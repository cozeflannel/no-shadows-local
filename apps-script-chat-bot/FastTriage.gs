/**
 * FastTriage.gs — the fast-triage layer on the early-wave path (Control rows 38-40): what the bot does with the Gemini
 * Decisions answers about a signal (Decisions.gs asks; the full Gemini review in EarlyDetection.gs still runs before
 * every card, and nothing is posted on these answers).
 *
 * Three switches, each OFF until a person turns it ON; rows 39 and 40 do nothing without row 38:
 *   Row 38  Fast triage (Gemini Decisions)       asks the six questions about each signal about to be queued and records
 *                                                the answers: on the queued signal, in the log, and on the Fast triage
 *                                                tab beside the full review's call. Nothing else changes: the order,
 *                                                what is queued and what is reviewed are as they were, and the early
 *                                                watch doesn't run.
 *   Row 39  Fast triage: rank and early watch    queues and reviews in the answers' order (ftRank_), and runs the early
 *                                                watch: the producer's stories still below the usual bar
 *                                                (EarlyWaveSource.gs) are asked about and recorded, and one is raised
 *                                                as a signal of its own when the answers say so (ewsWatchRaise_).
 *   Row 40  Fast triage: hold back noise         drops a signal without a review, only as ftHoldWhy_ allows.
 *
 * The answers are used for two things only:
 *   Order      P0 risk groups first, then the tier (P0 > P1 > P2); within a tier the severity score, then the
 *              brand-risk probability, then the order there was before. A signal with no answer (the API failed, a cap,
 *              a pause) is never ranked down for it: it goes first in its tier.
 *   Hold back  Only when ALL of these hold: the signal has no P0 risk group; no taxonomy hint raised it; its most
 *              probable severity level is one of the two lowest; that level's probability is above
 *              EW_TRIAGE_CONF_MIN_; and either about_google is below EW_TRIAGE_ABOUT_GOOGLE_MAX_ or routine_noise is
 *              above EW_TRIAGE_NOISE_MIN_. A signal that doesn't say whether it has a risk group or a hint (one made
 *              before the producer told) is never held back. A held-back signal is counted on Control C19 ("filtered by
 *              fast triage", beside the dismissals), logged in one line with its id, the reason and the probabilities,
 *              and written on the Fast triage tab.
 *
 * Bars. Each is a named constant, set only from real signals, with the evidence written here (as the similarity bars'
 * is in EarlyWaveSource.gs):
 *   - EW_TRIAGE_HOLD_MAX_LEVEL_ 1 (none, low): the two lowest of ED_SEVERITIES_' five levels. A definition, not a
 *     measurement.
 *   - EW_TRIAGE_ABOUT_GOOGLE_MAX_, EW_TRIAGE_NOISE_MIN_, EW_TRIAGE_CONF_MIN_: NOT SET (null), so nothing is held back
 *     whatever row 40 says (ftHoldReady_). They are set from the Fast triage tab once row 38 alone (recording only)
 *     has recorded enough reviewed signals, and only if, on every real signal available, no signal with a P0 risk group
 *     and no signal the full review escalated would have been held back.
 *
 * The Fast triage tab (made by the bot, its title in A1 its mark; a tab of that name the bot didn't make is never
 * read or written): one row a reviewed signal (the six answers beside the review's call, confidence and severity, and
 * the card's Alert-log id), one a signal held back, one an early-watch story asked about. The Rating column is the
 * analysts': Useful or Noise on a card's row is how "did an analyst act on it" is measured.
 */

const FT_SWITCH_ = 'fastTriage';            // Control row 38: ask and record
const FT_RANK_SWITCH_ = 'fastTriageRank';   // Control row 39: rank by the answers, and the early watch may raise a story
const FT_HOLD_SWITCH_ = 'fastTriageHold';   // Control row 40: hold back noise

// Hold-back bars (see the header). null: not set yet, and nothing is held back until all three are
const EW_TRIAGE_HOLD_MAX_LEVEL_ = 1;        // the most probable severity level is none (0) or low (1)
const EW_TRIAGE_ABOUT_GOOGLE_MAX_ = null;   // about_google below this: not about Google
const EW_TRIAGE_NOISE_MIN_ = null;          // routine_noise above this: routine chatter
const EW_TRIAGE_CONF_MIN_ = null;           // the severity level's probability above this: the answer is sure of it

const EW_WATCH_QUEUE_PER_DAY_ = 8;          // early-watch signals queued a day at most, of EW_MAX_PER_DAY_'s 40: the existing
                                            // signal types reached 40 on 3 of 5 full days (Nov 9-12), so they keep 32
