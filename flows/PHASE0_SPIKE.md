# Phase 0 spike: verify the platform assumptions (1–2 days)

The goal is go/no-go on the no-Chat-API design before Phase 1. Each check lists what to do, what "pass" looks like, and the config key that records the result.

**Setup:**
- Create the Triage Agent Workspace account.
- Deploy the add-on ([studio-addon/README.md](../studio-addon/README.md)) with the agent running in `dev` (Agent Runtime, or skip the agent for the inspect-only checks).
- Use a private test space plus a copy of the Burson space if you can't experiment in the real one.

## Checklist

| # | Check | How | Pass | Record in |
|---|---|---|---|---|
| 0 | **Agent call from Studio** | Test flow: any starter → the add-on's step with `op` = `health` (or run `infra/05_deploy_agent_engine.py --smoke` first) | The step's summary output reads `ok env=dev config=…`; the Activity tab shows no error | `AGENT_ENGINE_RESOURCE` Script Property |
| 1 | **Message starter variables** | Flow: *When I get a chat message* (test space) → **Inspect variables** mapping every starter variable to `var1..var8` | Message text, sender name/email, space id or name, message id or link, thread and time are all available | Variable names → `flows/FLOW_SETUP.md` mappings; `alert_template.detection.sender_names/sender_emails` |
| 2 | **Zapier/Burson message format** | Copy 3–5 real alerts (including one with "This alert meets P0 criteria") | Labels + line layout known | `config/default_config.yaml → alert_template.fields[].labels`, `detection.text_regex`, `is_placeholder: false`; add the samples to `evals/golden/real/` |
| 3 | **Reaction starter variables** | Flow: *When an emoji reaction is added* → Inspect | Emoji, reactor email, and the reacted message's text **or** id/link are available | If no text: add **Record post** steps (FLOW_SETUP Flow 2 note) |
| 4 | **Mention + DM starters** | *When I'm mentioned* and *When I get a chat message* (DMs) → Inspect | Text + sender email available; mentions fire in all 3 spaces | — |
| 5 | **Burson space external users** | Post with *Post in a space* (Notify ON) in a space with an external member | Posts without approval; "Reply to a message" there asks for approval (expected) | Confirms the `burson_text` rule |
| 6 | **Doorbell: sheet starter** | Create the Agent Outbox Sheet; append a row with the API as the runtime SA (sheet setup: [`infra/README.md`](../infra/README.md) → Doorbell) | *When a sheet changes* starts Flow 5 within ~1 min for API appends | `outbox.doorbell: sheet`, `outbox.sheet_id` |
| 6b | **Doorbell: email fallback** | Send `[triage-agent outbox] test` to the agent account via the Gmail API (agent token, `gmail.send`) | *When I get an email* starts Flow 5 | `outbox.doorbell: email` |
| 7 | **Run limits** | Note the quota shown in Studio (runs per day, steps per flow); estimate alerts/day × 2–3 runs each | Headroom ≥ 3× peak | Plan note; split flows across 2 accounts if needed |
| 8 | **Email starter for T&S mail** | Make the agent account receive brand-social-sends@ WD intake + Watchdog emails (group membership or forward). Then run *When I get an email* → Inspect | Subject, body, from, received time available | FLOW_SETUP Flow 4 filter |
| 9 | **go/WD-Triage pre-fill** | Open the form → ⋮ → *Get pre-filled link*; fill every field with a marker value | `entry.<id>` per field, exact option texts for Issue Category / Team | `tns.fields[].entry_id`, `tns.categories`, `tns.is_placeholder: false` |
| 10 | **Brand Social send-as** | In an IM's Gmail, confirm *Send mail as* brand-social-sends@; create a draft via the Console's Gmail connect + a test 📦 | The draft shows From: Brand Social; sending keeps the alias | `escalation.from_*`; note IMs without send-as |
| 10b | **Gmail read scope** | With the IM test token (gmail.compose + gmail.metadata): edit a draft in Gmail, then reply `@Triage Agent revise: shorter` | The revision keeps the Gmail edits. If they're lost, Gmail is blocking `drafts.get(format=raw)` while gmail.metadata is granted | Keep the default, or set `TRIAGE_GMAIL_READ_SCOPE=readonly` in `infra/.env` (broader mailbox access), re-run `05`–`07`, and have IMs reconnect Gmail |
| 11 | **Sample Social Alert email** | Get one sent from the SLRR Alert Assistant | Body layout and To vs Bcc usage known | `escalation.email_templates[social_alert].body_guidance`, `escalation.recipients_in` |
| 12 | **BigQuery access** | Runtime SA reads `bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw` and `brand_safety_alert_outbox` | `SELECT 1 FROM … LIMIT 1` works | `sonar_lookup.enabled`, `inhouse.enabled` |
| 13 | **Space ids** | From each space URL | All 7 known | `spaces[].space_id` |
| 14 | **Rosters + leads** | IM shift times / people; Burson on-call; Angie's email; missing distros (GCPA, GSOC, Regional Leads, Channel Owner, Brand) | Filled in | Console → Rosters; `protocols.leadership.recipients`; `config/distribution.yaml` |

## Go / no-go

- **Go** requires all of these:
  - 0, 1, 3 (text or id), 4, 5 and 8 pass;
  - one of 6 / 6b passes;
  - 7 shows enough headroom.
- **No-go fallbacks:**

  | Failed check | Fallback |
  |---|---|
  | 3 (no message reference at all) | IMs use chat commands (`pa TRG-1042`) instead of reactions; the agent supports both |
  | 6 and 6b | Queued posts only go out when another flow runs. Raise this before Phase 1 |
  | 7 | Split flows across two owner accounts |

## Record results

After the spike, update `config/default_config.yaml`:
- `spaces`, `alert_template`, `outbox`, `tns`;
- `escalation.recipients_in`;
- `protocols.leadership.recipients`.

Or set the same values in the Agent Console → Settings. Then run:

```bash
TRIAGE_LLM=fake .venv/bin/python -m pytest -q
.venv/bin/python -m evals.run_evals --live
```

The live run checks Gemini's judgment on the real samples.
