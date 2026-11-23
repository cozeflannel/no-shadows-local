"""Routing: which Chat space the QA chatbot reads, where it copies it, and when it may write back.

A port of the sheet-based bot's Mirror, Burson test copy and Safety valve (apps-script-chat-bot/Mirror.gs,
TestCopy.gs, Relay.gs, Chat.gs chatWriteRefusal_), set on the Console's Routing page:

    source space   Burson's space, or any other. Read every minute.
    second space   a copy of the source, message for message, in the source's own order.
    third space    a copy of everything that reached the second space, in the same order.

The source is written only when the QA chatbot is ON, the Safety valve is OFF and no second space is set. With the
valve ON nothing is written there; the copy spaces still get everything. A space people outside Google can join is
never written unless it is the source and the source is open. Every write in Chat goes through chatapi.ChatClient,
which asks refusal() first.
"""

from __future__ import annotations

import hashlib
import re
import time
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from . import audit, chatapi, safety

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

COPIES, THREADS, PEOPLE, QUEUE = "relay", "relay_threads", "relay_people", "relay_queue"
OWN_REPLIES = "relay_own"  # what the bot would have written in the closed source space, shown in the copy spaces instead
STATE, LAST = "routing:state", "routing:last"
SPACE_TTL = timedelta(minutes=10)   # how long a space's name and who-can-join answer is kept
OVERLAP = timedelta(minutes=5)      # messages are read again this far back; none is copied twice
MAX_GAP = timedelta(hours=24)       # a message held back by its own failures is read again for up to a day
MAX_CHARS = 3800                    # a copied text is cut here (Chat's limit is 4,096 with the name in front)
EMOJIS_PER_RUN = 60
ORGS = ("", "Burson", "Google")
_CREDIT = re.compile(r"^[ \t]*Zap sent by @.*$\n?", re.I | re.M)
_SPACE = (re.compile(r"(?:^|/)spaces/([A-Za-z0-9_-]+)"),
          re.compile(r"^https?://\S*?(?:/space/|/room/|/chat/|#chat/space/)([A-Za-z0-9_-]{6,})", re.I),
          re.compile(r"^([A-Za-z0-9_-]{8,})$"))


class Conflict(RuntimeError):
    """The step can't be taken as things stand (already sent, or the rules do not allow it right now)."""


def space_ref(value: str | None) -> str:
    """A space link, 'spaces/X' or a bare id -> 'spaces/X'. Blank stays blank; anything else is refused."""
    v = (value or "").strip()
    if not v:
        return ""
    for rx in _SPACE:
        m = rx.search(v)
        if m:
            return "spaces/" + m.group(1)
    raise ValueError(f'"{v}" is not a Chat space. Paste the space\'s link or its id.')


def _ref(value: str | None) -> str:
    try:
        return space_ref(value)
    except ValueError:
        return ""


def _same(a: str, b: str) -> bool:
    return bool(a) and a.lower() == b.lower()


def _id(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:32]


def mode(ctx: "AgentContext") -> dict[str, Any]:
    """Whether the QA chatbot may write in the source space right now, and if not, why."""
    r = ctx.config.platform.routing
    if not r.bot_on:
        why = "the QA chatbot is OFF"
    elif ctx.config.platform.safety.testing:
        why = "the Safety valve is ON"
    elif r.mirror.strip() or r.third.strip():
        why = "a second space is set, so writes go there and not to the source space"
    elif not r.source.strip():
        why = "no source space is set"
    else:
        return {"live": True, "why": ""}
    return {"live": False, "why": why}


