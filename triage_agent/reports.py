"""Reports: what happened in a window of time, alert by alert, each with its own timeline.

A report is read from the event log the agent already writes (agent_events): nothing new is recorded for it. Every
alert with activity in the window is listed with its whole story up to the window's end, in time order and in plain
words; the part from before the window is marked. The same report serves the Reports page (a window a person picks),
a schedule, and a shift on Workforce (the window is the shift).
"""

from __future__ import annotations

import statistics
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from .events import EventType as E

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext
    from .models import AgentEvent, Case

WINDOWS = {"1h": timedelta(hours=1), "4h": timedelta(hours=4), "24h": timedelta(days=1), "7d": timedelta(days=7)}
# What each kind of event is called in a timeline, in the order a person would tell it: events of one moment are
# listed in this order (marked, then what the mark caused). A kind that is not here is not timeline material (model
# usage, ignored messages, parity bookkeeping).
SAYS = {
    E.ALERT_RECEIVED: "Alert received", E.TRIAGE_PASSED: "Reviewed: correct as sent", E.TRIAGE_CORRECTED: "Reviewed: corrected",
    E.TRIAGE_NEEDS_REVIEW: "Reviewed: needs a person", E.TRIAGE_SUPPRESSED: "Reviewed: suppressed", E.TRIAGE_FAILED: "Reviewed: sent back",
    E.CORRECTION_APPLIED: "Correction applied", E.CORRECTION_PROPOSED: "Correction proposed", E.CORRECTION_REVERTED: "Correction undone",
    E.REVIEW_FORWARDED: "Sent on by a person", E.REVIEW_BOUNCED: "Sent back by a person", E.REVIEW_SUPPRESSED: "Suppressed by a person",
    E.VERDICT_OVERRIDDEN: "Verdict changed by a person", E.CLEAN_POSTED: "Posted to the analysts", E.ONCALL_NOTIFIED: "On-call told",
    E.ALERT_ACKNOWLEDGED: "Acknowledged", E.ACTION_RECORDED: "Marked", E.SLA_AT_RISK: "Response time at risk", E.SLA_MET: "Response time met",
    E.SLA_MISSED: "Response time missed", E.PROTOCOL_PINGED: "Leadership told", E.ESCALATION_STARTED: "Escalation started",
    E.EMAIL_DRAFTED: "Email drafted", E.EMAIL_REDRAFTED: "Email redrafted", E.EMAIL_REVISION_REQUESTED: "Changes to the email asked for",
    E.EMAIL_GROUP_ADDED: "Group added to the email", E.EMAIL_SENT: "Email sent", E.EMAIL_DISCARDED: "Email discarded", E.EMAIL_FAILED: "Email failed",
    E.TNS_ASSESSED: "T&S assessed", E.TNS_PREPARED: "T&S form filled in", E.TNS_SUBMITTED: "T&S form submitted", E.TNS_WITHDRAWN: "T&S form withdrawn",
    E.TNS_OUTCOME: "T&S outcome recorded", E.CASE_CLOSED: "Closed", E.CASE_ABANDONED: "Abandoned",
}
ORDER = {kind: n for n, kind in enumerate(SAYS)}
ESCALATED = {E.ESCALATION_STARTED, E.EMAIL_DRAFTED, E.EMAIL_SENT, E.TNS_PREPARED, E.TNS_SUBMITTED}


def bounds(ctx: "AgentContext", window: str, start: str | None = None, end: str | None = None) -> tuple[datetime, datetime]:
    """The window as two moments. A set length ends now; a custom one is the two dates given."""
    now = ctx.now()
    if window in WINDOWS:
        return now - WINDOWS[window], now
    if window != "custom":
        raise ValueError("Choose the last hour, 4 hours, day or week, or two dates.")
    if not start or not end:
        raise ValueError("Give a start and an end.")
    try:
        since, until = datetime.fromisoformat(start), datetime.fromisoformat(end)
    except ValueError as exc:
        raise ValueError("Give the start and the end as dates.") from exc
    since, until = (d if d.tzinfo else d.replace(tzinfo=now.tzinfo) for d in (since, until))
    if since >= until:
        raise ValueError("The start must be before the end.")
    if until - since > timedelta(days=ctx.config.platform.reports.max_days):
        raise ValueError(f"A report covers at most {ctx.config.platform.reports.max_days} days.")
    return since, until


