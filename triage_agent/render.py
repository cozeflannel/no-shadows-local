"""Chat message rendering (plain text + Google Chat markdown).

Shared helpers for every workstream: prefix(), fmt_time(), fmt_num(),
alert_summary_lines(). Triage renderers: clean_post(), needs_burson(),
review_dm(), protocol pings. Every message starts with the agent prefix and
carries the case / escalation id so reactions and replies can be tied back.
"""

from datetime import datetime
from typing import TYPE_CHECKING, Any, Iterable
from zoneinfo import ZoneInfo

from .models import Case, Correction, Severity, TriageResult

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

MAX_CHARS = 3500

FIELD_LABELS = {
    "alert_name": "Alert Name", "issue_name": "Issue Name", "issue_status": "Issue Status",
    "engagement_level": "Engagement Level", "total_engagement": "Total Engagement",
    "product": "Product", "other_products": "Other Products", "social_network": "Social Network",
    "exposure_tag": "Exposure Tag", "priority": "Priority", "risk_tags": "Risk Tags", "kof": "KOF",
    "ts": "T&S", "author": "Author", "followers": "Followers", "post_date": "Post Date",
    "post_url": "View Post", "post_content": "Post Content", "summary": "Summary", "location": "Location",
    "video_timestamp": "Video Timestamp",
}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def prefix(ctx: "AgentContext") -> str:
    return ctx.config.agent.message_prefix


def truncate(text: str | None, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + "…"


def fmt_time(ctx: "AgentContext", dt: datetime | None) -> str:
    """'10:20 AM ET' in the display timezone (date added when not today)."""
    if dt is None:
        return "—"
    zone = ZoneInfo(ctx.config.timezone)
    local = dt.astimezone(zone)
    now_local = ctx.now().astimezone(zone)
    abbr = {"America/New_York": "ET", "America/Los_Angeles": "PT", "America/Chicago": "CT"}.get(
        ctx.config.timezone, local.strftime("%Z")
    )
    clock = local.strftime("%I:%M %p").lstrip("0")
    if local.date() != now_local.date():
        return f"{local.strftime('%b')} {local.day}, {clock} {abbr}"
    return f"{clock} {abbr}"


def fmt_num(n: Any) -> str:
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return str(n) if n is not None else "—"


def fmt_compact(n: Any) -> str:
    """152300 -> '152K', 1_250_000 -> '1.3M'."""
    try:
        v = int(n)
    except (TypeError, ValueError):
        return "—"
    if v >= 1_000_000:
        return f"{v / 1_000_000:.1f}M".replace(".0M", "M")
    if v >= 10_000:
        return f"{round(v / 1000)}K"
    if v >= 1000:
        return f"{v / 1000:.1f}K".replace(".0K", "K")
    return str(v)


def fmt_value(value: Any) -> str:
    if value is None or value == "" or value == []:
        return "—"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (list, tuple)):
        return ", ".join(fmt_value(v) for v in value)
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def label(field: str) -> str:
    return FIELD_LABELS.get(field, field.replace("_", " ").title())


def _sla_text(ctx: "AgentContext", minutes: int | None, due: datetime | None) -> str:
    if minutes is None:
        return "no SLA"
    span = f"{minutes} min" if minutes < 120 else f"{minutes // 60} h"
    return f"SLA {span} (due {fmt_time(ctx, due)})" if due else f"SLA {span}"


def _level_emoji(ctx: "AgentContext", level: str | None) -> str:
    if not level:
        return ""
    if level.upper() == ctx.config.collection.viral_kof_label.upper():
        return "⭐"
    for lv in ctx.config.collection.engagement_levels:
        if lv.name.upper() == level.upper():
            return lv.emoji
    return ""


