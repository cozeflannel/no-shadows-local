/**
 * FastTriage.gs — the fast-triage layer on the early-wave path (Control rows 38-45 and 47) and the early-wave BigQuery
 * writer (Control row 46): what the bot does with the Gemini Decisions answers about a signal (Decisions.gs asks; the
 * full Gemini review in EarlyDetection.gs still runs before every card, and nothing is posted on these answers).
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
 *                                                counts it on Control C19 among the signals let go, and logs it in
 *                                                one line with its ID, the reason and the probabilities (ftHoldWhy_).
 *   Row 46  Write early-wave records to BigQuery writes each check's stories, story posts, signals, signal events and
 *                                                Decisions verdicts to brand-social-central-data.early_wave.
 *
 * Bars on the Control tab (rows 41-45 and 47, read on each run; a blank or invalid cell uses its seed and column C
 * says so). The seeds come from the eight real signals of Nov 6-12, 2026 in test/decisions_fixtures.json (3 risks,
 * 5 noise): at them the early watch raises 2 of the 3 risks and the hold-back drops 3 of the 5 noise signals and
 * none of the risks.
 *   Row 41  Hold-back: about_google at or below                        seed 0.10
 *   Row 42  Hold-back: routine_noise at or above                       seed 0.90
 *   Row 43  Hold-back and early watch: answer confidence at or above   seed 0.55
 *   Row 44  Early watch: about_google and brand_risk, each at or above seed 0.80
 *   Row 45  Early watch: distinct accounts, at least                   seed 3
 *   Row 47  Early watch: independent_reports at or above               seed 0.30 (its own cell: few accounts tell an
 *                                                                      early story, so this answer runs low on real risks)
 */

const FT_SWITCH_ = 'fastTriage';            // Control row 38: enables rows 39 and 40
const FT_RANK_SWITCH_ = 'fastTriageRank';   // Control row 39: rank by the answers, and the early-watch tier
const FT_HOLD_SWITCH_ = 'fastTriageHold';   // Control row 40: hold back noise
const EW_BQ_SWITCH_ = 'earlyWaveBq';        // Control row 46: write early-wave records to BigQuery

const EW_TRIAGE_HOLD_MAX_LEVEL_ = 1;        // the most probable severity level is none (0) or low (1)
const FT_BAR_SEEDS_ = { about: 0.10, noise: 0.90, conf: 0.55, watch: 0.80, accounts: 3, independent: 0.30 };
// 0.05 to 0.95 in steps of 0.05
const FT_PROB_CHOICES_ = Array.from({ length: 19 }, (_, i) => ((i + 1) * 0.05).toFixed(2));
const FT_ACCOUNTS_CHOICES_ = ['2', '3', '4'];
// Seeds that changed after a build wrote them into the cells: a cell still at the old seed moves to the new one, once
// (FT_BAR_SEED_VERSION_ in script property FT_BAR_SEED_PROP_); any other value is a person's and is kept.
const FT_BAR_SEED_PROP_ = 'FT_BAR_SEED_VERSION';
const FT_BAR_SEED_VERSION_ = 2;
const FT_BAR_RESEEDS_ = [{ key: 'conf', from: 0.80 }];

const FT_BAR_SPECS_ = [
  { key: 'about', row: 41, label: 'Hold-back: about_google at or below', seed: 0.10, start: '0.10', seedText: '0.10', kind: 'prob',
    choices: FT_PROB_CHOICES_,
    using: v => `Hold-back (row 40) drops a low-severity signal when about_google is at or below ${v.toFixed(2)}` },
  { key: 'noise', row: 42, label: 'Hold-back: routine_noise at or above', seed: 0.90, start: '0.90', seedText: '0.90', kind: 'prob',
    choices: FT_PROB_CHOICES_,
    using: v => `Hold-back (row 40) drops a low-severity signal when routine_noise is at or above ${v.toFixed(2)}` },
  { key: 'conf', row: 43, label: 'Hold-back and early watch: answer confidence at or above', seed: 0.55, start: '0.55', seedText: '0.55', kind: 'prob',
    choices: FT_PROB_CHOICES_,
    using: v => `Hold-back (row 40) and early watch (row 39) require answer confidence at or above ${v.toFixed(2)}` },
  { key: 'watch', row: 44, label: 'Early watch: about_google and brand_risk, each at or above', seed: 0.80, start: '0.80', seedText: '0.80', kind: 'prob',
    choices: FT_PROB_CHOICES_,
    using: v => `Early watch (row 39) requires about_google and brand_risk each at or above ${v.toFixed(2)}` },
  { key: 'accounts', row: 45, label: 'Early watch: distinct accounts, at least', seed: 3, start: '3', seedText: '3', kind: 'int',
    choices: FT_ACCOUNTS_CHOICES_,
    using: v => `Early watch (row 39) looks at stories below the promotion bar with at least ${v} distinct accounts` },
  // Row 47, below the BigQuery switch (46): rows 41-46 were on the tab before this bar had a cell of its own
  { key: 'independent', row: 47, label: 'Early watch: independent_reports at or above', seed: 0.30, start: '0.30', seedText: '0.30', kind: 'prob',
    choices: FT_PROB_CHOICES_,
    using: v => `Early watch (row 39) requires independent_reports at or above ${v.toFixed(2)}` },
];
const FT_BAR_FIRST_ROW_ = Math.min.apply(null, FT_BAR_SPECS_.map(s => s.row));
const FT_BAR_LAST_ROW_ = Math.max.apply(null, FT_BAR_SPECS_.map(s => s.row));

