/**
 * EarlyDetectionTab.gs — the "Early Detection" tab of the bot's sheet: every story signal Early Detection (Control row
 * 19) found, and what became of it, one row each, newest first (the setting early_detection_tab; false: no tab is made,
 * read or written, and nothing waits).
 *
 * The rows are the run's record (EarlyDetectionNotes.gs edNote_: every ending of a signal, worded there and ready to
 * show; edNotesOfRun_ hands them out). This file only lays them out. Nothing is posted, emailed or sent to BigQuery, and
 * there is no Control row or switch for it (Status, B5, says when a tab of that name is in the way).
 *
 * The tab, top to bottom:
 *   row 1   its title (EDT_TITLE_): the bot's mark. The tab is the bot's own only when A1 is exactly that title and row 4
 *           is exactly its column names (isEdTab_), checked before every read and write
 *   row 2   what's listed (EDT_ABOUT_)
 *   row 3   today's numbers (BigQuery.gs edDayNumbers_, the ones Control C19 shows), as of the last write
 *   row 4   the column names (EDT_HEADER_), frozen
 *   row 5+  one row per ending, newest first: new rows go in under row 4 in one write and are never changed after; past
 *           EDT_KEEP_ data rows the bottom rows are deleted (the header and at least one data row always stay)
 * Every text cell goes through the capped-text helper (Speed.gs speedText_: at most 49,000 characters) with a leading
 * apostrophe (edTabText_), so Sheets keeps it as the text it is: never read as a formula, a number or a date. The only
 * formulas are the quoted links (Speed.gs resultsLink_ through HeadStart.gs headStartLink_): the Story to the main post,
 * the Card to the card's message. A written row's cells don't count on a format they inherit from a neighbour row: its
 * texts are text, and its formats are set with it.
 *
 * When: poll() calls maybeWriteEdTab_ in its last block, beside the Head start tab, with the run's own deadline. It
 * writes only with EDT_MIN_LEFT_MS_ (30 seconds) of the run left and never in a run that is still catching up on alerts
 * (HeadStart.gs headStartRunBusy_). Rows a run could not write (no time, the write failed, a tab of that name the bot
 * didn't make is in the way) wait in ONE script-cache value (EDT_WAIT_KEY_, 6 hours) for the next run that can: at most
 * EDT_WAIT_ROWS_ rows and EDT_WAIT_CHARS_ characters (and as many bytes), the newest kept; the ones that had to go are
 * counted, and the next write adds one row "N outcomes were not recorded (the runs were full)". A run without a row to
 * write makes no Sheets call at all, except while Status says a tab is in the way (EDT_BLOCKED_PROP_): then a run with
 * time looks at the tab of that name once (edTabRecheck_), so the sentence goes as soon as that tab is renamed; and until
 * the bot has made its tab (EDT_MADE_PROP_): poll() makes it at the start of the first run with Early Detection (row 19)
 * ON and the setting on, before any flow writes Control C19, with its header rows and "Today: nothing yet."
 * (maybeMakeEdTab_), so C19, which points at the tab only once it is made (edTabPointed_), never points at a tab that
 * isn't there. The tab goes after the last of the report tabs, so no tab moves. Never throws.
 *
 * Row 3 is as of the last write (its date and time say when); a run with time and no row writes that one cell again
 * when the numbers changed since (edTabTodayRefresh_), so it says what Control C19 says. Each row is handed to the
 * script cache as it is noted (edTabHandOver_), so a run that ends before its last block leaves its rows to the next run
 * (edTabTakeOver_). Rows that wait live only in the cache: if the cache drops them, they are gone without a "not
 * recorded" row.
 */

const EDT_NAME_ = 'Early Detection';
// The bot's mark, in A1 (isEdTab_). A tab people made never has it
const EDT_TITLE_ = 'Early Detection: every story it found and what happened to each (written by the Burson QA bot)';
const EDT_ABOUT_ = 'What\'s listed: each story Early Detection (Control row 19) found in posts from small accounts: several ' +
  'accounts saying the same thing, or a jump in how many accounts post on one topic. Newest first, the last 2,000. Outcome ' +
  'says what the bot did and Why gives the reason. Only rows that start "Card posted", "Update added" or "Added under" are ' +
  'in the space; the others were not posted, and Why says why ("Never reviewed": the bot did not get to review it).';
const EDT_HEADER_ = ['When (ET)', 'Outcome', 'Story', 'Why', 'Card', 'Kind', 'Accounts', 'Platforms',
  'Exposure Tag (first guess)', 'Id'];
