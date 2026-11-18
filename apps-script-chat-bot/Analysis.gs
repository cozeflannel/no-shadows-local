/**
 * Analysis.gs — the Analysis tab of the bot's sheet: a full-screen side-by-side comparison table (1-row frozen header)
 * paired with a Google Sheets right-hand Sidepanel ("📊 Bot Analysis → Open Sidepanel") organized into 3 subtabs:
 *   1) Overview            Title, last-updated timestamp, plain-English summary, and Resources / Guidance / Precedents counts
 *   2) Controls & Filters  Run/Refresh trigger, Lookback window (24h / 3d / 7d / 14d), Focus filter, and Search keyword filter
 *   3) Scorecard           Social Alert alignment %, IM-only vs Bot-only disagreements, QA mistakes caught, Chat Q&A, Verdicts
 *
 * Row 1 on the Analysis tab is immediately the frozen column header (Columns A–K visible), giving analysts the full vertical
 * screen to read comparisons side-by-side. Hidden state columns L–N hold:
 *   Col L (row key)        Stable per-item key so Analyst Verdict (Col J) and Analyst Notes (Col K) stay attached across filters
 *   Col M (panel controls) Cell M2 JSON ({runNow, windowLabel, focus, search}) shared with the right-hand Sidepanel
 *   Col N (panel summary)  Cell N2 JSON payload powering the Sidepanel's Overview, Controls & Filters, and Scorecard subtabs
 *
 * Safety & stealth invariants:
 *   - Read-only reporting tab: never sends Chat messages, Gmail drafts/emails, or BigQuery write-backs.
 *   - Tab ownership check (isAnalysisTab_): never reads, clears, or overwrites a tab the bot didn't create.
 *   - Cell size cap: every cell stays well under Google Sheets' 50,000-character limit (speedText_ / capCell_ / capJson_).
 *   - Zero extra network calls during poll(): reuses Results' cached BigQuery/Gmail state unless "Run now" or
 *     refreshAnalysis() explicitly asks for a fresh read.
 */

const ANALYSIS_TAB_ = 'Analysis';
const ANALYSIS_TITLE_ = 'Analysis: Bot vs. Google Analysts — responses, logic & Knowledge Base snippets';
const ANALYSIS_LAYOUT_ = '2';
const ANALYSIS_LEGACY_CONTROL_ROW_ = 4;  // Layout 1 B4:B7 controls (migrated automatically on upgrade)

const ANALYSIS_RUN_OPTIONS_ = ['Ready', 'Run now'];
const ANALYSIS_WINDOWS_ = ['24 hours', '3 days', '7 days', '14 days'];
const ANALYSIS_WINDOW_DAYS_ = { '24 hours': 1, '3 days': 3, '7 days': 7, '14 days': 14 };
const ANALYSIS_FOCUSES_ = [
  'All items',
  'Disagreements only',
  'With Chat replies / Q&A',
  'Social Alerts only',
  'QA mistakes caught',
  'Thread Q&A only',
];
const ANALYSIS_VERDICTS_ = [
  'Bot right',
  'Analyst right',
  'Both acceptable',
  'Update Guidance',
  'Update Resources',
  'Needs bug fix',
];

const ANALYSIS_HEADER_ = [
  'Posted / Asked (ET)',
  'Type',
  'Post / Thread',
  'Product · Tag · Issue',
  'Chatbot\'s Response (Chat & Social Alert)',
  'Google Analyst\'s Response (Chat & IM Call)',
  'Alignment',
  'Bot\'s Logic (Rules, AI Review & Guidance)',
  'Knowledge Base Snippet (Resources)',
  'Analyst Verdict',
  'Analyst Notes',
  'row key',
  'panel controls',
  'panel summary',
];
const ANALYSIS_VISIBLE_COLS_ = 11;
const ANALYSIS_VERDICT_COL_ = 10;
const ANALYSIS_NOTES_COL_ = 11;
const ANALYSIS_KEY_COL_ = 12;       // hidden per-row key column
const ANALYSIS_CONTROLS_COL_ = 13;  // hidden M2 JSON controls ({runNow, windowLabel, focus, search})
const ANALYSIS_SUMMARY_COL_ = 14;   // hidden N2 JSON payload for Sidepanel subtabs (Overview, Controls, Scorecard)
const ANALYSIS_HIDDEN_COLS_ = 3;

const ANALYSIS_WIDTHS_ = [
  [1, 145], [2, 105], [3, 165], [4, 230], [5, 340], [6, 340],
  [7, 175], [8, 360], [9, 390], [10, 150], [11, 260],
];

const ANALYSIS_AT_PROP_ = 'ANALYSIS_AT';
const ANALYSIS_DIRTY_PROP_ = 'ANALYSIS_DIRTY';
const ANALYSIS_SIG_PROP_ = 'ANALYSIS_FILTER_SIG';
const ANALYSIS_LAYOUT_PROP_ = 'ANALYSIS_LAYOUT';
const ANALYSIS_REVIEWS_PROP_ = 'ANALYSIS_REVIEWS';
const ANALYSIS_QA_PROP_ = 'ANALYSIS_QA';
const ANALYSIS_QA_CACHE_ = 'analysis_qa_buf';

const ANALYSIS_ACTIVE_MS_ = 60 * 1000;
const ANALYSIS_QUIET_MS_ = 10 * 60 * 1000;
const ANALYSIS_MIN_LEFT_MS_ = 30 * 1000;
const ANALYSIS_FRESH_LEFT_MS_ = 65 * 1000;
const ANALYSIS_MAX_ROWS_ = 250;
const ANALYSIS_SNIPPET_CHARS_ = 380;
const ANALYSIS_PROP_MAX_CHARS_ = 7500;  // safely under Apps Script's 9 KB per-property limit

// ---------------------------------------------------------------------------------------------------------------
// Public entry points & poll() hook
// ---------------------------------------------------------------------------------------------------------------

/**
 * Run this from the Apps Script editor (or flip B4 on the Analysis tab to "Run now") to rebuild the Analysis tab
 * immediately with fresh BigQuery IM comparisons and current Knowledge Base snippets.
 */
function refreshAnalysis() {
  if (webViewerCall_()) throw new Error('Not available from the dashboard');
  const ss = openStore_(false);
  const wanted = readControl_(controlTab_(ss));
  const sfb = sfBursonFor_(null, wanted);
  const cfg = speedCfg_(wanted, sfb.space);
  const ctx = buildCtx_(cfg, ss, wanted.switches);
  let ac = null;
  if (wanted.autocorrect && sfb.space) {
    try {
      ac = buildCtx_(autoCorrectCfg_(resolveAutoCorrectSpace_(wanted.autocorrect), sfb.space), ss, wanted.switches);
    } catch (e) {
      console.warn('Analysis tab: couldn\'t open the auto-correct space (its alerts still count): ' + ((e && e.message) || e));
    }
  }
  const out = refreshAnalysis_(ss, ctx, { flows: resultsFlows_(ctx, ac, cfg), fresh: true, manual: true });
  console.log(`Analysis tab updated: ${out.shown} shown of ${out.total} item(s) in window (${out.windowLabel}, ${out.focus}).`);
  return out;
}

/** Alias for analysts running from the Apps Script function dropdown. */
function runBotAnalysis() {
  if (webViewerCall_()) throw new Error('Not available from the dashboard');
  return refreshAnalysis();
}

/**
 * Called at the end of poll() (after maybeRefreshSpeed_ and maybeRefreshFollowUp_): updates the Analysis tab when an
 * analyst flipped B4 to "Run now", changed any filter in B5:B7, after run activity, or every 10 minutes. Never throws.
 */
