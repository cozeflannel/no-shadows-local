"""Brandwatch + BigQuery deep-dive engine within a strict 8-call Brandwatch budget."""

from __future__ import annotations

import logging
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from triage_agent.qa.record_key import normalize_url

from .bigquery_mentions import BigQueryMentionsClient
from .brandwatch import BrandwatchClient
from .config import CampaignsConfig
from .email_parser import compute_mention_engagement, detect_platform, extract_alert_context_from_chat
from .gemini_flows import GeminiFlows
from .logging_utils import log_event, strip_emojis
from .models import CachedQuerySummary, CustomAlertFilterPayload
from .workspace import WorkspaceClients

logger = logging.getLogger(__name__)
NY_TZ = ZoneInfo("America/New_York")
MAX_DEEP_DIVE_BW_CALLS = 8


class DeepDiveOutcome:
    """Result returned by run_deep_dive for conversation handoff to prefilled campaign offer."""

    def __init__(
        self,
        *,
        doc_id: str,
        doc_url: str,
        thread_summary: str,
        project_id: int,
        project_name: str,
        query_id: int,
        query_name: str,
        alert_filter: CustomAlertFilterPayload,
        bw_calls_used: int,
    ) -> None:
        self.doc_id = doc_id
        self.doc_url = doc_url
        self.thread_summary = thread_summary
        self.project_id = project_id
        self.project_name = project_name
        self.query_id = query_id
        self.query_name = query_name
        self.alert_filter = alert_filter
        self.bw_calls_used = bw_calls_used


def _format_ny(dt: datetime) -> str:
    return dt.astimezone(NY_TZ).strftime("%Y-%m-%d %H:%M %Z")


def _resolve_target_alert_or_query(
    *,
    bw: BrandwatchClient,
    gemini: GeminiFlows,
    alert_name_hint: str,
    search_topic: str,
    alert_text: str,
) -> tuple[int, str, list[int], str, CustomAlertFilterPayload]:
    """Resolve (project_id, project_name, query_ids, query_name, filter) within budget."""
    parsed_ctx = extract_alert_context_from_chat(alert_text)
    search_name = (alert_name_hint or parsed_ctx["alert_name"] or search_topic).strip()
    cached_queries = bw.get_cached_queries()
    by_qid: dict[int, CachedQuerySummary] = {q.query_id: q for q in cached_queries}

    if search_name:
        found = bw.find_alert_by_name(search_name, max_projects=2)
        if found is not None:
            pid, alert_obj = found
            qids = [int(q) for q in (alert_obj.get("queryIds") or []) if isinstance(q, int)]
            raw_filt = alert_obj.get("filter")
            filt_raw: dict[str, Any] = raw_filt if isinstance(raw_filt, dict) else {}
            filt = CustomAlertFilterPayload.model_validate(
                {k: filt_raw[k] for k in ("pageType", "threadEntryType", "sentiment") if filt_raw.get(k)},
            )
            if qids:
                first_q = by_qid.get(qids[0])
                qname = first_q.name if first_q else str(alert_obj.get("name") or search_name)
                pname = first_q.project_name if first_q else f"Project {pid}"
                return pid, pname, qids, qname, filt

    # Fall back to cached queries (exact -> case-insensitive contains -> Gemini semantic rank).
    topic_key = (search_topic or search_name or parsed_ctx["product"] or "Google").strip()
    lower_key = topic_key.lower()
    exact = [q for q in cached_queries if q.name.strip().lower() == lower_key]
    if exact:
        chosen = exact[0]
        return (
            chosen.project_id,
            chosen.project_name,
            [chosen.query_id],
            chosen.name,
            CustomAlertFilterPayload(),
        )

    contains = [q for q in cached_queries if lower_key and lower_key in q.name.lower()]
    pool = contains if contains else cached_queries
    ranked = gemini.rank_queries(topic=topic_key, alert_text=alert_text, candidates=pool)
    if ranked:
        chosen = ranked[0]
        return (
            chosen.project_id,
            chosen.project_name,
            [chosen.query_id],
            chosen.name,
            CustomAlertFilterPayload(),
        )
    if cached_queries:
        chosen = cached_queries[0]
        return (
            chosen.project_id,
            chosen.project_name,
            [chosen.query_id],
            chosen.name,
            CustomAlertFilterPayload(),
        )
    raise RuntimeError("No accessible Brandwatch queries found for deep dive")


