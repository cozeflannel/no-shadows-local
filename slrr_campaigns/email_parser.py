"""Brandwatch Custom Alert email parser, engagement scorer, KOF lookup, and message formatter."""

from __future__ import annotations

import html
import re
from typing import Any

from triage_agent.qa.record_key import extract_url, normalize_url

from .config import CampaignsConfig
from .logging_utils import strip_emojis
from .models import CampaignRecord, ParsedBrandwatchMention
from .workspace import WorkspaceClients

CAMPAIGN_ID_IN_EMAIL_RE = re.compile(r"SLRR-CMP-([A-Z0-9]+)", re.IGNORECASE)
TIER_RE = re.compile(r"\[(VERY\s+LOW|LOW|MODERATE|HIGH)\]", re.IGNORECASE)
EXPLICIT_ENG_RE = re.compile(r"(\d[\d,]*)\s+engagements?\b", re.IGNORECASE)

TIER_FLOORS: dict[str, int] = {
    "VERY LOW": 0,
    "LOW": 200,
    "MODERATE": 500,
    "HIGH": 2000,
}

TIER_LABELS: dict[str, str] = {
    "VERY LOW": "Very Low (0-199)",
    "LOW": "Low (200-499)",
    "MODERATE": "Moderate (500-1999)",
    "HIGH": "High (2000+)",
}

KOF_TABS: tuple[tuple[str, int, int], ...] = (
    ("Chrome | Internal Follows", 1, 2),
    ("Chrome | KOFs from SLRR data", 1, 4),
    ("Chrome | Googlers, PR Voices and Top Influencers", 1, 4),
)


def extract_campaign_id_from_email(subject: str, html_body: str, text_body: str = "") -> tuple[str, str]:
    """Return (campaign_id, placement) where placement is 'subject', 'body', or ''."""
    subj_match = CAMPAIGN_ID_IN_EMAIL_RE.search(subject or "")
    if subj_match:
        return subj_match.group(1).upper(), "subject"
    body_match = CAMPAIGN_ID_IN_EMAIL_RE.search(html_body or "") or CAMPAIGN_ID_IN_EMAIL_RE.search(
        text_body or "",
    )
    if body_match:
        return body_match.group(1).upper(), "body"
    return "", ""


def extract_engagement_tier(subject: str, html_body: str) -> str:
    """Extract Brandwatch engagement tier [VERY LOW|LOW|MODERATE|HIGH] from subject or HTML body."""
    for source in (subject, html_body):
        if not source:
            continue
        match = TIER_RE.search(source)
        if match:
            raw = re.sub(r"\s+", " ", match.group(1).upper()).strip()
            if raw in TIER_FLOORS:
                return raw
    return "VERY LOW"


def format_engagement_tier(tier: str) -> str:
    """Format canonical engagement tier display text matching v1 Chrome Alerts."""
    key = re.sub(r"\s+", " ", (tier or "").upper()).strip()
    return TIER_LABELS.get(key, "Very Low (0-199)")


def detect_platform(url: str) -> str:
    """Detect social platform name from mention URL."""
    lower = (url or "").lower()
    if "x.com" in lower or "twitter.com" in lower:
        return "X"
    if "facebook.com" in lower:
        return "Facebook"
    if "instagram.com" in lower:
        return "Instagram"
    if "reddit.com" in lower or "redd.it" in lower:
        return "Reddit"
    if "bsky.app" in lower:
        return "Bluesky"
    if "youtube.com" in lower or "youtu.be" in lower:
        return "YouTube"
    if "tiktok.com" in lower:
        return "TikTok"
    if "threads.net" in lower or "threads.com" in lower:
        return "Threads"
    if "linkedin.com" in lower:
        return "LinkedIn"
    return "Online News"


def _strip_html(raw_html: str) -> str:
    no_comments = re.sub(r"<!--[\s\S]*?-->", "", raw_html)
    no_tags = re.sub(r"<[^>]+>", " ", no_comments)
    decoded = html.unescape(no_tags)
    return re.sub(r"\s+", " ", decoded).strip()


