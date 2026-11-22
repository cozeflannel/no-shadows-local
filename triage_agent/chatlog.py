"""Chat tracking: everything the agent is handed from Chat and everything it posts back.

The agent has no Chat API: Studio flows hand it messages, reactions and emails, and post what it returns. Each of
those passes through operations.handle(), which calls record_inbound() / record_outputs() here, and the outbox calls
record_queued() / mark_delivered(). The Console reads the `chat_activity` collection for the Chat tracking page, case
timelines, the Review Feed and the audit log.

Ids are derived from the message, so a delivery Studio repeats is recorded once.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel

from .events import PlatformEvent
from .ids import case_ids_in, escalation_ids_in

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext
    from .models import ChatOutputs, OutboxItem, RequestContext

log = logging.getLogger(__name__)

COLLECTION = "chat_activity"
MAX_TEXT = 6000


class ChatActivity(BaseModel):
    activity_id: str
    ts: datetime
    direction: Literal["inbound", "outbound"]
    kind: Literal["message", "reaction", "email", "post", "reply", "dm", "doc"]
    space_key: str | None = None  # configured space key (burson, clean, …), "dm" or "email"
    space_id: str | None = None
    thread_id: str | None = None
    message_id: str | None = None
    link: str | None = None
    actor: str = "agent"  # sender email or name; "agent" for the agent's own posts
    actor_name: str | None = None
    text: str = ""
    emoji: str | None = None
    recipients: list[str] = []
    case_id: str | None = None
    escalation_id: str | None = None
    op: str = ""
    flow: str = ""
    status: Literal["received", "returned", "queued", "delivered", "held"] = "received"
    outbox_id: str | None = None
    env: str = "dev"


def _digest(*parts: Any) -> str:
    return hashlib.sha256("|".join(str(p or "") for p in parts).encode()).hexdigest()[:24]


def _save(ctx: "AgentContext", activity: ChatActivity, *, overwrite: bool = False) -> bool:
    data = activity.model_dump(mode="json")
    try:
        if overwrite:
            ctx.store.put_doc(COLLECTION, activity.activity_id, data)
            return True
        return ctx.store.create_doc(COLLECTION, activity.activity_id, data)
    except Exception:  # noqa: BLE001 - tracking never fails the operation it describes
        log.exception("chat activity write failed (%s)", activity.activity_id)
        return False


def _emit(ctx: "AgentContext", activity: ChatActivity) -> None:
    try:
        ctx.emit(
            PlatformEvent.CHAT_INBOUND if activity.direction == "inbound" else PlatformEvent.CHAT_OUTBOUND,
            actor=activity.actor, case_id=activity.case_id, escalation_id=activity.escalation_id,
            message_ref=activity.message_id or activity.link,
            payload={"activity_id": activity.activity_id, "kind": activity.kind, "space_key": activity.space_key,
                     "status": activity.status, "op": activity.op, "chars": len(activity.text)},
        )
    except Exception:  # noqa: BLE001
        log.warning("chat activity event failed", exc_info=True)


def _ids_in(text: str, ctx: "AgentContext") -> tuple[str | None, str | None]:
    cases, escs = case_ids_in(text, ctx.config), escalation_ids_in(text, ctx.config)
    return (cases[0] if cases else None), (escs[0] if escs else None)


def record_inbound(ctx: "AgentContext", op: str, payload: dict[str, Any], rc: "RequestContext") -> tuple[ChatActivity | None, bool]:
    """The message, reaction or email an entry operation was called with: (record, first time seen)."""
    cfg = ctx.config
    try:
        if op in ("triage_message", "converse"):
            from .converse.handler import message_from_payload

            msg = message_from_payload(payload.get("message") and payload or {**payload, "message": None})
            text = msg.text or ""
            space_key = cfg.space_key_for(msg.space_id, msg.space_name)
            if not space_key and str(msg.conversation_type or "").upper() == "DM":
                space_key = "dm"
            case_id, esc_id = _ids_in(text, ctx)
            mid = msg.message_id or _digest(msg.space_id, msg.create_time, text)
            act = ChatActivity(
                activity_id=f"in-{_digest(op, mid)}", ts=ctx.now(), direction="inbound", kind="message", space_key=space_key,
                space_id=msg.space_id, thread_id=msg.thread_id, message_id=msg.message_id, link=msg.link,
                actor=(msg.sender.email or msg.sender.name or "unknown"), actor_name=msg.sender.name,
                text=text[:MAX_TEXT], case_id=case_id, escalation_id=esc_id, op=op, flow=rc.flow or "", env=cfg.env)
        elif op in ("record_reaction", "start_escalation"):
            from .actions import reaction_from_payload

            ev = reaction_from_payload(payload)
            msg = ev.message
            text = msg.text or ""
            case_id, esc_id = _ids_in(text, ctx)
            ref = msg.message_id or msg.link or _digest(text)
            act = ChatActivity(
                activity_id=f"rx-{_digest(ref, ev.emoji, ev.user.email)}", ts=ctx.now(), direction="inbound",
                kind="reaction", space_key=cfg.space_key_for(msg.space_id, msg.space_name), space_id=msg.space_id,
                thread_id=msg.thread_id, message_id=msg.message_id, link=msg.link,
                actor=(ev.user.email or ev.user.name or "unknown"), actor_name=ev.user.name, text=text[:MAX_TEXT],
                emoji=ev.emoji, case_id=case_id, escalation_id=esc_id, op=op, flow=rc.flow or "", env=cfg.env)
        elif op == "ingest_email":
            body = str(payload.get("body") or "")
            subject = str(payload.get("subject") or "")
            case_id, esc_id = _ids_in(f"{subject}\n{body}", ctx)
            mid = payload.get("message_id") or _digest(subject, payload.get("received_at"), body[:200])
            act = ChatActivity(
                activity_id=f"em-{_digest(mid)}", ts=ctx.now(), direction="inbound", kind="email", space_key="email",
                thread_id=payload.get("thread_id"), message_id=payload.get("message_id"), link=payload.get("link"),
                actor=(payload.get("from_email") or "unknown"), actor_name=payload.get("from_name"),
                text=f"{subject}\n\n{body}"[:MAX_TEXT], case_id=case_id, escalation_id=esc_id, op=op, flow=rc.flow or "",
                env=cfg.env)
        else:
            return None, False
    except Exception:  # noqa: BLE001
        log.exception("could not read the inbound payload of %s for chat tracking", op)
        return None, False
    if _save(ctx, act):
        _emit(ctx, act)
        return act, True
    return act, False  # a delivery Studio repeated: already on record


def link_inbound(ctx: "AgentContext", activity: ChatActivity | None, case_id: str | None, escalation_id: str | None) -> None:
    """Tie an inbound record to the case / escalation the operation resolved it to."""
    if activity is None or not (case_id or escalation_id):
        return
    if (case_id and case_id != activity.case_id) or (escalation_id and escalation_id != activity.escalation_id):
        activity.case_id = case_id or activity.case_id
        activity.escalation_id = escalation_id or activity.escalation_id
        _save(ctx, activity, overwrite=True)


def record_outputs(ctx: "AgentContext", op: str, outputs: "ChatOutputs", rc: "RequestContext",
                   inbound: ChatActivity | None = None) -> list[ChatActivity]:
    """Posts returned to the calling Studio flow (it posts them itself)."""
    out: list[ChatActivity] = []
    cfg = ctx.config
    base = inbound.activity_id if inbound else _digest(op, rc.run_id, ctx.now().isoformat())
    texts: list[tuple[str, str, str, list[str]]] = []  # (space_key, kind, text, recipients)
    for target, text in outputs.target_texts().items():
        texts.append((target, "doc" if target == "handover" else "post", text, []))
    if outputs.reply_text.strip():
        texts.append((inbound.space_key if inbound and inbound.space_key else "reply", "reply", outputs.reply_text, []))
    if outputs.dm_text.strip() and outputs.dm_recipients:
        texts.append(("dm", "dm", outputs.dm_text, list(outputs.dm_recipients)))
    for space_key, kind, text, recipients in texts:
        ref = cfg.space(space_key)
        act = ChatActivity(
            activity_id=f"out-{_digest(base, space_key, kind, text[:120])}", ts=ctx.now(), direction="outbound", kind=kind,  # type: ignore[arg-type]
            space_key=space_key, space_id=ref.space_id if ref else None,
            thread_id=inbound.thread_id if (inbound and kind == "reply") else None,
            actor="agent", actor_name=cfg.agent.display_name, text=text[:MAX_TEXT], recipients=recipients,
            case_id=outputs.case_id or (inbound.case_id if inbound else None),
            escalation_id=outputs.escalation_id or (inbound.escalation_id if inbound else None),
            op=op, flow=rc.flow or "", status="returned", env=cfg.env)
        if _save(ctx, act):
            _emit(ctx, act)
            out.append(act)
    return out


def record_queued(ctx: "AgentContext", item: "OutboxItem") -> None:
    cfg = ctx.config
    ref = cfg.space(item.target)
    act = ChatActivity(
        activity_id=f"obx-{item.outbox_id}", ts=item.created_at, direction="outbound",
        kind="dm" if item.target == "dm" else ("doc" if item.target == "handover" else "post"),
        space_key=item.target, space_id=ref.space_id if ref else None, actor="agent", actor_name=cfg.agent.display_name,
        text=item.text[:MAX_TEXT], recipients=list(item.recipients), case_id=item.case_id, escalation_id=item.escalation_id,
        op=item.source, status="queued", outbox_id=item.outbox_id, env=cfg.env)
    if _save(ctx, act):
        _emit(ctx, act)


def mark_delivered(ctx: "AgentContext", items: list["OutboxItem"], status: str = "delivered") -> None:
    for item in items:
        try:
            row = ctx.store.get_doc(COLLECTION, f"obx-{item.outbox_id}")
            if row is None:
                record_queued(ctx, item)
                row = ctx.store.get_doc(COLLECTION, f"obx-{item.outbox_id}")
            if row is None:
                continue
            row["status"] = status
            row["ts"] = ctx.now().isoformat()
            ctx.store.put_doc(COLLECTION, f"obx-{item.outbox_id}", row)
        except Exception:  # noqa: BLE001
            log.warning("could not mark chat activity delivered for %s", item.outbox_id, exc_info=True)


def search(ctx: "AgentContext", *, space_key: str | None = None, case_id: str | None = None, direction: str | None = None,
           kind: str | None = None, q: str | None = None, since: datetime | None = None, limit: int = 200) -> list[ChatActivity]:
    where: dict[str, Any] = {}
    if space_key:
        where["space_key"] = space_key
    if case_id:
        where["case_id"] = case_id
    if direction:
        where["direction"] = direction
    if kind:
        where["kind"] = kind
    needle = (q or "").strip().lower()
    rows = ctx.store.list_docs(COLLECTION, where=where or None, since=since, limit=limit if not needle else max(limit * 10, 2000))
    out = []
    for row in rows:
        if needle and needle not in f"{row.get('text', '')} {row.get('actor', '')} {row.get('case_id', '')}".lower():
            continue
        out.append(ChatActivity.model_validate(row))
        if len(out) >= limit:
            break
    out.sort(key=lambda a: a.ts, reverse=True)
    return out


def threads(activities: list[ChatActivity]) -> list[dict[str, Any]]:
    """Group activity into conversations: by thread when Chat gave one, else by case, else each on its own."""
    groups: dict[str, list[ChatActivity]] = {}
    for a in activities:
        key = f"t:{a.space_key}:{a.thread_id}" if a.thread_id else (f"c:{a.case_id}" if a.case_id else f"a:{a.activity_id}")
        groups.setdefault(key, []).append(a)
    out = []
    for key, items in groups.items():
        items.sort(key=lambda a: a.ts)
        out.append({
            "key": key, "space_key": items[-1].space_key, "case_id": next((a.case_id for a in items if a.case_id), None),
            "first_ts": items[0].ts, "last_ts": items[-1].ts, "count": len(items),
            "participants": sorted({a.actor for a in items}),
            "items": [a.model_dump(mode="json") for a in items],
        })
    out.sort(key=lambda g: g["last_ts"], reverse=True)
    return out
