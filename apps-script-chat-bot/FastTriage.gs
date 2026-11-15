/**
 * FastTriage.gs — the fast-triage layer on the early-wave path (Control rows 38-45) and the early-wave BigQuery writer
 * (Control row 46): what the bot does with the Gemini Decisions answers about a signal (Decisions.gs asks; the full
 * Gemini review in EarlyDetection.gs still runs before every card, and nothing is posted on these answers).
 *
 * Switches on the Control tab, each OFF until a person turns it ON; rows 39 and 40 need row 38:
 *   Row 38  Fast triage (Gemini Decisions)       only enables rows 39 and 40. While rows 39 and 40 are OFF, no
 *                                                Decisions call is made and nothing is written.
 *   Row 39  Fast triage: rank and early watch    orders the queue by the Decisions answers (ftRank_), and runs the
 *                                                early-watch tier: a story below the promotion bar (EarlyWaveSource.gs)
 *                                                that passes the watch bars is emitted as an EARLY_WATCH signal
 *                                                (ewsWatchRaise_) and takes the normal route (queue, same-story dedup,
 *                                                full review, card that says it is an early signal and how many
 *                                                accounts it rests on).
 *   Row 40  Fast triage: hold back noise         drops a signal that meets the hold-back conditions without a review,
 *                                                counts it on Control C19 as filtered by fast triage, and logs it in
 *                                                one line with its ID, the reason and the probabilities (ftHoldWhy_).
 *   Row 46  Write early-wave records to BigQuery writes each check's stories, story posts, signals, signal events and
 *                                                Decisions verdicts to brand-social-central-data.early_wave.
 *
 * Bars on the Control tab (rows 41-45, read on each run; a blank or invalid cell uses its seed and C41:C45 says so):
 *   Row 41  Hold-back: about_google at or below                                         seed 0.10
 *   Row 42  Hold-back: routine_noise at or above                                        seed 0.90
 *   Row 43  Hold-back and early watch: answer confidence at or above                    seed 0.80
 *   Row 44  Early watch: about_google, brand_risk and independent_reports, each at or above  seed 0.80
 *   Row 45  Early watch: distinct accounts, at least                                    seed 3
 */

const FT_SWITCH_ = 'fastTriage';            // Control row 38: enables rows 39 and 40
const FT_RANK_SWITCH_ = 'fastTriageRank';   // Control row 39: rank by the answers, and the early-watch tier
const FT_HOLD_SWITCH_ = 'fastTriageHold';   // Control row 40: hold back noise
const EW_BQ_SWITCH_ = 'earlyWaveBq';        // Control row 46: write early-wave records to BigQuery

const EW_TRIAGE_HOLD_MAX_LEVEL_ = 1;        // the most probable severity level is none (0) or low (1)
const FT_BAR_SEEDS_ = { about: 0.10, noise: 0.90, conf: 0.80, watch: 0.80, accounts: 3 };
const FT_PROB_CHOICES_ = ['0.05', '0.10', '0.15', '0.20', '0.25', '0.30', '0.40', '0.50', '0.60', '0.70', '0.75', '0.80', '0.85', '0.90', '0.95'];
const FT_ACCOUNTS_CHOICES_ = ['2', '3', '4'];

const FT_BAR_SPECS_ = [
  { key: 'about', row: 41, label: 'Hold-back: about_google at or below', seed: 0.10, start: '0.10', seedText: '0.10', kind: 'prob',
    choices: FT_PROB_CHOICES_,
    using: v => `Hold-back (row 40) drops a low-severity signal when about_google is at or below ${v.toFixed(2)}` },
  { key: 'noise', row: 42, label: 'Hold-back: routine_noise at or above', seed: 0.90, start: '0.90', seedText: '0.90', kind: 'prob',
    choices: FT_PROB_CHOICES_,
    using: v => `Hold-back (row 40) drops a low-severity signal when routine_noise is at or above ${v.toFixed(2)}` },
  { key: 'conf', row: 43, label: 'Hold-back and early watch: answer confidence at or above', seed: 0.80, start: '0.80', seedText: '0.80', kind: 'prob',
    choices: FT_PROB_CHOICES_,
    using: v => `Hold-back (row 40) and early watch (row 39) require answer confidence at or above ${v.toFixed(2)}` },
  { key: 'watch', row: 44, label: 'Early watch: about_google, brand_risk and independent_reports, each at or above', seed: 0.80, start: '0.80', seedText: '0.80', kind: 'prob',
    choices: FT_PROB_CHOICES_,
    using: v => `Early watch (row 39) requires about_google, brand_risk and independent_reports each at or above ${v.toFixed(2)}` },
  { key: 'accounts', row: 45, label: 'Early watch: distinct accounts, at least', seed: 3, start: '3', seedText: '3', kind: 'int',
    choices: FT_ACCOUNTS_CHOICES_,
    using: v => `Early watch (row 39) looks at stories below the promotion bar with at least ${v} distinct accounts` },
];

