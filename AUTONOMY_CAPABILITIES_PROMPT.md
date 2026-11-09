# Task: Build Toggleable Full-Autonomy & Next-Gen Intelligence Capabilities in the Existing Burson QA Bot Sheet

## 1. Strict Scope & Non-Negotiable Guardrails
- **Workspace:** Work ONLY inside `/Users/lhammonds/.gemini/jetski/scratch/burson-triage-agent` (primarily `apps-script-chat-bot/`, `config/default_config.yaml`, `scripts/build_apps_script.py`, and `apps-script-chat-bot/test/`). Never touch files outside this workspace.
- **No Deviation from Current Architecture:** Everything MUST run natively inside the existing Google Apps Script project (`scriptId: 19HakS6-o8U1qT99Xpnw2TQbJnZMx5FZz_JzVDd93Yd9gopQ9qXaWnGk3`) and the existing Google Sheet (`Burson QA bot`).
- **Explicitly Excluded:** Do NOT build or propose `#4 (True Event-Driven Cloud Architecture / Cloud Run / PubSub / external web dashboards)`. Keep the Google Sheet's `Control` tab as the single UI.
- **All New Capabilities Default to `OFF`:** Every capability below (except the passive 50,000-character cell-write safeguard) MUST have its own `ON / OFF` dropdown row on the `Control` tab, **defaulted to `OFF`**, with Column C showing its live status when `ON` or a clear "OFF (…)" description when `OFF`.
- **Stealth / Burson Isolation Requirement:**
  - The BigQuery write-back feature (`Write back to SLRR BigQuery tables`) MUST default to `OFF` and MUST NEVER write to `slrr_alerts.slrr_alerts` or `slrr_feedback.alert_sends` unless its `Control` tab switch is explicitly `ON`, so people on the Burson team or shared dashboards cannot see the bot at work while testing.
  - While in Testing mode (`Control!B30` testers / `stand_in`), ALL outbound emails, DMs, and form submissions must continue to respect the testing sandbox (never emailing real `Brand safety groups` distros or the T&S urgent alias, and never submitting to live external forms unless LIVE AND the feature switch is `ON`).
  - Nothing posted in a Burson-visible space may ever mention the analyst space, auto-correct space, mirror space, BigQuery write-backs, or internal automation.

---

## 2. Always-On Runtime Fix (No Switch Needed)
### 2.1. Fix the 50,000-Character Single-Cell Limit Error (`Sheets.gs`, `Speed.gs`)
- **Problem:** Live Cloud Logging shows `Your input contains more than the maximum of 50000 characters in a single cell` when writing large JSON columns (such as `email_input` containing `screenshot` data or large `forwarded_fields`) in `Sheets.gs` (`encodeCell_`) or long strings in `Speed.gs` (`speedText_`).
- **Implementation:**
  - In `Sheets.gs` (`encodeCell_`), cap any string or serialized JSON cell value at `49,000` characters (`SHEET_CELL_MAX_CHARS_ = 49000`). For JSON columns (`JSON_COLUMNS_`) that exceed `49,000` characters, strip or truncate oversized nested fields (e.g., `screenshot.base64` / long text snippets in `email_input`) first so the cell remains valid, parseable JSON under `49,000` chars.
  - In `Speed.gs` (`speedText_`), cap cell strings at `49,000` characters.
- **Upstream / Downstream Impact:**
  - *Upstream:* `Drafts.gs` (`draftPlan_`) attaches `review.screenshot` and `escalation` to `email_input`.
  - *Downstream:* `decodeCell_()` in `Sheets.gs` and `Results` tab reads (`resultsAlertRows_`) will still parse valid JSON without throwing a 50k cell exception during `poll()`.

---

## 3. Control Tab Layout & `ON / OFF` Switches (`Control.gs`, `Main.gs`)
Extend the `Control` tab layout cleanly between row 10 (`Auto-correct space`) and the `"How it works"` help block:
- Move `CONTROL_HELP_ROW_` down to accommodate the new capability switches (and ensure `ensureControlTab_` migrates existing sheets in place without overwriting user values in `B2:B10` or any existing toggle values).
- Add the following `ON / OFF` dropdown rows (all defaulted to `'OFF'` with `SpreadsheetApp.newDataValidation().requireValueInList(['ON', 'OFF'], true)`):

