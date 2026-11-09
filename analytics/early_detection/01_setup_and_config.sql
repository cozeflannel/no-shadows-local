-- =============================================================================
-- 01_setup_and_config.sql
-- Dataset, remote Vertex AI embedding model, parameterized thresholds, cost &
-- spike guardrails, same-story dedup settings, source feed registry, risk-term
-- taxonomy, and incremental watermarks.
-- Safe to re-run (idempotent DDL + MERGE config seed; the registry and taxonomy
-- are pipeline-owned seed tables that are re-seeded on every run of this file;
-- guardrail defaults are only filled where the value is still NULL).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS `brand-social-central-data.early_detection`
OPTIONS (
  location = 'US',
  description = 'Brand-safety low-tier early detection: embedding clustering (Cap 1) and velocity detection (Cap 2).',
  labels = [('app', 'slrr-triage-agent'), ('layer', 'early-detection')]
);

-- 1. Remote Vertex AI Embedding Model (768-dim text-embedding-005, the same endpoint as DSD.text_embedding_model,
-- which produced DSD.evergreen_vectors). Uses the project's existing `gem-connection` Cloud resource connection that
-- DSD.text_embedding_model already calls Vertex AI through.
CREATE MODEL IF NOT EXISTS `brand-social-central-data.early_detection.text_embedding_model`
REMOTE WITH CONNECTION `brand-social-central-data.us.gem-connection`
OPTIONS (
  ENDPOINT = 'text-embedding-005'
);

