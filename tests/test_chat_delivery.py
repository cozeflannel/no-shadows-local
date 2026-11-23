"""Queued posts delivered through the QA chatbot's own Chat sign-in, with no Chat flow in between.

Every minute, with the switch ON, each queued post is posted once in its space, or to each person's direct message, as
the bot's account. Google Chat is the in-memory stand-in from the Routing tests (no network); the queue, the routing
rules, the leak guard, the settings and the Console routes are the real ones.
"""

from __future__ import annotations

from typing import Any

import pytest

from conftest import GOOD_ALERT
from test_console_api import ADMIN, IM, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_platform import assess_ok
from test_routing import SRC, route, world  # noqa: F401 - fixtures
from triage_agent import chatapi, chatdelivery, mirror, outbox, safety
from triage_agent.platform_jobs import run_job

IM1, IM2 = "im1@ops.test", "im2@ops.test"


def space_of(api, target: str) -> str:
    ref = api.ctx.config.space(target)
    return chatapi.space_name(ref.space_id, ref.url)


def switches(api, **flags: bool) -> None:
    value = {**api.ctx.config.platform.flags.model_dump(mode="json"), **flags}
    assert api.put("/api/platform/flags", {"value": value, "note": "test"}).status_code == 200


def waiting(api) -> list[Any]:
    return api.ctx.store.list_outbox(undelivered_only=True, limit=1000)


@pytest.fixture
def on(api, world):
    """The QA chatbot ON with the delivery switch ON, the agent's own spaces open to it, and nothing left queued."""
    api.ctx.store.mark_outbox_delivered([i.outbox_id for i in waiting(api)], "before the test")
    world.add_space(space_of(api, "clean"), "SLRR Triaged Alerts")
    world.add_space(space_of(api, "team"), "24/7 SL Team")
    world.add_space(space_of(api, "burson"), "[S-F] Burson Automated Alerts V3", external=True)
    route(api, bot_on=True)
    switches(api, chat_delivery=True)
    return api


def tick(api, world) -> dict[str, Any]:
    world.clock.advance(minutes=1)
    return chatdelivery.run(api.ctx)


def rows(api) -> list[dict[str, Any]]:
    return api.get("/api/routing", user=IM).json()["delivery"]["rows"]


def test_the_switch_starts_off_and_a_queued_post_rings_for_a_flow_as_before(api, world):
    assert api.ctx.config.platform.flags.chat_delivery is False
    world.add_space(space_of(api, "clean"), "SLRR Triaged Alerts")
    item = api.ctx.enqueue("clean", "A note for the analysts")
    assert api.ctx.doorbell.rings == [item.outbox_id]
    assert tick(api, world) == {"ok": True, "off": True, "why": "the switch Post queued messages in Chat is OFF"}
    switches(api, chat_delivery=True)
    assert tick(api, world)["why"] == "the QA chatbot is OFF", "with the QA chatbot OFF nothing is written in Chat"
    assert world.writes == [] and item.outbox_id in {i.outbox_id for i in waiting(api)}


def test_a_queued_post_is_posted_once_in_its_space_as_the_qa_chatbot(on, world):
    clean = space_of(on, "clean")
    item = on.ctx.enqueue("clean", "A note for the analysts")
    assert on.ctx.doorbell.rings == [], "no flow is rung: the minute run posts it"
    got = tick(on, world)
    assert got == {"ok": True, "off": False, "sent": 1, "held": 0, "failed": 0, "error": ""}
    assert world.texts(clean) == ["A note for the analysts"] and world.messages[clean][0]["clientAssignedMessageId"].startswith("client-bqa-")
    assert waiting(on) == [] and on.ctx.store.list_outbox(undelivered_only=False, limit=1000)[-1].delivered_by == "chat_delivery"
    assert tick(on, world)["sent"] == 0 and len(world.writes) == 1, "never twice"
    [row] = rows(on)
    assert (row["status"], row["target"], row["text"], row["message"]) == ("sent", "clean", "A note for the analysts", world.messages[clean][0]["name"])
    entry = on.get("/api/audit", action="chat.post").json()["entries"][0]
    assert entry["actor"] == "agent" and entry["target_id"] == world.messages[clean][0]["name"] and item.outbox_id in str(entry["detail"])


