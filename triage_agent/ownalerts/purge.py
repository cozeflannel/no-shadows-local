"""What agent alerts keeps leaves after its days.

Each table's partitions already expire on their own (schema). Once a day the same rows are deleted outright, so a
row never outlives its days by waiting for its partition: posts, their links and KOF names, their engagement, the
stories and the queue after the days posts are kept (30 at most); decisions and verdicts after their own days. This
runs whether or not agent alerts is switched ON: what was kept still has to leave.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from . import schema

if TYPE_CHECKING:
    from ..context import AgentContext

MARK = "own:purge"  # {at, failed, error}
EVERY = timedelta(days=1)
RETRY = timedelta(hours=1)  # after a table could not be cleared
# table -> the time its rows are aged by. A story is aged by when it last gathered a post, not by when it began.
AGED_BY = {"posts_staging": "ingested_at", "author_vault_30d": "ingested_at", "posts": "ingested_at", "post_metrics": "recorded_at",
           "stories": "updated_at", "review_queue": "queued_at", "decisions": "decided_at", "feedback": "submitted_at"}


def run(ctx: "AgentContext", force: bool = False) -> dict[str, Any]:
    from .. import bq_admin

    if not (ctx.store.get_kv(schema.STATE) or {}).get("version"):  # the tables were never created: there is nothing to delete
        return {"ok": True, "ran": False}
    now = ctx.now()
    last = ctx.store.get_kv(MARK) or {}
    failed = list(last.get("failed") or [])
    if not force and last.get("at") and now - datetime.fromisoformat(last["at"]) < (RETRY if failed else EVERY):
        return {"ok": False, "ran": False, "failed": failed, "error": last.get("error") or ""} if failed else {"ok": True, "ran": False}
    own = ctx.config.platform.own_alerts
    gw = bq_admin.get_gateway(ctx)
    failed, errors = [], []
    for name, (_, _, _, keep, _) in schema.TABLES.items():
        try:
            gw.query(f"DELETE FROM `{schema.table(ctx, name)}` WHERE {AGED_BY[name]} < @before", {"before": now - timedelta(days=schema.days(own, keep))},
                     location=ctx.config.platform.bigquery.location or None, labels=schema.LABELS)
        except Exception as exc:  # noqa: BLE001 - the other tables are still cleared; this one is tried again within the hour
            failed.append(name)
            errors.append(f"{name}: {str(exc)[:160]}")
    error = "; ".join(errors)
    ctx.store.put_kv(MARK, {"at": now.isoformat(), "failed": failed, "error": error})
    return {"ok": not failed, "ran": True, "tables": sorted(schema.TABLES), "failed": failed, "error": error}
