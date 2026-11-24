"""The report engine: what happened in a window of time, alert by alert, each with its own timeline.

The alerts and what was done to them are made with the real operations (a legend emoji, a draft, a close); the report
is read back from the event log those operations wrote. Incident reports and the handover are built on it.
"""

from __future__ import annotations

from datetime import timedelta

from a2_fixtures import IM, connect, make_case, reaction
from triage_agent import reports
from triage_agent.operations import handle

FLOW2 = {"flow": "actions", "targets": ["reply", "dm", "crisis"]}


def react(ctx, emoji, case):
    done = handle({"op": "record_reaction", "payload": reaction(emoji, case), "context": FLOW2}, ctx)
    assert done.ok, done.error
    return done


def test_a_report_lists_each_alert_with_activity_in_the_window_and_its_timeline_in_order(ctx, clock):
    make_case(ctx)  # an alert from before the window that nothing happens to
    clock.advance(hours=5)
    start = clock.now
    case = make_case(ctx, product="Search", priority="P1")
    clock.advance(minutes=3)
    react(ctx, "👍", case)
    clock.advance(minutes=2)
    react(ctx, "❌", case)
    clock.advance(minutes=1)

    report = reports.build(ctx, start, clock.now)
    assert [a["case_id"] for a in report["alerts"]] == [case.case_id], "only alerts something happened to in the window"
    alert = report["alerts"][0]
    assert (alert["product"], alert["priority"], alert["status"], alert["escalated"]) == ("Search", "P1", "CLOSED", False)
    assert alert["name"] == case.issue_name
    assert [(t["what"], t["who"]) for t in alert["timeline"]] == [
        ("Alert received", ""),
        ("Acknowledged after 3 min", IM),
        ("Marked 👍 Confirming receipt, no action yet taken", IM),
        ("Marked ❌ No action taken", IM),
        ("Closed: no action", IM),
    ], "what happened in one moment reads mark first, then what it caused"
    times = [t["at"] for t in alert["timeline"]]
    assert times == sorted(times) and all(t["in_window"] for t in alert["timeline"])
    assert report["totals"] == {"alerts": 1, "acknowledged": 1, "escalated": 0, "emails_sent": 0, "tns_submitted": 0, "closed": 1,
                                "median_ack_minutes": 3.0}
    assert (report["since"], report["until"]) == (start.isoformat(), clock.now.isoformat())


def test_an_alert_with_a_draft_or_a_form_counts_as_escalated_and_can_be_listed_alone(ctx, clock):
    connect(ctx, clock, IM)
    start = clock.now
    quiet = make_case(ctx)
    loud = make_case(ctx, product="Search", exposure_tag="Product - Product failures - general software/service issues", priority="P1")
    clock.advance(minutes=4)
    react(ctx, "👍", quiet)
    react(ctx, "📦", loud)
    clock.advance(minutes=1)

    report = reports.build(ctx, start, clock.now)
    by_id = {a["case_id"]: a for a in report["alerts"]}
    assert by_id[loud.case_id]["escalated"] is True and by_id[quiet.case_id]["escalated"] is False
    assert "Email drafted" in [t["what"] for t in by_id[loud.case_id]["timeline"]]
    assert (report["totals"]["alerts"], report["totals"]["escalated"]) == (2, 1)

    only = reports.build(ctx, start, clock.now, escalated_only=True)
    assert [a["case_id"] for a in only["alerts"]] == [loud.case_id] and only["totals"]["alerts"] == 1 and only["escalated_only"] is True


def test_an_older_alert_acted_on_in_the_window_shows_its_whole_story_with_the_earlier_part_marked(ctx, clock):
    case = make_case(ctx)
    clock.advance(minutes=10)
    react(ctx, "👍", case)
    clock.advance(hours=3)
    start = clock.now
    clock.advance(minutes=5)
    react(ctx, "❌", case)
    clock.advance(minutes=1)

    [alert] = reports.build(ctx, start, clock.now)["alerts"]
    marks = [(t["what"].split(" ")[0], t["in_window"]) for t in alert["timeline"]]
    assert marks == [("Alert", False), ("Acknowledged", False), ("Marked", False), ("Marked", True), ("Closed:", True)]


def test_a_report_longer_than_the_set_number_of_alerts_says_it_was_cut(ctx, clock):
    ctx.config.platform.reports.max_alerts = 1
    start = clock.now
    first, second = make_case(ctx), make_case(ctx)
    clock.advance(minutes=1)
    react(ctx, "👍", first)
    clock.advance(minutes=1)
    react(ctx, "👍", second)
    clock.advance(minutes=1)
    report = reports.build(ctx, start, clock.now)
    assert len(report["alerts"]) == 1 and report["cut"] == {"shown": 1, "of": 2}
    assert report["alerts"][0]["case_id"] == second.case_id, "the latest activity is kept"
    assert report["totals"]["alerts"] == 2, "the totals still count every alert"


def test_the_window_is_a_set_length_or_two_dates_the_right_way_round(ctx, clock):
    now = clock.now
    assert reports.bounds(ctx, "1h") == (now - timedelta(hours=1), now)
    assert reports.bounds(ctx, "4h")[0] == now - timedelta(hours=4) and reports.bounds(ctx, "24h")[0] == now - timedelta(days=1)
    assert reports.bounds(ctx, "7d")[0] == now - timedelta(days=7)
    start, end = now - timedelta(days=2), now - timedelta(days=1)
    assert reports.bounds(ctx, "custom", start.isoformat(), end.isoformat()) == (start, end)
    for bad, why in ((("custom", end.isoformat(), start.isoformat()), "The start must be before the end."),
                     (("custom", "", end.isoformat()), "Give a start and an end."),
                     (("2w",), "Choose the last hour, 4 hours, day or week, or two dates."),
                     (("custom", (now - timedelta(days=ctx.config.platform.reports.max_days + 1)).isoformat(), now.isoformat()),
                      f"A report covers at most {ctx.config.platform.reports.max_days} days.")):
        try:
            reports.bounds(ctx, *bad)
        except ValueError as exc:
            assert str(exc) == why
        else:
            raise AssertionError(f"{bad} was taken")
