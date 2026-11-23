"""The QA chatbot's replies land where the message they answer is.

A reply meant for the source space (Burson's) answers one alert, so it belongs in that alert's thread. While the source
is open it is posted there. While it is closed (the Safety valve, or a second space set) nothing is written in the
source, and with a second space set the reply is shown under the alert's copy in the second and third spaces, as the
sheet-based bot shows its Burson replies in its Mirror space.

Google Chat is the in-memory stand-in from the Routing tests (no network). The queue, the guards, the routing rules and
the delivery are the real code.
"""

from __future__ import annotations

from test_chat_delivery import on, space_of, waiting  # noqa: F401 - fixtures
from test_chat_delivery import tick as deliver
from test_console_api import IM, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_routing import ALERT, MIR, THIRD, route, world  # noqa: F401 - fixtures
from test_routing import tick as copy
from triage_agent import mirror, operations
from triage_agent.models import ChatOutputs, OperationRequest, RequestContext

REPLY = "Please update the link on this alert and resend it. Thank you."


def thread_of(world, space: str, message: str) -> str:
    return next(m["thread"]["name"] for m in world.messages[space] if m["name"] == message)


def reviewed(ctx, space: str, message: str, thread: str, outputs: ChatOutputs):
    """What an operation's outputs become once a review of that Chat message hands them over to be queued. The bot
    is set to speak to Burson (silent_in_burson_space OFF), so what it has to say to Burson is not folded into the
    team's post."""
    ctx.config.burson_feedback.silent_in_burson_space = False
    req = OperationRequest(op="triage_message", context=RequestContext(deliver="outbox", flow="chat", invoked_by="agent"),
                           payload={"message": {"message_id": message, "text": "an alert", "space_id": space, "thread_id": thread}})
    return operations._finalize(ctx, req, outputs, {})


def test_a_reply_for_the_open_source_space_is_posted_in_the_thread_of_the_alert_it_answers(on, world):
    burson = space_of(on, "burson")
    route(on, bot_on=True, source=burson, safety_valve=False)
    world.say(burson, ALERT.format(n=1))
    alert = world.say(burson, ALERT.format(n=2))
    thread = thread_of(world, burson, alert)
    _, data = reviewed(on.ctx, burson, alert, thread, ChatOutputs(burson_text=REPLY, clean_text="A corrected alert for the team."))
    assert not data.get("held_outputs")
    queued = {i.target: i.thread for i in waiting(on)}
    assert queued == {"burson": thread, "clean": None}, "only the post for the space the alert is in answers its thread"

    assert deliver(on, world)["sent"] == 2
    posted = world.messages[burson][-1]
    assert posted["text"] == REPLY and posted["thread"]["name"] == thread and posted["threadReply"] is True
    assert world.messages[space_of(on, "clean")][-1].get("threadReply") is None, "the corrected alert is a new message, as before"

    clean = space_of(on, "clean")
    said = world.say(clean, "Is this one a duplicate?")
    reviewed(on.ctx, clean, said, thread_of(world, clean, said), ChatOutputs(burson_text=REPLY))
    assert [i.thread for i in waiting(on)] == [None], "a message in another space lends its thread to nothing in the source space"


def test_a_reply_that_waits_for_a_persons_send_keeps_its_thread(on, world):
    burson = space_of(on, "burson")
    route(on, bot_on=True, source=burson, safety_valve=False, ask_before_source=True)
    alert = world.say(burson, ALERT.format(n=1))
    thread = thread_of(world, burson, alert)
    _, data = reviewed(on.ctx, burson, alert, thread, ChatOutputs(burson_text=REPLY))
    assert [h["check"] for h in data["held_outputs"]] == ["waits_for_send"]
    [asked] = mirror.queue(on.ctx)
    assert asked["thread"] == thread
    mirror.decide(on.ctx, asked["id"], "send", IM)
    assert world.messages[burson][-1]["text"] == REPLY and world.messages[burson][-1]["thread"]["name"] == thread

    on.ctx.enqueue("burson", "Thank you, the resend is in.", thread=thread)  # queued by something that is not a review
    deliver(on, world)
    [asked] = mirror.queue(on.ctx)
    assert asked["text"] == "Thank you, the resend is in." and asked["thread"] == thread


