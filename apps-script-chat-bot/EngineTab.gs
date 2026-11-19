/**
 * EngineTab.gs — the "Engine" tab (step S3 of the open-engine plan): under Control row 51 (OpenEngine.gs openOn_), one
 * row for each Early Detection check, what it read, judged and could not do, and a daily row; 7 days kept, newest first.
 * With row 51 OFF nothing here runs: nothing is counted, read or written.
 *
 * The tab, top to bottom:
 *   row 1   its title (ENG_TITLE_): the bot's mark. The tab is the bot's own only when A1 is exactly that title and row 3
 *           is exactly its column names (isEngineTab_), checked before every write; a tab named "Engine" that the bot
 *           did not make is never read past its first rows, cleared or written (C51 says it is in the way)
 *   row 2   what's listed (ENG_ABOUT_)
 *   row 3   the column names (ENG_COLS_), frozen
 *   row 4+  one row a check (Row = "check"), and once an Eastern day a row for the day before (Row = "day ..."); newest
 *           first; rows older than 7 days are deleted from the bottom
 * Every cell is short: a number, or a text of at most ENG_CELL_MAX_ characters, written as text (a leading apostrophe).
 *
 * How a column is filled (each never throws, and does nothing with row 51 OFF):
 *   engAdd_(key, n)      adds n to the column `key` of the next row (a number column)
 *   engSet_(key, text)   sets the column `key` of the next row (a text column; the last one set wins)
 *   engCheck_(result)    an Early Detection check ran in this run (BigQuery.gs earlyWaveCheck_'s answer): the run's
 *                        row is written at its end (Main.gs maybeWriteEngineTab_)
 * Numbers counted between two checks (reviews in the runs between them, say) go in the next check's row: they are kept
 * in the script property ENGINE_ACC (at most 8,800 characters) until then, with the day's sums for the daily row. A
 * later step adds its column's numbers with engAdd_ at the place it counts them; the columns of later steps are here
 * already and stay blank until then (RQ8 of the requirements-first plan: alone read, code pass, gated, asked, quick
 * pass, failed, not reached, quick s, tokens, refused, code check ms).
 */

const ENG_NAME_ = 'Engine';
const ENG_TITLE_ = 'Engine: one row per Early Detection check, what it read, judged and could not do (written by the Burson QA bot)';
const ENG_ABOUT_ = 'One row for each Early Detection check while the open engine (Control row 51) is ON, and one row for each ' +
  'day; newest first, 7 days kept. Numbers since the check before. Blank: not counted yet.';
