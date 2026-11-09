"""BigQuery mention reader for deep dives and stripped-text / engagement hydration."""

from __future__ import annotations

import logging
from typing import Any

from google.api_core.exceptions import GoogleAPICallError
from google.cloud import bigquery
from triage_agent.qa.record_key import normalize_url

from .config import CampaignsConfig
from .logging_utils import log_event

logger = logging.getLogger(__name__)


class BigQueryMentionsError(RuntimeError):
    """Raised when a BigQuery mention lookup fails."""

    def __init__(self, message: str, *, table: str) -> None:
        super().__init__(message)
        self.table = table


class BigQueryMentionsClient:
    """Reads all_sundar_mentions and brandwatch_mentions in brand-social-central-data."""

    def __init__(self, cfg: CampaignsConfig) -> None:
        self._cfg = cfg
        self._client = bigquery.Client(project=cfg.gcp_project_id)

    def preflight_check(self) -> dict[str, int]:
        """Run a lightweight metadata/freshness query on both configured mention tables."""
        sql = f"""
        SELECT
          (SELECT COUNT(1) FROM `{self._cfg.bigquery_sundar_table}`
           WHERE ingestionTimestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)) AS sundar_7d,
          (SELECT COUNT(1) FROM `{self._cfg.bigquery_brandwatch_table}`) AS brandwatch_total
        """
        try:
            rows = list(self._client.query(sql).result())
        except GoogleAPICallError as exc:
            log_event(logger, logging.ERROR, "bigquery_preflight_failed", error_type=type(exc).__name__)
            raise BigQueryMentionsError(
                f"BigQuery mention table check failed: {exc}",
                table=self._cfg.bigquery_sundar_table,
            ) from exc
        if not rows:
            return {"sundar_7d": 0, "brandwatch_total": 0}
        row = rows[0]
        return {
            "sundar_7d": int(row["sundar_7d"] or 0),
            "brandwatch_total": int(row["brandwatch_total"] or 0),
        }

    def query_deep_dive_mentions(
        self,
        *,
        alert_name: str,
        start_iso: str,
        end_iso: str,
        limit: int = 250,
    ) -> list[dict[str, Any]]:
        """Query all_sundar_mentions when an alert's mentions land directly in BigQuery."""
        if not alert_name.strip():
            return []
        sql = f"""
        SELECT
          url,
          snippet,
          authorHandle,
          followers,
          postTime,
          engagement,
          engagementScore,
          Sentiment,
          SocialNetwork,
          product,
          KOF
        FROM `{self._cfg.bigquery_sundar_table}`
        WHERE ingestionTimestamp >= TIMESTAMP_SUB(TIMESTAMP(@start_iso), INTERVAL 1 DAY)
          AND postTime BETWEEN TIMESTAMP(@start_iso) AND TIMESTAMP(@end_iso)
          AND LOWER(alert_source) = LOWER(@alert_name)
        ORDER BY SAFE_CAST(engagementScore AS FLOAT64) DESC NULLS LAST, postTime DESC
        LIMIT @row_limit
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("start_iso", "STRING", start_iso),
                bigquery.ScalarQueryParameter("end_iso", "STRING", end_iso),
                bigquery.ScalarQueryParameter("alert_name", "STRING", alert_name.strip()),
                bigquery.ScalarQueryParameter("row_limit", "INT64", limit),
            ],
        )
        try:
            result = self._client.query(sql, job_config=job_config).result()
        except GoogleAPICallError as exc:
            log_event(
                logger,
                logging.ERROR,
                "bigquery_deep_dive_failed",
                alert_name=alert_name,
                error_type=type(exc).__name__,
            )
            raise BigQueryMentionsError(
                f"BigQuery deep-dive query failed: {exc}",
                table=self._cfg.bigquery_sundar_table,
            ) from exc

        out: list[dict[str, Any]] = []
        for r in result:
            raw_url = str(r["url"] or "").strip()
            out.append(
                {
                    "url": raw_url,
                    "normalized_url": normalize_url(raw_url) or raw_url.lower(),
                    "snippet": str(r["snippet"] or "").strip(),
                    "author": str(r["authorHandle"] or "Unknown").strip(),
                    "followers": str(r["followers"] or "").strip(),
                    "published_at": r["postTime"].isoformat() if r["postTime"] else "",
                    "engagement_tier": str(r["engagement"] or "").strip(),
                    "engagement_score": int(float(r["engagementScore"] or 0)),
                    "sentiment": str(r["Sentiment"] or "Neutral").strip(),
                    "network": str(r["SocialNetwork"] or "Social Media").strip(),
                    "product": str(r["product"] or "").strip(),
                    "kof_status": str(r["KOF"] or "No").strip(),
                },
            )
        return out

    def hydrate_urls(self, urls: list[str]) -> dict[str, dict[str, Any]]:
        """Hydrate stripped text, engagementScore, KOF, and product by URL from BigQuery."""
        clean_urls = sorted({u.strip() for u in urls if u and u.strip()})
        if not clean_urls:
            return {}

        sql = f"""
        WITH sundar AS (
          SELECT
            url,
            snippet AS text_val,
            authorHandle AS author_val,
            followers AS followers_val,
            SAFE_CAST(engagementScore AS INT64) AS eng_score,
            Sentiment AS sentiment_val,
            SocialNetwork AS network_val,
            product AS product_val,
            KOF AS kof_val
          FROM `{self._cfg.bigquery_sundar_table}`
          WHERE ingestionTimestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
            AND url IN UNNEST(@target_urls)
        ),
        bw_arch AS (
          SELECT
            url,
            COALESCE(NULLIF(full_text, ''), snippet) AS text_val,
            COALESCE(NULLIF(author_Clean, ''), author) AS author_val,
            '' AS followers_val,
            SAFE_CAST(engagement_total AS INT64) AS eng_score,
            sentiment AS sentiment_val,
            page_type AS network_val,
            '' AS product_val,
            'No' AS kof_val
          FROM `{self._cfg.bigquery_brandwatch_table}`
          WHERE url IN UNNEST(@target_urls)
        )
        SELECT * FROM sundar
        UNION ALL
        SELECT * FROM bw_arch
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ArrayQueryParameter("target_urls", "STRING", clean_urls)],
        )
        try:
            result = self._client.query(sql, job_config=job_config).result()
        except GoogleAPICallError as exc:
            log_event(logger, logging.ERROR, "bigquery_hydrate_failed", error_type=type(exc).__name__)
            raise BigQueryMentionsError(
                f"BigQuery URL hydration failed: {exc}",
                table=self._cfg.bigquery_sundar_table,
            ) from exc

        by_norm: dict[str, dict[str, Any]] = {}
        for r in result:
            raw_url = str(r["url"] or "").strip()
            norm = normalize_url(raw_url) or raw_url.lower()
            existing = by_norm.get(norm)
            snippet_val = str(r["text_val"] or "").strip()
            candidate: dict[str, Any] = {
                "url": raw_url,
                "snippet": snippet_val,
                "author": str(r["author_val"] or "").strip(),
                "followers": str(r["followers_val"] or "").strip(),
                "engagement_score": int(r["eng_score"] or 0),
                "sentiment": str(r["sentiment_val"] or "").strip(),
                "network": str(r["network_val"] or "").strip(),
                "product": str(r["product_val"] or "").strip(),
                "kof_status": str(r["kof_val"] or "No").strip(),
            }
            if existing is None or len(snippet_val) > len(str(existing.get("snippet") or "")):
                by_norm[norm] = candidate
        return by_norm
