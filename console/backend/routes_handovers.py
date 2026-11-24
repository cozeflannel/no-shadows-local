"""Handovers on Workforce: one per shift, made when the shift ends or when a person asks, with people's notes."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from triage_agent import audit, handovers
from triage_agent.context import AgentContext

from .auth import User, get_ctx, require_analyst, require_viewer

router = APIRouter(prefix="/api", tags=["handovers"])
GONE = {"error": "That handover is no longer kept.", "code": "not_found"}


@router.get("/handovers")
def handovers_list(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    now = ctx.now()
    name, start, end = handovers.last_shift(ctx)
    return {"handovers": handovers.between(ctx, now - timedelta(days=ctx.config.platform.reports.keep_days), now)[:60],
            "last_shift": {"shift": name, "start": start.isoformat(), "end": end.isoformat(),
                           "done": handovers.get(ctx, handovers._id(name, end)) is not None},
            "posts_to_team": ctx.config.handover.post_to_team, "can_make": user.has("analyst")}


@router.post("/handovers")
def handovers_make(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Make the handover of the shift that ended last, now. A shift is handed over once."""
    name, _, end = handovers.last_shift(ctx)
    new = handovers.get(ctx, handovers._id(name, end)) is None
    doc = handovers.make_now(ctx, by=user.email)
    if new:
        audit.record(ctx, actor=user.email, action="handover.make", surface="console", target_type="handover", target_id=doc["id"],
                     summary=f"Made the handover for {doc['shift']}")
    return doc


@router.get("/handovers/{handover_id}")
def handovers_get(handover_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    found = handovers.detail(ctx, handover_id)
    if found is None:
        raise HTTPException(404, GONE)
    return {**found, "can_note": user.has("analyst")}


class NoteBody(BaseModel):
    text: str


@router.post("/handovers/{handover_id}/notes")
def handovers_note(handover_id: str, body: NoteBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Add a note to a handover. It is kept as that person's."""
    try:
        note = handovers.add_note(ctx, handover_id, body.text, by=user.email)
    except KeyError as exc:
        raise HTTPException(404, GONE) from exc
    except ValueError as exc:
        raise HTTPException(422, {"error": str(exc), "code": "validation_error"}) from exc
    audit.record(ctx, actor=user.email, action="handover.note", surface="console", target_type="handover", target_id=handover_id,
                 summary="Added a note to a handover")
    return note
