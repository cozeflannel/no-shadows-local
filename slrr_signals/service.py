"""slrr-signals HTTP entry points (Cloud Run, private; Cloud Scheduler calls them with OIDC).

POST /tick       every minute: ingest the due sources, then Track 1 (within guards.tick_budget_seconds)
POST /radar      every 15 minutes: Track 2 (within guards.radar_budget_seconds)
POST /reprocess  ?hours=N: classify again what landed in the last N hours under the current rules/prompt versions
GET  /healthz    liveness
GET  /metrics    each source's health and today's numbers
One request at a time (Cloud Run concurrency 1, max instances 1, plus a lock here): runs never overlap. Every run
writes a run_log row. The service posts nothing in Chat and emails no one: the chatbot hands its results to the chat
(apps-script-chat-bot/Signals.gs).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import threading
import time
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException

from . import guards
from .guards import Budget
from .ingest import run_ingest
from .settings import Settings, load_settings
from .track1 import run_track1
from .track2 import run_track2
from .warehouse import BigQueryWarehouse, Warehouse


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return json.dumps({"severity": record.levelname, "message": record.getMessage(), "logger": record.name,
                           "component": "slrr-signals"})


def configure_logging() -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(_JsonFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[h], force=True)


log = logging.getLogger("slrr_signals.service")


class Runtime:
    """Everything a run needs, made once per instance (tests pass their own)."""

    def __init__(self, settings: Settings, wh: Warehouse, agent_cfg: Any, llm: Any, web: Any):
        self.settings = settings
        self.wh = wh
        self.agent_cfg = agent_cfg
        self.llm = llm
        self.web = web
        self.lock = threading.Lock()


_runtime: Runtime | None = None


def build_runtime() -> Runtime:
    from triage_agent.config import load_config
    from triage_agent.llm import get_llm

    from .classify import WebChecker

    s = load_settings()
    wh = BigQueryWarehouse(s.project, max_bytes=int(s.get("guards.max_query_bytes", 6_000_000_000)), labels=s.labels)
    agent_cfg = load_config(path=s.agent_config_path)
    location = str(s.get("models.location", "global"))
    web = WebChecker(s.project, location, str(s.get("models.web", "gemini-3.8-flash")))
    return Runtime(s, wh, agent_cfg, get_llm(location), web)


def runtime() -> Runtime:
    global _runtime
    if _runtime is None:
        _runtime = build_runtime()
    return _runtime


def set_runtime(rt: Runtime | None) -> None:
    global _runtime
    _runtime = rt


def _log_run(rt: Runtime, run_id: str, endpoint: str, started: float, status: str, stats: dict[str, Any], error: str | None) -> None:
    try:
        rt.wh.insert(rt.settings.table("run_log"), [{
            "run_id": run_id, "endpoint": endpoint, "started_at": guards.dt.datetime.fromtimestamp(started, guards.UTC),
            "finished_at": guards.now_utc(), "status": status, "stats": stats, "error": error,
        }], row_ids=[run_id])
    except Exception as e:  # noqa: BLE001 - the run's log never fails the run
        log.warning("couldn't write the run log: %s", e)


def run_tick(rt: Runtime) -> dict[str, Any]:
    s = rt.settings
    started, run_id = time.time(), f"tick-{uuid.uuid4().hex[:12]}"
    now = guards.now_utc()
    budget = Budget(float(s.get("guards.tick_budget_seconds", 50)))
    stats: dict[str, Any] = {}
    status, error = "ok", None
    try:
        states = guards.load_states(rt.wh, s)
        stats["sources"] = run_ingest(rt.wh, s, states, now, budget)
        guards.save_states(rt.wh, s, list(states.values()))
        stats["ingested"] = sum(int(v.get("landed", 0)) for v in stats["sources"].values() if isinstance(v, dict))
        if not budget.expired(need=10):
            t1 = run_track1(rt.wh, s, rt.agent_cfg, rt.llm, rt.web, now, budget)
            stats["track1"] = t1
            stats["classified"] = t1.get("classified", 0)
            stats["qualified"] = t1.get("qualified", 0)
        if any(isinstance(v, dict) and v.get("status") == "error" for v in stats["sources"].values()):
            status = "partial"
    except Exception as e:  # noqa: BLE001
        status, error = "error", f"{type(e).__name__}: {str(e)[:500]}"
        log.exception("tick failed")
    _log_run(rt, run_id, "tick", started, status, stats, error)
    return {"run_id": run_id, "status": status, "stats": stats, "error": error}


def run_radar(rt: Runtime) -> dict[str, Any]:
    s = rt.settings
    started, run_id = time.time(), f"radar-{uuid.uuid4().hex[:12]}"
    budget = Budget(float(s.get("guards.radar_budget_seconds", 240)))
    status, error, stats = "ok", None, {}
    try:
        stats = run_track2(rt.wh, s, rt.agent_cfg, rt.llm, rt.web, guards.now_utc(), budget)
        stats["assessed"] = stats.get("assessed", 0)
    except Exception as e:  # noqa: BLE001
        status, error = "error", f"{type(e).__name__}: {str(e)[:500]}"
        log.exception("radar failed")
    _log_run(rt, run_id, "radar", started, status, stats, error)
    return {"run_id": run_id, "status": status, "stats": stats, "error": error}


def run_reprocess(rt: Runtime, hours: int) -> dict[str, Any]:
    s = rt.settings
    started, run_id = time.time(), f"reprocess-{uuid.uuid4().hex[:12]}"
    budget = Budget(float(s.get("guards.radar_budget_seconds", 240)))
    status, error, stats = "ok", None, {}
    try:
        stats = run_track1(rt.wh, s, rt.agent_cfg, rt.llm, rt.web, guards.now_utc(), budget, reprocess_hours=max(1, min(hours, 72)))
    except Exception as e:  # noqa: BLE001
        status, error = "error", f"{type(e).__name__}: {str(e)[:500]}"
        log.exception("reprocess failed")
    _log_run(rt, run_id, "reprocess", started, status, stats, error)
    return {"run_id": run_id, "status": status, "stats": stats, "error": error}


app = FastAPI(title="slrr-signals")


def _exclusive(fn):
    rt = runtime()
    if not rt.lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="a run is already in progress")
    try:
        return fn(rt)
    finally:
        rt.lock.release()


@app.post("/tick")
def handle_tick() -> dict[str, Any]:
    return _exclusive(run_tick)


@app.post("/radar")
def handle_radar() -> dict[str, Any]:
    return _exclusive(run_radar)


@app.post("/reprocess")
def handle_reprocess(hours: int = 24) -> dict[str, Any]:
    return _exclusive(lambda rt: run_reprocess(rt, hours))


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/metrics")
def metrics() -> dict[str, Any]:
    rt = runtime()
    s = rt.settings
    health = rt.wh.query(f"SELECT source, status, last_ok, last_rows, day_count FROM `{s.table('v_source_health')}`",
                         location=s.dataset_location)
    today = rt.wh.query(f"SELECT * FROM `{s.table('v_metrics_daily')}` "
                        "WHERE day = CURRENT_DATE('America/New_York')", location=s.dataset_location)
    return {"sources": health, "today": today}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="slrr_signals.service")
    sub = p.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--port", type=int, default=8080)
    sub.add_parser("tick")
    sub.add_parser("radar")
    a = p.parse_args(argv)
    configure_logging()
    if a.cmd == "serve":
        import uvicorn

        uvicorn.run(app, host="0.0.0.0", port=a.port, log_config=None)  # noqa: S104 - Cloud Run's container port
        return 0
    out = run_tick(runtime()) if a.cmd == "tick" else run_radar(runtime())
    print(json.dumps(out, default=str, indent=2))  # noqa: T201 - CLI output
    return 0 if out["status"] != "error" else 1


if __name__ == "__main__":
    raise SystemExit(main())
