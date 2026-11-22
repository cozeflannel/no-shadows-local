"""Triage phase of the demo seed: one Case per Spec, with attempts and decision events
mirroring triage_agent/triage.py, review.py and followups.py payloads."""

from __future__ import annotations

from datetime import datetime, timedelta

from triage_agent.events import EventType as E
from triage_agent.models import (
    Attempt,
    Case,
    CaseStatus,
    ChatMessage,
    Correction,
    Issue,
    IssueSource,
    OnCallNotice,
    ReviewDecision,
    Severity,
    TriageResult,
    Verdict,
)

from . import demo_data as D
from . import demo_lifecycle as L
from .demo_sim import VERDICT_EVENTS, Sim, Spec

CENTRAL_AI_TARGETS = ("Gemini Model", "Gemini App", "DeepMind", "Devs Products", "Brand")


def touch(case: Case, t: datetime) -> None:
    if t > case.updated_at:
        case.updated_at = t


def denormalize(case: Case) -> None:
    latest = case.latest
    if not latest:
        return
    a, f = latest.result.assessment, latest.result.normalized
    case.alert_name = f.get("alert_name") or case.alert_name
    if a:
        case.product, case.exposure_tag, case.priority = a.product, a.exposure_tag, a.priority
        case.track, case.platform, case.issue_name = a.track, a.platform, a.issue_name
        case.issue_fingerprint, case.sla_due_at = a.issue_fingerprint, a.sla_due_at


def add_attempt(case: Case, t: datetime, result: TriageResult, message: ChatMessage) -> Attempt:
    att = Attempt(attempt=len(case.attempts) + 1, message=message, received_at=t, result=result)
    case.attempts.append(att)
    denormalize(case)
    touch(case, t)
    return att


def triage_events(sim: Sim, spec: Spec, case: Case, att: Attempt, *, after_bounce: bool = False,
                  bounced_at: datetime | None = None, oncall_source: str | None = None) -> datetime:
    """alert.received + corrections + verdict event (triage.py payloads). Returns the decision time."""
    r, a, t = att.result, att.result.assessment, att.received_at
    td = t + timedelta(milliseconds=r.latency_ms)
    space = "burson" if spec.source == "burson_chat" else "system"
    post_date = r.normalized.get("post_date")
    detect = (t - datetime.fromisoformat(post_date)).total_seconds() if isinstance(post_date, str) else None
    sim.emit(t, E.ALERT_RECEIVED, case_id=case.case_id, attempt=att.attempt, message_ref=att.message.message_id, space=space,
             payload={"source": spec.source, "record_key": spec.record_key, "sender": att.message.sender.name,
                      "detect_latency_s": round(detect) if detect is not None and detect > 0 else None})
    sim.correction_events(case, att.attempt, td, r.corrections)
    v = r.verdict
    payload: dict = {"first_pass": att.attempt == 1, "confidence": r.confidence, "source": spec.source,
                     "track": a.track if a else None, "priority": a.priority if a else None, "after_bounce": after_bounce}
    if after_bounce and bounced_at and v in (Verdict.PASS, Verdict.CORRECTED):
        payload["time_to_correction_s"] = round((t - bounced_at).total_seconds())
    if v == Verdict.CORRECTED:
        payload["fields"] = [c.field for c in r.applied_corrections]
    if v == Verdict.SUPPRESSED and a:
        payload.update({"reason": a.suppression_reason, "reason_codes": a.reason_codes, "update": False})
    if v == Verdict.NEEDS_REVIEW:
        payload.update({"reasons": r.review_reasons, "im_email": case.current_oncall_email})
    if v == Verdict.FAIL:
        payload.update({"oncall_email": case.current_oncall_email, "oncall_source": oncall_source,
                        "issues": [i.rule for i in r.blocking]})
    sim.emit(td, VERDICT_EVENTS[v], case_id=case.case_id, attempt=att.attempt, verdict=v.value, latency_ms=r.latency_ms,
             model=r.model, prompt_version="assess-v3", space=space,
             error_codes=[f"{i.field}:{i.rule}" if i.field else i.rule for i in r.blocking], payload=payload)
    touch(case, td)
    return td