def test_with_the_source_closed_the_reply_is_shown_under_the_alerts_copy_in_the_second_and_third_spaces(on, world):
    burson = space_of(on, "burson")
    route(on, bot_on=True, source=burson, mirror=MIR, third=THIRD)
    assert on.ctx.config.platform.safety.testing is True
    world.say(burson, ALERT.format(n=1))
    alert = world.say(burson, ALERT.format(n=2))
    thread = thread_of(world, burson, alert)
    copy(on, world)
    assert world.texts(MIR) == world.texts(THIRD) == [ALERT.format(n=1), ALERT.format(n=2)]

    _, data = reviewed(on.ctx, burson, alert, thread, ChatOutputs(burson_text=REPLY, clean_text="A corrected alert for the team.", case_id="TRG-1"))
    assert [(h["target"], h["check"], h["copied_to"]) for h in data["held_outputs"]] == [("burson", "safety_valve", "the second space")]
    assert [i.target for i in waiting(on)] == ["clean"], "nothing for the source space is queued: no flow and no delivery can post it there"

    got = copy(on, world)
    assert got["ok"] and got["replies"] == 1
    assert world.texts(burson) == [ALERT.format(n=1), ALERT.format(n=2)], "nothing is written in the source space"
    for space in (MIR, THIRD):
        under, last = world.messages[space][1], world.messages[space][-1]
        assert last["text"] == REPLY and last["thread"]["name"] == under["thread"]["name"] and last["threadReply"] is True
        assert last["clientAssignedMessageId"].startswith("client-bqa-"), "known as the bot's own post, so it is never read as an alert or copied"
    assert copy(on, world)["replies"] == 0 and len(world.messages[MIR]) == 3 and len(world.messages[THIRD]) == 3, "never twice"

    [row] = on.get("/api/routing", user=IM).json()["replies"]
    assert (row["text"], row["status"], row["case_id"]) == (REPLY, "posted", "TRG-1") and row["mirror"] and row["third"]
    entry = on.get("/api/audit", action="routing.reply_copied").json()["entries"][0]
    assert entry["case_id"] == "TRG-1" and entry["summary"] == "Posted the bot's reply for the source space in the second space"


def test_with_the_source_closed_and_no_second_space_the_reply_is_held_and_kept_nowhere(on, world):
    burson = space_of(on, "burson")
    route(on, bot_on=True, source=burson)
    alert = world.say(burson, ALERT.format(n=1))
    _, data = reviewed(on.ctx, burson, alert, thread_of(world, burson, alert), ChatOutputs(burson_text=REPLY))
    assert [(h["target"], h["check"], h.get("copied_to")) for h in data["held_outputs"]] == [("burson", "safety_valve", None)]
    assert on.ctx.store.list_docs(mirror.OWN_REPLIES) == [] and waiting(on) == []
    assert mirror.reply_in_copies(on.ctx, REPLY, thread="spaces/x/threads/t") is None and on.ctx.store.list_docs(mirror.OWN_REPLIES) == [], \
        "with no second space there is nowhere to show it, whoever asks"


def test_a_reply_waits_for_its_alerts_copy_and_is_given_up_after_a_day(on, world):
    burson = space_of(on, "burson")
    route(on, bot_on=True, source=burson, mirror=MIR)
    alert = world.say(burson, ALERT.format(n=1))
    thread = thread_of(world, burson, alert)
    world.clock.advance(minutes=40)  # the alert is older than where copying starts, so it never reaches the second space
    route(on, bot_on=True, source=burson, mirror=MIR, copy_everything=False)
    reviewed(on.ctx, burson, alert, thread, ChatOutputs(burson_text=REPLY))
    assert copy(on, world)["replies"] == 0 and world.texts(MIR) == [], "it is not posted out of place, on its own"
    [row] = on.get("/api/routing", user=IM).json()["replies"]
    assert row["status"] == "waiting"

    world.clock.advance(hours=24)
    assert copy(on, world)["replies"] == 0 and world.texts(MIR) == []
    [row] = on.get("/api/routing", user=IM).json()["replies"]
    assert row["status"] == "gave_up" and row["why"] == "The message it answers never reached the second space."


def test_a_reply_that_names_something_internal_is_not_shown_in_the_second_space(on, world):
    burson = space_of(on, "burson")
    leak = "We will forward this to the analyst space; the bot auto-corrected it."
    route(on, bot_on=True, source=burson, mirror=MIR)
    alert = world.say(burson, ALERT.format(n=1))
    copy(on, world)
    _, data = reviewed(on.ctx, burson, alert, thread_of(world, burson, alert), ChatOutputs(burson_text=leak))
    [held] = data["held_outputs"]
    assert held["check"] == "safety_valve" and held["hits"] and "copied_to" not in held, "it would not have gone to the source space either"
    assert on.ctx.store.list_docs(mirror.OWN_REPLIES) == []

    route(on, bot_on=True, source=burson, mirror="", safety_valve=False, ask_before_source=True)
    _, data = reviewed(on.ctx, burson, alert, thread_of(world, burson, alert), ChatOutputs(burson_text=leak))
    assert [h["check"] for h in data["held_outputs"]] == ["leak_guard"] and "copied_to" not in data["held_outputs"][0]
    assert on.ctx.store.list_docs(mirror.OWN_REPLIES) == [] and mirror.queue(on.ctx) == []


def test_a_second_space_reply_older_than_its_keep_days_is_removed(on, world):
    burson = space_of(on, "burson")
    route(on, bot_on=True, source=burson, mirror=MIR)
    alert = world.say(burson, ALERT.format(n=1))
    copy(on, world)
    reviewed(on.ctx, burson, alert, thread_of(world, burson, alert), ChatOutputs(burson_text=REPLY))
    copy(on, world)
    assert len(on.ctx.store.list_docs(mirror.OWN_REPLIES)) == 1
    from triage_agent import retention

    world.clock.advance(days=on.ctx.config.platform.routing.keep_days + 1)
    retention.run(on.ctx)
    assert on.ctx.store.list_docs(mirror.OWN_REPLIES) == []
