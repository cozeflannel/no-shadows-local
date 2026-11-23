"""Ops converse (Flow 3: @mentions + DMs), decide_proposal and decide_fact (docs/CONTRACTS.md §10).

Burson space messages are answered in burson_text with the asker's email (it becomes an
@mention), never reply_text. forward / bounce / suppress / revert / handover are dispatched
through operations.dispatch (review_decision, revert_correction, generate_handover, record_reaction)
and their outputs merged into the reply; the outer handle() finalizes delivery once.
"""

import hashlib
import logging
import re
import uuid
from datetime import datetime, time, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from .. import render
from ..context import AgentContext
from ..escalation import service
from ..escalation import tns as tns_mod
from ..events import EventType
from ..idempotency import claim_or_wait, release
from ..models import ChatMessage, ChatOutputs, Escalation, Override, RequestContext
from ..oncall.roster import person_by_email, person_for_sender, resolve_on_call
from ..operations import UserFacingError, dispatch, operation
from . import answer as answer_mod
from . import intents as intents_mod
from . import teach

log = logging.getLogger(__name__)

# Commands that only make sense for Google staff (not the external agency in the Burson space).
INTERNAL_ONLY = {"temp_check", "revise", "forward", "bounce", "suppress", "revert", "tns_submitted", "tns_withdraw", "bug", "handover",
                 "config_change", "decide", "action"}
SPACE_KINDS = {"burson", "clean", "youtube", "doodle", "team", "crisis"}
TZ_ABBR = {
    "et": "America/New_York", "est": "America/New_York", "edt": "America/New_York",
    "pt": "America/Los_Angeles", "pst": "America/Los_Angeles", "pdt": "America/Los_Angeles",
    "ct": "America/Chicago", "cst": "America/Chicago", "cdt": "America/Chicago",
    "mt": "America/Denver", "mst": "America/Denver", "mdt": "America/Denver",
    "utc": "UTC", "gmt": "UTC", "bst": "Europe/London", "cet": "Europe/Paris", "ist": "Asia/Kolkata",
    "sgt": "Asia/Singapore", "jst": "Asia/Tokyo",
}
ROSTER_LABELS = {"slrr_im": "IM on shift", "burson": "Burson on-call"}


class Turn:
    """One conversation turn: the message, who asked, where."""

    def __init__(self, ctx: AgentContext, msg: ChatMessage):
        self.ctx = ctx
        self.msg = msg
        self.asker = (msg.sender.email or "").strip().lower()
        self.asker_name = (msg.sender.name or "").strip()
        self.space = _space_key(ctx, msg)
        self.is_dm = msg.conversation_type == "DM" or (self.space is None and not msg.space_id and not msg.space_name)
        self.burson = self.space == "burson"  # where the reply goes (burson_text, never reply_text)
        self.agency = _is_agency_person(ctx, self.asker, self.asker_name)  # a Burson roster member, wherever they write
        self.external = self.burson or self.agency  # who reads it (agency: no internals)
        self.in_thread = False  # the reply goes under the message itself (the bot's own Chat sign-in): nobody is named in it
        self.case_hint: str | None = None  # the alert the message's thread is about, when the caller looked already ("" = none)

    @property
    def event_space(self) -> str | None:
        if self.is_dm:
            return "dm"
        return self.space if self.space in SPACE_KINDS else None

    def reply(self, text: str, **ids: str) -> ChatOutputs:
        return ChatOutputs(reply_text=render.finalize(f"{render.prefix(self.ctx)} {text}"), **ids)


def _space_key(ctx: AgentContext, msg: ChatMessage) -> str | None:
    """Configured space key; `space` may carry an id, resource name or URL instead of the display name."""
    cfg = ctx.config
    key = cfg.space_key_for(msg.space_id, msg.space_name)
    if key is None and msg.space_name:
        name = msg.space_name.strip()
        key = cfg.space_key_for(name, None) or cfg.space_key_for(name.rstrip("/").rsplit("/", 1)[-1], None)
    return key


def _is_agency_person(ctx: AgentContext, email: str, name: str | None = None) -> bool:
    """A Burson (agency) roster member: an external audience wherever they write, e.g. in a DM."""
    if email and ctx.config.analyst(email) is not None:
        return False
    if not email and not name:
        return False
    try:
        person = person_for_sender(ctx.roster("burson"), email, name)
    except Exception as exc:  # noqa: BLE001 - a roster read problem must not block the conversation
        log.warning("burson roster lookup failed: %s", exc)
        return False
    return person is not None and (person.org or "burson").strip().lower() == "burson"


