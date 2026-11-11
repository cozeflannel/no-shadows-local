"""triage_message (Path A) and process_alert (shared by Path B and Watchdog intake).

Burson message -> parse -> QA -> case -> outputs:
  PASS/CORRECTED -> clean post (+ YouTube / Doodle pings, leadership DM, URGENT auto-draft)
  FAIL           -> "Needs Burson" post @ the Burson on-call (unfixable data only)
  NEEDS_REVIEW   -> DM to the IM on shift
  SUPPRESSED     -> logged (Console + digest)
"""

import hashlib
import logging
from datetime import datetime
from typing import Any

from . import cases as case_mod
from . import render
from .context import AgentContext
from .events import EventType
from .idempotency import claim_or_wait, release
from .llm import LLMError
from .models import (
    Attempt, Case, CaseStatus, ChatMessage, ChatOutputs, OnCallNotice, ParsedAlert, RequestContext, TriageResult, Verdict,
)
from .operations import operation
from .qa import parser
from .qa.pipeline import run_qa
from .qa.record_key import record_key as make_record_key
from .render import fmt_value

log = logging.getLogger(__name__)

VERDICT_EVENTS = {
    Verdict.PASS: EventType.TRIAGE_PASSED, Verdict.CORRECTED: EventType.TRIAGE_CORRECTED,
    Verdict.FAIL: EventType.TRIAGE_FAILED, Verdict.NEEDS_REVIEW: EventType.TRIAGE_NEEDS_REVIEW,
    Verdict.SUPPRESSED: EventType.TRIAGE_SUPPRESSED,
}


def idempotency_key(msg: ChatMessage) -> str:
    if msg.message_id:
        return f"msg:{msg.message_id}"
    basis = f"{msg.space_id or msg.space_name}|{msg.create_time}|{msg.text}"
    return "msg:" + hashlib.sha256(basis.encode()).hexdigest()[:32]


def is_own_message(ctx: AgentContext, msg: ChatMessage) -> bool:
    agent = ctx.config.agent
    agent_email = (agent.email or "").strip().lower()
    return (bool(agent_email) and (msg.sender.email or "").strip().lower() == agent_email) or (
        msg.text or ""
    ).lstrip().startswith(agent.message_prefix)


