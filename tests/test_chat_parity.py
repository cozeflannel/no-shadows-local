"""The QA chatbot answers in Chat the way the sheet-based bot did, and then some.

The sheet-based bot (apps-script-chat-bot/Bot.gs handleHuman_, pollAnalystMessages_, selfAnswerOk_; Voice.gs
isQuestion_, isShortAck_, answerPrompts_, safeAnswer_; CampaignHandoff.gs) answered questions without being mentioned,
answered the person whose account it ran as (never in a loop), answered in an alert's thread with that alert in mind,
gave Burson its fixed answer when its own answer named something internal, never answered an alert a person pasted, and
handed a thread to the campaigns assistant when someone asked for a deep dive. Google Chat is the in-memory stand-in from
the Routing tests (no network); the reading, the rules, the operation and the posting are the real code.
"""

from __future__ import annotations

from typing import Any

import pytest

from a2_fixtures import make_case
from conftest import BURSON_SPACE, GOOD_ALERT, make_message
from test_chat_answers import BOT, HELLO, mention, on, rows, tick  # noqa: F401 - fixtures
from test_chat_delivery import space_of, switches
from test_console_api import IM, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_routing import ALERT, MIR, PAT, route, world  # noqa: F401 - fixtures
from test_routing import tick as copy
from triage_agent import chatanswers, chatrules, mirror
from triage_agent.converse import handler
from triage_agent.operations import handle

ME = {"name": BOT, "type": "HUMAN"}  # the person the bot's account belongs to, typing in Chat


def alert_case(api, world, space: str):
    """A case for the first alert in `space`, tied to that alert's Chat message and thread, as the review keeps it."""
    first = world.messages[space][0]
    case = make_case(api.ctx)
    case.attempts[0].message.message_id = first["name"]
    case.attempts[0].message.thread_id = first["thread"]["name"]
    api.ctx.store.save_case(case)
    return case


# ---------------------------------------------------------------------------------------------------------------
# The sheet-based bot's rules, word for word
# ---------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("text, question, short", [
    ("Why was this one flagged", True, False),
    ("is the tag right?", True, False),
    ("<users/1> can you check", True, False),
    ("@Someone what now", True, False),
    ("isn\u2019t this a P0", True, False),
    ("ok thanks!", False, True),
    ("Done, resent \U0001F44D", False, True),
    ("\U0001F44D", False, True),
    ("Morning all", False, False),
])
def test_the_sheet_bots_question_and_short_reply_rules(text, question, short):
    assert chatrules.is_question(text) is question and chatrules.is_short_ack(text) is short


def test_where_a_message_stands_decides_which_rule_applies():
    # Burson's space: a question, or in an alert's thread a follow-up about the alert
    assert chatrules.wants_answer("the exposure tag is wrong", source=True, reply=True, alert_thread=True)
    assert not chatrules.wants_answer("the exposure tag is wrong", source=True, reply=True, alert_thread=False)
    assert not chatrules.wants_answer("ok will fix, resending now", source=True, reply=True, alert_thread=True), "a short reply needs nothing back"
    assert chatrules.wants_answer("ok will fix the tag", source=True, reply=True, alert_thread=True), "naming a field is more than a short reply"
    looked: list[int] = []
    assert chatrules.wants_answer("why?", source=True, reply=True, alert_thread=lambda: looked.append(1) or False)
    assert looked == [], "a question needs no look at the alerts"
    # the other spaces: a question that is not a short reply, or in a thread a follow-up about the alert or the next steps
    assert chatrules.wants_answer("I'll send the draft to Priya", source=False, reply=True)
    assert not chatrules.wants_answer("I'll send the draft to Priya", source=False, reply=False)
    assert not chatrules.wants_answer("thanks", source=False, reply=True)
    assert chatrules.is_temp_check("temp check on the Gemini citations story") and not chatrules.is_temp_check("is a temp check needed?")


def test_what_asks_for_the_campaigns_assistant():
    assert chatrules.campaign_ask("Can you run a deep dive on this?") == "yes"
    assert chatrules.campaign_ask("[internal] start a new campaign for this topic") == "yes"
    assert chatrules.campaign_ask("keep tracking this in brandwatch") == "maybe"
    assert chatrules.campaign_ask("what is the status?") == ""
    assert chatrules.ownership_id("spaces/A/threads/B") == "spaces__A__threads__B", "the campaigns service's own document id"
    assert len(chatrules.ownership_id("spaces/" + "x" * 200)) == 64


# ---------------------------------------------------------------------------------------------------------------
# Questions without a mention
# ---------------------------------------------------------------------------------------------------------------

