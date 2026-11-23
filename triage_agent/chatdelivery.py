"""Queued posts delivered through the QA chatbot's own Chat sign-in, with no Chat flow in between.

Every minute, with the switch "Post queued messages in Chat" ON and the QA chatbot ON, each queued post is posted once:
in its space, or in the direct message each recipient already has with the bot's account. Before a post goes, the
rules it passed when it was queued are asked again (the allowed targets, the Routing page's rule for the source space,
the leak guard), and the Chat client asks the Routing page's rules once more on the write itself.

  held            a rule says no: it is not posted, now or later, and the reason is kept and audited
  waits_for_send  the source space asks for a person's Send: it moves to the Routing page's queue
  failed          not posted this minute, and tried again the next. When Chat refused the post itself (a space the bot
                  is not in, a person with no direct message yet) a try is counted, and after the Routing page's number
                  of tries it is given up. When Chat as a whole did not answer, no try is counted
  gave_up         stays queued and is left alone until a person presses Try again

A space Chat did not answer for is left alone for the rest of that minute, so its posts stay in order and the other
spaces still get theirs.

Posts queued before the switch was turned ON are not sent late: delivery starts a few minutes back, as the copy does.
The handover doc is not a Chat post and stays a flow's work.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from . import audit, chatapi, chatlog, mirror, safety
from .config import switch_title
from .operations import handle

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext
    from .models import OutboxItem

ROWS, STATE, LAST = "chat_delivery", "chat_delivery:state", "chat_delivery:last"
SWITCH = "chat_delivery"
BY = "chat_delivery"  # who an outbox item was delivered by
CLOSED = ("sent", "held", "waits_for_send")
READ = 500  # queued posts looked at in one pass
CLAIM_S = 120  # how long one post stays in hand before another worker may take it (a worker that died mid-post)


class _Stop(RuntimeError):
    """Chat cannot be reached or is turning the account away, or a safety check failed: the rest wait for the next minute."""


def takes(ctx: "AgentContext", target: str) -> bool:
    """True when this delivery, and no Chat flow, posts what is queued for `target`."""
    return ctx.flag(SWITCH) and target != "handover"


def why_off(ctx: "AgentContext") -> str:
    """Why nothing is posted right now, or ""."""
    if not ctx.flag(SWITCH):
        return f"the switch {switch_title(SWITCH)} is OFF"
    if not ctx.config.platform.routing.bot_on:
        return "the QA chatbot is OFF"
    return ""


def _row(item: "OutboxItem") -> dict[str, Any]:
    return {"id": item.outbox_id, "at": item.created_at.isoformat(), "target": item.target, "to": ", ".join(item.recipients),
            "text": item.text[:300], "case_id": item.case_id or "", "status": "waiting", "why": "", "tries": 0, "message": ""}


def _text(item: "OutboxItem") -> str:
    text = item.text.strip()
    return text if len(text) <= mirror.MAX_CHARS else text[: mirror.MAX_CHARS - 1] + "…"


def _plain(why: str, space: str) -> str:
    """The Routing rules' refusal without the space's id in front: the row already names the space."""
    lead = f"Refusing to write in {space}: "
    return why[len(lead):][:1].upper() + why[len(lead) + 1:] if why.startswith(lead) else why


def _close(ctx: "AgentContext", item: "OutboxItem", doc: dict[str, Any], status: str, why: str = "", *, check: str = "", hits: list[str] | None = None) -> None:
    """The post is finished with: sent, held by a rule, or handed to the Routing page for a person's Send."""
    doc.update(status=status, why=why)
    ctx.store.mark_outbox_delivered([item.outbox_id], delivered_by=BY if status == "sent" else f"{BY}:{status}")
    if status == "held":
        chatlog.mark_delivered(ctx, [item], status="held")
        audit.record(ctx, actor="agent", action="safety.block", surface="agent", target_type="output", target_id=item.target,
                     summary=f"Held a queued message to {item.target}: {why}"[:400], status="blocked", case_id=item.case_id,
                     escalation_id=item.escalation_id,
                     detail={"op": item.source, "outbox_id": item.outbox_id, "target": item.target, "check": check, "hits": hits or [], "chars": len(item.text)})