def space_info(ctx: "AgentContext", client: Any, space: str) -> dict[str, Any]:
    """A space's name and whether people outside Google can join it, as the QA chatbot's account sees it."""
    key = f"routing:space:{space}"
    kept = ctx.store.get_kv(key)
    now = ctx.now()
    if kept and now - datetime.fromisoformat(kept["at"]) < SPACE_TTL:
        return kept["info"]
    info = {"space": space, "name": "", "external": False, "error": ""}
    try:
        got = (client or chatapi.client_for(ctx)).get_space(space)
        info.update(name=got["display_name"], external=bool(got["external"]))
        ctx.store.put_kv(key, {"at": now.isoformat(), "info": info})
    except chatapi.NotSignedIn:
        info["error"] = "The QA chatbot is not signed in to Chat. Sign it in under Integrations, Google Chat."
    except chatapi.ChatError as exc:
        bot = ctx.config.agent.email or "the QA chatbot's account"
        info["error"] = (f"The QA chatbot can't open this space. Add {bot} to it." if exc.status in (403, 404)
                         else f"Chat did not answer for this space: {exc}")
    return info


def spaces(ctx: "AgentContext", client: Any = None) -> dict[str, dict[str, Any] | None]:
    r = ctx.config.platform.routing
    out: dict[str, dict[str, Any] | None] = {}
    for key in ("source", "mirror", "third"):
        ref = _ref(getattr(r, key))
        out[key] = space_info(ctx, client, ref) if ref else None
    return out


def problems(ctx: "AgentContext", sp: dict[str, dict[str, Any] | None]) -> dict[str, str]:
    """Why each space can't be used as set, or "". A copy space is never the source and never open to outsiders."""
    src, mir, third = sp["source"], sp["mirror"], sp["third"]
    out = {"source": (src or {}).get("error", ""), "mirror": "", "third": ""}
    outside = "People outside Google can join this space. Use a space only Google people can join."
    if mir:
        out["mirror"] = (mir["error"] or ("The second space can't be the source space." if src and _same(mir["space"], src["space"]) else "")
                         or (outside if mir["external"] else ""))
    if third:
        out["third"] = (third["error"] or ("The third space can't be the source space." if src and _same(third["space"], src["space"]) else "")
                        or ("The third space and the second space are the same space." if mir and _same(third["space"], mir["space"]) else "")
                        or (outside if third["external"] else "")
                        or ("The third space is fed from the second space. Set the second space first." if not mir else ""))
    return out


def refusal(ctx: "AgentContext", space: str, client: Any = None, approved: bool = False) -> str:
    """Why a write in `space` is not allowed right now, or "". Asked before every post and emoji."""
    r = ctx.config.platform.routing
    if _same(space, _ref(r.source)):
        m = mode(ctx)
        if not m["live"]:
            return f"Nothing is written in the source space: {m['why']}."
        if r.ask_before_source and not approved:
            return "Nothing is written in the source space until a person presses Send on the Routing page."
        return ""
    info = space_info(ctx, client, space)
    if info["error"]:
        return f"Refusing to write in {space}: {info['error']}"
    if info["external"]:
        return f"Refusing to write in {space}: people outside Google can join it and it is not the source space."
    return ""


def is_source_target(ctx: "AgentContext", target: str) -> bool:
    """True when one of the agent's post targets (burson, clean, ...) is the Routing page's source space."""
    src = _ref(ctx.config.platform.routing.source)
    ref = ctx.config.space(target) if src else None
    return bool(ref) and any(_same(_ref(v), src) for v in (ref.url, ref.space_id) if v)


# ---------------------------------------------------------------------------------------------------------------
# Writing in the source space: straight away, or after a person's Send
# ---------------------------------------------------------------------------------------------------------------

def _leaks(ctx: "AgentContext", text: str) -> list[str]:
    from . import safety

    return [] if not (space_info(ctx, None, _ref(ctx.config.platform.routing.source)).get("external")) else safety.leak_guard(ctx.config, text).hits


