"""IM actions from the emoji legend on clean-space posts (docs/CONTRACTS.md §6).

Ops: record_reaction (Flow 2, "When an emoji reaction is added"), start_escalation
(legacy alias = record_reaction with 📦), record_post (remember the clean post's id/link).

Each reaction: find the case (first TRG- id in the message, else Case.clean_message_ref),
dedupe on rx:<message>:<emoji>:<user>, run the action, record an ActionRecord, emit
action.recorded (and alert.acknowledged on the first action). Replies go to reply_text
(the clean space allows "Reply to a message"); 🔥 posts to crisis_text; 🧑‍💻 is a DM.
"""

import hashlib
from typing import Any, Callable

from . import render
from .config import ActionDef
from .context import AgentContext
from .escalation import service
from .escalation import tns as tns_mod
from .events import EventType
from .idempotency import claim_or_wait, release
from .ids import case_ids_in
from .models import (
    ActionRecord, Case, CaseStatus, ChatMessage, ChatOutputs, EmailStatus, ReactionEvent, RequestContext, TnsStatus,
)
from .operations import UserFacingError, operation

SPACE_OUTPUTS = ("burson", "clean", "youtube", "doodle", "team", "crisis")

# (outputs, escalation_id, note) per action kind
KindResult = tuple[ChatOutputs, str | None, str | None]


# ---------------------------------------------------------------------------
# Payload + lookups
# ---------------------------------------------------------------------------


def reaction_from_payload(payload: dict[str, Any]) -> ReactionEvent:
    """ReactionEvent from the nested shape (§3.1) or the flat custom-step inputs (§13)."""
    data = dict(payload or {})
    msg = data.get("message")
    if not isinstance(msg, dict):
        msg = {"text": data.get("message_text") or "", "message_id": data.get("message_id"),
               "link": data.get("message_link"), "space_name": data.get("space"), "thread_id": data.get("thread_id")}
    msg = {**msg, "text": msg.get("text") or ""}
    user = data.get("user")
    if not isinstance(user, dict):
        user = {"email": data.get("reactor_email"), "name": data.get("reactor_name")}
    return ReactionEvent.model_validate({"emoji": data.get("emoji") or "", "user": user, "message": msg})


def _ref_keys(ref: str | None) -> set[str]:
    if not ref:
        return set()
    ref = ref.strip()
    return {ref, ref.rstrip("/").rsplit("/", 1)[-1]}


def find_case(ctx: AgentContext, message: ChatMessage) -> Case | None:
    """First TRG- id in the text that exists, else the case whose clean post is this message."""
    for case_id in case_ids_in(message.text, ctx.config):
        case = ctx.store.get_case(case_id)
        if case is not None:
            return case
    wanted = _ref_keys(message.message_id) | _ref_keys(message.link)
    if not wanted:
        return None
    finder = getattr(ctx.store, "find_case_by_message_ref", None)
    for ref in (message.message_id, message.link):
        case = finder(ref) if (finder and ref) else None
        if case is not None:
            return case
    # Fallback for refs stored in another format (e.g. link vs resource name): scan recent cases.
    for case in ctx.store.list_cases(limit=500):
        if case.clean_message_ref and _ref_keys(case.clean_message_ref) & wanted:
            return case
    return None


def reaction_key(ev: ReactionEvent, emoji: str, actor: str) -> str:
    ref = ev.message.message_id or ev.message.link or hashlib.sha256((ev.message.text or "").encode()).hexdigest()[:24]
    return f"rx:{ref}:{emoji}:{actor}"


def find_newer_case(ctx: AgentContext, case: Case) -> Case | None:
    """Newest later case with the same record key or issue fingerprint (⬇️ superseded)."""
    newer = [
        c for c in ctx.store.list_cases(limit=500)
        if c.case_id != case.case_id and c.created_at > case.created_at and (
            (case.record_key and c.record_key == case.record_key)
            or (case.issue_fingerprint and c.issue_fingerprint == case.issue_fingerprint))
    ]
    return max(newer, key=lambda c: c.created_at) if newer else None


# ---------------------------------------------------------------------------
# Reply rendering
# ---------------------------------------------------------------------------