// [key, column name, 'n' (a number, summed) or 't' (a short text)]
const ENG_COLS_ = [
  ['at', 'When (ET)', 't'], ['row', 'Row', 't'], ['gap', 'Gap (min)', 'n'], ['read', 'Read by source', 't'],
  ['posts', 'Posts read', 'n'], ['kept', 'Posts kept', 'n'], ['fresh', 'Fresh / late', 't'], ['emb', 'Embedded', 'n'],
  ['carried', 'Carried', 'n'], ['lost', 'Lost (cache)', 'n'], ['prodS', 'Check s', 'n'], ['groupN', 'Grouped posts', 'n'],
  ['groupS', 'Group s', 'n'], ['stories', 'Stories', 'n'], ['signals', 'Signals', 'n'], ['queued', 'Queued', 'n'],
  ['qAsked', 'Quick asked', 'n'], ['qHeld', 'Quick held', 'n'], ['qRaised', 'Quick raised', 'n'], ['reviews', 'Reviews', 'n'],
  ['batch', 'Batch', 'n'], ['batchS', 'Batch s', 'n'], ['watch', 'Watch cards', 'n'], ['direct', 'Direct cards', 'n'],
  ['cardsWait', 'Cards waiting', 'n'], ['runs', 'Runs', 'n'], ['runS', 'Run s', 'n'], ['ledger', 'Run time (24 h)', 't'],
  ['step', 'Step', 't'], ['yields', 'Burson first', 'n'], ['pickup', 'Pick-up p50 / p90', 't'], ['guard', 'ApiGuard', 'n'],
  ['r429', '429s', 'n'], ['calls', 'Calls', 'n'], ['gb', 'BigQuery GB', 'n'], ['aiif', 'AI.IF rows', 'n'],
  ['grounded', 'Grounded', 'n'], ['evict', 'Evictions', 'n'], ['skipped', 'Checks skipped', 'n'], ['stop', 'Stop counts', 't'],
  // RQ8 of the requirements-first plan (steps S19a-S19g fill them)
  ['alone', 'Alone read', 'n'], ['codePass', 'Code pass', 'n'], ['gated', 'Gated', 'n'], ['asked', 'Asked', 'n'],
  ['qPass', 'Quick pass', 'n'], ['failed', 'Failed', 'n'], ['notReached', 'Not reached', 'n'], ['quickS', 'Quick s', 'n'],
  ['tokens', 'Tokens', 'n'], ['refused', 'Refused', 'n'], ['codeMs', 'Code check ms', 'n'],
  // the first screen (step S19h, RequirementsFirst.gs); 'm': the largest of the runs since the check before
  ['sPosts', 'screen posts', 'n'], ['sCalls', 'screen calls', 'n'], ['sPicked', 'screen picked', 'n'], ['sSentOn', 'screen sent on', 'n'],
  ['sBad', 'screen bad answers', 'n'], ['sS', 'screen s', 'm'], ['sTokens', 'screen tokens', 'n'], ['sPeak', 'screen peak tokens', 'm'],
  ['sThink', 'screen thinking', 'm'], ['sWhy', 'screen why off', 't'],
  ['growth', 'Growth notes', 'n'],  // step S16: a story's growth told in its card's thread
  ['note', 'Note', 't'],
];
const ENG_KIND_ = ENG_COLS_.reduce((o, c) => Object.assign(o, { [c[0]]: c[2] }), {});
const ENG_HEAD_ = ENG_COLS_.map(c => c[1]);
const ENG_HEAD_ROW_ = 3;
const ENG_KEEP_MS_ = 7 * 24 * 3600 * 1000;
const ENG_KEEP_ROWS_ = 2400;                  // at most (7 days of checks every 5 minutes is 2,016, with the daily rows)
const ENG_CELL_MAX_ = 100;
const ENG_NOTE_MAX_ = 200;                    // the Note column (a day's rows say a little more)
const ENG_ACC_PROP_ = 'ENGINE_ACC';
const ENG_ACC_MAX_ = 8800;
const ENG_PENDING_MAX_ = 12;                  // rows waiting for a run with time to write them
const ENG_MIN_LEFT_MS_ = 20 * 1000;

let ENG_RUN_ = null;  // this run: {n: {}, t: {}, check: null | {at, result}}

/** This run's numbers start (Main.gs poll(), with the run-time record). Never throws. */
function engRunStart_() {
  ENG_RUN_ = { n: {}, t: {}, check: null };
}

/** Adds `n` to the number column `key` of the next row. Row 51 OFF: nothing. Never throws. */
function engAdd_(key, n) {
  try {
    if (!ENG_RUN_ || typeof openOn_ !== 'function' || !openOn_()) return;
    const v = Number(n);
    if (!isFinite(v) || !v) return;
    ENG_RUN_.n[key] = Math.round(((Number(ENG_RUN_.n[key]) || 0) + v) * 1000) / 1000;
  } catch (e) { /* not counted */ }
}

/** Keeps the largest `n` of the run in the column `key` (a 'm' column: the largest of the runs since the check before). */
function engMax_(key, n) {
  try {
    if (!ENG_RUN_ || typeof openOn_ !== 'function' || !openOn_()) return;
    const v = Number(n);
    if (!isFinite(v) || !v) return;
    ENG_RUN_.n[key] = Math.max(Number(ENG_RUN_.n[key]) || 0, Math.round(v * 1000) / 1000);
  } catch (e) { /* not counted */ }
}

/** Sets the text column `key` of the next row. Row 51 OFF: nothing. Never throws. */
function engSet_(key, text) {
  try {
    if (!ENG_RUN_ || typeof openOn_ !== 'function' || !openOn_()) return;
    ENG_RUN_.t[key] = truncate_(String(text === undefined || text === null ? '' : text), ENG_CELL_MAX_);
  } catch (e) { /* not set */ }
}

/**
 * An Early Detection check ran in this run (`result`: what earlyWaveCheck_ returned): its stories, signals and queue,
 * and the producer's own numbers (EarlyWaveSource.gs st.last: read, kept, embedded, seconds, by source). Row 51 OFF:
 * nothing. Never throws.
 */
