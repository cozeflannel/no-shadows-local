"""Guards against stuck work and runaway calls (docs/TWO_TRACK_SIGNALS.md, "Loop guards").

- Each source has a circuit breaker: guards.breaker_failures failures in a row pause it for breaker_pause_minutes,
  doubling with each further failure up to breaker_max_pause_minutes; when the pause ends, ONE probe is tried.
- A source's place (watermark) moves only after its rows were written, so a failure never skips data and a success
  never re-reads it.
- Each run has a time budget (Budget): no new work starts once it's spent.
- Items that keep failing go to dead_letter after guards.dead_letter_tries and are never retried.
Cloud Run itself runs one request at a time (max-instances 1, concurrency 1: infra/09_slrr_signals.sh), so two ticks
never overlap.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import time
from typing import Any

from .settings import Settings
from .warehouse import Warehouse

UTC = dt.UTC


def now_utc() -> dt.datetime:
    return dt.datetime.now(UTC)


@dataclasses.dataclass
class SourceState:
    source: str
    watermark: dt.datetime | None = None
    table_modified: dt.datetime | None = None
    day: str | None = None
    day_count: int = 0
    failures: int = 0
    paused_until: dt.datetime | None = None
    last_ok: dt.datetime | None = None
    last_error: str | None = None
    last_rows: int = 0
    updated_at: dt.datetime | None = None


def is_paused(state: SourceState, now: dt.datetime) -> bool:
    return bool(state.paused_until and state.paused_until > now)


def is_due(state: SourceState, every_minutes: float, now: dt.datetime) -> bool:
    """A source reads at most every `every_minutes` (its last try, ok or not, counts)."""
    return state.updated_at is None or (now - state.updated_at) >= dt.timedelta(minutes=float(every_minutes) - 0.25)


def after_failure(state: SourceState, now: dt.datetime, error: str, settings: Settings) -> SourceState:
    failures = state.failures + 1
    limit = int(settings.get("guards.breaker_failures", 3))
    paused_until = None
    if failures >= limit:
        base = float(settings.get("guards.breaker_pause_minutes", 15))
        cap = float(settings.get("guards.breaker_max_pause_minutes", 360))
        minutes = min(cap, base * (2 ** (failures - limit)))
        paused_until = now + dt.timedelta(minutes=minutes)
    return dataclasses.replace(state, failures=failures, paused_until=paused_until, last_error=str(error)[:500],
                               updated_at=now)


def after_success(state: SourceState, now: dt.datetime, rows: int) -> SourceState:
    return dataclasses.replace(state, failures=0, paused_until=None, last_ok=now, last_error=None, last_rows=int(rows),
                               updated_at=now)


def day_left(state: SourceState, day_max: int | None, today: str) -> int | None:
    """What's left of a source's day maximum (None: no maximum)."""
    if not day_max:
        return None
    used = state.day_count if state.day == today else 0
    return max(0, int(day_max) - int(used))


def count_day(state: SourceState, n: int, today: str) -> SourceState:
    used = state.day_count if state.day == today else 0
    return dataclasses.replace(state, day=today, day_count=used + int(n))


class Budget:
    """A run's time limit (monotonic clock)."""

    def __init__(self, seconds: float, clock=time.monotonic):
        self._clock = clock
        self.deadline = clock() + float(seconds)

    def left(self) -> float:
        return self.deadline - self._clock()

    def expired(self, need: float = 0.0) -> bool:
        return self.left() <= need


# ---------------------------------------------------------------------------------------------------------------
# source_state: one row per source, read at the start of a run and written once at its end
# ---------------------------------------------------------------------------------------------------------------

_TS_FIELDS = ("watermark", "table_modified", "paused_until", "last_ok", "updated_at")