def run_deep_dive(
    *,
    cfg: CampaignsConfig,
    bw: BrandwatchClient,
    bq: BigQueryMentionsClient,
    workspace: WorkspaceClients,
    gemini: GeminiFlows,
    thread_name: str,
    alert_text: str,
    user_text: str,
    days: int,
    alert_name_hint: str = "",
    search_topic: str = "",
) -> DeepDiveOutcome:
    """Execute a live Brandwatch/BigQuery deep dive, write Google Doc report, and post summary."""
    clamped_days = max(1, min(7, days))
    end_dt = datetime.now(UTC)
    start_dt = end_dt - timedelta(days=clamped_days)
    start_iso = start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    end_iso = end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    window_label = f"{_format_ny(start_dt)} to {_format_ny(end_dt)} ({clamped_days}d)"

    calls_before = bw.call_count
    project_id, project_name, query_ids, query_name, alert_filter = _resolve_target_alert_or_query(
        bw=bw,
        gemini=gemini,
        alert_name_hint=alert_name_hint,
        search_topic=search_topic,
        alert_text=alert_text,
    )
    parsed_ctx = extract_alert_context_from_chat(alert_text)
    lookup_alert_name = (alert_name_hint or parsed_ctx["alert_name"] or query_name).strip()

    # Source 1: BigQuery first when mentions for this alert stream land in all_sundar_mentions.
    bq_rows = bq.query_deep_dive_mentions(
        alert_name=lookup_alert_name,
        start_iso=start_iso,
        end_iso=end_iso,
        limit=250,
    )

    total_mentions = 0
    sentiment_counts: dict[str, int] = {"positive": 0, "neutral": 0, "negative": 0}
    hourly_points: list[tuple[str, int]] = []
    top_topics: list[str] = []
    top_authors: list[str] = []
    top_posts: list[dict[str, Any]] = []
    lacking_sources: set[str] = set()
    primary_source = "BigQuery (all_sundar_mentions)"

    if bq_rows:
        total_mentions = len(bq_rows)
        hour_counter: Counter[str] = Counter()
        author_counter: Counter[str] = Counter()
        word_counter: Counter[str] = Counter()
        for row in bq_rows:
            sent_key = str(row.get("sentiment") or "neutral").strip().lower()
            if sent_key in sentiment_counts:
                sentiment_counts[sent_key] += 1
            else:
                sentiment_counts["neutral"] += 1
            pub = str(row.get("published_at") or "")[:13]
            if pub:
                hour_counter[f"{pub}:00Z"] += 1
            auth = str(row.get("author") or "Unknown")
            author_counter[f"{auth} ({row.get('network', 'Social')})"] += 1
            prod = str(row.get("product") or "").strip()
            if prod:
                word_counter[prod] += 1
            if not str(row.get("snippet") or "").strip():
                lacking_sources.add(str(row.get("network") or "Unknown"))
            top_posts.append(
                {
                    "url": row["url"],
                    "author": auth,
                    "network": row["network"],
                    "engagement": row["engagement_score"],
                    "sentiment": row["sentiment"],
                    "snippet": str(row.get("snippet") or "")[:300],
                },
            )
        hourly_points = sorted(hour_counter.items())
        top_authors = [f"{name}: {cnt} mentions" for name, cnt in author_counter.most_common(12)]
        top_topics = [f"{name} ({cnt})" for name, cnt in word_counter.most_common(12)]
    else:
        primary_source = "Brandwatch Consumer Research API (hydrated via BigQuery where available)"
        extra_filter = alert_filter.to_api_dict()
        total_mentions = bw.get_mentions_count(
            project_id,
            query_ids=query_ids,
            start_date=start_iso,
            end_date=end_iso,
            extra_filter=extra_filter,
        )
        chart_series = bw.get_volume_sentiment_by_hour(
            project_id,
            query_ids=query_ids,
            start_date=start_iso,
            end_date=end_iso,
            extra_filter=extra_filter,
        )
        hour_totals: Counter[str] = Counter()
        for bucket in chart_series:
            sent_name = str(bucket.get("id") or bucket.get("name") or "neutral").lower()
            vals = bucket.get("values") or []
            bucket_sum = 0
            for pt in vals:
                if isinstance(pt, dict):
                    v = int(pt.get("value") or 0)
                    bucket_sum += v
                    ts_id = str(pt.get("id") or pt.get("name") or "")[:16]
                    if ts_id:
                        hour_totals[ts_id] += v
            if sent_name in sentiment_counts:
                sentiment_counts[sent_name] += bucket_sum
        hourly_points = sorted(hour_totals.items())

        topics_raw = bw.get_topics(
            project_id,
            query_ids=query_ids,
            start_date=start_iso,
            end_date=end_iso,
            extra_filter=extra_filter,
            limit=12,
        )
        for t in topics_raw:
            lbl = str(t.get("label") or t.get("id") or "").strip()
            vol = int(t.get("volume") or 0)
            if lbl:
                top_topics.append(f"{lbl} ({vol} mentions)")

        authors_raw = bw.get_top_authors(
            project_id,
            query_ids=query_ids,
            start_date=start_iso,
            end_date=end_iso,
            extra_filter=extra_filter,
            limit=12,
        )
        for a in authors_raw:
            raw_adata = a.get("data")
            adata: dict[str, Any] = raw_adata if isinstance(raw_adata, dict) else {}
            aname = str(adata.get("authorName") or a.get("name") or "Unknown").strip()
            dom = str(adata.get("domain") or "").strip()
            vol = int(adata.get("volume") or adata.get("authorVolume") or 0)
            top_authors.append(f"{aname} ({dom or 'social'}): {vol} mentions")

        mentions_raw = bw.get_top_mentions(
            project_id,
            query_ids=query_ids,
            start_date=start_iso,
            end_date=end_iso,
            extra_filter=extra_filter,
            page_size=50,
        )
        raw_urls = [str(m.get("url") or "").strip() for m in mentions_raw if m.get("url")]
        hydrated_map = bq.hydrate_urls(raw_urls)
        alert_url_norm = normalize_url(parsed_ctx["url"]) if parsed_ctx["url"] else None

        for m in mentions_raw:
            m_url = str(m.get("url") or "").strip()
            norm = normalize_url(m_url) or m_url.lower()
            page_type = str(m.get("pageType") or detect_platform(m_url)).strip()
            raw_snippet = str(m.get("snippet") or m.get("fullText") or m.get("title") or "").strip()
            hyd = hydrated_map.get(norm)
            final_text = raw_snippet
            if (
                (not final_text or page_type.lower() in ("twitter", "x", "news", "linkedin"))
                and hyd
                and hyd.get("snippet")
            ):
                final_text = str(hyd["snippet"])
            elif not final_text and alert_url_norm and norm == alert_url_norm:
                final_text = parsed_ctx["raw_text"][:400]

            if not final_text:
                lacking_sources.add(page_type or "Unknown")
                title_meta = str(m.get("title") or m.get("domain") or page_type)
                final_text = f"[Text restricted by {page_type} via Brandwatch API; metadata: {title_meta}]"
            elif page_type.lower() == "news" and len(final_text) <= 260 and not (hyd and hyd.get("snippet")):
                lacking_sources.add("Online News (256-character API snippet limit)")

            eng = compute_mention_engagement(tier="VERY LOW", bq_row=hyd, api_row=m)
            author_val = (
                str(hyd["author"])
                if hyd and hyd.get("author")
                else str(m.get("author") or m.get("fullname") or m.get("domain") or "Unknown")
            )
            top_posts.append(
                {
                    "url": m_url,
                    "author": author_val,
                    "network": page_type,
                    "impact": round(float(m.get("impact") or 0.0), 1),
                    "engagement": eng,
                    "sentiment": str(m.get("sentiment") or "neutral"),
                    "snippet": strip_emojis(final_text)[:320],
                },
            )

    bw_calls_used = bw.call_count - calls_before
    if bw_calls_used > MAX_DEEP_DIVE_BW_CALLS:
        raise RuntimeError(
            f"Deep dive exceeded Brandwatch 8-call budget (used {bw_calls_used} calls)",
        )

    synthesis = gemini.synthesize_deep_dive(
        topic=f"{query_name} ({user_text[:120]})",
        window_label=window_label,
        total_mentions=total_mentions,
        sentiment_counts=sentiment_counts,
        top_topics=top_topics,
        top_authors=top_authors,
        sample_posts=top_posts[:20],
        lacking_text_sources=sorted(lacking_sources),
    )

    doc_lines: list[str] = [
        f"SLRR Brandwatch Deep Dive Report: {strip_emojis(query_name)}",
        f"Generated: {_format_ny(end_dt)}",
        f"Window: {window_label}",
        f"Project: {strip_emojis(project_name)} (ID {project_id})",
        f"Query IDs: {', '.join(str(q) for q in query_ids)}",
        f"Primary Data Source: {primary_source}",
        f"Brandwatch API Calls Used: {bw_calls_used} / {MAX_DEEP_DIVE_BW_CALLS}",
        "",
        "1. EXECUTIVE SUMMARY",
        strip_emojis(synthesis.headline_summary),
        "",
        "Key Findings:",
        *[f"- {strip_emojis(item)}" for item in synthesis.key_findings],
        "",
        "2. NUMBERS AND SENTIMENT SPLIT",
        f"- Total Mentions: {total_mentions}",
        f"- Positive: {sentiment_counts['positive']}",
        f"- Neutral: {sentiment_counts['neutral']}",
        f"- Negative: {sentiment_counts['negative']}",
        "",
        "3. TIMELINE (VOLUME BY HOUR)",
        strip_emojis(synthesis.timeline_takeaway),
        *[f"- {hr}: {cnt} mentions" for hr, cnt in hourly_points[-48:]],
        "",
        "4. TOP TOPICS AND NARRATIVE THEMES",
        *[f"- Theme: {strip_emojis(th)}" for th in synthesis.narrative_themes],
        *[
            f"- Topic: {strip_emojis(tp)}"
            for tp in (top_topics or ["No multi-mention phrase clusters returned"])
        ],
        "",
        "5. TOP AUTHORS",
        *[f"- {strip_emojis(au)}" for au in (top_authors or ["No author breakdown returned"])],
        "",
        f"6. TOP POSTS (UP TO {len(top_posts)})",
    ]
    for idx, post in enumerate(top_posts[:50], start=1):
        doc_lines.append(
            f"{idx}. [{post['network']}] {strip_emojis(str(post['author']))} | "
            f"Sentiment: {post['sentiment']} | Engagement: {post['engagement']} | "
            f"URL: {post['url']}\n   Snippet: {strip_emojis(str(post['snippet']))}",
        )
    doc_lines.extend(
        [
            "",
            "7. DATA GAPS AND SOURCE RESTRICTIONS",
            strip_emojis(synthesis.data_gap_notes),
            (
                "Sources lacking full API text: " + ", ".join(sorted(lacking_sources))
                if lacking_sources
                else "All sampled mentions had text populated from BigQuery or Brandwatch snippets."
            ),
            "",
        ],
    )

    doc_title = f"SLRR Deep Dive - {strip_emojis(query_name)[:60]} - {end_dt.strftime('%Y-%m-%d %H:%M UTC')}"
    doc_id, doc_url = workspace.create_report_doc(
        title=doc_title,
        folder_id=cfg.drive_folder_id,
        content="\n".join(doc_lines),
    )

    findings_preview = "\n".join(f"- {strip_emojis(f)}" for f in synthesis.key_findings[:3])
    gap_line = (
        f"Sources lacking full API text: {', '.join(sorted(lacking_sources))}."
        if lacking_sources
        else "Text coverage: full snippets available for sampled mentions."
    )
    thread_summary = (
        f"*Deep Dive Complete: {strip_emojis(query_name)}*\n"
        f"Window: {window_label}\n"
        f"Total mentions: {total_mentions} (Positive {sentiment_counts['positive']}, "
        f"Neutral {sentiment_counts['neutral']}, Negative {sentiment_counts['negative']})\n"
        f"{strip_emojis(synthesis.headline_summary)}\n"
        f"{findings_preview}\n"
        f"{gap_line}\n"
        f"Full Google Doc report: {doc_url}\n\n"
        f"Would you like to start an alert campaign prefilled with query *{strip_emojis(query_name)}* "
        f"(ID {query_ids[0]})?\n"
        "1. Yes, start a campaign with this query and filter\n"
        "2. Pick a different query or build a new one\n"
        "3. No thanks (reply 'cancel' or '3' to close)"
    )
    workspace.post_message(
        cfg.alerts_space,
        thread_summary,
        thread_name=thread_name,
        idempotency_key=f"deep-dive-{thread_name}-{end_dt.strftime('%Y%m%d%H%M')}",
    )
    log_event(
        logger,
        logging.INFO,
        "deep_dive_completed",
        thread=thread_name,
        project_id=project_id,
        query_id=query_ids[0],
        total_mentions=total_mentions,
        bw_calls_used=bw_calls_used,
        doc_id=doc_id,
    )
    return DeepDiveOutcome(
        doc_id=doc_id,
        doc_url=doc_url,
        thread_summary=thread_summary,
        project_id=project_id,
        project_name=project_name,
        query_id=query_ids[0],
        query_name=query_name,
        alert_filter=alert_filter,
        bw_calls_used=bw_calls_used,
    )