function engCheck_(result) {
  try {
    if (!ENG_RUN_ || !result || typeof openOn_ !== 'function' || !openOn_()) return;
    const r = result || {};
    ENG_RUN_.check = { at: Date.now() };
    engAdd_('queued', Number(r.queued) || 0);
    engAdd_('qHeld', Number(r.triaged) || 0);
    engAdd_('signals', (Number(r.queued) || 0) + (Number(r.repeats) || 0) + (Number(r.triaged) || 0) + (Number(r.failed) || 0));
    const last = typeof ewsState_ === 'function' ? (ewsState_(PropertiesService.getScriptProperties()).last || {}) : {};
    engAdd_('posts', Number(last.read) || 0);
    engAdd_('kept', Number(last.kept) || 0);
    engAdd_('emb', Number(last.embedded) || 0);
    if (isFinite(Number(last.ms))) engAdd_('prodS', Math.round(Number(last.ms) / 100) / 10);
    if (last.lanes && typeof last.lanes === 'object') {
      engSet_('read', Object.keys(last.lanes).filter(k => Number(last.lanes[k]) > 0).map(k => `${k} ${last.lanes[k]}`).join(' · '));
    }
    if (isFinite(Number(r.stories))) engAdd_('stories', Number(r.stories));
  } catch (e) { /* the row says less */ }
}

/** ENGINE_ACC: {cur: {n, t}, last (the last check's time), pending: [rows], plost, day: {d, n, checks}}. Never throws. */
function engAcc_(props) {
  let a = null;
  try { a = JSON.parse(props.getProperty(ENG_ACC_PROP_) || 'null'); } catch (e) { a = null; }
  if (!a || typeof a !== 'object' || Array.isArray(a)) a = {};
  const obj = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  a.cur = { n: obj(a.cur && a.cur.n), t: obj(a.cur && a.cur.t) };
  a.pending = Array.isArray(a.pending) ? a.pending.filter(Array.isArray) : [];
  a.day = a.day && typeof a.day.d === 'string' ? { d: a.day.d, n: obj(a.day.n), checks: Number(a.day.checks) || 0 } : null;
  a.last = Number(a.last) || 0;
  a.plost = Number(a.plost) || 0;
  return a;
}

/** The values of a row in the tab's column order. Pure. */
function engRowOf_(n, t) {
  return ENG_COLS_.map(([k, , kind]) => {
    if (kind === 'n' || kind === 'm') return Object.prototype.hasOwnProperty.call(n, k) ? Math.round(Number(n[k]) * 10) / 10 : '';
    return truncate_(String(t[k] === undefined ? '' : t[k]), k === 'note' ? ENG_NOTE_MAX_ : ENG_CELL_MAX_);
  });
}

/** "2 h 05 of 4 h 30" and the step, from the record of run time (OpenEngine.gs). Never throws. */
function engLedgerTexts_(now) {
  try {
    const u = openUsage_(now);
    const d = openDay_(now);
    return {
      ledger: `${openHours_(u.runSec)} of ${openHours_(u.budgetSec)}`,
      step: String(u.step) + (u.fetchStep ? ` · calls ${u.fetchStep}` : ''),
      pickup: u.pickup.n ? `${u.pickup.p50} / ${u.pickup.p90} s` : '',
      stop: [['rev', 'reviews'], ['ql', 'quick'], ['wc', 'Watch checks'], ['gb', 'GB']].map(([k, w]) => `${w} ${Math.round(Number(d[k]) || 0)}`).join(' · '),
    };
  } catch (e) {
    return {};
  }
}

/**
 * The end of a run under row 51 (Main.gs, its last block): the run's numbers join those since the last check; when a
 * check ran, its row is made (and, on the first check of an Eastern day, the day before's row), and the rows are written
 * on the tab when the run has ENG_MIN_LEFT_MS_ left and no flow is catching up on alerts (else they wait in ENGINE_ACC,
 * at most ENG_PENDING_MAX_). One property read and one write. opts: {deadline, flows}. {written, waiting, blocked}.
 * Never throws.
 */
