/**
 * SheetTestAlert.gs — Interactive `Test alert` worksheet for testing single-product and multi-product Social Alert
 * routing directly from the `slrr-agentic-assistant` Google Sheet (`🧪 Test Alert → 🚀 Send Test Alert` menu button or
 * setting `Test alert!B2` to `SEND NOW`).
 *
 * Safety invariants:
 * - Zero hardcoded emails: recipients come strictly from `Brand safety groups` Column C (`Group test emails`, Control
 *   row 37 ON), `Control!B30` (`Safety valve`, row 29 ON with row 37 OFF), or `Brand safety groups` Column B (LIVE).
 * - Tab ownership safeguard: never overwrites or modifies a `Test alert` tab unless `A1` matches `SHEET_TEST_HEADER_`.
 *   `Brand safety groups` is strictly read-only.
 * - Zero Burson-space leaks: posts only to a Google-only internal space (`B9`, `B10`, `B33`, or internal `B4`/`B3`),
 *   never to `S-F Burson` (`B25`) or any external space, and never writes synthetic test rows to SLRR BigQuery.
 */

const SHEET_TEST_TAB_ = 'Test alert';
const SHEET_TEST_HEADER_ = 'SLRR Test Alert Sender';
const SHEET_TEST_INGESTED_ = 'Sheet test alert';
let SHEET_TEST_SEQ_ = 0;

const SHEET_TEST_TAGS_ = [
  'Product - Scams involving Google products',
  'Product - Product failures - physical safety issues',
  'Product - Security & privacy vulnerabilities',
  'Product - Dangerous results (e.g. medical/legal)',
  'Product - Outage/widespread bug',
  'Product - Perceived bias',
  'Corporate - Executive misconduct/controversy',
  'Content - Negative reaction to owned social post',
];

const SHEET_TEST_TOPICS_ = [
  'None',
  'Politics',
  'Criminal/Dangerous Activity',
  'Malicious & Unwanted Software',
  'Child Safety',
  'Regulated Goods & Services',
];

const SHEET_TEST_PLATFORMS_ = [
  'X',
  'Instagram',
  'Reddit',
  'TikTok',
  'Threads',
  'Facebook',
  'LinkedIn',
  'Bluesky',
];

/** Ownership check: true only when `sh` was created by `ensureTestAlertTab_` / `Code.gs`. Pure-safe. */
function isTestAlertTab_(sh) {
  if (!sh) return false;
  try {
    return String(sh.getRange(1, 1).getValue() || '').trim() === SHEET_TEST_HEADER_;
  } catch (e) {
    return false;
  }
}

/** Formula for Column C next to each Product slot (`rowNum` 5..9), showing live routing from `Brand safety groups`. Pure. */
function sheetTestRouteFormula_(rowNum) {
  const cell = `B${rowNum}`;
  return `=IF(TRIM(${cell})="","",IFERROR(IF(Control!$B$37="ON","Test (Col C): "&IF(INDEX('Brand safety groups'!$C$2:$C$200,MATCH(${cell},'Brand safety groups'!$A$2:$A$200,0))="","(none — will skip)",INDEX('Brand safety groups'!$C$2:$C$200,MATCH(${cell},'Brand safety groups'!$A$2:$A$200,0))),IF(Control!$B$29="ON","Testing B30: "&IF(Control!$B$30="","(B30 blank — waiting)",Control!$B$30),"Live (Col B): "&INDEX('Brand safety groups'!$B$2:$B$200,MATCH(${cell},'Brand safety groups'!$A$2:$A$200,0)))),"(comma list / custom)"))`;
}