| Row | Column A Label | Default (`Col B`) | Column C Status / Hint |
|---|---|---|---|
| **11** | `Auto-send Social Alerts` | `OFF` | When `OFF`: creates Gmail draft (or sends to `stand_in` while testing). When `ON`: sends live Social Alert email automatically without waiting for a human to click Send in Gmail. |
| **12** | `Auto-submit T&S form` | `OFF` | When `OFF`: posts pre-filled T&S form link in Chat. When `ON`: submits the T&S form automatically via `FormApp` (test copy while `stand_in` is set; live form + urgent email when live). |
| **13** | `KB & Guidance can start alerts` | `OFF` | When `OFF`: KB/Guidance can only veto (`❌`) or reclassify fields. When `ON`: Gemini can start a Social Alert when backed by a cited `Guidance` item or `Resources` doc even if static rules wouldn't escalate. |
| **14** | `Auto-find missing links` | `OFF` | When `OFF`: asks Burson when a link/author is missing. When `ON`: searches BigQuery (`slrr`, `sonar_raw`) by Issue Name / text snippet to fill in missing `post_url` and `author` before asking Burson. |
| **15** | `Direct BigQuery alerts` | `OFF` | When `OFF`: reviews Chat alerts only. When `ON`: enables `pollBigQuerySources_()` (`Sprinklr`, `BMIE`, `BSIP`) to ingest un-alerted posts directly from BigQuery with URL deduplication. |
| **16** | `Write back to SLRR BigQuery` | `OFF` | **MUST STAY `OFF` BY DEFAULT.** When `OFF`: writes only to this Google Sheet (invisible to Burson/shared tables). When `ON`: logs finalized alerts/sends to BigQuery. |
| **17** | `Learn from IM calls` | `OFF` | When `OFF`: no precedent learning. When `ON`: records bot-vs-IM disagreements from the `Results` tab into a `Learned precedents` tab and injects matching past IM calls into Gemini's review prompt. |
| **18** | `Watch sent alerts (24h)` | `OFF` | When `OFF`: stops after sending the Social Alert. When `ON`: re-checks sent alerts every 30 min for 24h (engagement surges ≥ 50K, post deletions, or press pickup) and threads a 1-line update. |
| **19** | `Early wave & velocity check` | `OFF` | When `OFF`: single-post triage only. When `ON`: runs a 15-min BigQuery check over `sonar_raw` / `content_vectors` for multi-post narrative waves or pre-viral velocity spikes and posts an early warning in the analyst space. |
| **20** | `Check outage & comms docs` | `OFF` | When `OFF`: standard review. When `ON`: cross-checks product-outage claims against live status/grounding and attaches matching reactive holding statements from `Resources` to the Social Alert email. |
| **21** | `Track post-alert outcomes` | `OFF` | When `OFF`: doesn't scan replies after send. When `ON`: monitors replies on Social Alert email threads and T&S confirmations to log resolution outcomes (`Comms responded`, `T&S actioned`, `Product bug confirmed`) on the `Alert log` and `Results` tab. |

- Update `readControl_(sh)` to read all 11 switches into `wanted.switches` (`{ autoSend, autoTns, kbStartAlerts, autoFindLinks, directBq, writeBackBq, learnIm, watchSent, earlyWave, outageComms, trackOutcomes }`) and pass them into `ctx.switches`.
- Update `writeControlHelp_(sh)` so the help bullets stay below row 22 and explain each switch in plain language.

---

## 4. Detailed Feature Specifications & Upstream / Downstream Impacts

