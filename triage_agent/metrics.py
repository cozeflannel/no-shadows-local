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


# -- the Dashboard: alert messages by the lines of a Burson alert --------------------------------------------------------------
# A Burson alert reads [Product(s)]: [Social Network]: [Exposure Tag]: [Sensitive Topic]: [KOF]:. The Dashboard counts the
# alert messages in a time range by those lines (with the names from the taxonomy in config), plus Gemini's sentiment
# label, what the agent decided and where the alert came from, and filters by any of them. Each alert is one row of facts
# (alert_facts), built from its case; each Burson message on it (the first one, a rerun, an engagement update) counts once.

# Dimension key -> what the Dashboard calls it. "multi" dimensions can hold several values on one alert.
ALERT_DIMENSIONS: dict[str, dict[str, Any]] = {
    "product": {"label": "Product", "line": "[Product(s)]", "multi": True},
    "social_network": {"label": "Social network", "line": "[Social Network]", "multi": False},
    "exposure_tag": {"label": "Exposure tag", "line": "[Exposure Tag]", "multi": False},
    "sensitive_topic": {"label": "Sensitive topic", "line": "[Sensitive Topic]", "multi": True},
    "kof": {"label": "KOF", "line": "[KOF]", "multi": False},
    "kof_list": {"label": "KOF list", "line": "[KOF] list", "multi": True},
    "sentiment": {"label": "Sentiment", "line": "Gemini's read", "multi": False},
    "verdict": {"label": "What the agent decided", "line": "", "multi": False},
    "source": {"label": "Came from", "line": "", "multi": False},
}
NOT_GIVEN = "Not given"
NO_TOPIC = "None"
NO_KOF_LIST = "List not named"
SENTIMENT_LABELS = {"negative": "Negative", "neutral": "Neutral", "positive": "Positive", "": "Not rated"}
VERDICT_LABELS = {"PASS": "Passed as sent", "CORRECTED": "Fixed by the agent", "NEEDS_REVIEW": "Held for an IM to review",
                  "FAIL": "Sent back to Burson", "SUPPRESSED": "No alert needed (suppressed)"}
SOURCE_LABELS = {"burson_chat": "Burson", "inhouse": "In-house", "watchdog": "Watchdog email", "manual": "Pasted by hand"}
_EMPTY_VALUES = {"", "-", "–", "—", "none", "n/a", "na", "no", "null"}

# Response times: from the alert's first message to each step, over the alerts where that step happened.
RESPONSE_STEPS: list[tuple[str, str, str]] = [
    ("agent_review", "The agent's review", "From the alert message arriving to the agent's verdict on it: passed, fixed, held for an IM or sent back to Burson."),
    ("im_response", "First response by an IM", "To the first Incident Manager reaction on the alert, or their decision on an alert held for review."),
    ("burson_fix", "Burson's corrected re-post", "For alerts sent back to Burson: to the corrected message that then passed."),
    ("email_draft", "Social Alert draft ready", "To the Social Alert email draft landing in the IM's Gmail."),
    ("email_sent", "Social Alert email sent", "To the Social Alert email being sent."),
    ("tns_submitted", "Trust & Safety report submitted", "To the Trust & Safety form submission being confirmed."),
]
RESPONSE_EVENT_TYPES = [E.TRIAGE_PASSED, E.TRIAGE_CORRECTED, E.TRIAGE_FAILED, E.TRIAGE_NEEDS_REVIEW, E.TRIAGE_SUPPRESSED,
                        E.EMAIL_DRAFTED, E.EMAIL_SENT, E.TNS_SUBMITTED]
_DECISIONS = (E.TRIAGE_PASSED, E.TRIAGE_CORRECTED, E.TRIAGE_FAILED, E.TRIAGE_NEEDS_REVIEW, E.TRIAGE_SUPPRESSED)


def _text_list(value: Any) -> list[str]:
    if value is None:
        return []
    items = value if isinstance(value, (list, tuple)) else str(value).replace(";", ",").split(",")
    return [str(v).strip() for v in items if str(v).strip() and str(v).strip().lower() not in _EMPTY_VALUES]