/** Product names from `Brand safety groups` Col A (or `GEN.distribution.products` fallback) for dropdown validation. */
function sheetTestProductChoices_(ss) {
  const bsg = ss ? ss.getSheetByName(BRAND_SAFETY_GROUPS_TAB_) : null;
  if (bsg && bsg.getLastRow() >= 2) {
    try {
      const vals = bsg.getRange(2, 1, Math.min(bsg.getLastRow() - 1, 200), 1).getDisplayValues();
      const names = [];
      vals.forEach(r => {
        const n = String((r && r[0]) || '').trim();
        if (n && !names.includes(n)) names.push(n);
      });
      if (names.length) return names;
    } catch (e) {}
  }
  const dist = (typeof GEN !== 'undefined' && GEN && GEN.distribution && GEN.distribution.products) || [];
  return dist.filter(p => p && !p.deprecated && p.name).map(p => p.group_name || p.name);
}

/** Applies dropdown validations onto `Test alert` (`B2`, `B5:B9`, `B12`, `B13`, `B14`, `B17`). Never throws. */
function applyTestAlertValidations_(ss, sh) {
  if (!sh || typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.newDataValidation) return;
  try {
    const actionRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['Idle', 'SEND NOW'], true)
      .setAllowInvalid(false)
      .build();
    sh.getRange(2, 2).setDataValidation(actionRule);

    const bsg = ss ? ss.getSheetByName(BRAND_SAFETY_GROUPS_TAB_) : null;
    const prodBuilder = SpreadsheetApp.newDataValidation();
    let prodRule = null;
    if (bsg && typeof prodBuilder.requireValueInRange === 'function') {
      prodRule = prodBuilder.requireValueInRange(bsg.getRange('A2:A200'), true).setAllowInvalid(true).build();
    } else {
      const choices = sheetTestProductChoices_(ss);
      if (choices.length) prodRule = prodBuilder.requireValueInList(choices, true).setAllowInvalid(true).build();
    }
    if (prodRule) {
      for (let r = 5; r <= 9; r++) sh.getRange(r, 2).setDataValidation(prodRule);
    }

    sh.getRange(12, 2).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(SHEET_TEST_TAGS_, true).setAllowInvalid(true).build()
    );
    sh.getRange(13, 2).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(SHEET_TEST_TOPICS_, true).setAllowInvalid(true).build()
    );
    sh.getRange(14, 2).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(SHEET_TEST_PLATFORMS_, true).setAllowInvalid(true).build()
    );
    sh.getRange(17, 2).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['No', 'Yes'], true).setAllowInvalid(false).build()
    );
  } catch (e) {}
}

/**
 * Ensures the `Test alert` tab exists on workbooks that have `Brand safety groups` (or when explicitly requested).
 * Respects the tab ownership safeguard: if a user-owned `Test alert` tab already exists without `SHEET_TEST_HEADER_`,
 * returns `null` without touching it.
 */
