---
name: slrr-parity-tuning
description: >-
  Analyzes disagreements between the Burson QA Bot and human Incident Managers (IMs) on Social
  Alert calls (im_only vs bot_only on the Results tab), inspects BigQuery and Cloud Logging
  context, and recommends whether to add a Guidance row, update a Resources doc, or record a
  Learned Precedent. Use whenever reviewing bot vs IM accuracy or tuning escalation rules.
---

# SLRR Bot vs. Human IM Parity & Disagreement Tuning

Use this skill when the user wants to review why the bot and the human Incident Managers (IMs) differed on one or more alerts (shown under `WHERE THE BOT AND THE IMs DIFFERED` on the `Results` tab) and tune the bot's behavior.

## 1. Where Parity Data Lives
1. **In the Google Sheet (`Results` tab, built by `Speed.gs`):**
   - Compares every Burson alert from the last 7 days across both test spaces (`Mirror space` and `Auto-correct space`) against:
     - **Human IM Gmail Sends:** Emails from the configured Brand Social sender (`settings.speed_im_sender` / `GEN.email.from_email`) in the bot's mailbox matched by normalized post key (`postKey_`: X status ID, YouTube video ID, Instagram shortcode, Reddit post ID, etc.).
     - **Human IM Drafts (`brand-social-central-data.slrr_feedback.alert_sends`):** Drafts created in the SLRR Assistant.
     - **Master SLRR Archive (`brand-social-central-data.slrr_alerts.slrr_alerts`):** Logged alerts.
2. **In BigQuery (`brand-social-central-data` & `bsip-s-bsip-gg-26-2cf3`):**
   - Query IM drafts and logged alerts for a specific post URL or date window:
     ```sql
     SELECT post_url, subject, drafted_by, created_at
     FROM `brand-social-central-data.slrr_feedback.alert_sends`
     WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
     ORDER BY created_at DESC
     ```
   - Query Pendulum & Brandwatch raw capture for the post:
     ```sql
     SELECT url, description, transcript, ocr, image_caption, content_summary
     FROM `bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`
     WHERE url LIKE '%<POST_ID>%'
     LIMIT 5
     ```

## 2. Diagnosing a Disagreement (`IMs sent, bot didn't` vs `Bot sent, IMs didn't`)
For each disagreement:
1. **Check the Bot's Recorded Reason (`Why (bot)` column / `decision` field in `Alert log`):**
   - Did deterministic rules in `Escalate.gs` say `escalated: false` (e.g., `< 2,000` engagements, not P0, not Sensitive Topic, not KOF)?
   - Or did Gemini veto (`❌`) the alert via `aiVeto_()` / `kofNoAlertWhy_()` in `Drafts.gs` (e.g., `already alerted`, `a comment on an alerted post`, `the knowledge base (...)`)?
2. **Check Cloud Logging for the Alert's Review:**
   - Look up `knowledge:` and `knowledge used:` for that alert's `process_id` to see which `Resources` passages Gemini read and cited.

## 3. Choosing the Right Fix (Without Overfitting Code)
Always prefer sheet-driven tuning over hardcoding narrow exceptions in `.gs` files:
1. **Temporary or Breaking-News Rule -> Add to the `Guidance` Tab:**
   - If leads want a specific topic, launch, or event escalated (or skipped) for the next few days/weeks, add a row on the `Guidance` tab (`Guidance · Applies to · Until · Added by`).
   - *Note:* Ensure `KB & Guidance can start alerts` (`Row 13` on `Control`) is `ON` if the guidance asks to escalate posts below the 2,000-engagement threshold.
2. **Permanent Policy / Threshold Change -> Update the `Resources` Document:**
   - If the rule belongs in `SLRR Collection Requirements`, `Alerting & Escalation Thresholds`, or `Alerting Chat`, update that Google Doc. The bot automatically detects the Drive modification within 15 minutes (or immediately via `refreshKnowledge()`) and updates its `"Knowledge cache (bot)"` tab.
3. **Recurring Judgment Pattern -> `Learn from IM calls` (`Row 17` on `Control`):**
   - When `Learn from IM calls` is `ON`, decided disagreements from the `Results` tab are written to the `Learned precedents` tab and injected into Gemini's review prompt for similar future alerts on the same product/exposure tag.
