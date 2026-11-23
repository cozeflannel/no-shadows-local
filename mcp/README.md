# Custom MCP Servers for `burson-triage-agent`

Zero-dependency Model Context Protocol (MCP) stdio servers built specifically for developing, testing, and operating the SLRR Burson QA Bot (`apps-script-chat-bot/`) and Python Triage Agent (`triage_agent/`).

Both servers are registered globally in `~/.gemini/config/mcp_config.json` and stay completely excluded from `clasp push` via `apps-script-chat-bot/.claspignore`.

## 1. `slrr-live-ops` (`mcp/slrr_live_ops_server.js`)
Strictly **read-only** live inspection of the production Control Google Sheet (`1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI`) and Apps Script Cloud Logging (`project_key="MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ"` on `brand-social-central-data`) using Application Default Credentials (ADC).

| Tool | What It Inspects |
|---|---|
| `slrr_get_control_status` | Live `Control` tab (`A1:C35` + grid validations): Bot `ON/OFF`, `Status`, `Last check`, `Today`, `Runs as`, space bindings (`B3, B4, B9, B10, B25, B26`), all 17 capability switches, `B30` testers, `B31` strict 15-min lookback validation, and safety checks. |
| `slrr_read_logs` | Live Cloud Logging v2 entries automatically scoped to `MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ` (filtering out legacy orphan noise by default). Filter by `minutes_back`, `severity`, `search`, `function_name`, or single-run `process_id`. |
| `slrr_inspect_relay_and_outbox` | Live `Burson outbox`, `Relay`, and `Relay names` tabs — surfaces pending/blocked outbox rows, inbound/outbound relay counts, and unmapped Chat user IDs. |
| `slrr_inspect_parity_and_results` | Live `Results` and `Learned precedents` tabs — surfaces Bot vs. IM accuracy/speed headlines and `WHERE THE BOT AND THE IMs DIFFERED` rows. |
| `slrr_inspect_knowledge_and_guidance` | Live `Resources` (doc read status & Burson visibility) and `Guidance` rules. |
| `slrr_trace_alert` | End-to-end multi-system trace for any Social Alert (by QA-ID, author, URL, or issue) across `Alert log`, `Results`, `Relay`, `Burson outbox`, `Follow-up`, `Watch detections`, and Cloud Logging. |
| `slrr_diff_live_apps_script` | Diffs live deployed Apps Script source files (`apps-script-chat-bot` and `apps-script-sheet-sidepanel`) against local workspace files via the Apps Script REST API. |
| `slrr_inspect_resource_doc` | Deep-inspects `Resources` documents alongside `Knowledge cache (bot)` chunks (`<= 45,000` char cell cap verification) and live Google Drive API v3 metadata (`modifiedTime`, `lastModifyingUser`). |
| `slrr_read_cloud_run_logs` | Queries Cloud Run service/job logs (`console`, `jobs`, `slrr_campaigns`) alongside live `Watches`, `Watch sources`, and `Watch detections` health. |

## 2. `slrr-dev-pipeline` (`mcp/slrr_dev_pipeline_server.js`)
Local Apps Script V8 VM simulation, pre-deploy safety auditing, leak-guard testing, historical backtesting, and automated test execution.

| Tool | What It Does |
|---|---|
| `slrr_audit_safety_invariants` | Runs the 7 pre-deploy checks (`Generated.gs` sync, the `B30` testing sandbox with no hardcoded emails, all switches defaulting to `OFF`, `B31` strict 15-min dropdown, `B35` Watch alerts `OFF`, `<= 49,000` cell caps, `.claspignore`). |
| `slrr_test_leak_guard` | Runs production `outboxGuardHits_()`, `guardHits_()`, `relayGuardHits_()`, and `outboxEmojiProblem_()` in the V8 VM on candidate text/emojis. |
| `slrr_preview_alert_triage` | Runs `parseAlert_`, `reviewAlert_`, `escalation_`, `planRecipients_`, and `socialAlertEmail_` in `< 100ms` on any raw Zapier alert text. |
| `slrr_run_tests` | Runs `node` (all tests or a single `switch_*.test.js`), `pytest`, `evals`, or `all`. |
| `slrr_sync_generated_gs` | Checks (`--check`) or regenerates `apps-script-chat-bot/Generated.gs` from `config/*.yaml`. |
| `slrr_simulate_guidance_rule` | Validates and simulates a candidate `Guidance` rule in the V8 VM (`kbQuoteProblem_`, `kbScopeProblem_`, `kbCitation_`, `kbPromotion_` under Row 13 vs `KB_HOLD_RX_` suppression). |
| `slrr_backtest_alerts` | Backtests the local V8 rules engine (`escalation_`, `kbPromotion_`) across historical alerts from `Alert log` (or custom alerts) at $0 cost, with optional candidate `Guidance` injection. |

## Verification
```bash
# Offline protocol + V8 VM verification
node mcp/test_mcp_servers.js

# Full live verification (includes real Google Sheets v4 + Cloud Logging v2 calls)
node mcp/test_mcp_servers.js --live
```