const EDT_HEAD_ROW_ = 4;                     // the column names; data from the row under it
const EDT_KEEP_ = 2000;                      // data rows kept (the oldest at the bottom go)
const EDT_MIN_LEFT_MS_ = 30 * 1000;          // a write needs this much of the run left
const EDT_WAIT_KEY_ = 'ed_tab_waiting';      // the script-cache value of the rows waiting for a write
const EDT_WAIT_SECONDS_ = 6 * 60 * 60;
const EDT_WAIT_ROWS_ = 200;
const EDT_WAIT_CHARS_ = 90000;               // characters, and UTF-8 bytes: the cache may count either
// 'true' while a tab named "Early Detection" that the bot didn't make is in the way (Status, B5, says so)
const EDT_BLOCKED_PROP_ = 'ED_TAB_BLOCKED';
// 'true' once the bot has made its tab (or found its own): Control C19 points at the tab only then (edTabPointed_)
const EDT_MADE_PROP_ = 'ED_TAB_MADE';
// The day and numbers row 3 shows, as last written (edTabTodayKey_): row 3 is written again only when they change
const EDT_TODAY_PROP_ = 'ED_TAB_TODAY';
// This run's rows, handed over as each is noted (edTabHandOver_): a run that ends before its last block leaves them here,
// and the next run puts them with the rows that wait (edTabTakeOver_)
const EDT_RUN_KEY_ = 'ed_tab_run';
// Control row 51 (the open engine, OpenEngine.gs): the rows that wait go in up to EDT_WAIT_CHUNKS_ cache values (the
// first is EDT_WAIT_KEY_ as ever, the others EDT_WAIT_KEY_ + ':1' ...), with the row counts of the others in one script
// property (EDT_WAIT_MAN_PROP_), so a value the cache dropped is counted as rows not recorded. Row 51 OFF: one value
const EDT_WAIT_CHUNKS_ = 10;
const EDT_WAIT_MAN_PROP_ = 'ED_TAB_WAIT_MAN';
const EDT_WIDTHS_ = [[1, 130], [2, 230], [3, 320], [4, 360], [5, 110], [6, 170], [7, 80], [8, 120], [9, 280], [10, 300]];

/** The setting early_detection_tab: on unless it is false. */
function edTabOn_() {
  return !(typeof GEN === 'object' && GEN && GEN.settings && GEN.settings.early_detection_tab === false);
}

/**
 * From poll(), in its last block (beside maybeRefreshHeadStart_): this run's record rows and the ones waiting, written
 * on the tab when the run has time, else left waiting (EDT_WAIT_KEY_). opts: {deadline (ms: when the run must be done),
 * flows (what each flow of this run left: headStartRunBusy_)}. Returns {written (rows put on the tab), waiting (rows
 * left waiting), blocked (a tab the bot didn't make is in the way)}. With the setting off nothing is read or written,
 * and nothing waits. Never throws.
 */
function maybeWriteEdTab_(ss, ctx, opts) {
  const out = { written: 0, waiting: 0, blocked: false };
  try {
    const o = opts || {};
    if (!edTabOn_()) {
      edTabOff_();
      return out;
    }
    const now = ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now();
    const kept = edTabWaiting_();
    const all = edTabMerge_(kept.rows, edNotesOfRun_());
    const deadline = Number(o.deadline) || Number(ctx && ctx.deadline) || 0;
    const noTime = () => !ss || headStartRunBusy_(ctx, o.flows) || (deadline && deadline - now < EDT_MIN_LEFT_MS_);
    if (!all.length && !kept.lost) {
      // nothing to write: no Sheets call, unless Status says a tab is in the way and this run has time to look again,
      // or today's numbers changed since row 3 was written (then that one cell, on the bot's own tab)
      if (edTabBlocked_() && !noTime()) edTabRecheck_(ss);
      else if (!noTime()) edTabTodayRefresh_(ss, now);
      return out;
    }
    if (!noTime()) {
      try {
        const done = writeEdTab_(ss, all, kept, now);
        if (done.written) {
          edTabWait_([], 0, 0);
          edTabRunDone_();
          out.written = done.written;
          return out;
        }
        out.blocked = !!done.blocked;
      } catch (e) {
        console.error(`Early Detection tab not written (its rows wait for the next run): ${(e && e.message) || e}`);
      }
    }
    out.waiting = edTabWait_(all, kept.lost, kept.lostAt);
    edTabRunDone_();
    return out;
  } catch (e) {
    console.error('Early Detection tab: ' + ((e && e.message) || e));
    return out;
  }
}