def _recipient_counts(ctx: AgentContext, email) -> str:
    last = email.versions[-1] if email.versions else None
    if last is None:
        return ""
    if ctx.config.escalation.recipients_in == "bcc":
        return f"*To:* {ctx.config.escalation.from_email} · distro in *Bcc*"
    return f"*To:* {len(last.to)} · *Cc:* {len(last.cc)}"


def draft_reply(ctx: AgentContext, esc_id: str | None, case: Case, outcome: service.DraftOutcome,
                *, head: str | None = None, analyst: str | None = None) -> str:
    """Chat reply describing where the draft is, its groups, missing placeholders and notes."""
    p = render.prefix(ctx)
    email = outcome.email
    ids = " · ".join(i for i in (esc_id, case.case_id) if i)
    where = f"your Gmail ({analyst})" if analyst else "your Gmail"
    lines: list[str] = []
    if outcome.action == "failed":
        reason = (email.error if email.status == EmailStatus.FAILED and email.error else "; ".join(outcome.notes)) or "unknown error"
        if "isn't configured" in reason.lower():
            lines.append(f"{p} 📨 Gmail drafting isn't set up for the agent yet, so I couldn't draft this one · {ids}")
        elif "connect" in reason.lower():
            lines.append(f"{p} 📨 Connect Gmail in the Agent Console to get drafts in {where} · {ids}")
        else:
            verb = "create" if email.status == EmailStatus.FAILED else "update"
            lines.append(f"{p} 📨 I couldn't {verb} the draft: {render.truncate(reason, 200)} · {ids}. React again to retry.")
    elif outcome.action == "already_sent" and email.purpose == "alert":
        lines.append(f"{p} 📨 The alert email for {case.case_id} was already sent {render.fmt_time(ctx, email.sent_at)} · {ids}")
    else:
        default = {
            "created": f"Draft ready in {where}: Drafts, From Brand Social",
            "existing": f"Your draft is already in {where}: Drafts, From Brand Social",
            "updated": f"Draft updated in {where}",
            "unchanged": f"No change needed to the draft in {where}",
        }.get(outcome.action, f"Draft in {where}")
        lines.append(f"{p} 📨 {head or default} · {ids}")
        if email.versions:
            lines.append(f"*Subject:* {render.truncate(email.versions[-1].subject, 200)}")
        counts = _recipient_counts(ctx, email)
        if counts:
            lines.append(counts)
    plan = outcome.plan
    if plan is not None and plan.groups and outcome.action != "failed":
        lines.append("*Groups:* " + ", ".join(plan.groups))
    if plan is not None and plan.missing:
        lines.append("ℹ️ No recipients configured yet for: " + ", ".join(plan.missing)
                     + " (add them in the Agent Console; email them directly meanwhile)")
    notes = [] if outcome.action == "failed" else list(dict.fromkeys([*(plan.notes if plan else []), *outcome.notes]))
    for note in notes[:6]:
        lines.append(f"📝 {render.truncate(note, 240)}")
    if service.is_open(email):
        lines.append(f"To change it, reply in this thread: `@{ctx.config.agent.display_name} revise: …`")
    return render.finalize("\n".join(lines))


# ---------------------------------------------------------------------------
# Action kinds
# ---------------------------------------------------------------------------


