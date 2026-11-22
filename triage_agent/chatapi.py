"""Google Chat as the QA chatbot's own account, the way the sheet-based bot reaches it (apps-script-chat-bot/Chat.gs).

The Chat REST API is called with the sign-in of the account in Settings (the agent's account): no Chat app and no
webhooks. The account signs in once from Integrations, Google Chat; its token is kept in the token vault under its
own name, apart from any Gmail token. The permissions asked for are the ones the sheet-based bot's script lists.
"""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

log = logging.getLogger(__name__)

API = "https://chat.googleapis.com/v1/"
_SCOPE = "https://www.googleapis.com/auth/"
# What each permission lets the bot do, in the words a person reads when one is missing.
SCOPE_WORDS: dict[str, str] = {
    _SCOPE + "chat.messages.readonly": "read messages",
    _SCOPE + "chat.messages.create": "post messages",
    _SCOPE + "chat.messages.reactions.create": "add emoji reactions",
    _SCOPE + "chat.spaces.readonly": "see spaces",
    _SCOPE + "chat.memberships.readonly": "see who is in a space",
}
SCOPES: tuple[str, ...] = tuple(SCOPE_WORDS)
IDENTITY_SCOPES: tuple[str, ...] = ("openid", _SCOPE + "userinfo.email")
TRIES = 3
LOOK_BACK = timedelta(hours=24)  # how far back the latest message is looked for when Chat refuses to order them
_SPACE_ID = re.compile(r"/(?:room|space|chat|stream)/([A-Za-z0-9_-]{8,})")


class NotSignedIn(RuntimeError):
    """The QA chatbot has not signed in to Chat, or its sign-in was withdrawn."""


class ChatError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status


def vault_key(email: str) -> str:
    return "chat:" + email.strip().lower()


def space_name(space_id: str | None, url: str | None) -> str:
    """`spaces/<id>` from a space's id or its link ('' when neither names one)."""
    sid = (space_id or "").strip()
    if sid:
        return sid if sid.startswith("spaces/") else f"spaces/{sid}"
    found = _SPACE_ID.findall(url or "")
    return f"spaces/{found[-1]}" if found else ""


def _gmail() -> Any:
    from .escalation import gmail  # the token vault and the sign-in client are shared with Gmail's

    return gmail


def stored(ctx: "AgentContext") -> dict[str, Any] | None:
    bot = (ctx.config.agent.email or "").strip()
    if not bot:
        return None
    try:
        info = _gmail().get_token_vault().get(vault_key(bot))
    except Exception:  # noqa: BLE001 - a vault that can't be read is the same as no sign-in
        log.warning("the Chat sign-in could not be read from the vault", exc_info=True)
        return None
    return info if info and info.get("refresh_token") else None


def signed_in(ctx: "AgentContext") -> bool:
    return stored(ctx) is not None


def session_for(ctx: "AgentContext") -> Any:
    """An HTTP session that calls Chat as the QA chatbot's account."""
    from google.auth.exceptions import RefreshError
    from google.auth.transport.requests import AuthorizedSession, Request
    from google.oauth2.credentials import Credentials

    info = stored(ctx)
    if info is None:
        raise NotSignedIn("The QA chatbot is not signed in to Chat.")
    info = dict(info)
    gmail = _gmail()
    try:
        web = (gmail.load_oauth_client_config() or {}).get("web") or {}
    except Exception:  # noqa: BLE001 - the stored token may already carry the client's details
        web = {}
    for key in ("client_id", "client_secret", "token_uri"):
        if not info.get(key) and web.get(key):
            info[key] = web[key]
    creds = Credentials.from_authorized_user_info(info)
    if not creds.valid:
        try:
            creds.refresh(Request())
        except RefreshError as exc:
            raise NotSignedIn("The QA chatbot's Chat sign-in was withdrawn or expired. Sign in again under Integrations, Google Chat.") from exc
        try:
            gmail.get_token_vault().put(vault_key(ctx.config.agent.email), json.loads(creds.to_json()))
        except Exception as exc:  # noqa: BLE001 - the refreshed token still works for this call
            log.warning("could not keep the refreshed Chat token: %s", exc)
    return AuthorizedSession(creds)


class ChatClient:
    def __init__(self, session: Any):
        self.session = session

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        last: Any = None
        for attempt in range(1, TRIES + 1):
            last = self.session.request("GET", API + path, params=params or None, timeout=30)
            if last.status_code != 429 and last.status_code < 500:
                break
            if attempt < TRIES:
                time.sleep(1.5 ** attempt)
        try:
            body = last.json()
        except ValueError:
            body = {}
        if last.status_code >= 300:
            raise ChatError(last.status_code, str((body.get("error") or {}).get("message") or last.text or "no reason given")[:300])
        return body

    def get_space(self, space: str) -> dict[str, Any]:
        body = self._get(space)
        return {"name": body.get("name") or space, "display_name": body.get("displayName") or "", "external": bool(body.get("externalUserAllowed")),
                "type": body.get("spaceType") or ""}

    def latest_message(self, space: str, now: datetime | None = None) -> dict[str, Any] | None:
        """The newest message in a space. Chat is asked for the newest first; when it refuses to order them, the last
        day's messages are read and the newest is picked."""
        try:
            messages = self._get(f"{space}/messages", {"pageSize": 1, "orderBy": "createTime DESC"}).get("messages") or []
        except ChatError as exc:
            if exc.status != 400:
                raise
            since = ((now or datetime.now().astimezone()) - LOOK_BACK).isoformat()
            messages = self._get(f"{space}/messages", {"pageSize": 1000, "filter": f'create_time > "{since}"'}).get("messages") or []
        if not messages:
            return None
        m = max(messages, key=lambda x: str(x.get("createTime") or ""))
        return {"name": m.get("name") or "", "create_time": datetime.fromisoformat(str(m["createTime"]).replace("Z", "+00:00")),
                "text": m.get("text") or "", "sender": (m.get("sender") or {}).get("displayName") or (m.get("sender") or {}).get("name") or ""}


def client_for(ctx: "AgentContext") -> ChatClient:
    return ChatClient(session_for(ctx))