-- 2. Parameterized Runtime Configuration Table (no hard-coded thresholds in logic)
CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.early_detection_config` (
  config_profile                  STRING NOT NULL,
  updated_at                      TIMESTAMP NOT NULL,
  -- Low-tier subset & quality gates
  max_low_tier_audience           INT64 NOT NULL,   -- Audience/follower ceiling for low-tier accounts (e.g., 5,000)
  allow_null_audience             BOOL NOT NULL,    -- Include platforms without follower counts (e.g., Reddit)
  solo_alert_engagement_ceiling   INT64 NOT NULL,   -- Exclude posts >= ceiling already covered by single-post alerts
  min_clean_chars                 INT64 NOT NULL,   -- Reject short low-information posts (< 40 chars)
  min_token_count                 INT64 NOT NULL,   -- Reject posts with < 7 alphanumeric tokens
  same_author_dedup_hours         INT64 NOT NULL,   -- Suppress near-identical reposts by the same author within window
  ingest_overlap_minutes          INT64 NOT NULL,   -- Re-read window before the last ingest cutoff (late-landing rows)
  evergreen_max_cosine_distance   FLOAT64 NOT NULL, -- Suppress evergreen noise within cosine distance of DSD.evergreen_vectors
  -- Capability 1: Embedding clustering thresholds
  clustering_window_hours         INT64 NOT NULL,   -- Unassigned neighbor discovery lookback (e.g., 6h)
  cluster_active_horizon_hours    INT64 NOT NULL,   -- Active cluster centroid retention window (e.g., 24h)
  assign_max_cosine_distance      FLOAT64 NOT NULL, -- Max cosine distance to attach mention to an active cluster centroid
  new_cluster_max_cosine_distance FLOAT64 NOT NULL, -- Max cosine distance to seed a new cluster across distinct authors
  cluster_eval_window_minutes     INT64 NOT NULL,   -- Rolling evaluation window for noteworthy promotion (e.g., 180 min)
  min_cluster_unique_authors      INT64 NOT NULL,   -- Minimum distinct low-tier accounts to emit cluster alert
  min_cluster_platforms           INT64 NOT NULL,   -- Minimum distinct platforms (1 default; set 2 for strict cross-platform)
  cross_platform_author_discount  INT64 NOT NULL,   -- Author threshold reduction when >= 2 platforms corroborate
  cluster_cooldown_minutes        INT64 NOT NULL,   -- Cooldown before re-alerting same cluster unless authors double
  -- Capability 2: Low-tier velocity thresholds
  velocity_window_minutes         INT64 NOT NULL,   -- Sliding window for current velocity rate (e.g., 60 min)
  baseline_lookback_days          INT64 NOT NULL,   -- Same-hour-of-day diurnal baseline window (e.g., 7 days)
  short_rolling_hours             INT64 NOT NULL,   -- Short trailing rolling baseline window (e.g., 6 hours)
  smoothing_alpha_authors         FLOAT64 NOT NULL, -- Laplace floor added to baseline denominator for sparse/new claims
  min_velocity_multiplier         FLOAT64 NOT NULL, -- Alert when current_authors / smoothed_baseline >= multiplier
  min_cluster_vel_authors         INT64 NOT NULL,   -- Absolute floor of unique low-tier authors for CLUSTER velocity
  min_term_vel_authors            INT64 NOT NULL,   -- Absolute floor of unique low-tier authors for RISK_TERM_GROUP / PRIORITY_TOPIC
  hard_author_delta_spike         INT64 NOT NULL,   -- Raw unique-author jump over baseline that triggers even on high-volume topics
  velocity_cooldown_minutes       INT64 NOT NULL,
  velocity_warmup_hours           INT64 NOT NULL,   -- Hourly-rollup history required before any velocity alert (cold start)
  min_cluster_distinct_urls       INT64,            -- Distinct posts/links a cluster must span (2: a pile-up of comments on one post never alerts)
  -- Cost & spike guardrails (nullable; every procedure reads them as COALESCE(col, default), so a NULL never breaks a run)
  pipeline_enabled                BOOL,             -- Kill switch (TRUE; FALSE = every scheduled run exits after one tiny config read)
  max_backfill_hours              INT64,            -- Ingestion never reads further back than this, even after a pause/outage (12)
  max_ingest_rows_per_run         INT64,            -- NEW low-tier rows landed per run, newest first (20,000)
  max_new_embeddings_per_run      INT64,            -- AI.GENERATE_EMBEDDING rows (Vertex calls) per run (3,000)
  max_new_embeddings_per_day      INT64,            -- AI.GENERATE_EMBEDDING rows per UTC day, counted from embedding_cache.created_at (30,000)
  embedding_cache_reuse_days      INT64,            -- embedding_cache reads only scan the last N days of partitions; older texts are re-embedded (2: clustering looks back 26h at most)
  max_cluster_pool                INT64,            -- Stage B brute-force VECTOR_SEARCH pool (pool x pool), newest mentions first (15,000)
  max_alerts_per_run              INT64,            -- Cluster alerts per run and velocity alerts per run, EACH capped at this (8)
  max_bytes_billed_per_run        INT64,            -- Per-run circuit breaker checked between stages via @@script.bytes_billed (5 GiB)
  max_bytes_billed_per_day        INT64,            -- Daily circuit breaker (UTC day), summed from pipeline_run_log (200 GiB)
  cluster_retention_days          INT64,            -- Purge active_clusters rows whose last_seen_at is older than this (3)
  run_lock_minutes                INT64,            -- Skip a run while another RUNNING run started within this many minutes (30)
  -- Same-story dedup (nullable; read as COALESCE(col, default)): one story, one alert, unless it materially grew
  story_dedup_max_cosine_distance FLOAT64,          -- A cluster within this cosine distance of one alerted in the last story_dedup_hours is the same story (0.14)
  story_dedup_hours               INT64,            -- How long an alerted story holds back its repeats (24)
  story_update_min_growth         FLOAT64,          -- A repeat is queued as an update only at this multiple of the last alert's authors (2.0) ...
  story_update_min_new_authors    INT64             -- ... and at least this many more authors (3), or when it reached a platform the last alert didn't have
);

-- Columns added after the first install (nullable, so ALTER works on an existing table)
ALTER TABLE `brand-social-central-data.early_detection.early_detection_config`
  ADD COLUMN IF NOT EXISTS min_cluster_distinct_urls INT64,
  ADD COLUMN IF NOT EXISTS pipeline_enabled BOOL,
  ADD COLUMN IF NOT EXISTS max_backfill_hours INT64,
  ADD COLUMN IF NOT EXISTS max_ingest_rows_per_run INT64,
  ADD COLUMN IF NOT EXISTS max_new_embeddings_per_run INT64,
  ADD COLUMN IF NOT EXISTS max_new_embeddings_per_day INT64,
  ADD COLUMN IF NOT EXISTS embedding_cache_reuse_days INT64,
  ADD COLUMN IF NOT EXISTS max_cluster_pool INT64,
  ADD COLUMN IF NOT EXISTS max_alerts_per_run INT64,
  ADD COLUMN IF NOT EXISTS max_bytes_billed_per_run INT64,
  ADD COLUMN IF NOT EXISTS max_bytes_billed_per_day INT64,
  ADD COLUMN IF NOT EXISTS cluster_retention_days INT64,
  ADD COLUMN IF NOT EXISTS run_lock_minutes INT64,
  ADD COLUMN IF NOT EXISTS story_dedup_max_cosine_distance FLOAT64,
  ADD COLUMN IF NOT EXISTS story_dedup_hours INT64,
  ADD COLUMN IF NOT EXISTS story_update_min_growth FLOAT64,
  ADD COLUMN IF NOT EXISTS story_update_min_new_authors INT64;

MERGE `brand-social-central-data.early_detection.early_detection_config` T
USING (
  SELECT
    'prod' AS config_profile,
    CURRENT_TIMESTAMP() AS updated_at,
    5000 AS max_low_tier_audience,
    TRUE AS allow_null_audience,
    500 AS solo_alert_engagement_ceiling,
    40 AS min_clean_chars,
    7 AS min_token_count,
    24 AS same_author_dedup_hours,
    360 AS ingest_overlap_minutes,
    0.20 AS evergreen_max_cosine_distance,
    6 AS clustering_window_hours,
    24 AS cluster_active_horizon_hours,
    0.22 AS assign_max_cosine_distance,
    0.20 AS new_cluster_max_cosine_distance,
    180 AS cluster_eval_window_minutes,
    5 AS min_cluster_unique_authors,
    1 AS min_cluster_platforms,
    1 AS cross_platform_author_discount,
    360 AS cluster_cooldown_minutes,
    60 AS velocity_window_minutes,
    7 AS baseline_lookback_days,
    6 AS short_rolling_hours,
    2.0 AS smoothing_alpha_authors,
    3.0 AS min_velocity_multiplier,
    4 AS min_cluster_vel_authors,
    8 AS min_term_vel_authors,
    12 AS hard_author_delta_spike,
    180 AS velocity_cooldown_minutes,
    24 AS velocity_warmup_hours,
    2 AS min_cluster_distinct_urls,
    TRUE AS pipeline_enabled,
    12 AS max_backfill_hours,
    20000 AS max_ingest_rows_per_run,
    3000 AS max_new_embeddings_per_run,
    30000 AS max_new_embeddings_per_day,
    2 AS embedding_cache_reuse_days,
    15000 AS max_cluster_pool,
    8 AS max_alerts_per_run,
    5368709120 AS max_bytes_billed_per_run,   -- 5 GiB
    214748364800 AS max_bytes_billed_per_day, -- 200 GiB
    3 AS cluster_retention_days,
    30 AS run_lock_minutes,
    0.14 AS story_dedup_max_cosine_distance,
    24 AS story_dedup_hours,
    2.0 AS story_update_min_growth,
    3 AS story_update_min_new_authors
) S
ON T.config_profile = S.config_profile
WHEN NOT MATCHED THEN INSERT ROW;

UPDATE `brand-social-central-data.early_detection.early_detection_config`
SET min_cluster_distinct_urls = 2, updated_at = CURRENT_TIMESTAMP()
WHERE config_profile = 'prod' AND min_cluster_distinct_urls IS NULL;

-- Guardrail defaults: only fills values that are still NULL, so a tuned value (or an engaged kill switch) is never overwritten
UPDATE `brand-social-central-data.early_detection.early_detection_config`
SET
  pipeline_enabled           = COALESCE(pipeline_enabled, TRUE),
  max_backfill_hours         = COALESCE(max_backfill_hours, 12),
  max_ingest_rows_per_run    = COALESCE(max_ingest_rows_per_run, 20000),
  max_new_embeddings_per_run = COALESCE(max_new_embeddings_per_run, 3000),
  max_new_embeddings_per_day = COALESCE(max_new_embeddings_per_day, 30000),
  embedding_cache_reuse_days = COALESCE(embedding_cache_reuse_days, 2),
  max_cluster_pool           = COALESCE(max_cluster_pool, 15000),
  max_alerts_per_run         = COALESCE(max_alerts_per_run, 8),
  max_bytes_billed_per_run   = COALESCE(max_bytes_billed_per_run, 5368709120),
  max_bytes_billed_per_day   = COALESCE(max_bytes_billed_per_day, 214748364800),
  cluster_retention_days     = COALESCE(cluster_retention_days, 3),
  run_lock_minutes           = COALESCE(run_lock_minutes, 30),
  story_dedup_max_cosine_distance = COALESCE(story_dedup_max_cosine_distance, 0.14),
  story_dedup_hours               = COALESCE(story_dedup_hours, 24),
  story_update_min_growth         = COALESCE(story_update_min_growth, 2.0),
  story_update_min_new_authors    = COALESCE(story_update_min_new_authors, 3),
  updated_at                 = CURRENT_TIMESTAMP()
WHERE config_profile = 'prod'
  AND (
    pipeline_enabled IS NULL OR max_backfill_hours IS NULL OR max_ingest_rows_per_run IS NULL
    OR max_new_embeddings_per_run IS NULL OR max_new_embeddings_per_day IS NULL OR embedding_cache_reuse_days IS NULL
    OR max_cluster_pool IS NULL OR max_alerts_per_run IS NULL OR max_bytes_billed_per_run IS NULL
    OR max_bytes_billed_per_day IS NULL OR cluster_retention_days IS NULL OR run_lock_minutes IS NULL
    OR story_dedup_max_cosine_distance IS NULL OR story_dedup_hours IS NULL OR story_update_min_growth IS NULL
    OR story_update_min_new_authors IS NULL
  );

-- 3. Parameterized Source Feed Registry (maps heterogeneous landed tables without hard-coding schemas)
-- requires_entity_match = FALSE on already-Google-scoped feeds so unknown build-ups (e.g. "update bricked my phone",
-- "locked out of account", "routing onto closed road") are embedded & clustered without needing pre-known brand keywords.
-- ingested_ts_expr is the source's own ingestion / added time (incremental window); posted_ts_expr is when it was posted.
CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.source_feed_registry` (
  source_name           STRING NOT NULL,
  enabled               BOOL NOT NULL,
  requires_entity_match BOOL NOT NULL,
  table_fqn             STRING NOT NULL,
  ingested_ts_expr      STRING NOT NULL,
  posted_ts_expr        STRING NOT NULL,
  mention_id_expr       STRING NOT NULL,
  url_expr              STRING NOT NULL,
  platform_expr         STRING NOT NULL,
  author_expr           STRING NOT NULL,
  audience_expr         STRING NOT NULL,
  engagement_expr       STRING NOT NULL,
  is_kof_expr           STRING NOT NULL,
  text_expr             STRING NOT NULL,
  topic_hint_expr       STRING NOT NULL,
  extra_where_sql       STRING NOT NULL
);

