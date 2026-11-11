/**
 * Signals.gs — the two-track SLRR system on the bot's side (docs/TWO_TRACK_SIGNALS.md).
 *
 * The engine is the slrr-signals Cloud Run service writing to the BigQuery dataset slrr_signals: Track 1 classifies each
 * post against the playbook (deterministic rules, then Gemini, then the Collection Requirements engine); Track 2, the
 * radar, rates emerging clusters. This file hands their results to the chat, into the flows the Control tab already
 * routes, so they arrive like the bot's other finds and are worked the same way:
 *   Track 1   each qualifying classification becomes a flag on the Watch detections tab, queued for Watch alerts
 *             (Control row 35: OFF, B33, B9 or B10). WatchAlerts.gs posts it there as a watch alert, its card carrying
 *             Track 1's Product / Exposure Tag / Sensitive Topic, and the space's flow works it like any alert: an
 *             earlier alert on the story gets ❌, else the Social Alert is drafted (only to the B30 testers while
 *             Testing) with its marks. It goes out even while the Proactive watch (row 34) is OFF. Row 35 OFF: nothing
 *             is handed over (the classifications wait in BigQuery; a flag still unposted 3 hours on is dropped).
 *   Track 2   each cluster Gemini promoted, or rated likely to become an official alert, joins the Early detection
 *             review queue (Control row 19, EarlyDetection.gs): the same review and story card as the bot's other early
 *             signals, where row 19 posts them (dismissals filtered out, same-story repeats held back). Row 19 OFF:
 *             nothing is handed over.
 *   Each hand-off is recorded in slrr_signals.handoffs, so nothing is handed over twice.
 * The bot's own tab, "Signals", holds the rest, each switch OFF until a person turns it ON there:
 *   Sync to BigQuery     every 10 minutes: the Watch tags tab -> slrr_signals.taxonomy (people edit the taxonomy on the
 *                        sheet, as the watches do), the Alert log's forwarded alerts -> issue_history (Track 1's
 *                        previously-reported check), and people's ratings on Watch detections -> feedback_corrections.
 *   Archive              once a day, the first quiet run after 3 AM ET: the rows of the Alert log, Message log and Relay
 *                        older than the days set here are copied to slrr_signals.sheet_archive, checked there, and only
 *                        then trimmed from the sheet (never a row younger than 7 days, 15 for the Alert log, whose 14-day
 *                        already-reported check reads the sheet; at most 3,000 a tab a day). The archive is the bot's long
 *                        memory: signalsMemoryFor_ looks a post up there for analyst answers.
 *   Watchdog             see Watchdog.gs: a background step that keeps getting a run stopped is paused (when ON here).
 * Its last two rows say how each track's hand-off is going and how the Cloud Run engine is doing (written by the bot).
 * Nothing here posts, reacts or emails itself: the posting is Watch alerts' and Early detection's, as always.
 */

