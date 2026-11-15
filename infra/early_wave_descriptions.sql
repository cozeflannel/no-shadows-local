-- Descriptions for brand-social-central-data.early_wave.triage_verdicts, as the bot writes it
-- (apps-script-chat-bot/FastTriage.gs: ewBqVerdictRow_, EW_BQ_ACTIONS_). Descriptions only: no column, row or
-- setting changes. Run once in the BigQuery console (location US), then verifyEarlyWaveBqLive() in the Apps Script
-- editor reports `action_values_not_described: []`.

ALTER TABLE `brand-social-central-data.early_wave.triage_verdicts`
SET OPTIONS (
  description = 'One row per Gemini Decisions call made by the fast triage: the answers, the probabilities, token use, latency, and the failure when there was one. subject_type: signal (asked when a signal is queued) or watch_story (a story still below the promotion bar). action: ranked, kept, held_back, emitted, not_emitted; null when the call failed. raw holds the full response.'
);

ALTER TABLE `brand-social-central-data.early_wave.triage_verdicts`
ALTER COLUMN action SET OPTIONS (
  description = 'What was done with the answers. For a signal: ranked (its answers ordered the queue, row 39 ON), kept (asked about and sent on to its review, row 40 ON with row 39 OFF), held_back (dropped without a review, row 40). For a watch_story: emitted (raised as an EARLY_WATCH signal, row 39), not_emitted (asked about and not raised). Null when the call failed.'
);
