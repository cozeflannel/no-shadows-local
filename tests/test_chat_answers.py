"""Mentions of the QA chatbot answered through its own Chat sign-in, with no Chat flow in between.

Every minute, with the switch ON, the bot's account reads the spaces it works in. A person's message that mentions the
bot is handed, once, to the operation a Chat flow would hand it to (converse), and the reply is posted in that
message's thread. Google Chat is the in-memory stand-in from the Routing tests (no network); the reading, who the asker
is, the operation, the routing rules and the posting are the real code.
"""

from __future__ import annotations

from typing import Any

import pytest

from test_chat_delivery import space_of, switches
from test_console_api import IM, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_routing import ALERT, MIR, PAT, SRC, ZAP, route, world  # noqa: F401 - fixtures
from test_routing import tick as copy
from triage_agent import chatanswers, mirror
from triage_agent.platform_jobs import run_job

BOT = "users/bot"  # the user id Chat knows the bot's account by (the stand-in posts as it)
HELLO = "🤖 Hi! Ask me about alerts, drafts, T&S or who's on shift."


def mention(user: str = BOT, **where: int) -> dict[str, Any]:
    return {"annotations": [{"type": "USER_MENTION", **where, "userMention": {"user": {"name": user, "type": "HUMAN"}, "type": "MENTION"}}]}


@pytest.fixture
def on(api, world):
    """The QA chatbot ON with a second space, the answer switch ON, and Chat knowing the bot's account in each space."""
    burson = space_of(api, "burson")
    world.add_space(burson, "[S-F] Burson Automated Alerts V3", external=True)
    route(api, bot_on=True, source=burson, mirror=MIR)
    switches(api, chat_answers=True)
    api.ctx.config.burson_feedback.silent_in_burson_space = False
    for space in (burson, MIR, SRC):
        world.members[(space, api.ctx.config.agent.email)] = BOT
    return api


def tick(api, world) -> dict[str, Any]:
    world.clock.advance(minutes=1)
    return chatanswers.run(api.ctx)


def rows(api) -> list[dict[str, Any]]:
    return api.get("/api/routing", user=IM).json()["answers"]["rows"]


def test_the_switch_starts_off_and_nothing_is_read(api, world):
    route(api, bot_on=True, source=space_of(api, "burson"), mirror=MIR)
    world.say(MIR, "<users/bot> hello", sender=PAT, **mention())
    got = tick(api, world)
    assert got["off"] is True and got["why"] == "the switch Answer mentions in Chat is OFF" and world.writes == []
    assert api.get("/api/routing", user=IM).json()["answers"]["on"] is False

    switches(api, chat_answers=True)
    route(api, bot_on=False)
    before = list(world.asked)
    got = tick(api, world)
    assert got["off"] is True and got["why"] == "the QA chatbot is OFF" and world.asked == before, "the switch alone reads nothing"


def test_a_mention_in_the_second_space_is_answered_once_in_its_thread(on, world):
    asked = world.say(MIR, "<users/bot>", sender=PAT, **mention())
    got = tick(on, world)
    assert got["ok"] and (got["answered"], got["failed"]) == (1, 0)
    reply = world.messages[MIR][-1]
    thread = next(m["thread"]["name"] for m in world.messages[MIR] if m["name"] == asked)
    assert reply["text"].startswith(HELLO) and reply["thread"]["name"] == thread and reply["threadReply"] is True
    assert reply["clientAssignedMessageId"].startswith("client-bqa-"), "known as the bot's own post, so it never answers itself"
    assert tick(on, world)["answered"] == 0 and len(world.messages[MIR]) == 2, "never twice"
    [row] = rows(on)
    assert (row["status"], row["space"], row["text"]) == ("answered", "Burson mirror", "<users/bot>") and row["reply"].startswith(HELLO)
    entry = on.get("/api/audit", action="chat.answer").json()["entries"][0]
    assert entry["summary"] == "Answered a mention in Burson mirror" and entry["target_id"] == asked


def test_a_message_that_does_not_mention_the_bot_is_left_alone(on, world):
    world.say(MIR, "Morning all", sender=PAT)
    world.say(MIR, "<users/222> can you look at this?", sender=PAT, **mention("users/222"))
    got = tick(on, world)
    assert (got["answered"], got["ignored"]) == (0, 0) and world.writes == [] and rows(on) == []


def test_the_bots_name_typed_out_counts_as_a_mention_when_chat_gives_no_annotation(on, world):
    world.say(MIR, "@Triage Agent", sender=PAT)
    assert tick(on, world)["answered"] == 1 and world.messages[MIR][-1]["text"].startswith(HELLO)


def test_apps_and_the_bots_own_posts_are_never_answered(on, world):
    world.say(MIR, ALERT.format(n=1) + "\n@Triage Agent", sender=ZAP)
    world.say(MIR, "@Triage Agent is checking this", sender={"name": BOT, "type": "HUMAN"}, clientAssignedMessageId="client-bqa-abc")
    assert tick(on, world)["answered"] == 0 and world.writes == []


