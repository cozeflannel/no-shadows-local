-- =============================================================================
-- 01_agent_events.sql — the agent's append-only analytics log (one row per
-- triage_agent.models.AgentEvent). Placeholders ${PROJECT}/${DATASET} are
-- substituted by infra/04_bigquery.sh. Safe to re-run.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS `${PROJECT}.${DATASET}`
OPTIONS (location = '${BQ_LOCATION}', labels = [('app', 'slrr-triage-agent')]);

CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.agent_events` (
  event_id        STRING    NOT NULL OPTIONS (description = 'UUID; insert id for de-duplication'),
  event_ts        TIMESTAMP NOT NULL,
  event_type      STRING    NOT NULL OPTIONS (description = 'triage_agent.events.EventType, e.g. triage.corrected'),
  env             STRING    OPTIONS (description = 'dev | shadow | prod'),
  case_id         STRING    OPTIONS (description = 'TRG-…'),
  escalation_id   STRING    OPTIONS (description = 'ESC-…'),
  actor           STRING    OPTIONS (description = '"agent" or a user email'),
  space           STRING    OPTIONS (description = 'burson | clean | dm | youtube | doodle | team | crisis | handover | email | console | system'),
  message_ref     STRING,
  attempt         INT64     OPTIONS (description = '1 = first submission, >1 = rerun / update'),
  verdict         STRING    OPTIONS (description = 'PASS | CORRECTED | SUPPRESSED | NEEDS_REVIEW | FAIL'),
  error_codes     ARRAY<STRING>,
  latency_ms      INT64,
  model           STRING,
  prompt_version  STRING,
  config_version  STRING    OPTIONS (description = 'config version + content hash at event time'),
  payload         JSON      OPTIONS (description = 'event-specific fields (docs/CONTRACTS.md §15)')
)
PARTITION BY DATE(event_ts)
CLUSTER BY event_type, case_id
OPTIONS (
  description = 'SLRR Alert Automation Agent events (docs/CONTRACTS.md §15). KPIs: 02_metric_views.sql mirrors triage_agent/metrics.py.',
  labels = [('app', 'slrr-triage-agent')]
);