const SIG_TAB_ = 'Signals';
const SIG_TITLE_ = 'Two-track signals: the slrr-signals service (Cloud Run) and its BigQuery dataset slrr_signals';
const SIG_HEADER_ = ['Setting', 'Value', 'Status (written by the bot)'];
const SIG_FIRST_ROW_ = 3;
// [key, label, default, kind, least days]: switches start OFF (never turned ON by the bot); days are how long rows stay on
// the sheet, never fewer than the row's least (the Alert log: 15, as the bot's 14-day already-reported check reads it
// there); a status row's Value says where it is controlled (the Control tab), and only the bot writes its status
const SIG_ROWS_ = [
  ['sync', 'Sync taxonomy, alert history and ratings to BigQuery', 'OFF', 'switch'],
  ['archive', 'Archive old rows to BigQuery, then trim them here', 'OFF', 'switch'],
  ['alertDays', 'Archive: days of the Alert log kept on the sheet', 21, 'days', 15],
  ['messageDays', 'Archive: days of the Message log kept on the sheet', 14, 'days', 7],
  ['relayDays', 'Archive: days of the Relay tab kept on the sheet', 30, 'days', 7],
  ['watchdog', 'Pause a background step that keeps getting stuck (30 min)', 'OFF', 'switch'],
  ['track1', 'Classified alerts (Track 1): posted as Watch alerts', 'Control row 35', 'status'],
  ['track2', 'Radar alerts (Track 2): reviewed as Early detection', 'Control row 19', 'status'],
];
const SIG_MIN_DAYS_ = 7;                       // never archive a row younger than this, whatever the tab says
const SIG_EVERY_MS_ = 10 * 60 * 1000;          // sync and the engine's health at most every 10 minutes
const SIG_MIN_LEFT_MS_ = 45 * 1000;            // with less of the run left than this, nothing is started
const SIG_ARCHIVE_LEFT_MS_ = 90 * 1000;        // the archive needs this much
const SIG_ARCHIVE_HOUR_ = 3;                   // the archive: once a day, the first quiet run after 3 AM ET
const SIG_ARCHIVE_MAX_ROWS_ = 3000;            // rows a tab sends to the archive a day at most
const SIG_INSERT_CHUNK_ = 500;                 // rows a BigQuery insert call carries
const SIG_HISTORY_MAX_ = 500;                  // alerts a sync sends to issue_history at most
const SIG_FB_SEEN_MAX_ = 600;                  // ratings remembered as synced (short hashes in a script property)
const SIG_AT_PROP_ = 'SIG_AT';                 // when the sync last ran (ms)
const SIG_TAX_PROP_ = 'SIG_TAX_HASH';          // the Watch tags tab as last synced (hash)
const SIG_HIST_PROP_ = 'SIG_HIST_AT';          // the Alert log's newest updated_at synced (ms)
const SIG_FB_PROP_ = 'SIG_FB_SEEN';            // ratings synced: ["<hash>", ...]
const SIG_ARCHIVE_PROP_ = 'SIG_ARCHIVE_DAY';   // the day the archive last ran (yyyy-MM-dd ET)
const SIG_FLAGS_CACHE_ = 'sig_flags';          // {archive, watchdog}: the switches other files read (CacheService)
let SIG_STATUS_NOW_ = null;                    // this run's status column (setting key -> text): unchanged ones aren't rewritten

// The hand-offs to the chat
const SIG_T1_WATCH_ = 'Classification (Collection Requirements)';  // the Watch detections row's watch, the card's title
const SIG_T1_BAR_ = 8;                         // Track 1 qualifies at 0.8 confidence: its flags score 8-10 against this bar
const SIG_T1_EVERY_MS_ = 2 * 60 * 1000;        // Track 1's hand-off looks at most this often...
const SIG_T1_HOURS_ = 3;                       // ...at classifications this recent (a watch alert waits 3 hours at most)
const SIG_T1_MAX_RUN_ = 10;                    // ...this many a look
const SIG_T1_MAX_DAY_ = 200;                   // ...and a day
const SIG_T2_EVERY_MS_ = 5 * 60 * 1000;        // the radar's hand-off (it assesses every 15 minutes)
const SIG_T2_HOURS_ = 3;                       // assessments this recent (an Early detection signal waits 3 hours at most)
const SIG_T2_MAX_RUN_ = 3;
const SIG_T2_MAX_DAY_ = 12;
const SIG_T1_AT_PROP_ = 'SIG_T1_AT';
const SIG_T2_AT_PROP_ = 'SIG_T2_AT';
const SIG_HAND_PROP_ = 'SIG_HAND_TODAY';       // {day, t1, t2}: handed over today
const SIG_T1_PENDING_PROP_ = 'SIG_T1_PENDING';  // set while classified alerts may wait on the Watch detections tab (row 34 OFF:
                                                // WatchAlerts.gs pwPostWaitingOnly_ reads the tab for them only then)
const SIG_ENGINE_PROP_ = 'SIG_ENGINE';         // {at, tick, radar, sources}: the engine's health, read every 10 minutes

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

/** The ON/OFF dropdown on each switch row, none on the others. */
function sigValidate_(sh) {
  const onOff = SpreadsheetApp.newDataValidation().requireValueInList(['ON', 'OFF'], true).setAllowInvalid(false).build();
  SIG_ROWS_.forEach((r, i) => sh.getRange(SIG_FIRST_ROW_ + i, 2).setDataValidation(r[3] === 'switch' ? onOff : null));
}

/** A new tab's row for a setting: its label, its default (where a status row is controlled), its first status. Pure. */
function sigFreshRow_(r) {
  return [r[1], r[2], r[3] === 'switch' ? 'OFF' : ''];
}