def send(ctx: "AgentContext", text: str, *, thread: str = "", origin: str = "", case_id: str = "", actor: str = "agent") -> dict[str, Any]:
    """A message for the source space: posted, queued for a person's Send, or held, as the Routing page says."""
    r = ctx.config.platform.routing
    text = safety.unmarked(ctx.config, text) if is_source_target(ctx, "burson") else text
    m = mode(ctx)
    if not m["live"]:
        return {"status": "held", "why": m["why"]}
    hits = _leaks(ctx, text)
    if hits:
        return {"status": "held", "why": "it names something internal: " + ", ".join(hits[:4])}
    item_id = uuid.uuid4().hex[:16]
    if r.ask_before_source:
        ctx.store.put_doc(QUEUE, item_id, {"id": item_id, "text": text, "thread": thread, "origin": origin, "case_id": case_id,
                                           "status": "waiting", "at": ctx.now().isoformat(), "n": time.time_ns(), "by": "", "message": ""})
        audit.record(ctx, actor=actor, action="routing.queue", surface="agent", target_type="message", target_id=item_id,
                     summary="A message for the source space is waiting for Send or Skip", case_id=case_id or None)
        return {"status": "waiting", "id": item_id}
    posted = chatapi.client_for(ctx).post_message(_ref(r.source), text, thread=thread, key=f"src:{item_id}", id_prefix=chatapi.SOURCE_PREFIX)
    audit.record(ctx, actor=actor, action="routing.post", surface="agent", target_type="message", target_id=posted["name"],
                 summary="Posted in the source space", case_id=case_id or None)
    return {"status": "sent", "message": posted["name"]}


def reply_in_copies(ctx: "AgentContext", text: str, *, thread: str = "", origin: str = "", case_id: str = "") -> dict[str, Any] | None:
    """A reply the bot may not write in the source space, kept for the copy spaces: with a second space set, the minute
    run posts it there and on to the third, under the copy of the message it answers. None when there is no second
    space. Nothing here, and nothing that posts it, writes in the source space."""
    r = ctx.config.platform.routing
    text = safety.unmarked(ctx.config, text) if is_source_target(ctx, "burson") else text
    if not r.bot_on or not r.mirror.strip() or not text.strip():
        return None
    item_id = uuid.uuid4().hex[:16]
    doc = {"id": item_id, "text": text[:MAX_CHARS], "source_thread": thread, "origin": origin, "case_id": case_id, "status": "waiting", "why": "",
           "tries": 0, "at": ctx.now().isoformat(), "n": time.time_ns(), "mirror": "", "third": ""}
    ctx.store.put_doc(OWN_REPLIES, item_id, doc)
    return doc


def _own_replies(ctx: "AgentContext", client: Any, sp: dict[str, Any], third_ok: bool, out: dict[str, Any]) -> None:
    """Post the waiting replies in the second space, then the third, oldest first. One whose alert has not been copied
    yet waits for it; after a day it is given up, never posted on its own."""
    spaces_ = [("mirror", sp["mirror"]["space"])] + ([("third", sp["third"]["space"])] if third_ok else [])
    limit, now = ctx.config.platform.routing.max_tries, ctx.now()
    for doc in sorted(ctx.store.list_docs(OWN_REPLIES, where={"status": "waiting"}, limit=200), key=lambda d: (d["at"], d.get("n", 0))):
        try:
            for side, space in spaces_:
                if doc[side]:
                    continue
                under = _thread(ctx, doc["source_thread"], side) if doc["source_thread"] else ""
                if doc["source_thread"] and not under:
                    if datetime.fromisoformat(doc["at"]) <= now - MAX_GAP:
                        doc.update(status="gave_up", why="The message it answers never reached the second space.")
                    break
                doc[side] = client.post_message(space, doc["text"], thread=under, key=f"own:{doc['id']}", id_prefix=chatapi.OWN_PREFIX)["name"]
                if side == "mirror":
                    out["replies"] += 1
                    audit.record(ctx, actor="agent", action="routing.reply_copied", surface="agent", target_type="message", target_id=doc[side],
                                 summary="Posted the bot's reply for the source space in the second space", case_id=doc.get("case_id") or None,
                                 detail={"origin": doc.get("origin") or ""})
            else:
                doc.update(status="posted", why="")
        except Exception as exc:  # noqa: BLE001 - kept on the row and tried again next minute
            doc["tries"] += 1
            doc["why"] = str(exc)[:300]
            if doc["tries"] >= limit:
                doc["status"] = "gave_up"
        ctx.store.put_doc(OWN_REPLIES, doc["id"], doc)