def alert_summary_lines(ctx: "AgentContext", case: Case, result: TriageResult | None = None) -> list[str]:
    """Title, engagement/platform/SLA, tag/risk, product/author/market, summary, link."""
    result = result or (case.latest.result if case.latest else None)
    f = (result.normalized if result else {}) or {}
    a = result.assessment if result else None
    title = f.get("alert_name") or case.alert_name or "Alert"
    lines = [f"*{truncate(title, 200)}* · {case.case_id}"]

    level = (a.engagement_level if a else None) or f.get("engagement_level")
    total = (a.engagement_total if a else None) if a and a.engagement_total is not None else f.get("total_engagement")
    platform = (a.platform if a else None) or f.get("social_network")
    sla = _sla_text(ctx, a.sla_minutes if a else None, a.sla_due_at if a else case.sla_due_at) if a else ""
    parts = [p for p in (
        f"{_level_emoji(ctx, level)} {level}".strip() if level else "",
        f"{fmt_num(total)} engagements" if total is not None else "",
        platform or "",
        sla,
    ) if p]
    if parts:
        lines.append(" · ".join(parts))

    tag = (a.exposure_tag if a else None) or f.get("exposure_tag")
    prio = (a.priority if a else None) or f.get("priority")
    topics = (a.sensitive_topics if a and a.sensitive_topics else None) or f.get("risk_tags") or []
    tag_line = f"*Exposure Tag:* {tag}" + (f" ({prio})" if prio else "") if tag else ""
    risk_line = f"*Risk:* {fmt_value(topics)}" if topics else ""
    if tag_line or risk_line:
        lines.append(" · ".join(p for p in (tag_line, risk_line) if p))

    product = (a.product if a else None) or f.get("product")
    others = (a.secondary_products if a and a.secondary_products else None) or f.get("other_products") or []
    author = f.get("author")
    followers = f.get("followers")
    markets = (a.non_us_markets if a and a.non_us_markets else None) or ([f["location"]] if f.get("location") else [])
    who = []
    if product:
        who.append(f"*Product:* {product}" + (f" (+ {fmt_value(others)})" if others else ""))
    if author:
        who.append(f"*Author:* {author}" + (f" ({fmt_compact(followers)} followers)" if followers else ""))
    if markets:
        who.append(f"*Market:* {fmt_value(markets)}")
    if who:
        lines.append(" · ".join(who))
    if f.get("summary"):
        lines.append(f"*Summary:* {truncate(f['summary'], 500)}")
    if a and a.video_timestamp:
        lines.append(f"*Timestamp:* {a.video_timestamp}")
    if f.get("post_url"):
        lines.append(f"*View Post:* {f['post_url']}")
    return lines


def correction_text(c: Correction) -> str:
    reason = f" ({truncate(c.reason, 80)})" if c.reason else ""
    return f"{label(c.field)} \"{truncate(fmt_value(c.old), 60)}\" → \"{truncate(fmt_value(c.new), 60)}\"{reason}"


def finalize(text: str) -> str:
    return truncate(text, MAX_CHARS)


# ---------------------------------------------------------------------------
# Triage renderers
# ---------------------------------------------------------------------------


def clean_post(
    ctx: "AgentContext",
    case: Case,
    result: TriageResult,
    *,
    draft_note: str | None = None,
    auto_notes: Iterable[str] = (),
    header: str | None = None,
) -> str:
    """Verified alert for the clean space (one case per message)."""
    a = result.assessment
    lines = alert_summary_lines(ctx, case, result)
    lines[0] = f"{prefix(ctx)} {header + ' ' if header else ''}{lines[0]}"
    applied = result.applied_corrections
    if applied:
        lines.append("✏️ Corrected: " + " · ".join(correction_text(c) for c in applied[:4])
                     + (f" · +{len(applied) - 4} more" if len(applied) > 4 else ""))
    warnings = [i for i in result.issues if i.severity == Severity.WARNING]
    if warnings:
        lines.append("⚠️ Check: " + " · ".join(truncate(i.fix or i.rule, 100) for i in warnings[:3]))
    if a:
        suggested = [ctx.config.action(code) for code in a.suggested_actions]
        sugg = " · ".join(f"{s.emoji} {short_label(s.label)}" for s in suggested if s)
        auto = list(auto_notes)
        tail = (" · Auto: " + ", ".join(auto)) if auto else ""
        if sugg or tail:
            lines.append(f"👉 Suggested: {sugg or '—'}{tail}")
        if a.recipients and a.recipients.missing:
            lines.append(f"ℹ️ No recipients configured yet for: {', '.join(a.recipients.missing)}")
        if a.ts_recommended and a.ts_reasons:
            lines.append(f"✍️ T&S recommended: {', '.join(a.ts_reasons)}")
    if draft_note:
        lines.append(draft_note)
    return finalize("\n".join(lines))


def short_label(text: str) -> str:
    """'Reported to Product Areas (PAs)' -> 'PAs'; 'Reported to Trust & Safety (T&S)' -> 'T&S'."""
    if "(" in text and text.endswith(")"):
        return text[text.rfind("(") + 1 : -1]
    return text.replace("Reported to ", "")


