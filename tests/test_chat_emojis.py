"""Emojis people add in Chat, acted on through the QA chatbot's own Chat sign-in, with no Chat flow in between.

Every minute, with the switch ON, the bot's account reads the space it posts its alerts in. A legend emoji a person
adds to one of the bot's alert posts is handed, once, to the operation a Chat flow would hand it to (record_reaction),
and the reply is posted in that post's thread. Google Chat is the in-memory stand-in from the Routing tests (no
network); the reading, who reacted, the operation and the posting are the real code.
"""

from __future__ import annotations

from typing import Any

import pytest

from test_chat_delivery import space_of, switches
from test_console_api import IM, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_routing import MIR, PAT, route, world  # noqa: F401 - fixtures
from triage_agent import chatreactions
from triage_agent.models import CaseStatus
from triage_agent.platform_jobs import run_job

BOT = {"name": "users/bot", "type": "HUMAN"}  # the bot's own account, as Chat names it


def open_case(api) -> str:
    return next(c.case_id for c in api.ctx.store.list_cases(limit=200) if c.status != CaseStatus.CLOSED)


@pytest.fixture
def on(api, world):
    """The QA chatbot ON, the emoji switch ON, and one of the bot's alert posts in the space it posts its alerts in."""
    clean = world.add_space(space_of(api, "clean"), "SLRR Triaged Alerts")
    route(api, bot_on=True, source=world.add_space(space_of(api, "burson"), "[S-F] Burson Automated Alerts V3", external=True), mirror=MIR)
    switches(api, chat_reactions=True)
    world.members[(clean, api.ctx.config.agent.email)] = BOT["name"]
    world.members[(clean, IM)] = PAT["name"]
    api.case = open_case(api)
    api.clean = clean
    api.post = world.say(clean, f"🤖 {api.case} Someone says Gemini made up a citation.", sender=BOT, clientAssignedMessageId="client-bqa-alert1")
    return api


def tick(api, world) -> dict[str, Any]:
    world.clock.advance(minutes=1)
    return chatreactions.run(api.ctx)


def rows(api) -> list[dict[str, Any]]:
    return api.get("/api/routing", user=IM).json()["emojis"]["rows"]


def test_the_switch_starts_off_and_nothing_is_read(api, world):
    route(api, bot_on=True, source=world.add_space(space_of(api, "burson"), "Burson", external=True), mirror=MIR)
    before = list(world.asked)
    got = tick(api, world)
    assert got["off"] is True and got["why"] == "the switch Act on emojis added in Chat is OFF" and world.asked == before
    assert api.get("/api/routing", user=IM).json()["emojis"]["on"] is False

    switches(api, chat_reactions=True)
    route(api, bot_on=False)
    assert tick(api, world)["why"] == "the QA chatbot is OFF"


def test_a_legend_emoji_on_the_bots_alert_post_is_acted_on_once_with_the_reply_in_its_thread(on, world):
    world.emoji(on.post, "❌", user=PAT["name"])
    got = tick(on, world)
    assert got["ok"] and (got["acted"], got["failed"]) == (1, 0)
    case = on.ctx.store.get_case(on.case)
    assert case.status == CaseStatus.CLOSED and case.actions[-1].actor == IM, "the person who added it, by their address"
    reply = world.messages[on.clean][-1]
    assert reply["text"].startswith(f"🤖 ❌ Closed {on.case} (no action).") and reply["threadReply"] is True
    assert reply["thread"]["name"] == world.messages[on.clean][0]["thread"]["name"]
    assert tick(on, world)["acted"] == 0 and len(world.messages[on.clean]) == 2, "never twice"
    [row] = rows(on)
    assert (row["status"], row["emoji"], row["who"], row["case_id"], row["code"]) == ("acted", "❌", IM, on.case, "no_action")
    assert row["reply"] == reply["text"]
    entry = on.get("/api/audit", action="chat.reaction").json()["entries"][0]
    assert entry["summary"] == "Acted on ❌ in SLRR Triaged Alerts" and entry["target_id"] == on.post and entry["case_id"] == on.case


def test_an_emoji_that_needs_no_reply_is_still_acted_on(on, world):
    world.emoji(on.post, "👍", user=PAT["name"])
    assert tick(on, world)["acted"] == 1 and world.writes == []
    assert on.ctx.store.get_case(on.case).acknowledged_at is not None and rows(on)[0]["reply"] == ""