### Feature A (`Row 11: Auto-send Social Alerts`) — `Drafts.gs`
- **Behavior:** In `tryDraft_(ctx, row, report)`, when `D.standIn` is set, keep sending only to `D.standIn` (and note in Column C: `✓ ON (testing: sending only to stand-in)`). When `D.standIn` is empty (live) and `ctx.switches.autoSend` is `ON`, send the email directly via `ctx.gmail.sendEmail(...)` instead of `createDraft(...)`, mark `email_status: 'sent'`, `email_sent_by: 'bot'`, apply the `📦` + distro emojis (`📰`, `⚖️`, etc.) in Chat, and post the sent confirmation in the analyst thread.
- **Upstream Impact:** Reads `ctx.switches.autoSend` from `Control.gs`.
- **Downstream Impact:** `Speed.gs` (`Results` tab) already treats `email_status === 'sent'` and `email_sent_at` as the bot's send time; `maintainDrafts_()` won't need to poll Gmail for manual draft sends on rows the bot already sent.

### Feature B (`Row 12: Auto-submit T&S form`) — `Drafts.gs`, `TnsForm.gs`
- **Behavior:** When an alert requires T&S (`tnsWhy_(input)` is non-empty) and `ctx.switches.autoTns` is `ON`:
  - Submit the Google Form programmatically via `FormApp.openById(formId).createResponse()...submit()` (using the test form copy in Drive when `tnsTesting_()` is true, or the live T&S form when live, deduplicated by `post_url` so the same URL is never submitted twice).
  - If `urgent` (`P0`, `HIGH`, `VIRAL KOF`, or `Child Safety`), also send the urgent notification email (to `Control!B30` testers while testing; to the configured T&S urgent alias only when live).
  - Post confirmation in the analyst thread (`✍️ T&S form auto-submitted...`).
- **Upstream Impact:** Triggered from `tryDraft_()` and `noEmailNeeded_()` in `Drafts.gs`.
- **Downstream Impact:** Updates `Results` tab `tns` counter (`Speed.gs`) and records submission in `Alert log` so retries never double-submit.

### Feature C (`Row 13: KB & Guidance can start alerts`) — `Review.gs`, `Escalate.gs`, `Drafts.gs`
- **Behavior:** Currently, `draftPlan_()` in `Drafts.gs` requires `esc.escalated === true` from deterministic rules (`Escalate.gs`), so Gemini can only *veto* (`aiVeto_`) an alert. When `ctx.switches.kbStartAlerts` is `ON`:
  - If `esc.escalated` is `false`, check whether `review.socialAlert && review.socialAlert.warranted === true` with `confidence >= S.llm_min_confidence (0.9)` AND Gemini cited either a `Guidance` item (`review.guidanceCount > 0`) or a `Resources` document (`review.knowledgeUsed.length > 0`).
  - If so, promote `esc` to `escalated: true`, `track: 'URGENT'`, `reasons: ['KB_OR_GUIDANCE']`, and create the Social Alert draft/email citing the document or guidance rule that triggered it.
- **Upstream Impact:** Uses `review.knowledgeUsed` (`Knowledge.gs`) and `review.guidanceCount` (`Control.gs`) already computed during `reviewAlert_()`.
- **Downstream Impact:** `Drafts.gs` (`escalationWhyText_`) and `Speed.gs` (`resultsReason_`) display `Escalated per <Document / Guidance>` on the `Results` tab.

### Feature D (`Row 14: Auto-find missing links`) — `BigQuery.gs`, `Review.gs`, `Bot.gs`
- **Behavior:** When a parsed alert is missing `post_url` (or `author`) and `ctx.switches.autoFindLinks` is `ON`:
  - Before `reviewAlert_()` marks `post_url` as `missing` (which would force a fix request to Burson), query `bsip-s-bsip-gg-26-2cf3.google_bg.slrr` and `sonar_raw` (last 48 hours) matching the alert's `issue_name`, `product`, `social_network`, or summary keywords.
  - If a high-confidence match is found, populate `fields.post_url` (and `fields.author`), record it as an auto-fix (`source: 'bigquery'`), and run normal URL enrichment (`lookupPost_`, `enrichFromBigQuery_`, `mediaFor_`).
