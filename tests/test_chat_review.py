"""Alerts reviewed through the QA chatbot's own Chat sign-in, with no Chat flow in between.

Every minute the bot's account reads the source space on the Routing page and hands each new message to the same review
a Chat flow would hand it to. Google Chat is the in-memory stand-in from the Routing tests (no network); the review,
the settings, the write guard and the Console routes are the real ones, and Gemini's part of the review is scripted.
"""

from __future__ import annotations

from typing import Any

import pytest

from conftest import GOOD_ALERT
from test_console_api import ADMIN, IM, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_platform import alert, assess_ok
from test_routing import MIR, PAT, SRC, ZAP, route, world  # noqa: F401 - fixtures
from triage_agent import chatreview
from triage_agent.platform_jobs import run_job


@pytest.fixture
def on(api, world):
    """The QA chatbot ON, reading SRC, with the review switch ON and Gemini's review scripted."""
    assess_ok(api.ctx.llm)
    route(api, bot_on=True, source=SRC)
    api.ctx.config.platform.flags.chat_review = True
    return api


def tick(api, world) -> dict[str, Any]:
    world.clock.advance(minutes=1)
    return chatreview.run(api.ctx)


def cases(api) -> list[Any]:
    return [c for c in api.ctx.store.list_cases(limit=500) if any(a.message.space_id == SRC for a in c.attempts)]


def test_the_switch_starts_off_and_nothing_is_read(api, world):
    assert api.ctx.config.platform.flags.chat_review is False
    route(api, bot_on=True, source=SRC)
    world.say(SRC, GOOD_ALERT)
    assert tick(api, world) == {"ok": True, "off": True, "why": "the switch Review alerts read from Chat is OFF"}
    api.ctx.config.platform.flags.chat_review = True
    route(api, bot_on=False, source=SRC)
    assert tick(api, world)["why"] == "the QA chatbot is OFF", "with the QA chatbot OFF nothing in Chat is read"
    assert cases(api) == []


def test_a_new_alert_in_the_source_space_is_reviewed_once_as_a_flow_would_hand_it_over(on, world):
    name = world.say(SRC, GOOD_ALERT + "\nZap sent by @Someone")
    got = tick(on, world)
    assert got["ok"] and got["reviewed"] == 1 and got["ignored"] == 0 and got["failed"] == 0
    [case] = cases(on)
    message = case.attempts[0].message
    assert message.message_id == name and message.space_id == SRC and message.sender.name == "Zapier"
    assert "Zap sent by" not in message.text and message.text.startswith("🚨 Burson Automated Alert"), "Zapier's credit line is not part of the alert"
    assert message.create_time is not None and case.source == "burson_chat"
    assert tick(on, world)["reviewed"] == 0 and len(cases(on)) == 1, "never twice"
    rows = on.get("/api/routing", user=IM).json()["review"]["rows"]
    assert [(r["status"], r["case_id"], r["verdict"]) for r in rows] == [("reviewed", case.case_id, case.latest.result.verdict.value)]
    assert rows[0]["text"].startswith("🚨 Burson Automated Alert") and rows[0]["message"] == name
    audit = on.get("/api/audit", action="chat.review").json()["entries"]
    assert len(audit) == 1 and audit[0]["case_id"] == case.case_id and audit[0]["actor"] == "agent"


def test_reading_starts_a_few_minutes_back_and_a_new_source_space_starts_again(on, world):
    world.say(SRC, alert(1))
    world.clock.advance(minutes=40)
    world.say(SRC, alert(2))
    assert tick(on, world)["reviewed"] == 1, "an alert from before the last 15 minutes is not gone back for"
    world.say(MIR, alert(3))
    route(on, bot_on=True, source=MIR)
    assert tick(on, world)["reviewed"] == 1 and len(on.ctx.store.list_cases(limit=500)) >= 2, "the new source is read from its own start"


def test_peoples_messages_and_the_bots_own_posts_are_not_alerts(on, world):
    world.say(SRC, "Morning all, anything new on Gemini?", sender=PAT)
    world.say(SRC, GOOD_ALERT, sender={"name": "users/bot", "type": "HUMAN"}, clientAssignedMessageId="client-bqa-0123456789")
    got = tick(on, world)
    assert (got["reviewed"], got["ignored"]) == (0, 1) and cases(on) == [], "a person's message is looked at and set aside; the bot's own post is never read"
    [row] = on.get("/api/routing").json()["review"]["rows"]
    assert row["status"] == "ignored" and row["summary"] == "not an alert" and row["case_id"] == ""


def test_a_message_that_fails_is_tried_again_and_given_up_after_the_set_tries_without_holding_the_rest(on, world, monkeypatch):
    from triage_agent import operations

    real = operations.handle

    def flaky(request, ctx=None):
        if "18451234567890000" + "07" in str(request):
            return operations.OperationResponse(ok=False, op="triage_message", outputs={}, error="Gemini could not be reached", retryable=True)
        return real(request, ctx)

    monkeypatch.setattr(chatreview, "handle", flaky)
    world.say(SRC, alert(7))
    world.clock.advance(seconds=5)
    world.say(SRC, alert(8))
    first = tick(on, world)
    assert (first["reviewed"], first["failed"]) == (1, 1), "the alert behind a failing one is still reviewed"
    for _ in range(on.ctx.config.platform.routing.max_tries - 1):
        got = tick(on, world)
    rows = {r["status"]: r for r in on.get("/api/routing").json()["review"]["rows"]}
    assert set(rows) == {"reviewed", "gave_up"} and rows["gave_up"]["why"] == "Gemini could not be reached"
    assert rows["gave_up"]["tries"] == on.ctx.config.platform.routing.max_tries and got["failed"] == 1
    assert tick(on, world)["failed"] == 0, "given up: not tried again"


def test_what_the_review_wants_posted_is_queued_and_nothing_is_written_in_chat(on, world):
    before = {i.outbox_id for i in on.ctx.store.list_outbox(undelivered_only=True, limit=500)}
    world.say(SRC, GOOD_ALERT)
    tick(on, world)
    assert world.writes == [], "reading posts nothing: the posts wait in the outbox"
    queued = [i for i in on.ctx.store.list_outbox(undelivered_only=True, limit=500) if i.outbox_id not in before]
    assert queued and all(i.source == "triage_message" for i in queued)
    [row] = on.get("/api/routing").json()["review"]["rows"]
    assert row["queued"] == len(queued)


def test_the_review_runs_in_the_once_a_minute_tick_and_the_page_says_what_ran_last(on, world):
    world.say(SRC, GOOD_ALERT)
    world.clock.advance(minutes=1)
    jobs = run_job(on.ctx, "maintenance")["jobs"]
    assert jobs["chat_review"]["ok"] and jobs["chat_review"]["reviewed"] == 1
    page = on.get("/api/routing", user=VIEWER).json()["review"]
    assert page["on"] is True and page["last_run"]["reviewed"] == 1 and page["last_run"]["at"]


def test_chat_being_unreachable_is_reported_and_the_next_minute_tries_again(on, world):
    world.say(SRC, GOOD_ALERT)
    real = world.request
    world.request = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("Chat could not be reached"))
    got = tick(on, world)
    assert got["ok"] is False and "Chat could not be reached" in got["error"] and cases(on) == []
    world.request = real
    assert tick(on, world)["reviewed"] == 1, "the alert is still there the next minute"
