-- =============================================================================
-- 02_metric_views.sql — KPI views that mirror triage_agent/metrics.py
-- (KPI_DEFINITIONS + compute_kpis). If you change one, change the other;
-- tests/test_analytics_sql.py checks every KPI key appears here.
--
-- Views
--   v_event_kpis          one row per (event, KPI key) — the single mapping
--   v_kpi_daily           day (ET) × env × kpi -> n
--   v_first_pass_yield    day × env -> first_pass_yield
--   v_corrections_by_field, v_suppressed_by_reason, v_actions_by_code,
--   v_protocol_pings, v_sla, v_parity, v_speed
-- Placeholders ${PROJECT}/${DATASET} are substituted by infra/04_bigquery.sh.
-- =============================================================================

CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_event_kpis` AS
WITH e AS (
  SELECT
    *,
    JSON_VALUE(payload, '$.source')  AS p_source,
    JSON_VALUE(payload, '$.purpose') AS p_purpose,
    JSON_VALUE(payload, '$.trigger') AS p_trigger,
    JSON_VALUE(payload, '$.outcome') AS p_outcome,
    JSON_VALUE(payload, '$.rating')  AS p_rating,
    JSON_VALUE(payload, '$.side')    AS p_side,
    SAFE_CAST(JSON_VALUE(payload, '$.after_bounce') AS BOOL) AS p_after_bounce
  FROM `${PROJECT}.${DATASET}.agent_events`
)
SELECT e.* EXCEPT (p_source, p_purpose, p_trigger, p_outcome, p_rating, p_side, p_after_bounce), kpi
FROM e,
UNNEST(ARRAY_CONCAT(
  -- intake & QA
  IF(event_type = 'alert.received', ['alerts_received'], []),
  IF(event_type = 'alert.received' AND p_source = 'watchdog', ['watchdog_alerts_created'], []),
  IF(event_type = 'triage.passed' AND IFNULL(attempt, 1) = 1, ['forwarded_without_edits'], []),
  IF(event_type = 'triage.corrected', ['auto_corrected'], []),
  IF(event_type = 'triage.failed', ['sent_back_for_edits'], []),
  IF(event_type IN ('triage.passed', 'triage.corrected') AND IFNULL(attempt, 1) > 1 AND IFNULL(p_after_bounce, FALSE),
     ['burson_reruns_passed'], []),
  IF(event_type = 'triage.suppressed', ['suppressed'], []),
  IF(event_type = 'triage.needs_review', ['needs_review'], []),
  IF(event_type = 'review.forwarded', ['review_forwarded'], []),
  IF(event_type = 'review.bounced', ['review_bounced'], []),
  IF(event_type = 'review.suppressed', ['review_suppressed'], []),
  IF(event_type = 'correction.applied', ['corrections_applied'], []),
  IF(event_type = 'correction.reverted', ['corrections_reverted'], []),
  IF(event_type = 'verdict.overridden', ['verdict_overrides'], []),
  IF(event_type = 'oncall.notified', ['oncall_alerts'], []),
  IF(event_type = 'case.abandoned', ['cases_abandoned'], []),
  -- IM workflow
  IF(event_type = 'alert.acknowledged', ['alerts_acknowledged'], []),
  IF(event_type = 'action.recorded', ['im_actions'], []),
  IF(event_type = 'protocol.pinged', ['protocol_pings'], []),
  IF(event_type = 'sla.met', ['sla_met'], []),
  IF(event_type = 'sla.missed', ['sla_missed'], []),
  IF(event_type = 'sla.at_risk', ['sla_at_risk'], []),
  -- email drafts
  IF(event_type = 'escalation.started', ['escalations_started'], []),
  IF(event_type = 'escalation.started' AND p_trigger = 'auto_urgent', ['urgent_auto_drafts'], []),
  IF(event_type = 'email.drafted', ['emails_drafted'], []),
  IF(event_type = 'email.revision_requested', ['emails_returned_for_edits'], []),
  IF(event_type = 'email.redrafted', ['emails_redrafted'], []),
  IF(event_type = 'email.sent', ['emails_sent'], []),
  IF(event_type = 'email.discarded', ['emails_discarded'], []),
  IF(event_type = 'email.group_added', ['groups_added'], []),
  -- Trust & Safety
  IF(event_type = 'tns.prepared', ['tns_prepared'], []),
  IF(event_type = 'tns.submitted', ['tns_submitted'], []),
  IF(event_type = 'tns.not_eligible', ['tns_not_eligible'], []),
  IF(event_type = 'email.drafted' AND p_purpose = 'tns_urgent', ['tns_urgent_emails'], []),
  IF(event_type = 'tns.outcome' AND p_outcome = 'Fixed', ['tns_fixed'], []),
  IF(event_type = 'tns.outcome' AND p_outcome = 'Infeasible', ['tns_infeasible'], []),
  IF(event_type = 'email.drafted' AND p_purpose = 'bug_followup', ['bug_followups_drafted'], []),
  IF(event_type = 'email.sent' AND p_purpose = 'bug_followup', ['bug_followups_sent'], []),
  -- conversation
  IF(event_type = 'qa.answered', ['questions_answered'], []),
  IF(event_type IN ('route.forwarded', 'route.relayed'), ['rerouted_to_stakeholders'], []),
  IF(event_type = 'qa.feedback' AND p_rating = 'up', ['answers_helpful'], []),
  IF(event_type = 'qa.feedback' AND p_rating = 'down', ['answers_unhelpful'], []),
  -- Path B parity
  IF(event_type = 'parity.matched', ['parity_matched'], []),
  IF(event_type = 'parity.unmatched' AND p_side = 'burson_only', ['parity_burson_only'], []),
  IF(event_type = 'parity.unmatched' AND p_side = 'inhouse_only', ['parity_inhouse_only'], []),
  -- jobs
  IF(event_type = 'handover.posted', ['handovers_posted'], []),
  IF(event_type = 'burson.digest_posted', ['burson_digests'], [])
)) AS kpi;

CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_kpi_daily` AS
SELECT DATE(event_ts, 'America/New_York') AS day, env, kpi, COUNT(*) AS n
FROM `${PROJECT}.${DATASET}.v_event_kpis`
GROUP BY day, env, kpi;

