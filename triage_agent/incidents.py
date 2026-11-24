"""Incident reports: one per alert that was escalated, or that a person opened one for.

An incident report is the alert's story kept in one place: when it started and ended, a structured list of everything
that happened (read from the event log by triage_agent/reports.py), and the notes people add. The minute run opens one
for each alert that was escalated (a draft, a sent email, a T&S form) while the switch "Incident reports" is ON, and
keeps every open one up to date until its alert is closed. A person can open one for any alert, switch ON or OFF.
A person's note is theirs: nothing here rewrites or drops it.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from . import reports
from .config import switch_title
from .events import EventType as E
from .models import CaseStatus

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext
    from .models import Case

ROWS, MARK = "incidents", "incidents:mark"
SWITCH = "incident_reports"
NOTE_CHARS = 4000
OVER = (CaseStatus.CLOSED, CaseStatus.ABANDONED)
# The structured list: each kind of event under the part of the story it belongs to.
SECTIONS = (
    ("Arrival and review", {E.ALERT_RECEIVED, E.TRIAGE_PASSED, E.TRIAGE_CORRECTED, E.TRIAGE_NEEDS_REVIEW, E.TRIAGE_SUPPRESSED, E.TRIAGE_FAILED,
                            E.CORRECTION_APPLIED, E.CORRECTION_PROPOSED, E.CORRECTION_REVERTED, E.REVIEW_FORWARDED, E.REVIEW_BOUNCED,
                            E.REVIEW_SUPPRESSED, E.VERDICT_OVERRIDDEN, E.CLEAN_POSTED}),
    ("Response", {E.ALERT_ACKNOWLEDGED, E.ACTION_RECORDED, E.ONCALL_NOTIFIED, E.SLA_AT_RISK, E.SLA_MET, E.SLA_MISSED, E.PROTOCOL_PINGED}),
    ("Escalation", {E.ESCALATION_STARTED, E.EMAIL_DRAFTED, E.EMAIL_REDRAFTED, E.EMAIL_REVISION_REQUESTED, E.EMAIL_GROUP_ADDED, E.EMAIL_SENT,
                    E.EMAIL_DISCARDED, E.EMAIL_FAILED, E.TNS_ASSESSED, E.TNS_PREPARED, E.TNS_SUBMITTED, E.TNS_WITHDRAWN, E.TNS_OUTCOME}),
    ("Outcome", {E.CASE_CLOSED, E.CASE_ABANDONED}),
)


def why_off(ctx: "AgentContext") -> str:
    """Why no incident report is opened by the minute run right now, or ""."""
    return "" if ctx.flag(SWITCH) else f"the switch {switch_title(SWITCH)} is OFF"


def get(ctx: "AgentContext", incident_id: str) -> dict[str, Any] | None:
    return ctx.store.get_doc(ROWS, incident_id) if incident_id else None


def _follow(ctx: "AgentContext", doc: dict[str, Any], case: "Case") -> dict[str, Any]:
    """Bring an incident report up to date with its alert: its name, its latest activity, and its end once the alert is over."""
    seen = [e for e in ctx.events.query(case_id=case.case_id) if e.event_type in reports.SAYS]
    last = max([e.event_ts for e in seen] + [case.created_at])
    ended = None
    if case.status in OVER:
        ends = [e.event_ts for e in seen if e.event_type in (E.CASE_CLOSED, E.CASE_ABANDONED)]
        ended = max(ends) if ends else last
    doc.update(name=case.issue_name or case.alert_name or case.case_id, priority=case.priority or "", product=case.product or "",
               last_at=last.isoformat(), ended_at=ended.isoformat() if ended else None, status="closed" if ended else "open")
    return doc


def open_for(ctx: "AgentContext", case: "Case", *, by: str = "agent") -> dict[str, Any]:
    """The alert's incident report, opened now if it has none. One per alert: opening it again changes nothing."""
    doc = get(ctx, case.case_id)
    if doc is None:
        doc = _follow(ctx, {"id": case.case_id, "case_id": case.case_id, "opened_at": ctx.now().isoformat(), "opened_by": by,
                            "started_at": case.created_at.isoformat(), "notes": []}, case)
        ctx.store.put_doc(ROWS, doc["id"], doc)
    return doc


