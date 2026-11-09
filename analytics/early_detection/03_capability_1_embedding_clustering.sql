-- =============================================================================
-- 03_capability_1_embedding_clustering.sql
-- Materialized embedding cache (keyed by content_hash), evergreen vector noise
-- gate, incremental VECTOR_SEARCH similarity clustering, noteworthy cluster
-- promotion, and tuning telemetry.
-- Guardrails (early_detection_config): embedding_cache reads only scan the last
-- embedding_cache_reuse_days partitions; AI.GENERATE_EMBEDDING rows are capped per
-- run and per UTC day; the Stage B VECTOR_SEARCH pool is capped (newest first);
-- cluster alerts are capped per run; copy-paste rings that never name Google are
-- not promoted; active_clusters rows are purged after cluster_retention_days.
-- Same-story dedup: a cluster within story_dedup_max_cosine_distance of one that
-- alerted in the last story_dedup_hours is held back unless it materially grew
-- (then it is queued as an update of that alert: update_of_alert_id).
-- =============================================================================

CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.embedding_cache` (
  content_hash              STRING NOT NULL,
  sample_clean_text         STRING NOT NULL,
  embedding                 ARRAY<FLOAT64>,
  is_evergreen_noise        BOOL NOT NULL,
  closest_evergreen_topic   STRING,
  evergreen_cosine_distance FLOAT64,
  created_at                TIMESTAMP NOT NULL
)
PARTITION BY DATE(created_at)
CLUSTER BY content_hash
OPTIONS (
  partition_expiration_days = 90,
  labels = [('app', 'slrr-triage-agent'), ('layer', 'early-detection')]
);

CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.active_clusters` (
  cluster_id                STRING NOT NULL,
  created_at                TIMESTAMP NOT NULL,
  last_seen_at              TIMESTAMP NOT NULL,
  anchor_mention_id         STRING NOT NULL,
  cluster_label             STRING NOT NULL,
  dominant_topic_hint       STRING,
  centroid_embedding        ARRAY<FLOAT64>,
  total_mentions_24h        INT64 NOT NULL,
  unique_authors_24h        INT64 NOT NULL,
  last_alerted_at           TIMESTAMP,
  last_alerted_author_count INT64
)
CLUSTER BY cluster_id;

CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.mention_cluster_assignments` (
  mention_id        STRING NOT NULL,
  cluster_id        STRING NOT NULL,
  assignment_method STRING NOT NULL,
  cosine_distance   FLOAT64 NOT NULL,
  posted_at         TIMESTAMP NOT NULL,
  ingested_at       TIMESTAMP NOT NULL,
  assigned_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE(ingested_at)
CLUSTER BY cluster_id, mention_id
OPTIONS (partition_expiration_days = 30);

CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.cluster_run_metrics` (
  run_ts                      TIMESTAMP NOT NULL,
  candidate_mentions          INT64 NOT NULL,
  cache_hit_mentions          INT64 NOT NULL,
  newly_embedded_hashes       INT64 NOT NULL,
  evergreen_suppressed_count  INT64 NOT NULL,
  assigned_existing_count     INT64 NOT NULL,
  formed_new_clusters_count   INT64 NOT NULL,
  unassigned_singleton_count  INT64 NOT NULL,
  active_cluster_count        INT64 NOT NULL,
  p50_cluster_authors         FLOAT64,
  p90_cluster_authors         FLOAT64,
  max_cluster_authors         INT64,
  noteworthy_clusters_emitted INT64 NOT NULL,
  embeddings_skipped_budget   INT64,  -- Unseen hashes NOT embedded this run because the per-run / per-day budget ran out
  embedding_budget            INT64,  -- AI.GENERATE_EMBEDDING rows this run was allowed (LEAST(per-run cap, per-day cap - embedded today))
  copy_ring_suppressed        INT64,  -- Clusters that passed every gate but were dropped as copy-paste rings that never name Google
  pool_size                   INT64,  -- Stage B VECTOR_SEARCH pool after the max_cluster_pool cap
  story_dup_suppressed        INT64   -- Clusters held back as a repeat of a story already alerted (same-story dedup)
)
PARTITION BY DATE(run_ts);

-- Telemetry columns added after the first install (nullable, so ALTER works on an existing table)
ALTER TABLE `brand-social-central-data.early_detection.cluster_run_metrics`
  ADD COLUMN IF NOT EXISTS embeddings_skipped_budget INT64,
  ADD COLUMN IF NOT EXISTS embedding_budget INT64,
  ADD COLUMN IF NOT EXISTS copy_ring_suppressed INT64,
  ADD COLUMN IF NOT EXISTS pool_size INT64,
  ADD COLUMN IF NOT EXISTS story_dup_suppressed INT64;

CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.early_detection_alert_queue` (
  alert_id                STRING NOT NULL,
  created_at              TIMESTAMP NOT NULL,
  signal_type             STRING NOT NULL, -- CLUSTER_EMERGENCE | VELOCITY_SPIKE
  velocity_grain          STRING,
  cluster_id              STRING,
  signal_key              STRING NOT NULL,
  headline                STRING NOT NULL,
  topic_product           STRING NOT NULL,
  priority_hint           STRING NOT NULL,
  window_start            TIMESTAMP NOT NULL,
  window_end              TIMESTAMP NOT NULL,
  unique_low_tier_authors INT64 NOT NULL,
  mention_count           INT64 NOT NULL,
  platform_count          INT64 NOT NULL,
  platforms               ARRAY<STRING>,
  baseline_authors        FLOAT64,
  velocity_ratio          FLOAT64,
  absolute_author_delta   FLOAT64,
  primary_url             STRING,
  representative_posts    ARRAY<STRUCT<
    mention_id    STRING,
    platform      STRING,
    author_id     STRING,
    audience_size INT64,
    engagement    INT64,
    posted_at     TIMESTAMP,
    url           STRING,
    snippet       STRING
  >>,
  chatbot_card_text       STRING NOT NULL,
  chatbot_status          STRING NOT NULL, -- PENDING | POSTED | SKIPPED
  chatbot_claimed_at      TIMESTAMP,
  chatbot_message_name    STRING,
  update_of_alert_id      STRING,          -- Same-story dedup: the earlier alert this one updates (the story materially grew)
  update_of_authors       INT64            -- That earlier alert's unique_low_tier_authors
)
PARTITION BY DATE(created_at)
CLUSTER BY chatbot_status, signal_type, signal_key;

-- Columns added after the first install (nullable, so ALTER works on an existing table)
ALTER TABLE `brand-social-central-data.early_detection.early_detection_alert_queue`
  ADD COLUMN IF NOT EXISTS update_of_alert_id STRING,
  ADD COLUMN IF NOT EXISTS update_of_authors INT64;

CREATE OR REPLACE PROCEDURE `brand-social-central-data.early_detection.sp_embed_and_cluster_low_tier`(
  IN p_config_profile STRING
)
BEGIN
  DECLARE v_now TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE v_since, v_cache_since TIMESTAMP;
  DECLARE v_evergreen_dist, v_assign_dist, v_new_dist FLOAT64;
  DECLARE v_clust_win_h, v_active_h, v_eval_min, v_min_authors, v_min_plats, v_plat_disc, v_cooldown_min, v_min_urls INT64;
  DECLARE v_max_backfill_h, v_cache_days, v_max_embed_run, v_max_embed_day, v_max_pool, v_max_alerts, v_retention_days INT64;
  DECLARE v_candidates, v_cache_hits, v_new_embeds, v_evergreen_cnt, v_assigned_existing, v_new_clusters, v_unassigned, v_emitted INT64 DEFAULT 0;
  DECLARE v_embed_budget, v_embed_skipped, v_copy_ring_suppressed, v_pool_size INT64 DEFAULT 0;
  DECLARE v_story_dist, v_story_growth FLOAT64;
  DECLARE v_story_h, v_story_new_min INT64;
  DECLARE v_story_dup_suppressed INT64 DEFAULT 0;

  IF NOT EXISTS (
    SELECT 1 FROM `brand-social-central-data.early_detection.early_detection_config`
    WHERE config_profile = p_config_profile
  ) THEN
    RAISE USING MESSAGE = FORMAT('early_detection_config has no profile %T', p_config_profile);
  END IF;

  SET (v_evergreen_dist, v_clust_win_h, v_active_h, v_assign_dist, v_new_dist, v_eval_min,
       v_min_authors, v_min_plats, v_plat_disc, v_cooldown_min, v_min_urls,
       v_max_backfill_h, v_cache_days, v_max_embed_run, v_max_embed_day, v_max_pool, v_max_alerts, v_retention_days,
       v_story_dist, v_story_h, v_story_growth, v_story_new_min) = (
    SELECT AS STRUCT
      evergreen_max_cosine_distance, clustering_window_hours, cluster_active_horizon_hours,
      assign_max_cosine_distance, new_cluster_max_cosine_distance, cluster_eval_window_minutes,
      min_cluster_unique_authors, min_cluster_platforms, cross_platform_author_discount, cluster_cooldown_minutes,
      COALESCE(min_cluster_distinct_urls, 2),
      -- Cost & spike guardrails
      COALESCE(max_backfill_hours, 12),
      GREATEST(COALESCE(embedding_cache_reuse_days, 2), 1),
      COALESCE(max_new_embeddings_per_run, 3000),
      COALESCE(max_new_embeddings_per_day, 30000),
      COALESCE(max_cluster_pool, 15000),
      COALESCE(max_alerts_per_run, 8),
      GREATEST(COALESCE(cluster_retention_days, 3), 1),
      -- Same-story dedup
      COALESCE(story_dedup_max_cosine_distance, 0.14),
      GREATEST(COALESCE(story_dedup_hours, 24), 1),
      GREATEST(COALESCE(story_update_min_growth, 2.0), 1.0),
      GREATEST(COALESCE(story_update_min_new_authors, 3), 0)
    FROM `brand-social-central-data.early_detection.early_detection_config`
    WHERE config_profile = p_config_profile
  );

  -- Every embedding_cache read is limited to the last v_cache_days of partitions. A text last embedded before that is
  -- re-embedded, which only happens when no row for its hash exists inside the window, so the window never holds two.
  SET v_cache_since = TIMESTAMP_SUB(v_now, INTERVAL v_cache_days DAY);

  -- Never reach further back than max_backfill_hours (after a pause/outage the watermark could be days old)
  SET v_since = GREATEST(
    COALESCE(
      (SELECT TIMESTAMP_SUB(last_cutoff_ts, INTERVAL 5 MINUTE)
       FROM `brand-social-central-data.early_detection.pipeline_watermarks`
       WHERE step_name = 'embed_and_cluster'),
      TIMESTAMP_SUB(v_now, INTERVAL v_clust_win_h HOUR)
    ),
    TIMESTAMP_SUB(v_now, INTERVAL v_max_backfill_h HOUR)
  );

  CREATE TEMP TABLE tmp_new_mentions AS
  SELECT m.*
  FROM `brand-social-central-data.early_detection.low_tier_mentions` m
  LEFT JOIN `brand-social-central-data.early_detection.mention_cluster_assignments` a
    ON a.mention_id = m.mention_id
   AND a.ingested_at >= TIMESTAMP_SUB(v_since, INTERVAL 1 DAY)
  WHERE m.ingested_at >= v_since
    AND a.mention_id IS NULL;

  SET v_candidates = (SELECT COUNT(*) FROM tmp_new_mentions);

  -- Embedding budget: hard per-run and per-UTC-day ceilings on AI.GENERATE_EMBEDDING rows (Vertex calls)
  SET v_embed_budget = GREATEST(0, LEAST(
    v_max_embed_run,
    v_max_embed_day - (
      SELECT COUNT(*)
      FROM `brand-social-central-data.early_detection.embedding_cache`
      WHERE created_at >= TIMESTAMP_TRUNC(v_now, DAY)
    )
  ));

  -- Unseen content_hash values (no cache row inside the reuse window)
  CREATE TEMP TABLE tmp_missing_hashes_all AS
  SELECT
    m.content_hash,
    ANY_VALUE(m.clean_text) AS content,
    COUNT(DISTINCT m.author_id) AS authors,
    MAX(m.posted_at) AS last_posted
  FROM tmp_new_mentions m
  LEFT JOIN `brand-social-central-data.early_detection.embedding_cache` c
    ON c.content_hash = m.content_hash
   AND c.created_at >= v_cache_since
  WHERE c.content_hash IS NULL
  GROUP BY m.content_hash;

  SET (v_cache_hits, v_embed_skipped) = (
    SELECT AS STRUCT
      v_candidates - (
        SELECT COUNT(*) FROM tmp_new_mentions m
        JOIN tmp_missing_hashes_all h ON h.content_hash = m.content_hash
      ),
      GREATEST(0, (SELECT COUNT(*) FROM tmp_missing_hashes_all) - v_embed_budget)
  );

  -- Generate embeddings strictly for unseen content_hash values, at most v_embed_budget of them: hashes shared by more
  -- authors carry more signal, then the most recent. Hashes over budget are skipped (not clustered) this run.
  CREATE TEMP TABLE tmp_missing_hashes AS
  SELECT content_hash, content
  FROM tmp_missing_hashes_all
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (ORDER BY authors DESC, last_posted DESC, content_hash) <= v_embed_budget;

  IF (SELECT COUNT(*) FROM tmp_missing_hashes) > 0 THEN
    INSERT INTO `brand-social-central-data.early_detection.embedding_cache` (
      content_hash, sample_clean_text, embedding,
      is_evergreen_noise, closest_evergreen_topic, evergreen_cosine_distance, created_at
    )
    WITH generated AS (
      SELECT
        content_hash,
        content AS sample_clean_text,
        embedding
      FROM AI.GENERATE_EMBEDDING(
        MODEL `brand-social-central-data.early_detection.text_embedding_model`,
        (SELECT content_hash, content FROM tmp_missing_hashes),
        STRUCT('CLUSTERING' AS task_type, 768 AS output_dimensionality)
      )
      WHERE status = '' AND ARRAY_LENGTH(embedding) = 768
    ),
    evergreen_check AS (
      SELECT
        g.content_hash,
        ARRAY_AGG(
          STRUCT(ev.topic_id, ML.DISTANCE(g.embedding, ev.embedding, 'COSINE') AS dist)
          ORDER BY ML.DISTANCE(g.embedding, ev.embedding, 'COSINE') ASC
          LIMIT 1
        )[OFFSET(0)] AS nearest_ev
      FROM generated g
      CROSS JOIN `brand-social-central-data.DSD.evergreen_vectors` ev
      WHERE ARRAY_LENGTH(ev.embedding) = 768
      GROUP BY g.content_hash
    )
    SELECT
      g.content_hash,
      g.sample_clean_text,
      g.embedding,
      COALESCE(ec.nearest_ev.dist <= v_evergreen_dist, FALSE) AS is_evergreen_noise,
      ec.nearest_ev.topic_id AS closest_evergreen_topic,
      ec.nearest_ev.dist AS evergreen_cosine_distance,
      v_now AS created_at
    FROM generated g
    LEFT JOIN evergreen_check ec USING (content_hash);

    SET v_new_embeds = @@row_count;
  END IF;

  CREATE TEMP TABLE tmp_candidate_vectors AS
  SELECT
    m.mention_id, m.platform, m.author_id, m.posted_at, m.ingested_at,
    m.topic_hint, m.clean_text, c.embedding, c.is_evergreen_noise
  FROM tmp_new_mentions m
  JOIN `brand-social-central-data.early_detection.embedding_cache` c
    ON c.content_hash = m.content_hash
   AND c.created_at >= v_cache_since;

  SET v_evergreen_cnt = (SELECT COUNTIF(is_evergreen_noise) FROM tmp_candidate_vectors);
  DELETE FROM tmp_candidate_vectors WHERE is_evergreen_noise = TRUE;

  -- Stage A: Attach incremental mentions to existing active cluster centroids
  CREATE TEMP TABLE tmp_active_centroids AS
  SELECT cluster_id, centroid_embedding
  FROM `brand-social-central-data.early_detection.active_clusters`
  WHERE last_seen_at >= TIMESTAMP_SUB(v_now, INTERVAL v_active_h HOUR)
    AND ARRAY_LENGTH(centroid_embedding) = 768;

  IF (SELECT COUNT(*) FROM tmp_candidate_vectors) > 0 AND (SELECT COUNT(*) FROM tmp_active_centroids) > 0 THEN
    INSERT INTO `brand-social-central-data.early_detection.mention_cluster_assignments`
      (mention_id, cluster_id, assignment_method, cosine_distance, posted_at, ingested_at, assigned_at)
    SELECT
      vs.query.mention_id,
      vs.base.cluster_id,
      'EXISTING_CENTROID' AS assignment_method,
      vs.distance AS cosine_distance,
      vs.query.posted_at,
      vs.query.ingested_at,
      v_now AS assigned_at
    FROM VECTOR_SEARCH(
      (SELECT cluster_id, centroid_embedding FROM tmp_active_centroids),
      'centroid_embedding',
      (SELECT mention_id, posted_at, ingested_at, embedding FROM tmp_candidate_vectors),
      query_column_to_search => 'embedding',
      top_k => 1,
      distance_type => 'COSINE',
      options => '{"use_brute_force": true}'
    ) vs
    WHERE vs.distance <= v_assign_dist;

    SET v_assigned_existing = @@row_count;
  END IF;

  -- Stage B: Discover new clusters among unassigned low-tier mentions
  CREATE TEMP TABLE tmp_unassigned_pool AS
  SELECT
    m.mention_id, m.platform, m.author_id, m.posted_at, m.ingested_at,
    m.topic_hint, m.clean_text, c.embedding
  FROM `brand-social-central-data.early_detection.low_tier_mentions` m
  JOIN `brand-social-central-data.early_detection.embedding_cache` c
    ON c.content_hash = m.content_hash
   AND c.created_at >= v_cache_since
  LEFT JOIN `brand-social-central-data.early_detection.mention_cluster_assignments` a
    ON a.mention_id = m.mention_id
   AND a.ingested_at >= TIMESTAMP_SUB(v_now, INTERVAL v_clust_win_h + 2 HOUR)
  WHERE m.ingested_at >= TIMESTAMP_SUB(v_now, INTERVAL v_clust_win_h HOUR)
    AND NOT c.is_evergreen_noise
    AND a.mention_id IS NULL
  -- The brute-force search below is pool x pool, so the pool is capped (newest mentions first)
  QUALIFY ROW_NUMBER() OVER (ORDER BY m.posted_at DESC, m.mention_id) <= v_max_pool;

  SET v_pool_size = (SELECT COUNT(*) FROM tmp_unassigned_pool);

  IF v_pool_size >= 2 THEN
    CREATE TEMP TABLE tmp_new_cluster_members AS
    WITH neighbor_edges AS (
      SELECT
        vs.query.mention_id AS anchor_id,
        vs.query.posted_at AS anchor_posted_at,
        vs.query.clean_text AS anchor_text,
        vs.query.topic_hint AS anchor_topic,
        vs.base.mention_id AS member_id,
        vs.base.author_id AS member_author,
        vs.base.posted_at AS member_posted_at,
        vs.base.ingested_at AS member_ingested_at,
        vs.distance
      FROM VECTOR_SEARCH(
        (SELECT mention_id, author_id, posted_at, ingested_at, embedding FROM tmp_unassigned_pool),
        'embedding',
        (SELECT mention_id, posted_at, clean_text, topic_hint, embedding FROM tmp_unassigned_pool),
        query_column_to_search => 'embedding',
        top_k => 25,
        distance_type => 'COSINE',
        options => '{"use_brute_force": true}'
      ) vs
      WHERE vs.distance <= v_new_dist
    ),
    candidate_anchors AS (
      SELECT
        anchor_id,
        ANY_VALUE(anchor_posted_at) AS anchor_posted_at,
        ANY_VALUE(anchor_text) AS anchor_text,
        ANY_VALUE(anchor_topic) AS anchor_topic,
        COUNT(DISTINCT member_author) AS distinct_author_degree
      FROM neighbor_edges
      GROUP BY anchor_id
      HAVING COUNT(DISTINCT member_author) >= 2
    ),
    best_anchor_per_member AS (
      SELECT
        CONCAT('CLU-', SUBSTR(TO_HEX(SHA256(ca.anchor_id)), 1, 12)) AS cluster_id,
        ca.anchor_id,
        ca.anchor_text,
        ca.anchor_topic,
        ne.member_id AS mention_id,
        ne.distance AS cosine_distance,
        ne.member_posted_at AS posted_at,
        ne.member_ingested_at AS ingested_at
      FROM neighbor_edges ne
      JOIN candidate_anchors ca ON ca.anchor_id = ne.anchor_id
      WHERE TRUE
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY ne.member_id
        ORDER BY ca.distinct_author_degree DESC, ca.anchor_posted_at ASC, ne.distance ASC
      ) = 1
    ),
    valid_new_clusters AS (
      SELECT cluster_id
      FROM best_anchor_per_member
      GROUP BY cluster_id
      HAVING COUNT(*) >= 2
    )
    SELECT b.*
    FROM best_anchor_per_member b
    JOIN valid_new_clusters v USING (cluster_id);

    INSERT INTO `brand-social-central-data.early_detection.mention_cluster_assignments`
      (mention_id, cluster_id, assignment_method, cosine_distance, posted_at, ingested_at, assigned_at)
    SELECT
      mention_id, cluster_id, 'NEW_ANCHOR_GRAPH', cosine_distance, posted_at, ingested_at, v_now
    FROM tmp_new_cluster_members;

    SET v_new_clusters = (SELECT COUNT(DISTINCT cluster_id) FROM tmp_new_cluster_members);
  END IF;

  SET v_unassigned = (
    SELECT COUNT(*)
    FROM tmp_candidate_vectors cv
    LEFT JOIN `brand-social-central-data.early_detection.mention_cluster_assignments` a
      ON a.mention_id = cv.mention_id
     AND a.ingested_at >= TIMESTAMP_SUB(v_since, INTERVAL 1 DAY)
    WHERE a.mention_id IS NULL
  );

  -- Refresh active_clusters L2-normalized centroids
  MERGE `brand-social-central-data.early_detection.active_clusters` T
  USING (
    WITH recent_members AS (
      SELECT
        a.cluster_id,
        m.mention_id,
        m.author_id,
        m.posted_at,
        m.topic_hint,
        m.clean_text,
        c.embedding
      FROM `brand-social-central-data.early_detection.mention_cluster_assignments` a
      JOIN `brand-social-central-data.early_detection.low_tier_mentions` m
        ON m.mention_id = a.mention_id
       AND m.ingested_at >= TIMESTAMP_SUB(v_now, INTERVAL v_active_h + 2 HOUR)
      JOIN `brand-social-central-data.early_detection.embedding_cache` c
        ON c.content_hash = m.content_hash
       AND c.created_at >= v_cache_since
      WHERE a.ingested_at >= TIMESTAMP_SUB(v_now, INTERVAL v_active_h HOUR)
    ),
    dim_means AS (
      SELECT cluster_id, dim_idx, AVG(val) AS mean_val
      FROM recent_members, UNNEST(embedding) AS val WITH OFFSET AS dim_idx
      GROUP BY cluster_id, dim_idx
    ),
    dim_norms AS (
      SELECT cluster_id, SQRT(SUM(mean_val * mean_val)) AS l2_norm
      FROM dim_means
      GROUP BY cluster_id
    ),
    centroids AS (
      SELECT
        dm.cluster_id,
        ARRAY_AGG(dm.mean_val / dn.l2_norm ORDER BY dm.dim_idx) AS centroid_embedding
      FROM dim_means dm
      JOIN dim_norms dn USING (cluster_id)
      WHERE dn.l2_norm > 0
      GROUP BY dm.cluster_id
    ),
    cluster_meta AS (
      SELECT
        cluster_id,
        MIN(posted_at) AS first_posted_at,
        MAX(posted_at) AS last_seen_at,
        ARRAY_AGG(mention_id ORDER BY posted_at ASC LIMIT 1)[OFFSET(0)] AS anchor_mention_id,
        SUBSTR(ARRAY_AGG(clean_text ORDER BY CHAR_LENGTH(clean_text) ASC LIMIT 1)[OFFSET(0)], 1, 140) AS cluster_label,
        APPROX_TOP_COUNT(COALESCE(topic_hint, 'Brand'), 1)[OFFSET(0)].value AS dominant_topic_hint,
        COUNT(*) AS total_mentions_24h,
        COUNT(DISTINCT author_id) AS unique_authors_24h
      FROM recent_members
      GROUP BY cluster_id
    )
    SELECT
      cm.cluster_id,
      cm.first_posted_at AS created_at,
      cm.last_seen_at,
      cm.anchor_mention_id,
      cm.cluster_label,
      cm.dominant_topic_hint,
      ce.centroid_embedding,
      cm.total_mentions_24h,
      cm.unique_authors_24h
    FROM cluster_meta cm
    JOIN centroids ce USING (cluster_id)
  ) S
  ON T.cluster_id = S.cluster_id
  WHEN MATCHED THEN UPDATE SET
    last_seen_at = S.last_seen_at,
    centroid_embedding = S.centroid_embedding,
    dominant_topic_hint = S.dominant_topic_hint,
    total_mentions_24h = S.total_mentions_24h,
    unique_authors_24h = S.unique_authors_24h
  WHEN NOT MATCHED THEN INSERT (
    cluster_id, created_at, last_seen_at, anchor_mention_id, cluster_label,
    dominant_topic_hint, centroid_embedding, total_mentions_24h, unique_authors_24h,
    last_alerted_at, last_alerted_author_count
  ) VALUES (
    S.cluster_id, S.created_at, S.last_seen_at, S.anchor_mention_id, S.cluster_label,
    S.dominant_topic_hint, S.centroid_embedding, S.total_mentions_24h, S.unique_authors_24h,
    NULL, NULL
  );

  -- Retention: active_clusters is unpartitioned and every run scans it in full (768-float centroids), so clusters not
  -- seen for cluster_retention_days are purged (never anything inside the active horizon)
  DELETE FROM `brand-social-central-data.early_detection.active_clusters`
  WHERE last_seen_at < TIMESTAMP_SUB(v_now, INTERVAL GREATEST(v_retention_days * 24, v_active_h) HOUR);

  -- Evaluate Noteworthy Clusters & Enqueue for Chatbot Triage
  CREATE TEMP TABLE tmp_cluster_candidates AS
  WITH eval_window AS (
    SELECT
      a.cluster_id,
      m.mention_id,
      m.platform,
      m.author_id,
      m.audience_size,
      m.engagement_count,
      m.posted_at,
      m.canonical_url,
      m.clean_text,
      m.content_hash,
      m.risk_term_groups,
      a.cosine_distance
    FROM `brand-social-central-data.early_detection.mention_cluster_assignments` a
    JOIN `brand-social-central-data.early_detection.low_tier_mentions` m
      ON m.mention_id = a.mention_id
     AND m.ingested_at >= TIMESTAMP_SUB(v_now, INTERVAL v_eval_min + 480 MINUTE)
    WHERE m.posted_at >= TIMESTAMP_SUB(v_now, INTERVAL v_eval_min MINUTE)
      AND a.ingested_at >= TIMESTAMP_SUB(v_now, INTERVAL v_eval_min + 480 MINUTE)
  ),
  ranked_samples AS (
    SELECT *
    FROM eval_window
    WHERE TRUE
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY cluster_id, platform, author_id
      ORDER BY cosine_distance ASC, engagement_count DESC
    ) = 1
  ),
  aggregated AS (
    SELECT
      e.cluster_id,
      COUNT(*) AS mention_count,
      COUNT(DISTINCT CONCAT(e.platform, ':', e.author_id)) AS unique_low_tier_authors,
      COUNT(DISTINCT e.platform) AS platform_count,
      ARRAY_AGG(DISTINCT e.platform ORDER BY e.platform) AS platforms,
      MIN(e.posted_at) AS window_start,
      MAX(e.posted_at) AS window_end,
      LOGICAL_OR(ARRAY_LENGTH(e.risk_term_groups) > 0) AS has_risk_terms,
      COUNT(DISTINCT e.canonical_url) AS url_count,
      COUNT(DISTINCT e.content_hash) AS distinct_texts,
      -- Same entity regex as 02 quality_checked (single backslashes here: this file is not inside FORMAT())
      LOGICAL_OR(REGEXP_CONTAINS(
        LOWER(e.clean_text),
        r'\b(google|alphabet|sundar|pichai|gemini|pixel|android|youtube|waymo|deepmind|nest|chromebook|chromeos|chrome|workspace|gmail|maps|waze|fitbit|gboard|wing|verily|isomorphic|play\s+store|google\s+(?:maps|photos|cloud|drive|pay|wallet|play|ads|search|tv|fi|lens|one)|ai\s+overviews?|notebooklm|veo|imagen)\b'
      )) AS names_brand
    FROM eval_window e
    GROUP BY e.cluster_id
  ),
  sample_list AS (
    SELECT
      cluster_id,
      ARRAY_AGG(
        STRUCT(
          mention_id, platform, author_id, audience_size,
          engagement_count AS engagement, posted_at,
          canonical_url AS url, SUBSTR(clean_text, 1, 280) AS snippet
        )
        ORDER BY cosine_distance ASC, engagement_count DESC
        LIMIT 8
      ) AS representative_posts
    FROM ranked_samples
    GROUP BY cluster_id
  )
  SELECT
    ag.cluster_id,
    ac.cluster_label,
    COALESCE(ac.dominant_topic_hint, 'Brand') AS topic_product,
    IF(ag.has_risk_terms OR ag.platform_count >= 2, 'P1', 'P2') AS priority_hint,
    ag.window_start,
    ag.window_end,
    ag.unique_low_tier_authors,
    ag.mention_count,
    ag.platform_count,
    ag.platforms,
    sl.representative_posts[OFFSET(0)].url AS primary_url,
    sl.representative_posts,
    -- Copy-paste spam ring: mostly identical copies from many small accounts that never name Google or a product
    -- (a copy-paste ring that DOES name Google stays, and Gemini judges it in the bot)
    COALESCE(ag.distinct_texts * 3 <= ag.unique_low_tier_authors AND NOT ag.names_brand, FALSE) AS is_copy_ring
  FROM aggregated ag
  JOIN `brand-social-central-data.early_detection.active_clusters` ac USING (cluster_id)
  JOIN sample_list sl USING (cluster_id)
  WHERE ag.platform_count >= v_min_plats
    AND ag.url_count >= v_min_urls
    AND ag.unique_low_tier_authors >= GREATEST(
      2,
      v_min_authors - IF(ag.platform_count >= 2, v_plat_disc, 0)
    )
    AND (
      ac.last_alerted_at IS NULL
      OR ac.last_alerted_at < TIMESTAMP_SUB(v_now, INTERVAL v_cooldown_min MINUTE)
      OR ag.unique_low_tier_authors >= COALESCE(ac.last_alerted_author_count, 0) * 2
    );

  SET v_copy_ring_suppressed = (SELECT COUNTIF(is_copy_ring) FROM tmp_cluster_candidates);

  -- Same-story dedup: one story, one alert, unless it materially grew. A candidate whose centroid is within
  -- v_story_dist (cosine) of a cluster that already alerted in the last v_story_h hours (any signal type; that
  -- cluster's latest alert) is the same story told again. It is queued only as an UPDATE of the latest such alert: when
  -- its authors reached v_story_growth x that alert's and at least v_story_new_min more, or it reached a platform that
  -- alert didn't have. Otherwise it is held back (story_dup_suppressed) and not stamped below, so it can still go out as
  -- an update once it grows. Two candidates of one story in the same run keep the one with the most authors. The same
  -- cluster alerting again is distance 0, so it follows the same rule (on top of the cooldown above).
  -- Vectors are filtered to 768 dims in the materialized temp tables before any ML.DISTANCE call.
  CREATE TEMP TABLE tmp_story_cands AS
  SELECT c.cluster_id, c.unique_low_tier_authors AS authors, c.platforms, ac.centroid_embedding AS vec
  FROM tmp_cluster_candidates c
  JOIN `brand-social-central-data.early_detection.active_clusters` ac USING (cluster_id)
  WHERE NOT c.is_copy_ring
    AND ARRAY_LENGTH(ac.centroid_embedding) = 768;

  CREATE TEMP TABLE tmp_story_prior AS
  SELECT q.alert_id, q.cluster_id, q.created_at, q.unique_low_tier_authors AS authors, q.platforms,
         ac.centroid_embedding AS vec
  FROM `brand-social-central-data.early_detection.early_detection_alert_queue` q
  JOIN `brand-social-central-data.early_detection.active_clusters` ac USING (cluster_id)
  WHERE q.created_at >= TIMESTAMP_SUB(v_now, INTERVAL v_story_h HOUR)
    AND q.cluster_id IS NOT NULL
    AND q.chatbot_status != 'SKIPPED'
    AND ARRAY_LENGTH(ac.centroid_embedding) = 768
  QUALIFY ROW_NUMBER() OVER (PARTITION BY q.cluster_id ORDER BY q.created_at DESC, q.alert_id DESC) = 1;

  CREATE TEMP TABLE tmp_story_check AS
  WITH prior_hits AS (
    SELECT
      c.cluster_id,
      p.alert_id,
      p.created_at AS prior_at,
      p.authors AS prior_authors,
      COALESCE(
        (c.authors >= p.authors * v_story_growth AND c.authors - p.authors >= v_story_new_min)
        OR (ARRAY_LENGTH(p.platforms) > 0
            AND EXISTS (SELECT 1 FROM UNNEST(c.platforms) AS pl WHERE pl NOT IN UNNEST(p.platforms))),
        FALSE
      ) AS is_update
    FROM tmp_story_cands c
    CROSS JOIN tmp_story_prior p
    WHERE ML.DISTANCE(c.vec, p.vec, 'COSINE') <= v_story_dist
  ),
  vs_prior AS (
    SELECT
      cluster_id,
      LOGICAL_AND(is_update) AS is_update,
      ARRAY_AGG(STRUCT(alert_id, prior_authors) ORDER BY prior_at DESC, alert_id DESC LIMIT 1)[OFFSET(0)] AS latest
    FROM prior_hits
    GROUP BY cluster_id
  ),
  allowed AS (
    SELECT
      c.cluster_id,
      c.authors,
      c.vec,
      v.latest.alert_id AS update_of_alert_id,
      v.latest.prior_authors AS update_of_authors
    FROM tmp_story_cands c
    LEFT JOIN vs_prior v ON v.cluster_id = c.cluster_id
    WHERE v.cluster_id IS NULL OR v.is_update
  ),
  dominated AS (
    SELECT DISTINCT a.cluster_id
    FROM allowed a
    CROSS JOIN allowed b
    WHERE b.cluster_id != a.cluster_id
      AND (b.authors > a.authors OR (b.authors = a.authors AND b.cluster_id < a.cluster_id))
      AND ML.DISTANCE(a.vec, b.vec, 'COSINE') <= v_story_dist
  )
  SELECT
    c.cluster_id,
    al.cluster_id IS NOT NULL AND d.cluster_id IS NULL AS keep,
    al.update_of_alert_id,
    al.update_of_authors
  FROM tmp_story_cands c
  LEFT JOIN allowed al ON al.cluster_id = c.cluster_id
  LEFT JOIN dominated d ON d.cluster_id = c.cluster_id;

  SET v_story_dup_suppressed = (SELECT COUNTIF(NOT keep) FROM tmp_story_check);

  -- At most v_max_alerts cluster alerts per run; capped-out clusters are not stamped below, so they can alert next run.
  -- A candidate without a 768-dim centroid never reached the story check, so it is kept.
  CREATE TEMP TABLE tmp_noteworthy_clusters AS
  SELECT c.* EXCEPT(is_copy_ring), s.update_of_alert_id, s.update_of_authors
  FROM tmp_cluster_candidates c
  LEFT JOIN tmp_story_check s ON s.cluster_id = c.cluster_id
  WHERE NOT c.is_copy_ring
    AND COALESCE(s.keep, TRUE)
  QUALIFY ROW_NUMBER() OVER (
    ORDER BY
      CASE c.priority_hint WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
      c.unique_low_tier_authors DESC, c.platform_count DESC, c.window_end DESC, c.cluster_id
  ) <= v_max_alerts;

  INSERT INTO `brand-social-central-data.early_detection.early_detection_alert_queue` (
    alert_id, created_at, signal_type, velocity_grain, cluster_id, signal_key,
    headline, topic_product, priority_hint, window_start, window_end,
    unique_low_tier_authors, mention_count, platform_count, platforms,
    baseline_authors, velocity_ratio, absolute_author_delta,
    primary_url, representative_posts, chatbot_card_text, chatbot_status,
    update_of_alert_id, update_of_authors
  )
  SELECT
    CONCAT('ED-CLU-', cluster_id, '-', FORMAT_TIMESTAMP('%Y%m%d%H%M', v_now)) AS alert_id,
    v_now AS created_at,
    'CLUSTER_EMERGENCE' AS signal_type,
    CAST(NULL AS STRING) AS velocity_grain,
    cluster_id,
    cluster_id AS signal_key,
    CONCAT('Low-tier claim cluster (', CAST(unique_low_tier_authors AS STRING), ' accounts): ', cluster_label) AS headline,
    topic_product,
    priority_hint,
    window_start,
    window_end,
    unique_low_tier_authors,
    mention_count,
    platform_count,
    platforms,
    CAST(NULL AS FLOAT64),
    CAST(NULL AS FLOAT64),
    CAST(NULL AS FLOAT64),
    primary_url,
    representative_posts,
    CONCAT(
      '🚨 Early Detection Alert: ', topic_product, ' / Convergent Low-Tier Claim - Negative 🚨\n',
      'Topic: ', topic_product, ' (', cluster_id, ')\n',
      'Platform: ', ARRAY_TO_STRING(platforms, ', '), '\n',
      'Author: @', representative_posts[OFFSET(0)].author_id,
        ' (+ ', CAST(GREATEST(unique_low_tier_authors - 1, 0) AS STRING), ' other low-tier accounts)\n',
      'Followers: ', COALESCE(CAST(representative_posts[OFFSET(0)].audience_size AS STRING), 'low-tier / unindexed'), '\n',
      'Engagement: Very Low (', CAST(mention_count AS STRING), ' cluster mentions across ',
        CAST(unique_low_tier_authors AS STRING), ' unique accounts)\n',
      'Product: ', topic_product, '\n',
      'Date: ', FORMAT_TIMESTAMP('%Y-%m-%d %H:%M UTC', window_end), '\n',
      'Link: ', COALESCE(primary_url, 'https://console.cloud.google.com/bigquery'), '\n',
      'Summary: Convergent low-tier claim detected across ', CAST(unique_low_tier_authors AS STRING),
        ' distinct accounts on ', ARRAY_TO_STRING(platforms, '/'),
        ' between ', FORMAT_TIMESTAMP('%H:%M', window_start), ' and ', FORMAT_TIMESTAMP('%H:%M UTC', window_end),
        '. Representative claim: "', representative_posts[OFFSET(0)].snippet, '"\n',
      'Text: ', (
        SELECT STRING_AGG(CONCAT('[', p.platform, ' @', p.author_id, '] ', p.snippet, ' (', COALESCE(p.url, 'no-link'), ')'), ' || ')
        FROM UNNEST(representative_posts) p
      )
    ) AS chatbot_card_text,
    'PENDING' AS chatbot_status,
    update_of_alert_id,
    update_of_authors
  FROM tmp_noteworthy_clusters;

  SET v_emitted = @@row_count;

  MERGE `brand-social-central-data.early_detection.active_clusters` T
  USING tmp_noteworthy_clusters S
  ON T.cluster_id = S.cluster_id
  WHEN MATCHED THEN UPDATE SET
    last_alerted_at = v_now,
    last_alerted_author_count = S.unique_low_tier_authors;

  INSERT INTO `brand-social-central-data.early_detection.cluster_run_metrics` (
    run_ts, candidate_mentions, cache_hit_mentions, newly_embedded_hashes, evergreen_suppressed_count,
    assigned_existing_count, formed_new_clusters_count, unassigned_singleton_count, active_cluster_count,
    p50_cluster_authors, p90_cluster_authors, max_cluster_authors, noteworthy_clusters_emitted,
    embeddings_skipped_budget, embedding_budget, copy_ring_suppressed, pool_size, story_dup_suppressed
  )
  SELECT
    v_now AS run_ts,
    v_candidates AS candidate_mentions,
    v_cache_hits AS cache_hit_mentions,
    v_new_embeds AS newly_embedded_hashes,
    v_evergreen_cnt AS evergreen_suppressed_count,
    v_assigned_existing AS assigned_existing_count,
    v_new_clusters AS formed_new_clusters_count,
    v_unassigned AS unassigned_singleton_count,
    COUNT(*) AS active_cluster_count,
    APPROX_QUANTILES(unique_authors_24h, 100)[OFFSET(50)] AS p50_cluster_authors,
    APPROX_QUANTILES(unique_authors_24h, 100)[OFFSET(90)] AS p90_cluster_authors,
    MAX(unique_authors_24h) AS max_cluster_authors,
    v_emitted AS noteworthy_clusters_emitted,
    v_embed_skipped AS embeddings_skipped_budget,
    v_embed_budget AS embedding_budget,
    v_copy_ring_suppressed AS copy_ring_suppressed,
    v_pool_size AS pool_size,
    v_story_dup_suppressed AS story_dup_suppressed
  FROM `brand-social-central-data.early_detection.active_clusters`
  WHERE last_seen_at >= TIMESTAMP_SUB(v_now, INTERVAL v_active_h HOUR);

  MERGE `brand-social-central-data.early_detection.pipeline_watermarks` T
  USING (SELECT 'embed_and_cluster' AS step_name, v_now AS last_cutoff_ts, v_now AS updated_at) S
  ON T.step_name = S.step_name
  WHEN MATCHED THEN UPDATE SET last_cutoff_ts = S.last_cutoff_ts, updated_at = S.updated_at
  WHEN NOT MATCHED THEN INSERT ROW;
END;
