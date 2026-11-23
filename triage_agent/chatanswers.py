"""Mentions of the QA chatbot answered through its own Chat sign-in, with no Chat flow in between.

Every minute, with the switch "Answer mentions in Chat" ON and the QA chatbot ON, the bot's account reads the Routing
page's spaces and the agent's spaces picked there. A person's message that mentions the bot is handed, once, to the
operation a Chat flow would hand it to (op converse), and the reply is posted in that message's thread. A reply for the
source space follows the Routing page's rules: posted, left for a person's Send, or held and shown under the alert's
copy in the second space. A reply Chat does not take is tried again each minute and given up after the Routing page's
number of tries; the operation is never run twice for one message.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from . import audit, chatapi, mirror
from .config import switch_title
from .operations import handle

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

ROWS, STATE, LAST, KNOWN = "chat_answers", "chat_answers:state", "chat_answers:last", "chat_answers:known"
SWITCH = "chat_answers"
DONE = ("answered", "queued", "held", "ignored", "gave_up")
LOOKUP_TTL = timedelta(hours=6)  # how long "Chat does not know this address in this space" is believed before it is asked again
SAID = {"answered": "Answered", "queued": "Queued the answer to", "held": "Held the answer to"}
WAITS = "It waits for a person's Send on the Routing page."


def read_spaces(ctx: "AgentContext") -> list[dict[str, str]]:
    """The spaces read for mentions: the Routing page's three, then the agent's spaces picked there. Each once."""
    r = ctx.config.platform.routing
    out: list[dict[str, str]] = []

    def add(space: str, label: str) -> None:
        if space and not any(mirror._same(space, p["space"]) for p in out):
            out.append({"space": space, "label": label})

    for key, label in (("source", "the source space"), ("mirror", "the second space"), ("third", "the third space")):
        add(mirror._ref(getattr(r, key)), label)
    for key in r.answer_spaces:
        ref = ctx.config.space(key)
        if ref:
            add(chatapi.space_name(ref.space_id, ref.url), ref.display_name)
    return out


def why_off(ctx: "AgentContext") -> str:
    """Why nothing is read right now, or ""."""
    if not ctx.flag(SWITCH):
        return f"the switch {switch_title(SWITCH)} is OFF"
    if not ctx.config.platform.routing.bot_on:
        return "the QA chatbot is OFF"
    if not read_spaces(ctx):
        return "no space is set"
    return ""


# ---------------------------------------------------------------------------------------------------------------
# Who is who: Chat gives a signed-in account a person's id and nothing else
# ---------------------------------------------------------------------------------------------------------------

def _fresh(ctx: "AgentContext", at: str | None) -> bool:
    return bool(at) and ctx.now() - datetime.fromisoformat(at) < LOOKUP_TTL


def _bot_user(ctx: "AgentContext", client: Any, known: dict[str, Any], space: str) -> str:
    """The bot account's own Chat user id: the sender of anything it has posted, else asked of Chat in a space it is a
    member of. Remembered either way."""
    email = (ctx.config.agent.email or "").strip()
    known["bot"] = known["bot"] or chatapi.me(ctx)
    if known["bot"] or not email or _fresh(ctx, known["bot_asked"].get(space)):
        return known["bot"]
    known["bot"] = client.member_user(space, email)
    known["bot_asked"][space] = ctx.now().isoformat()  # kept only once Chat has answered: a failed call is asked again next minute
    return known["bot"]


def _roster(ctx: "AgentContext") -> list[str]:
    """Every address the agent knows a person by: the people under Settings and both rosters."""
    own = (ctx.config.agent.email or "").strip().lower()
    found = [a.email for a in ctx.config.analysts]
    for name in ("slrr_im", "burson"):
        found += [p.email for p in ctx.roster(name).people]
    return list(dict.fromkeys(e.strip().lower() for e in found if e and e.strip().lower() != own))


def _asker(ctx: "AgentContext", client: Any, known: dict[str, Any], space: str, user: str) -> str:
    """The address of the person behind a Chat user id, or "" for someone the agent does not know. Each address is asked
    of the space once; what Chat answers is remembered."""
    if not user or user in known["users"] or _fresh(ctx, known["asked"].get(space)):
        return known["users"].get(user, "")
    have = set(known["users"].values())
    for email in _roster(ctx):
        if email not in have:
            found = client.member_user(space, email)
            if found:
                known["users"][found] = email
    known["asked"][space] = ctx.now().isoformat()
    return known["users"].get(user, "")


# ---------------------------------------------------------------------------------------------------------------
# One message
# ---------------------------------------------------------------------------------------------------------------

def _asks(ctx: "AgentContext", m: dict[str, Any], bot: str) -> bool:
    """True for a person's message that mentions the bot. Apps and the bot's own posts never count."""
    if chatapi.OWN_ID.match(m["client_id"]) or (bot and m["sender"] == bot):
        return False
    if m["sender_type"] == "BOT" or re.search(r"\bzapier\b", m["sender_display"], re.I):
        return False
    if bot and any(x["user"] == bot for x in m["mentions"]):
        return True
    name = ctx.config.agent.display_name.strip()  # Chat gave no mention: the bot's name typed after an @ counts
    return bool(name) and bool(re.search(rf"@\s*{re.escape(name)}\b", m["text"] or "", re.I))


def _question(m: dict[str, Any], bot: str) -> str:
    """The message as written, without the bot's mention where Chat says it sits."""
    text = m["text"] or ""
    for x in sorted((x for x in m["mentions"] if x["user"] == bot and x["length"] > 0), key=lambda x: -x["start"]):
        if text[x["start"]:x["start"] + x["length"]].startswith("@"):
            text = text[:x["start"]] + " " + text[x["start"] + x["length"]:]
    return text.strip()


