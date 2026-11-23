"""The Agent alerts page: alerts the agent raises itself (triage_agent.ownalerts).

What the page is given, a run and the set-up of the BigQuery objects started by hand, the rules each new post is
checked against, and an analyst's verdict on an alert. Its settings are a Settings page of their own (own_alerts).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from triage_agent import bq_admin
from triage_agent.config import switch_off
from triage_agent.context import AgentContext
from triage_agent.models import SPACE_TARGETS
from triage_agent.ownalerts import POST_SWITCH, SWITCH, cycle, feedback, kof, review, rules, schema, sources

from .auth import User, get_ctx, require_admin, require_analyst, require_lead, require_viewer

router = APIRouter(prefix="/api/own", tags=["agent alerts"])
NAME = "Agent alerts"
VERDICT_WORDS = {"TRUE_POSITIVE": "Confirmed", "FALSE_POSITIVE": "False positive"}


def _state(ctx: AgentContext) -> dict[str, Any]:
    cfg = ctx.config.platform
    own = cfg.own_alerts
    target = own.post_target.strip()
    space = ctx.config.space(target) if target in SPACE_TARGETS else None
    return {**cycle.status(ctx), "review": review.status(ctx), "kof": kof.status(ctx), "rules_pending": rules.pending(ctx),
            "post": {"on": cfg.flag(POST_SWITCH), "target": target, "space": space.display_name if space else ""},
            "engine": own.review_engine, "severities": list(own.severities), "paths": list(own.escalation_paths),
            "bigquery_admin": cfg.flags.bigquery_admin}


@router.get("")
def own_page(days: int = 7, status: Literal["", "raised", "passed"] = "", ctx: AgentContext = Depends(get_ctx),
             user: User = Depends(require_viewer)) -> dict[str, Any]:
    keep = ctx.config.platform.own_alerts.console_keep_days
    return {"state": _state(ctx), "decisions": review.list_decisions(ctx, max(1, min(days, keep)), status),
            "can_act": user.has("analyst"), "can_run": user.has("lead"), "can_edit_rules": user.has("lead"), "can_set_up": user.has("admin")}


# -- by hand -----------------------------------------------------------------------------------------------------------
@router.post("/run")
def own_run(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    """Read the sources and review what is queued now, without waiting for the next run."""
    if not ctx.flag(SWITCH):
        raise HTTPException(403, {"error": switch_off(NAME, SWITCH), "code": "rejected"})
    run = cycle.run(ctx, force=True)
    reviewed = review.run(ctx)
    ok = bool(run.get("ok", True)) and bool(reviewed.get("ok", True))
    ctx.audit(actor=user.email, action="own.run", surface="console", target_type="own_alerts", status="ok" if ok else "error",
              summary=f"Started a run by hand. {cycle.said(run)}. Reviewed {reviewed.get('reviewed', 0)}, raised {reviewed.get('raised', 0)}"[:300])
    return {"ok": ok, "run": run, "review": reviewed}


@router.post("/setup")
def own_setup(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_admin)) -> dict[str, Any]:
    """Create the tables, the function, the models and the procedure in BigQuery, or bring them up to date."""
    try:
        steps = schema.provision(ctx)
    except (bq_admin.NotAllowed, ValueError, RuntimeError) as exc:
        ctx.audit(actor=user.email, action="own.setup", surface="console", target_type="own_alerts", status="error", summary=str(exc)[:300])
        raise HTTPException(409, {"error": str(exc), "code": "rejected"}) from exc
    rules.mark_pending(ctx)  # the new rules table is empty: the rules are copied before the next run
    ctx.audit(actor=user.email, action="own.setup", surface="console", target_type="own_alerts",
              summary=f"Created or updated the {len(steps)} BigQuery objects {NAME.lower()} uses")
    return {"ok": True, "steps": len(steps)}


# -- the rules ---------------------------------------------------------------------------------------------------------
class RuleBody(BaseModel):
    rule_name: str = Field("", max_length=200)
    process_doc_section: str = Field("", max_length=300)
    execution_mode: str = Field("", max_length=40)
    target_sources: list[str] = Field(default_factory=list, max_length=40)
    platforms: list[str] = Field(default_factory=list, max_length=40)
    require_kof: bool = False
    min_followers: int = Field(0, ge=0)
    min_engagements: int = Field(0, ge=0)
    required_keywords_any: list[str] = Field(default_factory=list, max_length=200)
    required_keywords_all: list[str] = Field(default_factory=list, max_length=200)
    excluded_keywords: list[str] = Field(default_factory=list, max_length=200)
    forced_severity: str = Field("", max_length=40)
    forced_escalation_path: str = Field("", max_length=80)
    active: bool = True


def _source_choices(ctx: AgentContext) -> list[dict[str, str]]:
    """What a rule can be limited to: each table, Brandwatch's API once, and the Other alerts space."""
    names = {sources.BRANDWATCH: "Brandwatch's API", sources.OTHER_ALERTS: "Other alerts space"}
    seen: dict[str, str] = {}
    for source in sources.listing(ctx):
        seen.setdefault(source.system, names.get(source.system, source.label))
    return [{"key": key, "label": label} for key, label in seen.items()]


