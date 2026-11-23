"""Alerts reviewed through the QA chatbot's own Chat sign-in, with no Chat flow in between.

Every minute, with the switch "Review alerts read from Chat" ON and the QA chatbot ON, the bot's account reads the source
space on the Routing page and hands each new message, once, to the review a Chat flow would hand it to
(op triage_message). What the review wants posted is queued, as it is for a Console action: nothing is written in Chat
here. A message whose review fails is tried again each minute and given up after the Routing page's number of tries; it
never holds the messages behind it.
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

ROWS, STATE, LAST = "chat_review", "chat_review:state", "chat_review:last"
SWITCH = "chat_review"
DONE = ("reviewed", "ignored", "gave_up")


def why_off(ctx: "AgentContext") -> str:
    """Why nothing is read right now, or ""."""
    r = ctx.config.platform.routing
    if not ctx.flag(SWITCH):
        return f"the switch {switch_title(SWITCH)} is OFF"
    if not r.bot_on:
        return "the QA chatbot is OFF"
    if not r.source.strip():
        return "no source space is set"
    return ""


def _message(m: dict[str, Any], space: str) -> dict[str, Any]:
    """A Chat message as the review takes it: an app's alert without Zapier's credit line, a person's message as written."""
    app = m["sender_type"] == "BOT" or bool(re.search(r"\bzapier\b", m["sender_display"], re.I))
    return {"message_id": m["name"], "text": mirror.alert_text(m) if app else (m["text"] or "").strip(),
            "sender": {"name": m["sender_display"] or None, "type": "BOT" if app else "HUMAN"}, "space_id": space,
            "thread_id": m["thread"] or None, "create_time": m["create_time"].isoformat(), "conversation_type": "SPACE"}


def _review(ctx: "AgentContext", m: dict[str, Any], space: str, doc: dict[str, Any] | None, out: dict[str, Any]) -> dict[str, Any]:
    """Hand one message to the review and keep what came of it."""
    message = _message(m, space)
    doc = doc or {"id": mirror._id(m["name"]), "message": m["name"], "at": m["create_time"].isoformat(), "text": message["text"][:300],
                  "status": "waiting", "tries": 0, "why": "", "case_id": "", "verdict": "", "summary": "", "queued": 0, "held": []}
    if not message["text"]:
        doc.update(status="ignored", summary="no text")
        out["ignored"] += 1
        return doc
    error = ""
    try:
        resp = handle({"op": "triage_message", "payload": {"message": message},
                       "context": {"deliver": "outbox", "flow": "chat", "invoked_by": "agent"}}, ctx)
        if not resp.ok:
            error = resp.error or "the review failed"
    except Exception as exc:  # noqa: BLE001 - kept on the row and tried again next minute
        error = str(exc)
    if error:
        doc["tries"] += 1
        doc["why"] = error[:300]
        out["failed"] += 1
        if doc["tries"] >= ctx.config.platform.routing.max_tries:
            doc["status"] = "gave_up"
        return doc
    case_id = resp.outputs.get("case_id") or ""
    doc.update(status="reviewed" if case_id else "ignored", why="", case_id=case_id, verdict=resp.outputs.get("verdict") or "",
               summary=(resp.outputs.get("summary") or "")[:300], queued=len(resp.data.get("queued_outbox_ids") or []),
               held=[{"target": h.get("target"), "check": h.get("check")} for h in resp.data.get("held_outputs") or []])
    out["reviewed" if case_id else "ignored"] += 1
    if case_id:
        audit.record(ctx, actor="agent", action="chat.review", surface="agent", target_type="message", target_id=m["name"],
                     summary=f"Reviewed an alert read from the source space: {doc['verdict'] or 'no verdict'}", case_id=case_id,
                     detail={"queued": doc["queued"], "held": doc["held"]})
    return doc


def _read(ctx: "AgentContext", client: Any, out: dict[str, Any]) -> None:
    r = ctx.config.platform.routing
    now = ctx.now()
    space = mirror._ref(r.source)
    st = ctx.store.get_kv(STATE) or {}
    if st.get("source") != space:  # a new source space is read from the last few minutes, as the copy is
        start = (now - timedelta(minutes=r.start_minutes)).isoformat()
        st = {"source": space, "floor": start, "cursor": start}
    floor, cursor = datetime.fromisoformat(st["floor"]), datetime.fromisoformat(st["cursor"])
    since = max(cursor - mirror.OVERLAP, floor, now - mirror.MAX_GAP)
    waiting: datetime | None = None  # the oldest message still to be reviewed: the cursor never passes it
    done = 0
    for m in client.list_messages(space, since):
        at = m["create_time"]
        if at <= since or chatapi.OWN_ID.match(m["client_id"]):
            continue  # the bot's own posts are never read as alerts
        doc = ctx.store.get_doc(ROWS, mirror._id(m["name"]))
        if doc and doc["status"] in DONE:
            cursor = max(cursor, at) if waiting is None else cursor
            continue
        if done >= r.max_per_run:
            waiting = waiting or at
            continue
        doc = _review(ctx, m, space, doc, out)
        ctx.store.put_doc(ROWS, doc["id"], doc)
        if doc.get("case_id") and m.get("emojis"):
            from . import chatreactions

            chatreactions.record_source_emojis(ctx, m["name"], m["emojis"], m.get("thread") or "")
        done += 1
        if doc["status"] in DONE:
            cursor = max(cursor, at) if waiting is None else cursor
        else:
            waiting = waiting or at
    st["cursor"] = (min(cursor, waiting - timedelta(microseconds=1)) if waiting else cursor).isoformat()
    ctx.store.put_kv(STATE, st)


def run(ctx: "AgentContext") -> dict[str, Any]:
    """One pass, once a minute: read the source space and review what is new."""
    why = why_off(ctx)
    if why:
        return {"ok": True, "off": True, "why": why}
    out: dict[str, Any] = {"ok": True, "off": False, "reviewed": 0, "ignored": 0, "failed": 0, "error": ""}
    try:
        _read(ctx, chatapi.client_for(ctx), out)
    except Exception as exc:  # noqa: BLE001 - shown on the Routing page; the next minute tries again
        out.update(ok=False, error=str(exc)[:300])
    ctx.store.put_kv(LAST, {**out, "at": ctx.now().isoformat()})
    return out


def status(ctx: "AgentContext") -> dict[str, Any]:
    """What the Routing page shows about the review: whether it runs, what the last pass did, and the last 100 messages."""
    why = why_off(ctx)
    rows = sorted(ctx.store.list_docs(ROWS, limit=100), key=lambda d: d["at"], reverse=True)
    return {"on": not why, "why": why, "switch": ctx.flag(SWITCH), "last_run": ctx.store.get_kv(LAST),
            "rows": [{k: d.get(k) for k in ("at", "message", "text", "status", "why", "tries", "case_id", "verdict", "summary", "queued", "held")}
                     for d in rows]}