/**
 * Writes `rows` (record rows, any order) on the tab, newest first under row 4, with one row more when `lost.lost`
 * outcomes could not be kept; then today's numbers in row 3, the new rows' formats, and the trim. Makes the tab when it
 * isn't there. {blocked: true, written: 0} when a tab named "Early Detection" that the bot didn't make is in the way
 * (nothing of it is read but its first four rows, nothing written). Throws when the write itself fails: the new rows
 * are taken out again, so the tab is as it was.
 */
function writeEdTab_(ss, rows, lost, now) {
  const found = ss.getSheetByName(EDT_NAME_);
  const owner = found ? edTabOwner_(found) : 'bot';
  // Sheets didn't answer: not known to be in the way, so Status isn't told; the rows wait (the caller catches this)
  if (owner === 'unknown') throw new Error(`the "${EDT_NAME_}" tab could not be checked`);
  const blocked = owner === 'other';
  noteEdTabBlocked_(blocked);
  if (blocked) {
    console.warn(`Early Detection tab not written: a "${EDT_NAME_}" tab the bot didn't make is there (left as it is)`);
    return { blocked: true, written: 0 };
  }
  const sh = found || ensureEdTab_(ss);
  if (!sh) throw new Error(`a "${EDT_NAME_}" tab the bot didn't make is in the way: left as it is`);
  const cells = edTabSorted_(rows).map(edTabRow_);
  const l = lost || {};
  if (Number(l.lost) > 0) cells.push(edTabLostRow_(l.lost, l.lostAt || now));
  const first = EDT_HEAD_ROW_ + 1;
  const n = cells.length;
  sh.insertRowsBefore(first, n);
  try {
    sh.getRange(first, 1, n, EDT_HEADER_.length).setValues(cells);
  } catch (e) {
    try { sh.deleteRows(first, n); } catch (err) { /* the blank rows stay; nothing was written in them */ }
    throw e;
  }
  const fmt = f => { try { f(); } catch (e) { /* formatting only */ } };
  fmt(() => {
    sh.getRange(3, 1).setValue(speedText_(edTabTodayText_(now)));
    edTabTodayNoted_(edTabTodayKey_(now));
  });
  // the new rows' own formats: in Sheets a new row takes its neighbour's (the bold header's), so they are set here
  fmt(() => sh.getRange(first, 1, n, EDT_HEADER_.length).setFontWeight('normal').setFontStyle('normal').setBackground(null)
    .setFontColor(null).setWrap(false).setVerticalAlignment('top'));
  fmt(() => sh.getRange(first, 7, n, 1).setNumberFormat('0'));
  try {
    const data = sh.getLastRow() - EDT_HEAD_ROW_;
    if (data > EDT_KEEP_) sh.deleteRows(EDT_HEAD_ROW_ + EDT_KEEP_ + 1, data - EDT_KEEP_);
  } catch (e) {
    console.error('Early Detection tab: its oldest rows could not be deleted: ' + ((e && e.message) || e));
  }
  noteEdTabMade_();
  return { blocked: false, written: n };
}

/** Record rows, newest first (the same time: in the order they were noted, the later first). Pure. */
function edTabSorted_(rows) {
  return (rows || []).map((r, i) => [r, i]).sort((a, b) => (Number(b[0][0]) || 0) - (Number(a[0][0]) || 0) || b[1] - a[1])
    .map(x => x[0]);
}

/** One record row (EarlyDetectionNotes.gs ED_NOTE_FIELDS_) as the tab's cells (EDT_HEADER_). Pure but for the time zone. */
function edTabRow_(row) {
  const r = edNoteObj_(row);
  const text = edTabText_;
  const at = Number(r.at) || 0;
  const story = String(r.story || '');
  const link = String(r.link || '');
  const cardUrl = originalAlertLink_(r.message);
  const card = String(r.card || '');
  return [
    at > 0 ? `'${speedTime_(at)}` : '',
    text(r.outcome),
    /^https?:\/\/\S+$/i.test(link) ? headStartLink_(link, story) : text(story),
    text(r.why),
    card && cardUrl ? headStartLink_(cardUrl, card) : text(card),
    text(r.kind),
    Math.max(0, Math.round(Number(r.accounts) || 0)),
    text(r.platforms),
    text(r.tag),
    text(r.id),
  ];
}