def test_a_question_without_a_mention_is_answered_only_with_its_switch_on(on, world):
    world.say(MIR, "What do I need to do on this one?", sender=PAT)
    assert tick(on, world)["answered"] == 0 and world.writes == [], "OFF by default: only mentions are answered"
    assert on.ctx.config.platform.flags.chat_questions is False and on.ctx.config.platform.flags.campaign_handoff is False

    switches(on, chat_questions=True)
    world.say(MIR, "What should I send next?", sender=PAT)
    assert tick(on, world)["answered"] == 2, "the question a minute ago is still read again, and answered now"
    assert on.get("/api/routing", user=IM).json()["answers"]["questions"] is True


def test_in_the_second_space_it_answers_as_the_sheet_bot_answered_the_analysts(on, world):
    switches(on, chat_questions=True)
    world.say(MIR, "What do I need to do on this one?", sender=PAT)
    world.say(MIR, "ok thanks!", sender=PAT)
    world.say(MIR, "Morning all", sender=PAT)
    world.say(MIR, "<users/222> what do you think?", sender=PAT, **mention("users/222"))
    top = world.say(MIR, "Heads up, a new alert is coming", sender=PAT)
    world.say(MIR, "I'll send the draft to Priya", sender=PAT, under=top)
    world.say(MIR, "done \U0001F44D", sender=PAT, under=top)
    got = tick(on, world)
    assert (got["answered"], got["failed"]) == (2, 0)
    assert sorted(r["text"] for r in rows(on)) == ["I'll send the draft to Priya", "What do I need to do on this one?"]
    assert {r["how"] for r in rows(on)} == {"question"}
    entry = on.get("/api/audit", action="chat.answer").json()["entries"][0]
    assert entry["summary"] == "Answered a question in Burson mirror"


def test_in_bursons_space_it_answers_questions_and_follow_ups_in_an_alerts_thread(on, world):
    switches(on, chat_questions=True)
    burson = space_of(on, "burson")
    alert = world.say(burson, ALERT.format(n=1))
    chatter = world.say(burson, "Morning team", sender=PAT)
    case = alert_case(on, world, burson)
    copy(on, world)
    world.say(burson, "The exposure tag is wrong here", sender=PAT, under=alert)
    world.say(burson, "The exposure tag is wrong here", sender=PAT, under=chatter)  # the same words, in no alert's thread
    world.say(burson, "ok will fix", sender=PAT, under=alert)
    world.say(burson, "Why was this one sent back", sender=PAT)
    got = tick(on, world)
    assert (got["held"], got["answered"]) == (2, 0), "the source space is closed: each answer is held and shown under the copies"
    assert sorted(r["text"] for r in rows(on)) == ["The exposure tag is wrong here", "Why was this one sent back"]
    follow_up = next(r for r in rows(on) if r["text"].startswith("The exposure"))
    assert follow_up["case_id"] == case.case_id, "answered with the alert its thread is about"
    assert world.texts(burson)[-1] == "Why was this one sent back", "nothing is written in Burson's space"


def test_an_alert_a_person_pastes_is_the_reviews_and_never_answered_even_when_it_mentions_the_bot(on, world):
    switches(on, chat_questions=True)
    world.say(MIR, "@Triage Agent\n" + GOOD_ALERT, sender=PAT)
    world.say(MIR, "Is this right?\n" + GOOD_ALERT, sender=PAT)
    assert tick(on, world)["answered"] == 0 and world.writes == []


# ---------------------------------------------------------------------------------------------------------------
# The person the bot's account belongs to
# ---------------------------------------------------------------------------------------------------------------

def test_the_person_whose_account_the_bot_uses_is_answered_but_never_in_a_loop(on, world):
    switches(on, chat_questions=True)
    top = world.say(MIR, "What do I need to do on this one?", sender=ME)
    assert tick(on, world)["answered"] == 1, "the person the bot's account belongs to can ask too, as with the sheet-based bot"
    assert rows(on)[0]["asker"] == on.ctx.config.agent.email
    for _ in range(3):
        world.say(MIR, "and why is that?", sender=ME, under=top)
    got = tick(on, world)
    assert (got["answered"], got["ignored"]) == (2, 1), f"at most {chatanswers.SELF_MAX} answers a thread in 15 minutes"
    assert [r["why"] for r in rows(on) if r["status"] == "ignored"] == [chatanswers.SELF_WHY]

    world.say(MIR, "\U0001F916 Here is what is left on this alert", sender=ME)  # its own post with no record of it: known by its prefix
    assert tick(on, world)["answered"] == 0
    world.clock.advance(minutes=16)
    world.say(MIR, "and now?", sender=ME, under=top)
    assert tick(on, world)["answered"] == 1, "the count is for the last 15 minutes"


