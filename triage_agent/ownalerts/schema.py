"""Agent alerts' BigQuery objects: its tables, the pattern function, two remote models and the triage procedure.

Everything is created in the agent's own dataset (Settings, BigQuery), from the settings under Settings, Agent alerts.
Nothing here names a source table, `agent_events` or a metric view, and no statement drops or replaces a table.
Each table that holds posts expires its partitions (30 days at most); the daily retention run deletes the same rows.

`version` is a hash of every statement: when a setting changes what a statement says (a model, the dataset, the
days kept), the objects are created again before the next run.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import TYPE_CHECKING, Any

from . import scrub

if TYPE_CHECKING:
    from ..context import AgentContext

STATE = "own:schema"  # {version, at}
PROCEDURE = "run_9source_triage_cycle"
FUNCTION = "fast_regex_sanitize"
EMBEDDING_MODEL = "embedding_model"
FAST_MODEL = "gemini4_fast_decisions"
WATERMARK = "slrr_inhouse_cycle"
LABELS = {"app": "triage-agent", "job": "own-alerts"}
# The procedure's parameters, in order: its header and the call are both built from this list.
PARAMS: tuple[tuple[str, str], ...] = (
    ("doc_guidelines", "STRING"), ("discovery_guidelines", "STRING"), ("cos_threshold", "FLOAT64"), ("min_vel_ratio", "FLOAT64"),
    ("min_story_posts", "INT64"), ("cooldown_mins", "INT64"), ("single_min_score", "FLOAT64"), ("story_min_score", "FLOAT64"),
    ("regrowth", "FLOAT64"), ("story_active_hours", "INT64"), ("catch_up_hours", "INT64"), ("other_alerts_source", "STRING"),
    ("other_alerts_mandatory", "BOOL"),
)
_NAME = re.compile(r"^[\w.-]+$")
_CONNECTION = re.compile(r"^[\w-]+\.[\w-]+\.[\w-]+$")

# name -> (columns, partition column, cluster columns, which setting says how many days a partition is kept, what it is)
TABLES: dict[str, tuple[str, str, str, str, str]] = {
    "posts_staging": (
        "ingested_at TIMESTAMP NOT NULL, post_id STRING NOT NULL, source_system STRING NOT NULL, published_at TIMESTAMP, platform STRING, "
        "author_hash STRING, author_followers INT64, is_kof BOOL NOT NULL, kof_tier STRING, sanitized_snippet STRING, views INT64, likes INT64, "
        "comments INT64, shares INT64, engagement_total INT64",
        "ingested_at", "post_id", "1", "Agent alerts: posts read from the sources, personal details already removed, waiting for the next run."),
    "author_vault_30d": (
        "post_id STRING NOT NULL, ingested_at TIMESTAMP NOT NULL, is_kof BOOL NOT NULL, kof_display_label STRING, post_url STRING",
        "ingested_at", "post_id", "keep_days", "Agent alerts: each post's link and, for a KOF, the name shown. No model reads this table."),
    "posts": (
        "post_id STRING NOT NULL, source_system STRING NOT NULL, published_at TIMESTAMP, ingested_at TIMESTAMP NOT NULL, platform STRING, "
        "author_hash STRING, author_followers INT64, is_kof BOOL NOT NULL, kof_tier STRING, sanitized_snippet STRING, rule_eval_status STRING, "
        "matched_rule_id STRING, story_id STRING, embedding ARRAY<FLOAT64>",
        "ingested_at", "rule_eval_status, source_system", "keep_days", "Agent alerts: every post kept, without personal details."),
    "post_metrics": (
        "post_id STRING NOT NULL, recorded_at TIMESTAMP NOT NULL, views INT64, likes INT64, comments INT64, shares INT64, engagement_total INT64",
        "recorded_at", "post_id", "keep_days", "Agent alerts: each post's engagement when it was first read."),
    "stories": (
        "story_id STRING NOT NULL, created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL, representative_post_id STRING, "
        "centroid_embedding ARRAY<FLOAT64>, post_count_15m INT64, unique_authors_15m INT64, post_count_1h INT64, velocity_ratio_15m FLOAT64, "
        "last_alerted_at TIMESTAMP, story_summary STRING, last_triaged_at TIMESTAMP, last_triaged_posts INT64",
        "created_at", "story_id", "keep_days", "Agent alerts: posts on one theme, and how fast the theme is growing."),
    "review_queue": (
        "queue_id STRING NOT NULL, queued_at TIMESTAMP NOT NULL, item_type STRING NOT NULL, target_id STRING NOT NULL, trigger_path STRING NOT NULL, "
        "matched_rule_id STRING, stage1_rank_score FLOAT64, stage1_rationale STRING, processed BOOL",
        "queued_at", "processed", "keep_days", "Agent alerts: posts and stories waiting for the review."),
    "decisions": (
        "decision_id STRING NOT NULL, decided_at TIMESTAMP NOT NULL, queue_id STRING NOT NULL, target_id STRING NOT NULL, item_type STRING NOT NULL, "
        "trigger_path STRING NOT NULL, escalate BOOL NOT NULL, severity STRING NOT NULL, escalation_path STRING NOT NULL, decision_rationale STRING, "
        "sanitized_evidence STRING, velocity_summary STRING, chat_message_id STRING, agent_engine_session STRING, embedding ARRAY<FLOAT64>",
        "decided_at", "escalate, severity", "decisions_keep_days", "Agent alerts: what the review decided, and why."),
    "feedback": (
        "feedback_id STRING NOT NULL, submitted_at TIMESTAMP NOT NULL, decision_id STRING NOT NULL, reviewer_email STRING NOT NULL, verdict STRING NOT NULL",
        "submitted_at", "decision_id", "decisions_keep_days", "Agent alerts: an analyst's verdict on a decision."),
}
PLAIN_TABLES: dict[str, tuple[str, str]] = {
    "pipeline_watermarks": ("source_name STRING NOT NULL, last_processed_ts TIMESTAMP NOT NULL", "Agent alerts: when the last run finished."),
    "policy_rules_config": (
        "rule_id STRING NOT NULL, rule_name STRING NOT NULL, process_doc_section STRING NOT NULL, execution_mode STRING NOT NULL, "
        "target_sources ARRAY<STRING>, platforms ARRAY<STRING>, require_kof BOOL, min_followers INT64, min_engagements INT64, "
        "required_keywords_any ARRAY<STRING>, required_keywords_all ARRAY<STRING>, excluded_keywords ARRAY<STRING>, forced_severity STRING, "
        "forced_escalation_path STRING, active BOOL, updated_by STRING, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()",
        "Agent alerts: the rules, as edited in the Console."),
}


def dataset(ctx: "AgentContext") -> str:
    """The agent's own dataset as project.dataset."""
    from .. import bq_admin

    cfg = ctx.config.platform.bigquery
    if not cfg.dataset.strip():
        raise ValueError("Set the agent's dataset first (Settings, BigQuery, Dataset).")
    full = cfg.dataset.strip() if "." in cfg.dataset else f"{cfg.project or bq_admin.get_gateway(ctx).project}.{cfg.dataset.strip()}"
    bq_admin.check_table_id(f"{full}.posts")
    return full