/** The row that says how many outcomes had to go while they waited (EDT_WAIT_ROWS_ / EDT_WAIT_CHARS_). Pure. */
function edTabLostRow_(n, at) {
  const k = Math.max(1, Math.round(Number(n) || 0));
  const row = new Array(EDT_HEADER_.length).fill('');
  row[0] = Number(at) > 0 ? `'${speedTime_(Number(at))}` : '';
  row[1] = edTabText_(`${k} outcome${k === 1 ? ' was' : 's were'} not recorded (the runs were full)`);
  return row;
}

/**
 * A text cell: the capped-text helper (speedText_: 49,000 characters at most, the apostrophe included) with a leading
 * apostrophe, so Sheets keeps the text as it is (never a formula, a number or a date; the apostrophe isn't shown).
 * '' stays ''. Pure.
 */
function edTabText_(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return s ? speedText_("'" + s) : '';
}

/**
 * Row 3: "Today (2026-11-15): 12 found · 3 cards · 0 under another alert · 6 let go · 1 never reviewed · 2 waiting.
 * Updated 10:15 AM ET." The numbers are the day's (BigQuery.gs edDayNumbers_), the ones Control C19 shows.
 */
function edTabTodayText_(now) {
  const tz = (typeof GEN !== 'undefined' && GEN && GEN.timezone) || 'America/New_York';
  const n = edDayNumbers_(PropertiesService.getScriptProperties());
  const d = new Date(Number(now) || Date.now());
  return `Today (${Utilities.formatDate(d, tz, 'yyyy-MM-dd')}): ${n.found} found · ${n.cards} card${n.cards === 1 ? '' : 's'} · ` +
    `${n.under} under another alert · ${n.letgo} let go · ${n.never} never reviewed · ${n.waiting} waiting. ` +
    `Updated ${Utilities.formatDate(d, tz, 'h:mm a')} ET.`;
}

/**
 * Is this the Early Detection tab the bot made? A1 is exactly its title and row 4 exactly its column names. An empty tab,
 * one people made, or the bot's own with its title or a column name changed is not: such a tab is never read further,
 * cleared, written or protected. False when Sheets doesn't answer.
 */
function isEdTab_(sh) {
  return edTabOwner_(sh) === 'bot';
}

/**
 * Whose is this tab: 'bot' (A1 is exactly EDT_TITLE_ and row 4 exactly EDT_HEADER_), 'other' (anything else), or
 * 'unknown' (Sheets threw while it was checked: not taken for a tab in the way). Reads only what it must: its row count,
 * then A1, then (only when A1 is the bot's title) row 4. Never rows 2 and 3, never past row 4. Never throws.
 */
function edTabOwner_(sh) {
  try {
    if (!sh || sh.getLastRow() < EDT_HEAD_ROW_) return 'other';
    if (String(sh.getRange(1, 1).getDisplayValue()).trim() !== EDT_TITLE_) return 'other';
    const head = (sh.getRange(EDT_HEAD_ROW_, 1, 1, EDT_HEADER_.length).getDisplayValues()[0] || []).map(v => String(v).trim());
    return EDT_HEADER_.every((name, i) => head[i] === name) ? 'bot' : 'other';
  } catch (e) {
    return 'unknown';
  }
}

/**
 * The tab, made: after the last of the report tabs (Results, Learned precedents, Follow-up, Analysis, Head start), so none
 * of them moves; at the end when there's none. Its first four rows in one write (the bot's mark in A1, what's listed,
 * today's line until the first write fills it, the column names), row 4 frozen, protected with a warning. null when a
 * tab of that name is there and isn't the bot's.
 */
