"""Escalations: Social Alert drafts in the IM's Gmail (Brand Social alias) + sent detection.

Public API (docs/CONTRACTS.md §7; used by triage.py for URGENT auto-drafts, actions.py,
converse, tns.py and run_followups):

    start_escalation(ctx, case, analyst_email, *, trigger, requested_by, chat_message_ref=None) -> Escalation
    draft_alert_email(ctx, esc, case, *, extra_groups=()) -> EmailState
    add_group(ctx, esc, case, group, actor) -> EmailState
    revise_email(ctx, esc, instruction, actor, purpose="alert") -> EmailState
    check_sent(ctx, esc) -> list[EmailState]

plus richer variants for chat replies (`draft_alert`, `add_group_to_draft` -> DraftOutcome),
`recipient_plan`, `create_email` (any purpose) and `draft_note` (clean-post line).

One escalation per case per IM mailbox: start_escalation reuses that IM's open escalation,
else their most recent one for the case. Drafts are always created in `esc.analyst_email`'s
mailbox. Functions mutate and save the Case / Escalation objects they are given, so callers
that keep a reference (triage.py) save the same object afterwards.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Iterable

from .. import render, routing
from ..events import EventType
from ..models import (
    AlertAssessment, Case, DraftVersion, EmailState, EmailStatus, Escalation, RecipientPlan,
)
from ..operations import UserFacingError
from ..store import escalation_is_open
from . import drafting
from .gmail import GmailDraftNotFound, GmailError, GmailNotConnected

if TYPE_CHECKING:  # pragma: no cover
    from ..context import AgentContext

log = logging.getLogger(__name__)

OPEN_EMAIL = (EmailStatus.DRAFTED, EmailStatus.REVISION_REQUESTED, EmailStatus.REDRAFTED)
PURPOSE_LABELS = {"alert": "alert", "tns_urgent": "T&S urgent", "bug_followup": "bug-ID follow-up", "group": "team follow-up"}


@dataclass
class ThreadRef:
    """Where a reply goes: the original email's Message-ID (+ Gmail thread if it's in this mailbox)."""

    in_reply_to: str
    references: list[str]
    subject: str | None = None
    thread_id: str | None = None  # only when the original is in the drafting IM's mailbox
    related_case_id: str | None = None
    original_escalation_id: str | None = None
    original_mailbox: str | None = None


@dataclass
class DraftOutcome:
    """Result of a draft operation, with what chat replies need (groups, missing, notes)."""

    email: EmailState
    action: str  # created | updated | unchanged | existing | already_sent | failed | gone
    plan: RecipientPlan | None = None
    notes: list[str] = field(default_factory=list)
    thread: ThreadRef | None = None
    escalation_id: str | None = None


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def is_open(email: EmailState | None) -> bool:
    return email is not None and email.status in OPEN_EMAIL


def purpose_label(purpose: str) -> str:
    return PURPOSE_LABELS.get(purpose, purpose)


def _norm(email: str | None) -> str:
    return (email or "").strip().lower()


def _dedupe(items: Iterable[str]) -> list[str]:
    out: dict[str, str] = {}
    for item in items:
        if item and item.strip() and item.strip().lower() not in out:
            out[item.strip().lower()] = item.strip()
    return list(out.values())


def _seconds(delta) -> float:
    return round(delta.total_seconds(), 1)


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def assessment(case: Case) -> AlertAssessment:
    """The case's assessment, or a minimal one from its denormalized fields."""
    a = drafting.assessment_of(case)
    if a is not None:
        return a
    data: dict[str, Any] = {"product": case.product, "exposure_tag": case.exposure_tag, "platform": case.platform}
    if case.priority in ("P0", "P1", "P2"):
        data["priority"] = case.priority
    if case.track in ("URGENT", "HIGH_ENGAGEMENT"):
        data["track"] = case.track
    return AlertAssessment.model_validate(data)


def alert_text(case: Case) -> str:
    """Text the routing keyword triggers look at (post text + issue name + summary + alert name)."""
    f = drafting.alert_fields(case)
    return "\n".join(str(f.get(k) or "") for k in ("post_content", "issue_name", "summary", "alert_name"))


def recipient_plan(ctx: "AgentContext", case: Case, extra_groups: Iterable[str] = ()) -> RecipientPlan:
    a = assessment(case)
    product = a.product or drafting.alert_fields(case).get("product") or case.product
    return routing.plan_recipients(ctx.config, a, alert_text(case), extra_groups=list(extra_groups), product_name=product)


def place_recipients(ctx: "AgentContext", plan: RecipientPlan) -> tuple[list[str], list[str], list[str]]:
    """(to, cc, bcc) per escalation.recipients_in. With "bcc" the To line is the Brand Social alias."""
    esc_cfg = ctx.config.escalation
    if esc_cfg.recipients_in == "bcc":
        return [esc_cfg.from_email], [], _dedupe(plan.to + plan.cc)
    return list(plan.to), list(plan.cc), []


