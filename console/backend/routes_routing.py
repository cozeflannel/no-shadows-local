"""The Routing page: the spaces the QA chatbot reads and copies, the Safety valve, and messages waiting for Send."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from triage_agent import chatdelivery, chatreview, mirror
from triage_agent.context import AgentContext

from .auth import User, get_ctx, require_admin, require_analyst, require_viewer
from .routes_admin import PartBody, save_part

router = APIRouter(prefix="/api", tags=["routing"])
SPACES = ("source", "mirror", "third")


def _status(ctx: AgentContext, user: User) -> dict[str, Any]:
    return {**mirror.status(ctx), "review": chatreview.status(ctx), "delivery": chatdelivery.status(ctx), "can_edit": user.has("admin"),
            "can_act": user.has("analyst")}


@router.get("/routing")
def routing_get(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return _status(ctx, user)


class RoutingBody(BaseModel):
    value: dict[str, Any]


@router.put("/routing")
def routing_put(body: RoutingBody, request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Saves the spaces and switches. A space may be pasted as a link or an id; a setting left out keeps its value.
    The Safety valve is the Testing switch under Safety and Testing: one valve for emails and for Chat."""
    given = dict(body.value)
    valve = given.pop("safety_valve", None)
    value = {**ctx.config.platform.routing.model_dump(mode="json"), **given}
    for key in SPACES:
        try:
            value[key] = mirror.space_ref(str(value.get(key) or ""))
        except ValueError as exc:
            raise HTTPException(422, {"error": str(exc), "code": "validation_error", "field": key}) from exc
    save_part("routing", PartBody(value=value), request, ctx, user, label="Routing", action="routing.save")
    if valve is not None and bool(valve) != ctx.config.platform.safety.testing:
        fresh = request.app.state.console.ctx
        safety = {**fresh.config.platform.safety.model_dump(mode="json"), "testing": bool(valve)}
        save_part("safety", PartBody(value=safety, note=f"Safety valve turned {'ON' if valve else 'OFF'} on the Routing page"), request, fresh, user,
                  label="Safety valve", action="routing.valve")
    return _status(request.app.state.console.ctx, user)


class DecideBody(BaseModel):
    action: Literal["send", "skip"]


@router.post("/routing/queue/{item_id}")
def routing_decide(item_id: str, body: DecideBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Send or Skip on a message waiting for the source space."""
    try:
        doc = mirror.decide(ctx, item_id, body.action, user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": "That message is not waiting any more.", "code": "not_found"}) from exc
    except (mirror.Conflict, mirror.chatapi.Refused) as exc:
        raise HTTPException(409, {"error": str(exc), "code": "conflict"}) from exc
    except (mirror.chatapi.ChatError, mirror.chatapi.NotSignedIn) as exc:
        raise HTTPException(502, {"error": f"Chat did not take the message: {exc}", "code": "chat_failed"}) from exc
    return {"id": doc["id"], "status": doc["status"], "message": doc.get("message", "")}


@router.post("/routing/delivery/{outbox_id}/retry")
def routing_retry(outbox_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    """Try again on a queued post that was given up: the next minute's pass posts it."""
    try:
        doc = chatdelivery.retry(ctx, outbox_id, user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": "That post is not waiting to be tried again.", "code": "not_found"}) from exc
    return {"id": doc["id"], "status": doc["status"]}


class PersonBody(BaseModel):
    user: str = Field(..., min_length=1, max_length=200)
    name: str = Field("", max_length=60)
    org: Literal["", "Burson", "Google"] = ""


@router.put("/routing/people")
def routing_person(body: PersonBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """A person's name and side, so their copied messages read "Name (Burson): ..."."""
    try:
        return mirror.name_person(ctx, body.user, body.name, body.org, user.email)
    except KeyError as exc:
        raise HTTPException(404, {"error": "That person has not been seen in Chat yet.", "code": "not_found"}) from exc
