/**
 * SheetTestAlert.gs — Interactive `Test alert` worksheet for posting single-product and multi-product test alerts into
 * the test Google Chat space (`🧪 Test Alert → 🚀 Send Test Alert` menu button or setting `Test alert!B2` to `SEND NOW`),
 * where the bot's Chat poller picks the alert up, works it in-place (emojis + thread note), and sends each product's
 * formulated Social Alert email.
 *
 * Safety invariants:
 * - Zero hardcoded emails: recipients come strictly from `Brand safety groups` Column C (`Group test emails`, Control
 *   row 37 ON), `Control!B30` (`Safety valve`, row 29 ON with row 37 OFF), or `Brand safety groups` Column B (LIVE).
 * - Tab ownership safeguard: never overwrites or modifies a `Test alert` tab unless `A1` matches `SHEET_TEST_HEADER_`.
 *   `Brand safety groups` is strictly read-only.
 * - Zero Burson-space leaks: posts only to a Google-only internal test space (`B9`, `B10`, `B33`, or internal `B3`),
 *   never to `S-F Burson` (`B25`) or any external space, and never writes synthetic test rows to SLRR BigQuery.
 */

const SHEET_TEST_TAB_ = 'Test alert';
const SHEET_TEST_HEADER_ = 'SLRR Test Alert Sender';
const SHEET_TEST_INGESTED_ = 'Sheet test alert';
const SHEET_TEST_MSGS_PROP_ = 'SHEET_TEST_MSGS';
const SHEET_TEST_MSGS_MAX_ = 50;
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
    try {
      if (String(existing.getRange(16, 2).getValue() || '').trim() === '500' &&
          /100\+ engagements/.test(String(existing.getRange(16, 3).getValue() || ''))) {
        existing.getRange(16, 2, 1, 2).setValues([
          ['2500', '2,000+ (HIGH) meets the SLRR Social Alert email threshold across P0/P1/P2'],
        ]);
      }
    } catch (e) {}
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
    ['Issue Title', 'Test Multi-Product Social Alert', 'Shown in the Chat alert and Social Alert subject line'],
    ['Exposure Tag', 'Product - Scams involving Google products', 'P0/P1 tag ensures the test alert escalates to email'],
    ['Sensitive Topic', 'None', 'Optional Sensitive Topic (or None)'],
    ['Platform', 'X', 'Social platform (avoid YouTube when testing standard PA emails)'],
    ['Author', '@test_routing_account', 'Sample handle used on the test card'],
    ['Engagements', '2500', '2,000+ (HIGH) meets the SLRR Social Alert email threshold across P0/P1/P2'],
    ['KOF', 'No', 'Key Opinion Former (Yes / No)'],
    [
      'Summary',
      'Synthetic test alert posted into the test Chat space to verify Chat pickup and per-product Social Alert email routing.',
      'Included in the Chat alert and formulated Social Alert email(s)',
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
 * Resolves a strictly internal Google-only test Chat space where the bot polls incoming alerts (`B9` Mirror, `B10`
 * Auto-correct, `B33` Other alerts, or internal `B3` test Burson feed). Never returns `S-F Burson` (`B25`) or any
 * external space.
 */
function resolveSheetTestSpace_(wanted, sfb) {
  const sfbId = sfb && sfb.space && sfb.space.id ? sfb.space.id : '';
  const candidates = [
    wanted && wanted.mirror,
    wanted && wanted.autocorrect,
    wanted && wanted.otherSpace,
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

/** Records a newly posted test Chat message in `SHEET_TEST_MSGS` so the Chat poller recognizes and picks it up. */
function rememberSheetTestMessage_(msgName, spaceName, products) {
  if (!msgName) return;
  try {
    const props = PropertiesService.getScriptProperties();
    let list = [];
    try { list = JSON.parse(props.getProperty(SHEET_TEST_MSGS_PROP_) || '[]') || []; } catch (e) { list = []; }
    const entry = [hashText_(String(msgName)), SHEET_TEST_INGESTED_, String(spaceName || ''), (products || []).slice()];
    const next = (Array.isArray(list) ? list : []).concat([entry]).slice(-SHEET_TEST_MSGS_MAX_);
    props.setProperty(SHEET_TEST_MSGS_PROP_, JSON.stringify(next));
  } catch (e) {}
}

/** Lookup metadata for a Chat message posted by `postSheetTestAlert_`, or `null` if `m` is not a sheet test alert. */
function sheetTestMeta_(ctx, m) {
  try {
    if (!m || !m.name) return null;
    const copy = !!m.clientId && String(m.clientId).indexOf(MIRROR_CLIENT_ID_PREFIX_) === 0;
    if (!copy && !(ctx && ctx.botUser && m.senderName === ctx.botUser)) return null;
    const raw = PropertiesService.getScriptProperties().getProperty(SHEET_TEST_MSGS_PROP_);
    if (!raw) return null;
    const h = hashText_(String(m.name));
    const hit = (JSON.parse(raw) || []).find(p => Array.isArray(p) && p[0] === h);
    if (!hit) return null;
    return {
      ingested: String(hit[1] || SHEET_TEST_INGESTED_),
      spaceName: String(hit[2] || ''),
      products: Array.isArray(hit[3]) ? hit[3] : [],
    };
  } catch (e) {
    return null;
  }
}

/** Returns `SHEET_TEST_INGESTED_` when Chat message `m` was posted into the test Chat space from the `Test alert` tab. */
function sheetTestSource_(ctx, m) {
  const meta = sheetTestMeta_(ctx, m);
  return meta ? meta.ingested : '';
}

/**
 * Preserves the exact user-selected `[Product]` targets and escalation intent when `handleAlert_` reviews a test alert
 * picked up from the test Chat space (so Gemini never strips out a chosen product because of the synthetic URL/summary).
 */
function applySheetTestReviewOverrides_(parsed, review) {
  if (!parsed || !review || !review.fields) return;
  const pf = parsed.fields || {};
  if (pf.product) review.fields.product = pf.product;
  if (Array.isArray(pf.other_products) && pf.other_products.length) {
    review.fields.other_products = pf.other_products.slice();
  } else {
    delete review.fields.other_products;
  }
  if (Array.isArray(pf.product_targets) && pf.product_targets.length >= 2) {
    review.fields.product_targets = pf.product_targets.slice();
  } else {
    delete review.fields.product_targets;
  }
  if (pf.exposure_tag) review.fields.exposure_tag = pf.exposure_tag;
  if (pf.issue_name) review.fields.issue_name = pf.issue_name;
  if (Number.isInteger(pf.total_engagement)) review.fields.total_engagement = pf.total_engagement;
  review.issues = [];
  review.socialAlert = {
    warranted: true,
    source: 'rule',
    confidence: 1,
    reason: 'Test alert picked up from test Chat space',
  };
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
  const head = `${alertId}${spaceName ? ` · Picked up in ${spaceName}` : ''}`;
  return truncate_(`${head} · ${parts.join(' ; ')}`, 1500);
}

/**
 * Step 1 (Sheet -> Test Chat Space): Ensures `Test alert` exists when `Brand safety groups` is present, and when `B2`
 * is `SEND NOW` (set via `🧪 Test Alert → 🚀 Send Test Alert` or dropdown), posts a formatted `🟧SOCIAL ALERT🟧` message
 * into the internal test Chat space so the bot's Chat poller picks it up from Chat and sends the Social Alert(s).
 */
function postSheetTestAlert_(ss, wanted, sfb) {
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
  sh.getRange(2, 3).setValue('⏳ Posting test alert to Chat space…');

  try {
    // Force-sync Brand safety groups right now so any Column B / Column C email edits made seconds ago apply immediately
    if (typeof syncBrandSafetyGroups_ === 'function') {
      syncBrandSafetyGroups_(ss, { force: true });
    }

    const products = readSheetTestProducts_(vals);
    if (!products.length) {
      sh.getRange(2, 3).setValue('⚠️ Pick at least one product in B5:B9');
      sh.getRange(3, 2).setValue('No alert posted: Product 1–5 (B5:B9) were all blank.');
      return { posted: false, reason: 'no_products' };
    }

    const space = resolveSheetTestSpace_(wanted, sfb);
    if (!space) {
      sh.getRange(2, 3).setValue('⚠️ Configure an internal test space (B9, B10, B33, or test B3) on Control');
      sh.getRange(3, 2).setValue('No alert posted: no Google-only internal Chat space found on the Control tab.');
      return { posted: false, reason: 'no_space' };
    }

    const cellVal = (rowIdx, fallback) => {
      const v = String(((vals[rowIdx] || [])[1]) || '').trim();
      return v || fallback;
    };
    const nowMs = Date.now();
    SHEET_TEST_SEQ_ = (SHEET_TEST_SEQ_ || 0) + 1;
    const seq = SHEET_TEST_SEQ_;
    const issueTitle = cellVal(10, 'Test Multi-Product Social Alert');
    const exposureTag = cellVal(11, 'Product - Scams involving Google products');
    const sensitiveRaw = cellVal(12, 'None');
    const sensitiveTopic = /^none$/i.test(sensitiveRaw) ? 'None' : sensitiveRaw;
    const platform = cellVal(13, 'X');
    const authorRaw = cellVal(14, '@test_routing_account');
    const handleSlug = authorRaw.replace(/[^a-zA-Z0-9_]+/g, '') || 'test_routing_account';
    const engagementsNum = Math.max(0, parseInt(String(cellVal(15, '2500')).replace(/[^0-9]/g, ''), 10) || 2500);
    const engLevel = engagementsNum >= 2000 ? 'HIGH' : 'LOW';
    const isKof = /^yes$|^true$/i.test(cellVal(16, 'No'));
    const summaryText = cellVal(
      17,
      'Synthetic test alert posted into the test Chat space to verify Chat pickup and per-product Social Alert email routing.'
    );
    const postUrl = `https://x.com/${handleSlug}/status/99${nowMs}${seq}`;
    const postedEt = typeof nowLabel_ === 'function' ? nowLabel_() : new Date(nowMs).toISOString();
    const productListStr = products.join(', ');

    const alertText = [
      `🟧SOCIAL ALERT🟧: ${productListStr} | ${issueTitle} | ${platform} | ${engagementsNum} Engagements`,
      `[Name]: ${issueTitle} / New / not previously reported over the past 14 days`,
      `[Engagement]: ${engLevel} (${engagementsNum} engagements)`,
      `[Product]: ${productListStr}`,
      `[Social Network]: ${platform}`,
      `[Exposure Tag]: ${exposureTag}`,
      `[Sensitive Topic]: ${sensitiveTopic}`,
      `[KOF]: ${isKof ? 'Viral KOFs (KOFs)' : 'No'}`,
      '',
      summaryText,
      '',
      `[Link]: ${postUrl}`,
      '',
      `[Time/Date Post Went Live]: ${postedEt}`,
      '',
      `[Code]: ${exposureTag},${engagementsNum},${handleSlug},${sensitiveTopic},${products[0]},New / not previously reported over the past 14 days`,
    ].join('\n');

    const chatMsg = mirrorPostMessage_(space.id, alertText, `sheettest:${nowMs}:${seq}`);
    rememberSheetTestMessage_(chatMsg && chatMsg.name, space.name, products);

    sh.getRange(2, 3).setValue(`📨 Posted to ${space.name} — picking up from Chat…`);
    sh.getRange(3, 2).setValue(`Posted test alert into ${space.name} (${productListStr}) — waiting on Chat pickup to send Social Alert(s)…`);

    return { posted: true, spaceId: space.id, spaceName: space.name, messageName: chatMsg && chatMsg.name, products };
  } catch (err) {
    const msg = truncate_(String((err && err.message) || err), 220);
    try {
      sh.getRange(2, 3).setValue(`⚠️ Failed to post to Chat: ${msg}`);
      sh.getRange(3, 2).setValue(`Error while posting test alert to Chat: ${msg}`);
    } catch (e2) {}
    throw err;
  }
}

/**
 * Step 2 callback (Chat Space -> Social Alert Sent): Called by `Bot.gs` `handleNewAlert_` after the Chat poller picks up
 * the posted test alert from the test Chat space and runs `tryDraft_`. Writes the per-product email delivery summary back
 * onto `Test alert!C2` & `B3` and into the Chat alert's thread. Never throws.
 */
function onSheetTestAlertWorked_(ctx, m, row) {
  try {
    const meta = sheetTestMeta_(ctx, m);
    const ff = (row && row.forwarded_fields) || {};
    const products = (meta && meta.products && meta.products.length)
      ? meta.products
      : (Array.isArray(ff.product_targets) && ff.product_targets.length
        ? ff.product_targets
        : [ff.product].concat(ff.other_products || []).filter(Boolean));
    const spaceName = (meta && meta.spaceName) ||
      (ctx && ctx.spaces && ctx.spaces.analyst && ctx.spaces.analyst.name) || '';
    const summary = summarizeSheetTestResult_(row.alert_id, spaceName, products, row);
    const postedEt = typeof nowLabel_ === 'function' ? nowLabel_() : new Date(ctx.now()).toISOString();
    const st = String((row && row.email_status) || '');
    const badge = st === 'sent'
      ? `✅ Picked up in Chat & Sent at ${postedEt} (${row.alert_id})`
      : st === 'drafted'
        ? `📝 Picked up in Chat & Drafted at ${postedEt} (${row.alert_id})`
        : st === 'skipped_no_test_email'
          ? `⏭️ Picked up in Chat — skipped (no Col C test email, ${row.alert_id})`
          : `⚠️ Picked up in Chat — ${st || 'checked'} (${row.alert_id})`;

    try {
      const targetSpace = (ctx && ctx.spaces && (ctx.sourceReadOnly ? ctx.spaces.analyst.id : ctx.spaces.burson.id)) || '';
      if (targetSpace) {
        postTo_(ctx, targetSpace, `🧪 *Test Alert Delivery (${row.alert_id}):*\n${summary}`,
          (row && row.forward_thread) || (m && m.thread) || null, `sheettestres:${row.alert_id}`);
      }
    } catch (e) {}

    const ss = openStore_(false);
    const sh = ss ? ss.getSheetByName(SHEET_TEST_TAB_) : null;
    if (isTestAlertTab_(sh)) {
      sh.getRange(2, 3).setValue(badge);
      sh.getRange(3, 2).setValue(summary);
    }
  } catch (e) {}
}
