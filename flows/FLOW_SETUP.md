# Workspace Studio flow setup

These are the six flows the **Triage Agent account** owns. Every flow follows the same pattern:

**starter → one Triage Agent custom step → one `Check if` block per target**

> [!IMPORTANT]
> - **Build everything signed in as the Triage Agent account.** That account must be a member of every space below. Flows run as their owner.
> - **Never use "Reply to a message" in the Burson space.** Studio requires owner approval for each run when external people are present. Burson-space output always comes through `burson_text` + **Post in a space**.
> - **Turn on "Notify space members" in every "Post in a space" step.** The agent puts bare email addresses in its texts, and this turns them into @mentions.

Do the [Phase 0 spike](PHASE0_SPIKE.md) first. It confirms the exact starter variable names that the mappings below refer to as *Message text*, *Sender email*, and so on.

## Spaces and constants

| Target | Space | `targets` keyword |
|---|---|---|
| Burson | [S-F] Burson Automated Alerts V3 (`spaces/AAQAaa_0I9g`) | `burson` |
| Clean | SLRR Triaged Alerts (new space for IMs) | `clean` |
| YouTube | [S-F] YouTube Social (`spaces/AAAAmUvgYGU`) | `youtube` |
| Doodle | Doodle Team | `doodle` |
| Team | 24/7 SL (SLPO/SLRR) Team (`spaces/AAAAEoKjb2g`) | `team` |
| Crisis | "this is fine" crisis chat | `crisis` |
| Handover doc | Handover doc (Google Doc) | `handover` |
| DM | "Send a message" to `dm_recipients` | `dm` |
| Reply | "Reply to a message" (clean space / DMs only) | `reply` |