- **Upstream Impact:** Runs in `Bot.gs` / `AutoCorrect.gs` right after `parseAlert_()` when `post_url` is blank.
- **Downstream Impact:** Eliminates `"Details only Burson could add (missing link)"` delays on `Results` and lets `Speed.gs` match the post against the IMs by URL key.

### Feature E (`Row 15: Direct BigQuery alerts`) — `BigQuery.gs`, `Main.gs`
- **Behavior:** Wire `pollBigQuerySources_(ctx, cfg.burson.id)` in `Main.gs` to `ctx.switches.directBq`. When `ON`, override `settings.bq_poll_sprinklr`, `settings.bq_poll_bmie`, and `settings.bq_poll_bsip` to `true` so `pollBigQuerySources_()` ingests qualifying Sprinklr, BMIE, and BSIP Sonar alerts directly into the analyst/test space, using `bqIsUrlProcessed_()` so any post Burson also alerts via Zapier is never processed twice.
- **Upstream Impact:** Reads from BigQuery tables already defined in `BigQuery.gs`.
- **Downstream Impact:** Reports counts in `report.bq_sprinklr`, `report.bq_bmie`, `report.bq_bsip` and updates Column C of row 15 on the `Control` tab.

### Feature F (`Row 16: Write back to SLRR BigQuery`) — `BigQuery.gs`, `Drafts.gs`
- **Behavior:** **Default `OFF`.** When `ctx.switches.writeBackBq` is `ON` (and ONLY when `ON`), after an alert's Social Alert email is sent or triage is finalized, insert a row into the designated BigQuery table (using `bigquery.googleapis.com` `tabledata.insertAll` with `insertId: row.alert_id` for idempotency). When `OFF`, perform zero BigQuery writes.
- **Upstream Impact:** Called from `Drafts.gs` when an email transitions to `sent` or final decision.
- **Downstream Impact:** Must NOT pollute `speedImDrafts_()` or `speedLogged_()` in `Speed.gs` (filter out rows where `drafted_by` / `source` is the bot so the `Results` tab never mistakes the bot's own write-back for a human IM's action).

### Feature G (`Row 17: Learn from IM calls`) — `Speed.gs`, `Review.gs`
- **Behavior:** When `ctx.switches.learnIm` is `ON`:
  - During `refreshSpeed_()` (`Speed.gs`), when the `Results` tab identifies decided disagreements (`s.imOnly`: IMs sent a Social Alert, bot didn't; `s.botOnly`: bot sent a Social Alert, IMs didn't), persist the latest up to 100 examples into a sheet tab named `Learned precedents` (columns: `Date · Post · Product · Exposure Tag · Engagements · KOF · Bot call · IM call · Lesson / Why · Active (Yes/No)`).
  - Before `geminiClient_().assess(parsed)` (`Review.gs`), select up to 5 active rows from `Learned precedents` matching the current alert's `product` or `exposure_tag` and include them in Gemini's prompt under `PAST IM DECISIONS ON SIMILAR ALERTS` so Gemini aligns its escalation and team-routing judgment with how the IMs handled those cases.
- **Upstream Impact:** Fed automatically by `Speed.gs` (`refreshSpeed_`).
- **Downstream Impact:** Feeds `assessPrompts_()` in `Review.gs`; users can also set `Active = No` on any row in `Learned precedents` to ignore an outlier.

### Feature H (`Row 18: Watch sent alerts (24h)`) — `Drafts.gs`, `Post.gs`, `BigQuery.gs`
- **Behavior:** When `ctx.switches.watchSent` is `ON`:
  - Every 30 minutes (budgeted to at most 3 watched alerts per run so `poll()` stays fast), check alerts from the last 24 hours where `email_status === 'sent'`.
  - Re-fetch live engagement counts (`lookupPost_` for X/Bluesky/YouTube + `enrichFromBigQuery_` for Sonar/BMIE) and check if:
    1. Engagements surged across a major milestone (`>= 50,000` and at least `3x` the count when alerted), OR
    2. The post was deleted/removed by the author (`lookupPost_` returns deleted/404), OR
    3. Mainstream news picked up the post (when web grounding finds news coverage).
  - If triggered (once per milestone per alert, tracked in `email_input.watch_state`), send a concise 1-line reply on the original Social Alert email thread (to `stand_in` while testing) and note it in the analyst Chat thread.