function ensureTestAlertTab_(ss) {
  if (!ss) return null;
  const existing = ss.getSheetByName(SHEET_TEST_TAB_);
  if (existing) {
    if (!isTestAlertTab_(existing)) return null;
    applyTestAlertValidations_(ss, existing);
    return existing;
  }
  const sheets = ss.getSheets();
  const bsgIdx = sheets.findIndex(s => s.getName() === BRAND_SAFETY_GROUPS_TAB_);
  const sh = bsgIdx >= 0 ? ss.insertSheet(SHEET_TEST_TAB_, bsgIdx + 1) : ss.insertSheet(SHEET_TEST_TAB_);
  const choices = sheetTestProductChoices_(ss);
  const firstProd = choices.includes('Gemini App') ? 'Gemini App' : (choices[0] || 'Gemini App');
  const rows = [
    [
      SHEET_TEST_HEADER_,
      'Pick 1–5 products below (or comma-separate in B5), then click 🧪 Test Alert → 🚀 Send Test Alert (or set B2 to SEND NOW).',
      'Email Route Preview (from Brand safety groups)',
    ],
    [
      'Action',
      'Idle',
      'Ready — pick product(s) in B5:B9, then click 🧪 Test Alert → 🚀 Send Test Alert (or set B2 to SEND NOW)',
    ],
    [
      'Last Result',
      'No test alert sent yet.',
      '=IF(Control!$B$37="ON","Mode: Group test emails (Control!B37 ON → Brand safety groups Col C)",IF(Control!$B$29="ON","Mode: Testing sandbox (Control!B29 ON → Control!B30)","Mode: LIVE (Brand safety groups Col B)"))',
    ],
    ['Product Slot', 'Product / Group (dropdown or comma-separated)', 'Configured Destination'],
    ['Product 1', firstProd, sheetTestRouteFormula_(5)],
    ['Product 2 (optional)', '', sheetTestRouteFormula_(6)],
    ['Product 3 (optional)', '', sheetTestRouteFormula_(7)],
    ['Product 4 (optional)', '', sheetTestRouteFormula_(8)],
    ['Product 5 (optional)', '', sheetTestRouteFormula_(9)],
    ['Alert Field', 'Value (editable — defaults trigger a Social Alert)', 'Notes'],
    ['Issue Title', 'Test Multi-Product Social Alert', 'Shown in the Social Alert subject line and summary'],
    ['Exposure Tag', 'Product - Scams involving Google products', 'P0/P1 tag ensures the test alert escalates to email'],
    ['Sensitive Topic', 'None', 'Optional Sensitive Topic (or None)'],
    ['Platform', 'X', 'Social platform (avoid YouTube when testing standard PA emails)'],
    ['Author', '@test_routing_account', 'Sample handle used on the test card'],
    ['Engagements', '500', '100+ engagements meets the SLRR collection threshold'],
    ['KOF', 'No', 'Key Opinion Former (Yes / No)'],
    [
      'Summary',
      'Synthetic test alert triggered from the Test alert tab to verify per-product Social Alert email routing.',
      'Included in the Chat card and formulated Social Alert email(s)',
    ],
  ];
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  try {
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 185);
    sh.setColumnWidth(2, 390);
    sh.setColumnWidth(3, 440);
    sh.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#e8f0fe');
    sh.getRange(4, 1, 1, 3).setFontWeight('bold').setBackground('#f1f3f4');
    sh.getRange(10, 1, 1, 3).setFontWeight('bold').setBackground('#f1f3f4');
    sh.getRange(2, 1, 2, 1).setFontWeight('bold');
  } catch (e) {}
  applyTestAlertValidations_(ss, sh);
  return sh;
}

/** Updates `Test alert!C2` if a test send is queued while `Control!B2` (`Bot`) is `OFF`. Never throws. */
function noteSheetTestPaused_(ss) {
  try {
    const sh = ss ? ss.getSheetByName(SHEET_TEST_TAB_) : null;
    if (!isTestAlertTab_(sh)) return;
    const action = String(sh.getRange(2, 2).getValue() || '').trim().toUpperCase();
    if (action === 'SEND NOW' || action === 'SEND' || action === 'QUEUED') {
      sh.getRange(2, 3).setValue('⏸️ Waiting — Bot is OFF on Control!B2 (turn Bot ON to send)');
    }
  } catch (e) {}
}

/** Collects deduplicated product/group names from `B5:B9` (supports both per-row dropdowns and comma-separated lists). Pure. */
function readSheetTestProducts_(vals) {
  const out = [];
  const seen = new Set();
  for (let r = 4; r <= 8; r++) {
    const raw = String(((vals[r] || [])[1]) || '').trim();
    if (!raw) continue;
    const split = typeof splitProductField_ === 'function' ? splitProductField_(raw) : null;
    const parts = split && Array.isArray(split.all) && split.all.length ? split.all : raw.split(/[,;\n]+/);
    parts.forEach(p => {
      const clean = String(p || '').trim();
      const key = clean.toLowerCase();
      if (clean && !seen.has(key)) {
        seen.add(key);
        out.push(clean);
      }
    });
  }
  return out;
}