def connection_error(ctx: "AgentContext", user_email: str) -> str | None:
    """None when drafting in `user_email`'s Gmail is possible, else a message for the IM."""
    if ctx.gmail is None:
        return "Gmail drafting isn't configured for the agent"
    try:
        connected = ctx.gmail.is_connected(user_email)
    except Exception as exc:  # noqa: BLE001
        log.warning("is_connected failed for %s: %s", user_email, exc)
        connected = False
    if not connected:
        return f"Gmail isn't connected for {user_email}: connect it in the Agent Console"
    return None


def _put_email(esc: Escalation, email: EmailState) -> None:
    """Append, replacing a previous FAILED email of the same purpose (it never had a draft)."""
    previous = esc.email_for(email.purpose)
    if previous is not None and previous.status == EmailStatus.FAILED and previous is not email:
        esc.emails[esc.emails.index(previous)] = email
    elif email not in esc.emails:
        esc.emails.append(email)


def _link_case(ctx: "AgentContext", case: Case, esc: Escalation) -> None:
    if esc.escalation_id not in case.escalation_ids:
        case.escalation_ids.append(esc.escalation_id)
        ctx.store.save_case(case)


def _drafted_payload(email: EmailState, version: DraftVersion, bcc: list[str], *, used_llm: bool | None = None) -> dict:
    payload: dict[str, Any] = {
        "purpose": email.purpose, "version": version.version, "to": len(version.to), "cc": len(version.cc),
        "bcc": len(bcc), "groups": list(email.groups), "thread_reply": bool(email.in_reply_to),
    }
    if used_llm is not None:
        payload["llm"] = used_llm
    return payload


# ---------------------------------------------------------------------------
# Escalations
# ---------------------------------------------------------------------------


def start_escalation(ctx: "AgentContext", case: Case, analyst_email: str, *, trigger: str, requested_by: str | None,
                     chat_message_ref: str | None = None) -> Escalation:
    """Reuse the IM's open escalation for the case (else their most recent one), or start one."""
    analyst = _norm(analyst_email)
    if not analyst:
        raise UserFacingError("I need the Incident Manager's email to start an escalation.")
    mine = [e for e in ctx.store.list_escalations(case_id=case.case_id, limit=100) if _norm(e.analyst_email) == analyst]
    existing = next((e for e in mine if escalation_is_open(e)), None) or (mine[0] if mine else None)
    if existing is not None:
        if chat_message_ref and not existing.chat_message_ref:
            existing.chat_message_ref = chat_message_ref
            ctx.store.save_escalation(existing)
        _link_case(ctx, case, existing)
        return existing
    now = ctx.now()
    esc = Escalation(
        escalation_id=ctx.store.next_id(ctx.config.escalation_id_prefix), case_id=case.case_id, analyst_email=analyst,
        requested_at=now, requested_by=requested_by, trigger=trigger,  # type: ignore[arg-type]
        chat_message_ref=chat_message_ref, updated_at=now, env=ctx.config.env,
    )
    ctx.store.save_escalation(esc)
    _link_case(ctx, case, esc)
    ctx.emit(EventType.ESCALATION_STARTED, escalation_id=esc.escalation_id, case_id=case.case_id,
             actor=requested_by or analyst, payload={"trigger": trigger, "analyst_email": analyst})
    return esc


def find_original_alert(ctx: "AgentContext", case_id: str) -> tuple[Escalation | None, EmailState | None]:
    """The case's most recent SENT alert email that has a Message-ID (any IM's mailbox)."""
    best: tuple[datetime, Escalation, EmailState] | None = None
    for esc in ctx.store.list_escalations(case_id=case_id, limit=100):
        for email in esc.emails:
            if email.purpose == "alert" and email.status == EmailStatus.SENT and email.rfc822_message_id:
                key = email.sent_at or esc.updated_at
                if best is None or key > best[0]:
                    best = (key, esc, email)
    return (best[1], best[2]) if best else (None, None)


def sent_alert(ctx: "AgentContext", case: Case) -> tuple[Escalation | None, EmailState | None]:
    """Any SENT alert email for the case (with or without a Message-ID)."""
    esc, email = find_original_alert(ctx, case.case_id)
    if email is not None:
        return esc, email
    for e in ctx.store.list_escalations(case_id=case.case_id, limit=100):
        for m in e.emails:
            if m.purpose == "alert" and m.status == EmailStatus.SENT:
                return e, m
    return None, None