def table(ctx: "AgentContext", name: str) -> str:
    return f"{dataset(ctx)}.{name}"


def days(own: Any, setting: str) -> int:
    """How many days a table's rows are kept: a number, or the setting that holds it."""
    return int(setting) if setting.isdigit() else int(getattr(own, setting))


def _models(own: Any) -> dict[str, str]:
    if not _CONNECTION.match(own.ai_connection.strip()):
        raise ValueError("Set the BigQuery connection the models are called through, as project.location.name (Settings, Agent alerts).")
    for what, value in (("embedding model", own.embedding_endpoint), ("fast Gemini model", own.fast_endpoint)):
        if not _NAME.match(value):
            raise ValueError(f"The {what}'s name has characters that are not allowed (Settings, Agent alerts).")
    return {EMBEDDING_MODEL: own.embedding_endpoint, FAST_MODEL: own.fast_endpoint}


def function_sql(ds: str, own: Any) -> str:
    """BigQuery's copy of the pattern pass, built from the same patterns the job uses."""
    inner = "IFNULL(raw_text, '')"
    for _, pattern, put in scrub.PATTERNS:
        inner = f"REGEXP_REPLACE({inner}, r'{pattern}', r'{put}')"
    return f"CREATE OR REPLACE FUNCTION `{ds}.{FUNCTION}`(raw_text STRING)\nRETURNS STRING AS (\n  LEFT(TRIM({inner}), {own.snippet_chars})\n)"