def compute_mention_engagement(
    *,
    tier: str,
    block_html: str = "",
    bq_row: dict[str, Any] | None = None,
    api_row: dict[str, Any] | None = None,
) -> int:
    """Compute numeric engagement from BigQuery, Brandwatch API fields, explicit text, or tier floor."""
    if bq_row and int(bq_row.get("engagement_score") or 0) > 0:
        return int(bq_row["engagement_score"])

    if api_row:
        direct = int(float(api_row.get("engagementScore") or 0))
        summed = sum(
            int(api_row.get(field) or 0)
            for field in (
                "twitterRetweets",
                "twitterLikeCount",
                "twitterReplyCount",
                "facebookLikes",
                "facebookComments",
                "facebookShares",
                "instagramInteractionsCount",
                "linkedinEngagement",
            )
        )
        if max(direct, summed) > 0:
            return max(direct, summed)

    if block_html:
        plain = _strip_html(block_html)
        exp_match = EXPLICIT_ENG_RE.search(plain)
        if exp_match:
            return int(exp_match.group(1).replace(",", ""))

    key = re.sub(r"\s+", " ", (tier or "").upper()).strip()
    return TIER_FLOORS.get(key, 0)


def load_kof_lookup(cfg: CampaignsConfig, workspace: WorkspaceClients) -> dict[str, str]:
    """Load handle -> KOF affiliation mapping from the shared KOF Google Sheet."""
    lookup: dict[str, str] = {}
    for tab_name, handle_idx, affil_idx in KOF_TABS:
        rows = workspace.read_sheet_values(cfg.kof_spreadsheet_id, f"'{tab_name}'!A2:E")
        for row in rows:
            if len(row) <= handle_idx:
                continue
            handle = row[handle_idx].strip().lstrip("@").lower()
            if not handle:
                continue
            affil = row[affil_idx].strip() if len(row) > affil_idx and row[affil_idx].strip() else "Yes"
            lookup[handle] = affil
    return lookup


def lookup_kof_status(author_handle: str, kof_map: dict[str, str]) -> str:
    """Resolve KOF status for an author handle."""
    clean = (author_handle or "").strip().lstrip("@").lower()
    if not clean or clean == "unknown":
        return "No"
    return kof_map.get(clean, "No")