const FT_ANSWER_CACHE_SEC_ = 3 * 3600;      // a signal's answers are kept as long as the producer's buffer keeps the signal,
                                            // so one left for the next check (5 a check) isn't asked about twice
const FT_ANSWER_CACHE_PREFIX_ = 'ft1:';

// The Fast triage tab
const FT_TAB_ = 'Fast triage';
const FT_TITLE_ = 'Fast triage: what Gemini Decisions said about each early-wave signal, beside its full review';
const FT_NOTE_ = 'One row a signal the full review looked at, one a signal the fast triage held back, one an early story ' +
  'it was asked about. The numbers are probabilities (0 to 1); Severity is 0 (none) to 4 (critical). Rating is yours: ' +
  'mark a card Useful or Noise. Everything else is written by the bot.';
const FT_HEAD_ROW_ = 4;
const FT_HEADER_ = ['Seen (ET)', 'Signal', 'Type', 'Accounts', 'Platforms', 'Headline', 'About Google', 'Brand risk',
  'Independent', 'Routine noise', 'Category', 'Category p', 'P0 tags p', 'Severity', 'Level', 'Level p', 'Fast triage',
  'Review', 'Review confidence', 'Review severity', 'Card', 'Rating', 'Key'];
const FT_COL_ = { rating: 22, key: 23 };
const FT_RATINGS_ = ['Useful', 'Noise'];    // as the Watch detections tab's
const FT_MAX_ROWS_ = 5000;                  // rows kept (the oldest go first)...
const FT_TRIM_SLACK_ = 500;                 // ...trimmed once this many more have built up
const FT_HEADLINE_CHARS_ = 300;             // of a signal's headline on the tab

// ---------------------------------------------------------------------------------------------------------------
// The switches
// ---------------------------------------------------------------------------------------------------------------

/** True when the fast triage asks and records this run (Control row 38). Pure. */
function ftOn_(ctx) { return switchOn_(ctx, FT_SWITCH_); }

/** True when the answers order the queue and the early watch may raise a story (row 39, with row 38). Pure. */
function ftRankOn_(ctx) { return ftOn_(ctx) && switchOn_(ctx, FT_RANK_SWITCH_); }

/** True when the fast triage may hold a signal back (row 40, with row 38). Pure. */
function ftHoldOn_(ctx) { return ftOn_(ctx) && switchOn_(ctx, FT_HOLD_SWITCH_); }

/** The hold-back bars ({about, noise, conf}; each null until it is set). Pure. */
function ftHoldBars_() {
  return { about: EW_TRIAGE_ABOUT_GOOGLE_MAX_, noise: EW_TRIAGE_NOISE_MIN_, conf: EW_TRIAGE_CONF_MIN_ };
}

/** True when every hold-back bar in `bars` (default: the constants) is set: until then nothing is held back. Pure. */
function ftHoldReady_(bars) {
  const b = bars || ftHoldBars_();
  return [b.about, b.noise, b.conf].every(v => typeof v === 'number' && isFinite(v));
}

// ---------------------------------------------------------------------------------------------------------------
// What a signal is: its risk groups and its taxonomy hint, as the producer told (EarlyWaveSource.gs, with opts.facts)
// ---------------------------------------------------------------------------------------------------------------

/**
 * True when the signal has a P0 risk-term group: one of its groups (`risk_groups`) is P0 in EWS_RISK_GROUPS_, or its
 * priority hint is P0 (a velocity spike on a P0 group). Pure.
 */
function ftP0Group_(row) {
  const r = row || {};
  if (String(r.priority_hint || '').trim().toUpperCase() === 'P0') return true;
  const p0 = EWS_RISK_GROUPS_.filter(g => g.tier === 'P0').map(g => g.key);
  return String(r.risk_groups || '').split(',').map(s => s.trim()).some(k => k && p0.indexOf(k) >= 0);
}

/**
 * True when the fast triage may never hold the signal back: it has a P0 risk group, a taxonomy hint raised it
 * (`tag_raised`), or the row doesn't say (no `risk_groups` / `tag_raised`: made before the producer told). Pure.
 */
function ftProtected_(row) {
  const r = row || {};
  if (typeof r.risk_groups !== 'string' || typeof r.tag_raised !== 'boolean') return true;
  return r.tag_raised || ftP0Group_(r);
}