def thread_for_reply(ctx: "AgentContext", esc: Escalation, case_id: str) -> ThreadRef | None:
    """Reply target on case `case_id`'s sent alert email (threadId only for the same mailbox)."""
    orig_esc, orig = find_original_alert(ctx, case_id)
    if orig is None:  # sent but not detected yet? refresh that case's open drafts once
        for other in ctx.store.list_escalations(case_id=case_id, open_only=True, limit=20):
            try:
                check_sent(ctx, other)
            except Exception as exc:  # noqa: BLE001
                log.warning("check_sent failed for %s: %s", other.escalation_id, exc)
        orig_esc, orig = find_original_alert(ctx, case_id)
    if orig is None or orig_esc is None:
        related = ctx.store.get_case(case_id)
        if related and related.alert_email_message_ids:
            rfc = related.alert_email_message_ids[-1]
            return ThreadRef(in_reply_to=rfc, references=[rfc], subject=drafting.subject_for(ctx, related),
                             related_case_id=case_id)
        return None
    same_mailbox = _norm(orig_esc.analyst_email) == _norm(esc.analyst_email)
    return ThreadRef(
        in_reply_to=orig.rfc822_message_id or "", references=[r for r in (orig.in_reply_to, orig.rfc822_message_id) if r],
        subject=orig.versions[-1].subject if orig.versions else None,
        thread_id=orig.thread_id if same_mailbox else None, related_case_id=case_id,
        original_escalation_id=orig_esc.escalation_id, original_mailbox=orig_esc.analyst_email,
    )


def _ongoing_thread(ctx: "AgentContext", esc: Escalation, case: Case) -> tuple[ThreadRef | None, list[str]]:
    a = assessment(case)
    if a.issue_status != "ONGOING" or not a.related_case_id or a.related_case_id == case.case_id:
        return None, []
    thread = thread_for_reply(ctx, esc, a.related_case_id)
    if thread is None:
        return None, [f"Ongoing issue ({a.related_case_id}), but its alert email hasn't been sent, so this draft starts a new thread."]
    notes = [f"↩️ Reply on the ongoing thread for {a.related_case_id}."]
    if thread.original_mailbox and not thread.thread_id:
        notes.append(f"The original was sent from {thread.original_mailbox}'s Gmail; In-Reply-To is set so it threads for recipients.")
    return thread, notes


# ---------------------------------------------------------------------------
# Creating / writing drafts
# ---------------------------------------------------------------------------


def _fail(ctx: "AgentContext", esc: Escalation, purpose: str, error: str, reason: str, *,
          groups: Iterable[str] = ()) -> EmailState:
    email = EmailState(purpose=purpose, status=EmailStatus.FAILED,  # type: ignore[arg-type]
                       from_alias=ctx.config.escalation.from_header, groups=list(groups), error=error)
    _put_email(esc, email)
    ctx.store.save_escalation(esc)
    ctx.emit(EventType.EMAIL_FAILED, escalation_id=esc.escalation_id, case_id=esc.case_id,
             payload={"purpose": purpose, "reason": reason, "error": error})
    return email


def create_email(
    ctx: "AgentContext", esc: Escalation, *, purpose: str, subject: str, body: str, to: list[str], cc: list[str],
    bcc: list[str], html_body: str | None = None, groups: Iterable[str] = (),
    thread: ThreadRef | None = None, used_llm: bool | None = None,
) -> EmailState:
    """Create a draft of any purpose in esc.analyst_email's Gmail; FAILED (+ email.failed) when impossible."""
    groups = list(groups)
    problem = connection_error(ctx, esc.analyst_email)
    if problem:
        return _fail(ctx, esc, purpose, problem, "not_connected", groups=groups)
    fields: dict[str, Any] = dict(
        from_header=ctx.config.escalation.from_header, to=to, cc=cc, bcc=bcc, subject=subject, body=body,
        in_reply_to=thread.in_reply_to if thread and thread.in_reply_to else None,
        references=thread.references if thread and thread.in_reply_to else None,
        thread_id=thread.thread_id if thread else None,
    )
    if html_body:
        fields["html_body"] = html_body
    try:
        try:
            result = ctx.gmail.create_draft(esc.analyst_email, **fields)
        except GmailDraftNotFound:
            if not fields["thread_id"]:
                raise
            fields["thread_id"] = None  # the thread was deleted: In-Reply-To/References still thread it
            result = ctx.gmail.create_draft(esc.analyst_email, **fields)
    except GmailNotConnected as exc:
        return _fail(ctx, esc, purpose, str(exc), "not_connected", groups=groups)
    except Exception as exc:  # noqa: BLE001 - never break the calling flow; the IM can retry
        log.exception("create_draft failed for %s", esc.escalation_id)
        return _fail(ctx, esc, purpose, f"Gmail error: {exc}", "gmail_error", groups=groups)
    now = ctx.now()
    version = DraftVersion(version=1, subject=subject, to=list(to), cc=list(cc), bcc=list(bcc), body=body, created_at=now)
    email = EmailState(
        purpose=purpose, status=EmailStatus.DRAFTED, from_alias=ctx.config.escalation.from_header,  # type: ignore[arg-type]
        groups=groups, draft_id=result.get("draft_id"), message_id=result.get("message_id"),
        thread_id=result.get("thread_id") or fields["thread_id"], in_reply_to=fields["in_reply_to"],
        versions=[version], drafted_at=now,
    )
    _put_email(esc, email)
    ctx.store.save_escalation(esc)
    ctx.emit(EventType.EMAIL_DRAFTED, escalation_id=esc.escalation_id, case_id=esc.case_id,
             actor=esc.analyst_email, payload=_drafted_payload(email, version, bcc, used_llm=used_llm))
    return email


