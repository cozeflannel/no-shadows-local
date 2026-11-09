#!/usr/bin/env node
/**
 * slrr_dev_pipeline_server.js — Development, Safety Audit, Leak-Guard & Local V8 Triage MCP Server for Burson QA Bot.
 *
 * Exposes structured MCP tools for safe local iteration on `burson-triage-agent`:
 *   - `slrr_audit_safety_invariants`: Verifies all 6 mandatory stealth, sandbox, cell-cap, switch-OFF, clasp, and git-local guardrails
 *   - `slrr_test_leak_guard`: Runs the real production `outboxGuardHits_()` & `outboxEmojiProblem_()` on candidate outbound text/emoji
 *   - `slrr_preview_alert_triage`: Executes local V8 VM dry-run of `parseAlert_`, `reviewAlert_`, `escalation_`, and `planRecipients_`
 *   - `slrr_run_tests`: Executes `node` (full suite or targeted `switch_*.test.js`), `pytest`, `evals`, or `all`
 *   - `slrr_sync_generated_gs`: Checks or rebuilds `apps-script-chat-bot/Generated.gs` from `config/*.yaml`
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createMcpStdioServer } = require('./mcp_stdio');

const REPO_ROOT = path.resolve(__dirname, '..');
const BOT_DIR = path.join(REPO_ROOT, 'apps-script-chat-bot');
const PYTHON_BIN = fs.existsSync(path.join(REPO_ROOT, '.venv', 'bin', 'python'))
  ? path.join(REPO_ROOT, '.venv', 'bin', 'python')
  : 'python3';

function loadFreshBotVm() {
  const fakesPath = path.join(BOT_DIR, 'test', 'fakes.js');
  const { makeGoogle, loadBot } = require(fakesPath);
  const g = makeGoogle();
  const bot = loadBot(g.services, g.clock);
  return { g, bot };
}

function runSubprocess(cmd, args, opts = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || REPO_ROOT,
    env: Object.assign({}, process.env, opts.env || {}),
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    exit_code: res.status === null ? -1 : res.status,
    duration_ms: Date.now() - started,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    signal: res.signal || null,
    error: res.error ? res.error.message : null,
  };
}

async function handleAuditSafetyInvariants() {
  const checks = [];

  // 1. Generated.gs sync check
  const buildCheck = runSubprocess(PYTHON_BIN, ['-m', 'scripts.build_apps_script', '--check']);
  checks.push({
    id: 'generated_gs_in_sync',
    passed: buildCheck.exit_code === 0,
    detail: buildCheck.exit_code === 0 ? 'Generated.gs matches config/*.yaml' : (buildCheck.stdout + buildCheck.stderr).trim(),
  });

  // 2-4. VM inspection of B30 testing sandbox + zero hardcoded emails, default OFF switches, B31 strict validation, and cell caps
  const { g, bot } = loadFreshBotVm();
  const gen = bot.ev('GEN');
  const controlSwitches = bot.ev('CONTROL_SWITCHES_');
  const standIn = String((gen && gen.email && gen.email.stand_in) || '').trim();
  const generatedRaw = fs.readFileSync(path.join(BOT_DIR, 'Generated.gs'), 'utf8') + '\n' +
    fs.readFileSync(path.join(BOT_DIR, 'Channels.gs'), 'utf8');
  const emailHits = generatedRaw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  const defaultTesting = bot.runTesting_() === true;
  const blankB30Empty = bot.testersFrom_('').testers.length === 0;
  const anyEmailAccepted = JSON.stringify(bot.testersFrom_('tester@external-org.test').testers) === JSON.stringify(['tester@external-org.test']);
  checks.push({
    id: 'testing_sandbox_b30_and_zero_hardcoded_emails',
    passed: standIn === '' && emailHits.length === 0 && defaultTesting && blankB30Empty && anyEmailAccepted,
    detail: `stand_in="${standIn}", generated_email_hits=${emailHits.length}, runTesting_=${defaultTesting}, blankB30Empty=${blankB30Empty}, anyEmailAccepted=${anyEmailAccepted}`,
  });

  const ss = g.services.SpreadsheetApp.create('AuditControl');
  const control = bot.ensureControlTab_(ss, 'bot@runner.invalid');
  const switchRows = bot.switchRows_();
  const switches = controlSwitches.map((sw, idx) => {
    const r = switchRows[idx];
    const val = String(control.getRange(r, 2).getValue() || '').trim();
    return { key: sw.key, label: sw.label, row: r, default_value: val };
  });
  const nonOff = switches.filter(s => s.default_value !== 'OFF');
  checks.push({
    id: 'all_switches_default_off',
    passed: nonOff.length === 0,
    detail:
      nonOff.length === 0
        ? `All ${switches.length} Control tab switches default to OFF (including writeBackBq & postBurson)`
        : `Switches not defaulting to OFF: ${JSON.stringify(nonOff)}`,
  });

  const b31Val = String(control.getRange(31, 2).getValue() || '');
  const b31Rule = control.getRange(31, 2).getDataValidation();
  const b31Choices = b31Rule ? b31Rule.getCriteriaValues()[0] : null;
  const b31Strict = b31Rule ? b31Rule.getAllowInvalid() === false : false;
  checks.push({
    id: 'b31_lookback_strict_15min_dropdown',
    passed:
      b31Strict &&
      JSON.stringify(b31Choices) === JSON.stringify(['15 minutes', '30 minutes', '45 minutes', '60 minutes']) &&
      b31Val === '60 minutes',
    detail: `B31 default="${b31Val}", strict=${b31Strict}, choices=${JSON.stringify(b31Choices)}`,
  });

  // Watch alerts (B35): OFF until a person chooses where the Proactive watch's alerts go, with its strict dropdown
  const b35Label = String(control.getRange(35, 1).getValue() || '');
  const b35Val = String(control.getRange(35, 2).getValue() || '');
  const b35Rule = control.getRange(35, 2).getDataValidation();
  const b35Choices = b35Rule ? b35Rule.getCriteriaValues()[0] : null;
  const b35Strict = b35Rule ? b35Rule.getAllowInvalid() === false : false;
  checks.push({
    id: 'b35_watch_alerts_default_off',
    passed:
      b35Label === 'Watch alerts' &&
      b35Val === 'OFF' &&
      b35Strict &&
      JSON.stringify(b35Choices) === JSON.stringify([
        'OFF', 'Other alerts space (B33)', 'Mirror space (B9)', 'Auto-correct space (B10)',
      ]),
    detail: `A35="${b35Label}", B35 default="${b35Val}", strict=${b35Strict}, choices=${JSON.stringify(b35Choices)}`,
  });

  const sheetCap = bot.ev('typeof SHEET_CELL_MAX_CHARS_ !== "undefined" ? SHEET_CELL_MAX_CHARS_ : null');
  const kbCap = bot.ev('typeof KNOWLEDGE_CELL_CHARS_ !== "undefined" ? KNOWLEDGE_CELL_CHARS_ : null');
  checks.push({
    id: 'sheets_50k_cell_caps_enforced',
    passed: Number(sheetCap) > 0 && Number(sheetCap) <= 49000 && Number(kbCap) > 0 && Number(kbCap) <= 49000,
    detail: `SHEET_CELL_MAX_CHARS_=${sheetCap}, KNOWLEDGE_CELL_CHARS_=${kbCap}`,
  });

  // 5. .claspignore check
  const claspIgnorePath = path.join(BOT_DIR, '.claspignore');
  const claspIgnore = fs.existsSync(claspIgnorePath) ? fs.readFileSync(claspIgnorePath, 'utf8') : '';
  const claspSafe = claspIgnore.includes('**/**') && claspIgnore.includes('!*.gs') && claspIgnore.includes('!appsscript.json');
  checks.push({
    id: 'claspignore_whitelists_only_gs_and_manifest',
    passed: claspSafe,
    detail: claspSafe ? '.claspignore blocks tests and local .js files from clasp push' : 'Check apps-script-chat-bot/.claspignore',
  });

  // 6. Local-only git check (zero remotes)
  const gitRemote = runSubprocess('git', ['remote', '-v']);
  const remotes = gitRemote.stdout.trim();
  checks.push({
    id: 'local_only_no_github_remote',
    passed: gitRemote.exit_code === 0 && remotes === '',
    detail: remotes === '' ? 'Zero git remotes configured (local-only policy intact)' : `Unexpected git remotes: ${remotes}`,
  });

  return {
    all_passed: checks.every(c => c.passed),
    checked_count: checks.length,
    checks,
  };
}

