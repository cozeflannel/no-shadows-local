---
name: slrr-bot-ops
description: >-
  Day-to-day live operations, health checks, Cloud Logging inspection, knowledge base verification,
  and alert troubleshooting for the Burson QA Bot (SLRR Triage Chat Agent). Use whenever the user
  asks how the bot is doing, wants to inspect recent alerts or errors, checks on the Resources or
  Guidance tabs, or asks why the bot took a specific action on an alert.
---

# SLRR Burson QA Bot — Day-to-Day Operations & Diagnostics

Use this runbook to inspect the live Burson QA Bot without polluting results with other Apps Script projects in the same GCP project.

## 1. Key Identifiers (Do Not Guess)
- **Repository Path:** `/Users/lhammonds/Desktop/burson-triage-agent`
- **Apps Script Project (`scriptId`):** `19HakS6-o8U1qT99Xpnw2TQbJnZMx5FZz_JzVDd93Yd9gopQ9qXaWnGk3`
- **Cloud Logging `project_key`:** `MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ`
- **GCP Project:** `brand-social-central-data` (`1028310913761`)
- **Live Control Sheet ID:** `1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI`

> [!IMPORTANT]
> Always filter `gcloud logging read` by `labels."script.googleapis.com/project_key"="MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ"` because other unrelated Apps Script projects log to `brand-social-central-data`.

## 2. Live Health & Recent Activity Check
Run the following command to inspect the last 2 hours of live bot activity (excluding the orphaned `checkSourceSpaceForNewMessages` trigger if it hasn't been deleted from the UI yet):

```bash
CLOUDSDK_METRICS_ENVIRONMENT="${CLOUDSDK_METRICS_ENVIRONMENT:+$CLOUDSDK_METRICS_ENVIRONMENT }datacloud.antigravity" \
gcloud logging read 'labels."script.googleapis.com/project_key"="MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ"' \
  --project=brand-social-central-data \
  --freshness=2h \
  --limit=100 \
  --format="value(timestamp,severity,resource.labels.function_name,jsonPayload.message)" | grep -v "checkSourceSpaceForNewMessages"
```

### What to Look For in the Logs:
1. **`ERROR` / `WARNING` lines:**
   - `Your input contains more than the maximum of 50000 characters in a single cell` -> Indicates an uncapped cell write in `Sheets.gs` (`encodeCell_`) or `Speed.gs` (`speedText_`).
   - `Gemini couldn't review ...` -> Shows media fallback (`video` -> `still picture` -> `alert text only`).
2. **Knowledge Base (`Resources` tab) Reads:**
   - Look for `knowledge base: <Name>: ✓ Read ...` when documents are refreshed, and `knowledge: <Name> (<N> characters) · ...` on each alert review.
   - Look for `knowledge used: <DocName> (<why>)` to see which reference documents Gemini cited when triaging an alert.
3. **Run Summaries:**
   - Main space / Mirror space run JSON: `{"seen":...,"handled":...,"alerts":...,"fix_requests":...,"drafts_sent":...}`
   - Auto-correct space run JSON: `auto-correct space: {"seen":...,"handled":...,"corrected":...}`
4. **Runs Apps Script cut short (crash recovery, Main.gs `claimRun_` + Bot.gs `crashGuard_`):**
   - `Out of memory error.` / `the JavaScript engine reported an unexpected error` (ERROR, no stack) = a run was killed; nothing after it in that run is logged.
   - `the run that started at <time> ended without finishing (it no longer holds the script lock): this run takes over` = the next minute's run resumed.
   - `a run ended partway through spaces/…/messages/… in its review (with …): … Counted as try N of 3; its next review gets a still of the post | the alert text only` = which alert crashed it, and what its next review gets (after 3 tries it's forwarded as received).
   - `reviewing spaces/…/messages/… with a still of the post | the alert text only: its review crashed the run …` = the lighter review happening; analysts see `🤖 QA: The post's own media wasn't reviewed: …` on that alert.
   - `run skipped: the run that started at … is still going` every minute for up to 25 minutes = a run that died more than 4 minutes in (the script lock can't vouch for it), or one genuinely still going.
5. **Runs too short for a post's video (Gemini.gs `assess` + Bot.gs `reviewHoldWhyNot_`, since Oct 26):** pictures (photos, a frame, Burson's screenshot) always go with a review; only a video or audio clip needs 90 s of the run.
   - `held spaces/…/messages/… for the next run: less than 90 s left in this run (N s), not enough for the post's video (…)` = waiting for the next run (it's reviewed first there); the run JSON has `"held":1` and stops at that alert.
   - `reviewed spaces/…/messages/… N min after it was held for this run` = the held alert got its video review.
   - `less than 90 s left in this run (N s): Gemini doesn't get the post's video (…), only a still of the post` followed by `… wasn't held for the next run: <why>` (the first message this run handled · this pass had N s when it started · it was held once already · it reached the Burson space N minutes ago) = reviewed with a still; analysts see `🤖 QA: The bot was short of time, so Gemini didn't review …`.
   - `🤖 QA: Gemini couldn't review …, so it had only …` on an alert = Gemini refused or failed on the post's media (the `Gemini couldn't review` WARNING says why).
6. **Who got the test emails (Control tab B30, "Testing: send to", since Oct 26):** while Testing, every email goes only to the testers in B30 (up to 5 email addresses, any domain; blank: nothing is sent while Testing). Check **C30** first: it says who gets them, and any address it refused (malformed, one of the bot's real recipients, or past the first 5).
   - `Testing: emails go only to a, b and c. This one was addressed to x, so it was not sent.` = the Gmail lock refused an email to someone not on the list (nothing went out). The list in that message is the run's testers.
   - `escalation protocol for QA-…: emailed to a and b: Chat can't DM them (…)` = testers without a Chat DM with the bot's account got the 🧑‍💻 message by email (the bot can't DM the account it runs as, and only uses DMs that already exist). A tester who wants it in Chat starts a DM with the bot's account once.
   - Testers see the test emails in their own inboxes; Gmail drafts the bot makes (rows 27-28) are only in the bot account's Drafts.

## 3. Auditing a Specific Alert (`QA-XXXX` or Author/URL)
When the user asks why the bot made a specific call on an alert:
1. Search Cloud Logging for the author handle or `QA-` ID:
   ```bash
   CLOUDSDK_METRICS_ENVIRONMENT="${CLOUDSDK_METRICS_ENVIRONMENT:+$CLOUDSDK_METRICS_ENVIRONMENT }datacloud.antigravity" \
   gcloud logging read 'labels."script.googleapis.com/project_key"="MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ" AND jsonPayload.message:"<AUTHOR_OR_QA_ID>"' \
     --project=brand-social-central-data \
     --freshness=7d \
     --limit=50 \
     --format="value(timestamp,severity,labels.\"script.googleapis.com/process_id\",jsonPayload.message)"
   ```
2. Using the `process_id` from step 1, fetch all log lines for that 1-minute execution to see:
   - `post:` (what `Post.gs` fetched from X/YouTube/Bluesky, including video duration or thread context)
   - `feed text:` (what `BigQuery.gs` pulled from Pendulum `sonar_raw` and Brandwatch `slrr`)
   - `knowledge:` (which passages from the `Resources` documents were passed to Gemini)
   - `Gemini web search:` (what search queries and sources Vertex AI Web Grounding used)
   - `knowledge used:` (which documents Gemini relied on)
   - `follow-up check:` (whether the post was linked to an earlier alert)
