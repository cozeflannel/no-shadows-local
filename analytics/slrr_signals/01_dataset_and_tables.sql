-- slrr_signals: the one dataset behind the two-track SLRR system (docs/TWO_TRACK_SIGNALS.md).
-- Run in location US on brand-social-central-data. Idempotent: CREATE ... IF NOT EXISTS only (never drops or rewrites).
--   bq query --project_id=brand-social-central-data --location=US --use_legacy_sql=false \
--     --label datacloud:antigravity --label app:slrr-signals < analytics/slrr_signals/01_dataset_and_tables.sql

CREATE SCHEMA IF NOT EXISTS `brand-social-central-data.slrr_signals`
OPTIONS (
  location = 'US',
  description = 'Two-track SLRR system: raw mentions, Track 1 (playbook) classifications, Track 2 (radar) clusters, taxonomy, issue history, feedback, KOFs and the sheet archive. Written by the slrr-signals Cloud Run service and the Burson QA Bot.',
  labels = [('app', 'slrr-signals')]
);

-- Landing zone: one row per post a source handed over (the same post from two sources is two rows: mention_key + source)
CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.raw_mentions` (
  mention_key STRING NOT NULL OPTIONS (description = 'The post: its normalized link (x.com/status/123), the bot\'s record key'),
  source STRING NOT NULL OPTIONS (description = 'sonar | tubular | bwm | owned | comments'),
  source_id STRING OPTIONS (description = 'The source\'s own id (Brandwatch mention_id, Sprinklr post id, Tubular video id)'),
  post_url STRING,
  platform STRING OPTIONS (description = 'twitter | reddit | bluesky | facebook | instagram | youtube | tiktok'),
  author STRING,
  author_followers INT64,
  engagement INT64 OPTIONS (description = 'Likes + comments + shares (or the source\'s total engagements)'),
  views INT64,
  text STRING OPTIONS (description = 'The post\'s text (capped at 4,000 characters)'),
  title STRING,
  summary STRING OPTIONS (description = 'The source\'s own summary (Pendulum\'s, or the pile-on description)'),
  language STRING,
  sentiment STRING,
  posted_at TIMESTAMP,
  source_seen_at TIMESTAMP OPTIONS (description = 'When the source first had it (Sonar received_at, Brandwatch first load, Tubular first seen)'),
  ingested_at TIMESTAMP NOT NULL OPTIONS (description = 'When slrr-signals landed it'),
  products ARRAY<STRING>,
  source_tags ARRAY<STRING> OPTIONS (description = 'The source\'s own classification: Brandwatch exposure tags, Sonar smart tag and Sensitive Topics, Tubular topics'),
  kof_lists ARRAY<STRING> OPTIONS (description = 'KOF lists the author is on, per the source (Sonar influencer lists)'),
  reason STRING OPTIONS (description = 'Why the source handed it over: new | grew | broke out | negative | negative comments | pile-on | big voice'),
  extra JSON OPTIONS (description = 'Source-specific numbers (comment counts, negative share...)')
)
PARTITION BY DATE(ingested_at)
CLUSTER BY source, platform, mention_key
OPTIONS (partition_expiration_days = 400, description = 'Track 1 and Track 2 input: what each of the five tables handed over, filtered to the team\'s networks, English, never Grok.');

-- Track 1 output: deterministic rules first, then Gemini on the survivors, then the Collection Requirements engine
CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.classified_mentions` (
  mention_key STRING NOT NULL,
  source STRING,
  post_url STRING,
  platform STRING,
  author STRING,
  engagement INT64,
  posted_at TIMESTAMP,
  ingested_at TIMESTAMP,
  classified_at TIMESTAMP NOT NULL,
  rules_version STRING,
  taxonomy_version STRING,
  model STRING,
  prompt_version STRING,
  passed_rules BOOL OPTIONS (description = 'Survived the deterministic rules (and so went to Gemini)'),
  rule_track STRING OPTIONS (description = 'urgent (0-engagement: P0 hint, Sensitive Topic keyword, KOF) | 2k (high engagement) | none'),
  rule_reasons ARRAY<STRING> OPTIONS (description = 'Why the rules passed or stopped it: SENSITIVE_KEYWORD:..., KOF, P0_HINT:..., HIGH_ENGAGEMENT, EXCLUDED_*, BELOW_THRESHOLD, PREVIOUSLY_REPORTED'),
  exposure_tag STRING,
  exposure_priority STRING OPTIONS (description = 'P0 | P1 | P2'),
  risk_tag STRING OPTIONS (description = 'The Sensitive Topic, when there is one'),
  products ARRAY<STRING>,
  issue_name STRING,
  summary STRING,
  urgency STRING OPTIONS (description = 'Gemini\'s recommendation: urgent | standard | none'),
  confidence FLOAT64,
  rationale STRING,
  track STRING OPTIONS (description = 'Collection Requirements track: URGENT | HIGH_ENGAGEMENT'),
  issue_status STRING OPTIONS (description = 'NEW | ONGOING (14-day novelty)'),
  meets_requirements BOOL OPTIONS (description = 'The Collection Requirements engine says it is alertable'),
  suppression_reason STRING,
  previously_reported BOOL,
  previous_alert_id STRING,
  qualifies BOOL OPTIONS (description = 'Meets the requirements at or above the confidence bar and not previously reported: ready for the chatbot'),
  web_context STRING OPTIONS (description = 'What a Google Search grounded check found in public (qualifying rows only)'),
  error STRING
)
PARTITION BY DATE(classified_at)
CLUSTER BY qualifies, exposure_priority, mention_key
OPTIONS (description = 'Track 1 (official, strict): playbook classifications. The chatbot hands each qualifying row to the chat once, as a watch alert where Control row 35 says (handoffs records it).');

