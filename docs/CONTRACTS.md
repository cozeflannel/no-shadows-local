# Contracts: SLRR Alert Automation Agent (v3)

The single source of truth shared by all workstreams. If code and this
document disagree, fix one of them in the same change.

| Workstream | Owns |
|---|---|
| **A1 Triage core** (main agent) | `triage_agent/qa/`, `triage.py`, `cases.py`, `render.py`, `review.py`, `followups.py`, `inhouse.py`, `agent_engine_app.py`, `jobs/`, `evals/` |
| **A2 Escalation & conversation** | `triage_agent/escalation/`, `actions.py`, `emails.py`, `converse/` |
| **B Agent Console** | `console/` |
| **C Workspace integration** | `studio-addon/`, `flows/`, `analytics/`, `infra/` |
| Foundation (main agent; others request changes) | `models.py`, `config.py`, `store.py`, `events.py`, `metrics.py`, `operations.py`, `outbox.py`, `routing.py`, `ids.py`, `context.py`, `llm.py`, `oncall/`, `handlers.py`, `config/*.yaml` |

## 1. Architecture

```
Chat spaces: [S-F] Burson Automated Alerts V3 · clean "SLRR Triaged Alerts"
             [S-F] YouTube Social · Doodle Team · 24/7 SL team chat · crisis chat · DMs
  ⇅ Workspace Studio flows owned by the Triage Agent account (NO Chat API, NO webhooks)
     └ custom steps (Apps Script add-on, studio-addon/)
         └ HTTPS → Agent Runtime (formerly Vertex AI Agent Engine) reasoningEngines/{id}:query
              └ TriageAgentApp.query(op, payload, context) → operations.handle()
Jobs (Cloud Scheduler → Cloud Run job, jobs/run_job.py): run_followups, ingest_inhouse
Agent Console (Cloud Run + IAP): FastAPI imports triage_agent directly
Gmail API (per-IM OAuth, tokens in Secret Manager): drafts from the Brand Social alias
State: Firestore (prod) / SQLite (dev) · Events: BigQuery (prod) / SQLite (dev)
Path B input: BigQuery bsip-s-bsip-gg-26-2cf3.google_bg.brand_safety_alert_outbox
```

**Outbound without the Chat API:** a Studio flow can only post from its own steps.
Posts that don't come from a running flow (jobs, Console, email follow-ups, or
targets the calling flow has no step for) are queued as `OutboxItem`s.
`ctx.enqueue()` then rings a **doorbell** that starts the Studio **Outbox flow**:
- `sheet`: append a row to the Agent Outbox Sheet ("When a sheet changes").
- `email`: email the Triage Agent account ("When I get an email").
- Studio's "On a schedule" starter only repeats daily or weekly, so nothing time-critical depends on it.

The Outbox flow calls `drain_outbox`, which atomically claims:
- 1 clean-space item, so each alert is its own message and a reaction maps to one case;
- up to 10 items per other target, joined into one message;
- DMs for a single recipient set.

`run_followups` re-rings for items still undelivered after 3 minutes.

## 2. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TRIAGE_BACKEND` | `local` | `local` = SQLite store + events; `gcp` = Firestore + BigQuery |
| `TRIAGE_LOCAL_DB` | `.local/triage.db` | SQLite file (store **and** events) |
| `TRIAGE_LLM` | `vertex` | `vertex` = Gemini on Vertex AI; `fake` = `FakeLLM` |
| `TRIAGE_LLM_LOCATION` | `global` | Vertex AI location for model calls |
| `TRIAGE_ENV` | config (`dev`) | `dev` \| `prod` |
| `TRIAGE_CONFIG_PATH` / `TRIAGE_DISTRIBUTION_PATH` | `config/…yaml` | Config files |
| `GOOGLE_CLOUD_PROJECT` | (none) | GCP project |
| `TRIAGE_FIRESTORE_DB` | `(default)` | Firestore database id |
| `TRIAGE_BQ_TABLE` | (none) | `project.dataset.agent_events` |
| `TRIAGE_GMAIL` | `fake` | `fake` = in-memory; `google` = Gmail API |
| `TRIAGE_TOKEN_VAULT` | `local` | `local` = `.local/gmail_tokens.json` (dev); `secretmanager` |
| `TRIAGE_OAUTH_CLIENT` | (none) | Path or Secret Manager name of the OAuth web client JSON |
| `TRIAGE_GMAIL_READ_SCOPE` | `metadata` | IM read scope next to gmail.compose: `metadata` (least access) or `readonly` (if Gmail blocks raw draft reads with metadata; Phase 0 check 10b) |
| `TRIAGE_DEV_USER` | `dev@local.invalid` | Console acting user without IAP (ignored with `TRIAGE_BACKEND=gcp` unless set explicitly) |
| `TRIAGE_IAP_AUDIENCE` | (none) | Console: verify IAP's signed `X-Goog-IAP-JWT-Assertion` for this audience. **Required with `TRIAGE_BACKEND=gcp`**: without it the plain email header is refused (401), never trusted |
| `TRIAGE_CHAT_APP_AUDIENCE` | (none) | Console: enables `POST /api/chat-webhook` (experimental Chat-app endpoint). Project number or endpoint URL that Google Chat's bearer token is issued for; unset = 404 |
| `TRIAGE_STEALTH_BURSON` | (none) | `1/true/yes` forces stealth mode (no `burson_text`; see §3 delivery rules) regardless of `burson_feedback.silent_in_burson_space` |
| `TRIAGE_CONSOLE_BASE_URL` / `TRIAGE_CONSOLE_DIST` | (none) | Console: Gmail OAuth redirect base; built frontend directory |
| `TRIAGE_BOOTSTRAP_ADMIN` | (none) | Console: this address is admin until an admin is named in Settings |
| `TRIAGE_OWNER_ADMIN` | (none) | Console: the owner (one address, or several with commas) is **always** an admin, whatever People or Settings say. Checked before anything else (`auth.resolve_role`, role source `owner`); counted by `config.admin_emails()` / `lead_emails()`; People lists them as locked and refuses to change their role or remove them. Set only at deploy (`OWNER_ADMIN` in `infra/.env`, default the deployer), so nobody can be locked out of the Console from the Console |
| `TRIAGE_SCHEDULER_SA` | (none) | Worker: the service account whose identity token may call it |

## 3. Operations API

Entry point: `triage_agent.operations.handle(request, ctx) -> OperationResponse`.
- Handler modules are listed in `triage_agent/handlers.py`. Each registers with `@operation("<name>")`.
- A handler returns `ChatOutputs` or `(ChatOutputs, data)`.
- `request.op` is validated against the registry. Unknown ops return `ok=false`.

**Request:**

```json
{ "op": "triage_message",
  "payload": { ... },
  "context": { "invoked_by": "triage-agent@…", "flow": "burson_alerts", "run_id": "…",
               "deliver": "return", "targets": ["burson","clean","dm","youtube","doodle"] } }
```

**Response** (`OperationResponse`): `outputs` always holds **all 23** `STUDIO_OUTPUT_KEYS`:

| Key pair | Studio step it drives |
|---|---|
| `has_reply` / `reply_text` | "Reply to a message" (clean space / DM only) |
| `has_burson` / `burson_text` | "Post in a space": Burson space (Notify space members ON) |
| `has_clean` / `clean_text` | "Post in a space": clean space |
| `has_dm` / `dm_text` / `dm_recipients` | "Send a message" (comma-separated emails) |
| `has_youtube` / `youtube_text` | "Post in a space": [S-F] YouTube Social |
| `has_doodle` / `doodle_text` | "Post in a space": Doodle Team |
| `has_team` / `team_text` | "Post in a space": 24/7 SL team chat |
| `has_crisis` / `crisis_text` | "Post in a space": crisis chat |
| `has_handover` / `handover_text` | "Add to a doc": Handover doc (Outbox flow only) |
| `case_id`, `escalation_id`, `verdict`, `summary` | Informational |

- `ok=false` means a failure, and every `has_*` flag is `no`.
- `retryable=true` makes the add-on throw a RETRYABLE error, so Studio retries up to 5 times.
- **Retry policy** (`operations.is_retryable`): `RetryableError` is always retryable. For the entry operations
  (`triage_message`, `record_reaction`, `converse`, `ingest_email`) **every other failure is retryable too**, except
  an invalid payload (pydantic `ValidationError`). Nothing is cached on failure and the idempotency claim is released,
  so the retry is processed rather than replayed; a transient Firestore/BigQuery/Gemini error must never drop an alert.
  Jobs and Console operations are not retryable (they rerun on their own schedule / the user retries).
  The `error` event carries `error_type` and `retryable`.