def test_the_bot_knows_its_own_account_from_a_post_it_made_or_from_chat_under_either_name_form(on, world):
    """As the sheet-based bot does (Main.gs rememberBotUser_, Chat.gs chatMyUserId_)."""
    from triage_agent import chatapi

    world.members.clear()  # Chat answers for no address: the account's id cannot be asked
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    assert tick(on, world)["answered"] == 0, "not known yet: Chat's mention cannot be matched to the bot"
    chatapi.client_for(on.ctx).post_message(MIR, "A note for the analysts", key="note")  # any post of its own tells it who it is
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    assert tick(on, world)["answered"] == 2, "both: the one it could not match a minute ago is answered too"
    assert world.messages[MIR][-1]["text"].startswith(HELLO)


def test_chat_is_asked_for_the_bots_account_under_the_second_name_form_when_the_first_is_refused(on, world):
    world.members.clear()
    world.members[(MIR, f"users/{on.ctx.config.agent.email}")] = BOT
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    assert tick(on, world)["answered"] == 1


def test_chat_failing_when_asked_who_is_who_is_not_taken_for_an_answer(on, world):
    world.members[(MIR, IM)] = PAT["name"]
    world.fail_lookups_in.update({space_of(on, "burson"), MIR})
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    got = tick(on, world)
    assert got["answered"] == 0 and got["ok"] is False
    assert got["error"] == "the source space: 500: Chat is having trouble; the second space: 500: Chat is having trouble"

    world.fail_lookups_in.discard(space_of(on, "burson"))  # the bot's own account can be asked again; the asker's cannot
    got = tick(on, world)
    assert (got["answered"], got["failed"]) == (0, 1) and rows(on)[0]["why"] == "500: Chat is having trouble"

    world.fail_lookups_in.clear()
    assert tick(on, world)["answered"] == 1 and rows(on)[0]["asker"] == IM, "asked again the next minute, not believed for hours"


def test_the_asker_is_known_by_their_address_once_chat_has_matched_it_to_the_roster(on, world):
    world.members[(MIR, IM)] = PAT["name"]
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    tick(on, world)
    assert rows(on)[0]["asker"] == IM
    asked = [r for r in world.asked if "/members/" in r]
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    tick(on, world)
    assert [r for r in world.asked if "/members/" in r] == asked, "a person is looked up once, then remembered"

    world.say(MIR, "<users/bot>", sender={"name": "users/999", "type": "HUMAN"}, **mention())
    tick(on, world)
    assert rows(on)[0]["asker"] == "", "someone the roster does not hold is answered as an unknown person"


def test_a_mention_in_the_closed_source_space_is_answered_under_its_copy_and_nothing_is_written_there(on, world):
    burson = space_of(on, "burson")
    alert = world.say(burson, ALERT.format(n=1))
    copy(on, world)
    world.say(burson, "<users/bot>", sender=PAT, under=alert, **mention())
    got = tick(on, world)
    assert (got["answered"], got["held"]) == (0, 1) and world.texts(burson) == [ALERT.format(n=1), "<users/bot>"], "nothing is written in the source space"
    [kept] = on.ctx.store.list_docs(mirror.OWN_REPLIES)
    assert "Hi! Ask me about alerts" in kept["text"]
    copy(on, world)
    last = world.messages[MIR][-1]
    assert "Hi! Ask me about alerts" in last["text"] and last["thread"]["name"] == world.messages[MIR][0]["thread"]["name"]
    row = rows(on)[0]
    assert (row["status"], row["reply"]) == ("held", "")
    assert row["why"] == ("Nothing is written in the source space: the Safety valve is ON. "
                          "It is shown in the second space, under the copy of the message it answers.")
    assert on.get("/api/audit", action="chat.answer").json()["entries"][0]["summary"].startswith("Held the answer to a mention in ")


def test_a_reply_chat_refuses_for_the_closed_source_space_is_shown_under_the_copy_instead(on, world):
    route(on, bot_on=True, source=SRC, mirror=MIR)  # a source space that is not the agent's own "burson" space
    alert = world.say(SRC, ALERT.format(n=1))
    copy(on, world)
    world.say(SRC, "<users/bot>", sender=PAT, under=alert, **mention())
    got = tick(on, world)
    assert (got["answered"], got["held"]) == (0, 1) and len(world.messages[SRC]) == 2, "nothing is written in the source space"
    row = rows(on)[0]
    assert row["status"] == "held" and row["why"].startswith("Nothing is written in the source space: the Safety valve is ON.")
    [kept] = on.ctx.store.list_docs(mirror.OWN_REPLIES)
    assert kept["text"].startswith(HELLO) and kept["source_thread"] == world.messages[SRC][0]["thread"]["name"]
    assert tick(on, world)["held"] == 0 and len(on.ctx.store.list_docs(mirror.OWN_REPLIES)) == 1, "held once, never again"


