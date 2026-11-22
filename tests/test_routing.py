"""Routing: which Chat space the QA chatbot reads, where it copies it, and when it may write back.

Google Chat is replaced by an in-memory stand-in that answers the REST calls the bot makes (no network). The
settings, the copy engine, the write guard and the Console routes are the real ones.
"""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

import pytest

from test_console_api import ADMIN, IM, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from triage_agent import chatapi, mirror, safety
from triage_agent.models import ChatOutputs

SRC, MIR, THIRD, OUT = "spaces/SRCaaaaaaaa", "spaces/MIRbbbbbbbb", "spaces/THDcccccccc", "spaces/OUTdddddddd"
ZAP = {"name": "users/zap", "type": "BOT", "displayName": "Zapier"}
PAT = {"name": "users/111", "type": "HUMAN"}   # Chat gives a person's id and nothing else to a signed-in account
ALERT = "*New Alert* - Gemini\nSomeone says Gemini made up a citation.\nhttps://x.example/post/{n}"


class _Resp:
    def __init__(self, status: int, body: dict[str, Any]):
        self.status_code, self._body, self.text = status, body, str(body)

    def json(self) -> dict[str, Any]:
        return self._body


class ChatWorld:
    """Spaces, their messages in order, threads and emojis, as the bot's account sees and changes them."""

    def __init__(self, ctx):
        self.ctx, self.spaces, self.messages, self.reactions = ctx, {}, {}, {}
        self.dms: dict[str, str] = {}  # a person's address -> the direct message space the bot's account has with them
        self.writes: list[tuple[str, str]] = []
        self.fail_posts_to: set[str] = set()
        self.n = 0
        for space, name, external in ((SRC, "[S-F] Burson Automated Alerts V3", True), (MIR, "Burson mirror", False),
                                      (THIRD, "Burson third", False), (OUT, "Vendor room", True)):
            self.spaces[space] = {"name": space, "displayName": name, "externalUserAllowed": external, "spaceType": "SPACE"}
            self.messages[space] = []

    def add_space(self, space: str, name: str, external: bool = False, kind: str = "SPACE") -> str:
        self.spaces[space] = {"name": space, "displayName": name, "externalUserAllowed": external, "spaceType": kind}
        self.messages[space] = []
        return space

    def say(self, space: str, text: str, sender: dict = ZAP, under: str = "", **extra: Any) -> str:
        self.n += 1
        name = f"{space}/messages/m{self.n}"
        root = next((m for m in self.messages[space] if m["name"] == under), None)
        msg = {"name": name, "text": text, "sender": dict(sender), "createTime": self.ctx.now().isoformat(),
               "thread": {"name": root["thread"]["name"] if root else f"{space}/threads/t{self.n}"}, **extra}
        if root:
            msg["threadReply"] = True
        self.messages[space].append(msg)
        return name

    def emoji(self, message: str, emoji: str, user: str = "users/111") -> None:
        self.reactions.setdefault(message, []).append((user, emoji))

    def texts(self, space: str) -> list[str]:
        return [m["text"] for m in self.messages[space]]

    def _view(self, m: dict) -> dict:
        sums: dict[str, int] = {}
        for _, e in self.reactions.get(m["name"], []):
            sums[e] = sums.get(e, 0) + 1
        return {**m, "emojiReactionSummaries": [{"emoji": {"unicode": e}, "reactionCount": c} for e, c in sums.items()]}

    def request(self, method: str, url: str, params: dict[str, Any] | None = None, json: Any = None, timeout: int = 0):
        path, params = url.split("/v1/")[1], dict(params or {})
        if method == "GET" and path == "spaces:findDirectMessage":
            found = self.dms.get(str(params.get("name", "")).removeprefix("users/"))
            return _Resp(200, self.spaces[found]) if found else _Resp(404, {"error": {"message": "Direct message not found"}})
        space = "/".join(path.split("/")[:2])
        if space not in self.spaces:
            return _Resp(403, {"error": {"message": "The caller does not have permission"}})
        if method == "GET" and path == space:
            return _Resp(200, self.spaces[space])
        if method == "GET" and path.endswith("/messages"):
            since = re.search(r'create_time > "([^"]+)"', params.get("filter", ""))
            rows = [self._view(m) for m in self.messages[space] if not since or m["createTime"] > since.group(1)]
            return _Resp(200, {"messages": rows})
        if method == "GET" and "/messages/" in path:
            found = next((m for m in self.messages[space] if path in (m["name"], f"{space}/messages/{m.get('clientAssignedMessageId')}")), None)
            return _Resp(200, self._view(found)) if found else _Resp(404, {"error": {"message": "not found"}})
        if method == "POST" and path.endswith("/messages"):
            if space in self.fail_posts_to:
                return _Resp(500, {"error": {"message": "Chat is having trouble"}})
            custom = params.get("messageId", "")
            if custom and any(m.get("clientAssignedMessageId") == custom for m in self.messages[space]):
                return _Resp(409, {"error": {"message": "already exists"}})
            thread = (json.get("thread") or {}).get("name", "")
            root = next((m for m in self.messages[space] if m["thread"]["name"] == thread), None)
            name = self.say(space, json["text"], sender={"name": "users/bot", "type": "HUMAN"}, under=root["name"] if root else "",
                            **({"clientAssignedMessageId": custom} if custom else {}))
            self.writes.append((space, json["text"]))
            return _Resp(200, self._view(self.messages[space][-1]) | {"name": name})
        if method == "POST" and path.endswith("/reactions"):
            message, emoji = path.rsplit("/reactions", 1)[0], json["emoji"]["unicode"]
            if ("users/bot", emoji) in self.reactions.get(message, []):
                return _Resp(409, {"error": {"message": "already reacted"}})
            self.reactions.setdefault(message, []).append(("users/bot", emoji))
            self.writes.append((space, f"emoji {emoji}"))
            return _Resp(200, {})
        return _Resp(404, {"error": {"message": f"no route for {method} {path}"}})


