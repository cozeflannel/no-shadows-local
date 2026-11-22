# Agent Console

Web console for the SLRR Alert Automation Agent (docs/CONTRACTS.md §17): KPIs, activity, cases,
the IM review queue, suppressions, Path B parity, escalations, rosters, settings, learning
(proposals / facts) and the outbox. It also hosts the Gmail connection for Incident Managers and
for the Triage Agent account (email doorbell).

- **Backend:** FastAPI (`console/backend/`). It imports `triage_agent` directly and shares one
  `AgentContext` (`build_context()` from the environment) across requests.
- **Frontend:** React 19 + Vite + TypeScript + Tailwind + Recharts (`console/frontend/`). The built
  app is served by the backend at `/`; every API route is under `/api`.

## Quick start (local, demo data)

```bash
# 1. Seed ~2 weeks of synthetic data into .local/demo.db (deterministic; --reset recreates the file)
.venv/bin/python -m tests._console_fixtures.seed_demo --reset
#    options: --db PATH (default $TRIAGE_LOCAL_DB or .local/demo.db), --now 2026-10-13T10:05:00+00:00,
#             --days 14, --seed 20261013. Refuses to run with TRIAGE_BACKEND=gcp.

# 2. API on :8000
TRIAGE_BACKEND=local TRIAGE_LOCAL_DB=.local/demo.db TRIAGE_LLM=fake \
  .venv/bin/python -m uvicorn console.backend.app:app --reload --port 8000

# 3a. Frontend dev server on :5173 (hot reload; proxies /api to :8000, override with VITE_API_TARGET)
cd console/frontend && npm ci && npm run dev

# 3b. ...or build once and use the backend alone: http://localhost:8000
cd console/frontend && npm ci && npm run build      # tsc --noEmit + vite build -> dist/
```

**Signing in locally:** without an IAP header the backend uses `TRIAGE_DEV_USER`
(default `dev@local.invalid`). To try roles locally, restart the API
with e.g. `TRIAGE_DEV_USER=ana.ruiz@roster.test` (a demo IM: analyst), `viewer@corp.test`
(viewer) or `triage-agent@runner.test` (the agent account: Gmail connect only).