DELETE FROM `brand-social-central-data.early_detection.source_feed_registry` WHERE TRUE;
INSERT INTO `brand-social-central-data.early_detection.source_feed_registry` VALUES
(
  -- all_sundar_mentions mixes many Brandwatch alert feeds. Google-scoped feeds (Chrome, Android, Search, Gemini, Google
  -- spikes, execs, policy, ...) need no keyword gate, so unknown build-ups with no brand keyword are still caught.
  'BMIE_GOOGLE_FEEDS', TRUE, FALSE,
  'brand-social-central-data.social_alerts_dataset.all_sundar_mentions',
  'ingestionTimestamp',
  'COALESCE(postTime, ingestionTimestamp)',
  'TO_HEX(SHA256(CONCAT("BMIE|", COALESCE(url, ""), "|", COALESCE(authorHandle, ""), "|", CAST(COALESCE(postTime, ingestionTimestamp) AS STRING))))',
  'url',
  'COALESCE(NULLIF(TRIM(SocialNetwork), ""), "Web")',
  'LOWER(TRIM(REGEXP_REPLACE(COALESCE(authorHandle, ""), r"^@+", "")))',
  'CAST(followers AS INT64)',
  'COALESCE(CAST(engagementScore AS INT64), 0)',
  'REGEXP_CONTAINS(COALESCE(KOF, ""), r"(?i)^(yes|true|1)|\\b(KOFs?|INFs?|KOLs?)\\b")',
  'snippet',
  'COALESCE(NULLIF(TRIM(product), ""), NULLIF(TRIM(alert_source), ""), "Unclassified")',
  'LOWER(COALESCE(Sentiment, "negative")) != "positive" AND REGEXP_CONTAINS(LOWER(TRIM(COALESCE(alert_source, ""))), r"^(chrome overall|chrome execs|chrome kofs|slrr kofs chrome mentions|this week in android|google spikes|apac google|all sundar|search|gemini|antigravity|ai digest - google|googlers posting on x|google reps & execs|v2 policy.*)$")'
),
(
  -- Broad feeds (AI digests, APAC/market listening, KOF chatter, developer AI, ...) only when the post itself names
  -- Google or a Google product; sports, culture, brand-fit and competitor-only feeds (BigQuery.gs BQ_NON_GOOGLE_SOURCES_RX_)
  -- are never read.
  'BMIE_BROAD_FEEDS', TRUE, TRUE,
  'brand-social-central-data.social_alerts_dataset.all_sundar_mentions',
  'ingestionTimestamp',
  'COALESCE(postTime, ingestionTimestamp)',
  'TO_HEX(SHA256(CONCAT("BMIE|", COALESCE(url, ""), "|", COALESCE(authorHandle, ""), "|", CAST(COALESCE(postTime, ingestionTimestamp) AS STRING))))',
  'url',
  'COALESCE(NULLIF(TRIM(SocialNetwork), ""), "Web")',
  'LOWER(TRIM(REGEXP_REPLACE(COALESCE(authorHandle, ""), r"^@+", "")))',
  'CAST(followers AS INT64)',
  'COALESCE(CAST(engagementScore AS INT64), 0)',
  'REGEXP_CONTAINS(COALESCE(KOF, ""), r"(?i)^(yes|true|1)|\\b(KOFs?|INFs?|KOLs?)\\b")',
  'snippet',
  'COALESCE(NULLIF(TRIM(product), ""), NULLIF(TRIM(alert_source), ""), "Unclassified")',
  'LOWER(COALESCE(Sentiment, "negative")) != "positive" AND NOT REGEXP_CONTAINS(LOWER(TRIM(COALESCE(alert_source, ""))), r"^(chrome overall|chrome execs|chrome kofs|slrr kofs chrome mentions|this week in android|google spikes|apac google|all sundar|search|gemini|antigravity|ai digest - google|googlers posting on x|google reps & execs|v2 policy.*)$") AND NOT REGEXP_CONTAINS(LOWER(TRIM(COALESCE(alert_source, ""))), r"^(nfl|today in nba|psg( |-|$)|culture accounts|positive culture|brand fit|positive opps|america 250|posts by google|ai digest - (openai|anthropic|xai|meta ai|deepseek|microsoft ai|perplexity)|play competitors|android competitors|chrome - competitors)")'
),
(
  -- Brandwatch CSV exports: `added` looks like 2026-11-04T20:44:27.149+0000, `date` like 2026-11-04 20:41:27.0
  'BRANDWATCH_EXPORTS', TRUE, FALSE,
  'brand-social-central-data.brandwatch_automated_exports.raw_brandwatch_exports',
  'COALESCE(SAFE.PARSE_TIMESTAMP("%Y-%m-%dT%H:%M:%E*S%z", added), SAFE.PARSE_TIMESTAMP("%Y-%m-%d %H:%M:%E*S", added), SAFE.PARSE_TIMESTAMP("%Y-%m-%dT%H:%M:%E*SZ", added))',
  'COALESCE(SAFE.PARSE_TIMESTAMP("%Y-%m-%d %H:%M:%E*S", date), SAFE.PARSE_TIMESTAMP("%Y-%m-%dT%H:%M:%E*S%z", date), SAFE.PARSE_TIMESTAMP("%Y-%m-%dT%H:%M:%E*S%z", added))',
  'CONCAT("BWEXP|", COALESCE(NULLIF(mention_id, ""), TO_HEX(SHA256(CONCAT(COALESCE(url, ""), "|", COALESCE(date, ""))))))',
  'url',
  'COALESCE(NULLIF(TRIM(page_type), ""), "Web")',
  'LOWER(TRIM(REGEXP_REPLACE(COALESCE(author, ""), r"^@+", "")))',
  'COALESCE(SAFE_CAST(x_followers AS INT64), SAFE_CAST(instagram_followers AS INT64), SAFE_CAST(bluesky_followers AS INT64), SAFE_CAST(tiktok_reach AS INT64), SAFE_CAST(potential_audience AS INT64))',
  'COALESCE(SAFE_CAST(engagement_score AS INT64), SAFE_CAST(likes AS INT64) + SAFE_CAST(comments AS INT64) + SAFE_CAST(shares AS INT64), 0)',
  'FALSE',
  'COALESCE(NULLIF(TRIM(full_text), ""), snippet)',
  'COALESCE(NULLIF(TRIM(query_name), ""), "Unclassified")',
  'LOWER(COALESCE(sentiment, "negative")) != "positive"'
),
(
  'SPRINKLR_OWNED_COMMENTS', TRUE, FALSE,
  'brand-social-central-data.reporting_data.sprinklr_inbound_comments',
  'comment_timestamp',
  'comment_timestamp',
  'CONCAT("SPK|", comment_id)',
  'post_url',
  'COALESCE(NULLIF(TRIM(platform), ""), "Social")',
  'LOWER(TRIM(REGEXP_REPLACE(COALESCE(author_username, ""), r"^@+", "")))',
  'CAST(author_followers AS INT64)',
  'CAST(ROUND(COALESCE(comment_like_count, 0) + COALESCE(comment_reply_count, 0)) AS INT64)',
  'FALSE',
  'COALESCE(comment_text, "")',
  'COALESCE(NULLIF(TRIM(Product), ""), NULLIF(TRIM(brand), ""), NULLIF(TRIM(account_name), ""), "Owned Social")',
  'LOWER(COALESCE(is_deleted, "false")) != "true" AND LOWER(COALESCE(is_spam, "false")) != "true" AND LOWER(COALESCE(sentiment, "negative")) != "positive"'
),
(
  'REDDIT_PULSE', TRUE, FALSE,
  'brand-social-central-data.reddit_pulse.reddit_items_raw',
  'created_ts',
  'created_ts',
  'CONCAT("REDDIT|", item_id)',
  'CONCAT("https://www.reddit.com/comments/", REGEXP_REPLACE(COALESCE(thread_id, item_id), r"^t[0-9]_", ""), "/_/", REGEXP_REPLACE(item_id, r"^t[0-9]_", ""))',
  '"Reddit"',
  'LOWER(TRIM(COALESCE(author_id, "")))',
  'CAST(NULL AS INT64)',
  '0',
  'FALSE',
  'COALESCE(NULLIF(TRIM(raw_text), ""), norm_text)',
  'CASE WHEN m_gemini THEN "Gemini App" WHEN m_google THEN "Brand" ELSE "Unclassified" END',
  '(m_google OR m_gemini) AND created_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 2 DAY)'
),
(
  -- Enable once us-central1 -> US cross-region staging sync for Sonar is scheduled (see README.md)
  'SONAR_US_STAGE', FALSE, FALSE,
  'brand-social-central-data.early_detection.stg_sonar_mentions_us',
  'last_received_at',
  'COALESCE(post_timestamp, first_received_at)',
  'CONCAT("SONAR|", post_id)',
  'post_url',
  'COALESCE(NULLIF(TRIM(platform), ""), "X")',
  'LOWER(TRIM(REGEXP_REPLACE(COALESCE(author, ""), r"^@+", "")))',
  'CAST(followers AS INT64)',
  'COALESCE(likes, 0) + COALESCE(comments, 0) + COALESCE(shares, 0)',
  'FALSE',
  'COALESCE(NULLIF(TRIM(aggregated_content), ""), summary)',
  'COALESCE((SELECT n FROM UNNEST(smart_alert_names) n LIMIT 1), "Unclassified")',
  'NOT EXISTS (SELECT 1 FROM UNNEST(smart_tags) t WHERE REGEXP_CONTAINS(LOWER(t), r"^(praise|positive|fan|promo)"))'
);