def _canonical_network(config: Any, value: str | None) -> str:
    """The Social Network as the taxonomy names it (X, Reddit, ...). A value that is not a network is counted as Other."""
    raw = (value or "").strip()
    if not raw or raw.lower() in _EMPTY_VALUES:
        return NOT_GIVEN
    spec = config.alert_template.field("social_network") if config is not None else None
    allowed = list(spec.allowed or []) if spec is not None and getattr(spec, "allowed", None) else []
    key = raw.lower()
    if key in ("twitter", "x (twitter)", "x/twitter", "twitter/x"):
        key = "x"
    match = next((a for a in allowed if a.lower() == key), None)
    if match:
        return match
    return "Other" if allowed else raw


def alert_facts(case: Any, config: Any) -> dict[str, Any]:
    """One alert as the Dashboard counts it: its lines (taxonomy names), its messages and when people responded.

    `messages` holds one (arrived at, verdict) pair for each Burson message on the alert. An IM's re-assessment (forward
    after review, an undone fix) adds an attempt to the case but is not a new message, so it is left out."""
    attempts = list(case.attempts or [])
    latest = attempts[-1] if attempts else None
    result = latest.result if latest else None
    a = result.assessment if result else None
    norm = (result.normalized or {}) if result else {}
    collection = config.collection if config is not None else None
    distribution = config.distribution if config is not None else None

    def product_name(name: str) -> str:
        found = distribution.product(name) if distribution is not None else None
        return found.name if found is not None else name

    products: list[str] = []
    for name in [(a.product if a else None) or case.product or norm.get("product"), *_text_list(norm.get("other_products"))]:
        if name and str(name).strip().lower() not in _EMPTY_VALUES:
            canonical = product_name(str(name).strip())
            if canonical not in products:
                products.append(canonical)
    tag_raw = (a.exposure_tag if a else None) or case.exposure_tag or norm.get("exposure_tag")
    tag = collection.tag(tag_raw) if collection is not None and tag_raw else None
    exposure_tag = tag.name if tag is not None else (str(tag_raw).strip() if tag_raw and str(tag_raw).strip().lower() not in _EMPTY_VALUES else NOT_GIVEN)
    topics_raw = list(a.risk_topics) if a and a.risk_topics else _text_list(norm.get("risk_tags"))
    topics: list[str] = []
    for t in topics_raw:
        found = collection.topic(t) if collection is not None else None
        name = found.name if found is not None else t
        if name not in topics:
            topics.append(name)
    is_kof = bool(a.is_kof) if a else norm.get("kof") is True
    kof_lists = list(a.kof_lists) if a and a.kof_lists else _text_list(norm.get("kof_lists"))

    messages: list[tuple[datetime, str]] = []
    previous = None
    for att in attempts:
        message = att.message.model_dump(mode="json") if hasattr(att.message, "model_dump") else att.message
        if previous is None or message != previous:
            verdict = att.result.verdict
            messages.append((att.received_at, verdict.value if hasattr(verdict, "value") else str(verdict)))
        previous = message
    burson_fix_at = None
    for (_, verdict), (at, after) in zip(messages, messages[1:]):
        if verdict == "FAIL" and after in ("PASS", "CORRECTED"):
            burson_fix_at = at
            break
    responses = [case.acknowledged_at]
    if case.review is not None and (case.review.decided_by or "agent") != "agent":
        responses.append(case.review.at)
    responses.extend(x.at for x in (case.actions or []) if (x.actor or "agent") != "agent")
    im_response_at = min((t for t in responses if t is not None), default=None)
    status = case.status.value if hasattr(case.status, "value") else str(case.status)
    return {
        "case_id": case.case_id, "env": case.env, "source": case.source, "status": status,
        "alert_name": case.alert_name, "messages": messages,
        "first_at": messages[0][0] if messages else case.created_at, "last_at": messages[-1][0] if messages else case.created_at,
        "product": products or [NOT_GIVEN],
        "social_network": _canonical_network(config, (a.platform if a else None) or case.platform or norm.get("social_network")),
        "exposure_tag": exposure_tag, "priority": (tag.priority if tag is not None else (case.priority or "")) or "",
        "sensitive_topic": topics or [NO_TOPIC],
        "kof": "Yes" if is_kof else "No",
        "kof_list": (kof_lists or [NO_KOF_LIST]) if is_kof else [],
        "im_response_at": im_response_at, "burson_fix_at": burson_fix_at,
        "clean_posted_at": case.clean_posted_at, "created_at": case.created_at,
    }


