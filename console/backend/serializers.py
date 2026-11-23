"""JSON shapes returned by the Console API (summaries for tables, human-readable event lines)."""

from __future__ import annotations

import re
from typing import Any

from triage_agent.models import AgentEvent, Case, Escalation
from triage_agent.render import FIELD_LABELS
from triage_agent.store import escalation_is_open

SOURCE_LABELS = {"burson_chat": "Burson chat", "inhouse": "in-house (Path B)", "watchdog": "Watchdog email", "manual": "manual"}

# Why an alert was not posted, in words (the codes come from the Collection Requirements). The Console's
# lib/labels.ts SUPPRESSION_LABEL says the same.
SUPPRESSION_LABELS = {
    "below_threshold": "Under 2K engagements, with no urgent reason",
    "ongoing_no_kof": "Ongoing issue with no KOF",
    "youtube_no_action": "YouTube post under 2K engagements: no action",
    "EXCLUDED_SPAM": "Spam",
    "EXCLUDED_BENCHMARK": "A benchmark comparison",
    "EXCLUDED_AI_COMPARISON": "A comparison of AI products",
    "EXCLUDED_GOOGLE_AS_VERB": "\"Google\" used as a verb",
    "EXCLUDED_DRIVE_LINK": "A Google Drive link",
    "im_review": "An IM suppressed it after review",
    "unspecified": "No reason recorded",
}

# The shapes triage writes its review reasons in (triage_agent/qa/pipeline.py): read here, said in words.
_WOULD_SUPPRESS = re.compile(r"^would be suppressed \((?P<code>[^)]*)\) but the deciding fields need review\.?$", re.I)
_PROPOSED = re.compile(r"^(?P<field>[a-z][a-z0-9_]*): proposed \"(?P<new>.*)\"(?: \((?P<pct>\d+)% likely right\))? [—-] (?P<why>.*)$", re.S)
_FIELD_SAYS = re.compile(r"^(?P<field>[a-z][a-z0-9_]*): (?P<says>.+)$", re.S)
_CODE = re.compile(r"^[a-z0-9_]+$")


def _dur(seconds: Any) -> str:
    try:
        s = float(seconds)
    except (TypeError, ValueError):
        return "?"
    if s < 90:
        return f"{round(s)} s"
    minutes = s / 60
    if minutes < 90:
        return f"{round(minutes)} min"
    hours = minutes / 60
    if hours < 36:
        return f"{hours:.1f} h"
    return f"{hours / 24:.1f} d"


def _short(value: Any, limit: int = 70) -> str:
    if value is None or value == "" or value == []:
        return "—"
    if isinstance(value, bool):
        text = "Yes" if value else "No"
    elif isinstance(value, (list, tuple)):
        text = ", ".join(str(v) for v in value) or "—"
    else:
        text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _n(value: Any) -> int:
    if isinstance(value, (list, tuple)):
        return len(value)
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# Plain words: codes and field keys as a person reads them
# ---------------------------------------------------------------------------


def words(code: Any) -> str:
    """'EXCLUDED_GOOGLE_AS_VERB' or 'unknown_exposure_tag' as words ('Google as verb', 'Unknown exposure tag')."""
    text = re.sub(r"^EXCLUDED_", "", str(code or "")).replace(".", " ").replace("_", " ").strip().lower()
    return text[:1].upper() + text[1:] if text else str(code or "")


def field_label(key: str) -> str:
    """An alert field's name as the alert template writes it ('exposure_tag' -> 'Exposure Tag')."""
    return FIELD_LABELS.get(key) or words(key)


def suppression_label(code: Any) -> str:
    """Why an alert was not posted, in words. A blank code reads 'No reason recorded'."""
    key = str(code or "").strip()
    if not key or key == "None":
        key = "unspecified"
    return SUPPRESSION_LABELS.get(key) or words(key)


def _sentence(text: str) -> str:
    text = text.strip()
    return text if not text or text[-1] in ".!?…" else f"{text}."


def plain_reason(reason: Any) -> str:
    """One reason an alert was held for review, as a sentence: field labels for field keys, words for codes.

    'alert_name: Add the Alert Name.' -> 'Alert Name: Add the Alert Name.'
    'would be suppressed (below_threshold) but the deciding fields need review' -> 'Normally it would not be posted (under 2K
    engagements, with no urgent reason), but the fields that decide that need a person to check them.'
    Anything already in words is kept as it is.
    """
    text = str(reason or "").strip()
    if not text:
        return ""
    m = _WOULD_SUPPRESS.match(text)
    if m:
        why = suppression_label(m["code"])
        return f"Normally it would not be posted ({why[:1].lower() + why[1:]}), but the fields that decide that need a person to check them."
    m = _PROPOSED.match(text)
    if m:
        likely = f" ({m['pct']}% likely right)" if m["pct"] else ""
        why = _sentence(m["why"]) if m["why"].strip() else ""
        why = why[:1].upper() + why[1:]
        return f"{field_label(m['field'])}: the agent suggests \u201c{m['new']}\u201d{likely}. {why}".strip()
    m = _FIELD_SAYS.match(text)
    if m and (m["field"] == "alert" or m["field"] in FIELD_LABELS or "_" in m["field"]):
        says = m["says"].strip()
        says = words(says) if _CODE.match(says) else says
        return _sentence(says if m["field"] == "alert" else f"{field_label(m['field'])}: {says}")
    return _sentence(text)


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------


