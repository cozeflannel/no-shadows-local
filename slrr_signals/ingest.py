"""Ingest: each due source's new rows land in raw_mentions once (per post and source), behind its circuit breaker.

A source's place moves only after its rows were written; a source that fails stays where it was (read again next time)
and its breaker pauses it after repeated failures (guards.py). Rows already landed for the same post and source in the
last 7 days are skipped, so a re-read never lands a post twice.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import logging
from typing import Any
from zoneinfo import ZoneInfo

from triage_agent.qa.record_key import normalize_url

from . import guards, sources
from .guards import Budget, SourceState
from .settings import Settings
from .warehouse import Warehouse

log = logging.getLogger("slrr_signals.ingest")
ET = ZoneInfo("America/New_York")
SETTLE = dt.timedelta(minutes=1)  # what a source got in the last minute waits for the next read


def et_day(t: dt.datetime) -> str:
    return t.astimezone(ET).strftime("%Y-%m-%d")


def window(state: SourceState, cfg: dict[str, Any], key: str, now: dt.datetime) -> tuple[dt.datetime, dt.datetime]:
    """(since, until) for a read ending a minute ago: from the source's place, within its first/max look-back."""
    until = now - SETTLE
    if sources.SOURCES[key].kind == "window":
        first = dt.timedelta(minutes=float(cfg.get("first_minutes", 15)))
        most = dt.timedelta(minutes=float(cfg.get("max_minutes", 30)))
    else:
        first = dt.timedelta(hours=float(cfg.get("first_hours", 2)))
        most = dt.timedelta(hours=float(cfg.get("max_hours", 6)))
    since = state.watermark or (until - first)
    return max(since, until - most), until


def normalize(key: str, row: dict[str, Any], now: dt.datetime) -> dict[str, Any] | None:
    """A source row as a raw_mentions row (None without a post link)."""
    url = str(row.get("post_url") or "").strip()
    mention_key = normalize_url(url) if url else None
    if not mention_key:
        return None
    extra = row.get("extra")
    if isinstance(extra, str):
        try:
            extra = json.loads(extra)
        except ValueError:
            extra = {"raw": extra[:500]}
    text = row.get("text")
    return {
        "mention_key": mention_key, "source": key, "source_id": str(row.get("source_id") or "")[:300] or None,
        "post_url": url[:1000], "platform": row.get("platform"), "author": (str(row.get("author") or "")[:200] or None),
        "author_followers": _int(row.get("author_followers")), "engagement": _int(row.get("engagement")),
        "views": _int(row.get("views")), "text": (str(text)[:4000] if text else None),
        "title": (str(row.get("title"))[:500] if row.get("title") else None),
        "summary": (str(row.get("summary"))[:1000] if row.get("summary") else None),
        "language": row.get("language"), "sentiment": row.get("sentiment"),
        "posted_at": row.get("posted_at"), "source_seen_at": row.get("source_seen_at"), "ingested_at": now,
        "products": [str(p) for p in (row.get("products") or []) if p][:10],
        "source_tags": [str(t) for t in (row.get("source_tags") or []) if t][:12],
        "kof_lists": [str(k) for k in (row.get("kof_lists") or []) if k][:10],
        "reason": row.get("reason"), "extra": extra or {},
    }


def _int(v: Any) -> int | None:
    try:
        return None if v is None or v == "" else int(v)
    except (TypeError, ValueError):
        return None


