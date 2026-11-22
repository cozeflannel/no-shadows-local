"""The QA chatbot's own sign-in to Google Chat, and what the Console reads with it.

Google's sign-in and the Chat API are replaced by stand-ins (no network); the routes, the token store and the
checks are the real ones.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from test_console_api import ADMIN, IM, _callback, api, console_ctx, fake_oauth, seeded  # noqa: F401 - fixtures
from triage_agent import chatapi


def _start(api) -> str:
    r = api.get("/api/chat-signin/connect", user=ADMIN, format="json")
    assert r.status_code == 200, r.text
    return r.json()["auth_url"].split("state=")[1].split("&")[0]


def test_only_the_bots_own_account_can_be_signed_in_and_its_token_is_kept_apart(api, fake_oauth):
    bot = api.ctx.config.agent.email
    assert api.get("/api/chat-signin", user=IM).json() == {"signed_in": False, "email": bot, "client_ready": True, "scopes": list(chatapi.SCOPES)}
    assert api.get("/api/chat-signin/connect", user=IM, format="json").status_code == 403, "an admin starts the sign-in"
    r = api.get("/api/chat-signin/connect", user=ADMIN, format="json")
    assert f"login_hint={bot}" in r.json()["auth_url"] and set(chatapi.SCOPES) <= set(r.json()["scopes"])
    state = r.json()["auth_url"].split("state=")[1].split("&")[0]

    fake_oauth.authorize_as = "someone.else@ops.test"
    back = _callback(api, ADMIN, state, "code-1")
    assert back["signin"] == ["error"] and bot in back["reason"][0] and fake_oauth.vault == {}, "another account's token is never kept"

    fake_oauth.authorize_as = bot
    back = _callback(api, ADMIN, _start(api), "code-2")
    assert back["signin"] == ["connected"]
    assert list(fake_oauth.vault) == [chatapi.vault_key(bot)] and fake_oauth.vault[chatapi.vault_key(bot)]["refresh_token"], \
        "kept under its own name, apart from the Gmail token"
    assert api.get("/api/chat-signin", user=IM).json()["signed_in"] is True
    entry = api.get("/api/audit", user=ADMIN, action="connection.").json()["entries"][0]
    assert entry["action"] == "connection.chat_signin" and entry["actor"] == ADMIN

    assert api.delete("/api/chat-signin", user=IM).status_code == 403
    assert api.delete("/api/chat-signin", user=ADMIN).json()["signed_in"] is False and fake_oauth.vault == {}


def test_a_sign_in_that_leaves_out_a_permission_keeps_no_token(api, fake_oauth):
    fake_oauth.authorize_as = api.ctx.config.agent.email
    fake_oauth.grant_only = [chatapi.SCOPES[0], "openid", "https://www.googleapis.com/auth/userinfo.email"]
    back = _callback(api, ADMIN, _start(api), "code")
    assert back["signin"] == ["error"] and "post messages" in back["reason"][0] and fake_oauth.vault == {}


def test_the_sign_in_needs_the_bots_account_and_a_sign_in_client(api, fake_oauth, monkeypatch):
    monkeypatch.setattr(fake_oauth.mod, "load_oauth_client_config", lambda source=None: (_ for _ in ()).throw(RuntimeError("TRIAGE_OAUTH_CLIENT is not set")))
    r = api.get("/api/chat-signin/connect", user=ADMIN, format="json")
    assert r.status_code == 503 and "sign-in client" in r.json()["error"]
    assert api.get("/api/chat-signin", user=IM).json()["client_ready"] is False
    api.ctx.config.agent.email = ""
    r = api.get("/api/chat-signin/connect", user=ADMIN, format="json")
    assert r.status_code == 422 and "account" in r.json()["error"]


class ChatStandIn:
    """Google Chat as the bot's account sees it: two spaces it is in, one it is not, and whether ordering is accepted."""

    def __init__(self, now, ordering: bool = True):
        self.now, self.ordering, self.calls = now, ordering, []

    def request(self, method: str, url: str, params: dict[str, Any] | None = None, json: Any = None, timeout: int = 0):
        path = url.split("/v1/")[1]
        self.calls.append((method, path, dict(params or {})))
        spaces = {"spaces/AAQAaa_0I9g": {"displayName": "[S-F] Burson Automated Alerts V3", "externalUserAllowed": True},
                  "spaces/AAQAaLn375E": {"displayName": "SLRR Triaged Alerts"}}
        space = "/".join(path.split("/")[:2])
        if space not in spaces:
            return _Resp(403, {"error": {"message": "The caller does not have permission"}})
        if path.endswith("/messages"):
            if "orderBy" in (params or {}) and not self.ordering:
                return _Resp(400, {"error": {"message": "orderBy is not supported"}})
            older = {"name": f"{space}/messages/a", "createTime": (self.now - timedelta(hours=3)).isoformat(), "text": "older"}
            newest = {"name": f"{space}/messages/b", "createTime": (self.now - timedelta(minutes=4)).isoformat(), "text": "newest"}
            return _Resp(200, {"messages": [newest] if "orderBy" in (params or {}) else [older, newest]})
        return _Resp(200, {"name": space, **spaces[space]})