function ensureEdTab_(ss) {
  let sh = ss.getSheetByName(EDT_NAME_);
  if (sh) return isEdTab_(sh) ? sh : null;
  const names = ss.getSheets().map(s => s.getName());
  const reports = [RESULTS_TAB_, LEARNED_TAB_, FOLLOWUP_TAB_, ANALYSIS_TAB_, HEAD_START_TAB_].map(x => names.indexOf(x)).filter(i => i >= 0);
  sh = ss.insertSheet(EDT_NAME_, reports.length ? Math.max.apply(null, reports) + 1 : names.length);
  const top = [[EDT_TITLE_], [EDT_ABOUT_], ['Today: nothing yet.'], EDT_HEADER_]
    .map(r => r.concat(new Array(EDT_HEADER_.length - r.length).fill('')));
  sh.getRange(1, 1, EDT_HEAD_ROW_, EDT_HEADER_.length).setValues(top);
  const fmt = f => { try { f(); } catch (e) { /* the tab works unformatted */ } };
  fmt(() => sh.setFrozenRows(EDT_HEAD_ROW_));
  fmt(() => sh.getRange(1, 1).setFontWeight('bold').setFontSize(13));
  fmt(() => {
    sh.getRange(2, 1, 1, EDT_HEADER_.length).merge().setWrap(true).setVerticalAlignment('top').setFontColor('#5f6368').setFontStyle('italic');
    sh.setRowHeight(2, resultsRowHeight_(EDT_ABOUT_));
  });
  fmt(() => sh.getRange(EDT_HEAD_ROW_, 1, 1, EDT_HEADER_.length).setFontWeight('bold').setBackground('#f1f3f4').setWrap(true));
  fmt(() => EDT_WIDTHS_.forEach(([c, px]) => sh.setColumnWidth(c, px)));
  try { sh.protect().setDescription('Written by the Burson QA bot').setWarningOnly(true); } catch (e) { /* the tab works unprotected */ }
  return sh;
}

/**
 * The rows waiting for a write ({rows, lost, lostAt}: record rows; how many had to go since the last write, and when
 * the newest of those was noted). Empty when there is none, the value is broken or the cache can't be read. Never throws.
 */
function edTabWaiting_() {
  const none = { rows: [], lost: 0, lostAt: 0 };
  try {
    const cache = CacheService.getScriptCache();
    const ok = r => Array.isArray(r) && r.length === ED_NOTE_FIELDS_.length && typeof r[2] === 'string';
    const raw = cache.get(EDT_WAIT_KEY_);
    let v = null;
    try { v = raw ? JSON.parse(raw) : null; } catch (e) { v = null; }
    const out = v ? { rows: (Array.isArray(v.r) ? v.r : []).filter(ok), lost: Math.max(0, Math.round(Number(v.n) || 0)), lostAt: Number(v.la) || 0 }
      : { rows: [], lost: 0, lostAt: 0 };
    // row 51's other values (edTabWait_): each one the cache dropped is counted as its rows, not recorded
    const man = edTabWaitMan_();
    man.c.forEach((n, i) => {
      let more = null;
      try { more = JSON.parse(cache.get(`${EDT_WAIT_KEY_}:${i + 1}`) || 'null'); } catch (e) { more = null; }
      if (Array.isArray(more)) out.rows = out.rows.concat(more.filter(ok));
      else { out.lost += n; out.lostAt = Math.max(out.lostAt, man.at); }
    });
    if (!raw && !man.c.length) return none;
    return out;
  } catch (e) {
    return none;
  }
}

/** Row 51's record of the other waiting values: {c: [rows in value 1, ...], at}. Never throws. */
function edTabWaitMan_() {
  try {
    const m = JSON.parse(PropertiesService.getScriptProperties().getProperty(EDT_WAIT_MAN_PROP_) || 'null');
    return { c: Array.isArray(m && m.c) ? m.c.map(n => Math.max(0, Math.round(Number(n) || 0))).slice(0, EDT_WAIT_CHUNKS_ - 1) : [],
      at: Number(m && m.at) || 0 };
  } catch (e) {
    return { c: [], at: 0 };
  }
}

/** The rows waiting for the tab, for C51 (row 51). Never throws. */
function edTabWaitingCount_() {
  try {
    return edTabWaiting_().rows.length;
  } catch (e) {
    return 0;
  }
}

