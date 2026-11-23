"""A raised story that is growing again is reviewed once more.

The follow-ups job checks every run. A story is queued again when, some time after it was raised (not straight away,
and not long after), it is still gathering posts fast: at least the posts in 15 minutes and the pace set under
Settings, Agent alerts. It is queued once for each time it was raised; when the review raises it again the clock starts
over. The review then decides, with what was said the first time in front of it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

from . import SWITCH, schema

if TYPE_CHECKING:
    from ..context import AgentContext

TRIGGER = "FOLLOWUP_SURGE"
MEASURED_MINUTES = 15  # a story's counts describe its last 15 minutes: older counts say nothing about now


def run(ctx: "AgentContext") -> int:
    """How many raised stories were queued for another review."""
    from .. import bq_admin

    cfg = ctx.config.platform
    if not cfg.flag(SWITCH):
        return 0
    try:
        ready = schema.current(ctx)
    except ValueError:
        ready = False
    if not ready:  # the in-house job creates the objects on its next run
        return 0
    own = cfg.own_alerts
    q, s = schema.table(ctx, "review_queue"), schema.table(ctx, "stories")
    now = ctx.now()
    sql = (
        f"INSERT INTO `{q}` (queue_id, queued_at, item_type, target_id, trigger_path, stage1_rationale, processed)\n"
        f"SELECT GENERATE_UUID(), @now, 'STORY', s.story_id, '{TRIGGER}',\n"
        "  CONCAT('Raised ', CAST(TIMESTAMP_DIFF(@now, s.last_alerted_at, MINUTE) AS STRING), ' minutes ago and growing again'), FALSE\n"
        f"FROM `{s}` s\n"
        "WHERE s.last_alerted_at BETWEEN @earliest AND @latest\n"
        "  AND s.updated_at >= @measured\n"
        "  AND s.post_count_15m >= @min_posts AND s.velocity_ratio_15m >= @ratio\n"
        f"  AND NOT EXISTS (SELECT 1 FROM `{q}` q WHERE q.queued_at >= @earliest AND q.target_id = s.story_id "
        f"AND q.trigger_path = '{TRIGGER}' AND q.queued_at >= s.last_alerted_at);\n"
        "SELECT @@row_count AS n;")
    rows = bq_admin.get_gateway(ctx).query(
        sql, {"now": now, "earliest": now - timedelta(hours=own.surge_max_hours), "latest": now - timedelta(minutes=own.surge_min_minutes),
              "measured": now - timedelta(minutes=MEASURED_MINUTES), "min_posts": own.surge_min_posts, "ratio": own.surge_ratio},
        location=cfg.bigquery.location or None, labels=schema.LABELS)
    return int((rows[0].get("n") if rows else 0) or 0)