class Clock:
    def __init__(self, start):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, **kw: Any) -> None:
        self.now += timedelta(**kw)


@pytest.fixture
def world(api, monkeypatch):
    clock = Clock(api.ctx.now())
    api.ctx.now = clock
    w = ChatWorld(api.ctx)
    w.clock = clock
    monkeypatch.setattr(chatapi, "session_for", lambda ctx: w)
    monkeypatch.setattr(chatapi.time, "sleep", lambda s: None)  # a failing call is tried again without the wait
    return w


def route(api, **values: Any) -> dict:
    r = api.put("/api/routing", {"value": values})
    assert r.status_code == 200, r.text
    return r.json()


def tick(api, world) -> dict:
    world.clock.advance(minutes=1)
    return mirror.run(api.ctx)


# ---------------------------------------------------------------------------------------------------------------
# The rule: when the QA chatbot may write in the source space
# ---------------------------------------------------------------------------------------------------------------

def test_a_new_install_reads_and_writes_nothing_in_chat(api, world):
    state = api.get("/api/routing", user=IM).json()
    assert state["value"] == {"bot_on": False, "source": "", "mirror": "", "third": "", "copy_everything": False,
                              "ask_before_source": False}
    assert state["safety_valve"] is True, "the Safety valve starts ON"
    assert state["mode"] == {"live": False, "why": "the QA chatbot is OFF"}
    world.say(SRC, ALERT.format(n=1))
    assert mirror.run(api.ctx)["off"] is True and world.writes == []


@pytest.mark.parametrize("values, valve, live, why", [
    ({"bot_on": True, "source": SRC}, True, False, "the Safety valve is ON"),
    ({"bot_on": True, "source": SRC, "mirror": MIR}, False, False, "a second space is set, so writes go there and not to the source space"),
    ({"bot_on": True, "source": ""}, False, False, "no source space is set"),
    ({"bot_on": False, "source": SRC}, False, False, "the QA chatbot is OFF"),
    ({"bot_on": True, "source": SRC}, False, True, ""),
])
def test_the_source_is_written_only_with_the_bot_on_the_valve_off_and_no_second_space(api, world, values, valve, live, why):
    api.put("/api/platform/safety", {"value": {"testing": valve}})
    state = route(api, **values)
    assert state["mode"] == {"live": live, "why": why}
    client = chatapi.client_for(api.ctx)
    if live:
        assert client.post_message(SRC, "Thanks, on it.")["name"] and world.writes == [(SRC, "Thanks, on it.")]
    elif values["source"]:
        with pytest.raises(chatapi.Refused, match="source space"):
            client.post_message(SRC, "Thanks, on it.")
        with pytest.raises(chatapi.Refused):
            client.react(world.say(SRC, ALERT.format(n=9)), "✅")
        assert world.writes == []