**Delivery rules** (applied by `handle()`; handlers don't care):

| Rule | Effect |
|---|---|
| `context.deliver="outbox"` (Console, jobs) | Every output is queued and the doorbell rings. `outputs` carries only ids, verdict and summary. `data.reply_text` holds any reply text |
| `context.targets` set | Outputs for targets the flow has no step for are queued. A reply with no `reply` target is dropped (`data.dropped_reply_text`) |
| **stealth** (`burson_feedback.silent_in_burson_space`, or `TRIAGE_STEALTH_BURSON`) | `burson_text` is never emitted; it is appended to `clean_text` as `[STEALTH — would post to Burson] …` so IMs still see what Burson would have been told. Applied once. Development/pilot only: it contradicts the Burson correction loop and must be off in production |

**Chat rules:**
- **Burson space:** never use `reply_text`, because "Reply to a message" needs owner approval when external users are present. Put the reply in `burson_text` and include the asker's email (it becomes an @mention).
- **Space identity:** `config.space_key_for(space_id, space_name)`.
- **Mentions:** include bare emails in a space text. "Notify space members" turns them into @mentions; non-members get a chip only.
- **Style:**
  - Every message starts with `config.agent.message_prefix` (`🤖`).
  - Include the case id (`TRG-1042`) and/or escalation id (`ESC-1207`); reactions, replies and emails are tied back with `triage_agent.ids`.
  - Use Chat markdown (`*bold*`, `_italic_`, `` `code` ``, `- ` bullets).
  - Keep messages ≤ 3,500 characters.
- **One case per clean post:** a clean-space message never contains two case ids, except digests and handovers, which aren't actionable by reaction.

### 3.1 Payload shapes (models in `triage_agent/models.py`)

- `ChatMessage`:
  ```json
  {"message_id","text","sender":{"name","email","type"},"space_id","space_name","thread_id","link","create_time","conversation_type"}
  ```
- `ReactionEvent` (`record_reaction`, `start_escalation`):
  ```json
  {"emoji","user":{"email","name"},"message":ChatMessage}
  ```
  `message.text` may be empty if Studio only exposes the id. Then look up the case with `Store.find_case_by_message_ref` (matches `Case.clean_message_key`, the last path segment of `clean_message_ref`; see `ids.message_key`).
- `InboundEmail` (`ingest_email`):
  ```json
  {"subject","from_email","from_name","to":[],"cc":[],"body","message_id","thread_id","received_at","link"}
  ```
- In-house row (`ingest_inhouse`): one `brand_safety_alert_log` row as JSON (see §9).

### 3.2 Operations

| op | Caller | Payload | Behavior | Owner |
|---|---|---|---|---|
| `triage_message` | Flow 1 (Burson space message) | `{message}` | §4 | A1 |
| `record_reaction` | Flow 2 (legend emoji on a clean-space post) | `ReactionEvent` | §6 | A2 |
| `start_escalation` | legacy | `ReactionEvent` | = `record_reaction` with 📦 | A2 |
| `record_post` | optional step after a clean post | `{case_id, message_id?, message_link?}` | Sets `Case.clean_message_ref` and `clean_posted_at`. Emits `clean.posted` | A2 |
| `converse` | Flow 3 (@mention, or DM to the agent) | `{message}` | §10 | A2 |
| `ingest_email` | Flow 4 (agent inbox) | `InboundEmail` | §8 | A2 |
| `drain_outbox` | Flow 5 (doorbell) | `{}` | §1 (foundation, done) | — |
| `run_followups` | job, every minute | `{}` | §11 | A1 |
| `generate_handover` | job at shift ends, or `converse` "handover" | `{shift?}` | §11 | A1 |
| `ingest_inhouse` | job, every 1–5 min | `{rows?}` (reads BigQuery if absent) | §9 | A1 |
| `review_decision` | Console, or converse `forward`/`bounce`/`suppress` | `{case_id, decision, reason?, fields?, actor, via}` | §5 | A1 |
| `revert_correction` | Console, or converse `revert TRG-… field` | `{case_id, field, actor}` | §5 | A1 |
| `close_case` | Console | `{case_id, reason, actor}` | → CLOSED. Emits `case.closed{reason:manual}` | A1 |
| `decide_proposal` / `decide_fact` | Console | `{id, decision: approve\|reject, actor}` | Approve applies the patch / activates the fact | A2 |
| `health` | probes | `{}` | Version info (done) | — |

**Exactly-once deliveries:** `triage_message`, `record_reaction`, `converse` and `ingest_email` cache their response under an idempotency key (message id, reaction, email). A repeated delivery replays the cached answer. Studio may retry a step while the first attempt is still running, so each call also takes an atomic claim on the key (`Store.claim_idempotent`, TTL 120 s; `triage_agent/idempotency.py`):
- An overlapping delivery waits up to 20 s for the first answer and replays it.
- If the first attempt is still running after that, the overlapping delivery returns `retryable=true`, so Studio retries later.
- A claim is released when its call ends, and expires if the attempt crashed.
- Failed or unmatched reactions are not cached, so reacting again retries them.

**Nested calls:** handlers that run another operation (converse → `review_decision`, `revert_correction`, `generate_handover`, `record_reaction`) use `operations.dispatch(op, payload, ctx, rc) -> (ChatOutputs, data)`. It returns the raw outputs (no outbox, rerouting or stealth) and lets exceptions propagate; the outer `handle()` finalizes delivery once.

## 4. Alert QA (`triage_message`; also used by Path B and Watchdog)

`triage_agent.qa.pipeline.run_qa(ctx, parsed: ParsedAlert, source, received_at) -> TriageResult`
is shared by every intake path.

1. **Normalize** the payload to `ChatMessage`.
   - Ignore the agent's own messages: sender == `config.agent.email`, or text starts with the prefix → `message.ignored{reason:own_message}`.
   - Ignore messages from other spaces → `wrong_space`.
2. **Idempotency:** key `msg:` + (`message_id`, or sha256 of `space|create_time|text`). If seen, return the stored response.
3. **Detect + parse** (`qa/parser.py`).
   - Labels match case-insensitively and ignore `*`/`_`. Values continue onto following lines until the next label.
   - `flag_patterns` set `parsed.flags`, e.g. `meets_p0`.
   - Not an alert → `message.ignored{reason:not_alert}` and empty outputs (questions are handled by Flow 3).
   - Required labels missing → Gemini fallback extraction (`triage.parse_fallback`).
   - Value normalization:
     - ints: `2,450`, `2.4K`, `1.2M`
     - booleans: Yes/No/True/False/✅/❌
     - datetimes: ISO, `Oct 12, 2026 1:05 PM ET`
     - lists: `,` `;` `|` or newline separated
     - enums snap to `allowed` casing
4. **Deterministic checks** (`qa/rules.py`):
   - Field rules: type, required, allowed, reference lists (`exposure_tags`, `sensitive_topics`, `products` are built-in), pattern, bounds, length, not in future, max age.
   - Cross-field rules.
   - Optional URL check.
5. **Deterministic corrections** (confidence 1.0, `source=rule`), each a `Correction(old → new, reason)`:
   - Aliased or merged exposure tags → canonical name.
   - Priority from the tag.
   - Risk-tag aliases → canonical names (e.g. World Politics → Politics).
   - Products:
     - an alias → its distro name;
     - a deprecated distro with one redirect (Gems → Gemini App) → the redirect target;
     - several redirects (Central AI) → Gemini reclassifies.
   - `total_engagement` = likes + comments + shares when the parts are present.
   - `engagement_level` from the total (KOF → `VIRAL KOF`).
   - `social_network` from the URL domain when the stated network disagrees. The link is never auto-corrected.
   - `issue_status` from alert history (14-day rule).
   - Alert-name prefix `[URGENT|HIGH ENGAGEMENT] [NEW|ONGOING]` from the computed track and status.
   - The account-suspension-claiming-bias remap.
6. **Gemini assessment:** one call, `triage.assess` (`qa/llm_assess.py`), using the triage model and temperature 0. The alert text is delimited as untrusted data. It returns, per `llm_checks` entry, `{ok, confidence, finding, proposed_value}`, plus enrichment:
   - `sundar_mention`, `non_us_markets`, `secondary_products`, `owned_post` (+ `owned_profile_url`), `video_timestamp`;
   - `youtube_subject`, `bias_allegation`, `exclusion_hints` (spam, AI comparison, Google as a verb);
   - `ts_evidence` (`input_shown` | `replicable` | `none`);
   - `product_reclassification`, `politics_us_relevant`.

   Skipped when `thresholds.llm_checks_enabled` is false. Gemini errors raise `RetryableError`.
7. **Correction policy:** an LLM-proposed value is **applied** when all of these hold:
   - `corrections.mode == "auto"`;
   - confidence ≥ `auto_apply_min_confidence`;
   - the field is `correctable`;
   - the field isn't in `never_auto_correct`.

   Otherwise it stays proposed (`applied=false`), and the alert goes to NEEDS_REVIEW.
8. **Collection Requirements** (`qa/requirements.py`) mirror `brand_safety_alerting/sql/02`.
   - **Sensitive topics:** risk tags in the list, minus redundant pairs. Politics only counts for a US or unknown location, or an English election mention. Briefed topics add `Launches: <label>`.
   - **Exclusions** (`EXCLUDED_*` reason codes) apply unless a risk signal is present (a sensitive topic, or Sonar VERY_HIGH relevance in `parsed.extra`):
     - `google_as_verb`: not P0 and only Brand/Search products.
     - `drive_link`.
     - `spam`: the regex, ≥4 links or ≥12 hashtags.
     - `ai_comparison`: a generic-criticism tag, no sensitive topic, and comparison + AI-context regexes.
     - `benchmark`: not P0, and no sensitive topic other than AI Personification.
   - **URGENT** reasons: `P0_TOPIC`, `SENSITIVE_TOPIC`, `BRIEFED_TOPIC`, `KOF`. URGENT needs at least one reason, no exclusion, and detection within 24 h.
   - **HIGH_ENGAGEMENT:** total ≥ 2,000 and no exclusion.
   - **Novelty:** among cases alerted within 14 days, one with the same exposure tag and the same fingerprint, or token Jaccard ≥ 0.6 using `issue_stopwords` and a plural stemmer, means **ONGOING** (sets `related_case_id`).
   - **Alertability:**
     - An ONGOING URGENT without KOF is suppressed (`ongoing_no_kof`), unless it is also HIGH_ENGAGEMENT, which alerts as an update on the thread.
     - Neither track → `below_threshold`.
     - `always_alert` tags (Content) alert regardless of novelty.
   - **YouTube protocol** (`alert_action`):

     | Case | Result |
     |---|---|
     | Subject, 2K+ or KOF | `YOUTUBE_CHAT_ONLY`, or `EMAIL_ALERT` with a bias allegation |
     | Subject, below 2K, sensitive | `chat_only` ping saying it isn't escalated on Google's end |
     | Subject, below 2K, not sensitive | Suppressed (`youtube_no_action`) |
     | Google is the subject but YouTube is mentioned | `EMAIL_ALERT` + ping |

   - **Doodle protocol:** product in `protocols.doodle.products`, or the doodle regex.
   - **Leadership protocol:** all of:
     - the issue is NEW;
     - the alert is P0 or sensitive;
     - the tag is in `product_mistake_tags` or is a Content tag;
     - no ping for the same fingerprint or tag in the last `dedupe_days`.
   - **T&S recommended:** KOF, Child Safety, or a hallucination tag on a Gemini product.
   - **SLA:** `sla_due_at` = received + the platform tier's `sla_minutes` (limited tiers have no SLA).
   - **Routing:** `routing.plan_recipients` and `routing.suggest_actions`.
9. **Verdict:**

   | Verdict | When |
   |---|---|
   | `FAIL` | An unfixable blocking issue remains (dead or missing link, missing post content, parse failure) on an alert that would otherwise be alertable |
   | `SUPPRESSED` | Not alertable on the corrected fields, and the fields driving that decision have no unfixable issues |
   | `NEEDS_REVIEW` | Proposed corrections, overall confidence < `needs_review_below`, a blocking LLM finding below `llm_block_min_confidence`, or conflicting signals (e.g. `meets_p0` flag but computed P2) |
   | `CORRECTED` | Applied corrections exist |
   | `PASS` | Otherwise |

10. **Case** (`cases.py`):
    - `record_key` = normalized post URL: lowercase host, `www.`/`m.` stripped, `twitter.com` → `x.com`, tracking params and the trailing `/` dropped.
    - The same key and source within 30 days → a new attempt on that case (FAILED → rerun, VERIFIED → `case.updated`). Otherwise create `TRG-####`.
    - Denormalize `alert_name`, `product`, `exposure_tag`, `priority`, `track`, `platform`, `issue_name`, `issue_fingerprint` and `sla_due_at` onto the case.
    - **Parity:** the same `record_key` from the other source → set both `counterpart_case_id` and emit `parity.matched{diffs}`.
11. **Outputs** (`render.py`):

    | Verdict | Output |
    |---|---|
    | PASS/CORRECTED | `clean_text` (format below). YouTube/Doodle pings → `youtube_text`/`doodle_text`. Leadership protocol → `dm_text` to `protocols.leadership.recipients` (`protocol.pinged`) |
    | FAIL | `burson_text` to the Burson on-call (`roster("burson")`) with numbered fixes. `oncall.notified{kind:bounce}` |
    | NEEDS_REVIEW | `dm_text` to the IM on shift (`roster("slrr_im")`) |
    | SUPPRESSED | Nothing posted (decision 5 default) |

12. **URGENT auto-draft** (decision 3) applies when all of these hold:
    - the verdict is PASS/CORRECTED;
    - `track ∈ escalation.auto_draft_tracks`;
    - `alert_action == EMAIL_ALERT`;
    - `ctx.gmail` is connected for the IM on shift.

    It calls `escalation.service.start_escalation(trigger="auto_urgent")` and `draft_alert_email`. The clean post then says `📨 Draft ready in <im>'s Gmail (Brand Social) · ESC-…`. If the IM's Gmail isn't connected, it says `📨 Connect Gmail in the Agent Console for auto-drafts`.

**Clean post format:**

```text
🤖 *[URGENT] [NEW] Gemini App – Users report fabricated citations* · TRG-1042
⭐ VIRAL KOF · 3,140 engagements · X · SLA 15 min (due 10:20 AM ET)
*Exposure Tag:* Product - Dangerous results (e.g. medical/legal) (P0) · *Risk:* Medical Content / Medical Misinformation
*Product:* Gemini App (+ AI Overviews) · *Author:* @handle (152K followers) · *Market:* US
*Summary:* …
*View Post:* https://x.com/…
✏️ Corrected: Exposure Tag "Product - Factual inaccuracies…" → "Product - Dangerous results…" (medical claim) · KOF: No → Yes
⚠️ Check: Long video: add the timestamp of the Google mention
👉 Suggested: 📦 PAs · ✍️ T&S · ⚖️ Civics · Auto: 🔔 leadership protocol, ▶️ YouTube Social
📨 Draft ready in im@ops.test's Gmail (Brand Social) · ESC-1207
```

## 5. Review, reverts, closing (`review.py`)

- **`review_decision`:**
  - `forward` (optionally with `fields` overrides, applied as `Correction(source=rule, applied=True)` with reason "IM") → re-run requirements, VERIFIED, clean post. Emits `review.forwarded`.
  - `bounce` → FAILED and a Burson post. Emits `review.bounced`.
  - `suppress` → SUPPRESSED. Emits `review.suppressed`.
  - Only NEEDS_REVIEW cases. The actor must be an analyst/IM, or anyone in `roster("slrr_im")`.
- **`revert_correction`:** marks `reverted_by`, restores the old value, re-runs requirements, and posts `🤖 TRG-… updated: <field> reverted to …` to the clean space. Emits `correction.reverted`. Reverted values are pinned through re-derivation (`evaluate(pinned=…)`), so derived fields (priority, KOF, engagement level, alert name, issue status) stay reverted, and later decisions use the IM's value.

## 6. IM actions: emoji legend (`actions.py`, A2)

1. Find the case (spaces may be given as an id, resource name or room URL; legend codes are case-insensitive): the first `TRG-` id in `message.text`, else `Store.find_case_by_message_ref(message_id | link)`, else a scan of recent cases' `clean_message_ref`. Unknown → reply "I couldn't match this message to an alert".
2. Idempotency key: `rx:` + message id/link + emoji + user.
3. Record an `ActionRecord`. Emit `action.recorded{code, emoji}`. The first action sets `acknowledged_at` and emits `alert.acknowledged`.

| kind | Behavior | Output |
|---|---|---|
| `ack` 👍 | Acknowledge only | none |
| `email_pa` 📦 | Start or reuse an escalation for the reactor; `draft_alert_email` (thread reply if ONGOING) | `reply_text` "📨 Draft ready in your Gmail…" |
| `tns` ✍️ | `tns.assess_and_prepare`; if urgent, also `draft_urgent_email` | `reply_text` with the pre-filled link + evidence note |
| `add_group` 📰 💬 💼 💧 1️⃣ 🦺 ⛑️ 🌎 ⚖️ 🌱 📸 | Add the group to the open alert draft, creating it if needed. Emits `email.group_added` | `reply_text` (or "no recipients configured for GCPA yet") |
| `post_space` 🔥 | Summary to `crisis_text`. Emits `protocol.pinged{protocol:crisis}` | `crisis_text` + reply |
| `dm` 🧑‍💻 | Summary DM to `recipients`. Emits `protocol.pinged{protocol:jon}` | `dm_text` |
| `close` ❌ | → CLOSED (`no_action`) | reply |
| `superseded` ⬇️ | Link to the newest later case with the same record key or fingerprint; set `superseded_by`; close | reply |
| `feedback` 👎 | `verdict_overridden_by`. Emits `verdict.overridden` | reply asking for the right value |
| `none` ➕ | Record only | none |

- 📦 on a case whose alert email was already sent replies "already sent" instead of drafting again.
- A team emoji after the alert email was sent drafts a short `group` email to just that team, replying on the alert thread.
- `email.group_added` is emitted only when recipients were actually added (not for placeholder groups such as GCPA).
- A 📦 / ✍️ / team reaction with no reactor email asks the IM to react again or use the chat fallback.
- **Phase 0 fallback** (if Studio can't trigger on reactions): `converse` intent `action`, e.g. `pa TRG-1042` or `📦 TRG-1042`, runs `record_reaction` as if the sender had reacted.

## 7. Escalation (`escalation/`, A2)

**`escalation/service.py`** (used by `triage.py` for URGENT auto-drafts):

```python
start_escalation(ctx, case, analyst_email, *, trigger, requested_by, chat_message_ref=None) -> Escalation
    # one escalation per case per mailbox: reuses the IM's open one for the case, else their most recent
draft_alert_email(ctx, esc, case, *, extra_groups=()) -> EmailState   # new thread, or reply on the ONGOING thread
add_group(ctx, esc, case, group, actor) -> EmailState                 # partial recipient update (keeps IM edits)
revise_email(ctx, esc, instruction, actor, purpose="alert") -> EmailState   # starts from the live draft text
check_sent(ctx, esc) -> list[EmailState]                             # used by run_followups
draft_note(ctx, esc, email) -> str                                   # the line triage adds to an URGENT clean post
# richer variants for chat replies: draft_alert(...), add_group_to_draft(..., via=) -> DraftOutcome
```

- Email purposes: `alert`, `tns_urgent`, `bug_followup`, `group`. `tns_urgent`, `bug_followup` and `group` bodies are deterministic templates; revisions of any purpose use `escalation.revise_email`. If Gemini fails, drafting falls back to a deterministic body.
- Every draft change appends a `DraftVersion` (`to`, `cc`, `bcc`, `body`, `instruction`), so `email.sent.versions` counts recipient changes too.
- A revision of a draft the IM deleted recreates it; a revision after sending is refused with the send time.

**Drafts:**
- Created in the acting IM's Gmail with `From: Brand Social` (`escalation.from_header`, using the configured Brand Social sender alias). The IM's Gmail must have the alias configured as send-as.
- Recipients come from `routing.plan_recipients`, placed per `escalation.recipients_in`.
- Subject: `escalation.subject_format` (the alert name).
- Body: drafted by Gemini (`escalation.draft_email`, drafting model) from the `social_alert` template guidance plus the alert fields.
- **ONGOING** issue:
  - Find `assessment.related_case_id`, then its sent alert email's `rfc822_message_id`.
  - Draft with `In-Reply-To`/`References` set and subject `Re: <original>`. This works even when another IM sent the original.
  - Set `threadId` only when the original is in this IM's mailbox.
- **Sent detection:** the draft is gone and its thread has a SENT message → SENT. Store `rfc822_message_id` (from the `Message-ID` header). Emit `email.sent{purpose, flag_to_send_s, post_to_send_s}`.
- For `purpose=alert`, also set `case.sla_met` and emit `sla.met` or `sla.missed{track, platform_tier, sent_at}`. SLA is decided once per case: only while `case.sla_met is None` and `sla_due_at` is set (`run_followups` may already have recorded the miss).
- Draft gone with no SENT message → DISCARDED.

**T&S (`escalation/tns.py`):**
- Eligibility is assessed by Gemini (`tns.assess`) against `tns.criteria` and the evidence rule (evidence of input or replicability).
- The pre-fill URL is built from `tns.fields`, with `submitter_team_option` "Marketing". The description is stamped with `tns.reference_format` so intake emails match.
- If any `urgent_when` rule matches (and the report is eligible), the agent drafts a `tns_urgent` email to `tns.urgent_alias`.
- The pre-fill link is built even when Gemini says not eligible (status `NOT_ELIGIBLE`; the IM decides). `tns.prepared` is emitted only for eligible reports.
- The link is capped at 2,600 characters so it fits a chat message; the reference stamp goes first in the description so truncation can't cut it.
- `tns.submitted` is emitted once per escalation. `outcome_regex` matches case-sensitively.
- `bug_followup` drafts reply on the original alert email thread, in the original sender's mailbox (else the IM on shift's), inside an escalation for that mailbox (see §8).

**Gmail gateway (`escalation/gmail.py`):**

```python
class GmailGateway(Protocol):
    def is_connected(self, user_email: str) -> bool: ...
    def create_draft(self, user_email, *, from_header, to, cc, bcc, subject, body,
                     in_reply_to=None, references=None, thread_id=None) -> dict  # {draft_id, message_id, thread_id}
    def update_draft(self, user_email, draft_id, **fields) -> dict      # partial: omitted fields keep their current value
    def get_draft(self, user_email, draft_id) -> dict | None           # optional: live subject/body/to/cc/bcc (IM edits)
    def draft_status(self, user_email, draft_id, thread_id, *, since=None, exclude=()) -> dict
        # {status: DRAFT|SENT|DISCARDED|UNKNOWN, rfc822_message_id?, sent_at?}; SENT = a SENT message on the
        # thread after `since` whose Message-ID isn't in `exclude`
    def send_as_agent(self, agent_email, to, subject, body) -> None   # email doorbell (agent account token)

class TokenVault(Protocol):
    def get(self, email: str) -> dict | None: ...
    def put(self, email: str, creds: dict) -> None: ...
    def delete(self, email: str) -> None: ...

def get_gmail_gateway(config) -> GmailGateway | None   # TRIAGE_GMAIL=fake|google
```

- **Scopes (IMs):** `gmail.compose` plus the read scope from `TRIAGE_GMAIL_READ_SCOPE`: `gmail.metadata` (default) or `gmail.readonly`.
  - Gmail may refuse `drafts.get(format=raw)` while gmail.metadata is granted. Revisions then start from the agent's last version instead of the IM's Gmail edits; nothing crashes.
  - The Console refuses a connection that leaves out a requested Gmail scope (granular consent).
- **Scopes (agent account):** `gmail.send`, only for the email doorbell.
- **FakeGmail** stores drafts in memory and supports `mark_sent(draft_id)` / `mark_discarded(draft_id)` for tests. `TRIAGE_GMAIL=fake` (default) → `FakeGmail(connect_all=True)`, `google` → `GoogleGmail`, `off` → None.
- **Token vaults:** `LocalTokenVault(.local/gmail_tokens.json)` for dev; `SecretManagerTokenVault` stores one secret per IM, `gmail-token-<sha256(email)[:40]>`.
- **Console OAuth helpers:** `load_oauth_client_config`, `build_oauth_flow(client_config, redirect_uri, scopes=IM_SCOPES, state=None)`, `store_credentials(vault, email, creds)`.
- Gmail tokens are never stored in Firestore.

## 8. Agent inbox (`emails.py`, A2)

`ingest_email` classifies each message and handles it:

| Email | Match | Effect | Output |
|---|---|---|---|
| WD intake (`intake_subject_regex`) | The escalation id in the body (`reference_format`), else the post URL | `tns.status=SUBMITTED`, `wd_issue_id`. Emits `tns.submitted{via:intake_email}` | `clean_text` "✍️ T&S intake confirmed: Issue N · TRG-…" |
| Outcome (`outcome_regex`, bug id via `bug_id_regex`) | The WD issue id | `tns.outcome`, `bug_id`. For **Fixed** with a bug id, draft the `bug_followup` reply on the original alert thread in the original sender's Gmail (else the IM on shift's) | `clean_text` + `dm_text` to that IM |
| Watchdog Anti-Abuse Alert (`watchdog.subject_regex`) | Skip early warnings, jailbreaks and NSFW images (`watchdog.skipped`). Extract the post link(s) | If no case has that record key, Gemini extracts alert fields from the email → `run_qa(source="watchdog")` → normal triage outputs (§4.11) | as §4.11 |
| Doorbell email (`outbox.email_subject`) | — | Flow 5 handles these, not Flow 4 | — |
| Anything else | — | `message.ignored{reason:unrecognized_email}` | none |