-- first_pass_yield = PASS on attempt 1 / all first-attempt decisions
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_first_pass_yield` AS
SELECT
  DATE(event_ts, 'America/New_York') AS day, env,
  COUNTIF(event_type = 'triage.passed') AS first_pass,
  COUNT(*) AS first_attempt_decisions,
  SAFE_DIVIDE(COUNTIF(event_type = 'triage.passed'), COUNT(*)) AS first_pass_yield
FROM `${PROJECT}.${DATASET}.agent_events`
WHERE event_type IN ('triage.passed', 'triage.corrected', 'triage.failed', 'triage.needs_review', 'triage.suppressed')
  AND IFNULL(attempt, 1) = 1
GROUP BY day, env;

-- derived.corrections_by_field
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_corrections_by_field` AS
SELECT DATE(event_ts, 'America/New_York') AS day, env, JSON_VALUE(payload, '$.field') AS field,
       JSON_VALUE(payload, '$.source') AS source, COUNT(*) AS n
FROM `${PROJECT}.${DATASET}.agent_events`
WHERE event_type = 'correction.applied'
GROUP BY day, env, field, source;

-- derived.suppressed_by_reason
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_suppressed_by_reason` AS
SELECT DATE(event_ts, 'America/New_York') AS day, env, JSON_VALUE(payload, '$.reason') AS reason, COUNT(*) AS n
FROM `${PROJECT}.${DATASET}.agent_events`
WHERE event_type = 'triage.suppressed'
GROUP BY day, env, reason;

-- derived.actions_by_code
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_actions_by_code` AS
SELECT DATE(event_ts, 'America/New_York') AS day, env, JSON_VALUE(payload, '$.code') AS code,
       JSON_VALUE(payload, '$.emoji') AS emoji, COUNT(*) AS n