Data = dict[str, Any]
Result = tuple[ChatOutputs, Data]


# ---------------------------------------------------------------------------
# Payload, delivery, nested ops
# ---------------------------------------------------------------------------


def message_from_payload(payload: dict[str, Any]) -> ChatMessage:
    """ChatMessage from {message: …} or the flat custom-step inputs (message_text, sender_email, …)."""
    data = payload.get("message") if isinstance(payload.get("message"), dict) else None
    if data is None:
        conv = str(payload.get("conversation_type") or "").upper()
        data = {
            "text": payload.get("message_text") or payload.get("text") or "",
            "sender": {"name": payload.get("sender_name"), "email": payload.get("sender_email")},
            "space_name": payload.get("space"), "space_id": payload.get("space_id"),
            "message_id": payload.get("message_id"), "link": payload.get("message_link"),
            "thread_id": payload.get("thread_id"),
            "conversation_type": "DM" if conv in ("DM", "DIRECT_MESSAGE", "DIRECT") else ("SPACE" if conv in ("SPACE", "ROOM", "GROUP_CHAT") else "UNKNOWN"),
        }
    data = {**data, "text": data.get("text") or ""}
    return ChatMessage.model_validate(data)


def conversation_key(msg: ChatMessage) -> str:
    if msg.message_id:
        return f"cv:{msg.message_id}"
    basis = f"{msg.space_id or msg.space_name}|{msg.create_time}|{msg.sender.email}|{msg.text}"
    return "cv:" + hashlib.sha256(basis.encode()).hexdigest()[:32]


def deliver(turn: Turn, out: ChatOutputs) -> ChatOutputs:
    """Burson space: the reply goes to burson_text with the asker's email (an @mention), never reply_text. A reply the
    caller posts itself under the message, through the bot's own Chat sign-in (`in_thread`, chatanswers), stays
    reply_text and names nobody, as the sheet-based bot's answers did: the caller follows the Routing page's rules for
    Burson's space and keeps it out of Burson's space while it is set to stay silent there."""
    if not turn.burson or not out.reply_text.strip() or turn.in_thread:
        return out
    p = render.prefix(turn.ctx)
    body = out.reply_text.strip()
    body = body[len(p):].lstrip() if body.startswith(p) else body
    mention = f"{turn.asker} " if turn.asker else ""
    out = out.model_copy(deep=True)
    out.burson_text = render.finalize("\n\n".join(t for t in (out.burson_text.strip(), f"{p} {mention}{body}") if t))
    out.reply_text = ""
    return out


