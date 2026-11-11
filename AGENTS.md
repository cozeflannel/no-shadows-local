# Workspace Rules — SLRR Burson QA Bot & Triage Agent

## 1. Canonical Identifiers
- **Workspace Root:** `/Users/lhammonds/Desktop/burson-triage-agent`
- **Live V1 Apps Script (`scriptId`):** `19HakS6-o8U1qT99Xpnw2TQbJnZMx5FZz_JzVDd93Yd9gopQ9qXaWnGk3`
- **Cloud Logging `project_key`:** `MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ`
- **GCP Project:** `brand-social-central-data` (`1028310913761`)
- **Live Control Google Sheet (`STORE_SHEET_ID`):** `1dVGeQjLOfEYoCm_iIOmXd5hLM3rOTY_71IF-J8Hl2AI`
- **Live Sheet Analysis Sidepanel (`scriptId`, bound to `STORE_SHEET_ID`):** `1I-2Zrj1V1yr7hYVzhicyO3xNLXqxBeX_cmQUnC9-u4kWmGgjfvgC6pqT` (`apps-script-sheet-sidepanel/`)

## 2. Non-Negotiable Safety & Stealth Invariants
1. **Zero Hardcoded Emails & `Control!B30` Testing Sandbox:** Never hardcode any real email address anywhere in the repository. Live Social Alert groups are read dynamically from the `Brand safety groups` worksheet on `STORE_SHEET_ID`, and while Testing (`Safety valve` Row 29 `ON` or `B26` set), outbound emails/alerts go strictly to the email address(es) entered in `Control!B30` (`Testing: send to`; nothing is sent when `B30` is blank).
2. **All New `Control` Tab Switches Default to `'OFF'`:** Never auto-enable a capability switch in code; `Write back to SLRR BigQuery` (`Row 16`) and `Post in S-F Burson` (`Row 24`) must always default to `'OFF'`.
3. **Zero Burson-Space Leaks:** Nothing sent to `[S-F] Burson Automated Alerts V3` (`B25`) may mention internal test/mirror/analyst spaces, `SLRR`, `the bot`, `outbox`, `relay`, `auto-correct`, `Zapier`, or internal space IDs. Always validate candidate outbound copy with `slrr_test_leak_guard`.
4. **Google Sheets 50,000-Char Cell Cap:** Any cell write in `Sheets.gs` (`encodeCell_`) or `Speed.gs` (`speedText_`) must stay `<= 49,000` characters (`KNOWLEDGE_CELL_CHARS_ = 45000`).
5. **Tab Ownership Safeguard:** Never overwrite or clear a sheet tab the bot did not create (`isOutboxTab_`, `isKnowledgeTab_`, `isAnalysisTab_`). `Brand safety groups` is strictly read-only.
6. **Local Git Only (Zero GitHub Remotes):** Commit locally on `main` only. Never add a GitHub remote or run `git push` to an external Git host. `clasp push -f` inside `apps-script-chat-bot/` (and `apps-script-sheet-sidepanel/` for the sheet UI) are the sole live deployment targets (protected by `.claspignore`).

## 3. Preferred MCP Tool Routing
Before writing ad-hoc shell/Node scripts, prefer the project's dedicated MCP servers:
- **`slrr-live-ops`** (`mcp/slrr_live_ops_server.js`):
  - `slrr_get_control_status` — Live `Control` tab state, space bindings (`B3, B4, B9, B10, B25, B26`), switches, `B31` dropdown validation, and safety audit.
  - `slrr_read_logs` — Scoped Cloud Logging queries (`project_key="MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ"`, legacy orphan excluded).
  - `slrr_inspect_relay_and_outbox` — Live `Burson outbox`, `Relay`, and `Relay names` inspection (including unmapped Chat user IDs).
  - `slrr_inspect_parity_and_results` — Live `Results` KPIs, `im_only` / `bot_only` disagreements, and `Learned precedents`.
  - `slrr_inspect_knowledge_and_guidance` — Live `Resources` document health and `Guidance` rules.
  - `slrr_trace_alert` — End-to-end trace across `Alert log`, `Results`, `Relay`, `Burson outbox`, `Follow-up`, `Watch detections`, and Cloud Logging.
  - `slrr_diff_live_apps_script` — Diff live deployed `apps-script-chat-bot` and `apps-script-sheet-sidepanel` files against local files via the Apps Script API.
  - `slrr_inspect_resource_doc` — Deep-inspect `Resources` docs, `Knowledge cache (bot)` chunks (`<=45k` cell cap), and live Google Drive v3 metadata.
  - `slrr_read_cloud_run_logs` — Query Cloud Run service/job logs alongside `Watches`, `Watch sources`, and `Watch detections` health.
- **`slrr-dev-pipeline`** (`mcp/slrr_dev_pipeline_server.js`):
  - `slrr_audit_safety_invariants` — Run all 6 pre-deploy safety checks in one call.
  - `slrr_test_leak_guard` — Test candidate text/emojis against `outboxGuardHits_()` and `outboxEmojiProblem_()`.
  - `slrr_preview_alert_triage` — Instant local V8 VM dry-run of `parseAlert_`, `reviewAlert_`, `escalation_`, and `planRecipients_`.
  - `slrr_simulate_guidance_rule` — Validate and simulate candidate `Guidance` rules (`kbQuoteProblem_`, `kbScopeProblem_`, `kbPromotion_`) in the V8 VM at $0 cost.
  - `slrr_backtest_alerts` — Backtest local V8 rules and candidate `Guidance` rows against historical `Alert log` alerts at $0 cost.
  - `slrr_run_tests` — Run `node` (`run_tests.js` or single `switch_*.test.js`), `pytest`, `evals`, or `all`.
  - `slrr_sync_generated_gs` — Verify or rebuild `apps-script-chat-bot/Generated.gs` from `config/*.yaml`.
- **`bigquery` / `datacloud_bigquery_remote`** & **`playwright`**:
  - Use `execute_sql_readonly` and `get_table_info` against `brand-social-central-data` and `bsip-s-bsip-gg-26-2cf3.google_bg`; use `playwright` for headless UI testing of `Sidebar.html`, `console/`, and `studio-addon/`.