- **Upstream Impact:** Uses existing `lookupPost_()`, `enrichFromBigQuery_()`, and `row.email_thread`.
- **Downstream Impact:** Updates `email_input.watch_state` in `Alert log` so it never sends duplicate milestone updates.

### Feature I (`Row 19: Early wave & velocity check`) — `BigQuery.gs`, `Main.gs`
- **Behavior:** When `ctx.switches.earlyWave` is `ON`:
  - At most once every 15 minutes during `poll()`, run a lightweight BigQuery query over `bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw` / `sonar_post_aggregates_7d_materialized` (last 2 hours) to detect:
    1. **Cross-post narrative wave:** >= 5 distinct authors posting negative mentions on the same product/topic cluster in the last 2 hours whose combined engagements exceed `2,000` even if no single post hit `2,000`.
    2. **Pre-viral velocity spike:** A single post under `2,000` engagements gaining >= 500 engagements in the last 30 minutes (`velocity >= 1,000/hr`).
  - Deduplicate wave/velocity alerts via `CacheService` / `PropertiesService` and post a `🌊 Early Wave / Velocity Warning` card in the analyst space (never in the Burson space).
- **Upstream Impact:** Runs in `Main.gs` after `pollBigQuerySources_()` when `ctx.switches.earlyWave` is `ON`.
- **Downstream Impact:** Updates Column C of row 19 on `Control` with the last check time and waves spotted today.

### Feature J (`Row 20: Check outage & comms docs`) — `Review.gs`, `Email.gs`, `Knowledge.gs`
- **Behavior:** When `ctx.switches.outageComms` is `ON`:
  - If an alert is about a service outage, widespread bug, or policy issue, instruct Gemini in `assessPrompts_()` to:
    1. Use Web Grounding to check whether there is a confirmed live outage or official Google status update.
    2. Extract any matching **reactive holding statement / approved talking points** from the `Resources` knowledge base documents.
  - If found, include a `"Comms / Status Context"` line in the analyst Chat card and at the bottom of the Social Alert email body (`Email.gs`).
- **Upstream Impact:** Uses `Knowledge.gs` passages and `Gemini.gs` web grounding.
- **Downstream Impact:** Appends context block to `Email.gs` (`renderSocialAlertHtml_`) and `Chat.gs` analyst notes.

### Feature K (`Row 21: Track post-alert outcomes`) — `Drafts.gs`, `Speed.gs`, `Store.gs`
- **Behavior:** When `ctx.switches.trackOutcomes` is `ON`:
  - During `maintainDrafts_()` (`Drafts.gs`), for sent Social Alert threads (`row.email_thread`) from the last 7 days, check if there are new replies on the Gmail thread or a `WD Intake Request` confirmation email from T&S.
  - Classify the outcome (`T&S confirmed`, `Comms replied`, `Product replied`, `Resolved`) into a new `outcome` column on `Alert log` (`ALERT_COLUMNS_` in `Store.gs`).
  - Surface the outcome in the `EVERY ALERT` table on the `Results` tab (`Speed.gs`).
- **Upstream Impact:** Uses `ctx.gmail` thread inspection in `Drafts.gs` / `Mail.gs`.
- **Downstream Impact:** Adds `outcome` to `ALERT_COLUMNS_` in `Store.gs` (`sheetTable_` automatically appends missing columns to `Alert log` header without breaking existing rows).

---