def test_posts_queued_before_the_switch_was_turned_on_are_not_sent_late(api, world):
    world.add_space(space_of(api, "clean"), "SLRR Triaged Alerts")
    api.ctx.store.mark_outbox_delivered([i.outbox_id for i in waiting(api)], "before the test")
    old = api.ctx.enqueue("clean", "Queued an hour ago, when nothing delivered it")
    world.clock.advance(minutes=60)
    recent = api.ctx.enqueue("clean", "Queued five minutes ago")
    world.clock.advance(minutes=5)
    route(api, bot_on=True)
    switches(api, chat_delivery=True)
    assert tick(api, world)["sent"] == 1
    assert world.texts(space_of(api, "clean")) == ["Queued five minutes ago"], "only what was queued in the last few minutes, as the copy starts"
    assert [i.outbox_id for i in waiting(api)] == [old.outbox_id] and recent.outbox_id not in {i.outbox_id for i in waiting(api)}


def test_the_first_clean_post_of_a_case_is_tied_to_the_case_so_emojis_find_it(on, world):
    case = next(c for c in on.ctx.store.list_cases(limit=50) if c.clean_message_ref is None)
    case.clean_posted_at = None
    on.ctx.store.save_case(case)
    on.ctx.enqueue("clean", f"[{case.case_id}] Verified alert", case_id=case.case_id)
    world.clock.advance(seconds=5)
    on.ctx.enqueue("clean", f"[{case.case_id}] A later note", case_id=case.case_id)
    assert tick(on, world)["sent"] == 2
    first = world.messages[space_of(on, "clean")][0]["name"]
    kept = on.ctx.store.get_case(case.case_id)
    assert kept.clean_message_ref == first and kept.clean_posted_at is not None, "the alert's own post, not the note after it"


def test_a_post_for_the_source_space_is_written_only_while_the_source_is_open(on, world):
    burson = space_of(on, "burson")
    route(on, bot_on=True, source=burson)
    assert on.ctx.config.platform.safety.testing is True
    held = on.ctx.enqueue("burson", "Please update the link on this alert and resend it. Thank you.")
    got = tick(on, world)
    assert (got["sent"], got["held"]) == (0, 1) and world.writes == [] and waiting(on) == [], "held means not posted, now or later"
    [row] = rows(on)
    assert row["status"] == "held" and row["why"] == "Nothing is written in the source space: the Safety valve is ON."
    blocked = on.get("/api/audit", action="safety.block").json()["entries"][0]
    assert blocked["target_id"] == "burson" and held.outbox_id in str(blocked["detail"])

    route(on, safety_valve=False)
    on.ctx.enqueue("burson", "Please update the link on this alert and resend it. Thank you.")
    world.clock.advance(seconds=5)
    on.ctx.enqueue("burson", "We will forward this to the analyst space; the bot auto-corrected it.")
    got = tick(on, world)
    assert (got["sent"], got["held"]) == (1, 1)
    assert world.texts(burson) == ["Please update the link on this alert and resend it. Thank you."]
    assert world.messages[burson][0]["clientAssignedMessageId"].startswith("client-zrlo-"), "marked as the bot's own post in the source space"
    leak = next(r for r in rows(on) if r["text"].startswith("We will forward"))
    assert leak["status"] == "held" and leak["why"].startswith("It names something internal: ")


def test_with_send_first_on_a_source_post_waits_on_the_routing_page_for_a_person(on, world):
    route(on, bot_on=True, source=space_of(on, "burson"), safety_valve=False, ask_before_source=True)
    on.ctx.enqueue("burson", "Please update the link on this alert and resend it. Thank you.")
    got = tick(on, world)
    assert (got["sent"], got["held"]) == (0, 0) and world.writes == [] and waiting(on) == []
    [asked] = mirror.queue(on.ctx)
    assert asked["text"].startswith("Please update the link") and rows(on)[0]["status"] == "waits_for_send"


def test_a_space_people_outside_google_can_join_is_never_written_unless_it_is_the_source(on, world):
    world.spaces[space_of(on, "team")]["externalUserAllowed"] = True
    on.ctx.enqueue("team", "Shift note for the team")
    got = tick(on, world)
    assert (got["sent"], got["held"]) == (0, 1) and world.writes == []
    assert rows(on)[0]["why"] == "People outside Google can join it and it is not the source space."