/** The rows waiting and this run's, without a row twice (a run that handed its rows over already). Pure. */
function edTabMerge_(waiting, run) {
  const seen = new Set();
  return (waiting || []).concat(run || []).filter(r => {
    const k = JSON.stringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Leaves `rows` waiting for the next write (one cache value, EDT_WAIT_SECONDS_): the newest EDT_WAIT_ROWS_, then as
 * many as fit EDT_WAIT_CHARS_ characters and bytes; those that go are added to `lost` (with lostAt, the time of the
 * newest of them). No row and nothing lost: the value is removed. Returns the number of rows left waiting. Never throws.
 */
function edTabWait_(rows, lost, lostAt) {
  try {
    const cache = CacheService.getScriptCache();
    let keep = edTabSorted_(rows).reverse();  // oldest first
    let n = Math.max(0, Math.round(Number(lost) || 0));
    let la = Number(lostAt) || 0;
    const drop = k => {
      keep.slice(0, k).forEach(r => { la = Math.max(la, Number(r[0]) || 0); });
      keep = keep.slice(k);
      n += k;
    };
    // row 51: the oldest go to values of their own (at most EDT_WAIT_CHUNKS_ - 1 more), the newest stay in the first
    const chunks = [];
    const open = typeof openOn_ === 'function' && openOn_();
    if (open) {
      if (keep.length > EDT_WAIT_ROWS_ * EDT_WAIT_CHUNKS_) drop(keep.length - EDT_WAIT_ROWS_ * EDT_WAIT_CHUNKS_);
      while (keep.length > EDT_WAIT_ROWS_ && chunks.length < EDT_WAIT_CHUNKS_ - 1) {
        let part = keep.slice(0, Math.min(EDT_WAIT_ROWS_, keep.length - EDT_WAIT_ROWS_));
        while (part.length > 1 && (JSON.stringify(part).length > EDT_WAIT_CHARS_ || edTabBytes_(JSON.stringify(part)) > EDT_WAIT_CHARS_)) {
          part = part.slice(0, part.length - 1);
        }
        chunks.push(part);
        keep = keep.slice(part.length);
      }
    }
    if (open || chunks.length || edTabWaitMan_().c.length) edTabWaitChunks_(cache, chunks);
    if (keep.length > EDT_WAIT_ROWS_) drop(keep.length - EDT_WAIT_ROWS_);
    const value = () => JSON.stringify(n ? { r: keep, n, la } : { r: keep });
    while (keep.length && (value().length > EDT_WAIT_CHARS_ || edTabBytes_(value()) > EDT_WAIT_CHARS_)) drop(1);
    if (!keep.length && !n) {
      cache.remove(EDT_WAIT_KEY_);
      return 0;
    }
    cache.put(EDT_WAIT_KEY_, value(), EDT_WAIT_SECONDS_);
    return keep.length;
  } catch (e) {
    console.error('Early Detection tab: the rows could not be kept for the next run: ' + ((e && e.message) || e));
    return 0;
  }
}

/**
 * Row 51: puts `chunks` (lists of rows) in the cache values EDT_WAIT_KEY_ + ':1' ... and their row counts in
 * EDT_WAIT_MAN_PROP_; values no longer needed are removed, and with none the property goes. Never throws.
 */
function edTabWaitChunks_(cache, chunks) {
  try {
    const props = PropertiesService.getScriptProperties();
    const was = edTabWaitMan_();
    chunks.forEach((part, i) => cache.put(`${EDT_WAIT_KEY_}:${i + 1}`, JSON.stringify(part), EDT_WAIT_SECONDS_));
    for (let i = chunks.length; i < was.c.length; i++) cache.remove(`${EDT_WAIT_KEY_}:${i + 1}`);
    if (chunks.length) props.setProperty(EDT_WAIT_MAN_PROP_, JSON.stringify({ c: chunks.map(p => p.length), at: Date.now() }));
    else if (was.c.length) props.deleteProperty(EDT_WAIT_MAN_PROP_);
  } catch (e) {
    console.error('Early Detection tab: the rows could not be kept in parts: ' + ((e && e.message) || e));
  }
}

/** A text's length in UTF-8 bytes (a half character counts 3, as Apps Script writes it). Pure. */
function edTabBytes_(s) {
  let b = 0;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x80) b += 1;
    else if (c < 0x800) b += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < t.length && t.charCodeAt(i + 1) >= 0xdc00 && t.charCodeAt(i + 1) <= 0xdfff) { b += 4; i++; }
    else b += 3;
  }
  return b;
}

/** The setting is off: nothing waits, and Status no longer speaks of the tab. Never throws. */
function edTabOff_() {
  try { CacheService.getScriptCache().remove(EDT_WAIT_KEY_); } catch (e) { /* nothing to keep */ }
  try { CacheService.getScriptCache().remove(EDT_RUN_KEY_); } catch (e) { /* nothing to keep */ }
  noteEdTabBlocked_(false);
}