def _ts(v: Any) -> dt.datetime | None:
    if v is None or v == "":
        return None
    if isinstance(v, dt.datetime):
        return v if v.tzinfo else v.replace(tzinfo=UTC)
    return dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def load_states(wh: Warehouse, settings: Settings) -> dict[str, SourceState]:
    rows = wh.query(f"SELECT * FROM `{settings.table('source_state')}`", location=settings.dataset_location)
    out: dict[str, SourceState] = {}
    for r in rows:
        kw = {f.name: r.get(f.name) for f in dataclasses.fields(SourceState) if f.name in r}
        for f in _TS_FIELDS:
            kw[f] = _ts(kw.get(f))
        kw["day_count"] = int(kw.get("day_count") or 0)
        kw["failures"] = int(kw.get("failures") or 0)
        kw["last_rows"] = int(kw.get("last_rows") or 0)
        out[str(r["source"])] = SourceState(**kw)
    return out


def save_states(wh: Warehouse, settings: Settings, states: list[SourceState]) -> None:
    """Upserts every state in ONE statement (a JSON parameter: never text pasted into the SQL)."""
    if not states:
        return
    payload = json.dumps([{k: (v.isoformat() if isinstance(v, dt.datetime) else v)
                           for k, v in dataclasses.asdict(s).items()} for s in states])
    t = settings.table("source_state")
    ts = lambda f: f"SAFE.TIMESTAMP(JSON_VALUE(j, '$.{f}'))"  # noqa: E731
    sql = f"""
MERGE `{t}` T
USING (
  SELECT JSON_VALUE(j, '$.source') AS source, {ts('watermark')} AS watermark, {ts('table_modified')} AS table_modified,
    JSON_VALUE(j, '$.day') AS day, SAFE_CAST(JSON_VALUE(j, '$.day_count') AS INT64) AS day_count,
    SAFE_CAST(JSON_VALUE(j, '$.failures') AS INT64) AS failures, {ts('paused_until')} AS paused_until,
    {ts('last_ok')} AS last_ok, JSON_VALUE(j, '$.last_error') AS last_error,
    SAFE_CAST(JSON_VALUE(j, '$.last_rows') AS INT64) AS last_rows, {ts('updated_at')} AS updated_at
  FROM UNNEST(JSON_QUERY_ARRAY(@states)) j
) S
ON T.source = S.source
WHEN MATCHED THEN UPDATE SET watermark = S.watermark, table_modified = S.table_modified, day = S.day,
  day_count = S.day_count, failures = S.failures, paused_until = S.paused_until, last_ok = S.last_ok,
  last_error = S.last_error, last_rows = S.last_rows, updated_at = S.updated_at
WHEN NOT MATCHED THEN INSERT (source, watermark, table_modified, day, day_count, failures, paused_until, last_ok,
  last_error, last_rows, updated_at)
  VALUES (S.source, S.watermark, S.table_modified, S.day, S.day_count, S.failures, S.paused_until, S.last_ok,
  S.last_error, S.last_rows, S.updated_at)"""
    wh.query(sql, {"states": payload}, location=settings.dataset_location)


# ---------------------------------------------------------------------------------------------------------------
# dead_letter: tries per item (an item at guards.dead_letter_tries is never tried again)
# ---------------------------------------------------------------------------------------------------------------

def dead_tries(wh: Warehouse, settings: Settings, stage: str, keys: list[str]) -> dict[str, int]:
    if not keys:
        return {}
    rows = wh.query(
        f"SELECT item_key, MAX(tries) AS tries FROM `{settings.table('dead_letter')}` "
        "WHERE stage = @stage AND item_key IN UNNEST(@keys) AND failed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) "
        "GROUP BY item_key", {"stage": stage, "keys": keys}, location=settings.dataset_location)
    return {str(r["item_key"]): int(r["tries"] or 0) for r in rows}


def record_failure(wh: Warehouse, settings: Settings, stage: str, key: str, tries: int, error: str,
                   payload: dict[str, Any] | None, now: dt.datetime) -> None:
    wh.insert(settings.table("dead_letter"), [{
        "item_key": key, "stage": stage, "tries": tries, "last_error": str(error)[:1000], "failed_at": now,
        "payload": payload or {},
    }], row_ids=[f"{stage}:{key}:{tries}"])