- Outcome emails are also recognised when the subject differs, if a known WD issue number and an outcome word appear.
- If the first WD email for an issue already carries the outcome (the intake email was missed), both the submission and the outcome are recorded.
- Watchdog cases use `source_ref = "<message_id>:<record_key>"` (one email can carry several links). Only the first new alert is returned inline; the others are queued to the outbox (one case per clean post).

## 9. Path B: in-house alerts (`inhouse.py`, A1)

`ingest_inhouse`:
1. Read up to `inhouse.max_rows_per_run` rows from `inhouse.outbox_view`, or take `payload.rows`.
2. Skip rows already seen (`find_case_by_source_ref("inhouse", alert_id)`).
3. Map columns to fields and call `run_qa(source="inhouse")`:

| Log column | Field / extra |
|---|---|
| `alert_name`, `issue_name`, `issue_status`, `priority`, `exposure_tag`, `product`, `other_products`, `social_network`, `post_url`, `post_content`, `author`, `followers`, `total_engagement`, `likes`, `comments`, `shares`, `views`, `engagement_level`, `kof_lists` | same-named fields (`sonar_summary` → `summary`, `channel_location` → `location`, `is_kof` → `kof`, `risk_tags` → `risk_tags`, `post_timestamp` → `post_date`, `ts_recommended` → `ts`) |
| `relevance_score`, `language`, `alert_track`, `alert_action`, `reason_codes`, `sensitive_topics`, `first_detected_at`, `related_alert_id` | `parsed.extra` (used by requirements and parity) |