def test_a_target_taken_off_the_allowed_list_is_held(on, world):
    safe = {**on.ctx.config.platform.safety.model_dump(mode="json"), "allowed_post_targets": ["clean"]}
    on.ctx.enqueue("team", "Shift note for the team")
    assert on.put("/api/platform/safety", {"value": safe, "note": "test"}).status_code == 200
    assert tick(on, world)["held"] == 1 and world.writes == []
    assert rows(on)[0]["why"] == "Posting to team is not allowed (Settings, Safety)."


def test_a_direct_message_goes_to_each_person_through_the_dm_they_already_have_with_the_bot(on, world):
    route(on, safety_valve=False)
    world.dms[IM1] = world.add_space("spaces/DM1aaaaaaaa", "", kind="DIRECT_MESSAGE")
    item = on.ctx.enqueue("dm", "You are on shift: one alert needs you.", recipients=[IM1, IM2])
    got = tick(on, world)
    assert (got["sent"], got["failed"]) == (0, 1) and world.texts("spaces/DM1aaaaaaaa") == ["You are on shift: one alert needs you."]
    [row] = rows(on)
    assert row["status"] == "failed" and row["tries"] == 1
    assert row["why"] == f"The QA chatbot has no direct message with {IM2} yet. They message it once in Chat, and it is sent."
    assert item.outbox_id in {i.outbox_id for i in waiting(on)}
    world.dms[IM2] = world.add_space("spaces/DM2bbbbbbbb", "", kind="DIRECT_MESSAGE")
    assert tick(on, world)["sent"] == 1
    assert world.texts("spaces/DM1aaaaaaaa") == ["You are on shift: one alert needs you."], "the first person is not messaged twice"
    assert world.texts("spaces/DM2bbbbbbbb") == ["You are on shift: one alert needs you."] and waiting(on) == []


def test_while_testing_a_direct_message_goes_only_to_the_testing_recipients(on, world):
    world.dms[IM1] = world.add_space("spaces/DM1aaaaaaaa", "", kind="DIRECT_MESSAGE")
    world.dms[IM2] = world.add_space("spaces/DM2bbbbbbbb", "", kind="DIRECT_MESSAGE")
    on.ctx.enqueue("dm", "You are on shift.", recipients=[IM1, IM2])
    assert tick(on, world)["held"] == 1 and world.writes == []
    assert rows(on)[0]["why"] == "Testing is ON: direct messages go only to the testing recipients, and none of them is on this one."
    safe = {**on.ctx.config.platform.safety.model_dump(mode="json"), "testing_recipients": [IM2]}
    assert on.put("/api/platform/safety", {"value": safe, "note": "test"}).status_code == 200
    on.ctx.enqueue("dm", "You are on shift again.", recipients=[IM1, IM2])
    assert tick(on, world)["sent"] == 1
    assert world.texts("spaces/DM2bbbbbbbb") == ["You are on shift again."] and world.texts("spaces/DM1aaaaaaaa") == []


def test_when_chat_has_trouble_with_a_space_its_posts_wait_in_order_and_other_spaces_still_get_theirs(on, world):
    clean, team = space_of(on, "clean"), space_of(on, "team")
    world.fail_posts_to.add(clean)
    on.ctx.enqueue("clean", "First note")
    world.clock.advance(seconds=5)
    on.ctx.enqueue("clean", "Second note")
    world.clock.advance(seconds=5)
    on.ctx.enqueue("team", "Team note")
    got = tick(on, world)
    assert (got["ok"], got["sent"], got["failed"]) == (True, 1, 1) and world.texts(team) == ["Team note"] and world.texts(clean) == []
    for _ in range(on.ctx.config.platform.routing.max_tries + 1):
        tick(on, world)
    by = {r["text"]: r for r in rows(on)}
    assert by["First note"]["status"] == "failed" and by["First note"]["tries"] == 0, "Chat's trouble is not the post's: it is never given up for it"
    assert by["First note"]["why"] == "Chat did not take the post: 500: Chat is having trouble" and by["Second note"]["status"] == "waiting"
    world.fail_posts_to.clear()
    assert tick(on, world)["sent"] == 2 and world.texts(clean) == ["First note", "Second note"], "in the order they were queued"