def procedure_sql(ds: str, own: Any) -> str:
    """One run inside BigQuery: staged posts are kept, checked against the rules, asked about, grouped and measured."""
    dedupe_days = max(7, math.ceil(own.posted_within_hours / 24) + 1)
    queue_cols = "queue_id, queued_at, item_type, target_id, trigger_path, matched_rule_id, stage1_rank_score, stage1_rationale, processed"
    header = ",\n  ".join(f"{name} {kind}" for name, kind in PARAMS)
    return f"""CREATE OR REPLACE PROCEDURE `{ds}.{PROCEDURE}`(
  {header})
BEGIN
  DECLARE run_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE pending_ts TIMESTAMP DEFAULT TIMESTAMP_SUB(run_ts, INTERVAL catch_up_hours HOUR);
  DECLARE active_ts TIMESTAMP DEFAULT TIMESTAMP_SUB(run_ts, INTERVAL story_active_hours HOUR);
  DECLARE lookback_ts TIMESTAMP DEFAULT COALESCE(
    (SELECT TIMESTAMP_SUB(MIN(last_processed_ts), INTERVAL 10 MINUTE) FROM `{ds}.pipeline_watermarks` WHERE source_name = '{WATERMARK}'),
    TIMESTAMP_SUB(run_ts, INTERVAL 1 DAY));
  DECLARE n_staged, n_new, n_hard, n_single, n_single_queued, n_embedded, n_stories_asked, n_stories_queued INT64 DEFAULT 0;

  -- 1. What the job staged since the last run, each post once, is kept. A post already held is left as it is.
  CREATE TEMP TABLE batch AS
  SELECT * FROM `{ds}.posts_staging`
  WHERE ingested_at >= lookback_ts AND LENGTH(TRIM(IFNULL(sanitized_snippet, ''))) > 0
  QUALIFY ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY ingested_at DESC) = 1;
  SET n_staged = (SELECT COUNT(*) FROM batch);

  MERGE `{ds}.posts` T
  USING batch S
  ON T.post_id = S.post_id AND T.ingested_at >= TIMESTAMP_SUB(run_ts, INTERVAL {dedupe_days} DAY)
  WHEN NOT MATCHED THEN INSERT (post_id, source_system, published_at, ingested_at, platform, author_hash, author_followers, is_kof, kof_tier,
                                sanitized_snippet, rule_eval_status)
  VALUES (S.post_id, S.source_system, S.published_at, run_ts, S.platform, S.author_hash, S.author_followers, S.is_kof, S.kof_tier,
          `{ds}.{FUNCTION}`(S.sanitized_snippet), 'NEW');
  SET n_new = @@row_count;

  INSERT INTO `{ds}.post_metrics` (post_id, recorded_at, views, likes, comments, shares, engagement_total)
  SELECT S.post_id, run_ts, S.views, S.likes, S.comments, S.shares, S.engagement_total
  FROM batch S JOIN `{ds}.posts` P ON P.post_id = S.post_id AND P.ingested_at = run_ts;

  -- 2. The rules. A mandatory rule sends a post straight to review; any other rule has Gemini read the post first.
  CREATE TEMP TABLE rule_matches AS
  SELECT p.post_id, r.rule_id, r.execution_mode,
    ROW_NUMBER() OVER (PARTITION BY p.post_id ORDER BY IF(r.execution_mode = 'HARD_MANDATE', 1, 2), IFNULL(r.forced_severity, 'ZZ'), r.rule_id) AS rn
  FROM `{ds}.posts` p
  LEFT JOIN (SELECT post_id, MAX(engagement_total) AS engagement_total FROM `{ds}.post_metrics` WHERE recorded_at >= pending_ts GROUP BY post_id) m
    ON m.post_id = p.post_id
  JOIN `{ds}.policy_rules_config` r ON r.active = TRUE
  WHERE p.ingested_at >= pending_ts AND p.rule_eval_status = 'NEW'
    AND (IFNULL(ARRAY_LENGTH(r.target_sources), 0) = 0 OR 'ALL' IN UNNEST(r.target_sources) OR p.source_system IN UNNEST(r.target_sources))
    AND (IFNULL(ARRAY_LENGTH(r.platforms), 0) = 0 OR 'ALL' IN UNNEST(r.platforms) OR p.platform IN UNNEST(r.platforms))
    AND (NOT IFNULL(r.require_kof, FALSE) OR p.is_kof = TRUE)
    AND IFNULL(p.author_followers, 0) >= IFNULL(r.min_followers, 0)
    AND IFNULL(m.engagement_total, 0) >= IFNULL(r.min_engagements, 0)
    AND (IFNULL(ARRAY_LENGTH(r.required_keywords_any), 0) = 0
         OR EXISTS (SELECT 1 FROM UNNEST(r.required_keywords_any) kw WHERE STRPOS(LOWER(p.sanitized_snippet), LOWER(kw)) > 0))
    AND NOT EXISTS (SELECT 1 FROM UNNEST(r.required_keywords_all) kw WHERE STRPOS(LOWER(p.sanitized_snippet), LOWER(kw)) = 0)
    AND NOT EXISTS (SELECT 1 FROM UNNEST(r.excluded_keywords) ex WHERE STRPOS(LOWER(p.sanitized_snippet), LOWER(ex)) > 0);

  UPDATE `{ds}.posts` p
  SET rule_eval_status = CASE
        WHEN m.execution_mode = 'HARD_MANDATE' THEN 'MET_IN_CODE'
        WHEN other_alerts_mandatory AND p.source_system = other_alerts_source THEN 'MET_IN_CODE'
        ELSE 'NEEDS_SINGLE_READ' END,
      matched_rule_id = m.rule_id
  FROM (SELECT post_id, rule_id, execution_mode FROM rule_matches WHERE rn = 1) m
  WHERE p.post_id = m.post_id AND p.ingested_at >= pending_ts AND p.rule_eval_status = 'NEW';

  UPDATE `{ds}.posts`
  SET rule_eval_status = IF(other_alerts_mandatory AND source_system = other_alerts_source, 'MET_IN_CODE', 'NEEDS_STORY_CLUSTER')
  WHERE ingested_at >= pending_ts AND rule_eval_status = 'NEW';

  INSERT INTO `{ds}.review_queue` ({queue_cols})
  SELECT GENERATE_UUID(), run_ts, 'SINGLE_POST', p.post_id, 'MET_IN_CODE', p.matched_rule_id, 1.0,
         IF(p.matched_rule_id IS NULL, 'Posted in the Other alerts space', 'Process Doc Hard Rule Matched'), FALSE
  FROM `{ds}.posts` p
  WHERE p.ingested_at >= pending_ts AND p.rule_eval_status = 'MET_IN_CODE'
    AND NOT EXISTS (SELECT 1 FROM `{ds}.review_queue` q WHERE q.queued_at >= pending_ts AND q.target_id = p.post_id AND q.trigger_path = 'MET_IN_CODE');
  SET n_hard = @@row_count;

  UPDATE `{ds}.posts` SET rule_eval_status = 'QUEUED_HARD'
  WHERE ingested_at >= pending_ts AND rule_eval_status = 'MET_IN_CODE';

  CREATE TEMP TABLE single_verdicts AS
  SELECT post_id, matched_rule_id, passes_rule, risk_score, rationale, status
  FROM AI.GENERATE_TABLE(
    MODEL `{ds}.{FAST_MODEL}`,
    (SELECT p.post_id, p.matched_rule_id,
            CONCAT('Evaluate sanitized social snippet against SOP: ', doc_guidelines,
                   '\\nRule: ', IFNULL(r.rule_name, ''), ' (', IFNULL(r.process_doc_section, ''), ')',
                   '\\nKOF Tier: ', IFNULL(p.kof_tier, 'NON_KOF'), ' | Followers: ', CAST(IFNULL(p.author_followers, 0) AS STRING),
                   '\\nSnippet: ', p.sanitized_snippet) AS prompt
     FROM `{ds}.posts` p
     LEFT JOIN `{ds}.policy_rules_config` r ON r.rule_id = p.matched_rule_id
     WHERE p.ingested_at >= pending_ts AND p.rule_eval_status = 'NEEDS_SINGLE_READ'),
    STRUCT('passes_rule BOOL, risk_score FLOAT64, rationale STRING' AS output_schema));
  SET n_single = (SELECT COUNT(*) FROM single_verdicts);

  INSERT INTO `{ds}.review_queue` ({queue_cols})
  SELECT GENERATE_UUID(), run_ts, 'SINGLE_POST', post_id, 'SINGLE_POST_GEMINI', matched_rule_id, risk_score, rationale, FALSE
  FROM single_verdicts
  WHERE passes_rule = TRUE AND risk_score >= single_min_score;
  SET n_single_queued = @@row_count;

  UPDATE `{ds}.posts` SET rule_eval_status = 'SINGLE_EVALUATED'
  WHERE ingested_at >= pending_ts AND rule_eval_status = 'NEEDS_SINGLE_READ'
    AND post_id IN (SELECT post_id FROM single_verdicts WHERE IFNULL(status, '') = '');

  -- 3. Posts no rule covers are turned into numbers and grouped: first into a story that is still running...
  UPDATE `{ds}.posts` T
  SET embedding = S.ml_generate_embedding_result
  FROM (
    SELECT post_id, ml_generate_embedding_result
    FROM ML.GENERATE_EMBEDDING(
      MODEL `{ds}.{EMBEDDING_MODEL}`,
      (SELECT post_id, sanitized_snippet AS content FROM `{ds}.posts`
       WHERE ingested_at >= pending_ts AND rule_eval_status = 'NEEDS_STORY_CLUSTER' AND IFNULL(ARRAY_LENGTH(embedding), 0) = 0),
      STRUCT(TRUE AS flatten_json_output, 'CLUSTERING' AS task_type, {own.embedding_dimensions} AS output_dimensionality))
    WHERE ARRAY_LENGTH(ml_generate_embedding_result) > 0
  ) S
  WHERE T.post_id = S.post_id AND T.ingested_at >= pending_ts;
  SET n_embedded = @@row_count;

  -- BigQuery's search takes whole tables: posts and stories whose numbers are missing, or of another length, are left out first.
  CREATE TEMP TABLE unplaced AS
  SELECT post_id, published_at, embedding FROM `{ds}.posts`
  WHERE ingested_at >= pending_ts AND rule_eval_status = 'NEEDS_STORY_CLUSTER' AND story_id IS NULL AND ARRAY_LENGTH(embedding) = {own.embedding_dimensions};

  CREATE TEMP TABLE running_stories AS
  SELECT story_id, centroid_embedding FROM `{ds}.stories`
  WHERE updated_at >= active_ts AND ARRAY_LENGTH(centroid_embedding) = {own.embedding_dimensions};

  IF EXISTS (SELECT 1 FROM running_stories) AND EXISTS (SELECT 1 FROM unplaced) THEN
    UPDATE `{ds}.posts` p
    SET story_id = matched.story_id
    FROM (
      SELECT query.post_id, ARRAY_AGG(base.story_id ORDER BY distance ASC LIMIT 1)[SAFE_OFFSET(0)] AS story_id
      FROM VECTOR_SEARCH(TABLE running_stories, 'centroid_embedding', TABLE unplaced, 'embedding', top_k => 1, distance_type => 'COSINE')
      WHERE distance <= cos_threshold
      GROUP BY query.post_id
    ) matched
    WHERE p.post_id = matched.post_id AND p.ingested_at >= pending_ts;
  END IF;

  -- ...then with each other: a post starts a story with the earliest new post it is close to.
  CREATE TEMP TABLE still_unplaced AS
  SELECT u.post_id, u.published_at, u.embedding
  FROM unplaced u JOIN `{ds}.posts` p ON p.post_id = u.post_id AND p.ingested_at >= pending_ts
  WHERE p.story_id IS NULL;

  IF (SELECT COUNT(*) FROM still_unplaced) > 1 THEN
    UPDATE `{ds}.posts` p
    SET story_id = CONCAT('st-', started.leader)
    FROM (
      SELECT query.post_id, ARRAY_AGG(base.post_id ORDER BY base.published_at ASC, base.post_id ASC LIMIT 1)[SAFE_OFFSET(0)] AS leader
      FROM VECTOR_SEARCH(TABLE still_unplaced, 'embedding', TABLE still_unplaced, 'embedding', top_k => {own.neighbours}, distance_type => 'COSINE')
      WHERE distance <= cos_threshold
      GROUP BY query.post_id
    ) started
    WHERE p.post_id = started.post_id AND p.ingested_at >= pending_ts;
  END IF;

  UPDATE `{ds}.posts`
  SET story_id = IFNULL(story_id, CONCAT('st-', post_id)), rule_eval_status = 'CLUSTERED'
  WHERE ingested_at >= pending_ts AND rule_eval_status = 'NEEDS_STORY_CLUSTER' AND ARRAY_LENGTH(embedding) > 0;

  -- 4. How fast each story is growing. A new story's centre is its earliest post.
  MERGE `{ds}.stories` T
  USING (
    SELECT story_id,
      ANY_VALUE(post_id HAVING MIN IFNULL(published_at, ingested_at)) AS rep_post_id,
      ANY_VALUE(embedding HAVING MIN IFNULL(published_at, ingested_at)) AS sample_emb,
      COUNTIF(ingested_at >= TIMESTAMP_SUB(run_ts, INTERVAL 15 MINUTE)) AS c15,
      COUNT(DISTINCT IF(ingested_at >= TIMESTAMP_SUB(run_ts, INTERVAL 15 MINUTE), author_hash, NULL)) AS u15,
      COUNTIF(ingested_at >= TIMESTAMP_SUB(run_ts, INTERVAL 1 HOUR)) AS c60,
      SAFE_DIVIDE(COUNTIF(ingested_at >= TIMESTAMP_SUB(run_ts, INTERVAL 15 MINUTE)) * 4.0,
                  GREATEST(COUNTIF(ingested_at >= TIMESTAMP_SUB(run_ts, INTERVAL 1 HOUR)), 1)) AS vel_ratio
    FROM `{ds}.posts`
    WHERE ingested_at >= active_ts AND story_id IS NOT NULL AND ARRAY_LENGTH(embedding) > 0
    GROUP BY story_id
  ) S
  ON T.story_id = S.story_id
  WHEN MATCHED THEN UPDATE SET
    updated_at = IF(S.c15 > 0, run_ts, T.updated_at), post_count_15m = S.c15, unique_authors_15m = S.u15, post_count_1h = S.c60,
    velocity_ratio_15m = S.vel_ratio
  WHEN NOT MATCHED THEN INSERT (story_id, created_at, updated_at, representative_post_id, centroid_embedding, post_count_15m, unique_authors_15m,
                                post_count_1h, velocity_ratio_15m)
  VALUES (S.story_id, run_ts, run_ts, S.rep_post_id, S.sample_emb, S.c15, S.u15, S.c60, S.vel_ratio);

  -- 5. Gemini looks at each story that is growing fast enough, once per cool-down unless it has grown again.
  CREATE TEMP TABLE story_candidates AS
  SELECT s.story_id, s.post_count_15m,
    CONCAT('Stage 1 Story Triage. Instructions: ', discovery_guidelines,
           '\\n15m Posts: ', CAST(s.post_count_15m AS STRING), ' | Velocity: ', CAST(ROUND(s.velocity_ratio_15m, 2) AS STRING),
           '\\nMemory: ', IFNULL(s.story_summary, 'Unalerted'),
           '\\nSnippets:\\n', (SELECT STRING_AGG(p.sanitized_snippet, '\\n---\\n' ORDER BY p.ingested_at DESC LIMIT {own.story_snippets})
                               FROM `{ds}.posts` p
                               WHERE p.story_id = s.story_id AND p.ingested_at >= TIMESTAMP_SUB(run_ts, INTERVAL 1 HOUR))) AS prompt
  FROM `{ds}.stories` s
  WHERE s.updated_at >= active_ts
    AND s.post_count_15m >= min_story_posts AND s.velocity_ratio_15m >= min_vel_ratio
    AND (s.last_alerted_at IS NULL OR s.last_alerted_at < TIMESTAMP_SUB(run_ts, INTERVAL cooldown_mins MINUTE))
    AND (s.last_triaged_at IS NULL OR s.last_triaged_at < TIMESTAMP_SUB(run_ts, INTERVAL cooldown_mins MINUTE)
         OR s.post_count_15m >= IFNULL(s.last_triaged_posts, 0) * regrowth);

  CREATE TEMP TABLE story_verdicts AS
  SELECT story_id, is_noise, rank_score, triage_summary, status
  FROM AI.GENERATE_TABLE(
    MODEL `{ds}.{FAST_MODEL}`,
    (SELECT story_id, prompt FROM story_candidates WHERE prompt IS NOT NULL),
    STRUCT('is_noise BOOL, rank_score FLOAT64, triage_summary STRING' AS output_schema));
  SET n_stories_asked = (SELECT COUNT(*) FROM story_verdicts);

  INSERT INTO `{ds}.review_queue` ({queue_cols})
  SELECT GENERATE_UUID(), run_ts, 'STORY', story_id, 'STORY_STAGE1_GEMINI', CAST(NULL AS STRING), rank_score, triage_summary, FALSE
  FROM story_verdicts
  WHERE is_noise = FALSE AND rank_score >= story_min_score;
  SET n_stories_queued = @@row_count;

  UPDATE `{ds}.stories` s
  SET last_triaged_at = run_ts, last_triaged_posts = c.post_count_15m
  FROM story_candidates c JOIN story_verdicts v ON v.story_id = c.story_id
  WHERE s.story_id = c.story_id AND IFNULL(v.status, '') = '';

  MERGE `{ds}.pipeline_watermarks` T
  USING (SELECT '{WATERMARK}' AS src, run_ts AS ts) S
  ON T.source_name = S.src
  WHEN MATCHED THEN UPDATE SET last_processed_ts = S.ts
  WHEN NOT MATCHED THEN INSERT (source_name, last_processed_ts) VALUES (S.src, S.ts);

  SELECT n_staged AS staged, n_new AS new_posts, n_hard AS hard, n_single AS single_asked, n_single_queued AS single_queued,
         n_embedded AS embedded, n_stories_asked AS stories_asked, n_stories_queued AS stories_queued;
END"""


