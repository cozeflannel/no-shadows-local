"""One run of agent alerts: the objects in BigQuery are brought up to date, every source is read and staged, and
BigQuery's procedure checks each new post against the rules, asks Gemini about the ones a rule leaves open, groups the
rest into stories and queues what should be reviewed.

The in-house job calls `run` every time it runs; a run happens when one is due (Settings, Agent alerts). One run at a
time: a second one that starts while the first is going does nothing.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from ..config import switch_title
from ..events import PlatformEvent
from . import SWITCH, ingest, rules, schema, sources

if TYPE_CHECKING:
    from ..context import AgentContext

STATE = "own:state"  # {last, cursors: {source: {...}}, sources: {source: {...}}, result, error}
LOCK = "own:cycle"
LOCK_S = 600
COUNTS = ("staged", "new_posts", "hard", "single_asked", "single_queued", "embedded", "stories_asked", "stories_queued")
NOT_CREATED = ("Agent alerts' tables in BigQuery are not created yet, or a setting changed what they hold. An admin can turn on "
               f'"{switch_title("bigquery_admin")}" under Settings, Switches; the next run creates them.')


def said(result: dict[str, Any]) -> str:
    """One run in a line, for the job's summary."""
    if result.get("busy"):
        return "agent alerts: a run is already going"
    if result.get("due") is False:
        return "agent alerts: not due"
    if result.get("error"):
        return f"agent alerts: {result['error']}"
    waiting = len(result.get("waiting") or [])
    return (f"agent alerts: {result.get('read', 0)} read, {result.get('staged', 0)} kept, "
            f"{result.get('hard', 0) + result.get('single_queued', 0) + result.get('stories_queued', 0)} sent to review"
            + (f", {waiting} source{'' if waiting == 1 else 's'} waiting for access" if waiting else ""))


def _objects(ctx: "AgentContext") -> None:
    """Creates agent alerts' objects when they are missing or out of date."""
    from .. import bq_admin

    if schema.current(ctx):
        return
    try:
        schema.provision(ctx)
    except bq_admin.NotAllowed as exc:
        raise RuntimeError(NOT_CREATED) from exc
    rules.mark_pending(ctx)  # the rules table may be new: every rule is copied again


def run(ctx: "AgentContext", force: bool = False) -> dict[str, Any]:
    """One run, when one is due (or `force`)."""
    from .. import bq_admin

    if not ctx.config.platform.flag(SWITCH):
        return {"ok": True, "off": True}
    own = ctx.config.platform.own_alerts
    now = ctx.now()
    state = ctx.store.get_kv(STATE) or {}
    if not force and state.get("last") and now - datetime.fromisoformat(state["last"]) < timedelta(minutes=own.interval_minutes):
        return {"ok": True, "due": False}
    if not ctx.store.claim_idempotent(LOCK, ttl_s=LOCK_S):
        return {"ok": True, "busy": True}
    started = time.monotonic()
    out: dict[str, Any] = {"ok": True, "due": True, "error": "", "read": 0, **{k: 0 for k in COUNTS}, "failing": [], "waiting": []}
    try:
        _objects(ctx)
        rules.sync_if_pending(ctx)
        read = ingest.run(ctx, state, now)
        out.update(read=read["read"], staged=read["staged"], failing=read["failing"], waiting=read["waiting"])
        call, params = schema.call(ctx, sources.OTHER_ALERTS)
        try:
            rows = bq_admin.get_gateway(ctx).query(call, params, location=ctx.config.platform.bigquery.location or None, labels=schema.LABELS)
        except Exception as exc:  # what was staged waits for the next run
            raise RuntimeError(f"BigQuery could not finish the run: {str(exc)[:300]}") from exc
        summary = rows[0] if rows else {}
        out.update({k: int(summary.get(k) or 0) for k in COUNTS if k != "staged"})
        if read["failing"]:
            labels = [state["sources"][k]["label"] for k in read["failing"]]
            out.update(ok=False, error="Could not read: " + ", ".join(labels))
    except Exception as exc:  # noqa: BLE001 - shown on the Agent alerts page; the next run tries again
        out.update(ok=False, error=str(exc)[:400])
    finally:
        ctx.store.release_idempotent(LOCK)
    state.update(last=now.isoformat(), error=out["error"], result={"read": out["read"], **{k: out[k] for k in COUNTS}})
    ctx.store.put_kv(STATE, state)
    ctx.emit(PlatformEvent.OWN_CYCLE, actor="agent", space="system", latency_ms=int((time.monotonic() - started) * 1000),
             payload={"read": out["read"], **{k: out[k] for k in COUNTS}, "failing": out["failing"], "waiting": out["waiting"], "error": out["error"]})
    return out


def status(ctx: "AgentContext") -> dict[str, Any]:
    """What the Agent alerts page shows about the runs: the switch, the last run, each source, and the objects."""
    state = ctx.store.get_kv(STATE) or {}
    try:
        objects = "ready" if schema.current(ctx) else "not created"
    except ValueError as exc:  # a setting the objects need is missing
        objects = str(exc)
    entries = state.get("sources") or {}
    listed = []
    try:
        for source in sources.listing(ctx):
            entry = entries.get(source.key) or {}
            cursor = (state.get("cursors") or {}).get(source.key) or {}
            listed.append({"key": source.key, "kind": source.kind, "label": source.label, "where": source.where, "system": source.system,
                           "status": entry.get("status") or "not read yet", "at": entry.get("at") or "", "error": entry.get("error") or "",
                           "read": entry.get("read", 0), "kept": entry.get("kept", 0), "skipped": entry.get("skipped", 0),
                           "more": bool(entry.get("more")), "behind_since": cursor.get("at") if cursor.get("more") else ""})
    except Exception as exc:  # noqa: BLE001 - the page still opens
        objects = objects if objects != "ready" else str(exc)
    return {"on": ctx.config.platform.flag(SWITCH), "last": state.get("last") or "", "error": state.get("error") or "",
            "result": state.get("result") or {}, "sources": listed, "objects": objects,
            "interval_minutes": ctx.config.platform.own_alerts.interval_minutes}