def _held_why(ctx: "AgentContext", h: dict[str, Any]) -> str:
    check, hits = h.get("check") or "", ", ".join((h.get("hits") or [])[:4])
    if check in ("safety_valve", "routing"):
        why = f"Nothing is written in the source space: {mirror.mode(ctx)['why'] or 'the Routing page holds it'}."
        if h.get("copied_to"):
            return why + " It is shown in the second space, under the copy of the message it answers."
        return why + (f" It names something internal ({hits}), so it is not shown in the second space either." if hits else "")
    if check == "leak_guard":
        return f"Held: it names something internal ({hits})."
    if check == "target_not_allowed":
        return f"Held: posting to {h.get('target')} is not allowed under Safety and Testing."
    return f"Held: {check}."


def _routed(ctx: "AgentContext", data: dict[str, Any]) -> tuple[str, str]:
    """What became of the posts the operation made for other spaces (they follow the Routing page and the queue)."""
    held = data.get("held_outputs") or []
    blocked = [h for h in held if h.get("check") != "waits_for_send"]
    if blocked:
        return "held", _held_why(ctx, blocked[0])
    if held:
        return "queued", WAITS
    if data.get("queued_outbox_ids"):
        return "queued", f"It is queued: the switch {switch_title('chat_delivery')} posts it."
    return "ignored", ""


def _post(ctx: "AgentContext", client: Any, doc: dict[str, Any]) -> tuple[str, str]:
    """Post the reply in the message's thread. In the source space the Routing page decides."""
    from . import safety

    space, text, thread = doc["space"], doc["pending"], doc["thread"]
    if mirror._same(space, mirror._ref(ctx.config.platform.routing.source)):
        got = mirror.send(ctx, text, thread=thread, origin="converse")
        if got["status"] == "sent":
            return "answered", ""
        if got["status"] == "waiting":
            return "queued", WAITS
        shown = safety._shown_in_copies(ctx, text, thread, "converse", "")
        return "held", _held_why(ctx, {"check": "routing", **shown}) if not mirror.mode(ctx)["live"] else f"Held: {got['why']}."
    try:
        client.post_message(space, text, thread=thread, key=f"answer:{doc['message']}")
    except chatapi.Refused as exc:
        return "held", str(exc)
    return "answered", ""