def test_only_legend_emojis_people_add_to_the_bots_alert_posts_count(on, world):
    world.emoji(on.post, "🎉", user=PAT["name"])                       # not in the legend
    world.emoji(on.post, "❌", user=BOT["name"])                       # the bot's own emoji
    chat = world.say(on.clean, f"{on.case} looks off to me", sender=PAT)
    world.emoji(chat, "👍", user="users/222")                          # a person's message, even one that names the alert
    stray = world.say(on.clean, "🤖 A note with no alert in it", sender=BOT, clientAssignedMessageId="client-bqa-note")
    world.emoji(stray, "👍", user=PAT["name"])                         # the bot's post, but no alert
    got = tick(on, world)
    assert (got["acted"], got["failed"]) == (0, 0) and world.writes == [] and rows(on) == []
    assert on.ctx.store.get_case(on.case).status != CaseStatus.CLOSED
    asked = [a for a in world.asked if a.endswith("/reactions")]
    assert asked == [f"GET {on.post}/reactions"], "who reacted is asked only for an alert post with a legend emoji"


def test_who_reacted_is_asked_again_only_when_a_posts_emojis_change(on, world):
    world.members[(on.clean, "admin@ops.test")] = "users/333"
    world.emoji(on.post, "👍", user=PAT["name"])
    tick(on, world)
    tick(on, world)
    assert len([a for a in world.asked if a.endswith("/reactions")]) == 1, "nothing changed: not asked again"
    world.emoji(on.post, "👍", user="users/333")  # a second person adds the same emoji
    assert tick(on, world)["acted"] == 1 and len([a for a in world.asked if a.endswith("/reactions")]) == 2
    assert sorted(r["who"] for r in rows(on)) == ["admin@ops.test", IM], "each person's emoji is theirs"


def test_each_persons_emoji_on_one_post_gets_its_own_reply(on, world):
    world.members[(on.clean, "admin@ops.test")] = "users/333"
    world.emoji(on.post, "❌", user=PAT["name"])
    tick(on, world)
    world.emoji(on.post, "❌", user="users/333")
    assert tick(on, world)["acted"] == 1
    replies = [m["text"] for m in world.messages[on.clean][1:]]
    assert len(replies) == 2 and replies[0].startswith(f"🤖 ❌ Closed {on.case}") and "already closed" in replies[1]


def test_someone_not_on_the_rosters_is_recorded_as_unknown_never_as_the_bot(on, world):
    world.emoji(on.post, "❌", user="users/999")
    assert tick(on, world)["acted"] == 1 and rows(on)[0]["who"] == ""
    assert on.ctx.store.get_case(on.case).actions[-1].actor == "unknown"


def test_a_post_older_than_the_routing_pages_emoji_hours_is_not_read(on, world):
    world.clock.advance(hours=on.ctx.config.platform.routing.emoji_hours + 1)
    world.emoji(on.post, "❌", user=PAT["name"])
    assert tick(on, world)["acted"] == 0 and rows(on) == []


def test_a_reply_chat_does_not_take_is_tried_again_and_the_emoji_is_acted_on_once(on, world, monkeypatch):
    ran, real = [], chatreactions.handle
    monkeypatch.setattr(chatreactions, "handle", lambda request, ctx: ran.append(request["op"]) or real(request, ctx))
    world.fail_posts_to.add(on.clean)
    world.emoji(on.post, "❌", user=PAT["name"])
    assert tick(on, world)["failed"] == 1 and rows(on)[0]["status"] == "failed" and "Chat is having trouble" in rows(on)[0]["why"]
    for _ in range(on.ctx.config.platform.routing.max_tries - 1):
        tick(on, world)
    assert rows(on)[0]["status"] == "gave_up" and tick(on, world)["failed"] == 0 and ran == ["record_reaction"]


def test_emojis_run_in_the_once_a_minute_tick_and_old_records_are_removed(on, world):
    world.emoji(on.post, "👍", user=PAT["name"])
    world.clock.advance(minutes=1)
    assert run_job(on.ctx, "maintenance")["jobs"]["chat_reactions"]["acted"] == 1
    from triage_agent import retention

    world.clock.advance(days=on.ctx.config.platform.routing.keep_days + 1)
    retention.run(on.ctx)
    assert on.ctx.store.list_docs(chatreactions.ROWS) == [] and on.ctx.store.list_docs(chatreactions.SEEN) == []
