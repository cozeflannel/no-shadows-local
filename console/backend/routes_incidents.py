"""Incident reports and the calendar they show on (the Review feed and Workforce)."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from triage_agent import audit, handovers, incidents
from triage_agent.context import AgentContext

from .auth import User, get_ctx, require_analyst, require_viewer

router = APIRouter(prefix="/api", tags=["incidents"])


def _refuse(why: str) -> HTTPException:
    return HTTPException(422, {"error": why, "code": "validation_error"})


@router.get("/calendar")
def calendar(start: str, end: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    """What a calendar draws between two dates: each incident report as an event, from its alert's arrival to its end
    (an open one runs to now), and each handover over its shift."""
    now = ctx.now()
    try:
        since, until = (datetime.fromisoformat(v) for v in (start, end))
    except ValueError as exc:
        raise _refuse("Give the start and the end as dates.") from exc
    since, until = (d if d.tzinfo else d.replace(tzinfo=now.tzinfo) for d in (since, until))
    most = ctx.config.platform.reports.max_days
    if since >= until:
        raise _refuse("The start must be before the end.")
    if until - since > timedelta(days=most):
        raise _refuse(f"A calendar view covers at most {most} days.")
    events = [{"kind": "incident", "id": i["id"], "title": i["name"], "start": i["started_at"], "end": i["ended_at"] or max(now, since).isoformat(),
               "open": i["status"] == "open", "priority": i["priority"], "notes": i["notes"]} for i in incidents.between(ctx, since, until)]
    events += [{"kind": "handover", "id": h["id"], "title": f"Handover: {h['shift']}", "start": h["start"], "end": h["end"], "open": False,
                "priority": "", "notes": h["notes"]} for h in handovers.between(ctx, since, until)]
    why = incidents.why_off(ctx)
    return {"events": events, "incident_reports": {"on": not why, "why": why}, "can_open": user.has("analyst")}


class OpenBody(BaseModel):
    case_id: str


@router.post("/incidents")
def incident_open(body: OpenBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Open an incident report for an alert by hand. One per alert: opening it again gives back the one there is."""
    case = ctx.store.get_case(body.case_id.strip().upper())
    if case is None:
        raise HTTPException(404, {"error": f"There is no alert {body.case_id}.", "code": "not_found"})
    new = incidents.get(ctx, case.case_id) is None
    doc = incidents.open_for(ctx, case, by=user.email)
    if new:
        audit.record(ctx, actor=user.email, action="incident.open", surface="console", target_type="incident", target_id=doc["id"],
                     summary=f"Opened an incident report for {case.case_id}", case_id=case.case_id)
    return doc


@router.get("/incidents/{incident_id}")
def incident_get(incident_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    incidents.sync_one(ctx, incident_id)  # read fresh: what happened a moment ago is on the list
    found = incidents.detail(ctx, incident_id)
    if found is None:
        raise HTTPException(404, {"error": "That incident report is no longer kept.", "code": "not_found"})
    return {**found, "can_note": user.has("analyst")}


class NoteBody(BaseModel):
    text: str


@router.post("/incidents/{incident_id}/notes")
def incident_note(incident_id: str, body: NoteBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Add a note to an incident report. It is kept as that person's."""
    try:
        note = incidents.add_note(ctx, incident_id, body.text, by=user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": "That incident report is no longer kept.", "code": "not_found"}) from exc
    except ValueError as exc:
        raise _refuse(str(exc)) from exc
    audit.record(ctx, actor=user.email, action="incident.note", surface="console", target_type="incident", target_id=incident_id,
                 summary="Added a note to an incident report", case_id=incident_id)
    return note