def _says(ctx: "AgentContext", e: "AgentEvent") -> str | None:
    said = SAYS.get(e.event_type)
    if said is None:
        return None
    p = e.payload or {}
    if e.event_type == E.ALERT_ACKNOWLEDGED and p.get("ack_latency_s") is not None:
        return f"{said} after {round(float(p['ack_latency_s']) / 60)} min"
    if e.event_type == E.ACTION_RECORDED:
        action = ctx.config.action(str(p.get("code") or ""))
        return f"{said} {action.emoji} {action.label}" if action else f"{said} {p.get('emoji') or p.get('code') or ''}".strip()
    if e.event_type in (E.CASE_CLOSED, E.CASE_ABANDONED) and p.get("reason"):
        return f"{said}: {str(p['reason']).replace('_', ' ')}"
    return said


def timeline(ctx: "AgentContext", case: "Case", since: datetime, until: datetime | None) -> list[dict[str, Any]]:
    """One alert's story up to `until` (None: everything recorded so far), oldest first. An alert whose log does not
    start with its arrival gets that line from the alert's own record."""
    events = sorted((e for e in ctx.events.query(case_id=case.case_id, until=until) if _says(ctx, e)),
                    key=lambda e: (e.event_ts, ORDER[e.event_type]))
    out = [{"at": e.event_ts.isoformat(), "kind": str(e.event_type), "what": _says(ctx, e),
            "who": "" if e.actor in ("agent", "unknown", None) else e.actor, "in_window": e.event_ts >= since} for e in events]
    if not any(e.event_type == E.ALERT_RECEIVED for e in events) and (until is None or case.created_at <= until):
        out.insert(0, {"at": case.created_at.isoformat(), "kind": str(E.ALERT_RECEIVED), "what": SAYS[E.ALERT_RECEIVED], "who": "",
                       "in_window": case.created_at >= since})
    return out


def build(ctx: "AgentContext", since: datetime, until: datetime, *, escalated_only: bool = False, window: str = "custom",
          by: str = "agent") -> dict[str, Any]:
    """The report for a window: its alerts, newest activity first, each with its timeline, and the totals."""
    last: dict[str, datetime] = {}  # alert -> its latest activity in the window
    for e in ctx.events.query(since=since, until=until, types=list(SAYS)):
        if e.case_id:
            last[e.case_id] = max(last.get(e.case_id, e.event_ts), e.event_ts)
    for case in ctx.store.list_cases(since=since, limit=100000):
        if since <= case.created_at <= until:  # an alert that arrived in the window, whatever its log holds
            last.setdefault(case.case_id, case.created_at)
    alerts, acks = [], []
    totals = {"alerts": 0, "acknowledged": 0, "escalated": 0, "emails_sent": 0, "tns_submitted": 0, "closed": 0}
    for case_id in sorted(last, key=lambda c: last[c], reverse=True):
        case = ctx.store.get_case(case_id)
        if case is None:
            continue
        seen = ctx.events.query(case_id=case_id, until=until)
        kinds = {e.event_type for e in seen}
        escalated = bool(kinds & ESCALATED)
        if escalated_only and not escalated:
            continue
        totals["alerts"] += 1
        totals["escalated"] += escalated
        totals["acknowledged"] += E.ALERT_ACKNOWLEDGED in kinds
        totals["emails_sent"] += E.EMAIL_SENT in kinds
        totals["tns_submitted"] += E.TNS_SUBMITTED in kinds
        totals["closed"] += E.CASE_CLOSED in kinds
        acks += [float(e.payload["ack_latency_s"]) / 60 for e in seen
                 if e.event_type == E.ALERT_ACKNOWLEDGED and (e.payload or {}).get("ack_latency_s") is not None]
        if len(alerts) < ctx.config.platform.reports.max_alerts:
            alerts.append({"case_id": case.case_id, "name": case.issue_name or case.alert_name or "", "product": case.product or "",
                           "priority": case.priority or "", "status": case.status.value, "received_at": case.created_at.isoformat(),
                           "escalated": escalated, "timeline": timeline(ctx, case, since, until)})
    report = {"made_at": ctx.now().isoformat(), "made_by": by, "window": window, "since": since.isoformat(),
              "until": until.isoformat(), "escalated_only": escalated_only,
              "totals": {**totals, "median_ack_minutes": round(statistics.median(acks), 1) if acks else None}, "alerts": alerts}
    if totals["alerts"] > len(alerts):
        report["cut"] = {"shown": len(alerts), "of": totals["alerts"]}
    return report