/** Does Status say a tab named "Early Detection" that the bot didn't make is in the way (EDT_BLOCKED_PROP_)? Never throws. */
function edTabBlocked_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(EDT_BLOCKED_PROP_) === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * While Status says a tab is in the way and no row is to be written: one look at the tab of that name (getSheetByName,
 * then edTabOwner_'s checks). When the name is free or the tab is the bot's again, Status no longer says so. A tab that
 * is still in the way, or that Sheets couldn't check, leaves the note as it is. Nothing is written. Never throws.
 */
function edTabRecheck_(ss) {
  try {
    const found = ss.getSheetByName(EDT_NAME_);
    const owner = found ? edTabOwner_(found) : 'bot';
    if (owner === 'bot') noteEdTabBlocked_(false);
    if (found && owner === 'bot') noteEdTabMade_();
  } catch (e) {
    console.error('Early Detection tab: could not look at it again: ' + ((e && e.message) || e));
  }
}

/**
 * From poll(), at the start of a run with Early Detection (Control row 19) ON, before any flow writes Control C19: the
 * tab, made once (edTabMakeOnce_) when the setting is on and the bot has not made it yet (EDT_MADE_PROP_), nor been told
 * a tab of that name is in the way. After that no Sheets call. Never throws.
 */
function maybeMakeEdTab_(ss) {
  try {
    if (!edTabOn_() || edTabMade_() || edTabBlocked_()) return;
    edTabMakeOnce_(ss);
  } catch (e) {
    console.error('Early Detection tab: ' + ((e && e.message) || e));
  }
}

/**
 * The tab, made once without a row to write (maybeMakeEdTab_): its first four rows with "Today: nothing yet."
 * (ensureEdTab_), so Control C19's pointer never leads to a tab that isn't there. The bot's own tab already there is only
 * remembered. A tab of that name the bot didn't make is left as it is (never read past its first four rows, cleared or
 * written): Status says it is in the way, and C19 has no pointer. Sheets not answering changes nothing (the next run
 * tries again). Never throws.
 */
function edTabMakeOnce_(ss) {
  try {
    if (!ss) return;
    const found = ss.getSheetByName(EDT_NAME_);
    const owner = found ? edTabOwner_(found) : 'bot';
    if (owner === 'unknown') return;
    if (owner === 'other') {
      noteEdTabBlocked_(true);
      return;
    }
    if (found || ensureEdTab_(ss)) noteEdTabMade_();
  } catch (e) {
    console.error('Early Detection tab: could not be made: ' + ((e && e.message) || e));
  }
}

/** The day and the numbers row 3 shows at `now` ("2026-11-15|12|3|0|6|1|2"), without its time. Never throws. */
function edTabTodayKey_(now) {
  try {
    const tz = (typeof GEN !== 'undefined' && GEN && GEN.timezone) || 'America/New_York';
    const n = edDayNumbers_(PropertiesService.getScriptProperties());
    return [Utilities.formatDate(new Date(Number(now) || Date.now()), tz, 'yyyy-MM-dd'), n.found, n.cards, n.under, n.letgo,
      n.never, n.waiting].join('|');
  } catch (e) {
    return '';
  }
}

/** Remembers what row 3 was written with (EDT_TODAY_PROP_). Never throws. */
function edTabTodayNoted_(key) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (key && props.getProperty(EDT_TODAY_PROP_) !== key) props.setProperty(EDT_TODAY_PROP_, key);
  } catch (e) { /* the next run writes row 3 again */ }
}

/**
 * A run with time and no row to write: row 3 brought up to date with today's numbers (the ones Control C19 shows), one
 * cell, only when they changed since row 3 was last written (EDT_TODAY_PROP_: no Sheets call while they are the same) and
 * only on the bot's own tab (made, and found to be its own: edTabOwner_). Never throws.
 */
function edTabTodayRefresh_(ss, now) {
  try {
    if (!ss || !edTabMade_()) return;
    const key = edTabTodayKey_(now);
    if (!key || PropertiesService.getScriptProperties().getProperty(EDT_TODAY_PROP_) === key) return;
    const sh = ss.getSheetByName(EDT_NAME_);
    if (!sh || edTabOwner_(sh) !== 'bot') return;
    sh.getRange(3, 1).setValue(speedText_(edTabTodayText_(now)));
    edTabTodayNoted_(key);
  } catch (e) {
    console.error('Early Detection tab: today\'s numbers not brought up to date: ' + ((e && e.message) || e));
  }
}

/**
 * From EarlyDetectionNotes.gs edNote_, as each row is noted: the run's rows so far, kept in the script cache
 * (EDT_RUN_KEY_, the newest EDT_WAIT_ROWS_ that fit EDT_WAIT_CHARS_), so a run that ends before its last block
 * (maybeWriteEdTab_) does not lose the rows of endings it already counted: the next run puts them with the rows that
 * wait (edTabTakeOver_). Nothing with the setting off. Never throws.
 */
