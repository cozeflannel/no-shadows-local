"""Scheduled work (Cloud Scheduler -> Cloud Run job, every minute; deliver="outbox").

run_followups:
  1. SLA risk nudges for unacknowledged verified alerts (IM on shift, then the team chat)
  2. NEEDS_REVIEW reminders (IM, then leads)
  3. Burson bounce reminders -> backup -> IM notice -> abandon
  4. Sent detection for drafts (escalation.service.check_sent) + SLA misses
  5. Daily Burson correction digest
  6. Shift handover
  7. Parity reconciliation (in-house vs Burson)
  8. Re-ring stale outbox items
Each message is enqueued separately (one case per clean post, DMs never mix recipients).
generate_handover: shift summary -> team chat + Handover doc.
"""

import logging
from collections import Counter, defaultdict
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from . import render
from .context import AgentContext
from .events import EventType
from .models import Case, CaseStatus, ChatOutputs, EmailStatus, OnCallNotice, RequestContext, TnsStatus
from .oncall.roster import escalation_chain
from .operations import enqueue_outputs, operation
from .outbox import rering_stale
from .ownalerts import surge as own_surge

log = logging.getLogger(__name__)

PARITY_MATCH_WINDOW = timedelta(hours=2)


def _send(ctx: AgentContext, out: ChatOutputs, source: str) -> int:
    return len(enqueue_outputs(ctx, out, source=source))


def _notices(case: Case, kind: str) -> list[OnCallNotice]:
    return [n for n in case.oncall_notices if n.kind == kind]


# ---------------------------------------------------------------------------
# 1. SLA risk
# ---------------------------------------------------------------------------


def sla_nudges(ctx: AgentContext) -> int:
    cfg, now = ctx.config, ctx.now()
    sent = 0
    parity = cfg.inhouse.parity_mode
    for case in ctx.store.list_cases(statuses=[CaseStatus.VERIFIED], since=now - timedelta(days=2), limit=500):
        if case.acknowledged_at or not case.sla_due_at or not case.clean_posted_at:
            continue
        if parity and case.source == "inhouse":
            continue
        total = (case.sla_due_at - case.clean_posted_at).total_seconds()
        elapsed = (now - case.clean_posted_at).total_seconds()
        if total <= 0:
            continue
        risk = _notices(case, "sla_risk")
        im = ctx.im_on_shift().person
        due = render.fmt_time(ctx, case.sla_due_at)
        if elapsed >= total and len(risk) < 2:
            text = f"{render.prefix(ctx)} ⏰ SLA passed for {case.case_id} (due {due}) with no reaction yet: {case.alert_name or ''}"
            out = ChatOutputs(case_id=case.case_id, team_text=text)
            if im:
                out.dm_text, out.dm_recipients = text, [im.email]
            sent += _send(ctx, out, "sla_risk")
            case.oncall_notices.append(OnCallNotice(kind="sla_risk", to_email=im.email if im else None, at=now))
            if not risk:
                case.oncall_notices.append(OnCallNotice(kind="sla_risk", to_email=im.email if im else None, at=now))
        elif elapsed >= total * cfg.thresholds.sla_warn_fraction and not risk and im:
            text = (f"{render.prefix(ctx)} ⏳ {case.case_id} is unacknowledged and its SLA is due at {due}. "
                    f"React on the clean-space post (👍 to acknowledge, 📦 for the email draft).")
            sent += _send(ctx, ChatOutputs(case_id=case.case_id, dm_text=text, dm_recipients=[im.email]), "sla_risk")
            case.oncall_notices.append(OnCallNotice(kind="sla_risk", to_email=im.email, at=now))
        else:
            continue
        a = case.latest.result.assessment if case.latest else None
        ctx.emit(EventType.SLA_AT_RISK, case_id=case.case_id,
                 payload={"track": case.track, "platform_tier": a.platform_tier if a else None,
                          "sla_minutes": a.sla_minutes if a else None, "due_at": case.sla_due_at.isoformat()})
        ctx.emit(EventType.ONCALL_NOTIFIED, case_id=case.case_id, payload={"kind": "sla_risk", "to_email": im.email if im else None, "roster": "slrr_im"})
        ctx.store.save_case(case)
    return sent


# ---------------------------------------------------------------------------
# 2. Review reminders  3. Burson bounce reminders
# ---------------------------------------------------------------------------