def dispatch_op(turn: Turn, op: str, payload: dict[str, Any]) -> Result:
    """Run another operation (review_decision, revert_correction, generate_handover, record_reaction) and
    return its outputs; the outer converse call finalizes delivery (outbox / targets) once."""
    ctx = turn.ctx
    rc = RequestContext(invoked_by=turn.asker or None, flow="converse", deliver="return")
    try:
        out, data = dispatch(op, payload, ctx, rc)
    except UserFacingError as exc:
        return turn.reply(str(exc)), {"op": op, "ok": True, "user_error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - answer in chat instead of failing the whole turn
        log.exception("nested op %s failed", op)
        try:
            ctx.emit(EventType.ERROR, actor=turn.asker or "agent",
                     payload={"op": op, "error": str(exc), "retryable": False, "nested_in": "converse"})
        except Exception:  # noqa: BLE001
            pass
        return turn.reply(f"I couldn't do that: {render.truncate(str(exc), 300)}"), {"op": op, "ok": False, "error": str(exc)}
    return out, {"op": op, "ok": True, **(data or {})}


def _answered(turn: Turn, intent: str, grounded: bool, sources: list[str]) -> None:
    turn.ctx.emit(EventType.QA_ANSWERED, actor=turn.asker or "unknown", space=turn.event_space,  # type: ignore[arg-type]
                  message_ref=turn.msg.message_id, payload={"intent": intent, "grounded": grounded, "sources": sources})


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------


def _key(name: str | None) -> str:
    """A thread's or a message's own id: the last part of its name, without Chat's '.part' (a thread's first message is
    named after the thread)."""
    return (name or "").rstrip("/").rsplit("/", 1)[-1].split(".", 1)[0]


def case_for_thread(ctx: AgentContext, thread_id: str | None, cases: list[Any] | None = None):
    """The alert a Chat thread is about, or None: the thread of the alert's own message (the source space), of its post
    for the analysts, or of its copy in the second or third space on the Routing page (relay_threads)."""
    from .. import mirror

    key = _key(thread_id)
    if not thread_id or not key:
        return None
    threads = {thread_id}
    for side in ("mirror", "third"):  # a copy's thread stands for the source message's thread
        threads.update(d["source"] for d in ctx.store.list_docs(mirror.THREADS, where={side: thread_id}, limit=1) if d.get("source"))
    keys = {_key(t) for t in threads}
    for c in cases if cases is not None else ctx.store.list_cases(limit=300):
        if c.clean_message_ref and (_key(c.clean_message_ref) in keys or key in c.clean_message_ref):
            return c
        for a in reversed(c.attempts):
            if (a.message.thread_id and a.message.thread_id in threads) or (a.message.message_id and _key(a.message.message_id) in keys):
                return c
    return None


_case_for_thread = case_for_thread


def resolve_escalation(turn: Turn, intent: intents_mod.Intent, *, need_open_draft: bool = False) -> Escalation | None:
    """ESC id in the text, else the TRG id's (or thread's) escalation, else the asker's latest open one."""
    ctx = turn.ctx
    if intent.escalation_id:
        return ctx.store.get_escalation(intent.escalation_id)
    case_id = intent.case_id
    if case_id is None:
        case = _case_for_thread(ctx, turn.msg.thread_id)
        case_id = case.case_id if case else None
    if case_id:
        escs = ctx.store.list_escalations(case_id=case_id, limit=50)
        mine = [e for e in escs if e.analyst_email.lower() == turn.asker]
        drafts = [e for e in mine + escs if any(service.is_open(m) for m in e.emails)]
        return (drafts or mine or escs or [None])[0]
    if not turn.asker:
        return None
    mine = ctx.store.list_escalations(analyst_email=turn.asker, open_only=True, limit=20)
    if need_open_draft:
        mine = [e for e in mine if any(service.is_open(m) for m in e.emails)]
    return mine[0] if mine else None


def roster_for(text: str, space: str | None, hint: str | None = None, *, agency: bool = False) -> str:
    """Words win ("Burson on-call", "IM", "shift"), then the space (Burson space -> burson), then who's asking
    (an agency roster member means their own roster), else slrr_im."""
    if hint in ROSTER_LABELS:
        return hint
    low = text.lower()
    if re.search(r"\bburson\b|\bagency\b", low):
        return "burson"
    if re.search(r"\bims?\b|incident manager|\bslrr\b|\bshift\b", low):
        return "slrr_im"
    return "burson" if space == "burson" or agency else "slrr_im"


def parse_until(ctx: AgentContext, text: str | None) -> datetime | None:
    """'6pm ET' / '18:30' / 'noon' / '7am tomorrow' -> the next such moment (UTC)."""
    if not text:
        return None
    low = text.lower()
    tz_match = re.search(r"\b(" + "|".join(TZ_ABBR) + r")\b", low)
    zone = ZoneInfo(TZ_ABBR[tz_match.group(1)] if tz_match else ctx.config.timezone)
    now_local = ctx.now().astimezone(zone)
    tomorrow = "tomorrow" in low
    if "noon" in low:
        options = [(12, 0)]
    elif "midnight" in low:
        options = [(0, 0)]
    else:
        m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])", low)
        if not m:
            return None
        hour, minute, ampm = int(m.group(1)), int(m.group(2) or 0), m.group(3)
        if hour > 23 or minute > 59:
            return None
        if ampm:
            hour = (hour % 12) + (12 if ampm.startswith("p") else 0)
            options = [(hour, minute)]
        elif hour <= 12:  # "until 6": the next 6 o'clock (am or pm)
            options = [(hour % 12, minute), (hour % 12 + 12, minute)]
        else:
            options = [(hour, minute)]
    day = now_local.date() + timedelta(days=1 if tomorrow else 0)
    candidates = []
    for hour, minute in options:
        target = datetime.combine(day, time(hour, minute), tzinfo=zone)
        if target <= now_local and not tomorrow:
            target += timedelta(days=1)
        candidates.append(target)
    return min(candidates).astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Intent handlers
# ---------------------------------------------------------------------------