// ---------------------------------------------------------------------------------------------------------------
// Order and hold-back (pure rules)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Queue-time order with the ranking ON: `a`, `b` are {row, dec (decCompact_ or null), idx (the order before)}. P0 risk
 * groups first; then the tier (P0 > P1 > P2); within a tier the higher severity score, then the higher brand-risk
 * probability (no answer: first, never ranked down for it); then the order before. Pure.
 */
function ftRank_(a, b) {
  const p0 = x => (ftP0Group_(x.row) ? 0 : 1);
  const pri = x => ewsPri_(x.row && x.row.priority_hint);
  const down = (x, y) => (x === y ? 0 : x > y ? -1 : 1);
  const sev = x => (x.dec ? Number(x.dec.s) || 0 : Infinity);
  const risk = x => (x.dec ? Number(x.dec.r) || 0 : Infinity);
  return p0(a) - p0(b) || pri(a) - pri(b) || down(sev(a), sev(b)) || down(risk(a), risk(b)) || (Number(a.idx) || 0) - (Number(b.idx) || 0);
}

/**
 * What a queued signal's index entry keeps for the review order with the ranking ON: {p0: 1 (a P0 risk group), sv: the
 * severity score, br: the brand-risk probability}; sv and br only with an answer. Pure.
 */
function ftRankKeys_(row, dec) {
  const out = {};
  if (ftP0Group_(row)) out.p0 = 1;
  if (dec) {
    out.sv = Number(dec.s) || 0;
    out.br = Number(dec.r) || 0;
  }
  return out;
}

/**
 * Takes the ranking's keys off the queued signals when the ranking is OFF (so turning row 39 OFF puts the review order
 * back to what it was on the next run). Writes nothing when no entry has them.
 */
function ftQueueUnrank_(props) {
  const list = edQueueList_(props);
  if (!list.some(e => e.p0 !== undefined || e.sv !== undefined || e.br !== undefined)) return;
  list.forEach(e => { delete e.p0; delete e.sv; delete e.br; });
  edQueueSave_(props, list.sort(edQueueRank_));
}

/**
 * Why the fast triage holds signal `row` back without a review on answers `dec` ('' when it doesn't): every condition in
 * the header, against `bars` ({about, noise, conf}; default: the constants, not set yet). Pure.
 */
function ftHoldWhy_(row, dec, bars) {
  const b = bars || ftHoldBars_();
  if (!dec || !ftHoldReady_(b) || ftProtected_(row)) return '';
  if (!(Number(dec.l) <= EW_TRIAGE_HOLD_MAX_LEVEL_) || !(Number(dec.sc) > b.conf)) return '';
  const level = ED_SEVERITIES_[dec.l] || String(dec.l);
  if (Number(dec.g) < b.about) return `not about Google (about Google ${dec.g}, severity ${level} ${dec.sc})`;
  if (Number(dec.n) > b.noise) return `routine noise (routine noise ${dec.n}, severity ${level} ${dec.sc})`;
  return '';
}

/** A signal's answers in words, for the log: every probability, the category and the severity. Pure. */
function ftAnswerWords_(dec) {
  const d = dec || {};
  return `about Google ${d.g} \u00b7 brand risk ${d.r} \u00b7 independent ${d.i} \u00b7 routine noise ${d.n} \u00b7 ` +
    `category "${d.c}" ${d.cp} \u00b7 severity ${d.s} (${ED_SEVERITIES_[d.l] || d.l} ${d.sc})`;
}

// ---------------------------------------------------------------------------------------------------------------
// A check's fast triage: asking, and remembering what was asked
// ---------------------------------------------------------------------------------------------------------------

/**
 * This check's fast triage, or null when row 38 is OFF: {session (decSession_), rank, hold, log, rows: the Fast triage
 * tab's rows so far, asked, missed: {why: count} of signals that went on without an answer, held, watch: {asked,
 * raised}}. `left`: () => ms of the run left.
 */
function ftStart_(ctx, left) {
  if (!ftOn_(ctx)) return null;
  return {
    session: decSession_(left, !!(ctx && ctx.slaBusy)),
    rank: ftRankOn_(ctx),
    hold: ftHoldOn_(ctx),
    log: msg => { if (ctx && typeof ctx.log === 'function') ctx.log(msg); },
    rows: [],
    asked: 0,
    missed: {},
    held: 0,
    watch: { asked: 0, raised: 0 },
  };
}

