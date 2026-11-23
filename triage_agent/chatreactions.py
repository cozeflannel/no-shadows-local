"""Emojis people add in Chat, acted on through the QA chatbot's own Chat sign-in, with no Chat flow in between.

Every minute, with the switch "Act on emojis added in Chat" ON and the QA chatbot ON, the bot's account reads the
space it posts its alerts in, as far back as the Routing page's emoji hours. A legend emoji a person adds to one of the
bot's alert posts is handed, once, to the operation a Chat flow would hand it to (op record_reaction), and the reply is
posted in that post's thread. Who reacted is asked of Chat only when a post's emojis change (Bot.gs analystReactions_).
The bot's own emojis, emojis outside the legend and emojis on anything but its alert posts are left alone. A reply
Chat does not take is tried again each minute and given up after the Routing page's number of tries; the operation is
never run twice for one emoji.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

from . import audit, chatanswers, chatapi, mirror
from .config import switch_title
from .models import ChatMessage
from .operations import handle

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

ROWS, SEEN, LAST = "chat_reactions", "chat_reactions_seen", "chat_reactions:last"
SWITCH = "chat_reactions"
DONE = ("acted", "queued", "held", "gave_up")
SAID = {"acted": "Acted on", "queued": "Queued the reply to", "held": "Held the reply to"}


def space(ctx: "AgentContext") -> str:
    """The space the bot posts its alerts in (the agent's "clean" space under Integrations, Google Chat), or ""."""
    ref = ctx.config.space("clean")
    return chatapi.space_name(ref.space_id, ref.url) if ref else ""


def why_off(ctx: "AgentContext") -> str:
    """Why nothing is read right now, or ""."""
    if not ctx.flag(SWITCH):
        return f"the switch {switch_title(SWITCH)} is OFF"
    if not ctx.config.platform.routing.bot_on:
        return "the QA chatbot is OFF"
    if not space(ctx):
        return "the space the bot posts its alerts in has no link or id under Integrations, Google Chat"
    return ""


def _act(ctx: "AgentContext", client: Any, doc: dict[str, Any], out: dict[str, Any]) -> dict[str, Any]:
    """Act on one emoji and keep what came of it. The operation runs once; only the reply's post is tried again."""
    try:
        if not doc["ran"]:
            message = {"message_id": doc["message"], "text": doc["text"], "space_id": doc["space"], "thread_id": doc["thread"] or None,
                       "conversation_type": "SPACE"}
            resp = handle({"op": "record_reaction", "payload": {"emoji": doc["emoji"], "user": {"email": doc["who"] or None}, "message": message},
                           "context": {"deliver": "outbox", "flow": "chat", "invoked_by": doc["who"] or None}}, ctx)
            if not resp.ok:
                raise RuntimeError(resp.error or "the bot could not act on it")
            doc.update(ran=True, pending=(resp.data.get("reply_text") or "").strip(), routed=list(chatanswers._routed(ctx, resp.data)),
                       case_id=resp.outputs.get("case_id") or doc["case_id"], code=resp.data.get("code") or "")
        status, why = doc["routed"]
        if doc["pending"]:
            status, said = chatanswers._post(ctx, client, doc, f"emoji:{doc['id']}")
            why = " ".join(t for t in (said, why if doc["routed"][0] != "ignored" else "") if t)
            if status == "answered":
                doc["reply"] = doc["pending"]
            doc["pending"] = ""
    except Exception as exc:  # noqa: BLE001 - kept on the row and tried again next minute
        doc["tries"] += 1
        doc.update(status="gave_up" if doc["tries"] >= ctx.config.platform.routing.max_tries else "failed", why=str(exc)[:300])
        out["failed"] += 1
        return doc
    status = "acted" if status in ("answered", "ignored") else status  # acted on, whether or not there was anything to say
    doc.update(status=status, why=why)
    out[status] += 1
    audit.record(ctx, actor=doc["who"] or "unknown", action="chat.reaction", surface="agent", target_type="message", target_id=doc["message"],
                 summary=f"{SAID[status]} {doc['emoji']} in {doc['space_name']}", case_id=doc["case_id"] or None,
                 detail={"status": status, "why": why, "code": doc["code"]})
    return doc


def _new(ctx: "AgentContext", client: Any, known: dict[str, Any], m: dict[str, Any], sp: str, bot: str, case_id: str) -> list[dict[str, Any]]:
    """A row for each legend emoji a person added to this post that has none yet."""
    made = []
    for r in client.list_reactions(m["name"]):
        action = ctx.config.action(r["emoji"])
        if action is None or not r["user"] or r["user"] == bot:
            continue
        row_id = mirror._id(m["name"], action.emoji, r["user"])
        if ctx.store.get_doc(ROWS, row_id):
            continue
        made.append({"id": row_id, "message": m["name"], "space": sp, "space_name": ctx.config.space("clean").display_name, "thread": m["thread"] or "",
                     "text": (m["text"] or "")[:300], "emoji": action.emoji, "who": chatanswers._asker(ctx, client, known, sp, r["user"]),
                     "case_id": case_id, "code": action.code, "at": ctx.now().isoformat(), "status": "waiting", "why": "", "tries": 0,
                     "reply": "", "pending": "", "ran": False, "routed": ["ignored", ""]})
    return made


def _read(ctx: "AgentContext", client: Any, known: dict[str, Any], out: dict[str, Any]) -> None:
    from .actions import find_case

    r = ctx.config.platform.routing
    sp, left = space(ctx), r.max_per_run
    bot = chatanswers._bot_user(ctx, client, known, sp)
    for doc in ctx.store.list_docs(ROWS, limit=500):  # what failed before is tried again first
        if doc["status"] not in DONE and left > 0:
            ctx.store.put_doc(ROWS, doc["id"], _act(ctx, client, doc, out))
            left -= 1
    for m in client.list_messages(sp, ctx.now() - timedelta(hours=r.emoji_hours)):
        legend = sorted(f"{e['emoji']}{e['count']}" for e in m["emojis"] if ctx.config.action(e["emoji"]))
        if not legend or not (chatapi.OWN_ID.match(m["client_id"]) or (bot and m["sender"] == bot)):
            continue  # only the bot's own posts, and only emojis in the legend
        seen = ctx.store.get_doc(SEEN, mirror._id(m["name"])) or {"id": mirror._id(m["name"]), "message": m["name"], "at": ctx.now().isoformat(), "emojis": ""}
        if seen["emojis"] == ",".join(legend):
            continue  # nothing changed on this post since it was last read
        case = find_case(ctx, ChatMessage(message_id=m["name"], text=m["text"] or ""))
        rows = _new(ctx, client, known, m, sp, bot, case.case_id) if case else []  # a post that is no alert's is left alone
        for doc in rows:
            if left <= 0:
                return  # the rest next minute: this post's emojis are not marked as read
            ctx.store.put_doc(ROWS, doc["id"], _act(ctx, client, doc, out))
            left -= 1
        ctx.store.put_doc(SEEN, seen["id"], {**seen, "emojis": ",".join(legend), "at": ctx.now().isoformat()})


def run(ctx: "AgentContext") -> dict[str, Any]:
    """One pass, once a minute: read the space the bot posts its alerts in and act on each new legend emoji."""
    why = why_off(ctx)
    if why:
        return {"ok": True, "off": True, "why": why}
    out: dict[str, Any] = {"ok": True, "off": False, "acted": 0, "queued": 0, "held": 0, "failed": 0, "error": ""}
    known = {"bot": "", "bot_asked": {}, "users": {}, "asked": {}, **(ctx.store.get_kv(chatanswers.KNOWN) or {})}
    try:
        _read(ctx, chatapi.client_for(ctx), known, out)
    except Exception as exc:  # noqa: BLE001 - shown on the Routing page; the next minute tries again
        out.update(ok=False, error=chatanswers._cannot(ctx, exc)[:300])
    ctx.store.put_kv(chatanswers.KNOWN, known)
    ctx.store.put_kv(LAST, {**out, "at": ctx.now().isoformat()})
    return out


def status(ctx: "AgentContext") -> dict[str, Any]:
    """What the Routing page shows about emojis: whether they are read, where, what the last pass did, the last 100."""
    why = why_off(ctx)
    ref = ctx.config.space("clean")
    rows = sorted(ctx.store.list_docs(ROWS, limit=100), key=lambda d: d["at"], reverse=True)
    return {"on": not why, "why": why, "switch": ctx.flag(SWITCH), "last_run": ctx.store.get_kv(LAST), "space": ref.display_name if ref else "",
            "rows": [{k: d[k] for k in ("at", "message", "emoji", "who", "case_id", "code", "status", "why", "reply", "tries")} for d in rows]}
