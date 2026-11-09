"""Gmail campaign alert ingestion, deduplication, sheet logging, and capped Chat posting."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from .bigquery_mentions import BigQueryMentionsClient
from .config import CampaignsConfig
from .email_parser import (
    extract_campaign_id_from_email,
    format_campaign_mention_post,
    load_kof_lookup,
    parse_brandwatch_alert_email,
)
from .gemini_flows import GeminiFlows, MentionSummaryItem
from .logging_utils import log_event, strip_emojis
from .models import CampaignRecord, ParsedBrandwatchMention, RegistrySettings, TopPostedMention
from .store import CampaignStore
from .workspace import GMAIL_CAMPAIGN_QUERY, WorkspaceClients

logger = logging.getLogger(__name__)
NY_TZ = ZoneInfo("America/New_York")

CAMPAIGN_SHEET_TAB = "Mentions"
CAMPAIGN_SHEET_HEADERS: list[str] = [
    "Received Time (ET)",
    "Network",
    "Author",
    "URL",
    "Text",
    "Engagement",
    "Sentiment",
    "Gate Result",
    "Posted Message Link",
]


def _format_ny_iso(iso_utc: str) -> str:
    dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
    return dt.astimezone(NY_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")


def _today_ny() -> str:
    return datetime.now(NY_TZ).strftime("%Y-%m-%d")


def _build_chat_message_link(campaign: CampaignRecord, created_msg: dict[str, Any]) -> str:
    msg_name = str(created_msg.get("name") or "")
    if campaign.space_uri and msg_name:
        msg_id = msg_name.rsplit("/", 1)[-1]
        return f"{campaign.space_uri}/{msg_id}"
    return campaign.space_uri or msg_name


def _roll_daily_counters(campaign: CampaignRecord) -> None:
    today = _today_ny()
    if campaign.stats_day_ny != today:
        campaign.stats_day_ny = today
        campaign.mentions_today = 0
        campaign.posted_today = 0


def ingest_campaign_emails(
    *,
    cfg: CampaignsConfig,
    store: CampaignStore,
    workspace: WorkspaceClients,
    bq: BigQueryMentionsClient,
    gemini: GeminiFlows,
    settings: RegistrySettings,
    only_campaign_id: str | None = None,
) -> dict[str, int]:
    """Process unprocessed SLRR-CMP-* Gmail alert emails and post qualifying mentions."""
    label_id = workspace.ensure_gmail_label()
    query = (
        f'"SLRR-CMP-{only_campaign_id}" -label:slrr-cmp-processed'
        if only_campaign_id
        else GMAIL_CAMPAIGN_QUERY
    )
    msg_ids = workspace.search_gmail_message_ids(query, max_results=40)
    if not msg_ids:
        return {"emails": 0, "mentions_logged": 0, "mentions_posted": 0}

    kof_map = load_kof_lookup(cfg, workspace)
    grouped_mentions: dict[str, list[tuple[str, ParsedBrandwatchMention]]] = {}
    message_to_campaign: list[tuple[str, str, str]] = []

    for msg_id in msg_ids:
        mail = workspace.get_gmail_message(msg_id)
        cid, placement = extract_campaign_id_from_email(
            mail["subject"],
            mail["html_body"],
            mail["text_body"],
        )
        if not cid:
            log_event(
                logger,
                logging.WARNING,
                "campaign_email_unmapped",
                gmail_id=msg_id,
                subject=mail["subject"][:160],
            )
            workspace.mark_gmail_processed(msg_id, label_id)
            continue
        if only_campaign_id and cid != only_campaign_id:
            continue

        log_event(
            logger,
            logging.INFO,
            "campaign_email_matched",
            gmail_id=msg_id,
            campaign_id=cid,
            name_placement=placement,
        )
        raw_urls = re.findall(r"https?://[^\s<>|\"')\]]+", mail["html_body"] or mail["text_body"])
        hydrated = bq.hydrate_urls(raw_urls[:60])
        parsed_list = parse_brandwatch_alert_email(
            subject=mail["subject"],
            html_body=mail["html_body"],
            text_body=mail["text_body"],
            kof_map=kof_map,
            bq_hydration=hydrated,
        )
        grouped_mentions.setdefault(cid, [])
        for mention in parsed_list:
            grouped_mentions[cid].append((mail["received_iso"], mention))
        message_to_campaign.append((msg_id, cid, mail["received_iso"]))

    emails_done = 0
    logged_total = 0
    posted_total = 0

    for cid, items in grouped_mentions.items():
        owner = f"ingest-{cid}-{int(datetime.now(UTC).timestamp())}"
        if not store.acquire_lease("campaign", cid, owner, ttl_s=90.0):
            continue
        try:
            campaign = store.get_campaign(cid)
            if campaign is None or not campaign.sheet_id or not campaign.space_name:
                for msg_id, mapped_cid, _ts in message_to_campaign:
                    if mapped_cid == cid:
                        workspace.mark_gmail_processed(msg_id, label_id)
                        emails_done += 1
                continue

            _roll_daily_counters(campaign)
            deduped: list[tuple[str, ParsedBrandwatchMention]] = []
            for recv_iso, mention in items:
                if store.mark_mention_seen(cid, mention.normalized_url):
                    deduped.append((recv_iso, mention))

            qualifying: list[tuple[str, ParsedBrandwatchMention]] = []
            below_or_paused: list[tuple[str, ParsedBrandwatchMention, str]] = []
            allowed_sentiments = {s.lower() for s in campaign.sentiments} if campaign.sentiments else set()

            for recv_iso, mention in deduped:
                if campaign.status == "paused":
                    below_or_paused.append((recv_iso, mention, "Filtered (Paused)"))
                elif allowed_sentiments and mention.sentiment.lower() not in allowed_sentiments:
                    below_or_paused.append((recv_iso, mention, f"Filtered (Sentiment {mention.sentiment})"))
                elif mention.engagement_score < campaign.threshold:
                    below_or_paused.append(
                        (
                            recv_iso,
                            mention,
                            f"Below threshold ({mention.engagement_score} < {campaign.threshold})",
                        ),
                    )
                else:
                    qualifying.append((recv_iso, mention))

            summaries: dict[str, MentionSummaryItem] = {}
            if qualifying:
                summaries = gemini.summarize_mentions(
                    campaign_topic=campaign.query_name,
                    mentions=[m for _r, m in qualifying],
                )

            to_post = qualifying[: settings.per_tick_post_cap]
            overflow = qualifying[settings.per_tick_post_cap :]
            sheet_rows: list[list[Any]] = []

            for recv_iso, mention in to_post:
                sum_item = summaries.get(mention.normalized_url)
                one_line = sum_item.one_line_summary if sum_item else strip_emojis(mention.snippet)[:150]
                sent_lbl = sum_item.sentiment if sum_item else mention.sentiment.capitalize()
                prod_lbl = sum_item.product if sum_item else (mention.product or "General")
                chat_text = format_campaign_mention_post(
                    campaign=campaign,
                    mention=mention,
                    ai_summary=one_line,
                    sentiment_label=sent_lbl,
                    product_label=prod_lbl,
                )
                created_msg = workspace.post_message(
                    campaign.space_name,
                    chat_text,
                    idempotency_key=f"post-{cid}-{mention.normalized_url}",
                )
                msg_link = _build_chat_message_link(campaign, created_msg)
                if campaign.also_post_in_alerts_space and campaign.source_space and campaign.source_thread:
                    workspace.post_message(
                        campaign.source_space,
                        chat_text,
                        thread_name=campaign.source_thread,
                        idempotency_key=f"echo-{cid}-{mention.normalized_url}",
                    )
                sheet_rows.append(
                    [
                        _format_ny_iso(recv_iso),
                        mention.network,
                        mention.author,
                        mention.url,
                        mention.snippet,
                        mention.engagement_score,
                        sent_lbl,
                        "Posted",
                        msg_link,
                    ],
                )
                posted_total += 1
                campaign.posted_today += 1
                campaign.total_posted += 1
                campaign.top_posted.append(
                    TopPostedMention(
                        url=mention.url,
                        author=mention.author,
                        network=mention.network,
                        engagement=mention.engagement_score,
                        summary=one_line,
                    ),
                )

            if overflow:
                overflow_msg = (
                    f"{len(overflow)} additional qualifying mentions met threshold "
                    f"(>= {campaign.threshold}) this tick. Full list in campaign sheet: {campaign.sheet_url}"
                )
                workspace.post_message(
                    campaign.space_name,
                    overflow_msg,
                    idempotency_key=f"overflow-{cid}-{int(datetime.now(UTC).timestamp())}",
                )
                for recv_iso, mention in overflow:
                    sum_item = summaries.get(mention.normalized_url)
                    sent_lbl = sum_item.sentiment if sum_item else mention.sentiment.capitalize()
                    sheet_rows.append(
                        [
                            _format_ny_iso(recv_iso),
                            mention.network,
                            mention.author,
                            mention.url,
                            mention.snippet,
                            mention.engagement_score,
                            sent_lbl,
                            "Qualified (Overflow to sheet)",
                            "",
                        ],
                    )

            for recv_iso, mention, reason in below_or_paused:
                sheet_rows.append(
                    [
                        _format_ny_iso(recv_iso),
                        mention.network,
                        mention.author,
                        mention.url,
                        mention.snippet,
                        mention.engagement_score,
                        mention.sentiment,
                        reason,
                        "",
                    ],
                )

            if sheet_rows:
                workspace.append_sheet_rows(
                    campaign.sheet_id,
                    f"'{CAMPAIGN_SHEET_TAB}'!A:I",
                    sheet_rows,
                )
                logged_total += len(sheet_rows)
                campaign.total_received += len(sheet_rows)
                if campaign.query_origin == "existing":
                    campaign.mentions_today += len(sheet_rows)

            campaign.top_posted.sort(key=lambda x: x.engagement, reverse=True)
            campaign.top_posted = campaign.top_posted[:10]
            now_iso = datetime.now(UTC).isoformat()
            latest_recv = max(
                (ts for msg_id, mcid, ts in message_to_campaign if mcid == cid),
                default=now_iso,
            )
            campaign.last_email_utc = latest_recv
            campaign.last_activity_utc = now_iso
            campaign.updated_at_utc = now_iso
            store.save_campaign(campaign)

            for msg_id, mapped_cid, _ts in message_to_campaign:
                if mapped_cid == cid:
                    workspace.mark_gmail_processed(msg_id, label_id)
                    emails_done += 1
        finally:
            store.release_lease("campaign", cid, owner)

    return {
        "emails": emails_done,
        "mentions_logged": logged_total,
        "mentions_posted": posted_total,
    }
