"""Ground truth lookup against the real BigQuery tables in bsip-s-bsip-gg-26-2cf3.google_bg
(us-central1) and brand-social-central-data.slrr_alerts (US).

Used to fill fields a Burson alert left blank or verify author, followers, engagement parts,
Sonar summary, post content, exposure tag, risk tags, and KOF lists.
"""

import logging
import re
from typing import Any

from ..config import AgentConfig

log = logging.getLogger(__name__)

FILL_COLUMNS = {
    "author": "author",
    "author_handle": "author",
    "creator_handle": "author",
    "followers": "followers",
    "creator_followers": "followers",
    "likes": "likes",
    "comments": "comments",
    "shares": "shares",
    "shares_rts": "shares",
    "views": "views",
    "total_engagement": "total_engagement",
    "engagement_count": "total_engagement",
    "engagements_actual": "total_engagement",
    "engagement_level": "engagement_level",
    "sonar_summary": "summary",
    "summary": "summary",
    "overview": "summary",
    "overview_of_post": "summary",
    "post_content": "post_content",
    "aggregated_content": "post_content",
    "content": "post_content",
    "original_post": "post_content",
    "snippet": "post_content",
    "issue_name": "issue_name",
    "exposure_tag": "exposure_tag",
    "product": "product",
    "kof_lists": "kof_lists",
    "kof_vertical": "kof_lists",
    "viral_kof": "kof_lists",
    "risk_tags": "risk_tags",
    "sensitive_topic": "risk_tags",
    "risk_tag": "risk_tags",
    "channel_location": "location",
}

_STATUS_ID_RE = re.compile(
    r"(?:/status/(\d{10,})|[?&]v=([A-Za-z0-9_-]{8,})|/shorts/([A-Za-z0-9_-]{8,})|/video/(\d{10,})|/p/([A-Za-z0-9_-]{6,})|/comments/([A-Za-z0-9_]{5,}))"
)


def _candidate_urls(post_url: str) -> tuple[list[str], str]:
    raw = (post_url or "").strip()
    if not raw:
        return [], ""
    base = raw.split("?", 1)[0].rstrip("/")
    candidates = [raw, base]
    for src, dst in (("https://x.com/", "https://twitter.com/"), ("https://twitter.com/", "https://x.com/")):
        if raw.startswith(src):
            candidates.append(dst + raw[len(src):])
        if base.startswith(src):
            candidates.append(dst + base[len(src):])
    seen: list[str] = []
    for u in candidates:
        if u and u not in seen:
            seen.append(u)
    m = _STATUS_ID_RE.search(raw)
    token = next((g for g in (m.groups() if m else ()) if g), "")
    return seen, token


def _normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for int_col in ("followers", "creator_followers", "likes", "comments", "shares", "shares_rts", "views",
                    "total_engagement", "engagement_count", "engagements_actual"):
        val = out.get(int_col)
        if val is not None and val != "":
            try:
                out[int_col] = int(float(val))
            except (TypeError, ValueError):
                pass
    if out.get("total_engagement") in (None, ""):
        likes = out.get("likes")
        comments = out.get("comments")
        shares = out.get("shares") if out.get("shares") is not None else out.get("shares_rts")
        if any(isinstance(x, int) for x in (likes, comments, shares)):
            out["total_engagement"] = int(likes or 0) + int(comments or 0) + int(shares or 0)
    if not out.get("exposure_tag") and isinstance(out.get("smart_tags"), list) and out["smart_tags"]:
        out["exposure_tag"] = out["smart_tags"][0]
    for list_col in ("kof_vertical", "viral_kof", "sensitive_topic", "risk_tag"):
        val = out.get(list_col)
        if isinstance(val, str):
            cleaned = val.strip()
            if cleaned.lower() in ("", "no", "none", "-", "n/a"):
                out[list_col] = []
            else:
                out[list_col] = [p.strip() for p in cleaned.split(",") if p.strip()]
    return out