def build_case(sim: Sim, spec: Spec) -> Case:
    case_id = sim.next_id(sim.cfg.case_id_prefix)
    spec.case_id = case_id
    case = Case(case_id=case_id, record_key=spec.record_key, source=spec.source, source_ref=spec.source_ref,  # type: ignore[arg-type]
                status=CaseStatus.VERIFIED, created_at=spec.received, updated_at=spec.received, env=sim.cfg.env)
    sim.cases[case_id] = case
    spec.case = case
    {"PASS": _verified_first, "CORRECTED": _verified_first, "SUPPRESSED": _suppressed,
     "FAIL": _failed, "NEEDS_REVIEW": _needs_review}[spec.outcome](sim, spec, case)
    return case


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _verified_first(sim: Sim, spec: Spec, case: Case) -> None:
    a = sim.assess(spec)
    fields = sim.fields(spec, a)
    corrections = sim.choose_corrections(spec, a, fields, sim.rng.choice([1, 1, 2, 2, 3])) if spec.outcome == "CORRECTED" else []
    verdict = Verdict.CORRECTED if corrections else Verdict.PASS
    msg = sim.chat_message(spec, spec.received, Sim.burson_fields(fields, corrections))
    att = add_attempt(case, spec.received, sim.result(spec, verdict, a, fields, corrections=corrections), msg)
    td = triage_events(sim, spec, case, att)
    L.verified(sim, spec, case, att, sim.after(td, 3, 14))


def _suppressed(sim: Sim, spec: Spec, case: Case) -> None:
    a = sim.assess(spec)
    fields = sim.fields(spec, a)
    corrections = sim.choose_corrections(spec, a, fields, 1) if sim.chance(0.25) else []
    msg = sim.chat_message(spec, spec.received, Sim.burson_fields(fields, corrections))
    att = add_attempt(case, spec.received, sim.result(spec, Verdict.SUPPRESSED, a, fields, corrections=corrections), msg)
    case.status = CaseStatus.SUPPRESSED
    triage_events(sim, spec, case, att)


def _bounce_and_wait(sim: Sim, spec: Spec, case: Case, td: datetime, *, rerun_fields: dict, a, after_review: bool = False) -> None:
    """Burson on-call notice, reminder chain, then a corrected rerun or abandonment."""
    person, source = sim.burson_at(td)
    roster = sim.rosters["burson"]
    case.status, case.current_oncall_email = CaseStatus.FAILED, person.email
    case.oncall_notices.append(OnCallNotice(kind="bounce", to_email=person.email, at=td))
    sim.emit(td, E.ONCALL_NOTIFIED, case_id=case.case_id, space="burson",
             payload={"kind": "bounce", "to_email": person.email, "roster": "burson", "source": source})
    resolution = spec.fail_resolution or "rerun"
    wait_limit = timedelta(minutes=sim.cfg.thresholds.max_correction_wait_min)
    rerun_delay = spec.force.get("rerun_delay_min") or sim.loguniform(12, 150)
    rerun_at = td + timedelta(minutes=rerun_delay) if resolution == "rerun" else None
    end = rerun_at or td + wait_limit
    policy = roster.reminders
    backup = next((p for p in roster.people if p.id == roster.backup_person_id), None)
    chain = [("reminder", policy.reping_after_min, person.email, "burson"),
             ("backup", policy.backup_after_min, backup.email if backup else person.email, "burson"),
             ("analyst", policy.notify_analyst_after_min, None, "slrr_im")]
    for kind, minutes, to_email, roster_name in chain:
        t = td + timedelta(minutes=minutes)
        if t >= end or not sim.ok(t):
            continue
        to_email = to_email or sim.im_at(t).email
        case.oncall_notices.append(OnCallNotice(kind=kind, to_email=to_email, at=t))  # type: ignore[arg-type]
        sim.emit(t, E.ONCALL_NOTIFIED, case_id=case.case_id, payload={"kind": kind, "to_email": to_email, "roster": roster_name})
        target = "dm" if roster_name == "slrr_im" else "burson"
        text = (f"🤖 {case.case_id} still needs a corrected rerun from Burson ({minutes} min since the bounce)."
                if target == "dm" else f"🤖 Reminder · {case.case_id}: {to_email}, this alert still needs a corrected rerun.")
        sim.enqueue(t, target, text, recipients=[to_email] if target == "dm" else None, case_id=case.case_id, source="run_followups")
        touch(case, t)
    if rerun_at is not None and sim.ok(rerun_at):
        fixed = dict(rerun_fields)
        corrections = sim.choose_corrections(spec, a, fixed, 1) if sim.chance(0.4) else []
        verdict = Verdict.CORRECTED if corrections else Verdict.PASS
        msg = sim.chat_message(spec, rerun_at, Sim.burson_fields(fixed, corrections))
        att = add_attempt(case, rerun_at, sim.result(spec, verdict, a, fixed, corrections=corrections), msg)
        case.current_oncall_email = None
        t2 = triage_events(sim, spec, case, att, after_bounce=True, bounced_at=td)
        L.verified(sim, spec, case, att, sim.after(t2, 3, 14))
    elif rerun_at is None and sim.ok(td + wait_limit):
        t = td + wait_limit + timedelta(seconds=sim.rng.uniform(5, 60))
        if sim.emit(t, E.CASE_ABANDONED, case_id=case.case_id, payload={"reason": "no_rerun", "waited_min": round(wait_limit.total_seconds() / 60)}):
            case.status, case.closed_reason, case.current_oncall_email = CaseStatus.ABANDONED, "no_rerun", None
            touch(case, t)


