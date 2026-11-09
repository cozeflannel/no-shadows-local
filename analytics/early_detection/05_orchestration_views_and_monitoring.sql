-- =============================================================================
-- 05_orchestration_views_and_monitoring.sql
-- Master 15-minute scheduled procedure (kill switch, run lock, per-run and daily
-- bytes circuit breakers, pipeline_run_log), Apps Script chatbot polling view,
-- operational health / tuning metrics view, and cost-guard view.
-- =============================================================================

-- One row per orchestrator call (scheduled or manual): status, skip reason, bytes / slots, and what the run produced
CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.pipeline_run_log` (
  run_id          STRING NOT NULL,    -- @@script.job_id of the calling job (scheduled_query_… or bqjob_…)
  config_profile  STRING,
  started_at      TIMESTAMP NOT NULL,
  finished_at     TIMESTAMP,
  status          STRING NOT NULL,    -- RUNNING | OK | SKIPPED | STOPPED_BYTES_CAP | FAILED
  skip_reason     STRING,             -- Why the run was SKIPPED or STOPPED_BYTES_CAP
  bytes_billed    INT64,              -- @@script.bytes_billed when the row was closed
  bytes_processed INT64,              -- @@script.bytes_processed
  slot_ms         INT64,              -- @@script.slot_ms
  child_jobs      INT64,              -- @@script.num_child_jobs
  new_mentions    INT64,              -- low_tier_mentions rows landed by this run
  new_embeddings  INT64,              -- embedding_cache rows (AI.GENERATE_EMBEDDING results) created by this run
  cluster_alerts  INT64,              -- CLUSTER_EMERGENCE rows queued by this run
  velocity_alerts INT64,              -- VELOCITY_SPIKE rows queued by this run
  error_message   STRING              -- @@error.message when FAILED
)
PARTITION BY DATE(started_at)
OPTIONS (
  partition_expiration_days = 90,
  labels = [('app', 'slrr-triage-agent'), ('layer', 'early-detection')]
);

CREATE OR REPLACE PROCEDURE `brand-social-central-data.early_detection.sp_run_early_detection_pipeline`(
  IN p_config_profile STRING
)
BEGIN
  DECLARE v_started TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE v_run_id STRING;
  DECLARE v_enabled, v_peer_running BOOL;
  DECLARE v_lock_min, v_max_bytes_run, v_max_bytes_day, v_bytes_today INT64;
  DECLARE v_status STRING DEFAULT 'OK';
  DECLARE v_skip_reason STRING;
  DECLARE v_new_mentions, v_new_embeddings, v_cluster_alerts, v_velocity_alerts INT64;

  -- Every child job of this run carries these labels, so its spend is attributable in INFORMATION_SCHEMA.JOBS
  SET @@query_label = 'app:slrr-early-detection,component:pipeline';
  SET v_run_id = @@script.job_id;

  -- (1) Kill switch + guardrail settings: one tiny config read. Aggregates always return one row, so a missing
  -- profile falls through to the stage procedures, which raise (and the run is logged as FAILED).
  SET (v_enabled, v_lock_min, v_max_bytes_run, v_max_bytes_day) = (
    SELECT AS STRUCT
      COALESCE(ANY_VALUE(pipeline_enabled), TRUE),
      COALESCE(ANY_VALUE(run_lock_minutes), 30),
      COALESCE(ANY_VALUE(max_bytes_billed_per_run), 5368709120),
      COALESCE(ANY_VALUE(max_bytes_billed_per_day), 214748364800)
    FROM `brand-social-central-data.early_detection.early_detection_config`
    WHERE config_profile = p_config_profile
  );

  IF NOT COALESCE(v_enabled, TRUE) THEN
    INSERT INTO `brand-social-central-data.early_detection.pipeline_run_log`
      (run_id, config_profile, started_at, finished_at, status, skip_reason,
       bytes_billed, bytes_processed, slot_ms, child_jobs)
    VALUES
      (v_run_id, p_config_profile, v_started, CURRENT_TIMESTAMP(), 'SKIPPED', 'pipeline_enabled = FALSE',
       @@script.bytes_billed, @@script.bytes_processed, @@script.slot_ms, @@script.num_child_jobs);
    RETURN;
  END IF;

  -- (2) Run lock and (3) daily bytes breaker (UTC day, all profiles): one read of the recent run log
  SET (v_peer_running, v_bytes_today) = (
    SELECT AS STRUCT
      COALESCE(LOGICAL_OR(
        status = 'RUNNING'
        AND config_profile = p_config_profile
        AND started_at >= TIMESTAMP_SUB(v_started, INTERVAL v_lock_min MINUTE)
      ), FALSE),
      COALESCE(SUM(IF(started_at >= TIMESTAMP_TRUNC(v_started, DAY), bytes_billed, 0)), 0)
    FROM `brand-social-central-data.early_detection.pipeline_run_log`
    WHERE started_at >= LEAST(TIMESTAMP_TRUNC(v_started, DAY), TIMESTAMP_SUB(v_started, INTERVAL v_lock_min MINUTE))
  );

  IF v_peer_running THEN
    INSERT INTO `brand-social-central-data.early_detection.pipeline_run_log`
      (run_id, config_profile, started_at, finished_at, status, skip_reason,
       bytes_billed, bytes_processed, slot_ms, child_jobs)
    VALUES
      (v_run_id, p_config_profile, v_started, CURRENT_TIMESTAMP(), 'SKIPPED', 'previous run still running',
       @@script.bytes_billed, @@script.bytes_processed, @@script.slot_ms, @@script.num_child_jobs);
    RETURN;
  END IF;

  IF v_bytes_today >= v_max_bytes_day THEN
    INSERT INTO `brand-social-central-data.early_detection.pipeline_run_log`
      (run_id, config_profile, started_at, finished_at, status, skip_reason,
       bytes_billed, bytes_processed, slot_ms, child_jobs)
    VALUES
      (v_run_id, p_config_profile, v_started, CURRENT_TIMESTAMP(), 'SKIPPED',
       FORMAT('daily bytes cap reached: %d of %d bytes billed today (UTC)', v_bytes_today, v_max_bytes_day),
       @@script.bytes_billed, @@script.bytes_processed, @@script.slot_ms, @@script.num_child_jobs);
    RETURN;
  END IF;

  -- (4) Open this run's log row (it also acts as the lock for the next scheduled run)
  INSERT INTO `brand-social-central-data.early_detection.pipeline_run_log` (run_id, config_profile, started_at, status)
  VALUES (v_run_id, p_config_profile, v_started, 'RUNNING');

  -- (5) Stages in order, with the per-run bytes breaker checked between them
  BEGIN
    CALL `brand-social-central-data.early_detection.sp_ingest_low_tier_mentions`(p_config_profile);

    IF COALESCE(@@script.bytes_billed, 0) > v_max_bytes_run THEN
      SET v_status = 'STOPPED_BYTES_CAP';
      SET v_skip_reason = FORMAT('per-run bytes cap reached after ingest: %d > %d bytes billed',
                                 @@script.bytes_billed, v_max_bytes_run);
    ELSE
      CALL `brand-social-central-data.early_detection.sp_embed_and_cluster_low_tier`(p_config_profile);

      IF COALESCE(@@script.bytes_billed, 0) > v_max_bytes_run THEN
        SET v_status = 'STOPPED_BYTES_CAP';
        SET v_skip_reason = FORMAT('per-run bytes cap reached after embed_and_cluster: %d > %d bytes billed',
                                   @@script.bytes_billed, v_max_bytes_run);
      ELSE
        CALL `brand-social-central-data.early_detection.sp_detect_low_tier_velocity`(p_config_profile);
      END IF;
    END IF;

    SET (v_new_mentions, v_new_embeddings, v_cluster_alerts, v_velocity_alerts) = (
      SELECT AS STRUCT m.n, e.n, q.clu, q.vel
      FROM (
        SELECT COUNT(*) AS n
        FROM `brand-social-central-data.early_detection.low_tier_mentions`
        WHERE ingested_at >= v_started
      ) m
      CROSS JOIN (
        SELECT COUNT(*) AS n
        FROM `brand-social-central-data.early_detection.embedding_cache`
        WHERE created_at >= v_started
      ) e
      CROSS JOIN (
        SELECT
          COUNTIF(signal_type = 'CLUSTER_EMERGENCE') AS clu,
          COUNTIF(signal_type = 'VELOCITY_SPIKE') AS vel
        FROM `brand-social-central-data.early_detection.early_detection_alert_queue`
        WHERE created_at >= v_started
      ) q
    );

    UPDATE `brand-social-central-data.early_detection.pipeline_run_log`
    SET
      finished_at = CURRENT_TIMESTAMP(),
      status = v_status,
      skip_reason = v_skip_reason,
      bytes_billed = @@script.bytes_billed,
      bytes_processed = @@script.bytes_processed,
      slot_ms = @@script.slot_ms,
      child_jobs = @@script.num_child_jobs,
      new_mentions = v_new_mentions,
      new_embeddings = v_new_embeddings,
      cluster_alerts = v_cluster_alerts,
      velocity_alerts = v_velocity_alerts
    WHERE started_at = v_started
      AND run_id = v_run_id;
  EXCEPTION WHEN ERROR THEN
    UPDATE `brand-social-central-data.early_detection.pipeline_run_log`
    SET
      finished_at = CURRENT_TIMESTAMP(),
      status = 'FAILED',
      error_message = SUBSTR(@@error.message, 1, 4000),
      bytes_billed = @@script.bytes_billed,
      bytes_processed = @@script.bytes_processed,
      slot_ms = @@script.slot_ms,
      child_jobs = @@script.num_child_jobs
    WHERE started_at = v_started
      AND run_id = v_run_id;
    -- Re-raise so the scheduled query run still shows as failed
    RAISE;
  END;
END;

-- Apps Script Chatbot Polling View (polled every 15m by BigQuery.gs earlyWaveCheck_). update_of_alert_id /
-- update_of_authors: this alert is an update of an earlier alert on the same story (same-story dedup in 03).
-- New columns go at the end (the bot reads them by name).
CREATE OR REPLACE VIEW `brand-social-central-data.early_detection.vw_chatbot_pending_early_alerts` AS
SELECT
  alert_id,
  created_at,
  signal_type,
  velocity_grain,
  cluster_id,
  signal_key,
  headline,
  topic_product,
  priority_hint,
  window_start,
  window_end,
  unique_low_tier_authors,
  mention_count,
  platform_count,
  platforms,
  baseline_authors,
  velocity_ratio,
  absolute_author_delta,
  primary_url,
  TO_JSON_STRING(representative_posts) AS representative_posts_json,
  chatbot_card_text,
  update_of_alert_id,
  update_of_authors
FROM `brand-social-central-data.early_detection.early_detection_alert_queue`
WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 HOUR)
  AND chatbot_status = 'PENDING'
ORDER BY
  CASE priority_hint WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END ASC,
  COALESCE(velocity_ratio, 0) DESC,
  unique_low_tier_authors DESC,
  created_at ASC;

-- Lightweight Operational Monitoring & Cluster Tuning View
CREATE OR REPLACE VIEW `brand-social-central-data.early_detection.vw_early_detection_monitoring` AS
WITH freshness AS (
  SELECT
    source_name,
    MAX(source_ingested_at) AS latest_source_ingested_at,
    TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(source_ingested_at), MINUTE) AS source_lag_minutes,
    MAX(ingested_at) AS latest_landed_at,
    COUNTIF(ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)) AS low_tier_rows_24h
  FROM `brand-social-central-data.early_detection.low_tier_mentions`
  WHERE ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 48 HOUR)
  GROUP BY source_name
),
latest_cluster_run AS (
  SELECT *
  FROM `brand-social-central-data.early_detection.cluster_run_metrics`
  WHERE run_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
  ORDER BY run_ts DESC
  LIMIT 1
),
alert_counts_24h AS (
  SELECT
    COUNTIF(signal_type = 'CLUSTER_EMERGENCE') AS cluster_alerts_24h,
    COUNTIF(signal_type = 'VELOCITY_SPIKE') AS velocity_alerts_24h,
    COUNTIF(chatbot_status = 'PENDING') AS queue_pending_now
  FROM `brand-social-central-data.early_detection.early_detection_alert_queue`
  WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
)
SELECT
  CURRENT_TIMESTAMP() AS checked_at,
  ARRAY_AGG(STRUCT(f.source_name, f.latest_source_ingested_at, f.source_lag_minutes, f.latest_landed_at, f.low_tier_rows_24h)) AS source_freshness,
  ANY_VALUE(l.run_ts) AS last_cluster_run_ts,
  ANY_VALUE(l.active_cluster_count) AS active_clusters,
  ANY_VALUE(SAFE_DIVIDE(l.cache_hit_mentions, NULLIF(l.candidate_mentions, 0))) AS embedding_cache_hit_rate,
  ANY_VALUE(SAFE_DIVIDE(l.unassigned_singleton_count, NULLIF(l.candidate_mentions, 0))) AS singleton_ratio,
  ANY_VALUE(l.p50_cluster_authors) AS p50_cluster_authors,
  ANY_VALUE(l.p90_cluster_authors) AS p90_cluster_authors,
  ANY_VALUE(a.cluster_alerts_24h) AS cluster_alerts_24h,
  ANY_VALUE(a.velocity_alerts_24h) AS velocity_alerts_24h,
  ANY_VALUE(a.queue_pending_now) AS chatbot_queue_pending
FROM freshness f
LEFT JOIN latest_cluster_run l ON TRUE
CROSS JOIN alert_counts_24h a;

-- Cost guard: usage vs hard ceilings in one row (today = UTC day, same window as the orchestrator's daily breaker).
-- Dollar figures are estimates: BigQuery on-demand $6.25 / TiB billed; Vertex text-embedding-005 online input
-- $0.000025 / 1,000 characters (CHAR_LENGTH over-counts slightly, since whitespace is not billed).
CREATE OR REPLACE VIEW `brand-social-central-data.early_detection.vw_early_detection_cost_guard` AS
WITH cfg AS (
  -- Aggregates always return one row (defaults if the prod profile is missing)
  SELECT
    COALESCE(ANY_VALUE(pipeline_enabled), TRUE) AS pipeline_enabled,
    COALESCE(ANY_VALUE(max_bytes_billed_per_run), 5368709120) AS max_bytes_billed_per_run,
    COALESCE(ANY_VALUE(max_bytes_billed_per_day), 214748364800) AS max_bytes_billed_per_day,
    COALESCE(ANY_VALUE(max_new_embeddings_per_run), 3000) AS max_new_embeddings_per_run,
    COALESCE(ANY_VALUE(max_new_embeddings_per_day), 30000) AS max_new_embeddings_per_day,
    COALESCE(ANY_VALUE(max_ingest_rows_per_run), 20000) AS max_ingest_rows_per_run,
    COALESCE(ANY_VALUE(max_backfill_hours), 12) AS max_backfill_hours,
    COALESCE(ANY_VALUE(max_cluster_pool), 15000) AS max_cluster_pool,
    COALESCE(ANY_VALUE(max_alerts_per_run), 8) AS max_alerts_per_run,
    COALESCE(ANY_VALUE(embedding_cache_reuse_days), 2) AS embedding_cache_reuse_days,
    COALESCE(ANY_VALUE(cluster_retention_days), 3) AS cluster_retention_days,
    COALESCE(ANY_VALUE(run_lock_minutes), 30) AS run_lock_minutes
  FROM `brand-social-central-data.early_detection.early_detection_config`
  WHERE config_profile = 'prod'
),
runs AS (
  SELECT
    COUNTIF(l.started_at >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY)) AS runs_today,
    COUNTIF(l.started_at >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY) AND l.status = 'OK') AS runs_ok_today,
    COUNTIF(l.started_at >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY) AND l.status = 'SKIPPED') AS runs_skipped_today,
    COUNTIF(l.started_at >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY) AND l.status = 'STOPPED_BYTES_CAP') AS runs_stopped_bytes_cap_today,
    COUNTIF(l.started_at >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY) AND l.status = 'FAILED') AS runs_failed_today,
    COUNTIF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)) AS runs_24h,
    COUNTIF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) AND l.status = 'OK') AS runs_ok_24h,
    COUNTIF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) AND l.status = 'SKIPPED') AS runs_skipped_24h,
    COUNTIF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) AND l.status = 'STOPPED_BYTES_CAP') AS runs_stopped_bytes_cap_24h,
    COUNTIF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) AND l.status = 'FAILED') AS runs_failed_24h,
    COUNTIF(l.status = 'RUNNING' AND l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL c.run_lock_minutes MINUTE)) AS runs_in_progress,
    -- RUNNING rows older than the lock window: the job died without reaching its exception handler (cancelled / timed out)
    COUNTIF(l.status = 'RUNNING' AND l.started_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL c.run_lock_minutes MINUTE)) AS runs_stuck_running,
    COALESCE(SUM(IF(l.started_at >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY), l.bytes_billed, 0)), 0) AS bytes_billed_today,
    COALESCE(SUM(IF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR), l.bytes_billed, 0)), 0) AS bytes_billed_24h,
    CAST(AVG(IF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) AND l.status = 'OK', l.bytes_billed, NULL)) AS INT64) AS avg_bytes_billed_per_ok_run_24h,
    MAX(IF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR), l.bytes_billed, NULL)) AS max_bytes_billed_one_run_24h,
    CAST(AVG(IF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) AND l.status = 'OK', l.slot_ms, NULL)) AS INT64) AS avg_slot_ms_per_ok_run_24h,
    CAST(AVG(IF(l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR) AND l.status = 'OK',
                TIMESTAMP_DIFF(l.finished_at, l.started_at, SECOND), NULL)) AS INT64) AS avg_ok_run_seconds_24h,
    ARRAY_AGG(
      STRUCT(l.run_id, l.status, l.started_at, l.finished_at, l.bytes_billed, l.slot_ms, l.child_jobs,
             COALESCE(l.skip_reason, l.error_message) AS note)
      ORDER BY l.started_at DESC
      LIMIT 1
    )[SAFE_OFFSET(0)] AS last_run
  FROM `brand-social-central-data.early_detection.pipeline_run_log` l
  CROSS JOIN cfg c
  WHERE l.started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
),
embeds AS (
  SELECT
    COUNTIF(created_at >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY)) AS embeddings_today,
    COALESCE(SUM(IF(created_at >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY), CHAR_LENGTH(sample_clean_text), 0)), 0) AS embedded_chars_today,
    COUNT(*) AS embeddings_24h
  FROM `brand-social-central-data.early_detection.embedding_cache`
  WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
),
alerts AS (
  SELECT
    COUNT(*) AS alerts_queued_today,
    COUNTIF(signal_type = 'CLUSTER_EMERGENCE') AS cluster_alerts_today,
    COUNTIF(signal_type = 'VELOCITY_SPIKE') AS velocity_alerts_today,
    COUNTIF(update_of_alert_id IS NOT NULL) AS story_updates_today
  FROM `brand-social-central-data.early_detection.early_detection_alert_queue`
  WHERE created_at >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY)
),
dedup AS (
  -- Same-story dedup: cluster alerts held back as a repeat of a story already alerted (03 story check)
  SELECT COALESCE(SUM(story_dup_suppressed), 0) AS story_repeats_held_back_today
  FROM `brand-social-central-data.early_detection.cluster_run_metrics`
  WHERE run_ts >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), DAY)
)
SELECT
  CURRENT_TIMESTAMP() AS checked_at,
  c.pipeline_enabled,
  -- BigQuery bytes billed by the pipeline (pipeline_run_log)
  r.bytes_billed_today,
  c.max_bytes_billed_per_day,
  ROUND(100 * SAFE_DIVIDE(r.bytes_billed_today, c.max_bytes_billed_per_day), 2) AS pct_daily_bytes_cap_used,
  ROUND(r.bytes_billed_today / POW(1024, 3), 3) AS gib_billed_today,
  ROUND(r.bytes_billed_today / POW(1024, 4) * 6.25, 4) AS est_bq_usd_today,
  r.bytes_billed_24h,
  ROUND(r.bytes_billed_24h / POW(1024, 4) * 6.25, 4) AS est_bq_usd_24h,
  r.avg_bytes_billed_per_ok_run_24h,
  r.max_bytes_billed_one_run_24h,
  c.max_bytes_billed_per_run,
  r.avg_slot_ms_per_ok_run_24h,
  r.avg_ok_run_seconds_24h,
  -- Runs by status
  r.runs_today,
  r.runs_ok_today,
  r.runs_skipped_today,
  r.runs_stopped_bytes_cap_today,
  r.runs_failed_today,
  r.runs_24h,
  r.runs_ok_24h,
  r.runs_skipped_24h,
  r.runs_stopped_bytes_cap_24h,
  r.runs_failed_24h,
  r.runs_in_progress,
  r.runs_stuck_running,
  r.last_run.run_id AS last_run_id,
  r.last_run.status AS last_run_status,
  r.last_run.started_at AS last_run_started_at,
  r.last_run.finished_at AS last_run_finished_at,
  r.last_run.bytes_billed AS last_run_bytes_billed,
  r.last_run.slot_ms AS last_run_slot_ms,
  r.last_run.child_jobs AS last_run_child_jobs,
  r.last_run.note AS last_run_note,
  -- Vertex AI embeddings (embedding_cache rows = successful AI.GENERATE_EMBEDDING results)
  e.embeddings_today,
  c.max_new_embeddings_per_day,
  ROUND(100 * SAFE_DIVIDE(e.embeddings_today, c.max_new_embeddings_per_day), 2) AS pct_daily_embedding_cap_used,
  e.embedded_chars_today,
  ROUND(e.embedded_chars_today / 1000 * 0.000025, 4) AS est_vertex_usd_today,
  e.embeddings_24h,
  c.max_new_embeddings_per_run,
  -- Alerts queued for the chatbot
  a.alerts_queued_today,
  a.cluster_alerts_today,
  a.velocity_alerts_today,
  a.story_updates_today,
  d.story_repeats_held_back_today,
  c.max_alerts_per_run,
  -- Other caps
  c.max_ingest_rows_per_run,
  c.max_backfill_hours,
  c.max_cluster_pool,
  c.embedding_cache_reuse_days,
  c.cluster_retention_days,
  c.run_lock_minutes
FROM runs r
CROSS JOIN embeds e
CROSS JOIN alerts a
CROSS JOIN dedup d
CROSS JOIN cfg c;