function maybeRefreshAnalysis_(ss, ctx, opts) {
  try {
    const o = opts || {};
    if (!ss || !ctx || (ctx.settings || {}).analysis_tab === false) return false;
    // During automated poll(), wait until Results or Analysis exists so brand-new test sheets without Results stay untouched
    const existing = ss.getSheetByName(ANALYSIS_TAB_);
    if (!existing && !ss.getSheetByName(RESULTS_TAB_)) return false;
    if (existing && !isAnalysisTab_(existing)) return false;

    const props = PropertiesService.getScriptProperties();
    const now = ctx.now();
    const controls = existing ? readAnalysisControls_(existing) : analysisDefaultControls_();
    const sig = JSON.stringify([controls.windowLabel, controls.focus, controls.search]);
    const prevSig = props.getProperty(ANALYSIS_SIG_PROP_) || '';
    const filterChanged = Boolean(existing && sig !== prevSig);
    const runNow = controls.runNow;
    const dirty = props.getProperty(ANALYSIS_DIRTY_PROP_) === 'true' || Boolean(CacheService.getScriptCache().get(ANALYSIS_QA_CACHE_));
    const later = () => {
      if (o.activity && !dirty) props.setProperty(ANALYSIS_DIRTY_PROP_, 'true');
      return false;
    };

    const deadline = Number(o.deadline) || Number(ctx.deadline) || 0;
    if (deadline && deadline - now < ANALYSIS_MIN_LEFT_MS_) return later();

    const lastAt = Number(props.getProperty(ANALYSIS_AT_PROP_)) || 0;
    const newLayout = !existing || props.getProperty(ANALYSIS_LAYOUT_PROP_) !== ANALYSIS_LAYOUT_;
    const busy = !!o.activity || dirty;
    const wait = (runNow || filterChanged || newLayout) ? 0 : (busy ? ANALYSIS_ACTIVE_MS_ : ANALYSIS_QUIET_MS_);
    if (!runNow && !filterChanged && !newLayout && now - lastAt < wait) return later();

    const canFresh = runNow && (!deadline || deadline - now >= ANALYSIS_FRESH_LEFT_MS_);
    props.setProperty(ANALYSIS_AT_PROP_, String(now));
    if (dirty) props.deleteProperty(ANALYSIS_DIRTY_PROP_);
    refreshAnalysis_(ss, ctx, Object.assign({}, o, { deadline, fresh: canFresh, runNow }));
    return true;
  } catch (e) {
    console.error('Analysis tab not refreshed: ' + ((e && e.message) || e));
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Recording live Chat Q&A exchanges from Bot.gs (buffered in CacheService, persisted in bounded property)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Records a question-and-answer exchange from handleHuman_ (Burson/Mirror space) or pollAnalystMessages_ (Analyst space)
 * so the Analysis tab can display the exact question, the bot's reply, and the KB docs Gemini used. Never throws.
 */
function recordAnalysisQa_(ctx, entry) {
  try {
    if (!entry || (!entry.question && !entry.bot_answer)) return;
    const cache = CacheService.getScriptCache();
    let list = [];
    try { list = JSON.parse(cache.get(ANALYSIS_QA_CACHE_) || '[]') || []; } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    const at = Number(entry.at) || (ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now());
    const docs = Array.isArray(entry.docs_used) ? entry.docs_used.slice(0, 6).map(d => ({
      name: truncate_(String((d && d.name) || d || ''), 100),
      whole: !!(d && d.whole),
      chars: Number((d && d.chars) || 0),
    })).filter(d => d.name && (!d.chars || d.chars > 0 || d.whole)) : [];
    list.push({
      key: 'qa:' + String(entry.message || at),
      message: String(entry.message || ''),
      thread: String(entry.thread || ''),
      at,
      space: String(entry.space || ''),
      who: truncate_(String(entry.who || ''), 80),
      question: truncate_(String(entry.question || '').trim(), 700),
      bot_answer: truncate_(String(entry.bot_answer || '').trim(), 1200),
      alert_id: String(entry.alert_id || ''),
      blocked: Array.isArray(entry.blocked) && entry.blocked.length ? entry.blocked.slice(0, 5) : [],
      docs_used: docs,
    });
    const trimmed = list.slice(-30);
    const raw = capJson_(trimmed, ANALYSIS_PROP_MAX_CHARS_);
    cache.put(ANALYSIS_QA_CACHE_, raw, 21600);
  } catch (e) { /* never interrupt a Chat answer */ }
}

/** Flushes buffered Q&A exchanges from CacheService into the bounded ANALYSIS_QA script property and returns all kept items. */
function flushAnalysisQa_(props) {
  let saved = [];
  try { saved = JSON.parse(props.getProperty(ANALYSIS_QA_PROP_) || '[]') || []; } catch (e) { saved = []; }
  if (!Array.isArray(saved)) saved = [];
  const cache = CacheService.getScriptCache();
  let buf = [];
  try { buf = JSON.parse(cache.get(ANALYSIS_QA_CACHE_) || '[]') || []; } catch (e) { buf = []; }
  if (Array.isArray(buf) && buf.length) {
    const byKey = new Map();
    saved.concat(buf).forEach(x => {
      if (x && x.key) byKey.set(String(x.key), x);
    });
    saved = Array.from(byKey.values()).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, 45);
    props.setProperty(ANALYSIS_QA_PROP_, capJson_(saved, ANALYSIS_PROP_MAX_CHARS_));
    try { cache.remove(ANALYSIS_QA_CACHE_); } catch (e) {}
  }
  return saved;
}

// ---------------------------------------------------------------------------------------------------------------
// Core rebuild pipeline
// ---------------------------------------------------------------------------------------------------------------

/**
 * Rebuilds the Analysis tab and returns summary counts. Respects tab ownership (never touches a user-made "Analysis" tab
 * or a sheet where someone added extra columns to the right of column N).
 */
function refreshAnalysis_(ss, ctx, opts) {
  const o = opts || {};
  const now = ctx.now();
  const props = PropertiesService.getScriptProperties();
  const sh = ensureAnalysisTab_(ss);
  if (!sh) {
    console.warn(`Analysis tab not updated: a "${ANALYSIS_TAB_}" tab the bot didn't make is in the way (left as it is)`);
    return { blocked: true, shown: 0, total: 0, windowLabel: '7 days', focus: 'All items' };
  }
  if (sh.getLastColumn() > ANALYSIS_HEADER_.length) {
    console.warn('Analysis tab not updated: the tab has custom columns after column N');
    return { blocked: true, shown: 0, total: 0, windowLabel: '7 days', focus: 'All items' };
  }

  const controls = readAnalysisControls_(sh);
  const days = ANALYSIS_WINDOW_DAYS_[controls.windowLabel] || 7;
  const since = now - days * SPEED_DAY_;
  const flows = resultsFlowsResolved_(ctx, o);
  const noWait = switchOn_(ctx, 'noWait');
  const mainLabel = (flows.main && flows.main.label) || 'Mirror space';

  // Preserve any Analyst Verdict / Analyst Notes written on the sheet + previously saved notes across filter changes
  const reviews = mergeAnalysisReviews_(props, readAnalysisReviews_(sh));

  // Load Knowledge Base documents, active Guidance rules, Learned precedents, and Relay Chat activity once
  const kb = loadKnowledge_(ss);
  const guidance = readGuidanceRows_(ss, now);
  const learned = readLearnedPrecedents_(ss).filter(r => !/^(?:no|n|false)$/i.test(String(r.active || '').trim()));
  const chatIndex = buildAnalysisChatIndex_(ss);
  const qaSaved = flushAnalysisQa_(props);

  // Load Alert log rows covering the lookback window (+ 2 days for resend roots)
  const allAlerts = o.alerts || resultsAlertRows_(ss, since - 2 * SPEED_DAY_);
  const recentAlerts = allAlerts.filter(a => (Number(a.source_at) || Number(a.created_at) || 0) >= since - 2 * SPEED_DAY_);
  const bursonRows = resultsBursonRows_(recentAlerts);
  const bursonSet = new Set(bursonRows);
  const takenRows = recentAlerts.filter(a => !bursonSet.has(a));

  const im = analysisImSide_(ss, ctx.settings || {}, since, now, o, bursonRows);
  const posts = speedPosts_(bursonRows, im.drafts, im.logged, flows, takenRows).filter(p => p.burson_at >= since);
  const resultsSh = ss.getSheetByName(RESULTS_TAB_);
  const speedState = resultsSh ? readSpeedState_(resultsSh) : new Map();
  posts.forEach(p => {
    const prev = (p.key && speedState.get(p.key)) || {};
    if (Number(prev.sent)) p.im_email_at = Number(prev.sent);
    p.im_call = p.key ? speedImCall_(p, now) : RESULTS_NO_LINK_;
  });

  // Index raw Alert log rows by alert_id and thread so we can pull full requested reasons, email_input, feedback & Q&A
  const alertsById = new Map();
  const alertByThread = new Map();
  allAlerts.forEach(a => {
    if (!a) return;
    if (a.alert_id) alertsById.set(String(a.alert_id), a);
    [a.source_thread, a.forward_thread, a.live_thread].filter(Boolean).forEach(t => {
      if (!alertByThread.has(String(t))) alertByThread.set(String(t), a);
    });
  });

  // Reconstruct historical + buffered Q&A items within `since`, and index Q&A by alert_id / thread for alert rows too
  const qaItems = buildAnalysisQaItems_(ss, qaSaved, chatIndex, alertsById, alertByThread, kb, guidance, since);
  const qaByAlert = new Map();
  qaItems.forEach(q => {
    if (!q.alertId) return;
    if (!qaByAlert.has(q.alertId)) qaByAlert.set(q.alertId, []);
    qaByAlert.get(q.alertId).push(q);
  });

  // Build unified comparison items: Alert items + Thread Q&A items
  const alertItems = posts.map(p => buildAnalysisAlertItem_(p, {
    alertsById, chatIndex, qaByAlert, kb, guidance, learned, noWait, mainLabel, now,
  }));
  const allItems = alertItems.concat(qaItems).sort((a, b) => b.at - a.at);

  // Compute scorecard across the full window (before Focus / Search filters), then apply Focus + Search filters
  const scorecard = analysisScorecard_(alertItems, qaItems, reviews);
  const filtered = allItems.filter(item => analysisMatchesFilter_(item, controls)).slice(0, ANALYSIS_MAX_ROWS_);

  writeAnalysisTab_(sh, {
    items: filtered,
    totalInWindow: allItems.length,
    totalMatching: allItems.filter(item => analysisMatchesFilter_(item, controls)).length,
    controls,
    scorecard,
    reviews,
    now,
    stale: im.stale,
    kbDocs: (kb.docs || []).length,
    guidanceCount: guidance.length,
    learnedCount: learned.length,
  });

  const sig = JSON.stringify([controls.windowLabel, controls.focus, controls.search]);
  if (props.getProperty(ANALYSIS_SIG_PROP_) !== sig) props.setProperty(ANALYSIS_SIG_PROP_, sig);
  if (props.getProperty(ANALYSIS_LAYOUT_PROP_) !== ANALYSIS_LAYOUT_) props.setProperty(ANALYSIS_LAYOUT_PROP_, ANALYSIS_LAYOUT_);

  return {
    shown: filtered.length,
    total: allItems.length,
    alerts: alertItems.length,
    qa: qaItems.length,
    windowLabel: controls.windowLabel,
    focus: controls.focus,
    scorecard,
  };
}

/**
 * Reads IM drafts & SLRR log rows without issuing new network calls during routine poll() runs (reusing RESULTS_BQ_CACHE_),
 * or runs a live BigQuery read when `o.fresh` is true (manual refreshAnalysis() or "Run now"). Never throws.
 */
function analysisImSide_(ss, S, since, now, o, rows) {
  if (o.drafts || o.logged) return resultsImSide_(S, since, now, o, rows);
  if (o.fresh) {
    try {
      return resultsImSide_(S, since, now, { fresh: true }, rows);
    } catch (e) {
      console.warn('Analysis tab: live BigQuery IM lookup unavailable, using cached state if present: ' + ((e && e.message) || e));
    }
  }
  const cache = CacheService.getScriptCache();
  let hit = null;
  try { hit = JSON.parse(cache.get(RESULTS_BQ_CACHE_) || 'null'); } catch (e) { hit = null; }
  if (hit && typeof hit === 'object') {
    const age = now - Number(hit.at || 0);
    return {
      drafts: (hit.d || []).map(x => ({ post_url: x[0], at: Number(x[1]) || 0, subject: x[2] || '', drafted_by: x[3] || '' })),
      logged: (hit.l || []).map(x => ({ url: x[0], day: x[1] || '' })),
      stale: age > 2 * SPEED_HOUR_ ? Number(hit.at || 0) : 0,
    };
  }
  return { drafts: [], logged: [], stale: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Pairing Google Analysts' & Burson's Chat messages + emojis from Relay & Relay names
// ---------------------------------------------------------------------------------------------------------------

/**
 * Indexes Relay + Relay names so any alert or thread can look up Google analysts' Chat replies & emoji reactions and
 * Burson's Chat replies/questions in O(1). Never modifies any tab.
 */
function buildAnalysisChatIndex_(ss) {
  const names = new Map();
  if (ss.getSheetByName(RELAY_NAMES_TAB_)) {
    try {
      sheetTable_(ss, RELAY_NAMES_TAB_, RELAY_NAMES_COLUMNS_, 'user', 2000).load().forEach(r => {
        const u = String(r.user || '').trim();
        if (u) names.set(u, { name: String(r.name || '').trim(), org: String(r.org || '').trim(), mark: relayMark_(r.org) });
      });
    } catch (e) {}
  }

  const byMsg = new Map();
  const byThread = new Map();
  const addMap = (map, k, item) => {
    const key = String(k || '').trim();
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  };

  if (ss.getSheetByName(RELAY_TAB_)) {
    try {
      const rows = sheetTable_(ss, RELAY_TAB_, RELAY_COLUMNS_, 'key', RELAY_READ_ROWS_).load();
      rows.forEach(r => {
        const what = String(r.what || '').trim();
        if (!what) return;
        const user = String(r.user || '').trim();
        const person = user ? names.get(user) : null;
        const rawWho = String(r.who || '').trim();
        const dir = String(r.direction || '').trim();
        const status = String(r.status || '').trim();
        const isGoogle = dir === RELAY_TO_ || dir === RELAY_TO_COPY_ ||
          (person && person.mark === 'google') ||
          /\(Google\)|\(xWF\)/i.test(rawWho) ||
          /marked Google on the Relay names tab/i.test(status);
        const isBurson = !isGoogle && ((person && person.mark === 'burson') || /\(Burson\)/i.test(rawWho));
        const displayWho = (person && person.name) || rawWho.replace(/\s*\((?:Google|Burson)\)\s*$/i, '').trim() ||
          (isGoogle ? 'Google analyst' : isBurson ? 'Burson' : 'Participant');
        const at = Date.parse(String(r.when || '')) || 0;
        const entry = {
          at,
          dir,
          what,
          who: displayWho,
          isGoogle,
          isBurson,
          text: String(r.text || '').trim(),
          status,
          burson_message: String(r.burson_message || '').trim(),
          burson_thread: String(r.burson_thread || '').trim(),
          test_message: String(r.test_message || '').trim(),
          test_thread: String(r.test_thread || '').trim(),
          copy_message: String(r.copy_message || '').trim(),
          copy_thread: String(r.copy_thread || '').trim(),
          key: String(r.key || '').trim(),
        };
        [entry.burson_message, entry.test_message, entry.copy_message].forEach(m => addMap(byMsg, m, entry));
        [entry.burson_thread, entry.test_thread, entry.copy_thread].forEach(t => addMap(byThread, t, entry));
      });
    } catch (e) {}
  }
  return { names, byMsg, byThread };
}

/** Collects deduplicated Relay activity (Google analyst emojis, Google analyst replies, Burson replies) for an alert's rows. */
function analysisAlertChatActivity_(alertRows, chatIndex) {
  const msgIds = new Set();
  const threadIds = new Set();
  const mirroredEmojis = new Set();
  const feedbackEmojis = new Set();

  (alertRows || []).forEach(a => {
    if (!a) return;
    [a.source_message, a.forward_message, a.live_message].filter(Boolean).forEach(m => msgIds.add(String(m)));
    [a.source_thread, a.forward_thread, a.live_thread].filter(Boolean).forEach(t => threadIds.add(String(t)));
    // Look up paired messages/threads via Relay alert rows if needed
    [a.source_message, a.forward_message, a.live_message].filter(Boolean).forEach(m => {
      ((chatIndex.byMsg.get(String(m))) || []).forEach(r => {
        if (r.what === 'alert') {
          [r.burson_message, r.test_message, r.copy_message].filter(Boolean).forEach(x => msgIds.add(x));
          [r.burson_thread, r.test_thread, r.copy_thread].filter(Boolean).forEach(x => threadIds.add(x));
        }
      });
    });
    // The row's `mirrored` marks count as the analyst space's emojis, but for a row of the Auto-correct flow: there
    // they are only the bot's own, put on its corrected alert (Drafts.gs markEmojis_; that flow copies no analyst's
    // reaction, Bot.gs analystReactions_), never an analyst's
    const ownMarks = typeof AC_PARTITION_SUFFIX_ === 'string' && String(a.space || '').endsWith(AC_PARTITION_SUFFIX_);
    if (!ownMarks) String(a.mirrored || '').split(/\s+/).filter(Boolean).forEach(e => mirroredEmojis.add(e));
    String(a.feedback || '').split(/\s+/).filter(Boolean).forEach(e => feedbackEmojis.add(e));
  });

  const seen = new Set();
  const events = [];
  const collect = list => (list || []).forEach(e => {
    const id = e.key || `${e.what}|${e.who}|${e.text}|${e.burson_message}|${e.test_message}`;
    if (seen.has(id)) return;
    seen.add(id);
    events.push(e);
  });
  msgIds.forEach(m => collect(chatIndex.byMsg.get(m)));
  threadIds.forEach(t => collect(chatIndex.byThread.get(t)));
  events.sort((a, b) => (a.at || 0) - (b.at || 0));

  const googleEmojis = [];
  const seenEmoji = new Set();
  events.filter(e => e.what === 'emoji' && e.isGoogle && e.text).forEach(e => {
    const k = `${bareEmoji_(e.text)}|${e.who}`;
    if (seenEmoji.has(k)) return;
    seenEmoji.add(k);
    googleEmojis.push({ emoji: e.text, who: e.who });
  });
  mirroredEmojis.forEach(emoji => {
    if (!googleEmojis.some(x => bareEmoji_(x.emoji) === bareEmoji_(emoji))) {
      googleEmojis.push({ emoji, who: 'Analyst space' });
    }
  });

  const dedupReplies = list => {
    const out = [];
    const seenText = new Set();
    list.forEach(e => {
      const sig = `${e.who.toLowerCase()}|${e.text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
      if (!e.text || seenText.has(sig)) return;
      seenText.add(sig);
      out.push(e);
    });
    return out;
  };

  const googleReplies = dedupReplies(events.filter(e => (e.what === 'reply' || e.what === 'message') && e.isGoogle));
  const bursonReplies = dedupReplies(events.filter(e => (e.what === 'reply' || e.what === 'message') && !e.isGoogle && e.what !== 'alert'));

  return {
    googleEmojis,
    feedbackEmojis: Array.from(feedbackEmojis),
    googleReplies,
    bursonReplies,
    threadIds: Array.from(threadIds),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Building Alert & Thread Q&A comparison items (with Bot Logic & Knowledge Base Snippets)
// ---------------------------------------------------------------------------------------------------------------

function buildAnalysisAlertItem_(p, env) {
  const rows = (p.alert_ids || []).map(id => env.alertsById.get(String(id))).filter(Boolean);
  const srcFlow = (p.flows && (p.flows.ac || p.flows.main)) || null;
  const orig = (srcFlow && srcFlow.orig) || rows[0] || {};
  const mailer = rows.find(r => r.email_status === 'sent') ||
    rows.find(r => RESULTS_ESCALATED_.includes(String(r.email_status || ''))) || orig;
  const input = (mailer && mailer.email_input) || (orig && orig.email_input) || {};
  const fields = Object.assign({}, input.fields || {}, (orig && orig.forwarded_fields) || {});
  const esc = input.escalation || {};
  const chat = analysisAlertChatActivity_(rows, env.chatIndex);

  // Any Q&A exchanges linked to one of this post's alert_ids
  const qas = [];
  const seenQa = new Set();
  (p.alert_ids || []).forEach(id => {
    (env.qaByAlert.get(String(id)) || []).forEach(q => {
      if (!seenQa.has(q.rowKey)) { seenQa.add(q.rowKey); qas.push(q); }
    });
  });

  const botText = formatBotAlertResponse_(p, rows, orig, mailer, input, chat, qas, env);
  const analystText = formatAnalystAlertResponse_(p, chat);
  const alignment = formatAlertAlignment_(p, chat, qas);
  const logicText = formatAlertLogic_(p, rows, orig, mailer, input, fields, esc, env);
  const kbText = formatAlertKbSnippets_(p, rows, orig, fields, env.kb);

  const eng = typeof p.engagements === 'number' && isFinite(p.engagements) ? `${fmtInt_(p.engagements)} eng` : '';
  const metaParts = [
    p.product || fields.product || 'Unknown product',
    p.exposure_tag || fields.exposure_tag || '',
    p.issue || fields.issue_name || '',
    eng,
    p.kof ? 'KOF' : '',
  ].filter(Boolean);

  const rowKey = p.key ? `post:${p.key}` : `alert:${p.alert_id || orig.alert_id || p.burson_at}`;
  const sameCall = resultsSameCall_(p);
  const hasChat = chat.googleReplies.length > 0 || chat.googleEmojis.length > 0 || qas.length > 0;

  return {
    rowKey,
    at: p.burson_at,
    type: 'Alert',
    linkCell: resultsLink_(p),
    contextCell: speedText_(metaParts.join(' · ')),
    botCell: speedText_(botText),
    analystCell: speedText_(analystText),
    alignmentCell: speedText_(alignment.label),
    logicCell: speedText_(logicText),
    kbCell: speedText_(kbText),
    disagreement: sameCall === 'No',
    aligned: sameCall === 'Yes',
    decided: sameCall === 'Yes' || sameCall === 'No',
    imOnly: !p.bot_alerted && p.im_call === 'Social Alert',
    botOnly: !!p.bot_alerted && p.im_call === 'No Social Alert',
    socialAlert: !!p.bot_alerted || p.im_call === 'Social Alert',
    hasMistakes: ((p.fixes || []).length + (p.missing || []).length) > 0,
    hasChat,
    isQa: false,
    searchBlob: [
      p.product, p.exposure_tag, p.issue, p.author, p.network, p.url,
      botText, analystText, alignment.label, logicText, kbText,
    ].join('\n').toLowerCase(),
  };
}

/** Formats Column E (Chatbot's Response) for an Alert row. */
function formatBotAlertResponse_(p, rows, orig, mailer, input, chat, qas, env) {
  const lines = [];
  const botMin = p.bot_email_at && p.start_known
    ? `${Math.max(0, Math.round((p.bot_email_at - p.burson_at) / 6000) / 10)} min`
    : '';
  if (p.bot_alerted) {
    const state = p.bot_call === 'Social Alert'
      ? `sent${botMin ? ` in ${botMin}` : ''}${p.bot_auto_sent ? ', auto-sent' : ''}`
      : 'drafted / pending send';
    lines.push(`🚨 Social Alert (${state})`);
    const subj = String((mailer && mailer.email_subject) || '').trim();
    if (subj) lines.push(`• Subject: ${truncate_(subj, 140)}`);
    const groups = groupsOf_(mailer || orig).filter(g => g !== 'tns');
    if (groups.length) lines.push(`• Routed to: ${groups.join(', ')}`);
  } else {
    lines.push('❌ No Social Alert');
  }
  if (p.tns) {
    const submitted = rows.some(r => Number(r.tns_submitted) > 0);
    lines.push(`✍️ T&S form: ${submitted ? 'auto-submitted' : 'prepared for analyst'}`);
  }

  // Bot's Chat QA response & reactions
  const fixes = p.fixes || [];
  const missing = p.missing || [];
  if (!fixes.length && !missing.length) {
    lines.push('💬 Chat QA: 👍 All fields passed QA');
  } else {
    lines.push(`💬 Chat QA (${fixes.length} fix${fixes.length === 1 ? '' : 'es'}` +
      `${missing.length ? `, ${missing.length} missing` : ''}): ${resultsWrongText_(p)}`);
  }

  // Bot's legend emojis placed on the forwarded post
  const botEmojis = [];
  if (p.bot_alerted) botEmojis.push('📦');
  groupsOf_(mailer || orig).forEach(code => {
    const leg = (GEN.legend || []).find(l => l.code === code);
    if (leg && leg.emoji && !botEmojis.includes(leg.emoji)) botEmojis.push(leg.emoji);
  });
  if (!p.bot_alerted && String((orig && orig.decision) || '').trim()) botEmojis.push('❌');
  if (p.tns && !botEmojis.includes('✍️')) botEmojis.push('✍️');
  if (botEmojis.length) lines.push(`• Bot Chat emojis: ${botEmojis.join(' ')}`);

  if (p.flows_differ && p.flows && p.flows.main && p.flows.ac) {
    lines.push(`• Space split: ${resultsFlowCalls_(p, env.mainLabel)}`);
  }

  qas.slice(0, 2).forEach(q => {
    lines.push(`💬 Bot Q&A reply${q.who ? ` (to ${q.who})` : ''}: "${truncate_(q.botAnswer, 220)}"`);
  });
  return lines.join('\n');
}

/** Formats Column F (Google Analyst's Response — both IM Social Alert call & Google Chat replies/emojis) for an Alert row. */
function formatAnalystAlertResponse_(p, chat) {
  const lines = [];
  const imAt = speedImAt_(p);
  const imMin = imAt && p.start_known ? `${Math.round((imAt - p.burson_at) / 6000) / 10} min` : '';
  const who = p.im_draft && p.im_draft.by ? String(p.im_draft.by).replace(/@.*$/, '') : '';
  const subj = String((p.im_draft && p.im_draft.subject) || p.im_email_subject || '').trim();

  if (p.im_call === 'Social Alert') {
    const how = p.im_email_at ? 'email sent' : (p.im_draft ? 'SLRR draft' : 'SLRR alert log');
    const detail = [how, who ? `by ${who}` : '', imMin].filter(Boolean).join(', ');
    lines.push(`🚨 IM Call: Social Alert (${detail})`);
    if (subj) lines.push(`• IM Subject: ${truncate_(subj, 140)}`);
  } else if (p.im_call === 'No Social Alert') {
    lines.push('❌ IM Call: No Social Alert (24h+ passed without IM draft/email)');
  } else if (p.im_call === RESULTS_BOT_SENT_) {
    lines.push('🤖 IM Call: Bot auto-sent the Social Alert live');
  } else if (p.im_call === RESULTS_NO_LINK_) {
    lines.push('— IM Call: Can\'t match to SLRR log (alert had no post link)');
  } else {
    lines.push('⏳ IM Call: Not yet (<24h since Burson posted)');
  }

  if (chat.googleEmojis.length) {
    const grouped = new Map();
    chat.googleEmojis.forEach(x => {
      if (!grouped.has(x.who)) grouped.set(x.who, []);
      grouped.get(x.who).push(x.emoji);
    });
    const parts = Array.from(grouped.entries()).map(([w, list]) => `${list.join(' ')} (${w})`);
    lines.push(`💬 Analyst Chat emojis: ${parts.join(' · ')}`);
  }
  if (chat.feedbackEmojis.length) {
    lines.push(`• Analyst feedback on bot: ${chat.feedbackEmojis.join(' ')}`);
  }
  chat.googleReplies.slice(0, 3).forEach(r => {
    const note = /queued/i.test(r.status) ? ' [queued in outbox]' : '';
    lines.push(`💬 ${r.who}${note}: "${truncate_(r.text, 240)}"`);
  });
  if (chat.googleReplies.length > 3) {
    lines.push(`• (+${chat.googleReplies.length - 3} more Google analyst Chat repl${chat.googleReplies.length - 3 === 1 ? 'y' : 'ies'})`);
  }
  if (!chat.googleEmojis.length && !chat.googleReplies.length && !chat.feedbackEmojis.length) {
    lines.push('💬 Chat: No Google analyst reply or emoji recorded on this thread');
  }
  return lines.join('\n');
}

/** Formats Column G (Alignment badge) for an Alert row. */
function formatAlertAlignment_(p, chat, qas) {
  const same = resultsSameCall_(p);
  const chatNote = chat.googleReplies.length || qas.length
    ? `\n(+ ${chat.googleReplies.length ? `${chat.googleReplies.length} analyst repl${chat.googleReplies.length === 1 ? 'y' : 'ies'}` : ''}` +
      `${chat.googleReplies.length && qas.length ? ', ' : ''}${qas.length ? `${qas.length} bot Q&A` : ''})`
    : '';
  if (same === 'Yes') {
    return { label: `✓ Aligned (${p.bot_alerted ? 'Social Alert' : 'No Social Alert'})${chatNote}` };
  }
  if (same === 'No') {
    return {
      label: (!p.bot_alerted && p.im_call === 'Social Alert'
        ? '⚠️ Disagreement: IM alerted, Bot didn\'t'
        : '⚠️ Disagreement: Bot alerted, IM didn\'t') + chatNote,
    };
  }
  if (p.im_call === 'Not yet') {
    const emojiHint = chat.googleEmojis.length
      ? ` · Analyst reacted ${chat.googleEmojis.map(x => x.emoji).join(' ')}`
      : '';
    return { label: `⏳ Pending IM window (<24h)${emojiHint}${chatNote}` };
  }
  if (p.im_call === RESULTS_BOT_SENT_) return { label: `✓ Bot auto-sent${chatNote}` };
  return { label: `— Can't match (no link)${chatNote}` };
}

/**
 * Formats Column H (Bot's Logic — escalation rule track, AI review / veto, QA check reasons, routing & T&S reasons,
 * plus any matching Guidance tab instruction or Learned precedent).
 */
function formatAlertLogic_(p, rows, orig, mailer, input, fields, esc, env) {
  const lines = [];
  const mainWhy = resultsReason_(p, env.noWait);
  const prio = esc && esc.priority ? `[${esc.priority}] ` : '';
  lines.push(`1) Call logic: ${prio}${mainWhy}`);

  // Rule reasons / suppression details from escalation object when present
  const escReasons = Array.isArray(esc && esc.reasons) ? esc.reasons.filter(Boolean) : [];
  if (escReasons.length) {
    const joined = escReasons.slice(0, 3).map(r => truncate_(String(r), 140)).join('; ');
    if (joined.toLowerCase() !== mainWhy.toLowerCase()) lines.push(`   • Rule triggers: ${joined}`);
  }
  if (esc && esc.suppression) {
    lines.push(`   • Suppression rule: ${truncate_(String(esc.suppression), 160)}`);
  }

  // QA field-by-field reasoning from requested items
  const req = []
    .concat((orig && Array.isArray(orig.requested)) ? orig.requested : [])
    .filter(x => x && x.field && (x.reason || x.problem || x.suggest));
  if (req.length) {
    const qaParts = req.slice(0, 4).map(x => {
      const label = burLabel_(x.field);
      const change = x.problem
        ? String(x.problem)
        : (LONG_TEXT_FIELDS_.includes(x.field) ? 'rewritten' : `${truncate_(bursonValue_(x.field, x.old), 28)} → ${truncate_(bursonValue_(x.field, x.new), 28)}`);
      const why = truncate_(String(x.reason || x.suggest || ''), 140);
      return `   • ${label} (${change})${why ? ': ' + why : ''}`;
    });
    lines.push('2) QA check logic:\n' + qaParts.join('\n'));
  } else {
    lines.push('2) QA check logic: Every parsed field matched SLRR schema & taxonomy checks.');
  }

  // Team & T&S routing reasons
  const aiReasons = input.ai_reasons && typeof input.ai_reasons === 'object' ? input.ai_reasons : {};
  const reasonKeys = Object.keys(aiReasons).filter(k => k !== 'tns' && aiReasons[k]);
  const tnsReason = tnsWhy_(input) || (Array.isArray(input.ts_reasons) ? input.ts_reasons.join(', ') : '');
  if (reasonKeys.length || tnsReason) {
    const routeBits = reasonKeys.slice(0, 3).map(k => `${k}: ${truncate_(String(aiReasons[k]), 110)}`);
    if (tnsReason) routeBits.push(`T&S: ${truncate_(String(tnsReason), 120)}`);
    lines.push(`3) Routing logic: ${routeBits.join(' · ')}`);
  }
  if (input.comms_context) {
    lines.push(`• Outage/comms doc note: ${truncate_(String(input.comms_context), 180)}`);
  }

  // Matching active Guidance rows & Learned precedents
  const prod = String(p.product || fields.product || '').toLowerCase();
  const tag = String(p.exposure_tag || fields.exposure_tag || '').toLowerCase();
  const iss = String(p.issue || fields.issue_name || '').toLowerCase();
  const matchedGuidance = (env.guidance || []).filter(g => {
    const app = String(g.applies_to || '').trim().toLowerCase();
    if (!app || /^(?:all|everything|every alert|\*)$/.test(app)) return true;
    return (prod && (app.includes(prod) || prod.includes(app))) ||
      (tag && app.includes(tag)) ||
      (iss && knowledgeTokens_(app).some(tok => tok.length >= 4 && iss.includes(tok)));
  });
  matchedGuidance.slice(0, 2).forEach(g => {
    lines.push(`📌 Active Guidance${g.applies_to ? ` (${g.applies_to})` : ''}: "${truncate_(g.text, 180)}"`);
  });

  const matchedLearned = (env.learned || []).filter(r =>
    (p.key && r.key && samePost_(p.key, r.key)) ||
    (prod && String(r.product || '').toLowerCase() === prod && tag && String(r.exposure_tag || '').toLowerCase() === tag)
  );
  matchedLearned.slice(0, 1).forEach(r => {
    lines.push(`📚 Learned precedent (${r.product || 'same product'}): ${truncate_(r.lesson, 180)}`);
  });

  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Knowledge Base Snippet extraction (from "Knowledge cache (bot)")
// ---------------------------------------------------------------------------------------------------------------

/**
 * Extracts verbatim Knowledge Base passages for an Alert: first every document Gemini explicitly cited in
 * `knowledge_used` (with what Gemini used it for + the top-scoring passage from that document), and when none were
 * explicitly cited, the highest-scoring passage across readable Resources documents that matches the alert's query.
 */
function formatAlertKbSnippets_(p, rows, orig, fields, kb) {
  const docs = (kb && kb.docs) || [];
  if (!docs.length) return 'No readable documents in Knowledge cache yet (check the Resources tab).';

  const cited = [];
  const seenDoc = new Set();
  (rows || []).concat(orig ? [orig] : []).forEach(r => {
    ((r && Array.isArray(r.knowledge_used)) ? r.knowledge_used : []).forEach(u => {
      const name = String((u && (u.document || u.name)) || '').trim();
      if (!name || seenDoc.has(name.toLowerCase())) return;
      seenDoc.add(name.toLowerCase());
      cited.push({ name, used_for: String((u && u.used_for) || '').trim() });
    });
  });

  const queryFields = Object.assign({
    product: p.product,
    exposure_tag: p.exposure_tag,
    issue_name: p.issue,
    author: p.author,
    social_network: p.network,
    post_url: p.url,
  }, fields || {});
  const query = knowledgeQuery_({ fields: queryFields, outageComms: true });

  const out = [];
  cited.slice(0, 3).forEach(c => {
    const doc = findKbDocByName_(docs, c.name);
    if (!doc) {
      out.push(`📄 ${c.name}${c.used_for ? ` — used for: ${c.used_for}` : ''}`);
      return;
    }
    const best = bestPassageInDoc_(doc, query);
    const head = best && best.heading ? ` [under "${truncate_(best.heading, 60)}"]` : '';
    out.push(`📄 ${doc.name}${c.used_for ? ` — used for: ${c.used_for}` : ''}${head}` +
      (best && best.snippet ? `\n  ↳ "${best.snippet}"` : ''));
  });

  if (!out.length) {
    const top = bestPassagesAcrossKb_(docs, query, 2);
    top.forEach(hit => {
      const head = hit.heading ? ` [under "${truncate_(hit.heading, 60)}"]` : '';
      out.push(`📄 ${hit.doc.name} (matched KB passage)${head}\n  ↳ "${hit.snippet}"`);
    });
  }

  return out.length
    ? out.join('\n\n')
    : 'No specific Resources passage matched this post (deterministic SLRR playbook thresholds & field rules applied).';
}

/** Finds a doc in `kb.docs` by exact or prefix/substring title match. Pure. */
function findKbDocByName_(docs, name) {
  const target = String(name || '').replace(/^\[\d+\]\s*/, '').trim().toLowerCase();
  if (!target) return null;
  return (docs || []).find(d => String(d.name || '').trim().toLowerCase() === target) ||
    (docs || []).find(d => String(d.name || '').toLowerCase().includes(target) || target.includes(String(d.name || '').toLowerCase())) ||
    null;
}

/** Picks the single passage in `doc` that scores highest for `query` (or its opening passage) and trims a crisp excerpt. Pure. */
function bestPassageInDoc_(doc, query) {
  if (!doc || !doc.text) return null;
  const passages = knowledgePassages_(doc.text);
  if (!passages.length) return null;
  const scores = knowledgeScores_(passages.map(x => x.text), query);
  let bestIdx = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[bestIdx]) bestIdx = i;
  }
  const chosen = passages[bestIdx];
  return {
    heading: chosen.heading || '',
    score: scores[bestIdx] || 0,
    snippet: trimPassageSnippet_(chosen.text, query, ANALYSIS_SNIPPET_CHARS_),
  };
}

/** Picks up to `limit` positive-scoring passages across all `docs` (at most one per document). Pure. */
function bestPassagesAcrossKb_(docs, query, limit) {
  const pool = [];
  (docs || []).forEach(doc => {
    knowledgePassages_(doc.text).forEach(p => pool.push({ doc, heading: p.heading || '', text: p.text }));
  });
  if (!pool.length) return [];
  const scores = knowledgeScores_(pool.map(x => x.text), query);
  const ranked = pool.map((x, i) => ({ x, score: scores[i] || 0, i }))
    .filter(r => r.score > 0.5)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const out = [];
  const seen = new Set();
  for (const r of ranked) {
    if (seen.has(r.x.doc.url)) continue;
    seen.add(r.x.doc.url);
    out.push({
      doc: r.x.doc,
      heading: r.x.heading,
      score: r.score,
      snippet: trimPassageSnippet_(r.x.text, query, ANALYSIS_SNIPPET_CHARS_),
    });
    if (out.length >= (limit || 2)) break;
  }
  return out;
}

/** Centers the excerpt around the first line/sentence matching the query's phrases/handles/tokens so snippets show exact rules. Pure. */
function trimPassageSnippet_(text, query, maxChars) {
  const max = maxChars || ANALYSIS_SNIPPET_CHARS_;
  const clean = String(text || '').replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;

  const q = query || {};
  const needles = []
    .concat((q.handles || []).map(h => String(h || '').replace(/^@+/, '').toLowerCase()).filter(h => h.length >= 3))
    .concat((q.phrases || []).map(p => String(p || '').toLowerCase()).filter(p => p.length >= 4))
    .concat(knowledgeTokens_(q.text).filter(t => t.length >= 4).slice(0, 8));

  const low = clean.toLowerCase();
  let pos = -1;
  for (const n of needles) {
    const idx = low.indexOf(n);
    if (idx >= 0) { pos = idx; break; }
  }
  if (pos <= 0 || pos < Math.floor(max * 0.45)) return clean.slice(0, max - 1).trim() + '…';
  const start = Math.max(0, clean.lastIndexOf(' ', Math.max(0, pos - 70)));
  const slice = clean.slice(start, start + max - 2).trim();
  return (start > 0 ? '…' : '') + slice + (start + max - 2 < clean.length ? '…' : '');
}

// ---------------------------------------------------------------------------------------------------------------
// Thread & standalone Chat Q&A comparison items
// ---------------------------------------------------------------------------------------------------------------

/**
 * Combines live-recorded Q&A items (ANALYSIS_QA) with historical `kind === 'question'` rows from `Message log` (paired
 * with `Relay` and `Alert log`), alongside any Google analyst replies in the same Chat thread.
 */
function buildAnalysisQaItems_(ss, qaSaved, chatIndex, alertsById, alertByThread, kb, guidance, since) {
  const byMsg = new Map();
  (qaSaved || []).forEach(q => {
    if (!q || (Number(q.at) || 0) < since) return;
    const id = q.message || q.key;
    byMsg.set(String(id), q);
  });

  // Also reconstruct from Message log (kind === 'question') so past Q&A exchanges appear immediately
  if (ss.getSheetByName(MESSAGE_TAB_)) {
    try {
      const msgRows = sheetTable_(ss, MESSAGE_TAB_, MESSAGE_COLUMNS_, 'message', MESSAGE_READ_ROWS_).load();
      msgRows.forEach(r => {
        if (!r || String(r.kind || '') !== 'question') return;
        const at = Number(r.created_at) || 0;
        if (at < since) return;
        const rawName = String(r.message || '').replace(/^ac\|/, '');
        if (!rawName || byMsg.has(rawName)) return;
        const relayHits = (chatIndex.byMsg.get(rawName) || []);
        const hit = relayHits.find(x => x.text) || relayHits[0] || null;
        const alert = (r.alert_id && alertsById.get(String(r.alert_id))) ||
          (hit && (alertByThread.get(hit.test_thread) || alertByThread.get(hit.burson_thread))) || null;
        byMsg.set(rawName, {
          key: 'qa:' + rawName,
          message: rawName,
          thread: (hit && (hit.test_thread || hit.burson_thread)) || (alert && (alert.forward_thread || alert.source_thread)) || '',
          at,
          space: hit && hit.dir === RELAY_FROM_ ? 'Mirror / Burson thread' : 'Chat thread',
          who: (hit && hit.who) || 'Chat user',
          question: (hit && hit.text) || '',
          bot_answer: '',
          alert_id: String(r.alert_id || (alert && alert.alert_id) || ''),
          blocked: [],
          docs_used: [],
        });
      });
    } catch (e) {}
  }

  const out = [];
  byMsg.forEach(q => {
    const alert = (q.alert_id && alertsById.get(String(q.alert_id))) ||
      (q.thread && alertByThread.get(String(q.thread))) || null;
    const f = Object.assign({}, ((alert && alert.email_input) || {}).fields || {}, (alert && alert.forwarded_fields) || {});
    const threadEvents = q.thread ? (chatIndex.byThread.get(String(q.thread)) || []) : [];
    const analystReplies = threadEvents.filter(e =>
      (e.what === 'reply' || e.what === 'message') && e.isGoogle && e.text && e.test_message !== q.message && e.burson_message !== q.message
    );

    const questionLine = q.question
      ? `Asked${q.who ? ` by ${q.who}` : ''}: "${truncate_(q.question, 280)}"`
      : `Question in ${q.space || 'Chat thread'} (${q.message.split('/').pop()})`;
    const answerLine = q.bot_answer
      ? `🤖 Bot answered: "${truncate_(q.bot_answer, 420)}"`
      : '🤖 Bot answered in Chat thread (recorded prior to full answer capture; new answers show verbatim here)';
    const botText = `${questionLine}\n${answerLine}`;

    const analystText = analystReplies.length
      ? analystReplies.slice(0, 3).map(r => `💬 ${r.who}: "${truncate_(r.text, 260)}"`).join('\n')
      : '💬 No separate Google analyst reply in this thread (bot handled the question)';

    const alignment = analystReplies.length
      ? '💬 Chat Q&A (Bot + Analyst replied)'
      : '💬 Chat Q&A (Bot answered)';

    const query = knowledgeQueryFor_(q.question || f.issue_name || '', alert);
    const docs = (kb && kb.docs) || [];
    const kbParts = [];
    (q.docs_used || []).slice(0, 3).forEach(d => {
      const doc = findKbDocByName_(docs, d.name);
      if (!doc) return;
      const best = bestPassageInDoc_(doc, query);
      const head = best && best.heading ? ` [under "${truncate_(best.heading, 60)}"]` : '';
      kbParts.push(`📄 ${doc.name} (consulted for answer)${head}` + (best && best.snippet ? `\n  ↳ "${best.snippet}"` : ''));
    });
    if (!kbParts.length && docs.length) {
      bestPassagesAcrossKb_(docs, query, 2).forEach(hit => {
        const head = hit.heading ? ` [under "${truncate_(hit.heading, 60)}"]` : '';
        kbParts.push(`📄 ${hit.doc.name} (matched KB passage)${head}\n  ↳ "${hit.snippet}"`);
      });
    }
    const kbText = kbParts.length
      ? kbParts.join('\n\n')
      : 'Answered from the alert\'s reviewed fields and built-in SLRR QA rules.';

    const logicLines = [
      `1) Q&A trigger: Question / field inquiry in ${q.space || 'Chat'}${alert ? ` on alert ${alert.alert_id}` : ''}.`,
      q.blocked && q.blocked.length
        ? `2) Leak-guard safety: Held back draft mentioning (${q.blocked.join(', ')}) and sent safe fallback.`
        : '2) Grounding: Answered from Resources documents + the alert\'s reviewed QA record & Guidance.',
    ];
    if (alert && (alert.requested || []).length) {
      logicLines.push(`3) Alert QA context: ${resultsWrongText_({
        fixes: (alert.requested || []).filter(x => x && x.field && !x.problem),
        missing: (alert.requested || []).filter(x => x && x.field && x.problem),
      })}`);
    }

    const url = String(f.post_url || '').trim();
    const linkCell = url
      ? resultsLink_({ network: f.social_network || 'Post', author: f.author || '', url })
      : speedText_(alert ? `Alert ${alert.alert_id} thread` : 'Standalone Chat Q&A');
    const contextParts = [
      f.product || (alert ? 'Alert thread' : 'General Q&A'),
      f.exposure_tag || '',
      f.issue_name || (q.question ? truncate_(q.question, 80) : ''),
    ].filter(Boolean);

    out.push({
      rowKey: q.key || ('qa:' + q.message),
      alertId: String(q.alert_id || (alert && alert.alert_id) || ''),
      who: q.who || '',
      botAnswer: q.bot_answer || '(answered in Chat)',
      at: Number(q.at) || 0,
      type: 'Thread Q&A',
      linkCell,
      contextCell: speedText_(contextParts.join(' · ')),
      botCell: speedText_(botText),
      analystCell: speedText_(analystText),
      alignmentCell: speedText_(alignment),
      logicCell: speedText_(logicLines.join('\n')),
      kbCell: speedText_(kbText),
      disagreement: false,
      aligned: false,
      decided: false,
      imOnly: false,
      botOnly: false,
      socialAlert: false,
      hasMistakes: false,
      hasChat: true,
      isQa: true,
      searchBlob: [
        f.product, f.exposure_tag, f.issue_name, f.author, url,
        q.who, q.question, q.bot_answer, analystText, kbText,
      ].join('\n').toLowerCase(),
    });
  });

  return out.sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------------------------------------------------------
// Controls, filters, scorecard & preserved analyst grading
// ---------------------------------------------------------------------------------------------------------------

function analysisDefaultControls_() {
  return { runNow: false, windowLabel: '7 days', focus: 'All items', search: '' };
}

function normalizeAnalysisControls_(raw) {
  const def = analysisDefaultControls_();
  const src = raw && typeof raw === 'object' ? raw : {};
  const runRaw = src.runNow;
  const runNow = runRaw === true || /^run now$|^true$|^1$/i.test(String(runRaw || '').trim());
  const winStr = String(src.windowLabel || '').trim();
  const win = ANALYSIS_WINDOWS_.find(w => w.toLowerCase() === winStr.toLowerCase()) || def.windowLabel;
  const focusStr = String(src.focus || '').trim();
  const focus = ANALYSIS_FOCUSES_.find(f => f.toLowerCase() === focusStr.toLowerCase()) || def.focus;
  const search = truncate_(String(src.search || '').trim(), 200);
  return { runNow, windowLabel: win, focus, search };
}

/**
 * Reads active filter controls from hidden cell M2 (`panel controls`), falling back cleanly to legacy Layout 1 B4:B7
 * during the one-time upgrade from the old 15-row top header.
 */
function readAnalysisControls_(sh) {
  const def = analysisDefaultControls_();
  if (!sh || sh.getLastRow() < 1) return def;
  const a1 = String(sh.getRange(1, 1).getDisplayValue() || '').trim();
  if (a1 === ANALYSIS_TITLE_) {
    if (sh.getLastRow() < ANALYSIS_LEGACY_CONTROL_ROW_ + 3) return def;
    const vals = sh.getRange(ANALYSIS_LEGACY_CONTROL_ROW_, 2, 4, 1).getDisplayValues().map(r => String(r[0] || '').trim());
    return normalizeAnalysisControls_({
      runNow: /^run now$/i.test(vals[0]),
      windowLabel: vals[1],
      focus: vals[2],
      search: vals[3],
    });
  }
  if (sh.getLastRow() < 2 || sh.getLastColumn() < ANALYSIS_CONTROLS_COL_) return def;
  const raw = String(sh.getRange(2, ANALYSIS_CONTROLS_COL_).getDisplayValue() || '').trim();
  if (!raw) return def;
  try {
    return normalizeAnalysisControls_(JSON.parse(raw));
  } catch (e) {
    return def;
  }
}

/** Updates hidden cell M2 (`panel controls`) on the Analysis tab so the Sidepanel and tests can change filters cleanly. */
function setAnalysisControls_(sh, patch) {
  const next = normalizeAnalysisControls_(Object.assign({}, readAnalysisControls_(sh), patch || {}));
  sh.getRange(2, ANALYSIS_CONTROLS_COL_).setValue(capJson_(next, 4000));
  return next;
}

function analysisMatchesFilter_(item, controls) {
  const focus = controls.focus;
  if (focus === 'Disagreements only' && !item.disagreement) return false;
  if (focus === 'With Chat replies / Q&A' && !item.hasChat) return false;
  if (focus === 'Social Alerts only' && !item.socialAlert) return false;
  if (focus === 'QA mistakes caught' && !item.hasMistakes) return false;
  if (focus === 'Thread Q&A only' && !item.isQa) return false;

  const q = String(controls.search || '').trim().toLowerCase();
  if (!q) return true;
  const terms = q.split(/\s+/).filter(Boolean);
  return terms.every(t => item.searchBlob.indexOf(t) >= 0);
}

function analysisScorecard_(alertItems, qaItems, reviews) {
  const decided = alertItems.filter(x => x.decided);
  const aligned = decided.filter(x => x.aligned);
  const pct = decided.length ? `${Math.round((100 * aligned.length) / decided.length)}%` : '—';
  let graded = 0;
  let botRight = 0;
  let analystRight = 0;
  alertItems.concat(qaItems).forEach(x => {
    const rev = reviews.get(x.rowKey);
    if (!rev || (!rev.verdict && !rev.notes)) return;
    if (rev.verdict) graded++;
    if (rev.verdict === 'Bot right' || rev.verdict === 'Both acceptable') botRight++;
    if (rev.verdict === 'Analyst right') analystRight++;
  });
  return {
    alerts: alertItems.length,
    decided: decided.length,
    aligned: aligned.length,
    parityPct: pct,
    imOnly: alertItems.filter(x => x.imOnly).length,
    botOnly: alertItems.filter(x => x.botOnly).length,
    withChat: alertItems.filter(x => x.hasChat).length,
    qaCount: qaItems.length,
    mistakes: alertItems.filter(x => x.hasMistakes).length,
    graded,
    botRight,
    analystRight,
  };
}

/** Reads existing Analyst Verdict & Analyst Notes from the sheet by finding the header row and hidden `row key` column. */
function readAnalysisReviews_(sh) {
  const out = new Map();
  if (!sh) return out;
  const last = sh.getLastRow();
  if (last < 2) return out;
  const firstCol = sh.getRange(1, 1, last, 1).getValues();
  let head = 0;
  for (let i = firstCol.length - 1; i >= 0 && !head; i--) {
    if (String(firstCol[i][0]) === ANALYSIS_HEADER_[0]) head = i + 1;
  }
  if (!head || head >= last) return out;
  const width = Math.max(ANALYSIS_HEADER_.length, sh.getLastColumn());
  const header = sh.getRange(head, 1, 1, width).getValues()[0].map(String);
  const keyCol = header.indexOf('row key') + 1;
  const verdictCol = header.indexOf('Analyst Verdict') + 1;
  const notesCol = header.indexOf('Analyst Notes') + 1;
  if (!keyCol || !verdictCol || !notesCol) return out;

  const rows = sh.getRange(head + 1, 1, last - head, Math.max(keyCol, verdictCol, notesCol)).getValues();
  rows.forEach(r => {
    const key = String(r[keyCol - 1] || '').trim();
    if (!key) return;
    const verdict = String(r[verdictCol - 1] || '').trim();
    const notes = String(r[notesCol - 1] || '').trim();
    out.set(key, { verdict, notes, touched: Boolean(verdict || notes) });
  });
  return out;
}

/**
 * Merges sheet verdicts/notes with the bounded ANALYSIS_REVIEWS backup property so filtering rows out and back in never
 * drops an analyst's notes, while clearing a cell on a visible row clears it in the backup too.
 */
function mergeAnalysisReviews_(props, sheetMap) {
  let saved = {};
  try { saved = JSON.parse(props.getProperty(ANALYSIS_REVIEWS_PROP_) || '{}') || {}; } catch (e) { saved = {}; }
  const merged = new Map();
  Object.keys(saved || {}).forEach(k => {
    const v = saved[k];
    if (v && (v.v || v.n)) merged.set(k, { verdict: String(v.v || ''), notes: String(v.n || ''), at: Number(v.t) || 0 });
  });
  const now = Date.now();
  sheetMap.forEach((val, key) => {
    if (val.verdict || val.notes) {
      merged.set(key, { verdict: truncate_(val.verdict, 60), notes: truncate_(val.notes, 500), at: now });
    } else if (merged.has(key)) {
      // The row was visible on the sheet and its verdict & notes were cleared by the analyst
      merged.delete(key);
    }
  });
  // Persist newest 80 non-empty entries under 7.5 KB
  const entries = Array.from(merged.entries())
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, 80);
  const compact = {};
  entries.forEach(([k, v]) => { compact[k] = { v: v.verdict, n: v.notes, t: v.at || 0 }; });
  const encoded = capJson_(compact, ANALYSIS_PROP_MAX_CHARS_);
  if (props.getProperty(ANALYSIS_REVIEWS_PROP_) !== encoded) props.setProperty(ANALYSIS_REVIEWS_PROP_, encoded);
  return merged;
}

// ---------------------------------------------------------------------------------------------------------------
// Sheet layout, ownership check & rendering (Layout 2: 1-row frozen header + 3-subtab Sidepanel state)
// ---------------------------------------------------------------------------------------------------------------

/**
 * True only when `sh` is the Analysis tab created by the bot: recognizes both Layout 2 (Row 1 = ANALYSIS_HEADER_ with
 * hidden `row key` column) and legacy Layout 1 (A1 = ANALYSIS_TITLE_) so existing sheets upgrade cleanly in place.
 */
function isAnalysisTab_(sh) {
  try {
    const lastCol = sh.getLastColumn();
    if (lastCol < 1) return false;
    const row1 = sh.getRange(1, 1, 1, Math.min(Math.max(lastCol, 1), ANALYSIS_HEADER_.length)).getDisplayValues()[0]
      .map(x => String(x || '').trim());
    if (row1[0] === ANALYSIS_TITLE_) return true;
    return row1[0] === ANALYSIS_HEADER_[0] &&
      row1[4] === ANALYSIS_HEADER_[4] &&
      row1[ANALYSIS_KEY_COL_ - 1] === 'row key';
  } catch (e) {
    return false;
  }
}

/**
 * Ensures the Analysis tab exists right after Results / Learned precedents / Follow-up (never displacing Follow-up or
 * Learned precedents right after Results). Returns null if a user-made tab named "Analysis" is in the way.
 */
function ensureAnalysisTab_(ss) {
  let sh = ss.getSheetByName(ANALYSIS_TAB_);
  if (sh && !isAnalysisTab_(sh)) return null;
  const created = !sh;
  if (created) {
    const sheets = ss.getSheets();
    const names = sheets.map(s => s.getName());
    const anchors = [RESULTS_TAB_, LEARNED_TAB_, FOLLOWUP_TAB_]
      .map(n => names.indexOf(n))
      .filter(i => i >= 0);
    const insertAt = anchors.length ? Math.max.apply(null, anchors) + 1 : Math.min(3, sheets.length);
    sh = ss.insertSheet(ANALYSIS_TAB_, insertAt);
    sh.getRange(1, 1, 1, ANALYSIS_HEADER_.length).setValues([ANALYSIS_HEADER_]);
    try {
      sh.protect()
        .setDescription('Written by the Burson QA bot (use 📊 Bot Analysis → Open Sidepanel to filter, and Columns J:K for verdicts/notes)')
        .setWarningOnly(true);
    } catch (e) { /* works unprotected too */ }
  }
  const props = PropertiesService.getScriptProperties();
  if (created || props.getProperty(ANALYSIS_LAYOUT_PROP_) !== ANALYSIS_LAYOUT_) {
    try { sh.showColumns(1, ANALYSIS_HEADER_.length); } catch (e) {}
    ANALYSIS_WIDTHS_.forEach(([c, px]) => sh.setColumnWidth(c, px));
    try { sh.hideColumns(ANALYSIS_KEY_COL_, ANALYSIS_HIDDEN_COLS_); } catch (e) {}
  }
  return sh;
}

/** Builds the structured JSON payload stored in hidden cell N2 for the Sidepanel's 3 subtabs (Overview, Controls, Scorecard). */
function buildAnalysisPanelSummary_(r) {
  const sc = r.scorecard;
  const updatedEt = `${speedTime_(r.now)} ET`;
  const staleEt = r.stale ? `${speedTime_(r.stale)} ET` : '';
  const overviewText = 'Side-by-side comparison of the chatbot\'s responses (Social Alert calls, Chat QA fixes/emojis, and ' +
    'Chat Q&A answers) next to Google analysts\' own responses (Chat replies & emojis from the Mirror/Relay logs plus IM ' +
    'Social Alert calls), alongside the bot\'s triage logic and verbatim snippets from the Resources Knowledge Base.';
  const payload = {
    version: 2,
    overview: {
      title: ANALYSIS_TITLE_,
      updatedAt: r.now,
      updatedEt,
      staleEt,
      description: overviewText,
      kbDocs: r.kbDocs,
      guidanceCount: r.guidanceCount,
      learnedCount: r.learnedCount,
    },
    controls: {
      windowLabel: r.controls.windowLabel,
      focus: r.controls.focus,
      search: r.controls.search,
      shown: r.items.length,
      totalMatching: r.totalMatching,
      totalInWindow: r.totalInWindow,
      statusText: `Showing ${r.items.length} of ${r.totalMatching} matching item(s) (${r.totalInWindow} total in ${r.controls.windowLabel})` +
        (r.controls.search ? ` for "${truncate_(r.controls.search, 60)}"` : ''),
    },
    scorecard: {
      windowLabel: r.controls.windowLabel,
      alerts: sc.alerts,
      decided: sc.decided,
      aligned: sc.aligned,
      parityPct: sc.parityPct,
      disagreements: sc.imOnly + sc.botOnly,
      imOnly: sc.imOnly,
      botOnly: sc.botOnly,
      mistakes: sc.mistakes,
      withChat: sc.withChat,
      qaCount: sc.qaCount,
      chatAndQa: sc.withChat + sc.qaCount,
      graded: sc.graded,
      botRight: sc.botRight,
      analystRight: sc.analystRight,
    },
  };
  return capJson_(payload, 45000);
}

/**
 * Writes the compact 1-row-header Analysis tab (Row 1 = frozen table header, Row 2+ = full-screen comparison rows) and
 * updates hidden Sidepanel state cells M2 (`panel controls`) and N2 (`panel summary`).
 */
function writeAnalysisTab_(sh, r) {
  const width = ANALYSIS_HEADER_.length;
  const out = [];
  const add = row => {
    out.push(row.map(v => (v === null || v === undefined ? '' : v))
      .concat(new Array(Math.max(0, width - row.length)).fill('')).slice(0, width));
    return out.length;
  };

  const head = add(ANALYSIS_HEADER_);
  const controlsJson = capJson_({
    runNow: false,
    windowLabel: r.controls.windowLabel,
    focus: r.controls.focus,
    search: r.controls.search,
  }, 4000);
  const summaryJson = buildAnalysisPanelSummary_(r);

  if (!r.items.length) {
    const emptyRow = new Array(width).fill('');
    emptyRow[0] = 'No items match the current Lookback / Focus / Search filters (open 📊 Bot Analysis → Open Sidepanel to adjust filters).';
    emptyRow[ANALYSIS_CONTROLS_COL_ - 1] = controlsJson;
    emptyRow[ANALYSIS_SUMMARY_COL_ - 1] = summaryJson;
    add(emptyRow);
  } else {
    r.items.forEach((item, idx) => {
      const rev = r.reviews.get(item.rowKey) || { verdict: '', notes: '' };
      add([
        speedTime_(item.at),
        item.type,
        item.linkCell,
        item.contextCell,
        item.botCell,
        item.analystCell,
        item.alignmentCell,
        item.logicCell,
        item.kbCell,
        speedText_(rev.verdict),
        speedText_(rev.notes),
        speedText_(item.rowKey),
        idx === 0 ? controlsJson : '',
        idx === 0 ? summaryJson : '',
      ]);
    });
  }

  const prev = sh.getLastRow();
  const prevWidth = Math.max(width, sh.getLastColumn());
  const upgrading = String(sh.getRange(1, 1).getDisplayValue() || '').trim() === ANALYSIS_TITLE_;
  const fmt = f => { try { f(); } catch (e) { /* formatting only */ } };
  fmt(() => sh.getRange(1, 1, Math.max(prev, out.length, 2), prevWidth).breakApart());
  fmt(() => sh.clearFormats());

  if (prev > out.length) {
    sh.getRange(out.length + 1, 1, prev - out.length, prevWidth).clearContent();
  }
  sh.getRange(1, 1, out.length, width).setValues(out);

  // Formatting: 1 single frozen header row (Row 1) + wrapped top-aligned comparison rows starting right at Row 2
  fmt(() => sh.getRange(head, 1, 1, ANALYSIS_VISIBLE_COLS_).setFontWeight('bold').setBackground('#f1f3f4').setWrap(true));
  fmt(() => sh.setFrozenRows(head));
  if (upgrading) {
    fmt(() => sh.autoResizeRows(1, Math.min(out.length, 40)));
  }

  if (r.items.length) {
    fmt(() => sh.getRange(head + 1, 1, r.items.length, 1).setNumberFormat('yyyy-mm-dd hh:mm'));
    fmt(() => sh.getRange(head + 1, 1, r.items.length, ANALYSIS_VISIBLE_COLS_).setWrap(true).setVerticalAlignment('top'));
    fmt(() => sh.getRange(head + 1, ANALYSIS_VERDICT_COL_, r.items.length, 2).setBackground('#fffef7'));
    fmt(() => sh.getRange(head + 1, ANALYSIS_VERDICT_COL_, r.items.length, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ANALYSIS_VERDICTS_, true).setAllowInvalid(true).build()));
  } else {
    fmt(() => sh.getRange(2, 1, 1, ANALYSIS_VISIBLE_COLS_).setFontColor('#5f6368').setFontStyle('italic'));
  }
  fmt(() => sh.hideColumns(ANALYSIS_KEY_COL_, ANALYSIS_HIDDEN_COLS_));
  return { head };
}