async function handleTestLeakGuard(args) {
  const { bot } = loadFreshBotVm();
  const extraTerms = Array.isArray(args.internal_space_terms) ? args.internal_space_terms : ['SLRR Triaged Alerts', 'Mirror Training Space'];
  const guard = { terms: extraTerms.filter(t => t && String(t).length > 3) };

  const result = {};
  if (args.text !== undefined) {
    const text = String(args.text);
    const botHits = Array.from(bot.guardHits_(text, guard));
    const relayHits = Array.from(bot.relayGuardHits_(text));
    const outboxHits = Array.from(bot.outboxGuardHits_(text, guard));
    const isInternalNote = bot.ev(`RELAY_INTERNAL_RX_.test(${JSON.stringify(text)})`);
    result.text_check = {
      allowed_to_burson: outboxHits.length === 0 && !isInternalNote,
      kept_internal_by_prefix: isInternalNote,
      outbox_guard_hits: outboxHits,
      bot_guard_hits: botHits,
      relay_guard_hits: relayHits,
    };
  }

  if (args.emoji !== undefined) {
    const emoji = String(args.emoji);
    const problem = bot.outboxEmojiProblem_(emoji);
    result.emoji_check = {
      emoji,
      allowed_to_burson: problem === '',
      problem: problem || null,
    };
  }

  return result;
}