/**
 * What the producer is asked for with the fast triage ON (EarlyWaveSource.gs ewsRows_'s opts): each new row's risk
 * groups and taxonomy raise (`facts`), and, only with the ranking ON (row 39; with row 38 alone the early watch
 * doesn't run), the early watch: `ask` (the six questions about a story still below the promotion bar, within this
 * check's session) and `done` (each story asked about: one log line, and one Fast triage tab row saying what came
 * of it).
 */
function ftProducerOpts_(ft) {
  const opts = { facts: true };
  if (!ft.rank) return opts;
  opts.watch = {
    ask: row => {
      const res = decSignalAsk_(row, ft.session);
      if (res.ok) ft.asked++;
      return res;
    },
    done: (row, res, raised) => {
      const n = ewCount_(row.unique_low_tier_authors);
      const at = `${fmtInt_(n)} account${n === 1 ? '' : 's'}`;
      ft.watch.asked++;
      if (!res.ok) {
        const why = String(res.why || 'no answer');
        ft.missed[why] = (ft.missed[why] || 0) + 1;
        ft.rows.push(ftTabRow_({ row, dec: null, did: `early watch: asked at ${at}, no answer (${why})`, kind: 'w' }));
        return;
      }
      if (raised) ft.watch.raised++;
      const did = raised ? `early watch: raised at ${at}`
        : !(typeof ewsWatchReady_ === 'function' && ewsWatchReady_()) ? `early watch: asked at ${at} (its bars are not set: nothing is raised)`
          : `early watch: asked at ${at}, not raised`;
      ft.log(`fast triage: early story ${row.alert_id || ''} (${at}) \u00b7 ${ftAnswerWords_(res.dec)} \u00b7 ` +
        `${raised ? 'raised' : 'not raised'} \u00b7 ${res.ms} ms`);
      ft.rows.push(ftTabRow_({ row, dec: res.dec, did, kind: 'w' }));
    },
  };
  return opts;
}

/** The answers kept for signal `id` since an earlier check (null: none). Never throws. */
function ftRecall_(id) {
  try {
    if (!id || typeof CacheService === 'undefined' || !CacheService.getScriptCache) return null;
    const v = JSON.parse(CacheService.getScriptCache().get(FT_ANSWER_CACHE_PREFIX_ + hashText_(String(id))) || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) && typeof v.s === 'number' ? v : null;
  } catch (e) {
    return null;
  }
}

/** Keeps signal `id`'s answers for the next checks (FT_ANSWER_CACHE_SEC_). Never throws. */
function ftRemember_(id, dec) {
  try {
    if (!id || !dec || typeof CacheService === 'undefined' || !CacheService.getScriptCache) return;
    CacheService.getScriptCache().put(FT_ANSWER_CACHE_PREFIX_ + hashText_(String(id)), JSON.stringify(dec), FT_ANSWER_CACHE_SEC_);
  } catch (e) {}
}

/**
 * The fast triage's answers about signal `row` (decCompact_), or null when it goes on without them (the API failed or
 * refused, a cap, a pause: logged once a reason at the check's end, ftFinish_). Answers the signal carries (an
 * early-watch story's, asked when it was raised) or that an earlier check kept are used as they are; a new answer is
 * logged in one line. Never throws.
 */