/**
 * Resolves a strictly internal Google-only Chat space for posting the synthetic test card (`B9` Mirror, `B10`
 * Auto-correct, `B33` Other alerts, or internal `B4`/`B3`). Never returns `S-F Burson` (`B25`) or any external space.
 */
function resolveSheetTestSpace_(wanted, sfb) {
  const sfbId = sfb && sfb.space && sfb.space.id ? sfb.space.id : '';
  const candidates = [
    wanted && wanted.mirror,
    wanted && wanted.autocorrect,
    wanted && wanted.otherSpace,
    wanted && wanted.analyst,
    wanted && wanted.burson,
  ];
  for (const raw of candidates) {
    const ref = String(raw || '').trim();
    if (!ref) continue;
    try {
      const sp = resolveSpace_(ref, 'analyst', false);
      if (!sp || !sp.id) continue;
      if (sfbId && sp.id === sfbId) continue;
      if (sp.externalUserAllowed) continue;
      return sp;
    } catch (e) {}
  }
  return null;
}

/** Summarizes per-product Social Alert delivery outcomes for `Test alert!B3` and the Chat thread note. Pure. */
function summarizeSheetTestResult_(alertId, spaceName, products, row) {
  const inp = (row && row.email_input) || {};
  const teams = Array.isArray(inp.team_emails) ? inp.team_emails : [];
  const status = String((row && row.email_status) || '');
  const parts = [];
  if (teams.length) {
    teams.forEach(t => {
      const label = t.product || t.distro || t.key || 'Group';
      if (t.status === 'sent') {
        const rcpt = [].concat(t.recipients || t.to || []).join(', ') || 'recipient';
        parts.push(`${label} → sent to ${rcpt}`);
      } else if (t.status === 'drafted') {
        const rcpt = [].concat(t.recipients || t.to || []).join(', ') || 'group POCs';
        parts.push(`${label} → Gmail draft (${rcpt})`);
      } else if (t.status === 'skipped_no_test_email') {
        parts.push(`${label} → skipped (no Test Email in Brand safety groups Col C)`);
      } else {
        parts.push(`${label} → ${t.status || 'pending'}${t.error ? ` (${t.error})` : ''}`);
      }
    });
  } else if (status === 'sent') {
    parts.push(`${products.join(', ')} → sent to ${row.email_to || 'recipient'}`);
  } else if (status === 'drafted') {
    parts.push(`${products.join(', ')} → Gmail draft (${row.email_to || 'group POCs'})`);
  } else if (status === 'skipped_no_test_email') {
    parts.push(`${products.join(', ')} → skipped (no Test Email in Brand safety groups Col C)`);
  } else if (row && row.email_error) {
    parts.push(`${products.join(', ')} → ${row.email_error}`);
  } else {
    parts.push(`${products.join(', ')} → ${status || 'processed'}`);
  }
  const head = `${alertId}${spaceName ? ` · Posted in ${spaceName}` : ''}`;
  return truncate_(`${head} · ${parts.join(' ; ')}`, 1500);
}

/**
 * Ensures `Test alert` exists when `Brand safety groups` is present, and executes a queued `SEND NOW` test alert
 * immediately using the bot's real `escalation_` + `productEmailTargets_` + `tryDraft_` pipeline.
 */