def _ack(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    return ChatOutputs(), None, None


def _email_pa(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    sent_esc, sent = service.sent_alert(ctx, case)
    if sent is not None:
        outcome = service.DraftOutcome(sent, "already_sent")
        esc_id = sent_esc.escalation_id if sent_esc else None
        return ChatOutputs(reply_text=draft_reply(ctx, esc_id, case, outcome)), esc_id, "already sent"
    esc = service.start_escalation(ctx, case, actor, trigger="reaction", requested_by=actor, chat_message_ref=ref)
    outcome = service.draft_alert(ctx, esc, case)
    text = draft_reply(ctx, esc.escalation_id, case, outcome, analyst=esc.analyst_email)
    return ChatOutputs(reply_text=text), esc.escalation_id, outcome.action


def _tns(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    esc = service.start_escalation(ctx, case, actor, trigger="reaction", requested_by=actor, chat_message_ref=ref)
    state = tns_mod.assess_and_prepare(ctx, esc, case, actor)
    if state.status == TnsStatus.SUBMITTED:
        text = (f"{render.prefix(ctx)} ✍️ T&S already submitted for {case.case_id}"
                f"{' (Issue ' + state.wd_issue_id + ')' if state.wd_issue_id else ''} · {esc.escalation_id}")
        return ChatOutputs(reply_text=text), esc.escalation_id, "already submitted"
    urgent_email = tns_mod.draft_urgent_email(ctx, esc, case) if state.urgent else None
    text = tns_mod.prepared_message(ctx, esc, case, state, urgent_email)
    failed = urgent_email is not None and urgent_email.status == EmailStatus.FAILED
    return ChatOutputs(reply_text=text), esc.escalation_id, state.status.value + ("; urgent draft failed" if failed else "")


def _add_group(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    key = action.group or action.code
    group = ctx.config.distribution.group(key)
    name = group.name if group else key
    esc = service.start_escalation(ctx, case, actor, trigger="reaction", requested_by=actor, chat_message_ref=ref)
    outcome = service.add_group_to_draft(ctx, esc, case, key, actor, via="reaction")
    if outcome.plan is not None and group is None and name not in outcome.plan.missing:
        outcome.plan.missing.append(name)  # legend points at a group that isn't configured
    missing = outcome.plan is not None and name in outcome.plan.missing
    p = render.prefix(ctx)
    if missing and outcome.action in ("already_sent", "unchanged", "existing"):
        text = render.finalize(
            f"{p} ℹ️ No recipients configured for {name} yet · {esc.escalation_id} · {case.case_id}\n"
            "Add them in the Agent Console (Settings → distribution) and react again; email them directly meanwhile.")
        return ChatOutputs(reply_text=text), esc.escalation_id, f"{name}: no recipients"
    head = None
    if outcome.email.purpose == "group" and outcome.action == "created":
        head = f"The alert email was already sent, so I drafted a reply to just {name} on its thread in your Gmail"
    elif outcome.action == "created":
        head = f"Draft ready in your Gmail ({esc.analyst_email}) with {name}" if not missing else None
    elif outcome.action == "updated":
        head = f"Added {name} to your draft in your Gmail ({esc.analyst_email})"
    elif outcome.action in ("unchanged", "existing") and not missing:
        head = f"{name} is already on your draft"
    text = draft_reply(ctx, esc.escalation_id, case, outcome, head=head, analyst=esc.analyst_email)
    return ChatOutputs(reply_text=text), esc.escalation_id, f"{name}: {outcome.action}"


def _post_space(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    target = action.target if action.target in SPACE_OUTPUTS else "crisis"
    p = render.prefix(ctx)
    summary = render.alert_summary_lines(ctx, case)
    text = render.finalize("\n".join([f"{p} {action.emoji} Flagged from the SLRR triage space by {actor}", *summary]))
    out = ChatOutputs(reply_text=f"{p} {action.emoji} Shared to the {render.short_label(action.label)} · {case.case_id}")
    out.set_target(target, text)
    ctx.emit(EventType.PROTOCOL_PINGED, case_id=case.case_id, actor=actor, space=target,  # type: ignore[arg-type]
             payload={"protocol": "crisis" if target == "crisis" else target, "via": "reaction"})
    return out, None, None


def _dm(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    p = render.prefix(ctx)
    if not action.recipients:
        return ChatOutputs(reply_text=f"{p} No recipients configured for {action.label} · {case.case_id}"), None, "no recipients"
    lines = [f"{p} {action.emoji} *{action.label}* by {actor}", *render.alert_summary_lines(ctx, case)]
    out = ChatOutputs(dm_text=render.finalize("\n".join(lines)), dm_recipients=list(action.recipients))
    protocol = action.code.removeprefix("escalated_") or action.code
    ctx.emit(EventType.PROTOCOL_PINGED, case_id=case.case_id, actor=actor, space="dm",
             payload={"protocol": protocol, "recipients": list(action.recipients), "via": "reaction"})
    return out, None, None


def _close(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    p = render.prefix(ctx)
    if case.status == CaseStatus.CLOSED:
        return ChatOutputs(reply_text=f"{p} {case.case_id} is already closed ({case.closed_reason or 'closed'})."), None, "already closed"
    case.status = CaseStatus.CLOSED
    case.closed_reason = "no_action"
    ctx.emit(EventType.CASE_CLOSED, case_id=case.case_id, actor=actor, payload={"reason": "no_action", "via": "reaction"})
    open_esc = [e.escalation_id for e in ctx.store.list_escalations(case_id=case.case_id, open_only=True, limit=20)]
    extra = f" Open drafts stay in Gmail ({', '.join(open_esc)})." if open_esc else ""
    return ChatOutputs(reply_text=f"{p} ❌ Closed {case.case_id} (no action).{extra}"), None, None


def _superseded(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    p = render.prefix(ctx)
    newer = find_newer_case(ctx, case)
    case.superseded_by = newer.case_id if newer else case.superseded_by
    case.status = CaseStatus.CLOSED
    case.closed_reason = "superseded"
    ctx.emit(EventType.CASE_CLOSED, case_id=case.case_id, actor=actor,
             payload={"reason": "superseded", "superseded_by": case.superseded_by, "via": "reaction"})
    if newer is not None:
        text = f"{p} ⬇️ {case.case_id} is superseded by {newer.case_id} and closed."
    else:
        text = f"{p} ⬇️ Closed {case.case_id} as superseded (I couldn't find a newer alert for the same post or issue)."
    return ChatOutputs(reply_text=text), None, newer.case_id if newer else None


def _feedback(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    p = render.prefix(ctx)
    result = case.latest.result if case.latest else None
    verdict = result.verdict.value if result else None
    case.verdict_overridden_by = actor
    ctx.emit(EventType.VERDICT_OVERRIDDEN, case_id=case.case_id, actor=actor, verdict=verdict,
             payload={"verdict": verdict, "track": case.track, "exposure_tag": case.exposure_tag, "via": "reaction"})
    corrected = [c.field for c in result.applied_corrections] if result else []
    name = ctx.config.agent.display_name
    hint = (f" To undo an auto-correction: `@{name} revert {case.case_id} {corrected[0]}` (corrected: {', '.join(corrected)})."
            if corrected else "")
    text = (f"{p} 👎 Thanks, logged for tuning · {case.case_id}. What should it have been? "
            f"Reply in this thread with the right value (e.g. exposure tag or product).{hint}")
    return ChatOutputs(reply_text=render.finalize(text)), None, None


def _none(ctx: AgentContext, case: Case, action: ActionDef, actor: str, ev: ReactionEvent, ref: str | None) -> KindResult:
    return ChatOutputs(), None, None


KIND_HANDLERS: dict[str, Callable[..., KindResult]] = {
    "ack": _ack, "email_pa": _email_pa, "tns": _tns, "add_group": _add_group, "post_space": _post_space,
    "dm": _dm, "close": _close, "superseded": _superseded, "feedback": _feedback, "none": _none,
}


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


def handle_reaction(ctx: AgentContext, ev: ReactionEvent, rc: RequestContext) -> tuple[ChatOutputs, dict[str, Any]]:
    cfg = ctx.config
    p = render.prefix(ctx)
    actor = (ev.user.email or "").strip().lower() or (rc.invoked_by or "unknown")
    ref = ev.message.message_id or ev.message.link
    action = cfg.action(ev.emoji)
    if action is None:
        ctx.emit(EventType.MESSAGE_IGNORED, actor=actor, space="clean", message_ref=ref,
                 payload={"reason": "unknown_emoji", "emoji": ev.emoji})
        return ChatOutputs(summary=f"ignored: {ev.emoji} isn't in the legend"), {"ignored": "unknown_emoji"}

    key = reaction_key(ev, action.emoji, actor)
    cached = ctx.store.get_idempotent(key) or claim_or_wait(ctx, key)
    if cached:
        return ChatOutputs.model_validate(cached.get("outputs", {})), {**cached.get("data", {}), "duplicate": True}
    try:

        if not ev.user.email and action.kind in ("email_pa", "tns", "add_group"):
            out = ChatOutputs(reply_text=f"{p} I couldn't tell who reacted, so I can't draft in your Gmail. React again, or "
                                         f"reply `@{cfg.agent.display_name} {action.code} <{cfg.case_id_prefix}-id>`.",
                              summary="reaction without a reactor email")
            return out, {"matched": False, "code": action.code, "reason": "no_reactor_email"}
        case = find_case(ctx, ev.message)
        if case is None:  # not cached: reacting again works once the clean post is recorded
            out = ChatOutputs(reply_text=f"{p} I couldn't match this message to an alert. React on the agent's alert post "
                                         f"(it carries a {cfg.case_id_prefix}- id).", summary="reaction not matched to a case")
            return out, {"matched": False, "code": action.code}

        now = ctx.now()
        first = case.acknowledged_at is None
        out, esc_id, note = KIND_HANDLERS.get(action.kind, _none)(ctx, case, action, actor, ev, ref)
        case.actions.append(ActionRecord(code=action.code, emoji=action.emoji, actor=actor, at=now,
                                         escalation_id=esc_id, note=note))
        if first:
            case.acknowledged_at = now
            ctx.emit(EventType.ALERT_ACKNOWLEDGED, case_id=case.case_id, actor=actor, space="clean", message_ref=ref,
                     payload={"ack_latency_s": round((now - (case.clean_posted_at or case.created_at)).total_seconds(), 1),
                              "code": action.code})
        ctx.emit(EventType.ACTION_RECORDED, case_id=case.case_id, escalation_id=esc_id, actor=actor, space="clean",
                 message_ref=ref, payload={"code": action.code, "emoji": action.emoji, "kind": action.kind,
                                           "escalation_id": esc_id})
        ctx.store.save_case(case)
        out.case_id = case.case_id
        out.escalation_id = esc_id or out.escalation_id
        out.summary = f"{case.case_id} {action.code} by {actor}" + (f" ({note})" if note else "")
        data = {"case_id": case.case_id, "code": action.code, "kind": action.kind, "escalation_id": esc_id, "note": note}
        if not (note or "").endswith("failed"):  # a failed draft says "react again to retry": don't pin the failure
            ctx.store.put_idempotent(key, {"outputs": out.model_dump(), "data": data})
        return out, data
    finally:
        release(ctx, key)


@operation("record_reaction")
def record_reaction(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    """Flow 2: an IM reacted with a legend emoji on a clean-space post."""
    return handle_reaction(ctx, reaction_from_payload(payload), rc)


@operation("start_escalation")
def start_escalation(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    """Legacy alias: record_reaction with the 📦 (email_pa) emoji."""
    ev = reaction_from_payload(payload)
    pa = next((a for a in ctx.config.actions if a.kind == "email_pa"), None)
    ev.emoji = pa.emoji if pa else "📦"
    return handle_reaction(ctx, ev, rc)


@operation("record_post")
def record_post(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    """Optional step after a clean post: remember its message id/link (reaction lookup) and post time."""
    case_id = (payload.get("case_id") or "").strip().upper()
    if not case_id:
        found = case_ids_in(payload.get("message_text") or "", ctx.config)
        case_id = found[0] if found else ""
    if not case_id:
        raise UserFacingError("record_post needs a case_id.")
    case = ctx.store.get_case(case_id)
    if case is None:
        raise UserFacingError(f"I can't find {case_id}.")
    ref = payload.get("message_id") or payload.get("message_link")
    if ref:
        case.clean_message_ref = ref
    if case.clean_posted_at is None:
        case.clean_posted_at = ctx.now()
    ctx.store.save_case(case)
    ctx.emit(EventType.CLEAN_POSTED, case_id=case.case_id, actor=rc.invoked_by or "agent", space="clean", message_ref=ref,
             payload={"message_id": payload.get("message_id"), "message_link": payload.get("message_link")})
    return ChatOutputs(case_id=case.case_id, summary=f"{case.case_id} clean post recorded"), {
        "case_id": case.case_id, "clean_message_ref": case.clean_message_ref}