def current_content(ctx: "AgentContext", esc: Escalation, email: EmailState) -> dict[str, Any]:
    """The draft as it is now in Gmail (IM edits included) when readable, else our last version."""
    last = email.versions[-1] if email.versions else None
    base: dict[str, Any] = {
        "subject": last.subject if last else "", "body": last.body if last else "",
        "to": list(last.to) if last else [], "cc": list(last.cc) if last else [],
        "bcc": list(last.bcc) if last and last.bcc else None,  # None = unknown, re-planned from the groups
    }
    getter = getattr(ctx.gmail, "get_draft", None)
    if getter is None or not email.draft_id:
        return base
    try:
        live = getter(esc.analyst_email, email.draft_id)
    except GmailError:
        return base
    except Exception as exc:  # noqa: BLE001
        log.warning("get_draft failed for %s: %s", email.draft_id, exc)
        return base
    if not live:
        return base
    return {**base, **{k: live.get(k) for k in ("subject", "body", "to", "cc", "bcc") if live.get(k) is not None}}


def _write(ctx: "AgentContext", esc: Escalation, email: EmailState, changes: dict[str, Any],
           full: dict[str, Any]) -> dict | None:
    """Partial update (keeps IM edits); if Gmail can't do it, retry with every field. None = draft gone."""
    try:
        try:
            return ctx.gmail.update_draft(esc.analyst_email, email.draft_id, **changes)
        except (GmailDraftNotFound, GmailNotConnected):
            raise
        except GmailError as exc:
            log.info("partial update failed (%s); rewriting draft %s", exc, email.draft_id)
            return ctx.gmail.update_draft(esc.analyst_email, email.draft_id, **full)
    except GmailDraftNotFound:
        return None


def _full_fields(ctx: "AgentContext", email: EmailState, *, subject: str, body: str, to: list[str], cc: list[str],
                 bcc: list[str]) -> dict[str, Any]:
    return dict(from_header=email.from_alias or ctx.config.escalation.from_header, to=to, cc=cc, bcc=bcc,
                subject=subject, body=body, in_reply_to=email.in_reply_to,
                references=[email.in_reply_to] if email.in_reply_to else None, thread_id=email.thread_id)


# ---------------------------------------------------------------------------
# Alert email
# ---------------------------------------------------------------------------


def draft_alert(ctx: "AgentContext", esc: Escalation, case: Case, *, extra_groups: Iterable[str] = ()) -> DraftOutcome:
    """Create the alert draft (a reply on the ongoing thread when the issue is ONGOING).

    An open alert draft is reused (recipients re-planned when `extra_groups` is given); a sent
    one is reported as already sent. Never raises for Gmail problems: the email is FAILED.
    """
    extra = list(extra_groups)
    current = esc.email_for("alert")
    if is_open(current):
        _refresh(ctx, esc, current, case)  # type: ignore[arg-type]
    if is_open(current):
        if extra:
            outcome = update_recipients(ctx, esc, case, current, list(current.groups) + extra)  # type: ignore[union-attr]
            if outcome.action != "gone":
                return outcome
        else:
            return DraftOutcome(current, "existing", plan=recipient_plan(ctx, case, current.groups),  # type: ignore[arg-type,union-attr]
                                escalation_id=esc.escalation_id)
    sent_esc, sent = sent_alert(ctx, case)
    if sent is not None:
        return DraftOutcome(sent, "already_sent", escalation_id=sent_esc.escalation_id if sent_esc else None)

    plan = recipient_plan(ctx, case, extra)
    notes = [f"Heads-up: {o.analyst_email} also has an open alert draft for {case.case_id} ({o.escalation_id}); send only one."
             for o in ctx.store.list_escalations(case_id=case.case_id, open_only=True, limit=20)
             if _norm(o.analyst_email) != _norm(esc.analyst_email) and is_open(o.email_for("alert"))]
    problem = connection_error(ctx, esc.analyst_email)
    if problem:
        return DraftOutcome(_fail(ctx, esc, "alert", problem, "not_connected", groups=plan.groups), "failed",
                            plan=plan, notes=notes, escalation_id=esc.escalation_id)
    thread, thread_notes = _ongoing_thread(ctx, esc, case)
    subject = drafting.reply_subject(ctx, thread.subject or drafting.subject_for(ctx, case)) if thread \
        else drafting.subject_for(ctx, case)
    text = drafting.draft_alert_text(ctx, case, plan=plan, thread_reply=thread is not None, subject=subject,
                                     original_subject=thread.subject if thread else None,
                                     related_case_id=thread.related_case_id if thread else None)
    to, cc, bcc = place_recipients(ctx, plan)
    email = create_email(ctx, esc, purpose="alert", subject=subject, body=text.body, html_body=text.html_body,
                         to=to, cc=cc, bcc=bcc, groups=plan.groups, thread=thread, used_llm=text.used_llm)
    action = "failed" if email.status == EmailStatus.FAILED else "created"
    return DraftOutcome(email, action, plan=plan, notes=notes + thread_notes + text.notes, thread=thread,
                        escalation_id=esc.escalation_id)