def _revise(turn: Turn, intent: intents_mod.Intent) -> Result:
    instruction = intent.args.get("instruction", "")
    if not instruction:
        return turn.reply("What should I change? e.g. `revise: shorter, add the AIO 2K list`."), {}
    esc = resolve_escalation(turn, intent, need_open_draft=True)
    if esc is None:
        return turn.reply("Which draft? Include its ESC- or TRG- id, or reply in the alert's thread."), {}
    open_purposes = [m.purpose for m in esc.emails if service.is_open(m)]
    purpose = "alert" if "alert" in open_purposes or not open_purposes else open_purposes[-1]
    if re.search(r"\burgent\b", instruction, re.IGNORECASE) and "tns_urgent" in open_purposes:
        purpose = "tns_urgent"
    try:
        email = service.revise_email(turn.ctx, esc, instruction, turn.asker or "unknown", purpose)
    except UserFacingError as exc:
        return turn.reply(str(exc), escalation_id=esc.escalation_id, case_id=esc.case_id), {"escalation_id": esc.escalation_id}
    ids = f"{esc.escalation_id} · {esc.case_id}"
    if email.error:
        return turn.reply(f"📨 {email.error} · {ids}", escalation_id=esc.escalation_id, case_id=esc.case_id), {
            "escalation_id": esc.escalation_id, "revised": False}
    text = (f"📨 Revised draft v{len(email.versions)} is ready in {esc.analyst_email}'s Gmail (Brand Social) · {ids}\n"
            f"*Subject:* {render.truncate(email.versions[-1].subject, 200)}")
    return turn.reply(text, escalation_id=esc.escalation_id, case_id=esc.case_id), {
        "escalation_id": esc.escalation_id, "revised": True, "version": len(email.versions)}


def _review(turn: Turn, intent: intents_mod.Intent) -> Result:
    payload: dict[str, Any] = {"case_id": intent.case_id, "decision": intent.name, "actor": turn.asker, "via": "chat"}
    if intent.args.get("reason"):
        payload["reason"] = intent.args["reason"]
    if intent.args.get("fields"):
        payload["fields"] = intent.args["fields"]
    return dispatch_op(turn, "review_decision", payload)


def _revert(turn: Turn, intent: intents_mod.Intent) -> Result:
    return dispatch_op(turn, "revert_correction", {"case_id": intent.case_id, "field": intent.args.get("field"),
                                                   "actor": turn.asker})


def _handover(turn: Turn, intent: intents_mod.Intent) -> Result:
    shift = next((s.name for s in turn.ctx.config.shifts if s.name.lower() in intent.text.lower()), None)
    return dispatch_op(turn, "generate_handover", {"shift": shift} if shift else {})


def _action(turn: Turn, intent: intents_mod.Intent) -> Result:
    """Phase 0 fallback for reactions: "pa TRG-1042" runs record_reaction as if the sender reacted 📦."""
    msg = turn.msg
    payload = {"emoji": intent.args["emoji"],
               "user": {"email": turn.asker or None, "name": msg.sender.name},
               "message": {"text": intent.case_id or "", "message_id": msg.message_id, "link": msg.link,
                           "space_id": msg.space_id, "space_name": msg.space_name, "thread_id": msg.thread_id}}
    out, data = dispatch_op(turn, "record_reaction", payload)
    if not data.get("ok"):
        return out, data
    if not (out.reply_text.strip() or out.dm_text.strip() or out.target_texts()):
        act = turn.ctx.config.action(intent.args["code"])
        out.reply_text = f"{render.prefix(turn.ctx)} {act.emoji if act else ''} Recorded on {intent.case_id}.".replace("  ", " ")
    return out, {**data, "code": intent.args["code"]}


def _tns_escalation(turn: Turn, intent: intents_mod.Intent) -> Escalation | None:
    ctx = turn.ctx
    if intent.escalation_id:
        return ctx.store.get_escalation(intent.escalation_id)
    if not intent.case_id:
        return None
    escs = ctx.store.list_escalations(case_id=intent.case_id, limit=50)
    with_tns = [e for e in escs if e.tns is not None]
    if with_tns or escs:
        return (with_tns or escs)[0]
    case = ctx.store.get_case(intent.case_id)
    if case is None or not turn.asker:
        return None
    return service.start_escalation(ctx, case, turn.asker, trigger="chat", requested_by=turn.asker)


def _tns_submitted(turn: Turn, intent: intents_mod.Intent) -> Result:
    esc = _tns_escalation(turn, intent)
    if esc is None:
        return turn.reply(f"I can't find {intent.escalation_id or intent.case_id}."), {}
    issue = intent.args.get("issue")
    tns_mod.mark_submitted(turn.ctx, esc, via="chat", actor=turn.asker or "unknown", wd_issue_id=issue)
    extra = f" (Issue {issue})" if issue else ""
    return turn.reply(f"✍️ Marked T&S submitted{extra} · {esc.escalation_id} · {esc.case_id}",
                      escalation_id=esc.escalation_id, case_id=esc.case_id), {"escalation_id": esc.escalation_id}