def queue(ctx: "AgentContext") -> list[dict[str, Any]]:
    return sorted(ctx.store.list_docs(QUEUE, where={"status": "waiting"}, limit=200), key=lambda d: (d["at"], d.get("n", 0)))


def decide(ctx: "AgentContext", item_id: str, action: str, actor: str) -> dict[str, Any]:
    """A person's Send or Skip on a waiting message. Send posts it once, and only while the rules still allow it."""
    doc = ctx.store.get_doc(QUEUE, item_id)
    if not doc:
        raise KeyError(item_id)
    if doc["status"] != "waiting":
        raise Conflict(f"This message was already {doc['status']}.")
    if action == "send":
        m = mode(ctx)
        if not m["live"]:
            raise Conflict(f"Not sent: {m['why']}.")
        hits = _leaks(ctx, doc["text"])
        if hits:
            raise Conflict("Not sent: it names something internal: " + ", ".join(hits[:4]))
        client = chatapi.client_for(ctx)
        client.approved = True
        posted = client.post_message(_ref(ctx.config.platform.routing.source), doc["text"], thread=doc.get("thread") or "",
                                     key=f"queue:{item_id}", id_prefix=chatapi.SOURCE_PREFIX)
        doc.update(status="sent", message=posted["name"])
    elif action == "skip":
        doc["status"] = "skipped"
    else:
        raise ValueError("Choose Send or Skip.")
    doc.update(by=actor, decided_at=ctx.now().isoformat())
    ctx.store.put_doc(QUEUE, item_id, doc)
    audit.record(ctx, actor=actor, action=f"routing.{action}", surface="console", target_type="message", target_id=item_id,
                 summary=("Sent a message to the source space" if action == "send" else "Skipped a message for the source space"),
                 case_id=doc.get("case_id") or None, detail={"text": doc["text"][:300]})
    return doc


# ---------------------------------------------------------------------------------------------------------------
# The copy: source -> second space -> third space
# ---------------------------------------------------------------------------------------------------------------

def _what(m: dict[str, Any], everything: bool) -> str:
    """'alert', 'reply' or 'message' for a message that is copied; "" for one that is not."""
    if chatapi.OWN_ID.match(m["client_id"]):
        return ""  # the bot's own work is never copied
    app = m["sender_type"] == "BOT" or bool(re.search(r"\bzapier\b", m["sender_display"], re.I))
    if app and not m["reply"]:
        return "alert"
    if not everything or app:
        return ""  # another app's reply in a thread is never copied
    return "reply" if m["reply"] else "message"


def alert_text(m: dict[str, Any]) -> str:
    """An alert's own text, without Zapier's credit line; the card's text when the message has no text."""
    clean = lambda s: _CREDIT.sub("", s or "").strip()  # noqa: E731
    return (clean(m["text"]) or clean(m["card_text"]))[:MAX_CHARS + 200]


def _person(ctx: "AgentContext", m: dict[str, Any], seen_in: str) -> str:
    """How a person is shown in a copy: their name, with (Burson) or (Google) once someone marked them."""
    user = m["sender"] or "unknown"
    doc = ctx.store.get_doc(PEOPLE, _id(user))
    if not doc:
        doc = {"user": user, "name": m["sender_display"], "org": "", "first_seen": ctx.now().isoformat(), "seen_in": seen_in,
               "example": (m["text"] or "(no text)")[:80]}
        ctx.store.put_doc(PEOPLE, _id(user), doc)
    name = (doc.get("name") or m["sender_display"] or "Someone").strip()[:60]
    return f"{name} ({doc['org']})" if doc.get("org") else name


