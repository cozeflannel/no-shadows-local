# Phase 0 Discovery Report: Brandwatch Deep Dives and Alert Campaigns

Recorded on 2026-10-29 before writing service code.

## 1. Alerts Space App (`SLRR Triage Chat Agent`)

- **Runtime and script ID:** Google Apps Script V8 (`apps-script-chat-bot/`, `scriptId = 19HakS6-o8U1qT99Xpnw2TQbJnZMx5FZz_JzVDd93Yd9gopQ9qXaWnGk3`, Cloud Logging `project_key = MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ`), executing under the authorized Workspace owner account (`Control!B8`).
- **Entry points and polling:** A single 1-minute time-based trigger invokes `poll()` in `apps-script-chat-bot/Main.gs` (`TRIGGER_HANDLER_ = 'poll'`), plus a form-submit trigger `onTnsTestFormSubmit` in `TnsForm.gs`. No additional Apps Script polling trigger is added by this build.
- **Polling sequence in `poll()` (`Main.gs`):**
  1. Reads live configuration and capability switches from `Control` (and Social Alert group recipients from `Brand safety groups`) on spreadsheet `1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI`.
  2. Runs the Mirror/Relay pass (`Relay.gs`: `relayInbound_`, `relayOutbound_`, `relayEmojis_`) between `[S-F] Burson Automated Alerts V3` (`Control!B25`) and the Mirror space (`Control!B9`) or Burson test copy (`Control!B26`).
  3. Polls direct BigQuery listening feeds (`BigQuery.gs:pollBigQuerySources_`) when Row 15 (`Direct BigQuery alerts`) is `ON`.
  4. Runs `runOnce_(ctx)` (`Bot.gs`), listing Chat messages after `cursor - overlap_minutes` (`Chat.gs:chatList_`), sorting ascending by `createTime`, and routing each message through `handleMessage_`, followed by `pollAnalystMessages_`, `analystReactions_`, `maintainDrafts_`, `checkTnsEmails_`, `retryBqWriteBacks_`, `watchSentAlerts_`, and `trackOutcomes_`.
- **Intent router (`Bot.gs` and `Relay.gs`):**
  - Top-level bot/Zapier/ingested alerts go to `handleAlert_` (`Bot.gs:435-445`).
  - When `Relay with S-F Burson` (`Row 22`) is `ON` on the Mirror space, `relayOutbound_` (`Relay.gs:997`) inspects human messages via `relayOutOne_` (`Relay.gs:1063`) before `runOnce_` skips `relayAnalyst_` messages as `'analyst'` (`Bot.gs:430`). Messages matching `RELAY_INTERNAL_RX_` (`internal:`) or threads in `rs.internalThreads` stay internal in the Mirror space (`RELAY_KEPT_`).
  - Human thread questions/replies otherwise route to `handleHuman_` (`Bot.gs:1338`) or `pollAnalystMessages_` (`Bot.gs:1404`).
- **State store:**
  - Apps Script side: Google Sheets (`1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI` tabs `Control`, `Brand safety groups`, `Alert log`, `Message log`, `Relay`, `Burson outbox`, `Results`, `Learned precedents`) plus `PropertiesService.getScriptProperties()` and `CacheService.getScriptCache()`.
  - Cloud side (shared operational store in `brand-social-central-data`): Firestore Native database `slrr-social-alerts` (`location = nam5`, `type = FIRESTORE_NATIVE`). Note that `(default)` in `brand-social-central-data` is `DATASTORE_MODE`, so all Firestore Native calls must target `database="slrr-social-alerts"`. `apps-script-chat-bot/appsscript.json` already carries `"https://www.googleapis.com/auth/cloud-platform"`, allowing `SLRR Triage Chat Agent` to write thread ownership records directly to `slrr-social-alerts` via the Firestore REST API without adding OAuth scopes or triggers.