function ftAsk_(ft, row) {
  try {
    const r = row || {};
    if (r.dec && typeof r.dec === 'object' && typeof r.dec.s === 'number') return r.dec;
    const id = String(r.alert_id || '');
    const kept = ftRecall_(id);
    if (kept) return kept;
    const res = decSignalAsk_(r, ft.session);
    if (res.ok) {
      ft.asked++;
      ftRemember_(id, res.dec);
      ft.log(`fast triage: ${id || 'a signal'} \u00b7 ${ftAnswerWords_(res.dec)} \u00b7 ${res.ms} ms`);
      return res.dec;
    }
    const why = String(res.why || 'no answer');
    ft.missed[why] = (ft.missed[why] || 0) + 1;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Ends a check's fast triage: one log line for the signals that went on without an answer, the Fast triage tab's rows
 * written, and row 38's Control note (C38): the day's calls, a pause and its reason (decStatusText_), and what the tab
 * couldn't take. Never throws.
 */
function ftFinish_(ft, props) {
  if (!ft) return;
  try {
    const missed = Object.keys(ft.missed);
    if (missed.length) {
      ft.log(`fast triage: ${missed.map(w => `${ft.missed[w]} signal${ft.missed[w] === 1 ? '' : 's'} without an answer (${w})`).join('; ')}` +
        ': handled as before');
    }
    const tab = ftTabAppend_(ft.rows);
    const parts = [`last check ${nowLabel_()}`, decStatusText_(props, Date.now())];
    if (ft.watch.asked) parts.push(`${ft.watch.asked} early ${ft.watch.asked === 1 ? 'story' : 'stories'} asked about`);
    if (tab.problem) parts.push(`\u26a0\ufe0f ${tab.problem}`);
    noteSwitch_(FT_SWITCH_, parts.filter(Boolean).join(' \u00b7 '));
  } catch (e) {
    console.warn('fast triage: could not finish the check: ' + ((e && e.message) || e));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The Fast triage tab
// ---------------------------------------------------------------------------------------------------------------

/** The bot's own Fast triage tab: its A1 is the title the bot writes there. */
function isFtTab_(sh) {
  try { return String(sh.getRange(1, 1).getDisplayValue()).trim() === FT_TITLE_; } catch (e) { return false; }
}

/**
 * The Fast triage tab ({sh, foreign}): made when missing and `create` (its title in A1 at once: the bot's mark, then its
 * note and header, protected with a warning but for the Rating column); foreign (sh null) when a tab with its name
 * exists that the bot didn't make: that tab is never read or written.
 */
function ftTab_(ss, create) {
  let sh = ss.getSheetByName(FT_TAB_);
  if (sh) return isFtTab_(sh) ? { sh, foreign: false } : { sh: null, foreign: true };
  if (!create) return { sh: null, foreign: false };
  sh = ss.insertSheet(FT_TAB_, ss.getSheets().length);
  sh.getRange(1, 1).setValue(FT_TITLE_);
  sh.getRange(2, 1).setValue(FT_NOTE_);
  sh.getRange(FT_HEAD_ROW_, 1, 1, FT_HEADER_.length).setValues([FT_HEADER_]);
  try {
    sh.getRange(1, 1).setFontWeight('bold').setFontSize(12);
    sh.getRange(FT_HEAD_ROW_, 1, 1, FT_HEADER_.length).setFontWeight('bold');
    sh.setFrozenRows(FT_HEAD_ROW_);
    sh.hideColumns(FT_COL_.key);
    [130, 250, 90, 70, 150, 360, 90, 80, 90, 100, 260, 80, 80, 70, 70, 60, 260, 170, 110, 110, 80, 80, 120]
      .forEach((w, i) => sh.setColumnWidth(i + 1, w));
  } catch (e) { /* the tab works unformatted */ }
  try {
    sh.protect().setDescription('Written by the Burson QA bot (the Rating column is yours to fill in)').setWarningOnly(true)
      .setUnprotectedRanges([sh.getRange(FT_HEAD_ROW_ + 1, FT_COL_.rating, FT_MAX_ROWS_ + FT_TRIM_SLACK_ + 200, 1)]);
  } catch (e) { /* the tab works unprotected */ }
  return { sh, foreign: false };
}

/** A Fast triage tab text cell: one line, capped, and never read by Sheets as a formula. Pure. */
function ftCell_(v, max) {
  const raw = String(v === undefined || v === null ? '' : v);
  const s = truncate_(raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim(), max || FT_HEADLINE_CHARS_);
  if (!s) return '';
  return (/^[=+\-@]/.test(s) || /^[\x00-\x1f]/.test(raw)) ? '\'' + s : s;
}

/**
 * A Fast triage tab row. o: {row (the signal), dec (its answers or null), did (what the fast triage did with it),
 * review ({disposition, basis, confidence, severity} or null), card (its Alert-log id), kind ('r' reviewed, 'h' held
 * back, 'w' an early-watch story asked about)}. Every cell is short (the headline FT_HEADLINE_CHARS_ at most) and
 * escaped against formula injection. Pure (but for the clock).
 */
function ftTabRow_(o) {
  const r = (o && o.row) || {};
  const d = o && o.dec && typeof o.dec === 'object' ? o.dec : null;
  const rev = (o && o.review) || null;
  const sig = String(r.signal_type || 'CLUSTER_EMERGENCE').trim().toUpperCase();
  const num = v => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? '' : Number(v));
  const clean = (v, n) => truncate_(String(v === undefined || v === null ? '' : v).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim(), n);
  const out = new Array(FT_HEADER_.length).fill('');
  out[0] = Utilities.formatDate(new Date(Date.now()), (typeof GEN !== 'undefined' && GEN && GEN.timezone) || 'America/New_York',
    'yyyy-MM-dd HH:mm');
  out[1] = ftCell_(r.alert_id, 120);
  out[2] = ftCell_(sig === 'VELOCITY_SPIKE' ? 'Velocity' : typeof EWS_WATCH_SIGNAL_ !== 'undefined' && sig === EWS_WATCH_SIGNAL_ ? 'Early watch' : 'Cluster', 20);
  out[3] = num(r.unique_low_tier_authors);
  out[4] = ftCell_(r.platforms_csv, 120);
  out[5] = ftCell_(r.headline, FT_HEADLINE_CHARS_);
  if (d) {
    out[6] = num(d.g);
    out[7] = num(d.r);
    out[8] = num(d.i);
    out[9] = num(d.n);
    out[10] = ftCell_(d.c, 128);
    out[11] = num(d.cp);
    out[12] = num(d.p0);
    out[13] = num(d.s);
    out[14] = ftCell_(ED_SEVERITIES_[d.l] || '', 20);
    out[15] = num(d.sc);
  }
  out[16] = ftCell_(o && o.did, 300);
  if (rev) {
    out[17] = ftCell_(`${rev.disposition || ''}${rev.basis && rev.basis !== 'early_detection' ? ` (${String(rev.basis).replace(/_/g, ' ')})` : ''}`, 80);
    out[18] = num(rev.confidence);
    out[19] = ftCell_(rev.severity, 20);
  }
  out[20] = ftCell_(o && o.card, 40);
  out[FT_COL_.key - 1] = JSON.stringify({ id: clean(r.alert_id, 120), cid: clean(r.cluster_id, 64), k: clean((o && o.kind) || 'r', 8) || 'r' });
  return out.map(v => (typeof v === 'string' && v.length > SHEET_CELL_MAX_CHARS_ ? capCell_(v, SHEET_CELL_MAX_CHARS_) : v));
}

/**
 * Writes `rows` (ftTabRow_) under the Fast triage tab's last row, with the Rating dropdown, and trims the oldest past
 * FT_MAX_ROWS_ (once FT_TRIM_SLACK_ more have built up). {added, problem}: problem says why nothing was written (a tab
 * of that name the bot didn't make, or the sheet refused). Never throws.
 */
function ftTabAppend_(rows) {
  const list = (rows || []).filter(r => Array.isArray(r) && r.length === FT_HEADER_.length);
  if (!list.length) return { added: 0, problem: '' };
  try {
    const tab = ftTab_(openStore_(false), true);
    if (tab.foreign) {
      const problem = `not recording: a tab named "${FT_TAB_}" exists that the bot didn't make (rename it and the bot makes its own)`;
      console.warn('fast triage: ' + problem);
      return { added: 0, problem };
    }
    const sh = tab.sh;
    const at = Math.max(sh.getLastRow(), FT_HEAD_ROW_) + 1;
    sh.getRange(at, 1, list.length, FT_HEADER_.length).setValues(list);
    const ratingRule = () => SpreadsheetApp.newDataValidation().requireValueInList(FT_RATINGS_, true).build();
    try {
      sh.getRange(at, FT_COL_.rating, list.length, 1).setDataValidation(ratingRule());
    } catch (e) { /* the column works without its dropdown */ }
    const count = sh.getLastRow() - FT_HEAD_ROW_;
    if (count > FT_MAX_ROWS_ + FT_TRIM_SLACK_) {
      const all = sh.getRange(FT_HEAD_ROW_ + 1, 1, count, FT_HEADER_.length).getValues();
      const keep = all.slice(count - FT_MAX_ROWS_);
      sh.getRange(FT_HEAD_ROW_ + 1, 1, keep.length, FT_HEADER_.length).setValues(keep);
      const tail = sh.getRange(FT_HEAD_ROW_ + 1 + keep.length, 1, count - keep.length, FT_HEADER_.length);
      tail.clearContent();
      try {
        sh.getRange(FT_HEAD_ROW_ + 1, FT_COL_.rating, keep.length, 1).setDataValidation(ratingRule());
        const tailRating = sh.getRange(FT_HEAD_ROW_ + 1 + keep.length, FT_COL_.rating, count - keep.length, 1);
        if (typeof tailRating.clearDataValidations === 'function') tailRating.clearDataValidations();
      } catch (e) { /* the column works without its dropdown */ }
    }
    return { added: list.length, problem: '' };
  } catch (e) {
    console.warn('fast triage: could not write the Fast triage tab: ' + ((e && e.message) || e));
    return { added: 0, problem: 'the Fast triage tab couldn\'t be written' };
  }
}