def test_when_chat_cannot_be_reached_the_pass_ends_and_the_next_minute_tries_again(on, world):
    on.ctx.enqueue("clean", "A note for the analysts")
    real = world.request
    world.request = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("Chat could not be reached"))
    got = tick(on, world)
    assert got["ok"] is False and "Chat could not be reached" in got["error"] and len(waiting(on)) == 1
    world.request = real
    assert tick(on, world)["sent"] == 1 and rows(on)[0]["tries"] == 0


def test_a_space_the_bot_is_not_in_is_given_up_after_the_set_tries_until_someone_presses_try_again(on, world):
    team = space_of(on, "team")
    del world.spaces[team]
    item = on.ctx.enqueue("team", "Shift note for the team")
    world.clock.advance(seconds=5)
    on.ctx.enqueue("clean", "A note for the analysts")
    got = tick(on, world)
    assert (got["ok"], got["sent"], got["failed"]) == (True, 1, 1), "the post behind it, for another space, still goes"
    stuck = next(r for r in rows(on) if r["target"] == "team")
    assert stuck["status"] == "failed" and stuck["tries"] == 1 and stuck["why"].startswith("The QA chatbot can't open this space. Add ")
    tries = on.ctx.config.platform.routing.max_tries
    for _ in range(tries - 1):
        tick(on, world)
    stuck = next(r for r in rows(on) if r["target"] == "team")
    assert stuck["status"] == "gave_up" and stuck["tries"] == tries
    world.add_space(team, "24/7 SL Team")
    assert tick(on, world)["sent"] == 0, "given up: left alone until a person says to try again"

    assert on.post(f"/api/routing/delivery/{item.outbox_id}/retry", user=VIEWER).status_code == 403
    again = on.post(f"/api/routing/delivery/{item.outbox_id}/retry", user=IM)
    assert again.status_code == 200 and again.json() == {"id": item.outbox_id, "status": "waiting"}
    assert on.post("/api/routing/delivery/OBX-nothing/retry", user=IM).status_code == 404
    assert tick(on, world)["sent"] == 1 and world.texts(team) == ["Shift note for the team"] and waiting(on) == []
    assert on.get("/api/audit", action="chat.post.retry").json()["entries"][0]["actor"] == IM


def test_a_failed_safety_check_stops_every_post(on, world, monkeypatch):
    on.ctx.enqueue("clean", "A note for the analysts")
    failing = safety.CheckResult(id="leak_guard", title="The leak guard holds internal wording and passes plain wording", passed=False)
    monkeypatch.setattr(safety, "blocking_failures", lambda ctx: [failing])
    got = tick(on, world)
    assert got["ok"] is False and got["error"] == "Held by a failed safety check: The leak guard holds internal wording and passes plain wording"
    assert world.writes == [] and len(waiting(on)) == 1 and rows(on) == []


def test_with_the_switch_on_a_flow_takes_only_what_chat_delivery_does_not_post(on, world):
    on.ctx.enqueue("clean", "A note for the analysts")
    note = on.ctx.enqueue("handover", "Handover line for the doc")
    assert on.ctx.doorbell.rings == [note.outbox_id], "the handover doc is still a flow's work"
    outputs, data = outbox.drain(on.ctx)
    assert data["delivered_ids"] == [note.outbox_id] and outputs.target_texts() == {"handover": "Handover line for the doc"}
    assert [i.target for i in waiting(on)] == ["clean"]
    world.clock.advance(minutes=10)
    assert outbox.rering_stale(on.ctx) == 0, "a post this delivery owns is never rung again for a flow"
    assert tick(on, world)["sent"] == 1


def test_a_reviewed_alert_is_posted_in_the_same_minute_run(on, world):
    assess_ok(on.ctx.llm)
    route(on, bot_on=True, source=SRC, safety_valve=False)
    switches(on, chat_delivery=True, chat_review=True)
    world.say(SRC, GOOD_ALERT)
    world.clock.advance(minutes=1)
    jobs = run_job(on.ctx, "maintenance")["jobs"]
    assert jobs["chat_review"]["reviewed"] == 1 and jobs["chat_delivery"]["ok"] and jobs["chat_delivery"]["sent"] >= 1
    posted = world.texts(space_of(on, "clean"))
    assert len(posted) == 1 and "TRG-" in posted[0], "the reviewed alert is in the analysts' space"
    page = on.get("/api/routing", user=VIEWER).json()["delivery"]
    assert page["on"] is True and page["last_run"]["sent"] >= 1 and page["last_run"]["at"]


