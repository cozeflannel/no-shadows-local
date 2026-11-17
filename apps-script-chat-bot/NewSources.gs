/**
 * NewSources.gs — what the owner reads about Early Detection's new sources (Control row 48, the AMIE table; row 49,
 * Brandwatch live, comes with a later step): the column C note of each source's row, the line a read leaves in the log,
 * and the bot-made tab "New sources".
 *
 * The tab is made only while a new source's row is ON, at the end of an Early Detection check (EarlyWaveSource.gs
 * ewsProduce_ calls nsrcAfterCheck_). Its A1 is the bot's mark (NSRC_TITLE_): a tab of that name whose A1 is anything
 * else (a person's tab, an empty one, a title one character off) is never read or written, and the source waits (it
 * is not read) and says so in its note until that tab is renamed. Its layout:
 *   row 1        the title (the mark)
 *   row 2        one line: the calls the new sources made today, when the tab was written, what "today" means
 *   row 3        the header of the source rows (NSRC_HEADER_)
 *   rows 4-5     one row a source (NSRC_SOURCE_ROWS_ kept: the AMIE table now, Brandwatch live in a later step)
 *   row 6        blank
 *   row 7 on     the stories only the new sources lifted over the bar (the trial's list), newest first; a later step
 *                puts Brandwatch's query list (where the owner ticks which queries are read) at NSRC_QUERY_ROW_ and
 *                these stories below it
 * Every cell is one line of at most NSRC_CELL_CHARS_ characters, written as text; every text that came from outside
 * (a post's words, BigQuery's message) is scrubbed first (nsrcScrub_). Nothing here posts to any space or sends any
 * email: the tab, the note and the log are for the owner only.
 */

const NSRC_TAB_ = 'New sources';
const NSRC_TITLE_ = 'Early Detection\'s new sources: what each one read today and how late its posts came (written by the bot)';
const NSRC_HEAD_ROW_ = 3;
const NSRC_SOURCE_ROWS_ = 2;   // rows kept for the sources: the AMIE table, then Brandwatch live (a later step)
const NSRC_QUERY_ROW_ = 7;     // where a later step lists Brandwatch's queries (none yet)
const NSRC_CELL_CHARS_ = 500;  // every cell the tab writes, at most (far under Sheets' 50,000)
const NSRC_NOTE_CHARS_ = 200;  // a column C note, at most (Control.gs noteSwitch_ cuts there)
const NSRC_HEADER_ = ['Source', 'Status', 'Last read (ET)',
  'Today: read / used / same post as another source / replaced by another source\'s copy',
  'Time from posting to seen, today (most of them; then how many within 15 min / 15-60 min / 1-3 h / 3-12 h / over 12 h)',
  'Seen first (posts another source also had)', 'No words / X left out / not embedded, today',
  'Stories today: with its post / started by it / lifted only by it (sent / noted)',
  'Brandwatch today: calls / mentions / ceiling / all features', 'AMIE table: newest row / table last changed / a read scans'];
const NSRC_LIFT_HEADER_ = ['Time (ET)', 'Headline', 'Accounts', 'Links', 'What happened', 'Sources'];
const NSRC_SOURCE_NAMES_ = { ami: 'The AMIE table (Brandwatch\'s alert feeds, X with its words)', bwl: 'Brandwatch live (not X)' };
const NSRC_SHORT_NAMES_ = { ami: 'the AMIE table', bwl: 'Brandwatch live' };
// how long after posting a post was first seen, by the day record's buckets (EarlyWaveSource.gs ewsNewBucket_)
const NSRC_DELAY_WORDS_ = ['within 15 min of posting', '15-60 min after posting', '1-3 h after posting', '3-12 h after posting',
  'over 12 h after posting'];
const NSRC_GAP_WORDS_ = ['up to 15 min', '15-60 min', '1-3 h', '3-12 h', 'over 12 h'];

// ---------------------------------------------------------------------------------------------------------------
// Small helpers (pure but for the time zone, GEN.timezone)
// ---------------------------------------------------------------------------------------------------------------