4. **Delivery:**
   - `parity_mode`: nothing is posted to chat. In-house cases are created (no SLA timers, auto-drafts or protocol pings) and compared on the Console's Parity page, so IMs keep working from Burson-sourced alerts.
   - After cutover (`parity_mode: false`): the same outputs as §4.11, posted to the clean space.
   - When `mark_delivered`: set `delivered_at` in `alert_log_table`.
   - Multi-message ops (`ingest_inhouse`, `run_followups`) enqueue each message separately (`operations.enqueue_outputs`), so one clean post never carries two cases and DMs never mix recipients. They return summary-only outputs.
5. **Reconciliation** (in `run_followups`): cases older than 2 h with no counterpart emit `parity.unmatched{side}` once.

## 10. Conversation (`converse/`, A2)

Intents are matched by regex first, then by Gemini (`converse.intent`).

| Intent | Example | Notes |
|---|---|---|
| `revise` | `@Triage Agent revise: shorter, add the AIO 2K list` | The escalation comes from an `ESC-`/`TRG-` id in the text/thread, else the IM's latest open escalation |
| `forward` / `bounce` / `suppress` | `forward TRG-1043` · `forward TRG-1043 exposure_tag=Product - Perceived bias` · `bounce TRG-1043: dead link` | → `review_decision` |
| `revert` | `revert TRG-1043 exposure_tag` | → `revert_correction` |
| `tns_submitted` / `tns_withdraw` / `bug` | `submitted ESC-1207` · `not T&S ESC-1207` · `bug ESC-1207 b/123456789` | Manual fallbacks for the email loop |
| `status` | `status TRG-1042` | Anyone |
| `oncall_set` / `oncall_handoff` / `oncall_who` | `I'm on until 6pm ET` · `hand off to sam@agency.test` · `who's on shift?` · `who's the Burson on-call?` | Roster from the space (Burson space → `burson`, otherwise `slrr_im`) or the words used. The sender must be in that roster |
| `handover` | `handover` | → `generate_handover` for the current shift |
| `metrics` | `how many alerts were corrected today?` | Answered from `metrics.compute_kpis` |
| `teach` | `remember that Doodle questions go to the Doodle Team` | `KnowledgeFact` PENDING; DM to the admins |
| `config_change` | `from now on cc Civics on bias alerts` | `ConfigChangeProposal` PENDING (summary + JSON merge patch) |
| `action` | `pa TRG-1042` · `📦 TRG-1042` | Phase 0 fallback for reactions → `record_reaction` with that legend code |
| `decide` | `approve PROP-12` · `reject FACT-7` | Admins (proposals) and admins + leads (facts) |
| `question` | anything else | Grounded answer (below) |

- **Burson space:** internal commands are refused (`revise`, `forward`, `bounce`, `suppress`, `revert`, `tns_*`, `bug`, `handover`, `config_change`, `decide`, `action`). Answers there never include recipient emails, and `status` shows only the case lines.
- **External audience:** the Burson space, or a sender on the Burson roster (`org: burson`) anywhere, DMs included. Same restrictions; answers are redacted (case lines only, no emails).
- **Roster commands:** words decide the roster ("Burson", "IM", "shift"), then the space; an agency member's "I'm on until 6pm" means the Burson roster.
- `revert` accepts field labels (`revert TRG-1042 exposure tag`).
- Regex intents with side effects (config changes, roster changes, handovers, bug outcomes) only match explicit command phrasings; anything else goes to Gemini (`converse.intent`).
- **Sign-in phrasings** (`oncall_set`): `I'm on call/shift/duty/alerts …`, `covering …`, `signing in …`, `taking over …` with the time window anywhere after; a bare `I'm on` counts only at the end of the message (the agent asks "Until when?") or right before the window (`I'm on until 6pm`). A lone `to` is not a time connector (`from 12 to 6` and `2pm to 6pm` are). So `I'm on it, will loop back to you by 5pm` is a question, not a roster change.
- **Sender identity for roster commands** (`roster.person_for_sender`): the sender's email decides when it is known; the display name is consulted only when Studio exposed no email (external members). A display name never grants membership to a different account.
- **Passive sign-in** (`handler.try_passive_shift_signin`, called by `triage_message` for non-alert messages): same phrasing rule, mention/apostrophe normalisation (`strip_mention`), and only the space's own roster, i.e. `burson` in the Burson space. Recorded as `oncall.override_set{via: chat}`; no reply is posted.

**Questions:**
- Grounding: approved facts, FAQ, the Collection Requirements and distribution config, the stakeholder directory, live case/escalation data and metrics, then Vertex AI Search if configured.
- Answers cite sources and say "I don't know" rather than guess.
- **The alert a thread is about** (`handler.case_for_thread`): a question in an alert's thread is answered with that alert in CONTEXT (`answer.alert_context`, label `[This alert]`, source `live:<case id>`), as the sheet-based bot answered (Voice.gs `answerPrompts_` / `answerAnalystPrompts_`). The thread is matched to the alert's own message in the source space (the attempt's `thread_id` or `message_id`), its post for the analysts (`clean_message_ref`), or its copy in the second or third space (`relay_threads`). An id typed in the question wins; a caller that knows the alert passes `payload.case_id`. For analysts: the alert's values, what the review corrected or proposes, what Burson was asked to fix, why it needs a person, and its escalations and actions. For Burson: only the fixes it was asked for, what was corrected, the alert's values and where it stands in plain words (`answer.burson_status_lines`, never who works on it, never a draft's details or a case id).
- **Answers for Burson** (the Burson space, or a Burson roster member anywhere): warm, 1 to 5 short lines, no source labels in brackets, nothing about how alerts are handled behind the scenes. An answer the leak guard holds (`safety.leak_guard`) is replaced by the fixed answer (`answer.safe_answer`, Voice.gs `fallbackAnswer_`: what needs fixing, else where the alert stands, else an offer to help) and the reply's `data.held_back` names what it held. When Gemini does not answer, Burson gets the same fixed answer, never a bare "I don't know". The answer is never held back in silence.
- `payload.in_thread: true` (chatanswers): the caller posts the reply itself under the message, through the bot's own Chat sign-in. A reply in the Burson space then stays `reply_text` (not `burson_text`) and names nobody (no address is put in front of it), as the sheet-based bot's answers did; the caller follows the Routing page's rules for that space.
- Stakeholder routing follows `autonomy`: `answer_only` and `notify_with_approval` emit `route.forwarded`; `auto_notify` DMs the contacts and emits `route.relayed`.

## 11. Jobs (`followups.py`, A1)

`run_followups` runs every minute (Cloud Scheduler → Cloud Run job, `deliver="outbox"`) and does the following each run:

1. **SLA risk:** a VERIFIED, unacknowledged case past `sla_warn_fraction` of its SLA → DM the IM on shift. Emits `sla.at_risk`. Repeats once at 100%, to the IM + `team_text`.
2. **Review reminders:** NEEDS_REVIEW undecided for `review_reminder_min` → remind the IM, then the leads.
3. **Burson bounces:** FAILED cases follow the Burson roster's `ReminderPolicy` (reping → backup → IM notice) and are abandoned after `max_correction_wait_min`.
4. **Sent detection** for open escalations (`escalation.service.check_sent`). An unsent alert email past its SLA emits `sla.missed` once.
5. **Burson digest:** once a day at `burson_feedback.digest_hour_local` (`mode=digest`), corrections by field with examples → `burson_text`. Emits `burson.digest_posted`.
6. **Handover:** when a shift ended `handover.minutes_after_shift_end` ago and isn't done yet (kv `handover:<date>:<shift>`), produce `generate_handover`'s outputs.
7. **Parity reconciliation** (§9).
8. **Re-ring** stale outbox items (`outbox.rering_stale`).

`generate_handover`:
- Summarizes the shift: alerts by verdict, open escalations, unsent drafts, pending T&S, reviews waiting, SLA misses, notable issues.
- Writes it to `team_text` and `handover_text`. Emits `handover.posted`.

## 12. Reserved LLM purposes (`FakeLLM.on(...)`)

`triage.parse_fallback` · `triage.assess` · `watchdog.extract` · `escalation.draft_email` · `escalation.revise_email` · `tns.assess` · `converse.intent` · `converse.answer` · `converse.teach` · `handover.summary`

Response schemas are pydantic models next to the code that uses them.

## 13. Studio integration (C)

**Custom steps** (one Apps Script add-on). Every step also takes `targets`, a design-time constant listing the flow's post steps, and returns all 23 outputs as STRING.