/**
 * The bot's Signals tab laid out as SIG_ROWS_ says: a tab from an earlier layout (a row since dropped or added) is
 * rewritten in place, each setting keeping the value a person gave it (matched by its label; a new row takes its
 * default), with the dropdown on the switches only. Reads only when the layout is current. True when it rewrote it.
 */
function sigLayout_(sh) {
  const have = Math.max(0, sh.getLastRow() - SIG_FIRST_ROW_ + 1);
  const old = have ? sh.getRange(SIG_FIRST_ROW_, 1, have, 3).getValues() : [];
  if (old.length === SIG_ROWS_.length && SIG_ROWS_.every((r, i) => String(old[i][0]).trim() === r[1])) return false;
  const was = {};
  old.forEach(o => { const k = String(o[0]).trim(); if (k) was[k] = o; });
  const rows = SIG_ROWS_.map(r => {
    const prev = was[r[1]];
    if (!prev) return sigFreshRow_(r);
    if (r[3] === 'status') return [r[1], r[2], prev[2]];
    return [r[1], String(prev[1]).trim() === '' ? r[2] : prev[1], prev[2]];
  });
  if (have) {
    sh.getRange(SIG_FIRST_ROW_, 1, have, 3).clearContent();
    for (let i = 0; i < have; i++) sh.getRange(SIG_FIRST_ROW_ + i, 2).setDataValidation(null);
  }
  sh.getRange(SIG_FIRST_ROW_, 1, rows.length, 3).setValues(rows);
  sigValidate_(sh);
  console.log(`Signals: the tab now has its ${SIG_ROWS_.length} rows (the settings people gave are kept)`);
  return true;
}

/**
 * The Signals tab ({sh, foreign}): made (after the Watch tabs) when `create` and there's none, laid out as SIG_ROWS_
 * says (sigLayout_); one people made is never used.
 */
function sigTab_(ss, create) {
  let sh = ss.getSheetByName(SIG_TAB_);
  if (sh) {
    if (!isSigTab_(sh)) return { sh: null, foreign: true };
    sigLayout_(sh);
    return { sh, foreign: false };
  }
  if (!create) return { sh: null, foreign: false };
  const names = ss.getSheets().map(s => s.getName());
  const after = ['Watch tags', 'Watch sources', 'Watch detections', 'Watches'].map(n => names.indexOf(n)).find(i => i >= 0);
  sh = ss.insertSheet(SIG_TAB_, after === undefined ? names.length : after + 1);
  sh.getRange(1, 1).setValue(SIG_TITLE_);
  sh.getRange(2, 1, 1, 3).setValues([SIG_HEADER_]);
  sh.getRange(SIG_FIRST_ROW_, 1, SIG_ROWS_.length, 3).setValues(SIG_ROWS_.map(sigFreshRow_));
  sigValidate_(sh);
  sh.setFrozenRows(2);
  sh.setColumnWidth(1, 380);
  sh.setColumnWidth(3, 600);
  return { sh, foreign: false };
}

