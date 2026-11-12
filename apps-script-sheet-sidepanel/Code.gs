/**
 * @OnlyCurrentDoc
 *
 * Container-bound Google Sheets UI script for the `slrr-agentic-assistant` workbook.
 * Adds the `📊 Bot Analysis` top-bar menu and opens a 3-subtab right-hand Sidepanel (`Overview`, `Controls & Filters`,
 * and `Scorecard`) so the `Analysis` sheet tab itself stays a clean 1-row-header full-screen comparison table.
 *
 * Strictly scoped to `@OnlyCurrentDoc` (`spreadsheets.currentonly` + `script.container.ui`): never touches Chat, Gmail,
 * Drive, or BigQuery, and never interrupts the standalone bot's 1-minute `poll()` trigger.
 */

const SIDEPANEL_ANALYSIS_TAB_ = 'Analysis';
const SIDEPANEL_VERDICT_COL_ = 10;   // Column J: Analyst Verdict
const SIDEPANEL_KEY_COL_ = 12;       // Column L (hidden): row key
const SIDEPANEL_CONTROLS_COL_ = 13;  // Column M (hidden): M2 JSON ({runNow, windowLabel, focus, search})

const SIDEPANEL_WINDOWS_ = ['24 hours', '3 days', '7 days', '14 days'];
const SIDEPANEL_FOCUSES_ = [
  'All items',
  'Disagreements only',
  'With Chat replies / Q&A',
  'Social Alerts only',
  'QA mistakes caught',
  'Thread Q&A only',
];

const SIDEPANEL_TEST_TAB_ = 'Test alert';
const SIDEPANEL_TEST_HEADER_ = 'SLRR Test Alert Sender';
const SIDEPANEL_BSG_TAB_ = 'Brand safety groups';

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📊 Bot Analysis')
    .addItem('Open Sidepanel', 'openAnalysisSidepanel')
    .addSeparator()
    .addItem('Overview', 'openAnalysisOverview')
    .addItem('Controls & Filters', 'openAnalysisControls')
    .addItem('Scorecard', 'openAnalysisScorecard')
    .addToUi();

  ui.createMenu('🧪 Test Alert')
    .addItem('🚀 Send Test Alert', 'sendSheetTestAlert')
    .addItem('📋 Open Test Alert Tab', 'openSheetTestAlertTab')
    .addSeparator()
    .addItem('🧹 Clear Extra Products (Slots 2–5)', 'clearExtraTestProducts')
    .addToUi();
}

function sidepanelTestRouteFormula_(rowNum) {
  const cell = `B${rowNum}`;
  return `=IF(TRIM(${cell})="","",IFERROR(IF(Control!$B$37="ON","Test (Col C): "&IF(INDEX('Brand safety groups'!$C$2:$C$200,MATCH(${cell},'Brand safety groups'!$A$2:$A$200,0))="","(none — will skip)",INDEX('Brand safety groups'!$C$2:$C$200,MATCH(${cell},'Brand safety groups'!$A$2:$A$200,0))),IF(ISNUMBER(SEARCH("LIVE",Control!$C$29)),"Live (Col B): "&INDEX('Brand safety groups'!$B$2:$B$200,MATCH(${cell},'Brand safety groups'!$A$2:$A$200,0)),"Testing B30: "&IF(Control!$B$30="","(B30 blank — waiting)",Control!$B$30))),"(comma list / custom)"))`;
}

