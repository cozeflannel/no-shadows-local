"""KPI definitions over the event log (single source of truth).

Used by the Agent Console (local + GCP) and by conversational Q&A
("how many alerts were sent back today?"). analytics/02_metric_views.sql
mirrors these definitions in BigQuery for ad-hoc analysis.

Event payload conventions are documented in docs/CONTRACTS.md#events.
"""

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from statistics import mean, median
from typing import Any, Iterable

from .events import EventType as E
from .models import AgentEvent

# KPI key -> (label, description, group) — shown in the Console and used by Q&A.
KPI_DEFINITIONS: dict[str, tuple[str, str, str]] = {
    # Intake & QA (the user's original metrics, plus v3 verdicts)
    "alerts_received": ("Alerts received", "Alerts detected (Burson chat, in-house, Watchdog), all attempts.", "intake"),
    "forwarded_without_edits": ("Forwarded without edits", "Passed QA as received on the first submission.", "intake"),
    "auto_corrected": ("Auto-corrected & forwarded", "Alertable after the agent fixed fields itself (no Burson retrigger).", "intake"),
    "sent_back_for_edits": ("Sent back to Burson", "Unfixable data bounced to the Burson on-call (Zapier messages sent back for edits).", "intake"),
    "burson_reruns_passed": ("Burson reruns forwarded", "A Burson rerun of a bounced alert that then passed.", "intake"),
    "suppressed": ("Suppressed", "Didn't meet the Collection Requirements (logged with the reason).", "intake"),
    "needs_review": ("Held for IM review", "Low-confidence verdicts sent to the IM on shift.", "intake"),
    "review_forwarded": ("Forwarded after review", "IM approved a held alert.", "intake"),
    "review_bounced": ("Bounced after review", "IM sent a held alert back to Burson.", "intake"),
    "review_suppressed": ("Suppressed after review", "IM decided a held alert doesn't meet the requirements.", "intake"),
    "corrections_applied": ("Field corrections", "Individual field corrections applied automatically.", "quality"),
    "corrections_reverted": ("Corrections reverted", "Auto-corrections an IM undid.", "quality"),
    "verdict_overrides": ("Agent marked wrong (👎)", "IM said the verdict or classification was wrong.", "quality"),
    "oncall_alerts": ("On-call notices", "Bounces, reminders, backup/fallback escalations and SLA nudges sent.", "intake"),
    "cases_abandoned": ("Abandoned cases", "No corrected rerun before the wait limit.", "intake"),
    # IM workflow
    "alerts_acknowledged": ("Alerts acknowledged", "Clean-space alerts an IM reacted to.", "im"),
    "im_actions": ("IM actions", "Emoji-legend actions the agent carried out.", "im"),
    "protocol_pings": ("Protocol pings", "YouTube / Doodle / leadership / crisis / Jon notifications posted.", "im"),
    "sla_met": ("SLA met", "Alert emails sent before the platform SLA deadline.", "im"),
    "sla_missed": ("SLA missed", "Alert emails sent after the SLA deadline (or never).", "im"),
    "sla_at_risk": ("SLA nudges", "IM nudged because an alert was unacknowledged near its SLA.", "im"),
    # Email drafts (the user's original metrics)
    "escalations_started": ("Escalations started", "Alerts escalated (📦/✍️ reactions, URGENT auto-drafts, chat).", "email"),
    "urgent_auto_drafts": ("URGENT auto-drafts", "Drafts created before the IM reacted (URGENT track).", "email"),
    "emails_drafted": ("Emails drafted", "Drafts created in the IM's Gmail (Brand Social alias).", "email"),
    "emails_returned_for_edits": ("Returned for edits", "IM revision requests on drafts.", "email"),
    "emails_redrafted": ("Resent (revised)", "Revised draft versions delivered.", "email"),
    "emails_sent": ("Sent by IM", "Drafts the IM sent from Gmail.", "email"),
    "emails_discarded": ("Drafts discarded", "Drafts deleted without sending.", "email"),
    "groups_added": ("Teams added", "Non-product teams added to drafts (📰 💬 💼 💧 1️⃣ 🦺 ⛑️ ⚖️ 📸 🌎 🌱).", "email"),
    # Trust & Safety (the user's original metric + the Watchdog loop)
    "tns_prepared": ("T&S forms prepared", "Pre-filled go/WD-Triage links produced.", "tns"),
    "tns_submitted": ("T&S forms submitted", "Submissions confirmed (WD intake email or IM).", "tns"),
    "tns_not_eligible": ("T&S not eligible", "Assessed as not meeting T&S criteria.", "tns"),
    "tns_urgent_emails": ("T&S urgent emails drafted", "trustsafety-urgent@ drafts for viral/urgent issues.", "tns"),
    "tns_fixed": ("T&S outcome: Fixed", "WD reports marked Fixed.", "tns"),
    "tns_infeasible": ("T&S outcome: Infeasible", "WD reports marked Infeasible.", "tns"),
    "bug_followups_drafted": ("Bug-ID follow-ups drafted", "go/Bad bug-ID replies drafted on the alert thread.", "tns"),
    "bug_followups_sent": ("Bug-ID follow-ups sent", "Bug-ID replies the IM sent.", "tns"),
    "watchdog_alerts_created": ("Alerts from Watchdog emails", "Watchdog Anti-Abuse emails turned into alerts by the agent.", "tns"),
    # Conversation (the user's original metrics)
    "questions_answered": ("Messages answered", "Questions the agent answered in chat.", "chat"),
    "rerouted_to_stakeholders": ("Rerouted to stakeholders", "Questions routed or relayed to owning teams.", "chat"),
    "answers_helpful": ("Helpful answers (👍)", "Positive feedback on answers.", "chat"),
    "answers_unhelpful": ("Unhelpful answers (👎)", "Negative feedback on answers.", "chat"),
    # Path B
    "parity_matched": ("Parity: matched", "Posts alerted by both Burson and the in-house pipeline.", "parity"),
    "parity_burson_only": ("Parity: Burson only", "Burson alerts the in-house pipeline missed.", "parity"),
    "parity_inhouse_only": ("Parity: in-house only", "In-house alerts Burson didn't send.", "parity"),
    # Jobs
    "handovers_posted": ("Shift handovers", "Handover summaries posted / appended.", "jobs"),
    "burson_digests": ("Burson digests", "Daily correction digests posted for Burson.", "jobs"),
}