FROM `${PROJECT}.${DATASET}.agent_events`
WHERE event_type = 'action.recorded'
GROUP BY day, env, code, emoji;

-- derived.protocol_pings_by_type
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_protocol_pings` AS
SELECT DATE(event_ts, 'America/New_York') AS day, env, JSON_VALUE(payload, '$.protocol') AS protocol, COUNT(*) AS n
FROM `${PROJECT}.${DATASET}.agent_events`
WHERE event_type = 'protocol.pinged'
GROUP BY day, env, protocol;

-- derived.sla_met_pct, sla_by_track, sla_by_tier
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_sla` AS
SELECT
  DATE(event_ts, 'America/New_York') AS day, env,
  JSON_VALUE(payload, '$.track') AS track,
  JSON_VALUE(payload, '$.platform_tier') AS platform_tier,
  COUNTIF(event_type = 'sla.met') AS met,
  COUNTIF(event_type = 'sla.missed') AS missed,
  SAFE_DIVIDE(COUNTIF(event_type = 'sla.met'), COUNT(*)) AS sla_met_pct
FROM `${PROJECT}.${DATASET}.agent_events`
WHERE event_type IN ('sla.met', 'sla.missed')
GROUP BY day, env, track, platform_tier;

-- derived.parity_recall = matched / (matched + burson_only)
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_parity` AS
SELECT
  DATE(event_ts, 'America/New_York') AS day, env,
  COUNTIF(event_type = 'parity.matched') AS matched,
  COUNTIF(event_type = 'parity.unmatched' AND JSON_VALUE(payload, '$.side') = 'burson_only') AS burson_only,
  COUNTIF(event_type = 'parity.unmatched' AND JSON_VALUE(payload, '$.side') = 'inhouse_only') AS inhouse_only,
  SAFE_DIVIDE(COUNTIF(event_type = 'parity.matched'),
              COUNTIF(event_type = 'parity.matched')
              + COUNTIF(event_type = 'parity.unmatched' AND JSON_VALUE(payload, '$.side') = 'burson_only')) AS parity_recall
FROM `${PROJECT}.${DATASET}.agent_events`
WHERE event_type IN ('parity.matched', 'parity.unmatched')
GROUP BY day, env;

-- derived speed metrics (minutes): detect_latency_min, post_to_send_min, flag_to_send_min,
-- time_to_correction_min; triage_latency_ms
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_speed` AS
SELECT
  DATE(event_ts, 'America/New_York') AS day, env,
  AVG(IF(event_type = 'alert.received', SAFE_CAST(JSON_VALUE(payload, '$.detect_latency_s') AS FLOAT64), NULL)) / 60 AS detect_latency_min_avg,
  AVG(IF(event_type = 'email.sent' AND IFNULL(JSON_VALUE(payload, '$.purpose'), 'alert') = 'alert',
         SAFE_CAST(JSON_VALUE(payload, '$.post_to_send_s') AS FLOAT64), NULL)) / 60 AS post_to_send_min_avg,
  AVG(IF(event_type = 'email.sent' AND IFNULL(JSON_VALUE(payload, '$.purpose'), 'alert') = 'alert',
         SAFE_CAST(JSON_VALUE(payload, '$.flag_to_send_s') AS FLOAT64), NULL)) / 60 AS flag_to_send_min_avg,
  AVG(IF(event_type IN ('triage.passed', 'triage.corrected'), SAFE_CAST(JSON_VALUE(payload, '$.time_to_correction_s') AS FLOAT64), NULL)) / 60
    AS time_to_correction_min_avg,
  AVG(IF(event_type IN ('triage.passed', 'triage.corrected', 'triage.failed', 'triage.needs_review', 'triage.suppressed'),
         latency_ms, NULL)) AS triage_latency_ms_avg
FROM `${PROJECT}.${DATASET}.agent_events`
GROUP BY day, env;