def _answer(ctx: "AgentContext", client: Any, known: dict[str, Any], m: dict[str, Any], space: str, bot: str,
            doc: dict[str, Any] | None, out: dict[str, Any]) -> dict[str, Any]:
    """Answer one mention and keep what came of it. The operation runs once; only the post is tried again."""
    doc = doc or {"id": mirror._id(m["name"]), "message": m["name"], "space": space, "space_name": "", "thread": m["thread"] or "",
                  "at": m["create_time"].isoformat(), "text": (m["text"] or "")[:300], "asker": "", "status": "waiting", "why": "", "tries": 0,
                  "reply": "", "pending": "", "ran": False, "routed": ["ignored", ""]}
    try:
        if not doc["ran"]:
            doc["space_name"] = mirror.space_info(ctx, client, space)["name"]
            doc["asker"] = _asker(ctx, client, known, space, m["sender"])
            message = {"message_id": m["name"], "text": _question(m, bot), "sender": {"email": doc["asker"] or None, "type": "HUMAN"},
                       "space_id": space, "thread_id": m["thread"] or None, "create_time": m["create_time"].isoformat(),
                       "conversation_type": "SPACE"}
            resp = handle({"op": "converse", "payload": {"message": message},
                           "context": {"deliver": "outbox", "flow": "chat", "invoked_by": "agent"}}, ctx)
            if not resp.ok:
                raise RuntimeError(resp.error or "the bot could not answer")
            doc.update(ran=True, pending=(resp.data.get("reply_text") or "").strip(), routed=list(_routed(ctx, resp.data)))
        status, why = doc["routed"]
        if doc["pending"]:
            status, said = _post(ctx, client, doc)
            why = " ".join(t for t in (said, why if doc["routed"][0] != "ignored" else "") if t)
            if status == "answered":
                doc["reply"] = doc["pending"]
            doc["pending"] = ""
    except Exception as exc:  # noqa: BLE001 - kept on the row and tried again next minute
        doc["tries"] += 1
        doc.update(status="gave_up" if doc["tries"] >= ctx.config.platform.routing.max_tries else "failed", why=str(exc)[:300])
        out["failed"] += 1
        return doc
    doc.update(status=status, why=why)
    out[status] += 1
    if status in SAID:
        audit.record(ctx, actor="agent", action="chat.answer", surface="agent", target_type="message", target_id=m["name"],
                     summary=f"{SAID[status]} a mention in {doc['space_name'] or space}",
                     detail={"status": status, "why": why, "asker": doc["asker"]})
    return doc


# ---------------------------------------------------------------------------------------------------------------
# The minute run
# ---------------------------------------------------------------------------------------------------------------

def _read(ctx: "AgentContext", client: Any, known: dict[str, Any], space: str, st: dict[str, Any], out: dict[str, Any], left: list[int]) -> None:
    r = ctx.config.platform.routing
    now = ctx.now()
    if space not in st:  # a space newly read starts from the last few minutes, as the copy does
        start = (now - timedelta(minutes=r.start_minutes)).isoformat()
        st[space] = {"floor": start, "cursor": start}
    floor, cursor = datetime.fromisoformat(st[space]["floor"]), datetime.fromisoformat(st[space]["cursor"])
    since = max(cursor - mirror.OVERLAP, floor, now - mirror.MAX_GAP)
    bot = _bot_user(ctx, client, known, space)
    waiting: datetime | None = None  # the oldest mention still to be answered: the cursor never passes it
    for m in client.list_messages(space, since):
        at = m["create_time"]
        if at <= since:
            continue
        doc = ctx.store.get_doc(ROWS, mirror._id(m["name"]))
        if doc is None and not _asks(ctx, m, bot):
            cursor = max(cursor, at) if waiting is None else cursor
            continue
        if doc is None or doc["status"] not in DONE:
            if left[0] <= 0:
                waiting = waiting or at
                continue
            doc = _answer(ctx, client, known, m, space, bot, doc, out)
            ctx.store.put_doc(ROWS, doc["id"], doc)
            left[0] -= 1
        if doc["status"] in DONE:
            cursor = max(cursor, at) if waiting is None else cursor
        else:
            waiting = waiting or at
    st[space]["cursor"] = (min(cursor, waiting - timedelta(microseconds=1)) if waiting else cursor).isoformat()