def draft_alert_email(ctx: "AgentContext", esc: Escalation, case: Case, *, extra_groups: Iterable[str] = ()) -> EmailState:
    """Contract wrapper (CONTRACTS §7): new thread, or reply on the ONGOING thread."""
    return draft_alert(ctx, esc, case, extra_groups=extra_groups).email


def update_recipients(ctx: "AgentContext", esc: Escalation, case: Case, email: EmailState,
                      groups: Iterable[str], *, note: str | None = None) -> DraftOutcome:
    """Re-plan an open draft's recipients with these groups and update it in Gmail."""
    plan = recipient_plan(ctx, case, groups)
    if {g.lower() for g in plan.groups} == {g.lower() for g in email.groups}:
        return DraftOutcome(email, "unchanged", plan=plan, escalation_id=esc.escalation_id)
    problem = connection_error(ctx, esc.analyst_email)
    if problem:
        return DraftOutcome(email, "failed", plan=plan, notes=[problem], escalation_id=esc.escalation_id)
    to, cc, bcc = place_recipients(ctx, plan)
    content = current_content(ctx, esc, email)
    last = email.versions[-1] if email.versions else None
    if last is not None:  # keep recipients the IM added by hand in Gmail
        ours = {x.lower() for x in last.to + last.cc}
        to = _dedupe(to + [r for r in content["to"] if r.lower() not in ours])
        cc = _dedupe(cc + [r for r in content["cc"] if r.lower() not in ours and r.lower() not in {t.lower() for t in to}])
    full = _full_fields(ctx, email, subject=content["subject"], body=content["body"], to=to, cc=cc, bcc=bcc)
    try:
        result = _write(ctx, esc, email, {"to": to, "cc": cc, "bcc": bcc}, full)
    except GmailError as exc:
        return DraftOutcome(email, "failed", plan=plan, notes=[str(exc)], escalation_id=esc.escalation_id)
    if result is None:
        _refresh(ctx, esc, email, case)
        return DraftOutcome(email, "gone", plan=plan, escalation_id=esc.escalation_id)
    now = ctx.now()
    email.message_id = result.get("message_id") or email.message_id
    email.thread_id = result.get("thread_id") or email.thread_id
    added = [g for g in plan.groups if g.lower() not in {x.lower() for x in email.groups}]
    email.groups = list(plan.groups)
    email.versions.append(DraftVersion(
        version=len(email.versions) + 1, subject=content["subject"], to=to, cc=cc, bcc=list(bcc), body=content["body"],
        instruction=note or ("Added " + ", ".join(added) if added else "Recipients updated"), created_at=now,
    ))
    ctx.store.save_escalation(esc)
    return DraftOutcome(email, "updated", plan=plan, escalation_id=esc.escalation_id)


def add_group_to_draft(ctx: "AgentContext", esc: Escalation, case: Case, group: str, actor: str, *,
                       via: str = "reaction") -> DraftOutcome:
    """Add a distribution group (📰 💬 💼 …) to the open alert draft, creating the draft if needed.

    If the alert email was already sent, a short reply-all to just that group is drafted on the
    alert thread (purpose "group"). Placeholder groups without recipients show up in plan.missing.
    """
    g = ctx.config.distribution.group(group)
    name = g.name if g else group
    current = esc.email_for("alert")
    if is_open(current):
        _refresh(ctx, esc, current, case)  # type: ignore[arg-type]
    outcome: DraftOutcome | None = None
    if is_open(current):
        outcome = update_recipients(ctx, esc, case, current, list(current.groups) + [name],  # type: ignore[union-attr]
                                    note=f"Added {name} ({via} by {actor})")
        if outcome.action == "gone":
            outcome = None
    if outcome is None:
        sent_esc, sent = sent_alert(ctx, case)
        if sent is not None:
            outcome = _group_followup(ctx, esc, case, name, sent_esc, sent)
        else:
            outcome = draft_alert(ctx, esc, case, extra_groups=[name])
    if outcome.plan and name.lower() in {x.lower() for x in outcome.plan.groups} and outcome.action in ("created", "updated"):
        ctx.emit(EventType.EMAIL_GROUP_ADDED, escalation_id=esc.escalation_id, case_id=case.case_id, actor=actor,
                 payload={"group": name, "via": via, "purpose": outcome.email.purpose})
    return outcome