class _Resp:
    def __init__(self, status: int, body: dict[str, Any]):
        self.status_code, self._body, self.text = status, body, str(body)

    def json(self) -> dict[str, Any]:
        return self._body


def _signed_in(api, fake_oauth, monkeypatch, **chat: Any) -> ChatStandIn:
    fake_oauth.authorize_as = api.ctx.config.agent.email
    assert _callback(api, ADMIN, _start(api), "code")["signin"] == ["connected"]
    stand_in = ChatStandIn(api.ctx.now(), **chat)
    monkeypatch.setattr(chatapi, "session_for", lambda ctx: stand_in)
    return stand_in


def test_the_check_reads_each_space_as_the_bot_and_says_who_can_join(api, fake_oauth, monkeypatch):
    _signed_in(api, fake_oauth, monkeypatch)
    got = api.post("/api/connections/chat/test", user=ADMIN).json()
    lines = {d["label"]: d for d in got["test"]["details"]}
    bot = api.ctx.config.agent.email
    assert lines["Signed in to Chat"] == {"label": "Signed in to Chat", "ok": True, "message": f"As {bot}."}
    burson = lines["[S-F] Burson Automated Alerts V3 space"]
    assert burson["ok"] is True and burson["message"] == "Latest message 4 min ago. People outside Google can join this space."
    assert lines["SLRR Triaged Alerts space"]["message"] == "Latest message 4 min ago. Only Google people can join."
    denied = [d for d in got["test"]["details"] if not d["ok"]]
    assert denied and all(f"Add {bot} to this space" in d["message"] for d in denied), "a space the bot is not in says what to do"


def test_the_newest_message_is_found_when_chat_refuses_to_order_them(api, fake_oauth, monkeypatch):
    chat = _signed_in(api, fake_oauth, monkeypatch, ordering=False)
    newest = chatapi.client_for(api.ctx).latest_message("spaces/AAQAaa_0I9g")
    assert newest["text"] == "newest"
    asked = [params for method, path, params in chat.calls if path.endswith("/messages")]
    assert "orderBy" in asked[0] and "orderBy" not in asked[1], "asked for the newest first, then without ordering"


def test_without_the_sign_in_the_tile_says_so(api, fake_oauth):
    tile = next(c for c in api.get("/api/connections", user=IM).json()["connections"] if c["key"] == "chat")
    assert {"label": "QA chatbot signed in to Chat", "value": "No"} in tile["facts"] and any(s["key"] == "signin" for s in tile["steps"])
    assert chatapi.space_name("", "https://chat.google.com/room/AAQAaa_0I9g") == "spaces/AAQAaa_0I9g"
    assert chatapi.space_name("spaces/XYZ", "") == "spaces/XYZ" and chatapi.space_name("", "") == ""