def _tns_withdraw(turn: Turn, intent: intents_mod.Intent) -> Result:
    esc = _tns_escalation(turn, intent)
    if esc is None:
        return turn.reply(f"I can't find {intent.escalation_id or intent.case_id}."), {}
    tns_mod.mark_withdrawn(turn.ctx, esc, via="chat", actor=turn.asker or "unknown")
    return turn.reply(f"✍️ Noted: no T&S report needed · {esc.escalation_id} · {esc.case_id}",
                      escalation_id=esc.escalation_id, case_id=esc.case_id), {"escalation_id": esc.escalation_id}


def _bug(turn: Turn, intent: intents_mod.Intent) -> Result:
    ctx = turn.ctx
    raw = intent.args.get("bug", "")
    bug = tns_mod.parse_bug_id(ctx.config, raw) or (m.group(0) if (m := re.search(r"\b\d{6,}\b", raw)) else None)
    if not bug:
        return turn.reply("Include the bug id, e.g. `bug ESC-1207 b/123456789`."), {}
    esc = _tns_escalation(turn, intent)
    case = ctx.store.get_case(esc.case_id) if esc else None
    if esc is None or case is None:
        return turn.reply(f"I can't find {intent.escalation_id or intent.case_id}."), {}
    email = tns_mod.record_outcome(ctx, esc, case, outcome="Fixed", bug_id=bug, via="chat", actor=turn.asker or "unknown")
    ids = f"{esc.escalation_id} · {esc.case_id}"
    if email is None or email.status.value == "FAILED":
        reason = email.error if email is not None else "no draft"
        return turn.reply(f"✍️ Bug b/{bug} recorded, but I couldn't draft the follow-up ({reason}) · {ids}",
                          escalation_id=esc.escalation_id, case_id=esc.case_id), {"escalation_id": esc.escalation_id}
    holder = next((e for e in ctx.store.list_escalations(case_id=case.case_id, limit=50)
                   if any(m.draft_id == email.draft_id for m in e.emails)), esc)
    return turn.reply(f"📨 Bug b/{bug} recorded. The follow-up reply is ready in {holder.analyst_email}'s Gmail "
                      f"(Brand Social) · {holder.escalation_id} · {case.case_id}",
                      escalation_id=holder.escalation_id, case_id=case.case_id), {"escalation_id": holder.escalation_id}


def _status(turn: Turn, intent: intents_mod.Intent) -> Result:
    ident = intent.case_id or intent.escalation_id or ""
    text = answer_mod.case_status_text(turn.ctx, ident)
    if text is None:
        return turn.reply(f"I can't find {ident}."), {}
    if turn.external:  # external audience: case status only
        text = "\n".join(text.splitlines()[:2])
    _answered(turn, "status", True, [f"live:{ident}"])
    return turn.reply(text, case_id=intent.case_id or ""), {"status_of": ident}


def _oncall_who(turn: Turn, intent: intents_mod.Intent) -> Result:
    name = roster_for(intent.text, turn.space, intent.args.get("roster"), agency=turn.agency)
    res = turn.ctx.on_call(name)
    label = ROSTER_LABELS[name]
    if res.person is None:
        text = f"Nobody is scheduled as {label} right now."
    else:
        until = f" until {render.fmt_time(turn.ctx, res.until)}" if res.until else ""
        source = "" if res.source == "rotation" else f" ({res.source})"
        text = f"{label}: {res.person.name} {res.person.email}{until}{source}"
    _answered(turn, "oncall_who", res.person is not None, [f"roster:{name}"])
    return turn.reply(text), {"roster": name, "person": res.person.email if res.person else None}


def _save_override(turn: Turn, name: str, person_id: str, end: datetime, reason: str) -> Override:
    ctx, now = turn.ctx, turn.ctx.now()
    roster = ctx.roster(name)
    override = Override(override_id=f"ovr-{uuid.uuid4().hex[:8]}", person_id=person_id, start=now, end=end,
                        reason=render.truncate(reason, 200), set_by=turn.asker or "unknown", set_via="chat", created_at=now)
    roster.overrides.append(override)
    ctx.store.save_roster(roster, actor=turn.asker or "unknown", name=name)
    ctx.emit(EventType.ONCALL_OVERRIDE_SET, actor=turn.asker or "unknown", space=turn.event_space,  # type: ignore[arg-type]
             payload={"roster": name, "person_id": person_id, "start": now.isoformat(), "end": end.isoformat(), "via": "chat"})
    return override