def parse_brandwatch_alert_email(
    *,
    subject: str,
    html_body: str,
    text_body: str = "",
    kof_map: dict[str, str] | None = None,
    bq_hydration: dict[str, dict[str, Any]] | None = None,
) -> list[ParsedBrandwatchMention]:
    """Parse mentions from a Brandwatch Custom Alert email (featured-content or legacy template)."""
    tier = extract_engagement_tier(subject, html_body)
    seen_norms: set[str] = set()
    mentions: list[ParsedBrandwatchMention] = []
    kof = kof_map or {}
    hydration = bq_hydration or {}

    is_featured = bool(
        re.search(r'<table[^>]*class=["\'][^"\']*featured-content', html_body or "", re.IGNORECASE)
        or re.search(r'class=["\'][^"\']*featured-content-container', html_body or "", re.IGNORECASE),
    )

    blocks: list[tuple[str, str, str, str]] = []
    if is_featured and html_body:
        starts = [
            m.start()
            for m in re.finditer(
                r'<table[^>]*class=["\'][^"\']*featured-content[^"\']*["\']',
                html_body,
                re.IGNORECASE,
            )
        ]
        if starts:
            tail = html_body[starts[-1] :]
            footer_m = re.search(
                r'<table[^>]*class=["\'][^"\']*alerts-settings[^"\']*["\']',
                tail,
                re.IGNORECASE,
            )
            last_end = starts[-1] + footer_m.start() if footer_m else len(html_body)
            for idx, start in enumerate(starts):
                end = starts[idx + 1] if idx + 1 < len(starts) else last_end
                blk = html_body[start:end]
                link_m = re.search(
                    r'<a[^>]*class=["\'][^"\']*open-link[^"\']*["\'][^>]*href=["\']([^"\']+)["\']',
                    blk,
                    re.IGNORECASE,
                ) or re.search(r'href=["\'](https?://[^"\']+)["\']', blk, re.IGNORECASE)
                if not link_m:
                    continue
                raw_url = html.unescape(link_m.group(1).strip())
                author_handle = "Unknown"
                followers = "0" if detect_platform(raw_url) == "X" else "N/A"
                auth_m = re.search(
                    r'<h5[^>]*class=["\'][^"\']*author[^"\']*["\'][^>]*>([\s\S]*?)</h5>',
                    blk,
                    re.IGNORECASE,
                )
                if auth_m:
                    raw_auth = re.sub(r"<!--[\s\S]*?-->", "", auth_m.group(1)).strip()
                    lines = [
                        _strip_html(part)
                        for part in re.split(r"<br\s*/?>", raw_auth, flags=re.IGNORECASE)
                        if _strip_html(part)
                    ]
                    target_line = lines[-1] if len(lines) > 1 else _strip_html(raw_auth)
                    handle_m = re.search(r"@([A-Za-z0-9_.-]+)", target_line) or re.search(
                        r"@([A-Za-z0-9_.-]+)",
                        raw_auth,
                    )
                    if handle_m:
                        author_handle = f"@{handle_m.group(1)}"
                    elif lines:
                        author_handle = lines[0]
                    foll_m = re.search(r"([\d.,]+\s*[kKmM]?\s*Followers?)\b", raw_auth, re.IGNORECASE)
                    if foll_m:
                        followers = foll_m.group(1).strip()
                if author_handle == "Unknown":
                    x_handle = re.search(r"(?:twitter|x)\.com/([^/?#\s]+)", raw_url, re.IGNORECASE)
                    if x_handle:
                        author_handle = f"@{x_handle.group(1)}"
                ext_m = re.search(
                    r'<td[^>]*class=["\'][^"\']*extract[^"\']*["\'][^>]*>([\s\S]*?)</td>',
                    blk,
                    re.IGNORECASE,
                )
                snippet = _strip_html(ext_m.group(1)) if ext_m else ""
                blocks.append((raw_url, author_handle, followers, snippet or blk))
    elif html_body:
        for legacy_m in re.finditer(
            r'<table[^>]*class=["\']mentions["\'][\s\S]*?</table>',
            html_body,
            re.IGNORECASE,
        ):
            blk = legacy_m.group(0)
            url_m = re.search(
                r'href=["\'](https?://(?:twitter|x)\.com/[^"\']+)["\']',
                blk,
                re.IGNORECASE,
            ) or re.search(r'href=["\'](https?://[^"\']+)["\']', blk, re.IGNORECASE)
            if not url_m:
                continue
            raw_url = html.unescape(url_m.group(1).strip())
            snip_m = re.search(r'class=["\']mention["\'][^>]*>([\s\S]*?)</span>', blk, re.IGNORECASE)
            snippet = _strip_html(snip_m.group(1)) if snip_m else ""
            x_handle = re.search(r"(?:twitter|x)\.com/([^/?#\s]+)", raw_url, re.IGNORECASE)
            author_handle = f"@{x_handle.group(1)}" if x_handle else "Unknown"
            foll_m = re.search(r">\s*([\d.MkK,]+\s*Followers?)\s*</span>", blk, re.IGNORECASE)
            followers = (
                foll_m.group(1).strip() if foll_m else ("0" if detect_platform(raw_url) == "X" else "N/A")
            )
            blocks.append((raw_url, author_handle, followers, snippet))

    if not blocks and text_body:
        first_url = extract_url(text_body)
        if first_url:
            blocks.append((first_url, "Unknown", "N/A", text_body[:500].strip()))

    for raw_url, author_handle, followers, snippet_val in blocks:
        norm = normalize_url(raw_url)
        if not norm or norm in seen_norms:
            continue
        seen_norms.add(norm)
        bq = hydration.get(norm)
        network = (bq.get("network") if bq and bq.get("network") else "") or detect_platform(raw_url)
        final_author = author_handle
        if (not final_author or final_author == "Unknown") and bq and bq.get("author"):
            final_author = str(bq["author"])
        final_snippet = snippet_val if snippet_val and snippet_val != "No snippet" else ""
        if (not final_snippet or len(final_snippet) < 40) and bq and bq.get("snippet"):
            final_snippet = str(bq["snippet"])
        if not final_snippet:
            final_snippet = f"Metadata-only mention on {network} by {final_author}"

        sentiment = str(bq["sentiment"]).capitalize() if bq and bq.get("sentiment") else "Neutral"
        kof_val = lookup_kof_status(final_author, kof)
        if kof_val == "No" and bq and str(bq.get("kof_status") or "No").lower() != "no":
            kof_val = str(bq["kof_status"])
        eng_score = compute_mention_engagement(tier=tier, block_html=snippet_val, bq_row=bq)

        mentions.append(
            ParsedBrandwatchMention(
                url=raw_url,
                normalized_url=norm,
                network=network,
                author=final_author,
                followers=str(bq["followers"]) if bq and bq.get("followers") else followers,
                snippet=strip_emojis(final_snippet)[:900],
                sentiment=sentiment,
                engagement_tier=tier,
                engagement_score=eng_score,
                kof_status=kof_val,
                product=str(bq.get("product") or "") if bq else "",
            ),
        )
    return mentions


