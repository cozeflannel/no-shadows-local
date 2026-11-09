"""Non-case demo data: rosters, config history, proposals/facts, conversation, jobs
(handovers, Burson digests), Watchdog emails, ignored messages and errors."""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime, time, timedelta, timezone

from triage_agent.events import EventType as E
from triage_agent.models import (
    ConfigChangeProposal,
    KnowledgeFact,
    Override,
    Person,
    ProposalStatus,
    ReminderPolicy,
    Roster,
    RotationSlot,
)
from triage_agent.store import escalation_is_open

from . import demo_data as D
from .demo_sim import Sim

ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"]
ADMIN = "admin@ops.test"


def _local(sim: Sim, day: date, hhmm: str) -> datetime:
    hours, minutes = (int(x) for x in hhmm.split(":"))
    return datetime.combine(day, time(hours, minutes), tzinfo=sim.tz).astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Rosters
# ---------------------------------------------------------------------------


def build_rosters(sim: Sim) -> dict[str, Roster]:
    """Demo rosters (@roster.test / @agency.test people). Saved before cases are simulated."""
    today = sim.now.astimezone(sim.tz).date()
    im_people = [
        Person(id="ana", name="Ana Ruiz", email="ana.ruiz@roster.test", org="insight_global"),
        Person(id="ben", name="Ben Okafor", email="ben.okafor@roster.test", org="insight_global"),
        Person(id="chloe", name="Chloe Tan", email="chloe.tan@roster.test", org="insight_global"),
        Person(id="dev", name="Dev Patel", email="dev.patel@roster.test", org="insight_global"),
        Person(id="erin", name="Erin Walsh", email="erin.walsh@roster.test", org="insight_global"),
    ]
    im = Roster(
        people=im_people,
        rotation=[
            RotationSlot(person_id="ana", days=WEEKDAYS, start="06:00", end="12:00"),  # type: ignore[arg-type]
            RotationSlot(person_id="ben", days=WEEKDAYS, start="12:00", end="18:00"),  # type: ignore[arg-type]
            RotationSlot(person_id="erin", days=["sat", "sun"], start="06:00", end="18:00"),  # type: ignore[arg-type]
            RotationSlot(person_id="chloe", days=ALL_DAYS, start="18:00", end="00:00"),  # type: ignore[arg-type]
            RotationSlot(person_id="dev", days=["mon", "tue", "wed", "thu", "fri", "sat"], start="00:00", end="06:00"),  # type: ignore[arg-type]
        ],
        backup_person_id="erin",
        fallback=Person(id="slrr_leads", name="SLRR leads", email="lead@ops.test", org="ops"),
        reminders=ReminderPolicy(reping_after_min=10, backup_after_min=15, notify_analyst_after_min=30, max_reminders=1),
        overrides=[
            Override(override_id="ovr-demo-im-1", person_id="chloe", start=_local(sim, today - timedelta(days=5), "12:00"),
                     end=_local(sim, today - timedelta(days=5), "18:00"), reason="Ben at a training", set_by="ben.okafor@roster.test",
                     set_via="chat", created_at=_local(sim, today - timedelta(days=6), "15:10")),
            Override(override_id="ovr-demo-im-2", person_id="erin", start=_local(sim, today + timedelta(days=1), "06:00"),
                     end=_local(sim, today + timedelta(days=1), "12:00"), reason="Ana out (dentist)", set_by=ADMIN,
                     set_via="console", created_at=sim.now - timedelta(hours=20)),
        ],
    )
    burson = Roster(
        people=[
            Person(id="jdoe", name="Jane Doe", email="burson1@agency.test", org="burson"),
            Person(id="slee", name="Sam Lee", email="burson2@agency.test", org="burson"),
            Person(id="mchen", name="Maya Chen", email="maya.chen@agency.test", org="burson"),
        ],
        rotation=[
            RotationSlot(person_id="jdoe", days=["mon", "tue", "wed"], start="08:00", end="18:00"),  # type: ignore[arg-type]
            RotationSlot(person_id="slee", days=["thu", "fri"], start="08:00", end="18:00"),  # type: ignore[arg-type]
            RotationSlot(person_id="mchen", days=["sat"], start="10:00", end="16:00"),  # type: ignore[arg-type]
        ],
        backup_person_id="slee",
        fallback=Person(id="burson_lead", name="Burson Lead", email="burson-lead@agency.test", org="burson"),
        overrides=[
            Override(override_id="ovr-demo-b-1", person_id="slee", start=_local(sim, today - timedelta(days=3), "08:00"),
                     end=_local(sim, today - timedelta(days=3), "18:00"), reason="Jane out sick", set_by="burson1@agency.test",
                     set_via="chat", created_at=_local(sim, today - timedelta(days=3), "07:40")),
            Override(override_id="ovr-demo-b-2", person_id="mchen", start=_local(sim, today + timedelta(days=2), "08:00"),
                     end=_local(sim, today + timedelta(days=2), "18:00"), reason="Covering Jane (PTO)", set_by="maya.chen@agency.test",
                     set_via="chat", created_at=sim.now - timedelta(hours=7)),
        ],
    )
    sim.rosters = {"slrr_im": im, "burson": burson}
    sim.gmail_connected = {p.email for p in im_people if p.id != "erin"} | set(sim.cfg.analyst_emails())
    return sim.rosters


