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
.venv/bin/python -m console.backend.seed_demo --reset
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

| Page | What it shows / does |
|---|---|
| Overview | Headline cards (first-pass yield, Burson bounce rate, auto-fix rate, SLA met, time saved, parity recall) and KPI cards by group, for a 24 h / 7 / 14 / 30-day window with the change vs the previous window; daily activity chart; top QA rule failures and operation errors; failures by Burson on-call |
| Activity | Live event feed (filters: type or prefix, case, escalation, actor; auto-refresh) |
| Cases | Searchable, filterable list; drawer with fields, attempts, corrections, issues, the timeline, escalations / email versions / T&S, links to the counterpart and related cases. Analysts can revert an applied correction or close the case |
| Review queue | Alerts held for IM review (oldest first, waiting time): forward (optionally overriding fields), bounce or suppress with a reason |
| Suppressed | Suppressed alerts with reasons (agent vs IM review) |
| Parity | Path B recall / precision / full agreement, disagreements by field with examples, Burson-only / in-house-only / pending lists |
| Escalations | Social Alert drafts and T&S forms: status, versions, recipients, bodies (open-only toggle; search by id, IM, bug or WD issue) |
| Rosters | Tabs *IM shifts* (`slrr_im`) and *Burson on-call* (`burson`): week schedule with coverage gaps, people, overrides (add / remove), roster editor (admins) |
| Settings | Structured forms (thresholds, corrections, Burson feedback, outbox, handover, metrics, models), table editors (distribution products and groups, emoji actions legend), a validated JSON editor for every other section, per-section reset, change history |
| Learning | Config-change proposals (with a validity preview) and knowledge facts: approve / reject |
| Outbox | Queued chat posts, delivery status and stale items |

The header shows who's on call now on both rosters, the Gmail button, the signed-in user and role,
and a dark/light toggle. The sidebar shows badges for the review queue, learning and the outbox.

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
| `VITE_API_TARGET` | Dev server only: where `/api` is proxied (default `http://127.0.0.1:8000`) |

## Deploy (Cloud Run + IAP)

`Dockerfile.console` builds the frontend with `npm ci && npm run build` (node:22) and serves it with
`uvicorn console.backend.app:app --proxy-headers` (python:3.12); `infra/07_console.sh` builds it with
Cloud Build and deploys with IAP on the service, `TRIAGE_BACKEND=gcp`, `TRIAGE_IAP_AUDIENCE`,
`TRIAGE_OAUTH_CLIENT` and `TRIAGE_CONSOLE_BASE_URL`. Grant `roles/iap.httpsResourceAccessor` to the
people who should reach the Console; roles inside it come from `config.analysts` and the `slrr_im`
roster. Add `<url>/api/gmail/callback` as an authorized redirect URI of the OAuth client. Don't set
`TRIAGE_DEV_USER` in production.

`package-lock.json` uses public `registry.npmjs.org` URLs and lists the native bindings for every
platform, so `npm ci` works in Cloud Build. Behind a registry mirror, npm's default
`replace-registry-host=npmjs` sends the same requests to your configured registry.

## Tests

```bash
TRIAGE_LLM=fake .venv/bin/python -m pytest -q tests/test_console_api.py
```

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
| `backend/serializers.py` | Case / escalation / event JSON, event descriptions |
| `backend/seed_demo.py`, `backend/demo_*.py` | Demo data generator |
| `frontend/src/pages/` | One component per page |
| `frontend/src/components/` | Layout, case drawer, charts, schedule, roster and settings editors, UI kit |
| `frontend/src/api/` | Typed API client, hooks and response types |