def statements(ctx: "AgentContext") -> list[dict[str, str]]:
    """Every statement that creates agent alerts' objects, in the order they run: {what, sql}."""
    own = ctx.config.platform.own_alerts
    ds = dataset(ctx)
    models = _models(own)
    out: list[dict[str, str]] = []
    for name, (columns, partition, cluster, keep, what) in TABLES.items():
        kept = days(own, keep)
        out.append({"what": f"table {name}", "sql": (
            f"CREATE TABLE IF NOT EXISTS `{ds}.{name}` (\n  {columns}\n)\nPARTITION BY DATE({partition})\nCLUSTER BY {cluster}\n"
            f"OPTIONS (partition_expiration_days = {kept}, description = \"{what}\")")})
        out.append({"what": f"days {name} is kept", "sql": f"ALTER TABLE `{ds}.{name}` SET OPTIONS (partition_expiration_days = {kept})"})
    for name, (columns, what) in PLAIN_TABLES.items():
        out.append({"what": f"table {name}", "sql": f"CREATE TABLE IF NOT EXISTS `{ds}.{name}` (\n  {columns}\n)\nOPTIONS (description = \"{what}\")"})
    out.append({"what": f"function {FUNCTION}", "sql": function_sql(ds, own)})
    for name, endpoint in models.items():
        out.append({"what": f"model {name}", "sql": (
            f"CREATE OR REPLACE MODEL `{ds}.{name}`\nREMOTE WITH CONNECTION `{own.ai_connection.strip()}`\nOPTIONS (endpoint = '{endpoint}')")})
    out.append({"what": f"procedure {PROCEDURE}", "sql": procedure_sql(ds, own)})
    return out


