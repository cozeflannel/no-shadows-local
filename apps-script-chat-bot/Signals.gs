/**
 * Signals.gs — the two-track SLRR system on the bot's sheet (docs/TWO_TRACK_SIGNALS.md).
 *
 * The engine is the slrr-signals Cloud Run service (Track 1: playbook classification; Track 2: the radar) writing to the
 * BigQuery dataset slrr_signals. This file is the sheet's side of it, all on one bot-made tab, "Signals", whose
 * settings start OFF (nothing here runs until a person turns it ON there):
 *   Sync to BigQuery     every 10 minutes: the Watch tags tab -> slrr_signals.taxonomy (so people edit the taxonomy on
 *                        the sheet, as the watches do), the Alert log's forwarded alerts -> issue_history (the
 *                        previously-reported check), and people's ratings (Watch detections, Track 1, Radar) ->
 *                        feedback_corrections.
 *   Show on this sheet   every 10 minutes: the "Track 1 (shadow)" and "Radar" tabs from BigQuery, with a Review column
 *                        for people (kept across refreshes, synced as feedback).
 *   Archive              once a day, the first quiet run after 3 AM ET: the rows of the Alert log, Message log and Relay
 *                        older than the days set here are copied to slrr_signals.sheet_archive, checked there, and only
 *                        then trimmed from the sheet (never a row younger than 7 days, 15 for the Alert log, whose 14-day
 *                        already-reported check reads the sheet; at most 3,000 a tab a day). The archive is the bot's long
 *                        memory: signalsMemoryFor_ looks a post up there for analyst answers.
 *   Watchdog             see Watchdog.gs: a background step that keeps getting a run stopped is paused (when ON here).
 * Google Chat isn't touched by any of it: nothing here posts, reacts or emails.
 */

const SIG_TAB_ = 'Signals';
const SIG_TITLE_ = 'Two-track signals: the slrr-signals service (Cloud Run) and its BigQuery dataset slrr_signals';
const SIG_HEADER_ = ['Setting', 'Value', 'Status (written by the bot)'];
const SIG_FIRST_ROW_ = 3;
// [key, label, default, kind, least days]: switches start OFF (never turned ON by the bot); days are how long rows stay on
// the sheet, never fewer than the row's least (the Alert log: 15, as the bot's 14-day already-reported check reads it there)
const SIG_ROWS_ = [
  ['sync', 'Sync taxonomy, alert history and ratings to BigQuery', 'OFF', 'switch'],
  ['show', 'Show Track 1 and the radar on this sheet', 'OFF', 'switch'],
  ['archive', 'Archive old rows to BigQuery, then trim them here', 'OFF', 'switch'],
  ['alertDays', 'Archive: days of the Alert log kept on the sheet', 21, 'days', 15],
  ['messageDays', 'Archive: days of the Message log kept on the sheet', 14, 'days', 7],
  ['relayDays', 'Archive: days of the Relay tab kept on the sheet', 30, 'days', 7],
  ['watchdog', 'Pause a background step that keeps getting stuck (30 min)', 'OFF', 'switch'],
];
const SIG_MIN_DAYS_ = 7;                       // never archive a row younger than this, whatever the tab says
const SIG_EVERY_MS_ = 10 * 60 * 1000;          // sync and show at most every 10 minutes
const SIG_MIN_LEFT_MS_ = 45 * 1000;            // with less of the run left than this, nothing is started
const SIG_ARCHIVE_LEFT_MS_ = 90 * 1000;        // the archive needs this much
const SIG_ARCHIVE_HOUR_ = 3;                   // the archive: once a day, the first quiet run after 3 AM ET
const SIG_ARCHIVE_MAX_ROWS_ = 3000;            // rows a tab sends to the archive a day at most
const SIG_INSERT_CHUNK_ = 500;                 // rows a BigQuery insert call carries
const SIG_HISTORY_MAX_ = 500;                  // alerts a sync sends to issue_history at most
const SIG_SHOW_ROWS_ = 300;                    // rows each shown tab gets at most
const SIG_CELL_CHARS_ = 1500;                  // of a shown text cell
const SIG_FB_SEEN_MAX_ = 600;                  // ratings remembered as synced (short hashes in a script property)
const SIG_AT_PROP_ = 'SIG_AT';                 // when sync/show last ran (ms)
const SIG_TAX_PROP_ = 'SIG_TAX_HASH';          // the Watch tags tab as last synced (hash)
const SIG_HIST_PROP_ = 'SIG_HIST_AT';          // the Alert log's newest updated_at synced (ms)
const SIG_FB_PROP_ = 'SIG_FB_SEEN';            // ratings synced: ["<hash>", ...]
const SIG_ARCHIVE_PROP_ = 'SIG_ARCHIVE_DAY';   // the day the archive last ran (yyyy-MM-dd ET)
const SIG_FLAGS_CACHE_ = 'sig_flags';          // {archive, watchdog}: the switches other files read (CacheService)
let SIG_STATUS_NOW_ = null;                    // this run's status column (setting key -> text): unchanged ones aren't rewritten

