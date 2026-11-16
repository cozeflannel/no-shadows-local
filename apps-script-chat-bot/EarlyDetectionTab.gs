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
 * Every cell goes through the capped-text helper (Speed.gs speedText_: at most 49,000 characters, and a text that starts
 * with = + - @ is never read as a formula). The only formulas are the quoted links (Speed.gs resultsLink_ through
 * HeadStart.gs headStartLink_): the Story to the main post, the Card to the card's message. A written row's cells don't
 * count on a format they inherit from a neighbour row: its time is text, and its formats are set with it.
 *
 * When: poll() calls maybeWriteEdTab_ in its last block, beside the Head start tab, with the run's own deadline. It
 * writes only with EDT_MIN_LEFT_MS_ (30 seconds) of the run left and never in a run that is still catching up on alerts
 * (HeadStart.gs headStartRunBusy_). Rows a run could not write (no time, the write failed, a tab of that name the bot
 * didn't make is in the way) wait in ONE script-cache value (EDT_WAIT_KEY_, 6 hours) for the next run that can: at most
 * EDT_WAIT_ROWS_ rows and EDT_WAIT_CHARS_ characters (and as many bytes), the newest kept; the ones that had to go are
 * counted, and the next write adds one row "N outcomes were not recorded (the runs were full)". A run without a row to
 * write makes no Sheets call at all. The tab is made the first time there is a row to write, after the last of the
 * report tabs, so no tab moves. Never throws.
 */

const EDT_NAME_ = 'Early Detection';
// The bot's mark, in A1 (isEdTab_). A tab people made never has it
const EDT_TITLE_ = 'Early Detection: every story it found and what happened to each (written by the Burson QA bot)';
const EDT_ABOUT_ = 'What\'s listed: each story Early Detection (Control row 19) found in posts from small accounts: several ' +
  'accounts saying the same thing, or a jump in how many accounts post on one topic. Newest first, the last 2,000. Outcome ' +
  'says what the bot did and Why gives the reason. Only rows that start "Card posted", "Update added" or "Added under" are ' +
  'in the space; the others were looked at and let go.';
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
    if (!all.length && !kept.lost) return out;  // nothing to write: no Sheets call
    const deadline = Number(o.deadline) || Number(ctx && ctx.deadline) || 0;
    const noTime = !ss || headStartRunBusy_(ctx, o.flows) || (deadline && deadline - now < EDT_MIN_LEFT_MS_);
    if (!noTime) {
      try {
        const done = writeEdTab_(ss, all, kept, now);
        if (done.written) {
          edTabWait_([], 0, 0);
          out.written = done.written;
          return out;
        }
        out.blocked = !!done.blocked;
      } catch (e) {
        console.error(`Early Detection tab not written (its rows wait for the next run): ${(e && e.message) || e}`);
      }
    }
    out.waiting = edTabWait_(all, kept.lost, kept.lostAt);
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
  const blocked = !!found && !isEdTab_(found);
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
  fmt(() => sh.getRange(3, 1).setValue(speedText_(edTabTodayText_(now))));
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
  const text = v => speedText_(String(v === undefined || v === null ? '' : v));
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
  row[1] = `${k} outcome${k === 1 ? ' was' : 's were'} not recorded (the runs were full)`;
  return row;
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
 * Is this the Early Detection tab the bot made? A1 is exactly its title and row 4 exactly its column names (one read of
 * the first four rows). An empty tab, one people made, or the bot's own with its title or a column name changed is not:
 * such a tab is never read further, cleared, written or protected. False when Sheets doesn't answer.
 */
function isEdTab_(sh) {
  try {
    if (!sh || sh.getLastRow() < EDT_HEAD_ROW_) return false;
    const top = sh.getRange(1, 1, EDT_HEAD_ROW_, EDT_HEADER_.length).getDisplayValues();
    const head = top[EDT_HEAD_ROW_ - 1].map(v => String(v).trim());
    return String(top[0][0]).trim() === EDT_TITLE_ && EDT_HEADER_.every((name, i) => head[i] === name);
  } catch (e) {
    return false;
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
    const raw = CacheService.getScriptCache().get(EDT_WAIT_KEY_);
    if (!raw) return none;
    const v = JSON.parse(raw);
    const rows = (Array.isArray(v && v.r) ? v.r : [])
      .filter(r => Array.isArray(r) && r.length === ED_NOTE_FIELDS_.length && typeof r[2] === 'string');
    return { rows, lost: Math.max(0, Math.round(Number(v && v.n) || 0)), lostAt: Number(v && v.la) || 0 };
  } catch (e) {
    return none;
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
  noteEdTabBlocked_(false);
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