const EW_WATCH_QUEUE_PER_DAY_ = 8;          // early-watch signals queued a day at most, of EW_MAX_PER_DAY_'s 40
const FT_ANSWER_CACHE_SEC_ = 3 * 3600;      // a signal's answers are kept as long as the producer's buffer keeps the signal
const FT_ANSWER_CACHE_PREFIX_ = 'ft1:';

const EW_BQ_DATASET_ = 'early_wave';
const EW_BQ_TABLES_ = ['story_snapshots', 'story_posts', 'signals', 'signal_events', 'triage_verdicts'];
const EW_BQ_STATE_PROP_ = 'EW_BQ_STATE';    // {day, written, dropped, until, why, table}: today's writes and any cooldown
const EW_BQ_PAUSE_MS_ = 15 * 60 * 1000;     // after an insert failure, writes pause for 15 minutes
const EW_BQ_MIN_LEFT_MS_ = 15 * 1000;       // a write starts only with this much of the run left
const EW_BQ_BATCH_MAX_ = 500;               // rows per insertAll request at most

// ---------------------------------------------------------------------------------------------------------------
// The switches and the Control tab bars (rows 41-45)
// ---------------------------------------------------------------------------------------------------------------

/** True when the fast triage is available this run (Control row 38): rows 39 and 40 may use it. Pure. */
function ftOn_(ctx) { return switchOn_(ctx, FT_SWITCH_); }

/** True when the answers order the queue and the early watch runs (row 39, with row 38). Pure. */
function ftRankOn_(ctx) { return ftOn_(ctx) && switchOn_(ctx, FT_RANK_SWITCH_); }

/** True when the fast triage may hold a signal back (row 40, with row 38). Pure. */
function ftHoldOn_(ctx) { return ftOn_(ctx) && switchOn_(ctx, FT_HOLD_SWITCH_); }

/** True when early-wave records are written to BigQuery this run (row 46, with row 19). Pure. */
function ewBqOn_(ctx) { return switchOn_(ctx, 'earlyWave') && switchOn_(ctx, EW_BQ_SWITCH_); }

/** Strict Google Sheets dropdown rule for bar `spec`. */
function ftBarRule_(spec) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(spec.choices, true)
    .setAllowInvalid(false)
    .build();
}

/** True when `cell` already carries `spec`'s strict dropdown so steady-state runs make zero writes. */
function ftBarValidationCurrent_(cell, spec) {
  if (!cell || typeof cell.getDataValidation !== 'function') return true;
  const rule = cell.getDataValidation();
  if (!rule) return false;
  const allow = typeof rule.getAllowInvalid === 'function' ? rule.getAllowInvalid() : !!rule.allowInvalid;
  if (allow) return false;
  const vals = typeof rule.getCriteriaValues === 'function' ? (rule.getCriteriaValues() || [])[0] : rule.values;
  return Array.isArray(vals) && vals.length === spec.choices.length && spec.choices.every((v, i) => vals[i] === v);
}

/**
 * Parses one bar cell (`raw`) for `spec` (FT_BAR_SPECS_): a blank or invalid cell uses `spec.seed` and its note says so.
 * Returns {value, blank, valid, note}. Pure.
 */
function ftBarFrom_(spec, raw) {
  const isDate = Object.prototype.toString.call(raw) === '[object Date]';
  const text = isDate ? '' : String(raw === undefined || raw === null ? '' : raw).trim();
  if (!isDate && !text) {
    return {
      value: spec.seed,
      blank: true,
      valid: false,
      note: `Blank: using seed ${spec.start} (${spec.using(spec.seed)})`,
    };
  }
  const numOk = typeof raw === 'number' || (!isDate && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text));
  const n = numOk ? Number(raw) : NaN;
  if (spec.kind === 'int') {
    const r = Math.round(n);
    if (!numOk || !isFinite(n) || Math.floor(n) !== n || r < 2 || r >= EWS_MIN_AUTHORS_) {
      return {
        value: spec.seed,
        blank: false,
        valid: false,
        note: `\u26a0\ufe0f Couldn't use "${truncate_(text || String(raw), 40)}": using seed ${spec.start} (${spec.using(spec.seed)}). Choose 2, 3 or 4.`,
      };
    }
    return { value: r, blank: false, valid: true, note: `\u2713 ${spec.using(r)}` };
  }
  if (!numOk || !isFinite(n) || n <= 0 || n >= 1) {
    return {
      value: spec.seed,
      blank: false,
      valid: false,
      note: `\u26a0\ufe0f Couldn't use "${truncate_(text || String(raw), 40)}": using seed ${spec.start} (${spec.using(spec.seed)}). Enter a probability between 0.01 and 0.99.`,
    };
  }
  const v = Math.round(n * 100) / 100;
  return { value: v, blank: false, valid: true, note: `\u2713 ${spec.using(v)}` };
}