- **Own-message recognition (`Bot.gs:501` and `Relay.gs:1028`):**
  - Checks `m.clientId` (`clientAssignedMessageId`) prefixes `client-bqa-` (`CLIENT_ID_PREFIX_`) and `client-rel-` (`RELAY_OUT_PREFIX_`), `botPosted_(m.name)`, `isBotFormattedText_(m.text)`, and `ctx.store.isOwnPost(m.name)`, backed by `selfAnswerOk_` (`Bot.gs:528`).
  - `slrr-campaigns` assigns `client-scmp-<hash>` to every Chat message it creates, records every created `spaces/.../messages/...` resource name in Firestore `created_messages`, and adds `client-scmp-` recognition to `isOwnMessage_` in `Bot.gs` (`relayAnalyst_` already ignores any message with `m.clientId` set).
- **Gemini client and model:**
  - Apps Script bot (`Gemini.gs`): Vertex AI (`aiplatform.googleapis.com`) using `gemini-2.5-flash` / `gemini-2.5-pro`.
  - Python repo (`triage_agent/llm.py`): `VertexGemini` wrapping `google-genai` (`genai.Client(vertexai=True, project="brand-social-central-data", location="global")`) with Pydantic `response_schema`, `response_mime_type="application/json"`, temperature control, and exponential backoff on HTTP `429/500/502/503/504`. Verified live in `brand-social-central-data` that `gemini-3.8-flash` on `location="global"` succeeds with structured JSON schema output.

## 2. Brandwatch Email-to-Chat App (`v1 Chrome Alerts`)

- **Apps Script project:** `v1 Chrome Alerts` (`scriptId = 1IxFUi7i5q4eVBBCFJmAwjqmttku4pHMZt9BpCWw8wPEnaNDWGDuSQFPP`), running under the authorized Workspace owner account via `processSocialAlerts()`. (Its predecessor `1lAKLv-jSZzsXZF-yjuu8jYySQFhTOYTnprUV391E9gaIq1nsgSDrXD8Q` is fully commented out and inactive; `1rO_DDhhrV9JklpEOkNwVNvjMKcw3RIZirY6ECHMDmxSywA5KmTihsqxb` is `Mad Max` / `SLRR Chat Builder`, referencing Brandwatch project ID `1998368542`.)
- **Current Gmail search query (`Code.gs:5`):**
  - `'subject:("Chrome Alerts") is:unread'`
  - Updated in the same commit as `slrr-campaigns` to `'subject:("Chrome Alerts") -"SLRR-CMP-" is:unread'`, while `slrr-campaigns` queries `'"SLRR-CMP-" -label:slrr-cmp-processed'`. Two 100%-commented-out legacy files (`Code_.gs` and `Code__.gs`) in `v1 Chrome Alerts` are removed in the same change.
- **HTML email parser (`Code.gs:521-642`):**
  - Supports Brandwatch's `featured-content` HTML layout (`table.featured-content` up to `table.alerts-settings`, extracting `a.open-link` URL, `h5.author` handle and X follower count, `td.extract` text snippet, and platform detection from URL) as well as legacy `table.mentions` (`span.mention`).
  - Deduplicates per-email and cross-email mentions via `normalizeUrl` (`triage_agent/qa/record_key.py:normalize_url` covers a strict superset of platform canonicalizations).
- **Fields posted (`Code.gs:480-504` and sheet logger):**
  - Posts Network/Platform header, `Author`, `Followers` (for X), `KOF Status` (from sheet `17HIdayu6q9NDFRR-BC0VZWiAXfGHX1rjO5IKC0YreEQ`), `Product` / scope, `Engagement`, `Sentiment`, `AI Summary` (one-line Gemini summary in `slrr-campaigns`), `Text` snippet, and `<url|Click to view post>`. `slrr-campaigns` omits all emojis and prepends the plain-text focused campaign header `[FOCUSED DEEP DIVE: <Campaign Name> | <Campaign ID>]`.
- **Engagement calculation (`Code.gs:234-282` and `Newsletter.gs:125-128`, plus `BigQuery.gs:bqRealEngagement_`):**
  - Brandwatch alert emails encode engagement tiers `[VERY LOW]`, `[LOW]`, `[MODERATE]`, `[HIGH]` (`VERY LOW = 0-199`, `LOW = 200-499`, `MODERATE = 500-1999`, `HIGH = 2000+`).
  - `slrr-campaigns` computes numeric engagement for threshold gating by checking: (1) BigQuery exact/normalized URL match (`engagementScore` or `likes + comments + shares`), (2) Brandwatch mention metadata (`engagementScore` / interaction totals when present), and (3) Brandwatch email tier floor (`HIGH -> 2000`, `MODERATE -> 500`, `LOW -> 200`, `VERY LOW -> 0`), plus any explicit integer engagement count printed in the email block.