-- Track 2 output: one row per assessment of a cluster (the latest per cluster is the current one: v_radar_latest)
CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.radar_clusters` (
  cluster_id STRING NOT NULL,
  assessed_at TIMESTAMP NOT NULL,
  origin STRING OPTIONS (description = 'early_detection (its embedding clusters and velocity) | raw_mentions'),
  origin_ref STRING OPTIONS (description = 'The origin\'s own id (early_detection alert or cluster id)'),
  headline STRING,
  representative_texts ARRAY<STRING>,
  post_urls ARRAY<STRING>,
  mentions INT64,
  authors INT64,
  platforms ARRAY<STRING>,
  velocity_ratio FLOAT64,
  growth_per_hour FLOAT64,
  first_seen TIMESTAMP,
  last_seen TIMESTAMP,
  likelihood STRING OPTIONS (description = 'Gemini: chance it meets Track 1 if left alone: high | medium | low'),
  closest_tag STRING,
  closest_priority STRING,
  action STRING OPTIONS (description = 'promote | watch | discard'),
  rationale STRING,
  confidence FLOAT64,
  model STRING,
  prompt_version STRING,
  web_context STRING
)
PARTITION BY DATE(assessed_at)
CLUSTER BY likelihood, action, cluster_id
OPTIONS (description = 'Track 2 (radar, exploratory): predictive assessments of sub-threshold clusters. The chatbot hands the promoted or high-likelihood ones to its Early detection review (Control row 19) once; never S-F Burson.');

-- Taxonomy: exposure tags, Sensitive Topics, thresholds, keywords and exclusions (edited on the sheet's Watch tags tab)
CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.taxonomy` (
  kind STRING NOT NULL OPTIONS (description = 'tag | threshold | sensitive_keyword | p0_keyword | exclusion'),
  priority STRING OPTIONS (description = 'P0 | P1 | P2 | Sensitive (tags)'),
  name STRING NOT NULL,
  label STRING OPTIONS (description = 'P0 · Product - Dangerous results ...'),
  description STRING,
  short_version STRING,
  also_known_as ARRAY<STRING>,
  value STRING OPTIONS (description = 'A threshold\'s value, or a keyword / exclusion regex'),
  is_on BOOL,
  version STRING,
  updated_at TIMESTAMP,
  updated_from STRING OPTIONS (description = 'watch_tags_tab | seed | config')
)
OPTIONS (description = 'Track 1 and Track 2 reference. The latest version wins (v_taxonomy_current).');

CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.issue_history` (
  alert_id STRING,
  record_key STRING,
  issue_name STRING,
  issue_tokens ARRAY<STRING>,
  exposure_tag STRING,
  priority STRING,
  products ARRAY<STRING>,
  author STRING,
  post_url STRING,
  alerted_at TIMESTAMP,
  status STRING,
  email_status STRING,
  source STRING OPTIONS (description = 'alert_log (the bot\'s sheet) | sheet_archive | track1'),
  synced_at TIMESTAMP
)
PARTITION BY DATE(alerted_at)
CLUSTER BY record_key, alert_id
OPTIONS (description = 'Previously-reported checks (14-day novelty) and later benchmarks.');

CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.feedback_corrections` (
  feedback_id STRING,
  track STRING OPTIONS (description = 'track1 | track2 | watch'),
  item_key STRING OPTIONS (description = 'mention_key, cluster_id or the Watch detections key'),
  field STRING,
  old_value STRING,
  new_value STRING,
  rating STRING,
  note STRING,
  created_at TIMESTAMP,
  source STRING OPTIONS (description = 'Where it was entered: the sheet tab')
)
PARTITION BY DATE(created_at)
OPTIONS (description = 'Human overrides from either track (ratings, promote/discard), for evaluation and improvement.');

CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.kof_list` (
  platform STRING,
  handle STRING,
  name STRING,
  list_name STRING,
  followers INT64,
  updated_at TIMESTAMP,
  source STRING
)
OPTIONS (description = 'Known KOF accounts (Track 1 deterministic lookup). Empty: the sources\' own KOF lists are used.');

-- Rows the bot trims from its own sheet tabs (Alert log, Message log, Relay), searchable as the bot's long memory
CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.sheet_archive` (
  tab STRING NOT NULL,
  row_key STRING OPTIONS (description = 'The row\'s own key: alert_id, message name or relay id'),
  record_key STRING OPTIONS (description = 'The post (normalized link), when the row has one'),
  alert_id STRING,
  created_at TIMESTAMP,
  archived_at TIMESTAMP NOT NULL,
  archive_batch STRING,
  row_json JSON OPTIONS (description = 'The whole row as the bot stores it')
)
PARTITION BY DATE(archived_at)
CLUSTER BY tab, record_key, alert_id
OPTIONS (description = 'The sheet\'s archive: rows older than the retention window, copied here before they are trimmed.');

-- Operations: each source's place and circuit breaker, each run's metrics, and items that keep failing
CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.source_state` (
  source STRING NOT NULL,
  watermark TIMESTAMP,
  table_modified TIMESTAMP,
  day STRING,
  day_count INT64,
  failures INT64,
  paused_until TIMESTAMP,
  last_ok TIMESTAMP,
  last_error STRING,
  last_rows INT64,
  updated_at TIMESTAMP
)
OPTIONS (description = 'One row per source: where it is, and whether its breaker paused it.');

CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.run_log` (
  run_id STRING,
  endpoint STRING,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  status STRING OPTIONS (description = 'ok | partial | error | skipped'),
  stats JSON,
  error STRING
)
PARTITION BY DATE(started_at)
OPTIONS (partition_expiration_days = 90, description = 'Metrics per run: rows read, classified, assessed, latency, errors.');

CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.dead_letter` (
  item_key STRING,
  stage STRING OPTIONS (description = 'track1 | track2 | web'),
  tries INT64,
  last_error STRING,
  failed_at TIMESTAMP,
  payload JSON
)
PARTITION BY DATE(failed_at)
OPTIONS (partition_expiration_days = 90, description = 'Items that failed: after the configured tries they are never retried (no retry loops).');

-- The chatbot's pick-ups of Track 1 rows (append-only: a row is handed over once)
CREATE TABLE IF NOT EXISTS `brand-social-central-data.slrr_signals.handoffs` (
  mention_key STRING,
  handed_at TIMESTAMP,
  alert_id STRING,
  outcome STRING
)
PARTITION BY DATE(handed_at)
OPTIONS (description = 'What the chatbot handed to the chat, once each: Track 1 rows (mention_key, outcome watch_alerts) and radar assessments (mention_key radar:<cluster>@<ms>, outcome early_detection_queue).');