def test_a_space_outsiders_can_join_is_never_written_unless_it_is_the_open_source(api, world):
    api.put("/api/platform/safety", {"value": {"testing": False}})
    route(api, bot_on=True, source=SRC)
    client = chatapi.client_for(api.ctx)
    with pytest.raises(chatapi.Refused, match="outside Google"):
        client.post_message(OUT, "hello")
    assert client.post_message(MIR, "a note for the team")["name"], "a Google-only space is fine"
    assert world.writes == [(MIR, "a note for the team")]


def test_with_ask_first_on_a_message_for_the_source_waits_for_send_or_skip(api, world):
    api.put("/api/platform/safety", {"value": {"testing": False}})
    route(api, bot_on=True, source=SRC, ask_before_source=True)
    with pytest.raises(chatapi.Refused, match="Send"):
        chatapi.client_for(api.ctx).post_message(SRC, "straight in")
    first = mirror.send(api.ctx, "Thanks, on it.", origin="test")
    second = mirror.send(api.ctx, "Not needed after all.", origin="test")
    assert first["status"] == second["status"] == "waiting" and world.writes == []
    waiting = api.get("/api/routing", user=IM).json()["queue"]
    assert [q["text"] for q in waiting] == ["Thanks, on it.", "Not needed after all."]

    assert api.post(f"/api/routing/queue/{first['id']}", {"action": "send"}, user=VIEWER).status_code == 403
    sent = api.post(f"/api/routing/queue/{first['id']}", {"action": "send"}, user=IM).json()
    assert sent["status"] == "sent" and world.writes == [(SRC, "Thanks, on it.")]
    assert world.messages[SRC][-1]["clientAssignedMessageId"].startswith("client-zrlo-")
    assert api.post(f"/api/routing/queue/{second['id']}", {"action": "skip"}, user=IM).json()["status"] == "skipped"
    assert api.post(f"/api/routing/queue/{first['id']}", {"action": "send"}, user=IM).status_code == 409, "sent once"
    assert world.writes == [(SRC, "Thanks, on it.")] and api.get("/api/routing").json()["queue"] == []
    acts = [e["action"] for e in api.get("/api/audit", action="routing.").json()["entries"]]
    assert acts.count("routing.send") == 1 and acts.count("routing.skip") == 1

    third = mirror.send(api.ctx, "Later.", origin="test")
    api.put("/api/platform/safety", {"value": {"testing": True}})
    r = api.post(f"/api/routing/queue/{third['id']}", {"action": "send"}, user=IM)
    assert r.status_code == 409 and "Safety valve" in r.json()["error"] and len(world.writes) == 1, "the valve wins over Send"


def test_what_the_agent_wants_posted_in_the_source_is_held_while_the_valve_is_on(api, world):
    def burson_is_the_source() -> None:  # the agent's "burson" post target points at the same space (a save reloads the settings)
        ref = api.ctx.config.space("burson")
        ref.url, ref.space_id = "", SRC

    route(api, bot_on=True, source=SRC)
    burson_is_the_source()
    out, held = safety.guard_outputs(api.ctx, ChatOutputs(burson_text="Thanks, on it.", clean_text="for the team"), op="test")
    assert out.burson_text == "" and out.clean_text == "for the team"
    assert [(h["target"], h["check"]) for h in held] == [("burson", "safety_valve")]

    api.put("/api/platform/safety", {"value": {"testing": False}})
    burson_is_the_source()
    out, held = safety.guard_outputs(api.ctx, ChatOutputs(burson_text="Thanks, on it."), op="test")
    assert out.burson_text == "Thanks, on it." and held == [], "open: it goes out as before"

    route(api, bot_on=True, source=SRC, ask_before_source=True)
    burson_is_the_source()
    out, held = safety.guard_outputs(api.ctx, ChatOutputs(burson_text="Thanks, on it."), op="test")
    assert out.burson_text == "" and [h["check"] for h in held] == ["waits_for_send"]
    assert [q["text"] for q in api.get("/api/routing").json()["queue"]] == ["Thanks, on it."]


