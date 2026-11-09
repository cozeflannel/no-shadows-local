"""Case lifecycle: one case per post per source; reruns and updates are attempts.

Also: the alert history used for the 14-day novelty rule, and parity links
between a Burson-sourced case and an in-house case for the same post.

A rerun normally matches its case by record key (the post link). An alert bounced for a
missing or malformed link gets a new record key when Burson reruns it with the link, so
open FAILED cases are also matched by alert/issue name (find_bounced_rerun).
"""

import re
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from .models import Case, CaseStatus, TriageResult

if TYPE_CHECKING:  # pragma: no cover
    from .context import AgentContext

CASE_REUSE_DAYS = 30  # a new alert for the same post within this window is an attempt on the same case
RERUN_MATCH_HOURS = 48  # a bounced (FAILED) case can be matched by name this long after its last bounce
HISTORY_START_KEY = "history_start"
PARITY_FIELDS = ("track", "priority", "exposure_tag", "product", "issue_status", "is_kof", "engagement_level",
                 "sensitive_topics", "alertable", "alert_action")


def name_key(value: str | None) -> str | None:
    """An alert/issue name without its [URGENT] [NEW] … prefixes, case or punctuation (rerun matching)."""
    if not value:
        return None
    text = re.sub(r"^\s*(\[[^\]]*\]\s*)+", "", str(value))
    text = re.sub(r"[\W_]+", " ", text.lower()).strip()
    return text or None


def find_bounced_rerun(ctx: "AgentContext", fields: dict[str, Any], source: str,
                       record_key: str | None = None) -> Case | None:
    """The open FAILED case this alert reruns, matched by alert or issue name (most recent first).

    Only for cases whose record key differs from this alert's (otherwise the record-key lookup
    already matched), i.e. bounces for a missing or malformed post link.
    """
    wanted = {k for k in (name_key(fields.get("issue_name")), name_key(fields.get("alert_name"))) if k}
    if not wanted:
        return None
    cutoff = ctx.now() - timedelta(hours=RERUN_MATCH_HOURS)
    for case in ctx.store.list_cases(statuses=[CaseStatus.FAILED], limit=100):
        bounced_at = max((n.at for n in case.oncall_notices if n.kind == "bounce"), default=case.created_at)
        if case.source != source or bounced_at < cutoff or (record_key and case.record_key == record_key):
            continue
        names = {name_key(case.issue_name), name_key(case.alert_name)}
        latest = case.latest.result.normalized if case.latest and case.latest.result else {}
        names |= {name_key(latest.get("issue_name")), name_key(latest.get("alert_name"))}
        if wanted & (names - {None}):
            return case
    return None


def find_or_start(ctx: "AgentContext", record_key: str | None, source: str,
                  source_ref: str | None = None, fields: dict[str, Any] | None = None) -> tuple[Case, int, CaseStatus | None]:
    """(case, attempt number, previous status or None for a new case)."""
    store, now = ctx.store, ctx.now()
    existing = None
    if source_ref:
        existing = store.find_case_by_source_ref(source, source_ref)
    if existing is None and record_key:
        existing = store.find_case_by_record_key(record_key, source=source)
    if existing is None and fields:
        existing = find_bounced_rerun(ctx, fields, source, record_key)
    if existing and now - existing.created_at <= timedelta(days=CASE_REUSE_DAYS):
        return existing, len(existing.attempts) + 1, existing.status
    if store.get_kv(HISTORY_START_KEY) is None:
        store.put_kv(HISTORY_START_KEY, {"at": now.isoformat()})
    case = Case(
        case_id=store.next_id(ctx.config.case_id_prefix),
        record_key=record_key,
        source=source,  # type: ignore[arg-type]
        source_ref=source_ref,
        status=CaseStatus.NEEDS_REVIEW,  # set by the caller after QA
        created_at=now,
        updated_at=now,
        env=ctx.config.env,
    )
    return case, 1, None


def apply_result(case: Case, result: TriageResult) -> None:
    """Denormalize the latest result onto the case (Console filters, novelty lookups)."""
    f, a = result.normalized, result.assessment
    case.record_key = case.record_key or result.record_key
    case.alert_name = f.get("alert_name") or case.alert_name
    if a:
        case.product = a.product or f.get("product")
        case.exposure_tag = a.exposure_tag or f.get("exposure_tag")
        case.priority = a.priority
        case.track = a.track or case.track
        case.platform = a.platform
        case.issue_name = a.issue_name
        case.issue_fingerprint = a.issue_fingerprint
    else:
        case.product = f.get("product") or case.product
        case.exposure_tag = f.get("exposure_tag") or case.exposure_tag


def history_complete(ctx: "AgentContext", received_at: datetime) -> bool:
    """True once the agent has seen a full novelty window of alerts (else "no match" can't prove NEW)."""
    doc = ctx.store.get_kv(HISTORY_START_KEY)
    if not doc:
        return False
    start = datetime.fromisoformat(doc["at"])
    return start <= received_at - timedelta(days=ctx.config.collection.novelty_days)


def novelty_history(ctx: "AgentContext", exposure_tag: str | None, received_at: datetime,
                    exclude_record_key: str | None = None, exclude_case_id: str | None = None) -> list[Case]:
    """Cases alerted (posted to the clean space) recently with this exposure tag."""
    if not exposure_tag:
        return []
    days = max(ctx.config.collection.novelty_days, ctx.config.protocols.leadership.dedupe_days) + 1
    since = received_at - timedelta(days=days)
    out = []
    for c in ctx.store.list_cases(since=since, limit=2000, exposure_tag=exposure_tag):
        if not c.clean_posted_at or c.case_id == exclude_case_id:
            continue
        if exclude_record_key and c.record_key == exclude_record_key:
            continue
        out.append(c)
    return out


def counterpart_source(source: str) -> str | None:
    return {"burson_chat": "inhouse", "inhouse": "burson_chat"}.get(source)


def link_counterpart(ctx: "AgentContext", case: Case) -> Case | None:
    """Pair a Burson case with the in-house case for the same post (parity). Saves the other case."""
    other_source = counterpart_source(case.source)
    if not other_source or not case.record_key or not ctx.config.inhouse.enabled:
        return None
    other = ctx.store.find_case_by_record_key(case.record_key, source=other_source)
    if other is None:
        return None
    if case.counterpart_case_id != other.case_id:
        case.counterpart_case_id = other.case_id
    if other.counterpart_case_id != case.case_id:
        other.counterpart_case_id = case.case_id
        ctx.store.save_case(other)
    return other


def parity_diffs(a: Case, b: Case) -> dict[str, list[Any]]:
    """Field disagreements between two cases' latest assessments ({field: [a, b]}).

    For parity events, call with (burson case, in-house case) so diffs read [burson, inhouse].
    """
    ra, rb = (a.latest.result.assessment if a.latest else None), (b.latest.result.assessment if b.latest else None)
    if not ra or not rb:
        return {}
    diffs = {}
    for name in PARITY_FIELDS:
        va, vb = getattr(ra, name), getattr(rb, name)
        if isinstance(va, list):
            va, vb = sorted(va), sorted(vb or [])
        if va != vb:
            diffs[name] = [va, vb]
    return diffs
