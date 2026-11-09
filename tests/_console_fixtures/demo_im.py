"""IM workflow orchestration for a verified alert: acknowledgement, emoji actions, drafts,
T&S, SLA nudges, superseding, updates, reverts and closing (uses demo_lifecycle helpers)."""

from __future__ import annotations

from datetime import datetime, timedelta

from triage_agent.events import EventType as E
from triage_agent.models import Attempt, Case, CaseStatus, Verdict

from . import demo_lifecycle as L
from .demo_sim import Sim, Spec


def _supersede_related(sim: Sim, spec: Spec, case: Case, t_post: datetime, actor: str) -> None:
    """⬇️ on the older post of an ongoing issue: 'addressed on updated post below'."""
    rel = spec.related.case if spec.related else None
    if rel is None or rel.status != CaseStatus.VERIFIED or rel.updated_at >= t_post or rel.source != case.source:
        return
    if not (spec.force.get("supersede") or sim.chance(0.3)):
        return
    t = sim.after(t_post, 120, 1200)
    if not L._action(sim, rel, t, "superseded", actor):
        return
    rel.status, rel.closed_reason, rel.superseded_by = CaseStatus.CLOSED, "superseded", case.case_id
    sim.emit(t, E.CASE_CLOSED, case_id=rel.case_id, actor=actor, space="clean", payload={"reason": "superseded", "superseded_by": case.case_id})


def _sla_nudge(sim: Sim, case: Case, a, t_post: datetime, t_ack: datetime | None) -> None:
    if not a.sla_minutes:
        return
    warn_at = t_post + timedelta(minutes=a.sla_minutes * sim.cfg.thresholds.sla_warn_fraction)
    if (t_ack is not None and t_ack <= warn_at) or not sim.ok(warn_at):
        return
    im = sim.im_at(warn_at)
    sim.emit(warn_at, E.SLA_AT_RISK, case_id=case.case_id, space="dm",
             payload={"track": a.track, "platform_tier": a.platform_tier, "sla_minutes": a.sla_minutes,
                      "due_at": a.sla_due_at.isoformat() if a.sla_due_at else None})
    sim.emit(warn_at, E.ONCALL_NOTIFIED, case_id=case.case_id, space="dm", payload={"kind": "sla_risk", "to_email": im.email, "roster": "slrr_im"})
    pct = round(sim.cfg.thresholds.sla_warn_fraction * 100)
    sim.enqueue(warn_at, "dm", f"🤖 ⏰ {case.case_id} is unacknowledged: {pct}% of its {a.sla_minutes} min SLA has passed.",
                recipients=[im.email], case_id=case.case_id, source="run_followups")


def _update_attempt(sim: Sim, spec: Spec, case: Case, att: Attempt, t: datetime) -> None:
    from .demo_triage import add_attempt, triage_events  # late import: demo_triage imports this module's parent

    a = att.result.assessment
    if case.status != CaseStatus.VERIFIED or a is None or not sim.ok(t):
        return
    old_total = int(a.engagement_total or spec.total)
    new_total = int(old_total * sim.rng.uniform(1.6, 4.0))
    a2 = sim.assess(spec, total=new_total, at=t)
    f2 = dict(att.result.normalized, total_engagement=new_total, engagement_level=a2.engagement_level, alert_name=sim.alert_name(spec, a2))
    att2 = add_attempt(case, t, sim.result(spec, Verdict.PASS, a2, f2), sim.chat_message(spec, t, f2))
    td = triage_events(sim, spec, case, att2)
    sim.emit(td, E.CASE_UPDATED, case_id=case.case_id, space="burson",
             payload={"reason": "new_attempt", "changes": [f"engagement {old_total:,} → {new_total:,}"]})