def review_reminders(ctx: AgentContext) -> int:
    cfg, now = ctx.config, ctx.now()
    wait = timedelta(minutes=cfg.thresholds.review_reminder_min)
    sent = 0
    for case in ctx.store.list_cases(statuses=[CaseStatus.NEEDS_REVIEW], since=now - timedelta(days=2), limit=500):
        if cfg.inhouse.parity_mode and case.source == "inhouse":
            continue
        last = case.oncall_notices[-1].at if case.oncall_notices else case.updated_at
        if now - last < wait:
            continue
        reminders = _notices(case, "reminder")
        if len(reminders) >= 2:
            continue
        im = ctx.im_on_shift().person
        to = [im.email] if (im and not reminders) else cfg.lead_emails()
        if not to:
            continue
        text = (f"{render.prefix(ctx)} Reminder: {case.case_id} is waiting for a review decision. "
                f"Reply `forward {case.case_id}` / `bounce {case.case_id}: reason` / `suppress {case.case_id}: reason`, or use the Agent Console.")
        sent += _send(ctx, ChatOutputs(case_id=case.case_id, dm_text=text, dm_recipients=to), "review_reminder")
        case.oncall_notices.append(OnCallNotice(kind="reminder", to_email=",".join(to), at=now))
        ctx.emit(EventType.ONCALL_NOTIFIED, case_id=case.case_id, payload={"kind": "reminder", "to_email": ",".join(to), "roster": "slrr_im"})
        ctx.store.save_case(case)
    return sent


def burson_reminders(ctx: AgentContext) -> int:
    cfg, now = ctx.config, ctx.now()
    roster = ctx.roster("burson")
    policy = roster.reminders
    sent = 0
    for case in ctx.store.list_cases(statuses=[CaseStatus.FAILED], since=now - timedelta(days=3), limit=500):
        if case.source != "burson_chat":
            continue
        bounces = _notices(case, "bounce")
        if not bounces:
            continue
        waited = now - bounces[0].at
        minutes = waited.total_seconds() / 60
        if minutes >= cfg.thresholds.max_correction_wait_min:
            case.status = CaseStatus.ABANDONED
            case.closed_reason = "no corrected rerun"
            ctx.emit(EventType.CASE_ABANDONED, case_id=case.case_id, payload={"reason": "no_rerun", "waited_min": round(minutes)})
            ctx.store.save_case(case)
            continue
        reminders = _notices(case, "reminder")
        chain = escalation_chain(roster, now)
        out: ChatOutputs | None = None
        kind = None
        if minutes >= policy.notify_analyst_after_min and not _notices(case, "analyst"):
            im = ctx.im_on_shift().person
            if im:
                kind = "analyst"
                out = ChatOutputs(case_id=case.case_id, dm_recipients=[im.email], dm_text=(
                    f"{render.prefix(ctx)} {case.case_id} has waited {round(minutes)} min for a Burson rerun "
                    f"(unfixable data: {', '.join(i.rule for i in case.latest.result.blocking[:3])}). Decide in the Agent Console if needed."))
        elif minutes >= policy.backup_after_min and not (_notices(case, "backup") or _notices(case, "fallback")) and len(chain) > 1:
            person = chain[1]
            kind = "backup" if person.id == roster.backup_person_id else "fallback"
            out = ChatOutputs(case_id=case.case_id, burson_text=(
                f"{render.prefix(ctx)} {person.email} ({kind}), {case.case_id} still needs a corrected rerun from Burson. "
                f"The on-call hasn't responded in {round(minutes)} min."))
        elif minutes >= policy.reping_after_min * (len(reminders) + 1) and len(reminders) < policy.max_reminders:
            to = case.current_oncall_email or (chain[0].email if chain else None)
            kind = "reminder"
            out = ChatOutputs(case_id=case.case_id, burson_text=(
                f"{render.prefix(ctx)} Reminder {to or 'Burson on-call'}: {case.case_id} still needs a corrected rerun "
                f"(see the Needs Burson message above)."))
        if out is None:
            continue
        sent += _send(ctx, out, "burson_reminder")
        to_email = ",".join(out.dm_recipients) if out.dm_recipients else case.current_oncall_email
        case.oncall_notices.append(OnCallNotice(kind=kind, to_email=to_email, at=now))  # type: ignore[arg-type]
        ctx.emit(EventType.ONCALL_NOTIFIED, case_id=case.case_id, payload={"kind": kind, "to_email": to_email, "roster": "burson"})
        ctx.store.save_case(case)
    return sent


