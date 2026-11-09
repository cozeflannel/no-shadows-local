-- =============================================================================
-- 04_capability_2_low_tier_velocity.sql
-- Multi-grain rate-of-change detection (CLUSTER, RISK_TERM_GROUP, PRIORITY_TOPIC)
-- over the low-tier subset against smoothed 7d diurnal + 6h rolling baselines.
-- Velocity alerts wait until the hourly rollup has velocity_warmup_hours of history (cold start), and the diurnal
-- baseline averages over the days of history it actually has (so a young rollup never reads as a 7x quieter baseline).
-- Guardrail: at most max_alerts_per_run velocity alerts are queued per run (P0 first, then highest velocity ratio).
-- Same-story dedup: a CLUSTER-grain spike on a cluster (or one within story_dedup_max_cosine_distance of a cluster)
-- that alerted in the last story_dedup_hours is held back unless its authors reached story_update_min_growth x the most
-- that story's alerts reported and at least story_update_min_new_authors more.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.low_tier_hourly_rollup` (
  hour_bucket         TIMESTAMP NOT NULL,
  grain_type          STRING NOT NULL, -- CLUSTER | RISK_TERM_GROUP | PRIORITY_TOPIC
  grain_key           STRING NOT NULL,
  topic_product       STRING NOT NULL,
  unique_author_count INT64 NOT NULL,
  mention_count       INT64 NOT NULL,
  platform_count      INT64 NOT NULL,
  updated_at          TIMESTAMP NOT NULL
)
PARTITION BY DATE(hour_bucket)
CLUSTER BY grain_type, grain_key
OPTIONS (partition_expiration_days = 30);

CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.velocity_alert_cooldowns` (
  grain_type           STRING NOT NULL,
  grain_key            STRING NOT NULL,
  last_alerted_at      TIMESTAMP NOT NULL,
  last_alerted_authors INT64 NOT NULL
)
CLUSTER BY grain_type, grain_key;

CREATE OR REPLACE PROCEDURE `brand-social-central-data.early_detection.sp_detect_low_tier_velocity`(
  IN p_config_profile STRING
)
BEGIN
  DECLARE v_now TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE v_win_min, v_base_days, v_roll_hrs, v_min_clu_auth, v_min_term_auth, v_hard_delta, v_cooldown_min, v_warmup_hrs INT64;
  DECLARE v_max_alerts INT64;
  DECLARE v_alpha, v_min_mult FLOAT64;
  DECLARE v_story_dist, v_story_growth FLOAT64;
  DECLARE v_story_h, v_story_new_min INT64;
  DECLARE v_win_start TIMESTAMP;
  DECLARE v_history_hrs, v_diurnal_days INT64;

  IF NOT EXISTS (
    SELECT 1 FROM `brand-social-central-data.early_detection.early_detection_config`
    WHERE config_profile = p_config_profile
  ) THEN
    RAISE USING MESSAGE = FORMAT('early_detection_config has no profile %T', p_config_profile);
  END IF;

  SET (v_win_min, v_base_days, v_roll_hrs, v_alpha, v_min_mult,
       v_min_clu_auth, v_min_term_auth, v_hard_delta, v_cooldown_min, v_warmup_hrs, v_max_alerts,
       v_story_dist, v_story_h, v_story_growth, v_story_new_min) = (
    SELECT AS STRUCT
      velocity_window_minutes, baseline_lookback_days, short_rolling_hours,
      smoothing_alpha_authors, min_velocity_multiplier,
      min_cluster_vel_authors, min_term_vel_authors, hard_author_delta_spike, velocity_cooldown_minutes,
      velocity_warmup_hours,
      COALESCE(max_alerts_per_run, 8),  -- Cost & spike guardrail
      -- Same-story dedup
      COALESCE(story_dedup_max_cosine_distance, 0.14),
      GREATEST(COALESCE(story_dedup_hours, 24), 1),
      GREATEST(COALESCE(story_update_min_growth, 2.0), 1.0),
      GREATEST(COALESCE(story_update_min_new_authors, 3), 0)
    FROM `brand-social-central-data.early_detection.early_detection_config`
    WHERE config_profile = p_config_profile
  );

  SET v_win_start = TIMESTAMP_SUB(v_now, INTERVAL v_win_min MINUTE);

  -- Incrementally refresh recent hourly buckets in low_tier_hourly_rollup
  MERGE `brand-social-central-data.early_detection.low_tier_hourly_rollup` T
  USING (
    WITH base_mentions AS (
      SELECT
        TIMESTAMP_TRUNC(m.posted_at, HOUR) AS hour_bucket,
        m.mention_id,
        m.platform,
        m.author_id,
        COALESCE(m.topic_hint, 'Brand') AS topic_product,
        m.risk_term_groups,
        a.cluster_id
      FROM `brand-social-central-data.early_detection.low_tier_mentions` m
      LEFT JOIN `brand-social-central-data.early_detection.mention_cluster_assignments` a
        ON a.mention_id = m.mention_id
       AND a.ingested_at >= TIMESTAMP_SUB(v_now, INTERVAL 12 HOUR)
      WHERE m.posted_at >= TIMESTAMP_TRUNC(TIMESTAMP_SUB(v_now, INTERVAL 3 HOUR), HOUR)
        AND m.ingested_at >= TIMESTAMP_SUB(v_now, INTERVAL 12 HOUR)
    ),
    unioned_grains AS (
      SELECT hour_bucket, 'CLUSTER' AS grain_type, cluster_id AS grain_key, topic_product, platform, author_id
      FROM base_mentions WHERE cluster_id IS NOT NULL
      UNION ALL
      SELECT hour_bucket, 'RISK_TERM_GROUP' AS grain_type, rg AS grain_key, topic_product, platform, author_id
      FROM base_mentions, UNNEST(risk_term_groups) AS rg
      UNION ALL
      SELECT hour_bucket, 'PRIORITY_TOPIC' AS grain_type, topic_product AS grain_key, topic_product, platform, author_id
      FROM base_mentions WHERE topic_product IS NOT NULL AND topic_product NOT IN ('Unclassified', '')
    )
    SELECT
      hour_bucket,
      grain_type,
      grain_key,
      APPROX_TOP_COUNT(topic_product, 1)[OFFSET(0)].value AS topic_product,
      COUNT(DISTINCT CONCAT(platform, ':', author_id)) AS unique_author_count,
      COUNT(*) AS mention_count,
      COUNT(DISTINCT platform) AS platform_count,
      v_now AS updated_at
    FROM unioned_grains
    GROUP BY hour_bucket, grain_type, grain_key
  ) S
  ON T.hour_bucket = S.hour_bucket
     AND T.grain_type = S.grain_type
     AND T.grain_key = S.grain_key
     AND T.hour_bucket >= TIMESTAMP_TRUNC(TIMESTAMP_SUB(v_now, INTERVAL 3 HOUR), HOUR)
  WHEN MATCHED THEN UPDATE SET
    topic_product = S.topic_product,
    unique_author_count = S.unique_author_count,
    mention_count = S.mention_count,
    platform_count = S.platform_count,
    updated_at = S.updated_at
  WHEN NOT MATCHED THEN INSERT ROW;

  -- Cold start: no velocity alert until the rollup holds v_warmup_hrs of history (baselines would read as ~0)
  SET v_history_hrs = COALESCE((
    SELECT TIMESTAMP_DIFF(v_now, MIN(hour_bucket), HOUR)
    FROM `brand-social-central-data.early_detection.low_tier_hourly_rollup`
    WHERE hour_bucket >= TIMESTAMP_SUB(v_now, INTERVAL v_base_days DAY)
  ), 0);
  IF v_history_hrs < v_warmup_hrs THEN
    RETURN;
  END IF;

  -- Days of same-hour-of-day history the diurnal baseline can actually average over (1..v_base_days)
  SET v_diurnal_days = GREATEST(1, COALESCE((
    SELECT COUNT(DISTINCT DATE(hour_bucket))
    FROM `brand-social-central-data.early_detection.low_tier_hourly_rollup`
    WHERE hour_bucket >= TIMESTAMP_SUB(TIMESTAMP_TRUNC(v_now, HOUR), INTERVAL v_base_days DAY)
      AND hour_bucket < TIMESTAMP_SUB(TIMESTAMP_TRUNC(v_now, HOUR), INTERVAL 12 HOUR)
      AND EXTRACT(HOUR FROM hour_bucket) = EXTRACT(HOUR FROM v_now)
  ), 0));

  CREATE TEMP TABLE tmp_velocity_candidates AS
  WITH live_mentions AS (
    SELECT
      m.mention_id, m.platform, m.author_id, m.audience_size, m.engagement_count,
      m.posted_at, m.canonical_url, m.clean_text,
      COALESCE(NULLIF(m.topic_hint, 'Unclassified'), 'Brand') AS topic_product,
      m.topic_hint AS raw_topic_hint,
      m.risk_term_groups,
      a.cluster_id
    FROM `brand-social-central-data.early_detection.low_tier_mentions` m
    LEFT JOIN `brand-social-central-data.early_detection.mention_cluster_assignments` a
      ON a.mention_id = m.mention_id
     AND a.ingested_at >= TIMESTAMP_SUB(v_now, INTERVAL 12 HOUR)
    WHERE m.posted_at >= v_win_start
      AND m.ingested_at >= TIMESTAMP_SUB(v_win_start, INTERVAL 12 HOUR)
  ),
  live_grained AS (
    SELECT 'CLUSTER' AS grain_type, cluster_id AS grain_key, * EXCEPT(raw_topic_hint)
    FROM live_mentions WHERE cluster_id IS NOT NULL
    UNION ALL
    SELECT 'RISK_TERM_GROUP' AS grain_type, rg AS grain_key, lm.* EXCEPT(raw_topic_hint)
    FROM live_mentions lm, UNNEST(lm.risk_term_groups) AS rg
    UNION ALL
    SELECT 'PRIORITY_TOPIC' AS grain_type, raw_topic_hint AS grain_key, * EXCEPT(raw_topic_hint)
    FROM live_mentions WHERE raw_topic_hint IS NOT NULL AND raw_topic_hint NOT IN ('Unclassified', '')
  ),
  dedup_author_samples AS (
    SELECT *
    FROM live_grained
    WHERE TRUE
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY grain_type, grain_key, platform, author_id
      ORDER BY engagement_count DESC, posted_at DESC
    ) = 1
  ),
  current_stats AS (
    SELECT
      grain_type,
      grain_key,
      APPROX_TOP_COUNT(topic_product, 1)[OFFSET(0)].value AS topic_product,
      COUNT(DISTINCT CONCAT(platform, ':', author_id)) AS current_authors,
      COUNT(*) AS current_mentions,
      COUNT(DISTINCT platform) AS platform_count,
      ARRAY_AGG(DISTINCT platform ORDER BY platform) AS platforms
    FROM live_grained
    GROUP BY grain_type, grain_key
  ),
  sample_posts AS (
    SELECT
      grain_type,
      grain_key,
      ARRAY_AGG(
        STRUCT(
          mention_id, platform, author_id, audience_size,
          engagement_count AS engagement, posted_at,
          canonical_url AS url, SUBSTR(clean_text, 1, 280) AS snippet
        )
        ORDER BY engagement_count DESC, posted_at DESC
        LIMIT 8
      ) AS representative_posts
    FROM dedup_author_samples
    GROUP BY grain_type, grain_key
  ),
  diurnal_baseline AS (
    SELECT
      grain_type,
      grain_key,
      SUM(unique_author_count) / CAST(v_diurnal_days AS FLOAT64) AS diurnal_mean_authors
    FROM `brand-social-central-data.early_detection.low_tier_hourly_rollup`
    WHERE hour_bucket >= TIMESTAMP_SUB(TIMESTAMP_TRUNC(v_now, HOUR), INTERVAL v_base_days DAY)
      AND hour_bucket < TIMESTAMP_SUB(TIMESTAMP_TRUNC(v_now, HOUR), INTERVAL 12 HOUR)
      AND EXTRACT(HOUR FROM hour_bucket) = EXTRACT(HOUR FROM v_now)
    GROUP BY grain_type, grain_key
  ),
  rolling_baseline AS (
    SELECT
      grain_type,
      grain_key,
      SUM(unique_author_count) / CAST(v_roll_hrs AS FLOAT64) AS rolling_mean_authors
    FROM `brand-social-central-data.early_detection.low_tier_hourly_rollup`
    WHERE hour_bucket >= TIMESTAMP_SUB(TIMESTAMP_TRUNC(v_now, HOUR), INTERVAL v_roll_hrs HOUR)
      AND hour_bucket < TIMESTAMP_TRUNC(v_now, HOUR)
    GROUP BY grain_type, grain_key
  ),
  scored AS (
    SELECT
      cs.grain_type,
      cs.grain_key,
      cs.topic_product,
      cs.current_authors,
      cs.current_mentions,
      cs.platform_count,
      cs.platforms,
      (GREATEST(COALESCE(db.diurnal_mean_authors, 0.0), COALESCE(rb.rolling_mean_authors, 0.0) * 0.5)
        * (v_win_min / 60.0)) AS raw_baseline_authors,
      ((GREATEST(COALESCE(db.diurnal_mean_authors, 0.0), COALESCE(rb.rolling_mean_authors, 0.0) * 0.5)
        * (v_win_min / 60.0)) + v_alpha) AS smoothed_baseline_authors,
      sp.representative_posts,
      ac.cluster_label,
      ac.centroid_embedding AS centroid,
      rt.priority_tier AS risk_priority
    FROM current_stats cs
    JOIN sample_posts sp
      ON sp.grain_type = cs.grain_type AND sp.grain_key = cs.grain_key
    LEFT JOIN diurnal_baseline db
      ON db.grain_type = cs.grain_type AND db.grain_key = cs.grain_key
    LEFT JOIN rolling_baseline rb
      ON rb.grain_type = cs.grain_type AND rb.grain_key = cs.grain_key
    LEFT JOIN `brand-social-central-data.early_detection.active_clusters` ac
      ON cs.grain_type = 'CLUSTER' AND ac.cluster_id = cs.grain_key
    LEFT JOIN `brand-social-central-data.early_detection.risk_term_taxonomy` rt
      ON cs.grain_type = 'RISK_TERM_GROUP' AND rt.risk_group = cs.grain_key
  ),
  spikes AS (
    SELECT
      s.*,
      SAFE_DIVIDE(s.current_authors, s.smoothed_baseline_authors) AS velocity_ratio,
      (s.current_authors - s.raw_baseline_authors) AS absolute_author_delta,
      COALESCE(s.risk_priority, IF(SAFE_DIVIDE(s.current_authors, s.smoothed_baseline_authors) >= 5.0, 'P1', 'P2')) AS priority_hint
    FROM scored s
    LEFT JOIN `brand-social-central-data.early_detection.velocity_alert_cooldowns` cd
      ON cd.grain_type = s.grain_type AND cd.grain_key = s.grain_key
    WHERE
      s.current_authors >= IF(s.grain_type = 'CLUSTER', v_min_clu_auth, v_min_term_auth)
      AND (
        SAFE_DIVIDE(s.current_authors, s.smoothed_baseline_authors) >= v_min_mult
        OR (s.current_authors - s.raw_baseline_authors) >= v_hard_delta
      )
      AND (
        cd.last_alerted_at IS NULL
        OR cd.last_alerted_at < TIMESTAMP_SUB(v_now, INTERVAL v_cooldown_min MINUTE)
        OR s.current_authors >= cd.last_alerted_authors * 1.75
      )
  )
  SELECT * FROM spikes;

  -- Same-story dedup for the CLUSTER grain: the most authors any alert (cluster or velocity) on each cluster reported in
  -- the last v_story_h hours, with that cluster's centroid
  CREATE TEMP TABLE tmp_vel_story_prior AS
  SELECT p.cluster_id, p.prior_authors, ac.centroid_embedding AS vec
  FROM (
    SELECT cluster_id, MAX(unique_low_tier_authors) AS prior_authors
    FROM `brand-social-central-data.early_detection.early_detection_alert_queue`
    WHERE created_at >= TIMESTAMP_SUB(v_now, INTERVAL v_story_h HOUR)
      AND cluster_id IS NOT NULL
      AND chatbot_status != 'SKIPPED'
    GROUP BY cluster_id
  ) p
  LEFT JOIN `brand-social-central-data.early_detection.active_clusters` ac
    ON ac.cluster_id = p.cluster_id;

  -- A CLUSTER-grain spike on a story that already alerted (the same cluster, or a centroid within v_story_dist) goes out
  -- only when its authors reached v_story_growth x and v_story_new_min more than that story's alerts reported. At most
  -- v_max_alerts velocity alerts per run; held-back and capped-out spikes are not stamped in the cooldown table below.
  CREATE TEMP TABLE tmp_velocity_spikes AS
  WITH story AS (
    SELECT c.grain_key, MAX(p.prior_authors) AS prior_authors
    FROM tmp_velocity_candidates c
    CROSS JOIN tmp_vel_story_prior p
    WHERE c.grain_type = 'CLUSTER'
      AND (
        p.cluster_id = c.grain_key
        OR IF(ARRAY_LENGTH(c.centroid) = 768 AND ARRAY_LENGTH(p.vec) = 768,
              ML.DISTANCE(c.centroid, p.vec, 'COSINE'), NULL) <= v_story_dist
      )
    GROUP BY c.grain_key
  )
  SELECT c.* EXCEPT(centroid)
  FROM tmp_velocity_candidates c
  LEFT JOIN story st
    ON c.grain_type = 'CLUSTER' AND st.grain_key = c.grain_key
  WHERE st.grain_key IS NULL
    OR (c.current_authors >= st.prior_authors * v_story_growth
        AND c.current_authors - st.prior_authors >= v_story_new_min)
  QUALIFY ROW_NUMBER() OVER (
    ORDER BY
      CASE c.priority_hint WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
      c.velocity_ratio DESC, c.current_authors DESC, c.grain_type, c.grain_key
  ) <= v_max_alerts;

  INSERT INTO `brand-social-central-data.early_detection.early_detection_alert_queue` (
    alert_id, created_at, signal_type, velocity_grain, cluster_id, signal_key,
    headline, topic_product, priority_hint, window_start, window_end,
    unique_low_tier_authors, mention_count, platform_count, platforms,
    baseline_authors, velocity_ratio, absolute_author_delta,
    primary_url, representative_posts, chatbot_card_text, chatbot_status
  )
  SELECT
    CONCAT('ED-VEL-', grain_type, '-', TO_HEX(MD5(grain_key)), '-', FORMAT_TIMESTAMP('%Y%m%d%H%M', v_now)) AS alert_id,
    v_now AS created_at,
    'VELOCITY_SPIKE' AS signal_type,
    grain_type AS velocity_grain,
    IF(grain_type = 'CLUSTER', grain_key, NULL) AS cluster_id,
    grain_key AS signal_key,
    CONCAT(
      'Low-tier velocity ', FORMAT('%.1fx', velocity_ratio), ' (', grain_type, ': ',
      COALESCE(cluster_label, grain_key), ')'
    ) AS headline,
    topic_product,
    priority_hint,
    v_win_start AS window_start,
    v_now AS window_end,
    current_authors AS unique_low_tier_authors,
    current_mentions AS mention_count,
    platform_count,
    platforms,
    ROUND(raw_baseline_authors, 2) AS baseline_authors,
    ROUND(velocity_ratio, 2) AS velocity_ratio,
    ROUND(absolute_author_delta, 2) AS absolute_author_delta,
    representative_posts[OFFSET(0)].url AS primary_url,
    representative_posts,
    CONCAT(
      '🚨 Early Detection Alert: ', topic_product, ' / Low-Tier Velocity ', FORMAT('%.1fx', velocity_ratio), ' - Negative 🚨\n',
      'Topic: ', topic_product, ' · ', grain_type, ': ', COALESCE(cluster_label, grain_key), '\n',
      'Platform: ', ARRAY_TO_STRING(platforms, ', '), '\n',
      'Author: @', representative_posts[OFFSET(0)].author_id,
        ' (+ ', CAST(GREATEST(current_authors - 1, 0) AS STRING), ' other low-tier accounts)\n',
      'Followers: ', COALESCE(CAST(representative_posts[OFFSET(0)].audience_size AS STRING), 'low-tier / unindexed'), '\n',
      'Engagement: Very Low (', CAST(current_mentions AS STRING), ' mentions / ',
        CAST(current_authors AS STRING), ' unique accounts vs ', FORMAT('%.1f', raw_baseline_authors),
        ' baseline; ', FORMAT('%.1fx', velocity_ratio), ' velocity)\n',
      'Product: ', topic_product, '\n',
      'Date: ', FORMAT_TIMESTAMP('%Y-%m-%d %H:%M UTC', v_now), '\n',
      'Link: ', COALESCE(representative_posts[OFFSET(0)].url, 'https://console.cloud.google.com/bigquery'), '\n',
      'Summary: Low-tier conversation accelerated to ', FORMAT('%.1fx', velocity_ratio),
        ' smoothed baseline (+', FORMAT('%.1f', absolute_author_delta), ' unique accounts over baseline) in the last ',
        CAST(v_win_min AS STRING), ' minutes across ', ARRAY_TO_STRING(platforms, '/'),
        '. Lead sample: "', representative_posts[OFFSET(0)].snippet, '"\n',
      'Text: ', (
        SELECT STRING_AGG(CONCAT('[', p.platform, ' @', p.author_id, '] ', p.snippet, ' (', COALESCE(p.url, 'no-link'), ')'), ' || ')
        FROM UNNEST(representative_posts) p
      )
    ) AS chatbot_card_text,
    'PENDING' AS chatbot_status
  FROM tmp_velocity_spikes;

  MERGE `brand-social-central-data.early_detection.velocity_alert_cooldowns` T
  USING tmp_velocity_spikes S
  ON T.grain_type = S.grain_type AND T.grain_key = S.grain_key
  WHEN MATCHED THEN UPDATE SET
    last_alerted_at = v_now,
    last_alerted_authors = S.current_authors
  WHEN NOT MATCHED THEN INSERT (grain_type, grain_key, last_alerted_at, last_alerted_authors)
    VALUES (S.grain_type, S.grain_key, v_now, S.current_authors);

  -- Retention: a cooldown row older than 14 days can no longer suppress anything
  DELETE FROM `brand-social-central-data.early_detection.velocity_alert_cooldowns`
  WHERE last_alerted_at < TIMESTAMP_SUB(v_now, INTERVAL 14 DAY);
END;