async function handlePreviewAlertTriage(args) {
  const alertText = String(args.alert_text || '').trim();
  if (!alertText) {
    throw new Error('alert_text is required');
  }
  const noWait = args.no_wait === true;
  const { bot } = loadFreshBotVm();
  const gen = bot.ev('GEN');
  const now = Date.now();

  const parsed = bot.parseAlert_(alertText);
  if (noWait) parsed.noWait = true;
  const detected = bot.detectAlert_(alertText, parsed, '');
  if (!detected) {
    return {
      detected: false,
      note: 'Input text was not detected as a Zapier Social Alert (too few [Label]: value lines).',
      parsed_fields: parsed.fields,
    };
  }

  const review = bot.reviewAlert_(parsed, { now, settings: gen.settings, history: [] });
  const items = { fixes: review.fixes, missing: review.missing };
  const bursonReply =
    items.fixes.length + items.missing.length > 0
      ? noWait
        ? bot.processedText_(items, { terms: [] })
        : bot.fixRequestText_(items, { terms: [] }, false)
      : null;
  const rebuilt = bot.rebuildAlert_(alertText, parsed, review.fields, review.changed);
  const analystPost = bot.joinText_(
    noWait ? bot.withTimestamp_(rebuilt, review.fields, review.changed) : rebuilt,
    bot.forwardFooter_(review, noWait)
  );
  const esc = bot.escalation_(review.fields, { now });
  let emailPreview = null;
  if (esc.escalated) {
    const input = bot.emailInput_(review.fields, esc, noWait);
    const plan = bot.planRecipients_(esc, esc.text, []);
    const email = bot.socialAlertEmail_(input, plan, {
      test: false,
      mailbox: gen.email.from_email,
      sendId: 'MCP-PREVIEW',
    });
    emailPreview = {
      subject: email.subject,
      to: email.to,
      cc: email.cc,
      body_preview: String(email.text || '').slice(0, 1500),
    };
  }

  return {
    detected: true,
    record_key: bot.recordKey_(review.fields),
    parsed_fields: parsed.fields,
    reviewed_fields: review.fields,
    fixes: review.fixes,
    missing: review.missing,
    escalation: {
      escalated: esc.escalated,
      track: esc.track,
      reason: esc.reason,
      reasons: esc.reasons,
    },
    burson_space_reply: bursonReply,
    analyst_space_post: analystPost,
    social_alert_email: emailPreview,
  };
}

async function handleRunTests(args) {
  const suite = String(args.suite || 'all').toLowerCase();
  const results = {};

  if (suite === 'node' || suite === 'all') {
    if (args.node_test_file && suite === 'node') {
      const base = path.basename(String(args.node_test_file));
      const target = path.join(BOT_DIR, 'test', base);
      if (!fs.existsSync(target)) {
        throw new Error(`Test file not found: ${target}`);
      }
      const res = runSubprocess('node', [target], { timeoutMs: 120000 });
      results.node = {
        passed: res.exit_code === 0,
        exit_code: res.exit_code,
        duration_ms: res.duration_ms,
        output_tail: (res.stdout + res.stderr).slice(-3500),
      };
    } else {
      const res = runSubprocess('node', [path.join(BOT_DIR, 'test', 'run_tests.js')], { timeoutMs: 120000 });
      results.node = {
        passed: res.exit_code === 0,
        exit_code: res.exit_code,
        duration_ms: res.duration_ms,
        output_tail: (res.stdout + res.stderr).slice(-3500),
      };
    }
  }

  if (suite === 'pytest' || suite === 'all') {
    const pytestArgs = ['-m', 'pytest', '-q'];
    if (args.pytest_target) {
      pytestArgs.push(String(args.pytest_target));
    }
    const res = runSubprocess(PYTHON_BIN, pytestArgs, {
      env: { TRIAGE_LLM: 'fake' },
      timeoutMs: 180000,
    });
    results.pytest = {
      passed: res.exit_code === 0,
      exit_code: res.exit_code,
      duration_ms: res.duration_ms,
      output_tail: (res.stdout + res.stderr).slice(-3500),
    };
  }

  if (suite === 'evals') {
    const res = runSubprocess(PYTHON_BIN, ['-m', 'evals.run_evals'], {
      env: { TRIAGE_LLM: 'fake' },
      timeoutMs: 120000,
    });
    results.evals = {
      passed: res.exit_code === 0,
      exit_code: res.exit_code,
      duration_ms: res.duration_ms,
      output_tail: (res.stdout + res.stderr).slice(-3500),
    };
  }

  const allPassed = Object.values(results).every(r => r.passed);
  return {
    suite,
    all_passed: allPassed,
    results,
  };
}