## 3. Chat Project and OAuth Alignment

- **Chat GCP project:** `brand-social-central-data` (Project Number `1028310913761`), confirmed via `SLRR Triage Chat Agent` project settings and live Chat API calls.
- **OAuth client requirement:** Must live in `brand-social-central-data` (`1028310913761`) so user-authenticated Chat API calls route through the configured Chat app and never return HTTP 404 `"Google Chat app not found"`.
- **User OAuth scopes requested (`scripts/authorize_user.py`):** Only the minimum scopes consumed by `slrr-campaigns`:
  - `https://www.googleapis.com/auth/chat.spaces`
  - `https://www.googleapis.com/auth/chat.delete` (required by `spaces.delete` for temporary preflight and `pytest -m live` space cleanup)
  - `https://www.googleapis.com/auth/chat.memberships`
  - `https://www.googleapis.com/auth/chat.messages`
  - `https://www.googleapis.com/auth/gmail.modify`
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/drive`
  - `https://www.googleapis.com/auth/documents`
  - `https://www.googleapis.com/auth/directory.readonly`

## 4. Spaces

- **Configured alerts space (Mirror space, `Control!B3` and `Control!B9`):** `spaces/AAQAnWE2vpo` (`agentic testing`). Receives live alerts one way from `[S-F] Burson Automated Alerts V3`.
- **Live Burson alerts space (`Control!B25`, strictly forbidden):** `spaces/AAQAaa_0I9g` (`[S-F] Burson Automated Alerts V3`). Hard-blocked in `slrr-campaigns` space allowlist so no code path can ever post to or modify it.
- **Burson test router (`Control!B26`):** `spaces/AAQAe2vkzWE` (`SLRR Test Router`). Kept isolated from campaign threads via `Relay.gs` internal-thread gating.

## 5. Brandwatch Discovery and API Contradictions

- **Ingest mailbox:** The authorized OAuth user's Gmail mailbox.
- **Known Brandwatch project ID in existing SLRR automation (`Mad Max`):** `1998368542`.
- **Live Brandwatch API verification (`brand-social-central-data` dedicated secrets `slrr-campaigns-bw-*`):**
  - Authenticated user (`GET /me`): `id = 2049838843`, `uiRole = "admin"`.
  - Client (`GET /client`): `id = 1997402114`, `name = "Google - Social Lab"`, `pricingModel = null`, tags `{"is_forsight": "true", "ratelimit.limit": "600", "ratelimit.period": "10", "shardName": "13"}`.
  - Rate-limit headers: `x-rate-limit: 600/10m` (**600 calls per rolling 10-minute window** across the client; `slrr-campaigns` enforces a hard 50% ceiling of **300 calls per 10 minutes**).
  - Accessible projects (`GET /projects` paginated across `page=0,1`): **167 total projects** (`resultsTotal = 167`).
  - Custom Alert concentration across projects:
    - `1998344909` (`[SLRR] Private`, returned on `page=1` of `GET /projects`): **2,129 Custom Alerts** (including `[Alert] Emerging AI`, `[Alert] Emerging Social Networks`, `[ALERT] Google I/O 2025`).
    - `1998368542` (`[Brand Social] Google AI`): **793 Custom Alerts**.
    - `1998376270` (`[Brand Social] Google Search`): **41 Custom Alerts**.
    - `1998378240` (`[Brand Social] Android`): **20 Custom Alerts**.
    - `1998377738` (`[Brand Social] Google Chrome`): **1 Custom Alert** (`Google Chrome Alert`).
    - `config/campaigns.yaml` orders `brandwatch_project_ids` with `1998344909` first so alert lookup hits `[SLRR] Private` on the first API call, while `accessible_project_map()` paginates all 167 projects and `store.py` chunks `brandwatch_cache` documents across 120-item pages well below Firestore's 1 MiB document limit.
