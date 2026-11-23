# Plan 5: agent alerts from the nine sources

The owner's "System architectural rebuild specification" (22 Nov 2026), built inside the Python app.
The app reads nine sources, strips personal details from every post before it is stored, checks each post against
editable rules, groups like posts into stories in BigQuery, reviews what passes on the Agent Runtime, raises it in
Chat, and learns from the analysts' verdicts.

In the Console it is called **Agent alerts**: alerts the agent raises itself. ("Our own alerts" is already the name of the page for alerts
taken from the team's own tables.) In the code it is `own_alerts`. Its switch starts OFF.

## Decision log

Where the specification's own text cannot run, or breaks one of its hard rules, and what is built instead.

| # | The specification says | Built instead | Why |
|---|---|---|---|
| D1 | One `app.py` deployed onto the Console, the worker and both jobs | The pipeline is added to the existing code on the same four workloads | Hard rule 1 is "retain and extend, never overwrite". One file would delete the merged Console |
| D2 | Insert into `agent_events` with `target_id`, `severity`, `status`, `metadata` | Events are written through `triage_agent.events`, in the table's real columns | The table exists with other columns; `CREATE TABLE IF NOT EXISTS` changes nothing and every insert would fail |
| D3 | One statement unions all seven tables | Each table is read in its own location; rows are staged in the agent's dataset | Sonar and Tubular are in us-central1, the rest in US. BigQuery refuses to read both in one statement |
| D4 | Source rows read by guessed field names (`$.id`, `$.text`, ...) | Each table is read by its real columns: the reads already under Settings, Temp check, sources, plus two new ones (Google's own posts, the DSD story pool) taken from the sheet bot's Watch | Hard rule "live production schemas" |
| D5 | Cloud DLP runs on Brandwatch API and Chat text only; the seven tables get the SQL pattern only | Every source is staged by the job, so the pattern and Cloud DLP both run before a post is stored | Hard rule: names are stripped before storage, and only DLP finds names |
| D6 | Cards, `replaceCards` as the app, `users/app`, a Workspace Events stream | Alerts are posted as text by the QA chatbot's sign-in. Verdict links open the Console. The Other alerts space is read each run | All four need a configured Chat app, which the owner ruled out on 22 Nov. The sheet bot reads and posts the same way |
| D7 | An external table over a KOF sheet with columns `platform, handle, kof_name, kof_tier` | The service account reads the sheet; an author is a KOF when a cell names the handle (the sheet bot's rule) | The sheet's real columns are not those four |
| D8 | Per-user secrets named `slrr-triage-token-<user>` | The sign-in vault that exists is kept as it is | Hard rule 1 |
| D9 | Thresholds, model names, topic names and space ids as constants or environment values | Every one is a setting under Settings, Agent alerts, with the specification's value as its default | The owner's rule: nothing operational is hard-coded |
| D10 | Vector indexes on `posts` and `decisions` | None | Neither search reads those tables directly, and each compares a few thousand rows at most |
| D11 | A remote model `gemini4_deep_reviewer` | Not created. The deep model is called by the Agent Runtime, and by the worker when the Agent Runtime cannot be reached | Nothing in the specification's own code calls that BigQuery model |
| D12 | A scheduled query purges after 30 days | The app's daily retention run deletes the rows; every table also expires its partitions | Same result with nothing extra to set up |
| D13 | A DLP template `slrr_social_pii_scrubber` | The same DLP settings are sent with each call, from Settings | Nothing to create by hand; the list of detail types can be changed in the Console |
| D14 | The review marks the queue item done, then publishes the alert | The decision is written to BigQuery first, once. Then its Console record and its alert. The queue item is closed last, and an open item comes back with the decision BigQuery holds | A run cut short between two steps would otherwise lose an alert, or raise one twice |
| D15 | `VECTOR_SEARCH` over a query that filters on the embedding column | Each search reads temporary tables made just before it | BigQuery allows only SELECT, FROM and WHERE in the base query, and no filter on the embedding column |
| D16 | The follow-up job re-queues a surging story every minute, with a made-up score of 0.95 | A raised story is queued again once for each time it was raised, with no score, and only when it was measured in the last 15 minutes | Once a minute would send the same story to review 200 times; a stale count is not a surge |
| D17 | The ten most recent verdicts are shown to every review | The ten decisions most like the item under review, among those with a verdict | A verdict on an unrelated post says nothing about this one |
| D18 | The review handles 25 items a minute, however long each takes | A run stops starting reviews after its seconds (a setting); the rest wait a minute. One run at a time | Two slow runs would otherwise overlap and review the same items |
| D19 | A button on the card records the verdict when its link is opened | The link opens the Agent alerts page, which records the verdict once for the analyst who is signed in and can be changed there | A link that changes something when fetched can be set off by a preview. The page asks the API as the person |
| D20 | The seven tables are named in the procedure | Find and fill (Integrations) adds the two tables only agent alerts read and ticks the tables it reads. Each tick can be changed there | Which tables are read is a setting, like every other read |
| D21 | The alert space is an environment value | The space is chosen from the agent's spaces under Settings, Agent alerts. The source space is not among the choices and is refused again when an alert is queued | Nothing the agent raises may reach the source space |
| D22 | Phase 1 grants the agent's account `storage.objectAdmin` and `chat.bot`, the scheduler `cloudfunctions.invoker`, the connection's account `dlp.user` and `run.invoker`, and Chat's publishers `pubsub.publisher` | None of those. Added to what the deploy already grants: `dlp.user` for the agent's account, Vertex AI User for the connection's account, and Connection Admin on the one connection for the agent's account | Each role left out serves a part that is not built (D5, D6) or nothing. The account that creates the two remote models needs Connection Admin, which the specification leaves out |
| D23 | Phase 1 enables 22 APIs | Two are added to the deploy's list: Sensitive Data Protection and BigQuery Connection | The rest are on already or serve nothing built: Workspace Events (D6), Data Transfer (D12), Data Policy, Data Catalog and Monitoring, which no code calls |

Defects in the specification's SQL and code that are fixed here:
- `last_alerted_at` is read (cool-down, follow-up) and never written. The review writes it.
- `ARRAY_LENGTH(embedding) IS NULL` is never true for a stored column, so no post would get an embedding.
- `required_keywords_all` and `min_engagements` are stored on a rule and never checked.
- Posts that start a story in one run each get their own story, so a spike splits across stories. They are grouped first.
- A story's alert carries no link. It now lists its posts' links from the vault.
- A story that stays above the bar is sent to Gemini again every run. It is asked again only after the cool-down, or when it has grown.
- `rows`, `at`, `from` and `to` are reserved words in BigQuery and cannot name a table expression, a column or a parameter. A test reads every statement for them.
- The vault is looked up by post id only, so a story's alert gets no author and no link. A story's posts are looked up, and each KOF among them is named once.

## Phases

Each step is built test-first. The suite: `TRIAGE_LLM=fake .venv/bin/python -m pytest -q` (README, Quickstart).

### Phase 1: the data in
Verified when: with the switch ON and BigQuery stood in for, one run stages scrubbed posts from all nine sources, fills the vault and calls the procedure.

| Step | What | Files | Blocked by |
|---|---|---|---|
| 1.1 | Settings, two switches, the two new tables | `triage_agent/config.py`, `config/own_alerts.yaml` | none |
| 1.2 | Strip personal details: the pattern, then Cloud DLP; nothing is kept when DLP cannot be reached | `triage_agent/ownalerts/scrub.py` | 1.1 |
| 1.3 | The KOF list | `triage_agent/ownalerts/kof.py` | 1.1 |
| 1.4 | BigQuery tables, the pattern function, two remote models, the procedure | `triage_agent/ownalerts/schema.py` | 1.1 |
| 1.5 | The nine reads, staged; the vault | `triage_agent/ownalerts/sources.py`, `ingest.py` | 1.2, 1.3, 1.4 |
| 1.6 | The run, in the in-house job | `triage_agent/ownalerts/cycle.py`, `triage_agent/inhouse.py` | 1.5 |

### Phase 2: review and raise
Verified when: a queued post or story is reviewed, a mandatory rule cannot be overruled, the decision is stored once, the alert is queued for Chat, and a verdict is stored.

| Step | What | Files | Blocked by |
|---|---|---|---|
| 2.1 | Policy rules, kept in the store and mirrored to BigQuery | `triage_agent/ownalerts/rules.py` | 1.4 |
| 2.2 | The review: Agent Runtime first, the worker when it cannot be reached; the hard-rule lock; decisions | `triage_agent/ownalerts/review.py`, `triage_agent/agent_runtime.py`, `triage_agent/handlers.py` | 2.1 |
| 2.3 | The alert in Chat, with the KOF label and links from the vault | `triage_agent/ownalerts/raise_.py` | 2.2 |
| 2.4 | Verdicts | `triage_agent/ownalerts/feedback.py` | 2.2 |
| 2.5 | Follow-up: a raised story that surges is reviewed again | `triage_agent/ownalerts/surge.py`, `triage_agent/followups.py` | 2.2 |
| 2.6 | The 30-day purge | `triage_agent/ownalerts/purge.py`, `triage_agent/retention.py` | 1.4 |
| 2.7 | The review and the purge run in the worker's minute tick | `triage_agent/platform_jobs.py` | 2.2, 2.6 |

### Phase 3: the Console
Verified when: the page shows sources, alerts and rules from the real routes, type-check and build pass, and the page is looked at in a browser.

| Step | What | Files | Blocked by |
|---|---|---|---|
| 3.1 | Routes | `console/backend/routes_own.py` | Phase 2 |
| 3.2 | The Agent alerts page, the Integrations tick, Settings, Help | `console/frontend/src/pages/OwnAlerts.tsx` and friends | 3.1 |

### Phase 4: Google Cloud
Verified when: `infra/deploy.sh` enables what is needed, grants the roles, creates the BigQuery connection and the salt secret, and seeds the settings.

| Step | What | Files | Blocked by |
|---|---|---|---|
| 4.1 | Deploy scripts | `infra/01_enable_apis.sh`, `infra/02_service_accounts.sh`, `infra/06_jobs.sh`, `infra/11_own_alerts.sh`, `infra/10_seed_settings.py`, `infra/deploy.sh`, `tests/test_own_infra.py` | Phase 1 |
| 4.2 | Documents | `README.md`, `infra/README.md`, `docs/CONTRACTS.md` | all |

## Not yet specified

- **Nothing here has run against Google Cloud.** This workspace cannot reach the project. The first live run is the proof of the SQL.
- `gemini-4-hydrogen` as a BigQuery remote model is taken from Google's model list, not from a run. The name is a setting.
- Zero data retention: `infra/11_own_alerts.sh` turns Vertex AI's cache off, for every Gemini call in the project (it needs the Vertex AI admin role; `--keep-cache` skips it). Prompt logging for abuse monitoring stays on until Google grants an exception, which is a request to Google.
- Cards in Chat. They need a configured Chat app (D6).

## Always / Never

- Always: read the source tables, never write to them. Start every switch OFF. Keep handles, links and names out of every table but the vault. Stop a read when Cloud DLP cannot be reached.
- Never: Apps Script. A post in the source (Burson) space. A change to `agent_events` or the metric views.

## Progress

| Phase | Status |
|---|---|
| 1 The data in | built: settings, scrub, the KOF list, the BigQuery objects, the nine reads, the run in the in-house job. Left for 3.2: the Integrations tick and Find and fill |
| 2 Review and raise | built: rules, the review, the alert, verdicts, the follow-up, the purge, the minute tick. A raised alert is not edited in Chat after its verdict (D6) |
| 3 The Console | built: the Agent alerts page (raised, passed over, sources, rules), verdicts from the page and from a Chat link, its Settings and Help pages, its tick on Integrations, Find and fill, its place on the AI page |
| 4 Google Cloud | built: the two APIs, the DLP role, the BigQuery connection with its two grants, the salt, Vertex AI's cache off, the two settings filled, ten minutes for the in-house job, the documents. The script was run against stand-ins for gcloud, bq and curl, not against the project |