def add_group(ctx: "AgentContext", esc: Escalation, case: Case, group: str, actor: str) -> EmailState:
    """Contract wrapper (CONTRACTS §7)."""
    return add_group_to_draft(ctx, esc, case, group, actor).email


def _group_followup(ctx: "AgentContext", esc: Escalation, case: Case, name: str, sent_esc: Escalation | None,
                    sent: EmailState) -> DraftOutcome:
    """The alert already went out: draft a reply on its thread to just the new group."""
    dist = ctx.config.distribution
    group = dist.group(name)
    a = assessment(case)
    product, _ = routing.resolve_product(dist, a.product or case.product)
    raw_text = (case.latest.message.text if (case.latest and case.latest.message) else "") or ""
    emails = routing.group_recipients(group, product, dist=dist, a=a, text=raw_text) if group else []
    plan = RecipientPlan(groups=[name] if emails else [], missing=[] if emails else [name],
                         reasons={name: "added by IM"} if emails else {})
    if not emails:
        return DraftOutcome(sent, "already_sent", plan=plan, escalation_id=sent_esc.escalation_id if sent_esc else None)
    existing = next((m for m in reversed(esc.emails) if m.purpose == "group" and is_open(m)), None)
    if existing is not None:
        return update_recipients_group(ctx, esc, existing, name, emails, plan)
    thread = None
    if sent.rfc822_message_id:
        same = sent_esc is not None and _norm(sent_esc.analyst_email) == _norm(esc.analyst_email)
        thread = ThreadRef(in_reply_to=sent.rfc822_message_id,
                           references=[r for r in (sent.in_reply_to, sent.rfc822_message_id) if r],
                           subject=sent.versions[-1].subject if sent.versions else None,
                           thread_id=sent.thread_id if same else None, related_case_id=case.case_id)
    subject = drafting.reply_subject(ctx, (thread.subject if thread else None) or drafting.subject_for(ctx, case))
    text = drafting.group_followup_text(ctx, case, name, subject=subject)
    to, cc, bcc = place_recipients(ctx, RecipientPlan(to=emails))
    email = create_email(ctx, esc, purpose="group", subject=subject, body=text.body, to=to, cc=cc, bcc=bcc,
                         groups=[name], thread=thread)
    action = "failed" if email.status == EmailStatus.FAILED else "created"
    return DraftOutcome(email, action, plan=plan, notes=["The alert email was already sent, so this is a reply to just the new team."],
                        thread=thread, escalation_id=esc.escalation_id)


def update_recipients_group(ctx: "AgentContext", esc: Escalation, email: EmailState, name: str, emails: list[str],
                            plan: RecipientPlan) -> DraftOutcome:
    """Add another team to an open group follow-up draft."""
    if name.lower() in {g.lower() for g in email.groups}:
        return DraftOutcome(email, "unchanged", plan=plan, escalation_id=esc.escalation_id)
    content = current_content(ctx, esc, email)
    bcc_mode = ctx.config.escalation.recipients_in == "bcc"
    current = content.get("bcc") if bcc_mode else content.get("to")
    merged = _dedupe(list(current or []) + emails)
    to, cc, bcc = (([ctx.config.escalation.from_email], [], merged) if bcc_mode else (merged, list(content.get("cc") or []), []))
    full = _full_fields(ctx, email, subject=content["subject"], body=content["body"], to=to, cc=cc, bcc=bcc)
    try:
        result = _write(ctx, esc, email, {"to": to, "cc": cc, "bcc": bcc}, full)
    except GmailError as exc:
        return DraftOutcome(email, "failed", plan=plan, notes=[str(exc)], escalation_id=esc.escalation_id)
    if result is None:
        _refresh(ctx, esc, email)
        return DraftOutcome(email, "gone", plan=plan, escalation_id=esc.escalation_id)
    email.groups = email.groups + [name]
    email.versions.append(DraftVersion(version=len(email.versions) + 1, subject=content["subject"], to=to, cc=cc,
                                       bcc=list(bcc), body=content["body"], instruction=f"Added {name}", created_at=ctx.now()))
    ctx.store.save_escalation(esc)
    plan.groups = list(email.groups)
    return DraftOutcome(email, "updated", plan=plan, escalation_id=esc.escalation_id)


# ---------------------------------------------------------------------------
# Revisions
# ---------------------------------------------------------------------------