class SonarLookup:
    def __init__(self, config: AgentConfig):
        from google.cloud import bigquery  # lazy import

        self.cfg = config.sonar_lookup
        self.bq = bigquery
        project = getattr(self.cfg, "project", None) or "brand-social-central-data"
        self.client = bigquery.Client(project=project, location=self.cfg.location)
        self.client_us = bigquery.Client(project=project, location="US")

    def by_post_url(self, post_url: str) -> dict[str, Any] | None:
        bq = self.bq
        urls, token = _candidate_urls(post_url)
        if not urls:
            return None
        params = [
            bq.ArrayQueryParameter("urls", "STRING", urls),
            bq.ScalarQueryParameter("url", "STRING", urls[0]),
            bq.ScalarQueryParameter("token", "STRING", token),
            bq.ScalarQueryParameter("days", "INT64", self.cfg.lookback_days),
        ]
        labels = {"app": "slrr-triage-agent", "component": "sonar-lookup"}

        # 1. Primary: bsip-s-bsip-gg-26-2cf3.google_bg.sonar_post_aggregates_7d_materialized (us-central1)
        if self.cfg.table and "sonar_post_aggregates" in self.cfg.table:
            sql_sonar = (
                f"SELECT post_id, post_url, post_timestamp, platform, language, author, followers, "
                f"summary, issue_name, relevance_score, criticality, likes, comments, shares, views, "
                f"smart_alert_names, smart_tags, aggregated_content, first_received_at, last_received_at "
                f"FROM `{self.cfg.table}` "
                f"WHERE post_url IN UNNEST(@urls) OR (@token != '' AND STRPOS(post_url, @token) > 0) "
                f"ORDER BY last_received_at DESC LIMIT 1"
            )
            try:
                job = self.client.query(sql_sonar, job_config=bq.QueryJobConfig(query_parameters=params, labels=labels))
                rows = [dict(r.items()) for r in job.result()]
                if rows:
                    return _normalize_row(rows[0])
            except Exception:  # noqa: BLE001
                log.warning("Primary sonar lookup failed on %s", self.cfg.table, exc_info=True)

        # 2. Secondary: bsip-s-bsip-gg-26-2cf3.google_bg.collection_alerts (or configured alert_log_table)
        if self.cfg.alert_log_table:
            url_col = "url" if self.cfg.alert_log_table.endswith(".collection_alerts") else "post_url"
            order_col = "created_at" if url_col == "url" else "alerted_at"
            where_clause = (
                f"{url_col} IN UNNEST(@urls) OR (@token != '' AND STRPOS({url_col}, @token) > 0)"
                if url_col == "url"
                else "post_url = @url AND alerted_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)"
            )
            sql_log = f"SELECT * FROM `{self.cfg.alert_log_table}` WHERE {where_clause} ORDER BY {order_col} DESC LIMIT 1"
            try:
                job = self.client.query(sql_log, job_config=bq.QueryJobConfig(query_parameters=params, labels=labels))
                rows = [dict(r.items()) for r in job.result()]
                if rows:
                    return _normalize_row(rows[0])
            except Exception:  # noqa: BLE001
                log.warning("Secondary alert-log lookup failed on %s", self.cfg.alert_log_table,
                            exc_info=True)

        # 3. Tertiary: brand-social-central-data.slrr_alerts.slrr_alerts (US multi-region)
        slrr_table = getattr(self.cfg, "slrr_table", "")
        if slrr_table:
            sql_slrr = (
                f"SELECT * FROM `{slrr_table}` "
                f"WHERE url IN UNNEST(@urls) OR (@token != '' AND STRPOS(url, @token) > 0) "
                f"ORDER BY ingestion_timestamp DESC LIMIT 1"
            )
            try:
                job = self.client_us.query(sql_slrr, job_config=bq.QueryJobConfig(query_parameters=params, labels=labels))
                rows = [dict(r.items()) for r in job.result()]
                if rows:
                    return _normalize_row(rows[0])
            except Exception:  # noqa: BLE001
                log.warning("Tertiary slrr_alerts lookup failed on %s", slrr_table, exc_info=True)

        return None

    def missing_fields(self, fields: dict[str, Any]) -> dict[str, Any]:
        """Values for fields the alert left blank (empty dict when no record / on errors)."""
        url = fields.get("post_url")
        if not url:
            return {}
        try:
            row = self.by_post_url(str(url))
        except Exception:  # noqa: BLE001 - ground truth is optional
            log.exception("Sonar lookup failed")
            return {}
        if not row:
            return {}
        row = _normalize_row(row)
        filled: dict[str, Any] = {}
        for col, name in FILL_COLUMNS.items():
            if name in filled:
                continue
            if row.get(col) not in (None, "", []) and fields.get(name) in (None, "", []):
                filled[name] = row[col]
        return filled


def get_sonar_lookup(config: AgentConfig) -> SonarLookup | None:
    if not config.sonar_lookup.enabled:
        return None
    try:
        return SonarLookup(config)
    except Exception:  # noqa: BLE001
        log.exception("Sonar lookup unavailable")
        return None


__all__ = ["SonarLookup", "get_sonar_lookup"]
