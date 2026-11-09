"""IM workflow after an alert is verified: clean post, protocol pings, acknowledgements, emoji
actions, Social Alert drafts (versions, sends, SLA), the T&S / Watchdog loop and closing."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlencode

from triage_agent.events import EventType as E
from triage_agent.models import (
    ActionRecord,
    AlertAssessment,
    Attempt,
    Case,
    CaseStatus,
    DraftVersion,
    EmailState,
    EmailStatus,
    Escalation,
    TnsState,
    TnsStatus,
    TriageResult,
    Verdict,
)
from triage_agent.render import fmt_value

from . import demo_data as D
from .demo_sim import Sim, Spec

GROUP_CODES = ["civics", "people_comms", "exec_comms", "stop_leaks", "influencer_team", "lss", "gup"]


def _touch(case: Case, t: datetime) -> None:
    if t > case.updated_at:
        case.updated_at = t


def _fields(att: Attempt) -> dict[str, Any]:
    return att.result.normalized


def _action(sim: Sim, case: Case, t: datetime, code: str, actor: str, esc: Escalation | None = None, note: str | None = None) -> bool:
    act = sim.cfg.action(code)
    if act is None or not sim.ok(t):
        return False
    first = case.acknowledged_at is None
    case.actions.append(ActionRecord(code=code, emoji=act.emoji, actor=actor, at=t, escalation_id=esc.escalation_id if esc else None, note=note))
    sim.emit(t, E.ACTION_RECORDED, case_id=case.case_id, escalation_id=esc.escalation_id if esc else None, actor=actor, space="clean",
             payload={"code": code, "emoji": act.emoji, "kind": act.kind, "escalation_id": esc.escalation_id if esc else None})
    if first:
        case.acknowledged_at = t
        posted = case.clean_posted_at or t
        sim.emit(t, E.ALERT_ACKNOWLEDGED, case_id=case.case_id, actor=actor, space="clean",
                 payload={"ack_latency_s": round((t - posted).total_seconds())})
    _touch(case, t)
    return True


# ---------------------------------------------------------------------------
# Escalations (Social Alert email)
# ---------------------------------------------------------------------------


def _body(fields: dict[str, Any], a: AlertAssessment, version: int, instruction: str | None) -> str:
    bottom = fields.get("summary") or ""
    if instruction and "shorter" in instruction:
        bottom = bottom.split(";")[0].split(".")[0] + "."
    lines = [
        f"Bottom line: {bottom}", "",
        f"Name: {fields.get('alert_name')}",
        f"Engagement: {a.engagement_level} ({int(a.engagement_total or 0):,})",
        f"Product: {a.product}" + (f" (+ {', '.join(a.secondary_products)})" if a.secondary_products else ""),
        f"Social Network: {a.platform}",
        f"Exposure Tag: {a.exposure_tag} ({a.priority})",
        f"Risk Tag: {', '.join(a.sensitive_topics) or '—'}",
        f"KOF: {'Yes' if a.is_kof else 'No'}",
        f"T&S: {'Recommended' if a.ts_recommended else 'No'}",
    ]
    if a.video_timestamp:
        lines.append(f"Timestamp: {a.video_timestamp}")
    lines += ["", f"Post: \"{fields.get('post_content') or ''}\"", f"View Post: {fields.get('post_url')}", "", "Brand Social"]
    if version > 1 and instruction:
        lines.insert(1, f"(Revised: {instruction})")
    return "\n".join(lines)


def start_escalation(sim: Sim, case: Case, t: datetime, trigger: str, actor: str, analyst: str) -> Escalation | None:
    if not sim.ok(t):
        return None
    esc_id = sim.next_id(sim.cfg.escalation_id_prefix)
    esc = Escalation(escalation_id=esc_id, case_id=case.case_id, analyst_email=analyst, requested_at=t, requested_by=actor,
                     trigger=trigger, chat_message_ref=case.clean_message_ref, updated_at=t, env=sim.cfg.env)  # type: ignore[arg-type]
    sim.escalations[esc_id] = esc
    case.escalation_ids.append(esc_id)
    sim.emit(t, E.ESCALATION_STARTED, escalation_id=esc_id, case_id=case.case_id, actor=actor,
             space="console" if trigger == "console" else "clean", payload={"trigger": trigger, "analyst_email": analyst})
    _touch(case, t)
    return esc


def _alert_email_events(sim: Sim, esc: Escalation, case: Case, t: datetime, kind: str, email: EmailState, version: int, thread_reply: bool) -> None:
    latest = email.versions[-1] if email.versions else None
    sim.emit(t, kind, escalation_id=esc.escalation_id, case_id=case.case_id, space="email",
             payload={"purpose": email.purpose, "version": version, "to": len(latest.to) if latest else 0,
                      "cc": len(latest.cc) if latest else 0, "bcc": len(latest.bcc) if latest else 0,
                      "groups": list(email.groups), "thread_reply": thread_reply, "llm": email.purpose == "alert"})


def draft_alert(sim: Sim, spec: Spec, esc: Escalation, case: Case, att: Attempt, t: datetime) -> EmailState | None:
    if not sim.ok(t):
        return None
    a = att.result.assessment
    assert a is not None
    from_alias = sim.cfg.escalation.from_header
    if esc.analyst_email not in sim.gmail_connected:
        email = EmailState(purpose="alert", status=EmailStatus.FAILED, from_alias=from_alias,
                           error=f"Gmail not connected for {esc.analyst_email}")
        esc.emails.append(email)
        esc.updated_at = t
        sim.emit(t, E.EMAIL_FAILED, escalation_id=esc.escalation_id, case_id=case.case_id, space="email",
                 payload={"purpose": "alert", "reason": "gmail_not_connected"})
        return None
    plan = a.recipients
    fields = _fields(att)
    subject = sim.cfg.escalation.subject_format.format(alert_name=fields.get("alert_name") or case.alert_name)
    in_reply_to = None
    related = spec.related.case if spec.related else None
    if related and related.alert_email_message_ids:
        in_reply_to = related.alert_email_message_ids[-1]
        subject = f"{sim.cfg.escalation.reply_subject_prefix}{related.alert_name or subject}"
    to, cc = (list(plan.to), list(plan.cc)) if plan else ([], [])
    email = EmailState(
        purpose="alert", status=EmailStatus.DRAFTED, from_alias=from_alias, groups=list(plan.groups) if plan else [],
        draft_id=f"r-{sim.digits(19)}", message_id=sim.token(16, "0123456789abcdef"), thread_id=sim.token(16, "0123456789abcdef"),
        in_reply_to=in_reply_to, drafted_at=t,
        versions=[DraftVersion(version=1, subject=subject, to=to, cc=cc, body=_body(fields, a, 1, None), created_at=t)],
    )
    esc.emails.append(email)
    esc.updated_at = t
    _alert_email_events(sim, esc, case, t, E.EMAIL_DRAFTED, email, 1, bool(in_reply_to))
    _touch(case, t)
    return email


def add_group(sim: Sim, esc: Escalation, case: Case, email: EmailState, code: str, t: datetime, actor: str) -> bool:
    group = sim.cfg.distribution.group(code)
    if group is None or not sim.ok(t) or email.status not in (EmailStatus.DRAFTED, EmailStatus.REDRAFTED):
        return False
    recipients = list(group.recipients)
    if not recipients:
        return False
    _action(sim, case, t, code, actor, esc)
    if group.name not in email.groups:
        email.groups.append(group.name)
        latest = email.versions[-1]
        latest.cc = latest.cc + [r for r in recipients if r not in latest.cc and r not in latest.to]
    sim.emit(t, E.EMAIL_GROUP_ADDED, escalation_id=esc.escalation_id, case_id=case.case_id, actor=actor, space="clean",
             payload={"group": group.name, "via": "reaction"})
    esc.updated_at = t
    return True


def revise(sim: Sim, esc: Escalation, case: Case, att: Attempt, email: EmailState, t: datetime, actor: str) -> datetime | None:
    instruction = sim.rng.choice(D.REVISION_INSTRUCTIONS)
    if not sim.emit(t, E.EMAIL_REVISION_REQUESTED, escalation_id=esc.escalation_id, case_id=case.case_id, actor=actor, space="clean",
                    payload={"purpose": email.purpose, "instruction": instruction}):
        return None
    email.status, email.revision_requests = EmailStatus.REVISION_REQUESTED, email.revision_requests + 1
    t2 = sim.after(t, 15, 70)
    if not sim.ok(t2):
        return None
    prev = email.versions[-1]
    a = att.result.assessment
    assert a is not None
    email.versions.append(DraftVersion(version=prev.version + 1, subject=prev.subject, to=prev.to, cc=prev.cc,
                                       body=_body(_fields(att), a, prev.version + 1, instruction), instruction=instruction, created_at=t2))
    email.status = EmailStatus.REDRAFTED
    _alert_email_events(sim, esc, case, t2, E.EMAIL_REDRAFTED, email, prev.version + 1, bool(email.in_reply_to))
    esc.updated_at = t2
    return t2


def _sla_event(sim: Sim, case: Case, a: AlertAssessment, t: datetime, met: bool, esc_id: str | None = None, **extra: Any) -> None:
    if case.sla_met is not None:  # SLA is decided once per case (escalation/service.py)
        return
    sim.emit(t, E.SLA_MET if met else E.SLA_MISSED, case_id=case.case_id, escalation_id=esc_id, space="system",
             payload={"track": a.track, "platform_tier": a.platform_tier, "sla_minutes": a.sla_minutes,
                      "due_at": a.sla_due_at.isoformat() if a.sla_due_at else None, **extra})
    case.sla_met = met


def finish_email(sim: Sim, spec: Spec, esc: Escalation, case: Case, att: Attempt, email: EmailState, t_last: datetime, actor: str,
                 outcome: str | None = None) -> datetime | None:
    """Sent / discarded / still open (with an SLA miss once the deadline passes)."""
    a = att.result.assessment
    assert a is not None
    outcome = outcome or spec.force.get("email") or sim.pick([("sent", 0.86), ("discarded", 0.08), ("open", 0.06)])
    strong = a.platform_tier == "strong"
    t_done = t_last + timedelta(minutes=sim.loguniform(1, 9) if strong else sim.loguniform(8, 240))
    if outcome == "sent" and sim.ok(t_done):
        email.status, email.sent_at = EmailStatus.SENT, t_done
        email.rfc822_message_id = f"<CA{sim.token(28)}@mail.test>"
        case.alert_email_message_ids.append(email.rfc822_message_id)
        post_date = datetime.fromisoformat(str(_fields(att).get("post_date")))
        sim.emit(t_done, E.EMAIL_SENT, escalation_id=esc.escalation_id, case_id=case.case_id, actor=actor, space="email",
                 payload={"purpose": "alert", "flag_to_send_s": round((t_done - esc.requested_at).total_seconds()),
                          "post_to_send_s": round((t_done - post_date).total_seconds()), "versions": len(email.versions)})
        if a.sla_due_at:
            _sla_event(sim, case, a, t_done, t_done <= a.sla_due_at, esc.escalation_id, sent_at=t_done.isoformat())
        esc.updated_at = t_done
        _touch(case, t_done)
        return t_done
    if outcome == "discarded" and sim.ok(t_done):
        email.status = EmailStatus.DISCARDED
        sim.emit(t_done, E.EMAIL_DISCARDED, escalation_id=esc.escalation_id, case_id=case.case_id, space="email",
                 payload={"purpose": "alert", "reason": "draft deleted in Gmail"})
        esc.updated_at = t_done
        _touch(case, t_done)
        return t_done
    if a.sla_due_at and sim.ok(a.sla_due_at) and a.sla_due_at > t_last:
        _sla_event(sim, case, a, a.sla_due_at, False, reason="no_email_by_due")
    return None


# ---------------------------------------------------------------------------
# Trust & Safety
# ---------------------------------------------------------------------------


def _tns_category(a: AlertAssessment, cfg) -> str:
    cats = cfg.tns.categories or ["Other"]
    want = ("Child safety" if "Child Safety" in a.sensitive_topics else
            "Harmful hallucination" if a.exposure_tag in cfg.collection.hallucination_tags else
            "Hate / harassment" if "Hate Speech" in a.sensitive_topics else
            "Dangerous content" if "Dangerous" in (a.exposure_tag or "") else "Other")
    return want if want in cats else cats[-1]


def tns_flow(sim: Sim, spec: Spec, esc: Escalation, case: Case, att: Attempt, t: datetime, actor: str) -> None:
    cfg, a = sim.cfg, att.result.assessment
    assert a is not None
    plan = spec.force.get("tns")
    eligible = plan not in ("not_eligible",) and (plan is not None or sim.chance(0.85 if a.ts_recommended else 0.3))
    urgent = eligible and (a.is_kof or (a.engagement_total or 0) >= cfg.collection.high_engagement_threshold or "Child Safety" in a.sensitive_topics)
    criteria = [c for c, ok in (("viral_kof", a.is_kof), ("child_safety", "Child Safety" in a.sensitive_topics),
                                ("gemini_hallucination", "Gemini hallucination" in a.ts_reasons)) if ok] or ["product_abuse"]
    evidence = sim.pick([("input_shown", 0.5), ("replicable", 0.35), ("none", 0.15)]) if eligible else "none"
    payload = {"eligible": eligible, "urgent": urgent, "category": _tns_category(a, cfg), "criteria_ids": criteria, "evidence": evidence}
    t1 = sim.after(t, 20, 60)
    if not sim.emit(t1, E.TNS_ASSESSED, escalation_id=esc.escalation_id, case_id=case.case_id, space="email", payload=payload):
        return
    tns = TnsState(status=TnsStatus.ASSESSED, eligible=eligible, urgent=urgent, category=payload["category"], criteria_ids=criteria,
                   evidence=evidence, rationale="Product abuse with evidence of input" if eligible else "No evidence of input or replicability")  # type: ignore[arg-type]
    esc.tns, esc.updated_at = tns, t1
    if not eligible:
        tns.status = TnsStatus.NOT_ELIGIBLE
        sim.emit(t1, E.TNS_NOT_ELIGIBLE, escalation_id=esc.escalation_id, case_id=case.case_id, space="email", payload=payload)
        return
    ref = cfg.tns.reference_format.format(escalation_id=esc.escalation_id, case_id=case.case_id)
    fields = _fields(att)
    values = {"field:post_url": fields.get("post_url"), "field:product": a.product, "llm": payload["category"]}
    tns.fields = {f.entry_id: str(values.get(f.source) or (f.source[6:] if f.source.startswith("const:") else
                                                          f"{ref} {fields.get('summary', '')}"[: f.max_len or 1500])) for f in cfg.tns.fields}
    tns.prefill_url = f"{cfg.tns.form_url}?usp=pp_url&{urlencode(tns.fields)}"[: cfg.tns.max_url_length]
    tns.status, tns.prepared_at = TnsStatus.PREPARED, t1
    sim.emit(t1, E.TNS_PREPARED, escalation_id=esc.escalation_id, case_id=case.case_id, space="email", payload=payload)
    if urgent:
        _tns_urgent_email(sim, esc, case, att, sim.after(t1, 20, 50), actor)
    if plan == "withdrawn" or (plan is None and sim.chance(0.05)):
        tw = sim.after(t1, 900, 3600)
        if sim.emit(tw, E.TNS_WITHDRAWN, escalation_id=esc.escalation_id, case_id=case.case_id, actor=actor, space="clean", payload={"via": "chat"}):
            tns.status, esc.updated_at = TnsStatus.WITHDRAWN, tw
        return
    if plan is None and not sim.chance(0.82):
        return  # prepared, not submitted yet (open escalation)
    ts = sim.after(t1, 600, 5400)
    via = sim.pick([("intake_email", 0.7), ("chat", 0.2), ("console", 0.1)])
    wd = sim.digits(7)
    if not sim.emit(ts, E.TNS_SUBMITTED, escalation_id=esc.escalation_id, case_id=case.case_id, actor="agent" if via == "intake_email" else actor,
                    space="email" if via == "intake_email" else "clean", payload={"via": via, "wd_issue_id": wd}):
        return
    tns.status, tns.submitted_at, tns.submitted_by, tns.wd_issue_id = TnsStatus.SUBMITTED, ts, actor, wd
    esc.updated_at = ts
    if via == "intake_email":
        sim.enqueue(ts, "clean", f"🤖 ✍️ T&S intake confirmed: Issue {wd} · {case.case_id}", case_id=case.case_id,
                    escalation_id=esc.escalation_id, source="ingest_email")
    outcome = plan if plan in ("Fixed", "Infeasible") else ("Fixed" if sim.chance(0.6) else "Infeasible")
    to = ts + timedelta(hours=sim.loguniform(18, 110))
    bug = sim.digits(9) if outcome == "Fixed" and (plan == "Fixed" or sim.chance(0.85)) else None
    if not sim.emit(to, E.TNS_OUTCOME, escalation_id=esc.escalation_id, case_id=case.case_id, space="email",
                    payload={"outcome": outcome, "bug_id": bug, "wd_issue_id": wd}):
        return
    tns.outcome, tns.outcome_at, tns.bug_id = outcome, to, bug  # type: ignore[assignment]
    esc.updated_at = to
    _touch(case, to)
    if bug:
        _bug_followup(sim, esc, case, att, sim.after(to, 60, 300), bug, force_sent=plan == "Fixed")


def _tns_urgent_email(sim: Sim, esc: Escalation, case: Case, att: Attempt, t: datetime, actor: str) -> None:
    if not sim.ok(t) or esc.analyst_email not in sim.gmail_connected:
        return
    fields = _fields(att)
    subject = f"[Urgent T&S] {fields.get('alert_name')}"
    body = f"Flagging an urgent T&S issue: {fields.get('summary')}\nPost: {fields.get('post_url')}\nWD triage form submitted separately.\n\nBrand Social"
    email = EmailState(purpose="tns_urgent", status=EmailStatus.DRAFTED, from_alias=sim.cfg.escalation.from_header, drafted_at=t,
                       draft_id=f"r-{sim.digits(19)}", versions=[DraftVersion(version=1, subject=subject, to=[sim.cfg.tns.urgent_alias], body=body, created_at=t)])
    esc.emails.append(email)
    _alert_email_events(sim, esc, case, t, E.EMAIL_DRAFTED, email, 1, False)
    t2 = sim.after(t, 300, 1800)
    if sim.chance(0.85) and sim.ok(t2):
        email.status, email.sent_at, email.rfc822_message_id = EmailStatus.SENT, t2, f"<CA{sim.token(28)}@mail.test>"
        sim.emit(t2, E.EMAIL_SENT, escalation_id=esc.escalation_id, case_id=case.case_id, actor=actor, space="email",
                 payload={"purpose": "tns_urgent", "flag_to_send_s": round((t2 - esc.requested_at).total_seconds()), "versions": 1})
    esc.updated_at = max(esc.updated_at, t)


def _bug_followup(sim: Sim, esc: Escalation, case: Case, att: Attempt, t: datetime, bug: str, force_sent: bool = False) -> None:
    if not sim.ok(t):
        return
    alert = esc.email_for("alert")
    subject = f"Re: {alert.versions[-1].subject}" if alert and alert.versions else f"Re: {case.alert_name}"
    body = f"Update: Trust & Safety marked this Fixed. Bug: b/{bug}\n\nBrand Social"
    email = EmailState(purpose="bug_followup", status=EmailStatus.DRAFTED, from_alias=sim.cfg.escalation.from_header, drafted_at=t,
                       draft_id=f"r-{sim.digits(19)}", in_reply_to=alert.rfc822_message_id if alert else None,
                       versions=[DraftVersion(version=1, subject=subject, to=alert.versions[-1].to if alert and alert.versions else [], body=body, created_at=t)])
    esc.emails.append(email)
    _alert_email_events(sim, esc, case, t, E.EMAIL_DRAFTED, email, 1, True)
    sim.enqueue(t, "dm", f"🤖 📨 Bug-ID follow-up drafted in your Gmail: b/{bug} · {esc.escalation_id} · {case.case_id}",
                recipients=[esc.analyst_email], case_id=case.case_id, escalation_id=esc.escalation_id, source="ingest_email")
    t2 = sim.after(t, 600, 14400)
    if (force_sent or sim.chance(0.75)) and sim.ok(t2):
        email.status, email.sent_at = EmailStatus.SENT, t2
        if esc.tns:
            esc.tns.bug_followup_sent_at = t2
        sim.emit(t2, E.EMAIL_SENT, escalation_id=esc.escalation_id, case_id=case.case_id, actor=esc.analyst_email, space="email",
                 payload={"purpose": "bug_followup", "flag_to_send_s": round((t2 - t).total_seconds()), "versions": 1})
    esc.updated_at = max(esc.updated_at, t)


# ---------------------------------------------------------------------------
# Main entry: a case just became VERIFIED
# ---------------------------------------------------------------------------


def verified(sim: Sim, spec: Spec, case: Case, att: Attempt, t_post: datetime, *, via_outbox: bool = False) -> None:
    from . import demo_im  # late import keeps modules small and acyclic at import time

    case.status = CaseStatus.VERIFIED
    a = att.result.assessment
    assert a is not None
    fields = _fields(att)
    if spec.source == "inhouse":
        sim.enqueue(t_post, "clean", f"🤖 [IN-HOUSE] *{fields.get('alert_name')}* · {case.case_id}\n{a.engagement_level} · "
                    f"{int(a.engagement_total or 0):,} engagements · {a.platform}\n*View Post:* {fields.get('post_url')}",
                    case_id=case.case_id, source="ingest_inhouse")
        _touch(case, t_post)
        return
    if not sim.ok(t_post):
        return
    if via_outbox:
        item = sim.enqueue(t_post, "clean", f"🤖 *{fields.get('alert_name')}* · {case.case_id}\n(forwarded after IM review)",
                           case_id=case.case_id, source="review_decision")
        t_post = item.delivered_at if item and item.delivered_at else t_post
    case.clean_posted_at = t_post
    case.clean_message_ref = f"spaces/AAAAcleanDemo/messages/{sim.token(11)}.{sim.token(11)}"
    sim.emit(sim.after(t_post, 1, 3), E.CLEAN_POSTED, case_id=case.case_id, space="clean", payload={"message_id": case.clean_message_ref})
    _touch(case, t_post)
    if a.youtube_protocol != "none":
        sim.emit(t_post, E.PROTOCOL_PINGED, case_id=case.case_id, space="youtube", payload={"protocol": "youtube", "mode": a.youtube_protocol})
    if a.doodle_protocol:
        sim.emit(t_post, E.PROTOCOL_PINGED, case_id=case.case_id, space="doodle", payload={"protocol": "doodle"})
    if a.leadership_protocol:
        recipients = sim.cfg.protocols.leadership.recipients
        sim.emit(t_post, E.PROTOCOL_PINGED, case_id=case.case_id, space="dm", payload={"protocol": "leadership", "recipients": recipients})
        case.leadership_pinged_at = t_post
        sim.leadership_pinged[spec.tpl["key"]] = t_post
    demo_im.im_workflow(sim, spec, case, att, t_post)


def revert_correction(sim: Sim, case: Case, t: datetime, actor: str) -> bool:
    """IM reverts an applied correction (review.py: new attempt, correction marked reverted_by)."""
    latest = case.latest
    if latest is None or not sim.ok(t):
        return False
    applied = [c for c in latest.result.corrections if c.applied and not c.reverted_by]
    if not applied:
        return False
    target = sim.rng.choice([c for c in applied if c.source.value == "llm"] or applied)
    corrections = [c.model_copy(update={"reverted_by": actor}) if c is target else c for c in latest.result.corrections]
    normalized = dict(latest.result.normalized, **{target.field: target.old})
    result = TriageResult.model_validate({**latest.result.model_dump(), "corrections": [c.model_dump() for c in corrections],
                                          "normalized": normalized,
                                          "verdict": Verdict.CORRECTED if any(c.applied and not c.reverted_by for c in corrections) else Verdict.PASS})
    case.attempts.append(Attempt(attempt=len(case.attempts) + 1, message=latest.message, received_at=t, result=result))
    sim.emit(t, E.CORRECTION_REVERTED, case_id=case.case_id, actor=actor, space="console",
             payload={"field": target.field, "old": fmt_value(target.new), "new": fmt_value(target.old), "source": target.source.value})
    sim.enqueue(t, "clean", f"🤖 {case.case_id} updated: {target.field} reverted to \"{fmt_value(target.old)}\" by {actor}",
                case_id=case.case_id, source="revert_correction")
    _touch(case, t)
    return True
