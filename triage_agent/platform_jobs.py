"""Scheduled work by name: what the worker's /jobs route and `python -m jobs.run_job` both run.

`maintenance` is the once-a-minute tick: each part decides from its own settings whether it is due.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .operations import handle

if TYPE_CHECKING:
    from .context import AgentContext

JOB_OPS: dict[str, tuple[str, dict[str, Any]]] = {
    "followups": ("run_followups", {}),
    "inhouse": ("ingest_inhouse", {}),
    "knowledge": ("refresh_knowledge", {}),
    "forecast": ("run_forecast", {}),
    "watches": ("run_watches", {}),
}
JOB_NAMES = sorted([*JOB_OPS, "temp-checks", "maintenance"])
TICK_KEY = "tick:last"  # when the once-a-minute tick last ran, and which of its parts failed (Admin → System)


def run_job(ctx: "AgentContext", name: str) -> dict[str, Any]:
    """One scheduled job by name."""
    from . import chatreview, early, mirror, retention, stories, storyread, tempcheck, workforce

    if name in JOB_OPS:
        op, payload = JOB_OPS[name]
        resp = handle({"op": op, "payload": payload, "context": {"deliver": "outbox", "flow": "job", "invoked_by": f"job:{name}"}}, ctx)
        out: dict[str, Any] = {"ok": resp.ok and not (resp.data or {}).get("failed_steps"), "op": op,
                               "summary": resp.outputs.get("summary"), "error": resp.error, "data": resp.data}
        if name == "forecast" and resp.ok:
            out["gap_alerts"] = workforce.check_gap_alerts(ctx)
        return out
    if name == "temp-checks":
        return {"ok": True, **tempcheck.auto_run(ctx)}
    if name == "maintenance":
        results = {n: run_job(ctx, n) for n in ("knowledge", "watches", "temp-checks", "forecast")}
        try:
            results["stories"] = {"ok": True, "placed": stories.refresh(ctx), "reads": storyread.run(ctx)}  # Gemini reads the stories that are due
        except Exception as exc:  # noqa: BLE001 - one part failing never stops the others
            results["stories"] = {"ok": False, "error": str(exc)[:300]}
        results["routing"] = mirror.run(ctx)  # the QA chatbot's copy of the source space (Routing page)
        results["chat_review"] = chatreview.run(ctx)  # ...and its review of each new alert there, when that switch is ON
        read = early.check(ctx)  # Early Detection: BigQuery reads and groups the posts when a read is due...
        results["early"] = {**early.drain(ctx), "read": read, "ok": read.get("ok", True)}  # ...and Gemini writes up what was raised
        failed = sorted(n for n, r in results.items() if not r.get("ok", True))
        ctx.store.put_kv(TICK_KEY, {"at": ctx.now().isoformat(), "failed": failed})
        return {"ok": not failed, "jobs": results, "retention": retention.run(ctx)}
    raise KeyError(name)
