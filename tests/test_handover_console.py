"""The handover in the Console: one record per shift, made when the shift ends or when a person asks, shown on
Workforce and its calendar, posted to the team space, with the notes people add.

The shift's alerts are made with the real operations and the handover runs through the real scheduled job. The Console
routes are the real ones.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from a2_fixtures import IM, connect, make_case, reaction
from test_console_api import ADMIN, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_console_api import IM as ANALYST
from test_jobs import outbox, run
from triage_agent import handovers, incidents, retention
from triage_agent.operations import handle

FLOW2 = {"flow": "actions", "targets": ["reply", "dm", "crisis"]}
PRODUCT = dict(product="Search", exposure_tag="Product - Product failures - general software/service issues", priority="P1")
LATE_START = datetime(2026, 10, 12, 16, 0, tzinfo=timezone.utc)   # AMER late: 12:00 to 18:00 Eastern
LATE_END = datetime(2026, 10, 12, 22, 0, tzinfo=timezone.utc)


def react(ctx, emoji, case):
    done = handle({"op": "record_reaction", "payload": reaction(emoji, case), "context": FLOW2}, ctx)
    assert done.ok, done.error


def a_shift(ctx, clock):
    """Two alerts in AMER late, one of them escalated with an incident report; then ten minutes past the shift's end."""
    connect(ctx, clock, IM)
    clock.now = LATE_START + timedelta(hours=1)
    quiet = make_case(ctx)
    loud = make_case(ctx, **PRODUCT)
    clock.advance(minutes=5)
    react(ctx, "👍", quiet)
    react(ctx, "📦", loud)
    incidents.open_for(ctx, loud, by=IM)
    clock.now = LATE_END + timedelta(minutes=10)
    return quiet, loud


def test_the_shifts_end_makes_one_handover_record_and_posts_it_to_the_team_space_once(ctx, clock):
    quiet, loud = a_shift(ctx, clock)
    run(ctx, "handover")
    [h] = handovers.between(ctx, LATE_START, LATE_END + timedelta(hours=1))
    assert (h["shift"], h["made_by"]) == ("AMER late", "agent")
    assert (datetime.fromisoformat(h["start"]), datetime.fromisoformat(h["end"])) == (LATE_START, LATE_END), "the shift's own hours"
    [post] = outbox(ctx, "team")
    assert "Shift handover: AMER late" in post.text and handovers.get(ctx, h["id"])["text"] == post.text, "the record holds what was posted"
    assert outbox(ctx, "handover") == [], "the Google Doc is no longer written"
    run(ctx, "handover")
    assert len(outbox(ctx, "team")) == 1 and len(handovers.between(ctx, LATE_START, LATE_END + timedelta(hours=1))) == 1, "never twice"
    assert handovers.between(ctx, LATE_END + timedelta(hours=2), LATE_END + timedelta(hours=3)) == [], "only on the dates its shift touches"


def test_a_handover_holds_the_shifts_numbers_its_incident_reports_and_what_is_left_open(ctx, clock):
    quiet, loud = a_shift(ctx, clock)
    run(ctx, "handover")
    h = handovers.detail(ctx, handovers.between(ctx, LATE_START, LATE_END + timedelta(hours=1))[0]["id"])
    assert h["numbers"]["alerts"] == 2 and h["numbers"]["acknowledged"] == 2 and h["numbers"]["escalated"] == 1
    assert [(i["id"], i["name"], i["status"]) for i in h["incidents"]] == [(loud.case_id, loud.issue_name, "open")]
    assert {a["case_id"] for a in h["alerts"]} == {quiet.case_id, loud.case_id} and all(a["timeline"] for a in h["alerts"])
    assert h["notes"] == [] and h["text"].startswith("🤖 *Shift handover: AMER late*")


def test_a_person_asks_for_a_handover_now_and_adds_a_note_that_is_kept(ctx, clock):
    a_shift(ctx, clock)
    made = handovers.make_now(ctx, by=IM)
    assert made["made_by"] == IM and made["shift"] == "AMER late" and len(outbox(ctx, "team")) == 1
    again = handovers.make_now(ctx, by="lead@ops.test")
    assert again["id"] == made["id"] and again["made_by"] == IM and len(outbox(ctx, "team")) == 1, "the same shift is not handed over twice"
    run(ctx, "handover")
    assert len(outbox(ctx, "team")) == 1, "the scheduled run finds it done"

    note = handovers.add_note(ctx, made["id"], "Watch the Search outage thread overnight.", by=IM)
    assert (note["by"], note["text"]) == (IM, "Watch the Search outage thread overnight.")
    assert [n["text"] for n in handovers.detail(ctx, made["id"])["notes"]] == ["Watch the Search outage thread overnight."]
    kept = handovers.record(ctx, "AMER late", LATE_START, LATE_END, "another text")  # recorded again for the same shift
    assert (kept["made_by"], kept["text"]) == (IM, made["text"]) and len(kept["notes"]) == 1, "the first record and its notes stand"
    try:
        handovers.add_note(ctx, made["id"], " ", by=IM)
    except ValueError as exc:
        assert str(exc) == "Write the note first."
    else:
        raise AssertionError("taken")


def test_old_handovers_are_removed_after_the_set_days(ctx, clock):
    a_shift(ctx, clock)
    run(ctx, "handover")
    clock.advance(days=ctx.config.platform.reports.keep_days + 1)
    retention.run(ctx, force=True)
    assert handovers.between(ctx, LATE_START - timedelta(days=1), clock.now) == []


def test_the_console_lists_makes_shows_and_takes_notes_on_handovers_and_the_calendar_shows_them(api):
    assert api.post("/api/handovers", {}, user=VIEWER).status_code == 403
    made = api.post("/api/handovers", {}, user=ANALYST)
    assert made.status_code == 200, made.text
    h = made.json()
    assert h["made_by"] == ANALYST and h["shift"] and h["start"] < h["end"]

    listed = api.get("/api/handovers", user=VIEWER).json()
    assert [x["id"] for x in listed["handovers"]] == [h["id"]] and listed["can_make"] is False and "text" not in listed["handovers"][0]
    detail = api.get(f"/api/handovers/{h['id']}", user=VIEWER).json()
    assert detail["text"] and "numbers" in detail and detail["can_note"] is False
    assert api.get("/api/handovers/nope", user=VIEWER).status_code == 404
    assert api.post(f"/api/handovers/{h['id']}/notes", {"text": "Nothing urgent."}, user=VIEWER).status_code == 403
    assert api.post(f"/api/handovers/{h['id']}/notes", {"text": "Nothing urgent."}, user=ANALYST).json()["by"] == ANALYST

    start, end = datetime.fromisoformat(h["start"]) - timedelta(days=1), datetime.fromisoformat(h["end"]) + timedelta(days=1)
    events = api.get("/api/calendar", user=VIEWER, start=start.isoformat(), end=end.isoformat()).json()["events"]
    [event] = [e for e in events if e["kind"] == "handover"]
    assert (event["id"], event["title"], event["start"], event["end"]) == (h["id"], f"Handover: {h['shift']}", h["start"], h["end"])
    acts = [e["action"] for e in api.get("/api/audit").json()["entries"]]
    assert "handover.make" in acts and "handover.note" in acts