def case_summary(case: Case) -> dict[str, Any]:
    """Flat row for tables (denormalized fields + latest attempt highlights)."""
    latest = case.latest
    result = latest.result if latest else None
    a = result.assessment if result else None
    f = (result.normalized if result else None) or {}
    corrections = result.corrections if result else []
    first = case.attempts[0] if case.attempts else None
    return {
        "case_id": case.case_id,
        "status": case.status.value,
        "source": case.source,
        "source_ref": case.source_ref,
        "record_key": case.record_key,
        "alert_name": case.alert_name or f.get("alert_name"),
        "product": case.product,
        "exposure_tag": case.exposure_tag,
        "priority": case.priority,
        "track": case.track,
        "platform": case.platform,
        "issue_name": case.issue_name,
        "issue_status": a.issue_status if a else None,
        "verdict": result.verdict.value if result else None,
        "review_probability": result.review_probability if result else None,  # Gemini Decisions; None = not asked
        "burson": {k: v for k, v in (result.burson or {}).items() if k != "fields"} if result and result.burson else None,
        "attempts": len(case.attempts),
        "corrections": sum(1 for c in corrections if c.applied and not c.reverted_by),
        "proposed": sum(1 for c in corrections if not c.applied),
        "reverted": sum(1 for c in corrections if c.reverted_by),
        "issues": len(result.issues) if result else 0,
        "blocking": len(result.blocking) if result else 0,
        "engagement_total": a.engagement_total if a and a.engagement_total is not None else f.get("total_engagement"),
        "engagement_level": (a.engagement_level if a else None) or f.get("engagement_level"),
        "sensitive_topics": a.sensitive_topics if a else [],
        "is_kof": a.is_kof if a else False,
        "alert_action": a.alert_action if a else None,
        "suppression_reason": a.suppression_reason if a else None,
        "suppression_label": suppression_label(a.suppression_reason) if a and a.suppression_reason else None,  # the reason in words
        "reason_codes": a.reason_codes if a else [],
        "review_reasons": result.review_reasons if result else [],
        "review_reasons_plain": [plain_reason(r) for r in (result.review_reasons if result else [])],  # the same, as sentences
        "post_url": f.get("post_url"),
        "author": f.get("author"),
        "received_at": first.received_at if first else case.created_at,
        "latest_received_at": latest.received_at if latest else case.created_at,
        "created_at": case.created_at,
        "updated_at": case.updated_at,
        "sla_due_at": case.sla_due_at,
        "sla_met": case.sla_met,
        "acknowledged_at": case.acknowledged_at,
        "clean_posted_at": case.clean_posted_at,
        "counterpart_case_id": case.counterpart_case_id,
        "superseded_by": case.superseded_by,
        "escalation_ids": case.escalation_ids,
        "current_oncall_email": case.current_oncall_email,
        "closed_reason": case.closed_reason,
        "review": case.review.model_dump(mode="json") if case.review else None,
        "actions": len(case.actions),
        "verdict_overridden_by": case.verdict_overridden_by,
    }


# ---------------------------------------------------------------------------
# Escalations
# ---------------------------------------------------------------------------


def escalation_json(esc: Escalation, case: Case | None = None) -> dict[str, Any]:
    data = esc.model_dump(mode="json")
    data["is_open"] = escalation_is_open(esc)
    data["alert_name"] = case.alert_name if case else None
    data["case_status"] = case.status.value if case else None
    data["track"] = case.track if case else None
    data["product"] = case.product if case else None
    return data


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


