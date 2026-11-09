-- =============================================================================
-- 02_low_tier_ingestion.sql
-- Shared low-tier mention normalization, noise stripping, quality gates,
-- same-author near-duplicate deduplication, and SHA256 content_hash computation.
--
-- Time columns on low_tier_mentions:
--   posted_at          when the post/comment was published (velocity & cluster evaluation windows)
--   ingested_at        when THIS pipeline landed the row (incremental embedding/clustering; partition column)
--   source_ingested_at the source table's own ingestion / added time (freshness monitoring)
-- Each run re-reads the source back to (last cutoff - ingest_overlap_minutes) so rows that land late in their source
-- table (Sprinklr comments ~15-30 min, BMIE ~20 min) are still picked up; the MERGE on mention_id keeps them unique.
-- Guardrails: the re-read never reaches further back than max_backfill_hours (12h), and at most
-- max_ingest_rows_per_run (20,000) NEW rows are landed per run, newest source_ingested_at first.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `brand-social-central-data.early_detection.low_tier_mentions` (
  mention_id         STRING NOT NULL,
  source_name        STRING NOT NULL,
  canonical_url      STRING,
  platform           STRING NOT NULL,
  author_id          STRING NOT NULL,
  audience_size      INT64,
  engagement_count   INT64 NOT NULL,
  posted_at          TIMESTAMP NOT NULL,
  ingested_at        TIMESTAMP NOT NULL,
  topic_hint         STRING,
  raw_text           STRING,
  clean_text         STRING NOT NULL,
  norm_claim_text    STRING NOT NULL,
  content_hash       STRING NOT NULL,
  author_dedup_sig   INT64 NOT NULL,
  risk_term_groups   ARRAY<STRING>,
  source_ingested_at TIMESTAMP
)
PARTITION BY DATE(ingested_at)
CLUSTER BY content_hash, platform, author_id
OPTIONS (
  partition_expiration_days = 30,
  labels = [('app', 'slrr-triage-agent'), ('layer', 'early-detection')]
);