/**
 * A text from outside (a post's words, BigQuery's or Brandwatch's message) made safe to keep, show or log: `token` (when
 * given) becomes [token]; anything shaped like an email address, whole, URL-encoded or cut short, becomes [address] (a
 * handle such as "@maker" is left as it is); one line; cut to `max` characters (NSRC_CELL_CHARS_ when not given). Pure.
 */
function nsrcScrub_(s, max, token) {
  let t = String(s === undefined || s === null ? '' : s);
  if (token) t = t.split(String(token)).join('[token]');
  t = t.replace(/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi, '[address]')
    .replace(/[^\s()[\]<>"',;@]+(?:@|%40)[^\s()[\]<>"',;]*/gi, '[address]')
    .replace(/\s+/g, ' ').trim();
  return truncate_(t, max > 0 ? max : NSRC_CELL_CHARS_);
}

/**
 * A cell as the tab writes it: one line, at most NSRC_CELL_CHARS_ characters, and always text (a leading apostrophe
 * when Sheets would read it as a number, a time, a date, a truth value or a formula). Pure.
 */
function nsrcCell_(v) {
  const s = truncate_(String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim(), NSRC_CELL_CHARS_);
  return /^(?:[=+\-@'\d.]|true$|false$)/i.test(s) ? `'${s}` : s;
}

/** A number as people read it ("1,240"). Pure. */
function nsrcNum_(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
}

/** A time (ms) in ET: "10:15 AM" on the same ET day as `now`, else "Nov 16, 10:15 AM"; '' for none. */
function nsrcWhen_(ms, now) {
  const n = Number(ms);
  if (!(n > 0)) return '';
  const tz = GEN.timezone || 'America/New_York';
  const day = t => Utilities.formatDate(new Date(t), tz, 'yyyy-MM-dd');
  return day(n) === day(Number(now) || Date.now()) ? Utilities.formatDate(new Date(n), tz, 'h:mm a')
    : Utilities.formatDate(new Date(n), tz, 'MMM d, h:mm a');
}

/** A time (ms) in ET with its day: "Nov 16, 10:15 AM"; '' for none. */
function nsrcStamp_(ms) {
  const n = Number(ms);
  return n > 0 ? Utilities.formatDate(new Date(n), GEN.timezone || 'America/New_York', 'MMM d, h:mm a') : '';
}

/** How long, in plain words: "just now", "45 min", "3 h", "2 days". Pure. */
function nsrcFor_(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} days`;
}

/** A UTC day 'YYYY-MM-DD' as "Nov 23"; '' for none. Pure. */
function nsrcDayWords_(day) {
  const m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1] || ''} ${Number(m[3])}`;
}

/** The bucket most posts fall in (the median's) of a five-bucket list, or -1 when it holds nothing. Pure. */
function nsrcMedianBucket_(list) {
  const b = Array.isArray(list) ? list.map(x => Math.max(0, Number(x) || 0)) : [];
  const total = b.reduce((a, x) => a + x, 0);
  if (!(total > 0)) return -1;
  let seen = 0;
  for (let i = 0; i < b.length; i++) { seen += b[i]; if (seen * 2 >= total) return i; }
  return b.length - 1;
}

/**
 * A source's day: today's counts in EWS_SRC_DAY (`rec`: ewsSrcDay_) for `src` on UTC day `day`, each count a number
 * (0 when not there) and each bucket list five numbers. Pure.
 */
function nsrcDay_(rec, src, day) {
  const d = (((rec && rec.d) || {})[day] || {})[src] || {};
  const out = {};
  ['in', 'used', 'same', 'sl', 'big', 'ex', 'al', 'rp', 'sf', 'ne', 'emb', 'st', 'sb', 'lf', 'lfs', 'lfn', 'rows', 'npt', 'rep',
    'lc', 'le', 'calls'].forEach(k => { out[k] = Math.max(0, Number(d[k]) || 0); });
  ['dl', 'sfb'].forEach(k => { out[k] = [0, 1, 2, 3, 4].map(i => Math.max(0, Number((Array.isArray(d[k]) ? d[k] : [])[i]) || 0)); });
  return out;
}

/**
 * The trial of a source (early_wave_new_trial_days from the day it was first read, EWS_SRC_DAY `on`): {until (the
 * first UTC day out of it, 'YYYY-MM-DD'), noted (the stories only it lifted that were noted in the days kept)}, or null
 * when the source is not in its trial (not read yet, past it, or no trial). Pure (reads GEN).
 */
function nsrcTrial_(rec, src, day) {
  const cfg = ewsNewCfg_();
  const on = rec && rec.on && rec.on[src];
  if (!(cfg.trialDays > 0) || !on || ewsDaysBetween_(on, day) >= cfg.trialDays) return null;
  const until = ewsUtcDay_(Date.parse(`${on}T00:00:00Z`) + cfg.trialDays * 24 * 3600 * 1000);
  let noted = 0;
  Object.keys((rec && rec.d) || {}).forEach(k => { if (k >= on) noted += Math.max(0, Number(((rec.d[k] || {})[src] || {}).lfn) || 0); });
  return { until, noted };
}

// ---------------------------------------------------------------------------------------------------------------
// The AMIE table's note (C48), status and log line
// ---------------------------------------------------------------------------------------------------------------

/**
 * The AMIE table's one warning, or '' when there is none: a tab named "New sources" the bot didn't make (`foreign`),
 * else a stop, a pause or a failure (ewsAmiStatus_), else no new rows for amie_stale_hours. It starts with "⚠️", says
 * since when and fits NSRC_NOTE_CHARS_ (the reason is shortened, never the rest). `s`: ewsAmiStatus_. Pure (but for the
 * time zone).
 */
function nsrcAmiWarning_(s, now, foreign) {
  if (foreign) {
    return `⚠️ waiting: a tab named "${NSRC_TAB_}" exists that the bot didn't make; rename it to let the bot make its own`;
  }
  const st = s || {};
  const since = `since ${nsrcWhen_(st.since, now)} (${nsrcFor_(now - st.since)})`;
  const fit = make => {
    const why = String(st.why || '').replace(/[.\s]+$/, '');
    const full = make(why);
    return full.length <= NSRC_NOTE_CHARS_ ? full : make(truncate_(why, Math.max(1, why.length - (full.length - NSRC_NOTE_CHARS_))));
  };
  if (st.state === 'stopped' && st.kind === 'cost') {
    return fit(why => `⚠️ stopped for today: ${why}. It tries again tomorrow; the other sources go on`);
  }
  if (st.state === 'stopped') {
    const long = `⚠️ ${since}: ${String(st.why || '').replace(/[.\s]+$/, '')}. The other sources go on (New sources tab)`;
    return long.length <= NSRC_NOTE_CHARS_ ? long : fit(why => `⚠️ ${since}: ${why}. The other sources go on`);
  }
  if (st.state === 'paused') return fit(why => `⚠️ ${since}: ${why}. It tries again in an hour`);
  if (st.state === 'failing') return fit(why => `⚠️ ${since}: ${why}. It tries again at the next check`);
  if (st.kind === 'stale') {
    return `⚠️ the AMIE table has had no new rows since ${nsrcWhen_(st.since, now)} (${nsrcFor_(now - st.since)}; it is usually ` +
      'written every few minutes). It reads on when rows come';
  }
  return '';
}

/**
 * Column C of row 48 (after its ON text): the warning first and whole (nsrcAmiWarning_), at most one; then, while they
 * fit NSRC_NOTE_CHARS_, the last read's time and today's counts, last a pointer to the tab. In its trial the trial comes
 * first ("trial until Nov 23: 3 stories it alone lifted were noted, not sent for review"). `o`: {status (ewsAmiStatus_),
 * day (nsrcDay_), trial (nsrcTrial_ or null), now, foreign}. Never longer than NSRC_NOTE_CHARS_. Pure (but for the time
 * zone).
 */
function nsrcAmiNote_(o) {
  const x = o || {};
  const s = x.status || {};
  const d = x.day || nsrcDay_(null, 'ami', '');
  const now = Number(x.now) || Date.now();
  const warning = nsrcAmiWarning_(s, now, !!x.foreign);
  const read = s.read > 0 ? `read ${nsrcWhen_(s.read, now)}` : warning ? '' : 'waiting for its first read';
  const counts = `today: ${nsrcNum_(d.rows)} rows, ${nsrcNum_(d.used)} posts used, ${nsrcNum_(d.same)} same as another source, ` +
    `${nsrcNum_(d.st)} in stories (${nsrcNum_(d.sb)} started)`;
  const short = `today: ${nsrcNum_(d.rows)} rows, ${nsrcNum_(d.used)} used`;
  const most = nsrcMedianBucket_(d.dl);
  const delay = most >= 0 ? `most arrive ${NSRC_DELAY_WORDS_[most]}` : '';
  let parts;
  if (warning) parts = [warning, read, counts, short];
  else if (x.trial) {
    const n = Number(x.trial.noted) || 0;
    const what = n === 1 ? '1 story it alone lifted was noted, not sent for review'
      : n > 1 ? `${nsrcNum_(n)} stories it alone lifted were noted, not sent for review`
        : 'stories it alone lifts are noted, not sent for review';
    parts = [`trial until ${nsrcDayWords_(x.trial.until)}: ${what} (New sources tab)`, read, short];
  } else parts = [read, counts, short, delay, 'New sources tab'];
  let note = '';
  let haveCounts = false;
  parts.filter(Boolean).forEach((p, i) => {
    if (p === short && haveCounts) return;  // the long counts are there: the short ones are not needed
    const next = note ? `${note} · ${p}` : p;
    if (next.length > NSRC_NOTE_CHARS_ && i > 0) return;
    note = next;
    if (p === counts) haveCounts = true;
  });
  return truncate_(note, NSRC_NOTE_CHARS_);
}

/** The AMIE table's Status cell on the tab: its warning, else "✓ live: N new rows at the last read". Pure. */
function nsrcAmiStatusText_(s, now, foreign, lastRows) {
  const warning = nsrcAmiWarning_(s, now, foreign);
  if (warning) return warning;
  if (!(s && s.read > 0)) return 'waiting for its first read';
  return `✓ live: ${nsrcNum_(lastRows)} new row${Number(lastRows) === 1 ? '' : 's'} at the last read`;
}

/**
 * The line an AMIE read leaves in the log (one a check it was collected): "early wave source ami: 1240 rows
 * 10:00-10:14 UTC (overlap 60 min), 310 kept, 41 same post, 6 late caught, mark 10:13:58Z, 0.2 GB". `n`: this check's
 * counts of the source (ewsNewCount_'s nx.n.ami), `from` / `mark`: the mark before and after the read (ms), `gb`: the
 * last dry run's figure (or null). `got` (optional): {rows: the rows the job sent back (its overlap's repeats and its
 * other rows included), ms: the time to fetch and read them}, added at the end ("2300 rows came back, read in 1.4 s"),
 * so the first live weeks show what the overlap costs. Pure.
 */
function nsrcAmiLog_(n, from, mark, overlapMin, gb, got) {
  const c = n || {};
  const hm = ms => (Number(ms) > 0 ? new Date(Number(ms)).toISOString().slice(11, 16) : '?');
  const span = Number(mark) > 0 ? ` ${hm(from)}-${hm(mark)} UTC` : '';
  const at = Number(mark) > 0 ? new Date(Number(mark)).toISOString().slice(11, 19) + 'Z' : 'none yet';
  return `early wave source ami: ${Math.round(Number(c.rows) || 0)} rows${span} (overlap ${Math.round(Number(overlapMin) || 0)} min), ` +
    `${Math.round(Number(c.used) || 0)} kept, ${Math.round(Number(c.same) || 0)} same post, ${Math.round(Number(c.lc) || 0)} late caught, ` +
    `mark ${at}${typeof gb === 'number' ? `, ${gb} GB` : ''}` +
    (got && typeof got === 'object' ? `, ${Math.round(Number(got.rows) || 0)} rows came back, read in ${((Number(got.ms) || 0) / 1000).toFixed(1)} s` : '');
}

// ---------------------------------------------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------------------------------------------

/** The bot's own New sources tab: its A1 is the title the bot writes there. */
function isNsrcTab_(sh) {
  try { return String(sh.getRange(1, 1).getDisplayValue()).trim() === NSRC_TITLE_; } catch (e) { return false; }
}

/** The bot's sheet (STORE_SHEET_ID), or null when there is none yet. */
function nsrcStore_() {
  const id = PropertiesService.getScriptProperties().getProperty(STORE_SHEET_PROP_);
  return id ? SpreadsheetApp.openById(id) : null;
}

/**
 * True when the bot's sheet has a tab named "New sources" that the bot didn't make (EarlyWaveSource.gs asks at the
 * end of the first check after a new source's row goes ON, before it reads anything). Reads only that tab's A1. Never throws.
 */
function nsrcForeign_() {
  try {
    const ss = nsrcStore_();
    const sh = ss ? ss.getSheetByName(NSRC_TAB_) : null;
    return !!sh && !isNsrcTab_(sh);
  } catch (e) {
    return false;
  }
}

/**
 * The New sources tab ({sh, foreign}): made, last of the tabs, when missing and `create` (its title in A1 first, the
 * bot's mark), protected with a warning only; foreign (sh null) when a tab of that name exists whose A1 is not the bot's
 * title: that tab is never read (but for its A1) or written. A tab of the bot's that a person hid or protected stays
 * the bot's.
 */
function nsrcTab_(ss, create) {
  let sh = ss.getSheetByName(NSRC_TAB_);
  if (sh) return isNsrcTab_(sh) ? { sh, foreign: false } : { sh: null, foreign: true };
  if (!create) return { sh: null, foreign: false };
  sh = ss.insertSheet(NSRC_TAB_, ss.getSheets().length);
  sh.getRange(1, 1).setValue(NSRC_TITLE_);
  try {
    sh.getRange(1, 1).setFontWeight('bold').setFontSize(12);
    sh.getRange(NSRC_HEAD_ROW_, 1, 1, NSRC_HEADER_.length).setFontWeight('bold');
    sh.setFrozenRows(NSRC_HEAD_ROW_);
    [240, 320, 110, 200, 260, 220, 160, 200, 200, 220].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  } catch (e) { /* the tab works unformatted */ }
  try { sh.protect().setDescription('Written by the Burson QA bot').setWarningOnly(true); } catch (e) { /* unprotected */ }
  return { sh, foreign: false };
}

/**
 * The AMIE table's row on the tab (NSRC_HEADER_). `s`: ewsAmiStatus_; `d`: nsrcDay_ of today; `lastRows`: new rows at
 * the last read. Pure (but for the time zone).
 */
function nsrcAmiRow_(s, d, now, foreign, lastRows) {
  const delay = nsrcMedianBucket_(d.dl);
  const gap = nsrcMedianBucket_(d.sfb);
  const buckets = list => list.map(nsrcNum_).join(' / ');
  const dash = v => v || '—';
  return [
    NSRC_SOURCE_NAMES_.ami,
    nsrcAmiStatusText_(s, now, foreign, lastRows),
    dash(nsrcWhen_(s.read, now)),
    `${nsrcNum_(d.rows)} rows / ${nsrcNum_(d.used)} / ${nsrcNum_(d.same)} / ${nsrcNum_(d.rp)}`,
    delay >= 0 ? `most ${NSRC_DELAY_WORDS_[delay]} (${buckets(d.dl)})` : 'none today',
    d.sf > 0 ? `first on ${nsrcNum_(d.sf)} post${d.sf === 1 ? '' : 's'}, most of them ${NSRC_GAP_WORDS_[gap]} before the other source's copy` : 'none today',
    `— / — / ${nsrcNum_(d.ne)}`,
    `${nsrcNum_(d.st)} / ${nsrcNum_(d.sb)} / ${nsrcNum_(d.lf)} (${nsrcNum_(d.lfs)} / ${nsrcNum_(d.lfn)})`,
    '—',
    `${dash(nsrcWhen_(s.mark, now))} / ${dash(nsrcWhen_(s.changed, now))} / ${typeof s.gb === 'number' ? `${s.gb} GB` : '—'}`,
  ];
}

/**
 * How a trial is named for people: "first week" for 7 days (early_wave_new_trial_days), "first N days" for another
 * number, and "trial" once the setting is 0 (a story noted in an earlier trial). Pure (reads GEN).
 */
function nsrcTrialWords_() {
  const n = ewsNewCfg_().trialDays;
  if (!(n > 0)) return 'trial';
  return n === 7 ? 'first week' : `first ${n} day${n === 1 ? '' : 's'}`;
}

/**
 * The tab's rows, from row 1: the title, the summary, the source rows' header, one row a source (`sources`, each a row of
 * NSRC_HEADER_; the slots of NSRC_SOURCE_ROWS_ not used are blank), a blank row, then the lifted stories (`lifted`:
 * EarlyWaveSource.gs ewsLiftedStories_, newest last there, newest first here). `calls`: the calls the new sources made
 * today. `trial`: true while a source is in its trial (nsrcTrial_), the only time the list's title speaks of one. Pure
 * (but for the time zone).
 */
function nsrcRows_(sources, lifted, calls, now, trial) {
  const width = NSRC_HEADER_.length;
  const pad = r => r.concat(Array(Math.max(0, width - r.length)).fill('')).slice(0, width);
  const rows = [
    pad([NSRC_TITLE_]),
    pad([`Calls today: ${nsrcNum_(calls)} to BigQuery for the AMIE table (its reads, table checks and dry runs) · written ` +
      `${nsrcStamp_(now)} ET · "today" is the day in UTC, which starts at 7 or 8 PM ET · — means it ` +
      'does not apply to that source']),
    pad(NSRC_HEADER_.slice()),
  ];
  for (let i = 0; i < NSRC_SOURCE_ROWS_; i++) rows.push(pad(sources[i] || []));
  rows.push(pad([]));
  // (a later step puts Brandwatch's query list here, from row NSRC_QUERY_ROW_, and the lifted stories after it)
  const list = (lifted || []).slice().reverse();
  rows.push(pad([`Stories only the new sources lifted over the bar, newest first (${list.length}` +
    (trial ? `; in a source's ${nsrcTrialWords_()} they are noted here, not sent for review)` : ')')]));
  rows.push(pad(NSRC_LIFT_HEADER_.slice()));
  list.forEach(e => rows.push(pad([
    nsrcStamp_(e.at),
    nsrcScrub_(e.headline) || '(no headline)',
    nsrcNum_(e.accounts),
    nsrcNum_(e.links),
    e.sent ? 'sent for review' : e.trial ? `noted, not sent: the source's ${nsrcTrialWords_()}` : 'noted, not sent: the hour\'s or day\'s limit was reached',
    (e.sources || []).map(x => NSRC_SHORT_NAMES_[x] || x).join(', '),
  ])));
  return rows.map(r => r.map(nsrcCell_));
}

/**
 * Writes the tab's rows (nsrcRows_) when a cell changed, and empties the rows below them that an earlier write left (the
 * tab is the bot's own: nsrcTab_). Returns true when it wrote. A failure is logged, never thrown.
 */
function nsrcWrite_(sh, rows) {
  try {
    const width = NSRC_HEADER_.length;
    const have = sh.getRange(1, 1, rows.length, width).getDisplayValues();
    const same = (want, got) => String(want).replace(/^'/, '') === String(got === undefined || got === null ? '' : got);
    const changed = rows.some((r, i) => r.some((c, j) => !same(c, (have[i] || [])[j])));
    const range = sh.getRange(1, 1, rows.length, width);
    if (changed) {
      try { range.setNumberFormat('@'); } catch (e) { /* the apostrophes keep it text */ }
      range.setValues(rows);
    }
    const left = sh.getLastRow() - rows.length;
    if (left > 0) sh.getRange(rows.length + 1, 1, left, width).clearContent();
    return changed;
  } catch (e) {
    console.error(`New sources: couldn't write the ${NSRC_TAB_} tab: ${nsrcScrub_((e && e.message) || e, 200)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The end of a check (EarlyWaveSource.gs ewsProduce_), and the wait while row 19 is OFF
// ---------------------------------------------------------------------------------------------------------------

/**
 * The end of an Early Detection check while a new source's row is ON (`nx`: the check's new-source context, after its
 * day record was saved): the line its read leaves in the log, the New sources tab (made when missing; left alone when a
 * person's tab has its name, and then `st.nsf` is set so the source waits; cleared when the tab is the bot's), and
 * column C of its row (noteSwitch_, every check, so the note never ages out while the source is ON). `read`: the
 * check's lanes (ewsReadLanes_). Only the AMIE table (row 48) has all of this yet. Never throws.
 */
function nsrcAfterCheck_(props, st, nx, now, read) {
  try {
    if (!nx || !Array.isArray(nx.sources) || nx.sources.indexOf('ami') < 0) return;
    const amiq = (st.marks && st.marks.amiq) || {};
    const lane = read && read.ami;
    if (lane && lane.state === 'done') {
      const before = Number(lane.q && lane.q.flags && lane.q.flags.mark) || Number(lane.q && lane.q.win && lane.q.win.since) || 0;
      console.log(nsrcAmiLog_((nx.n || {}).ami, before, Number(st.marks.ami) || 0, ewsAmiCfg_().overlapMin,
        typeof amiq.gb === 'number' ? amiq.gb : null, { rows: Number(lane.got) || 0, ms: Number(lane.ms) || 0 }));
    }
    const rec = ewsSrcDay_(props);  // as saved: the tab's numbers are the day record's
    const status = ewsAmiStatus_(now, st);
    const day = ewsUtcDay_(now);
    const d = nsrcDay_(rec, 'ami', day);
    let ss = null;
    try { ss = nsrcStore_(); } catch (e) { ss = null; }
    if (ss) {
      let tab = null;
      try { tab = nsrcTab_(ss, true); } catch (e) {
        console.error(`New sources: couldn't make the ${NSRC_TAB_} tab: ${nsrcScrub_((e && e.message) || e, 200)}`);
      }
      if (tab && tab.foreign) {
        if (!st.nsf) console.warn(`New sources: a tab named "${NSRC_TAB_}" exists that the bot didn't make: left alone, and the AMIE table waits`);
        st.nsf = st.nsf || now;
      } else if (tab && tab.sh) {
        delete st.nsf;
        const rows = nsrcRows_([nsrcAmiRow_(status, d, now, false, Number(amiq.lr) || 0)], ewsLiftedStories_(), d.calls, now,
          !!nsrcTrial_(rec, 'ami', day));
        nsrcWrite_(tab.sh, rows);
      }
    }
    noteSwitch_('edAmie', nsrcAmiNote_({ status, day: d, trial: nsrcTrial_(rec, 'ami', day), now, foreign: !!st.nsf }));
  } catch (e) {
    console.warn(`New sources: ${nsrcScrub_((e && e.message) || e, 200)}`);
  }
}

/**
 * Row 48 is ON but Early wave & velocity check (row 19) is OFF, so no check runs: column C shows only the ON text's
 * waiting words, never a note a check left before (it would say "read ..." of a source that waits). Reads the notes;
 * writes only when row 48 has a note. Never throws.
 */
function nsrcWaiting_(key) {
  try {
    const notes = JSON.parse(PropertiesService.getScriptProperties().getProperty(SWITCH_NOTES_PROP_) || '{}') || {};
    if (notes[key] && notes[key].text) noteSwitch_(key, '');
  } catch (e) { /* the note ages out within a day */ }
}