function ensureSidepanelTestAlertTab_(ss) {
  const existing = ss.getSheetByName(SIDEPANEL_TEST_TAB_);
  if (existing) {
    const marker = String(existing.getRange(1, 1).getValue() || '').trim();
    if (marker !== SIDEPANEL_TEST_HEADER_) {
      throw new Error('A custom tab named "Test alert" already exists; refusing to overwrite it.');
    }
    try {
      if (String(existing.getRange(16, 2).getValue() || '').trim() === '500' &&
          /100\+ engagements/.test(String(existing.getRange(16, 3).getValue() || ''))) {
        existing.getRange(16, 2, 1, 2).setValues([
          ['2500', '2,000+ (HIGH) meets the SLRR Social Alert email threshold across P0/P1/P2'],
        ]);
      }
    } catch (e) {}
    applySidepanelTestValidations_(ss, existing);
    return { sh: existing, created: false };
  }
  const sheets = ss.getSheets();
  const bsgIdx = sheets.findIndex(s => s.getName() === SIDEPANEL_BSG_TAB_);
  const sh = bsgIdx >= 0 ? ss.insertSheet(SIDEPANEL_TEST_TAB_, bsgIdx + 1) : ss.insertSheet(SIDEPANEL_TEST_TAB_);
  const rows = [
    [
      SIDEPANEL_TEST_HEADER_,
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
      '=IF(Control!$B$37="ON","Mode: Group test emails (Control!B37 ON → Brand safety groups Col C)",IF(ISNUMBER(SEARCH("LIVE",Control!$C$29)),"Mode: LIVE (Brand safety groups Col B)","Mode: Testing sandbox (Control!C29 → Control!B30)"))',
    ],
    ['Product Slot', 'Product / Group (dropdown or comma-separated)', 'Configured Destination'],
    ['Product 1', 'Gemini App', sidepanelTestRouteFormula_(5)],
    ['Product 2 (optional)', '', sidepanelTestRouteFormula_(6)],
    ['Product 3 (optional)', '', sidepanelTestRouteFormula_(7)],
    ['Product 4 (optional)', '', sidepanelTestRouteFormula_(8)],
    ['Product 5 (optional)', '', sidepanelTestRouteFormula_(9)],
    ['Alert Field', 'Value (editable — defaults trigger a Social Alert)', 'Notes'],
    ['Issue Title', 'Test Multi-Product Social Alert', 'Shown in the Social Alert subject line and summary'],
    ['Exposure Tag', 'Product - Scams involving Google products', 'P0/P1 tag ensures the test alert escalates to email'],
    ['Sensitive Topic', 'None', 'Optional Sensitive Topic (or None)'],
    ['Platform', 'X', 'Social platform (avoid YouTube when testing standard PA emails)'],
    ['Author', '@test_routing_account', 'Sample handle used on the test card'],
    ['Engagements', '2500', '2,000+ (HIGH) meets the SLRR Social Alert email threshold across P0/P1/P2'],
    ['KOF', 'No', 'Key Opinion Former (Yes / No)'],
    [
      'Summary',
      'Synthetic test alert triggered from the Test alert tab to verify Chat pickup and Social Alert email routing (single product in To, multi-product all in CC).',
      'Included in the Chat alert and formulated Social Alert email',
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
  applySidepanelTestValidations_(ss, sh);
  return { sh, created: true };
}

function applySidepanelTestValidations_(ss, sh) {
  if (!sh || typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.newDataValidation) return;
  try {
    sh.getRange(2, 2).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['Idle', 'SEND NOW'], true).setAllowInvalid(false).build()
    );
    const bsg = ss.getSheetByName(SIDEPANEL_BSG_TAB_);
    if (bsg) {
      const b = SpreadsheetApp.newDataValidation();
      if (typeof b.requireValueInRange === 'function') {
        const rule = b.requireValueInRange(bsg.getRange('A2:A200'), true).setAllowInvalid(true).build();
        for (let r = 5; r <= 9; r++) sh.getRange(r, 2).setDataValidation(rule);
      }
    }
  } catch (e) {}
}

/** Opens (or creates) the `Test alert` tab and focuses `Product 1` (`B5`). */
function openSheetTestAlertTab(ssOverride) {
  const ss = ssOverride || SpreadsheetApp.getActiveSpreadsheet();
  const { sh, created } = ensureSidepanelTestAlertTab_(ss);
  if (ss.setActiveSheet) ss.setActiveSheet(sh);
  try { sh.getRange(5, 2).activate(); } catch (e) {}
  if (typeof ss.toast === 'function') {
    ss.toast(
      created
        ? 'Created Test alert tab — pick 1–5 products in B5:B9, then click 🧪 Test Alert → 🚀 Send Test Alert.'
        : 'Pick 1–5 products in B5:B9, then click 🧪 Test Alert → 🚀 Send Test Alert.',
      '🧪 Test Alert',
      6
    );
  }
  return { ok: true, created };
}