def call(ctx: "AgentContext", other_alerts_source: str) -> tuple[str, dict[str, Any]]:
    """The statement that runs the procedure, and its parameters from Settings."""
    own = ctx.config.platform.own_alerts
    values: dict[str, Any] = {
        "doc_guidelines": own.doc_guidelines, "discovery_guidelines": own.discovery_guidelines, "cos_threshold": float(own.cos_threshold),
        "min_vel_ratio": float(own.min_vel_ratio), "min_story_posts": int(own.min_story_posts), "cooldown_mins": int(own.cooldown_minutes),
        "single_min_score": float(own.single_min_score), "story_min_score": float(own.story_min_score), "regrowth": float(own.regrowth),
        "story_active_hours": int(own.story_active_hours), "catch_up_hours": int(own.catch_up_hours),
        "other_alerts_source": other_alerts_source, "other_alerts_mandatory": bool(own.other_alerts_mandatory),
    }
    names = [name for name, _ in PARAMS]
    return f"CALL `{dataset(ctx)}.{PROCEDURE}`(" + ", ".join(f"@{n}" for n in names) + ")", {n: values[n] for n in names}


def version(ctx: "AgentContext") -> str:
    return hashlib.sha256("\n;\n".join(s["sql"] for s in statements(ctx)).encode()).hexdigest()[:16]


def current(ctx: "AgentContext") -> bool:
    """True when the objects were created from the settings as they stand now."""
    return (ctx.store.get_kv(STATE) or {}).get("version") == version(ctx)


def provision(ctx: "AgentContext") -> list[dict[str, Any]]:
    """Creates agent alerts' objects, or brings them up to date. Needs the switch Change BigQuery from here. Stops at the
    first statement BigQuery refuses, and says which."""
    from .. import bq_admin

    todo = statements(ctx)
    bq_admin.require_admin(ctx, table(ctx, "posts"))
    gw = bq_admin.get_gateway(ctx)
    home = ctx.config.platform.bigquery.location or None
    steps: list[dict[str, Any]] = []
    for statement in todo:
        try:
            gw.query(statement["sql"], location=home, labels=LABELS)
        except Exception as exc:  # the step is named, with BigQuery's own words
            raise RuntimeError(f"BigQuery refused to create the {statement['what']}: {str(exc)[:400]}") from exc
        steps.append({"step": statement["what"], "ok": True})
    ctx.store.put_kv(STATE, {"version": version(ctx), "at": ctx.now().isoformat()})
    return steps
