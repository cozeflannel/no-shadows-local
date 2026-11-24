"""Incident reports: one per escalated alert, opened by the minute run or by a person, with a structured list of
everything that happened and the notes people add.

The alerts and what was done to them are made with the real operations; the incident report is read back from the
event log they wrote. The Console routes are the real ones.
"""

from __future__ import annotations

from datetime import timedelta

from a2_fixtures import IM, connect, make_case, reaction
from test_console_api import ADMIN, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_console_api import IM as ANALYST
from triage_agent import incidents, retention
from triage_agent.models import CaseStatus
from triage_agent.operations import handle
from triage_agent.platform_jobs import run_job

FLOW2 = {"flow": "actions", "targets": ["reply", "dm", "crisis"]}
PRODUCT = dict(product="Search", exposure_tag="Product - Product failures - general software/service issues", priority="P1")


def react(ctx, emoji, case):
    done = handle({"op": "record_reaction", "payload": reaction(emoji, case), "context": FLOW2}, ctx)
    assert done.ok, done.error
    return done


def switched_on(ctx):
    ctx.config.platform.flags.incident_reports = True
    return ctx


def test_the_switch_starts_off_and_nothing_is_opened(ctx, clock):
    connect(ctx, clock, IM)
    react(ctx, "📦", make_case(ctx, **PRODUCT))
    got = incidents.sync(ctx)
    assert got == {"ok": True, "off": True, "why": "the switch Incident reports is OFF"} and incidents.between(ctx, clock.now - timedelta(days=1), clock.now) == []


def test_an_escalated_alert_gets_an_incident_report_once_and_a_quiet_one_gets_none(ctx, clock):
    switched_on(ctx)
    connect(ctx, clock, IM)
    quiet, loud = make_case(ctx), make_case(ctx, **PRODUCT)
    clock.advance(minutes=4)
    react(ctx, "👍", quiet)
    react(ctx, "📦", loud)
    clock.advance(minutes=1)
    assert incidents.sync(ctx)["opened"] == 1
    [inc] = incidents.between(ctx, clock.now - timedelta(hours=1), clock.now)
    assert (inc["id"], inc["case_id"], inc["name"], inc["status"], inc["opened_by"]) == (loud.case_id, loud.case_id, loud.issue_name, "open", "agent")
    assert inc["started_at"] == loud.created_at.isoformat() and inc["ended_at"] is None and inc["priority"] == "P1"
    clock.advance(minutes=1)
    assert incidents.sync(ctx)["opened"] == 0 and len(incidents.between(ctx, clock.now - timedelta(hours=1), clock.now)) == 1, "never twice"


def test_an_incident_report_follows_its_alert_until_it_is_closed(ctx, clock):
    switched_on(ctx)
    connect(ctx, clock, IM)
    case = make_case(ctx, **PRODUCT)
    clock.advance(minutes=2)
    react(ctx, "📦", case)
    clock.advance(minutes=1)
    assert incidents.sync(ctx)["opened"] == 1
    clock.advance(minutes=30)
    react(ctx, "❌", case)
    closed_at = clock.now
    clock.advance(minutes=1)
    assert incidents.sync(ctx)["closed"] == 1
    inc = incidents.get(ctx, case.case_id)
    assert (inc["status"], inc["ended_at"], inc["last_at"]) == ("closed", closed_at.isoformat(), closed_at.isoformat())


def test_a_person_opens_one_for_an_alert_that_was_not_escalated_with_the_switch_off(ctx, clock):
    case = make_case(ctx)
    inc = incidents.open_for(ctx, case, by=IM)
    assert (inc["id"], inc["opened_by"], inc["status"]) == (case.case_id, IM, "open")
    assert incidents.open_for(ctx, case, by="someone.else@ops.test")["opened_by"] == IM, "opening it again changes nothing"

    switched_on(ctx)
    connect(ctx, clock, IM)
    react(ctx, "📦", case)  # escalated after a person had opened its report
    clock.advance(minutes=1)
    assert incidents.sync(ctx)["opened"] == 0 and incidents.get(ctx, case.case_id)["opened_by"] == IM, "the person's one is the one"


def test_the_detail_is_a_structured_list_of_everything_that_happened(ctx, clock):
    connect(ctx, clock, IM)
    case = make_case(ctx, **PRODUCT)
    clock.advance(minutes=3)
    react(ctx, "👍", case)
    clock.advance(minutes=2)
    react(ctx, "📦", case)
    clock.advance(minutes=20)
    react(ctx, "❌", case)
    clock.advance(minutes=1)
    incidents.open_for(ctx, case, by=IM)
    incidents.sync_one(ctx, case.case_id)
    detail = incidents.detail(ctx, case.case_id)
    assert detail["facts"] == {"name": case.issue_name, "case_id": case.case_id, "product": "Search", "priority": "P1", "status": "closed",
                               "alert_status": "CLOSED", "started_at": case.created_at.isoformat(), "ended_at": (clock.now - timedelta(minutes=1)).isoformat(),
                               "minutes": 25, "acknowledged_after_minutes": 3}
    titles = [s["title"] for s in detail["sections"]]
    assert titles == ["Arrival and review", "Response", "Escalation", "Outcome"]
    by_title = {s["title"]: [e["what"] for e in s["entries"]] for s in detail["sections"]}
    assert by_title["Arrival and review"] == ["Alert received"]
    assert by_title["Response"][:2] == ["Acknowledged after 3 min", "Marked 👍 Confirming receipt, no action yet taken"]
    assert "Escalation started" in by_title["Escalation"] and "Email drafted" in by_title["Escalation"]
    assert by_title["Outcome"] == ["Closed: no action"]
    assert all(e["at"] and "who" in e for s in detail["sections"] for e in s["entries"])
    assert incidents.detail(ctx, "TRG-0") is None

    late = make_case(ctx, **PRODUCT)
    incidents.open_for(ctx, late, by=IM)
    react(ctx, "👍", late)  # this very moment: it is on the list straight away, not a minute later
    assert "Marked 👍 Confirming receipt, no action yet taken" in [e["what"] for s in incidents.detail(ctx, late.case_id)["sections"] for e in s["entries"]]


