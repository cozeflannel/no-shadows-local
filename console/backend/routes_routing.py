"""The Routing page: the spaces the QA chatbot reads and copies, the Safety valve, and messages waiting for Send."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from triage_agent import mirror
from triage_agent.context import AgentContext

from .auth import User, get_ctx, require_admin, require_analyst, require_viewer
from .routes_admin import PartBody, save_part

router = APIRouter(prefix="/api", tags=["routing"])
SPACES = ("source", "mirror", "third")


def _status(ctx: AgentContext, user: User) -> dict[str, Any]:
    return {**mirror.status(ctx), "can_edit": user.has("admin"), "can_act": user.has("analyst")}


@router.get("/routing")
def routing_get(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    return _status(ctx, user)


class RoutingBody(BaseModel):
    value: dict[str, Any]


@router.put("/routing")
def routing_put(body: RoutingBody, request: Request, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Saves the spaces and switches. A space may be pasted as a link or an id; a setting left out keeps its value."""
    value = {**ctx.config.platform.routing.model_dump(mode="json"), **body.value}
    for key in SPACES:
        try:
            value[key] = mirror.space_ref(str(value.get(key) or ""))
        except ValueError as exc:
            raise HTTPException(422, {"error": str(exc), "code": "validation_error", "field": key}) from exc
    save_part("routing", PartBody(value=value), request, ctx, user, label="Routing", action="routing.save")
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