@operation("triage_message")
def triage_message(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    msg = ChatMessage.model_validate(payload.get("message", payload))
    cfg = ctx.config
    if is_own_message(ctx, msg):
        ctx.emit(EventType.MESSAGE_IGNORED, space="burson", message_ref=msg.message_id, payload={"reason": "own_message"})
        return ChatOutputs(summary="ignored: own message")
    space = cfg.space_key_for(msg.space_id, msg.space_name)
    if space not in (None, "burson", "shadow"):
        ctx.emit(EventType.MESSAGE_IGNORED, message_ref=msg.message_id, payload={"reason": "wrong_space", "space": space})
        return ChatOutputs(summary=f"ignored: message from the {space} space")
    key = idempotency_key(msg)
    cached = ctx.store.get_idempotent(key) or claim_or_wait(ctx, key)
    if cached:
        return ChatOutputs.model_validate(cached.get("outputs", {})), {**cached.get("data", {}), "duplicate": True}
    try:

        parsed = parser.parse(cfg, msg.text)
        is_alert, why = parser.detect(cfg, msg, parsed)
        if not is_alert:
            from .converse.handler import try_passive_shift_signin
            signin = try_passive_shift_signin(ctx, msg, rosters=("burson",))  # this flow is the Burson space
            ctx.emit(EventType.MESSAGE_IGNORED, space="burson", message_ref=msg.message_id,
                     payload={"reason": "not_alert", "detail": why, **({"signin": signin} if signin else {})})
            data = {"ignored": why, **({"signin": signin} if signin else {})}
            ctx.store.put_idempotent(key, {"outputs": ChatOutputs(summary="not an alert").model_dump(), "data": data})
            return ChatOutputs(summary="not an alert"), data
        if parsed.missing_labels:
            try:
                parsed = parser.parse_fallback(ctx, parsed)
            except LLMError as exc:
                log.warning("parse fallback failed: %s", exc)

        outputs, data = process_alert(ctx, parsed, source="burson_chat", message=msg,
                                      received_at=msg.create_time or ctx.now())
        ctx.store.put_idempotent(key, {"outputs": outputs.model_dump(), "data": data})
        return outputs, data
    finally:
        release(ctx, key)


# ---------------------------------------------------------------------------
# Shared intake processing
# ---------------------------------------------------------------------------


def process_alert(ctx: AgentContext, parsed: ParsedAlert, *, source: str, received_at: datetime,
                  message: ChatMessage | None = None, source_ref: str | None = None, post: bool = True) -> tuple[ChatOutputs, dict]:
    """QA one alert, update its case and build the chat outputs. post=False: record only (parity mode)."""
    cfg = ctx.config
    rkey = make_record_key(parsed.fields, cfg.alert_template.record_key_fields)
    case, attempt_no, prev_status = case_mod.find_or_start(ctx, rkey, source, source_ref, fields=parsed.fields)
    previous = case.latest.result if case.latest else None
    result = run_qa(ctx, parsed, source=source, received_at=received_at, record_key=rkey)
    msg = message or ChatMessage(text=parsed.raw_text[:4000], create_time=received_at)
    case.attempts.append(Attempt(attempt=attempt_no, message=msg, received_at=received_at, result=result))
    case_mod.apply_result(case, result)

    post_date = result.normalized.get("post_date")
    ctx.emit(EventType.ALERT_RECEIVED, case_id=case.case_id, attempt=attempt_no, message_ref=msg.message_id,
             space="burson" if source == "burson_chat" else "system",
             payload={"source": source, "record_key": rkey, "sender": msg.sender.name,
                      "detect_latency_s": (received_at - post_date).total_seconds() if isinstance(post_date, datetime) else None})
    for c in result.corrections:
        ctx.emit(EventType.CORRECTION_APPLIED if c.applied else EventType.CORRECTION_PROPOSED, case_id=case.case_id,
                 attempt=attempt_no, payload={"field": c.field, "old": fmt_value(c.old), "new": fmt_value(c.new),
                                              "confidence": c.confidence, "source": c.source.value, "reason": c.reason})

    outputs = ChatOutputs(case_id=case.case_id, verdict=result.verdict.value)
    after_bounce = prev_status == CaseStatus.FAILED
    v = result.verdict
    if v in (Verdict.PASS, Verdict.CORRECTED):
        outputs = outputs.merge(publish_verified(ctx, case, result, previous=previous, prev_status=prev_status, post=post))
    elif v == Verdict.FAIL:
        outputs = outputs.merge(bounce(ctx, case, result, post=post))
    elif v == Verdict.NEEDS_REVIEW:
        outputs = outputs.merge(hold_for_review(ctx, case, result, post=post))
    else:  # SUPPRESSED
        if prev_status not in (CaseStatus.VERIFIED, CaseStatus.CLOSED):
            case.status = CaseStatus.SUPPRESSED
        outputs.summary = f"{case.case_id} suppressed: {result.assessment.suppression_reason if result.assessment else ''}"

    a = result.assessment
    payload: dict[str, Any] = {
        "first_pass": attempt_no == 1, "confidence": result.confidence, "source": source,
        "track": a.track if a else None, "priority": a.priority if a else None, "after_bounce": after_bounce,
    }
    if after_bounce and v in (Verdict.PASS, Verdict.CORRECTED):
        bounced_at = next((n.at for n in reversed(case.oncall_notices) if n.kind == "bounce"), None)
        if bounced_at:
            payload["time_to_correction_s"] = (received_at - bounced_at).total_seconds()
    if v == Verdict.CORRECTED:
        payload["fields"] = [c.field for c in result.applied_corrections]
    if v == Verdict.SUPPRESSED and a:
        payload.update({"reason": a.suppression_reason, "reason_codes": a.reason_codes, "update": prev_status is not None})
    if v == Verdict.NEEDS_REVIEW:
        payload.update({"reasons": result.review_reasons, "im_email": case.current_oncall_email})
    if v == Verdict.FAIL:
        payload.update({"oncall_email": case.current_oncall_email, "issues": [i.rule for i in result.blocking]})
    ctx.emit(VERDICT_EVENTS[v], case_id=case.case_id, attempt=attempt_no, verdict=v.value, latency_ms=result.latency_ms,
             model=result.model, error_codes=[f"{i.field}:{i.rule}" if i.field else i.rule for i in result.blocking],
             payload=payload)

    counterpart = case_mod.link_counterpart(ctx, case)
    if counterpart is not None:
        burson_side, inhouse_side = (counterpart, case) if case.source == "inhouse" else (case, counterpart)
        ctx.emit(EventType.PARITY_MATCHED, case_id=case.case_id,
                 payload={"counterpart_case_id": counterpart.case_id,
                          "diffs": case_mod.parity_diffs(burson_side, inhouse_side)})  # {field: [burson, inhouse]}
    ctx.store.save_case(case)
    if not outputs.summary:
        outputs.summary = f"{case.case_id} {v.value}"
    return outputs, {"case_id": case.case_id, "verdict": v.value, "attempt": attempt_no, "record_key": rkey,
                     "corrections": [c.model_dump(mode="json") for c in result.corrections],
                     "suppression_reason": a.suppression_reason if a else None}


def publish_verified(ctx: AgentContext, case: Case, result: TriageResult, *, previous: TriageResult | None = None,
                     prev_status: CaseStatus | None = None, post: bool = True, header: str | None = None) -> ChatOutputs:
    """VERIFIED: clean post (or update), protocol pings, leadership DM, URGENT auto-draft."""
    cfg, now = ctx.config, ctx.now()
    a = result.assessment
    out = ChatOutputs(case_id=case.case_id, verdict=result.verdict.value)
    first_time = case.clean_posted_at is None
    case.status = CaseStatus.VERIFIED
    case.current_oncall_email = None
    if not post:
        return out
    auto: list[str] = []
    if first_time and a:
        if a.youtube_protocol != "none" and cfg.protocols.youtube.enabled:
            out.youtube_text = render.youtube_ping(ctx, case, result)
            auto.append("▶️ YouTube Social")
            ctx.emit(EventType.PROTOCOL_PINGED, case_id=case.case_id, space="youtube",
                     payload={"protocol": "youtube", "mode": a.youtube_protocol})
        if a.doodle_protocol:
            out.doodle_text = render.doodle_ping(ctx, case, result)
            auto.append("🎨 Doodle Team")
            ctx.emit(EventType.PROTOCOL_PINGED, case_id=case.case_id, space="doodle", payload={"protocol": "doodle"})
        lead = cfg.protocols.leadership
        if a.leadership_protocol and case.leadership_pinged_at is None and lead.recipients:
            out.dm_text = render.leadership_dm(ctx, case, result)
            out.dm_recipients = list(lead.recipients)
            case.leadership_pinged_at = now
            auto.append("🔔 leadership protocol")
            ctx.emit(EventType.PROTOCOL_PINGED, case_id=case.case_id, space="dm",
                     payload={"protocol": "leadership", "recipients": lead.recipients})
    draft_note = maybe_auto_draft(ctx, case, result) if first_time else None
    if a and a.alert_action == "YOUTUBE_CHAT_ONLY":
        auto.append("no email (YouTube chat only)")
    if first_time:
        out.clean_text = render.clean_post(ctx, case, result, draft_note=draft_note, auto_notes=auto, header=header)
        case.clean_posted_at = now
        case.sla_due_at = a.sla_due_at if a else None
    else:
        changes = describe_changes(previous, result)
        if changes or header:
            out.clean_text = render.update_post(ctx, case, result, changes) if not header else \
                render.clean_post(ctx, case, result, header=header, auto_notes=auto)
        ctx.emit(EventType.CASE_UPDATED, case_id=case.case_id, payload={"reason": "new_attempt", "changes": changes,
                                                                       "previous_status": prev_status.value if prev_status else None})
    return out


def maybe_auto_draft(ctx: AgentContext, case: Case, result: TriageResult) -> str | None:
    """URGENT auto-draft in the on-shift IM's Gmail (decision 3). Returns the clean-post note."""
    cfg = ctx.config
    a = result.assessment
    if not a or a.track not in cfg.escalation.auto_draft_tracks or a.alert_action != "EMAIL_ALERT":
        return None
    im = ctx.im_on_shift().person
    if im is None:
        return "📨 No IM on shift to draft for"
    if ctx.gmail is None or not ctx.gmail.is_connected(im.email):
        return f"📨 {im.email}: connect Gmail in the Agent Console to get URGENT drafts automatically"
    try:
        from .escalation import service  # workstream A2
    except ImportError:
        return None
    try:
        esc = service.start_escalation(ctx, case, im.email, trigger="auto_urgent", requested_by="agent")
        email = service.draft_alert_email(ctx, esc, case)
    except Exception as exc:  # noqa: BLE001 - the alert must still post
        log.exception("auto-draft failed for %s", case.case_id)
        return f"📨 Auto-draft failed ({exc}); react 📦 to retry"
    if esc.escalation_id not in case.escalation_ids:
        case.escalation_ids.append(esc.escalation_id)
    if hasattr(service, "draft_note"):
        return service.draft_note(ctx, esc, email)
    if getattr(email, "status", None) is not None and email.status.value == "FAILED":
        return f"📨 Auto-draft failed ({email.error}); react 📦 to retry"
    return f"📨 Draft ready in {im.email}'s Gmail (Brand Social) · {esc.escalation_id}"


def bounce(ctx: AgentContext, case: Case, result: TriageResult, *, post: bool = True, reason: str | None = None) -> ChatOutputs:
    """FAILED: only unfixable source data goes back to Burson."""
    now = ctx.now()
    out = ChatOutputs(case_id=case.case_id, verdict=result.verdict.value)
    case.status = CaseStatus.FAILED
    if case.source != "burson_chat":
        im = ctx.im_on_shift().person
        if post and case.source == "watchdog" and im:
            out.dm_text = render.finalize(f"{render.prefix(ctx)} Couldn't verify the Watchdog alert {case.case_id}: "
                                          + "; ".join(i.fix or i.rule for i in result.blocking[:3]))
            out.dm_recipients = [im.email]
        return out
    res = ctx.burson_on_call()
    person = res.person
    case.current_oncall_email = person.email if person else None
    if not post:
        return out
    text = render.needs_burson(ctx, case, result, person.email if person else None, person.name if person else None)
    if reason:
        text = render.finalize(f"{text}\nIM note: {reason}")
    out.burson_text = text
    case.oncall_notices.append(OnCallNotice(kind="bounce", to_email=case.current_oncall_email, at=now))
    ctx.emit(EventType.ONCALL_NOTIFIED, case_id=case.case_id, space="burson",
             payload={"kind": "bounce", "to_email": case.current_oncall_email, "roster": "burson", "source": res.source})
    return out


def hold_for_review(ctx: AgentContext, case: Case, result: TriageResult, *, post: bool = True) -> ChatOutputs:
    out = ChatOutputs(case_id=case.case_id, verdict=result.verdict.value)
    case.status = CaseStatus.NEEDS_REVIEW
    im = ctx.im_on_shift().person
    case.current_oncall_email = im.email if im else None
    if post and im:
        out.dm_text = render.review_dm(ctx, case, result)
        out.dm_recipients = [im.email]
        case.oncall_notices.append(OnCallNotice(kind="analyst", to_email=im.email, at=ctx.now()))
    return out


def describe_changes(previous: TriageResult | None, current: TriageResult) -> list[str]:
    """What changed between attempts, for update posts ("engagement 2,450 → 5,100")."""
    if previous is None or previous.assessment is None or current.assessment is None:
        return []
    pa, ca = previous.assessment, current.assessment
    out = []
    if (pa.engagement_total or 0) != (ca.engagement_total or 0):
        out.append(f"engagement {render.fmt_num(pa.engagement_total)} → {render.fmt_num(ca.engagement_total)}")
    if pa.track != ca.track and ca.track:
        out.append(f"now {ca.track.replace('_', ' ')}")
    if pa.is_kof != ca.is_kof:
        out.append(f"KOF: {'Yes' if ca.is_kof else 'No'}")
    if pa.exposure_tag != ca.exposure_tag:
        out.append(f"tag → {ca.exposure_tag}")
    if set(pa.sensitive_topics) != set(ca.sensitive_topics):
        out.append("risk: " + (", ".join(ca.sensitive_topics) or "none"))
    return out