def roster_events(sim: Sim) -> None:
    t0 = sim.start + timedelta(hours=2)
    for name, roster in sim.rosters.items():
        sim.emit(t0, E.ROSTER_UPDATED, actor=ADMIN, space="console",
                 payload={"roster": name, "via": "console", "people": len(roster.people), "rotation": len(roster.rotation)})
        for o in roster.overrides:
            sim.emit(o.created_at, E.ONCALL_OVERRIDE_SET, actor=o.set_by, space="console" if o.set_via == "console" else "team",
                     payload={"roster": name, "person_id": o.person_id, "start": o.start.isoformat(), "end": o.end.isoformat(),
                              "via": o.set_via, "override_id": o.override_id, "reason": o.reason})


# ---------------------------------------------------------------------------
# Config history + learning
# ---------------------------------------------------------------------------


def config_history(sim: Sim) -> list[tuple[datetime, dict, str, str]]:
    """(saved_at, cumulative overrides, actor, note), oldest first; also emits the matching events."""
    first = sim.start + timedelta(days=2, hours=3)
    approved = next(p for p in D.PROPOSALS if p["status"] == "APPROVED")
    second = sim.now - timedelta(hours=approved["age_h"]) + timedelta(hours=2)
    entries = [
        (first, {"thresholds": {"sla_warn_fraction": 0.5}}, ADMIN, "Nudge IMs earlier on strong-tier alerts"),
        (second, {"thresholds": {"sla_warn_fraction": 0.5}, **approved["patch"]}, ADMIN, f"Approved proposal: {approved['summary']}"),
    ]
    sim.emit(first, E.CONFIG_UPDATED, actor=ADMIN, space="console", payload={"section": "thresholds", "via": "console", "note": entries[0][3]})
    sim.emit(second, E.CONFIG_UPDATED, actor=ADMIN, space="console", payload={"section": "metrics", "via": "proposal", "note": entries[1][3]})
    return entries


def learning(sim: Sim) -> tuple[list[ConfigChangeProposal], list[KnowledgeFact]]:
    proposals, facts = [], []
    for p in D.PROPOSALS:
        created = sim.now - timedelta(hours=p["age_h"])
        decided = created + timedelta(hours=2) if p.get("decided_by") else None
        prop = ConfigChangeProposal(proposal_id=sim.next_id("PROP"), proposed_by=p["by"], via="chat", summary=p["summary"], patch=p["patch"],
                                    status=ProposalStatus(p["status"]), created_at=created, decided_by=p.get("decided_by"), decided_at=decided)
        proposals.append(prop)
        sim.emit(created, E.CONFIG_CHANGE_PROPOSED, actor=p["by"], space="team",
                 payload={"id": prop.proposal_id, "summary": prop.summary, "section": sorted(p["patch"])[0]})
        if decided:
            kind = E.CONFIG_CHANGE_APPROVED if prop.status == ProposalStatus.APPROVED else E.CONFIG_CHANGE_REJECTED
            sim.emit(decided, kind, actor=p["decided_by"], space="console", payload={"id": prop.proposal_id, "summary": prop.summary})
    for f in D.FACTS:
        created = sim.now - timedelta(hours=f["age_h"])
        decided = created + timedelta(hours=3) if f.get("decided_by") else None
        fact = KnowledgeFact(fact_id=sim.next_id("FACT"), text=f["text"], source=f"chat: {f['by']}", status=ProposalStatus(f["status"]),
                             created_by=f["by"], created_at=created, decided_by=f.get("decided_by"), decided_at=decided)
        facts.append(fact)
        sim.emit(created, E.FACT_PROPOSED, actor=f["by"], space="team", payload={"id": fact.fact_id, "text": fact.text})
        if decided:
            kind = E.FACT_APPROVED if fact.status == ProposalStatus.APPROVED else E.FACT_REJECTED
            sim.emit(decided, kind, actor=f["decided_by"], space="console", payload={"id": fact.fact_id, "text": fact.text})
    return proposals, facts