def _oncall_set(turn: Turn, intent: intents_mod.Intent) -> Result:
    ctx = turn.ctx
    name = roster_for(intent.text, turn.space, intent.args.get("roster"), agency=turn.agency)
    label = ROSTER_LABELS[name]
    person = person_for_sender(ctx.roster(name), turn.asker, turn.asker_name)
    if person is None:
        return turn.reply(f"You're not in the {label} roster, so I can't put you on. An admin can add you to the roster."), {"roster": name}
    until = parse_until(ctx, intent.args.get("until"))
    if until is None:
        return turn.reply("Until when? e.g. `I'm on until 6pm ET`."), {"roster": name}
    _save_override(turn, name, person.id, until, f"chat: {intent.text}")
    return turn.reply(f"✅ {person.name} is {label} until {render.fmt_time(ctx, until)}."), {"roster": name, "until": until.isoformat()}


def _oncall_handoff(turn: Turn, intent: intents_mod.Intent) -> Result:
    ctx = turn.ctx
    name = roster_for(intent.text, turn.space, intent.args.get("roster"), agency=turn.agency)
    label = ROSTER_LABELS[name]
    roster = ctx.roster(name)
    if person_for_sender(roster, turn.asker, turn.asker_name) is None:
        return turn.reply(f"You're not in the {label} roster, so you can't hand it off. An admin can change the roster."), {"roster": name}
    who = (intent.args.get("who") or "").strip()
    target = person_by_email(roster, who) if "@" in who else next(
        (p for p in roster.people if p.name.lower() == who.lower() or p.id.lower() == who.lower()
         or (p.name.lower().split() or [""])[0] == who.lower()), None)
    if target is None:
        return turn.reply(f"I can't find {who or 'that person'} in the {label} roster."), {"roster": name}
    now = ctx.now()
    current = resolve_on_call(roster, now)
    end = parse_until(ctx, intent.args.get("until")) or (current.until if current.until and current.until > now else now + timedelta(hours=8))
    _save_override(turn, name, target.id, end, f"chat handoff from {turn.asker or turn.asker_name}: {intent.text}")
    return turn.reply(f"✅ Handed off: {target.name} {target.email} is {label} until {render.fmt_time(ctx, end)}."), {
        "roster": name, "person_id": target.id, "until": end.isoformat()}


def try_passive_shift_signin(ctx: AgentContext, msg: ChatMessage,
                             rosters: tuple[str, ...] = ("slrr_im", "burson")) -> dict[str, Any] | None:
    """Silently record a shift override when a roster member posts a natural shift sign-in in a space.

    Only explicit sign-in phrasings with a time window count (intents.match_regex `oncall_set`),
    the sender must be in one of `rosters` (email first; display name only when Studio exposed no
    email), and callers restrict `rosters` to the space's own roster, e.g. ("burson",) for the
    Burson space.
    """
    text = intents_mod.strip_mention(msg.text, ctx.config)
    if not text:
        return None
    intent = intents_mod.match_regex(text, ctx.config)
    if intent is None or intent.name != "oncall_set":
        return None
    until = parse_until(ctx, intent.args.get("until"))
    if until is None:
        return None
    turn = Turn(ctx, msg)
    for roster_name in rosters:
        person = person_for_sender(ctx.roster(roster_name), turn.asker, turn.asker_name)
        if person is not None:
            _save_override(turn, roster_name, person.id, until, f"chat: {text}")
            return {"roster": roster_name, "person_id": person.id, "until": until.isoformat()}
    return None


def _metrics(turn: Turn, intent: intents_mod.Intent) -> Result:
    ans = answer_mod.answer_metrics(turn.ctx, intent.text)
    _answered(turn, "metrics", ans.grounded, ans.sources)
    return turn.reply(ans.text), {"grounded": ans.grounded, "sources": ans.sources}


def _teach(turn: Turn, intent: intents_mod.Intent) -> Result:
    fact, out = teach.propose_fact(turn.ctx, intent.args.get("fact") or intent.text, turn.asker or "unknown",
                                   source=f"chat:{turn.event_space or 'unknown'}")
    return out, {"fact_id": fact.fact_id}