/** The tab's settings: switches true only when they read ON, days as numbers (never under the row's least). Pure. */
function sigSettingsOf_(values) {
  const out = {};
  SIG_ROWS_.forEach((r, i) => {
    if (r[3] === 'status') return;
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
// The run's step (Main.gs, after the alerts and the other tabs): the hand-offs, sync, then the archive (last: it trims)
// ---------------------------------------------------------------------------------------------------------------

/**
 * One run's Signals work, within what's left of the run (`runStart` + RUN_HARD_STOP_MS_): makes the tab the first time
 * (laid out anew when its rows changed), reads its settings every run (the switches other files read are cached for
 * them), then hands the two tracks' results to the chat where the Control tab routes them (`opts.watchAlerts`: B35's
 * value; `opts.earlyWave`: row 19 ON), syncs (at most every 10 minutes, when ON) and archives (once a day, when ON).
 * `opts.busy`: the run is catching up on alerts (only the settings are read). Never throws.
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
    // the engine's health (every 10 minutes) only while a track has somewhere to go: with rows 35 and 19 OFF nothing
    // here reads BigQuery
    const routed = (typeof pwAlertsChoice_ === 'function' && !!pwAlertsChoice_(o.watchAlerts)) || !!o.earlyWave;
    const engine = routed ? (sigTry_(sh, 'track1', () => ({ health: sigEngine_(props) })).health || null) : null;
    out.track1 = sigTry_(sh, 'track1', () => sigHandTrack1_(ss, props, o, engine));
    if (left() >= SIG_MIN_LEFT_MS_) out.track2 = sigTry_(sh, 'track2', () => sigHandRadar_(props, o, engine));
    const due = Date.now() - Number(props.getProperty(SIG_AT_PROP_) || 0) >= SIG_EVERY_MS_;
    if (S.sync && due && left() >= SIG_MIN_LEFT_MS_) {
      props.setProperty(SIG_AT_PROP_, String(Date.now()));
      out.sync = sigTry_(sh, 'sync', () => sigSync_(ss, props));
    }
    if (!S.sync) sigStatus_(sh, 'sync', 'OFF: nothing is sent to BigQuery');
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
    return r || {};
  } catch (e) {
    const why = truncate_(String((e && e.message) || e), 220);
    console.warn(`Signals ${key}: ${why}`);
    sigStatus_(sh, key, `⚠️ ${why} (tried again next time) · ${pwTime_(Date.now())} ET`);
    return { error: why };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The hand-offs: Track 1 to Watch alerts (Control row 35), Track 2 to the Early detection review (Control row 19)
// ---------------------------------------------------------------------------------------------------------------

/** Today's hand-offs ({day, t1, t2}), a new day's at 0. Never throws. */
function sigHandDay_(props, now) {
  const day = pwDay_(now);
  try {
    const s = JSON.parse(props.getProperty(SIG_HAND_PROP_) || 'null');
    if (s && s.day === day) return { day, t1: Number(s.t1) || 0, t2: Number(s.t2) || 0 };
  } catch (e) { /* a fresh day */ }
  return { day, t1: 0, t2: 0 };
}

/**
 * How the Cloud Run engine is doing, read at most every 10 minutes (the rest of the time the last reading): each
 * endpoint's latest run in the last day ({at, status}) and each source's health. {tick, radar, sources: [{source,
 * status}]}; null when it couldn't be read (the hand-offs carry on without it; a failed read throws, and is tried again
 * 10 minutes later).
 */
function sigEngine_(props) {
  const now = Date.now();
  let last = null;
  try { last = JSON.parse(props.getProperty(SIG_ENGINE_PROP_) || 'null'); } catch (e) { last = null; }
  if (last && now - (Number(last.at) || 0) < SIG_EVERY_MS_) return last.failed ? null : last;
  // noted first: a read that fails is tried again in 10 minutes, not every run
  props.setProperty(SIG_ENGINE_PROP_, JSON.stringify({ at: now, failed: true }));
  const runs = sigQuery_(`SELECT endpoint, status, UNIX_MILLIS(started_at) AS started_ms FROM \`${sigTable_('run_log')}\` ` +
    'WHERE started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) ' +
    'QUALIFY ROW_NUMBER() OVER (PARTITION BY endpoint ORDER BY started_at DESC) = 1', {});
  const sources = sigQuery_(`SELECT source, status FROM \`${sigTable_('v_source_health')}\` ORDER BY source`, {});
  const run = name => {
    const r = runs.find(x => x.endpoint === name);
    return r ? { at: Number(r.started_ms) || 0, status: String(r.status || '') } : null;
  };
  const health = { at: now, tick: run('tick'), radar: run('radar'),
    sources: sources.map(s => ({ source: String(s.source || ''), status: String(s.status || '') })) };
  props.setProperty(SIG_ENGINE_PROP_, JSON.stringify(health));
  return health;
}

/** A line on the engine's run for a track's status: its latest run, or that none ran in the last day. Pure but for GEN. */
function sigEngineWords_(run, what, sources) {
  const ran = run && run.at ? `last ${what} ${pwTime_(run.at)} ET (${run.status || '?'})`
    : `no ${what} in the last day (its Cloud Scheduler job is paused, or it can't run)`;
  if (!sources) return `engine: ${ran}`;
  const bad = (sources || []).filter(s => s.status && s.status !== 'live');
  const live = (sources || []).length - bad.length;
  return `engine: ${ran} · sources live ${live} of ${(sources || []).length}` +
    `${bad.length ? ` (${bad.map(s => `${s.source}: ${truncate_(s.status, 60)}`).join('; ')})` : ''}`;
}

/** The newest qualifying classification of each post from the last @hours not handed over yet, the oldest first. */
function sigT1Sql_() {
  return 'SELECT c.mention_key, c.source, c.post_url, c.platform, c.author, c.engagement, ' +
    'UNIX_MILLIS(c.posted_at) AS posted_ms, UNIX_MILLIS(c.classified_at) AS classified_ms, c.exposure_tag, ' +
    'c.exposure_priority, c.risk_tag, ARRAY_TO_STRING(c.products, \'|\') AS products, c.issue_name, c.issue_status, ' +
    'c.summary, c.urgency, c.confidence, c.rule_track, m.followers, m.kof_lists ' +
    `FROM (SELECT * FROM \`${sigTable_('classified_mentions')}\` ` +
    'WHERE classified_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) ' +
    'QUALIFY ROW_NUMBER() OVER (PARTITION BY mention_key ORDER BY classified_at DESC) = 1) c ' +
    `LEFT JOIN (SELECT DISTINCT mention_key FROM \`${sigTable_('handoffs')}\` ` +
    'WHERE handed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)) h USING (mention_key) ' +
    'LEFT JOIN (SELECT mention_key, MAX(author_followers) AS followers, ANY_VALUE(ARRAY_TO_STRING(kof_lists, \'|\')) AS kof_lists ' +
    `FROM \`${sigTable_('raw_mentions')}\` WHERE ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY) ` +
    'GROUP BY mention_key) m USING (mention_key) ' +
    'WHERE c.qualifies AND h.mention_key IS NULL ' +
    'AND c.classified_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR) ' +
    'ORDER BY c.classified_at LIMIT @limit';
}

/**
 * A qualifying Track 1 row as the Watch detections row it becomes (ProactiveWatch.gs pwRecord_ takes it as a look's
 * row): the watch SIG_T1_WATCH_, its score Gemini's confidence out of 10 against SIG_T1_BAR_, seen when it was
 * classified, its exposure tags as the tab writes them, and Track 1's classification as the listening data's (`tax`,
 * marked firm: f, so the card shows it whatever the pre-read says; Sonar's KOF lists, none meaning not a KOF). Pure.
 */
function sigT1Flag_(r) {
  const conf = Number(r.confidence);
  const score = isFinite(conf) && conf > 0 ? Math.max(1, Math.min(10, Math.round(conf * 10))) : SIG_T1_BAR_;
  const list = v => String(v === null || v === undefined ? '' : v).split('|').map(s => s.trim()).filter(Boolean);
  const tag = String(r.exposure_tag || '').trim();
  const risk = String(r.risk_tag || '').trim();
  const tags = [tag ? `${r.exposure_priority ? `${r.exposure_priority} · ` : ''}${tag}` : '', risk ? `Sensitive · ${risk}` : '']
    .filter(Boolean).join('; ');
  const tax = { p: list(r.products), t: tag, s: risk ? [risk] : [], f: 1 };
  const kofs = list(r.kof_lists);
  if (kofs.length || String(r.source) === 'sonar') tax.k = kofs;
  const num = v => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
  return {
    post_url: String(r.post_url || ''), watch: SIG_T1_WATCH_, impact: score, bar: SIG_T1_BAR_, source: String(r.source || ''),
    seen_ms: num(r.classified_ms) || Date.now(), topic: tags, platform: String(r.platform || ''), author: String(r.author || ''),
    followers: num(r.followers) || 0, eng: num(r.engagement) || 0, posted_ms: num(r.posted_ms),
    issue: String(r.issue_name || ''), issue_new: String(r.issue_status || '').toUpperCase() === 'NEW',
    summary: String(r.summary || ''), why: `classified, ${r.rule_track === 'urgent' ? 'urgent track' : '2K+ track'}`,
    tax: JSON.stringify(tax),
  };
}

/**
 * Track 1 -> Watch alerts: while Control row 35 says where watch alerts go, at most every 2 minutes, the qualifying
 * classifications of the last SIG_T1_HOURS_ not handed over yet (SIG_T1_MAX_RUN_ a look, SIG_T1_MAX_DAY_ a day) go on
 * the Watch detections tab as flags queued for posting (WatchAlerts.gs posts them next, as watch alerts, and the
 * space's flow works them), each recorded in slrr_signals.handoffs. Row 35 OFF: nothing is handed over. {text,
 * handed} for the status row, or null when it didn't look this run.
 */
function sigHandTrack1_(ss, props, o, engine) {
  const choice = typeof pwAlertsChoice_ === 'function' ? pwAlertsChoice_(o.watchAlerts) : '';
  if (!choice) {
    return { text: 'waiting: Watch alerts (Control row 35) is OFF, so classified alerts stay in BigQuery' +
      `${engine ? ` · ${sigEngineWords_(engine.tick, 'run', engine.sources)}` : ''}` };
  }
  const now = Date.now();
  if (now - Number(props.getProperty(SIG_T1_AT_PROP_) || 0) < SIG_T1_EVERY_MS_) return null;
  props.setProperty(SIG_T1_AT_PROP_, String(now));
  const day = sigHandDay_(props, now);
  const where = pwAlertsWhere_(choice);
  const tail = engine ? ` · ${sigEngineWords_(engine.tick, 'run', engine.sources)}` : '';
  const room = Math.max(0, SIG_T1_MAX_DAY_ - day.t1);
  if (!room) return { text: `✓ ${day.t1} handed to Watch alerts (${where}) today: the day's most; more tomorrow${tail}` };
  const rows = sigQuery_(sigT1Sql_(), { hours: SIG_T1_HOURS_, limit: Math.min(SIG_T1_MAX_RUN_, room) });
  if (!rows.length) {
    return { text: `✓ checked ${pwTime_(now)} ET: nothing new to hand over · ${day.t1} handed to Watch alerts (${where}) today${tail}` };
  }
  const dt = pwDetectionsTab_(ss, true);
  if (dt.foreign) throw new Error(`a tab named "${PW_DET_TAB_}" exists that the bot didn't make (rename it and the bot makes its own)`);
  const rec = pwRecord_(dt.sh, rows.map(sigT1Flag_), 0, true);
  if (rec.added) props.setProperty(SIG_T1_PENDING_PROP_, String(now));
  sigInsert_('handoffs', rows.map(r => ({ mention_key: String(r.mention_key), handed_at: new Date(now).toISOString(),
    alert_id: null, outcome: 'watch_alerts' })), rows.map(r => `t1:${r.mention_key}`));
  day.t1 += rows.length;
  props.setProperty(SIG_HAND_PROP_, JSON.stringify(day));
  console.log(`Signals: ${rows.length} classified alert${rows.length === 1 ? '' : 's'} handed to Watch alerts (${where}): ` +
    `${rec.added} new on ${PW_DET_TAB_}`);
  return { text: `✓ ${pwTime_(now)} ET: ${rows.length} handed to Watch alerts (${where}) · ${day.t1} today${tail}`, handed: rows.length };
}

/** The radar's latest assessments from the last @hours, promoted or rated high, not handed over yet: P0 first, then reach. */
function sigT2Sql_() {
  return 'SELECT l.cluster_id, l.origin, l.origin_ref, UNIX_MILLIS(l.assessed_at) AS assessed_ms, l.headline, ' +
    'TO_JSON_STRING(l.representative_texts) AS texts, TO_JSON_STRING(l.post_urls) AS urls, l.mentions, l.authors, ' +
    'ARRAY_TO_STRING(l.platforms, \', \') AS platforms, l.velocity_ratio, l.likelihood, l.action, l.closest_tag, ' +
    'l.closest_priority, l.rationale, UNIX_MILLIS(l.first_seen) AS first_ms, UNIX_MILLIS(l.last_seen) AS last_ms ' +
    `FROM \`${sigTable_('v_radar_latest')}\` l ` +
    `LEFT JOIN (SELECT DISTINCT mention_key FROM \`${sigTable_('handoffs')}\` ` +
    'WHERE handed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY)) h ' +
    'ON h.mention_key = CONCAT(\'radar:\', l.cluster_id, \'@\', CAST(UNIX_MILLIS(l.assessed_at) AS STRING)) ' +
    'WHERE h.mention_key IS NULL AND l.assessed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR) ' +
    'AND IFNULL(l.action, \'\') != \'discard\' AND (l.action = \'promote\' OR l.likelihood = \'high\') ' +
    'ORDER BY CASE l.closest_priority WHEN \'P0\' THEN 0 WHEN \'P1\' THEN 1 ELSE 2 END, IFNULL(l.authors, 0) DESC ' +
    'LIMIT @limit';
}

/** The handoffs key of a radar assessment (one hand-off an assessment; a later one of the same cluster may go too). Pure. */
function sigRadarKey_(r) {
  return `radar:${r.cluster_id}@${Number(r.assessed_ms) || 0}`;
}

/**
 * A radar assessment as an Early detection queue row (BigQuery.gs edQueuePut_; EarlyDetection.gs edFromRow_ reads it):
 * signal type RADAR, its own alert id, the cluster early_detection knows it by (same-story dedup with that pipeline's
 * cards), its posts (each text with its link), reach and pace, its closest tag's priority as the hint, and the radar's
 * outlook (likelihood, action, tag, why) for the review. Pure.
 */
function sigRadarRow_(r) {
  const arr = v => {
    try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  };
  const texts = arr(r.texts);
  const urls = arr(r.urls);
  const posts = texts.map((t, i) => ({ url: String(urls[i] || '').trim(), snippet: String(t || '') }))
    .concat(urls.slice(texts.length).map(u => ({ url: String(u || '').trim(), snippet: '' })))
    .filter(p => p.url || p.snippet);
  const platforms = String(r.platforms || '').split(',').map(s => s.trim()).filter(Boolean);
  const fromEd = String(r.origin || '') === 'early_detection' && String(r.origin_ref || '').trim();
  const num = v => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
  // the closest tag by its bare name: Gemini may give it as its "P0 · <name>" label, the priority then from that label
  const raw = String(r.closest_tag || '').trim();
  const labelled = raw.match(/^(P[012]|Sensitive)\s*[·:\-–—]\s*(.+)$/i);
  const tag = labelled ? labelled[2].trim() : raw;
  const given = String(r.closest_priority || '').trim().toUpperCase();
  const pri = /^P[012]$/.test(given) ? given : labelled && /^P[012]$/i.test(labelled[1]) ? labelled[1].toUpperCase() : '';
  const kind = pri || (labelled && /^sensitive$/i.test(labelled[1]) ? 'Sensitive' : '');
  return {
    alert_id: `radar-${sigHash_(sigRadarKey_(r))}`,
    created_utc: sigIso_(num(r.assessed_ms)) || '',
    signal_type: 'RADAR',
    cluster_id: fromEd ? String(r.origin_ref).trim() : String(r.cluster_id || ''),
    signal_key: fromEd ? '' : String(r.origin_ref || r.cluster_id || ''),
    headline: String(r.headline || ''),
    priority_hint: pri,
    unique_low_tier_authors: num(r.authors) || 0,
    mention_count: num(r.mentions) || 0,
    platform_count: platforms.length,
    platforms_csv: platforms.join(', '),
    velocity_ratio: num(r.velocity_ratio),
    primary_url: (posts.find(p => p.url) || {}).url || '',
    window_start_utc: sigIso_(num(r.first_ms)) || '',
    window_end_utc: sigIso_(num(r.last_ms)) || '',
    posts,
    radar_origin: String(r.origin || ''),
    radar_likelihood: String(r.likelihood || ''),
    radar_action: String(r.action || ''),
    radar_tag: tag ? `${kind ? `${kind} · ` : ''}${tag}` : '',
    radar_why: String(r.rationale || ''),
  };
}

/**
 * Track 2 -> the Early detection review: while Control row 19 is ON, at most every 5 minutes, the radar's assessments
 * of the last SIG_T2_HOURS_ that Gemini promoted or rated high, not handed over yet (SIG_T2_MAX_RUN_ a look,
 * SIG_T2_MAX_DAY_ a day), join the Early detection review queue (EarlyDetection.gs edDrainQueue_ reviews each and posts
 * its story card where row 19 posts them; dismissals filtered out, same-story repeats held back). One the queue can't
 * take now (full) is tried again at the next look while it's recent. Each queued one is recorded in
 * slrr_signals.handoffs. Row 19 OFF: nothing is handed over. {text, handed}, or null when it didn't look this run.
 */
function sigHandRadar_(props, o, engine) {
  if (!o.earlyWave) {
    return { text: 'waiting: Early wave & velocity check (Control row 19) is OFF, so radar alerts stay in BigQuery' +
      `${engine ? ` · ${sigEngineWords_(engine.radar, 'radar run', null)}` : ''}` };
  }
  const now = Date.now();
  if (now - Number(props.getProperty(SIG_T2_AT_PROP_) || 0) < SIG_T2_EVERY_MS_) return null;
  props.setProperty(SIG_T2_AT_PROP_, String(now));
  const day = sigHandDay_(props, now);
  const tail = engine ? ` · ${sigEngineWords_(engine.radar, 'radar run', null)}` : '';
  const room = Math.max(0, SIG_T2_MAX_DAY_ - day.t2);
  if (!room) return { text: `✓ ${day.t2} handed to the Early detection review today: the day's most; more tomorrow${tail}` };
  const rows = sigQuery_(sigT2Sql_(), { hours: SIG_T2_HOURS_, limit: Math.min(SIG_T2_MAX_RUN_, room) });
  if (!rows.length) {
    return { text: `✓ checked ${pwTime_(now)} ET: nothing new to hand over · ${day.t2} handed to the Early detection review today${tail}` };
  }
  const queued = [];
  let full = 0;
  rows.forEach(r => {
    const q = sigRadarRow_(r);
    const k = edQueueKey_(q);
    if (edQueuePut_(props, q, now) || edQueueList_(props).some(e => e.k === k)) queued.push({ r, q });
    else full++;
  });
  if (queued.length) {
    sigInsert_('handoffs', queued.map(x => ({ mention_key: sigRadarKey_(x.r), handed_at: new Date(now).toISOString(),
      alert_id: x.q.alert_id, outcome: 'early_detection_queue' })), queued.map(x => sigRadarKey_(x.r)));
    day.t2 += queued.length;
    props.setProperty(SIG_HAND_PROP_, JSON.stringify(day));
    console.log(`Signals: ${queued.length} radar alert${queued.length === 1 ? '' : 's'} handed to the Early detection review`);
  }
  return { text: `✓ ${pwTime_(now)} ET: ${queued.length} handed to the Early detection review` +
    `${full ? ` (${full} waiting: its queue is full)` : ''} · ${day.t2} today${tail}`, handed: queued.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Sync: taxonomy (the Watch tags tab), issue history (the Alert log), feedback (ratings)
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
  // ratings people gave since
  const fb = sigFeedback_(ss, props, now);
  parts.push(`${fb} rating${fb === 1 ? '' : 's'} to feedback`);
  return { text: `✓ ON · ${pwTime_(now)} ET: ${parts.join(', ')}` };
}

/**
 * The ratings on the Watch detections tab not synced yet, to feedback_corrections: the watches' flags as track
 * 'watch', Track 1's classified alerts (SIG_T1_WATCH_) as track 'track1'.
 */
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
  if (det && typeof isPwDetectionsTab_ === 'function' && isPwDetectionsTab_(det) && det.getLastRow() > PW_DET_HEAD_ROW_) {
    const n = Math.min(det.getLastRow() - PW_DET_HEAD_ROW_, PW_DET_READ_ROWS_);
    const first = det.getLastRow() - n + 1;
    det.getRange(first, 1, n, PW_DET_HEADER_.length).getValues().forEach(r => {
      const k = typeof pwKeyOf_ === 'function' ? pwKeyOf_(r[PW_COL_.key - 1]) : null;
      if (!k) return;
      const t1 = k.w === SIG_T1_WATCH_;
      add(t1 ? 'track1' : 'watch', t1 ? k.k : `${k.w}|${k.k}`, r[PW_COL_.rating - 1], PW_DET_TAB_);
    });
  }
  if (rows.length) sigInsert_('feedback_corrections', rows, rows.map(r => r.feedback_id));
  props.setProperty(SIG_FB_PROP_, JSON.stringify(seen.slice(-SIG_FB_SEEN_MAX_)));
  return rows.length;
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