const SIG_T1_TAB_ = 'Track 1 (shadow)';
const SIG_T1_HEADER_ = ['Classified (ET)', 'Qualifies', 'Priority', 'Exposure tag', 'Sensitive Topic', 'Urgency', 'Confidence',
  'Track', 'Requirements', 'Post', 'Network', 'Author', 'Engagements', 'Source', 'Issue', 'Summary', 'Why', 'Rules',
  'Public coverage', 'Review', 'Key'];
const SIG_T1_REVIEWS_ = ['Correct', 'Wrong tag', 'Not an issue', 'Should be urgent'];
const SIG_RADAR_TAB_ = 'Radar';
const SIG_RADAR_HEADER_ = ['Assessed (ET)', 'Likelihood', 'Action', 'Closest tag', 'Priority', 'Headline', 'Mentions', 'Authors',
  'Velocity', 'New authors / hour', 'Networks', 'Posts', 'Why', 'Public coverage', 'Origin', 'Review', 'Key'];
const SIG_RADAR_REVIEWS_ = ['Promote', 'Watch', 'Discard'];

function sigTable_(name) { return `${GCP_PROJECT}.${SIG_DATASET_()}.${name}`; }
function SIG_DATASET_() { return 'slrr_signals'; }

// ---------------------------------------------------------------------------------------------------------------
// The Signals tab: its settings (OFF until a person turns them ON) and the bot's status column
// ---------------------------------------------------------------------------------------------------------------

/** The bot's own Signals tab: its title and header as the bot writes them. */
function isSigTab_(sh) {
  if (!sh || sh.getLastRow() < 2) return false;
  const top = sh.getRange(1, 1, 2, 3).getValues();
  return String(top[0][0]) === SIG_TITLE_ && top[1].map(String).join('|') === SIG_HEADER_.join('|');
}

/** The Signals tab ({sh, foreign}): made (after the Watch tabs) when `create` and there's none; one people made is never used. */
function sigTab_(ss, create) {
  let sh = ss.getSheetByName(SIG_TAB_);
  if (sh) return isSigTab_(sh) ? { sh, foreign: false } : { sh: null, foreign: true };
  if (!create) return { sh: null, foreign: false };
  const names = ss.getSheets().map(s => s.getName());
  const after = ['Watch tags', 'Watch sources', 'Watch detections', 'Watches'].map(n => names.indexOf(n)).find(i => i >= 0);
  sh = ss.insertSheet(SIG_TAB_, after === undefined ? names.length : after + 1);
  sh.getRange(1, 1).setValue(SIG_TITLE_);
  sh.getRange(2, 1, 1, 3).setValues([SIG_HEADER_]);
  sh.getRange(SIG_FIRST_ROW_, 1, SIG_ROWS_.length, 3).setValues(SIG_ROWS_.map(r => [r[1], r[2], r[3] === 'switch' ? 'OFF' : '']));
  const onOff = SpreadsheetApp.newDataValidation().requireValueInList(['ON', 'OFF'], true).setAllowInvalid(false).build();
  SIG_ROWS_.forEach((r, i) => { if (r[3] === 'switch') sh.getRange(SIG_FIRST_ROW_ + i, 2).setDataValidation(onOff); });
  sh.setFrozenRows(2);
  sh.setColumnWidth(1, 380);
  sh.setColumnWidth(3, 600);
  return { sh, foreign: false };
}

/** The tab's settings: switches true only when they read ON, days as numbers (never under the row's least). Pure. */
function sigSettingsOf_(values) {
  const out = {};
  SIG_ROWS_.forEach((r, i) => {
    const v = values && values[i] ? values[i][0] : '';
    if (r[3] === 'switch') out[r[0]] = String(v).trim().toUpperCase() === 'ON';
    else {
      const n = Math.floor(Number(v));
      out[r[0]] = isFinite(n) && n > 0 ? Math.max(r[4] || SIG_MIN_DAYS_, SIG_MIN_DAYS_, n) : r[2];
    }
  });
  return out;
}