def _config_change(turn: Turn, intent: intents_mod.Intent) -> Result:
    proposal, out = teach.propose_config_change(turn.ctx, intent.text, turn.asker or "unknown")
    return out, {"proposal_id": proposal.proposal_id if proposal else None}


def _decide(turn: Turn, intent: intents_mod.Intent) -> Result:
    item, decision = intent.args.get("item_id", ""), intent.args.get("decision", "")
    try:
        if item.startswith(teach.FACT_PREFIX):
            out = teach.decide_fact(turn.ctx, item, decision, turn.asker, via="chat")
        else:
            out = teach.decide_proposal(turn.ctx, item, decision, turn.asker, via="chat")
    except UserFacingError as exc:
        return turn.reply(str(exc)), {"item_id": item}
    return out, {"item_id": item, "decision": decision}


def _route(turn: Turn, ans: answer_mod.Answer, question: str) -> tuple[str, ChatOutputs]:
    """Stakeholder routing per `autonomy` (answer_only | notify_with_approval | auto_notify)."""
    s = ans.stakeholder
    if s is None:
        return "", ChatOutputs()
    ctx, p = turn.ctx, render.prefix(turn.ctx)
    where = s.team if turn.external else (s.chat_space or ", ".join(s.contacts) or s.email or s.team)
    extra = ChatOutputs()
    payload = {"stakeholder_id": s.id, "team": s.team, "mode": s.autonomy}
    recipients = [c for c in s.contacts if "@" in c] or ([s.email] if s.email else [])
    if s.autonomy == "auto_notify" and recipients:
        extra.dm_text = render.finalize(f"{p} ❓ Question for {s.team} from {turn.asker or 'someone'}: “{render.truncate(question, 800)}”")
        extra.dm_recipients = recipients
        ctx.emit(EventType.ROUTE_RELAYED, actor=turn.asker or "unknown", space=turn.event_space, payload=payload)  # type: ignore[arg-type]
        return f"I've passed this to {s.team}.", extra
    if s.autonomy == "notify_with_approval" and ctx.config.admin_emails():
        extra.dm_text = render.finalize(f"{p} ❓ {turn.asker or 'Someone'} asked something {s.team} owns: "
                                        f"“{render.truncate(question, 800)}” Forward it to {where} if appropriate.")
        extra.dm_recipients = ctx.config.admin_emails()
        ctx.emit(EventType.ROUTE_FORWARDED, actor=turn.asker or "unknown", space=turn.event_space, payload=payload)  # type: ignore[arg-type]
        return f"I've asked an admin to loop in {s.team}.", extra
    ctx.emit(EventType.ROUTE_FORWARDED, actor=turn.asker or "unknown", space=turn.event_space,  # type: ignore[arg-type]
             payload={**payload, "mode": "answer_only"})
    return f"{s.team} owns this: ask {where}.", extra


def _thread_case(turn: Turn, intent: intents_mod.Intent):
    """The alert the question is about: an id typed in it, else the one its thread is about."""
    ctx = turn.ctx
    if intent.case_id:
        return ctx.store.get_case(intent.case_id)
    if turn.case_hint is not None:
        return ctx.store.get_case(turn.case_hint) if turn.case_hint else None
    return case_for_thread(ctx, turn.msg.thread_id)


def _question(turn: Turn, intent: intents_mod.Intent) -> Result:
    case = _thread_case(turn, intent)
    ans = answer_mod.answer_question(turn.ctx, intent.text, external=turn.external, case=case)
    note, extra = _route(turn, ans, intent.text)
    text = ans.text + (f"\n{note}" if note else "")
    _answered(turn, "question", ans.grounded, ans.sources)
    data: Data = {"grounded": ans.grounded, "sources": ans.sources, "stakeholder": ans.stakeholder.id if ans.stakeholder else None}
    if case is not None:
        data["about_case"] = case.case_id
    if ans.held_back:
        data["held_back"] = ans.held_back
    return turn.reply(text, case_id=case.case_id if case is not None else "").merge(extra), data