/** Clears optional product slots `B6:B9` (`Product 2`..`Product 5`) on `Test alert`. */
function clearExtraTestProducts(ssOverride) {
  const ss = ssOverride || SpreadsheetApp.getActiveSpreadsheet();
  const { sh } = ensureSidepanelTestAlertTab_(ss);
  sh.getRange(6, 2, 4, 1).clearContent();
  if (ss.setActiveSheet) ss.setActiveSheet(sh);
  try { sh.getRange(5, 2).activate(); } catch (e) {}
  if (typeof ss.toast === 'function') {
    ss.toast('Cleared Product 2–5 slots (B6:B9).', '🧪 Test Alert', 4);
  }
  return { ok: true };
}

/**
 * Queues the configured test alert on `Test alert` (`B2 = 'SEND NOW'`) so the bot's 1-minute `poll()` posts the Chat
 * alert into the test space, picks it up from Chat, and sends one Social Alert email (single product in To, multi-product all in CC).
 */
function sendSheetTestAlert(ssOverride) {
  const ss = ssOverride || SpreadsheetApp.getActiveSpreadsheet();
  const { sh, created } = ensureSidepanelTestAlertTab_(ss);
  if (ss.setActiveSheet) ss.setActiveSheet(sh);
  if (created) {
    try { sh.getRange(5, 2).activate(); } catch (e) {}
    if (typeof ss.toast === 'function') {
      ss.toast('Test alert tab created! Review your Product(s) in B5:B9 and click 🚀 Send Test Alert again to send.', '🧪 Test Alert', 8);
    }
    return { ok: true, queued: false, created: true };
  }
  const prodVals = sh.getRange(5, 2, 5, 1).getDisplayValues();
  const chosen = [];
  prodVals.forEach(r => {
    String((r && r[0]) || '').split(/[,;\n]+/).forEach(p => {
      const s = p.trim();
      if (s && !chosen.some(x => x.toLowerCase() === s.toLowerCase())) chosen.push(s);
    });
  });
  if (!chosen.length) {
    sh.getRange(2, 3).setValue('⚠️ Pick at least one product in B5:B9 first');
    try { sh.getRange(5, 2).activate(); } catch (e) {}
    if (typeof ss.toast === 'function') {
      ss.toast('Pick at least one product in B5:B9 before sending.', '🧪 Test Alert', 6);
    }
    return { ok: false, queued: false, reason: 'no_products' };
  }
  sh.getRange(2, 2).setValue('SEND NOW');
  sh.getRange(2, 3).setValue(`⏳ Queued (${chosen.join(', ')}) — sending on next 1-minute bot check…`);
  if (typeof ss.toast === 'function') {
    ss.toast(`Queued test alert for: ${chosen.join(', ')} — watch row 2 & 3 (~60s).`, '🧪 Test Alert', 8);
  }
  return { ok: true, queued: true, products: chosen };
}

function openAnalysisSidepanel() {
  showAnalysisSidebar_('overview');
}

function openAnalysisOverview() {
  showAnalysisSidebar_('overview');
}

function openAnalysisControls() {
  showAnalysisSidebar_('controls');
}

function openAnalysisScorecard() {
  showAnalysisSidebar_('scorecard');
}

function showAnalysisSidebar_(initialTab) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss ? ss.getSheetByName(SIDEPANEL_ANALYSIS_TAB_) : null;
  if (sh && ss.getActiveSheet().getName() !== SIDEPANEL_ANALYSIS_TAB_) {
    ss.setActiveSheet(sh);
  }
  const tpl = HtmlService.createTemplateFromFile('Sidebar');
  tpl.initialTab = String(initialTab || 'overview');
  const html = tpl.evaluate().setTitle('Bot Analysis');
  SpreadsheetApp.getUi().showSidebar(html);
}