/** The settings (sigSettingsOf_), reading the status column with them (SIG_STATUS_NOW_) so unchanged statuses aren't rewritten. */
function sigSettings_(sh) {
  const vals = sh ? sh.getRange(SIG_FIRST_ROW_, 2, SIG_ROWS_.length, 2).getValues() : null;
  SIG_STATUS_NOW_ = {};
  if (vals) SIG_ROWS_.forEach((r, i) => { SIG_STATUS_NOW_[r[0]] = vals[i] ? vals[i][1] : ''; });
  return sigSettingsOf_(vals);
}

/** Column C of a setting's row (capped, never a formula), written only when it says something new. Never throws. */
function sigStatus_(sh, key, text) {
  try {
    const i = SIG_ROWS_.findIndex(r => r[0] === key);
    if (!sh || i < 0) return;
    const v = pwCell_(text, 400);
    if (SIG_STATUS_NOW_ && key in SIG_STATUS_NOW_ && pwSame_(v, SIG_STATUS_NOW_[key])) return;
    sh.getRange(SIG_FIRST_ROW_ + i, 3).setValue(v);
    if (SIG_STATUS_NOW_) SIG_STATUS_NOW_[key] = String(v).replace(/^'/, '');
  } catch (e) {
    console.warn(`Signals: couldn't write the ${key} status: ${(e && e.message) || e}`);
  }
}

/** The switches other files read without the tab (Watchdog.gs, signalsMemoryFor_): {archive, watchdog}. Never throws. */
function sigFlags_() {
  try {
    const raw = CacheService.getScriptCache().get(SIG_FLAGS_CACHE_);
    return raw ? JSON.parse(raw) : { archive: false, watchdog: false };
  } catch (e) {
    return { archive: false, watchdog: false };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// BigQuery (the script's own token, as the watch's looks): queries with named parameters, inserts with insert ids
// ---------------------------------------------------------------------------------------------------------------

function sigParam_(name, value) {
  if (Array.isArray(value)) {
    return { name, parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
      parameterValue: { arrayValues: value.map(v => ({ value: String(v) })) } };
  }
  const type = typeof value === 'number' ? (Number.isInteger(value) ? 'INT64' : 'FLOAT64') : 'STRING';
  return { name, parameterType: { type }, parameterValue: { value: String(value) } };
}

/** Rows of a read-only query in US (waits up to 20 s). Throws BigQuery's error. */
function sigQuery_(sql, params) {
  if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', 1);
  const res = pwCall_('post', `${BQ_API_BASE_}${GCP_PROJECT}/queries`, {
    query: sql, useLegacySql: false, location: 'US', timeoutMs: 20000, parameterMode: 'NAMED',
    maximumBytesBilled: String(2 * 1024 * 1024 * 1024), labels: { app: 'slrr-signals', tool: 'burson-qa-bot' },
    queryParameters: Object.keys(params || {}).map(k => sigParam_(k, params[k])),
  });
  if (!res.jobComplete) throw new Error('BigQuery took too long (tried again next time)');
  return parseBqRows_(res);
}

/** Streams rows into a slrr_signals table, in chunks, each row with its insert id. Throws on any row BigQuery refused. */
function sigInsert_(table, rows, ids) {
  for (let i = 0; i < rows.length; i += SIG_INSERT_CHUNK_) {
    if (typeof apiGuardNote_ === 'function') apiGuardNote_('bigquery', 1);
    const res = pwCall_('post', `${BQ_API_BASE_}${GCP_PROJECT}/datasets/${SIG_DATASET_()}/tables/${table}/insertAll`, {
      skipInvalidRows: false, ignoreUnknownValues: false,
      rows: rows.slice(i, i + SIG_INSERT_CHUNK_).map((json, j) => ({ insertId: String(ids[i + j]).slice(0, 128), json })),
    });
    if (res && Array.isArray(res.insertErrors) && res.insertErrors.length) {
      throw new Error(`BigQuery refused ${res.insertErrors.length} row(s) of ${table}: ` +
        truncate_(JSON.stringify(res.insertErrors[0]), 200));
    }
  }
}

function sigIso_(ms) { return Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null; }

function sigHash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// ---------------------------------------------------------------------------------------------------------------
// The run's step (Main.gs, after the alerts and the other tabs): sync, show, then the archive (always last: it trims)
// ---------------------------------------------------------------------------------------------------------------

/**
 * One run's Signals work, within what's left of the run (`runStart` + RUN_HARD_STOP_MS_): makes the tab (all OFF) the
 * first time, reads its settings every run (the switches other files read are cached for them), then, at most every
 * 10 minutes and only what's ON, sync and show; then the archive (once a day). `opts.busy`: the run is catching up on
 * alerts (only the settings are read). Never throws.
 */
function runSignals_(ss, runStart, opts) {
  const o = opts || {};
  let sh = null;
  try {
    const tab = sigTab_(ss, true);
    if (tab.foreign) {
      console.warn('Signals: a tab named "Signals" exists that the bot didn\'t make: rename it and the bot makes its own');
      return { foreign: true };
    }
    sh = tab.sh;
    const S = sigSettings_(sh);
    try { CacheService.getScriptCache().put(SIG_FLAGS_CACHE_, JSON.stringify({ archive: S.archive, watchdog: S.watchdog }), 1800); } catch (e) { /* best effort */ }
    if (typeof wdStatusText_ === 'function') sigStatus_(sh, 'watchdog', wdStatusText_(S.watchdog));
    const left = () => runStart + RUN_HARD_STOP_MS_ - Date.now();
    if (o.busy || left() < SIG_MIN_LEFT_MS_) return { settings: S, skipped: 'busy' };
    const props = PropertiesService.getScriptProperties();
    const out = { settings: S };
    const due = Date.now() - Number(props.getProperty(SIG_AT_PROP_) || 0) >= SIG_EVERY_MS_;
    if (due && (S.sync || S.show)) {
      props.setProperty(SIG_AT_PROP_, String(Date.now()));
      if (S.sync) out.sync = sigTry_(sh, 'sync', () => sigSync_(ss, props));
      if (S.show && left() >= SIG_MIN_LEFT_MS_) out.show = sigTry_(sh, 'show', () => sigShow_(ss));
    }
    if (!S.sync) sigStatus_(sh, 'sync', 'OFF: nothing is sent to BigQuery');
    if (!S.show) sigStatus_(sh, 'show', 'OFF: the Track 1 and Radar tabs aren\'t refreshed');
    if (S.archive) out.archive = sigTry_(sh, 'archive', () => sigArchiveDue_(ss, S, props, left));
    else sigStatus_(sh, 'archive', 'OFF: every row stays on the sheet');
    return out;
  } catch (e) {
    console.error('Signals: ' + ((e && e.message) || e));
    if (sh) sigStatus_(sh, 'sync', `⚠️ ${truncate_(String((e && e.message) || e), 200)} (tried again next time)`);
    return { error: String((e && e.message) || e) };
  }
}

/** Runs one part, writing its status (✓ text, or ⚠️ the error); never throws. */
function sigTry_(sh, key, fn) {
  try {
    const r = fn();
    if (r && r.text) sigStatus_(sh, key, r.text);
    return r;
  } catch (e) {
    const why = truncate_(String((e && e.message) || e), 220);
    console.warn(`Signals ${key}: ${why}`);
    sigStatus_(sh, key, `⚠️ ${why} (tried again next time) · ${pwTime_(Date.now())} ET`);
    return { error: why };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sync: taxonomy (the Watch tags tab), issue history (the Alert log), feedback (ratings and reviews)
// ---------------------------------------------------------------------------------------------------------------

/** The Watch tags tab as taxonomy rows (every tag, ON or OFF), with `version`. Pure but for GEN. */
function sigTaxonomyRows_(tags, version, now) {
  return (tags || []).map(t => ({
    kind: 'tag', priority: t.priority, name: t.name, label: t.label, description: t.desc, short_version: t.short,
    also_known_as: (t.aka || []).slice(0, 20), value: null, is_on: !!t.on, version, updated_at: new Date(now).toISOString(),
    updated_from: 'watch_tags_tab',
  }));
}

/** An Alert log row as an issue_history row (forwarded alerts only; null otherwise). Pure. */
function sigHistoryRow_(a, now) {
  if (!a || !a.forward_message || a.resend_of) return null;
  const f = a.forwarded_fields || {};
  const products = [f.product].concat(Array.isArray(f.other_products) ? f.other_products : []).filter(Boolean).map(String);
  return {
    alert_id: String(a.alert_id || ''), record_key: a.record_key ? String(a.record_key) : null,
    issue_name: f.issue_name || f.alert_name ? String(f.issue_name || f.alert_name).slice(0, 300) : null,
    issue_tokens: Array.isArray(a.issue_tokens) ? a.issue_tokens.slice(0, 30).map(String) : [],
    exposure_tag: a.exposure_tag ? String(a.exposure_tag) : null, priority: f.priority ? String(f.priority) : null,
    products: products.slice(0, 5), author: a.author ? String(a.author).slice(0, 200) : null,
    post_url: f.post_url ? String(f.post_url).slice(0, 1000) : null, alerted_at: sigIso_(a.created_at),
    status: a.status ? String(a.status) : null, email_status: a.email_status ? String(a.email_status) : null,
    source: 'alert_log', synced_at: new Date(now).toISOString(),
  };
}

function sigSync_(ss, props) {
  const now = Date.now();
  const parts = [];
  // the taxonomy, when the Watch tags tab changed (or once a day); the tab is made (every tag ON) if the watch never made
  // it, so people always have the one place to edit the taxonomy (one people made is left alone: the team's list is sent)
  const wt = pwTagsTab_(ss, true);
  const tags = pwTags_(wt.sh);
  const hash = sigHash_(JSON.stringify(tags.map(t => [t.priority, t.name, t.desc, t.short, t.aka, t.on])));
  const [lastHash, lastDay] = String(props.getProperty(SIG_TAX_PROP_) || '|').split('|');
  if (tags.length && (hash !== lastHash || lastDay !== pwDay_(now))) {
    const rows = sigTaxonomyRows_(tags, hash, now);
    sigInsert_('taxonomy', rows, rows.map(r => `${hash}:${r.priority}:${r.name}`));
    props.setProperty(SIG_TAX_PROP_, `${hash}|${pwDay_(now)}`);
    parts.push(`taxonomy ${rows.length} tags (version ${hash})`);
  }
  // the forwarded alerts updated since the last sync
  const since = Number(props.getProperty(SIG_HIST_PROP_) || 0);
  const alerts = sheetBackend_(ss).loadAlerts().filter(a => Number(a.updated_at) > since)
    .sort((x, y) => Number(x.updated_at) - Number(y.updated_at)).slice(0, SIG_HISTORY_MAX_);
  const hist = alerts.map(a => sigHistoryRow_(a, now)).filter(Boolean);
  if (hist.length) sigInsert_('issue_history', hist, hist.map(h => `${h.alert_id}:${h.synced_at}`));
  if (alerts.length) props.setProperty(SIG_HIST_PROP_, String(Number(alerts[alerts.length - 1].updated_at) || since));
  parts.push(`${hist.length} alert${hist.length === 1 ? '' : 's'} to issue history`);
  // ratings and reviews people gave since
  const fb = sigFeedback_(ss, props, now);
  parts.push(`${fb} rating${fb === 1 ? '' : 's'} to feedback`);
  return { text: `✓ ON · ${pwTime_(now)} ET: ${parts.join(', ')}` };
}

/** The ratings and reviews on the Watch detections, Track 1 and Radar tabs not synced yet, to feedback_corrections. */
function sigFeedback_(ss, props, now) {
  const seen = (() => { try { return JSON.parse(props.getProperty(SIG_FB_PROP_) || '[]'); } catch (e) { return []; } })();
  const have = new Set(seen);
  const rows = [];
  const add = (track, key, rating, source) => {
    if (!key || !rating) return;
    const h = sigHash_(`${track}|${key}|${rating}`);
    if (have.has(h)) return;
    have.add(h);
    seen.push(h);
    rows.push({ feedback_id: h, track, item_key: String(key).slice(0, 500), field: 'review', old_value: null,
      new_value: String(rating).slice(0, 100), rating: String(rating).slice(0, 100), note: null,
      created_at: new Date(now).toISOString(), source });
  };
  const det = ss.getSheetByName(PW_DET_TAB_);
  if (det && typeof isPwDetectionsTab_ === 'function' && isPwDetectionsTab_(det) && det.getLastRow() > PW_DET_HEADER_ROW_) {
    const n = Math.min(det.getLastRow() - PW_DET_HEADER_ROW_, PW_DET_READ_ROWS_);
    const first = det.getLastRow() - n + 1;
    det.getRange(first, 1, n, PW_DET_HEADER_.length).getValues().forEach(r => {
      const k = typeof pwKeyOf_ === 'function' ? pwKeyOf_(r[PW_COL_.key - 1]) : null;
      add('watch', k ? `${k.w}|${k.k}` : '', r[PW_COL_.rating - 1], PW_DET_TAB_);
    });
  }
  [[SIG_T1_TAB_, SIG_T1_HEADER_, 'track1'], [SIG_RADAR_TAB_, SIG_RADAR_HEADER_, 'track2']].forEach(([name, header, track]) => {
    const sh = ss.getSheetByName(name);
    if (!sigShownTab_(sh, header) || sh.getLastRow() < 2) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, header.length).getValues()
      .forEach(r => add(track, r[header.length - 1], r[header.indexOf('Review')], name));
  });
  if (rows.length) sigInsert_('feedback_corrections', rows, rows.map(r => r.feedback_id));
  props.setProperty(SIG_FB_PROP_, JSON.stringify(seen.slice(-SIG_FB_SEEN_MAX_)));
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Show: the Track 1 (shadow) and Radar tabs, from BigQuery, people's Review kept
// ---------------------------------------------------------------------------------------------------------------

function sigShownTab_(sh, header) {
  return !!sh && sh.getLastRow() >= 1 && sh.getRange(1, 1, 1, header.length).getValues()[0].map(String).join('|') === header.join('|');
}

/** Writes a shown tab (the bot's own; made when missing; one people made is left alone): rows, Review kept by key. */
function sigWriteShown_(ss, name, header, reviews, rows) {
  let sh = ss.getSheetByName(name);
  if (sh && !sigShownTab_(sh, header)) return { foreign: true };
  if (!sh) {
    const names = ss.getSheets().map(s => s.getName());
    const at = names.indexOf(SIG_TAB_);
    sh = ss.insertSheet(name, at >= 0 ? at + 1 : names.length);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
    sh.hideColumns(header.length);
    sh.protect().setDescription('Written by the Burson QA bot (only the Review column is yours)').setWarningOnly(true);
  }
  const reviewCol = header.indexOf('Review') + 1;
  const kept = {};
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, header.length).getValues().forEach(r => {
      if (r[reviewCol - 1]) kept[String(r[header.length - 1])] = r[reviewCol - 1];
    });
    sh.getRange(2, 1, sh.getLastRow() - 1, header.length).clearContent();
  }
  const values = rows.map(r => {
    const v = r.slice();
    v[reviewCol - 1] = kept[String(v[header.length - 1])] || '';
    return v;
  });
  if (values.length) {
    sh.getRange(2, 1, values.length, header.length).setValues(values);
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(reviews, true).setAllowInvalid(false).build();
    sh.getRange(2, reviewCol, values.length, 1).setDataValidation(rule);
  }
  return { rows: values.length };
}

const sigCell_ = (v, n) => pwCell_(v === null || v === undefined ? '' : (Array.isArray(v) ? v.join(', ') : v), n || SIG_CELL_CHARS_);
const sigTimeCell_ = v => (v ? pwText_(pwTime_(typeof v === 'number' ? v * 1000 : Date.parse(v) || Number(v) * 1000)) : '');

/** A v_track1_latest row as the Track 1 tab's row. Pure but for GEN. */
function sigT1Row_(r) {
  return [sigTimeCell_(r.classified_at), r.qualifies ? 'Yes' : 'No', sigCell_(r.exposure_priority, 20), sigCell_(r.exposure_tag, 200),
    sigCell_(r.risk_tag, 100), sigCell_(r.urgency, 20), r.confidence === null || r.confidence === undefined ? '' : Number(r.confidence),
    sigCell_(r.track, 40), r.meets_requirements ? 'Met' : sigCell_(r.suppression_reason || 'Not met', 100), sigCell_(r.post_url, 500),
    sigCell_(typeof pwNetwork_ === 'function' ? pwNetwork_(r.platform, String(r.post_url || '')) : r.platform, 40),
    sigCell_(r.author, 120), r.engagement === null || r.engagement === undefined ? '' : Number(r.engagement), sigCell_(r.source, 40),
    sigCell_(r.issue_name, 300), sigCell_(r.summary, 600), sigCell_(r.rationale, 600), sigCell_(r.rule_reasons, 300),
    sigCell_(r.web_context, 800), '', sigCell_(r.mention_key, 500)];
}

/** A v_radar_latest row as the Radar tab's row. Pure but for GEN. */
function sigRadarRow_(r) {
  return [sigTimeCell_(r.assessed_at), sigCell_(r.likelihood, 20), sigCell_(r.action, 20), sigCell_(r.closest_tag, 200),
    sigCell_(r.closest_priority, 20), sigCell_(r.headline, 300), Number(r.mentions) || 0, Number(r.authors) || 0,
    r.velocity_ratio === null || r.velocity_ratio === undefined ? '' : Number(r.velocity_ratio),
    r.growth_per_hour === null || r.growth_per_hour === undefined ? '' : Number(r.growth_per_hour), sigCell_(r.platforms, 120),
    sigCell_(r.post_urls, 1200), sigCell_(r.rationale, 600), sigCell_(r.web_context, 800), sigCell_(r.origin, 40), '',
    sigCell_(r.cluster_id, 300)];
}

function sigShow_(ss) {
  const t1 = sigQuery_(`SELECT * EXCEPT (products), ARRAY_TO_STRING(products, ', ') AS products FROM \`${sigTable_('v_track1_latest')}\` ` +
    'WHERE passed_rules AND classified_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 48 HOUR) ' +
    `ORDER BY qualifies DESC, classified_at DESC LIMIT ${SIG_SHOW_ROWS_}`, {});
  const radar = sigQuery_(`SELECT * EXCEPT (representative_texts, post_urls, platforms), ARRAY_TO_STRING(post_urls, ' ') AS post_urls, ` +
    `ARRAY_TO_STRING(platforms, ', ') AS platforms FROM \`${sigTable_('v_radar_latest')}\` ` +
    "ORDER BY CASE likelihood WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, assessed_at DESC " +
    `LIMIT ${SIG_SHOW_ROWS_}`, {});
  const a = sigWriteShown_(ss, SIG_T1_TAB_, SIG_T1_HEADER_, SIG_T1_REVIEWS_, t1.map(sigT1Row_));
  const b = sigWriteShown_(ss, SIG_RADAR_TAB_, SIG_RADAR_HEADER_, SIG_RADAR_REVIEWS_, radar.map(sigRadarRow_));
  const q = t1.filter(r => r.qualifies).length;
  const what = [a.foreign ? `⚠️ a "${SIG_T1_TAB_}" tab people made is left alone` : `${SIG_T1_TAB_}: ${a.rows} (${q} qualifying)`,
    b.foreign ? `⚠️ a "${SIG_RADAR_TAB_}" tab people made is left alone` : `${SIG_RADAR_TAB_}: ${b.rows}`];
  return { text: `✓ ON · ${pwTime_(Date.now())} ET: ${what.join(' · ')}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Archive: copy, check, then trim (the bot's own tabs only; never a row younger than SIG_MIN_DAYS_)
// ---------------------------------------------------------------------------------------------------------------

const SIG_ARCHIVE_TABS_ = [
  { tab: 'Alert log', key: 'alert_id', time: 'created_at', days: 'alertDays' },
  { tab: 'Message log', key: 'message', time: 'created_at', days: 'messageDays' },
  { tab: 'Relay', key: 'key', time: 'when', days: 'relayDays' },
];

/** A cell's time (ms): a number, a date, or text a date parses from. Pure. */
function sigMs_(v) {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  if (isFinite(n) && n > 1e11) return n;
  const p = Date.parse(String(v || ''));
  return isFinite(p) ? p : 0;
}

/**
 * How many rows from row 2 down are all older than `cutoff` (ms): the rows to archive (the oldest first, stopping at the
 * first one that isn't, or has no time), never more than `max`. Pure.
 */
function sigArchivePrefix_(times, cutoff, max) {
  let n = 0;
  while (n < times.length && n < max && times[n] > 0 && times[n] < cutoff) n++;
  return n;
}

function sigArchiveDue_(ss, S, props, left) {
  const now = Date.now();
  const day = pwDay_(now);
  const hour = Number(Utilities.formatDate(new Date(now), GEN.timezone || 'America/New_York', 'yyyy-MM-dd HH:mm').slice(11, 13));
  const last = props.getProperty(SIG_ARCHIVE_PROP_) || '';
  if (last === day || hour < SIG_ARCHIVE_HOUR_) {
    return { text: `✓ ON: once a day after ${SIG_ARCHIVE_HOUR_} AM ET (last ${last || 'never'}); ` +
      `keeps ${S.alertDays} days of the Alert log, ${S.messageDays} of the Message log, ${S.relayDays} of the Relay` };
  }
  if (left() < SIG_ARCHIVE_LEFT_MS_) return null;  // a quieter run does it
  props.setProperty(SIG_ARCHIVE_PROP_, day);  // once a day, done or not (a failure is noted and tried tomorrow)
  const done = SIG_ARCHIVE_TABS_.map(t => {
    if (left() < SIG_MIN_LEFT_MS_) return `${t.tab}: next time (time)`;
    try {
      const n = sigArchiveTab_(ss, t, now - S[t.days] * 24 * 3600 * 1000, now);
      return `${t.tab}: ${n} archived`;
    } catch (e) {
      return `${t.tab}: ⚠️ ${truncate_(String((e && e.message) || e), 120)} (nothing trimmed)`;
    }
  });
  return { text: `✓ ON · ${pwTime_(now)} ET: ${done.join(' · ')}` };
}

/** Archives one tab's old rows: copied to sheet_archive, counted there, and only then deleted. The number archived. */
function sigArchiveTab_(ss, t, cutoff, now) {
  const sh = ss.getSheetByName(t.tab);
  if (!sh || sh.getLastRow() < 3) return 0;
  const width = sh.getLastColumn();
  const header = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
  const timeCol = header.indexOf(t.time);
  const keyCol = header.indexOf(t.key);
  if (timeCol < 0 || keyCol < 0) throw new Error(`its "${t.time}" or "${t.key}" column is missing: not a tab the bot keeps`);
  const count = Math.min(sh.getLastRow() - 1, SIG_ARCHIVE_MAX_ROWS_);
  const values = sh.getRange(2, 1, count, width).getValues();
  const n = sigArchivePrefix_(values.map(r => sigMs_(r[timeCol])), cutoff, SIG_ARCHIVE_MAX_ROWS_);
  if (!n) return 0;
  const batch = `${t.tab.toLowerCase().replace(/\s+/g, '_')}-${pwDay_(now)}-${sigHash_(String(now))}`;
  const rows = values.slice(0, n).map(r => {
    const obj = {};
    header.forEach((h, j) => { if (h) obj[h] = typeof decodeCell_ === 'function' ? decodeCell_(h, r[j]) : r[j]; });
    return {
      tab: t.tab, row_key: String(r[keyCol] || '').slice(0, 500),
      record_key: obj.record_key ? String(obj.record_key).slice(0, 500) : null,
      alert_id: obj.alert_id ? String(obj.alert_id) : null, created_at: sigIso_(sigMs_(r[timeCol])),
      archived_at: new Date(now).toISOString(), archive_batch: batch, row_json: JSON.stringify(obj),
    };
  });
  sigInsert_('sheet_archive', rows, rows.map(r => `${t.tab}:${r.row_key}:${r.created_at}`));
  const check = sigQuery_(`SELECT COUNT(*) AS n FROM \`${sigTable_('sheet_archive')}\` WHERE archive_batch = @batch ` +
    'AND archived_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)', { batch });
  const got = check.length ? Number(check[0].n) : 0;
  if (got !== n) throw new Error(`BigQuery has ${got} of the ${n} rows sent: nothing trimmed (the copies stay; tried again tomorrow)`);
  // the rows are still the same ones (nothing was added above them meanwhile: the bot only appends at the bottom)
  const again = sh.getRange(2, keyCol + 1, n, 1).getValues().map(r => String(r[0]));
  if (again.join('\n') !== values.slice(0, n).map(r => String(r[keyCol])).join('\n')) {
    throw new Error('the rows moved while archiving: nothing trimmed (the copies stay; tried again tomorrow)');
  }
  sh.deleteRows(2, n);
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Memory: what the archive and the issue history know of a post (for analyst answers)
// ---------------------------------------------------------------------------------------------------------------

const SIG_MEMORY_CACHE_SEC_ = 3600;

/**
 * Earlier alerts on the alert's post from the bot's long memory (slrr_signals.v_memory: the archive and the issue
 * history), as prompt lines; [] when the Archive switch is OFF (nothing has left the sheet), without a post, or on any
 * error. One query a post an hour (cached). Never throws.
 */
function signalsMemoryFor_(alertRow) {
  try {
    if (!sigFlags_().archive || !alertRow || !alertRow.record_key) return [];
    const key = String(alertRow.record_key);
    const cache = CacheService.getScriptCache();
    const ck = 'sigmem:' + sigHash_(key);
    const hit = cache.get(ck);
    const rows = hit ? JSON.parse(hit) : sigQuery_(`SELECT alert_id, issue_name, exposure_tag, alerted_at, status, email_status, ` +
      `source FROM \`${sigTable_('v_memory')}\` WHERE record_key = @key ORDER BY alerted_at DESC LIMIT 10`, { key });
    if (!hit) cache.put(ck, JSON.stringify(rows), SIG_MEMORY_CACHE_SEC_);
    return rows.filter(r => r.alert_id !== alertRow.alert_id).map(r => `- ${r.alert_id}: ${r.issue_name || 'no issue name'}` +
      ` (${r.exposure_tag || 'no tag'}) on ${r.alerted_at || '?'}, email ${r.email_status || 'none'}, from ${r.source}`);
  } catch (e) {
    console.warn('Signals memory: ' + ((e && e.message) || e));
    return [];
  }
}
