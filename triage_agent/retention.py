"""Retention: rows past their keep-time leave the fast store. Each keep-time is a Console setting (Telemetry, BigQuery).

Audit entries and Chat activity are removed after their retention days. Recent events are removed from the fast store
only when BigQuery holds them too, after twice the hot window. BigQuery keeps its own copy of events and audit entries.
Runs with the worker's scheduled tick, at most once an hour.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from . import audit, chatlog, stories
from .events import HOT_COLLECTION, TeeEventLogger

if TYPE_CHECKING:
    from .context import AgentContext

MARK = "retention:last"
BATCH = 2000


def run(ctx: "AgentContext", force: bool = False) -> dict[str, Any]:
    now = ctx.now()
    last = (ctx.store.get_kv(MARK) or {}).get("at")
    if not force and last and now - datetime.fromisoformat(last) < timedelta(hours=1):
        return {"skipped": "ran within the hour", "removed": {}}
    ctx.store.put_kv(MARK, {"at": now.isoformat()})
    cfg = ctx.config.platform
    plan: list[tuple[str, str, datetime]] = [
        (audit.COLLECTION, "ts", now - timedelta(days=cfg.telemetry.audit_retention_days)),
        (chatlog.COLLECTION, "ts", now - timedelta(days=cfg.telemetry.chat_retention_days)),
        (stories.VECTORS, "last_at", now - timedelta(days=cfg.stories.keep_days)),  # a story that is over is never matched again
    ]
    if isinstance(ctx.events, TeeEventLogger) and ctx.events.cold is not None:
        plan.append((HOT_COLLECTION, "event_ts", now - timedelta(hours=2 * cfg.bigquery.hot_window_hours)))
    removed = {name: ctx.store.delete_docs_before(name, field, before, BATCH) for name, field, before in plan}
    if any(removed.values()):
        audit.record(ctx, actor="agent", action="retention.removed", surface="job", target_type="store", target_id="retention",
                     summary="Removed rows past their retention: " + ", ".join(f"{n} from {k}" for k, n in removed.items() if n),
                     detail={"removed": removed})
    return {"removed": removed}