# ---------------------------------------------------------------------------
# 4. Sent detection + SLA misses
# ---------------------------------------------------------------------------


def sent_detection(ctx: AgentContext) -> int:
    try:
        from .escalation import service  # workstream A2
    except ImportError:
        return 0
    changed = 0
    for esc in ctx.store.list_escalations(open_only=True, limit=500):
        try:
            changed += len(service.check_sent(ctx, esc) or [])
        except Exception:  # noqa: BLE001 - one mailbox failing must not stop the job
            log.exception("check_sent failed for %s", esc.escalation_id)
    return changed


def sla_misses(ctx: AgentContext) -> int:
    """EMAIL_ALERT cases past due with no alert email sent: decide the SLA as missed (once)."""
    now = ctx.now()
    missed = 0
    for case in ctx.store.list_cases(statuses=[CaseStatus.VERIFIED], since=now - timedelta(days=3), limit=1000):
        if case.sla_met is not None or not case.sla_due_at or case.sla_due_at > now:
            continue
        a = case.latest.result.assessment if case.latest else None
        if not a or a.alert_action != "EMAIL_ALERT" or (ctx.config.inhouse.parity_mode and case.source == "inhouse"):
            continue
        sent = False
        for esc_id in case.escalation_ids:
            esc = ctx.store.get_escalation(esc_id)
            if esc and any(e.purpose == "alert" and e.status == EmailStatus.SENT for e in esc.emails):
                sent = True
        if sent:
            continue
        case.sla_met = False
        ctx.emit(EventType.SLA_MISSED, case_id=case.case_id,
                 payload={"track": case.track, "platform_tier": a.platform_tier, "sla_minutes": a.sla_minutes,
                          "due_at": case.sla_due_at.isoformat(), "reason": "no_email_by_due"})
        ctx.store.save_case(case)
        missed += 1
    return missed


# ---------------------------------------------------------------------------
# 5. Burson digest
# ---------------------------------------------------------------------------


def burson_digest(ctx: AgentContext, force: bool = False) -> int:
    cfg, now = ctx.config, ctx.now()
    fb = cfg.burson_feedback
    if fb.mode != "digest" and not force:
        return 0
    local = now.astimezone(ZoneInfo(cfg.timezone))
    key = f"digest:{local.date().isoformat()}"
    if not force and (local.hour < fb.digest_hour_local or ctx.store.get_kv(key)):
        return 0
    if not fb.post_digest_to_burson_space:
        return 0  # posting is off: nothing would be queued, so no day key and no burson.digest_posted
    events = ctx.events.query(since=now - timedelta(days=1), types=[EventType.CORRECTION_APPLIED, EventType.TRIAGE_FAILED,
                                                                   EventType.TRIAGE_SUPPRESSED, EventType.VERDICT_OVERRIDDEN])
    corrections = [e for e in events if e.event_type == EventType.CORRECTION_APPLIED]
    by_field: dict[str, list] = defaultdict(list)
    for e in corrections:
        by_field[e.payload.get("field") or "?"].append(e)
    lines = [f"{render.prefix(ctx)} *Daily QA digest for Burson* ({local.strftime('%b')} {local.day})"]
    if fb.recipients:
        lines.append("FYI " + " ".join(fb.recipients))
    if not corrections:
        lines.append("No corrections were needed in the last 24 hours. 🎉")
    else:
        lines.append(f"{len(corrections)} field corrections across {len({e.case_id for e in corrections})} alerts:")
        for name, evs in sorted(by_field.items(), key=lambda kv: -len(kv[1]))[:8]:
            examples = "; ".join(f"{e.case_id}: \"{render.truncate(e.payload.get('old'), 40)}\" → \"{render.truncate(e.payload.get('new'), 40)}\""
                                 for e in evs[:2])
            lines.append(f"- {render.label(name)} ×{len(evs)} (e.g. {examples})")
    bounced = sum(1 for e in events if e.event_type == EventType.TRIAGE_FAILED)
    suppressed = Counter(e.payload.get("reason") for e in events if e.event_type == EventType.TRIAGE_SUPPRESSED)
    lines.append(f"Sent back for unfixable data: {bounced} · Suppressed: {sum(suppressed.values())}"
                 + (f" ({', '.join(f'{k} {v}' for k, v in suppressed.most_common(3))})" if suppressed else ""))
    out = ChatOutputs(burson_text=render.finalize("\n".join(lines)))
    sent = _send(ctx, out, "burson_digest")
    if sent:  # the day key and the event both mean "today's digest was queued"
        ctx.store.put_kv(key, {"at": now.isoformat(), "corrections": len(corrections)})
        ctx.emit(EventType.BURSON_DIGEST_POSTED, space="burson", payload={"corrections": len(corrections), "fields": {k: len(v) for k, v in by_field.items()}})
    return sent


