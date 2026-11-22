"""Operations added with the Console platform. Registered through triage_agent.handlers like every other op.

    record_assessment   an IM's own judgment of an alert (Review Feed, chat agent)
    run_temp_check      a temp check, from the Console, the chat agent or Chat ("temp check …")
    run_forecast        the volume forecast in BigQuery and the staffing recommendations it leads to (job)
    refresh_knowledge   re-read linked knowledge docs that are due (job)
    run_watches         evaluate the Console's watches (job)
"""

from __future__ import annotations

from typing import Any

from .config import switch_off
from .context import AgentContext
from .models import ChatOutputs, RequestContext
from .operations import UserFacingError, operation


def _actor(payload: dict[str, Any], rc: RequestContext) -> str:
    return str(payload.get("actor") or rc.invoked_by or "agent")


CONSOLE_FLOWS = ("console", "chat_agent")  # the Console decides a person's role before it calls an operation


def _require_im(ctx: AgentContext, actor: str, rc: RequestContext) -> None:
    """From Chat, only an analyst or someone on the IM roster; a Console call was already checked against the person's role."""
    from .context import ROSTER_IM
    from .oncall.roster import person_by_email

    if rc.flow in CONSOLE_FLOWS or ctx.config.analyst(actor) or person_by_email(ctx.roster(ROSTER_IM), actor):
        return
    raise UserFacingError("Only Incident Managers and analysts can do that.")


@operation("record_assessment")
def record_assessment(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    from . import golden

    actor = _actor(payload, rc)
    _require_im(ctx, actor, rc)
    case_id = str(payload.get("case_id") or "").upper()
    if ctx.store.get_case(case_id) is None:
        raise UserFacingError(f"I don't know {case_id or 'that case'}.")
    agree = bool(payload.get("agree"))
    fields = payload.get("fields") or {}
    if not agree and not (fields or payload.get("verdict") or str(payload.get("note") or "").strip()):
        raise UserFacingError("Say what is wrong: the right verdict, the right value of a field, or a note.")
    record = golden.add_assessment(ctx, case_id, actor=actor, agree=agree, verdict=payload.get("verdict") or None,
                                   fields=fields, note=str(payload.get("note") or ""))
    summary = f"{case_id}: assessment recorded ({'agrees' if agree else 'disagrees'}); golden label {record.label}"
    return ChatOutputs(case_id=case_id, summary=summary), {"label": record.label, "assessments": len(record.assessments)}


@operation("run_temp_check")
def run_temp_check(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    from . import tempcheck

    actor = _actor(payload, rc)
    if not ctx.flag("temp_checks"):
        raise UserFacingError(switch_off("Temp checks", "temp_checks"))
    check = tempcheck.run(ctx, tempcheck.TempCheckRequest.model_validate({**payload, "requested_by": actor,
                                                                          "via": payload.get("via") or (rc.flow or "console")}))
    text = tempcheck.chat_summary(ctx, check)
    target = ctx.config.platform.temp_check.post_to_space
    out = ChatOutputs(case_id=check.case_id or "", summary=f"Temp check {check.check_id}: {check.status}", reply_text=text)
    if target and check.status == "complete" and not payload.get("silent"):
        out.set_target(target, text)
    return out, {"check_id": check.check_id, "status": check.status, "concern": check.concern_level}


@operation("run_forecast")
def run_forecast(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    from . import workforce

    if not ctx.flag("workforce_forecasting") and not payload.get("force"):
        return ChatOutputs(summary=""), {"skipped": "workforce_forecasting is OFF"}
    result = workforce.run_forecast(ctx, actor=_actor(payload, rc), force=bool(payload.get("force")))
    return ChatOutputs(summary=result.get("summary", "")), result


@operation("refresh_knowledge")
def refresh_knowledge(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    from . import knowledge

    counts = knowledge.refresh_due(ctx, force=bool(payload.get("force")))
    summary = f"knowledge: {counts['checked']} checked, {counts['changed']} changed, {counts['failed']} failed" if counts["checked"] else ""
    return ChatOutputs(summary=summary), counts


@operation("run_watches")
def run_watches(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    from . import watches

    if not ctx.flag("watches"):
        return ChatOutputs(summary=""), {"skipped": "watches is OFF"}
    result = watches.run_due(ctx, actor=_actor(payload, rc))
    return ChatOutputs(summary=result.get("summary", "")), result