/** Parses all five bar cells (`raw`: {about, noise, conf, watch, accounts}) into {bars, values, details}. Pure. */
function ftBarsFrom_(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const bars = {};
  const details = {};
  FT_BAR_SPECS_.forEach(spec => {
    const parsed = ftBarFrom_(spec, r[spec.key]);
    bars[spec.key] = parsed.value;
    details[spec.key] = parsed;
  });
  return { bars, values: bars, details };
}

/**
 * Ensures rows 41-45 (the fast-triage bars) exist on the Control tab with their seeds and strict dropdowns; preserves
 * any value a person set in B41:B45.
 */
function ensureFtBarRows_(sh) {
  if (!sh) return;
  const first = FT_BAR_SPECS_[0].row;
  const grid = sh.getRange(first, 1, FT_BAR_SPECS_.length, 2).getValues();
  let changed = false;
  FT_BAR_SPECS_.forEach((spec, idx) => {
    const rowVals = grid[idx] || [];
    const label = String(rowVals[0] || '').trim();
    const cell = sh.getRange(spec.row, 2);
    if (label === spec.label) {
      if (!ftBarValidationCurrent_(cell, spec)) {
        cell.setDataValidation(ftBarRule_(spec));
        changed = true;
      }
      return;
    }
    const b = rowVals[1];
    const had = Object.prototype.toString.call(b) === '[object Date]' ? b : String(b === undefined || b === null ? '' : b).trim();
    const value = had === '' ? spec.start : had;
    sh.getRange(spec.row, 1, 1, 3).setValues([[spec.label, value, ftBarFrom_(spec, value).note]]);
    sh.getRange(spec.row, 1).setFontWeight('bold');
    cell.setBackground('#fff8e1').setDataValidation(ftBarRule_(spec));
    changed = true;
  });
  if (changed) writeControlHelp_(sh);
}

/** Reads B41:B45 from the Control tab as {about, noise, conf, watch, accounts} ('' where a row isn't its bar yet). */
function readFtBars_(sh) {
  const out = {};
  FT_BAR_SPECS_.forEach(spec => { out[spec.key] = ''; });
  if (!sh) return out;
  try {
    const first = FT_BAR_SPECS_[0].row;
    const grid = sh.getRange(first, 1, FT_BAR_SPECS_.length, 2).getValues();
    FT_BAR_SPECS_.forEach((spec, idx) => {
      const r = grid[idx] || [];
      if (String(r[0] || '').trim() !== spec.label) return;
      out[spec.key] = Object.prototype.toString.call(r[1]) === '[object Date]' ? r[1]
        : String(r[1] === undefined || r[1] === null ? '' : r[1]).trim();
    });
  } catch (e) {}
  return out;
}

/** Resolves B41:B45 (`raw`) for this run and updates C41:C45 when changed. Never throws. */
function ftBarsFor_(raw, sh) {
  const out = ftBarsFrom_(raw);
  if (sh) {
    try {
      FT_BAR_SPECS_.forEach(spec => {
        const note = out.details[spec.key].note;
        const cell = sh.getRange(spec.row, 3);
        if (String(cell.getValue() || '') !== String(note || '')) cell.setValue(note || '');
      });
    } catch (e) {
      console.error('could not write C41:C45 (fast-triage bars): ' + ((e && e.message) || e));
    }
  }
  return out;
}

/**
 * The current bars ({about, noise, conf, watch, accounts}): from `ctx.ftBars` when given, else read from the Control
 * tab's B41:B45 (falling back to FT_BAR_SEEDS_ for any blank or invalid cell). Never turns a feature off. Pure when
 * `ctx` carries `ftBars`.
 */