const EW_WATCH_QUEUE_PER_DAY_ = 8;          // early-watch signals queued a day at most, of EW_MAX_PER_DAY_'s 40 (or of the allowance's)
const FT_ANSWER_CACHE_SEC_ = 3 * 3600;      // a signal's answers are kept as long as the producer's buffer keeps the signal
const FT_ANSWER_CACHE_PREFIX_ = 'ft1:';

const EW_BQ_DATASET_ = 'early_wave';
const EW_BQ_TABLES_ = ['story_snapshots', 'story_posts', 'signals', 'signal_events', 'triage_verdicts'];
const EW_BQ_STATE_PROP_ = 'EW_BQ_STATE';    // {day, written, dropped, pauses: {table: {until, why}}}: today's writes and each table's cooldown
const EW_BQ_PAUSE_MS_ = 15 * 60 * 1000;     // after an insert failure, writes to that table pause for 15 minutes
const EW_BQ_MIN_LEFT_MS_ = 15 * 1000;       // a write starts only with this much of the run left
const EW_BQ_BATCH_MAX_ = 500;               // rows per insertAll request at most
const EW_BQ_SIG_CACHE_PREFIX_ = 'ewbq1:';   // script cache: a signal whose early_wave.signals row BigQuery took
const EW_BQ_SIG_CACHE_SEC_ = 6 * 3600;      // longer than a signal waits in the producer's buffer (3 hours)

/**
 * The columns each row builder below writes, as the BigQuery API names their types (tables.get): '!' REQUIRED, '[]'
 * REPEATED. bqInsertAll_ refuses a whole batch for one column the table doesn't have, so this list is what
 * LiveVerify.gs verifyEarlyWaveBqLive() holds against the live tables before row 46 is turned ON, and what the tests
 * hold the row builders to.
 */