/** Switches the active Google Sheet tab to `Analysis` and focuses the first comparison row (`A2`). */
function jumpToAnalysisTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss ? ss.getSheetByName(SIDEPANEL_ANALYSIS_TAB_) : null;
  if (!sh) return { ok: false, message: 'The Analysis tab has not been created yet.' };
  ss.setActiveSheet(sh);
  try { sh.getRange(2, 1).activate(); } catch (e) {}
  return { ok: true };
}

function normalizeSidepanelControls_(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const runNow = src.runNow === true || /^run now$|^true$|^1$/i.test(String(src.runNow || '').trim());
  const winStr = String(src.windowLabel || '').trim();
  const windowLabel = SIDEPANEL_WINDOWS_.find(w => w.toLowerCase() === winStr.toLowerCase()) || '7 days';
  const focusStr = String(src.focus || '').trim();
  const focus = SIDEPANEL_FOCUSES_.find(f => f.toLowerCase() === focusStr.toLowerCase()) || 'All items';
  const search = String(src.search || '').trim().slice(0, 200);
  return { runNow, windowLabel, focus, search };
}

/**
 * Reads the current `Analysis` tab state (`M2` controls + `N2` summary) and overlays live verdict counts from Column J
 * so newly entered verdicts appear immediately in the `Scorecard` subtab without waiting for the next 1-minute poll.
 */
function getAnalysisSidepanelState(ssOverride) {
  const ss = ssOverride || SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss ? ss.getSheetByName(SIDEPANEL_ANALYSIS_TAB_) : null;
  if (!sh || sh.getLastRow() < 1) {
    return {
      exists: false,
      controls: normalizeSidepanelControls_({}),
      overview: {
        title: 'Bot vs. Google Analysts',
        updatedAt: 0,
        updatedEt: 'Waiting for first bot refresh',
        staleEt: '',
        description: 'Open the Analysis tab once the bot completes its next 1-minute run.',
        kbDocs: 0,
        guidanceCount: 0,
        learnedCount: 0,
      },
      scorecard: {
        windowLabel: '7 days',
        alerts: 0,
        decided: 0,
        aligned: 0,
        parityPct: '—',
        disagreements: 0,
        imOnly: 0,
        botOnly: 0,
        mistakes: 0,
        withChat: 0,
        qaCount: 0,
        chatAndQa: 0,
        graded: 0,
        botRight: 0,
        analystRight: 0,
      },
    };
  }

  let controls = normalizeSidepanelControls_({});
  let summary = null;
  if (sh.getLastRow() >= 2 && sh.getLastColumn() >= SIDEPANEL_CONTROLS_COL_) {
    const metaVals = sh.getRange(2, SIDEPANEL_CONTROLS_COL_, 1, 2).getDisplayValues()[0];
    try {
      if (metaVals[0]) controls = normalizeSidepanelControls_(JSON.parse(metaVals[0]));
    } catch (e) {}
    try {
      if (metaVals[1]) summary = JSON.parse(metaVals[1]);
    } catch (e) {}
  }

  // Live-count visible Analyst Verdicts on the sheet so grading updates Scorecard immediately
  const liveVerdicts = countSheetVerdictsLive_(sh);
  const ov = (summary && summary.overview) || {};
  const ct = (summary && summary.controls) || {};
  const sc = (summary && summary.scorecard) || {};

  // Use whichever verdict count reflects the latest visible edits (if visible rows have more/newer edits, reflect immediately)
  const graded = Math.max(Number(sc.graded) || 0, liveVerdicts.graded);
  const botRight = liveVerdicts.visibleRows > 0 && ct.focus === 'All items' && !ct.search
    ? liveVerdicts.botRight
    : Math.max(Number(sc.botRight) || 0, liveVerdicts.botRight);
  const analystRight = liveVerdicts.visibleRows > 0 && ct.focus === 'All items' && !ct.search
    ? liveVerdicts.analystRight
    : Math.max(Number(sc.analystRight) || 0, liveVerdicts.analystRight);

  return {
    exists: true,
    activeSheet: ss.getActiveSheet ? ss.getActiveSheet().getName() : SIDEPANEL_ANALYSIS_TAB_,
    controls: {
      runNow: controls.runNow,
      windowLabel: controls.windowLabel,
      focus: controls.focus,
      search: controls.search,
      shown: Number(ct.shown || liveVerdicts.visibleRows || 0),
      totalMatching: Number(ct.totalMatching || liveVerdicts.visibleRows || 0),
      totalInWindow: Number(ct.totalInWindow || liveVerdicts.visibleRows || 0),
      statusText: ct.statusText || `Showing ${liveVerdicts.visibleRows} item(s)`,
    },
    overview: {
      title: ov.title || 'Analysis: Bot vs. Google Analysts',
      updatedAt: Number(ov.updatedAt) || 0,
      updatedEt: ov.updatedEt || 'Pending refresh',
      staleEt: ov.staleEt || '',
      description: ov.description || 'Side-by-side comparison of chatbot responses vs. Google analyst responses, bot logic, and Knowledge Base snippets.',
      kbDocs: Number(ov.kbDocs) || 0,
      guidanceCount: Number(ov.guidanceCount) || 0,
      learnedCount: Number(ov.learnedCount) || 0,
    },
    scorecard: {
      windowLabel: sc.windowLabel || controls.windowLabel,
      alerts: Number(sc.alerts) || 0,
      decided: Number(sc.decided) || 0,
      aligned: Number(sc.aligned) || 0,
      parityPct: sc.parityPct || '—',
      disagreements: Number(sc.disagreements) || 0,
      imOnly: Number(sc.imOnly) || 0,
      botOnly: Number(sc.botOnly) || 0,
      mistakes: Number(sc.mistakes) || 0,
      withChat: Number(sc.withChat) || 0,
      qaCount: Number(sc.qaCount) || 0,
      chatAndQa: Number(sc.chatAndQa) || 0,
      graded: liveVerdicts.visibleRows > 0 && ct.focus === 'All items' && !ct.search ? liveVerdicts.graded : graded,
      botRight,
      analystRight,
    },
  };
}