# ---------------------------------------------------------------------------
# Conversation, Watchdog emails, noise
# ---------------------------------------------------------------------------


def _daytime(sim: Sim, day_start: datetime) -> datetime:
    return day_start + timedelta(hours=sim.rng.choice([8, 9, 10, 11, 13, 14, 15, 16, 17, 19, 21, 23, 2]), minutes=sim.rng.uniform(0, 59))


def conversation(sim: Sim) -> None:
    stakeholders = sim.cfg.stakeholders
    burson_people = [p.email for p in sim.rosters["burson"].people]
    for d in range(sim.days):
        day_start = sim.start + timedelta(days=d)
        for _ in range(sim.poisson(7)):
            t = _daytime(sim, day_start)
            space = sim.pick([("clean", 0.4), ("team", 0.25), ("dm", 0.25), ("burson", 0.1)])
            actor = sim.rng.choice(burson_people) if space == "burson" else (
                sim.im_at(t).email if sim.chance(0.7) else sim.rng.choice(sim.cfg.lead_emails() or [sim.im_at(t).email]))
            intent = sim.pick(D.QUESTION_INTENTS)
            grounded = sim.chance(0.85)
            sources = sim.rng.sample(D.QUESTION_SOURCES, k=sim.rng.choice([1, 2, 3])) if grounded else []
            if not sim.emit(t, E.QA_ANSWERED, actor=actor, space=space, payload={"intent": intent, "grounded": grounded, "sources": sources}):
                continue
            if sim.chance(0.45):
                sim.emit(sim.after(t, 30, 600), E.QA_FEEDBACK, actor=actor, space=space, payload={"rating": "up" if sim.chance(0.8) else "down"})
            if stakeholders and sim.chance(0.1):
                s = sim.rng.choice(stakeholders)
                kind = E.ROUTE_FORWARDED if sim.chance(0.6) else E.ROUTE_RELAYED
                sim.emit(sim.after(t, 5, 60), kind, actor=actor, space="stakeholder",
                         payload={"stakeholder_id": s.id, "team": s.team, "mode": s.autonomy})
    # Scripted: one unhelpful answer and one relay in the last day (keeps those KPIs non-trivial).
    t = sim.now - timedelta(hours=26)
    who = sim.im_at(t).email
    sim.emit(t, E.QA_ANSWERED, actor=who, space="clean", payload={"intent": "question", "grounded": False, "sources": []})
    sim.emit(t + timedelta(minutes=3), E.QA_FEEDBACK, actor=who, space="clean", payload={"rating": "down"})
    if stakeholders:
        s = stakeholders[0]
        sim.emit(t + timedelta(minutes=4), E.ROUTE_RELAYED, actor=who, space="stakeholder",
                 payload={"stakeholder_id": s.id, "team": s.team, "mode": s.autonomy})


def watchdog_emails(sim: Sim, alert_times: list[tuple[datetime, str, str]]) -> None:
    """watchdog.received for emails that became alerts (time, subject, link) + some skipped ones."""
    for t, subject, link in alert_times:
        sim.emit(t - timedelta(seconds=40), E.WATCHDOG_RECEIVED, space="email", payload={"subject": subject, "links": [link]})
    for i, (label, reason) in enumerate(D.WATCHDOG_SKIPS):
        t = sim.start + timedelta(days=2 + i * 4, hours=sim.rng.uniform(9, 17))
        subject = f"Watchdog Anti-Abuse Alert: {label} · Gemini App"
        link = f"https://x.com/{sim.rng.choice(D.HANDLES['X'])}/status/18{sim.digits(17)}"
        sim.emit(t, E.WATCHDOG_RECEIVED, space="email", payload={"subject": subject, "links": [link]})
        sim.emit(sim.after(t, 1, 5), E.WATCHDOG_SKIPPED, space="email", payload={"subject": subject, "reason": reason, "links": [link]})