CREATE OR REPLACE PROCEDURE `brand-social-central-data.early_detection.sp_ingest_low_tier_mentions`(
  IN p_config_profile STRING
)
BEGIN
  DECLARE v_now TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE v_since TIMESTAMP;
  DECLARE v_max_aud, v_eng_ceil, v_min_chars, v_min_tokens, v_dedup_hrs, v_overlap_min INT64;
  DECLARE v_max_backfill_h, v_max_rows INT64;
  DECLARE v_allow_null_aud BOOL;
  DECLARE v_union_sql STRING;

  IF NOT EXISTS (
    SELECT 1 FROM `brand-social-central-data.early_detection.early_detection_config`
    WHERE config_profile = p_config_profile
  ) THEN
    RAISE USING MESSAGE = FORMAT('early_detection_config has no profile %T', p_config_profile);
  END IF;

  SET (v_max_aud, v_allow_null_aud, v_eng_ceil, v_min_chars, v_min_tokens, v_dedup_hrs, v_overlap_min,
       v_max_backfill_h, v_max_rows) = (
    SELECT AS STRUCT
      max_low_tier_audience, allow_null_audience, solo_alert_engagement_ceiling,
      min_clean_chars, min_token_count, same_author_dedup_hours, ingest_overlap_minutes,
      -- Cost & spike guardrails
      COALESCE(max_backfill_hours, 12), COALESCE(max_ingest_rows_per_run, 20000)
    FROM `brand-social-central-data.early_detection.early_detection_config`
    WHERE config_profile = p_config_profile
  );

  -- Re-read back to (last cutoff - overlap), but never further back than max_backfill_hours (after a pause/outage the
  -- watermark could be days old, and every source scan would grow with it)
  SET v_since = GREATEST(
    TIMESTAMP_SUB(
      COALESCE(
        (SELECT last_cutoff_ts
         FROM `brand-social-central-data.early_detection.pipeline_watermarks`
         WHERE step_name = 'ingest_low_tier'),
        TIMESTAMP_SUB(v_now, INTERVAL 2 HOUR)
      ),
      INTERVAL v_overlap_min MINUTE
    ),
    TIMESTAMP_SUB(v_now, INTERVAL v_max_backfill_h HOUR)
  );

  SET v_union_sql = (
    SELECT STRING_AGG(
      FORMAT("""
        SELECT
          %T AS source_name,
          %s AS requires_entity_match,
          CAST(%s AS STRING) AS mention_id,
          CAST(%s AS STRING) AS raw_url,
          CAST(%s AS STRING) AS platform,
          CAST(%s AS STRING) AS author_id,
          %s AS audience_size,
          %s AS engagement_count,
          %s AS is_kof,
          CAST(%s AS TIMESTAMP) AS posted_at,
          CAST(%s AS TIMESTAMP) AS ingested_at,
          CAST(%s AS STRING) AS raw_text,
          CAST(%s AS STRING) AS topic_hint
        FROM `%s`
        WHERE (%s) >= @since_ts
          AND (%s) <= @now_ts
          AND (%s)
      """,
        source_name, IF(requires_entity_match, 'TRUE', 'FALSE'),
        mention_id_expr, url_expr, platform_expr, author_expr,
        audience_expr, engagement_expr, is_kof_expr, posted_ts_expr, ingested_ts_expr,
        text_expr, topic_hint_expr, table_fqn, ingested_ts_expr, ingested_ts_expr, extra_where_sql
      ),
      '\nUNION ALL\n'
    )
    FROM `brand-social-central-data.early_detection.source_feed_registry`
    WHERE enabled = TRUE
  );

  IF v_union_sql IS NULL THEN
    RETURN;
  END IF;

  EXECUTE IMMEDIATE FORMAT("""
    MERGE `brand-social-central-data.early_detection.low_tier_mentions` T
    USING (
      WITH raw_union AS (
        %s
      ),
      low_tier_filtered AS (
        SELECT
          source_name,
          requires_entity_match,
          mention_id,
          REGEXP_REPLACE(REGEXP_REPLACE(TRIM(COALESCE(raw_url, '')), r'[?#].*$', ''), r'/+$', '') AS canonical_url,
          platform,
          COALESCE(NULLIF(TRIM(author_id), ''), 'anon') AS author_id,
          audience_size,
          COALESCE(engagement_count, 0) AS engagement_count,
          LEAST(COALESCE(posted_at, ingested_at), @now_ts) AS posted_at,
          ingested_at AS source_ingested_at,
          topic_hint,
          raw_text,
          -- Strip RT prefixes, URLs, @handles, and non-brand slang/boilerplate retained from BigQuery.gs
          TRIM(REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(COALESCE(raw_text, ''), r'^RT\\s+@\\w+:\\s*', ''),
              r'https?://\\S+|@[\\w.-]+', ' '
            ),
            r'(?i)(available\\s+on\\s+google\\s+play|get\\s+it\\s+on\\s+google\\s+play|\\bgoogle\\s+it\\b|\\bgemini\\s+(?:season|moon|rising|venus|mercury|horoscope|zodiac)\\b|\\bchrome\\s+(?:hearts|wheels|rims)\\b)',
            ' '
          )) AS clean_text
        FROM raw_union
        WHERE mention_id IS NOT NULL
          AND NOT COALESCE(is_kof, FALSE)
          AND COALESCE(engagement_count, 0) < @eng_ceil
          AND (
            (audience_size IS NULL AND @allow_null_aud)
            OR (audience_size IS NOT NULL AND audience_size <= @max_aud)
          )
          AND NOT REGEXP_CONTAINS(LOWER(COALESCE(raw_url, '')), r'/(grok)/status/')
          AND LOWER(TRIM(COALESCE(author_id, ''))) NOT IN ('grok', 'automoderator', '[deleted]')
          -- Reject pure astrology / fashion homonyms without restricting unknown emerging topics
          AND NOT REGEXP_CONTAINS(
            LOWER(COALESCE(raw_text, '')),
            r'^[^a-z]*(gemini\\s+(?:season|moon|rising|horoscope|zodiac)|chrome\\s+hearts)\\b'
          )
          -- Reject copy-paste spam rings and promos (they converge on identical text across many accounts)
          AND NOT REGEXP_CONTAINS(
            LOWER(COALESCE(raw_text, '')),
            r'\\b(iptv|airdrop|giveaway|promo\\s*code|coupon\\s*code|onlyfans|check\\s+my\\s+bio|link\\s+in\\s+(?:my\\s+)?bio|link\\s+na\\s+bio|dm\\s+me|follow\\s+back|use\\s+(?:my\\s+)?code|frete\\s+gr[aá]tis|compre\\s+agora)\\b|#(?:ad|ads|sponsored|promo)\\b'
          )
      ),
      quality_checked AS (
        SELECT
          * EXCEPT(requires_entity_match),
          TRIM(REGEXP_REPLACE(LOWER(clean_text), r'[^a-z0-9\\s]+', ' ')) AS norm_claim_text,
          REGEXP_EXTRACT_ALL(LOWER(clean_text), r'[a-z0-9]{2,}') AS tokens
        FROM low_tier_filtered
        WHERE CHAR_LENGTH(clean_text) >= @min_chars
          AND (
            NOT requires_entity_match
            OR REGEXP_CONTAINS(
              LOWER(CONCAT(clean_text, ' ', COALESCE(topic_hint, ''))),
              r'\\b(google|alphabet|sundar|pichai|gemini|pixel|android|youtube|waymo|deepmind|nest|chromebook|chromeos|chrome|workspace|gmail|maps|waze|fitbit|gboard|wing|verily|isomorphic|play\\s+store|google\\s+(?:maps|photos|cloud|drive|pay|wallet|play|ads|search|tv|fi|lens|one)|ai\\s+overviews?|notebooklm|veo|imagen)\\b'
            )
          )
      ),
      dedup_prepared AS (
        SELECT
          q.mention_id,
          q.source_name,
          NULLIF(q.canonical_url, '') AS canonical_url,
          q.platform,
          q.author_id,
          q.audience_size,
          q.engagement_count,
          q.posted_at,
          @now_ts AS ingested_at,
          q.topic_hint,
          SUBSTR(q.raw_text, 1, 2000) AS raw_text,
          SUBSTR(q.clean_text, 1, 1500) AS clean_text,
          SUBSTR(q.norm_claim_text, 1, 1500) AS norm_claim_text,
          TO_HEX(SHA256(SUBSTR(q.norm_claim_text, 1, 1500))) AS content_hash,
          FARM_FINGERPRINT(CONCAT(
            q.platform, '|', q.author_id, '|',
            ARRAY_TO_STRING(ARRAY(
              SELECT DISTINCT tok FROM UNNEST(q.tokens) tok ORDER BY tok LIMIT 12
            ), ' ')
          )) AS author_dedup_sig,
          ARRAY(
            SELECT r.risk_group
            FROM `brand-social-central-data.early_detection.risk_term_taxonomy` r
            WHERE r.enabled AND REGEXP_CONTAINS(q.clean_text, r.pattern_regex)
          ) AS risk_term_groups,
          q.source_ingested_at
        FROM quality_checked q
        WHERE ARRAY_LENGTH(q.tokens) >= @min_tokens
          AND (SELECT COUNT(DISTINCT tok) FROM UNNEST(q.tokens) tok) >= 5
      ),
      same_author_deduped AS (
        SELECT d.*
        FROM dedup_prepared d
        WHERE NOT EXISTS (
          SELECT 1
          FROM `brand-social-central-data.early_detection.low_tier_mentions` prev
          WHERE prev.ingested_at >= TIMESTAMP_SUB(@now_ts, INTERVAL @dedup_hrs HOUR)
            AND prev.author_dedup_sig = d.author_dedup_sig
            AND prev.mention_id != d.mention_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM `brand-social-central-data.slrr_alerts.slrr_alerts` sa
          WHERE sa.ingestion_timestamp >= TIMESTAMP_SUB(@now_ts, INTERVAL 7 DAY)
            AND sa.url IS NOT NULL
            AND REGEXP_REPLACE(REGEXP_REPLACE(TRIM(sa.url), r'[?#].*$', ''), r'/+$', '') = d.canonical_url
        )
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY author_dedup_sig
          ORDER BY posted_at ASC, mention_id ASC
        ) = 1
      ),
      -- Row cap: only rows not landed yet, newest first (capped-out rows are re-read by the overlap window of the next run)
      new_rows_capped AS (
        SELECT s.*
        FROM same_author_deduped s
        WHERE NOT EXISTS (
          SELECT 1
          FROM `brand-social-central-data.early_detection.low_tier_mentions` t
          WHERE t.ingested_at >= TIMESTAMP_SUB(@since_ts, INTERVAL 1 DAY)
            AND t.mention_id = s.mention_id
        )
        QUALIFY ROW_NUMBER() OVER (ORDER BY s.source_ingested_at DESC, s.mention_id) <= @max_rows
      )
      SELECT * FROM new_rows_capped
    ) S
    ON T.mention_id = S.mention_id
       AND T.ingested_at >= TIMESTAMP_SUB(@since_ts, INTERVAL 1 DAY)
    WHEN NOT MATCHED THEN INSERT (
      mention_id, source_name, canonical_url, platform, author_id, audience_size, engagement_count,
      posted_at, ingested_at, topic_hint, raw_text, clean_text, norm_claim_text, content_hash,
      author_dedup_sig, risk_term_groups, source_ingested_at
    ) VALUES (
      S.mention_id, S.source_name, S.canonical_url, S.platform, S.author_id, S.audience_size, S.engagement_count,
      S.posted_at, S.ingested_at, S.topic_hint, S.raw_text, S.clean_text, S.norm_claim_text, S.content_hash,
      S.author_dedup_sig, S.risk_term_groups, S.source_ingested_at
    )
  """, v_union_sql)
  USING
    v_since AS since_ts,
    v_now AS now_ts,
    v_eng_ceil AS eng_ceil,
    v_allow_null_aud AS allow_null_aud,
    v_max_aud AS max_aud,
    v_min_chars AS min_chars,
    v_min_tokens AS min_tokens,
    v_dedup_hrs AS dedup_hrs,
    v_max_rows AS max_rows;

  MERGE `brand-social-central-data.early_detection.pipeline_watermarks` T
  USING (SELECT 'ingest_low_tier' AS step_name, v_now AS last_cutoff_ts, v_now AS updated_at) S
  ON T.step_name = S.step_name
  WHEN MATCHED THEN UPDATE SET last_cutoff_ts = S.last_cutoff_ts, updated_at = S.updated_at
  WHEN NOT MATCHED THEN INSERT ROW;
END;