function maybeWriteEngineTab_(ss, ctx, opts) {
  const out = { written: 0, waiting: 0, blocked: false };
  try {
    if (!ENG_RUN_ || typeof openOn_ !== 'function' || !openOn_()) return out;
    const o = opts || {};
    const now = Date.now();
    const props = PropertiesService.getScriptProperties();
    const a = engAcc_(props);
    // the run's own numbers
    engAdd_('runs', 1);
    if (OE_RUN_) {
      engAdd_('runS', Math.round((now - OE_RUN_.start) / 100) / 10);
      engAdd_('calls', OE_RUN_.fetches || 0);
      engAdd_('yields', OE_RUN_.walls.burson ? 1 : 0);
      engAdd_('guard', OE_RUN_.walls.guard ? 1 : 0);
      engAdd_('r429', OE_RUN_.walls.gemini ? 1 : 0);
    }
    const join = (into, k, v) => {
      into[k] = ENG_KIND_[k] === 'm' ? Math.max(Number(into[k]) || 0, Number(v) || 0) : Math.round(((Number(into[k]) || 0) + Number(v)) * 1000) / 1000;
    };
    Object.keys(ENG_RUN_.n).forEach(k => join(a.cur.n, k, ENG_RUN_.n[k]));
    Object.assign(a.cur.t, ENG_RUN_.t);
    if (ENG_RUN_.check) {
      const at = ENG_RUN_.check.at;
      const day = openEtDay_(at);
      // the first check of an Eastern day: the day before's row first
      if (a.day && a.day.d !== day) {
        a.pending.push(engRowOf_(a.day.n, { at: a.day.d, row: `day ${a.day.d}`, note: engDayNote_(a.day) }));
        // the first screen's rows for that day (step S19h): one cell each
        const screen = typeof rqScreenDayRows_ === 'function' ? rqScreenDayRows_(a.day.d) : [];
        screen.forEach(text => a.pending.push(engRowOf_({}, { at: a.day.d, row: 'first screen', note: text })));
        a.day = null;
      }
      if (!a.day) a.day = { d: day, n: {}, checks: 0 };
      const texts = Object.assign({}, a.cur.t, engLedgerTexts_(now));
      const n = Object.assign({}, a.cur.n);
      if (a.last && at > a.last) n.gap = Math.round((at - a.last) / 6000) / 10;
      let label = '';
      try { label = Utilities.formatDate(new Date(at), 'America/New_York', 'MMM d, h:mm a'); } catch (e) { label = new Date(at).toISOString(); }
      a.pending.push(engRowOf_(n, Object.assign(texts, { at: label, row: 'check' })));
      Object.keys(n).forEach(k => { if (k !== 'gap') join(a.day.n, k, n[k]); });
      a.day.checks++;
      a.last = at;
      a.cur = { n: {}, t: {} };
    }
    if (a.pending.length > ENG_PENDING_MAX_) {
      a.plost += a.pending.length - ENG_PENDING_MAX_;
      a.pending = a.pending.slice(-ENG_PENDING_MAX_);
    }
    const deadline = Number(o.deadline) || Number(ctx && ctx.deadline) || 0;
    const busy = typeof headStartRunBusy_ === 'function' && headStartRunBusy_(ctx, o.flows);
    if (a.pending.length && ss && !busy && !(deadline && deadline - now < ENG_MIN_LEFT_MS_)) {
      const done = writeEngineTab_(ss, a.pending, a.plost, now);
      out.blocked = !!done.blocked;
      if (done.written) {
        out.written = done.written;
        a.pending = [];
        a.plost = 0;
      }
    }
    out.waiting = a.pending.length;
    engSave_(props, a);
    return out;
  } catch (e) {
    console.error('Engine tab: ' + ((e && e.message) || e));
    return out;
  } finally {
    ENG_RUN_ = null;
  }
}

/** The daily row's note: the day's checks and what they came to, in a line. Pure. */
function engDayNote_(day) {
  const n = (day && day.n) || {};
  const v = k => Math.round(Number(n[k]) || 0).toLocaleString('en-US');
  return truncate_(`checks ${Number(day && day.checks) || 0} · posts read ${v('posts')} · stories ${v('stories')} · ` +
    `signals ${v('signals')} · reviews ${v('reviews')} · Watch cards ${v('watch')} · Direct cards ${v('direct')} · calls ${v('calls')}`, ENG_CELL_MAX_ * 2);
}

/** Saves ENGINE_ACC within ENG_ACC_MAX_ (the oldest waiting rows go first, counted). Never throws. */
function engSave_(props, a) {
  try {
    let json = JSON.stringify(a);
    while (json.length > ENG_ACC_MAX_ && a.pending.length) { a.pending.shift(); a.plost++; json = JSON.stringify(a); }
    if (json.length > ENG_ACC_MAX_) { a.cur = { n: {}, t: {} }; json = JSON.stringify(a); }
    if (json.length <= ENG_ACC_MAX_) props.setProperty(ENG_ACC_PROP_, json);
  } catch (e) {
    console.error('Engine tab: its numbers could not be kept: ' + ((e && e.message) || e));
  }
}

