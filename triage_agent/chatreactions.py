"""Emoji reactions read from Google Chat (source space + analysts' copy/clean space), matching Bot.gs & Relay.gs.

Two things happen without needing a Chat app or Studio flow:
  1. Source-space reactions (`record_source_emojis` & `acknowledge_source_reply`, called when `mirror` or `chatreview`
     reads the source space):
     When an Incident Manager reacts or replies on an alert in the source space (e.g. `[S-F] Burson`), the emoji is
     copied onto the mirrored post AND recorded on the matched `Case` (`acknowledged_at` + `ActionRecord`), so SLA
     timers, IM response-time metrics, and Parity comparisons reflect the real IM reaction immediately — without
     creating duplicate email drafts.
  2. Analyst/mirror-space reactions (`run`, called once a minute in `maintenance`):
     Reads recent messages in the `clean` / `mirror` space (`SLRR Agentic Assistant`), subtracts any emojis that
     `mirror` itself copied over from the source space (`withoutRelayedEmojis_` in `Bot.gs`), matches either the
     agent's `TRG-` alert post OR the mirrored alert copy to its `Case`, and invokes `record_reaction` (`👍`
     acknowledge, `📦` Gmail draft, `✍️` T&S pre-fill, `❌` close, etc.), posting any confirmation reply in that
     message's thread. While Testing (`safety.testing`) is ON, nothing is ever written back to the source space or
     live team spaces, and drafts go strictly to the testing recipient.
"""

from __future__ import annotations

import hashlib
import logging
import re
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from . import actions, audit, chatapi, chatreview, mirror, safety
from .events import EventType
from .models import ActionRecord, ChatMessage
from .operations import handle

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext
    from .models import Case

log = logging.getLogger(__name__)

SRC_SEEN = "chat_reactions_src"   # {id, case_id, message, emoji, code, at}
CLEAN_SEEN = "chat_reactions"     # {id, case_id, message, emoji, code, status, reply, at}
LAST = "chat_reactions:last"
SOURCE_ACK_EMOJIS = frozenset({"👀", "✅", "🫡", "🙏", "👍", "👌", "🙌"})
_SKIN_RX = re.compile(r"[\U0001f3fb-\U0001f3ff]")


def bare(emoji: str) -> str:
    """Normalize an emoji by stripping variation selectors, keycap combiners, and skin-tone modifiers."""
    s = (emoji or "").strip().replace("\ufe0f", "").replace("\u20e3", "")
    return _SKIN_RX.sub("", s)


def _match_action(ctx: "AgentContext", raw_emoji: str):
    return ctx.config.action(raw_emoji) or ctx.config.action(bare(raw_emoji))


def find_case_for_source_message(ctx: "AgentContext", source_msg_name: str, thread_name: str = "") -> "Case | None":
    """Resolve a source-space alert message (or thread) to its triaged `Case`, if one exists."""
    if source_msg_name:
        rev = ctx.store.get_doc(chatreview.ROWS, mirror._id(source_msg_name))
        cid = (rev or {}).get("case_id") or ""
        if cid:
            found = ctx.store.get_case(cid)
            if found is not None:
                return found
    wanted_msg = source_msg_name.strip()
    wanted_thr = thread_name.strip()
    if not wanted_msg and not wanted_thr:
        return None
    for case in ctx.store.list_cases(limit=300):
        for att in case.attempts:
            mid = (att.message.message_id or "").strip()
            tid = (att.message.thread_id or "").strip()
            if wanted_msg and mid == wanted_msg:
                return case
            if wanted_thr and (tid == wanted_thr or mid == wanted_thr):
                return case
    return None


def record_source_emojis(ctx: "AgentContext", source_msg_name: str, emojis: list[dict[str, Any]],
                         thread_name: str = "") -> int:
    """Record IM emoji reactions placed on an alert in the source space (`[S-F] Burson`) onto its `Case`."""
    if not source_msg_name or not emojis:
        return 0
    case = find_case_for_source_message(ctx, source_msg_name, thread_name)
    if case is None:
        return 0
    recorded = 0
    now = ctx.now()
    for e in emojis:
        raw = str(e.get("emoji") or "").strip()
        if not raw:
            continue
        action = _match_action(ctx, raw)
        if action is not None:
            code, canonical = action.code, action.emoji
        elif bare(raw) in SOURCE_ACK_EMOJIS:
            code, canonical = "ack", raw
        else:
            continue
        seen_id = hashlib.sha256(f"{case.case_id}|{source_msg_name}|{code}".encode()).hexdigest()[:32]
        if ctx.store.get_doc(SRC_SEEN, seen_id):
            continue
        first = case.acknowledged_at is None
        if first:
            case.acknowledged_at = now
            latency = max(0.0, round((now - (case.clean_posted_at or case.created_at)).total_seconds(), 1))
            ctx.emit(EventType.ALERT_ACKNOWLEDGED, case_id=case.case_id, actor="source_im", space="burson",
                     message_ref=source_msg_name, payload={"ack_latency_s": latency, "code": code, "via": "source_reaction"})
        if not any(a.code == code and a.actor == "source_im" for a in case.actions):
            case.actions.append(ActionRecord(code=code, emoji=canonical, actor="source_im", at=now,
                                             note="from source space"))
            ctx.emit(EventType.ACTION_RECORDED, case_id=case.case_id, actor="source_im", space="burson",
                     message_ref=source_msg_name, payload={"code": code, "emoji": canonical, "kind": action.kind if action else "ack",
                                                           "via": "source_reaction"})
        ctx.store.save_case(case)
        ctx.store.put_doc(SRC_SEEN, seen_id, {"id": seen_id, "case_id": case.case_id, "message": source_msg_name,
                                              "emoji": canonical, "code": code, "at": now.isoformat()})
        recorded += 1
    return recorded