- **Vendor doc details and prompt-vs-doc notes verified against `developers.brandwatch.com/*.md` on 2026-10-29:**
  1. **`enabled` field on Custom Alerts (`retrieving-custom-alerts.md` vs `updating-custom-alerts.md`):** `retrieving-custom-alerts.md` documents `enabled` as returning active alerts when `true`, whereas `updating-custom-alerts.md` states `"Pause the Custom Alert when set to true"`. Existing SLRR production code (`Mad Max`) sends `enabled: false` to pause and `enabled: true` to resume. The live Brandwatch alert lifecycle test (`tests/live/test_live_campaigns.py`) verifies and settles the active vs paused polarity by listing with `enabled=true&pageSize=50&page=0` and `slrr-campaigns` uses the verified polarity.
  2. **Deprecated Custom Alert fields (`creating-custom-alerts.md`, `updating-custom-alerts.md`):** `queryId`, `queryName`, `additionalRecipients`, and `emailCreator` are deprecated (scheduled removal on or after 2026-11-16). `slrr-campaigns` defines one strict Pydantic request payload (`CustomAlertPayload`) containing only `name`, `queryIds`, `frequency`, `alertTypes`, `mentionsPerAlert`, `recipients`, `filter`, and `enabled` (on `PUT`).
  3. **Query `contentSources` vs Alert `filter.pageType`:** Query creation (`POST /projects/{id}/queries`) uses `contentSources`, `languages`, `locationFilter`, `startDate`, `lockedQuery: true`, and `exclusionSnippets` (numeric IDs mapped from `GET /exclusionsnippets?language=en`). Alert filters use `pageType` (content source IDs from `GET /metrics`), `threadEntryType` (`post`, `reply`, `share`), and `sentiment` (`positive`, `neutral`, `negative`).
  4. **Timestamps (`total-mentions.md`):** `GET /projects/{id}/data/mentions/count` requires ISO timestamps with `+` in timezone offsets URL-encoded as `%2B` (or UTC `Z` / `+00:00` properly percent-encoded).
  5. **Google Chat `spaces.setup` and `spaces.patch` (`spaces/setup` & `spaces/patch` reference):** `spaces.setup` rejects `spaceHistoryState` with `HTTP 400 INVALID_ARGUMENT` (`"Don't set space history state. After creating the space, set space history state by calling update space API."`), and `spaces.patch` forbids combining `displayName`, `spaceHistoryState`, `accessSettings`, or `permissionSettings` in a single `updateMask`. `slrr-campaigns` omits `spaceHistoryState` in `spaces.setup`, then reads `spaces.get` and patches `spaceHistoryState` alone (`updateMask="spaceHistoryState"`) when not already `HISTORY_ON`, and patches `displayName` alone (`updateMask="displayName"`).
  6. **Organization Switching accounts on `POST /oauth/token` (`authenticate.md`):** Multi-client Brandwatch UI accounts return `HTTP 500` on `/oauth/token` unless `platform_client_id` is passed; `slrr_campaigns/auth.py` supports `email|platform_client_id` syntax and uses the dedicated single-client `Google - Social Lab` API admin user (`2049838843`).

## 6. BigQuery Mention Tables

Checked live in `brand-social-central-data.social_alerts_dataset` (location `US`):

1. **`brand-social-central-data.social_alerts_dataset.brandwatch_mentions`:**
   - **Freshness:** Stale/archived (`61,060` rows total, `0` rows in the last 7 days; `MAX(ingested_at) = 2026-03-21T07:03:20Z`).
   - **Columns:** `mention_id`, `resource_id`, `url`, `title`, `snippet`, `full_text`, `domain`, `page_type`, `published_at`, `ingested_at`, `language`, `country_code`, `author`, `author_Clean`, `sentiment`, `emotion`, `reach`, `impressions`, `impact`, `engagement_total`, `raw` (JSON). Has no numeric `queryId` column.