# ---------------------------------------------------------------------------------------------------------------
# The copy: source -> mirror -> third, message for message, in order
# ---------------------------------------------------------------------------------------------------------------

def test_alerts_are_copied_to_the_mirror_in_order_once_and_nothing_is_written_to_the_source(api, world):
    route(api, bot_on=True, source=SRC, mirror=MIR)
    world.say(SRC, "an alert from before the mirror was set")
    world.clock.advance(minutes=20)
    route(api, bot_on=True, source=SRC, mirror=MIR, copy_everything=False)
    assert tick(api, world)["copied"] == {"mirror": 0, "third": 0}, "starts from the last 15 minutes"
    a = world.say(SRC, ALERT.format(n=1) + "\nZap sent by @Someone")
    world.clock.advance(seconds=20)
    world.say(SRC, "Has anyone looked at this?", sender=PAT, under=a)
    world.say(SRC, "Morning all", sender=PAT)
    world.clock.advance(seconds=20)
    world.say(SRC, ALERT.format(n=2))
    result = tick(api, world)
    assert result["ok"] and result["copied"] == {"mirror": 2, "third": 0}
    assert world.texts(MIR) == [ALERT.format(n=1), ALERT.format(n=2)], "exact text, without Zapier's credit line; people's messages stay"
    assert all(m["clientAssignedMessageId"].startswith("client-zmir-") for m in world.messages[MIR])
    assert tick(api, world)["copied"] == {"mirror": 0, "third": 0} and len(world.messages[MIR]) == 2, "never twice"
    assert {space for space, _ in world.writes} == {MIR}
    rows = api.get("/api/routing", user=IM).json()["copies"]
    assert [(r["what"], r["status"], bool(r["mirror"])) for r in rows] == [("alert", "copied", True)] * 2


def test_with_copy_everything_on_replies_messages_and_emojis_come_over_into_the_right_thread(api, world):
    route(api, bot_on=True, source=SRC, mirror=MIR, copy_everything=True)
    a = world.say(SRC, ALERT.format(n=1))
    world.clock.advance(seconds=5)
    world.say(SRC, "Has anyone looked at this?", sender=PAT, under=a)
    world.clock.advance(seconds=5)
    world.say(SRC, "Morning all", sender=PAT)
    world.say(SRC, "an app's reply", sender={"name": "users/app2", "type": "BOT"}, under=a)
    tick(api, world)
    assert world.texts(MIR) == [ALERT.format(n=1), "Someone: Has anyone looked at this?", "Someone: Morning all"]
    alert_copy, reply_copy, own = world.messages[MIR]
    assert reply_copy["thread"] == alert_copy["thread"] and reply_copy.get("threadReply") and own["thread"] != alert_copy["thread"]

    people = api.get("/api/routing").json()["people"]
    assert [(p["user"], p["name"], p["org"]) for p in people] == [("users/111", "", "")]
    assert api.put("/api/routing/people", {"user": "users/111", "name": "Pat Lee", "org": "Burson"}, user=IM).status_code == 403
    assert api.put("/api/routing/people", {"user": "users/111", "name": "Pat Lee", "org": "Burson"}).status_code == 200
    world.clock.advance(seconds=5)
    world.say(SRC, "Any update?", sender=PAT, under=a)
    world.emoji(a, "👀")
    world.emoji(a, "👀", user="users/222")
    tick(api, world)
    assert world.texts(MIR)[-1] == "Pat Lee (Burson): Any update?"
    assert world.reactions[alert_copy["name"]] == [("users/bot", "👀")], "each emoji once, as the bot's account"
    tick(api, world)
    assert world.reactions[alert_copy["name"]] == [("users/bot", "👀")]


def test_the_third_space_gets_what_reached_the_mirror_in_the_same_order_and_threads(api, world):
    route(api, bot_on=True, source=SRC, mirror=MIR, third=THIRD, copy_everything=True)
    a = world.say(SRC, ALERT.format(n=1))
    world.clock.advance(seconds=5)
    world.say(SRC, "Looking now", sender=PAT, under=a)
    world.clock.advance(seconds=5)
    world.say(SRC, ALERT.format(n=2))
    world.emoji(a, "✅")
    assert tick(api, world)["copied"] == {"mirror": 3, "third": 3}
    assert world.texts(THIRD) == world.texts(MIR) == [ALERT.format(n=1), "Someone: Looking now", ALERT.format(n=2)]
    first, reply, _ = world.messages[THIRD]
    assert reply["thread"] == first["thread"] and world.reactions[first["name"]] == [("users/bot", "✅")]
    assert SRC not in {space for space, _ in world.writes}