def _body(m: dict[str, Any]) -> str:
    text = (m["text"] or "").strip()
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + "… [cut short]"
    files = [f for f in m["files"] if f]
    note = f"[{'a file' if len(files) == 1 else f'{len(files)} files'}: {', '.join(files)}, not attached here]" if files else ""
    return "\n".join(t for t in (text, note) if t)


def _state(ctx: "AgentContext", sp: dict[str, Any], now: datetime) -> dict[str, Any]:
    """How far the copy has got. A new source or second space starts from the last few minutes; so does a new third."""
    st = ctx.store.get_kv(STATE) or {}
    start = (now - timedelta(minutes=ctx.config.platform.routing.start_minutes)).isoformat()
    ids = {k: (sp[k] or {}).get("space", "") for k in ("source", "mirror", "third")}
    if st.get("source") != ids["source"] or st.get("mirror") != ids["mirror"]:
        st.update(source=ids["source"], mirror=ids["mirror"], floor=start, cursor=start)
    if st.get("third") != ids["third"]:
        st.update(third=ids["third"], third_floor=start)
    return st


def _thread(ctx: "AgentContext", source_thread: str, side: str, value: str = "") -> str:
    """The thread on `side` (mirror | third) that matches a source thread; given `value`, remembers it the first time."""
    key = _id(source_thread)
    doc = ctx.store.get_doc(THREADS, key) or {"source": source_thread, "mirror": "", "third": ""}
    if value and not doc.get(side):
        doc[side] = value
        ctx.store.put_doc(THREADS, key, doc)
    return doc.get(side) or ""


def _push(ctx: "AgentContext", client: Any, third: str, doc: dict[str, Any]) -> None:
    """One message that reached the second space, copied on to the third: same text, under the matching message."""
    thread = _thread(ctx, doc["source_thread"], "third") if doc["what"] == "reply" else ""
    prefix = chatapi.MIRROR_PREFIX if doc["what"] == "alert" else chatapi.RELAY_PREFIX
    posted = client.post_message(third, doc["text"], thread=thread, key=f"third:{doc['source']}", id_prefix=prefix)
    _thread(ctx, doc["source_thread"], "third", posted["thread"])
    doc.update(third={"name": posted["name"], "thread": posted["thread"]}, third_done=True, third_why="")


def _push_waiting(ctx: "AgentContext", client: Any, third: str, st: dict[str, Any], out: dict[str, Any]) -> bool:
    """Third-space copies still owed, oldest first. False when one failed and holds the rest."""
    limit = ctx.config.platform.routing.max_tries
    for doc in sorted(ctx.store.list_docs(COPIES, where={"third_done": False}, limit=500), key=lambda d: d["at"]):
        if doc["status"] != "copied":
            continue
        if doc["at"] < st.get("third_floor", "") or not third:
            doc["third_done"] = True
        else:
            try:
                _push(ctx, client, third, doc)
                out["copied"]["third"] += 1
            except Exception as exc:  # noqa: BLE001 - recorded on the row; the rest wait behind it
                doc["third_tries"] = int(doc.get("third_tries") or 0) + 1
                doc["third_why"] = str(exc)[:300]
                doc["third_done"] = doc["third_tries"] >= limit
                ctx.store.put_doc(COPIES, doc["id"], doc)
                if not doc["third_done"]:
                    return False
                continue
        ctx.store.put_doc(COPIES, doc["id"], doc)
    return True


