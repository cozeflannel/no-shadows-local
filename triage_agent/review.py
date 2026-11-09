"""IM decisions on held alerts, correction reverts, manual closing.

review_decision    forward (optionally with field overrides) | bounce | suppress
revert_correction  undo an auto-correction (re-evaluates the requirements)
close_case         close manually from the Console
Callers: the Agent Console (deliver=outbox) and converse ("forward TRG-1043").
"""

from typing import Any

from . import render
from .context import AgentContext
from .events import EventType
from .models import Attempt, Case, CaseStatus, ChatOutputs, RequestContext, ReviewDecision
from .operations import UserFacingError, operation
from .qa.pipeline import reassess
from .triage import bounce, publish_verified


def _case(ctx: AgentContext, case_id: str | None) -> Case:
    if not case_id:
        raise UserFacingError("Which alert? Include its id, e.g. TRG-1042.")
    case = ctx.store.get_case(case_id.strip().upper())
    if case is None or case.latest is None:
        raise UserFacingError(f"I can't find {case_id}.")
    return case


def can_decide(ctx: AgentContext, actor: str | None) -> bool:
    if not actor:
        return False
    if ctx.config.analyst(actor):
        return True
    roster = ctx.roster("slrr_im")
    return any(p.email.lower() == actor.lower() for p in roster.people)


def _new_attempt(ctx: AgentContext, case: Case, result) -> Attempt:
    prev = case.latest
    attempt = Attempt(attempt=len(case.attempts) + 1, message=prev.message, received_at=ctx.now(), result=result)
    case.attempts.append(attempt)
    return attempt


@operation("review_decision")
def review_decision(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    case = _case(ctx, payload.get("case_id"))
    actor = payload.get("actor") or rc.invoked_by
    decision = (payload.get("decision") or "").lower()
    reason = payload.get("reason")
    via = payload.get("via") or ("console" if rc.flow == "console" else "chat")
    if decision not in ("forward", "bounce", "suppress"):
        raise UserFacingError("Decision must be forward, bounce or suppress.")
    if not can_decide(ctx, actor):
        raise UserFacingError(f"Only Incident Managers and SLRR analysts can decide on {case.case_id}.")
    if case.status != CaseStatus.NEEDS_REVIEW:
        raise UserFacingError(f"{case.case_id} isn't waiting for review (it's {case.status.value}).")
    now = ctx.now()
    case.review = ReviewDecision(decided_by=actor, decision=decision, reason=reason, at=now)
    previous = case.latest.result
    out = ChatOutputs(case_id=case.case_id)

    if decision == "forward":
        result = reassess(ctx, previous, received_at=case.latest.received_at, overrides=payload.get("fields") or {},
                          accept_proposed=True, actor=actor, forced_alertable=True)
        _new_attempt(ctx, case, result)
        out = out.merge(publish_verified(ctx, case, result, previous=previous, prev_status=CaseStatus.NEEDS_REVIEW))
        out.reply_text = f"{render.prefix(ctx)} Forwarded {case.case_id} to the clean space."
        ctx.emit(EventType.REVIEW_FORWARDED, case_id=case.case_id, actor=actor,
                 payload={"reason": reason, "via": via, "overrides": list((payload.get("fields") or {}).keys())})
    elif decision == "bounce":
        out = out.merge(bounce(ctx, case, previous, reason=reason or "Sent back by the IM"))
        out.reply_text = f"{render.prefix(ctx)} Sent {case.case_id} back to the Burson on-call."
        ctx.emit(EventType.REVIEW_BOUNCED, case_id=case.case_id, actor=actor, payload={"reason": reason, "via": via})
    else:
        case.status = CaseStatus.SUPPRESSED
        out.reply_text = f"{render.prefix(ctx)} Suppressed {case.case_id}" + (f": {reason}" if reason else ".")
        ctx.emit(EventType.REVIEW_SUPPRESSED, case_id=case.case_id, actor=actor, payload={"reason": reason, "via": via})
    out.verdict = case.status.value
    out.summary = f"{case.case_id} {decision} by {actor}"
    ctx.store.save_case(case)
    return out, {"case_id": case.case_id, "status": case.status.value}


@operation("revert_correction")
def revert_correction(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    case = _case(ctx, payload.get("case_id"))
    actor = payload.get("actor") or rc.invoked_by
    field = (payload.get("field") or "").strip()
    if not can_decide(ctx, actor):
        raise UserFacingError("Only Incident Managers and SLRR analysts can revert corrections.")
    previous = case.latest.result
    target = next((c for c in previous.corrections if c.field == field and c.applied and not c.reverted_by), None)
    if target is None:
        fields = ", ".join(sorted({c.field for c in previous.applied_corrections})) or "none"
        raise UserFacingError(f"No applied correction on '{field}' for {case.case_id} (corrected fields: {fields}).")
    result = reassess(ctx, previous, received_at=case.latest.received_at, revert_field=field, actor=actor,
                      forced_alertable=case.status == CaseStatus.VERIFIED)
    _new_attempt(ctx, case, result)
    ctx.emit(EventType.CORRECTION_REVERTED, case_id=case.case_id, actor=actor,
             payload={"field": field, "old": render.fmt_value(target.new), "new": render.fmt_value(target.old),
                      "source": target.source.value})
    out = ChatOutputs(case_id=case.case_id, verdict=case.status.value)
    note = f"{render.label(field)} reverted to \"{render.fmt_value(target.old)}\" by {actor}"
    if case.status == CaseStatus.VERIFIED:
        out.clean_text = render.clean_post(ctx, case, result, header=f"🔁 *Updated* ({note})")
    out.reply_text = f"{render.prefix(ctx)} {case.case_id}: {note}."
    out.summary = f"{case.case_id} {note}"
    ctx.store.save_case(case)
    return out, {"case_id": case.case_id, "field": field}


@operation("close_case")
def close_case(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    case = _case(ctx, payload.get("case_id"))
    actor = payload.get("actor") or rc.invoked_by or "console"
    reason = payload.get("reason") or "closed manually"
    case.status = CaseStatus.CLOSED
    case.closed_reason = reason
    ctx.emit(EventType.CASE_CLOSED, case_id=case.case_id, actor=actor, payload={"reason": "manual", "note": reason})
    ctx.store.save_case(case)
    return ChatOutputs(case_id=case.case_id, verdict=case.status.value, summary=f"{case.case_id} closed: {reason}",
                       reply_text=f"{render.prefix(ctx)} Closed {case.case_id}: {reason}")
