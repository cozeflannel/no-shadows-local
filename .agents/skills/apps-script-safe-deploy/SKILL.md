---
name: apps-script-safe-deploy
description: >-
  Safe build, test, verification, and clasp deployment pipeline for the Burson QA Bot
  (apps-script-chat-bot). Use whenever modifying .gs files, config/*.yaml, or deploying
  changes to the live Apps Script project. The project is local only (no GitHub).
---

# Burson QA Bot — Safe Build, Test & `clasp` Deployment Pipeline

Follow this exact 5-step checklist whenever making code or configuration changes in `/Users/lhammonds/.gemini/jetski/scratch/burson-triage-agent`.

## Step 1: Regenerate `Generated.gs` (If YAML Changed)
If `config/default_config.yaml`, `config/distribution.yaml`, or `scripts/build_apps_script.py` was modified, rebuild `apps-script-chat-bot/Generated.gs` (never edit `Generated.gs` by hand):

```bash
.venv/bin/python -m scripts.build_apps_script
```

## Step 2: Enforce Stealth, Sandbox & Sheet Safeguards
Before running tests or pushing, verify these non-negotiable invariants:
1. **Zero Hardcoded Emails & `Control!B30` Testing Sandbox:** Never hardcode real email addresses in code or YAML (`GEN.email.stand_in` stays `""`); while Testing, Gmail refuses any recipient outside `Control!B30` (`Testing: send to`) and live external forms are never submitted.
2. **All New `Control` Tab Switches Default to `OFF`:** Every new capability toggle on the `Control` tab must default to `'OFF'`, especially `Write back to SLRR BigQuery` (`Row 16`), so Burson and shared BigQuery tables never see bot write-backs unless explicitly turned `ON`.
3. **Zero Burson-Space Leaks:** Nothing posted in a Burson-facing space may mention the analyst space, auto-correct space, mirror space, forwarding, reducing reliance on Burson, or internal emails/IDs.
4. **Google Sheets 50,000-Character Cell Limit:** Any string or JSON written to a cell in `Sheets.gs` (`encodeCell_`) or `Speed.gs` (`speedText_`) must be capped under `49,000` characters (`KNOWLEDGE_CELL_CHARS_ = 45000` in `Knowledge.gs`).
5. **Tab Ownership Safeguard:** Never read, clear, hide, or overwrite any sheet tab the bot did not create (`isKnowledgeTab_` checks `KNOWLEDGE_HEADER_`).

## Step 3: Run Both Test Suites (Must Pass 100%)
Run the Apps Script Node test suite and the Python test suite:

```bash
node apps-script-chat-bot/test/run_tests.js && .venv/bin/python -m pytest -q
```
Do **not** push to Apps Script if any test fails.

## Step 4: Deploy to Live Apps Script via `clasp` & Verify Live Run
1. Push the updated `.gs` files to `scriptId: 19HakS6-o8U1qT99Xpnw2TQbJnZMx5FZz_JzVDd93Yd9gopQ9qXaWnGk3`:
   ```bash
   npx @google/clasp push -f
   ```
   *(Run with `Cwd: /Users/lhammonds/.gemini/jetski/scratch/burson-triage-agent/apps-script-chat-bot`)*
2. Wait ~65 seconds for the next 1-minute `poll()` trigger and check Cloud Logging for `project_key="MT90an4vYnIDfrbDRi1jgSZANzck4hlvJ"` to confirm zero runtime errors.

## Step 5: Commit Locally (No GitHub)
This project lives only on this Mac: there is no GitHub remote. Never add one or push anywhere. Commit on `main`:
```bash
git add -u && git status --short   # tracked files only; add a new file by name (the clasp-pulled apps-script-chat-bot/*.js stay out)
git commit -m "<descriptive summary>"
```