def read_source(wh: Warehouse, settings: Settings, key: str, state: SourceState,
                now: dt.datetime) -> tuple[list[dict[str, Any]], SourceState, bool]:
    """(rows, the state to keep if they land, read?) for one source. Raises on a failed read."""
    cfg = settings.source(key)
    table = str(cfg["table"])
    location = str(cfg.get("location", "US"))
    spec = sources.SOURCES[key]
    new_state = state
    if spec.gated:  # read only when the table changed since the last read
        rows = wh.query(sources.tables_sql(table), {"table_id": table.rsplit(".", 1)[1]}, location=location)
        modified = guards._ts(rows[0]["modified"]) if rows else None
        if modified is not None and state.table_modified is not None and modified <= state.table_modified:
            return [], state, False
        new_state = dataclasses.replace(new_state, table_modified=modified)
    since, until = window(state, cfg, key, now)
    max_rows = int(settings.get("guards.max_rows_per_source", 500))
    left = guards.day_left(state, cfg.get("day_max"), et_day(now))
    if left is not None:
        max_rows = min(max_rows, left)
    if max_rows <= 0:  # its day's maximum is reached: read nothing more today
        return [], new_state, False
    params = {"since": since, "until": until, "max_rows": max_rows}
    params.update(sources.params_for(key, cfg, settings.networks))
    got = wh.query(sources.SQL[key](table), params, location=location)
    if spec.kind == "window":
        new_state = dataclasses.replace(new_state, watermark=until)
    else:
        seen = [guards._ts(r.get("source_seen_at")) for r in got if r.get("source_seen_at")]
        if seen:
            new_state = dataclasses.replace(new_state, watermark=max(s for s in seen if s))
    if left is not None:
        new_state = guards.count_day(new_state, len(got), et_day(now))
    return got, new_state, True


def land(wh: Warehouse, settings: Settings, key: str, rows: list[dict[str, Any]], now: dt.datetime) -> int:
    """Writes the rows not already landed (same post and source, last 7 days). The number written."""
    normed = [r for r in (normalize(key, row, now) for row in rows) if r]
    seen: set[str] = set()
    uniq = []
    for r in normed:
        if r["mention_key"] not in seen:
            seen.add(r["mention_key"])
            uniq.append(r)
    if not uniq:
        return 0
    have = wh.query(
        f"SELECT DISTINCT mention_key FROM `{settings.table('raw_mentions')}` WHERE source = @source "
        "AND mention_key IN UNNEST(@keys) AND ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)",
        {"source": key, "keys": [r["mention_key"] for r in uniq]}, location=settings.dataset_location)
    known = {str(h["mention_key"]) for h in have}
    fresh = [r for r in uniq if r["mention_key"] not in known]
    wh.insert(settings.table("raw_mentions"), fresh, row_ids=[f"{key}:{r['mention_key']}" for r in fresh])
    return len(fresh)


def run_ingest(wh: Warehouse, settings: Settings, states: dict[str, SourceState], now: dt.datetime,
               budget: Budget) -> dict[str, Any]:
    """Reads each due source (fastest first) within the run's budget. Mutates `states`; returns per-source stats."""
    stats: dict[str, Any] = {}
    for key in sources.ORDER:
        cfg = settings.source(key)
        if not cfg or not cfg.get("enabled", True):
            continue
        st = states.get(key) or SourceState(source=key)
        if guards.is_paused(st, now):
            stats[key] = {"status": "paused", "until": st.paused_until.isoformat() if st.paused_until else None}
            continue
        if not guards.is_due(st, float(cfg.get("every_minutes", 5)), now):
            continue
        if budget.expired(need=10):
            stats[key] = {"status": "deferred (time)"}
            break
        try:
            rows, kept, read = read_source(wh, settings, key, st, now)
            landed = land(wh, settings, key, rows, now) if rows else 0
            states[key] = guards.after_success(kept, now, landed)
            stats[key] = {"status": "ok" if read else "unchanged", "read": len(rows), "landed": landed}
        except Exception as e:  # noqa: BLE001 - one source's failure never stops the others
            states[key] = guards.after_failure(st, now, f"{type(e).__name__}: {e}", settings)
            stats[key] = {"status": "error", "error": str(e)[:300], "failures": states[key].failures,
                          "paused_until": states[key].paused_until.isoformat() if states[key].paused_until else None}
            log.warning("source %s failed (%d in a row): %s", key, states[key].failures, e)
    return stats