def _values(row: dict[str, Any], dim: str, verdict: str, sentiment: dict[str, str]) -> list[str]:
    if dim == "verdict":
        return [verdict]
    if dim == "sentiment":
        return [sentiment.get(row["case_id"], "")]
    if dim == "source":
        return [row["source"]]
    value = row.get(dim)
    return list(value) if isinstance(value, list) else [value or ""]


def _matches(row: dict[str, Any], verdict: str, filters: dict[str, list[str]], sentiment: dict[str, str], skip: str | None = None) -> bool:
    for dim, wanted in filters.items():
        if dim == skip or not wanted:
            continue
        if not set(_values(row, dim, verdict, sentiment)) & set(wanted):
            return False
    return True


def option_label(dim: str, value: str) -> str:
    if dim == "sentiment":
        return SENTIMENT_LABELS.get(value, value)
    if dim == "verdict":
        return VERDICT_LABELS.get(value, value)
    if dim == "source":
        return SOURCE_LABELS.get(value, value)
    return value


def taxonomy_values(config: Any) -> dict[str, list[str]]:
    """Every value the taxonomy knows for each dimension, so a filter lists them all, not only the ones seen lately."""
    if config is None:
        return {}
    spec = config.alert_template.field("social_network")
    return {
        "product": [p.name for p in config.distribution.products if not p.deprecated],
        "social_network": list(spec.allowed or []) if spec is not None and getattr(spec, "allowed", None) else [],
        "exposure_tag": [t.name for t in config.collection.exposure_tags],
        "sensitive_topic": [t.name for t in config.collection.sensitive_topics],
        "kof": ["Yes", "No"],
        "sentiment": ["negative", "neutral", "positive", ""],
        "verdict": list(VERDICT_LABELS),
        "source": list(SOURCE_LABELS),
    }


def _step_times(row: dict[str, Any], events: list[AgentEvent]) -> dict[str, datetime | None]:
    """When each response step first happened for one alert (events are that alert's, in any order)."""
    out: dict[str, datetime | None] = {"agent_review": None, "im_response": row.get("im_response_at"), "burson_fix": row.get("burson_fix_at"),
                                       "email_draft": None, "email_sent": None, "tns_submitted": None}

    def first(key: str, at: datetime) -> None:
        held = out[key]
        if held is None or at < held:
            out[key] = at

    for e in events:
        p = e.payload or {}
        if e.event_type in _DECISIONS:
            first("agent_review", e.event_ts)
        elif e.event_type == E.EMAIL_DRAFTED and p.get("purpose", "alert") == "alert":
            first("email_draft", e.event_ts)
        elif e.event_type == E.EMAIL_SENT and p.get("purpose", "alert") == "alert":
            # The event is written when the send is noticed; post_to_send_s gives the send time itself.
            base = row.get("clean_posted_at") or row.get("created_at")
            sent = base + timedelta(seconds=float(p["post_to_send_s"])) if base and p.get("post_to_send_s") is not None else e.event_ts
            first("email_sent", sent)
        elif e.event_type == E.TNS_SUBMITTED:
            first("tns_submitted", e.event_ts)
    return out


def _seconds_stats(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"avg_s": None, "median_s": None, "n": 0}
    return {"avg_s": round(mean(values), 1), "median_s": round(median(values), 1), "n": len(values)}