| Step | op | Inputs |
|---|---|---|
| Triage Agent: Triage alert | `triage_message` | `message_text`*, `sender_name`, `sender_email`, `space`, `message_id`, `message_link`, `thread_id`, `sent_at` |
| Triage Agent: Record reaction | `record_reaction` | `emoji`*, `reactor_email`*, `reactor_name`, `message_text`, `message_id`, `message_link`, `space` |
| Triage Agent: Converse | `converse` | `message_text`*, `sender_name`, `sender_email`*, `space`, `conversation_type`, `message_id`, `message_link`, `thread_id` |
| Triage Agent: Ingest email | `ingest_email` | `subject`*, `from`, `to`, `cc`, `body`*, `message_id`, `thread_id`, `received_at`, `link` |
| Triage Agent: Deliver outbox | `drain_outbox` | (none) |
| Triage Agent: Record post | `record_post` | `case_id`*, `message_id`, `message_link` |
| Triage Agent: Inspect variables (Phase 0) | (none; logs) | `var1` … `var8` |

\*required

**Flows** (owned by the Triage Agent account; ≤ 20 steps each):

| # | Flow | Starter | Step | Check-if blocks (targets) |
|---|---|---|---|---|
| 1 | Burson alerts | When I get a chat message (Burson space) | Triage alert | burson, clean, dm, youtube, doodle |
| 2 | IM actions | When an emoji reaction is added (clean space, legend emojis) | Record reaction | reply, dm, crisis |
| 3a | Mentions | When I'm mentioned (clean, team, Burson spaces) | Converse | reply, burson, dm |
| 3b | DMs | When I get a chat message (direct messages) | Converse | reply, dm |
| 4 | Agent inbox | When I get an email (WD intake / Watchdog filters) | Ingest email | clean, dm, youtube, doodle |
| 5 | Outbox | When a sheet changes (Agent Outbox Sheet), or the doorbell email | Deliver outbox | burson, clean, dm, youtube, doodle, team, crisis, handover |

**Calling the agent:**
- Script Properties: `AGENT_ENGINE_RESOURCE` (`projects/<p>/locations/<region>/reasoningEngines/<id>`) and `TRIAGE_ENV`.
- Request: `POST https://<region>-aiplatform.googleapis.com/v1/<AGENT_ENGINE_RESOURCE>:query`
- Body: `{"class_method":"query","input":{"op":…,"payload":…,"context":{…}}}`
- Auth: `ScriptApp.getOAuthToken()` with the `cloud-platform` scope. The Triage Agent account needs `roles/aiplatform.user`.
- The response is wrapped in `{"output": OperationResponse}`.

## 14. Agent Runtime app (A1)

- `triage_agent.agent_engine_app.TriageAgentApp`
- `set_up()` builds an `AgentContext` from env (`TRIAGE_BACKEND=gcp`).
- `query(*, op, payload=None, context=None) -> dict` returns `OperationResponse.model_dump(mode="json")`.
- Deployed with Python **3.12**, so code must stay 3.12-compatible.
- Deployed from source files by `infra/05_deploy_agent_engine.py`: `agentplatform.Client(...).runtimes.create|update(config=…)`
  with `source_packages=[triage_agent, config, requirements.txt]`, `entrypoint_module="triage_agent.agent_engine_app"`,
  `entrypoint_object="root_agent"`, `class_methods=[query]`, the runtime service account and the env vars from §2.
  `--smoke` calls `op=health` through `:query`, exactly like the add-on.

## 15. Events (BigQuery `agent_events`; columns = `models.AgentEvent`)

- Partitioned by `DATE(event_ts)`, clustered by `event_type, case_id`.
- `payload` is JSON.
- KPIs are defined in `metrics.py` (`KPI_DEFINITIONS`); `analytics/02_metric_views.sql` mirrors them.

| event_type | Required fields / payload |
|---|---|
| `alert.received` | `case_id`, `attempt`, `message_ref`, payload `{source, record_key, sender, detect_latency_s?}` |
| `triage.passed` / `triage.corrected` | `case_id`, `attempt`, `verdict`, `latency_ms`, `model`, payload `{first_pass, confidence, track, priority, after_bounce?, time_to_correction_s?, fields? (corrected)}` |
| `triage.suppressed` | `case_id`, payload `{reason, reason_codes, track?}` |
| `triage.failed` | `case_id`, `attempt`, `error_codes`, payload `{oncall_email, oncall_source, issues}` |
| `triage.needs_review` | `case_id`, `attempt`, `error_codes`, payload `{confidence, reasons, im_email}` |
| `correction.applied` / `correction.proposed` / `correction.reverted` | `case_id`, payload `{field, old, new, confidence, source}` (`actor` for reverted) |
| `review.forwarded` / `review.bounced` / `review.suppressed` | `case_id`, `actor`, payload `{reason?, via: chat\|console}` |
| `case.updated` / `case.closed` / `case.abandoned` | `case_id`, payload `{reason, …}` |
| `oncall.notified` | `case_id`, payload `{kind, to_email, roster}` |
| `alert.acknowledged` | `case_id`, `actor`, payload `{ack_latency_s}` |
| `action.recorded` | `case_id`, `actor`, payload `{code, emoji, kind, escalation_id?}` |
| `sla.at_risk` / `sla.met` / `sla.missed` | `case_id`, payload `{track, platform_tier, sla_minutes, due_at}` |
| `protocol.pinged` | `case_id`, payload `{protocol: youtube\|doodle\|leadership\|crisis\|jon, mode?}` |
| `escalation.started` | `escalation_id`, `case_id`, `actor`, payload `{trigger, analyst_email}` |
| `email.drafted` / `email.redrafted` | `escalation_id`, payload `{purpose, version, to, cc, bcc, groups, thread_reply, llm}` (`to`/`cc`/`bcc` are counts) |
| `email.group_added` | `escalation_id`, payload `{group, via}` |
| `email.revision_requested` | `escalation_id`, payload `{purpose, instruction}` |
| `email.sent` | `escalation_id`, payload `{purpose, flag_to_send_s, post_to_send_s?, versions}` (speed KPIs count `purpose=alert` only) |
| `email.discarded` / `email.failed` | `escalation_id`, payload `{purpose, reason, error?}` |
| `tns.assessed` / `tns.prepared` / `tns.not_eligible` | `escalation_id`, payload `{eligible, urgent, category, criteria_ids, evidence}` |
| `tns.submitted` / `tns.withdrawn` | `escalation_id`, `actor`, payload `{via, wd_issue_id?}` |
| `tns.outcome` | `escalation_id`, payload `{outcome, bug_id?, wd_issue_id}` |
| `watchdog.received` / `watchdog.skipped` | payload `{subject, reason?, links}` |
| `parity.matched` / `parity.unmatched` | `case_id`, payload `{counterpart_case_id?, diffs?: {field: [burson, inhouse]}, side?: burson_only\|inhouse_only}` |
| `qa.answered` / `qa.feedback` | `actor`, `space`, payload `{intent, grounded, sources}` / `{rating}` |
| `route.forwarded` / `route.relayed` | payload `{stakeholder_id, team, mode}` |
| `oncall.override_set` / `roster.updated` | `actor`, payload `{roster, person_id?, start?, end?, via}` |
| `burson.digest_posted` / `handover.posted` / `outbox.delivered` | payload `{…counts}` |
| `config.*` / `knowledge.*` | `actor`, payload `{section? / id}` |
| `message.ignored` / `error` | payload `{reason}` / `{op, error, retryable, nested_in?}` |

## 16. State (Store)

**Collections:** `cases`, `escalations`, `idempotency`, `claims` (short-lived delivery claims), `counters`, `kv`, `config/current`, `config_history`, `roster/{slrr_im|burson}`, `proposals`, `facts`, `outbox`

**Firestore composite indexes:**
- `cases(record_key ASC, updated_at DESC)` and `cases(record_key, source, updated_at DESC)`
- `cases(status ASC, updated_at DESC)`, `cases(exposure_tag, updated_at DESC)`, `cases(source, source_ref)`
- `escalations(case_id ASC, updated_at DESC)`, `escalations(analyst_email ASC, updated_at DESC)`
- `outbox(delivered_at ASC, created_at ASC)`
- `cases.clean_message_key` equality lookups use Firestore's automatic single-field index (no composite needed).

## 17. Agent Console API (FastAPI, `console/backend`, B)

**Auth:**
- Behind IAP, the user is taken from `X-Goog-Authenticated-User-Email` (prefix stripped). With `TRIAGE_IAP_AUDIENCE` set, the signed `X-Goog-IAP-JWT-Assertion` is verified instead. **With `TRIAGE_BACKEND=gcp` the plain header is refused (401) unless the audience is set** — fail closed. Locally it is `TRIAGE_DEV_USER`.
- Roles come from `config.analysts` (`admin` | `lead` | `analyst` | `im`; `im` ranks as `analyst`). People in `roster("slrr_im")` act as analysts. Any other `@google.com` user is read-only.
- Only `GET /api/health` is unauthenticated.

**Endpoints:**
- `GET /api/me`
- Metrics:
  - `GET /api/kpis?days=7` → `compute_kpis(events, config)` + `KPI_DEFINITIONS`
  - `GET /api/timeseries?days=30&bucket=day`
  - `GET /api/errors?days=7`
  - `GET /api/failures-by-oncall?days=7`
- Dashboard and live views (`console/backend/live.py`, `triage_agent/metrics.py`):
  - `GET /api/dashboard?range=hour|today|24h|7d|30d|custom&from=&to=&filters=` → `kpis`, `derived`, `previous`, `series`, `now`, `extra`,
    `alert_lines`, `filtered`. `filters` is a JSON object of dimension → values picked: `product`, `social_network`, `exposure_tag`,
    `sensitive_topic`, `kof`, `kof_list`, `sentiment`, `verdict`, `source` (`metrics.ALERT_DIMENSIONS`). Several values in one dimension
    match any of them; different dimensions must all hold. An unknown dimension, more than 100 values or a value over 300 characters is a
    422. Custom `from`/`to` without a zone are in the display timezone.
  - `alert_lines` (`metrics.alert_view`): `total_messages` (alert messages in the range that match: each Burson message on an alert counts
    once, the first one, a rerun, an engagement update; an IM's re-assessment is not a message), `total_alerts`, `new_alerts` (first message
    in the range), `previous_messages` (same filters, the period before), `breakdowns[dim]` (the top 12 `{value, label, count}` and a
    `more` row), `options[dim]` (every value the taxonomy knows plus the ones seen, each counted with the other filters applied),
    `dimensions`, `capped`, and `response_times`: `{key, label, description, of, avg_s, median_s, n, recorded_from?}` for `agent_review`
    (the alert's first decision event), `im_response` (`acknowledged_at`, an IM's `review.at`, their first action), `burson_fix` (the first
    passing message after a FAIL), `email_draft` (`email.drafted`, purpose alert), `email_sent` (`email.sent`, the send time from
    `post_to_send_s`) and `tns_submitted` (`tns.submitted`). Each runs from the alert's first message, over the alerts that first arrived
    in the range and got to that step. For a range that ended in the past, steps up to 14 days after it still count.
  - Values carry the taxonomy's names: products through `distribution.product` (the product and `other_products`), the exposure tag through
    `collection.tag`, Sensitive Topics from the assessment's `risk_topics` (else the alert's `risk_tags`) through `collection.topic`, the
    network from the template's allowed list (anything else is `Other`), KOF from `is_kof` and `kof_lists`. Blank lines are `Not given`
    (`None` for a topic line of `-`). Sentiment is Gemini's story-read label (`story_reads` docs, `labels`); blank = not rated.
  - With filters on, `kpis`, `previous` and `series` count only the events of the alerts in view (events that belong to no alert are left
    out). `now` is never filtered.
  - Alert facts are kept per Console process (`live.AlertIndex`): the first request for a range reads `store.list_cases(since=)` once (at
    most 20,000, `capped` says when more were left out); later requests read only the cases updated since (every 10 seconds, or at once
    after this process writes an event).
  - `GET /api/live/feed?since=&limit=` and `GET /api/live/stream` (server-sent events `events` and `now`) feed the header bell and the
    alert pop-ups. The bell keeps what was read in the browser (`localStorage`).