def _fail(ctx: "AgentContext", doc: dict[str, Any], why: str) -> None:
    doc["tries"] += 1
    doc["why"] = why[:300]
    doc["status"] = "gave_up" if doc["tries"] >= ctx.config.platform.routing.max_tries else "failed"


def _sent(ctx: "AgentContext", item: "OutboxItem", doc: dict[str, Any], message: str, where: str) -> None:
    doc.update(message=message, posted_at=ctx.now().isoformat())
    _close(ctx, item, doc, "sent")
    chatlog.mark_delivered(ctx, [item])
    audit.record(ctx, actor="agent", action="chat.post", surface="agent", target_type="message", target_id=message,
                 summary=f"Posted in {where}"[:400], case_id=item.case_id, escalation_id=item.escalation_id,
                 detail={"outbox_id": item.outbox_id, "target": item.target, "source": item.source})


def _tie_to_case(ctx: "AgentContext", item: "OutboxItem", message: str) -> None:
    """A case's first post in the analysts' space is remembered on the case, as a flow's Record post step does, so an
    emoji on that message finds the case."""
    case = ctx.store.get_case(item.case_id) if item.case_id else None
    if case is not None and case.clean_posted_at is None:
        handle({"op": "record_post", "payload": {"case_id": case.case_id, "message_id": message}, "context": {"flow": "chat", "invoked_by": "agent"}}, ctx)


def _chat(ctx: "AgentContext", doc: dict[str, Any], exc: Exception, quiet: set[str], place: str) -> None:
    """A write Chat did not take. When Chat refused this post itself, a try is counted. When Chat had trouble, none is:
    the place is left alone for the rest of the pass, and the pass ends when Chat cannot be reached at all or is
    turning the account away for calling too often."""
    refused = isinstance(exc, chatapi.ChatError) and exc.status < 500 and exc.status != 429
    if refused:
        _fail(ctx, doc, f"Chat did not take the post: {exc}")
        return
    doc.update(status="failed", why=f"Chat did not take the post: {exc}"[:300])
    quiet.add(place)
    if not isinstance(exc, chatapi.ChatError) or exc.status == 429:
        raise _Stop(f"Chat did not take a post: {exc}") from exc


def _to_space(ctx: "AgentContext", client: Any, item: "OutboxItem", doc: dict[str, Any], out: dict[str, Any], quiet: set[str]) -> None:
    ref = ctx.config.space(item.target)
    space = chatapi.space_name(ref.space_id, ref.url) if ref else ""
    name = (ref.display_name if ref else "") or item.target
    doc["to"] = name
    if space in quiet:
        return
    if not space:
        _fail(ctx, doc, f"No space is set for {name}. Set it under Integrations, Google Chat.")
        out["failed"] += 1
        return
    text = _text(item)
    source = mirror.is_source_target(ctx, item.target)
    if source and ctx.config.platform.routing.ask_before_source:
        asked = mirror.send(ctx, text, thread=item.thread or "", origin=item.source, case_id=item.case_id or "", actor="agent")
        if asked["status"] == "waiting":
            _close(ctx, item, doc, "waits_for_send")
        else:
            why = str(asked.get("why") or "the Routing page's rules")
            _close(ctx, item, doc, "held", why[:1].upper() + why[1:] + ".", check="routing")
            out["held"] += 1
        return
    info = mirror.space_info(ctx, client, space)
    if info["error"]:
        _fail(ctx, doc, info["error"])
        out["failed"] += 1
        return
    hits = safety.leak_guard(ctx.config, text).hits if source and info["external"] else []
    if hits:  # the source space is open to people outside: nothing internal goes there, whatever its key is called
        _close(ctx, item, doc, "held", "It names something internal: " + ", ".join(hits[:4]), check="leak_guard", hits=hits)
        out["held"] += 1
        return
    try:
        posted = client.post_message(space, text, thread=item.thread or "", key=f"outbox:{item.outbox_id}",
                                     id_prefix=chatapi.SOURCE_PREFIX if source else chatapi.OWN_PREFIX)
    except chatapi.Refused as exc:
        _close(ctx, item, doc, "held", _plain(str(exc), space), check="routing")
        out["held"] += 1
        return
    except Exception as exc:  # noqa: BLE001 - kept on the row and tried again next minute
        out["failed"] += 1
        _chat(ctx, doc, exc, quiet, space)
        return
    _sent(ctx, item, doc, posted["name"], info["name"] or name)
    out["sent"] += 1
    if item.target == "clean":
        _tie_to_case(ctx, item, posted["name"])