# ---------------------------------------------------------------------------
# 6. Handover
# ---------------------------------------------------------------------------


def _shift_windows(ctx: AgentContext, at: datetime) -> list[tuple[str, datetime, datetime]]:
    """(name, start, end) of each configured shift occurrence ending in the last 24h."""
    out = []
    for shift in ctx.config.shifts:
        tz = ZoneInfo(shift.tz)
        local = at.astimezone(tz)
        h1, m1 = map(int, shift.start.split(":"))
        h2, m2 = map(int, shift.end.split(":"))
        for day_offset in (0, -1):
            day = local.date() + timedelta(days=day_offset)
            start = datetime.combine(day, time(h1, m1), tzinfo=tz)
            end = datetime.combine(day, time(h2, m2), tzinfo=tz)
            if end <= start:
                end += timedelta(days=1)
            if end <= at:
                out.append((shift.name, start, end))
    return out


def handover_due(ctx: AgentContext) -> list[tuple[str, datetime, datetime]]:
    cfg, now = ctx.config, ctx.now()
    if not cfg.handover.enabled:
        return []
    due = []
    for name, start, end in _shift_windows(ctx, now):
        delay = now - end
        if timedelta(minutes=cfg.handover.minutes_after_shift_end) <= delay < timedelta(minutes=60):
            key = f"handover:{end.date().isoformat()}:{name}"
            if not ctx.store.get_kv(key):
                due.append((name, start, end))
    return due


def build_handover(ctx: AgentContext, name: str, start: datetime, end: datetime) -> ChatOutputs:
    cfg = ctx.config
    cases = [c for c in ctx.store.list_cases(since=start, limit=2000) if start <= c.created_at < end]
    by_status = Counter(c.status.value for c in cases)
    open_esc = ctx.store.list_escalations(open_only=True, limit=500)
    unsent = [(e, m) for e in open_esc for m in e.emails if m.status in (EmailStatus.DRAFTED, EmailStatus.REDRAFTED, EmailStatus.REVISION_REQUESTED)]
    tns_pending = [e for e in open_esc if e.tns and e.tns.status == TnsStatus.PREPARED]
    tns_waiting = [e for e in open_esc if e.tns and e.tns.status == TnsStatus.SUBMITTED and not e.tns.outcome]
    reviews = ctx.store.list_cases(statuses=[CaseStatus.NEEDS_REVIEW], limit=100)
    failed = ctx.store.list_cases(statuses=[CaseStatus.FAILED], limit=100)
    misses = [c for c in cases if c.sla_met is False]
    notable = [c for c in cases if c.status in (CaseStatus.VERIFIED, CaseStatus.CLOSED) and (c.track == "URGENT" or c.priority == "P0")][:6]
    lines = [
        f"{render.prefix(ctx)} *Shift handover: {name}* ({render.fmt_time(ctx, start)} – {render.fmt_time(ctx, end)})",
        f"Alerts: {len(cases)} · verified {by_status.get('VERIFIED', 0) + by_status.get('CLOSED', 0)} · "
        f"suppressed {by_status.get('SUPPRESSED', 0)} · held {by_status.get('NEEDS_REVIEW', 0)} · sent to Burson {by_status.get('FAILED', 0)}",
    ]
    if notable:
        lines.append("Notable:")
        lines += [f"- {c.case_id} {render.truncate(c.alert_name, 110)}" for c in notable]
    if unsent:
        lines.append("Unsent drafts: " + ", ".join(f"{e.escalation_id} ({e.analyst_email})" for e, _ in unsent[:8]))
    if tns_pending:
        lines.append("T&S forms prepared, not submitted: " + ", ".join(e.escalation_id for e in tns_pending[:8]))
    if tns_waiting:
        lines.append("T&S awaiting outcome: " + ", ".join(f"{e.escalation_id} (Issue {e.tns.wd_issue_id or '?'})" for e in tns_waiting[:8]))
    if reviews:
        lines.append("Waiting for review: " + ", ".join(c.case_id for c in reviews[:8]))
    if failed:
        lines.append("Waiting on Burson reruns: " + ", ".join(c.case_id for c in failed[:8]))
    if misses:
        lines.append("SLA misses: " + ", ".join(c.case_id for c in misses[:8]))
    text = render.finalize("\n".join(lines))
    out = ChatOutputs(summary=f"handover {name}")
    if cfg.handover.post_to_team:
        out.team_text = text
    if cfg.handover.append_to_doc:
        out.handover_text = text.replace("*", "")
    return out