/** Is `sh` the bot's own Engine tab (its title in A1, its column names in row 3)? Never throws. */
function isEngineTab_(sh) {
  try {
    if (!sh || String(sh.getRange(1, 1).getValue()) !== ENG_TITLE_) return false;
    const head = sh.getRange(ENG_HEAD_ROW_, 1, 1, ENG_HEAD_.length).getValues()[0].map(String);
    return head.join('\u0001') === ENG_HEAD_.join('\u0001');
  } catch (e) {
    return false;
  }
}

/**
 * Writes `rows` (oldest first) on the tab, newest first under row 3, with one row more when `lost` rows could not be
 * kept; makes the tab when it isn't there; deletes rows older than 7 days (and past ENG_KEEP_ROWS_). {written, blocked}:
 * blocked when a tab named "Engine" that the bot didn't make is in the way (nothing of it is written). Never throws.
 */
function writeEngineTab_(ss, rows, lost, now) {
  try {
    let sh = ss.getSheetByName(ENG_NAME_);
    if (sh && !isEngineTab_(sh)) {
      engBlocked_(true);
      return { written: 0, blocked: true };
    }
    engBlocked_(false);
    if (!sh) {
      sh = ss.insertSheet(ENG_NAME_, ss.getSheets().length);
      sh.getRange(1, 1).setValue(ENG_TITLE_);
      sh.getRange(2, 1).setValue(ENG_ABOUT_);
      sh.getRange(ENG_HEAD_ROW_, 1, 1, ENG_HEAD_.length).setValues([ENG_HEAD_]);
      sh.setFrozenRows(ENG_HEAD_ROW_);
    }
    const out = rows.slice().reverse();  // newest first
    if (lost > 0) {
      const r = engRowOf_({}, { at: '', row: 'not recorded', note: `${lost} row${lost === 1 ? '' : 's'} could not be kept (the runs were full)` });
      out.push(r);
    }
    const cells = out.map(r => r.map(v => (typeof v === 'number' || v === '' ? v : `'${speedText_(String(v))}`)));
    sh.insertRowsBefore(ENG_HEAD_ROW_ + 1, cells.length);
    sh.getRange(ENG_HEAD_ROW_ + 1, 1, cells.length, ENG_HEAD_.length).setValues(cells);
    engTrim_(sh, now);
    return { written: cells.length, blocked: false };
  } catch (e) {
    console.error(`Engine tab not written (its rows wait for the next run): ${(e && e.message) || e}`);
    return { written: 0, blocked: false };
  }
}

/** Deletes the rows at the bottom past ENG_KEEP_ROWS_, and those of checks older than 7 days (by the day rows). Never throws. */
function engTrim_(sh, now) {
  try {
    const last = sh.getLastRow();
    const first = ENG_HEAD_ROW_ + 1;
    if (last < first) return;
    let keep = Math.min(last - ENG_HEAD_ROW_, ENG_KEEP_ROWS_);
    // the day rows say which day each block of rows is: rows under a day row more than 7 days old go
    const rows = sh.getRange(first, 2, last - ENG_HEAD_ROW_, 1).getValues().map(r => String(r[0]).replace(/^'/, ''));
    const oldest = openEtDay_(now - ENG_KEEP_MS_);
    const cut = rows.findIndex(v => /^day \d{4}-\d\d-\d\d$/.test(v) && v.slice(4) < oldest);
    if (cut >= 0) keep = Math.min(keep, cut);
    if (keep >= 1 && first + keep <= last) sh.deleteRows(first + keep, last - (first + keep) + 1);
  } catch (e) { /* trimmed at the next write */ }
}

/** A tab named "Engine" the bot did not make is in the way (kept for C51). Never throws. */
function engBlocked_(blocked) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (blocked) props.setProperty('ENGINE_TAB_BLOCKED', 'true');
    else if (props.getProperty('ENGINE_TAB_BLOCKED') !== null) props.deleteProperty('ENGINE_TAB_BLOCKED');
  } catch (e) { /* said at the next write */ }
}

/** C51's part (OpenEngine.gs openC51Text_): a tab in the way, and the Early Detection tab's rows waiting. Never throws. */
function engC51Part_() {
  try {
    const parts = [];
    if (PropertiesService.getScriptProperties().getProperty('ENGINE_TAB_BLOCKED') === 'true') {
      parts.push('a tab named "Engine" that the bot did not make is in the way');
    }
    const waiting = typeof edTabWaitingCount_ === 'function' ? edTabWaitingCount_() : 0;
    if (waiting > EDT_WAIT_ROWS_) parts.push(`${waiting.toLocaleString('en-US')} story rows wait for the tab`);
    return parts.join(' · ');
  } catch (e) {
    return '';
  }
}