def _failed(sim: Sim, spec: Spec, case: Case) -> None:
    a = sim.assess(spec)
    fields = sim.fields(spec, a)
    fm = D.FAIL_MODES[spec.fail_mode or "post_content:required"]
    first = dict(fields)
    drop: tuple[str, ...] = ()
    if fm["rule"] == "required" and fm["field"]:
        first.pop(fm["field"], None)
        drop = (fm["field"],)
    elif fm["rule"] == "not_in_future":
        first["post_date"] = (spec.received + timedelta(hours=3)).isoformat()
    issue = Issue(field=fm["field"], rule=fm["rule"], severity=Severity.BLOCKING, found=fm["found"], expected=fm["expected"],
                  fix=fm["fix"], source=IssueSource.PARSER if fm["rule"] == "parse_failed" else IssueSource.RULE)
    msg = sim.chat_message(spec, spec.received, first, drop=drop, truncated=fm["rule"] == "parse_failed")
    att = add_attempt(case, spec.received, sim.result(spec, Verdict.FAIL, a, first, issues=[issue]), msg)
    person, source = sim.burson_at(spec.received)
    case.status, case.current_oncall_email = CaseStatus.FAILED, person.email
    td = triage_events(sim, spec, case, att, oncall_source=source)
    _bounce_and_wait(sim, spec, case, td, rerun_fields=fields, a=a)


def _proposal(sim: Sim, spec: Spec, a) -> tuple[Correction, tuple[str, str], dict]:
    """(proposed correction, (error code, review reason), assess() overrides for the Burson values)."""
    tpl = spec.tpl
    conf = round(sim.rng.uniform(0.58, 0.82), 2)
    if tpl["product"] in CENTRAL_AI_TARGETS and sim.chance(0.35):
        return (Correction(field="product", old="Central AI", new=tpl["product"], confidence=conf, source=IssueSource.LLM, applied=False,
                           reason="Central AI distro removed; Gemini suggests a reclassification"), D.REVIEW_REASONS[3], {"product": "Central AI"})
    if spec.is_kof and sim.chance(0.3):
        return (Correction(field="kof", old=False, new=True, confidence=conf, source=IssueSource.LLM, applied=False,
                           reason="author may be on a P0 KOF list"), D.REVIEW_REASONS[2], {})
    old_tag = tpl["llm_tag"][0] if tpl.get("llm_tag") else sim.rng.choice(
        [t.name for t in sim.cfg.collection.exposure_tags if t.category == sim.tag(tpl["tag"]).category and t.name != tpl["tag"]])
    reason = D.REVIEW_REASONS[1] if sim.tag(old_tag).priority == "P2" and a.priority == "P0" else D.REVIEW_REASONS[0]
    return (Correction(field="exposure_tag", old=old_tag, new=tpl["tag"], confidence=conf, source=IssueSource.LLM, applied=False,
                       reason=f"Gemini suggests {tpl['tag']}"), reason, {"tag_name": old_tag})


