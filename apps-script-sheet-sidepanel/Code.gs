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
const SIDEPANEL_NOTES_COL_ = 11;     // Column K: Analyst Notes
const SIDEPANEL_KEY_COL_ = 12;       // Column L (hidden): row key
const SIDEPANEL_CONTROLS_COL_ = 13;  // Column M (hidden): M2 JSON ({runNow, windowLabel, focus, search})
const SIDEPANEL_SUMMARY_COL_ = 14;   // Column N (hidden): N2 JSON ({overview, controls, scorecard})

const SIDEPANEL_WINDOWS_ = ['24 hours', '3 days', '7 days', '14 days'];
const SIDEPANEL_FOCUSES_ = [
  'All items',
  'Disagreements only',
  'With Chat replies / Q&A',
  'Social Alerts only',
  'QA mistakes caught',
  'Thread Q&A only',
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📊 Bot Analysis')
    .addItem('Open Sidepanel', 'openAnalysisSidepanel')
    .addSeparator()
    .addItem('Overview', 'openAnalysisOverview')
    .addItem('Controls & Filters', 'openAnalysisControls')
    .addItem('Scorecard', 'openAnalysisScorecard')
    .addToUi();
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
