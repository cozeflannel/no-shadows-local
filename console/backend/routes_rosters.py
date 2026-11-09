"""Roster endpoints: 'slrr_im' (IM shifts) and 'burson' (Burson on-call), schedules, overrides, on-call now."""

from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from triage_agent.context import AgentContext
from triage_agent.events import EventType as E
from triage_agent.models import Override, Person, ReminderPolicy, Roster, RotationSlot
from triage_agent.oncall.roster import WEEKDAYS, escalation_chain, resolve_on_call, schedule

from .auth import User, get_ctx, require_admin, require_analyst, require_viewer

router = APIRouter(prefix="/api", tags=["rosters"])

ROSTERS: dict[str, dict[str, str]] = {
    "slrr_im": {"label": "IM shifts", "description": "Incident Managers on shift: reviews, SLA nudges, Gmail drafts, handovers."},
    "burson": {"label": "Burson on-call", "description": "Burson agency on-call: @mentioned when an alert can't be verified and needs a corrected rerun."},
}
COVERED_SOURCES = ("override", "rotation")


def _roster_name(name: str) -> str:
    if name not in ROSTERS:
        raise HTTPException(404, {"error": f"Unknown roster '{name}' (use slrr_im or burson)", "code": "not_found"})
    return name


def _person_json(p: Person | None) -> dict[str, Any] | None:
    return p.model_dump(mode="json") if p else None


def roster_view(ctx: AgentContext, name: str) -> dict[str, Any]:
    roster = ctx.roster(name)
    now = ctx.now()
    upcoming = schedule(roster, now, now + timedelta(days=2), step_minutes=15)
    nxt = upcoming[1] if len(upcoming) > 1 else None
    return {
        "name": name,
        **ROSTERS[name],
        "roster": roster.model_dump(mode="json"),
        "on_call_now": resolve_on_call(roster, now).model_dump(mode="json"),
        "next": nxt,
        "escalation_chain": [_person_json(p) for p in escalation_chain(roster, now)],
        "timezone": ctx.config.timezone,
        "weekdays": WEEKDAYS,
    }