@operation("generate_handover")
def generate_handover(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    now = ctx.now()
    wanted = (payload.get("shift") or "").strip().lower()
    windows = _shift_windows(ctx, now + timedelta(hours=24))  # include the current shift
    current = [w for w in windows if w[1] <= now] or windows
    match = [w for w in current if not wanted or w[0].lower() == wanted]
    if match:
        name, start, _end = max(match, key=lambda w: w[1])
        end = min(_end, now)
    else:
        name, start, end = "last 6 hours", now - timedelta(hours=6), now
    out = build_handover(ctx, name, start, end)
    ctx.emit(EventType.HANDOVER_POSTED, actor=rc.invoked_by or "agent", payload={"shift": name, "on_demand": True})
    return out, {"shift": name}


# ---------------------------------------------------------------------------
# 7. Parity reconciliation
# ---------------------------------------------------------------------------


def parity_reconcile(ctx: AgentContext) -> int:
    if not ctx.config.inhouse.enabled:
        return 0
    now = ctx.now()
    emitted = 0
    for case in ctx.store.list_cases(since=now - timedelta(days=2), limit=2000):
        if case.source not in ("burson_chat", "inhouse") or case.counterpart_case_id:
            continue
        if now - case.created_at < PARITY_MATCH_WINDOW or case.status == CaseStatus.SUPPRESSED:
            continue
        key = f"parity_unmatched:{case.case_id}"
        if ctx.store.get_kv(key):
            continue
        side = "burson_only" if case.source == "burson_chat" else "inhouse_only"
        ctx.emit(EventType.PARITY_UNMATCHED, case_id=case.case_id, payload={"side": side, "record_key": case.record_key})
        ctx.store.put_kv(key, {"at": now.isoformat(), "side": side})
        emitted += 1
    return emitted


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


@operation("run_followups")
def run_followups(ctx: AgentContext, payload: dict[str, Any], rc: RequestContext):
    explicit = payload.get("steps")
    if explicit:
        steps = list(explicit)
    elif ctx.flag("followups"):
        steps = ["sla", "reviews", "burson", "sent", "sla_misses", "digest", "handover", "parity", "own_alerts", "rering"]
    else:
        steps = ["sent", "sla_misses", "parity", "own_alerts", "rering"]
    report: dict[str, Any] = {}
    failed: list[str] = []

    def step(name: str, fn, *args) -> None:
        if name not in steps:
            return
        try:
            report[name] = fn(ctx, *args)
        except Exception as exc:  # noqa: BLE001 - keep going; the error is logged as an event
            log.exception("followups step %s failed", name)
            report[name] = f"error: {exc}"
            failed.append(name)
            ctx.emit(EventType.ERROR, payload={"op": f"run_followups.{name}", "error": str(exc)})

    def post_due_handovers(ctx: AgentContext) -> int:
        from . import handovers

        posted = 0
        for name, start, end in handover_due(ctx):
            out = build_handover(ctx, name, start, end)
            posted += _send(ctx, out, "handover")
            ctx.store.put_kv(f"handover:{end.date().isoformat()}:{name}", {"at": ctx.now().isoformat()})
            handovers.record(ctx, name, start, end, out.team_text or out.handover_text)  # kept for Workforce and its calendar
            ctx.emit(EventType.HANDOVER_POSTED, payload={"shift": name, "start": start.isoformat(), "end": end.isoformat()})
        return posted

    step("sla", sla_nudges)
    step("reviews", review_reminders)
    step("burson", burson_reminders)
    step("sent", sent_detection)
    step("sla_misses", sla_misses)
    step("digest", burson_digest)
    step("handover", post_due_handovers)
    step("parity", parity_reconcile)
    step("own_alerts", own_surge.run)  # a raised agent alert that is growing again is reviewed once more
    step("rering", rering_stale)
    summary = "followups: " + ", ".join(f"{k}={v}" for k, v in report.items())
    if failed:  # the operation still answers ok (every step ran); jobs/run_job.py exits non-zero on this
        report["failed_steps"] = failed
    return ChatOutputs(summary=summary), report