- Activity: `GET /api/activity?limit=&type=&case_id=&escalation_id=`
- Cases:
  - `GET /api/cases?status=&source=&track=&limit=`
  - `GET /api/cases/{id}` (case + events + escalations)
  - Every case summary (`serializers.case_summary`: case lists, the Review feed, a story's alerts) also says two things in plain words:
    `review_reasons_plain` (the `review_reasons`, one sentence each: field labels for field keys, words for codes) and
    `suppression_label` (`suppression_reason` in words; `null` when there is none). The codes stay as they were.
- Suppressed: `GET /api/suppressed?days=7` (case list + reasons). Each case has `reason_label`, and each count in `reasons` /
  `event_reasons` has `label`: the reason in words (`serializers.SUPPRESSION_LABELS`, the same words as the Console's).
- Review queue:
  - `GET /api/review-queue`
  - `POST /api/review-queue/{case_id}` `{decision, reason?, fields?}` → `handle(review_decision, deliver=outbox)`
- `POST /api/cases/{id}/revert` `{field}` → `revert_correction`
- `POST /api/cases/{id}/close` `{reason}` → `close_case`
- Parity: `GET /api/parity?days=14` (matched / Burson-only / in-house-only, field disagreement counts)
- Rosters:
  - `GET /api/rosters/{name}`
  - `PUT /api/rosters/{name}`
  - `POST /api/rosters/{name}/overrides`
  - `DELETE /api/rosters/{name}/overrides/{id}`
  - `GET /api/rosters/{name}/schedule?days=7`
  - `GET /api/oncall/now` (both rosters)
- Settings:
  - `GET /api/settings`
  - `PUT /api/settings/{section}` for any top-level `AgentConfig` key except `version`/`env`
  - Validate with `AgentConfig`, then `store.save_config_overrides` and emit `config.updated`
  - `GET /api/settings/history`
  - `GET /api/settings/available-models[?refresh=true]` (viewers; `refresh` reads the list again now, admins only;
    `console/backend/model_catalog.py`): the Gemini models every model setting picks from. Read from Vertex AI's catalogue of
    Google's models through the agent's own Gemini client (`triage_agent/llm.py`) in the location it calls Gemini in, kept for an
    hour. Left out: models for other jobs (speech, pictures, video, live audio), experiments and dated previews, the retired
    generations (1.0, 1.5, 2.0) and anything the catalogue marks retired. Answer: `{source: vertex|fallback, project, location,
    fetched_at, error, text: [choice], embedding: [choice], fields, technical?}`; a choice is `{name, label, description, preview,
    in_use: [what uses it]}`; `fields` maps each model setting (`models.triage`, `platform.chat_agent.model`, ...,
    `prompts.<purpose>`) to `{kind: text|embedding|none, label, blank, default, follows, none_label}`: the list it picks from,
    whether blank means the default, the model the default uses and the setting it follows. `kind: none` marks settings named
    model that name no Vertex AI model (Gemini Decisions, the forecast). With `source: fallback` (offline, refused, slow) the
    lists are every model the settings and their defaults name plus a few known to work, and `error` says why in plain words;
    `technical` (admins) holds Google's own words. Its path has a hyphen so it never clashes with a section's name.
- Escalations and outbox:
  - `GET /api/escalations?open_only=`
  - `GET /api/outbox?undelivered_only=`
- Gmail:
  - `GET /api/gmail/connect` (OAuth consent, offline access)
  - `GET /api/gmail/callback`
  - `GET /api/gmail/status`
  - `DELETE /api/gmail`
- Learning:
  - `GET /api/proposals`
  - `POST /api/proposals/{id}`
  - `GET /api/facts`
  - `POST /api/facts/{id}`
- Live Test Channel (runs the real operations against the real store; **never posts to Chat**):
  - `POST /api/test/push` `{text, channel: test_burson|clean_chat, sender_email?, sender_name?}` → `triage_message` / `converse` with the configured space ids (`config.space("burson"|"clean")`).
  - `POST /api/test/react` `{case_id, emoji}` → `record_reaction` **as the signed-in user** (never as the IM on shift: drafts land in the reactor's Gmail).
  - Gate: analysts in `dev`; **admins only when `env == "prod"`**.
- Chat app (experimental; pending the Phase 0 decision on Studio flows vs. a Chat app):
  - `POST /api/chat-webhook`: Google Chat app HTTP endpoint. MESSAGE → `triage_message` (if `parser.detect` says alert) else `converse`; REACTION → `record_reaction`.
  - Enabled only with `TRIAGE_CHAT_APP_AUDIENCE`; requires the bearer token Google Chat issues (`chat@system.gserviceaccount.com`, verified against that audience); a message with no sender email is rejected (400). Otherwise 404 / 401.

## 17a. Platform (Console-managed)

**Settings.** `AgentConfig.platform` (`PlatformConfig`): `flags`, `access`, `gcp`, `safety`, `pubsub`, `bigquery`, `forecasting`, `chat_agent`,
`classification`, `knowledge`, `temp_check`, `campaigns`, `costs`, `telemetry`. No YAML holds them; defaults are in the models, values in the
store's overrides, edited per part through `GET/PUT /api/platform/{part}`. Every flag defaults to `False`. Agent Runtime, jobs, worker and
Console re-read overrides within 5 seconds.

**Stories** (`stories.py`, settings `platform.stories`): alerts are placed on stories by the Chat bot's same-story rules (story text,
identifier clash, `same_story_similarity`, `gray_similarity` with the same tag and product, word likeness without vectors, `keep_days`).
Collections `stories`, `story_members` (case id to story), `story_vectors` (removed past `keep_days`). `stories.refresh` runs on
`GET /api/stories` and in the once-a-minute tick. `GET /api/stories?hours=` returns each story's size, status (`new`, `growing`, `quiet`),
smaller stories, per-alert points and hourly running totals; `GET /api/stories/{id}` adds its alerts and Chat messages. A point is
`{t, e, s, id, a, m}`: when the alert came in, its engagement, its smaller story, its case, its post's author (the account; `""` when
not known) and its sentiment label. The map's time slider counts alerts, stories and accounts from them.

**Compare, Admin, Integrations:** `GET /api/compare?days=` (four sections of `{key, label, value, unit, note, previous}`),
`GET /api/admin/overview` (leads), `PUT|DELETE /api/admin/people/{email}` (admins; audit `people.save`, `people.remove`),
`GET /api/connections`, `PUT|DELETE /api/connections/{key}`, `POST /api/connections/{key}/test`, `GET /api/connections/{key}/options?field=`,
`POST /api/connections/autofill` (admins; audit `connection.*`). A connection writes only its own fields, through the same overrides as
Settings. A check's result is kept in kv `connection:test:<key>` with a fingerprint of the values and dropped when they change.
`GET /api/meta` carries `notifications` for the pop-ups. The tick records kv `tick:last`.

**QA evaluations and lessons** (`qa_evals.py`, `lessons.py`, collection `qa_evals`): `POST /api/qa-evals` keeps one evaluation per alert
(`subject_type` `case` | `agent_alert`). The first evaluator owns it: their next submit revises the same record (`revision`, `first_at`,
`history`), anyone else gets `409`; `GET /api/qa-evals/subject` and `GET /api/workspace/{case}` carry `standing {evaluator, eval_id, mine,
can_submit}`. Each lesson is a `KnowledgeFact` with `scope` (`alert_review` | `agent_alerts`) and, when checked, `check {result: clear | same |
conflict | unchecked, against[{ref, title, kind, why}], read{lessons, passages, documents, documents_kept}}`. Flag `lessons_auto_apply` off:
it stays `PENDING` for a lead. On: `lessons.check` compares it with the lessons in use of its scope (same words, in Python), then hands
Gemini (`lessons.check`) those lessons and the knowledge passages nearest to it (every document when they fit in 48,000 characters, else up
to 24 passages, however far: `retrieve(min_score=0)`), and Gemini must answer `finding: nothing_against | goes_against` with the labels it
goes against. `clear` approves it at once (`decided_by` "the contradiction check"); anything else leaves it `PENDING`: a conflict, no
answer, an answer without `finding`, `goes_against` naming nothing, a label Gemini was not shown, documents kept but none handed over
(`unchecked`). `read` counts what was actually put in the prompt. With no document and no lesson in use nothing is asked and it is `clear`.
The check compares with the nearest passages, not every line of every document. `APPROVED` lessons are read by `triage.assess` as guidance
passages (`checks_run` gets `lessons`; no flag, and without `knowledge_rag`), by `own.review` as lines with its precedents, and by chat
answers. `POST /api/facts/{id}` `withdraw` takes an `APPROVED` fact out of use (leads); `approve` / `reject` still decide a `PENDING` one once.

**Sending from the Console** (flag `console_send_email`, default off): `POST /api/workspace/{case}/email/send` takes the composer's email
(`subject, to, cc, bcc, html`), saves it as `PUT …/email` does, then calls `SafeGmail.send_draft(user, draft_id, **whole email)`, which
writes the whole email to the draft once more under the recipient rules (`_apply`: allowed domains, Testing stand-ins) and calls
`users.drafts.send` straight after, so a draft changed in Gmail is never what goes out. It refuses (`409`) with the flag off, with Testing
on and no Testing recipient, with no recipient left, and for an email already sent. The gateway refuses on its own with the flag off. The
send is then read back like a send from Gmail (`_refresh` / `_mark_sent`: `email.sent`, SLA, `alert_email_message_ids`); audit `email.send`.

**Usage tracking** (settings `platform.analytics`, the Console only): `gtm_container` is a Google Tag Manager container id
(`GTM-XXXXXXX`, nothing else is accepted) or `""`, the default, for no tracking. `GET /api/meta` carries it as
`analytics.gtm_container`. The browser (`console/frontend/src/lib/analytics.ts`) never loads the container into the Console's own page:
a tag reads the address, the clicks and the forms of the page it is on. It loads it once into `GET /api/usage-frame`, a blank page with no
script of its own, kept out of sight with no referrer, the first time a tracked page is opened, and tells it each tracked page opened as a
`page_view` (`page_location` = the Console's origin + the route's shape, e.g. `/feed/:alert`; `page_title` = the page's name) and a
`console_page_view` data layer event (`page_name`, `page_path`, `page_section`). An alert's number, a search and the person signed in are
never sent. Not tracked: Settings, People & Admin, Integrations, Routing, AI, Welcome. Time on a page is not measured. A change to the
setting applies at each person's next load of the Console.

**The bot's replies and threads** (plan 6, step 1.2): a queued post may carry `thread` (`OutboxItem.thread`), the Chat thread it answers.
When an operation was handed a message from the Routing page's source space, its post for that space carries the message's thread, and
`chatdelivery` and `mirror.send` post into it. While the source space is closed (the Safety valve, or a second space set) such a post is held
as before and never queued; with a second space set, `safety.guard_outputs` also hands it to `mirror.reply_in_copies`, and the minute run
posts it under the alert's copy in the second and third spaces (docs `relay_own`, audit `routing.reply_copied`, `GET /api/routing` `replies`,
the held entry's `copied_to`). A reply that names something internal is not shown there. One whose alert was never copied is given up after
a day and never posted on its own.

**Mentions answered in Chat** (plan 6, step 1.3; switch `chat_answers`, OFF by default; `triage_agent/chatanswers.py`): in the tick, after
`chat_review`, the QA chatbot's account reads the Routing page's three spaces and the agent's spaces listed in `routing.answer_spaces`. A
person's message that mentions it (a Chat `USER_MENTION` of the account, or `@` and the agent's name typed out) is handed once to op `converse` with `deliver: outbox`, `in_thread: true` and the alert its thread is about (`case_id`, when it is one), and `reply_text` is posted in that message's thread. In the source space
the reply goes through `mirror.send`: posted, left for Send, or held and shown under the alert's copy (`mirror.reply_in_copies`). While
Burson is to hear nothing (`burson_feedback.silent_in_burson_space`, or `TRIAGE_STEALTH_BURSON`) and the source space is the agent's
`burson` space, the reply is never written there: it is held and shown under the copy only. Apps and the bot's own posts (its client ids,
its record of its posts, text that starts with the agent's prefix, or its copy of someone's message, "Name (Burson): ...")
are never answered.
- **The person the bot's account belongs to** may ask too, as with the sheet-based bot: at most 3 answers a thread in 15 minutes for messages
  from the bot's own account (kv `chat_answers:self`, Bot.gs `selfAnswerOk_`); the next is kept as `ignored` with the reason. Their row's
  `asker` is `agent.email`; the operation is handed no address for them.