def _copy(ctx: "AgentContext", client: Any, sp: dict[str, Any], third_ok: bool, out: dict[str, Any]) -> None:
    r = ctx.config.platform.routing
    now = ctx.now()
    src, mir = sp["source"]["space"], sp["mirror"]["space"]
    third = sp["third"]["space"] if third_ok else ""
    st = _state(ctx, sp, now)
    floor, cursor = datetime.fromisoformat(st["floor"]), datetime.fromisoformat(st["cursor"])
    since = max(cursor - OVERLAP, floor, now - MAX_GAP)
    read_from = min(since, now - timedelta(hours=r.emoji_hours)) if r.copy_everything else since
    messages = client.list_messages(src, read_from)
    pushing = _push_waiting(ctx, client, third, st, out)
    done = 0
    for m in messages:
        at = m["create_time"]
        if at <= since:
            continue
        key = _id(m["name"])
        doc = ctx.store.get_doc(COPIES, key)
        what = "" if doc and doc["status"] != "waiting" else _what(m, r.copy_everything)
        text = "" if not what else alert_text(m) if what == "alert" else _body(m)
        if not what or not text:
            cursor = max(cursor, at)
            continue
        if done >= r.max_per_run:
            break
        doc = doc or {"id": key, "source": m["name"], "source_thread": m["thread"], "at": at.isoformat(), "what": what, "user": m["sender"],
                      "who": "", "text": "", "status": "waiting", "why": "", "tries": 0, "mirror": None, "third": None,
                      "third_done": not sp["third"], "emojis": {"mirror": [], "third": []}}
        try:
            if what != "alert":
                doc["who"] = _person(ctx, m, sp["source"]["name"] or "the source space")
                text = f"{doc['who']}: {text}"
                if what == "reply":
                    from . import chatreactions

                    chatreactions.acknowledge_source_reply(ctx, m, who=doc["who"])
            posted = client.post_message(mir, text, thread=_thread(ctx, m["thread"], "mirror") if what == "reply" else "",
                                         key=f"{'zmir' if what == 'alert' else 'zrly'}:{m['name']}",
                                         id_prefix=chatapi.MIRROR_PREFIX if what == "alert" else chatapi.RELAY_PREFIX)
        except Exception as exc:  # noqa: BLE001 - one that can't go yet holds the rest, so nothing arrives out of order
            doc["tries"] += 1
            doc["why"] = str(exc)[:300]
            doc["text"] = doc["text"] or text
            gave_up = doc["tries"] >= r.max_tries
            if gave_up:
                doc.update(status="gave_up", third_done=True)
                cursor = max(cursor, at)
            ctx.store.put_doc(COPIES, key, doc)
            if gave_up:
                continue
            break
        _thread(ctx, m["thread"], "mirror", posted["thread"])
        doc.update(status="copied", why="", text=text, mirror={"name": posted["name"], "thread": posted["thread"]})
        out["copied"]["mirror"] += 1
        done += 1
        cursor = max(cursor, at)
        if third and pushing:
            try:
                _push(ctx, client, third, doc)
                out["copied"]["third"] += 1
            except Exception as exc:  # noqa: BLE001 - tried again next minute, ahead of anything newer
                doc.update(third_tries=1, third_why=str(exc)[:300])
                pushing = False
        ctx.store.put_doc(COPIES, key, doc)
    st["cursor"] = cursor.isoformat()
    ctx.store.put_kv(STATE, st)
    if r.copy_everything:
        _emojis(ctx, client, messages, bool(third), out)


def _emojis(ctx: "AgentContext", client: Any, messages: list[dict[str, Any]], third: bool, out: dict[str, Any]) -> None:
    """Each emoji on a source message goes once onto its copies, as the bot's account, and acknowledges its Case."""
    from . import chatreactions

    for m in messages:
        if not m["emojis"]:
            continue
        chatreactions.record_source_emojis(ctx, m["name"], m["emojis"], m.get("thread") or "")
        if out["emojis"] >= EMOJIS_PER_RUN:
            continue
        doc = ctx.store.get_doc(COPIES, _id(m["name"]))
        if not doc or doc["status"] != "copied":
            continue
        changed = False
        for side in ("mirror", "third") if third else ("mirror",):
            target = (doc.get(side) or {}).get("name")
            for e in m["emojis"]:
                if not target or e["emoji"] in doc["emojis"][side]:
                    continue
                try:
                    client.react(target, e["emoji"])
                except Exception:  # noqa: BLE001 - tried again next minute
                    continue
                doc["emojis"][side].append(e["emoji"])
                out["emojis"] += 1
                changed = True
        if changed:
            ctx.store.put_doc(COPIES, doc["id"], doc)