def acknowledge_source_reply(ctx: "AgentContext", m: dict[str, Any], *, who: str = "") -> bool:
    """When a Google IM replies in an alert's thread in the source space, mark the `Case` acknowledged."""
    if not m.get("reply") or not m.get("thread") or m.get("sender_type") == "BOT":
        return False
    sender = str(m.get("sender") or "")
    person = ctx.store.get_doc(mirror.PEOPLE, mirror._id(sender)) if sender else None
    org = (person or {}).get("org") or ("Google" if who.endswith("(Google)") else "Burson" if who.endswith("(Burson)") else "")
    if org == "Burson":
        return False
    if org != "Google":
        known = ctx.store.get_kv("chat_answers:known") or {}
        email = ((known.get("users") or {}).get(sender) or "").strip().lower()
        im_emails = {a.email.lower() for a in ctx.config.analysts} | {p.email.lower() for p in ctx.roster("slrr_im").people if p.email}
        if not email or email not in im_emails:
            return False
    case = find_case_for_source_message(ctx, "", str(m.get("thread") or ""))
    if case is None or case.acknowledged_at is not None:
        return False
    now = ctx.now()
    case.acknowledged_at = now
    latency = max(0.0, round((now - (case.clean_posted_at or case.created_at)).total_seconds(), 1))
    ctx.emit(EventType.ALERT_ACKNOWLEDGED, case_id=case.case_id, actor="source_im", space="burson",
             message_ref=str(m.get("name") or ""), payload={"ack_latency_s": latency, "code": "reply", "via": "source_reply"})
    ctx.store.save_case(case)
    return True


def without_relayed_emojis(emojis: list[dict[str, Any]], relayed_list: list[str]) -> list[dict[str, Any]]:
    """Subtract 1 count per emoji that `mirror` copied over from the source space (`Bot.gs` `withoutRelayedEmojis_`)."""
    if not emojis:
        return []
    budget: dict[str, int] = {}
    for e in relayed_list or []:
        k = bare(e)
        if k:
            budget[k] = budget.get(k, 0) + 1
    out: list[dict[str, Any]] = []
    for item in emojis:
        raw = str(item.get("emoji") or "").strip()
        cnt = int(item.get("count") or 1)
        k = bare(raw)
        used = min(cnt, budget.get(k, 0))
        if used:
            budget[k] -= used
        rem = cnt - used
        if rem > 0 and raw:
            out.append({"emoji": raw, "count": rem})
    return out


def _analyst_spaces(ctx: "AgentContext") -> list[str]:
    """Internal analyst/mirror spaces polled for direct emoji reactions (never the source or live partner spaces)."""
    r = ctx.config.platform.routing
    src = mirror._ref(r.source)
    candidates: list[str] = []
    clean_ref = ctx.config.space("clean")
    if clean_ref:
        s = chatapi.space_name(clean_ref.space_id, clean_ref.url)
        if s:
            candidates.append(s)
    for raw in (r.mirror, r.third):
        s = mirror._ref(raw)
        if s:
            candidates.append(s)
    out: list[str] = []
    for s in candidates:
        if src and mirror._same(s, src):
            continue
        if not any(mirror._same(s, x) for x in out):
            out.append(s)
    return out


def _default_reactor_email(ctx: "AgentContext") -> str:
    """Chat message summaries do not expose per-reactor emails without reactions.readonly scope; resolve safe actor."""
    testers = safety.testing_recipients(ctx.config)
    if testers is not None:
        return testers[0] if testers else ""
    im = ctx.im_on_shift().person
    if im and im.email:
        return im.email
    leads = ctx.config.lead_emails()
    if leads:
        return leads[0]
    return (ctx.config.agent.email or "").strip()


def _copy_index(ctx: "AgentContext") -> dict[str, dict[str, Any]]:
    idx: dict[str, dict[str, Any]] = {}
    for doc in ctx.store.list_docs(mirror.COPIES, limit=500):
        for side in ("mirror", "third"):
            name = ((doc.get(side) or {}).get("name") or "").strip()
            if name:
                idx[name] = {"doc": doc, "side": side}
    return idx