def test_in_the_open_source_space_the_reply_is_posted_or_waits_for_send_as_the_routing_page_says(on, world):
    route(on, bot_on=True, source=SRC, mirror="", safety_valve=False, ask_before_source=True)
    alert = world.say(SRC, ALERT.format(n=1))
    thread = world.messages[SRC][0]["thread"]["name"]
    asked = world.say(SRC, "<users/bot>", sender=PAT, under=alert, **mention())
    got = tick(on, world)
    assert (got["queued"], got["answered"]) == (1, 0) and len(world.messages[SRC]) == 2
    assert (rows(on)[0]["status"], rows(on)[0]["why"]) == ("queued", "It waits for a person's Send on the Routing page.")
    [waits] = on.get("/api/routing", user=IM).json()["queue"]
    assert waits["text"].startswith(HELLO)

    route(on, ask_before_source=False)
    world.say(SRC, "<users/bot>", sender=PAT, under=alert, **mention())
    assert tick(on, world)["answered"] == 1
    last = world.messages[SRC][-1]
    assert last["text"].startswith(HELLO) and last["clientAssignedMessageId"].startswith("client-zrlo-") and last["name"] != asked
    assert last["thread"]["name"] == thread, "in the thread of the message it answers"
    assert rows(on)[0]["status"] == "answered" and rows(on)[0]["reply"].startswith(HELLO)


def test_a_mention_is_cut_out_of_the_question_where_chat_says_it_sits(on, world):
    world.say(MIR, "@QA Account", sender=PAT, **mention(length=11))  # the account's own name, not the agent's
    world.say(MIR, "\n@QA Account", sender=PAT, **mention(startIndex=1, length=11))
    world.say(MIR, "Hi @QA Account", sender=PAT, **mention(startIndex=3, length=11))
    assert tick(on, world)["answered"] == 3
    said = [m["text"].startswith(HELLO) for m in world.messages[MIR][-3:]]
    assert said == [True, True, False], "nothing but the mention: the bot says hello. Anything else is the question"


def test_one_of_the_agents_own_spaces_is_read_once_it_is_picked_on_the_routing_page(on, world):
    team = world.add_space(space_of(on, "team"), "24/7 SL Team")
    world.members[(team, on.ctx.config.agent.email)] = BOT
    world.say(team, "<users/bot>", sender=PAT, **mention())
    assert tick(on, world)["answered"] == 0 and world.writes == [], "not picked: not read"
    state = route(on, answer_spaces=["team"])["answers"]
    assert state["spaces"][-1] == on.ctx.config.space("team").display_name
    assert {"key": "team", "name": on.ctx.config.space("team").display_name, "picked": True} in state["choices"]
    assert "burson" not in [c["key"] for c in state["choices"]], "the source space is read already: it is not offered again"
    assert tick(on, world)["held"] == 1 and len(world.messages[team]) == 1, "while Testing is ON, nothing is posted to live team space"
    route(on, safety_valve=False)
    world.say(team, "<users/bot>", sender=PAT, **mention())
    assert tick(on, world)["answered"] == 1 and world.messages[team][-1]["text"].startswith(HELLO)

    r = on.put("/api/routing", {"value": {"answer_spaces": ["nowhere"]}})
    assert r.status_code == 422 and r.json()["field"] == "answer_spaces" and r.json()["error"] == "nowhere is not one of the agent's spaces."
    assert on.put("/api/routing", {"value": {"answer_spaces": ["doodle"]}}).status_code == 422, "a space with no link or id cannot be read"


def test_a_space_the_bot_cannot_open_is_named_and_never_stops_the_others(on, world):
    route(on, answer_spaces=["team"])  # the stand-in has no such space: Chat refuses it
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    got = tick(on, world)
    assert got["answered"] == 1 and got["ok"] is False
    assert got["error"] == (f"{on.ctx.config.space('team').display_name}: the QA chatbot can't open this space. "
                            f"Add {on.ctx.config.agent.email} to it")
    assert on.get("/api/routing", user=IM).json()["answers"]["last_run"]["error"] == got["error"]


def test_a_reply_that_cannot_be_posted_is_tried_again_and_given_up_after_the_set_tries(on, world, monkeypatch):
    ran, real = [], chatanswers.handle
    monkeypatch.setattr(chatanswers, "handle", lambda request, ctx: ran.append(request["op"]) or real(request, ctx))
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    world.fail_posts_to.add(MIR)
    assert tick(on, world)["failed"] == 1 and rows(on)[0]["status"] == "failed" and "Chat is having trouble" in rows(on)[0]["why"]
    for _ in range(on.ctx.config.platform.routing.max_tries - 1):
        tick(on, world)
    assert rows(on)[0]["status"] == "gave_up" and tick(on, world)["failed"] == 0, "given up: it is left alone"
    assert ran == ["converse"], "the question is answered once; only the post is tried again"

    world.fail_posts_to.clear()
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    assert tick(on, world)["answered"] == 1, "one that failed never holds the ones behind it"


def test_answers_run_in_the_once_a_minute_tick_and_old_records_are_removed(on, world):
    world.say(MIR, "<users/bot>", sender=PAT, **mention())
    world.clock.advance(minutes=1)
    assert run_job(on.ctx, "maintenance")["jobs"]["chat_answers"]["answered"] == 1
    from triage_agent import retention

    world.clock.advance(days=on.ctx.config.platform.routing.keep_days + 1)
    retention.run(on.ctx)
    assert on.ctx.store.list_docs(chatanswers.ROWS) == []