2. **`brand-social-central-data.social_alerts_dataset.all_sundar_mentions`:**
   - **Freshness:** Live and fresh (~9 minutes lag; `8,042,400` rows total, `173,412` rows in the last 7 days, partitioned by `DAY(ingestionTimestamp)`, clustered by `(alert_source, url)`).
   - **Column mapping:**
     - Alert/stream identifier: `alert_source` (`STRING` alert name; no numeric Brandwatch `queryId` column — mapped via alert name and normalized URL).
     - URL: `url` (`STRING`).
     - Text: `snippet` (`STRING`, populated across X and Online News rows where Brandwatch API strips text).
     - Author: `authorHandle` (`STRING`), plus `followers` (`STRING`) and `KOF` (`STRING`).
     - Date: `postTime` (`TIMESTAMP`) and `ingestionTimestamp` (`TIMESTAMP`).
     - Engagement: `engagementScore` (`FLOAT` / numeric) and `engagement` (`STRING` tier).
     - Sentiment: `Sentiment` (`STRING`: `Positive`, `Neutral`, `Negative`).
     - Network/Product: `SocialNetwork` (`STRING`), `product` (`STRING`).
   - **Deep-dive usage:** `slrr-campaigns` queries `all_sundar_mentions` first by `alert_source` (matching the Brandwatch alert name) within `[startDate, endDate]` when rows land there, and also queries `all_sundar_mentions` by normalized URLs to hydrate full snippets and engagement scores for Brandwatch API mentions whose text was stripped (X, LinkedIn, Online News 256-char truncation).

## 7. GCP Region, Services, and IAM Permissions

- **Existing Cloud Run region in `brand-social-central-data`:** `us-central1` (all 9 existing Cloud Run services run in `us-central1`). `slrr-campaigns` deploys to `us-central1`.
- **Enabled APIs in `brand-social-central-data`:** `run`, `cloudscheduler`, `secretmanager`, `firestore`, `aiplatform`, `bigquery`, `chat`, `gmail`, `sheets`, `drive`, `docs`, `people`, `cloudbuild`, and `artifactregistry` are all enabled.
- **IAM permissions verified via `projects.testIamPermissions` for the project admin account:**
  - Held roles: `roles/run.admin`, `roles/resourcemanager.projectIamAdmin`, `roles/aiplatform.user`, `roles/bigquery.dataViewer`, `roles/bigquery.jobUser`, `roles/bigquery.connectionAdmin`, `roles/editor`, `roles/iap.admin`.
  - `run.services.{create,update,get,setIamPolicy}`: Granted.
  - `cloudscheduler.jobs.{create,update,get}`: Granted.
  - `secretmanager.secrets.{create,get}`, `secretmanager.versions.add`: Granted (`roles/resourcemanager.projectIamAdmin` allows `./setup.sh` to bind `roles/secretmanager.secretAccessor` on the dedicated `slrr-campaigns-*` secrets to the runtime service account and setup user).
  - `datastore.entities.{create,get,update}`, `datastore.databases.get`: Granted (`slrr-social-alerts` Native DB already exists).
  - `aiplatform.endpoints.predict`: Granted.
  - `bigquery.jobs.create`, `bigquery.tables.getData`: Granted.
  - `iam.serviceAccounts.{create,actAs,get}`, `resourcemanager.projects.{getIamPolicy,setIamPolicy}`, `cloudbuild.builds.create`, `artifactregistry.repositories.uploadArtifacts`: Granted.

## 8. Thread Ownership Choice and Change Map

