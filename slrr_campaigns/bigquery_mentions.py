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


MAX_QUERY_BYTES_BILLED = 10 * 1024 * 1024 * 1024


class BigQueryMentionsClient:
    """Reads DSD-story-selection and brandwatch_raw_mentions_base in brand-social-central-data."""

    def __init__(self, cfg: CampaignsConfig) -> None:
        self._cfg = cfg
        self._client = bigquery.Client(project=cfg.gcp_project_id, location="US")

    def preflight_check(self) -> dict[str, int]:
        """Run a lightweight metadata/freshness query on both configured mention tables."""
        sql = f"""
        SELECT
          (SELECT COUNT(1) FROM `{self._cfg.bigquery_dsd_table}`
           WHERE ingestion_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)) AS dsd_7d,
          (SELECT COUNT(1) FROM `{self._cfg.bigquery_brandwatch_table}`
           WHERE report_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)) AS brandwatch_7d
        """
        job_config = bigquery.QueryJobConfig(maximum_bytes_billed=MAX_QUERY_BYTES_BILLED)
        try:
            rows = list(self._client.query(sql, job_config=job_config).result())
        except GoogleAPICallError as exc:
            log_event(logger, logging.ERROR, "bigquery_preflight_failed", error_type=type(exc).__name__)
            raise BigQueryMentionsError(
                f"BigQuery mention table check failed: {exc}",
                table=self._cfg.bigquery_dsd_table,
            ) from exc
        if not rows:
            return {"dsd_7d": 0, "brandwatch_7d": 0}
        row = rows[0]
        return {
            "dsd_7d": int(row["dsd_7d"] or 0),
            "brandwatch_7d": int(row["brandwatch_7d"] or 0),
        }

    def query_deep_dive_mentions(
        self,
        *,
        alert_name: str,
        start_iso: str,
        end_iso: str,
        query_ids: list[int] | None = None,
        limit: int = 250,
    ) -> list[dict[str, Any]]:
        """Query DSD-story-selection and brandwatch_raw_mentions_base when mentions land in BigQuery."""
        clean_name = alert_name.strip()
        qids = [int(q) for q in (query_ids or []) if q > 0]
        qid_strs = [str(q) for q in qids]
        if not clean_name and not qids:
            return []
        sql = f"""
        WITH dsd AS (
          SELECT
            1 AS is_dsd,
            url,
            snippet,
            author AS author_val,
            CAST(follower_count AS STRING) AS followers_val,
            post_time AS post_ts,
            alert_type AS engagement_tier,
            COALESCE(CAST(total_engagements AS FLOAT64), CAST(engagement_score AS FLOAT64), 0.0) AS eng_score,
            'Negative' AS sentiment_val,
            platform AS network_val,
            query_name AS product_val,
            IF(UPPER(IFNULL(alert_type, '')) = 'KOF', 'KOF', 'No') AS kof_val
          FROM `{self._cfg.bigquery_dsd_table}`
          WHERE ingestion_time >= TIMESTAMP_SUB(TIMESTAMP(@start_iso), INTERVAL 1 DAY)
            AND post_time BETWEEN TIMESTAMP(@start_iso) AND TIMESTAMP(@end_iso)
            AND (
              (@alert_name != '' AND LOWER(IFNULL(query_name, '')) = LOWER(@alert_name))
              OR query_id IN UNNEST(@query_ids)
            )
        ),
        bwm AS (
          SELECT
            0 AS is_dsd,
            post_url AS url,
            COALESCE(NULLIF(TRIM(mention_text), ''), snippet) AS snippet,
            author AS author_val,
            CAST(reachEstimate AS STRING) AS followers_val,
            published_timestamp AS post_ts,
            IF(COALESCE(engagement_score, 0) >= 50, 'HIGH', 'MODERATE') AS engagement_tier,
            COALESCE(
              CAST(
                IFNULL(like_count, 0) + IFNULL(comment_count, 0) + IFNULL(reply_count, 0)
                + IFNULL(retweet_count, 0) + IFNULL(share_count, 0) AS FLOAT64
              ),
              engagement_score,
              0.0
            ) AS eng_score,
            sentiment AS sentiment_val,
            platform AS network_val,
            product_config_name AS product_val,
            COALESCE(
              (SELECT t.name FROM UNNEST(tags) t
               WHERE STARTS_WITH(UPPER(TRIM(IFNULL(t.name, ''))), 'KOF') LIMIT 1),
              'No'
            ) AS kof_val
          FROM `{self._cfg.bigquery_brandwatch_table}`
          WHERE report_date BETWEEN DATE_SUB(DATE(TIMESTAMP(@start_iso)), INTERVAL 1 DAY)
            AND DATE_ADD(DATE(TIMESTAMP(@end_iso)), INTERVAL 7 DAY)
            AND published_timestamp BETWEEN TIMESTAMP(@start_iso) AND TIMESTAMP(@end_iso)
            AND post_url IS NOT NULL
            AND (
              (@alert_name != '' AND LOWER(IFNULL(product_config_name, '')) = LOWER(@alert_name))
              OR query_id IN UNNEST(@query_id_strs)
            )
        )
        SELECT *
        FROM (SELECT * FROM dsd UNION ALL SELECT * FROM bwm)
        WHERE url IS NOT NULL AND TRIM(url) != ''
        QUALIFY ROW_NUMBER() OVER (PARTITION BY url ORDER BY is_dsd DESC, eng_score DESC, post_ts DESC) = 1
        ORDER BY eng_score DESC NULLS LAST, post_ts DESC
        LIMIT @row_limit
        """
        job_config = bigquery.QueryJobConfig(
            maximum_bytes_billed=MAX_QUERY_BYTES_BILLED,
            query_parameters=[
                bigquery.ScalarQueryParameter("start_iso", "STRING", start_iso),
                bigquery.ScalarQueryParameter("end_iso", "STRING", end_iso),
                bigquery.ScalarQueryParameter("alert_name", "STRING", clean_name),
                bigquery.ArrayQueryParameter("query_ids", "INT64", qids),
                bigquery.ArrayQueryParameter("query_id_strs", "STRING", qid_strs),
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
                table=self._cfg.bigquery_dsd_table,
            ) from exc

        out: list[dict[str, Any]] = []
        for r in result:
            raw_url = str(r["url"] or "").strip()
            out.append(
                {
                    "url": raw_url,
                    "normalized_url": normalize_url(raw_url) or raw_url.lower(),
                    "snippet": str(r["snippet"] or "").strip(),
                    "author": str(r["author_val"] or "Unknown").strip(),
                    "followers": str(r["followers_val"] or "").strip(),
                    "published_at": r["post_ts"].isoformat() if r["post_ts"] else "",
                    "engagement_tier": str(r["engagement_tier"] or "").strip(),
                    "engagement_score": int(float(r["eng_score"] or 0)),
                    "sentiment": str(r["sentiment_val"] or "Neutral").strip(),
                    "network": str(r["network_val"] or "Social Media").strip(),
                    "product": str(r["product_val"] or "").strip(),
                    "kof_status": str(r["kof_val"] or "No").strip(),
                },
            )
        return out

    def hydrate_urls(self, urls: list[str]) -> dict[str, dict[str, Any]]:
        """Hydrate stripped text, engagementScore, KOF, and product by URL from BigQuery."""
        clean_urls = sorted({u.strip() for u in urls if u and u.strip()})
        if not clean_urls:
            return {}

        sql = f"""
        WITH dsd AS (
          SELECT
            url,
            snippet AS text_val,
            author AS author_val,
            CAST(follower_count AS STRING) AS followers_val,
            COALESCE(
              SAFE_CAST(total_engagements AS INT64),
              SAFE_CAST(engagement_score AS INT64),
              0
            ) AS eng_score,
            'Negative' AS sentiment_val,
            platform AS network_val,
            query_name AS product_val,
            IF(UPPER(IFNULL(alert_type, '')) = 'KOF', 'KOF', 'No') AS kof_val
          FROM `{self._cfg.bigquery_dsd_table}`
          WHERE ingestion_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
            AND url IN UNNEST(@target_urls)
        ),
        bwm AS (
          SELECT
            post_url AS url,
            COALESCE(NULLIF(TRIM(mention_text), ''), snippet) AS text_val,
            author AS author_val,
            CAST(reachEstimate AS STRING) AS followers_val,
            COALESCE(
              SAFE_CAST(
                IFNULL(like_count, 0) + IFNULL(comment_count, 0) + IFNULL(reply_count, 0)
                + IFNULL(retweet_count, 0) + IFNULL(share_count, 0) AS INT64
              ),
              SAFE_CAST(engagement_score AS INT64),
              0
            ) AS eng_score,
            sentiment AS sentiment_val,
            platform AS network_val,
            product_config_name AS product_val,
            COALESCE(
              (SELECT t.name FROM UNNEST(tags) t
               WHERE STARTS_WITH(UPPER(TRIM(IFNULL(t.name, ''))), 'KOF') LIMIT 1),
              'No'
            ) AS kof_val
          FROM `{self._cfg.bigquery_brandwatch_table}`
          WHERE report_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
            AND post_url IN UNNEST(@target_urls)
        )
        SELECT * FROM dsd
        UNION ALL
        SELECT * FROM bwm
        """
        job_config = bigquery.QueryJobConfig(
            maximum_bytes_billed=MAX_QUERY_BYTES_BILLED,
            query_parameters=[bigquery.ArrayQueryParameter("target_urls", "STRING", clean_urls)],
        )
        try:
            result = self._client.query(sql, job_config=job_config).result()
        except GoogleAPICallError as exc:
            log_event(logger, logging.ERROR, "bigquery_hydrate_failed", error_type=type(exc).__name__)
            raise BigQueryMentionsError(
                f"BigQuery URL hydration failed: {exc}",
                table=self._cfg.bigquery_dsd_table,
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