# ---------------------------------------------------------------------------------------------------------------
# Answers in an alert's thread
# ---------------------------------------------------------------------------------------------------------------

def test_an_answer_in_an_alerts_thread_knows_the_alert_and_burson_gets_the_fixed_answer_when_gemini_names_internals(on, world):
    switches(on, chat_questions=True)
    burson = space_of(on, "burson")
    alert = world.say(burson, ALERT.format(n=1))
    case = alert_case(on, world, burson)
    copy(on, world)
    on.ctx.llm.on("converse.answer", {"answer": "The bot auto-corrected it and SLRR will forward it to the analyst space.",
                                      "grounded": True, "sources": [f"live:{case.case_id}"]})
    world.say(burson, "Why is the exposure tag wrong?", sender=PAT, under=alert)
    assert tick(on, world)["held"] == 1
    call = next(c for c in reversed(on.ctx.llm.calls) if c["purpose"] == "converse.answer")
    assert "[This alert] (the alert this thread is about)" in call["prompt"] and "Correct values for this alert:" in call["prompt"]
    assert "Do not cite source labels" in call["system"] and case.case_id not in call["prompt"], "Burson reads no case ids"
    [kept] = on.ctx.store.list_docs(mirror.OWN_REPLIES)
    assert "SLRR" not in kept["text"] and "auto-correct" not in kept["text"]
    assert "This alert does not need any updates." in kept["text"] and "in review on our end" in kept["text"]

    copy(on, world)  # shown under the alert's copy in the second space
    assert world.messages[MIR][-1]["text"] == kept["text"] and world.messages[MIR][-1]["thread"]["name"] == world.messages[MIR][0]["thread"]["name"]


def test_an_answer_under_the_alerts_copy_in_the_second_space_knows_the_alert_too(on, world):
    switches(on, chat_questions=True)
    burson = space_of(on, "burson")
    world.say(burson, ALERT.format(n=1))
    case = alert_case(on, world, burson)
    copy(on, world)
    on.ctx.llm.on("converse.answer", {"answer": "Review and send the draft.", "grounded": True, "sources": [f"live:{case.case_id}"]})
    world.say(MIR, "What do I need to do on this one?", sender=PAT, under=world.messages[MIR][0]["name"])
    assert tick(on, world)["answered"] == 1
    call = next(c for c in reversed(on.ctx.llm.calls) if c["purpose"] == "converse.answer")
    assert f"[This alert] {case.case_id}" in call["prompt"] and "Its values:" in call["prompt"]
    assert "give a short checklist for that alert" in call["system"]
    assert rows(on)[0]["case_id"] == case.case_id
    assert world.messages[MIR][-1]["text"].endswith("Review and send the draft.")


def test_the_thread_of_an_alert_is_found_wherever_it_is_read(on, world):
    burson = space_of(on, "burson")
    world.say(burson, ALERT.format(n=1))
    case = alert_case(on, world, burson)
    copy(on, world)
    source_thread, copy_thread = world.messages[burson][0]["thread"]["name"], world.messages[MIR][0]["thread"]["name"]
    assert handler.case_for_thread(on.ctx, source_thread).case_id == case.case_id
    assert handler.case_for_thread(on.ctx, copy_thread).case_id == case.case_id, "the copy's thread stands for the alert's"
    assert handler.case_for_thread(on.ctx, "spaces/elsewhere/threads/zzz") is None and handler.case_for_thread(on.ctx, "") is None
    case.clean_message_ref = "spaces/clean/messages/kk1.kk1"
    on.ctx.store.save_case(case)
    assert handler.case_for_thread(on.ctx, "spaces/clean/threads/kk1").case_id == case.case_id, "its post for the analysts"


# ---------------------------------------------------------------------------------------------------------------
# Burson's space
# ---------------------------------------------------------------------------------------------------------------

def test_while_burson_is_to_hear_nothing_an_answer_is_never_written_there_even_when_the_space_is_open(on, world):
    burson = space_of(on, "burson")
    route(on, bot_on=True, source=burson, mirror="", safety_valve=False)
    on.ctx.config.burson_feedback.silent_in_burson_space = True
    world.say(burson, "<users/bot> what counts as high engagement?", sender=PAT, **mention())
    got = tick(on, world)
    assert (got["held"], got["answered"]) == (1, 0) and len(world.messages[burson]) == 1
    assert rows(on)[0]["why"] == chatanswers.SILENT_WHY

    on.ctx.config.burson_feedback.silent_in_burson_space = False
    world.say(burson, "<users/bot> and what about P0?", sender=PAT, **mention())
    assert tick(on, world)["answered"] == 1, "once Burson may hear it, the open space gets the answer in the thread"
    assert world.messages[burson][-1]["clientAssignedMessageId"].startswith("client-zrlo-")