function edTabHandOver_() {
  try {
    if (!edTabOn_()) return;
    let rows = edNotesOfRun_().slice(-EDT_WAIT_ROWS_);
    if (!rows.length) return;
    while (rows.length > 1 && (JSON.stringify(rows).length > EDT_WAIT_CHARS_ || edTabBytes_(JSON.stringify(rows)) > EDT_WAIT_CHARS_)) {
      rows = rows.slice(1);
    }
    CacheService.getScriptCache().put(EDT_RUN_KEY_, JSON.stringify(rows), EDT_WAIT_SECONDS_);
  } catch (e) {
    console.error('Early Detection tab: this run\'s rows could not be kept: ' + ((e && e.message) || e));
  }
}

/**
 * From EarlyDetectionNotes.gs edNotesStart_, when a run starts: rows an earlier run handed over (edTabHandOver_) and did
 * not write or leave waiting itself (it ended first) join the rows that wait (edTabWait_), without a row twice. Never
 * throws.
 */
function edTabTakeOver_() {
  try {
    if (!edTabOn_()) return;
    const cache = CacheService.getScriptCache();
    const raw = cache.get(EDT_RUN_KEY_);
    if (!raw) return;
    cache.remove(EDT_RUN_KEY_);
    let rows = [];
    try { rows = JSON.parse(raw); } catch (e) { rows = []; }
    rows = (Array.isArray(rows) ? rows : []).filter(r => Array.isArray(r) && r.length === ED_NOTE_FIELDS_.length && typeof r[2] === 'string');
    if (!rows.length) return;
    const kept = edTabWaiting_();
    edTabWait_(edTabMerge_(kept.rows, rows), kept.lost, kept.lostAt);
  } catch (e) {
    console.error('Early Detection tab: an earlier run\'s rows could not be taken over: ' + ((e && e.message) || e));
  }
}

/** The run's rows are written or left waiting: what it handed over (EDT_RUN_KEY_) is no longer needed. Never throws. */
function edTabRunDone_() {
  try {
    if (edNotesOfRun_().length) CacheService.getScriptCache().remove(EDT_RUN_KEY_);
  } catch (e) { /* the next run takes them over: they are on the tab or waiting, and none is written twice */ }
}

/** Has the bot made its tab (EDT_MADE_PROP_)? Never throws. */
function edTabMade_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(EDT_MADE_PROP_) === 'true';
  } catch (e) {
    return false;
  }
}

/** Remembers that the bot's tab is there (EDT_MADE_PROP_), once. Never throws. */
function noteEdTabMade_() {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(EDT_MADE_PROP_) !== 'true') props.setProperty(EDT_MADE_PROP_, 'true');
  } catch (e) {
    console.error('could not note the Early Detection tab: ' + ((e && e.message) || e));
  }
}

/**
 * Control C19 ends with its pointer to the tab only when the tab is there to be read: the setting on, the bot's tab made
 * (EDT_MADE_PROP_) and no tab of that name in its way. Never throws.
 */
function edTabPointed_() {
  return edTabOn_() && edTabMade_() && !edTabBlocked_();
}

/** Remembers whether a tab named "Early Detection" that the bot didn't make is in the way (EDT_BLOCKED_PROP_). Never throws. */
function noteEdTabBlocked_(blocked) {
  try {
    const props = PropertiesService.getScriptProperties();
    const was = props.getProperty(EDT_BLOCKED_PROP_) === 'true';
    if (blocked && !was) props.setProperty(EDT_BLOCKED_PROP_, 'true');
    if (!blocked && was) props.deleteProperty(EDT_BLOCKED_PROP_);
  } catch (e) {
    console.error('could not note the Early Detection tab: ' + ((e && e.message) || e));
  }
}

/**
 * Control tab: why the Early Detection tab isn't being updated ('' when it is, or the setting is off), for the status
 * line (Main.gs poll(): B5, after the Head start tab's note). Never throws.
 */
function edTabBlockedNote_() {
  try {
    if (!edTabOn_()) return '';
    if (PropertiesService.getScriptProperties().getProperty(EDT_BLOCKED_PROP_) !== 'true') return '';
    return `The ${EDT_NAME_} tab isn't being updated: a tab named "${EDT_NAME_}" that the bot didn't make is in the way ` +
      '(or its title in A1 or a column name was changed). Rename that tab, and the bot makes its own.';
  } catch (e) {
    return '';
  }
}
