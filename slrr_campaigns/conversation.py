"""Interactive text-only conversation engine for deep dives, query builder, and campaigns."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from triage_agent.llm import LLMError

from .bigquery_mentions import BigQueryMentionsClient, BigQueryMentionsError
from .brandwatch import BrandwatchApiError, BrandwatchClient
from .config import CampaignsConfig
from .deep_dive import run_deep_dive
from .email_parser import extract_alert_context_from_chat
from .gemini_flows import GeminiFlows, StepReplyParseSchema
from .logging_utils import log_event, strip_emojis
from .models import (
    CachedQuerySummary,
    CampaignRecord,
    ConversationState,
    CustomAlertFilterPayload,
    LocationFilterPayload,
    QueryBuilderDraft,
    RegistrySettings,
    SentimentValue,
    ThreadEntryTypeValue,
    ThreadOwnershipRecord,
)
from .provisioning import ProvisioningFailureError, provision_campaign
from .registry import (
    VALID_POST_TYPES,
    VALID_SENTIMENTS,
    apply_campaign_mutation,
    format_et,
    resolve_approver_users,
)
from .store import CampaignStore, StoreError
from .workspace import WorkspaceApiError, WorkspaceClients

logger = logging.getLogger(__name__)
NY_TZ = ZoneInfo("America/New_York")
EXPIRY_HOURS = 24


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_ny_str() -> str:
    return _now_utc().astimezone(NY_TZ).strftime("%Y-%m-%d %H:%M %Z")


def _today_ny_date() -> str:
    return _now_utc().astimezone(NY_TZ).strftime("%Y-%m-%d")


def extract_direct_chat_command(text: str) -> dict[str, str] | None:
    """Detect explicit lifecycle commands in a thread or campaign space."""
    cleaned = text.strip()
    lower = cleaned.lower()
    if lower in ("pause", "pause campaign"):
        return {"action": "Pause"}
    if lower in ("resume", "resume campaign"):
        return {"action": "Resume"}
    if lower in ("shut down", "shut down now", "shutdown", "close campaign"):
        return {"action": "Shut down now"}
    m_ext = re.match(r"^extend(?:\s+by)?\s+(\d+)\s*d(?:ays?)?\b", lower)
    if m_ext:
        return {"extend_days": m_ext.group(1)}
    m_thr = re.match(r"^(?:set\s+)?threshold(?:\s+to)?\s+(\d+)\b", lower)
    if m_thr:
        return {"threshold": m_thr.group(1)}
    return None


def _command_from_parsed_reply(parsed: StepReplyParseSchema) -> dict[str, str] | None:
    if parsed.outcome != "command" or parsed.command_name == "none":
        return None
    if parsed.command_name == "pause":
        return {"action": "Pause"}
    if parsed.command_name == "resume":
        return {"action": "Resume"}
    if parsed.command_name == "shut_down":
        return {"action": "Shut down now"}
    if parsed.command_name == "extend" and parsed.command_arg > 0:
        return {"extend_days": str(parsed.command_arg)}
    if parsed.command_name == "threshold" and parsed.command_arg >= 0:
        return {"threshold": str(parsed.command_arg)}
    return None


def _find_campaign_for_thread(store: CampaignStore, thread_name: str) -> CampaignRecord | None:
    matches = [
        c
        for c in store.list_campaigns()
        if c.source_thread == thread_name and c.status in ("active", "paused")
    ]
    return matches[-1] if matches else None


def _search_top_5_queries(
    *,
    bw: BrandwatchClient,
    gemini: GeminiFlows,
    topic: str,
    alert_text: str,
) -> list[CachedQuerySummary]:
    """Search cached queries: exact name -> case-insensitive contains -> Gemini semantic top 5."""
    all_queries = bw.get_cached_queries()
    if not all_queries:
        return []
    needle = topic.strip().lower()
    ordered: list[CachedQuerySummary] = []
    seen: set[int] = set()

    if needle:
        for q in all_queries:
            if q.name.strip().lower() == needle and q.query_id not in seen:
                ordered.append(q)
                seen.add(q.query_id)
        for q in all_queries:
            if needle in q.name.lower() and q.query_id not in seen:
                ordered.append(q)
                seen.add(q.query_id)
                if len(ordered) >= 5:
                    return ordered[:5]

    if len(ordered) < 5:
        remaining = [q for q in all_queries if q.query_id not in seen]
        ranked = gemini.rank_queries(
            topic=topic or "Google social alert",
            alert_text=alert_text,
            candidates=remaining,
        )
        for q in ranked:
            if q.query_id not in seen:
                ordered.append(q)
                seen.add(q.query_id)
                if len(ordered) >= 5:
                    break
    return ordered[:5]


def _find_covering_cached_query(
    cached: list[CachedQuerySummary],
    builder: QueryBuilderDraft,
) -> CachedQuerySummary | None:
    """Check whether an existing cached query already covers the requested core terms and platforms."""
    terms = [t.strip().lower() for t in builder.core_terms if len(t.strip()) >= 3]
    if not terms:
        return None
    req_sources = {s.strip().lower() for s in builder.content_sources if s.strip()}
    for q in cached:
        if q.name.startswith("SLRR-CMP-"):
            continue
        haystack = f"{q.name} {q.boolean_query}".lower()
        if not all(term in haystack for term in terms):
            continue
        q_sources = {s.strip().lower() for s in q.content_sources if s.strip()}
        if req_sources and q_sources and not req_sources.issubset(q_sources):
            continue
        return q
    return None


def format_validation_issues(validation_resp: dict[str, Any]) -> tuple[list[str], str]:
    """Extract human-readable validation errors/issues with row/column positions and queryLimitUsage."""
    messages: list[str] = []
    for err in validation_resp.get("errors") or []:
        if isinstance(err, dict):
            row = err.get("row")
            col = err.get("column")
            msg = str(err.get("message") or err.get("code") or err)
            pos = f" (row {row}, col {col})" if row is not None or col is not None else ""
            messages.append(f"Error{pos}: {msg}")
        else:
            messages.append(f"Error: {err}")

    for issue in validation_resp.get("issues") or []:
        if isinstance(issue, dict):
            severity = str(issue.get("severity") or issue.get("type") or "issue").upper()
            row = issue.get("row")
            col = issue.get("column")
            msg = str(issue.get("message") or issue.get("code") or issue)
            pos = f" (row {row}, col {col})" if row is not None or col is not None else ""
            if severity in ("ERROR", "FATAL") or "error" in severity.lower():
                messages.append(f"{severity}{pos}: {msg}")
    usage = str(validation_resp.get("queryLimitUsage") or "1")
    return messages, usage


def _step_prompt(state: ConversationState, settings: RegistrySettings) -> str:
    """Render plain-text numbered prompt for state.step."""
    step = state.step
    b = state.builder
    s = state.settings

    if step == "choose_mapped_query":
        q = state.candidate_queries[0]
        srcs = ", ".join(q.content_sources) if q.content_sources else "all configured sources"
        langs = ", ".join(q.languages) if q.languages else "all languages"
        return (
            f"This alert maps to Brandwatch query *{strip_emojis(q.name)}* "
            f"(ID {q.query_id}, project {strip_emojis(q.project_name)}).\n"
            f"Platforms: {srcs} | Languages: {langs}\n\n"
            "Choose a query option (reply with a number or plain text, or 'cancel'):\n"
            f"1. Use *{strip_emojis(q.name)}* (ID {q.query_id})\n"
            "2. Search other existing Brandwatch queries\n"
            "3. None of these (build a new Brandwatch query)"
        )

    if step == "choose_search_query":
        lines = ["Top matching Brandwatch queries across accessible projects:"]
        for idx, q in enumerate(state.candidate_queries, start=1):
            srcs = ", ".join(q.content_sources[:5]) if q.content_sources else "all sources"
            lines.append(
                f"{idx}. [{strip_emojis(q.project_name)}] *{strip_emojis(q.name)}* "
                f"(ID {q.query_id}) — platforms: {srcs}",
            )
        none_num = len(state.candidate_queries) + 1
        lines.append(f"{none_num}. None of these (build a new Brandwatch query)")
        lines.append("Reply with the option number (or 'cancel').")
        return "\n".join(lines)

    if step == "qb_core_terms":
        terms_preview = ", ".join(b.core_terms) if b.core_terms else "Google"
        return (
            f"*Query Builder (1/7) — Core Terms*\n"
            f"Short query name: {strip_emojis(b.short_name or 'Focused Topic')}\n"
            "Prefilled core terms (names, products, handles, hashtags, domains, variants): "
            f"{strip_emojis(terms_preview)}\n"
            "1. Keep prefilled core terms\n"
            "2. Reply with your comma-separated core terms to replace them"
        )

    if step == "qb_context_proximity":
        prox = b.context_proximity or "No proximity constraint"
        return (
            f"*Query Builder (2/7) — Context Terms & Proximity*\n"
            f"Prefilled rule: {strip_emojis(prox)}\n"
            "Specify which context words must appear near core terms, within how many words, "
            "and whether order matters (or paste sample relevant posts and ask to measure distance).\n"
            "1. Keep prefilled context/proximity rule\n"
            "2. No proximity constraint needed\n"
            "3. Reply with custom context terms and word distance"
        )

    if step == "qb_alternate_phrases":
        alts = ", ".join(b.alternate_phrases) if b.alternate_phrases else "none"
        return (
            f"*Query Builder (3/7) — Alternate Phrases*\n"
            f"Prefilled alternate wordings: {strip_emojis(alts)}\n"
            "1. Keep prefilled alternate phrases\n"
            "2. None\n"
            "3. Reply with comma-separated alternate phrases"
        )

    if step == "qb_exclusions":
        excls = ", ".join(b.exclusions) if b.exclusions else "none"
        return (
            f"*Query Builder (4/7) — Exclusions*\n"
            f"Prefilled exclusions (terms, site:domain.com, author:handle): {strip_emojis(excls)}\n"
            "1. Keep prefilled exclusions\n"
            "2. None\n"
            "3. Reply with comma-separated exclusions"
        )

    if step == "qb_platforms_langs_locs":
        srcs = (
            ", ".join(b.content_sources)
            if b.content_sources
            else "twitter, reddit, news, youtube, blog, forum"
        )
        langs = ", ".join(b.languages) if b.languages else "en"
        locs = ", ".join(b.locations) if b.locations else "worldwide (none)"
        return (
            f"*Query Builder (5/7) — Platforms, Languages & Locations*\n"
            "Set directly on the query so unwanted mentions are never collected.\n"
            f"- Platforms (contentSources): {strip_emojis(srcs)}\n"
            f"- Languages: {strip_emojis(langs)}\n"
            f"- Locations: {strip_emojis(locs)}\n"
            "1. Keep these platforms, languages, and locations\n"
            "2. Reply with changes (for example: 'platforms: reddit, news; languages: en; locations: US')"
        )

    if step == "qb_start_date":
        today = _today_ny_date()
        cur = b.start_date or today
        return (
            f"*Query Builder (6/7) — Backfill Start Date*\n"
            f"Default start date is today ({today} ET). Choosing an earlier date backfills "
            "historical mentions and can spend Brandwatch mention allotment.\n"
            f"1. Start today ({today})\n"
            f"2. Reply with an explicit YYYY-MM-DD start date (currently {cur})"
        )

    if step == "qb_daily_cap":
        cap = b.daily_cap or settings.default_daily_cap
        return (
            f"*Query Builder (7/7) — Daily Mention Cap*\n"
            f"Default daily mention cap from Registry Settings: {cap} mentions/day.\n"
            f"1. Use {cap} mentions/day\n"
            "2. Reply with a custom integer daily cap"
        )

    if step == "qb_offer_existing_coverage":
        q = state.candidate_queries[0]
        return (
            f"Existing Brandwatch query *{strip_emojis(q.name)}* (ID {q.query_id}, project "
            f"{strip_emojis(q.project_name)}) already covers these core terms and platforms.\n"
            "1. Use this existing query instead of creating a new one\n"
            "2. Continue building a new Brandwatch query"
        )

    if step == "qb_fix_boolean":
        errs = "\n".join(f"- {e}" for e in b.validation_errors)
        return (
            "Brandwatch /query-validation reported syntax issues after 3 automatic attempts:\n"
            f"{strip_emojis(errs)}\n"
            f"Last draft:\n{strip_emojis(b.boolean_query)}\n\n"
            "Reply with revised core/context terms or a corrected boolean query (or 'cancel')."
        )

    if step == "cs_space_name":
        default_name = s.base_space_name or state.selected_query_name or b.short_name or "SLRR Campaign"
        return (
            f"*Campaign Setup — Dedicated Chat Space Name*\n"
            f"Campaign ID *{state.campaign_id}* will be appended automatically.\n"
            f"1. Use '{strip_emojis(default_name)} [{state.campaign_id}]'\n"
            "2. Reply with your preferred space name"
        )

    if step == "cs_members_external":
        extra = ", ".join(s.member_emails) if s.member_emails else "requester only"
        ext_lbl = "Yes" if s.external_user_allowed else "No"
        return (
            "*Campaign Setup — Members & External Access*\n"
            "You (the requester) are added automatically. Important: whether people outside Google "
            "can join (externalUserAllowed) cannot be changed after the space is created.\n"
            f"Current: extra members = {strip_emojis(extra)} | external access = {ext_lbl}\n"
            "1. Keep requester only, Google-internal only (externalUserAllowed = No)\n"
            "2. Reply with comma-separated Workspace emails and whether external users must join "
            "(for example: 'lead1@team.invalid, lead2@team.invalid; external: no')"
        )

    if step == "cs_platforms_post_types":
        plats = ", ".join(s.platforms) if s.platforms else "all query platforms"
        pts = ", ".join(s.post_types) if s.post_types else "all"
        return (
            "*Campaign Setup — Alert Platforms & Post Types (Existing Query)*\n"
            "Warning: Brandwatch sets threadEntryType (post, reply, share) only on threaded mentions, "
            "so filtering by post type can drop non-threaded news and blog articles.\n"
            f"Current: platforms = {plats} | post types = {pts}\n"
            "1. Keep current filter (all platforms / prefilled filter)\n"
            "2. Reply with platforms and/or post types "
            "(for example: 'platforms: twitter, reddit; post types: post, share')"
        )

    if step == "cs_sentiment":
        sents = ", ".join(s.sentiments) if s.sentiments else "positive, neutral, negative"
        return (
            "*Campaign Setup — Sentiment Filter*\n"
            f"Current: {sents}\n"
            "1. All sentiments (positive, neutral, negative)\n"
            "2. Negative only\n"
            "3. Negative and neutral\n"
            "4. Positive only"
        )

    if step == "cs_threshold":
        return (
            "*Campaign Setup — Posting Engagement Threshold*\n"
            "All matching mentions are logged to the campaign sheet; only mentions at or above "
            "this engagement score post to Chat.\n"
            f"Current threshold: {s.threshold}\n"
            "1. 0 (post every mention up to per-tick cap)\n"
            "2. 200 (default medium-impact threshold)\n"
            "3. 500 (high-impact threshold)\n"
            "4. Reply with any non-negative integer"
        )

    if step == "cs_also_post_alerts_space":
        cur_echo = "Yes" if s.also_post_in_alerts_space else "No"
        return (
            "*Campaign Setup — Secondary Echo in Alerts Space*\n"
            "Qualifying mentions always post in the dedicated campaign space with the plain-text "
            "focused header. Should they also echo into this thread in the alerts space?\n"
            f"Current: {cur_echo}\n"
            "1. No (post only in the dedicated campaign space)\n"
            "2. Yes (post in the dedicated campaign space and echo into this thread)"
        )

    if step == "cs_shutdown_time":
        max_d = settings.max_campaign_duration_days
        cur_et = format_et(s.end_time_utc) if s.end_time_utc else "not set"
        return (
            f"*Campaign Setup — Shutdown Time (America/New_York)*\n"
            f"Must be in the future and within {max_d} days from now. Current: {cur_et}\n"
            "1. 24 hours from now\n"
            "2. 3 days from now\n"
            f"3. {min(7, max_d)} days from now\n"
            "4. Reply with a specific date/time in America/New_York (YYYY-MM-DD HH:MM ET)"
        )

    if step == "confirm_summary":
        return _render_confirmation_summary(state)

    if step == "await_approval":
        return _render_approval_request(state, settings)

    return "Reply to continue or 'cancel' to abort."


def _render_confirmation_summary(state: ConversationState) -> str:
    s = state.settings
    b = state.builder
    space_full = (
        s.base_space_name
        if state.campaign_id in s.base_space_name
        else f"{s.base_space_name} [{state.campaign_id}]"
    )
    members_lbl = ", ".join(s.member_emails) if s.member_emails else "requester only"
    lines = [
        f"*Confirm Campaign Summary ({state.campaign_id})*",
        f"- Query mode: {state.query_origin}",
    ]
    if state.query_origin == "existing":
        q_line = (
            f"- Query: {strip_emojis(state.selected_query_name)} "
            f"(ID {state.selected_query_id}, project {strip_emojis(state.project_name)})"
        )
        lines.extend(
            [
                q_line,
                f"- Alert platforms: {', '.join(s.platforms) if s.platforms else 'all query platforms'}",
                f"- Alert post types: {', '.join(s.post_types) if s.post_types else 'all'}",
            ],
        )
    else:
        lines.extend(
            [
                f"- New query name: SLRR-CMP-{state.campaign_id} {strip_emojis(b.short_name)}",
                f"- Boolean query: {strip_emojis(b.boolean_query)}",
                f"- Query platforms: {', '.join(b.content_sources) if b.content_sources else 'all'}",
                f"- Query languages: {', '.join(b.languages) if b.languages else 'en'}",
                f"- Query locations: {', '.join(b.locations) if b.locations else 'worldwide'}",
                f"- Start date: {b.start_date}",
                f"- Daily mention cap: {b.daily_cap}",
                f"- Query limit usage: {b.query_limit_usage or '1'}",
            ],
        )
    edit_hint = (
        "2. Name any field to edit it (space name, members, platforms, post types, "
        "sentiment, threshold, alerts echo, shutdown time, daily cap)"
    )
    lines.extend(
        [
            f"- Space name: {strip_emojis(space_full)}",
            f"- Extra members: {strip_emojis(members_lbl)}",
            f"- External members allowed: {'Yes' if s.external_user_allowed else 'No'} (immutable)",
            f"- Sentiment filter: {', '.join(s.sentiments)}",
            f"- Posting engagement threshold: >= {s.threshold}",
            f"- Also post in alerts space: {'Yes' if s.also_post_in_alerts_space else 'No'}",
            f"- Shutdown time (ET): {format_et(s.end_time_utc)}",
            "",
            "1. Reply 'yes' to confirm"
            + (" and request approver sign-off" if state.query_origin == "created" else " and provision now"),
            edit_hint,
            "3. Reply 'cancel' to abort without creating anything",
        ],
    )
    return "\n".join(lines)


def _render_approval_request(state: ConversationState, settings: RegistrySettings) -> str:
    b = state.builder
    s = state.settings
    approvers = ", ".join(settings.approver_emails)
    end_lbl = format_et(s.end_time_utc)
    return (
        f"*Approver Sign-Off Required for New Brandwatch Query ({state.campaign_id})*\n"
        f"Authorized approvers in Registry Settings: {approvers}\n\n"
        f"- Proposed query name: SLRR-CMP-{state.campaign_id} {strip_emojis(b.short_name)}\n"
        f"- Project ID: {state.project_id}\n"
        f"- Validated booleanQuery:\n{strip_emojis(b.boolean_query)}\n"
        f"- contentSources: {', '.join(b.content_sources) if b.content_sources else 'all'}\n"
        f"- languages: {', '.join(b.languages) if b.languages else 'en'}\n"
        f"- locationFilter: {', '.join(b.locations) if b.locations else 'none'}\n"
        f"- startDate: {b.start_date} (lockedQuery: true)\n"
        f"- exclusionSnippets (Settings): {', '.join(settings.exclusion_snippet_names) or 'none'}\n"
        f"- Daily mention cap: {b.daily_cap} | queryLimitUsage: {b.query_limit_usage or '1'}\n"
        f"- Dedicated space: {strip_emojis(s.base_space_name)} [{state.campaign_id}]\n"
        f"- Sentiment: {', '.join(s.sentiments)} | Threshold: >= {s.threshold} | Shutdown: {end_lbl}\n\n"
        "An approver listed in Settings must reply *approve* in this thread within 24 hours "
        "to create the query and provision the campaign (or reply 'cancel')."
    )


def _draft_and_validate_boolean(
    *,
    bw: BrandwatchClient,
    gemini: GeminiFlows,
    state: ConversationState,
) -> bool:
    """Draft booleanQuery from cached examples and run up to 3 POST /query-validation attempts."""
    cached = bw.get_cached_queries()
    examples = [q.boolean_query for q in cached if q.boolean_query and not q.name.startswith("SLRR-CMP-")][:4]
    errors: list[str] = []
    loc_payload = (
        LocationFilterPayload(includedLocations=list(state.builder.locations))
        if state.builder.locations
        else None
    )

    for _attempt in range(3):
        drafted = gemini.draft_boolean(
            builder=state.builder,
            example_booleans=examples,
            previous_errors=errors,
        )
        state.builder.boolean_query = strip_emojis(drafted.boolean_query).strip()
        val_resp = bw.validate_query(
            boolean_query=state.builder.boolean_query,
            languages=state.builder.languages or ["en"],
            location_filter=loc_payload,
        )
        errors, usage = format_validation_issues(val_resp)
        state.builder.query_limit_usage = usage
        if not errors:
            state.builder.validation_errors = []
            return True
        state.builder.validation_errors = errors
    return False


def _advance_after_setting(state: ConversationState, next_default_step: str) -> None:
    if state.return_to_confirm:
        state.return_to_confirm = False
        state.step = "confirm_summary"
    else:
        state.step = next_default_step


def _map_edit_field_to_step(field_raw: str, query_origin: str) -> str | None:
    f = field_raw.strip().lower()
    if "space" in f or "name" in f:
        return "cs_space_name"
    if "member" in f or "external" in f:
        return "cs_members_external"
    if ("platform" in f or "post" in f or "type" in f) and query_origin == "existing":
        return "cs_platforms_post_types"
    if "sentiment" in f:
        return "cs_sentiment"
    if "threshold" in f or "engagement" in f:
        return "cs_threshold"
    if "echo" in f or "alert" in f:
        return "cs_also_post_alerts_space"
    if "shutdown" in f or "end" in f or "time" in f or "duration" in f:
        return "cs_shutdown_time"
    if "cap" in f and query_origin == "created":
        return "qb_daily_cap"
    return None


def _build_campaign_record_from_state(state: ConversationState) -> CampaignRecord:
    s = state.settings
    b = state.builder
    now_iso = _now_iso()
    display_name = (
        s.base_space_name
        if state.campaign_id in s.base_space_name
        else f"{s.base_space_name} [{state.campaign_id}]"
    )
    members = list(dict.fromkeys([state.requester_user, *s.member_users]))
    return CampaignRecord(
        campaign_id=state.campaign_id,
        status="provisioning",
        source_space=state.space,
        source_thread=state.thread,
        requester_user=state.requester_user,
        requester_email=state.requester_email,
        approver_user=state.approver_user,
        approver_email=state.approver_email,
        project_id=state.project_id,
        query_id=state.selected_query_id if state.query_origin == "existing" else 0,
        query_name=state.selected_query_name if state.query_origin == "existing" else b.short_name,
        query_origin=state.query_origin,
        query_limit_usage=b.query_limit_usage,
        alert_id=0,
        alert_name=f"SLRR-CMP-{state.campaign_id}",
        space_display_name=strip_emojis(display_name)[:120],
        external_user_allowed=s.external_user_allowed,
        member_users=members,
        threshold=s.threshold,
        sentiments=list(s.sentiments),
        platforms=list(s.platforms) if state.query_origin == "existing" else list(b.content_sources),
        post_types=list(s.post_types) if state.query_origin == "existing" else [],
        daily_cap=b.daily_cap if state.query_origin == "created" else 0,
        also_post_in_alerts_space=s.also_post_in_alerts_space,
        end_time_utc=s.end_time_utc,
        created_at_utc=now_iso,
        updated_at_utc=now_iso,
    )


def _start_campaign_query_choice(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    gemini: GeminiFlows,
    state: ConversationState,
    topic: str,
    alert_name_hint: str,
) -> str:
    """Populate initial query selection state (mapped alert query first, else top-5 search)."""
    if not state.campaign_id:
        state.campaign_id = store.next_campaign_id()
    if state.project_id <= 0:
        state.project_id = cfg.brandwatch_project_ids[0]

    parsed_ctx = extract_alert_context_from_chat(state.alert_text)
    lookup_name = (alert_name_hint or parsed_ctx["alert_name"]).strip()
    cached = bw.get_cached_queries()
    by_qid = {q.query_id: q for q in cached}

    if lookup_name:
        found = bw.find_alert_by_name(lookup_name, max_projects=5)
        if found is not None:
            pid, alert_obj = found
            qids = [int(q) for q in (alert_obj.get("queryIds") or []) if isinstance(q, int)]
            if qids and qids[0] in by_qid:
                raw_filt = alert_obj.get("filter")
                filt_raw: dict[str, Any] = raw_filt if isinstance(raw_filt, dict) else {}
                state.prefilled_filter = CustomAlertFilterPayload.model_validate(
                    {k: filt_raw[k] for k in ("pageType", "threadEntryType", "sentiment") if filt_raw.get(k)},
                )
                state.candidate_queries = [by_qid[qids[0]]]
                state.project_id = pid
                state.project_name = by_qid[qids[0]].project_name
                state.step = "choose_mapped_query"
                return state.step

    top5 = _search_top_5_queries(
        bw=bw,
        gemini=gemini,
        topic=topic or lookup_name or parsed_ctx["product"] or "Google",
        alert_text=state.alert_text,
    )
    if top5:
        state.candidate_queries = top5
        state.step = "choose_search_query"
        return state.step

    return _begin_query_builder(
        cfg=cfg,
        gemini=gemini,
        state=state,
        settings_daily_cap=2500,
        user_text=topic,
    )


def _begin_query_builder(
    *,
    cfg: CampaignsConfig,
    gemini: GeminiFlows,
    state: ConversationState,
    settings_daily_cap: int,
    user_text: str,
) -> str:
    prefill = gemini.prefill_builder(user_text=user_text, alert_text=state.alert_text)
    state.query_origin = "created"
    if state.project_id <= 0:
        state.project_id = cfg.brandwatch_project_ids[0]
    state.builder = QueryBuilderDraft(
        short_name=strip_emojis(prefill.short_name)[:48] or "Campaign Topic",
        core_terms=[strip_emojis(t) for t in prefill.core_terms if t.strip()],
        context_proximity=strip_emojis(prefill.context_proximity),
        alternate_phrases=[strip_emojis(p) for p in prefill.alternate_phrases if p.strip()],
        exclusions=[strip_emojis(e) for e in prefill.exclusions if e.strip()],
        content_sources=[s.strip().lower() for s in prefill.content_sources if s.strip()],
        languages=[lang.strip().lower() for lang in (prefill.languages or ["en"]) if lang.strip()],
        locations=[loc.strip() for loc in prefill.locations if loc.strip()],
        start_date=_today_ny_date(),
        daily_cap=settings_daily_cap,
    )
    state.settings.base_space_name = state.builder.short_name
    state.step = "qb_core_terms"
    return state.step


def _enter_campaign_settings_for_existing_query(
    state: ConversationState,
    chosen: CachedQuerySummary,
) -> None:
    state.query_origin = "existing"
    state.project_id = chosen.project_id
    state.project_name = chosen.project_name
    state.selected_query_id = chosen.query_id
    state.selected_query_name = chosen.name
    state.settings.base_space_name = chosen.name[:60]
    if state.prefilled_filter.pageType:
        state.settings.platforms = list(state.prefilled_filter.pageType)
    if state.prefilled_filter.threadEntryType:
        state.settings.post_types = list(state.prefilled_filter.threadEntryType)
    if state.prefilled_filter.sentiment:
        state.settings.sentiments = list(state.prefilled_filter.sentiment)
    state.step = "cs_space_name"


def _handle_conversation_reply(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    bq: BigQueryMentionsClient,
    workspace: WorkspaceClients,
    gemini: GeminiFlows,
    settings: RegistrySettings,
    state: ConversationState,
    sender_user: str,
    reply_text: str,
) -> None:
    """Process one human reply inside an active conversation state."""
    target_space = state.space or cfg.alerts_space
    direct_cmd = extract_direct_chat_command(reply_text)
    existing_camp = _find_campaign_for_thread(store, state.thread)
    if direct_cmd and existing_camp:
        _updated, msg = apply_campaign_mutation(
            cfg=cfg,
            store=store,
            bw=bw,
            workspace=workspace,
            bq=bq,
            gemini=gemini,
            settings=settings,
            campaign=existing_camp,
            changes=direct_cmd,
        )
        workspace.post_message(target_space, msg, thread_name=state.thread)
        return

    prompt_context = _step_prompt(state, settings)
    parsed = gemini.parse_step_reply(
        step_name=state.step,
        step_instructions=prompt_context,
        current_Time_ny=_now_ny_str(),
        user_reply=reply_text,
    )

    if parsed.outcome == "cancel" or reply_text.strip().lower() == "cancel":
        state.flow = "cancelled"
        state.step = "done"
        state.last_prompted_at_utc = _now_iso()
        store.save_conversation(state)
        workspace.post_message(
            target_space,
            "Cancelled. Nothing was created.",
            thread_name=state.thread,
        )
        return

    cmd_map = _command_from_parsed_reply(parsed)
    if cmd_map and existing_camp:
        _updated, msg = apply_campaign_mutation(
            cfg=cfg,
            store=store,
            bw=bw,
            workspace=workspace,
            bq=bq,
            gemini=gemini,
            settings=settings,
            campaign=existing_camp,
            changes=cmd_map,
        )
        workspace.post_message(target_space, msg, thread_name=state.thread)
        return

    if parsed.outcome == "unclear":
        if state.clarifications_asked < 2:
            state.clarifications_asked += 1
            state.last_prompted_at_utc = _now_iso()
            store.save_conversation(state)
            q_text = strip_emojis(parsed.clarifying_question) or "Could you clarify your choice?"
            workspace.post_message(
                target_space,
                f"{q_text}\n(Clarification {state.clarifications_asked}/2, or reply 'cancel'.)",
                thread_name=state.thread,
            )
            return
        state.clarifications_asked = 0
        state.last_prompted_at_utc = _now_iso()
        store.save_conversation(state)
        workspace.post_message(
            target_space,
            f"Let's try this step again:\n\n{prompt_context}",
            thread_name=state.thread,
        )
        return

    state.clarifications_asked = 0
    step = state.step
    extra_prefix = ""

    if step == "offer_after_deep_dive":
        choice = parsed.choice_number
        if choice == 3 or (parsed.outcome == "parsed" and not parsed.bool_value and choice == 0):
            state.flow = "completed"
            state.step = "done"
            store.save_conversation(state)
            workspace.post_message(
                target_space,
                "Understood. The deep dive Google Doc remains in Drive; no campaign was created.",
                thread_name=state.thread,
            )
            return
        if not state.campaign_id:
            state.campaign_id = store.next_campaign_id()
        if choice == 2:
            top5 = _search_top_5_queries(
                bw=bw,
                gemini=gemini,
                topic=state.selected_query_name,
                alert_text=state.alert_text,
            )
            if top5:
                state.candidate_queries = top5
                state.step = "choose_search_query"
            else:
                _begin_query_builder(
                    cfg=cfg,
                    gemini=gemini,
                    state=state,
                    settings_daily_cap=settings.default_daily_cap,
                    user_text=reply_text,
                )
        else:
            state.query_origin = "existing"
            state.settings.base_space_name = state.selected_query_name[:60]
            if state.prefilled_filter.pageType:
                state.settings.platforms = list(state.prefilled_filter.pageType)
            if state.prefilled_filter.threadEntryType:
                state.settings.post_types = list(state.prefilled_filter.threadEntryType)
            if state.prefilled_filter.sentiment:
                state.settings.sentiments = list(state.prefilled_filter.sentiment)
            state.step = "cs_space_name"

    elif step == "choose_mapped_query":
        if parsed.choice_number == 1 or parsed.bool_value:
            _enter_campaign_settings_for_existing_query(state, state.candidate_queries[0])
        elif parsed.choice_number == 2:
            top5 = _search_top_5_queries(
                bw=bw,
                gemini=gemini,
                topic=state.selected_query_name or "Google",
                alert_text=state.alert_text,
            )
            if top5:
                state.candidate_queries = top5
                state.step = "choose_search_query"
            else:
                _begin_query_builder(
                    cfg=cfg,
                    gemini=gemini,
                    state=state,
                    settings_daily_cap=settings.default_daily_cap,
                    user_text=reply_text,
                )
        else:
            _begin_query_builder(
                cfg=cfg,
                gemini=gemini,
                state=state,
                settings_daily_cap=settings.default_daily_cap,
                user_text=reply_text,
            )

    elif step == "choose_search_query":
        none_idx = len(state.candidate_queries) + 1
        if parsed.choice_number == none_idx or "none" in reply_text.lower() or "build" in reply_text.lower():
            _begin_query_builder(
                cfg=cfg,
                gemini=gemini,
                state=state,
                settings_daily_cap=settings.default_daily_cap,
                user_text=reply_text,
            )
        elif 1 <= parsed.choice_number <= len(state.candidate_queries):
            chosen = state.candidate_queries[parsed.choice_number - 1]
            _enter_campaign_settings_for_existing_query(state, chosen)
        else:
            workspace.post_message(
                target_space,
                f"Please pick a number between 1 and {none_idx} (or 'cancel').",
                thread_name=state.thread,
            )
            return

    elif step == "qb_core_terms":
        if parsed.choice_number != 1 and (parsed.list_values or parsed.text_value):
            terms = parsed.list_values or [t.strip() for t in reply_text.split(",") if t.strip()]
            state.builder.core_terms = [strip_emojis(t) for t in terms if t.strip()]
            if state.builder.core_terms:
                state.builder.short_name = " ".join(state.builder.core_terms[:2])[:48]
                state.settings.base_space_name = state.builder.short_name
        state.step = "qb_context_proximity"

    elif step == "qb_context_proximity":
        if parsed.choice_number == 2:
            state.builder.context_proximity = "None"
        elif parsed.choice_number != 1 and parsed.text_value:
            state.builder.context_proximity = strip_emojis(parsed.text_value)
        state.step = "qb_alternate_phrases"

    elif step == "qb_alternate_phrases":
        if parsed.choice_number == 2:
            state.builder.alternate_phrases = []
        elif parsed.choice_number != 1 and (parsed.list_values or parsed.text_value):
            vals = parsed.list_values or [v.strip() for v in reply_text.split(",") if v.strip()]
            state.builder.alternate_phrases = [strip_emojis(v) for v in vals if v.strip()]
        state.step = "qb_exclusions"

    elif step == "qb_exclusions":
        if parsed.choice_number == 2:
            state.builder.exclusions = []
        elif parsed.choice_number != 1 and (parsed.list_values or parsed.text_value):
            vals = parsed.list_values or [v.strip() for v in reply_text.split(",") if v.strip()]
            state.builder.exclusions = [strip_emojis(v) for v in vals if v.strip()]
        state.step = "qb_platforms_langs_locs"

    elif step == "qb_platforms_langs_locs":
        if parsed.choice_number != 1 and (parsed.list_values or parsed.text_value):
            valid_metrics = {
                str(m.get("id") or m.get("name") or "").strip().lower()
                for m in bw.get_metrics()
                if m.get("id") or m.get("name")
            }
            valid_metrics.update(
                {"twitter", "reddit", "youtube", "news", "blog", "forum", "instagram", "facebook", "bluesky"},
            )
            tokens = parsed.list_values or [t.strip() for t in re.split(r"[,;\s]+", reply_text) if t.strip()]
            srcs = [t.lower() for t in tokens if t.lower() in valid_metrics]
            langs = [
                t.lower() for t in tokens if len(t) == 2 and t.isalpha() and t.lower() not in ("us", "uk")
            ]
            locs = [t for t in tokens if t.upper() in ("US", "UK", "GB", "CA", "AU", "IN", "DE", "FR", "JP")]
            if srcs:
                state.builder.content_sources = srcs
            if langs:
                state.builder.languages = langs
            if locs:
                state.builder.locations = [loc.upper() for loc in locs]
        state.step = "qb_start_date"

    elif step == "qb_start_date":
        today = _today_ny_date()
        if parsed.choice_number == 1 or not parsed.text_value:
            state.builder.start_date = today
        else:
            candidate = parsed.text_value.strip()[:10]
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", candidate):
                workspace.post_message(
                    target_space,
                    "Please enter a valid YYYY-MM-DD start date (or reply '1' for today).",
                    thread_name=state.thread,
                )
                return
            state.builder.start_date = candidate
            if candidate < today:
                extra_prefix = (
                    f"Warning: startDate {candidate} is earlier than today ({today}); "
                    "Brandwatch historical backfill will count against your mention allotment.\n\n"
                )
        state.step = "qb_daily_cap"

    elif step == "qb_daily_cap":
        if parsed.choice_number == 1 and state.builder.daily_cap > 0:
            pass
        elif parsed.int_value > 0:
            state.builder.daily_cap = parsed.int_value
        else:
            state.builder.daily_cap = settings.default_daily_cap

        if state.return_to_confirm:
            state.return_to_confirm = False
            state.step = "confirm_summary"
        else:
            covering = _find_covering_cached_query(bw.get_cached_queries(), state.builder)
            if covering is not None:
                state.candidate_queries = [covering]
                state.step = "qb_offer_existing_coverage"
            else:
                ok = _draft_and_validate_boolean(bw=bw, gemini=gemini, state=state)
                state.step = "cs_space_name" if ok else "qb_fix_boolean"

    elif step == "qb_offer_existing_coverage":
        if parsed.choice_number == 1 or parsed.bool_value:
            _enter_campaign_settings_for_existing_query(state, state.candidate_queries[0])
        else:
            ok = _draft_and_validate_boolean(bw=bw, gemini=gemini, state=state)
            state.step = "cs_space_name" if ok else "qb_fix_boolean"

    elif step == "qb_fix_boolean":
        state.builder.context_proximity = (
            f"{state.builder.context_proximity}; user revision: {strip_emojis(reply_text)}"
        )
        ok = _draft_and_validate_boolean(bw=bw, gemini=gemini, state=state)
        state.step = "cs_space_name" if ok else "qb_fix_boolean"

    elif step == "cs_space_name":
        if parsed.choice_number != 1 and parsed.text_value.strip():
            state.settings.base_space_name = strip_emojis(parsed.text_value.strip())[:80]
        elif not state.settings.base_space_name:
            state.settings.base_space_name = (
                state.selected_query_name or state.builder.short_name or "SLRR Campaign"
            )
        _advance_after_setting(state, "cs_members_external")

    elif step == "cs_members_external":
        if parsed.choice_number == 1:
            state.settings.member_emails = []
            state.settings.member_users = []
            state.settings.external_user_allowed = False
        else:
            emails = [
                e.strip().lower()
                for e in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", reply_text)
            ]
            resolved_users: list[str] = []
            unresolved: list[str] = []
            for em in emails:
                try:
                    resolved_users.append(workspace.resolve_email_to_chat_user(em))
                except WorkspaceApiError:
                    unresolved.append(em)
            if unresolved:
                workspace.post_message(
                    target_space,
                    f"Could not resolve directory user IDs for: {', '.join(unresolved)}. "
                    "Please reply with valid Google Workspace emails (or '1' for requester only).",
                    thread_name=state.thread,
                )
                return
            state.settings.member_emails = emails
            state.settings.member_users = resolved_users
            ext_yes = bool(re.search(r"external\s*[:=]?\s*(?:yes|true|allow)", reply_text, re.IGNORECASE))
            state.settings.external_user_allowed = ext_yes or parsed.bool_value
        next_step = "cs_platforms_post_types" if state.query_origin == "existing" else "cs_sentiment"
        _advance_after_setting(state, next_step)

    elif step == "cs_platforms_post_types":
        if parsed.choice_number != 1:
            tokens = [t.strip().lower() for t in re.split(r"[,;\s:]+", reply_text) if t.strip()]
            valid_metrics = {
                str(m.get("id") or m.get("name") or "").strip().lower()
                for m in bw.get_metrics()
                if m.get("id") or m.get("name")
            }
            valid_metrics.update(
                {"twitter", "reddit", "youtube", "news", "blog", "forum", "instagram", "facebook", "bluesky"},
            )
            plats = [t for t in tokens if t in valid_metrics]
            pts: list[ThreadEntryTypeValue] = [pt for pt in VALID_POST_TYPES if pt in tokens]
            if "all" in tokens and not plats:
                state.settings.platforms = []
            elif plats:
                state.settings.platforms = plats
            if "all" in tokens and not pts:
                state.settings.post_types = []
            elif pts:
                state.settings.post_types = pts
        _advance_after_setting(state, "cs_sentiment")

    elif step == "cs_sentiment":
        if parsed.choice_number == 1:
            state.settings.sentiments = ["positive", "neutral", "negative"]
        elif parsed.choice_number == 2:
            state.settings.sentiments = ["negative"]
        elif parsed.choice_number == 3:
            state.settings.sentiments = ["neutral", "negative"]
        elif parsed.choice_number == 4:
            state.settings.sentiments = ["positive"]
        else:
            found_s: list[SentimentValue] = [sv for sv in VALID_SENTIMENTS if sv in reply_text.lower()]
            state.settings.sentiments = found_s or ["positive", "neutral", "negative"]
        _advance_after_setting(state, "cs_threshold")

    elif step == "cs_threshold":
        if parsed.choice_number == 1 and reply_text.strip() == "1":
            state.settings.threshold = 0
        elif parsed.choice_number == 2 and reply_text.strip() == "2":
            state.settings.threshold = 200
        elif parsed.choice_number == 3 and reply_text.strip() == "3":
            state.settings.threshold = 500
        elif reply_text.strip().isdigit():
            state.settings.threshold = int(reply_text.strip())
        elif parsed.int_value >= 0:
            state.settings.threshold = parsed.int_value
        _advance_after_setting(state, "cs_also_post_alerts_space")

    elif step == "cs_also_post_alerts_space":
        state.settings.also_post_in_alerts_space = parsed.choice_number == 2 or parsed.bool_value
        _advance_after_setting(state, "cs_shutdown_time")

    elif step == "cs_shutdown_time":
        now = _now_utc()
        max_dt = now + timedelta(days=settings.max_campaign_duration_days)
        chosen_dt: datetime | None = None
        stripped = reply_text.strip()
        if stripped == "1" or parsed.choice_number == 1:
            chosen_dt = now + timedelta(hours=24)
        elif stripped == "2" or parsed.choice_number == 2:
            chosen_dt = now + timedelta(days=3)
        elif stripped == "3" or parsed.choice_number == 3:
            chosen_dt = now + timedelta(days=min(7, settings.max_campaign_duration_days))
        elif parsed.iso_utc_value:
            chosen_dt = datetime.fromisoformat(parsed.iso_utc_value.replace("Z", "+00:00")).astimezone(UTC)

        if chosen_dt is None or chosen_dt <= now or chosen_dt > max_dt:
            workspace.post_message(
                target_space,
                "Shutdown time must be in the future and within "
                f"{settings.max_campaign_duration_days} days from now. "
                "Reply with 1, 2, 3, or a valid YYYY-MM-DD HH:MM ET timestamp.",
                thread_name=state.thread,
            )
            return
        state.settings.end_time_utc = chosen_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        state.return_to_confirm = False
        state.step = "confirm_summary"

    elif step == "confirm_summary":
        if parsed.outcome == "edit_field" or parsed.choice_number == 2:
            target_step = _map_edit_field_to_step(parsed.edit_field_name or reply_text, state.query_origin)
            if target_step is None:
                workspace.post_message(
                    target_space,
                    "Specify which field to edit: space name, members, platforms, post types, "
                    "sentiment, threshold, alerts echo, or shutdown time.",
                    thread_name=state.thread,
                )
                return
            state.return_to_confirm = True
            state.step = target_step
        elif (
            parsed.bool_value
            or parsed.choice_number == 1
            or reply_text.strip().lower() in ("yes", "y", "confirm")
        ):
            if state.query_origin == "created":
                state.step = "await_approval"
            else:
                record = _build_campaign_record_from_state(state)
                store.save_campaign(record)
                provision_campaign(
                    cfg=cfg,
                    store=store,
                    bw=bw,
                    workspace=workspace,
                    campaign=record,
                    builder=state.builder,
                    settings=settings,
                )
                state.flow = "completed"
                state.step = "done"
                state.last_prompted_at_utc = _now_iso()
                store.save_conversation(state)
                return
        else:
            target_step = _map_edit_field_to_step(reply_text, state.query_origin)
            if target_step:
                state.return_to_confirm = True
                state.step = target_step
            else:
                workspace.post_message(
                    target_space,
                    "Reply 'yes' to confirm, name a field to edit, or 'cancel' to abort.",
                    thread_name=state.thread,
                )
                return

    elif step == "await_approval":
        approver_map = resolve_approver_users(settings, workspace)
        is_approve = parsed.outcome == "approve" or reply_text.strip().lower().startswith("approve")
        if not is_approve:
            workspace.post_message(
                target_space,
                "Waiting for an authorized approver listed in Registry Settings to reply "
                "'approve' (or 'cancel' to abort).",
                thread_name=state.thread,
            )
            return
        if sender_user not in approver_map:
            workspace.post_message(
                target_space,
                f"Sender {sender_user} is not listed as an approver in Registry Settings "
                f"({', '.join(settings.approver_emails)}). An authorized approver must reply 'approve'.",
                thread_name=state.thread,
            )
            return
        state.approver_user = sender_user
        state.approver_email = approver_map[sender_user]
        record = _build_campaign_record_from_state(state)
        store.save_campaign(record)
        provision_campaign(
            cfg=cfg,
            store=store,
            bw=bw,
            workspace=workspace,
            campaign=record,
            builder=state.builder,
            settings=settings,
        )
        state.flow = "completed"
        state.step = "done"
        state.last_prompted_at_utc = _now_iso()
        store.save_conversation(state)
        return

    state.last_prompted_at_utc = _now_iso()
    store.save_conversation(state)
    workspace.post_message(
        target_space,
        f"{extra_prefix}{_step_prompt(state, settings)}",
        thread_name=state.thread,
    )


def _handle_initial_thread_request(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    bq: BigQueryMentionsClient,
    workspace: WorkspaceClients,
    gemini: GeminiFlows,
    settings: RegistrySettings,
    ownership: ThreadOwnershipRecord,
    sender_user: str,
    user_text: str,
) -> None:
    """Handle the initial handoff message or a fresh request in an owned thread."""
    target_space = ownership.space or cfg.alerts_space
    direct_cmd = extract_direct_chat_command(user_text)
    existing_camp = _find_campaign_for_thread(store, ownership.thread)
    if direct_cmd and existing_camp:
        _updated, msg = apply_campaign_mutation(
            cfg=cfg,
            store=store,
            bw=bw,
            workspace=workspace,
            bq=bq,
            gemini=gemini,
            settings=settings,
            campaign=existing_camp,
            changes=direct_cmd,
        )
        workspace.post_message(target_space, msg, thread_name=ownership.thread)
        return

    parsed_intent = gemini.parse_initial_intent(
        user_text=user_text,
        alert_text=ownership.alert_text,
    )
    if parsed_intent.intent == "chat_command" and existing_camp and parsed_intent.command_name != "none":
        cmd_changes: dict[str, str] = {}
        if parsed_intent.command_name == "pause":
            cmd_changes["action"] = "Pause"
        elif parsed_intent.command_name == "resume":
            cmd_changes["action"] = "Resume"
        elif parsed_intent.command_name == "shut_down":
            cmd_changes["action"] = "Shut down now"
        elif parsed_intent.command_name == "extend" and parsed_intent.command_int > 0:
            cmd_changes["extend_days"] = str(parsed_intent.command_int)
        elif parsed_intent.command_name == "threshold" and parsed_intent.command_int >= 0:
            cmd_changes["threshold"] = str(parsed_intent.command_int)
        if cmd_changes:
            _updated, msg = apply_campaign_mutation(
                cfg=cfg,
                store=store,
                bw=bw,
                workspace=workspace,
                bq=bq,
                gemini=gemini,
                settings=settings,
                campaign=existing_camp,
                changes=cmd_changes,
            )
            workspace.post_message(target_space, msg, thread_name=ownership.thread)
            return

    if parsed_intent.intent == "deep_dive":
        outcome = run_deep_dive(
            cfg=cfg,
            bw=bw,
            bq=bq,
            workspace=workspace,
            gemini=gemini,
            thread_name=ownership.thread,
            alert_text=ownership.alert_text,
            user_text=user_text,
            days=parsed_intent.deep_dive_days,
            alert_name_hint=parsed_intent.alert_name_hint,
            search_topic=parsed_intent.search_topic,
            space=target_space,
        )
        conv = ConversationState(
            thread=ownership.thread,
            space=target_space,
            requester_user=sender_user,
            flow="campaign",
            step="offer_after_deep_dive",
            last_prompted_at_utc=_now_iso(),
            alert_text=ownership.alert_text,
            alert_name=parsed_intent.alert_name_hint,
            deep_dive_days=parsed_intent.deep_dive_days,
            project_id=outcome.project_id,
            project_name=outcome.project_name,
            selected_query_id=outcome.query_id,
            selected_query_name=outcome.query_name,
            query_origin="existing",
            prefilled_filter=outcome.alert_filter,
        )
        store.save_conversation(conv)
        return

    conv = ConversationState(
        thread=ownership.thread,
        space=target_space,
        requester_user=sender_user,
        flow="campaign",
        step="init",
        last_prompted_at_utc=_now_iso(),
        alert_text=ownership.alert_text,
        alert_name=parsed_intent.alert_name_hint,
    )
    _start_campaign_query_choice(
        cfg=cfg,
        store=store,
        bw=bw,
        gemini=gemini,
        state=conv,
        topic=parsed_intent.search_topic or user_text,
        alert_name_hint=parsed_intent.alert_name_hint,
    )
    conv.last_prompted_at_utc = _now_iso()
    store.save_conversation(conv)
    workspace.post_message(
        target_space,
        _step_prompt(conv, settings),
        thread_name=ownership.thread,
    )


def process_owned_threads(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    bq: BigQueryMentionsClient,
    workspace: WorkspaceClients,
    gemini: GeminiFlows,
    settings: RegistrySettings,
) -> dict[str, int]:
    """Poll all owned threads in allowed Google-only alert spaces, expire 24h idle conversations, and advance steps."""
    owned_list = store.list_owned_threads()
    threads_checked = 0
    messages_handled = 0
    expired_count = 0

    for ownership in owned_list:
        if not cfg.is_allowed_alerts_space(ownership.space):
            continue
        thread_space = ownership.space
        owner_token = f"thread-{int(_now_utc().timestamp())}"
        if not store.acquire_lease("thread", ownership.thread, owner_token, ttl_s=110.0):
            continue
        try:
            threads_checked += 1
            # Retry any interrupted provisioning saga tied to this thread.
            for camp in store.list_campaigns():
                if camp.source_thread == ownership.thread and camp.status == "provisioning":
                    conv_for_saga = store.get_conversation(ownership.thread)
                    builder_draft = conv_for_saga.builder if conv_for_saga else QueryBuilderDraft()
                    provision_campaign(
                        cfg=cfg,
                        store=store,
                        bw=bw,
                        workspace=workspace,
                        campaign=camp,
                        builder=builder_draft,
                        settings=settings,
                    )

            conv = store.get_conversation(ownership.thread)
            if conv is not None and conv.flow in ("deep_dive", "campaign") and conv.step != "done":
                last_dt = datetime.fromisoformat(conv.last_prompted_at_utc.replace("Z", "+00:00"))
                if _now_utc() - last_dt >= timedelta(hours=EXPIRY_HOURS):
                    conv.flow = "expired"
                    conv.step = "done"
                    store.save_conversation(conv)
                    workspace.post_message(
                        thread_space,
                        "This request expired after 24 hours without a reply or approval. "
                        "Post a new message in this thread whenever you would like to start again.",
                        thread_name=ownership.thread,
                        idempotency_key=f"expire-{ownership.thread}-{conv.last_prompted_at_utc}",
                    )
                    expired_count += 1
                    continue

            cursor_key = f"thread:{ownership.thread}"
            cursor = store.get_cursor(cursor_key)

            if not ownership.handled_initial:
                source_msg = workspace.get_message(ownership.source_message)
                src_time = str(source_msg.get("createTime") or ownership.created_at)
                src_text = str(source_msg.get("text") or ownership.source_text).strip()
                src_sender = str(((source_msg.get("sender") or {}).get("name")) or ownership.requester)
                if not ownership.alert_text:
                    ownership.alert_text = workspace.get_thread_root_text(
                        thread_space,
                        ownership.thread,
                    )
                try:
                    _handle_initial_thread_request(
                        cfg=cfg,
                        store=store,
                        bw=bw,
                        bq=bq,
                        workspace=workspace,
                        gemini=gemini,
                        settings=settings,
                        ownership=ownership,
                        sender_user=src_sender,
                        user_text=src_text,
                    )
                    messages_handled += 1
                except (
                    LLMError,
                    BrandwatchApiError,
                    WorkspaceApiError,
                    BigQueryMentionsError,
                    ProvisioningFailureError,
                    StoreError,
                    ValueError,
                    RuntimeError,
                ) as exc:
                    log_event(
                        logger,
                        logging.ERROR,
                        "owned_thread_initial_failed",
                        thread=ownership.thread,
                        error_type=type(exc).__name__,
                        error_message=str(exc)[:300],
                    )
                    workspace.post_message(
                        thread_space,
                        f"Request failed: {strip_emojis(str(exc))[:350]}",
                        thread_name=ownership.thread,
                    )
                ownership.handled_initial = True
                store.save_owned_thread(ownership)
                if src_time > cursor:
                    cursor = src_time
                    store.set_cursor(cursor_key, cursor)

            new_msgs = workspace.list_human_messages(
                thread_space,
                thread_name=ownership.thread,
                since_iso=cursor,
            )
            for msg in new_msgs:
                msg_name = str(msg.get("name") or "")
                if msg_name == ownership.source_message:
                    msg_ct = str(msg.get("createTime") or "")
                    if msg_ct > cursor:
                        cursor = msg_ct
                        store.set_cursor(cursor_key, cursor)
                    continue
                text = str(msg.get("text") or "").strip()
                sender = str(((msg.get("sender") or {}).get("name")) or ownership.requester)
                msg_ct = str(msg.get("createTime") or "")
                if not text:
                    if msg_ct > cursor:
                        cursor = msg_ct
                        store.set_cursor(cursor_key, cursor)
                    continue

                try:
                    active_conv = store.get_conversation(ownership.thread)
                    if (
                        active_conv is not None
                        and active_conv.flow in ("deep_dive", "campaign")
                        and active_conv.step != "done"
                    ):
                        _handle_conversation_reply(
                            cfg=cfg,
                            store=store,
                            bw=bw,
                            bq=bq,
                            workspace=workspace,
                            gemini=gemini,
                            settings=settings,
                            state=active_conv,
                            sender_user=sender,
                            reply_text=text,
                        )
                    else:
                        _handle_initial_thread_request(
                            cfg=cfg,
                            store=store,
                            bw=bw,
                            bq=bq,
                            workspace=workspace,
                            gemini=gemini,
                            settings=settings,
                            ownership=ownership,
                            sender_user=sender,
                            user_text=text,
                        )
                    messages_handled += 1
                except (
                    LLMError,
                    BrandwatchApiError,
                    WorkspaceApiError,
                    BigQueryMentionsError,
                    ProvisioningFailureError,
                    StoreError,
                    ValueError,
                    RuntimeError,
                ) as exc:
                    log_event(
                        logger,
                        logging.ERROR,
                        "owned_thread_reply_failed",
                        thread=ownership.thread,
                        message=msg_name,
                        error_type=type(exc).__name__,
                        error_message=str(exc)[:300],
                    )
                    workspace.post_message(
                        thread_space,
                        f"Could not complete step: {strip_emojis(str(exc))[:350]}",
                        thread_name=ownership.thread,
                    )
                if msg_ct > cursor:
                    cursor = msg_ct
                    store.set_cursor(cursor_key, cursor)
        finally:
            store.release_lease("thread", ownership.thread, owner_token)

    return {
        "threads_checked": threads_checked,
        "messages_handled": messages_handled,
        "expired": expired_count,
    }


def process_campaign_spaces(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    bw: BrandwatchClient,
    bq: BigQueryMentionsClient,
    workspace: WorkspaceClients,
    gemini: GeminiFlows,
    settings: RegistrySettings,
) -> dict[str, int]:
    """Poll active/paused campaign spaces for Chat commands and route through apply_campaign_mutation."""
    spaces_polled = 0
    commands_applied = 0

    for campaign in store.list_campaigns():
        if campaign.status not in ("active", "paused") or not campaign.space_name:
            continue
        owner_token = f"spacepoll-{campaign.campaign_id}"
        if not store.acquire_lease("space_poll", campaign.space_name, owner_token, ttl_s=60.0):
            continue
        try:
            spaces_polled += 1
            cursor_key = f"space:{campaign.space_name}"
            cursor = store.get_cursor(cursor_key)
            if not cursor:
                cursor = campaign.created_at_utc
                store.set_cursor(cursor_key, cursor)
            msgs = workspace.list_human_messages(campaign.space_name, since_iso=cursor)
            for msg in msgs:
                text = str(msg.get("text") or "").strip()
                msg_ct = str(msg.get("createTime") or "")
                thread_in_space = str(((msg.get("thread") or {}).get("name")) or "")
                cmd = extract_direct_chat_command(text)
                if cmd is not None:
                    fresh = store.get_campaign(campaign.campaign_id)
                    if fresh is not None:
                        try:
                            _updated, result_msg = apply_campaign_mutation(
                                cfg=cfg,
                                store=store,
                                bw=bw,
                                workspace=workspace,
                                bq=bq,
                                gemini=gemini,
                                settings=settings,
                                campaign=fresh,
                                changes=cmd,
                            )
                            workspace.post_message(
                                campaign.space_name,
                                result_msg,
                                thread_name=thread_in_space or None,
                            )
                            commands_applied += 1
                        except (BrandwatchApiError, WorkspaceApiError, StoreError, RuntimeError) as exc:
                            log_event(
                                logger,
                                logging.ERROR,
                                "campaign_space_command_failed",
                                campaign_id=campaign.campaign_id,
                                error_type=type(exc).__name__,
                                error_message=str(exc)[:300],
                            )
                            workspace.post_message(
                                campaign.space_name,
                                f"Command failed: {strip_emojis(str(exc))[:300]}",
                                thread_name=thread_in_space or None,
                            )
                if msg_ct > cursor:
                    cursor = msg_ct
                    store.set_cursor(cursor_key, cursor)
        finally:
            store.release_lease("space_poll", campaign.space_name, owner_token)

    return {"spaces_polled": spaces_polled, "commands_applied": commands_applied}