### Thread Ownership Option Chosen: **Option A**
- **Reason:** The live alerts space app (`SLRR Triage Chat Agent`, `19HakS6-o8U1qT99Xpnw2TQbJnZMx5FZz_JzVDd93Yd9gopQ9qXaWnGk3`) is a Google Apps Script V8 project (`apps-script-chat-bot/`), not a Python or Cloud Run service, and Apps Script has a shared 6-hour/day trigger quota across all scripts on the owner account. Under Option A:
  1. `apps-script-chat-bot/CampaignHandoff.gs` detects deep-dive or campaign requests in alert threads in `spaces/AAQAnWE2vpo`, writes an ownership document (`space`, `thread`, `requester`, `source_message`, `source_text`, `alert_text`, `created_at`) to Firestore `slrr-social-alerts` (`thread_ownership` collection), caches the owned thread ID, replies once in plain text (`Campaign assistant now owns this thread and will reply shortly.`), and marks the message handled.
  2. `Relay.gs` (`relayOutOne_`) treats campaign/deep-dive requests and owned threads as internal (`RELAY_KEPT_`) so nothing in an owned thread is ever forwarded to `SLRR Test Router` (`B26`) or `Burson outbox`.
  3. `Bot.gs` (`handleMessage_`, `pollAnalystMessages_`, `isOwnMessage_`) skips owned threads and recognizes `client-scmp-` messages as own posts.
  4. `slrr-campaigns` reads and posts **only** in threads recorded in `thread_ownership` inside `spaces/AAQAnWE2vpo` and in campaign spaces it created.

### Change Map
- **Files added:**
  - `docs/discovery.md` — Phase 0 discovery findings and architecture decisions.
  - `config/campaigns.yaml` — Resource IDs only (GCP project, region, Firestore DB, spaces, BigQuery tables, Drive folder ID, Registry spreadsheet ID, KOF spreadsheet ID, Brandwatch project IDs, Secret Manager secret names).
  - `pyproject.toml` — Python 3.12 package metadata, exact dependencies, and strict `ruff`, `mypy`, `vulture`, `deptry`, and `pytest` settings.
  - `Dockerfile.campaigns` — Python 3.12 Cloud Run container image for `slrr-campaigns`.
  - `slrr_campaigns/__init__.py` — Package marker.
  - `slrr_campaigns/config.py` — Typed loader for `config/campaigns.yaml` and runtime environment variables.
  - `slrr_campaigns/models.py` — Typed Pydantic domain, conversation schema, Firestore state, and strict Brandwatch payload models, plus framework-reflection companion `slrr_campaigns/_vulture_whitelist.py`.
  - `slrr_campaigns/logging_utils.py` — Emoji-free structured JSON logging and visible failure reporting helpers.
  - `slrr_campaigns/auth.py` — Secret Manager secret loader, scoped Google User OAuth credential builder, and Brandwatch token manager with automatic `401` re-authentication.
  - `slrr_campaigns/store.py` — Firestore Native (`slrr-social-alerts`) state store, distributed per-thread and per-campaign leases, created-message registry, cursors, registry snapshots, and client-wide Brandwatch rate-limit ledger.
  - `slrr_campaigns/brandwatch.py` — Queued, rate-limited Brandwatch Consumer Research API client (enforcing `<= 50%` of `x-rate-limit`, `429` window wait, 24h caching of queries/filters/metrics/exclusion snippets).
  - `slrr_campaigns/workspace.py` — User-OAuth clients for Google Chat (enforcing space/thread allowlist and `client-scmp-` own-message tracking), Gmail, Sheets, Drive, Docs, and People API directory resolution.
  - `slrr_campaigns/bigquery_mentions.py` — BigQuery reader for `all_sundar_mentions` and `brandwatch_mentions` (deep-dive primary source and stripped-text/engagement hydration).
  - `slrr_campaigns/email_parser.py` — Python port/extension of `v1 Chrome Alerts` Brandwatch HTML alert email parser, engagement tier/score resolver, KOF lookup, and URL deduplication (reusing `triage_agent.qa.record_key.normalize_url`).
  - `slrr_campaigns/gemini_flows.py` — Structured `gemini-3.8-flash` (`location="global"`) schemas and calls (reusing `triage_agent.llm.VertexGemini`) for conversation step parsing, semantic query ranking, boolean drafting + validation loop, mention summaries, and deep-dive synthesis.
  - `slrr_campaigns/deep_dive.py` — End-to-end Brandwatch + BigQuery deep-dive engine (strictly `<= 8` Brandwatch calls), Google Doc report writer, thread summary poster, and prefilled campaign offer.
  - `slrr_campaigns/conversation.py` — Shared plain-text conversation state machine (numbered options, up to 2 clarifications, `cancel`, confirmation jump-edit, 24h expiry, `America/New_York` display / UTC storage, query selection, Query Builder, approver `approve` gate, and campaign settings).
  - `slrr_campaigns/provisioning.py` — Idempotent campaign provisioning saga with Brandwatch rollback on unrecoverable failure, plus campaign shutdown and volume guard execution.
  - `slrr_campaigns/registry.py` — Registry spreadsheet initializer (`Campaigns`, `Settings`, `Orphans`, protected ranges, data validations), snapshot diff/apply engine, row healer, and Chat command dispatcher.
  - `slrr_campaigns/ingest.py` — `/tick` campaign Gmail ingestion, URL deduplication, sheet logging, batched Gemini summaries, per-tick capped Chat posting (plus alerts-space owned-thread secondary-layer echo and overflow summary), and Chat `429` backoff.
  - `slrr_campaigns/service.py` — FastAPI application exposing `POST /tick`, `POST /hourly`, and `POST /daily`, plus `serve`, `bootstrap`, and `preflight` CLI commands invoked by `Dockerfile.campaigns` and `./setup.sh`.
  - `scripts/authorize_user.py` — One-time browser OAuth consent flow storing OAuth client and refresh token in Secret Manager.
  - `scripts/check_config.py` — Bidirectional static verifier ensuring 1-to-1 parity between `setup.sh`, `config/campaigns.yaml`, environment variables, Secret Manager names, and Python code.
  - `check.sh` — Quality gate script running `ruff check`, `ruff format --check`, `mypy --strict`, `vulture`, `deptry`, banned-pattern/emoji scan, `scripts/check_config.py`, `shellcheck`, and `eslint` + Apps Script unit tests.
  - `setup.sh` — Idempotent end-to-end setup, IAM, secret provisioning, Drive/Registry bootstrap, `./check.sh`, Cloud Build + Cloud Run deploy, Cloud Scheduler OIDC jobs, and live preflight table.
  - `apps-script-chat-bot/CampaignHandoff.gs` — Option A thread-ownership detector and Firestore `slrr-social-alerts` handoff writer.
  - `apps-script-chrome-alerts/Code.gs`, `apps-script-chrome-alerts/Newsletter.gs`, `apps-script-chrome-alerts/appsscript.json`, `apps-script-chrome-alerts/.claspignore` — Tracked `v1 Chrome Alerts` source with `"SLRR-CMP-"` Gmail exclusion.
  - `tests/live/__init__.py`, `tests/live/conftest.py`, and `tests/live/test_live_campaigns.py` — `pytest -m live` suite exercising Brandwatch, Chat, Gmail partition, Sheets/Drive/Docs, Gemini, and People APIs with verified resource cleanup.