- **Questions without a mention** (switch `chat_questions`, "Answer questions without a mention", OFF by default; `triage_agent/chatrules.py`,
  the sheet-based bot's rules): in the source space, a question (a `?`, or a first word such as why, how, what, can, is) or, in an alert's
  thread, a follow-up that names an alert field (tag, product, priority, status, link, escalation...); in the other spaces, a question that is
  not a short reply ("ok", "thanks", "will fix", an emoji) or, in a thread, a follow-up about the alert or the next steps; and "temp check
  ..." in a space only Google people read, while temp checks are ON. Rows carry `how: mention | question | campaign`; audit summaries say
  "a mention" or "a question".
- **Never answered:** a message that mentions someone and not the bot, and an alert a person pasted (`parser.detect`), even one that mentions
  the bot.
- **The campaigns assistant** (CampaignHandoff.gs): in the second space, with switch `campaign_handoff` ("Hand threads to the campaigns
  assistant", OFF by default) and the campaigns database set (Settings → Campaigns), a person's thread reply that asks for a Brandwatch deep
  dive or an alert campaign (`chatrules.campaign_ask`; a "maybe" is judged by Gemini, purpose `chat.campaign_route`) hands the thread over:
  a `thread_ownership` record in the campaigns database (document id `chatrules.ownership_id(thread)`, fields `space, thread, requester,
  source_message, source_text, alert_text, created_at, handled_initial: false`), then "Campaign assistant now owns this thread and will reply
  shortly." in the thread. The row is `answered` with why "Handed this thread to the campaigns assistant.", audit `chat.campaign_handoff`,
  `answers.last_run.handed_off`. Whatever the switch, a thread with a `thread_ownership` record is never answered.
- The asker's address comes from asking Chat, once per space, which roster addresses are members;
someone not on the rosters is answered with no address. Docs `chat_answers` (status `answered | queued | held | ignored | failed |
gave_up`, plus `how` and `case_id`), audit `chat.answer`, `GET /api/routing` `answers` (with `questions` and `handoff`: the two switches).
The account's own Chat user id is the sender of any post it made (kv
`chat:me`), else asked with `spaces.members.get` by address, under both name forms, as the sheet-based bot does; a failed lookup is asked
again the next minute. A reply Chat does not take is tried again each minute, up to
`routing.max_tries`; the operation is not run again. A space that cannot be read is named in `answers.last_run.error` and does not stop
the others.

**Incident reports and the calendar** (plan 7, phases 1 and 2; switch `incident_reports`, OFF by default; `triage_agent/reports.py`,
`triage_agent/incidents.py`): `reports.timeline` and `reports.build` read the event log (`agent_events`) and write nothing. An incident
report is one doc (`incidents`, id = the alert's id): name, start (the alert's arrival), end (its close), status `open | closed`, notes
`[{id, by, at, text}]`. With the switch ON the tick opens one for each alert with an escalation event (`escalation.started`, `email.drafted`,
`email.sent`, `tns.prepared`, `tns.submitted`) since the last pass and keeps the open ones up to date; a person opens one for any alert with
the switch ON or OFF. A note is never rewritten or dropped. `GET /api/calendar?start&end` (events `{kind: incident, id, title, start, end,
open, priority, notes}`, at most `reports.max_days`), `GET /api/incidents/{id}` (facts, sections `Arrival and review | Response |
Escalation | Outcome`, notes), `POST /api/incidents {case_id}` and `POST /api/incidents/{id}/notes {text}` (analysts; audit `incident.open`,
`incident.note`). Removed `reports.keep_days` after the last activity.

**The handover in the Console** (plan 7, phase 3; `triage_agent/handovers.py`): when a shift ends, `run_followups` posts the handover to
the team space as before and keeps it as one doc (`handovers`, id = the shift's end and name): `shift`, `start`, `end`, `made_at`,
`made_by`, `text` (what was posted), `notes`. `handover.append_to_doc` is now false in `config/default_config.yaml`: the Handover doc is
written only where that is turned on. `POST /api/handovers` (analysts) makes the handover of the shift that ended last, once, through the
same queue, and marks it done for the scheduled run. `GET /api/handovers`, `GET /api/handovers/{id}` (adds the shift read from the event
log: `numbers`, `alerts` with timelines, `incidents`), `POST /api/handovers/{id}/notes`. `GET /api/calendar` also returns each handover as
`{kind: handover}` over its shift. Audit `handover.make`, `handover.note`. Removed `reports.keep_days` after it was made.

**A table waiting for access** (`bq_admin.no_access`): BigQuery's answer `Access Denied: Table|Dataset ...` means the table's owners have
not let the runtime account read it yet. It is waiting, not failing. On Integrations its check line carries `waiting: true` and `grant`, the
tool's `ok` and state leave waiting lines out, and `grants` holds one statement a dataset, each led by a `--` comment naming the tables it
is for. Early Detection (`sources[].status = "waiting"`, `check().waiting`), Watches (`watch_sources.status = "waiting"`, no try counted) and
Agent alerts (`sources[].status = "waiting"`, `cycle.run().waiting`, `own.cycle` payload `waiting`) skip the table without failing the read,
the run or the job, keep its cursor, and read it once access arrives. `POST /api/ai/bigquery/check` marks such steps `waiting` and does not
fail over them. Every other refusal (quota, billing, an organisation's policy, the account's own project, a connection) stays a failure.

**Chat as the QA chatbot's account** (`chatapi.py`, `console/backend/chat_signin.py`): the Console calls the Chat REST API with the sign-in
of the account in `agent.email`, as the sheet-based bot does (no Chat app, no webhooks). `GET /api/chat-signin`, `GET /api/chat-signin/connect`
(admins; Google returns to `/api/gmail/callback`, shared with Gmail), `DELETE /api/chat-signin`. Scopes: the sheet-based bot's five `chat.*`
scopes. A token is kept only for that account and only when every scope was granted, in the token vault under `chat:<email>`. The Google Chat
check reads each space and its latest message with it.

**Operations** (`platform_ops.py`): `record_assessment {case_id, agree, verdict?, fields?, note?, actor}`, `run_temp_check {issue?, boolean?,
query_ref?, filters?, draft_query?, case_id?, hours?, update_of?, keep_refreshed_hours?, actor}`, `run_forecast {force?}`, `refresh_knowledge {}`,
`run_watches {}`. From Chat an assessment needs an analyst or IM; a Console call was already checked against the person's role.

**Knowledge** (`knowledge.py`, `knowledge_import.py`, `sheet_read.py`; page Knowledge). `GET /api/knowledge` (`can_edit` leads,
`can_import` admins), `GET /api/knowledge/{id}`, `POST /api/knowledge/search`; `POST /api/knowledge`, `POST /api/knowledge/upload`,
`DELETE /api/knowledge/{id}` and `POST /api/knowledge/{id}/refresh` (leads; reads it again whatever the stored copy says).
`POST /api/knowledge/import-sheet {dry_run = true, budget_chars = 400000}` (admins) brings the sheet-based bot's documents over: the
sheet (`SLRR_STORE_SHEET_ID`, else the live control sheet) is read read-only with the Console's own account (`spreadsheets.readonly`;
`x-goog-user-project` only for a person's sign-in). Each Resources row (Name, Link, What it covers, Burson can see it?) becomes a
document with the text of the freshest copy the sheet keeps (`Knowledge cache (bot)`, else the older `Knowledge` tab; Link · Part ·
Text, part 0 JSON), `source_type` drive (url for any other link) and its link, `imported_from: "sheet"`, `import_key` (the link
without its decorations), `text_from` (where the text came from). Answer `{dry_run, sheet {id, title, read_as}, counts {add, update,
unchanged, skip}, items [{action, title, row, link, covers, external_ok, kind, source_type, chars, doc_id, reason, changes, copy}],
notes, applied, remaining}`: the page calls again while `remaining` > 0. The same link again updates (never doubles); nothing in the
Console is removed; a document a person made keeps its name, visibility, kind and text and only gets what it lacks. Guidance rows still
in force become guidance documents (an expired one this import made is turned off); Learned precedents are not brought over (a note
says why). A sheet that can't be read answers 502 `sheet_unreadable`, naming the account to share it with. A linked document that
can't be read keeps a copy brought over in use (status ready, the detail says why) and is tried every 30 minutes; one the Console
read itself clears `text_from`. Audit `knowledge.import`. `scripts/import_sheet_knowledge.py --dry-run | --apply [--folder PATH]
[--file PATH] [--signals]` does the same from a computer (with `infra/.env` sourced, on the live store).

**Signals** (watches; `watches.py`, `watches_import.py`; page Campaigns & watches, tab Signals). `GET /api/watches?days=` adds to each
watch `plain_status`, `checked`, `flagged_24h`, `near_misses_24h`, and to the answer `can_import`, `defaults {rubric, topics,
flag_at_score}` (the sheet's: `SHEET_DEFAULT_RUBRIC`, `SHEET_DEFAULT_TOPICS` unless Settings names topics, `watch_default_bar`) and
`templates` (the sheet's two starting rows). `POST /api/watches` (save), `POST /api/watches/{id}/switch {enabled}`,
`DELETE /api/watches/{id}`, `POST /api/watches/import-sheet {dry_run = true}` (all leads) work whatever the `watches` switch says: the
switch only decides whether the Console looks (`run_watches`, `POST /api/watches/run`). At most `watch_max_enabled` signals are on at
once (422 says so). Networks are kept as the post tables name them (`network_key`: X and Twitter are `x`). The import reads the
sheet's Watches tab as the bot does (blank rubric or topics take the sheet's defaults, a bar outside 1-10 the default bar, each name
once, a row without a question is left out), brings every new signal over OFF (`sheet_on` says it was ON there) and updates a
signal of the same name without changing whether it is on. Answer `{dry_run, sheet, counts, items [{action, name, row, on_in_sheet,
sheet_status, watch_id, enabled, reason, changes}], notes, applied, on_in_sheet}`. Audit `watch.save`, `watch.switch`, `watch.delete`.

**Agent alerts** (`triage_agent/ownalerts/`, settings `platform.own_alerts`, flags `own_alerts` and `own_alerts_post`; plan and decisions in
`docs/build-plan/5_own_alerts_plan.md`). Alerts the agent raises itself. In the code and the settings it is `own_alerts`.
- **A run** (`cycle.run`, inside `ingest_inhouse` when no rows are handed in, every `interval_minutes`): the BigQuery objects are created or
  brought up to date (`schema.provision`, needs `bigquery_admin`), the rules are copied when the copy is behind, each source is read from its
  cursor (`sources`: the tables in `sources` each in its own location, the Brandwatch queries, the Other alerts space), personal details are
  taken out (`scrub`: patterns, then Cloud DLP `content:deidentify`; nothing is kept when DLP fails), authors are hashed with the salt, KOFs
  are found from the KOF sheet, and rows go to `posts_staging` and `author_vault_30d` (`ingest`). Then `CALL run_9source_triage_cycle(...)`.
- **BigQuery objects**, all in the agent's dataset: tables `posts_staging`, `author_vault_30d`, `posts`, `post_metrics`, `stories`,
  `review_queue`, `decisions`, `feedback` (partitioned, expiring), `pipeline_watermarks`, `policy_rules_config`; function
  `fast_regex_sanitize`; remote models `embedding_model`, `gemini4_fast_decisions`; procedure `run_9source_triage_cycle`. `agent_events`
  and the metric views are never touched. No statement names anything with a reserved word, and none reads another table once
  for each row outside EXISTS / NOT EXISTS: BigQuery refuses such a subquery when it cannot turn it into a join, and always when
  it keeps only the latest rows (ORDER BY ... LIMIT). Rows are gathered first (a GROUP BY, or ROW_NUMBER() and QUALIFY) and
  joined on (`tests/test_own_sql_words.py`). A changed statement changes `schema.version`, so the next run (with
  `bigquery_admin` ON) makes the objects again before it reads anything; the review waits until it has.
- **The review** (`review.run`, in the worker's once-a-minute tick): reads the open queue items with any decision already kept, reviews the
  rest through operation `review_own_candidate {item, precedents}` (answers `data.verdict {escalate, severity, escalation_path,
  decision_rationale}`; asked of the Agent Runtime through `agent_runtime.query`, run by the worker when that fails), applies the hard-rule
  lock, inserts the decisions once, keeps a record in `own_decisions`, queues the alert (`raise_`, outbox source `own_alerts`, never the
  source space), remembers a raised story, and closes the queue last. LLM purpose `own.review`.
- **Afterwards:** `run_followups` step `own_alerts` (`surge.run`) queues a raised story that is growing again, once for each time it was
  raised; `purge.run` deletes rows past their days once a day; retention removes `own_decisions` past `console_keep_days`.
- **Console:** `GET /api/own?days=&status=`, `POST /api/own/run` (leads), `POST /api/own/setup` (admins), `GET|POST /api/own/rules`,
  `PUT|DELETE /api/own/rules/{id}` (leads), `POST /api/own/decisions/{id}/verdict {verdict: TRUE_POSITIVE|FALSE_POSITIVE}` (analysts).
  What went wrong reaches the page in plain words (`ownalerts/plain.py`): `state.problem`, `state.review.problem`,
  `state.kof.problem` and each source's `problem` are `{kind, title, message, action, link: {to, label}, technical?}` (kind `setup`,
  `sources`, `missing`, `permission`, `model`, `quota`, `timeout`, `unavailable`, `query` or `other`), and `POST /api/own/run`
  answers `problem` too. `technical` (Google's own words) and the raw `error` strings go to admins only; for everyone else each
  `error` holds the plain message. `state.made_before` says the BigQuery objects were made before (they are out of date, not new).
  Audit actions `own.run`, `own.setup`, `own.rule_saved`, `own.rule_removed`, `own.verdict`. On Integrations each table of posts carries an
  `own` tick (`platform.own_alerts.sources`); Find and fill adds the two tables in `config/own_alerts.yaml`.
- **Events:** `own.cycle`, `own.reviewed`, `own.raised`, `own.feedback`, `own.rule_saved`. **State:** docs `own_decisions`, `own_rules`; kv
  `own:state`, `own:schema`, `own:review`, `own:rules`, `own:kof` (and `own:kof:N`), `own:feedback`, `own:purge`.
- **Google Cloud** (`infra/11_own_alerts.sh`, run by `infra/deploy.sh`): the BigQuery connection the two remote models are called through
  (`ai_connection`; its own account has Vertex AI User, the runtime account has Connection Admin on it), the secret that holds the salt
  (`hash_salt_secret`, made once). `infra/10_seed_settings.py` fills the two settings while they are empty. The runtime account has
  `roles/dlp.user`. The in-house job may run for 600 s, the time a run holds its lock. No script changes Vertex AI's settings for the
  project (its cache, its data retention).

**Triage additions** (flags): `classification_layer` runs purpose `triage.classify` first and picks the knowledge the assessment reads;
`knowledge_rag` adds passages to `triage.assess` and to answers. The result's `extra` carries `classification`, `field_confidence`, `citations`,
`knowledge_read`. Both off: prompts and results are unchanged.

**Every operation** records inbound and outbound Chat activity, an audit entry, and passes its outputs through `safety.guard_outputs`
(allow-listed targets, leak guard for external spaces). Held outputs are returned in `data.held_outputs` and emitted as `safety.blocked`.

**Delivery.** With `pubsub_delivery` on, queued posts are published as `OutboundAction {action_id, kind, idempotency_key, payload}`; the worker
delivers each once (`done:<key>`), fails the push to make Pub/Sub retry, and records dead letters for replay or discard. Synchronous outputs
returned to a Studio flow and Gmail drafts are not queued.

**Events** (`events.PlatformEvent`): `audit.recorded`, `chat.inbound|outbound`, `triage.classified`, `assessment.recorded`, `golden.recorded`,
`safety.blocked|checked`, `outbound.published|delivered|failed|dead_lettered|replayed`, `llm.usage`, `prompt.published`, `agent_chat.turn|tool`,
`temp_check.started|completed|failed|actioned`, `forecast.run|failed`, `workforce.recommendation_created|recommendation_decided|gap_alert|shift_updated`,
`knowledge.doc_saved|doc_removed|indexed`, `watch.saved|detected`, `campaign.saved`, `bigquery.changed`, `secret.changed`,
`own.cycle|reviewed|raised|feedback|rule_saved`.

**Post velocity (`/api/velocity`, `triage_agent/velocity.py`, `console/backend/routes_velocity.py`):** `GET /api/velocity` (leaderboard + traction counts + poller state), `POST /api/velocity/track` (URL or `case_id`, SSRF-safe X/Bluesky public polling), `POST /api/velocity/lookup` (batch summaries by `case_id` and `url` for inline badges across Review feed, Cases, Stories, Early Detection and Temp check), `GET /api/velocity/posts/{key}` (`T+0…T+168h` curve), `GET /api/velocity/compare?keys=…`, `POST /api/velocity/posts/{key}/refresh`, `POST /api/velocity/refresh`, `POST /api/velocity/posts/{key}/watch`, `DELETE /api/velocity/posts/{key}`, `POST /api/velocity/import-legacy` (admin dry-run/apply from `slrr-tooling` GCS). Background polling & `velocity.spike` alerts gated by `platform.flags.velocity_tracking` (default `false`).

**State** (generic documents, `Store.put_doc/get_doc/list_docs/create_doc/delete_doc/delete_docs_before`): `audit`, `chat_activity`, `events_hot`,
`outbound`, `dead_letters`, `prompt_versions`, `prompt_defaults`, `knowledge_docs|chunks|text`, `golden`, `agent_sessions`, `temp_checks`, `tc_curves`, `tc_issues`,
`wf_forecasts`, `wf_recommendations`, `watches`, `watch_detections`, `watch_sources`, `velocity_posts`, `velocity_snapshots`. Equality filters need no composite index.

**LLM purposes added:** `triage.classify`, `console.chat_agent`, `temp_check.query`, `temp_check.relevance`, `temp_check.writeup`, `own.review`. Each purpose's
instructions, model and temperature can be published as a version in the Console (`prompts.py`); `{{default}}` stands for the built-in text.

**Forecast SQL.** Primary: `AI.FORECAST((series), data_col => 'y', timestamp_col => 'ts', horizon => N, confidence_level => X)` (TimesFM).
Fallback: `CREATE OR REPLACE MODEL … OPTIONS(model_type = 'ARIMA_PLUS', …)` then `ML.EXPLAIN_FORECAST`. Staff needed in an hour:
`ceil(volume × minutes_per_alert / (60 × target_utilization))`, at least `min_staff`.

## 18. Module layout (agent core)

```
triage_agent/
  qa/parser.py · qa/rules.py · qa/requirements.py · qa/llm_assess.py · qa/pipeline.py · qa/record_key.py · qa/sonar.py   (A1)
  triage.py · cases.py · render.py · review.py · followups.py · inhouse.py · agent_engine_app.py                         (A1)
  escalation/gmail.py · escalation/drafting.py · escalation/service.py · escalation/tns.py                              (A2)
  actions.py · emails.py · converse/{intents,answer,teach,handler}.py                                                    (A2)
jobs/run_job.py (A1) · evals/ (A1) · console/ (B) · studio-addon/ · flows/ · analytics/ · infra/ (C)
```

`render.py` exposes `prefix(ctx)`, `fmt_time(ctx, dt)` and `alert_summary_lines(ctx, case)` for A2's messages.

## 19. Conventions

- **Python:** 3.12-compatible, type hints, pydantic v2, no global state except the operation registry.
- **Dependencies:**
  - Install with `.venv/bin/pip install …`, then run `.venv/bin/pip freeze > requirements.txt`.
  - Only the main agent edits `requirements.txt`; other workstreams request additions.
- **Tests:**
  - Run `TRIAGE_LLM=fake .venv/bin/python -m pytest -q`.
  - Tests are offline: SQLite in a tmp dir, `FakeLLM`, `FakeGmail`.
  - Each workstream has its own `tests/test_<area>*.py`.
- **Git:** subagents don't commit; the main agent integrates and commits.
- **Placeholders:** keep placeholder values labeled (`is_placeholder: true`, `example.com` emails, `PLACEHOLDER` comments).