def run(ctx: "AgentContext") -> dict[str, Any]:
    """One pass, once a minute: read the source, copy what is new to the second space and on to the third."""
    out: dict[str, Any] = {"ok": True, "off": not ctx.config.platform.routing.bot_on, "copied": {"mirror": 0, "third": 0}, "emojis": 0,
                           "replies": 0, "problems": {}, "error": ""}
    if out["off"]:
        return out
    try:
        client = chatapi.client_for(ctx)
        sp = spaces(ctx, client)
        out["problems"] = probs = problems(ctx, sp)
        if sp["source"] and sp["mirror"] and not probs["source"] and not probs["mirror"]:
            _copy(ctx, client, sp, bool(sp["third"]) and not probs["third"], out)
            _own_replies(ctx, client, sp, bool(sp["third"]) and not probs["third"], out)  # after the copy, so each lands under its alert
    except Exception as exc:  # noqa: BLE001 - shown on the Routing page; the next minute tries again
        out.update(ok=False, error=str(exc)[:300])
    ctx.store.put_kv(LAST, {**out, "at": ctx.now().isoformat()})
    return out


def status(ctx: "AgentContext") -> dict[str, Any]:
    """Everything the Routing page shows."""
    r = ctx.config.platform.routing
    sp = spaces(ctx)
    copies = sorted(ctx.store.list_docs(COPIES, limit=100), key=lambda d: d["at"], reverse=True)
    return {
        "value": {k: getattr(r, k) for k in ("bot_on", "source", "mirror", "third", "copy_everything", "ask_before_source")},
        "safety_valve": ctx.config.platform.safety.testing, "mode": mode(ctx), "spaces": sp, "problems": problems(ctx, sp),
        "signed_in": chatapi.signed_in(ctx), "bot": ctx.config.agent.email, "last_run": ctx.store.get_kv(LAST),
        "queue": [{k: q.get(k, "") for k in ("id", "text", "origin", "case_id", "at")} for q in queue(ctx)],
        "replies": [{k: d.get(k, "") for k in ("at", "text", "status", "why", "case_id", "mirror", "third")}
                    for d in sorted(ctx.store.list_docs(OWN_REPLIES, limit=100), key=lambda d: (d["at"], d.get("n", 0)), reverse=True)],
        "copies": [{"at": d["at"], "what": d["what"], "who": d["who"], "text": d["text"], "status": d["status"], "why": d["why"],
                    "mirror": (d.get("mirror") or {}).get("name", ""), "third": (d.get("third") or {}).get("name", ""),
                    "third_why": d.get("third_why", "")} for d in copies],
        "people": sorted(({k: p.get(k, "") for k in ("user", "name", "org", "first_seen", "seen_in", "example")}
                          for p in ctx.store.list_docs(PEOPLE, limit=500)), key=lambda p: p["first_seen"]),
    }


def name_person(ctx: "AgentContext", user: str, name: str, org: str, actor: str) -> dict[str, Any]:
    """A person's name and side (Burson or Google), typed in once: how their messages are shown from then on."""
    if org not in ORGS:
        raise ValueError("Choose Burson, Google, or leave it blank.")
    doc = ctx.store.get_doc(PEOPLE, _id(user))
    if not doc:
        raise KeyError(user)
    doc.update(name=name.strip()[:60], org=org)
    ctx.store.put_doc(PEOPLE, _id(user), doc)
    audit.record(ctx, actor=actor, action="routing.person", surface="console", target_type="person", target_id=user,
                 summary=f"Named a person seen in Chat: {doc['name'] or 'no name'} {('(' + org + ')') if org else ''}".strip())
    return doc
