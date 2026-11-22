"""The QA chatbot is not a Chat app.

It reaches Chat the way the sheet-based bot does (apps-script-chat-bot/Chat.gs): as its own account, signed in, through
the Chat API of a project where that API is on. No Chat app is set up for it, so nothing here may depend on one: not the
setup steps, not what Chat does with custom message ids, and not the words shown when Chat turns a call away.
Google Chat is the in-memory stand-in from the Routing tests.
"""

from __future__ import annotations

import re
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from conftest import GOOD_ALERT
from console.backend import connections
from test_console_api import ADMIN, IM, VIEWER, api, console_ctx, seeded  # noqa: F401 - fixtures
from test_platform import assess_ok
from test_routing import SRC, _Resp, route, world  # noqa: F401 - fixtures
from triage_agent import chatapi, chatreview, retention

ROOT = Path(__file__).resolve().parents[1]
NOT_FOUND = "Google Chat app not found. To create a Chat app, you must turn on the Chat API and configure the app in the Google Cloud console."


class OtherProject:
    """Chat answering a sign-in that was made in a project it takes no calls from."""

    def request(self, method: str, url: str, params: Any = None, json: Any = None, timeout: int = 0) -> _Resp:
        return _Resp(404, {"error": {"code": 404, "message": NOT_FOUND, "status": "NOT_FOUND"}})


@pytest.fixture
def live(api, world):
    """The QA chatbot ON and free to write in the source space, and Chat taking no custom message ids."""
    api.put("/api/platform/safety", {"value": {"testing": False}})
    route(api, bot_on=True, source=SRC)
    world.refuse_custom_ids = True
    return api


# -- setup ----------------------------------------------------------------------------------------------------------
def test_the_sign_in_steps_ask_for_no_chat_app():
    script = (ROOT / "infra/08_gmail_oauth.sh").read_text(encoding="utf-8")
    assert "Configuration" not in script and "Avatar" not in script, "nothing is filled in on the Chat API's Configuration page"
    assert "not a Chat app" in script
    lines = script.splitlines()
    last_note = max(i for i, line in enumerate(lines[: lines.index("set -euo pipefail")], 1) if line.startswith("#"))
    shown = re.search(r"sed -n '2,(\d+)p' \"\$0\"", script)
    assert shown and int(shown.group(1)) == last_note, "run with no file, the script prints its whole note and nothing after it"


# -- what Chat says when it turns the sign-in's project away --------------------------------------------------------
def test_chat_turning_the_sign_ins_project_away_is_said_in_plain_words():
    with pytest.raises(chatapi.ChatError) as refused:
        chatapi.ChatClient(OtherProject()).get_space("spaces/AAA")
    assert refused.value.status == 404 and chatapi.WRONG_PROJECT in str(refused.value)
    assert "configure the app" not in str(refused.value), "nobody is sent to set up a Chat app"


def test_the_chat_check_blames_the_project_and_not_the_accounts_membership(api, monkeypatch):
    monkeypatch.setattr(chatapi, "signed_in", lambda ctx: True)
    monkeypatch.setattr(chatapi, "session_for", lambda ctx: OtherProject())
    spaces = [line for line in connections._check_chat(api.ctx) if line["label"].endswith(" space")]
    assert spaces and all(not line["ok"] and line["message"] == chatapi.WRONG_PROJECT for line in spaces)
    assert not any("Add " in line["message"] for line in spaces), "adding the account to the space would not help"


# -- Chat taking no custom message ids ------------------------------------------------------------------------------
def test_a_post_still_goes_out_once_when_chat_takes_no_custom_ids(live, world):
    client = chatapi.client_for(live.ctx)
    first = client.post_message(SRC, "Thanks, on it.", key="reply-1")
    again = client.post_message(SRC, "Thanks, on it.", key="reply-1")
    assert world.writes == [(SRC, "Thanks, on it.")] and again["name"] == first["name"], "the request id alone keeps it to one post"
    assert first["client_id"].startswith(chatapi.OWN_PREFIX) and again["client_id"] == first["client_id"], "the bot knows the post as its own"


def test_the_bot_tells_its_own_posts_apart_without_chats_help(live, world):
    client = chatapi.client_for(live.ctx)
    since = live.ctx.now() - timedelta(minutes=5)
    mine = client.post_message(SRC, "Updated post received.", key="reply-2", id_prefix=chatapi.SOURCE_PREFIX)
    world.clock.advance(seconds=5)
    theirs = world.say(SRC, "ok thanks", sender={"name": "users/bot", "type": "HUMAN"})  # typed by a person signed in as the same account
    read = {m["name"]: m["client_id"] for m in chatapi.client_for(live.ctx).list_messages(SRC, since)}
    assert chatapi.OWN_ID.match(read[mine["name"]]) and read[mine["name"]].startswith(chatapi.SOURCE_PREFIX)
    assert read[theirs] == "", "what a person types from that account is a person's message, as in the sheet-based bot"


def test_the_bots_own_post_is_never_reviewed_as_an_alert_when_chat_takes_no_custom_ids(live, world):
    assess_ok(live.ctx.llm)
    live.ctx.config.platform.flags.chat_review = True
    chatapi.client_for(live.ctx).post_message(SRC, GOOD_ALERT, key="copy-of-an-alert")
    world.clock.advance(minutes=1)
    got = chatreview.run(live.ctx)
    assert got["ok"] and got["reviewed"] == 0 and got["ignored"] == 0 and got["failed"] == 0
    assert live.get("/api/routing", user=IM).json()["review"]["rows"] == []


def test_the_record_of_the_bots_own_posts_is_kept_as_long_as_the_copies_and_then_removed(live, world):
    chatapi.client_for(live.ctx).post_message(SRC, "Thanks, on it.", key="reply-3")
    assert len(live.ctx.store.list_docs(chatapi.OWN, limit=10)) == 1
    world.clock.advance(days=live.ctx.config.platform.routing.keep_days + 1)
    retention.run(live.ctx)
    assert live.ctx.store.list_docs(chatapi.OWN, limit=10) == []