def _count(events: Iterable[AgentEvent], event_type: str, **payload_eq: Any) -> int:
    return sum(
        1
        for e in events
        if e.event_type == event_type and all((e.payload or {}).get(k) == v for k, v in payload_eq.items())
    )


def _minutes(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"avg": None, "median": None, "n": 0}
    return {"avg": round(mean(values) / 60, 1), "median": round(median(values) / 60, 1), "n": len(values)}


def _ms(values: list[int]) -> dict[str, float | None]:
    if not values:
        return {"avg": None, "p50": None}
    return {"avg": round(mean(values)), "p50": round(median(values))}


def _payload_values(events: list[AgentEvent], event_type: str, key: str) -> list[float]:
    return [
        float(e.payload[key])
        for e in events
        if e.event_type == event_type and (e.payload or {}).get(key) is not None
    ]


def _pct(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 3) if denominator else None


def compute_kpis(events: list[AgentEvent], config: Any | None = None) -> dict:
    """All KPIs for a set of events (caller filters by time window / env).

    `config` (AgentConfig) enables the time-saved estimate.
    """
    decisions = (E.TRIAGE_PASSED, E.TRIAGE_CORRECTED, E.TRIAGE_FAILED, E.TRIAGE_NEEDS_REVIEW, E.TRIAGE_SUPPRESSED)
    passed = [e for e in events if e.event_type == E.TRIAGE_PASSED]
    corrected = [e for e in events if e.event_type == E.TRIAGE_CORRECTED]
    failed = [e for e in events if e.event_type == E.TRIAGE_FAILED]
    first_attempt = [e for e in events if e.event_type in decisions and (e.attempt or 1) == 1]
    first_pass = [e for e in passed if (e.attempt or 1) == 1]
    reruns_passed = [
        e for e in passed + corrected if (e.attempt or 1) > 1 and (e.payload or {}).get("after_bounce")
    ]
    feedback = Counter((e.payload or {}).get("rating") for e in events if e.event_type == E.QA_FEEDBACK)
    drafted = [e for e in events if e.event_type == E.EMAIL_DRAFTED]
    sent = [e for e in events if e.event_type == E.EMAIL_SENT]

    kpis = {
        "alerts_received": _count(events, E.ALERT_RECEIVED),
        "forwarded_without_edits": len(first_pass),
        "auto_corrected": len(corrected),
        "sent_back_for_edits": len(failed),
        "burson_reruns_passed": len(reruns_passed),
        "suppressed": _count(events, E.TRIAGE_SUPPRESSED),
        "needs_review": _count(events, E.TRIAGE_NEEDS_REVIEW),
        "review_forwarded": _count(events, E.REVIEW_FORWARDED),
        "review_bounced": _count(events, E.REVIEW_BOUNCED),
        "review_suppressed": _count(events, E.REVIEW_SUPPRESSED),
        "corrections_applied": _count(events, E.CORRECTION_APPLIED),
        "corrections_reverted": _count(events, E.CORRECTION_REVERTED),
        "verdict_overrides": _count(events, E.VERDICT_OVERRIDDEN),
        "oncall_alerts": _count(events, E.ONCALL_NOTIFIED),
        "cases_abandoned": _count(events, E.CASE_ABANDONED),
        "alerts_acknowledged": _count(events, E.ALERT_ACKNOWLEDGED),
        "im_actions": _count(events, E.ACTION_RECORDED),
        "protocol_pings": _count(events, E.PROTOCOL_PINGED),
        "sla_met": _count(events, E.SLA_MET),
        "sla_missed": _count(events, E.SLA_MISSED),
        "sla_at_risk": _count(events, E.SLA_AT_RISK),
        "escalations_started": _count(events, E.ESCALATION_STARTED),
        "urgent_auto_drafts": _count(events, E.ESCALATION_STARTED, trigger="auto_urgent"),
        "emails_drafted": len(drafted),
        "emails_returned_for_edits": _count(events, E.EMAIL_REVISION_REQUESTED),
        "emails_redrafted": _count(events, E.EMAIL_REDRAFTED),
        "emails_sent": len(sent),
        "emails_discarded": _count(events, E.EMAIL_DISCARDED),
        "groups_added": _count(events, E.EMAIL_GROUP_ADDED),
        "tns_prepared": _count(events, E.TNS_PREPARED),
        "tns_submitted": _count(events, E.TNS_SUBMITTED),
        "tns_not_eligible": _count(events, E.TNS_NOT_ELIGIBLE),
        "tns_urgent_emails": _count(events, E.EMAIL_DRAFTED, purpose="tns_urgent"),
        "tns_fixed": _count(events, E.TNS_OUTCOME, outcome="Fixed"),
        "tns_infeasible": _count(events, E.TNS_OUTCOME, outcome="Infeasible"),
        "bug_followups_drafted": _count(events, E.EMAIL_DRAFTED, purpose="bug_followup"),
        "bug_followups_sent": _count(events, E.EMAIL_SENT, purpose="bug_followup"),
        "watchdog_alerts_created": _count(events, E.ALERT_RECEIVED, source="watchdog"),
        "questions_answered": _count(events, E.QA_ANSWERED),
        "rerouted_to_stakeholders": _count(events, E.ROUTE_FORWARDED) + _count(events, E.ROUTE_RELAYED),
        "answers_helpful": feedback.get("up", 0),
        "answers_unhelpful": feedback.get("down", 0),
        "parity_matched": _count(events, E.PARITY_MATCHED),
        "parity_burson_only": _count(events, E.PARITY_UNMATCHED, side="burson_only"),
        "parity_inhouse_only": _count(events, E.PARITY_UNMATCHED, side="inhouse_only"),
        "handovers_posted": _count(events, E.HANDOVER_POSTED),
        "burson_digests": _count(events, E.BURSON_DIGEST_POSTED),
    }

    alertable = len(first_pass) + len(corrected) + len(failed) + kpis["needs_review"]
    alert_emails_sent = [e for e in sent if (e.payload or {}).get("purpose", "alert") == "alert"]
    burson_side = kpis["parity_matched"] + kpis["parity_burson_only"]
    derived = {
        "first_pass_yield": _pct(len(first_pass), len(first_attempt)),
        "burson_bounce_rate": _pct(len(failed), alertable),  # share of alertable alerts that still needed Burson
        "auto_fix_rate": _pct(len(corrected), alertable),
        "revisions_per_email": round(kpis["emails_returned_for_edits"] / len(drafted), 2) if drafted else None,
        "sla_met_pct": _pct(kpis["sla_met"], kpis["sla_met"] + kpis["sla_missed"]),
        "sla_by_track": _sla_breakdown(events, "track"),
        "sla_by_tier": _sla_breakdown(events, "platform_tier"),
        "corrections_by_field": dict(Counter((e.payload or {}).get("field") for e in events if e.event_type == E.CORRECTION_APPLIED)),
        "suppressed_by_reason": dict(Counter((e.payload or {}).get("reason") for e in events if e.event_type == E.TRIAGE_SUPPRESSED)),
        "actions_by_code": dict(Counter((e.payload or {}).get("code") for e in events if e.event_type == E.ACTION_RECORDED)),
        "protocol_pings_by_type": dict(Counter((e.payload or {}).get("protocol") for e in events if e.event_type == E.PROTOCOL_PINGED)),
        "alerts_by_source": dict(Counter((e.payload or {}).get("source", "burson_chat") for e in events if e.event_type == E.ALERT_RECEIVED)),
        "parity_recall": _pct(kpis["parity_matched"], burson_side),
        # speed (seconds in payloads, reported in minutes)
        "detect_latency_min": _minutes(_payload_values(events, E.ALERT_RECEIVED, "detect_latency_s")),  # post -> alert
        "post_to_send_min": _minutes([float((e.payload or {})["post_to_send_s"]) for e in alert_emails_sent if (e.payload or {}).get("post_to_send_s") is not None]),
        "flag_to_send_min": _minutes([float((e.payload or {})["flag_to_send_s"]) for e in alert_emails_sent if (e.payload or {}).get("flag_to_send_s") is not None]),
        "time_to_correction_min": _minutes([float((e.payload or {})["time_to_correction_s"]) for e in reruns_passed if (e.payload or {}).get("time_to_correction_s") is not None]),
        "triage_latency_ms": _ms([e.latency_ms for e in events if e.event_type in decisions and e.latency_ms is not None]),
    }
    if config is not None:
        m = config.metrics
        avoided_retriggers = len(corrected) + kpis["review_forwarded"]
        derived["time_saved_hours"] = round(
            (avoided_retriggers * m.burson_retrigger_minutes + len(drafted) * m.im_minutes_per_alert) / 60, 1
        )
    return {"kpis": kpis, "derived": derived}