def test_a_reply_posted_under_the_message_stays_the_callers_and_names_nobody(ctx, fake_llm):
    fake_llm.on("converse.answer", {"answer": "Alerts with 2,000+ engagements are HIGH ENGAGEMENT.", "grounded": True,
                                    "sources": ["collection_requirements"]})
    asker = "burson2@agency.test"
    msg = make_message("@Triage Agent what counts as high engagement?", sender_name="burson2", sender_email=asker,
                       sender_type="HUMAN", message_id="chat-in-thread", thread_id="spaces/x/threads/t1", **BURSON_SPACE)
    r = handle({"op": "converse", "payload": {"message": msg, "in_thread": True}, "context": {"flow": "chat"}}, ctx)
    assert r.outputs["has_burson"] == "no" and r.outputs["has_reply"] == "yes"
    assert asker not in r.outputs["reply_text"] and "Alerts with 2,000+" in r.outputs["reply_text"]
    assert "[Collection" not in r.outputs["reply_text"]


# ---------------------------------------------------------------------------------------------------------------
# The campaigns assistant
# ---------------------------------------------------------------------------------------------------------------

def _copied_alert(api, world) -> dict[str, Any]:
    burson = space_of(api, "burson")
    world.say(burson, ALERT.format(n=1))
    copy(api, world)
    return world.messages[MIR][0]


def test_a_request_for_a_deep_dive_hands_the_thread_to_the_campaigns_assistant(on, world):
    switches(on, campaign_handoff=True, chat_questions=True)
    root = _copied_alert(on, world)
    thread = root["thread"]["name"]
    asked = world.say(MIR, "Can you run a deep dive on this?", sender=PAT, under=root["name"])
    got = tick(on, world)
    assert (got["handed_off"], got["answered"]) == (1, 0)
    owned = on.ctx.store.get_doc(chatrules.OWNERSHIP, chatrules.ownership_id(thread))
    assert (owned["thread"], owned["space"], owned["source_message"], owned["requester"]) == (thread, MIR, asked, PAT["name"])
    assert owned["handled_initial"] is False and "Gemini" in owned["alert_text"]
    last = world.messages[MIR][-1]
    assert last["text"] == chatrules.HANDOFF_REPLY and last["thread"]["name"] == thread
    assert (rows(on)[0]["status"], rows(on)[0]["why"]) == ("answered", chatanswers.HANDED)
    assert on.get("/api/audit", action="chat.campaign_handoff").json()["entries"][0]["target_id"] == asked

    world.say(MIR, "@Triage Agent what is the status?", sender=PAT, under=root["name"])
    assert tick(on, world)["answered"] == 0, "the campaigns assistant's thread is left to it"


def test_gemini_decides_a_maybe_and_nothing_is_handed_over_with_the_switch_off(on, world):
    switches(on, chat_questions=True)
    root = _copied_alert(on, world)
    world.say(MIR, "Can you run a deep dive on this?", sender=PAT, under=root["name"])
    got = tick(on, world)
    assert got["handed_off"] == 0 and on.ctx.store.list_docs(chatrules.OWNERSHIP) == [], "OFF by default: nothing is handed over"

    switches(on, campaign_handoff=True)
    on.ctx.llm.on(chatanswers.PURPOSE_CAMPAIGN, {"route_to_campaigns": True})
    world.say(MIR, "Could we keep tracking this in brandwatch?", sender=PAT, under=root["name"])
    assert tick(on, world)["handed_off"] == 1
    assert [c for c in on.ctx.llm.calls if c["purpose"] == chatanswers.PURPOSE_CAMPAIGN], "Gemini was asked about the maybe"


def test_an_answer_for_burson_keeps_only_the_links_its_context_holds():
    from triage_agent.converse.answer import known_links_only

    context = "[Docs] Alert requirements: https://docs.example.com/requirements"
    said = ("The rule is in https://docs.example.com/requirements. See also https://made.up.example/x, "
            "<https://other.example/a|this guide> and [the requirements](https://docs.example.com/requirements).")
    assert known_links_only(said, context) == ("The rule is in https://docs.example.com/requirements. See also , this guide and "
                                               "<https://docs.example.com/requirements|the requirements>.")


def test_a_copy_of_someones_message_is_never_taken_for_the_account_owners_question(on, world):
    switches(on, chat_questions=True)
    world.say(MIR, "Pat (Burson): why was this alert sent back?", sender=ME)  # the bot's copy, with no record of it kept
    assert tick(on, world)["answered"] == 0 and world.writes == [] and rows(on) == []