function runSheetTestAlert_(ss, control, wanted, sfb, mode, testersObj) {
  if (!ss) return null;
  let sh = ss.getSheetByName(SHEET_TEST_TAB_);
  if (!sh && ss.getSheetByName(BRAND_SAFETY_GROUPS_TAB_)) {
    sh = ensureTestAlertTab_(ss);
  }
  if (!isTestAlertTab_(sh)) return null;

  const vals = sh.getRange(1, 1, Math.max(18, Math.min(sh.getLastRow(), 25)), 3).getDisplayValues();
  const action = String(((vals[1] || [])[1]) || '').trim().toUpperCase();
  if (action !== 'SEND NOW' && action !== 'SEND' && action !== 'QUEUED') return null;

  // Reset B2 to Idle immediately before any network call so a partial failure can never loop every minute
  sh.getRange(2, 2).setValue('Idle');
  sh.getRange(2, 3).setValue('⏳ Sending test alert…');

  try {
    // Force-sync Brand safety groups right now so any Column B / Column C email edits made seconds ago apply immediately
    if (typeof syncBrandSafetyGroups_ === 'function') {
      syncBrandSafetyGroups_(ss, { force: true });
    }

    const products = readSheetTestProducts_(vals);
    if (!products.length) {
      sh.getRange(2, 3).setValue('⚠️ Pick at least one product in B5:B9');
      sh.getRange(3, 2).setValue('No alert sent: Product 1–5 (B5:B9) were all blank.');
      return { sent: false, reason: 'no_products' };
    }

    const space = resolveSheetTestSpace_(wanted, sfb);
    if (!space) {
      sh.getRange(2, 3).setValue('⚠️ Configure an internal test space (B9, B10, or B33) on Control');
      sh.getRange(3, 2).setValue('No alert sent: no Google-only internal Chat space found on the Control tab.');
      return { sent: false, reason: 'no_space' };
    }

    const sfbSpace = sfb && sfb.space ? sfb.space : null;
    const testersList = testersObj && Array.isArray(testersObj.testers)
      ? testersObj.testers
      : testersFor_(wanted ? wanted.testers : '').testers;
    const cfgBase = {
      burson: space,
      analyst: space,
      mirror: space,
      outboundBlocked: true,
      sfBurson: sfbSpace,
      testers: testersList,
    };
    cfgBase.mode = runMode_(wanted.switches, wanted.testCopy, sfbSpace, cfgBase);
    const ctx = buildCtx_(cfgBase, ss, wanted.switches);

    const cellVal = (rowIdx, fallback) => {
      const v = String(((vals[rowIdx] || [])[1]) || '').trim();
      return v || fallback;
    };
    const nowMs = ctx.now();
    SHEET_TEST_SEQ_ = (SHEET_TEST_SEQ_ || 0) + 1;
    const seq = SHEET_TEST_SEQ_;
    const issueTitle = cellVal(10, 'Test Multi-Product Social Alert');
    const exposureTag = cellVal(11, 'Product - Scams involving Google products');
    const sensitiveRaw = cellVal(12, 'None');
    const sensitiveTopic = /^none$/i.test(sensitiveRaw) ? '' : sensitiveRaw;
    const platform = cellVal(13, 'X');
    const authorRaw = cellVal(14, '@test_routing_account');
    const handleSlug = authorRaw.replace(/[^a-zA-Z0-9_]+/g, '') || 'test_routing_account';
    const engagementsNum = Math.max(0, parseInt(String(cellVal(15, '500')).replace(/[^0-9]/g, ''), 10) || 500);
    const isKof = /^yes$|^true$/i.test(cellVal(16, 'No'));
    const summaryText = cellVal(
      17,
      'Synthetic test alert triggered from the Test alert tab to verify per-product Social Alert email routing.'
    );
    const postUrl = `https://x.com/${handleSlug}/status/99${nowMs}${seq}`;
    const postedEt = typeof nowLabel_ === 'function' ? nowLabel_() : new Date(nowMs).toISOString();

    const fields = {
      issue_name: issueTitle,
      issue_status: 'New',
      exposure_tag: exposureTag,
      risk_tags: sensitiveTopic ? [sensitiveTopic] : [],
      sensitive_topics: sensitiveTopic ? [sensitiveTopic] : [],
      product: products[0],
      other_products: products.slice(1),
      product_targets: products.slice(),
      social_network: platform,
      author: authorRaw,
      post_url: postUrl,
      post_date: postedEt,
      total_engagement: engagementsNum,
      engagement_level: engagementsNum >= 2000 ? 'HIGH' : 'LOW',
      kof: isKof ? 'Yes' : 'No',
      summary: summaryText,
    };

    let esc = escalation_(fields, 'NEW');
    esc = Object.assign({}, esc, {
      escalated: true,
      action: 'EMAIL_ALERT',
      suppression: null,
      product: products[0],
      issue_name: issueTitle,
    });
    if (products.length >= 2) {
      esc.other_products = products.slice(1);
      esc.product_targets = products.slice();
    }

    const cardLines = [
      `🧪 *Sheet Test Alert* · ${issueTitle}`,
      `*Link:* <${postUrl}|View synthetic test post>`,
      `*Author:* ${authorRaw} · ${platform} · ${fmtInt_(engagementsNum)} engagements`,
      `*Product:* ${products.join(', ')}`,
      `*Exposure Tag:* ${exposureTag}`,
      `*Sensitive Topic:* ${sensitiveTopic || 'None'}`,
      `*KOF:* ${isKof ? 'Yes' : 'No'}`,
      `*Summary:* ${summaryText}`,
    ];
    const cardMsg = postTo_(ctx, space.id, cardLines.join('\n'), null, `sheettest:${nowMs}:${seq}`);
    const alertId = ctx.store.nextAlertId();

    const review = {
      fields,
      recordKey: recordKey_(fields),
      issueTokens: typeof issueTokens_ === 'function' ? issueTokens_(issueTitle) : [],
      recommendedGroups: [],
      groupReasons: {},
      socialAlert: { warranted: true, source: 'rule', confidence: 1, reason: 'Triggered from Test alert sheet tab' },
    };
    const draft = draftRowFor_(ctx, review, esc, null);
    const row = ctx.store.addAlert(Object.assign({
      alert_id: alertId,
      source_message: cardMsg.name,
      source_thread: cardMsg.thread || '',
      record_key: review.recordKey || `sheettest:${nowMs}`,
      author: authorRaw,
      issue_tokens: review.issueTokens,
      exposure_tag: exposureTag,
      status: 'ok',
      requested: [],
      forwarded_fields: snapshotFields_(fields),
      forward_message: cardMsg.name,
      forward_thread: cardMsg.thread || '',
      burson_done: true,
      source_at: nowMs,
      seen_at: postedEt,
      ingested: SHEET_TEST_INGESTED_,
    }, draft || {}));

    ctx.store.markDone(cardMsg.name, 'sheet_test_alert', alertId);
    ctx.recent.add(cardMsg.name, cardMsg.createTime || nowMs);
    ctx.recent.save();

    const report = { seen: 1, handled: 1, alerts: 1, drafts: 0, drafts_sent: 0, errors: [] };
    if (draft) {
      watchDraft_(ctx, alertId);
      tryDraft_(ctx, row, report);
    }

    const summary = summarizeSheetTestResult_(alertId, space.name, products, row);
    const st = String(row.email_status || '');
    const badge = st === 'sent'
      ? `✅ Sent at ${postedEt} (${alertId})`
      : st === 'drafted'
        ? `📝 Drafted at ${postedEt} (${alertId})`
        : st === 'skipped_no_test_email'
          ? `⏭️ Skipped at ${postedEt} — no Col C test email set (${alertId})`
          : `⚠️ ${st || 'Checked'} at ${postedEt} (${alertId})`;

    sh.getRange(2, 3).setValue(badge);
    sh.getRange(3, 2).setValue(summary);

    try {
      postTo_(ctx, space.id, `🧪 *Test Alert Result (${alertId}):*\n${summary}`, cardMsg.thread || null, `sheettestres:${alertId}`);
    } catch (e) {}

    return { sent: st === 'sent', status: st, alertId, products, summary };
  } catch (err) {
    const msg = truncate_(String((err && err.message) || err), 220);
    try {
      sh.getRange(2, 3).setValue(`⚠️ Failed: ${msg}`);
      sh.getRange(3, 2).setValue(`Error while sending test alert: ${msg}`);
    } catch (e2) {}
    throw err;
  }
}