def _temp_check(turn: Turn, intent: intents_mod.Intent) -> Result:
    """`temp check` in an alert's thread, or with a Brandwatch query (its name, id or link) or a Boolean after it."""
    rest = str(intent.args.get("rest") or "").strip()
    case_id = intent.case_id
    if not case_id:
        case = _case_for_thread(turn.ctx, turn.msg.thread_id)
        case_id = case.case_id if case else None
    for found in ([case_id] if case_id else []):
        rest = rest.replace(found, "").strip()
    payload: dict[str, Any] = {"case_id": case_id, "actor": turn.asker, "via": "chat", "silent": True}
    if not rest:
        if not case_id:
            return turn.reply("Which issue? Type `temp check` in an alert's thread, or follow it with a Brandwatch query's "
                              "name, id or link, or a Boolean."), {"intent": "temp_check"}
        payload["draft_query"] = True
    elif re.search(r"\b(?:AND|OR|NOT|NEAR/\d+)\b|[\"()]", rest):
        payload.update({"boolean": rest, "issue": "" if case_id else rest[:80]})
    else:
        payload.update({"query_ref": rest, "issue": rest[:120]})
    return dispatch_op(turn, "run_temp_check", payload)


HANDLERS: dict[str, Callable[[Turn, intents_mod.Intent], Result]] = {
    "temp_check": _temp_check,
    "revise": _revise, "forward": _review, "bounce": _review, "suppress": _review, "revert": _revert,
    "tns_submitted": _tns_submitted, "tns_withdraw": _tns_withdraw, "bug": _bug, "status": _status,
    "oncall_set": _oncall_set, "oncall_handoff": _oncall_handoff, "oncall_who": _oncall_who, "handover": _handover,
    "metrics": _metrics, "teach": _teach, "config_change": _config_change, "decide": _decide, "action": _action,
    "question": _question,
}


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


@operation("converse")
def converse(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    """Flow 3: an @mention in a space, or a DM to the agent."""
    msg = message_from_payload(payload)
    agent = ctx.config.agent
    agent_email = (agent.email or "").strip().lower()
    if (bool(agent_email) and (msg.sender.email or "").strip().lower() == agent_email) or msg.text.lstrip().startswith(agent.message_prefix):
        ctx.emit(EventType.MESSAGE_IGNORED, message_ref=msg.message_id, payload={"reason": "own_message"})
        return ChatOutputs(summary="ignored: own message"), {"ignored": "own_message"}
    key = conversation_key(msg)
    cached = ctx.store.get_idempotent(key) or claim_or_wait(ctx, key)
    if cached:
        return ChatOutputs.model_validate(cached.get("outputs", {})), {**cached.get("data", {}), "duplicate": True}
    try:

        turn = Turn(ctx, msg)
        turn.in_thread = bool(payload.get("in_thread"))
        turn.case_hint = str(payload.get("case_id") or "").strip().upper() if "case_id" in payload else None
        text = intents_mod.strip_mention(msg.text, ctx.config)
        if not text:
            out, data = turn.reply(f"Hi! Ask me about alerts, drafts, T&S or who's on shift. "
                                   f"e.g. `status {ctx.config.case_id_prefix}-1042`."), {"intent": "empty"}
        else:
            intent = intents_mod.classify(ctx, text)
            if turn.external and intent.name in INTERNAL_ONLY:
                out, data = turn.reply("That command isn't available in this space." if turn.burson
                                       else "That command isn't available to you."), {}
            else:
                try:
                    out, data = HANDLERS.get(intent.name, _question)(turn, intent)
                except UserFacingError as exc:  # answered here so deliver() routes it (never reply_text in Burson)
                    out, data = turn.reply(str(exc)), {"user_error": str(exc)}
            data = {"intent": intent.name, "intent_source": intent.source, **data}
        out = deliver(turn, out)
        if not out.summary:
            out.summary = f"converse: {data.get('intent')}"
        ctx.store.put_idempotent(key, {"outputs": out.model_dump(), "data": data})
        return out, data
    finally:
        release(ctx, key)


def _decider(payload: dict[str, Any], rc: RequestContext) -> tuple[str, str, str | None, str]:
    item = payload.get("id") or payload.get("proposal_id") or payload.get("fact_id") or ""
    actor = payload.get("actor") or rc.invoked_by
    via = "console" if (rc.flow or "console") == "console" else "chat"
    return item, payload.get("decision") or "", actor, via


@operation("decide_proposal")
def decide_proposal(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    """Console: approve (apply the JSON merge patch) or reject a config change proposal."""
    item, decision, actor, via = _decider(payload, rc)
    out = teach.decide_proposal(ctx, item, decision, actor, via=via)
    return out, {"id": item.upper(), "decision": decision}


@operation("decide_fact")
def decide_fact(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    """Console: approve (activate) or reject a taught fact."""
    item, decision, actor, via = _decider(payload, rc)
    out = teach.decide_fact(ctx, item, decision, actor, via=via)
    return out, {"id": item.upper(), "decision": decision}