def needs_burson(ctx: "AgentContext", case: Case, result: TriageResult, oncall_email: str | None,
                 oncall_name: str | None = None) -> str:
    who = f"{oncall_email} ({oncall_name or 'Burson on-call'})" if oncall_email else "Burson on-call"
    lines = [f"{prefix(ctx)} *Needs Burson* · {case.case_id}"]
    title = result.normalized.get("alert_name")
    if title:
        lines.append(f"_{truncate(title, 160)}_")
    lines.append(f"{who}, this alert can't be verified:")
    for n, issue in enumerate(result.blocking[:8], start=1):
        problem = "missing" if issue.rule == "required" else issue.rule.split(":")[-1].replace("_", " ")
        found = f" (found: {truncate(issue.found, 80)})" if issue.found else ""
        fix = f" → {issue.fix}" if issue.fix else ""
        lines.append(f"{n}. {label(issue.field) if issue.field else 'Alert'}: {problem}{found}{fix}")
    lines.append("Everything else is handled by the agent. Re-run the Zap with the fix; the rerun is matched automatically.")
    return finalize("\n".join(lines))


def review_dm(ctx: "AgentContext", case: Case, result: TriageResult) -> str:
    cid = case.case_id
    lines = [f"{prefix(ctx)} *Review needed* · {cid}"]
    lines += alert_summary_lines(ctx, case, result)[:3]
    if result.review_reasons:
        lines.append("Why: " + "; ".join(truncate(r, 160) for r in result.review_reasons[:4]))
    proposed = result.proposed_corrections
    if proposed:
        lines.append("Proposed: " + " · ".join(f"{correction_text(c)} [{c.confidence:.2f}]" for c in proposed[:4]))
    example = f" {proposed[0].field}={fmt_value(proposed[0].new)}" if proposed else ""
    lines.append(
        f"Reply: `forward {cid}` · `forward {cid}{example}` · `bounce {cid}: reason` · `suppress {cid}: reason` "
        "(or decide in the Agent Console)"
    )
    return finalize("\n".join(lines))


def update_post(ctx: "AgentContext", case: Case, result: TriageResult, changes: list[str], *, draft_note: str | None = None) -> str:
    """Re-post for a new attempt on a verified case (engagement update, Burson re-post)."""
    header = "🔁 *Update*" + (f" ({'; '.join(changes[:3])})" if changes else "")
    return clean_post(ctx, case, result, header=header, draft_note=draft_note)


def youtube_ping(ctx: "AgentContext", case: Case, result: TriageResult) -> str:
    a = result.assessment
    f = result.normalized
    mode = a.youtube_protocol if a else "none"
    note = {
        "chat_only": "Sharing for visibility (YouTube is the subject; no email sent from Brand Social).",
        "sensitive_ping": "Sharing for visibility: sensitive YouTube-subject post below 2K. It isn't being escalated on Google's end.",
        "email_and_ping": "Sharing for visibility: Google is the subject and an alert email is going out.",
    }.get(mode, "Sharing for visibility.")
    lines = [f"{prefix(ctx)} {note} · {case.case_id}", f"*{truncate(f.get('alert_name'), 200)}*"]
    if f.get("post_url"):
        lines.append(f"*View Post:* {f['post_url']}")
    return finalize("\n".join(lines))


def doodle_ping(ctx: "AgentContext", case: Case, result: TriageResult) -> str:
    f = result.normalized
    lines = [f"{prefix(ctx)} {ctx.config.protocols.doodle.message} · {case.case_id}",
             f"*{truncate(f.get('alert_name'), 200)}*"]
    if f.get("summary"):
        lines.append(truncate(f["summary"], 400))
    if f.get("post_url"):
        lines.append(f"*View Post:* {f['post_url']}")
    return finalize("\n".join(lines))


def leadership_dm(ctx: "AgentContext", case: Case, result: TriageResult) -> str:
    a = result.assessment
    why = []
    if a and a.priority == "P0":
        why.append("P0")
    if a and a.sensitive_topics:
        why.append("Sensitive: " + ", ".join(a.sensitive_topics))
    lines = [f"{prefix(ctx)} *Escalation protocol* (P0 + Sensitive Topics + Product Failure) · {case.case_id}"]
    lines += alert_summary_lines(ctx, case, result)
    if why:
        lines.append("Why: NEW issue · " + " · ".join(why))
    if ctx.config.protocols.leadership.doc_url:
        lines.append(f"Protocol: {ctx.config.protocols.leadership.doc_url}")
    return finalize("\n".join(lines))