def extract_alert_context_from_chat(alert_text: str) -> dict[str, str]:
    """Extract alert name, product, URL, and issue summary from an alerts-space thread root."""
    text = strip_emojis(alert_text or "")
    name_m = re.search(r"\[Name\]:\s*([^\r\n]+)", text, re.IGNORECASE)
    prod_m = re.search(r"\[Product\]:\s*([^\r\n]+)", text, re.IGNORECASE)
    subj_m = re.search(r"Subject:\s*([^\r\n]+)", text, re.IGNORECASE)
    header_m = re.search(r"SOCIAL ALERT[^:]*:\s*([^\r\n]+)", text, re.IGNORECASE)
    url = extract_url(text) or ""
    alert_name = ""
    if name_m:
        alert_name = name_m.group(1).split("/")[0].strip()
    elif subj_m:
        alert_name = subj_m.group(1).strip()
    elif header_m:
        parts = [p.strip() for p in header_m.group(1).split("|")]
        alert_name = parts[1] if len(parts) > 1 else parts[0]
    product = prod_m.group(1).strip() if prod_m else ""
    return {
        "alert_name": alert_name,
        "product": product,
        "url": url,
        "raw_text": text[:3000],
    }


def format_campaign_mention_post(
    *,
    campaign: CampaignRecord,
    mention: ParsedBrandwatchMention,
    ai_summary: str,
    sentiment_label: str,
    product_label: str,
) -> str:
    """Format a qualifying campaign mention in the alerts layout with zero emojis and focused header."""
    tier_text = format_engagement_tier(mention.engagement_tier)
    alert_title = (
        f"*{strip_emojis(mention.network)} Alert: "
        f"{strip_emojis(campaign.query_name)} ({strip_emojis(sentiment_label)})*"
    )
    lines: list[str] = [
        f"*[FOCUSED DEEP DIVE: {strip_emojis(campaign.space_display_name)} | {campaign.campaign_id}]*",
        alert_title,
        "",
        f"*Author:* {strip_emojis(mention.author)}",
        f"*Network:* {strip_emojis(mention.network)}",
    ]
    if mention.network == "X" and mention.followers and mention.followers != "N/A":
        lines.append(f"*Followers:* {strip_emojis(mention.followers)}")
    lines.extend(
        [
            f"*KOF Status:* {strip_emojis(mention.kof_status or 'No')}",
            f"*Product:* {strip_emojis(product_label or mention.product or 'General')}",
            f"*Engagement:* {tier_text} ({mention.engagement_score})",
            f"*Sentiment:* {strip_emojis(sentiment_label)}",
            f"*AI Summary:* {strip_emojis(ai_summary)}",
            f'*Text:* _"{strip_emojis(mention.snippet)[:500]}"_',
            "",
            f"<{mention.url}|Click to view post>",
        ],
    )
    return "\n".join(lines)
