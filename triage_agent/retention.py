"""Retention: rows past their keep-time leave the fast store. Each keep-time is a Console setting (Telemetry, BigQuery).

Audit entries and Chat activity are removed after their retention days. Recent events are removed from the fast store
only when BigQuery holds them too, after twice the hot window. BigQuery keeps its own copy of events and audit entries.
Runs with the worker's scheduled tick, at most once an hour.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from . import audit, chatapi, chatlog, chatdelivery, chatreview, early, mirror, stories, storyread, tempcheck
from .events import HOT_COLLECTION, TeeEventLogger
from .ownalerts import review as own_review

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
        (storyread.READS, "at", now - timedelta(days=cfg.stories.keep_days)),  # Gemini's read of a story that is over
        (mirror.COPIES, "at", now - timedelta(days=cfg.routing.keep_days)),  # the record of what was copied between spaces
        (mirror.QUEUE, "at", now - timedelta(days=cfg.routing.keep_days)),
        (chatreview.ROWS, "at", now - timedelta(days=cfg.routing.keep_days)),  # the record of what was read and reviewed from Chat
        (chatdelivery.ROWS, "at", now - timedelta(days=cfg.routing.keep_days)),  # ...and of what was posted there
        (chatapi.OWN, "at", now - timedelta(days=cfg.routing.keep_days)),  # ...and of which messages the bot's account posted itself
        (early.SIGNALS, "raised", now - timedelta(days=cfg.early.keep_days)),  # raised early stories
        (tempcheck.POSTS, "at", now - timedelta(days=cfg.temp_check.keep_posts_days)),  # posts kept with a temp check, for reuse
        (own_review.DECISIONS, "at", now - timedelta(days=cfg.own_alerts.console_keep_days)),  # own alerts' decisions, with their links and KOF names
    ]
    if isinstance(ctx.events, TeeEventLogger) and ctx.events.cold is not None:
        plan.append((HOT_COLLECTION, "event_ts", now - timedelta(hours=2 * cfg.bigquery.hot_window_hours)))
    removed = {name: ctx.store.delete_docs_before(name, field, before, BATCH) for name, field, before in plan}
    if any(removed.values()):
        audit.record(ctx, actor="agent", action="retention.removed", surface="job", target_type="store", target_id="retention",
                     summary="Removed rows past their retention: " + ", ".join(f"{n} from {k}" for k, n in removed.items() if n),
                     detail={"removed": removed})
    return {"removed": removed}
