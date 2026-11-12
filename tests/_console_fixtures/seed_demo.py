"""Seed a local SQLite DB with ~2 weeks of realistic synthetic Agent Console data.

Writes directly through the Store and EventLogger (the triage pipeline isn't involved) and is
deterministic for a given (seed, now, days). Every event type in docs/CONTRACTS.md §15 is
emitted with consistent payloads, so every KPI in metrics.KPI_DEFINITIONS and every derived
metric is non-trivial.

    TRIAGE_LOCAL_DB=.local/demo.db .venv/bin/python -m tests._console_fixtures.seed_demo --reset

Tests call `seed_database(path, now=...)` or `seed_demo(store, events, now=...)`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

import triage_agent.store as store_module
from triage_agent.config import AgentConfig, load_config
from triage_agent.events import EventLogger, EventType, SqliteEventLogger
from triage_agent.metrics import compute_kpis
from triage_agent.models import AgentEvent, CaseStatus, utcnow
from triage_agent.store import SqliteStore, Store

from . import demo_extras as X
from .demo_plan import plan
from .demo_sim import Sim, Spec
from .demo_triage import build_case

try:
    from conftest import seed_test_config
except ModuleNotFoundError:  # pragma: no cover
    from tests.conftest import seed_test_config

DEFAULT_DB = ".local/demo.db"
DEFAULT_SEED = 20261013
PARITY_FIELDS = ("track", "priority", "exposure_tag", "product", "issue_status", "is_kof", "engagement_level",
                 "sensitive_topics", "alertable", "alert_action")


@contextmanager
def _store_clock() -> Iterator[dict[str, datetime | None]]:
    """Let the Store stamp historical updated_at values (save_case/save_roster use store.utcnow)."""
    original = store_module.utcnow
    current: dict[str, datetime | None] = {"t": None}
    store_module.utcnow = lambda: current["t"] or original()  # type: ignore[assignment]
    try:
        yield current
    finally:
        store_module.utcnow = original  # type: ignore[assignment]


def _parity_diffs(burson: Spec, inhouse: Spec) -> dict[str, list[Any]]:
    """{field: [burson, inhouse]} like triage_agent.cases.parity_diffs."""
    ra = burson.case.latest.result.assessment if burson.case and burson.case.latest else None
    rb = inhouse.case.latest.result.assessment if inhouse.case and inhouse.case.latest else None
    if not ra or not rb:
        return {}
    out = {}
    for name in PARITY_FIELDS:
        va, vb = getattr(ra, name), getattr(rb, name)
        if isinstance(va, list):
            va, vb = sorted(va), sorted(vb or [])
        if va != vb:
            out[name] = [va, vb]
    return out


def _link_parity(sim: Sim, spec: Spec) -> None:
    other = spec.counterpart
    if other is None or other.case is None or spec.case is None:
        return
    spec.case.counterpart_case_id, other.case.counterpart_case_id = other.case.case_id, spec.case.case_id
    burson, inhouse = (spec, other) if spec.source == "burson_chat" else (other, spec)
    t = spec.received + timedelta(milliseconds=spec.latency_ms + 50)
    sim.emit(t, EventType.PARITY_MATCHED, case_id=spec.case.case_id, space="system",
             payload={"counterpart_case_id": other.case.case_id, "diffs": _parity_diffs(burson, inhouse)})


def _parity_unmatched(sim: Sim) -> None:
    for spec in sim.specs:
        case = spec.case
        if spec.parity not in ("burson_only", "inhouse_only") or case is None or case.status == CaseStatus.SUPPRESSED:
            continue
        t = case.created_at + timedelta(hours=2, seconds=sim.rng.uniform(5, 60))
        sim.emit(t, EventType.PARITY_UNMATCHED, case_id=case.case_id, space="system",
                 payload={"side": spec.parity, "record_key": case.record_key})


def coverage(events: list[AgentEvent], config: AgentConfig, now: datetime, days: int = 7) -> dict[str, Any]:
    """Which event types are missing, and which KPIs / derived metrics are empty in the last `days`."""
    window = [e for e in events if now - timedelta(days=days) <= e.event_ts < now]
    result = compute_kpis(window, config)
    empty_derived = [
        k for k, v in result["derived"].items()
        if v is None or v == {} or (isinstance(v, dict) and (v.get("n") == 0 or v.get("avg") is None and "avg" in v))
    ]
    return {
        "missing_event_types": sorted(set(EventType.all()) - {e.event_type for e in events}),
        "zero_kpis": sorted(k for k, v in result["kpis"].items() if not v),
        "empty_derived": sorted(empty_derived),
    }


def seed_demo(store: Store, events: EventLogger, *, now: datetime | None = None, days: int = 14, seed: int = DEFAULT_SEED) -> dict[str, Any]:
    """Generate and write the demo data; returns a summary (counts + coverage)."""
    now = (now or utcnow()).astimezone(timezone.utc).replace(second=0, microsecond=0)
    sim = Sim(seed_test_config(load_config(store)), now, days, seed, store.next_id)
    history = X.config_history(sim)
    with _store_clock() as clock:
        for saved_at, overrides, actor, note in history:
            clock["t"] = saved_at
            store.save_config_overrides(overrides, actor=actor, note=note)
    cfg = seed_test_config(load_config(store))
    sim.cfg, sim.config_version = cfg, cfg.config_version()

    X.build_rosters(sim)
    X.roster_events(sim)
    sim.specs = plan(sim)
    X.watchdog_emails(sim, [(s.received, f"Watchdog Anti-Abuse Alert: {s.tpl['title']}", s.url) for s in sim.specs if s.source == "watchdog"])
    for spec in sim.specs:
        build_case(sim, spec)
        _link_parity(sim, spec)
    _parity_unmatched(sim)
    proposals, facts = X.learning(sim)
    X.conversation(sim)
    X.noise(sim)
    X.jobs(sim)

    with _store_clock() as clock:
        for name, roster in sim.rosters.items():
            clock["t"] = max([sim.start + timedelta(hours=2)] + [o.created_at for o in roster.overrides if o.created_at < now])
            store.save_roster(roster, actor=X.ADMIN, name=name)
        for case in sim.cases.values():
            clock["t"] = case.updated_at
            store.save_case(case)
        for esc in sim.escalations.values():
            clock["t"] = esc.updated_at
            store.save_escalation(esc)
        for item in sim.outbox:
            clock["t"] = item.delivered_at or item.created_at
            store.add_outbox(item)
        for p in proposals:
            clock["t"] = p.decided_at or p.created_at
            store.save_proposal(p)
        for f in facts:
            clock["t"] = f.decided_at or f.created_at
            store.save_fact(f)
    sim.events.sort(key=lambda e: e.event_ts)
    for event in sim.events:
        events.log(event)

    return {
        "now": now.isoformat(),
        "days": days,
        "seed": seed,
        "cases": len(sim.cases),
        "by_status": dict(Counter(c.status.value for c in sim.cases.values())),
        "by_source": dict(Counter(c.source for c in sim.cases.values())),
        "escalations": len(sim.escalations),
        "outbox": len(sim.outbox),
        "proposals": len(proposals),
        "facts": len(facts),
        "events": len(sim.events),
        "coverage": coverage(sim.events, cfg, now),
    }


def seed_database(path: str | Path, *, reset: bool = False, now: datetime | None = None, days: int = 14,
                  seed: int = DEFAULT_SEED) -> dict[str, Any]:
    """Seed the SQLite file at `path` (store + events share it, like TRIAGE_BACKEND=local)."""
    path = Path(path)
    if reset:
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(f"{path}{suffix}").unlink(missing_ok=True)
    store = SqliteStore(path)
    if store.list_cases(limit=1):
        raise RuntimeError(f"{path} already has data; pass reset=True (--reset) to recreate it")
    summary = seed_demo(store, SqliteEventLogger(path), now=now, days=days, seed=seed)
    return {"db": str(path), **summary}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed the Agent Console demo database (local SQLite only).")
    parser.add_argument("--db", default=os.environ.get("TRIAGE_LOCAL_DB") or DEFAULT_DB, help="SQLite file (default: $TRIAGE_LOCAL_DB or .local/demo.db)")
    parser.add_argument("--reset", action="store_true", help="delete the file first")
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--now", help="ISO timestamp to treat as now (default: current time)")
    args = parser.parse_args(argv)
    if os.environ.get("TRIAGE_BACKEND", "local") == "gcp":
        print("Refusing to seed with TRIAGE_BACKEND=gcp: demo data is for local SQLite only.", file=sys.stderr)
        return 2
    now = datetime.fromisoformat(args.now) if args.now else None
    if now is not None and now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    try:
        summary = seed_database(args.db, reset=args.reset, now=now, days=args.days, seed=args.seed)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
