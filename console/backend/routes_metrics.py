"""Metrics endpoints: KPIs (metrics.compute_kpis + KPI_DEFINITIONS), timeseries, errors, failures by on-call."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query

from triage_agent.context import AgentContext
from triage_agent.events import EventType as E
from triage_agent.metrics import KPI_DEFINITIONS, compute_kpis, error_breakdown, failures_by_oncall, timeseries, window

from .auth import User, get_ctx, require_viewer

router = APIRouter(prefix="/api", tags=["metrics"])

# Display order + labels for KPI_DEFINITIONS groups.
KPI_GROUPS: list[dict[str, str]] = [
    {"key": "intake", "label": "Alerts in, and what the agent did", "description": "What arrived and what the agent decided."},
    {"key": "quality", "label": "Fixes and disagreements", "description": "Fields the agent fixed, and how often an IM said it was wrong."},
    {"key": "im", "label": "Incident Manager work", "description": "Reactions, emoji actions, protocol pings and SLAs."},
    {"key": "email", "label": "Social Alert emails", "description": "Drafts in the IMs' Gmail (Brand Social alias) and what happened to them."},
    {"key": "tns", "label": "Trust & Safety", "description": "go/WD-Triage forms, their outcomes and the Watchdog loop."},
    {"key": "chat", "label": "Questions in Chat", "description": "Questions the agent answered or passed on in Chat."},
    {"key": "parity", "label": "In-house alerts and Burson's", "description": "Posts both caught, or only one of them."},
    {"key": "jobs", "label": "Scheduled posts", "description": "Shift handovers and Burson digests."},
]

DEFAULT_TIMESERIES_TYPES = [
    E.ALERT_RECEIVED,
    E.TRIAGE_PASSED,
    E.TRIAGE_CORRECTED,
    E.TRIAGE_SUPPRESSED,
    E.TRIAGE_FAILED,
    E.TRIAGE_NEEDS_REVIEW,
    E.EMAIL_DRAFTED,
    E.EMAIL_SENT,
    E.SLA_MET,
    E.SLA_MISSED,
]


def env_filter(ctx: AgentContext, env: str | None) -> str | None:
    """Events of the Console's own env by default; env=all disables the filter."""
    if env == "all":
        return None
    return env or ctx.config.env


def kpi_definitions() -> list[dict[str, str]]:
    return [{"key": k, "label": label, "description": desc, "group": group} for k, (label, desc, group) in KPI_DEFINITIONS.items()]


def _window_json(days: int, since: datetime, until: datetime, env: str | None) -> dict[str, Any]:
    return {"days": days, "since": since, "until": until, "env": env}


@router.get("/kpis")
def get_kpis(
    days: int = Query(7, ge=1, le=180),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    since, until = window(days, now=ctx.now())
    env_f = env_filter(ctx, env)
    events = ctx.events.query(since=since, until=until, env=env_f)
    previous_events = ctx.events.query(since=since - (until - since), until=since, env=env_f)
    result = compute_kpis(events, ctx.config)
    previous = compute_kpis(previous_events, ctx.config)
    return {
        "window": _window_json(days, since, until, env_f),
        "kpis": result["kpis"],
        "derived": result["derived"],
        "previous": {"kpis": previous["kpis"], "derived": previous["derived"], "event_count": len(previous_events)},
        "definitions": kpi_definitions(),
        "groups": KPI_GROUPS,
        "event_count": len(events),
        "metrics_config": ctx.config.metrics.model_dump(mode="json"),
    }


def _fill_buckets(rows: list[dict], types: list[str], since: datetime, until: datetime, bucket: str, tz: str) -> list[dict]:
    zone = ZoneInfo(tz)
    by_key = {r["bucket"]: r for r in rows}
    keys: list[str] = []
    if bucket == "day":
        day = since.astimezone(zone).date()
        last = until.astimezone(zone).date()
        while day <= last:
            keys.append(day.isoformat())
            day += timedelta(days=1)
    else:
        t = since.replace(minute=0, second=0, microsecond=0)
        while t < until:
            key = t.astimezone(zone).strftime("%Y-%m-%dT%H:00")
            if key not in keys:
                keys.append(key)
            t += timedelta(hours=1)
    for key in by_key:
        if key not in keys:
            keys.append(key)
    return [by_key.get(k) or {"bucket": k, **{t: 0 for t in types}} for k in sorted(keys)]


@router.get("/timeseries")
def get_timeseries(
    days: int = Query(30, ge=1, le=180),
    bucket: Literal["day", "hour"] = "day",
    types: str | None = Query(None, description="Comma-separated event types (default: intake + email + SLA)"),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    if bucket == "hour" and days > 14:
        raise HTTPException(422, {"error": "Hourly buckets are limited to 14 days", "code": "validation_error"})
    type_list = [t.strip() for t in types.split(",") if t.strip()] if types else list(DEFAULT_TIMESERIES_TYPES)
    unknown = [t for t in type_list if t not in E.all()]
    if unknown:
        raise HTTPException(422, {"error": f"Unknown event type(s): {', '.join(unknown)}", "code": "validation_error"})
    since, until = window(days, now=ctx.now())
    env_f = env_filter(ctx, env)
    events = ctx.events.query(since=since, until=until, types=type_list, env=env_f)
    rows = timeseries(events, type_list, bucket=bucket, tz=ctx.config.timezone)
    return {
        "window": _window_json(days, since, until, env_f),
        "bucket": bucket,
        "timezone": ctx.config.timezone,
        "types": type_list,
        "rows": _fill_buckets(rows, type_list, since, until, bucket, ctx.config.timezone),
    }


@router.get("/errors")
def get_errors(
    days: int = Query(7, ge=1, le=180),
    top: int = Query(15, ge=1, le=100),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    since, until = window(days, now=ctx.now())
    env_f = env_filter(ctx, env)
    events = ctx.events.query(since=since, until=until, types=[E.TRIAGE_FAILED, E.TRIAGE_NEEDS_REVIEW, E.ERROR], env=env_f)
    op_errors: dict[str, int] = {}
    for e in events:
        if e.event_type == E.ERROR:
            op = str((e.payload or {}).get("op") or "unknown")
            op_errors[op] = op_errors.get(op, 0) + 1
    return {
        "window": _window_json(days, since, until, env_f),
        "rule_codes": error_breakdown(events, top=top),
        "operation_errors": [{"op": k, "count": v} for k, v in sorted(op_errors.items(), key=lambda kv: -kv[1])],
    }


@router.get("/failures-by-oncall")
def get_failures_by_oncall(
    days: int = Query(7, ge=1, le=180),
    env: str | None = None,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    since, until = window(days, now=ctx.now())
    env_f = env_filter(ctx, env)
    events = ctx.events.query(since=since, until=until, types=[E.TRIAGE_FAILED], env=env_f)
    return {"window": _window_json(days, since, until, env_f), "rows": failures_by_oncall(events)}