**Before the cutover:**
- Keep `TRIAGE_ENV=dev` (Script Property and agent config).
- Point every **Post in a space** step at a Google-only test space (never the Burson space).
- Point every **Send a message** step at yourself.
- At the cutover, point the steps at the real spaces ([`../infra/README.md`](../infra/README.md#cutover-to-production)).

## Check-if block recipe

Each target is one block. In the block, use the step's output variables from **+ Variables → Triage Agent step**:

| Condition | Step inside the block | Message / content |
|---|---|---|
| `has_reply` is `yes` | **Reply to a message** → the starter's message, **Reply in a thread** ON | `reply_text` |
| `has_burson` is `yes` | **Post in a space** → Burson space, Notify ON | `burson_text` |
| `has_clean` is `yes` | **Post in a space** → clean space, Notify ON | `clean_text` |
| `has_dm` is `yes` | **Send a message** → To: `dm_recipients` | `dm_text` |
| `has_youtube` is `yes` | **Post in a space** → [S-F] YouTube Social, Notify ON | `youtube_text` |
| `has_doodle` is `yes` | **Post in a space** → Doodle Team, Notify ON | `doodle_text` |
| `has_team` is `yes` | **Post in a space** → 24/7 SL team chat, Notify ON | `team_text` |
| `has_crisis` is `yes` | **Post in a space** → crisis chat, Notify ON | `crisis_text` |
| `has_handover` is `yes` | **Add to a doc** → Handover doc, "After existing content" | `handover_text` |

Turn on **Markdown** for message steps where offered; the texts use Chat markdown.

## Flow 1: Burson alerts

| Setting | Value |
|---|---|
| Starter | **When I get a chat message** → Space: [S-F] Burson Automated Alerts V3. Optional sender filter: the Zapier/Burson bot |
| Step 1 | **Triage Agent: Triage alert** |
| `message_text` | Message text |
| `sender_name` / `sender_email` | Sender name / Sender email |
| `space` | Space (id or name) |
| `message_id` / `message_link` / `thread_id` | Message id / Message link / Thread |
| `sent_at` | Message time |
| `targets` | `burson,clean,dm,youtube,doodle` |
| `flow` | `burson_alerts` |
| Check-if blocks | `has_burson`, `has_clean`, `has_dm`, `has_youtube`, `has_doodle` |
| Steps | 1 + 5 × 2 = **11** |

Human chatter in the Burson space also starts this flow. The agent answers `not an alert` and every `has_*` flag is `no`, so nothing posts.

## Flow 2: IM actions (emoji legend)

| Setting | Value |
|---|---|
| Starter | **When an emoji reaction is added** → Space: SLRR Triaged Alerts. Emojis: 👍 ⬇️ ✍️ 📰 📦 💬 🔥 💼 💧 1️⃣ 🦺 ⛑️ ➕ 🌎 ⚖️ 🌱 📸 ❌ 🧑‍💻 👎 |
| Step 1 | **Triage Agent: Record reaction** |
| `emoji` | Emoji |
| `reactor_email` / `reactor_name` | Reaction user email / name |
| `message_text` | Reacted message text (if exposed) |
| `message_id` / `message_link` | Reacted message id / link |
| `space` | Space |
| `targets` | `reply,dm,crisis` |
| `flow` | `im_actions` |
| Check-if blocks | `has_reply`, `has_dm`, `has_crisis` |
| Steps | 1 + 3 × 2 = **7** |

If Phase 0 shows the starter doesn't expose the reacted message's text:
- Add the optional **Triage Agent: Record post** step to Flow 1 and Flow 5, right after the clean-space post. It records each post's message id so the agent can map reactions by id.

## Flow 3a: Mentions

| Setting | Value |
|---|---|
| Starter | **When I'm mentioned** → Spaces: SLRR Triaged Alerts, 24/7 SL team chat, [S-F] Burson Automated Alerts V3 |
| Step 1 | **Triage Agent: Converse** |
| Inputs | Message text, sender name/email, space, `conversation_type` = `SPACE`, message id/link, thread |
| `targets` | `reply,burson,dm` |
| `flow` | `mentions` |
| Check-if blocks | `has_reply`, `has_burson`, `has_dm` |
| Steps | **7** |

For mentions in the Burson space, the agent answers through `burson_text` with the asker's email, never `reply_text`.

## Flow 3b: Direct messages

| Setting | Value |
|---|---|
| Starter | **When I get a chat message** → direct messages to the Triage Agent account |
| Step 1 | **Triage Agent: Converse**, with `conversation_type` = `DM` and `space` empty |
| `targets` | `reply,dm` |
| `flow` | `dms` |
| Check-if blocks | `has_reply`, `has_dm` |
| Steps | **5** |

IMs answer review DMs here: `forward TRG-1043`, `bounce TRG-1043: dead link`, `revise: shorter`, …

## Flow 4: Agent inbox (WD intake, outcomes, Watchdog)

| Setting | Value |
|---|---|
| Starter | **When I get an email** with *Has the words* `"WD Intake Request" OR "Watchdog Anti-Abuse Alert"`. The agent account must receive brand-social-sends@ T&S mail (Phase 0) |
| Step 1 | **Triage Agent: Ingest email** |
| Inputs | `subject`, `from`, `to`, `cc`, `body` (plain-text body), `message_id`, `thread_id`, `received_at`, `link` |
| `targets` | `clean,dm,youtube,doodle` |
| `flow` | `agent_inbox` |
| Check-if blocks | `has_clean`, `has_dm`, `has_youtube`, `has_doodle` |
| Steps | **9** |

## Flow 5: Outbox (doorbell)

Delivers everything that doesn't come from a running flow:
- SLA nudges, reminders, Burson digests, shift handovers;
- Console decisions and in-house alerts;
- outputs for targets another flow lacks.

| Setting | Value |
|---|---|
| Starter (doorbell = `sheet`) | **When a sheet changes** → Agent Outbox Sheet, tab `outbox` |
| Starter (doorbell = `email`, alternative) | **When I get an email** with *Has the words* `"[triage-agent outbox]"` |
| Step 1 | **Triage Agent: Deliver outbox** |
| `targets` | `burson,clean,dm,youtube,doodle,team,crisis,handover` |
| `flow` | `outbox` |
| Check-if blocks | `has_burson`, `has_clean`, `has_dm`, `has_youtube`, `has_doodle`, `has_team`, `has_crisis`, `has_handover` |
| Steps | 1 + 8 × 2 = **17** |

How it behaves:
- Each queued post rings the doorbell once.
- Each run delivers one clean-space alert, so every alert is its own message. It also delivers up to 10 items for the other targets and DMs for one recipient set.
- The minute job re-rings for anything stuck longer than 3 minutes.

## No scheduled flow is needed

Studio's **On a schedule** starter only repeats daily or weekly. Minute-level work runs as a Cloud Run job on Cloud Scheduler (`infra/06_jobs.sh`) and reaches Chat through Flow 5:
- SLA timers;
- reminders;
- sent-draft detection;
- the digest;
- handovers;
- in-house ingestion.

## Troubleshooting

| Symptom | Check |
|---|---|
| Step errors with "AGENT_ENGINE_RESOURCE is not set" | Script Properties on the add-on project |
| HTTP 403 from the Agent Runtime | `roles/aiplatform.user` for the Triage Agent account |
| Nothing posts for an alert | The run's Activity log `summary` (e.g. `not an alert`, `ignored: own message`, `suppressed: below_threshold`) |
| Reactions say "couldn't match this message" | The reaction starter isn't passing the message text. Add **Record post** steps (Flow 1) |
| Posts arrive late | Doorbell starter firing? (Phase 0 item 6). Outbox backlog in the Agent Console → Outbox |
| Mentions not notified | "Notify space members" ON, and the person is a member of that space |