The demo `now` defaults to the current time. Data is generated relative to it: 3 alerts waiting
for review, a failed alert awaiting a rerun, an unacknowledged URGENT alert with an SLA warning,
T&S outcomes, email drafts in every state, parity matches and mismatches, roster overrides, config
history, pending proposals and facts, stale outbox items. Every KPI in `metrics.KPI_DEFINITIONS`
is non-zero. The seeder writes through the Store and EventLogger only (it doesn't run the pipeline).

## Pages

Dark theme by default, light theme from the header. Every page has a Help link that opens its own topic.

| Page | What it does |
|---|---|
| Welcome (`/welcome`) | Landing and sign-in. Shown by itself when the session has no identity or no role. |
| Dashboard (`/`) | Counts that need a person now (review queue, to acknowledge, SLA at risk, deliveries, who is on shift), KPI cards and the activity chart for Hour, Today, 24 h, 7 days, 30 days or a custom range, the live event stream with an action on each alert, and the setup steps still open. |
| Review feed (`/feed`) | Every alert as a card: what it needs, verdict, confidence, class. The detail shows the alert, per-field confidence, corrections (revert), cited knowledge, the review decision, every legend action, "Was the agent right?" and the Chat thread. "Triage an alert" puts pasted text through triage. |
| Stories (`/stories`) | Alerts on the same story as one circle, sized by engagement or alerts, with the smaller stories inside it. Play growth or drag the time slider; List has every story. A story opens its running total, smaller stories, alerts (why each is there, the post, the alert in the Review feed) and linked Chat messages. |
| Chat spaces (`/chat`) | Each space's messages in and out, held and queued posts, and the conversations by thread or case. |
| Chat agent (`/agent`) | Ask the agent or have it act with the same tools as Chat. Actions wait for a confirmation. Sessions are kept per person. |
| Temp check (`/temp-check`) | Run one from a Boolean (converted as typed), a saved Brandwatch query or a drafted query. Result: count, concern level, velocity, sentiment, write-up, posts, history, the Google Doc when a folder is set. |
| Workforce (`/workforce`) | Now (staff, load, utilization, today against the forecast, gap alerts), Schedule (coverage grid, link to Rosters), History (by day, heatmap, short hours), Forecast (run, recommendations to Accept, Edit or Dismiss, runs), Reports (coverage, utilization, MAPE, gaps, CSV). |
| Knowledge (`/knowledge`) | Documents (text, web page, Drive file), class mapping, a search that shows what the agent would read, the golden set with its export. |
| Campaigns & watches (`/campaigns`) | Campaigns with change requests and End now; watches (create, edit, run), found posts with ratings, the scorecard. |
| Compare (`/compare`) | Burson, the app and the IMs for a period next to the period before: Burson's alerts as the app found them, the app's own detection against Burson's, IM agreement with the app, and speed. |
| Integrations (`/connections`) | A tile per tool with its state. Find and fill writes what the running service can see (project, region, its own address, the one Agent Runtime, the dataset holding the agent's tables). A tile opens its values (chosen from what the project has where it can list them), Create for BigQuery tables and Pub/Sub topics, and a live check that names the grant to run when access is denied. |
| Sign in as the QA chatbot (Integrations, Google Chat) | The QA chatbot's own account signs in to Google Chat once. The Console then reads Chat as that account: the check shows each space's latest message, whether people outside Google can join, and which spaces the account still has to be added to. |
| Admin (`/admin`) | People (add once: role and IM roster place from one record; remove), System (integrations, scheduled work, the agent, delivery, safety, BigQuery, switches), Changes (settings, integrations and people in the last 7 days, who was active). Leads read; admins change. |
| Alert pop-ups (every page) | A pop-up when an alert comes in, from the shared live stream. Switch `alert_popups`, rules in Settings, Notifications. Each person turns them, a sound and browser notifications on or off from the bell. |
| Settings (`/settings`, `/settings/:key`) | Opens on the four things to fill in (Integrations, People, Switches, Safety). Advanced holds the rest: platform parts as forms built from their schema (switches, access, project, safety, delivery, BigQuery, forecasting, chat agent, classification, knowledge retrieval, temp check, campaigns & watches, costs, telemetry), the agent's sections (spaces, analysts, shifts, distribution, actions, taxonomy and the rest), and tools: secrets, AI instructions, audit log, change history. BigQuery, Delivery, Safety, Costs and Project carry their own panel under the form. |
| Help (`/help/:topic`) | Searchable help by page. |
| Cases, Emails & T&S, Rosters | As before: case list and drawer, drafts and T&S forms, IM and Burson rosters. |
| More: Suppressed, In-house parity, Outbox, Event log, Breakdowns | As before. Breakdowns is the former Overview page. |

## API

All routes are under `/api`; OpenAPI docs at `/api/docs`. Errors are JSON
`{"error": "...", "code": "...", ...}` (`validation_error` responses include `errors: [{loc, msg, type}]`).

| Route | Role |
|---|---|
| `GET /health` | public |
| `GET /me`, `GET /gmail/status`, `GET /gmail/callback`, `DELETE /gmail` | any signed-in user |
| `GET /meta`, `/kpis`, `/timeseries`, `/errors`, `/failures-by-oncall`, `/activity`, `/cases`, `/cases/{id}`, `/suppressed`, `/review-queue`, `/parity`, `/escalations`, `/outbox`, `/rosters/{name}`, `/rosters/{name}/schedule`, `/oncall/now`, `/settings`, `/settings/history`, `/settings/{section}`, `/proposals`, `/facts` | viewer |
| `POST /review-queue/{case_id}`, `POST /cases/{id}/revert`, `POST /cases/{id}/close`, `POST /rosters/{name}/overrides`, `DELETE /rosters/{name}/overrides/{id}` | analyst |
| `GET /gmail/connect` | analyst, or the agent account (`config.agent.email`) |
| `POST /facts/{id}` | lead |
| `PUT /rosters/{name}`, `PUT/DELETE /settings/{section}`, `POST /proposals/{id}` | admin |

**Roles:** `config.analysts` gives admin / lead / analyst; people in the `slrr_im` roster are analysts;
other `@google.com` users are viewers (read-only); anyone else gets 403 (except `/me` and the Gmail
status). Identity: IAP's `X-Goog-Authenticated-User-Email`, or the signed `X-Goog-IAP-JWT-Assertion`
when `TRIAGE_IAP_AUDIENCE` is set (use this in production). The `TRIAGE_DEV_USER` fallback is off with
`TRIAGE_BACKEND=gcp` unless the variable is set explicitly.

**Actions that post to chat** (review decisions, reverts, closing, proposal / fact decisions) call
`triage_agent.operations.handle()` with context `{deliver: "outbox", invoked_by: <user>, flow: "console"}`,
so the chat messages go to the outbox for the Studio Outbox flow. An unregistered operation returns
501 `op_not_implemented`; a `UserFacingError` returns 400 `op_rejected`; a retryable failure 503.

**Settings:** `PUT /settings/{section}` takes `{value, note?, base_version?}` with the whole section.
The backend stores the minimal JSON merge patch against the YAML defaults (a section equal to the
defaults has no override), validates the merged config with `AgentConfig`, rejects unknown keys,
returns 409 if `base_version` is stale, saves with `store.save_config_overrides`, reloads the shared
config and emits `config.updated {section, via: "console", note, reset}`. `DELETE` resets a section.
`version` and `env` aren't editable.

**Rosters:** overrides take naive times in the display timezone (`config.timezone`), are limited
to 31 days and must end in the future. `PUT` replaces people / rotation / backup / fallback / reminders
(overrides are kept) and refuses to remove a person who has an active or upcoming override.

## Gmail connection

| Who | Scopes | Used for |
|---|---|---|
| Incident Managers / analysts | `gmail.compose` + the read scope (`IM_SCOPES`): `gmail.metadata` by default, `gmail.readonly` with `TRIAGE_GMAIL_READ_SCOPE=readonly` | Social Alert drafts in their own mailbox, sent detection |
| The Triage Agent account (`config.agent.email`) | `gmail.send` (`AGENT_SCOPES`) + `openid`, `userinfo.email` | the email doorbell; the identity scopes let the callback check which account was authorized (`gmail.send` can't read the profile) |

The read scope is chosen by `TRIAGE_GMAIL_READ_SCOPE` (`metadata`, the default, or `readonly`), read
by `triage_agent.escalation.gmail` at import; the Phase 0 spike decides which one sent detection
needs. The Console requests whatever `IM_SCOPES` contains and shows those permissions in plain words.
IMs who connected with one read scope must connect again after it changes.

`GET /gmail/connect` starts the OAuth web flow (offline access, PKCE). The state, code verifier,
scopes and redirect URI are kept in the store for 15 minutes. `GET /gmail/callback`:

1. Checks the granted scopes. Google lets people untick individual permissions. If any requested
   Gmail scope is missing (from `credentials.granted_scopes`, else the token response's `scope`;
   `openid` / `email` / `userinfo.email` don't count), the token is **not** stored. The callback
   redirects to `/?gmail=error&reason=missing_scopes&missing=metadata&mailbox=im` and the UI asks the
   user to allow all requested Gmail permissions (drafts + send status) and connect again, listing
   the missing ones in plain words.
2. Checks that the authorized mailbox is the signed-in user.
3. Stores the token in the TokenVault (`triage_agent.escalation.gmail.get_token_vault()`:
   `.local/gmail_tokens.json` locally, Secret Manager with `TRIAGE_TOKEN_VAULT=secretmanager`).
4. Redirects to `/?gmail=connected` (or `connected_agent`, or `error&reason=...`).

Tokens never go into Firestore. `GET /gmail/status` returns `mailbox: "agent" | "im"` and the
requested `scopes` (short names), so the UI shows *Connect agent mailbox (doorbell)* for the agent
account, which has no other Console access. It also returns `needs_reconnect` / `missing_scopes`
when the stored token predates a scope change (e.g. the read scope switched to `readonly`); the
header then shows *Reconnect Gmail*.

### Platform routes

| Route | Purpose |
|---|---|
| `GET /dashboard?range=hour\|today\|24h\|7d\|30d\|custom&from&to` | KPIs, previous period, series, counts that need a person |
| `GET /live/feed`, `GET /live/stream` | Recent events; server-sent events (`events`, `now`, `problem`) |
| `GET /feed`, `GET /feed/{case}`, `POST /feed/{case}/action`, `POST /feed/{case}/assessment`, `POST /intake` | Review feed, legend action, IM assessment, triage pasted text |
| `GET /chat/activity`, `GET /chat/spaces` | Chat tracking |
| `/agent/sessions…` | Chat agent sessions, messages, confirm |
| `/temp-checks…` | List, run, convert a Boolean, saved queries, record what was done with one |
| `/workforce/…` | actuals, historicals, intraday, coverage, forecast (+run), recommendations (+decide), report (+CSV) |
| `/knowledge…`, `/golden…` | Documents, refresh, search; golden set and export |
| `/campaigns…`, `/watches…` | Campaign change requests; watches, run, rate |
| `GET/PUT /platform/{part}` | One part of the platform settings with its JSON schema |
| `/secrets…`, `/bigquery/…`, `/delivery…`, `/prompts…` | Secret versions (write-only), datasets/tables/views, topics and dead letters, AI instructions |
| `GET /safety`, `GET /audit`, `GET /audit.csv`, `GET /costs`, `GET /setup`, `GET /help`, `GET /agent-runtime` | Runtime checks, audit log, costs, setup steps, help, the deployed agent's health |

Every call that changes something is written to the audit log with the signed-in person.

The worker (`console.backend.worker:app`) is a separate service: `POST /pubsub/outbound`, `POST /pubsub/dead-letter`,
`POST /jobs/{followups|inhouse|knowledge|forecast|watches|temp-checks|maintenance}`. It accepts only a Google identity
token of the service account in `TRIAGE_SCHEDULER_SA` or in Settings, Delivery.

## Configuration (environment)

| Variable | Purpose |
|---|---|
| `TRIAGE_BACKEND` | `local` (SQLite) or `gcp` (Firestore + BigQuery) |
| `TRIAGE_LOCAL_DB` | SQLite file for `local` (the seeder's default target too) |
| `TRIAGE_LLM` | `fake` for offline runs; the Console only calls Gemini through operations (created lazily) |
| `TRIAGE_ENV` | `dev` / `prod`; metrics default to events of this env (`env=all` disables the filter) |
| `TRIAGE_DEV_USER` | Local identity when there's no IAP header |
| `TRIAGE_IAP_AUDIENCE` | Verify the IAP JWT (`/projects/<number>/locations/<region>/services/<service>` for Cloud Run IAP) |
| `TRIAGE_GMAIL` | `fake` (default, every user counts as connected), `google`, `off` |
| `TRIAGE_GMAIL_READ_SCOPE` | IM read scope: `metadata` (default, `gmail.metadata`) or `readonly` (`gmail.readonly`); decided by the Phase 0 spike |
| `TRIAGE_OAUTH_CLIENT` | OAuth web client JSON: file path or Secret Manager secret |
| `TRIAGE_CONSOLE_BASE_URL` | Public URL used for the OAuth redirect (`<url>/api/gmail/callback`) |
| `TRIAGE_TOKEN_VAULT` | `local` (default) or `secretmanager` |
| `TRIAGE_CONSOLE_DIST` | Built frontend directory (default `console/frontend/dist`) |
| `TRIAGE_BOOTSTRAP_ADMIN` | The deployer's address: admin until an admin is named in Settings |
| `TRIAGE_SCHEDULER_SA` | Worker only: the service account allowed to call it |
| `VITE_API_TARGET` | Dev server only: where `/api` is proxied (default `http://127.0.0.1:8000`) |

## Deploy (Cloud Run + IAP)

`Dockerfile.console` builds the frontend with `npm ci && npm run build` (node:22) and serves it with
`uvicorn console.backend.app:app --proxy-headers` (python:3.12); `infra/07_console.sh` builds it with
Cloud Build and deploys with IAP on the service, `TRIAGE_BACKEND=gcp`, `TRIAGE_IAP_AUDIENCE`,
`TRIAGE_OAUTH_CLIENT` and `TRIAGE_CONSOLE_BASE_URL`. Grant `roles/iap.httpsResourceAccessor` to the
people who should reach the Console; roles inside it come from `config.analysts` and the `slrr_im`
roster. Add `<url>/api/gmail/callback` as an authorized redirect URI of the OAuth client. Don't set
`TRIAGE_DEV_USER` in production. `infra/09_worker.sh` deploys the worker from the same image.
`infra/deploy.sh` runs every step.

`package-lock.json` uses public `registry.npmjs.org` URLs and lists the native bindings for every
platform, so `npm ci` works in Cloud Build. Behind a registry mirror, npm's default
`replace-registry-host=npmjs` sends the same requests to your configured registry.

## Tests

```bash
TRIAGE_LLM=fake .venv/bin/python -m pytest -q tests/test_console_api.py tests/test_platform.py
```

`tests/test_platform.py` runs the platform through the real pipeline and the real API on the local store.

The tests seed a temporary SQLite DB once per module with `seed_demo` (each test gets a copy) and
cover auth and roles, KPIs and charts, cases and activity, the review queue (stubbed and real
operations), reverts (derived and plain fields) and closing, operation error mapping, settings
validation / saves / resets, rosters (CRUD, schedule, validation), parity, learning decisions and the
Gmail OAuth flows with a fake OAuth flow: IM and agent mailboxes, partial consent (token not stored),
identity-scope aliases, and reconnect after a read-scope change.

## Code map

| File | Contents |
|---|---|
| `backend/app.py` | App factory, error handlers, `/health`, `/me`, `/meta`, static SPA |
| `backend/auth.py` | Identity (IAP header / JWT / dev user), roles, `require_*` dependencies |
| `backend/state.py` | Shared lazy `AgentContext`; reloads config when stored overrides change |
| `backend/ops.py` | Runs agent operations with outbox delivery and maps their errors |
| `backend/routes_*.py` | Metrics, cases (activity, review, parity, escalations, outbox), rosters, settings, learning |
| `backend/gmail_oauth.py` | Gmail OAuth for IMs and the agent account |
| `backend/live.py` | Dashboard, live stream, Review feed, intake |
| `backend/routes_work.py` | Chat tracking, chat agent, temp checks, workforce, knowledge, golden set, campaigns, watches |
| `backend/routes_admin.py` | Platform settings, secrets, BigQuery, delivery, AI instructions, safety, audit, costs, setup, agent health |
| `backend/audit_mw.py` · `help_content.py` · `worker.py` | Audit of every changing call; help topics; the worker service |
| `backend/serializers.py` | Case / escalation / event JSON, event descriptions |
| `../tests/_console_fixtures/seed_demo.py`, `demo_*.py` | Demo data generator (kept with the tests) |
| `frontend/src/pages/` | One component per page |
| `frontend/src/components/` | Layout, case drawer, charts, schedule, roster and settings editors, UI kit |
| `frontend/src/api/` | Typed API client, hooks and response types |
