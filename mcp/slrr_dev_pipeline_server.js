#!/usr/bin/env node
/**
 * slrr_dev_pipeline_server.js — Development, Safety Audit, Leak-Guard & Local V8 Triage MCP Server for Burson QA Bot.
 *
 * Exposes structured MCP tools for safe local iteration on `burson-triage-agent`:
 *   - `slrr_audit_safety_invariants`: Runs the 8 pre-deploy checks (Generated.gs sync, B30 sandbox and no hardcoded emails, switches OFF, B31 dropdown, B35 Watch alerts OFF, cell caps, .claspignore, no git remote)
 *   - `slrr_test_leak_guard`: Runs the bot's `outboxGuardHits_()` & `outboxEmojiProblem_()` from the local .gs files on candidate outbound text/emoji (without the real space names production also blocks)
 *   - `slrr_preview_alert_triage`: Executes local V8 VM dry-run of `parseAlert_`, `reviewAlert_`, `escalation_`, and `planRecipients_`
 *   - `slrr_run_tests`: Executes `node` (full suite or targeted `switch_*.test.js`), `pytest`, `evals`, or `all`
 *   - `slrr_sync_generated_gs`: Checks or rebuilds `apps-script-chat-bot/Generated.gs` from `config/*.yaml`
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  DEFAULT_STORE_SHEET_ID,
  gcpFetchJson,
  getWorkbookMetadata,
  readTabTails,
  tailReadSummary,
  createMcpStdioServer,
} = require('./mcp_stdio');

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

// handleAuditSafetyInvariants and handleRunTests take (args, deps): the MCP server passes args only; the tests pass
// deps.runSubprocess so they can stand in for git, node and python without running them.
function runnerOf(deps) {
  return (deps && deps.runSubprocess) || runSubprocess;
}

async function handleAuditSafetyInvariants(_args, deps) {
  const run = runnerOf(deps);
  const checks = [];

  // 1. Generated.gs sync check
  const buildCheck = run(PYTHON_BIN, ['-m', 'scripts.build_apps_script', '--check']);
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
  const gitRemote = run('git', ['remote', '-v']);
  const remotes = gitRemote.stdout.trim();
  const gitRan = gitRemote.exit_code === 0;
  const gitWhy = gitRemote.error || String(gitRemote.stderr || '').trim() || `exit code ${gitRemote.exit_code}`;
  checks.push({
    id: 'local_only_no_github_remote',
    passed: gitRan && remotes === '',
    detail: !gitRan
      ? `Could not run \`git remote -v\` (${gitWhy}), so the remotes were not checked`
      : remotes === ''
        ? 'Zero git remotes configured (local-only policy intact)'
        : `Unexpected git remotes: ${remotes}`,
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

const TEST_SUITES = ['node', 'pytest', 'evals', 'all'];

async function handleRunTests(args, deps) {
  const run = runnerOf(deps);
  const suite = String(args.suite || 'all').toLowerCase();
  if (!TEST_SUITES.includes(suite)) {
    throw new Error(`Unknown suite "${suite}": use one of ${TEST_SUITES.join(', ')}`);
  }
  const results = {};

  if (suite === 'node' || suite === 'all') {
    if (args.node_test_file && suite === 'node') {
      const base = path.basename(String(args.node_test_file));
      const target = path.join(BOT_DIR, 'test', base);
      if (!fs.existsSync(target)) {
        throw new Error(`Test file not found: ${target}`);
      }
      const res = run('node', [target], { timeoutMs: 120000 });
      results.node = {
        passed: res.exit_code === 0,
        exit_code: res.exit_code,
        duration_ms: res.duration_ms,
        output_tail: (res.stdout + res.stderr).slice(-3500),
      };
    } else {
      const res = run('node', [path.join(BOT_DIR, 'test', 'run_tests.js')], { timeoutMs: 120000 });
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
      // a test file or folder under tests/ (with an optional ::test), never an option or a path outside the repo
      const target = String(args.pytest_target).trim();
      if (!/^tests(?:\/[\w.-]+)*(?:::[\w\[\].:,=-]+)*$/.test(target) || target.split('/').includes('..')) {
        throw new Error(`pytest_target "${target.slice(0, 80)}" isn't a path under tests/ (for example tests/test_triage.py::test_name)`);
      }
      pytestArgs.push(target);
    }
    const res = run(PYTHON_BIN, pytestArgs, {
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

  if (suite === 'evals' || suite === 'all') {
    const res = run(PYTHON_BIN, ['-m', 'evals.run_evals'], {
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

  // Nothing ran is never a pass
  const allPassed = Object.keys(results).length > 0 && Object.values(results).every(r => r.passed);
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

async function handleSimulateGuidanceRule(args) {
  const guidanceText = String(args.guidance_text || '').trim();
  if (!guidanceText) {
    throw new Error('guidance_text is required');
  }
  const appliesTo = String(args.applies_to || '').trim();
  const quote = String(args.quote || guidanceText).trim();
  const testProduct = String(args.product || '').trim();
  const alertText = String(args.alert_text || '').trim();

  const { bot } = loadFreshBotVm();
  const normText = bot.kbNorm_(guidanceText);
  const normQuote = bot.kbNorm_(quote);
  const quoteProblem = bot.kbQuoteProblem_(normQuote, normText, true, 'Guidance row G1');
  const hasHoldRx = bot.ev(`KB_HOLD_RX_.test(${JSON.stringify(normText)})`);
  const hasStartRx = bot.ev(`KB_START_RX_.test(${JSON.stringify(normText)})`);

  let mode = 'informational_only';
  if (hasHoldRx) {
    mode = 'suppress_or_hold (noAlertChecks.guidance)';
  } else if (hasStartRx && !quoteProblem) {
    mode = 'can_start_social_alert (Row 13 kbPromotion_)';
  }

  const scopeCheckForProduct = prod => {
    if (!prod) return null;
    const prob = bot.kbScopeProblem_(appliesTo, { product: prod, other_products: [] });
    return {
      product: prod,
      allowed: prob === '',
      reason: prob || 'Matches Applies to scope',
    };
  };

  let alertSimulation = null;
  if (alertText) {
    const now = Date.now();
    const parsed = bot.parseAlert_(alertText);
    const review = bot.reviewAlert_(parsed, { now, settings: bot.ev('GEN.settings'), history: [] });
    const baseEsc = bot.escalation_(review.fields, { now });
    const guidanceList = [{ source: 'tab', text: guidanceText, applies_to: appliesTo }];
    const citation = bot.kbCitation_(
      { source: 'guidance', guidance_n: 1, quote },
      guidanceList,
      { text: '', docs: [] },
      review.fields
    );
    const reviewWithCitation = Object.assign({}, review, {
      socialAlert: {
        warranted: !hasHoldRx,
        confidence: 0.95,
        source: 'ai',
        per: citation,
      },
      noAlertChecks: {
        guidance: hasHoldRx,
      },
    });
    const promoted = bot.kbPromotion_(reviewWithCitation, baseEsc, now);
    alertSimulation = {
      product: review.fields.product,
      exposure_tag: review.fields.exposure_tag,
      total_engagement: review.fields.total_engagement,
      baseline_escalation: {
        escalated: baseEsc.escalated,
        track: baseEsc.track,
        suppression: baseEsc.suppression,
        reason: baseEsc.reason,
      },
      citation_check: citation,
      promoted_under_row13: promoted
        ? {
            escalated: promoted.escalated,
            track: promoted.track,
            kb_basis: promoted.kb_basis,
            reasons: promoted.reasons,
          }
        : null,
      suppressed_by_hold_guidance: hasHoldRx,
    };
  }

  return {
    guidance_text: guidanceText,
    applies_to: appliesTo || '(all products)',
    quote_tested: quote,
    rule_classification: mode,
    can_start_alerts_under_row13: quoteProblem === '',
    quote_validation_problem: quoteProblem || null,
    contains_start_keywords: hasStartRx,
    contains_hold_keywords: hasHoldRx,
    product_scope_check: scopeCheckForProduct(testProduct),
    alert_simulation: alertSimulation,
  };
}

function safeJsonParse(str, fallback = null) {
  if (!str || typeof str !== 'string') return fallback;
  try {
    return JSON.parse(str);
  } catch (_e) {
    return fallback;
  }
}

// How many of the Alert log's newest rows slrr_backtest_alerts reads (it read rows 2-500, the oldest, before)
const BACKTEST_READ_ROWS = 500;

async function handleBacktestAlerts(args, deps) {
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
  const disagreementsOnly = args.disagreements_only === true;
  const candidateGuidance = args.candidate_guidance || null;
  const customAlerts = Array.isArray(args.custom_alerts) ? args.custom_alerts : null;
  const { bot } = loadFreshBotVm();
  const now = Date.now();

  let records = [];
  let alertLogRead = null;  // what was read of the Alert log (null with custom_alerts: the sheet isn't read)
  if (customAlerts && customAlerts.length) {
    records = customAlerts.slice(0, limit).map((item, idx) => {
      if (typeof item === 'string') {
        const parsed = bot.parseAlert_(item);
        const rev = bot.reviewAlert_(parsed, { now, settings: bot.ev('GEN.settings'), history: [] });
        return {
          id: `custom-${idx + 1}`,
          fields: rev.fields,
          recorded_bot_call: null,
          recorded_im_call: null,
        };
      }
      return {
        id: item.alert_id || `custom-${idx + 1}`,
        fields: item.fields || item,
        recorded_bot_call: item.bot_call || null,
        recorded_im_call: item.im_call || null,
      };
    });
  } else {
    // The bot adds alerts at the bottom of the Alert log (header in row 1): its newest rows (readTabTails). The MCP
    // server passes no deps; the tests pass deps.fetchJson with a canned sheet
    const fetchJson = (deps && deps.fetchJson) || gcpFetchJson;
    const sheetId = args.sheet_id || DEFAULT_STORE_SHEET_ID;
    const meta = await getWorkbookMetadata(sheetId, fetchJson);
    if (!((meta && meta.sheets) || []).some(s => s && s.properties && s.properties.title === 'Alert log')) {
      throw new Error('The workbook has no "Alert log" tab to backtest (pass custom_alerts to backtest offline).');
    }
    const tail = (await readTabTails(
      sheetId,
      meta,
      [{ tab: 'Alert log', lastCol: 'AP', topRows: 1, maxRows: BACKTEST_READ_ROWS }],
      fetchJson
    ))['Alert log'];
    alertLogRead = tailReadSummary('Alert log', tail);
    const header = (tail.top[0] || []).map(h => String(h || '').trim());
    const objs = [];
    tail.rows.forEach((row, i) => {
      const r = row || [];
      const o = {};
      header.forEach((h, j) => {
        if (h) o[h] = r[j] !== undefined ? String(r[j]) : '';
      });
      const ff = safeJsonParse(o.forwarded_fields, null);
      if (!ff || !ff.product) return;
      const emailSt = String(o.email_status || '').trim();
      const botSent = ['sent', 'drafted', 'pending'].includes(emailSt);
      const mirrored = String(o.mirrored || '');
      const imNoAction = mirrored.includes('❌');
      const imAlerted = ['🚨', '📧', '✅'].some(e => mirrored.includes(e));
      const imCall = imAlerted ? 'alerted' : imNoAction ? 'no_action' : 'unknown';
      const botCall = botSent ? 'alerted' : 'no_action';
      if (disagreementsOnly && (imCall === 'unknown' || imCall === botCall)) return;
      objs.push({
        id: o.alert_id || `row-${tail.firstRow + i}`,
        author: o.author || ff.author || '',
        fields: ff,
        recorded_bot_call: botCall,
        recorded_im_call: imCall,
        recorded_email_status: emailSt,
        recorded_mirrored: mirrored,
      });
    });
    records = objs.slice(-limit);
  }

  let escalatedCount = 0;
  let suppressedCount = 0;
  let promotedByGuidanceCount = 0;
  let diffFromRecordedBot = 0;
  const details = [];

  for (const rec of records) {
    const esc = bot.escalation_(rec.fields, { now });
    let finalEscalated = !!esc.escalated;
    let promotedByGuidance = false;

    if (candidateGuidance && candidateGuidance.text) {
      const gText = String(candidateGuidance.text);
      const gApplies = String(candidateGuidance.applies_to || '');
      const gQuote = String(candidateGuidance.quote || gText);
      const normText = bot.kbNorm_(gText);
      const hasHold = bot.ev(`KB_HOLD_RX_.test(${JSON.stringify(normText)})`);
      const scopeProb = bot.kbScopeProblem_(gApplies, rec.fields);
      if (hasHold && !scopeProb) {
        finalEscalated = false;
      } else if (!finalEscalated) {
        const citation = bot.kbCitation_(
          { source: 'guidance', guidance_n: 1, quote: gQuote },
          [{ source: 'tab', text: gText, applies_to: gApplies }],
          { text: '', docs: [] },
          rec.fields
        );
        const prom = bot.kbPromotion_(
          {
            fields: rec.fields,
            socialAlert: { warranted: true, confidence: 0.95, source: 'ai', per: citation },
            noAlertChecks: {},
          },
          esc,
          now
        );
        if (prom && prom.escalated) {
          finalEscalated = true;
          promotedByGuidance = true;
          promotedByGuidanceCount++;
        }
      }
    }

    if (finalEscalated) escalatedCount++;
    else suppressedCount++;

    const localCall = finalEscalated ? 'alerted' : 'no_action';
    const changedVsBot = rec.recorded_bot_call && rec.recorded_bot_call !== localCall;
    if (changedVsBot) diffFromRecordedBot++;

    details.push({
      id: rec.id,
      author: rec.author || rec.fields.author || '',
      product: rec.fields.product || '',
      issue_name: rec.fields.issue_name || '',
      exposure_tag: rec.fields.exposure_tag || '',
      engagement: rec.fields.total_engagement,
      local_rules_call: localCall,
      track: esc.track,
      suppression: esc.suppression,
      reason: esc.reason,
      promoted_by_candidate_guidance: promotedByGuidance,
      recorded_bot_call: rec.recorded_bot_call,
      recorded_im_call: rec.recorded_im_call,
      changed_vs_recorded_bot: !!changedVsBot,
    });
  }

  return {
    total_tested: details.length,
    // which Alert log rows the alerts came from (the newest ones), and whether older rows were left out; null with
    // custom_alerts
    alert_log_read: alertLogRead,
    escalated_by_local_vm: escalatedCount,
    suppressed_by_local_vm: suppressedCount,
    promoted_by_candidate_guidance: promotedByGuidanceCount,
    changed_vs_recorded_bot_count: diffFromRecordedBot,
    results: details,
  };
}

const TOOLS = [
  {
    name: 'slrr_audit_safety_invariants',
    description:
      'Run the 8 pre-deploy safety checks: Generated.gs YAML sync, the B30 testing sandbox with no hardcoded emails, every Control switch defaulting to OFF, B31 strict 15-min lookback validation, B35 Watch alerts defaulting to OFF, 49,000-char cell caps, .claspignore protection, and zero git remotes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: handleAuditSafetyInvariants,
  },
  {
    name: 'slrr_test_leak_guard',
    description:
      'Test candidate outbound Burson message text and/or reaction emoji against the bot\'s leak guards (`outboxGuardHits_`, `guardHits_`, `relayGuardHits_`, `outboxEmojiProblem_`), loaded from the local .gs files into the Apps Script V8 VM. Production also blocks the real names and ids of the internal spaces, which this tool does not know: pass them in `internal_space_terms`, or a pass covers the fixed patterns only.',
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
      'Run the Apps Script Node test suite (`node`), a single `switch_*.test.js` file, the Python test suite (`pytest`), offline golden evals (`evals`), or `all` (node, pytest and evals; the default). An unknown suite is an error.',
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
  {
    name: 'slrr_simulate_guidance_rule',
    description:
      'Validate and simulate a candidate `Guidance` tab rule in the local Apps Script V8 VM ($0 cost). Checks whether the wording passes `kbQuoteProblem_` (Row 13 `KB & Guidance can start alerts` vs hold/suppress `KB_HOLD_RX_`), checks `Applies to` product scoping (`kbScopeProblem_`), and optionally simulates its effect on an alert.',
    inputSchema: {
      type: 'object',
      properties: {
        guidance_text: {
          type: 'string',
          description: 'Candidate Guidance column A text (e.g., "Escalate all posts about Chrome zero-day CVE-2026-125350 regardless of engagement").',
        },
        applies_to: {
          type: 'string',
          description: 'Optional Guidance column B `Applies to` value (e.g., "Chrome" or blank for all).',
        },
        quote: {
          type: 'string',
          description: 'Optional exact quote substring to test with `kbCitation_` (defaults to full guidance_text).',
        },
        product: {
          type: 'string',
          description: 'Optional product name to test against `kbScopeProblem_`.',
        },
        alert_text: {
          type: 'string',
          description: 'Optional raw Zapier alert text to simulate before/after escalation with this Guidance rule.',
        },
      },
      required: ['guidance_text'],
    },
    handler: handleSimulateGuidanceRule,
  },
  {
    name: 'slrr_backtest_alerts',
    description:
      'Backtest the local V8 Apps Script rules engine (`escalation_`, `kbPromotion_`) across historical alerts from the live `Alert log` tab (the most recent of its newest 500 rows; `alert_log_read` says which rows were read) or `custom_alerts`, at $0 cost (zero LLM/BigQuery charges). Optionally inject a `candidate_guidance` rule to see how many below-threshold/ongoing alerts it promotes or suppresses.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max historical alerts to backtest (default: 25, max: 100).',
        },
        disagreements_only: {
          type: 'boolean',
          description: 'If true, only backtest rows where the recorded Bot call and IM emoji call differed.',
        },
        candidate_guidance: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            applies_to: { type: 'string' },
            quote: { type: 'string' },
          },
          description: 'Optional candidate Guidance rule to simulate across the alert batch.',
        },
        custom_alerts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of raw Zapier alert texts to backtest offline instead of fetching from the Sheet.',
        },
        sheet_id: {
          type: 'string',
          description: 'Optional Google Sheet ID override.',
        },
      },
    },
    handler: handleBacktestAlerts,
  },
];

const server = createMcpStdioServer({
  name: 'slrr-dev-pipeline',
  version: '1.1.0',
  instructions:
    'Local V8 simulation, leak-guard verification, safety-invariant auditing, historical backtesting, and test execution MCP server for burson-triage-agent.',
  tools: TOOLS,
});

if (require.main === module) {
  server.start();
}

module.exports = { TOOLS, server };