function countSheetVerdictsLive_(sh) {
  const last = sh.getLastRow();
  if (last < 2 || sh.getLastColumn() < SIDEPANEL_KEY_COL_) {
    return { visibleRows: 0, graded: 0, botRight: 0, analystRight: 0 };
  }
  const rows = sh.getRange(2, SIDEPANEL_VERDICT_COL_, last - 1, 3).getDisplayValues();
  let visibleRows = 0;
  let graded = 0;
  let botRight = 0;
  let analystRight = 0;
  rows.forEach(r => {
    const verdict = String(r[0] || '').trim();
    const key = String(r[2] || '').trim();
    if (!key) return;
    visibleRows++;
    if (verdict) graded++;
    if (verdict === 'Bot right' || verdict === 'Both acceptable') botRight++;
    if (verdict === 'Analyst right') analystRight++;
  });
  return { visibleRows, graded, botRight, analystRight };
}

/**
 * Saves updated filter controls into hidden cell `M2` on the `Analysis` tab (with `runNow: true` when requested or when
 * filters changed) so the bot's 1-minute `poll()` rebuilds the `Analysis` tab immediately (`wait = 0`).
 */
function saveAnalysisControls(patch, ssOverride) {
  const ss = ssOverride || SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss ? ss.getSheetByName(SIDEPANEL_ANALYSIS_TAB_) : null;
  if (!sh) {
    throw new Error('The Analysis tab does not exist yet on this spreadsheet.');
  }
  const current = getAnalysisSidepanelState(ss);
  const next = normalizeSidepanelControls_(Object.assign({}, current.controls, patch || {}, {
    runNow: patch && patch.runNow !== undefined ? patch.runNow : true,
  }));
  sh.getRange(2, SIDEPANEL_CONTROLS_COL_).setValue(JSON.stringify(next));
  if (ss.getActiveSheet && ss.getActiveSheet().getName() !== SIDEPANEL_ANALYSIS_TAB_) {
    ss.setActiveSheet(sh);
  }
  return {
    saved: next,
    previousUpdatedAt: current.overview.updatedAt || 0,
    state: getAnalysisSidepanelState(ss),
  };
}