def noise(sim: Sim) -> None:
    for d in range(sim.days):
        day_start = sim.start + timedelta(days=d)
        for _ in range(sim.poisson(3)):
            t = day_start + timedelta(minutes=sim.rng.uniform(0, 1439))
            reason = sim.pick([("own_message", 0.4), ("not_alert", 0.35), ("duplicate", 0.15), ("wrong_space", 0.1)])
            sim.emit(t, E.MESSAGE_IGNORED, space=None if reason == "wrong_space" else "burson", message_ref=f"spaces/x/messages/{sim.token(10)}",
                     payload={"reason": reason, **({"space": "team"} if reason == "wrong_space" else {})})
    for i, err in enumerate(D.ERRORS):
        t = sim.start + timedelta(days=(i + 0.5) * sim.days / len(D.ERRORS), minutes=sim.rng.uniform(0, 600))
        sim.emit(t, E.ERROR, space="system", payload=dict(err))
    # A stale item (doorbell failed) and a fresh one still waiting for the Outbox flow.
    sim.enqueue(sim.now - timedelta(minutes=22), "team", "🤖 Heads-up: Burson digest delayed (Sheets doorbell failed); re-ringing.",
                source="run_followups", delay_s=10**7)
    sim.enqueue(sim.now - timedelta(seconds=40), "dm", "🤖 Reminder: an alert is waiting for your review in the Agent Console.",
                recipients=[sim.im_at(sim.now - timedelta(minutes=1)).email], source="run_followups", delay_s=10**7)


# ---------------------------------------------------------------------------
# Jobs (run after cases so counts are real)
# ---------------------------------------------------------------------------


def jobs(sim: Sim) -> None:
    cfg = sim.cfg
    first_day = sim.start.astimezone(sim.tz).date()
    last_day = sim.now.astimezone(sim.tz).date()
    by_type: dict[str, list[datetime]] = {}
    for e in sim.events:
        by_type.setdefault(e.event_type, []).append(e.event_ts)

    def count(kind: str, lo: datetime, hi: datetime) -> int:
        return sum(1 for t in by_type.get(kind, []) if lo <= t < hi)

    day = first_day
    while day <= last_day:
        for shift in cfg.shifts:
            start = _local(sim, day, shift.start)
            end = _local(sim, day + timedelta(days=1) if shift.end <= shift.start else day, shift.end)
            t = end + timedelta(minutes=cfg.handover.minutes_after_shift_end)
            if start < sim.start or not sim.ok(t):
                continue
            counts = {k: count(v, start, end) for k, v in (("alerts", E.ALERT_RECEIVED), ("passed", E.TRIAGE_PASSED), ("corrected", E.TRIAGE_CORRECTED),
                                                           ("suppressed", E.TRIAGE_SUPPRESSED), ("bounced", E.TRIAGE_FAILED),
                                                           ("held", E.TRIAGE_NEEDS_REVIEW), ("sla_missed", E.SLA_MISSED))}
            open_escs = sum(1 for esc in sim.escalations.values() if esc.requested_at < end and escalation_is_open(esc))
            sim.emit(t, E.HANDOVER_POSTED, space="team", payload={"shift": shift.name, "start": start.isoformat(), "end": end.isoformat(),
                                                                  **counts, "open_escalations": open_escs})
            text = (f"🤖 *Shift handover · {shift.name}* ({start.astimezone(sim.tz):%b %d %I:%M %p}–{end.astimezone(sim.tz):%I:%M %p} ET)\n"
                    f"- Alerts: {counts['alerts']} ({counts['passed'] + counts['corrected']} verified, {counts['suppressed']} suppressed, "
                    f"{counts['bounced']} bounced, {counts['held']} held)\n- SLA misses: {counts['sla_missed']}\n- Open escalations: {open_escs}")
            if cfg.handover.post_to_team:
                sim.enqueue(t, "team", text, source="run_followups")
            if cfg.handover.append_to_doc:
                sim.enqueue(t, "handover", text, source="run_followups")
        digest_at = _local(sim, day, f"{cfg.burson_feedback.digest_hour_local:02d}:00")
        if digest_at > sim.start + timedelta(days=1) and sim.ok(digest_at):
            fields = Counter(str(e.payload.get("field")) for e in sim.events
                             if e.event_type == E.CORRECTION_APPLIED and digest_at - timedelta(days=1) <= e.event_ts < digest_at)
            cases = len({e.case_id for e in sim.events if e.event_type == E.CORRECTION_APPLIED and digest_at - timedelta(days=1) <= e.event_ts < digest_at})
            n = sum(fields.values())
            sim.emit(digest_at, E.BURSON_DIGEST_POSTED, space="burson", payload={"corrections": n, "fields": dict(fields), "cases": cases, "mode": "digest"})
            top = ", ".join(f"{k} ×{v}" for k, v in fields.most_common(4)) or "none"
            sim.enqueue(digest_at, "burson", f"🤖 *Daily QA digest for Burson* · {n} corrections on {cases} alerts yesterday: {top}", source="run_followups")
        day += timedelta(days=1)