async function handleSyncGeneratedGs(args) {
  const checkOnly = args.check_only !== false;
  const pyArgs = ['-m', 'scripts.build_apps_script'];
  if (checkOnly) pyArgs.push('--check');
  const res = runSubprocess(PYTHON_BIN, pyArgs, { timeoutMs: 30000 });
  return {
    mode: checkOnly ? 'check' : 'rebuild',
    in_sync_or_rebuilt: res.exit_code === 0,
    exit_code: res.exit_code,
    output: (res.stdout + res.stderr).trim() || (checkOnly ? 'Generated.gs is up to date.' : 'Generated.gs rebuilt.'),
  };
}

const TOOLS = [
  {
    name: 'slrr_audit_safety_invariants',
    description:
      'Run all 6 non-negotiable pre-deploy safety checks: Generated.gs YAML sync, GEN.email.stand_in sandbox, every Control switch defaulting to OFF, B31 strict 15-min lookback validation, 49,000-char cell caps, .claspignore protection, and zero GitHub remotes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: handleAuditSafetyInvariants,
  },
  {
    name: 'slrr_test_leak_guard',
    description:
      'Test candidate outbound Burson message text and/or reaction emoji against the production leak guards (`outboxGuardHits_`, `guardHits_`, `relayGuardHits_`, `outboxEmojiProblem_`) in the Apps Script V8 VM.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Candidate message or thread reply text to test against Burson leak guards.',
        },
        emoji: {
          type: 'string',
          description: 'Candidate reaction emoji to test (e.g., "👍" vs "👎").',
        },
        internal_space_terms: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional internal space names/IDs to include in guard term matching.',
        },
      },
    },
    handler: handleTestLeakGuard,
  },
  {
    name: 'slrr_preview_alert_triage',
    description:
      'Dry-run any raw Zapier Social Alert text through the production Apps Script V8 rules engine (`parseAlert_`, `reviewAlert_`, `escalation_`, `planRecipients_`, `socialAlertEmail_`) in <100ms without network writes.',
    inputSchema: {
      type: 'object',
      properties: {
        alert_text: {
          type: 'string',
          description: 'Raw Zapier alert text to parse, QA, and route.',
        },
        no_wait: {
          type: 'boolean',
          description: 'Simulate `Never wait on Burson` = ON (default: false).',
        },
      },
      required: ['alert_text'],
    },
    handler: handlePreviewAlertTriage,
  },
  {
    name: 'slrr_run_tests',
    description:
      'Run the Apps Script Node test suite (`node`), a single `switch_*.test.js` file, the Python test suite (`pytest`), offline golden evals (`evals`), or `all`.',
    inputSchema: {
      type: 'object',
      properties: {
        suite: {
          type: 'string',
          enum: ['node', 'pytest', 'evals', 'all'],
          description: 'Which test runner to execute (default: "all").',
        },
        node_test_file: {
          type: 'string',
          description: 'Optional single test filename inside apps-script-chat-bot/test/ when suite="node" (e.g., "switch_relay_test_copy.test.js").',
        },
        pytest_target: {
          type: 'string',
          description: 'Optional pytest file or -k target when suite="pytest" (e.g., "tests/test_apps_script_bot.py").',
        },
      },
    },
    handler: handleRunTests,
  },
  {
    name: 'slrr_sync_generated_gs',
    description:
      'Verify (`check_only: true`) or regenerate (`check_only: false`) `apps-script-chat-bot/Generated.gs` from `config/default_config.yaml` and `config/distribution.yaml`.',
    inputSchema: {
      type: 'object',
      properties: {
        check_only: {
          type: 'boolean',
          description: 'If true (default), only checks freshness with `--check`; if false, regenerates `Generated.gs`.',
        },
      },
    },
    handler: handleSyncGeneratedGs,
  },
];

const server = createMcpStdioServer({
  name: 'slrr-dev-pipeline',
  version: '1.0.0',
  instructions:
    'Local V8 simulation, leak-guard verification, safety-invariant auditing, and test execution MCP server for burson-triage-agent.',
  tools: TOOLS,
});

if (require.main === module) {
  server.start();
}

module.exports = { TOOLS, server };