def revise_email(ctx: "AgentContext", esc: Escalation, instruction: str, actor: str, purpose: str = "alert") -> EmailState:
    """Apply an IM revision ("@Triage Agent revise: shorter") to the open draft with Gemini.

    Raises UserFacingError when there is nothing to revise. If Gemini fails, the email stays
    REVISION_REQUESTED with `error` set (the draft in Gmail is unchanged).
    """
    instruction = (instruction or "").strip()
    label = purpose_label(purpose)
    if not instruction:
        raise UserFacingError("Tell me what to change, e.g. `revise: shorter, add the AIO 2K list`.")
    email = esc.email_for(purpose)
    if email is None:
        raise UserFacingError(f"{esc.escalation_id} has no {label} draft to revise.")
    if is_open(email):
        _refresh(ctx, esc, email)
    if email.status == EmailStatus.SENT:
        raise UserFacingError(f"The {label} email on {esc.escalation_id} was already sent "
                              f"({render.fmt_time(ctx, email.sent_at)}), so I can't change it.")
    if email.status == EmailStatus.FAILED:
        raise UserFacingError(f"{esc.escalation_id}: {email.error or f'the {label} draft failed'}.")
    problem = connection_error(ctx, esc.analyst_email)
    if problem:
        raise UserFacingError(f"{esc.escalation_id}: {problem}.")
    case = ctx.store.get_case(esc.case_id)
    gone = email.draft_id is None or email.status == EmailStatus.DISCARDED  # before the status changes below
    email.revision_requests += 1
    email.status = EmailStatus.REVISION_REQUESTED
    ctx.store.save_escalation(esc)
    ctx.emit(EventType.EMAIL_REVISION_REQUESTED, escalation_id=esc.escalation_id, case_id=esc.case_id, actor=actor,
             payload={"purpose": purpose, "instruction": instruction})

    content = current_content(ctx, esc, email)
    text = drafting.revise_text(ctx, case, purpose=purpose, subject=content["subject"], body=content["body"],
                                instruction=instruction, thread_reply=bool(email.in_reply_to))
    if text.error:
        email.error = f"Revision not applied automatically ({text.error}); edit the draft in Gmail."
        ctx.store.save_escalation(esc)
        return email
    to, cc = list(content["to"]), list(content["cc"])
    bcc = list(content["bcc"]) if content.get("bcc") is not None else (
        place_recipients(ctx, recipient_plan(ctx, case, email.groups))[2] if case and purpose == "alert" else [])
    full = _full_fields(ctx, email, subject=text.subject, body=text.body, to=to, cc=cc, bcc=bcc)
    result = None
    if not gone:
        try:
            result = _write(ctx, esc, email, {"subject": text.subject, "body": text.body}, full)
        except GmailError as exc:
            email.error = f"Gmail error: {exc}"
            ctx.store.save_escalation(esc)
            return email
        if result is None:  # deleted or sent meanwhile
            _refresh(ctx, esc, email)
            if email.status == EmailStatus.SENT:
                raise UserFacingError(f"The {label} email on {esc.escalation_id} was sent before I could revise it.")
    if result is None:  # the IM deleted the draft: recreate it with the revision
        try:
            try:
                result = ctx.gmail.create_draft(esc.analyst_email, **full)
            except GmailDraftNotFound:
                if not full.get("thread_id"):
                    raise
                full["thread_id"] = None  # the thread went with the draft; In-Reply-To/References still thread replies
                result = ctx.gmail.create_draft(esc.analyst_email, **full)
        except GmailError as exc:
            email.error = f"Gmail error: {exc}"
            ctx.store.save_escalation(esc)
            return email
        email.draft_id = result.get("draft_id")
    now = ctx.now()
    email.message_id = result.get("message_id") or email.message_id
    email.thread_id = result.get("thread_id") or email.thread_id
    version = DraftVersion(version=len(email.versions) + 1, subject=text.subject, to=to, cc=cc, bcc=list(bcc),
                           body=text.body, instruction=instruction, created_at=now)
    email.versions.append(version)
    email.status = EmailStatus.REDRAFTED
    email.error = None
    ctx.store.save_escalation(esc)
    ctx.emit(EventType.EMAIL_REDRAFTED, escalation_id=esc.escalation_id, case_id=esc.case_id, actor=actor,
             payload=_drafted_payload(email, version, bcc, used_llm=True))
    return email


# ---------------------------------------------------------------------------
# Sent detection
# ---------------------------------------------------------------------------