def why_off(ctx: "AgentContext") -> str:
    r = ctx.config.platform.routing
    if not r.bot_on:
        return "the QA chatbot is OFF"
    if not (ctx.flag("chat_review") or ctx.flag("chat_delivery") or ctx.flag("chat_answers")):
        return "Chat review, delivery, and answers switches are all OFF"
    if not _analyst_spaces(ctx) and not mirror._ref(r.source):
        return "no Chat space is set"
    return ""


def run(ctx: "AgentContext") -> dict[str, Any]:
    """Once a minute: read reactions in the analyst/mirror space (and source space if not already covered by mirror)."""
    why = why_off(ctx)
    if why:
        return {"ok": True, "off": True, "why": why}
    r = ctx.config.platform.routing
    out: dict[str, Any] = {"ok": True, "off": False, "acted": 0, "source_acked": 0, "replies": 0, "error": ""}
    try:
        client = chatapi.client_for(ctx)
        since = ctx.now() - timedelta(hours=r.emoji_hours)
        src = mirror._ref(r.source)
        # If mirror._emojis didn't already scan 24h of source messages, scan source reactions read-only here.
        if src and not (r.mirror.strip() and r.copy_everything):
            try:
                for sm in client.list_messages(src, since):
                    if sm.get("emojis"):
                        out["source_acked"] += record_source_emojis(ctx, sm["name"], sm["emojis"], sm.get("thread") or "")
            except Exception as exc:  # noqa: BLE001
                log.warning("source reaction scan failed: %s", exc)

        copies = _copy_index(ctx)
        reactor = _default_reactor_email(ctx)
        for space in _analyst_spaces(ctx):
            info = mirror.space_info(ctx, client, space)
            if info["error"] or info["external"]:
                continue
            for m in client.list_messages(space, since):
                if not m.get("emojis"):
                    continue
                copy_hit = copies.get(m["name"])
                relayed = ((copy_hit["doc"].get("emojis") or {}).get(copy_hit["side"], []) if copy_hit else [])
                direct = without_relayed_emojis(m["emojis"], relayed)
                if not direct:
                    continue
                msg_text = "\n".join(p for p in (m.get("text") or "", m.get("card_text") or "") if p).strip()
                case = actions.find_case(ctx, ChatMessage(message_id=m["name"], text=msg_text, thread_id=m.get("thread") or None))
                if case is None and copy_hit:
                    cdoc = copy_hit["doc"]
                    case = find_case_for_source_message(ctx, str(cdoc.get("source") or ""), str(cdoc.get("source_thread") or ""))
                if case is None:
                    continue
                for e in direct:
                    action = _match_action(ctx, e["emoji"])
                    if action is None:
                        continue
                    seen_id = hashlib.sha256(f"{m['name']}|{action.code}".encode()).hexdigest()[:32]
                    existing = ctx.store.get_doc(CLEAN_SEEN, seen_id)
                    if existing and existing.get("status") == "done":
                        continue
                    resp = handle({
                        "op": "record_reaction",
                        "payload": {
                            "emoji": action.emoji,
                            "reactor_email": reactor or None,
                            "message": {
                                "message_id": m["name"],
                                "text": f"{case.case_id}\n{msg_text}".strip(),
                                "space_id": space,
                                "thread_id": m.get("thread") or None,
                            },
                        },
                        "context": {"deliver": "outbox", "flow": "chat", "invoked_by": reactor or "agent"},
                    }, ctx)
                    if not resp.ok:
                        continue
                    reply_text = (resp.outputs.get("reply_text") or resp.data.get("reply_text") or "").strip()
                    posted_name = ""
                    if reply_text and ctx.flag("chat_delivery"):
                        posted = client.post_message(
                            space, reply_text, thread=m.get("thread") or "",
                            key=f"rx-reply:{m['name']}:{action.code}",
                        )
                        posted_name = posted.get("name") or ""
                        out["replies"] += 1
                    failed_draft = str((resp.data or {}).get("note") or "").endswith("failed")
                    ctx.store.put_doc(CLEAN_SEEN, seen_id, {
                        "id": seen_id, "case_id": case.case_id, "message": m["name"], "space": space,
                        "emoji": action.emoji, "code": action.code,
                        "status": "retry" if failed_draft else "done",
                        "reply": posted_name, "at": ctx.now().isoformat(),
                    })
                    out["acted"] += 1
                    audit.record(ctx, actor=reactor or "agent", action="chat.reaction", surface="agent",
                                 target_type="message", target_id=m["name"], case_id=case.case_id,
                                 summary=f"Acted on {action.emoji} ({action.code}) reaction in Chat for {case.case_id}")
    except Exception as exc:  # noqa: BLE001
        out.update(ok=False, error=str(exc)[:300])
    ctx.store.put_kv(LAST, {**out, "at": ctx.now().isoformat()})
    return out


def status(ctx: "AgentContext") -> dict[str, Any]:
    why = why_off(ctx)
    rows = sorted(ctx.store.list_docs(CLEAN_SEEN, limit=50), key=lambda d: d.get("at", ""), reverse=True)
    return {"on": not why, "why": why, "last_run": ctx.store.get_kv(LAST), "rows": rows}