const EW_BQ_COLUMNS_ = {
  story_snapshots: {
    snapshot_at: 'TIMESTAMP!', cluster_id: 'STRING!', created_at: 'TIMESTAMP', last_post_at: 'TIMESTAMP', label: 'STRING',
    topic_product: 'STRING', risk_groups: 'STRING[]', priority_hint: 'STRING', stage: 'STRING', distinct_accounts: 'INTEGER',
    post_count: 'INTEGER', platforms: 'STRING[]', distinct_urls: 'INTEGER', audience_reach: 'INTEGER', engagement: 'INTEGER',
    accounts_last_60m: 'INTEGER', baseline_accounts: 'FLOAT', velocity_ratio: 'FLOAT', taxonomy_hint: 'STRING',
    centroid: 'FLOAT[]',
  },
  story_posts: {
    joined_at: 'TIMESTAMP!', cluster_id: 'STRING!', post_id: 'STRING!', account_key: 'STRING', platform: 'STRING',
    url: 'STRING', posted_at: 'TIMESTAMP', snippet: 'STRING', similarity: 'FLOAT', content_hash: 'STRING', topic: 'STRING',
    audience: 'INTEGER', engagement: 'INTEGER', risk_groups: 'STRING[]', names_google: 'BOOLEAN', slow_lane: 'BOOLEAN',
  },
  signals: {
    created_at: 'TIMESTAMP!', alert_id: 'STRING!', signal_type: 'STRING', velocity_grain: 'STRING', cluster_id: 'STRING',
    signal_key: 'STRING', headline: 'STRING', topic_product: 'STRING', priority_hint: 'STRING', distinct_accounts: 'INTEGER',
    mention_count: 'INTEGER', platforms: 'STRING[]', baseline_accounts: 'FLOAT', velocity_ratio: 'FLOAT',
    account_delta: 'FLOAT', primary_url: 'STRING', window_start: 'TIMESTAMP', window_end: 'TIMESTAMP',
    representative_posts: 'RECORD[]', update_of_alert_id: 'STRING', update_of_accounts: 'INTEGER', taxonomy_hint: 'STRING',
  },
  signal_events: {
    event_at: 'TIMESTAMP!', alert_id: 'STRING!', cluster_id: 'STRING', event: 'STRING!', reason: 'STRING', detail: 'JSON',
  },
  triage_verdicts: {
    asked_at: 'TIMESTAMP!', subject_type: 'STRING!', alert_id: 'STRING', cluster_id: 'STRING', model: 'STRING',
    latency_ms: 'INTEGER', input_tokens: 'INTEGER', ok: 'BOOLEAN', failure: 'STRING', about_google: 'FLOAT',
    brand_risk: 'FLOAT', independent_reports: 'FLOAT', routine_noise: 'FLOAT', category: 'STRING', severity_score: 'FLOAT',
    severity_level: 'STRING', action: 'STRING', raw: 'JSON',
  },
};
// signals.representative_posts: one struct a post
const EW_BQ_POST_COLUMNS_ = {
  post_id: 'STRING', platform: 'STRING', account_key: 'STRING', audience: 'INTEGER', engagement: 'INTEGER',
  posted_at: 'TIMESTAMP', url: 'STRING', snippet: 'STRING',
};
// triage_verdicts.action: what was done with the answers of one Decisions call (null: the call failed)
const EW_BQ_ACTIONS_ = {
  ranked: 'a signal\'s answers ordered the queue (row 39 ON)',
  kept: 'a signal was asked about and went on to its review (row 40 ON, row 39 OFF)',
  held_back: 'a signal was dropped without a review (row 40)',
  emitted: 'a story below the promotion bar was raised as an EARLY_WATCH signal (row 39)',
  not_emitted: 'a story below the promotion bar was asked about and not raised',
};

// ---------------------------------------------------------------------------------------------------------------
// The switches and the Control tab bars (rows 41-45 and 47)
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

/** Parses the six bar cells (`raw`: {about, noise, conf, watch, accounts, independent}) into {bars, values, details}. Pure. */
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
 * Ensures rows 41-45 and 47 (the fast-triage bars) exist on the Control tab with their seeds and strict dropdowns;
 * preserves any value a person set in column B (a bar whose label changed keeps its value too). "How it works" is
 * written again below them when a row was added.
 */
function ensureFtBarRows_(sh) {
  if (!sh) return;
  const grid = sh.getRange(FT_BAR_FIRST_ROW_, 1, FT_BAR_LAST_ROW_ - FT_BAR_FIRST_ROW_ + 1, 2).getValues();
  let changed = false;
  FT_BAR_SPECS_.forEach(spec => {
    const rowVals = grid[spec.row - FT_BAR_FIRST_ROW_] || [];
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
  ftBarReseed_(sh);
  if (changed) writeControlHelp_(sh);
}

/**
 * Once per seed change (FT_BAR_RESEEDS_): a bar cell still holding the seed an earlier build wrote there gets the
 * seed in use now; a cell with any other value is left as the person set it. Never throws.
 */
function ftBarReseed_(sh) {
  try {
    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) return;
    const props = PropertiesService.getScriptProperties();
    if (Number(props.getProperty(FT_BAR_SEED_PROP_)) >= FT_BAR_SEED_VERSION_) return;
    FT_BAR_RESEEDS_.forEach(r => {
      const spec = FT_BAR_SPECS_.filter(x => x.key === r.key)[0];
      if (!spec) return;
      const vals = sh.getRange(spec.row, 1, 1, 2).getValues()[0];
      if (String(vals[0] || '').trim() !== spec.label) return;
      const text = String(vals[1] === undefined || vals[1] === null ? '' : vals[1]).trim();
      if (text === '' || Number(text) !== r.from) return;
      sh.getRange(spec.row, 2, 1, 2).setValues([[spec.start, ftBarFrom_(spec, spec.start).note]]);
    });
    props.setProperty(FT_BAR_SEED_PROP_, String(FT_BAR_SEED_VERSION_));
  } catch (e) {
    console.error('could not update the fast-triage bar seeds: ' + ((e && e.message) || e));
  }
}

/** Reads the bar cells from the Control tab as {about, noise, conf, watch, accounts, independent} ('' where a row isn't its bar yet). */
function readFtBars_(sh) {
  const out = {};
  FT_BAR_SPECS_.forEach(spec => { out[spec.key] = ''; });
  if (!sh) return out;
  try {
    const grid = sh.getRange(FT_BAR_FIRST_ROW_, 1, FT_BAR_LAST_ROW_ - FT_BAR_FIRST_ROW_ + 1, 2).getValues();
    FT_BAR_SPECS_.forEach(spec => {
      const r = grid[spec.row - FT_BAR_FIRST_ROW_] || [];
      if (String(r[0] || '').trim() !== spec.label) return;
      out[spec.key] = Object.prototype.toString.call(r[1]) === '[object Date]' ? r[1]
        : String(r[1] === undefined || r[1] === null ? '' : r[1]).trim();
    });
  } catch (e) {}
  return out;
}

/** Resolves the bar cells (`raw`) for this run and updates column C beside each when changed. Never throws. */
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
      console.error('could not write the fast-triage bars\' notes (column C): ' + ((e && e.message) || e));
    }
  }
  return out;
}

