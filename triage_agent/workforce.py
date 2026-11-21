"""Workforce: rosters and coverage, volume history, live load, the volume forecast and staffing recommendations.

Everything is built on the agent's own data: alert volume from the event stream, staffing from the rosters
(weekly recurring slots plus overrides for one-off coverage). There is no outside workforce system.

Forecast: BigQuery AI.FORECAST (TimesFM) is the primary method and ARIMA_PLUS the explainable fallback; which one
runs, the horizon and the confidence level are Settings → Forecasting. Every recommendation the forecast leads to is
written as pending and does nothing until a person accepts, edits or dismisses it.
"""

from __future__ import annotations

import csv
import io
import logging
import math
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from .context import ROSTER_IM
from .events import PlatformEvent
from .models import Override, Person, Roster
from .oncall.roster import slot_window

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

FORECASTS = "wf_forecasts"
RECS = "wf_recommendations"
HOUR = timedelta(hours=1)
MODEL_NAME = re.compile(r"^[A-Za-z0-9 ._-]{1,60}$")
MODEL_ID = re.compile(r"^(?:[A-Za-z0-9_-]+\.)?[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")


def floor_hour(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def tz_of(ctx: "AgentContext") -> ZoneInfo:
    return ZoneInfo(ctx.config.platform.forecasting.timezone or ctx.config.timezone)


# -- staffing ----------------------------------------------------------------------------------------------------------
def staff_at(roster: Roster, at: datetime) -> list[tuple[Person, str]]:
    """Everyone scheduled at `at`: (person, 'override' | 'rotation'). An override adds coverage; it removes nobody."""
    people = {p.id: p for p in roster.people}
    out: dict[str, tuple[Person, str]] = {}
    for slot in roster.rotation:
        if slot.person_id in people and slot_window(slot, at):
            out[slot.person_id] = (people[slot.person_id], "rotation")
    for o in roster.overrides:
        if o.person_id in people and o.start <= at < o.end:
            out[o.person_id] = (people[o.person_id], "override")
    return list(out.values())


def staffing_by_hour(roster: Roster, start: datetime, end: datetime) -> dict[datetime, list[tuple[Person, str]]]:
    out, at = {}, floor_hour(start)
    while at < end:
        out[at] = staff_at(roster, at + timedelta(minutes=30))  # who holds the middle of the hour
        at += HOUR
    return out


def required_staff(volume: float, cfg: Any) -> int:
    """IMs needed for `volume` alerts in an hour: handling time over the share of an hour planned for alert work."""
    need = math.ceil(max(0.0, volume) * cfg.minutes_per_alert / (60.0 * cfg.target_utilization) - 1e-9)
    return max(cfg.min_staff, need)


# -- volume ------------------------------------------------------------------------------------------------------------
def volume_by_hour(ctx: "AgentContext", start: datetime, end: datetime) -> dict[datetime, int]:
    """Alerts received in each hour of [start, end), from the event stream."""
    cfg = ctx.config.platform.forecasting
    events = ctx.events.query(since=start, until=end, types=list(cfg.volume_event_types), env=ctx.config.env)
    out: dict[datetime, int] = {}
    for e in events:
        key = floor_hour(e.event_ts)
        out[key] = out.get(key, 0) + 1
    return out


def historicals(ctx: "AgentContext", days: int = 28) -> dict[str, Any]:
    """Past volume by hour and by day, staffing levels, and the hours that were short."""
    cfg = ctx.config.platform.forecasting
    tz = tz_of(ctx)
    now = floor_hour(ctx.now())
    start = now - timedelta(days=days)
    volume = volume_by_hour(ctx, start, now)
    roster = ctx.roster(ROSTER_IM)
    staffing = staffing_by_hour(roster, start, now)
    by_day: dict[str, dict[str, Any]] = {}
    by_hod = [{"hour": h, "volume": 0, "staff_hours": 0, "n": 0} for h in range(24)]
    heat = [[0 for _ in range(24)] for _ in range(7)]  # weekday x hour of day, total volume
    heat_n = [[0 for _ in range(24)] for _ in range(7)]
    gaps: list[dict[str, Any]] = []
    at = start
    while at < now:
        local = at.astimezone(tz)
        n, staff = volume.get(at, 0), len(staffing.get(at, []))
        need = required_staff(n, cfg)
        day = by_day.setdefault(local.date().isoformat(), {"date": local.date().isoformat(), "volume": 0, "staff_hours": 0,
                                                         "hours": 0, "covered_hours": 0, "required_hours": 0})
        day["volume"] += n
        day["staff_hours"] += staff
        day["hours"] += 1
        day["required_hours"] += need
        day["covered_hours"] += 1 if staff >= need else 0
        hod = by_hod[local.hour]
        hod["volume"] += n
        hod["staff_hours"] += staff
        hod["n"] += 1
        heat[local.weekday()][local.hour] += n
        heat_n[local.weekday()][local.hour] += 1
        if staff < need and n > 0:
            if gaps and gaps[-1]["end"] == at.isoformat() and gaps[-1]["staff"] == staff:
                gaps[-1].update({"end": (at + HOUR).isoformat(), "volume": gaps[-1]["volume"] + n,
                                 "short_by": max(gaps[-1]["short_by"], need - staff)})
            else:
                gaps.append({"start": at.isoformat(), "end": (at + HOUR).isoformat(), "volume": n, "staff": staff,
                             "required": need, "short_by": need - staff})
        at += HOUR
    for d in by_day.values():
        d["coverage_pct"] = round(100 * d["covered_hours"] / d["hours"], 1) if d["hours"] else None
    return {
        "days": days, "timezone": str(tz), "total_volume": sum(volume.values()),
        "by_day": sorted(by_day.values(), key=lambda d: d["date"]),
        "by_hour_of_day": [{"hour": h["hour"], "avg_volume": round(h["volume"] / h["n"], 2) if h["n"] else 0,
                            "avg_staff": round(h["staff_hours"] / h["n"], 2) if h["n"] else 0} for h in by_hod],
        "heatmap": [[round(heat[d][h] / heat_n[d][h], 2) if heat_n[d][h] else 0 for h in range(24)] for d in range(7)],
        "gaps": sorted(gaps, key=lambda g: -g["short_by"])[:100],
    }


def actuals(ctx: "AgentContext") -> dict[str, Any]:
    """Who is on shift now and the load they carry."""
    from .models import CaseStatus

    cfg = ctx.config.platform.forecasting
    now = ctx.now()
    roster = ctx.roster(ROSTER_IM)
    on_shift = []
    for person, source in staff_at(roster, now):
        until = None
        for slot in roster.rotation:
            window = slot_window(slot, now) if slot.person_id == person.id else None
            if window:
                until = window[1]
        for o in roster.overrides:
            if o.person_id == person.id and o.start <= now < o.end:
                until = o.end
        on_shift.append({"id": person.id, "name": person.name, "email": person.email, "source": source,
                         "until": until.isoformat() if until else None})
    open_cases = ctx.store.list_cases(statuses=[CaseStatus.VERIFIED, CaseStatus.NEEDS_REVIEW, CaseStatus.FAILED],
                                      since=now - timedelta(days=2), limit=500)
    waiting = [c for c in open_cases if c.status == CaseStatus.VERIFIED and c.acknowledged_at is None]
    review = [c for c in open_cases if c.status == CaseStatus.NEEDS_REVIEW]
    at_risk = [c for c in waiting if c.sla_due_at and c.sla_met is None and c.sla_due_at - now <= timedelta(minutes=5)]
    volume = volume_by_hour(ctx, now - timedelta(hours=1), now + timedelta(seconds=1))
    last_hour = sum(volume.values())
    load = len(waiting) + len(review)
    capacity = len(on_shift) * 60.0 * cfg.target_utilization / cfg.minutes_per_alert
    return {
        "as_of": now.isoformat(), "on_shift": on_shift, "staff": len(on_shift),
        "unacknowledged": len(waiting), "needs_review": len(review), "sla_at_risk": len(at_risk),
        "open_load": load, "load_per_im": round(load / len(on_shift), 1) if on_shift else None,
        "last_hour_volume": last_hour, "hourly_capacity": round(capacity, 1),
        "utilization_pct": round(100 * last_hour / capacity, 1) if capacity else None,
        "required_now": required_staff(last_hour, cfg),
    }


# -- forecast ------------------------------------------------------------------------------------------------------------
class ForecastRun(BaseModel):
    run_id: str
    created_at: datetime
    method: Literal["timesfm", "arima_plus"]
    model: str = ""
    horizon_hours: int
    confidence_level: float
    status: Literal["ok", "failed"] = "ok"
    error: str = ""
    fallback_from: str = ""
    points: list[dict[str, Any]] = Field(default_factory=list)  # [{ts, value, lower, upper, trend?, daily?, weekly?}]
    requested_by: str = "agent"
    env: str = "dev"


def series_sql(events_table: str) -> str:
    """Hourly volume with every hour present (an hour with no alerts counts 0)."""
    return (
        "SELECT ts, COUNT(e.event_id) AS y\n"
        "FROM UNNEST(GENERATE_TIMESTAMP_ARRAY(TIMESTAMP_TRUNC(@since, HOUR), TIMESTAMP_SUB(TIMESTAMP_TRUNC(@until, HOUR), INTERVAL 1 HOUR), INTERVAL 1 HOUR)) AS ts\n"
        f"LEFT JOIN `{events_table}` AS e\n"
        "  ON TIMESTAMP_TRUNC(e.event_ts, HOUR) = ts AND e.event_type IN UNNEST(@types) AND e.env = @env\n"
        "  AND e.event_ts >= TIMESTAMP_TRUNC(@since, HOUR) AND e.event_ts < TIMESTAMP_TRUNC(@until, HOUR)\n"
        "GROUP BY ts"
    )


def timesfm_sql(events_table: str, cfg: Any) -> str:
    model = f", model => '{cfg.timesfm_version}'" if cfg.timesfm_version else ""
    if cfg.timesfm_version and not MODEL_NAME.match(cfg.timesfm_version):
        raise ValueError("The TimesFM model name has characters that are not allowed.")
    return (
        "SELECT forecast_timestamp AS ts, forecast_value AS value, prediction_interval_lower_bound AS lower,\n"
        "  prediction_interval_upper_bound AS upper\n"
        f"FROM AI.FORECAST(\n  (\n{_indent(series_sql(events_table), 4)}\n  ),\n"
        f"  data_col => 'y', timestamp_col => 'ts'{model}, horizon => {int(cfg.horizon_hours)}, "
        f"confidence_level => {float(cfg.confidence_level)})\nORDER BY ts"
    )


def arima_model_id(ctx: "AgentContext") -> str:
    cfg = ctx.config.platform
    name = cfg.forecasting.arima_model or (f"{cfg.bigquery.dataset}.alert_volume_arima" if cfg.bigquery.dataset else "")
    if not name or not MODEL_ID.match(name):
        raise ValueError("Set where the ARIMA_PLUS model is kept (Settings → Forecasting → ARIMA model, or the agent's dataset).")
    return name


def arima_train_sql(events_table: str, model_id: str) -> str:
    return (
        f"CREATE OR REPLACE MODEL `{model_id}`\n"
        "OPTIONS(model_type = 'ARIMA_PLUS', time_series_timestamp_col = 'ts', time_series_data_col = 'y',\n"
        "        data_frequency = 'HOURLY', clean_spikes_and_dips = TRUE, decompose_time_series = TRUE) AS\n"
        f"{series_sql(events_table)}"
    )


def arima_forecast_sql(model_id: str, cfg: Any) -> str:
    return (
        "SELECT time_series_timestamp AS ts, time_series_data AS value, prediction_interval_lower_bound AS lower,\n"
        "  prediction_interval_upper_bound AS upper, trend, seasonal_period_daily AS daily, seasonal_period_weekly AS weekly\n"
        f"FROM ML.EXPLAIN_FORECAST(MODEL `{model_id}`, STRUCT({int(cfg.horizon_hours)} AS horizon, {float(cfg.confidence_level)} AS confidence_level))\n"
        "WHERE time_series_type = 'forecast'\nORDER BY ts"
    )


def _indent(sql: str, n: int) -> str:
    return "\n".join(" " * n + line for line in sql.splitlines())


def _run_method(ctx: "AgentContext", method: str, gw: Any, events_table: str, params: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    cfg = ctx.config.platform.forecasting
    if method == "timesfm":
        return gw.query(timesfm_sql(events_table, cfg), params, max_rows=10000), cfg.timesfm_version or "TimesFM (default)"
    model_id = arima_model_id(ctx)
    gw.query(arima_train_sql(events_table, model_id), params, max_rows=1)
    return gw.query(arima_forecast_sql(model_id, cfg), None, max_rows=10000), model_id


def latest_forecast(ctx: "AgentContext") -> ForecastRun | None:
    rows = ctx.store.list_docs(FORECASTS, where={"status": "ok"}, limit=1)
    return ForecastRun.model_validate(rows[0]) if rows else None


def run_forecast(ctx: "AgentContext", actor: str = "agent", force: bool = False) -> dict[str, Any]:
    """Forecast hourly volume in BigQuery, keep the run, and write staffing recommendations as pending."""
    from . import audit, bq_admin

    cfg = ctx.config.platform.forecasting
    now = ctx.now()
    last = latest_forecast(ctx)
    if last and not force and now - last.created_at < timedelta(minutes=cfg.refresh_minutes):
        return {"skipped": "the forecast is fresh", "run_id": last.run_id}
    events_table = bq_admin.table(ctx, "events")
    if not events_table:
        raise ValueError("Map the events table first (Settings → BigQuery → tables → events).")
    gw = bq_admin.get_gateway(ctx)
    params = {"since": now - timedelta(days=cfg.history_days), "until": now, "types": list(cfg.volume_event_types), "env": ctx.config.env}
    run = ForecastRun(run_id=f"FC-{uuid.uuid4().hex[:10]}", created_at=now, method=cfg.model, horizon_hours=cfg.horizon_hours,
                      confidence_level=cfg.confidence_level, requested_by=actor, env=ctx.config.env)
    methods = [cfg.model] + ([cfg.fallback] if cfg.fallback not in ("none", cfg.model) else [])
    errors: list[str] = []
    rows: list[dict[str, Any]] = []
    for method in methods:
        try:
            rows, run.model = _run_method(ctx, method, gw, events_table, params)
            run.method = method  # type: ignore[assignment]
            run.fallback_from = cfg.model if method != cfg.model else ""
            break
        except Exception as exc:  # noqa: BLE001 - try the fallback; both failing is reported
            errors.append(f"{method}: {exc}"[:400])
            log.warning("forecast with %s failed: %s", method, exc)
    if not rows:
        run.status, run.error = "failed", " | ".join(errors) or "the forecast returned no rows"
        ctx.store.put_doc(FORECASTS, run.run_id, run.model_dump(mode="json"))
        ctx.emit(PlatformEvent.FORECAST_FAILED, actor=actor, payload={"run_id": run.run_id, "error": run.error})
        audit.record(ctx, actor=actor, action="forecast.run", surface="job" if actor == "agent" else "console", target_type="forecast",
                     target_id=run.run_id, summary=f"Forecast failed: {run.error}"[:300], status="error")
        return {"run_id": run.run_id, "status": "failed", "error": run.error, "summary": "forecast failed"}
    run.points = [{"ts": _iso(r["ts"]), "value": max(0.0, float(r.get("value") or 0)),
                   "lower": max(0.0, float(r["lower"])) if r.get("lower") is not None else None,
                   "upper": max(0.0, float(r["upper"])) if r.get("upper") is not None else None,
                   **({k: float(r[k]) for k in ("trend", "daily", "weekly") if r.get(k) is not None})} for r in rows]
    ctx.store.put_doc(FORECASTS, run.run_id, run.model_dump(mode="json"))
    table = bq_admin.table(ctx, "forecasts")
    if table:
        try:
            gw.insert_rows(table, [{"run_id": run.run_id, "created_at": now.isoformat(), "method": run.method, "forecast_ts": p["ts"],
                                    "forecast_value": p["value"], "lower_bound": p["lower"], "upper_bound": p["upper"],
                                    "confidence_level": run.confidence_level} for p in run.points])
        except Exception as exc:  # noqa: BLE001 - the run is kept in the store either way
            log.warning("could not write the forecast to %s: %s", table, exc)
    recs = build_recommendations(ctx, run, actor)
    ctx.emit(PlatformEvent.FORECAST_RUN, actor=actor, model=run.model,
             payload={"run_id": run.run_id, "method": run.method, "points": len(run.points), "fallback_from": run.fallback_from,
                      "recommendations": len(recs)})
    audit.record(ctx, actor=actor, action="forecast.run", surface="job" if actor == "agent" else "console", target_type="forecast",
                 target_id=run.run_id, summary=f"Forecast by {run.method} ({len(run.points)} hours); {len(recs)} recommendation(s) pending")
    return {"run_id": run.run_id, "status": "ok", "method": run.method, "points": len(run.points), "recommendations": len(recs),
            "fallback_from": run.fallback_from, "summary": f"forecast: {run.method}, {len(recs)} recommendation(s)"}


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()


# -- recommendations -------------------------------------------------------------------------------------------------------
class Recommendation(BaseModel):
    rec_id: str
    run_id: str
    kind: Literal["add_coverage", "reduce_coverage"]
    start: datetime
    end: datetime
    required: int  # most IMs needed in any hour of the window
    scheduled: int  # fewest IMs scheduled in any hour of the window
    gap: int
    peak_forecast: float
    suggested_person_id: str | None = None
    suggested_person: str | None = None
    rationale: str = ""
    mid_shift: bool = False  # the window starts within the shift now running
    status: Literal["pending", "accepted", "edited", "dismissed", "expired"] = "pending"
    created_at: datetime
    decided_by: str | None = None
    decided_at: datetime | None = None
    decision_note: str = ""
    applied_override_id: str | None = None
    env: str = "dev"


def _weekly_hours(roster: Roster, person_id: str, around: datetime) -> int:
    start = floor_hour(around) - timedelta(days=3)
    return sum(1 for at, staff in staffing_by_hour(roster, start, start + timedelta(days=7)).items()
               if any(p.id == person_id for p, _ in staff))


def build_recommendations(ctx: "AgentContext", run: ForecastRun, actor: str = "agent") -> list[Recommendation]:
    """Compare the forecast's staffing need with the schedule; write each run of short (or over-staffed) hours as
    one pending recommendation. Pending ones from earlier runs that are still open are replaced."""
    cfg = ctx.config.platform.forecasting
    now = ctx.now()
    roster = ctx.roster(ROSTER_IM)
    for old in list_recommendations(ctx, status="pending"):
        old.status = "expired"
        ctx.store.put_doc(RECS, old.rec_id, old.model_dump(mode="json"))
    points = [(datetime.fromisoformat(p["ts"]), p) for p in run.points if datetime.fromisoformat(p["ts"]) >= floor_hour(now)]
    if not points:
        return []
    staffing = staffing_by_hour(roster, points[0][0], points[-1][0] + HOUR)
    windows: list[dict[str, Any]] = []
    for at, p in points:
        basis = (p["upper"] if cfg.use_upper_bound and p.get("upper") is not None else p["value"])
        need = required_staff(basis, cfg)
        have = len(staffing.get(at, []))
        kind = "add_coverage" if have < need else ("reduce_coverage" if have > need and have > cfg.min_staff and have - need >= 2 else "")
        if not kind:
            continue
        last = windows[-1] if windows else None
        if last and last["kind"] == kind and last["end"] == at:
            last.update({"end": at + HOUR, "required": max(last["required"], need), "scheduled": min(last["scheduled"], have),
                         "peak": max(last["peak"], basis)})
        else:
            windows.append({"kind": kind, "start": at, "end": at + HOUR, "required": need, "scheduled": have, "peak": basis})
    out: list[Recommendation] = []
    tz = tz_of(ctx)
    for w in windows:
        gap = abs(w["required"] - w["scheduled"])
        suggested = None
        if w["kind"] == "add_coverage":
            busy = {p.id for at in staffing if w["start"] <= at < w["end"] for p, _ in staffing[at]}
            free = [p for p in roster.people if p.id not in busy]
            suggested = min(free, key=lambda p: _weekly_hours(roster, p.id, w["start"]), default=None)
        local_s, local_e = w["start"].astimezone(tz), w["end"].astimezone(tz)
        span = f"{local_s:%a %b %-d %H:%M}–{local_e:%H:%M} {local_s.tzname()}"
        rationale = (
            f"{span}: the forecast peaks at {w['peak']:.1f} alerts an hour, which needs {w['required']} IM"
            f"{'' if w['required'] == 1 else 's'} at {cfg.minutes_per_alert:g} minutes an alert and {round(cfg.target_utilization * 100)}% "
            f"utilization; {w['scheduled']} {'is' if w['scheduled'] == 1 else 'are'} scheduled."
            if w["kind"] == "add_coverage" else
            f"{span}: {w['scheduled']} IMs are scheduled and the forecast needs {w['required']} (peak {w['peak']:.1f} alerts an hour).")
        rec = Recommendation(
            rec_id=f"REC-{uuid.uuid4().hex[:10]}", run_id=run.run_id, kind=w["kind"], start=w["start"], end=w["end"],
            required=w["required"], scheduled=w["scheduled"], gap=gap, peak_forecast=round(w["peak"], 2),
            suggested_person_id=suggested.id if suggested else None, suggested_person=suggested.name if suggested else None,
            rationale=rationale, mid_shift=w["start"] - now < timedelta(hours=6), created_at=now, env=ctx.config.env)
        ctx.store.put_doc(RECS, rec.rec_id, rec.model_dump(mode="json"))
        ctx.emit(PlatformEvent.RECOMMENDATION_CREATED, actor=actor, payload={"rec_id": rec.rec_id, "kind": rec.kind, "gap": gap,
                                                                             "start": rec.start.isoformat(), "end": rec.end.isoformat()})
        out.append(rec)
    return out


def list_recommendations(ctx: "AgentContext", status: str | None = None, limit: int = 200) -> list[Recommendation]:
    rows = ctx.store.list_docs(RECS, where={"status": status} if status else None, limit=limit)
    out = [Recommendation.model_validate(r) for r in rows]
    out.sort(key=lambda r: r.start)
    return out


def decide_recommendation(ctx: "AgentContext", rec_id: str, *, actor: str, decision: Literal["accept", "edit", "dismiss"],
                          person_id: str | None = None, start: datetime | None = None, end: datetime | None = None,
                          note: str = "") -> Recommendation:
    """Accept (as proposed), edit (change the person or the window, then apply) or dismiss. Nothing changes the
    schedule until this is called by a person."""
    from . import audit

    row = ctx.store.get_doc(RECS, rec_id)
    if row is None:
        raise KeyError(rec_id)
    rec = Recommendation.model_validate(row)
    if rec.status != "pending":
        raise ValueError(f"This recommendation was already {rec.status}.")
    now = ctx.now()
    if decision in ("accept", "edit"):
        if rec.kind == "add_coverage":
            pid = person_id or rec.suggested_person_id
            roster = ctx.roster(ROSTER_IM)
            person = next((p for p in roster.people if p.id == pid), None)
            if person is None:
                raise ValueError("Choose who covers the window: nobody free was found to suggest.")
            s, e = start or rec.start, end or rec.end
            if e <= s:
                raise ValueError("The window must end after it starts.")
            if e <= now:
                raise ValueError("The window is already over.")
            override = Override(override_id=f"ovr-{uuid.uuid4().hex[:10]}", person_id=person.id, start=s, end=e,
                                reason=f"forecast {rec.rec_id}", set_by=actor, set_via="console", created_at=now)
            roster.overrides.append(override)
            ctx.store.save_roster(roster, actor=actor, name=ROSTER_IM)
            rec.applied_override_id = override.override_id
            rec.suggested_person_id, rec.suggested_person = person.id, person.name
            rec.start, rec.end = s, e
        rec.status = "edited" if decision == "edit" else "accepted"
    else:
        rec.status = "dismissed"
    rec.decided_by, rec.decided_at, rec.decision_note = actor, now, note[:500]
    ctx.store.put_doc(RECS, rec.rec_id, rec.model_dump(mode="json"))
    ctx.emit(PlatformEvent.RECOMMENDATION_DECIDED, actor=actor, space="console",
             payload={"rec_id": rec.rec_id, "decision": rec.status, "kind": rec.kind, "override_id": rec.applied_override_id})
    audit.record(ctx, actor=actor, action=f"workforce.recommendation.{rec.status}", surface="console", target_type="recommendation",
                 target_id=rec.rec_id, summary=f"{rec.status.title()} “{rec.rationale[:160]}”"
                 + (f" → {rec.suggested_person} covers" if rec.applied_override_id else ""))
    return rec


# -- intraday and gap alerts --------------------------------------------------------------------------------------------------
def intraday(ctx: "AgentContext", hours_back: int = 12, hours_ahead: int = 12) -> dict[str, Any]:
    """Live volume next to the forecast, hour by hour, with the staffing need and who is scheduled."""
    cfg = ctx.config.platform.forecasting
    now = ctx.now()
    cur = floor_hour(now)
    start, end = cur - timedelta(hours=hours_back), cur + timedelta(hours=hours_ahead + 1)
    volume = volume_by_hour(ctx, start, now + timedelta(seconds=1))
    staffing = staffing_by_hour(ctx.roster(ROSTER_IM), start, end)
    forecast: dict[datetime, dict[str, Any]] = {}
    runs = [ForecastRun.model_validate(r) for r in ctx.store.list_docs(FORECASTS, where={"status": "ok"}, limit=30)]
    for run in sorted(runs, key=lambda r: r.created_at):  # for each hour, the newest forecast made before that hour began
        for p in run.points:
            ts = datetime.fromisoformat(p["ts"])
            if start <= ts < end and (run.created_at <= ts or ts not in forecast):
                forecast[ts] = {**p, "run_id": run.run_id, "method": run.method}
    rows, alerts = [], []
    at = start
    while at < end:
        f = forecast.get(at)
        actual = volume.get(at, 0) if at <= cur else None
        elapsed = min(1.0, (now - at).total_seconds() / 3600) if at == cur else 1.0
        expected = (f["value"] * elapsed) if f else None
        need_basis = max(actual or 0, f["value"] if f else 0) if at <= cur else (f["value"] if f else 0)
        row = {"hour": at.isoformat(), "actual": actual, "forecast": round(f["value"], 2) if f else None,
               "lower": f.get("lower") if f else None, "upper": f.get("upper") if f else None,
               "staff": len(staffing.get(at, [])), "required": required_staff(need_basis, cfg) if (f or actual is not None) else None,
               "partial": at == cur}
        if f and actual is not None and expected is not None:
            over = actual - expected
            pct = (over / expected * 100) if expected > 0 else (100.0 if over > 0 else 0.0)
            row["gap_pct"] = round(pct, 1)
            if over >= cfg.gap_alert_min_alerts and pct >= cfg.gap_alert_pct and at >= cur - HOUR:
                alerts.append({"hour": at.isoformat(), "actual": actual, "expected": round(expected, 1), "over_by": round(over, 1),
                               "pct": round(pct, 1), "staff": row["staff"], "required": required_staff(actual / max(elapsed, 0.25), cfg)})
        rows.append(row)
        at += HOUR
    return {"as_of": now.isoformat(), "hours": rows, "gap_alerts": alerts, "has_forecast": bool(forecast),
            "method": (runs and sorted(runs, key=lambda r: r.created_at)[-1].method) or None}


def check_gap_alerts(ctx: "AgentContext", actor: str = "agent") -> list[dict[str, Any]]:
    """Raise a gap alert (once an hour) when live volume runs over the forecast; DM the leads when that switch is ON."""
    alerts = intraday(ctx, hours_back=2, hours_ahead=0)["gap_alerts"]
    out = []
    for a in alerts:
        key = f"wf:gap:{a['hour']}"
        if ctx.store.get_kv(key):
            continue
        ctx.store.put_kv(key, {"at": ctx.now().isoformat(), **a})
        ctx.emit(PlatformEvent.GAP_ALERT, actor=actor, payload=a)
        if ctx.flag("forecast_gap_alerts"):
            leads = ctx.config.lead_emails()
            if leads:
                hour = datetime.fromisoformat(a["hour"]).astimezone(tz_of(ctx))
                text = (f"{ctx.config.agent.message_prefix} Volume is over forecast: {a['actual']} alerts since {hour:%H:%M} "
                        f"against {a['expected']} expected (+{a['pct']:.0f}%). {a['staff']} on shift; {a['required']} needed at this pace.")
                ctx.enqueue("dm", text, recipients=leads, source="forecast.notify")
        out.append(a)
    return out


# -- reporting -------------------------------------------------------------------------------------------------------------
def forecast_accuracy(ctx: "AgentContext", days: int = 14) -> dict[str, Any]:
    """MAPE and bias of past forecasts against what came in. For each hour: the newest forecast made before it."""
    now = floor_hour(ctx.now())
    start = now - timedelta(days=days)
    volume = volume_by_hour(ctx, start, now)
    runs = sorted((ForecastRun.model_validate(r) for r in ctx.store.list_docs(FORECASTS, where={"status": "ok"}, limit=500)),
                  key=lambda r: r.created_at)
    chosen: dict[datetime, tuple[float, str]] = {}
    for run in runs:
        for p in run.points:
            ts = datetime.fromisoformat(p["ts"])
            if start <= ts < now and run.created_at <= ts:
                chosen[ts] = (p["value"], run.method)
    errors, abs_pct, by_method = [], [], {}
    for ts, (pred, method) in chosen.items():
        actual = volume.get(ts, 0)
        errors.append(pred - actual)
        if actual > 0:
            ape = abs(pred - actual) / actual
            abs_pct.append(ape)
            by_method.setdefault(method, []).append(ape)
    n = len(errors)
    return {
        "days": days, "hours_scored": n, "hours_with_volume": len(abs_pct),
        "mape_pct": round(100 * sum(abs_pct) / len(abs_pct), 1) if abs_pct else None,
        "mae": round(sum(abs(e) for e in errors) / n, 2) if n else None,
        "bias": round(sum(errors) / n, 2) if n else None,
        "by_method": {m: round(100 * sum(v) / len(v), 1) for m, v in by_method.items()},
    }


def report(ctx: "AgentContext", days: int = 14) -> dict[str, Any]:
    """Coverage, utilization, forecast accuracy and the gaps, for the reporting view and the export."""
    cfg = ctx.config.platform.forecasting
    hist = historicals(ctx, days)
    hours = sum(d["hours"] for d in hist["by_day"])
    covered = sum(d["covered_hours"] for d in hist["by_day"])
    staff_hours = sum(d["staff_hours"] for d in hist["by_day"])
    volume = hist["total_volume"]
    return {
        "days": days,
        "coverage_pct": round(100 * covered / hours, 1) if hours else None,
        "utilization_pct": round(100 * volume * cfg.minutes_per_alert / (staff_hours * 60), 1) if staff_hours else None,
        "staff_hours": staff_hours, "volume": volume, "alerts_per_staff_hour": round(volume / staff_hours, 2) if staff_hours else None,
        "unstaffed_hours_with_volume": sum(1 for g in hist["gaps"] if g["staff"] == 0),
        "accuracy": forecast_accuracy(ctx, days), "by_day": hist["by_day"], "gaps": hist["gaps"],
        "assumptions": {"minutes_per_alert": cfg.minutes_per_alert, "target_utilization": cfg.target_utilization, "min_staff": cfg.min_staff},
    }


def report_csv(ctx: "AgentContext", days: int = 14) -> str:
    data = report(ctx, days)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["section", "date_or_start", "end", "volume", "staff_hours", "required_hours", "covered_hours", "hours", "coverage_pct", "short_by"])
    for d in data["by_day"]:
        w.writerow(["day", d["date"], "", d["volume"], d["staff_hours"], d["required_hours"], d["covered_hours"], d["hours"], d["coverage_pct"], ""])
    for g in data["gaps"]:
        w.writerow(["gap", g["start"], g["end"], g["volume"], g["staff"], g["required"], "", "", "", g["short_by"]])
    acc = data["accuracy"]
    w.writerow(["summary", f"last {days} days", "", data["volume"], data["staff_hours"], "", "", "", data["coverage_pct"], ""])
    w.writerow(["utilization_pct", data["utilization_pct"], "", "", "", "", "", "", "", ""])
    w.writerow(["forecast_mape_pct", acc["mape_pct"], "hours_scored", acc["hours_scored"], "", "", "", "", "", ""])
    return out.getvalue()