def _to_people(ctx: "AgentContext", client: Any, item: "OutboxItem", doc: dict[str, Any], out: dict[str, Any], quiet: set[str]) -> None:
    """A direct message: to each recipient, in the direct message they already have with the bot's account. While
    Testing, only to the testing recipients (Main.gs dm)."""
    if "dm" in quiet:
        return
    people, _ = safety.filter_recipients(ctx.config, list(dict.fromkeys(r.strip() for r in item.recipients if r.strip())))
    why = "" if people else "None of its recipients is in an allowed domain (Settings, Safety)."
    testers = safety.testing_recipients(ctx.config)
    if people and testers is not None:
        allowed = {t.lower() for t in testers}
        people = [p for p in people if p.lower() in allowed]
        why = "" if people else "Testing is ON: direct messages go only to the testing recipients, and none of them is on this one."
    if not people:
        _close(ctx, item, doc, "held", why, check="recipients")
        out["held"] += 1
        return
    doc["to"] = ", ".join(people)
    text, missing, last = _text(item), [], ""
    try:
        for person in people:
            space = client.find_dm(person)
            if not space:
                missing.append(person)
                continue
            last = client.post_message(space, text, key=f"outbox:{item.outbox_id}:{person.lower()}")["name"]
    except chatapi.Refused as exc:
        _close(ctx, item, doc, "held", str(exc), check="routing")
        out["held"] += 1
        return
    except Exception as exc:  # noqa: BLE001 - kept on the row and tried again next minute
        out["failed"] += 1
        _chat(ctx, doc, exc, quiet, "dm")
        return
    if missing:  # a person already messaged is not messaged again: each one's post has its own key
        _fail(ctx, doc, f"The QA chatbot has no direct message with {', '.join(missing)} yet. They message it once in Chat, and it is sent.")
        out["failed"] += 1
        return
    _sent(ctx, item, doc, last, "a direct message to " + ", ".join(people))
    out["sent"] += 1


def _post(ctx: "AgentContext", client: Any, item: "OutboxItem", doc: dict[str, Any], out: dict[str, Any], quiet: set[str]) -> None:
    reason, hits = safety.target_block(ctx, item.target, item.text)
    if reason:
        why = {"target_not_allowed": f"Posting to {item.target} is not allowed (Settings, Safety).",
               "leak_guard": "It names something internal: " + ", ".join(hits[:4])}.get(reason) or f"Nothing is written in the source space: {mirror.mode(ctx)['why']}."
        _close(ctx, item, doc, "held", why, check=reason, hits=hits)
        out["held"] += 1
    elif item.target == "dm":
        _to_people(ctx, client, item, doc, out, quiet)
    else:
        _to_space(ctx, client, item, doc, out, quiet)


def claim(ctx: "AgentContext", outbox_id: str) -> bool:
    """Take one queued post in hand. False when the minute run or a Pub/Sub push already has it: it is posted once."""
    take = getattr(ctx.store, "claim_idempotent", None)
    return True if take is None else bool(take(f"chatpost:{outbox_id}", ttl_s=CLAIM_S))


def release(ctx: "AgentContext", outbox_id: str) -> None:
    give = getattr(ctx.store, "release_idempotent", None)
    if give is not None:
        give(f"chatpost:{outbox_id}")


def post_now(ctx: "AgentContext", item: "OutboxItem") -> str:
    """One queued post, as soon as its Pub/Sub push arrives (pubsub._run). Returns what came of it. Raises when it was
    not posted and should be pushed again: Pub/Sub tries again and sets it aside after the last try, and the minute
    run posts whatever is still queued."""
    why = why_off(ctx)
    if why:
        return f"waits for the minute run: {why}"
    if item.created_at < ctx.now() - mirror.MAX_GAP:
        return "too old to post"
    doc = ctx.store.get_doc(ROWS, item.outbox_id) or _row(item)
    if doc["status"] == "gave_up":
        return "given up: Try again on the Routing page"
    if not claim(ctx, item.outbox_id):
        return "in hand elsewhere"
    out: dict[str, Any] = {"sent": 0, "held": 0, "failed": 0}
    try:
        try:
            _post(ctx, chatapi.client_for(ctx), item, doc, out, set())
        except _Stop:  # Chat could not be reached: the row says why
            pass
        finally:
            ctx.store.put_doc(ROWS, doc["id"], doc)
    finally:
        release(ctx, item.outbox_id)
    if doc["status"] in CLOSED:
        return doc["status"]
    raise RuntimeError(doc["why"] or "the post did not go out")