def test_worker_identity_check_passes_with_scheduler_account_while_console_requires_iap(api, monkeypatch):
    monkeypatch.setenv("K_SERVICE", "slrr-triage-console")
    monkeypatch.delenv("TRIAGE_IAP_AUDIENCE", raising=False)
    monkeypatch.setenv("TRIAGE_SCHEDULER_SA", "sched@ops.test")
    console_check = next(c for c in safety.run_checks(api.ctx) if c.id == "signed_identity")
    assert not console_check.passed and "IAP" in console_check.detail

    monkeypatch.setenv("K_SERVICE", "slrr-triage-console-worker")
    worker_check = next(c for c in safety.run_checks(api.ctx) if c.id == "signed_identity")
    assert worker_check.passed and "The worker only takes calls signed by the scheduler's account." in worker_check.detail


def test_posts_held_through_a_long_block_are_not_sent_late_on_recovery(on, world, monkeypatch):
    clean = space_of(on, "clean")
    stale = on.ctx.enqueue("clean", "Queued while delivery was blocked")
    failing = safety.CheckResult(id="signed_identity", title="Console identity is verified", passed=False)
    monkeypatch.setattr(safety, "blocking_failures", lambda ctx: [failing])
    assert tick(on, world)["ok"] is False
    world.clock.advance(minutes=45)
    fresh = on.ctx.enqueue("clean", "Queued right before recovery")
    monkeypatch.setattr(safety, "blocking_failures", lambda ctx: [])

    got = tick(on, world)
    assert got["ok"] is True and got["sent"] == 1 and got["not_sent_late"] == 1
    assert got["note"] == "1 older post was not sent late."
    assert world.texts(clean) == ["Queued right before recovery"]
    assert waiting(on) == []
    assert chatdelivery.post_now(on.ctx, stale) == "too old to post"
    st = chatdelivery.status(on.ctx)
    assert st["not_sent_late"]["count"] == 1 and "1 older post was not sent late." in st["not_sent_late"]["note"]


def test_testing_mode_keeps_dms_off_real_ims_and_strips_bot_markers_from_burson(on, world):
    burson = space_of(on, "burson")
    clean = space_of(on, "clean")
    dm_real = world.dms[IM1] = world.add_space("spaces/DM1aaaaaaaa", "", kind="DIRECT_MESSAGE")
    dm_tester = world.dms[IM2] = world.add_space("spaces/DM2bbbbbbbb", "", kind="DIRECT_MESSAGE")
    safety_val = {**on.ctx.config.platform.safety.model_dump(mode="json"), "testing": True, "testing_recipients": [IM2]}
    assert on.put("/api/platform/safety", {"value": safety_val, "note": "test"}).status_code == 200

    on.ctx.enqueue("dm", "🤖 Review needed", recipients=[IM1])
    on.ctx.enqueue("dm", "🤖 Review needed for tester", recipients=[IM1, IM2])
    on.ctx.enqueue("burson", "🤖 Please add the link and resend.")
    got = tick(on, world)
    assert got["sent"] == 1 and got["held"] == 2
    assert world.texts(dm_real) == [], "real IMs never receive DMs while Testing is ON"
    assert world.texts(dm_tester) == ["🤖 Review needed for tester"]
    assert world.texts(burson) == [], "Burson receives nothing while the safety valve / testing holds it"

    # When the source space is open and not in stealth, Burson posts strip the robot prefix while internal spaces keep it.
    safety_live = {**safety_val, "testing": False, "testing_recipients": []}
    assert on.put("/api/platform/safety", {"value": safety_live, "note": "live"}).status_code == 200
    route(on, bot_on=True, source=burson, mirror="", safety_valve=False, ask_before_source=False)
    on.ctx.enqueue("burson", "🤖 Please include the full post URL on the View Post line.")
    on.ctx.enqueue("clean", "🤖 Internal triage note")
    got2 = tick(on, world)
    assert got2["sent"] == 2
    assert world.texts(burson) == ["Please include the full post URL on the View Post line."]
    assert world.texts(clean) == ["🤖 Internal triage note"]