def sync_one(ctx: "AgentContext", incident_id: str) -> dict[str, Any] | None:
    doc = get(ctx, incident_id)
    case = ctx.store.get_case(doc["case_id"]) if doc else None
    if doc is None or case is None:
        return doc
    was = doc["status"]
    ctx.store.put_doc(ROWS, doc["id"], _follow(ctx, doc, case))
    return {**doc, "just_closed": was == "open" and doc["status"] == "closed"}


def sync(ctx: "AgentContext") -> dict[str, Any]:
    """One pass, once a minute: open an incident report for each alert escalated since the last pass, and bring the open
    ones up to date."""
    why = why_off(ctx)
    if why:
        return {"ok": True, "off": True, "why": why}
    now = ctx.now()
    mark = (ctx.store.get_kv(MARK) or {}).get("at")
    since = datetime.fromisoformat(mark) if mark else now - timedelta(days=ctx.config.platform.reports.max_days)
    out = {"ok": True, "off": False, "opened": 0, "closed": 0}
    for case_id in dict.fromkeys(e.case_id for e in ctx.events.query(since=since, until=now, types=list(reports.ESCALATED)) if e.case_id):
        case = ctx.store.get_case(case_id)
        if case is not None and get(ctx, case_id) is None:
            open_for(ctx, case)
            out["opened"] += 1
    for doc in ctx.store.list_docs(ROWS, where={"status": "open"}, limit=1000):
        out["closed"] += bool((sync_one(ctx, doc["id"]) or {}).get("just_closed"))
    ctx.store.put_kv(MARK, {"at": now.isoformat()})
    return out


def add_note(ctx: "AgentContext", incident_id: str, text: str, *, by: str) -> dict[str, Any]:
    doc = get(ctx, incident_id)
    if doc is None:
        raise KeyError(incident_id)
    text = (text or "").strip()
    if not text:
        raise ValueError("Write the note first.")
    if len(text) > NOTE_CHARS:
        raise ValueError(f"A note is at most {NOTE_CHARS:,} characters.")
    note = {"id": uuid.uuid4().hex[:12], "by": by, "at": ctx.now().isoformat(), "text": text}
    doc["notes"] = [*doc.get("notes", []), note]
    ctx.store.put_doc(ROWS, doc["id"], doc)
    return note


def between(ctx: "AgentContext", since: datetime, until: datetime) -> list[dict[str, Any]]:
    """The incident reports that touch a stretch of time, newest start first. An open one runs on past now."""
    out = []
    for d in ctx.store.list_docs(ROWS, limit=5000):
        start = datetime.fromisoformat(d["started_at"])
        end = datetime.fromisoformat(d["ended_at"]) if d["ended_at"] else None
        if start <= until and (end is None or end >= since):
            out.append({k: d.get(k) for k in ("id", "case_id", "name", "priority", "product", "status", "started_at", "ended_at", "last_at",
                                              "opened_at", "opened_by")} | {"notes": len(d.get("notes", []))})
    return sorted(out, key=lambda d: d["started_at"], reverse=True)


def detail(ctx: "AgentContext", incident_id: str) -> dict[str, Any] | None:
    """The incident report in full: the facts, the structured list of everything that happened, and the notes."""
    doc = get(ctx, incident_id)
    case = ctx.store.get_case(doc["case_id"]) if doc else None
    if doc is None or case is None:
        return None
    now = ctx.now()
    entries = reports.timeline(ctx, case, case.created_at, None)  # everything recorded, this very moment included
    sections = []
    for title, members in SECTIONS:
        kinds = {str(k) for k in members}
        rows = [{"at": e["at"], "what": e["what"], "who": e["who"]} for e in entries if e["kind"] in kinds]
        if rows:
            sections.append({"title": title, "entries": rows})
    start = case.created_at
    end = datetime.fromisoformat(doc["ended_at"]) if doc["ended_at"] else now
    ack = next((e for e in ctx.events.query(case_id=case.case_id, types=[E.ALERT_ACKNOWLEDGED]) if (e.payload or {}).get("ack_latency_s") is not None), None)
    return {"id": doc["id"], "opened_at": doc["opened_at"], "opened_by": doc["opened_by"], "notes": doc.get("notes", []), "sections": sections,
            "facts": {"name": doc["name"], "case_id": case.case_id, "product": case.product or "", "priority": case.priority or "",
                      "status": doc["status"], "alert_status": case.status.value, "started_at": start.isoformat(), "ended_at": doc["ended_at"],
                      "minutes": round((end - start).total_seconds() / 60),
                      "acknowledged_after_minutes": round(float(ack.payload["ack_latency_s"]) / 60) if ack else None}}