def _post_all(ctx: "AgentContext", out: dict[str, Any]) -> None:
    r = ctx.config.platform.routing
    now = ctx.now()
    st = ctx.store.get_kv(STATE) or {}
    if not st.get("floor"):  # just turned ON: what was queued before the last few minutes is not sent late
        st = {"floor": (now - timedelta(minutes=r.start_minutes)).isoformat()}
        ctx.store.put_kv(STATE, st)
    since = max(datetime.fromisoformat(st["floor"]), now - mirror.MAX_GAP)
    rows = {d["id"]: d for d in ctx.store.list_docs(ROWS, where={"status": "gave_up"}, limit=READ)}
    items = [i for i in ctx.store.list_outbox(undelivered_only=True, limit=READ, since=since) if takes(ctx, i.target) and i.outbox_id not in rows]
    if not items:
        return
    if ctx.config.platform.safety.block_on_failed_check:
        failed = safety.blocking_failures(ctx)
        if failed:
            raise _Stop("Held by a failed safety check: " + "; ".join(c.title for c in failed[:3]))
    client = chatapi.client_for(ctx)
    quiet: set[str] = set()  # spaces Chat did not answer for in this pass ("dm" for direct messages)
    for item in items[: r.max_per_run]:
        if not claim(ctx, item.outbox_id):
            continue  # a Pub/Sub push is posting it right now
        try:
            doc = ctx.store.get_doc(ROWS, item.outbox_id) or _row(item)
            try:
                _post(ctx, client, item, doc, out, quiet)
            finally:
                ctx.store.put_doc(ROWS, doc["id"], doc)
        finally:
            release(ctx, item.outbox_id)


def run(ctx: "AgentContext") -> dict[str, Any]:
    """One pass, once a minute: post what is queued."""
    why = why_off(ctx)
    if why:
        if ctx.store.get_kv(STATE):
            ctx.store.put_kv(STATE, {})  # turned ON again later, it starts from then
        return {"ok": True, "off": True, "why": why}
    out: dict[str, Any] = {"ok": True, "off": False, "sent": 0, "held": 0, "failed": 0, "error": ""}
    try:
        _post_all(ctx, out)
    except Exception as exc:  # noqa: BLE001 - shown on the Routing page; the next minute tries again
        out.update(ok=False, error=str(exc)[:300])
    ctx.store.put_kv(LAST, {**out, "at": ctx.now().isoformat()})
    return out


def retry(ctx: "AgentContext", outbox_id: str, actor: str) -> dict[str, Any]:
    """Try again on a post that was given up: it is posted on the next minute's pass."""
    doc = ctx.store.get_doc(ROWS, outbox_id)
    if not doc or doc["status"] != "gave_up":
        raise KeyError(outbox_id)
    doc.update(status="waiting", tries=0, why="")
    ctx.store.put_doc(ROWS, outbox_id, doc)
    audit.record(ctx, actor=actor, action="chat.post.retry", surface="console", target_type="output", target_id=outbox_id,
                 summary=f"Try again on a queued message to {doc['target']}", case_id=doc.get("case_id") or None)
    return doc


def status(ctx: "AgentContext") -> dict[str, Any]:
    """What the Routing page shows about posting: whether it runs, what the last pass did, and the last 100 posts."""
    why = why_off(ctx)
    rows = sorted(ctx.store.list_docs(ROWS, limit=100), key=lambda d: d["at"], reverse=True)
    return {"on": not why, "why": why, "switch": ctx.flag(SWITCH), "last_run": ctx.store.get_kv(LAST),
            "rows": [{k: d.get(k) for k in ("id", "at", "target", "to", "text", "status", "why", "tries", "case_id", "message")} for d in rows]}