@router.get("/rules")
def own_rules(ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_viewer)) -> dict[str, Any]:
    own = ctx.config.platform.own_alerts
    return {"rules": [r.model_dump(mode="json") for r in rules.list_rules(ctx)], "sources": _source_choices(ctx),
            "severities": list(own.severities), "paths": list(own.escalation_paths), "pending": rules.pending(ctx), "can_edit": user.has("lead")}


def _save_rule(ctx: AgentContext, user: User, data: dict[str, Any]) -> dict[str, Any]:
    try:
        rule = rules.save(ctx, user.email, data)
    except ValueError as exc:
        raise HTTPException(422, {"error": str(exc), "code": "validation_error"}) from exc
    kind = "mandatory" if rule.execution_mode == "HARD_MANDATE" else "candidate"
    ctx.audit(actor=user.email, action="own.rule_saved", surface="console", target_type="own_rule", target_id=rule.rule_id,
              summary=f"Saved the {kind} rule {rule.rule_name}" + ("" if rule.active else " (switched off)"))
    return {"ok": True, "rule": rule.model_dump(mode="json")}


@router.post("/rules")
def own_rule_add(body: RuleBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    return _save_rule(ctx, user, body.model_dump())


@router.put("/rules/{rule_id}")
def own_rule_change(rule_id: str, body: RuleBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    if rules.get(ctx, rule_id) is None:
        raise HTTPException(404, {"error": "That rule is no longer there.", "code": "not_found"})
    return _save_rule(ctx, user, {**body.model_dump(), "rule_id": rule_id})


@router.delete("/rules/{rule_id}")
def own_rule_remove(rule_id: str, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_lead)) -> dict[str, Any]:
    rule = rules.get(ctx, rule_id)
    if rule is None or not rules.delete(ctx, user.email, rule_id):
        raise HTTPException(404, {"error": "That rule is no longer there.", "code": "not_found"})
    ctx.audit(actor=user.email, action="own.rule_removed", surface="console", target_type="own_rule", target_id=rule_id,
              summary=f"Removed the rule {rule.rule_name}")
    return {"ok": True}


# -- an analyst's verdict ----------------------------------------------------------------------------------------------
class VerdictBody(BaseModel):
    verdict: Literal["TRUE_POSITIVE", "FALSE_POSITIVE"]


@router.post("/decisions/{decision_id}/verdict")
def own_verdict(decision_id: str, body: VerdictBody, ctx: AgentContext = Depends(get_ctx), user: User = Depends(require_analyst)) -> dict[str, Any]:
    try:
        doc = feedback.record(ctx, decision_id, body.verdict, user.email)
    except LookupError as exc:
        raise HTTPException(404, {"error": str(exc), "code": "not_found"}) from exc
    except RuntimeError as exc:
        raise HTTPException(502, {"error": f"BigQuery did not keep the verdict: {str(exc)[:300]}", "code": "upstream"}) from exc
    ctx.audit(actor=user.email, action="own.verdict", surface="console", target_type="own_decision", target_id=decision_id,
              summary=f"{VERDICT_WORDS[body.verdict]}: the {doc.get('severity')} {doc.get('path')} alert of {str(doc.get('at') or '')[:16]}")
    return {"ok": True, "decision": doc}