def test_a_persons_note_is_kept_as_theirs_and_survives_every_refresh(ctx, clock):
    switched_on(ctx)
    connect(ctx, clock, IM)
    case = make_case(ctx, **PRODUCT)
    react(ctx, "📦", case)
    clock.advance(minutes=1)
    incidents.sync(ctx)
    clock.advance(minutes=5)
    note = incidents.add_note(ctx, case.case_id, "  Legal has been told by phone.  ", by=IM)
    assert (note["by"], note["text"], note["at"]) == (IM, "Legal has been told by phone.", clock.now.isoformat())
    clock.advance(minutes=5)
    react(ctx, "❌", case)
    incidents.sync(ctx)
    assert [n["text"] for n in incidents.detail(ctx, case.case_id)["notes"]] == ["Legal has been told by phone."]
    for bad, why in (("   ", "Write the note first."), ("x" * 4001, "A note is at most 4,000 characters.")):
        try:
            incidents.add_note(ctx, case.case_id, bad, by=IM)
        except ValueError as exc:
            assert str(exc) == why
        else:
            raise AssertionError("taken")


def test_the_calendar_gets_the_incidents_that_touch_its_dates(ctx, clock):
    first = make_case(ctx)
    incidents.open_for(ctx, first, by=IM)
    react(ctx, "❌", first)
    incidents.sync_one(ctx, first.case_id)  # over within the first minute
    clock.advance(days=3)
    second = make_case(ctx)
    incidents.open_for(ctx, second, by=IM)  # still open
    clock.advance(hours=2)
    now = clock.now
    assert [i["id"] for i in incidents.between(ctx, now - timedelta(days=1), now)] == [second.case_id], "one that ended before the dates is left out"
    assert {i["id"] for i in incidents.between(ctx, now - timedelta(days=4), now)} == {first.case_id, second.case_id}
    assert incidents.between(ctx, now + timedelta(hours=1), now + timedelta(days=1))[0]["id"] == second.case_id, "an open one runs on"
    assert incidents.between(ctx, now - timedelta(days=30), now - timedelta(days=20)) == [], "dates before either began show neither"


def test_the_minute_run_opens_and_refreshes_them_and_old_ones_are_removed(ctx, clock):
    switched_on(ctx)
    connect(ctx, clock, IM)
    case = make_case(ctx, **PRODUCT)
    react(ctx, "📦", case)
    clock.advance(minutes=1)
    assert run_job(ctx, "maintenance")["jobs"]["incident_reports"]["opened"] == 1
    react(ctx, "❌", case)
    clock.advance(minutes=1)
    incidents.sync(ctx)
    clock.advance(days=ctx.config.platform.reports.keep_days + 1)
    retention.run(ctx, force=True)
    assert incidents.get(ctx, case.case_id) is None


def test_the_console_lists_opens_shows_and_takes_notes_on_incident_reports(api):
    case = next(c for c in api.ctx.store.list_cases(limit=200) if c.status != CaseStatus.CLOSED)
    assert api.post("/api/incidents", {"case_id": case.case_id}, user=VIEWER).status_code == 403
    made = api.post("/api/incidents", {"case_id": case.case_id}, user=ANALYST)
    assert made.status_code == 200 and made.json()["opened_by"] == ANALYST
    assert api.post("/api/incidents", {"case_id": "TRG-0"}, user=ANALYST).status_code == 404

    now = api.ctx.now()
    cal = api.get("/api/calendar", user=VIEWER, start=(now - timedelta(days=40)).isoformat(), end=(now + timedelta(days=1)).isoformat()).json()
    [event] = [e for e in cal["events"] if e["id"] == case.case_id]
    assert (event["kind"], event["title"], event["open"]) == ("incident", case.issue_name or case.alert_name, True) and event["start"] and event["end"]
    assert cal["incident_reports"] == {"on": False, "why": "the switch Incident reports is OFF"}
    too_long = api.get("/api/calendar", user=VIEWER, start=(now - timedelta(days=400)).isoformat(), end=now.isoformat())
    assert too_long.status_code == 422 and "at most" in too_long.json()["error"]

    assert api.post(f"/api/incidents/{case.case_id}/notes", {"text": "Watching the replies."}, user=VIEWER).status_code == 403
    noted = api.post(f"/api/incidents/{case.case_id}/notes", {"text": "Watching the replies."}, user=ANALYST)
    assert noted.status_code == 200 and noted.json()["by"] == ANALYST
    assert api.post(f"/api/incidents/{case.case_id}/notes", {"text": " "}, user=ANALYST).json()["error"] == "Write the note first."
    detail = api.get(f"/api/incidents/{case.case_id}", user=VIEWER).json()
    assert detail["facts"]["case_id"] == case.case_id and [n["text"] for n in detail["notes"]] == ["Watching the replies."] and detail["sections"]
    assert detail["can_note"] is False and api.get(f"/api/incidents/{case.case_id}", user=ANALYST).json()["can_note"] is True
    assert api.get("/api/incidents/TRG-0", user=VIEWER).status_code == 404
    acts = [e["action"] for e in api.get("/api/audit").json()["entries"]]
    assert "incident.open" in acts and "incident.note" in acts