- **Files modified:**
  - `apps-script-chat-bot/Bot.gs` — Skip owned threads in `handleMessage_` and `pollAnalystMessages_`; hand off new deep-dive/campaign requests; treat `client-scmp-` as own messages in `isOwnMessage_`.
  - `apps-script-chat-bot/Relay.gs` — Keep campaign/deep-dive requests and owned threads internal in `relayOutOne_` so nothing leaks to `B26` or `Burson outbox`.
  - `apps-script-chat-bot/BigQuery.gs` — Restore `BQ_BSIP_MAX_AGE_H_ = 48` so BSIP alerts delayed in `bsip-s-bsip-gg-26-2cf3.google_bg` beyond 1 hour are ingested on every poll.
  - `README.md` — Document `slrr-campaigns` setup, registry tabs/columns, chat commands, secondary focused alerting, and teardown.
- **Files / dead code deleted:**
  - `Code_.gs` (639 lines, 100% commented-out legacy copy of `Code.gs`) and `Code__.gs` (690 lines, 100% commented-out legacy copy of `Code.gs`) in live Apps Script project `v1 Chrome Alerts` (`1IxFUi7i5q4eVBBCFJmAwjqmttku4pHMZt9BpCWw8wPEnaNDWGDuSQFPP`) upon `clasp push -f`.
  - Unused functions `testGeminiSetup` (in `apps-script-chrome-alerts/Code.gs`) and `setupWeekdayTriggers` (in `apps-script-chrome-alerts/Newsletter.gs`).