## 5. Verification & Deployment Requirements
1. **Unit & Integration Tests (`apps-script-chat-bot/test/run_tests.js` & `pytest`):**
   - Add comprehensive tests for:
     - The 50,000-character cell truncation safeguard in `Sheets.gs` and `Speed.gs`.
     - `Control` tab creation, migration of existing sheets, and reading/writing all 11 `ON / OFF` switches (verifying all 11 default to `OFF`).
     - Each capability (`Features A–K`) both when its switch is `OFF` (confirming zero change to current behavior, and confirming `Write back to SLRR BigQuery` performs zero BigQuery writes when `OFF`) and when its switch is `ON` (including `stand_in` sandbox enforcement).
   - Run `node apps-script-chat-bot/test/run_tests.js` and `.venv/bin/python -m pytest` and ensure **100% of tests pass**.
2. **Deploy & Sync:**
   - Run `.venv/bin/python -m scripts.build_apps_script` if `config/default_config.yaml` changed.
   - Push to the live Apps Script project via `clasp push -f`.
   - Commit and push the changes to `origin` (`v1-burson-qa`).

---

## 6. Skills to Activate During Build & Day-to-Day Operations
Read and follow these skills via `view_file` when executing this prompt and operating the bot:

### Project-Specific Custom Skills (`.agents/skills/` in this repository)
- **`apps-script-safe-deploy`** (`.agents/skills/apps-script-safe-deploy/SKILL.md`): Enforces the 5-step build, test, stealth/sandbox check (`stand_in` active, `Write back to SLRR BigQuery` defaulted to `OFF`, 49,000-char cell cap), `clasp push -f`, and live Cloud Logging verification pipeline.
- **`slrr-bot-ops`** (`.agents/skills/slrr-bot-ops/SKILL.md`): Day-to-day live health checks, `project_key="MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ"` Cloud Logging queries, `Resources` knowledge-base read verification, and per-alert (`QA-XXXX`) triage diagnostics.
- **`slrr-parity-tuning`** (`.agents/skills/slrr-parity-tuning/SKILL.md`): Root-cause workflow for comparing bot vs. human IM calls on the `Results` tab (`im_only` vs. `bot_only`) and deciding between a `Guidance` tab entry, a `Resources` doc update, or `Learn from IM calls` (`Row 17`).

### Installed Global GCP / ML Skills (`~/.gemini/config/skills/`)
- **`google-cloud-auth-verification`** (`/Users/lhammonds/.gemini/config/skills/google-cloud-auth-verification/SKILL.md`): Pre-flight authentication verification before running `gcloud`, BigQuery, or `clasp` commands.
- **`accidental-data-loss-prevention`** (`/Users/lhammonds/.gemini/config/skills/accidental-data-loss-prevention/SKILL.md`): Enforces strict protection against unintended writes or deletions on shared BigQuery tables (`slrr_alerts`) or live Google Sheets tabs.
- **`discovering-gcp-data-assets`** (`/Users/lhammonds/.gemini/config/skills/discovering-gcp-data-assets/SKILL.md`): Used to inspect exact schemas and partition columns in `brand-social-central-data` and `bsip-s-bsip-gg-26-2cf3.google_bg` before authoring SQL for `Features D, E, F, I`.
- **`bigquery-sql`** (`/Users/lhammonds/.gemini/config/skills/bigquery-sql/SKILL.md`): Optimizes BigQuery SQL queries in `BigQuery.gs` (`Feature D` link recovery, `Feature I` 15-min wave/velocity check) so every query stays fast and partition-pruned under Apps Script's 10s timeout.
- **`bigquery-ai-ml`** (`/Users/lhammonds/.gemini/config/skills/bigquery-ai-ml/SKILL.md`): Guides vector embedding (`ML.GENERATE_EMBEDDING`, `ML.DISTANCE`) and velocity/anomaly queries in `BigQuery.gs`.
- **`enforcing-resource-attribution`** (`/Users/lhammonds/.gemini/config/skills/enforcing-resource-attribution/SKILL.md`): Ensures mandatory `CLOUDSDK_METRICS_ENVIRONMENT` / labeling on all `gcloud` and `bq` CLI commands.
- **`ml-best-practices`** (`/Users/lhammonds/.gemini/config/skills/ml-best-practices/SKILL.md`): Guides the few-shot precedent selection and confidence calibration for `Feature G` (`Learn from IM calls`).
