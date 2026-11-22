"""Queued posts carried by Pub/Sub to the QA chatbot's Chat sign-in.

With Pub/Sub delivery ON, a post is published when it is queued and posted as the bot's account as soon as the push
arrives: no Chat flow, no Apps Script, and no wait for the minute run. Pub/Sub tries a failed post again and sets it
aside after the last try; the minute run still posts whatever is left. Pub/Sub is the in-process bus the local store
uses (the same deliver, retry and dead-letter path); Google Chat is the stand-in from the Routing tests.
"""

from __future__ import annotations

from typing import Any

import pytest

from test_chat_delivery import IM1, on, rows, space_of, switches, tick, waiting  # noqa: F401 - fixtures
from test_console_api import ADMIN, IM, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_routing import route, world  # noqa: F401 - fixtures
from triage_agent import chatdelivery, pubsub
from triage_agent.events import PlatformEvent as P


@pytest.fixture
def pushed(on):
    """Posting through the Chat sign-in ON, and Pub/Sub delivery ON with its topic and its dead-letter topic set."""
    switches(on, pubsub_delivery=True)
    on.ctx.config.platform.pubsub.outbound_topic, on.ctx.config.platform.pubsub.dead_letter_topic = "outbound", "dead"
    return on


def states(api) -> list[pubsub.OutboundState]:
    return [pubsub.OutboundState.model_validate(d) for d in api.ctx.store.list_docs(pubsub.OUTBOUND, limit=100) if "action" in d]


def test_a_queued_post_goes_out_through_pubsub_as_soon_as_it_is_queued(pushed, world):
    clean = space_of(pushed, "clean")
    item = pushed.ctx.enqueue("clean", "A note for the analysts")
    assert world.texts(clean) == ["A note for the analysts"], "posted when the push arrived, before any minute run"
    assert pushed.ctx.doorbell.rings == [], "no Chat flow is rung"
    assert waiting(pushed) == [] and rows(pushed)[0]["status"] == "sent" and rows(pushed)[0]["message"] == world.messages[clean][0]["name"]
    [state] = states(pushed)
    assert state.action.kind == "outbox.deliver" and state.action.payload["outbox_id"] == item.outbox_id and state.status == "delivered"
    delivered = pushed.ctx.events.query(types=[P.OUTBOUND_DELIVERED])
    assert delivered and delivered[0].payload["note"] == "sent"
    assert tick(pushed, world)["sent"] == 0 and len(world.writes) == 1, "the minute run finds nothing left to post"


def test_a_direct_message_goes_out_through_pubsub_too(pushed, world):
    pushed.put("/api/platform/safety", {"value": {"testing": False}})
    dm = world.add_space("spaces/DMim1aaaaaa", "", kind="DIRECT_MESSAGE")
    world.dms[IM1] = dm
    pushed.ctx.enqueue("dm", "Review TRG-1001 when you can.", recipients=[IM1])
    assert world.texts(dm) == ["Review TRG-1001 when you can."] and waiting(pushed) == []


def test_a_post_chat_does_not_take_is_tried_again_and_set_aside_after_the_last_try(pushed, world):
    clean = space_of(pushed, "clean")
    world.fail_posts_to.add(clean)
    item = pushed.ctx.enqueue("clean", "A note for the analysts")
    assert world.writes == [] and [i.outbox_id for i in waiting(pushed)] == [item.outbox_id], "nothing is lost: it stays queued"
    [dead] = pubsub.list_dead_letters(pushed.ctx)
    assert dead["action"]["payload"]["outbox_id"] == item.outbox_id and dead["attempts"] == pushed.ctx.config.platform.pubsub.max_delivery_attempts
    assert "Chat did not take the post" in dead["last_error"]
    world.fail_posts_to.clear()
    assert tick(pushed, world)["sent"] == 1 and world.texts(clean) == ["A note for the analysts"], "the minute run posts it once Chat is back"
    pubsub.replay(pushed.ctx, dead["action"]["action_id"], ADMIN)
    assert len(world.writes) == 1, "replaying the one that was set aside does not post it a second time"


def test_a_post_the_rules_hold_is_not_pushed_again(pushed, world):
    pushed.ctx.enqueue("burson", "The outbox relay in the SLRR mirror space will resend this.")
    assert world.writes == [] and waiting(pushed) == []
    assert rows(pushed)[0]["status"] == "held" and pubsub.list_dead_letters(pushed.ctx) == []
    assert [(s.status, s.attempts) for s in states(pushed)] == [("delivered", 1)], "held is a finished answer, not a failure to retry"


def test_while_the_qa_chatbot_is_off_a_pushed_post_waits_for_the_minute_run(pushed, world):
    route(pushed, bot_on=False)
    item = pushed.ctx.enqueue("clean", "A note for the analysts")
    assert world.writes == [] and [i.outbox_id for i in waiting(pushed)] == [item.outbox_id]
    assert pubsub.list_dead_letters(pushed.ctx) == [], "waiting is not a failure"
    route(pushed, bot_on=True)
    assert tick(pushed, world)["sent"] == 1


def test_the_push_and_the_minute_run_never_post_the_same_one_twice(on, world):
    item = on.ctx.enqueue("clean", "A note for the analysts")
    assert chatdelivery.claim(on.ctx, item.outbox_id), "the push has it in hand"
    assert tick(on, world)["sent"] == 0 and world.writes == [], "the minute run leaves it alone"
    assert chatdelivery.post_now(on.ctx, item) == "in hand elsewhere"
    chatdelivery.release(on.ctx, item.outbox_id)
    assert tick(on, world)["sent"] == 1 and len(world.writes) == 1


def test_when_the_publish_fails_the_post_waits_for_the_minute_run(pushed, world):
    class Down:
        name = "pubsub"

        def publish(self, topic: str, data: dict[str, Any], attributes: dict[str, str] | None = None) -> str:
            raise RuntimeError("503 Pub/Sub is unavailable")

    pushed.ctx.publisher = Down()
    item = pushed.ctx.enqueue("clean", "A note for the analysts")
    assert world.writes == [] and [i.outbox_id for i in waiting(pushed)] == [item.outbox_id]
    assert pushed.ctx.doorbell.rings == [], "no Chat flow is rung in its place"
    pushed.ctx.publisher = None
    assert tick(pushed, world)["sent"] == 1


def test_with_pubsub_delivery_off_nothing_is_published_and_the_minute_run_posts(on, world):
    on.ctx.enqueue("clean", "A note for the analysts")
    assert states(on) == [] and world.writes == []
    assert tick(on, world)["sent"] == 1