def _needs_review(sim: Sim, spec: Spec, case: Case) -> None:
    a_final = sim.assess(spec)
    fields_final = sim.fields(spec, a_final)
    proposed, (code, why), burson_values = _proposal(sim, spec, a_final)
    a1 = sim.assess(spec, **burson_values)
    fields1 = dict(fields_final, **{proposed.field: proposed.old})
    issue = Issue(field=proposed.field, rule=f"llm:{proposed.field}_fit", severity=Severity.BLOCKING, source=IssueSource.LLM,
                  confidence=proposed.confidence, found=str(proposed.old), expected=str(proposed.new), fix=proposed.reason)
    im = sim.im_at(spec.received)
    case.status, case.current_oncall_email = CaseStatus.NEEDS_REVIEW, im.email
    msg = sim.chat_message(spec, spec.received, fields1)
    result = sim.result(spec, Verdict.NEEDS_REVIEW, a1, fields1, corrections=[proposed], issues=[issue], review_reasons=[why])
    att = add_attempt(case, spec.received, result, msg)
    td = triage_events(sim, spec, case, att)
    case.oncall_notices.append(OnCallNotice(kind="analyst", to_email=im.email, at=td))
    sim.emit(td, E.ONCALL_NOTIFIED, case_id=case.case_id, space="dm", payload={"kind": "analyst", "to_email": im.email, "roster": "slrr_im"})
    decision_at = td + timedelta(minutes=spec.decision_delay_min)
    remind_at = td + timedelta(minutes=sim.cfg.thresholds.review_reminder_min)
    if remind_at < decision_at and sim.ok(remind_at):
        sim.emit(remind_at, E.ONCALL_NOTIFIED, case_id=case.case_id, space="dm", payload={"kind": "reminder", "to_email": im.email, "roster": "slrr_im"})
        sim.enqueue(remind_at, "dm", f"🤖 Reminder: {case.case_id} is waiting for your review (forward / bounce / suppress).",
                    recipients=[im.email], case_id=case.case_id, source="run_followups")
        touch(case, remind_at)
    if not sim.ok(decision_at):
        return
    decider = sim.im_at(decision_at).email if sim.chance(0.8) else sim.rng.choice(sim.cfg.lead_emails() or [im.email])
    via = "console" if sim.chance(0.4) else "chat"
    decision = spec.review_decision or "forward"
    reason = {"forward": None if sim.chance(0.6) else "Verified the tag against the post",
              "bounce": "Link is a profile page, not the post", "suppress": "Generic criticism, no specific product issue"}[decision]
    case.review = ReviewDecision(decided_by=decider, decision=decision, reason=reason, at=decision_at)  # type: ignore[arg-type]
    case.current_oncall_email = None
    touch(case, decision_at)
    if decision == "forward":
        accepted = proposed.model_copy(update={"applied": True, "reason": f"{proposed.reason} (accepted by {decider})"})
        overrides = [Correction(field="issue_name", old=fields_final["issue_name"], new=spec.tpl["title"], reason="IM",
                                source=IssueSource.RULE)] if spec.force.get("im_override") else []
        if overrides:
            fields_final = dict(fields_final, issue_name=spec.tpl["title"])
        result2 = sim.result(spec, Verdict.CORRECTED, a_final, fields_final, corrections=[accepted, *overrides])
        att2 = add_attempt(case, decision_at, result2, att.message)
        sim.emit(decision_at, E.REVIEW_FORWARDED, case_id=case.case_id, actor=decider, space="console" if via == "console" else "dm",
                 payload={"reason": reason, "via": via, "overrides": [c.field for c in overrides]})
        L.verified(sim, spec, case, att2, sim.after(decision_at, 2, 10), via_outbox=via == "console")
    elif decision == "bounce":
        sim.emit(decision_at, E.REVIEW_BOUNCED, case_id=case.case_id, actor=decider, space="console" if via == "console" else "dm",
                 payload={"reason": reason, "via": via})
        if via == "console":
            sim.enqueue(decision_at, "burson", f"🤖 *Needs Burson* · {case.case_id}\n{reason}. Re-run the Zap with the fix.",
                        case_id=case.case_id, source="review_decision")
        _bounce_and_wait(sim, spec, case, sim.after(decision_at, 1, 5), rerun_fields=fields_final, a=a_final, after_review=True)
    else:
        sim.emit(decision_at, E.REVIEW_SUPPRESSED, case_id=case.case_id, actor=decider, space="console" if via == "console" else "dm",
                 payload={"reason": reason, "via": via})
        case.status = CaseStatus.SUPPRESSED