def describe_event(e: AgentEvent) -> str:  # noqa: C901 - one readable line per event type
    p = e.payload or {}
    t = e.event_type
    actor = e.actor if e.actor and e.actor != "agent" else "agent"
    if t == "alert.received":
        extra = f", detected {_dur(p['detect_latency_s'])} after posting" if p.get("detect_latency_s") is not None else ""
        return f"Alert received from {SOURCE_LABELS.get(p.get('source'), p.get('source') or 'Burson chat')} (attempt {e.attempt or 1}){extra}"
    if t == "triage.passed":
        rerun = " after a Burson rerun" if p.get("after_bounce") else ""
        return f"Passed QA as received{rerun} · {p.get('track') or 'no track'} · {p.get('priority') or '—'}"
    if t == "triage.corrected":
        fields = p.get("fields") or []
        rerun = " after a Burson rerun" if p.get("after_bounce") else ""
        return f"Auto-corrected {len(fields) or 'some'} field(s){rerun}: {_short(fields, 90)}"
    if t == "triage.suppressed":
        return f"Suppressed: {p.get('reason') or '—'}" + (f" ({_short(p.get('reason_codes'), 60)})" if p.get("reason_codes") else "")
    if t == "triage.failed":
        return f"Bounced to Burson on-call {p.get('oncall_email') or '—'}: {_short(e.error_codes, 90)}"
    if t == "triage.needs_review":
        reasons = p.get("reasons") or []
        return f"Held for IM review ({p.get('im_email') or 'IM on shift'}): {_short(reasons[0] if reasons else e.error_codes, 90)}"
    if t in ("correction.applied", "correction.proposed"):
        verb = "Corrected" if t == "correction.applied" else "Proposed"
        conf = f" · {float(p['probability']):.0%} likely right" if p.get("probability") is not None else ""  # Gemini Decisions' (newer events only)
        return f"{verb} {p.get('field')}: {_short(p.get('old'), 40)} → {_short(p.get('new'), 40)} ({p.get('source') or 'rule'}{conf})"
    if t == "correction.reverted":  # review.py: old = the corrected value, new = the restored original
        return f"{actor} reverted {p.get('field')}: {_short(p.get('old'), 40)} → {_short(p.get('new'), 40)}"
    if t.startswith("review."):
        verb = {"review.forwarded": "forwarded", "review.bounced": "bounced", "review.suppressed": "suppressed"}.get(t, t)
        reason = f": {_short(p.get('reason'), 80)}" if p.get("reason") else ""
        return f"{actor} {verb} the held alert via {p.get('via') or 'chat'}{reason}"
    if t == "clean.posted":
        return "Posted to the clean space"
    if t == "case.updated":
        changes = p.get("changes")
        return f"Case updated: {p.get('reason') or 'new attempt'}" + (f" ({_short(changes, 80)})" if changes else "")
    if t == "case.closed":
        by = f" by {actor}" if actor != "agent" else ""
        return f"Closed ({p.get('reason') or '—'}){by}" + (f" → superseded by {p['superseded_by']}" if p.get("superseded_by") else "")
    if t == "case.abandoned":
        return f"Abandoned: {p.get('reason') or 'no corrected rerun before the wait limit'}"
    if t == "oncall.notified":
        return f"Notified {p.get('to_email') or '—'} ({p.get('kind') or '—'}, {p.get('roster') or '—'} roster)"
    if t == "verdict.overridden":
        return f"{actor} marked the agent's verdict wrong (👎)" + (f": {_short(p.get('note'), 80)}" if p.get("note") else "")
    if t == "message.ignored":
        return f"Ignored a message ({p.get('reason') or '—'})"
    if t == "alert.acknowledged":
        return f"Acknowledged by {actor}" + (f" after {_dur(p['ack_latency_s'])}" if p.get("ack_latency_s") is not None else "")
    if t == "action.recorded":
        return f"{actor} reacted {p.get('emoji') or ''} ({p.get('code') or '—'})".replace("  ", " ")
    if t in ("sla.at_risk", "sla.met", "sla.missed"):
        word = {"sla.at_risk": "SLA at risk", "sla.met": "SLA met", "sla.missed": "SLA missed"}[t]
        mins = f" ({p['sla_minutes']} min)" if p.get("sla_minutes") else ""
        return f"{word} · {p.get('track') or '—'} · {p.get('platform_tier') or '—'} tier{mins}"
    if t == "protocol.pinged":
        return f"Protocol ping: {p.get('protocol') or '—'}" + (f" ({p['mode']})" if p.get("mode") else "")
    if t == "escalation.started":
        mailbox = f" in {p['analyst_email']}'s Gmail" if p.get("analyst_email") and p.get("analyst_email") != e.actor else ""
        return f"Escalation {e.escalation_id or ''} started ({p.get('trigger') or '—'}) by {actor}{mailbox}".replace("  ", " ")
    if t in ("email.drafted", "email.redrafted"):
        verb = "drafted" if t == "email.drafted" else "redrafted"
        reply = " as a thread reply" if p.get("thread_reply") else ""
        bcc = f" · {_n(p.get('bcc'))} bcc" if p.get("bcc") else ""
        return f"{(p.get('purpose') or 'alert').replace('_', ' ')} email {verb}{reply} (v{p.get('version') or 1}, {_n(p.get('to'))} to · {_n(p.get('cc'))} cc{bcc})"
    if t == "email.group_added":
        return f"Added {p.get('group') or '—'} to the draft (via {p.get('via') or 'reaction'})"
    if t == "email.revision_requested":
        return f"{actor} requested a revision: “{_short(p.get('instruction'), 80)}”"
    if t == "email.sent":
        flag = f", {_dur(p['flag_to_send_s'])} after the flag" if p.get("flag_to_send_s") is not None else ""
        return f"{(p.get('purpose') or 'alert').replace('_', ' ')} email sent{flag}"
    if t in ("email.discarded", "email.failed"):
        word = "discarded" if t == "email.discarded" else "failed"
        return f"{(p.get('purpose') or 'alert').replace('_', ' ')} email {word}: {_short(p.get('reason'), 80)}"
    if t == "tns.assessed":
        return f"T&S assessed: {'eligible' if p.get('eligible') else 'not eligible'}{', urgent' if p.get('urgent') else ''}" + (f" · {p['category']}" if p.get("category") else "")
    if t == "tns.prepared":
        return "T&S form pre-filled" + (" (urgent)" if p.get("urgent") else "")
    if t == "tns.not_eligible":
        return "Not eligible for T&S" + (f" · {p['category']}" if p.get("category") else "")
    if t == "tns.submitted":
        return f"T&S submitted via {p.get('via') or '—'}" + (f" · Issue {p['wd_issue_id']}" if p.get("wd_issue_id") else "")
    if t == "tns.withdrawn":
        return f"T&S report withdrawn by {actor}"
    if t == "tns.outcome":
        return f"T&S outcome: {p.get('outcome') or '—'}" + (f" · b/{p['bug_id']}" if p.get("bug_id") else "")
    if t == "watchdog.received":
        return f"Watchdog email: {_short(p.get('subject'), 90)}"
    if t == "watchdog.skipped":
        return f"Watchdog email skipped ({p.get('reason') or '—'})"
    if t == "parity.matched":
        diffs = p.get("diffs") or {}
        return f"Parity matched with {p.get('counterpart_case_id') or '—'} ({len(diffs)} field difference{'s' if len(diffs) != 1 else ''})"
    if t == "parity.unmatched":
        side = {"burson_only": "Burson only (in-house missed it)", "inhouse_only": "in-house only (Burson didn't alert)"}.get(p.get("side"), p.get("side"))
        return f"Parity unmatched: {side}"
    if t == "qa.answered":
        return f"Answered {actor} ({p.get('intent') or 'question'}{', grounded' if p.get('grounded') else ''})"
    if t == "qa.feedback":
        return f"{actor} rated an answer {'👍' if p.get('rating') == 'up' else '👎'}"
    if t in ("route.forwarded", "route.relayed"):
        verb = "Forwarded" if t == "route.forwarded" else "Relayed"
        return f"{verb} a question to {p.get('team') or p.get('stakeholder_id') or '—'} ({p.get('mode') or '—'})"
    if t == "oncall.override_set":
        return f"{actor} set an on-call override on {p.get('roster') or '—'} for {p.get('person_id') or '—'} (via {p.get('via') or '—'})"
    if t == "roster.updated":
        return f"{actor} updated the {p.get('roster') or '—'} roster (via {p.get('via') or '—'})"
    if t == "burson.digest_posted":
        return f"Burson correction digest posted ({p.get('corrections', 0)} corrections)"
    if t == "handover.posted":
        return f"Shift handover posted ({p.get('shift') or '—'})"
    if t == "outbox.delivered":
        return f"Delivered {p.get('count', 0)} queued item(s): {_short(p.get('targets'), 60)}"
    if t == "config.updated":
        return f"{actor} updated config section {p.get('section') or '—'}"
    if t.startswith("config.change_"):
        verb = t.removeprefix("config.change_")
        return f"Config change {verb}: {_short(p.get('summary') or p.get('id'), 80)}"
    if t.startswith("knowledge.fact_"):
        verb = t.removeprefix("knowledge.fact_")
        return f"Fact {verb}: {_short(p.get('text') or p.get('id'), 80)}"
    if t == "error":
        return f"Error in {p.get('op') or '—'}: {_short(p.get('error'), 90)}" + (" (retryable)" if p.get("retryable") else "")
    return t


def event_json(e: AgentEvent) -> dict[str, Any]:
    data = e.model_dump(mode="json")
    data.get("payload", {}).pop("trace", None)  # stack traces stay in the event log, not the UI
    data["summary"] = describe_event(e)
    return data