-- 4. Configurable Risk-Term Taxonomy for Capability 2 (Velocity by Risk Group)
CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.risk_term_taxonomy` (
  risk_group    STRING NOT NULL,
  priority_tier STRING NOT NULL,
  pattern_regex STRING NOT NULL,
  enabled       BOOL NOT NULL
);

DELETE FROM `brand-social-central-data.early_detection.risk_term_taxonomy` WHERE TRUE;
INSERT INTO `brand-social-central-data.early_detection.risk_term_taxonomy` VALUES
  ('privacy_data_leak',       'P0', r'(?i)\b(data\s+breach|leaked\s+passwords?|private\s+(?:docs|chats|emails|photos)\s+exposed|spy(?:ing)?\s+on|unauthorized\s+access|training\s+on\s+private)\b', TRUE),
  ('safety_csam_selfharm',    'P0', r'(?i)\b(csam|child\s+safety|self[- ]harm|suicid(?:e|al)|dangerous\s+advice|told\s+(?:me|my\s+kid)\s+to\s+(?:die|hurt|eat))\b', TRUE),
  ('security_scam_malware',   'P1', r'(?i)\b(phishing|malware|account\s+(?:hacked|drained|locked\s+out)|fake\s+google\s+support|scam\s+ads?)\b', TRUE),
  ('outage_broken_feature',   'P1', r'(?i)\b(is\s+down|outage|bricked|bootloop|battery\s+(?:swelling|fire|explod)|wiped\s+my\s+(?:files|drive|photos))\b', TRUE),
  ('ai_hallucination_bias',   'P1', r'(?i)\b(ai\s+overview\s+(?:wrong|lying|dangerous)|gemini\s+(?:refuses|woke|censored|racist|hallucinat)|fake\s+citation)\b', TRUE),
  ('legal_antitrust_layoffs', 'P2', r'(?i)\b(doj|antitrust|monopoly|class\s+action|lawsuit|whistleblower|mass\s+layoffs?|union\s+busting)\b', TRUE);

-- 5. Incremental Watermark Cursor Table
CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.pipeline_watermarks` (
  step_name      STRING NOT NULL,
  last_cutoff_ts TIMESTAMP NOT NULL,
  updated_at     TIMESTAMP NOT NULL
);