def _refresh(ctx: "AgentContext", esc: Escalation, email: EmailState, case: Case | None = None) -> bool:
    """Check one open draft in Gmail; apply SENT / DISCARDED. True when the status changed.

    Pass the caller's `case` object (if it holds one) so SENT updates land on it."""
    if not is_open(email) or not email.draft_id or ctx.gmail is None:
        return False
    try:
        if not ctx.gmail.is_connected(esc.analyst_email):
            return False
        status = ctx.gmail.draft_status(
            esc.analyst_email, email.draft_id, email.thread_id, since=email.drafted_at,
            exclude=[email.in_reply_to] if email.in_reply_to else [],
        ) or {}
    except Exception as exc:  # noqa: BLE001 - try again on the next run
        log.warning("draft_status failed for %s/%s: %s", esc.escalation_id, email.draft_id, exc)
        return False
    if status.get("status") == "SENT":
        _mark_sent(ctx, esc, email, status, case)
        return True
    if status.get("status") == "DISCARDED":
        email.status = EmailStatus.DISCARDED
        ctx.store.save_escalation(esc)
        ctx.emit(EventType.EMAIL_DISCARDED, escalation_id=esc.escalation_id, case_id=esc.case_id,
                 actor=esc.analyst_email, payload={"purpose": email.purpose, "reason": "draft_deleted"})
        return True
    return False


def _mark_sent(ctx: "AgentContext", esc: Escalation, email: EmailState, status: dict, case: Case | None = None) -> None:
    sent_at = _as_datetime(status.get("sent_at")) or ctx.now()
    email.status = EmailStatus.SENT
    email.sent_at = sent_at
    email.rfc822_message_id = status.get("rfc822_message_id") or email.rfc822_message_id
    email.error = None
    ctx.store.save_escalation(esc)
    if case is None or case.case_id != esc.case_id:
        case = ctx.store.get_case(esc.case_id)
    payload: dict[str, Any] = {"purpose": email.purpose, "flag_to_send_s": _seconds(sent_at - esc.requested_at),
                               "versions": len(email.versions)}
    if case is not None:
        payload["post_to_send_s"] = _seconds(sent_at - (case.clean_posted_at or case.created_at))
    if case is not None and email.purpose == "alert":
        if email.rfc822_message_id and email.rfc822_message_id not in case.alert_email_message_ids:
            case.alert_email_message_ids.append(email.rfc822_message_id)
        if case.sla_met is None and case.sla_due_at is not None:  # SLA is decided once per case
            met = sent_at <= case.sla_due_at
            case.sla_met = met
            a = assessment(case)
            ctx.emit(EventType.SLA_MET if met else EventType.SLA_MISSED, case_id=case.case_id,
                     escalation_id=esc.escalation_id,
                     payload={"track": case.track or a.track, "platform_tier": a.platform_tier,
                              "sla_minutes": a.sla_minutes, "due_at": case.sla_due_at.isoformat(),
                              "sent_at": sent_at.isoformat()})
        ctx.store.save_case(case)
    if email.purpose == "bug_followup":
        _mark_bug_followup_sent(ctx, esc, sent_at)
    ctx.emit(EventType.EMAIL_SENT, escalation_id=esc.escalation_id, case_id=esc.case_id, actor=esc.analyst_email,
             payload=payload)


def _mark_bug_followup_sent(ctx: "AgentContext", esc: Escalation, sent_at: datetime) -> None:
    holder = esc if esc.tns is not None else next(
        (e for e in ctx.store.list_escalations(case_id=esc.case_id, limit=100) if e.tns and e.tns.bug_id), None)
    if holder is not None and holder.tns is not None and holder.tns.bug_followup_sent_at is None:
        holder.tns.bug_followup_sent_at = sent_at
        ctx.store.save_escalation(holder)


def check_sent(ctx: "AgentContext", esc: Escalation) -> list[EmailState]:
    """Sent detection for every open draft of the escalation (run_followups). Returns changed emails."""
    changed = [email for email in list(esc.emails) if is_open(email) and _refresh(ctx, esc, email)]
    return changed


# ---------------------------------------------------------------------------
# Chat lines
# ---------------------------------------------------------------------------


def draft_note(ctx: "AgentContext", esc: Escalation, email: EmailState) -> str:
    """One line for the clean post / replies about where the draft is."""
    if email.status in OPEN_EMAIL:
        thread = " · ↩️ reply on the ongoing thread" if email.in_reply_to else ""
        return f"📨 Draft ready in {esc.analyst_email}'s Gmail (Brand Social) · {esc.escalation_id}{thread}"
    if email.status == EmailStatus.SENT:
        return f"📨 {purpose_label(email.purpose).capitalize()} email sent {render.fmt_time(ctx, email.sent_at)} · {esc.escalation_id}"
    if email.status == EmailStatus.FAILED and "connect" in (email.error or "").lower():
        return f"📨 Connect Gmail in the Agent Console for auto-drafts ({esc.analyst_email}) · {esc.escalation_id}"
    if email.status == EmailStatus.FAILED:
        return f"📨 Draft failed ({render.truncate(email.error, 120)}); react 📦 to retry · {esc.escalation_id}"
    return f"📨 Draft {email.status.value.lower()} · {esc.escalation_id}"