/**
 * The current bars ({about, noise, conf, watch, accounts, independent}): from `ctx.ftBars` when given, else read from
 * the Control tab's bar cells (falling back to FT_BAR_SEEDS_ for any blank or invalid cell). Never turns a feature
 * off. Pure when `ctx` carries `ftBars`.
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

/**
 * True when signal `row` is serious, for the allowance of the Auto-correct flow (BigQuery.gs edAllowance_: a serious
 * signal goes first and passes the hour's allowance for ordinary ones): an early-watch story (EARLY_WATCH); or a P0 risk
 * group (ftP0Group_: also a row without facts whose hint is P0); or, when the fast triage answered (`dec`, decCompact_),
 * its probability of medium severity or higher (sp[2] + sp[3] + sp[4]) is at or above the confidence bar (`bars.conf`,
 * Control B43); or, only when there is no answer, a taxonomy hint raised it (`tag_raised === true`). Never
 * ftProtected_, which is true for a row without facts. Pure.
 */
function edSerious_(row, dec, bars) {
  const r = row || {};
  if (String(r.signal_type || '').trim().toUpperCase() === EWS_WATCH_SIGNAL_) return true;
  if (ftP0Group_(r)) return true;
  const sp = dec && typeof dec === 'object' && Array.isArray(dec.sp) && dec.sp.length === 5 ? dec.sp.map(v => Number(v) || 0) : null;
  if (sp) {
    const set = Number(bars && bars.conf);
    const bar = isFinite(set) && set > 0 ? set : FT_BAR_SEEDS_.conf;
    return Math.round((sp[2] + sp[3] + sp[4]) * 1000) / 1000 >= bar;
  }
  return r.tag_raised === true;
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

/**
 * Today's early-wave BigQuery writer state ({day, written, dropped, pauses: {table: {until, why}}}): a table that
 * refused its rows is paused by itself, the other four go on. Never throws.
 */
function ewBqState_(props, now) {
  const day = dayKey_();
  const t = Number(now) || Date.now();
  let s = null;
  try { s = JSON.parse(props.getProperty(EW_BQ_STATE_PROP_) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  const num = v => Math.max(0, Math.floor(Number(v) || 0));
  const same = s.day === day;
  const pauses = {};
  const from = s.pauses && typeof s.pauses === 'object' && !Array.isArray(s.pauses) ? s.pauses : {};
  Object.keys(from).forEach(table => {
    const p = from[table] || {};
    if (EW_BQ_TABLES_.indexOf(table) >= 0 && num(p.until) > t) pauses[table] = { until: num(p.until), why: String(p.why || '') };
  });
  // a pause an earlier build kept for every table at once ({until, why, table}): it is that table's
  if (num(s.until) > t && EW_BQ_TABLES_.indexOf(String(s.table || '')) >= 0 && !pauses[s.table]) {
    pauses[s.table] = { until: num(s.until), why: String(s.why || '') };
  }
  return { day, written: same ? num(s.written) : 0, dropped: same ? num(s.dropped) : 0, pauses };
}

/** Saves today's early-wave BigQuery writer state. Never throws. */
function ewBqSaveState_(props, st) {
  try {
    props.setProperty(EW_BQ_STATE_PROP_, JSON.stringify(st));
  } catch (e) {
    console.error('early wave BigQuery: could not save state: ' + ((e && e.message) || e));
  }
}

/** Row 46's Control note text from `st` (ewBqState_): the day's rows, and each table that is paused and why. Pure. */
function ewBqStatusText_(st, now) {
  const t = Number(now) || Date.now();
  const parts = [];
  if (st.written) parts.push(`${fmtInt_(st.written)} row${st.written === 1 ? '' : 's'} written today`);
  if (st.dropped) parts.push(`${fmtInt_(st.dropped)} dropped`);
  const tz = (typeof GEN !== 'undefined' && GEN && GEN.timezone) || 'America/New_York';
  EW_BQ_TABLES_.filter(table => st.pauses && st.pauses[table] && st.pauses[table].until > t).forEach(table => {
    const p = st.pauses[table];
    parts.push(`⚠️ ${table} paused until ${Utilities.formatDate(new Date(p.until), tz, 'h:mm a')}` +
      `${p.why ? ` (${truncate_(p.why, 60)})` : ''}`);
  });
  return parts.join(' · ');
}

/**
 * Sends at most one batched `bqInsertAll_` request for `early_wave.${table}` with `rows`. Background work: skipped while
 * SLA triage is busy, inside the run deadline, under `ApiGuard.gs` BigQuery ceilings, and while this table is paused
 * after it refused its rows (the other tables go on). True when BigQuery took the rows. Never throws or queues dropped
 * rows in script properties.
 */
function ewBqWriteTable_(ctx, props, left, table, rows) {
  const all = (rows || []).filter(r => r && r.insertId && r.json);
  if (!all.length) return false;
  if (EW_BQ_TABLES_.indexOf(table) < 0) return false;
  const list = all.slice(0, EW_BQ_BATCH_MAX_);
  const over = all.length - list.length;
  const log = msg => { if (ctx && typeof ctx.log === 'function') ctx.log(msg); };
  const now = ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now();
  const st = ewBqState_(props, now);
  const paused = st.pauses[table];
  const skip = (ctx && ctx.slaBusy) ? 'SLA triage is busy'
    : paused ? `${table} is paused after an error${paused.why ? ` (${paused.why})` : ''}`
      : left() < EW_BQ_MIN_LEFT_MS_ ? 'too little of the run left'
        : typeof apiGuardAllowBackground_ === 'function' && !apiGuardAllowBackground_('bigquery', !!(ctx && ctx.slaBusy))
          ? 'BigQuery background ceiling reached'
          : '';
  if (skip) {
    st.dropped += all.length;
    ewBqSaveState_(props, st);
    log(`early wave BigQuery: dropped ${all.length} row(s) for ${EW_BQ_DATASET_}.${table} (${skip})`);
    noteSwitch_(EW_BQ_SWITCH_, ewBqStatusText_(st, now));
    return false;
  }
  if (over) {
    st.dropped += over;
    log(`early wave BigQuery: dropped ${over} row(s) for ${EW_BQ_DATASET_}.${table} (more than ${EW_BQ_BATCH_MAX_} in one check)`);
  }
  if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', 1);
  try {
    bqInsertAll_(`${EW_BQ_DATASET_}.${table}`, list);
    st.written += list.length;
    ewBqSaveState_(props, st);
    noteSwitch_(EW_BQ_SWITCH_, ewBqStatusText_(st, now));
    return true;
  } catch (e) {
    const why = truncate_(String((e && e.message) || e).replace(/\s+/g, ' ').trim(), 120) || 'insert failed';
    st.dropped += list.length;
    st.pauses[table] = { until: now + EW_BQ_PAUSE_MS_, why };
    ewBqSaveState_(props, st);
    log(`early wave BigQuery: couldn't write ${list.length} row(s) to ${EW_BQ_DATASET_}.${table} (dropped): ${why}; ` +
      `writes to ${table} paused for ${Math.round(EW_BQ_PAUSE_MS_ / 60000)} minutes`);
    noteSwitch_(EW_BQ_SWITCH_, ewBqStatusText_(st, now));
    return false;
  }
}

/**
 * Flushes a check's batched rows (`batches`: {story_snapshots, story_posts, signals, signal_events, triage_verdicts}) to
 * `brand-social-central-data.early_wave`: at most one insert request per table. {table: true} for each table BigQuery
 * took. Never throws.
 */
function ewBqFlush_(ctx, props, left, batches) {
  const took = {};
  if (!ewBqOn_(ctx) || !batches) return took;
  try {
    const sent = (ctx._ewBqSentTables = ctx._ewBqSentTables || new Set());
    EW_BQ_TABLES_.forEach(table => {
      const rows = batches[table];
      if (!Array.isArray(rows) || !rows.length || sent.has(table)) return;
      sent.add(table);
      if (ewBqWriteTable_(ctx, props, left, table, rows)) took[table] = true;
    });
  } catch (e) {
    console.warn('early wave BigQuery: flush failed: ' + ((e && e.message) || e));
  }
  return took;
}

/**
 * The signals among `ids` (alert ids) whose early_wave.signals row BigQuery already took (a Set), so a signal queued
 * or held in a later check than the one that created it gets no second row. Never throws (an unreadable cache: none).
 */
function ewBqSignalsWritten_(ids) {
  const out = new Set();
  try {
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return out;
    const list = (ids || []).map(id => String(id || '')).filter(Boolean);
    if (!list.length) return out;
    const keys = list.map(id => EW_BQ_SIG_CACHE_PREFIX_ + hashText_(id));
    const got = CacheService.getScriptCache().getAll(keys) || {};
    list.forEach((id, i) => { if (got[keys[i]]) out.add(id); });
  } catch (e) {}
  return out;
}

/** Remembers that BigQuery took the early_wave.signals rows of `ids` (EW_BQ_SIG_CACHE_SEC_). Never throws. */
function ewBqNoteSignalsWritten_(ids) {
  try {
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return;
    const items = {};
    (ids || []).map(id => String(id || '')).filter(Boolean).forEach(id => { items[EW_BQ_SIG_CACHE_PREFIX_ + hashText_(id)] = '1'; });
    if (Object.keys(items).length) CacheService.getScriptCache().putAll(items, EW_BQ_SIG_CACHE_SEC_);
  } catch (e) {}
}

/**
 * What stops the row builders' rows from landing in live table `table`, given its schema (`fields`: BigQuery
 * tables.get's schema.fields): a column the table doesn't have, a column of another type or mode, a REQUIRED column
 * the builder never writes. [] when the rows fit. Pure.
 */
function ewBqSchemaProblems_(table, fields) {
  const want = EW_BQ_COLUMNS_[table];
  if (!want) return [`${table} isn't an early-wave table`];
  const norm = t => {
    const u = String(t || '').trim().toUpperCase();
    return { INT64: 'INTEGER', FLOAT64: 'FLOAT', BOOL: 'BOOLEAN', STRUCT: 'RECORD' }[u] || u;
  };
  const shape = spec => {
    const text = String(spec);
    return { type: norm(text.replace(/[!\[\]]/g, '')), repeated: /\[\]/.test(text), required: /!/.test(text) };
  };
  const problems = [];
  const check = (cols, list, prefix) => {
    const live = {};
    (list || []).forEach(f => { if (f && f.name) live[String(f.name)] = f; });
    Object.keys(cols).forEach(name => {
      const w = shape(cols[name]);
      const f = live[name];
      if (!f) { problems.push(`${prefix}${name}: the table has no such column`); return; }
      const mode = String(f.mode || 'NULLABLE').toUpperCase();
      if (norm(f.type) !== w.type) problems.push(`${prefix}${name}: the table's type is ${norm(f.type)}, the row's is ${w.type}`);
      if ((mode === 'REPEATED') !== w.repeated) {
        problems.push(`${prefix}${name}: the table's column is ${mode === 'REPEATED' ? 'a list' : 'one value'}, the row's is ${w.repeated ? 'a list' : 'one value'}`);
      }
    });
    Object.keys(live).forEach(name => {
      if (String(live[name].mode || '').toUpperCase() === 'REQUIRED' && !cols[name]) {
        problems.push(`${prefix}${name}: the table requires it and the row never writes it`);
      }
    });
    return live;
  };
  const top = check(want, fields, '');
  if (table === 'signals' && top.representative_posts) check(EW_BQ_POST_COLUMNS_, top.representative_posts.fields, 'representative_posts.');
  return problems;
}