def im_workflow(sim: Sim, spec: Spec, case: Case, att: Attempt, t_post: datetime) -> None:  # noqa: C901 - one readable story
    cfg, f = sim.cfg, spec.force
    a = att.result.assessment
    assert a is not None
    im = sim.im_at(t_post)
    actor = im.email
    _supersede_related(sim, spec, case, t_post, actor)

    email_alert = a.alert_action == "EMAIL_ALERT"
    esc = email = None
    if email_alert and a.track in cfg.escalation.auto_draft_tracks and im.email in sim.gmail_connected and f.get("esc") in (None, "auto"):
        esc = L.start_escalation(sim, case, sim.after(t_post, 5, 20), "auto_urgent", "agent", im.email)
        if esc:
            email = L.draft_alert(sim, spec, esc, case, att, sim.after(esc.requested_at, 15, 45))

    strong = a.platform_tier == "strong"
    ack = f.get("ack", sim.chance(0.93))
    ack_s = f.get("ack_s") or ((sim.loguniform(30, 300) if sim.chance(0.9) else sim.loguniform(300, 1100)) if strong
                               else sim.loguniform(120, 3600))
    t_ack = t_post + timedelta(seconds=ack_s) if ack else None
    _sla_nudge(sim, case, a, t_post, t_ack)
    if t_ack is None or not sim.ok(t_ack):
        if esc and email:
            L.finish_email(sim, spec, esc, case, att, email, email.versions[-1].created_at, actor, outcome="open")
        return

    want_pa = email_alert and (esc is not None or f.get("esc") in ("reaction", "chat", "console")
                               or (f.get("esc") is None and sim.chance(0.85 if a.track == "URGENT" else 0.72)))
    close = f.get("close")
    if close is None:
        close = "no_action" if not want_pa and not a.ts_recommended and sim.chance(0.55) else None
    t = t_ack
    if want_pa and esc is None:
        trigger = f.get("esc") if f.get("esc") in ("reaction", "chat", "console") else sim.pick([("reaction", 0.88), ("chat", 0.07), ("console", 0.05)])
        L._action(sim, case, t, "pa" if trigger == "reaction" else "ack", actor)
        t_start = t if trigger == "reaction" else sim.after(t, 30, 180)
        esc = L.start_escalation(sim, case, t_start, trigger, actor, actor)
        if esc:
            case.actions[-1].escalation_id = esc.escalation_id if trigger == "reaction" else None
            email = L.draft_alert(sim, spec, esc, case, att, sim.after(t_start, 15, 45))
    elif want_pa:
        L._action(sim, case, t, "pa" if sim.chance(0.4) else "ack", actor, esc)
    elif close == "no_action":
        L._action(sim, case, t, "no_action", actor)
        sim.emit(t, E.CASE_CLOSED, case_id=case.case_id, actor=actor, space="clean", payload={"reason": "no_action"})
        case.status, case.closed_reason = CaseStatus.CLOSED, "no_action"
        return
    else:
        L._action(sim, case, t, "ack", actor)

    t_mail = max(t, email.versions[-1].created_at) if email is not None and email.versions else t
    if email is not None and email.status.value in ("DRAFTED", "REDRAFTED"):
        suggested = [c for c in a.suggested_actions if c in L.GROUP_CODES]
        n = len(f["groups"]) if "groups" in f else (sim.rng.choice([1, 1, 2]) if sim.chance(0.35) else 0)
        codes = list(f.get("groups") or (suggested + [c for c in L.GROUP_CODES if c not in suggested])[: max(n, 0) + 2])
        for code in codes[:n] if "groups" not in f else codes:
            t = sim.after(t, 40, 360)
            L.add_group(sim, esc, case, email, code, t, actor)  # type: ignore[arg-type]
        if f.get("revise") or sim.chance(0.22):
            t = L.revise(sim, esc, case, att, email, sim.after(t, 120, 720), actor) or t  # type: ignore[arg-type]
        t_mail = max(t, email.versions[-1].created_at)

    if f.get("tns") or (a.ts_recommended and sim.chance(0.7)) or sim.chance(0.03):
        t = sim.after(t, 60, 480)
        if esc is None:
            esc = L.start_escalation(sim, case, t, "reaction", actor, actor)
        if esc and L._action(sim, case, t, "tns", actor, esc):
            L.tns_flow(sim, spec, esc, case, att, t, actor)

    if f.get("crisis") or sim.chance(0.06 if a.priority == "P0" and a.track == "URGENT" else 0.01):
        t = sim.after(t, 60, 600)
        if L._action(sim, case, t, "crisis", actor):
            sim.emit(t, E.PROTOCOL_PINGED, case_id=case.case_id, actor=actor, space="crisis", payload={"protocol": "crisis"})
    if f.get("jon") or sim.chance(0.03):
        t = sim.after(t, 60, 600)
        if L._action(sim, case, t, "escalated_jon", actor):
            sim.emit(t, E.PROTOCOL_PINGED, case_id=case.case_id, actor=actor, space="dm", payload={"protocol": "jon"})
    if f.get("other_team") or sim.chance(0.03):
        L._action(sim, case, sim.after(t, 60, 600), "other_team", actor, note="Reported to Legal")
    if f.get("thumbs_down") or sim.chance(0.04):
        t = sim.after(t, 60, 900)
        if L._action(sim, case, t, "agent_wrong", actor):
            note = sim.rng.choice(["Exposure tag should be Product - Other/general criticism", "Not a KOF", "Wrong product: this is AI Mode"])
            sim.emit(t, E.VERDICT_OVERRIDDEN, case_id=case.case_id, actor=actor, space="clean", payload={"emoji": "👎", "note": note})
            case.verdict_overridden_by = actor
    if f.get("revert") or (att.result.applied_corrections and sim.chance(0.08)):
        t = sim.after(t, 120, 1200)
        L.revert_correction(sim, case, t, actor)
        att = case.latest or att

    done = None
    if esc is not None and email is not None and email.status.value in ("DRAFTED", "REDRAFTED"):
        done = L.finish_email(sim, spec, esc, case, att, email, max(t_mail, email.versions[-1].created_at), actor)

    t_update = t_post + timedelta(hours=sim.rng.uniform(1, 8))
    if close is None and done is not None and (f.get("close") == "manual" or sim.chance(0.35)):
        close = "manual"
    t_close = sim.after(done or t, 3600, 8 * 3600)
    if f.get("update") or (spec.source == "burson_chat" and sim.chance(0.06)):
        if close is None or t_update < t_close:
            _update_attempt(sim, spec, case, case.latest or att, t_update)
    if close == "manual" and sim.ok(t_close) and case.status == CaseStatus.VERIFIED:
        who = actor if sim.chance(0.7) else sim.rng.choice(cfg.lead_emails() or [actor])
        sim.emit(t_close, E.CASE_CLOSED, case_id=case.case_id, actor=who, space="console", payload={"reason": "manual", "note": "Actions done"})
        case.status, case.closed_reason = CaseStatus.CLOSED, "Actions done"
        L._touch(case, t_close)
    elif close == "no_action" and case.status == CaseStatus.VERIFIED:
        t_c = sim.after(t, 60, 1200)
        if L._action(sim, case, t_c, "no_action", actor):
            sim.emit(t_c, E.CASE_CLOSED, case_id=case.case_id, actor=actor, space="clean", payload={"reason": "no_action"})
            case.status, case.closed_reason = CaseStatus.CLOSED, "no_action"