function ftBars_(ctx) {
  if (ctx && ctx.ftBars && typeof ctx.ftBars === 'object') {
    const out = Object.assign({}, FT_BAR_SEEDS_);
    Object.keys(FT_BAR_SEEDS_).forEach(k => {
      const v = Number(ctx.ftBars[k]);
      if (isFinite(v) && v > 0) out[k] = v;
    });
    return out;
  }
  try {
    const ss = openStore_(false);
    const sh = ss ? controlTab_(ss) : null;
    if (sh) return ftBarsFrom_(readFtBars_(sh)).bars;
  } catch (e) {}
  return Object.assign({}, FT_BAR_SEEDS_);
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
 * Why the fast triage holds signal `row` back without a review on answers `dec` ('' when it doesn't): no P0 risk group;
 * no taxonomy hint raised it; its severity is one of the two lowest levels; answer confidence is at or above `b.conf`;
 * and `about_google` is at or below `b.about` or `routine_noise` is at or above `b.noise`. Pure.
 */
function ftHoldWhy_(row, dec, bars) {
  const b = Object.assign({}, FT_BAR_SEEDS_, bars || ftBars_());
  if (!dec || ftProtected_(row)) return '';
  if (!(Number(dec.l) <= EW_TRIAGE_HOLD_MAX_LEVEL_) || !(Number(dec.sc) >= b.conf)) return '';
  const level = ED_SEVERITIES_[dec.l] || String(dec.l);
  if (Number(dec.g) <= b.about) return `not about Google (about Google ${dec.g}, severity ${level} ${dec.sc})`;
  if (Number(dec.n) >= b.noise) return `routine noise (routine noise ${dec.n}, severity ${level} ${dec.sc})`;
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
 * This check's fast triage, or null when nothing that is ON uses the answers (row 38 OFF, or rows 39 and 40 both OFF):
 * {session (decSession_), rank, hold, bars (ftBars_), log, asked, missed: {why: count}, held, watch: {asked, raised},
 * verdicts: [triage_verdicts rows]}. `left`: () => ms of the run left.
 */
function ftStart_(ctx, left) {
  const rank = ftRankOn_(ctx);
  const hold = ftHoldOn_(ctx);
  if (!rank && !hold) return null;
  return {
    session: decSession_(left, !!(ctx && ctx.slaBusy)),
    rank,
    hold,
    bars: ftBars_(ctx),
    now: () => (ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now()),
    log: msg => { if (ctx && typeof ctx.log === 'function') ctx.log(msg); },
    asked: 0,
    missed: {},
    held: 0,
    watch: { asked: 0, raised: 0 },
    verdicts: [],
  };
}

/**
 * What the producer is asked for with the fast triage running (EarlyWaveSource.gs ewsRows_'s opts): each new row's risk
 * groups and taxonomy raise (`facts`), and, only with the ranking ON (row 39), the early watch: its `bars`, `ask` (the
 * six questions about a story still below the promotion bar, within this check's session) and `done` (each story asked
 * about: one log line, and one verdict for early_wave.triage_verdicts).
 */
function ftProducerOpts_(ft, record) {
  const opts = { facts: true };
  if (record) opts.record = record;
  if (!ft || !ft.rank) return opts;
  opts.watch = {
    bars: ft.bars,
    ask: row => {
      const res = decSignalAsk_(row, ft.session);
      if (res.ok) ft.asked++;
      return res;
    },
    done: (row, res, raised) => {
      const n = ewCount_(row.unique_low_tier_authors);
      const at = `${fmtInt_(n)} account${n === 1 ? '' : 's'}`;
      ft.watch.asked++;
      ft.verdicts.push(ewBqVerdictRow_('watch_story', row, res, raised ? 'emitted' : (res && res.ok ? 'not_emitted' : null), ft.now()));
      if (!res.ok) {
        const why = String(res.why || 'no answer');
        ft.missed[why] = (ft.missed[why] || 0) + 1;
        return;
      }
      if (raised) ft.watch.raised++;
      ft.log(`fast triage: early story ${row.alert_id || ''} (${at}) \u00b7 ${ftAnswerWords_(res.dec)} \u00b7 ` +
        `${raised ? 'raised' : 'not raised'} \u00b7 ${res.ms} ms`);
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
 * early-watch story's, asked when it was raised) or that an earlier check kept are used as they are; a new call is
 * logged in one line and recorded in `ft.verdicts` when a call was attempted. Never throws.
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
      ft.verdicts.push(ewBqVerdictRow_('signal', r, res, ft.rank ? 'ranked' : 'kept', ft.now()));
      ft.log(`fast triage: ${id || 'a signal'} \u00b7 ${ftAnswerWords_(res.dec)} \u00b7 ${res.ms} ms`);
      return res.dec;
    }
    if (!res.skipped) {
      ft.verdicts.push(ewBqVerdictRow_('signal', r, res, null, ft.now()));
    }
    const why = String(res.why || 'no answer');
    ft.missed[why] = (ft.missed[why] || 0) + 1;
    return null;
  } catch (e) {
    return null;
  }
}

/** Marks the verdict for `row` in `ft.verdicts` as `'held_back'` when row 40 holds the signal back. Never throws. */
function ftNoteHeldVerdict_(ft, row) {
  if (!ft || !Array.isArray(ft.verdicts) || !row) return;
  const id = String(row.alert_id || '');
  for (let i = ft.verdicts.length - 1; i >= 0; i--) {
    const v = ft.verdicts[i];
    if (v && v.json && v.json.subject_type === 'signal' && v.json.alert_id === id) {
      v.json.action = 'held_back';
      return;
    }
  }
}

/**
 * Ends a check's fast triage: one log line for the signals that went on without an answer, and row 38's Control note
 * (C38): the day's calls, and a pause and its reason (decStatusText_). Never throws.
 */
function ftFinish_(ft, props) {
  if (!ft) return;
  try {
    const missed = Object.keys(ft.missed);
    if (missed.length) {
      ft.log(`fast triage: ${missed.map(w => `${ft.missed[w]} signal${ft.missed[w] === 1 ? '' : 's'} without an answer (${w})`).join('; ')}` +
        ': handled as before');
    }
    const parts = [`last check ${nowLabel_()}`, decStatusText_(props, Date.now())];
    if (ft.watch.asked) parts.push(`${ft.watch.asked} early ${ft.watch.asked === 1 ? 'story' : 'stories'} asked about`);
    noteSwitch_(FT_SWITCH_, parts.filter(Boolean).join(' \u00b7 '));
  } catch (e) {
    console.warn('fast triage: could not finish the check: ' + ((e && e.message) || e));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Early-wave BigQuery writer: brand-social-central-data.early_wave (Control row 46)
// ---------------------------------------------------------------------------------------------------------------

/** Deterministic insertId (<= 128 chars) for `kind` and `key` so a retry never duplicates a row. Pure. */
function ewBqId_(kind, key) {
  const clean = String(key || '').replace(/[^A-Za-z0-9_.:|-]+/g, '_');
  const full = `ew:${kind}:${clean}`;
  return full.length <= 120 ? full : `ew:${kind}:${hashText_(String(key || ''))}:${clean.slice(0, 64)}`;
}

/** Timestamp ms -> RFC 3339 UTC string for BigQuery TIMESTAMP columns, or null when missing/invalid. Pure. */
function ewBqIso_(ms) {
  const n = Number(ms);
  return isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/** Parses a timestamp string ('2026-11-13 15:10:00 UTC' or ISO) or ms into RFC 3339 UTC, or `fallbackMs`. Pure. */
function ewBqTs_(v, fallbackMs) {
  if (typeof v === 'number' && isFinite(v) && v > 0) return new Date(v).toISOString();
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (s) {
    const norm = s.replace(/\s+UTC$/i, 'Z').replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/, '$1T$2');
    const ms = Date.parse(norm);
    if (isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  return fallbackMs ? ewBqIso_(fallbackMs) : null;
}

/** Integer for BigQuery INT64 columns, or null when missing/invalid. Pure. */
function ewBqInt_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? Math.round(n) : null;
}

/** Float for BigQuery FLOAT64 columns, or null when missing/invalid. Pure. */
function ewBqFloat_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** Public post snippet / label / reason with any email address stripped, capped to `max` chars, or null when empty. Pure. */
function ewBqText_(v, max) {
  const s = String(v === undefined || v === null ? '' : v)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? truncate_(s, max || 500) : null;
}

/** Canonical URL without tracking query parameters, or null when empty. Pure. */
function ewBqUrl_(u) {
  const raw = String(u === undefined || u === null ? '' : u).trim();
  if (!raw) return null;
  const canon = typeof ewsCanonUrl_ === 'function' ? ewsCanonUrl_(raw) : raw.replace(/[?#].*$/, '');
  return canon || raw;
}

/** Account key with any email address or raw @handle hashed so no display name or @handle is stored, or null when empty. Pure. */
function ewBqAccountKey_(ak, platform) {
  const raw = String(ak === undefined || ak === null ? '' : ak).trim();
  if (!raw) return null;
  const parts = raw.split(/[|:]/);
  const plat = String(platform || (parts.length > 1 ? parts[0] : 'acct')).trim().toLowerCase() || 'acct';
  const idPart = (parts.length > 1 ? parts.slice(1).join(':') : raw).trim().toLowerCase();
  return `${plat}:${hashText_(idPart || raw.toLowerCase())}`;
}

/** One row for `early_wave.story_snapshots` from a live story `s` ({c, w, stage, priority, taxonomy_hint, baseline, ratio}) at `now`. Pure. */
function ewBqSnapshotRow_(s, now) {
  const c = (s && s.c) || (s && s.cluster_id ? { id: s.cluster_id, t0: s.created_at, t1: s.last_post_at, lab: s.label, m: [] } : {});
  const w = (s && s.w) || {};
  const snapAt = ewBqTs_(s && s.snapshot_at, now) || ewBqIso_(now);
  const cid = String(c.id || (s && s.cluster_id) || '');
  const members = Array.isArray(c.m) ? c.m : [];
  const last60m = new Set(members.filter(m => m && now - (Number(m.t) || 0) <= 3600 * 1000 && (Number(m.t) || 0) <= now + 5 * 60000).map(m => m.a)).size;
  const vec = typeof ewsCentroid_ === 'function' ? ewsCentroid_(c) : null;
  const centroid = vec && vec.length ? Array.from(vec, x => Math.round((Number(x) || 0) * 1e6) / 1e6) : [];
  const reach = members.reduce((sum, m) => sum + (isFinite(Number(m && m.f)) && Number(m.f) > 0 ? Math.round(Number(m.f)) : 0), 0);
  const eng = members.reduce((sum, m) => sum + (isFinite(Number(m && m.e)) && Number(m.e) > 0 ? Math.round(Number(m.e)) : 0), 0);
  const risk = Array.isArray(w.risk) ? w.risk.filter(Boolean) : [];
  const platforms = Array.isArray(w.platforms) ? w.platforms.filter(Boolean) : [];
  return {
    insertId: ewBqId_('ss', `${cid}:${snapAt}`),
    json: {
      snapshot_at: snapAt,
      cluster_id: cid,
      created_at: ewBqIso_(c.t0),
      last_post_at: ewBqIso_(w.end || c.t1),
      label: ewBqText_(c.lab, 300),
      topic_product: (typeof ewsStoryTopic_ === 'function' ? ewsStoryTopic_(c) : null) || null,
      risk_groups: risk,
      priority_hint: String((s && s.priority) || (risk.length || platforms.length >= 2 ? 'P1' : 'P2')),
      stage: String((s && s.stage) || 'watching'),
      distinct_accounts: ewBqInt_(w.authors !== undefined ? w.authors : (s && s.author_count !== undefined ? s.author_count : new Set(members.map(m => m.a)).size)),
      post_count: members.length,
      platforms,
      distinct_urls: ewBqInt_(w.urls !== undefined ? w.urls : new Set(members.map(m => m.u).filter(Boolean)).size),
      audience_reach: reach,
      engagement: eng,
      accounts_last_60m: last60m,
      baseline_accounts: ewBqFloat_(s && s.baseline),
      velocity_ratio: ewBqFloat_(s && s.ratio),
      taxonomy_hint: ewBqText_(s && s.taxonomy_hint, 300),
      centroid,
    },
  };
}

/** One row for `early_wave.story_posts` when member `m` (ewsMember_) first joins story `cid`. Pure. */
function ewBqPostRow_(cid, m, now) {
  const joinedAt = ewBqIso_(m && m.j ? m.j : now);
  const pid = String((m && m.i) || '');
  const risk = m && m.r ? String(m.r).split(',').map(s => s.trim()).filter(Boolean) : [];
  return {
    insertId: ewBqId_('sp', `${cid}:${pid}`),
    json: {
      joined_at: joinedAt,
      cluster_id: String(cid || ''),
      post_id: pid,
      account_key: ewBqAccountKey_(m && m.a),
      platform: String((m && m.p) || '') || null,
      url: ewBqUrl_(m && m.u),
      posted_at: ewBqIso_(m && m.t),
      snippet: ewBqText_(m && m.s, EWS_KEEP_CHARS_),
      similarity: ewBqFloat_(m && m.d),
      content_hash: String((m && m.h) || '') || null,
      topic: String((m && m.tp) || '') || null,
      audience: ewBqInt_(m && m.f),
      engagement: ewBqInt_(m && m.e),
      risk_groups: risk,
      names_google: Boolean(m && m.b),
      slow_lane: Boolean(m && m.sl),
    },
  };
}

/** One row for `early_wave.signals` when signal `r` (EarlyWaveRow) is created. Pure. */
function ewBqSignalRow_(r, now) {
  const row = r || {};
  const id = String(row.alert_id || '');
  const sig = String(row.signal_type || 'CLUSTER_EMERGENCE').trim().toUpperCase();
  const isVel = sig === 'VELOCITY_SPIKE';
  let rawPosts = [];
  if (Array.isArray(row.posts)) {
    rawPosts = row.posts;
  } else {
    try { rawPosts = JSON.parse(String(row.representative_posts_json || '[]')) || []; } catch (e) { rawPosts = []; }
  }
  const repPosts = (Array.isArray(rawPosts) ? rawPosts : []).slice(0, ED_POSTS_MAX_).map(p => ({
    post_id: String((p && (p.mention_id || p.post_id || p.id)) || '') || null,
    platform: String((p && p.platform) || '') || null,
    account_key: ewBqAccountKey_(p && (p.author_id || p.account_key || p.author), p && p.platform),
    audience: ewBqInt_(p && (p.audience_size !== undefined ? p.audience_size : p.audience)),
    engagement: ewBqInt_(p && p.engagement),
    posted_at: ewBqTs_(p && (p.posted_at || p.published_at), null),
    url: ewBqUrl_(p && p.url),
    snippet: ewBqText_(p && (p.snippet || p.text), EWS_SNIPPET_CHARS_),
  }));
  const platforms = String(row.platforms_csv || '').split(',').map(s => s.trim()).filter(Boolean);
  const updId = String(row.update_of_alert_id || (row.update_of && row.update_of.id) || '') || null;
  const updAu = updId ? ewBqInt_(row.update_of_authors || (row.update_of && row.update_of.authors)) : null;
  return {
    insertId: ewBqId_('sig', id),
    json: {
      created_at: ewBqTs_(row.created_utc, Number(row._at) || now),
      alert_id: id,
      signal_type: sig,
      velocity_grain: String(row.velocity_grain || '') || null,
      cluster_id: String(row.cluster_id || '') || null,
      signal_key: String(row.signal_key || '') || null,
      headline: ewBqText_(row.headline, 300),
      topic_product: String(row.topic_product || '') || null,
      priority_hint: String(row.priority_hint || '') || null,
      distinct_accounts: ewBqInt_(row.unique_low_tier_authors),
      mention_count: ewBqInt_(row.mention_count),
      platforms,
      baseline_accounts: isVel ? ewBqFloat_(row.baseline_authors) : null,
      velocity_ratio: isVel ? ewBqFloat_(row.velocity_ratio) : null,
      account_delta: isVel ? ewBqFloat_(row.absolute_author_delta) : null,
      primary_url: ewBqUrl_(row.primary_url),
      window_start: ewBqTs_(row.window_start_utc, null),
      window_end: ewBqTs_(row.window_end_utc, null),
      representative_posts: repPosts,
      update_of_alert_id: updId,
      update_of_accounts: updAu,
      taxonomy_hint: ewBqText_(row.taxonomy_hint, 300),
    },
  };
}

/** One row for `early_wave.signal_events`: `event` on signal `alertId` (`clusterId`), with optional `reason` and `detail`. Pure. */
function ewBqEventRow_(alertId, clusterId, event, reason, detail, now, suffix) {
  const id = String(alertId || '');
  const ev = String(event || '');
  return {
    insertId: ewBqId_('ev', `${id}:${ev}${suffix ? ':' + suffix : ''}`),
    json: {
      event_at: ewBqIso_(now),
      alert_id: id,
      cluster_id: String(clusterId || '') || null,
      event: ev,
      reason: ewBqText_(reason, 300),
      detail: detail && typeof detail === 'object' ? JSON.stringify(detail) : null,
    },
  };
}

/** One row for `early_wave.triage_verdicts` from one Decisions call (`res` on `row`, `subjectType`: 'signal' | 'watch_story'). Pure. */
function ewBqVerdictRow_(subjectType, row, res, action, now) {
  const r = row || {};
  const ok = !!(res && res.ok && res.dec);
  const d = ok ? res.dec : null;
  const id = String(r.alert_id || '');
  const cid = String(r.cluster_id || '');
  return {
    insertId: ewBqId_('tv', `${subjectType}:${id || cid}:${now}`),
    json: {
      asked_at: ewBqIso_(now),
      subject_type: String(subjectType || 'signal'),
      alert_id: id || null,
      cluster_id: cid || null,
      model: DEC_MODEL_,
      latency_ms: ewBqInt_(res && res.ms),
      input_tokens: ok && res.tokens ? ewBqInt_(res.tokens) : null,
      ok,
      failure: ok ? null : ewBqText_(res && res.why, 240),
      about_google: d ? ewBqFloat_(d.g) : null,
      brand_risk: d ? ewBqFloat_(d.r) : null,
      independent_reports: d ? ewBqFloat_(d.i) : null,
      routine_noise: d ? ewBqFloat_(d.n) : null,
      category: d ? (String(d.c || '') || null) : null,
      severity_score: d ? ewBqFloat_(d.s) : null,
      severity_level: d ? (ED_SEVERITIES_[d.l] || null) : null,
      action: action ? String(action) : null,
      raw: ok && res.answers ? JSON.stringify(res.answers) : null,
    },
  };
}

/** Today's early-wave BigQuery writer state ({day, written, dropped, until, why, table}). Never throws. */
function ewBqState_(props, now) {
  const day = dayKey_();
  let s = null;
  try { s = JSON.parse(props.getProperty(EW_BQ_STATE_PROP_) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  const num = v => Math.max(0, Math.floor(Number(v) || 0));
  const until = num(s.until);
  const paused = until > (Number(now) || Date.now());
  const same = s.day === day;
  return {
    day,
    written: same ? num(s.written) : 0,
    dropped: same ? num(s.dropped) : 0,
    until: paused ? until : 0,
    why: paused || same ? String(s.why || '') : '',
    table: paused || same ? String(s.table || '') : '',
  };
}

/** Saves today's early-wave BigQuery writer state. Never throws. */
function ewBqSaveState_(props, st) {
  try {
    props.setProperty(EW_BQ_STATE_PROP_, JSON.stringify(st));
  } catch (e) {
    console.error('early wave BigQuery: could not save state: ' + ((e && e.message) || e));
  }
}

/** Row 46's Control note text from `st` (ewBqState_). Pure. */
function ewBqStatusText_(st, now) {
  const t = Number(now) || Date.now();
  const parts = [];
  if (st.written) parts.push(`${fmtInt_(st.written)} row${st.written === 1 ? '' : 's'} written today`);
  if (st.dropped) parts.push(`${fmtInt_(st.dropped)} dropped`);
  if (st.until > t) {
    const tz = (typeof GEN !== 'undefined' && GEN && GEN.timezone) || 'America/New_York';
    parts.push(`\u26a0\ufe0f paused until ${Utilities.formatDate(new Date(st.until), tz, 'h:mm a')}` +
      `${st.table ? ` (${st.table}${st.why ? ': ' + st.why : ''})` : st.why ? ` (${st.why})` : ''}`);
  } else if (st.why) {
    parts.push(`\u26a0\ufe0f last error${st.table ? ` on ${st.table}` : ''}: ${st.why}`);
  }
  return parts.join(' \u00b7 ');
}

/**
 * Sends at most one batched `bqInsertAll_` request for `early_wave.${table}` with `rows`. Background work: skipped while
 * SLA triage is busy, inside the run deadline, under `ApiGuard.gs` BigQuery ceilings, and paused after an error. Never
 * throws or queues dropped rows in script properties.
 */
function ewBqWriteTable_(ctx, props, left, table, rows) {
  const list = (rows || []).filter(r => r && r.insertId && r.json).slice(0, EW_BQ_BATCH_MAX_);
  if (!list.length) return;
  if (EW_BQ_TABLES_.indexOf(table) < 0) return;
  const log = msg => { if (ctx && typeof ctx.log === 'function') ctx.log(msg); };
  const now = ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now();
  const st = ewBqState_(props, now);
  const skip = (ctx && ctx.slaBusy) ? 'SLA triage is busy'
    : st.until > now ? `paused after an error on ${st.table || 'early_wave'}${st.why ? ` (${st.why})` : ''}`
      : left() < EW_BQ_MIN_LEFT_MS_ ? 'too little of the run left'
        : typeof apiGuardAllowBackground_ === 'function' && !apiGuardAllowBackground_('bigquery', !!(ctx && ctx.slaBusy))
          ? 'BigQuery background ceiling reached'
          : '';
  if (skip) {
    st.dropped += list.length;
    ewBqSaveState_(props, st);
    log(`early wave BigQuery: dropped ${list.length} row(s) for ${EW_BQ_DATASET_}.${table} (${skip})`);
    noteSwitch_(EW_BQ_SWITCH_, ewBqStatusText_(st, now));
    return;
  }
  if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', 1);
  try {
    bqInsertAll_(`${EW_BQ_DATASET_}.${table}`, list);
    st.written += list.length;
    ewBqSaveState_(props, st);
    noteSwitch_(EW_BQ_SWITCH_, ewBqStatusText_(st, now));
  } catch (e) {
    const why = truncate_(String((e && e.message) || e).replace(/\s+/g, ' ').trim(), 120) || 'insert failed';
    st.dropped += list.length;
    st.until = now + EW_BQ_PAUSE_MS_;
    st.table = table;
    st.why = why;
    ewBqSaveState_(props, st);
    log(`early wave BigQuery: couldn't write ${list.length} row(s) to ${EW_BQ_DATASET_}.${table} (dropped): ${why}; writes paused for ${Math.round(EW_BQ_PAUSE_MS_ / 60000)} minutes`);
    noteSwitch_(EW_BQ_SWITCH_, ewBqStatusText_(st, now));
  }
}

/**
 * Flushes a check's batched rows (`batches`: {story_snapshots, story_posts, signals, signal_events, triage_verdicts}) to
 * `brand-social-central-data.early_wave`: at most one insert request per table. Never throws.
 */
function ewBqFlush_(ctx, props, left, batches) {
  if (!ewBqOn_(ctx) || !batches) return;
  try {
    const sent = (ctx._ewBqSentTables = ctx._ewBqSentTables || new Set());
    EW_BQ_TABLES_.forEach(table => {
      const rows = batches[table];
      if (!Array.isArray(rows) || !rows.length || sent.has(table)) return;
      sent.add(table);
      ewBqWriteTable_(ctx, props, left, table, rows);
    });
  } catch (e) {
    console.warn('early wave BigQuery: flush failed: ' + ((e && e.message) || e));
  }
}