def response_times(rows: list[dict[str, Any]], events: list[AgentEvent]) -> list[dict[str, Any]]:
    """Average and median time from each alert's first message to each step, over the alerts where the step happened."""
    by_case: dict[str, list[AgentEvent]] = defaultdict(list)
    for e in events:
        if e.case_id and e.event_type in RESPONSE_EVENT_TYPES:
            by_case[e.case_id].append(e)
    durations: dict[str, list[float]] = {key: [] for key, _, _ in RESPONSE_STEPS}
    for row in rows:
        start = row["first_at"]
        for key, at in _step_times(row, by_case.get(row["case_id"], [])).items():
            if at is not None and at >= start - timedelta(minutes=1):  # a step logged before the message arrived is a clock slip
                durations[key].append(max(0.0, (at - start).total_seconds()))
    return [{"key": key, "label": label, "description": desc, "of": len(rows), **_seconds_stats(durations[key])}
            for key, label, desc in RESPONSE_STEPS]


def matching_messages(rows: list[dict[str, Any]], since: datetime, until: datetime, filters: dict[str, list[str]] | None,
                      sentiment: dict[str, str] | None = None) -> tuple[int, set[str]]:
    """How many alert messages in [since, until) match the filters, and the alerts they are on (for the period before)."""
    sentiment = sentiment or {}
    wanted = {k: [str(v) for v in vs] for k, vs in (filters or {}).items() if k in ALERT_DIMENSIONS and vs}
    count, cases = 0, set()
    for row in rows:
        for at, verdict in row["messages"]:
            if since <= at < until and _matches(row, verdict, wanted, sentiment):
                count += 1
                cases.add(row["case_id"])
    return count, cases


def alert_view(rows: list[dict[str, Any]], since: datetime, until: datetime, filters: dict[str, list[str]] | None, *,
               sentiment: dict[str, str] | None = None, config: Any | None = None, events: list[AgentEvent] | None = None,
               top: int = 12) -> dict[str, Any]:
    """The Dashboard's numbers for a range and filters: how many alert messages, the breakdown by each line of the alert,
    the choices for each filter (each counted with the other filters applied) and the response times.

    Several values picked in one filter mean any of them; different filters must all hold."""
    sentiment = sentiment or {}
    wanted = {k: [str(v) for v in vs] for k, vs in (filters or {}).items() if k in ALERT_DIMENSIONS and vs}
    in_range = [(row, at, verdict) for row in rows for at, verdict in row["messages"] if since <= at < until]
    matching = [(row, at, verdict) for row, at, verdict in in_range if _matches(row, verdict, wanted, sentiment)]
    breakdowns: dict[str, list[dict[str, Any]]] = {}
    options: dict[str, list[dict[str, Any]]] = {}
    known = taxonomy_values(config)
    for dim in ALERT_DIMENSIONS:
        counts: Counter[str] = Counter()
        for row, _, verdict in matching:
            counts.update(set(_values(row, dim, verdict, sentiment)))
        ranked = counts.most_common()
        breakdowns[dim] = [{"value": v, "label": option_label(dim, v), "count": n} for v, n in ranked[:top]]
        if len(ranked) > top:
            breakdowns[dim].append({"value": "", "label": f"{len(ranked) - top} more", "count": sum(n for _, n in ranked[top:]), "more": True})
        choice: Counter[str] = Counter()
        for row, _, verdict in in_range:
            if _matches(row, verdict, wanted, sentiment, skip=dim):
                choice.update(set(_values(row, dim, verdict, sentiment)))
        values = list(dict.fromkeys([*choice, *known.get(dim, []), *wanted.get(dim, [])]))
        options[dim] = sorted(({"value": v, "label": option_label(dim, v), "count": choice.get(v, 0)} for v in values),
                              key=lambda o: (-o["count"], o["label"].lower()))
    alerts = {row["case_id"]: row for row, _, _ in matching}
    firsts = [row for row in alerts.values() if since <= row["first_at"] < until]
    return {
        "total_messages": len(matching), "total_alerts": len(alerts), "messages_in_range": len(in_range),
        "new_alerts": len(firsts), "case_ids": sorted(alerts),
        "breakdowns": breakdowns, "options": options,
        "dimensions": [{"key": k, **v} for k, v in ALERT_DIMENSIONS.items()],
        "response_times": response_times(firsts, events or []),
        "filters": wanted,
    }