@router.get("/rosters/{name}")
def get_roster(name: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return roster_view(ctx, _roster_name(name))


class RosterBody(BaseModel):
    people: list[Person] = Field(default_factory=list)
    rotation: list[RotationSlot] = Field(default_factory=list)
    backup_person_id: str | None = None
    fallback: Person | None = None
    reminders: ReminderPolicy = Field(default_factory=ReminderPolicy)


def _valid_hhmm(value: str) -> bool:
    try:
        hours, minutes = value.strip().split(":")
        return 0 <= int(hours) <= 23 and 0 <= int(minutes) <= 59 and len(minutes) == 2
    except (ValueError, AttributeError):
        return False


def validate_roster(body: RosterBody, current: Roster, now: datetime) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    ids = [p.id.strip() for p in body.people]
    seen: set[str] = set()
    for i, p in enumerate(body.people):
        if not p.id.strip():
            errors.append({"loc": ["people", i, "id"], "msg": "Person id is required"})
        elif p.id in seen:
            errors.append({"loc": ["people", i, "id"], "msg": f"Duplicate person id '{p.id}'"})
        seen.add(p.id)
        if not p.name.strip():
            errors.append({"loc": ["people", i, "name"], "msg": "Name is required"})
        if "@" not in p.email:
            errors.append({"loc": ["people", i, "email"], "msg": f"'{p.email}' is not an email address"})
    for i, slot in enumerate(body.rotation):
        if slot.person_id not in ids:
            errors.append({"loc": ["rotation", i, "person_id"], "msg": f"'{slot.person_id}' is not in the people list"})
        if not slot.days:
            errors.append({"loc": ["rotation", i, "days"], "msg": "Pick at least one day"})
        for key in ("start", "end"):
            if not _valid_hhmm(getattr(slot, key)):
                errors.append({"loc": ["rotation", i, key], "msg": f"'{getattr(slot, key)}' is not HH:MM"})
        try:
            ZoneInfo(slot.tz)
        except (ZoneInfoNotFoundError, ValueError):
            errors.append({"loc": ["rotation", i, "tz"], "msg": f"Unknown timezone '{slot.tz}'"})
    if body.backup_person_id and body.backup_person_id not in ids:
        errors.append({"loc": ["backup_person_id"], "msg": f"Backup '{body.backup_person_id}' is not in the people list"})
    if body.fallback and "@" not in body.fallback.email:
        errors.append({"loc": ["fallback", "email"], "msg": "Fallback needs an email address"})
    for o in current.overrides:
        if o.end > now and o.person_id not in ids:
            errors.append({"loc": ["people"], "msg": f"Remove the active/upcoming override {o.override_id} for '{o.person_id}' before removing that person"})
    return errors


@router.put("/rosters/{name}")
def put_roster(name: str, body: RosterBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    name = _roster_name(name)
    current = ctx.roster(name)
    errors = validate_roster(body, current, ctx.now())
    if errors:
        raise HTTPException(422, {"error": "The roster has errors", "code": "validation_error", "errors": errors})
    roster = Roster(
        people=body.people,
        rotation=body.rotation,
        overrides=current.overrides,  # overrides are managed with their own endpoints
        backup_person_id=body.backup_person_id or None,
        fallback=body.fallback,
        reminders=body.reminders,
    )
    ctx.store.save_roster(roster, actor=user.email, name=name)
    ctx.emit(E.ROSTER_UPDATED, actor=user.email, space="console",
             payload={"roster": name, "via": "console", "people": len(roster.people), "rotation": len(roster.rotation)})
    return roster_view(ctx, name)


class OverrideBody(BaseModel):
    person_id: str
    start: datetime
    end: datetime
    reason: str | None = Field(None, max_length=500)


def _aware(dt: datetime, tz: str) -> datetime:
    return dt.replace(tzinfo=ZoneInfo(tz)) if dt.tzinfo is None else dt


@router.post("/rosters/{name}/overrides")
def post_override(name: str, body: OverrideBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    name = _roster_name(name)
    roster = ctx.roster(name)
    now = ctx.now()
    start = _aware(body.start, ctx.config.timezone).astimezone(timezone.utc)
    end = _aware(body.end, ctx.config.timezone).astimezone(timezone.utc)
    errors = []
    if body.person_id not in {p.id for p in roster.people}:
        errors.append({"loc": ["person_id"], "msg": f"'{body.person_id}' is not in the {ROSTERS[name]['label']} people list"})
    if end <= start:
        errors.append({"loc": ["end"], "msg": "End must be after start"})
    if end <= now:
        errors.append({"loc": ["end"], "msg": "This override would already be over"})
    if end - start > timedelta(days=31):
        errors.append({"loc": ["end"], "msg": "Overrides are limited to 31 days; edit the rotation instead"})
    if errors:
        raise HTTPException(422, {"error": "Invalid override", "code": "validation_error", "errors": errors})
    override = Override(
        override_id=f"ovr-{uuid.uuid4().hex[:10]}",
        person_id=body.person_id,
        start=start,
        end=end,
        reason=(body.reason or "").strip() or None,
        set_by=user.email,
        set_via="console",
        created_at=now,
    )
    roster.overrides.append(override)
    ctx.store.save_roster(roster, actor=user.email, name=name)
    ctx.emit(
        E.ONCALL_OVERRIDE_SET,
        actor=user.email,
        space="console",
        payload={"roster": name, "person_id": body.person_id, "start": start.isoformat(), "end": end.isoformat(),
                 "via": "console", "override_id": override.override_id, "reason": override.reason},
    )
    return {"override": override.model_dump(mode="json"), **roster_view(ctx, name)}


@router.delete("/rosters/{name}/overrides/{override_id}")
def delete_override(name: str, override_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    name = _roster_name(name)
    roster = ctx.roster(name)
    match = next((o for o in roster.overrides if o.override_id == override_id), None)
    if match is None:
        raise HTTPException(404, {"error": f"Override {override_id} not found", "code": "not_found"})
    roster.overrides = [o for o in roster.overrides if o.override_id != override_id]
    ctx.store.save_roster(roster, actor=user.email, name=name)
    ctx.emit(E.ROSTER_UPDATED, actor=user.email, space="console",
             payload={"roster": name, "via": "console", "override_removed": override_id, "person_id": match.person_id})
    return roster_view(ctx, name)


@router.get("/rosters/{name}/schedule")
def get_schedule(
    name: str,
    days: int = Query(7, ge=1, le=28),
    start: date | None = Query(None, description="First day (YYYY-MM-DD, display timezone); default today"),
    step: int = Query(15, ge=5, le=60),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    name = _roster_name(name)
    roster = ctx.roster(name)
    tz = ZoneInfo(ctx.config.timezone)
    now = ctx.now()
    first = start or now.astimezone(tz).date()
    start_dt = datetime.combine(first, time(0), tzinfo=tz).astimezone(timezone.utc)
    end_dt = datetime.combine(first + timedelta(days=days), time(0), tzinfo=tz).astimezone(timezone.utc)
    segments = schedule(roster, start_dt, end_dt, step_minutes=step)
    for s in segments:
        s["gap"] = s["source"] not in COVERED_SOURCES
    day_rows = []
    for i in range(days):
        d = first + timedelta(days=i)
        day_start = datetime.combine(d, time(0), tzinfo=tz).astimezone(timezone.utc)
        day_end = datetime.combine(d + timedelta(days=1), time(0), tzinfo=tz).astimezone(timezone.utc)
        blocks = []
        for s in segments:
            lo, hi = max(s["start"], day_start), min(s["end"], day_end)
            if lo >= hi:
                continue
            blocks.append({
                **{k: s[k] for k in ("person_id", "name", "email", "source", "gap")},
                "start": lo,
                "end": hi,
                "start_min": round((lo - day_start).total_seconds() / 60),
                "end_min": round((hi - day_start).total_seconds() / 60),
            })
        day_rows.append({
            "date": d.isoformat(),
            "weekday": WEEKDAYS[d.weekday()],
            "minutes": round((day_end - day_start).total_seconds() / 60),
            "blocks": blocks,
        })
    gaps = [{"start": s["start"], "end": s["end"], "source": s["source"], "name": s["name"]} for s in segments if s["gap"]]
    return {
        "name": name,
        "timezone": ctx.config.timezone,
        "start": start_dt,
        "end": end_dt,
        "now": now,
        "step_minutes": step,
        "segments": segments,
        "gaps": gaps,
        "gap_minutes": round(sum((g["end"] - g["start"]).total_seconds() for g in gaps) / 60),
        "days": day_rows,
        "people": [p.model_dump(mode="json") for p in roster.people] + ([roster.fallback.model_dump(mode="json")] if roster.fallback else []),
    }


@router.get("/oncall/now")
def get_oncall_now(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    now = ctx.now()
    out = {}
    for name, meta in ROSTERS.items():
        roster = ctx.roster(name)
        upcoming = schedule(roster, now, now + timedelta(days=2), step_minutes=15)
        out[name] = {
            "label": meta["label"],
            **resolve_on_call(roster, now).model_dump(mode="json"),
            "next": upcoming[1] if len(upcoming) > 1 else None,
        }
    return {"now": now, "timezone": ctx.config.timezone, "rosters": out}
