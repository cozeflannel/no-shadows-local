-- slrr_signals views (run after 01). Idempotent: CREATE OR REPLACE VIEW only (views hold no data).
--   bq query --project_id=brand-social-central-data --location=US --use_legacy_sql=false \
--     --label datacloud:antigravity --label app:slrr-signals < analytics/slrr_signals/02_views.sql

-- The taxonomy as it is now: the newest row of each (kind, priority, name)
CREATE OR REPLACE VIEW `brand-social-central-data.slrr_signals.v_taxonomy_current` AS
SELECT * EXCEPT (rn) FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY kind, IFNULL(priority, ''), name ORDER BY updated_at DESC) AS rn
  FROM `brand-social-central-data.slrr_signals.taxonomy`
) WHERE rn = 1;

-- Each post's latest Track 1 classification
CREATE OR REPLACE VIEW `brand-social-central-data.slrr_signals.v_track1_latest` AS
SELECT * EXCEPT (rn) FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY mention_key ORDER BY classified_at DESC) AS rn
  FROM `brand-social-central-data.slrr_signals.classified_mentions`
  WHERE classified_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
) WHERE rn = 1;

-- Track 1 rows not handed to the chat yet: qualifying, from the last 24 hours. The chatbot (Signals.gs) hands each one
-- over once, as a watch alert where Control row 35 says; this view is for looking (the bot reads the table itself).
CREATE OR REPLACE VIEW `brand-social-central-data.slrr_signals.v_track1_ready` AS
SELECT l.*
FROM `brand-social-central-data.slrr_signals.v_track1_latest` l
LEFT JOIN (SELECT DISTINCT mention_key FROM `brand-social-central-data.slrr_signals.handoffs`) h USING (mention_key)
WHERE l.qualifies AND h.mention_key IS NULL AND l.classified_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR);

-- Each cluster's latest Track 2 assessment
CREATE OR REPLACE VIEW `brand-social-central-data.slrr_signals.v_radar_latest` AS
SELECT * EXCEPT (rn) FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY assessed_at DESC) AS rn
  FROM `brand-social-central-data.slrr_signals.radar_clusters`
  WHERE assessed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
) WHERE rn = 1;

-- The radar's notable clusters: high or medium likelihood, not discarded, from the last 3 days (the chatbot hands the
-- promoted or high ones to its Early detection review: Signals.gs)
CREATE OR REPLACE VIEW `brand-social-central-data.slrr_signals.v_radar_review` AS
SELECT *
FROM `brand-social-central-data.slrr_signals.v_radar_latest`
WHERE likelihood IN ('high', 'medium') AND action != 'discard'
  AND assessed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY);

-- What was alerted in the last 14 days (the previously-reported check)
CREATE OR REPLACE VIEW `brand-social-central-data.slrr_signals.v_issue_history_14d` AS
SELECT * EXCEPT (rn) FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY IFNULL(alert_id, record_key) ORDER BY synced_at DESC) AS rn
  FROM `brand-social-central-data.slrr_signals.issue_history`
  WHERE alerted_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
) WHERE rn = 1;

-- The bot's long memory: every alert it knows of beyond its sheet (issue history and the archived Alert log rows), one
-- row per alert, searchable by record_key (the post) or alert_id
CREATE OR REPLACE VIEW `brand-social-central-data.slrr_signals.v_memory` AS
SELECT * EXCEPT (rn) FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY alert_id ORDER BY synced_at DESC) AS rn
  FROM (
    SELECT alert_id, record_key, issue_name, exposure_tag, priority, post_url, alerted_at, status, email_status,
      source, synced_at, CAST(NULL AS STRING) AS decision, CAST(NULL AS STRING) AS tns_submitted
    FROM `brand-social-central-data.slrr_signals.issue_history`
    UNION ALL
    SELECT alert_id, record_key,
      JSON_VALUE(row_json, '$.forwarded_fields.issue_name') AS issue_name,
      JSON_VALUE(row_json, '$.exposure_tag') AS exposure_tag,
      CAST(NULL AS STRING) AS priority,
      JSON_VALUE(row_json, '$.forwarded_fields.post_url') AS post_url,
      created_at AS alerted_at,
      JSON_VALUE(row_json, '$.status') AS status,
      JSON_VALUE(row_json, '$.email_status') AS email_status,
      'sheet_archive' AS source, archived_at AS synced_at,
      JSON_VALUE(row_json, '$.decision') AS decision,
      JSON_VALUE(row_json, '$.tns_submitted') AS tns_submitted
    FROM `brand-social-central-data.slrr_signals.sheet_archive`
    WHERE tab = 'Alert log' AND alert_id IS NOT NULL
  )
) WHERE rn = 1;

-- Each source's health for the sheet and for monitoring
CREATE OR REPLACE VIEW `brand-social-central-data.slrr_signals.v_source_health` AS
SELECT source, watermark, table_modified, day, day_count, failures, paused_until, last_ok, last_error, last_rows, updated_at,
  CASE
    WHEN paused_until > CURRENT_TIMESTAMP() THEN CONCAT('paused until ', FORMAT_TIMESTAMP('%b %d %H:%M', paused_until, 'America/New_York'), ' ET: ', IFNULL(last_error, ''))
    WHEN IFNULL(failures, 0) > 0 THEN CONCAT('failing (', CAST(failures AS STRING), '): ', IFNULL(last_error, ''))
    WHEN last_ok IS NULL THEN 'waiting for its first read'
    ELSE 'live'
  END AS status
FROM `brand-social-central-data.slrr_signals.source_state`;

-- Daily metrics from the run log
CREATE OR REPLACE VIEW `brand-social-central-data.slrr_signals.v_metrics_daily` AS
SELECT DATE(started_at, 'America/New_York') AS day, endpoint, COUNT(*) AS runs,
  COUNTIF(status = 'ok') AS ok_runs, COUNTIF(status IN ('partial', 'error')) AS failed_runs,
  SUM(SAFE_CAST(JSON_VALUE(stats, '$.ingested') AS INT64)) AS ingested,
  SUM(SAFE_CAST(JSON_VALUE(stats, '$.classified') AS INT64)) AS classified,
  SUM(SAFE_CAST(JSON_VALUE(stats, '$.qualified') AS INT64)) AS qualified,
  SUM(SAFE_CAST(JSON_VALUE(stats, '$.assessed') AS INT64)) AS assessed,
  APPROX_QUANTILES(TIMESTAMP_DIFF(finished_at, started_at, MILLISECOND), 2)[OFFSET(1)] AS median_run_ms
FROM `brand-social-central-data.slrr_signals.run_log`
GROUP BY 1, 2;
