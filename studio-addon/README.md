# SLRR Triage Agent: Workspace Studio custom steps

An Apps Script add-on that gives Workspace Studio six custom steps. Each step:
1. Calls the agent on the Agent Runtime (Gemini Enterprise Agent Platform, formerly Vertex AI Agent Engine).
2. Returns the same 23 output variables (`has_reply`/`reply_text` … `summary`).

The flow's own **Check if** blocks then post with Studio's built-in Chat and Docs steps. There's no Chat API and no webhooks.

| Step | Agent op | Used by flow |
|---|---|---|
| Triage Agent: Triage alert | `triage_message` | 1 Burson alerts |
| Triage Agent: Record reaction | `record_reaction` | 2 IM actions |
| Triage Agent: Converse | `converse` | 3a Mentions, 3b DMs |
| Triage Agent: Ingest email | `ingest_email` | 4 Agent inbox |
| Triage Agent: Deliver outbox | `drain_outbox` | 5 Outbox (doorbell) |
| Triage Agent: Record post | `record_post` | optional, after a clean-space post |
| Triage Agent: Inspect variables (Phase 0) | none | spike only |

## Files

| File | |
|---|---|
| `Code.gs` | Config cards, input → payload mapping, Agent Runtime call, output/error responses |
| `Steps.gs` | **Generated**: step definitions + entry points |
| `appsscript.json` | **Generated**: manifest |
| `build_manifest.py` | Regenerates the two generated files from `triage_agent/models.py` (run after contract changes) |
| `test/harness.js` | Runs the add-on in Node with mocked Apps Script services (used by `tests/test_studio_addon.py`) |

```bash
.venv/bin/python studio-addon/build_manifest.py           # regenerate
.venv/bin/python studio-addon/build_manifest.py --check   # verify (also run by the test suite)
```

## Deploy (as the Triage Agent Workspace account)

1. **Push with clasp** while signed in as the dedicated account (`triage-agent@…`):
   ```bash
   clasp login                      # as the Triage Agent account
   cd studio-addon
   clasp create --type standalone --title "SLRR Triage Agent"
   clasp push                       # pushes appsscript.json, Code.gs, Steps.gs (see .claspignore)
   ```
   `.clasp.json` is git-ignored.
2. **Link the GCP project.** In the Apps Script editor, open **Project Settings → Google Cloud Platform (GCP) Project** and set the agent's project number. Use an internal OAuth consent screen.
3. **Set Script Properties** in **Project Settings → Script Properties**:
   - `AGENT_ENGINE_RESOURCE` = `projects/<project>/locations/<region>/reasoningEngines/<id>`. It's printed by `infra/05_deploy_agent_engine.py`.
   - `TRIAGE_ENV` = `dev` until the cutover, then `prod`.
4. **Grant IAM.** The Triage Agent account needs `roles/aiplatform.user` on the project. `infra/02_service_accounts.sh` grants it once `TRIAGE_AGENT_ACCOUNT` is set in `infra/.env`. The step calls the Agent Runtime with the flow owner's token (`ScriptApp.getOAuthToken()`, `cloud-platform` scope).
5. **Install.** Choose **Deploy → Test deployments → Install**, then reload Workspace Studio. The steps appear under the add-on's name. Authorize on first use.
6. **Build the flows** in [`../flows/FLOW_SETUP.md`](../flows/FLOW_SETUP.md). Start with the Phase 0 spike: [`../flows/PHASE0_SPIKE.md`](../flows/PHASE0_SPIKE.md).

## Behavior

- **Inputs:**
  - Every input accepts Studio variables. Map starter variables such as message text, sender, space and message link.
  - `targets` is a constant listing the post steps that flow has, e.g. `burson,clean,dm,youtube,doodle`. The agent queues anything else for the Outbox flow, so nothing is dropped.
  - `flow` is a constant name used in logs.
- **Errors:**

  | Situation | Error type | Studio behavior |
  |---|---|---|
  | HTTP 429/5xx, or `retryable` from the agent | `RETRYABLE` | Retries up to 5 times |
  | Missing Script Property, 403/404, or a missing required input | `ACTIONABLE` | Shows a fix-it button on the Activity tab |
  | Anything else | `NOT_RETRYABLE` | Logged on the Activity tab |

- **Logs:** every run writes the agent's one-line `summary` to the step's Activity log.