def test_a_copy_space_that_is_the_source_or_lets_outsiders_in_is_refused(api, world):
    state = route(api, bot_on=True, source=SRC, mirror=OUT, third=SRC)
    assert "outside Google" in state["problems"]["mirror"] and "source space" in state["problems"]["third"]
    world.say(SRC, ALERT.format(n=1))
    result = tick(api, world)
    assert result["copied"] == {"mirror": 0, "third": 0} and world.writes == []
    state = route(api, bot_on=True, source=SRC, mirror=MIR, third=MIR)
    assert state["problems"]["mirror"] == "" and "same space" in state["problems"]["third"]


def test_a_message_that_cannot_be_copied_holds_the_rest_and_is_given_up_after_five_tries(api, world):
    route(api, bot_on=True, source=SRC, mirror=MIR)
    world.say(SRC, ALERT.format(n=1))
    world.clock.advance(seconds=5)
    world.say(SRC, ALERT.format(n=2))
    world.fail_posts_to.add(MIR)
    for _ in range(4):
        assert tick(api, world)["copied"]["mirror"] == 0
    assert world.texts(MIR) == [], "the second alert waits behind the first"
    tick(api, world)
    rows = {r["text"]: r for r in api.get("/api/routing").json()["copies"]}
    assert rows[ALERT.format(n=1)]["status"] == "gave_up" and "Chat is having trouble" in rows[ALERT.format(n=1)]["why"]
    world.fail_posts_to.clear()
    tick(api, world)
    assert world.texts(MIR) == [ALERT.format(n=2)]


# ---------------------------------------------------------------------------------------------------------------
# The Console's side
# ---------------------------------------------------------------------------------------------------------------

def test_only_an_admin_changes_routing_and_every_change_is_on_the_record(api, world):
    assert api.put("/api/routing", {"value": {"bot_on": True}}, user=IM).status_code == 403
    state = route(api, bot_on=True, source="https://mail.google.com/chat/u/0/#chat/space/SRCaaaaaaaa", mirror="MIRbbbbbbbb")
    assert state["value"]["source"] == SRC and state["value"]["mirror"] == MIR, "a link or a bare id becomes the space"
    assert state["spaces"]["source"] == {"space": SRC, "name": "[S-F] Burson Automated Alerts V3", "external": True, "error": ""}
    assert state["spaces"]["mirror"]["name"] == "Burson mirror" and state["spaces"]["third"] is None
    entry = api.get("/api/audit", action="routing.").json()["entries"][0]
    assert entry["action"] == "routing.save" and entry["actor"] == ADMIN
    r = api.put("/api/routing", {"value": {"source": "not a space"}})
    assert r.status_code == 422 and "link" in r.json()["error"]
    state = route(api, source="spaces/NOPEeeeeeee")
    assert "can't open" in state["spaces"]["source"]["error"]


def test_the_copy_runs_in_the_once_a_minute_tick(api, world):
    from triage_agent.platform_jobs import run_job

    route(api, bot_on=True, source=SRC, mirror=MIR)
    world.say(SRC, ALERT.format(n=1))
    world.clock.advance(minutes=1)
    assert run_job(api.ctx, "maintenance")["jobs"]["routing"]["copied"]["mirror"] == 1
    assert api.get("/api/routing").json()["last_run"]["ok"] is True


def test_the_safety_valve_is_set_from_the_routing_page_and_the_other_safety_settings_stay(api, world):
    api.put("/api/platform/safety", {"value": {"testing": True, "testing_recipients": ["tester@ops.test"]}})
    state = route(api, bot_on=True, source=SRC, safety_valve=False)
    assert state["safety_valve"] is False and state["mode"]["live"] is True
    safety_now = api.ctx.config.platform.safety
    assert safety_now.testing is False and safety_now.testing_recipients == ["tester@ops.test"]
    assert route(api, safety_valve=True)["mode"] == {"live": False, "why": "the Safety valve is ON"}
