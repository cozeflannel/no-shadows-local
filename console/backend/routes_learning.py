"""Learning endpoints: config-change proposals and taught facts (approve / reject via ops)."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ValidationError

from triage_agent.config import AgentConfig, deep_merge
from triage_agent.context import AgentContext
from triage_agent.models import ConfigChangeProposal, ProposalStatus

from .auth import User, get_ctx, require_admin, require_lead, require_viewer
from .ops import op_available, run_op

router = APIRouter(prefix="/api", tags=["learning"])


class DecisionBody(BaseModel):
    decision: Literal["approve", "reject"]


def _status(status: str | None) -> ProposalStatus | None:
    if not status:
        return None
    try:
        return ProposalStatus(status.strip().upper())
    except ValueError as exc:
        raise HTTPException(422, {"error": f"Unknown status: {status}", "code": "validation_error"}) from exc


def preview_patch(ctx: AgentContext, patch: dict[str, Any]) -> dict[str, Any]:
    """Would applying this merge patch to the effective config still validate?"""
    try:
        AgentConfig.model_validate(deep_merge(ctx.config.model_dump(mode="json"), patch or {}))
    except ValidationError as exc:
        errors = [{"loc": list(e.get("loc", ())), "msg": e.get("msg", "invalid")}
                  for e in exc.errors(include_url=False, include_context=False, include_input=False)]
        return {"valid": False, "errors": errors[:20]}
    return {"valid": True, "errors": []}


def proposal_json(ctx: AgentContext, p: ConfigChangeProposal) -> dict[str, Any]:
    data = p.model_dump(mode="json")
    data["sections"] = sorted((p.patch or {}).keys())
    data["preview"] = preview_patch(ctx, p.patch) if p.status == ProposalStatus.PENDING else None
    return data


@router.get("/proposals")
def get_proposals(
    status: str | None = Query(None, description="PENDING | APPROVED | REJECTED"),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    items = sorted(ctx.store.list_proposals(status=_status(status), limit=1000), key=lambda p: p.created_at, reverse=True)
    return {
        "proposals": [proposal_json(ctx, p) for p in items],
        "pending": sum(1 for p in items if p.status == ProposalStatus.PENDING),
        "op_available": op_available("decide_proposal"),
    }


@router.post("/proposals/{proposal_id}")
def post_proposal_decision(
    proposal_id: str,
    body: DecisionBody,
    request: Request,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    proposal = ctx.store.get_proposal(proposal_id)
    if proposal is None:
        raise HTTPException(404, {"error": f"Proposal {proposal_id} not found", "code": "not_found"})
    if proposal.status != ProposalStatus.PENDING:
        raise HTTPException(409, {"error": f"Proposal {proposal_id} is already {proposal.status.value}", "code": "conflict"})
    if body.decision == "approve":
        preview = preview_patch(ctx, proposal.patch)
        if not preview["valid"]:
            raise HTTPException(422, {"error": "This change would make the configuration invalid; reject it or fix it in Settings",
                                      "code": "validation_error", "errors": preview["errors"]})
    result = run_op(ctx, "decide_proposal", {"id": proposal.proposal_id, "decision": body.decision, "actor": user.email}, user)
    ctx = request.app.state.console.reload()  # an approved patch changes the effective config
    updated = ctx.store.get_proposal(proposal.proposal_id)
    return {**result, "proposal": proposal_json(ctx, updated) if updated else None}


@router.get("/facts")
def get_facts(
    status: str | None = Query(None, description="PENDING | APPROVED | REJECTED"),
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_viewer),
) -> dict[str, Any]:
    items = sorted(ctx.store.list_facts(status=_status(status), limit=2000), key=lambda f: f.created_at, reverse=True)
    return {
        "facts": [f.model_dump(mode="json") for f in items],
        "pending": sum(1 for f in items if f.status == ProposalStatus.PENDING),
        "op_available": op_available("decide_fact"),
    }


@router.post("/facts/{fact_id}")
def post_fact_decision(
    fact_id: str,
    body: DecisionBody,
    ctx: AgentContext = Depends(get_ctx),
    user: User = Depends(require_lead),
) -> dict[str, Any]:
    fact = ctx.store.get_fact(fact_id)
    if fact is None:
        raise HTTPException(404, {"error": f"Fact {fact_id} not found", "code": "not_found"})
    if fact.status != ProposalStatus.PENDING:
        raise HTTPException(409, {"error": f"Fact {fact_id} is already {fact.status.value}", "code": "conflict"})
    result = run_op(ctx, "decide_fact", {"id": fact.fact_id, "decision": body.decision, "actor": user.email}, user)
    updated = ctx.store.get_fact(fact.fact_id)
    return {**result, "fact": updated.model_dump(mode="json") if updated else None}