def _cannot(ctx: "AgentContext", exc: Exception) -> str:
    if isinstance(exc, chatapi.ChatError) and exc.status in (403, 404):
        return f"the QA chatbot can't open this space. Add {ctx.config.agent.email or 'its account'} to it"
    return str(exc)


def run(ctx: "AgentContext") -> dict[str, Any]:
    """One pass, once a minute: read each space and answer what mentions the bot."""
    why = why_off(ctx)
    if why:
        return {"ok": True, "off": True, "why": why}
    out: dict[str, Any] = {"ok": True, "off": False, "answered": 0, "queued": 0, "held": 0, "ignored": 0, "failed": 0, "error": ""}
    errors: list[str] = []
    try:
        client = chatapi.client_for(ctx)
        places = read_spaces(ctx)
        st = {k: v for k, v in (ctx.store.get_kv(STATE) or {}).items() if any(mirror._same(k, p["space"]) for p in places)}
        known = {"bot": "", "bot_asked": {}, "users": {}, "asked": {}, **(ctx.store.get_kv(KNOWN) or {})}
        left = [ctx.config.platform.routing.max_per_run]
        for place in places:
            try:
                _read(ctx, client, known, place["space"], st, out, left)
            except chatapi.NotSignedIn:
                raise
            except Exception as exc:  # noqa: BLE001 - one space that cannot be read never stops the others
                errors.append(f"{place['label']}: {_cannot(ctx, exc)}")
        ctx.store.put_kv(STATE, st)
        ctx.store.put_kv(KNOWN, known)
    except Exception as exc:  # noqa: BLE001 - shown on the Routing page; the next minute tries again
        errors.append(str(exc))
    if errors:
        out.update(ok=False, error="; ".join(errors)[:300])
    ctx.store.put_kv(LAST, {**out, "at": ctx.now().isoformat()})
    return out


def status(ctx: "AgentContext") -> dict[str, Any]:
    """What the Routing page shows about the answers: whether they run, where, what the last pass did, the last 100."""
    why = why_off(ctx)
    r = ctx.config.platform.routing
    picked, routed = set(r.answer_spaces), [mirror._ref(getattr(r, k)) for k in ("source", "mirror", "third")]
    rows = sorted(ctx.store.list_docs(ROWS, limit=100), key=lambda d: d["at"], reverse=True)
    return {"on": not why, "why": why, "switch": ctx.flag(SWITCH), "last_run": ctx.store.get_kv(LAST),
            "spaces": [p["label"] for p in read_spaces(ctx)],
            # the agent's spaces that can be added: one the Routing page reads already is not offered again
            "choices": [{"key": s.key, "name": s.display_name, "picked": s.key in picked} for s in ctx.config.spaces
                        if chatapi.space_name(s.space_id, s.url) and not any(mirror._same(chatapi.space_name(s.space_id, s.url), x) for x in routed)],
            "rows": [{"at": d["at"], "message": d["message"], "space": d["space_name"] or d["space"], "text": d["text"], "asker": d["asker"],
                      "reply": d["reply"], "status": d["status"], "why": d["why"], "tries": d["tries"]} for d in rows]}