def _sla_breakdown(events: list[AgentEvent], key: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = defaultdict(lambda: {"met": 0, "missed": 0, "pct": None})
    for e in events:
        if e.event_type in (E.SLA_MET, E.SLA_MISSED):
            bucket = str((e.payload or {}).get(key) or "unknown")
            out[bucket]["met" if e.event_type == E.SLA_MET else "missed"] += 1
    for row in out.values():
        row["pct"] = _pct(row["met"], row["met"] + row["missed"])
    return dict(out)


def error_breakdown(events: list[AgentEvent], top: int = 15) -> list[dict]:
    """Most common rule codes behind bounces and review holds."""
    counter: Counter[str] = Counter()
    for e in events:
        if e.event_type in (E.TRIAGE_FAILED, E.TRIAGE_NEEDS_REVIEW):
            counter.update(e.error_codes or [])
    return [{"code": code, "count": n} for code, n in counter.most_common(top)]


def failures_by_oncall(events: list[AgentEvent]) -> list[dict]:
    counter: Counter[str] = Counter(
        (e.payload or {}).get("oncall_email") or "unassigned" for e in events if e.event_type == E.TRIAGE_FAILED
    )
    return [{"oncall_email": k, "count": v} for k, v in counter.most_common()]


def timeseries(events: list[AgentEvent], types: list[str], bucket: str = "day", tz: str = "UTC") -> list[dict]:
    """Counts per bucket ("day" | "hour") per event type, oldest first."""
    from zoneinfo import ZoneInfo

    zone = ZoneInfo(tz)
    rows: dict[str, Counter[str]] = defaultdict(Counter)
    for e in events:
        if e.event_type not in types:
            continue
        local = e.event_ts.astimezone(zone)
        key = local.strftime("%Y-%m-%d") if bucket == "day" else local.strftime("%Y-%m-%dT%H:00")
        rows[key][e.event_type] += 1
    return [{"bucket": k, **{t: rows[k].get(t, 0) for t in types}} for k in sorted(rows)]


def window(days: int = 7, now: datetime | None = None) -> tuple[datetime, datetime]:
    now = now or datetime.now(timezone.utc)
    return now - timedelta(days=days), now
