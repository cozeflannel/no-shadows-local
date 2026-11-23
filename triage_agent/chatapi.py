"""Google Chat as the QA chatbot's own account, the way the sheet-based bot reaches it (apps-script-chat-bot/Chat.gs).

The Chat REST API is called with the sign-in of the account in Settings (the agent's account): no Chat app and no
webhooks. The account signs in once from Integrations, Google Chat; its token is kept in the token vault under its
own name, apart from any Gmail token. The permissions asked for are the ones the sheet-based bot's script lists.

Nothing here depends on a Chat app being set up. Chat may take no custom message ids from such a caller, so the bot
keeps its own record of what it posted (OWN) and knows its posts by that, as the sheet-based bot does (noteBotWrite_,
botPostId_): what a post is never depends on Chat.
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
OWN = "chat_own"  # what the bot's account posted itself: {message, id (the id it was meant to have), at}
# Chat's answer to a sign-in made in a Google Cloud project it takes no calls from, in the words a person reads.
WRONG_PROJECT = ("Chat takes no calls from the Google Cloud project this sign-in was made in. Make the sign-in client in "
                 "the project the sheet-based bot runs in, where Chat already takes calls made as a person, and sign in "
                 "again. The QA chatbot is not a Chat app and needs none set up.")
LOOK_BACK = timedelta(hours=24)  # how far back the latest message is looked for when Chat refuses to order them
_SPACE_ID = re.compile(r"/(?:room|space|chat|stream)/([A-Za-z0-9_-]{8,})")


class NotSignedIn(RuntimeError):
    """The QA chatbot has not signed in to Chat, or its sign-in was withdrawn."""


class Refused(RuntimeError):
    """A write the routing rules do not allow (Routing page). Nothing was sent to Chat."""


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


OWN_PREFIX = "client-bqa-"      # the QA chatbot's own work
MIRROR_PREFIX = "client-zmir-"   # its exact copy of an alert
RELAY_PREFIX = "client-zrly-"    # its copy of a person's message or reply
SOURCE_PREFIX = "client-zrlo-"   # what it posts in the source space
OWN_ID = re.compile(r"^client-(?:bqa|zmir|zrly|zrlo|scmp|zwat|zeda)-")  # ids only the bot's own posts carry
_CARD_KEYS = ("title", "subtitle", "text", "topLabel", "bottomLabel", "content")
MARKUP = "MARKUP_SYNTAX_CHAT"


def _when(value: Any) -> datetime:
    return datetime.fromisoformat(re.sub(r"(\.\d{6})\d+", r"\1", str(value)).replace("Z", "+00:00"))


def _card_text(m: dict[str, Any]) -> str:
    out: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            for key, value in node.items():
                if isinstance(value, str):
                    if key in _CARD_KEYS and value.strip():
                        out.append(value)
                else:
                    walk(value)

    walk(m.get("cardsV2") or [])
    walk(m.get("cards") or [])
    text = "\n".join(re.sub(r"<[^>]+>", "", re.sub(r"<br\s*/?>", "\n", t, flags=re.I)) for t in out)
    for a, b in (("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&amp;", "&")):
        text = text.replace(a, b)
    return text.strip()


def message_view(m: dict[str, Any]) -> dict[str, Any]:
    """One Chat message in the shape the rest of the code reads (Chat.gs normalizeMessage_)."""
    sender = m.get("sender") or {}
    return {
        "name": m.get("name") or "", "text": m.get("text") or m.get("formattedText") or m.get("fallbackText") or "",
        "card_text": _card_text(m), "create_time": _when(m["createTime"]) if m.get("createTime") else None,
        "sender": sender.get("name") or "", "sender_display": sender.get("displayName") or "", "sender_type": sender.get("type") or "",
        "thread": (m.get("thread") or {}).get("name") or "", "reply": bool(m.get("threadReply")),
        "client_id": m.get("clientAssignedMessageId") or "",
        "emojis": [{"emoji": s["emoji"]["unicode"], "count": int(s.get("reactionCount") or 0)}
                   for s in m.get("emojiReactionSummaries") or [] if (s.get("emoji") or {}).get("unicode")],
        "files": [a.get("contentName") or "" for a in m.get("attachment") or [] if a.get("contentName")],
        # who the message mentions, and where in its text Chat says each mention sits (no length: Chat did not say)
        "mentions": [{"user": ((a.get("userMention") or {}).get("user") or {}).get("name") or "", "start": int(a.get("startIndex") or 0),
                      "length": int(a.get("length") or 0)} for a in m.get("annotations") or [] if a.get("type") == "USER_MENTION"],
    }


class ChatClient:
    def __init__(self, session: Any, refuse: Any = None):
        self.session = session
        self.refuse = refuse      # refuse(space, approved) -> why this write is not allowed, or ""
        self.approved = False     # True only while a person's Send is being posted (mirror.decide)
        self.posted: Any = None   # posted(message, id): keeps the id a post was meant to have when Chat gave it none
        self.own_id: Any = None   # own_id(message) -> that id, or "" for a message the bot did not post

    def _call(self, method: str, path: str, params: dict[str, Any] | None = None, body: Any = None) -> tuple[int, dict[str, Any], str]:
        last: Any = None
        for attempt in range(1, TRIES + 1):
            last = self.session.request(method, API + path, params=params or None, json=body, timeout=30)
            if last.status_code != 429 and last.status_code < 500:
                break
            if attempt < TRIES:
                time.sleep(1.5 ** attempt)
        try:
            data = last.json()
        except ValueError:
            data = {}
        why = str((data.get("error") or {}).get("message") or last.text or "no reason given")[:300]
        if last.status_code == 404 and "chat app not found" in why.lower():
            why = WRONG_PROJECT
        return last.status_code, data, why

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        status, body, why = self._call("GET", path, params)
        if status >= 300:
            raise ChatError(status, why)
        return body

    def _may_write(self, path: str) -> None:
        space = "/".join(path.split("/")[:2])
        why = self.refuse(space, self.approved) if self.refuse else ""
        if why:
            raise Refused(why)

    def list_messages(self, space: str, since: datetime) -> list[dict[str, Any]]:
        """Every message posted in a space after `since`, oldest first."""
        out: list[dict[str, Any]] = []
        params: dict[str, Any] = {"pageSize": 1000, "filter": f'create_time > "{since.isoformat()}"'}
        while True:
            body = self._get(f"{space}/messages", params)
            out += [message_view(m) for m in body.get("messages") or []]
            if not body.get("nextPageToken") or len(out) >= 5000:
                break
            params = {**params, "pageToken": body["nextPageToken"]}
        if self.own_id:  # a post of the bot's that Chat gave no custom id gets the id the bot meant it to have
            for m in out:
                if not m["client_id"] and m["sender_type"] != "BOT":
                    m["client_id"] = self.own_id(m["name"]) or ""
        return sorted((m for m in out if m["create_time"]), key=lambda m: (m["create_time"], m["name"]))

    def post_message(self, space: str, text: str, *, thread: str = "", key: str = "", id_prefix: str = OWN_PREFIX) -> dict[str, Any]:
        """Posts once: the same `key` in the same space gives back the message already posted (Chat.gs chatPostMessage_)."""
        import hashlib

        path = f"{space}/messages"
        self._may_write(path)
        body: dict[str, Any] = {"text": text, "markupSyntax": MARKUP}
        params: dict[str, Any] = {}
        if thread:
            body["thread"] = {"name": thread}
            params["messageReplyOption"] = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
        custom, meant = "", id_prefix + "nokey"  # meant: the id this post is to be known by, whether or not Chat takes it
        if key:
            digest = hashlib.sha256(f"{space}|{key}".encode()).hexdigest()
            params["requestId"] = f"{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-a{digest[17:20]}-{digest[20:32]}"
            custom = meant = params["messageId"] = id_prefix + digest[:40]
        status, data, why = self._call("POST", path, params, body)
        if status == 409 and custom:  # posted on an earlier try: use that message
            return message_view(self._get(f"{space}/messages/{custom}"))
        if status == 400 and custom and re.search(r"message_?id", why, re.I):  # custom ids refused: the request id still dedupes
            params.pop("messageId")
            status, data, why = self._call("POST", path, params, body)
        if status >= 300:
            raise ChatError(status, why)
        view = message_view(data)
        if not view["client_id"]:  # Chat gave it no custom id: the bot keeps the one it meant, and knows the post by it
            view["client_id"] = meant
            if self.posted and view["name"]:
                self.posted(view["name"], meant)
        return view

    def react(self, message: str, emoji: str) -> None:
        """Adds an emoji as the bot's account. Already there counts as done (Chat.gs chatReact_)."""
        self._may_write(message)
        bare = emoji.replace("\ufe0f", "")
        status, why = 0, ""
        for form in ([emoji, bare] if bare != emoji else [emoji, emoji + "\ufe0f"]):
            status, _, why = self._call("POST", f"{message}/reactions", None, {"emoji": {"unicode": form}})
            if status < 300 or status == 409:
                return
            if status != 400:
                break
        raise ChatError(status, why)

    def find_dm(self, email: str) -> str:
        """The direct message space the bot's account already has with a person, or "" when there is none
        (Chat.gs chatFindDm_). An address works as the person's name for a signed-in account."""
        status, body, why = self._call("GET", "spaces:findDirectMessage", {"name": f"users/{email}"})
        if status == 404:
            return ""
        if status >= 300:
            raise ChatError(status, why)
        return str(body.get("name") or "")

    def member_user(self, space: str, email: str) -> str:
        """The Chat user id of the member of `space` with this address, or "" when they are not one. Chat gives a
        signed-in account a person's id and nothing else, so this is how an id is matched to a person."""
        status, body, why = self._call("GET", f"{space}/members/{email}")
        if status in (400, 403, 404):
            return ""
        if status >= 300:
            raise ChatError(status, why)
        return str((body.get("member") or {}).get("name") or "")

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
    """The Chat client every write goes through: the Routing page's rules are checked before each one."""
    from . import mirror

    client = ChatClient(session_for(ctx))
    client.refuse = lambda space, approved=False: mirror.refusal(ctx, space, client, approved=approved)
    client.posted = lambda message, meant: ctx.store.put_doc(OWN, _own_key(message), {"message": message, "id": meant, "at": ctx.now().isoformat()})
    client.own_id = lambda message: str((ctx.store.get_doc(OWN, _own_key(message)) or {}).get("id") or "")
    return client


def _own_key(message: str) -> str:
    import hashlib

    return hashlib.sha256(message.encode()).hexdigest()[:32]
