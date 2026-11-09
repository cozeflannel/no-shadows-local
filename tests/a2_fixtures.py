"""Shared builders for workstream A2 tests (escalation, T&S, actions, emails, converse).

Cases are built directly from models (no QA pipeline). Import with `from a2_fixtures import ...`.
"""

from datetime import datetime, timedelta
from typing import Any

from triage_agent.escalation.gmail import FakeGmail
from triage_agent.models import (
    AlertAssessment, Attempt, Case, CaseStatus, ChatMessage, ChatUser, RecipientPlan, TriageResult, Verdict,
)

IM = "im1@ops.test"  # IM on shift at conftest.FIXED_NOW (Mon 2pm ET)
IM2 = "im2@ops.test"
CLEAN_SPACE = {"space_id": None, "space_name": "SLRR Triaged Alerts"}


def make_case(
    ctx, *, n: int | None = None, track: str | None = "URGENT", issue_status: str = "NEW",
    related_case_id: str | None = None, product: str = "Gemini App", exposure_tag: str = "Product - Dangerous results (e.g. medical/legal)",
    priority: str = "P0", sensitive_topics: list[str] | None = None, engagement_total: int = 3140, is_kof: bool = False,
    platform: str = "X", platform_tier: str | None = "strong", sla_minutes: int | None = 15, alert_action: str | None = "EMAIL_ALERT",
    ts_recommended: bool = False, ts_reasons: list[str] | None = None, issue_fingerprint: str | None = None,
    record_key: str | None = None, verdict: Verdict = Verdict.PASS, status: CaseStatus = CaseStatus.VERIFIED,
    fields: dict[str, Any] | None = None, created_at: datetime | None = None, save: bool = True, **assessment: Any,
) -> Case:
    now = created_at or ctx.now()
    case_id = ctx.store.next_id(ctx.config.case_id_prefix)
    n = n if n is not None else int(case_id.split("-")[1])
    post_url = f"https://x.com/techwatcher/status/18451234567{n:05d}"
    name = f"[{(track or 'HIGH_ENGAGEMENT').replace('_', ' ')}] [{issue_status}] {product} – Gemini gives unsafe dosage advice {n}"
    normalized: dict[str, Any] = {
        "alert_name": name, "issue_name": f"Gemini gives unsafe dosage advice {n}",
        "issue_status": "NEW" if issue_status == "NEW" else "Ongoing Issue", "engagement_level": "HIGH",
        "total_engagement": engagement_total, "product": product, "social_network": platform,
        "exposure_tag": exposure_tag, "priority": priority, "risk_tags": list(sensitive_topics or []),
        "kof": is_kof, "author": "@techwatcher", "followers": 152300, "location": "US", "post_url": post_url,
        "summary": "User says Gemini recommended a dangerous medication dose.",
        "post_content": "Asked Gemini about ibuprofen and it told me to take 4000mg at once. Screenshot attached.",
    }
    normalized.update(fields or {})
    a = AlertAssessment(
        track=track, alert_action=alert_action, issue_status=issue_status, issue_name=normalized["issue_name"],
        issue_fingerprint=issue_fingerprint or f"fp-{n}", related_case_id=related_case_id, priority=priority,
        exposure_tag=exposure_tag, product=product, sensitive_topics=list(sensitive_topics or []), is_kof=is_kof,
        engagement_total=engagement_total, engagement_level="VIRAL KOF" if is_kof else "HIGH", platform=platform,
        platform_tier=platform_tier, sla_minutes=sla_minutes,
        sla_due_at=now + timedelta(minutes=sla_minutes) if sla_minutes else None,
        ts_recommended=ts_recommended, ts_reasons=list(ts_reasons or []), **assessment,
    )
    result = TriageResult(verdict=verdict, assessment=a, normalized=normalized,
                          record_key=record_key or f"x.com/status/18451234567{n:05d}")  # = normalize_url(post_url)
    msg = ChatMessage(message_id=f"burson-msg-{n}", text=f"Alert Name: {name}", sender=ChatUser(name="Zapier", type="BOT"))
    case = Case(
        case_id=case_id, record_key=result.record_key, status=status, alert_name=name, product=product,
        exposure_tag=exposure_tag, priority=priority, track=track, platform=platform, issue_name=normalized["issue_name"],
        issue_fingerprint=a.issue_fingerprint, attempts=[Attempt(attempt=1, message=msg, received_at=now, result=result)],
        clean_posted_at=now, sla_due_at=a.sla_due_at, created_at=now, updated_at=now, env=ctx.config.env,
    )
    if save:
        ctx.store.save_case(case)
    return case


def connect(ctx, clock, *users: str) -> FakeGmail:
    gmail = FakeGmail(connected=users, clock=clock)
    ctx.gmail = gmail
    return gmail


def events(ctx, event_type: str) -> list:
    """Events of one type, oldest first."""
    return list(reversed(ctx.events.query(types=[event_type])))


def reaction(emoji: str, case: Case | None = None, *, user: str = IM, message_id: str | None = None,
             text: str | None = None) -> dict:
    """record_reaction payload for a reaction on the case's clean post."""
    body = text if text is not None else (f"🤖 *{case.alert_name}* · {case.case_id}" if case else "")
    return {
        "emoji": emoji, "user": {"email": user, "name": user.split("@")[0]},
        "message": {"message_id": message_id or (f"clean-{case.case_id}" if case else "clean-x"), "text": body,
                    **CLEAN_SPACE},
    }


def plan_groups(plan: RecipientPlan | None) -> list[str]:
    return list(plan.groups) if plan else []
