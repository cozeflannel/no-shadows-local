/**
 * LiveVerify.gs — Standalone, zero-mock live integration test harness for Google Apps Script.
 *
 * Exercises the real live Control tab spreadsheet (`openStore_(false)` / `SpreadsheetApp`), real BigQuery v2 API
 * (`us-central1` Sonar table via `UrlFetchApp` + `ScriptApp.getOAuthToken()`), and real Vertex AI Gemini 3-Step
 * Dual-Track pipeline (`geminiClient_()`), logging real execution output directly via `console.log`.
 * Makes zero mutations to user cells on the live Control tab.
 *
 * verifyFastTriageLive() does the same for the fast triage (Decisions.gs, FastTriage.gs): real Gemini Decisions calls
 * about the real early-wave signals the bot holds right now, through the client the checks use. It writes to no sheet
 * cell and posts nowhere; its output is one LIVE_VERIFY_FAST_TRIAGE line in the log.
 *
 * verifyEarlyWaveBqLive() reads the live schema of the five brand-social-central-data.early_wave tables and holds the
 * early-wave writer's rows against them (FastTriage.gs EW_BQ_COLUMNS_). Run it before row 46 is turned ON: it reads
 * only, writes no row, and its output is one LIVE_VERIFY_EARLY_WAVE_BQ line in the log.
 *
 * verifyNewSourcesLive() looks at the two new sources planned for Early Detection before anything is built on them:
 * Brandwatch read live (never X) and the AMIE table. It only asks: GET requests to Brandwatch, BigQuery's table
 * metadata, a dry run and one SELECT whose bytes it caps. Its output is a plain report (one OK / CHECK / PROBLEM line a
 * finding) in the log, also returned, for a person to paste into a message.
 */

const LIVE_VERIFY_FT_MAX_ = 5;  // signals asked about by verifyFastTriageLive (a look, not a load test)

function verifyLookbackAndPipelineLive() {
  const ss = openStore_(false);
  const sheetId = ss.getId();
  const sh = controlTab_(ss);
  if (!sh) throw new Error('Control tab not found on live spreadsheet ' + sheetId);

  ensureBqLookbackRow_(sh);
  const cell = sh.getRange(BQ_LOOKBACK_ROW_, 2);
  const rule = cell.getDataValidation();
  if (!rule) throw new Error('B31 has no DataValidation rule on live Control tab');
  const values = (rule.getCriteriaValues() || [])[0] || [];
  const allowInvalid = rule.getAllowInvalid();
  if (allowInvalid !== false) throw new Error('Expected B31 allowInvalid === false, got ' + allowInvalid);
  if (JSON.stringify(values) !== JSON.stringify(['15 minutes', '30 minutes', '45 minutes', '60 minutes'])) {
    throw new Error('Unexpected B31 dropdown values: ' + JSON.stringify(values));
  }

  const liveControlRead = readControl_(sh);
  const liveResolved = bqLookbackFrom_(liveControlRead.bqLookback);
  const choiceChecks = ['15 minutes', '30 minutes', '45 minutes', '60 minutes'].map(choice => {
    const parsed = bqLookbackFrom_(choice);
    const clamped = bqLookbackMinutes_({ bq_lookback_minutes: parsed.minutes });
    return { choice, minutes: parsed.minutes, clamped, note: parsed.note };
  });
  const zeroCheck = bqLookbackFrom_(0);

  let liveEarlyAlerts15 = [];
  let liveEarlyError = '';
  try {
    liveEarlyAlerts15 = bqEarlyDetectionRows_(15);
  } catch (e) {
    liveEarlyError = String((e && e.message) || e);
  }
  const gemini = geminiClient_();

  const priors = [{
    alert_id: 'QA-LIVE-VERIFY-1',
    url: 'https://x.com/pixelowner/status/1900000000000000001',
    author: '@pixelowner',
    platforms: ['X'],
    product: 'Pixel',
    issue_name: 'Pixel 10 battery swelling',
    engagement: 2800,
    summary: 'User reported Pixel 10 battery swelling on charger.',
  }, {
    alert_id: 'QA-LIVE-VERIFY-2',
    url: 'https://x.com/mapsfan/status/1900000000000000002',
    author: '@mapsfan',
    platforms: ['X'],
    product: 'Google Maps',
    issue_name: 'Maps routing onto a closed bridge',
    engagement: 5200,
    summary: 'Drivers on X reported Google Maps routing onto a closed bridge.',
  }];

  const soloOnlyBatch = [{
    id: 'solo_new_dev',
    url: 'https://x.com/technews/status/1900000000000000010',
    author: '@technews',
    platform: 'X',
    product: 'Pixel',
    issue_name: 'Pixel 10 battery swelling',
    engagement: 3400,
    summary: 'Breaking update: Google confirmed an official battery replacement program for affected Pixel 10 units.',
  }];
  const soloTrackEval = evaluateBqDualTrack_(soloOnlyBatch, null, {
    threshold: 2000,
    waveMin: 2000,
    minWaveAuthors: 5,
    priorAlerts: priors,
    gemini,
  });

  const paraphrasedWaveBatch = [1, 2, 3, 4, 5].map(i => ({
    id: `wave_m${i}`,
    url: `https://x.com/driver${i}/status/190000000000000002${i}`,
    author: `@driver${i}`,
    platform: 'X',
    issue_name: 'Maps routing onto a closed bridge',
    engagement: 450 + i * 25,
    summary: `Commuter #${i} stranded at Elm Street closure because Google Maps still routes cars onto the closed bridge.`,
  }));
  const waveSuppressionEval = evaluateBqDualTrack_(paraphrasedWaveBatch, null, {
    wavesOnly: true,
    threshold: 2000,
    waveMin: 2000,
    minWaveAuthors: 5,
    priorAlerts: priors,
    gemini,
  });

  const summary = {
    sheetId,
    liveRow31: {
      a31: sh.getRange(BQ_LOOKBACK_ROW_, 1).getValue(),
      b31: cell.getValue(),
      c31: sh.getRange(BQ_LOOKBACK_ROW_, 3).getValue(),
      a33: sh.getRange(CONTROL_HELP_ROW_, 1).getValue(),
      dropdownChoices: values,
      allowInvalid,
      resolvedMinutes: liveResolved.minutes,
    },
    choiceChecks,
    zeroCheck,
    liveBigQuery15Min: {
      earlyDetectionPendingReturned: liveEarlyAlerts15.length,
      earlyDetectionError: liveEarlyError || null,
    },
    liveGeminiSoloTrackCheck: {
      by: soloTrackEval.by,
      soloAlerts: soloTrackEval.solo_alerts,
      discardedIds: soloTrackEval.discarded_ids,
    },
    liveGeminiWaveSuppressionCheck: {
      by: waveSuppressionEval.by,
      groupWavesCount: waveSuppressionEval.group_waves.length,
      discardedIds: waveSuppressionEval.discarded_ids,
    },
  };
  console.log('LIVE_VERIFY_RESULT ' + JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * The fast triage, live: one real Gemini Decisions call about each real early-wave signal the bot holds right now
 * (the producer's 3-hour buffer, then the review queue; LIVE_VERIFY_FT_MAX_ at most), through the same client the
 * checks use (the key from Secret Manager, the caps, the pause after a failure). Reads only: nothing is queued,
 * reviewed, posted or written to a sheet (the client counts its own calls in script state, as it always does). Logs,
 * for each signal, what was sent's size, the six answers, the time it took, and what the fast triage does with them
 * (hold back, raise); then the latencies and the day's call counts. No signal at hand: it says so and asks nothing.
 * Run it from the editor.
 */
function verifyFastTriageLive() {
  const props = PropertiesService.getScriptProperties();
  const buffer = ewsReadBuffer_(ewsCache_());
  const queued = edQueueList_(props).map(e => edQueueRow_(props, e.k)).filter(Boolean);
  const ids = new Set();
  const signals = buffer.concat(queued).filter(r => {
    if (!r || !r.alert_id || ids.has(r.alert_id)) return false;
    ids.add(r.alert_id);
    return true;
  }).slice(0, LIVE_VERIFY_FT_MAX_);
  const bars = ftBars_();
  const session = decSession_(() => Infinity, false);
  const results = signals.map(r => {
    const res = decSignalAsk_(r, session);
    return {
      alert_id: r.alert_id,
      signal_type: r.signal_type || '',
      accounts: ewCount_(r.unique_low_tier_authors),
      headline: truncate_(String(r.headline || ''), 120),
      input_chars: decSignalInput_(r).length,
      ok: res.ok,
      why: res.ok ? '' : res.why,
      ms: res.ok ? res.ms : null,
      tokens: res.ok ? res.tokens : null,
      answers: res.ok ? res.dec : null,
      p0_risk_group: ftP0Group_(r),
      never_held_back: ftProtected_(r),
      hold_back: res.ok ? (ftHoldWhy_(r, res.dec, bars) || 'no') : null,
      raise_early: res.ok ? ewsWatchRaise_(res.dec, bars) : null,
    };
  });
  const times = results.filter(x => x.ok).map(x => x.ms).sort((a, b) => a - b);
  const st = decState_(props, Date.now());
  const summary = {
    endpoint: decUrl_(),
    model: DEC_MODEL_,
    signals: { in_buffer: buffer.length, in_queue: queued.length, asked: results.length },
    answered: times.length,
    not_answered: results.filter(x => !x.ok).map(x => `${x.alert_id}: ${x.why}`),
    latency_ms: times.length ? { min: times[0], median: times[Math.floor(times.length / 2)], max: times[times.length - 1] } : null,
    calls_today: { asked: st.asked, failed: st.failed, refused: st.refused, paused_until: st.until ? new Date(st.until).toISOString() : '', why: st.why },
    bars,
    results,
  };
  console.log('LIVE_VERIFY_FAST_TRIAGE ' + JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * Live check of the early-wave BigQuery writer (Control row 46, FastTriage.gs) before it is turned ON: reads each of
 * the five early_wave tables' schema (BigQuery tables.get: one read a table, no row written, nothing queried) and says
 * what would stop the writer's rows from landing (ewBqSchemaProblems_: a column the table doesn't have, another type,
 * a REQUIRED column the rows never fill), and whether the triage_verdicts table's description names every value the
 * writer puts in `action` (EW_BQ_ACTIONS_; infra/early_wave_descriptions.sql sets it). `ready` is true only when every
 * table was read and has no problem. Run it from the editor.
 */
function verifyEarlyWaveBqLive() {
  const token = ScriptApp.getOAuthToken();
  const tables = EW_BQ_TABLES_.map(table => {
    const url = `${BQ_API_BASE_}${GCP_PROJECT}/datasets/${EW_BQ_DATASET_}/tables/${table}`;
    let code = 0;
    let body = null;
    let text = '';
    try {
      const resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } });
      code = resp.getResponseCode();
      text = resp.getContentText() || '';
      try { body = JSON.parse(text); } catch (e) { body = null; }
    } catch (e) {
      text = String((e && e.message) || e);
    }
    if (code !== 200 || !body || !body.schema || !Array.isArray(body.schema.fields)) {
      return { table, read: false, why: `HTTP ${code}: ${truncate_(text.replace(/\s+/g, ' '), 200)}`, problems: [] };
    }
    const fields = body.schema.fields;
    const out = {
      table,
      read: true,
      problems: ewBqSchemaProblems_(table, fields),
      not_written: fields.map(f => f.name).filter(n => !EW_BQ_COLUMNS_[table][n]),  // nullable columns the writer leaves empty
    };
    if (table === 'triage_verdicts') {
      const said = [String(body.description || '')].concat(fields.filter(f => f.name === 'action').map(f => String(f.description || ''))).join(' ');
      out.action_values_not_described = Object.keys(EW_BQ_ACTIONS_).filter(a => !new RegExp(`\\b${a}\\b`).test(said));
    }
    return out;
  });
  const summary = {
    dataset: `${GCP_PROJECT}.${EW_BQ_DATASET_}`,
    ready: tables.every(t => t.read && !t.problems.length),
    tables,
  };
  console.log('LIVE_VERIFY_EARLY_WAVE_BQ ' + JSON.stringify(summary, null, 2));
  return summary;
}

// --------------------------------------------------------------------------------------------------------------
// The new sources, live (the plan's stage 0): Brandwatch read live (never X) and the AMIE table, looked at by hand
// --------------------------------------------------------------------------------------------------------------
// Stand-ins for what later steps define for the bot itself; each of those steps replaces the NSV_ constant named here
// with its own (the settings bw_live_project_id, bw_live_sources and bw_live_queries_max of step 2b, the reader's
// request of step 2a). The AMIE table's name, its column lists, the old Google feeds and its settings are the AMIE
// job's own (EarlyWaveSource.gs EWS_AMI_*, ewsAmiCfg_), read inside the functions below.
const NSV_BW_PROJECT_ = 1998344909;           // the Brandwatch project the bot reads (PW_BW_PROJECT_; later bw_live_project_id)
const NSV_BW_SOURCES_ = ['reddit', 'bluesky', 'facebook', 'facebook_public', 'instagram', 'instagram_public', 'tiktok',
  'youtube', 'threads', 'tumblr', 'forum'];   // content sources Brandwatch live would ask for (later bw_live_sources); never X
const NSV_BW_NEVER_RX_ = /^(?:twitter|x|linkedin.*)$/i;  // content sources never asked for, whatever a list says
const NSV_BW_FIXED_ = 'orderBy=added&language=en&xthreadEntryType=share&sourceType=new';  // the reader's fixed filters
const NSV_BW_POSTED_HOURS_ = 72;             // startDate: posted at most this long ago
const NSV_BW_END_AHEAD_MS_ = 5 * 60 * 1000;  // endDate: this far ahead of now
const NSV_BW_SINCE_MINUTES_ = 60;            // the test read asks for what was added in the last hour
const NSV_BW_TEST_PAGE_ = 5;                 // mentions in the test read
const NSV_BW_DAY_PAGE_ = 500;                // mentions in the read of the last 24 hours
const NSV_BW_QUERIES_MAX_ = 20;              // query ids a read may carry (later bw_live_queries_max)
const NSV_BW_EARLY_MS_ = 60 * 1000;          // a mention added more than this before "added since": the filter was ignored
// Fields the reader reads on a mention: the first list should be on every mention; the second is reported as it comes
const NSV_BW_FIELDS_ = ['contentSource', 'guid', 'resourceId', 'url', 'added', 'date', 'language', 'sentiment'];
const NSV_BW_MAYBE_FIELDS_ = ['pageType', 'threadEntryType'];  // the old name of contentSource; empty on unthreaded mentions
const NSV_BW_FOLLOWER_FIELDS_ = ['twitterFollowers', 'blueskyFollowers', 'instagramFollowerCount', 'youtubeSubscriberCount',
  'potentialAudience'];                       // where pwBwRow_ finds an author's followers
const NSV_WORDS_MIN_ = 40;                    // characters of text a post needs (the shared length gate)
const NSV_SLOW_MINUTES_ = 120;                // the gate: a source slower than this from posting to added is left out
const NSV_SLOW_MIN_COUNT_ = 5;                // mentions with times a source needs before the gate judges it

/**
 * The new sources, live, read only: run it from the editor before stage 1 or 2 is built or turned ON. `queryIds`
 * (optional, an array of Brandwatch query ids): the queries the two Brandwatch reads use; without it, the first two
 * whose names look like Google's. It asks Brandwatch (GET only, with the shared key read the way the Watch reads it)
 * for the project's queries, the account's content sources, five mentions with every filter the reader will send, and
 * the last 24 hours; and BigQuery for the AMIE table's metadata, a dry run of a one-day read and, under 1 GB, that read.
 * It writes nothing anywhere and posts nothing. Each part runs on its own: one refusal is reported and the rest goes
 * on. Returns the report it logs: one line a finding, each starting OK, CHECK or PROBLEM, the gate for Brandwatch live
 * last. No key, address, post text or author name is in it.
 */
function verifyNewSourcesLive(queryIds) {
  const now = Date.now();
  const lines = [];
  const notes = [];   // the project's queries, listed after the findings
  const why = e => (e && e.message ? e.message : e);
  let bwToken = '';
  const bw = { calls: [], gate: null, gateWhy: 'the shared Brandwatch key could not be read, so Brandwatch was not asked', silent: [] };
  try {
    bwToken = pwBwToken_();
  } catch (e) {
    // pwBwToken_ cuts Secret Manager's text before this check sees it: a word the cut ends in may be part of an address
    // whose @ was cut off, so it is dropped before the scrub
    const said = String(why(e) === undefined || why(e) === null ? '' : why(e)).replace(/\s*\S*…$/, '…');
    lines.push(`PROBLEM the bot could not read the shared Brandwatch key from Secret Manager (${nsvScrub_(said, '')}), so Brandwatch was not asked anything`);
  }
  if (bwToken) {
    const given = queryIds === undefined || queryIds === null ? [] : Array.isArray(queryIds) ? queryIds : [queryIds];
    const usable = given.map(Number).filter(n => isFinite(n) && n > 0 && Math.floor(n) === n);
    const passed = usable.slice(0, NSV_BW_QUERIES_MAX_);
    let queries = null;
    let sources = null;
    try { queries = nsvBwQueries_(bwToken, bw, lines, notes); } catch (e) { lines.push(`PROBLEM Brandwatch query list: ${nsvScrub_(why(e), bwToken)}`); }
    const metricsAt = lines.length;
    try { sources = nsvBwSources_(bwToken, bw, lines); } catch (e) { lines.push(`PROBLEM Brandwatch content sources: ${nsvScrub_(why(e), bwToken)}`); }
    if (given.length && !passed.length) {
      lines.push(`CHECK ${given.length === 1 ? 'the query id given is not' : `none of the ${given.length} query ids given is`} a Brandwatch query id (a whole number), so ` +
        (queries ? 'the queries that look like Google\'s were used instead' : 'none was used'));
    } else if (passed.length < given.length) {
      const bad = given.length - usable.length;
      const over = usable.length - passed.length;
      lines.push(`CHECK of the ${given.length} query ids given, ${[bad ? `${bad} ${bad === 1 ? 'is' : 'are'} not a whole number` : '',
        over ? `${over} ${over === 1 ? 'is' : 'are'} over the ${NSV_BW_QUERIES_MAX_} a read may carry` : ''].filter(Boolean).join(' and ')}; ` +
        `${bad + over === 1 ? 'it was' : 'they were'} left out`);
    }
    const chosen = passed.length ? passed.map(id => ({ id, name: ((queries || []).find(q => q.id === id) || {}).name || '' }))
      : (queries || []).filter(q => q.suggested).slice(0, 2);
    const asked = NSV_BW_SOURCES_.filter(s => !NSV_BW_NEVER_RX_.test(s) && (!sources || sources.includes(s)));
    if (!chosen.length) {
      lines.push(queries ? 'CHECK no query looks like Google\'s by the plan\'s rule, so no mention was read: run it again with two query ids, as verifyNewSourcesLive([123, 456])'
        : `CHECK no mention was read: the query list could not be read and no ${given.length ? 'usable query id was' : 'query ids were'} given`);
      bw.gateWhy = 'no query was chosen, so the read of the last 24 hours was not sent';
    } else if (!asked.length) {
      lines.push('PROBLEM no mention was read: this Brandwatch account has none of the content sources Brandwatch live would ask for');
      bw.gateWhy = 'no content source was left to ask for, so the read of the last 24 hours was not sent';
    } else {
      // Brandwatch's own list of content sources was not read: say on its line that the reads ask for the plan's list
      if (!sources && /^PROBLEM /.test(lines[metricsAt] || '')) lines[metricsAt] += '; the reads below ask for the plan\'s whole list';
      lines.push(`OK the two Brandwatch reads use ${chosen.length === 1 ? 'one query' : chosen.length + ' queries'}: ` +
        chosen.map(q => (q.name ? `"${nsvScrub_(q.name, bwToken)}" (${q.id})` : String(q.id))).join(', ') +
        `, and these content sources: ${asked.join(', ')}`);
      const ids = chosen.map(q => q.id);
      try { nsvBwTestRead_(bwToken, bw, lines, ids, asked, now); } catch (e) { lines.push(`PROBLEM Brandwatch test read: ${nsvScrub_(why(e), bwToken)}`); }
      bw.gateWhy = 'the read of the last 24 hours was refused or failed (said above)';
      try { bw.gate = nsvBwDayRead_(bwToken, bw, lines, ids, asked, now); } catch (e) { lines.push(`PROBLEM Brandwatch read of the last 24 hours: ${nsvScrub_(why(e), bwToken)}`); }
    }
    try { lines.push(nsvBwHeaderLine_(bw.calls)); } catch (e) { lines.push('CHECK the call-count headers could not be read'); }
  }
  let bqToken = '';
  try { bqToken = ScriptApp.getOAuthToken(); } catch (e) { lines.push(`PROBLEM the bot has no Google token for BigQuery (${nsvScrub_(why(e), '')})`); }
  if (bqToken) {
    let schema = null;
    try { schema = nsvAmieSchema_(bqToken, lines, now); } catch (e) { lines.push(`PROBLEM the AMIE table's metadata: ${nsvScrub_(why(e), bwToken)}`); }
    try { nsvAmieRead_(bqToken, lines, schema, now); } catch (e) { lines.push(`PROBLEM the AMIE table's one-day read: ${nsvScrub_(why(e), bwToken)}`); }
    try { nsvNewJobDryRuns_(bqToken, schema, now).forEach(l => lines.push(l)); } catch (e) { lines.push(`PROBLEM the new jobs' dry runs: ${nsvScrub_(why(e), bwToken)}`); }
  }
  const head = `Live check of the new sources (read only), ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const list = notes.length ? ['The project\'s Brandwatch queries (id | name | collects | languages | suggested):'].concat(notes) : [];
  const report = [head].concat(lines, list, [nsvGateLine_(bw.gate, bw.gateWhy, bw.silent)]).map(l => nsvScrub_(l, bwToken, true)).join('\n');
  console.log('LIVE_VERIFY_NEW_SOURCES\n' + report);
  return report;
}

/**
 * A text from outside (an error, a name) made safe for the report: the Brandwatch key out, anything shaped like an
 * email address (plain or URL-encoded) replaced by [address], on one line, at most 300 characters unless `whole`.
 * It scrubs before it cuts; and a word with an @ (or %40) after a name, such as an address another helper already cut
 * short ("someone@exam…"), is replaced too. Pure.
 */
function nsvScrub_(s, token, whole) {
  let t = String(s === undefined || s === null ? '' : s);
  if (token) t = t.split(String(token)).join('[token]');
  t = t.replace(/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi, '[address]')
    .replace(/[A-Za-z0-9._%+-]+(?:@|%40)[^\s"'<>()\[\]{},;]*/gi, '[address]')
    .replace(/[\r\n\t]+/g, ' ');
  return whole ? t : truncate_(t.replace(/\s+/g, ' ').trim(), 300);
}

/**
 * One GET to Brandwatch (no method, no body): {what, code, body, headers (values scrubbed), why, thrown}, also kept in
 * `bw.calls`. Every outside text is scrubbed whole before anything cuts it.
 */
function nsvBwGet_(token, bw, what, path) {
  const r = { what, code: 0, body: null, headers: {}, why: '', thrown: '' };
  try {
    const resp = UrlFetchApp.fetch(PW_BW_API_ + path,
      { muteHttpExceptions: true, headers: { Authorization: 'bearer ' + token, Accept: 'application/json' } });
    r.code = resp.getResponseCode();
    let headers = {};
    try { headers = (resp.getHeaders && resp.getHeaders()) || {}; } catch (e) { headers = {}; }
    // header values are kept scrubbed whole, so a later cut can't leave part of the key or of an address
    Object.keys(headers).forEach(k => { r.headers[k] = nsvScrub_(headers[k], token, true); });
    if (r.code === 200) {
      try { r.body = JSON.parse(resp.getContentText() || ''); } catch (e) { r.body = null; }
    } else {
      // scrubbed before pwHttpWhy_ cuts it to 200 characters, and again after
      const text = nsvScrub_(resp.getContentText(), token, true);
      r.why = nsvScrub_(pwHttpWhy_({ getContentText: () => text }), token);
    }
  } catch (e) {
    r.thrown = nsvScrub_(e && e.message ? e.message : e, token);
  }
  bw.calls.push(r);
  return r;
}

/** The report's line for a Brandwatch call that gave no usable answer, or '' when it did. Pure. */
function nsvBwRefusal_(r) {
  if (r.thrown) return `PROBLEM ${r.what}: the call to Brandwatch did not complete (${r.thrown})`;
  if (r.code === 401) return `PROBLEM ${r.what}: Brandwatch refused the shared key (HTTP 401). The service that renews it may be down`;
  if (r.code === 429) return `PROBLEM ${r.what}: Brandwatch said too many calls on the shared login (HTTP 429; other tools share it). Try again in 10 minutes`;
  if (r.code === 403) return `PROBLEM ${r.what}: Brandwatch refused it (HTTP 403: ${r.why})`;
  if (r.code !== 200) return `PROBLEM ${r.what}: Brandwatch failed (HTTP ${r.code}: ${r.why})`;
  if (!r.body || typeof r.body !== 'object') return `PROBLEM ${r.what}: Brandwatch's answer could not be read`;
  return '';
}

/** A list field of Brandwatch's (an array of names or of {id, name}, or one name) as names. Pure. */
function nsvNames_(v) {
  return (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v])
    .map(x => String(x && typeof x === 'object' ? (x.id || x.name || '') : x).trim()).filter(Boolean);
}

/**
 * (a) The project's queries, from GET /projects/{project}/queries/summary: [{id, name, sources, languages, suggested}]
 * (nothing else of the answer is kept: never a user name), in Brandwatch's order; null when Brandwatch gave none. Adds
 * the findings to `lines` and one line a query to `notes` (the suggested ones first).
 */
function nsvBwQueries_(token, bw, lines, notes) {
  const r = nsvBwGet_(token, bw, 'Brandwatch query list', `/projects/${NSV_BW_PROJECT_}/queries/summary`);
  const refused = nsvBwRefusal_(r);
  if (refused) { lines.push(refused); return null; }
  if (!Array.isArray(r.body.results)) { lines.push('PROBLEM Brandwatch query list: the answer had no list of queries'); return null; }
  const googleRx = new RegExp(EWS_GOOGLE_CONFIG_RX_);
  const list = r.body.results.filter(q => q && q.id && q.name).map(q => {
    const name = String(q.name).replace(/\s+/g, ' ').trim();
    const low = name.toLowerCase();
    return { id: Number(q.id), name, sources: nsvNames_(q.contentSources), languages: nsvNames_(q.languages),
      suggested: googleRx.test(low) || new RegExp(EWS_AMI_GOOGLE_FEEDS_RX_).test(low) };
  });
  const sug = list.filter(q => q.suggested);
  lines.push(`OK Brandwatch project ${NSV_BW_PROJECT_} has ${fmtInt_(list.length)} queries; ${fmtInt_(sug.length)} look like Google's by the plan's rule` +
    (sug.length ? ` (${sug.slice(0, 5).map(q => `"${nsvScrub_(q.name, token)}"`).join(', ')}${sug.length > 5 ? ', ...' : ''})` : ''));
  sug.concat(list.filter(q => !q.suggested)).forEach(q => notes.push(
    `- ${q.id} | ${nsvScrub_(q.name, token)} | ${q.sources.join(', ') || 'none listed'} | ${q.languages.join(', ') || 'none listed'} | ${q.suggested ? 'yes' : 'no'}`));
  return list;
}

/**
 * (b) The account's content sources, from GET /metrics (lowercase names), or null when Brandwatch gave none (its
 * PROBLEM line is then the next line; verifyNewSourcesLive adds to it when the reads ask for the plan's whole list).
 */
function nsvBwSources_(token, bw, lines) {
  const r = nsvBwGet_(token, bw, 'Brandwatch content sources', '/metrics');
  const refused = nsvBwRefusal_(r);
  if (refused) { lines.push(refused); return null; }
  const names = nsvNames_(r.body.contentSources).map(s => s.toLowerCase());
  if (!names.length) { lines.push('PROBLEM Brandwatch content sources: the answer had none'); return null; }
  lines.push(`OK this Brandwatch account has ${names.length} content sources: ${names.join(', ')}`);
  const missing = NSV_BW_SOURCES_.filter(s => !names.includes(s));
  if (missing.length) lines.push(`CHECK on the plan's list but not on this account (they are not asked for): ${missing.join(', ')}`);
  return names;
}

/** The path of a mentions read (GET /projects/{project}/data/mentions) with the reader's filters; never X. Pure. */
function nsvBwMentionsPath_(o) {
  const iso = ms => encodeURIComponent(new Date(ms).toISOString());
  return `/projects/${NSV_BW_PROJECT_}/data/mentions?` + o.queryIds.map(id => `queryId=${encodeURIComponent(id)}`).join('&') +
    `&startDate=${iso(o.now - NSV_BW_POSTED_HOURS_ * 60 * 60 * 1000)}&endDate=${iso(o.now + NSV_BW_END_AHEAD_MS_)}` +
    `&sinceAdded=${iso(o.since)}&orderDirection=${o.direction}&pageSize=${o.pageSize}&page=0&` +
    o.sources.filter(s => !NSV_BW_NEVER_RX_.test(s)).map(s => `pageType=${encodeURIComponent(s)}`).join('&') + `&${NSV_BW_FIXED_}`;
}

/** True for a mention that is an X post (as the reader's X check will judge it). Pure. */
function nsvIsX_(m) {
  const src = [m.contentSource, m.pageType].map(v => String(v || '').trim().toLowerCase());
  const onX = u => /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:x|twitter)\.com(?:[\/?#:]|$)/i.test(String(u || '').trim());
  return src.includes('twitter') || src.includes('x') || onX(m.url) || onX(m.originalUrl) ||
    (/^\d+$/.test(String(m.guid || '').trim()) && !String(m.url || '').trim());
}

/** A read's mentions ([] for none). Pure. */
function nsvBwResults_(r) {
  return (r.body && Array.isArray(r.body.results) ? r.body.results : []).filter(m => m && typeof m === 'object');
}

/**
 * (c) One read of NSV_BW_TEST_PAGE_ mentions with every filter the reader will send: whether "added since" and the
 * oldest-first order were honoured, whether X came back, and which fields came.
 */
function nsvBwTestRead_(token, bw, lines, ids, sources, now) {
  const since = now - NSV_BW_SINCE_MINUTES_ * 60 * 1000;
  const r = nsvBwGet_(token, bw, 'Brandwatch test read',
    nsvBwMentionsPath_({ queryIds: ids, sources, now, since, direction: 'asc', pageSize: NSV_BW_TEST_PAGE_ }));
  const refused = nsvBwRefusal_(r);
  if (refused) { lines.push(refused); return; }
  if (!Array.isArray(r.body.results)) { lines.push('PROBLEM Brandwatch test read: the answer had no list of mentions'); return; }
  const list = nsvBwResults_(r);
  const xs = list.filter(nsvIsX_).length;
  lines.push(xs ? `PROBLEM Brandwatch sent ${xs} X ${xs === 1 ? 'post' : 'posts'} in the test read although the bot asked for none`
    : 'OK no X post came back in the test read');
  if (!list.length) {
    lines.push(`CHECK the test read found no mention added in the last ${NSV_BW_SINCE_MINUTES_} minutes, so "added since", the order and the fields could not be checked: run it again with two busier query ids`);
    return;
  }
  const added = list.map(m => pwBwTime_(m.added));
  const early = added.filter(t => t && t < since - NSV_BW_EARLY_MS_).length;
  lines.push(early ? `PROBLEM Brandwatch ignored "added since": ${early} of ${list.length} mentions were added before it`
    : `OK "added since" was honoured: none of the ${list.length} mentions was added before it`);
  const times = added.filter(Boolean);
  lines.push(times.some((t, i) => i && t < times[i - 1]) ? 'PROBLEM the mentions did not come oldest added first (the order asked for was ignored)'
    : times.length < 2 ? 'CHECK the order could not be judged: fewer than two mentions had an added time'
      : 'OK the mentions came oldest added first');
  const has = f => list.filter(m => m[f] !== undefined && m[f] !== null && String(m[f]).trim() !== '').length;
  const short = NSV_BW_FIELDS_.filter(f => has(f) < list.length);
  lines.push(short.length ? `CHECK fields not on every mention: ${short.map(f => `${f} (${has(f)} of ${list.length})`).join(', ')}`
    : `OK every mention had ${NSV_BW_FIELDS_.join(', ')}`);
  lines.push(`OK other fields: ${NSV_BW_MAYBE_FIELDS_.map(f => `${f} on ${has(f)} of ${list.length}`).join(', ')}`);
  const withFollowers = list.filter(m => NSV_BW_FOLLOWER_FIELDS_.some(f => Number(m[f]) > 0)).length;
  const seen = NSV_BW_FOLLOWER_FIELDS_.filter(f => has(f)).map(f => `${f} on ${has(f)}`);
  lines.push(`${withFollowers === list.length ? 'OK' : 'CHECK'} a follower count on ${withFollowers} of ${list.length} mentions` +
    ` (${seen.length ? seen.join(', ') : 'none of ' + NSV_BW_FOLLOWER_FIELDS_.join(', ')})`);
}

/** An answer's header, its name matched in any letter case: {name, value} or null. Pure. */
function nsvHeader_(headers, name) {
  const k = Object.keys(headers || {}).find(h => h.toLowerCase() === name);
  return k === undefined ? null : { name: k, value: String(headers[k]).trim() };
}

/**
 * The call-count headers of the first Brandwatch answer that came (the test read's first): their names as sent and
 * their form ("600/10m": a limit over minutes; "600": a bare limit). Pure.
 */
function nsvBwHeaderLine_(calls) {
  const order = ['Brandwatch test read', 'Brandwatch read of the last 24 hours', 'Brandwatch query list', 'Brandwatch content sources'];
  const r = order.map(w => calls.find(c => c.what === w && !c.thrown)).find(Boolean);
  if (!r) return 'CHECK the call-count headers could not be seen: no Brandwatch call gave an answer';
  const on = r.what.replace(/^Brandwatch /, '');
  const used = nsvHeader_(r.headers, 'x-rate-limit-used');
  const limit = nsvHeader_(r.headers, 'x-rate-limit');
  if (!used && !limit) return `CHECK no call-count header on Brandwatch's answer to the ${on} (looked for x-rate-limit and x-rate-limit-used in any letter case): the reader would show the shared login's use as unknown`;
  const m = limit ? limit.value.match(/^(\d+)\s*\/\s*(\d+)\s*m$/i) : null;
  const form = !limit ? 'missing' : m ? `"${limit.value}": ${m[1]} calls in ${m[2]} minutes`
    : /^\d+$/.test(limit.value) ? `"${limit.value}", a bare number: ${limit.value} calls (the minutes not given)`
      : `"${truncate_(limit.value, 40)}", a form the reader can't read`;
  const usedText = !used ? 'missing' : /^\d+$/.test(used.value) ? `"${used.value}"` : `"${truncate_(used.value, 40)}", not a number`;
  const ok = used && /^\d+$/.test(used.value) && limit && (m || /^\d+$/.test(limit.value));
  return `${ok ? 'OK' : 'CHECK'} call-count headers on the answer to the ${on}: ${used ? used.name : 'x-rate-limit-used'} ${usedText}; ` +
    `${limit ? limit.name : 'x-rate-limit'} ${form}`;
}

/** The value at fraction `p` of sorted numbers (nearest rank), or null for none. Pure. */
function nsvQuantile_(sorted, p) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
}

/** Minutes in plain words ("14 min", "3 h 10 min", "2 days 5 h"). Pure. */
function nsvMinutes_(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const h = Math.floor((m % 1440) / 60);
  return `${Math.floor(m / 1440)} days${h ? ` ${h} h` : ''}`;
}

/**
 * (d) One read of the last 24 hours by added time (NSV_BW_DAY_PAGE_ mentions, the newest added first): per content
 * source the count, how many came with words, and the median and 90th percentile of the minutes from posting (date)
 * to added. Returns [{source, n (mentions with both times), median}] for the gate, or null when nothing was measured.
 * The sources asked for that brought no mention are said on one line and kept in `bw.silent` for the gate.
 */
function nsvBwDayRead_(token, bw, lines, ids, sources, now) {
  const since = now - 24 * 60 * 60 * 1000;
  const r = nsvBwGet_(token, bw, 'Brandwatch read of the last 24 hours',
    nsvBwMentionsPath_({ queryIds: ids, sources, now, since, direction: 'desc', pageSize: NSV_BW_DAY_PAGE_ }));
  const refused = nsvBwRefusal_(r);
  if (refused) { lines.push(refused); return null; }
  if (!Array.isArray(r.body.results)) { lines.push('PROBLEM Brandwatch read of the last 24 hours: the answer had no list of mentions'); return null; }
  const all = nsvBwResults_(r);
  const xs = all.filter(nsvIsX_).length;
  if (xs) lines.push(`PROBLEM Brandwatch sent ${xs} X ${xs === 1 ? 'post' : 'posts'} in the read of the last 24 hours although the bot asked for none`);
  const total = Number(r.body.resultsTotal);
  lines.push(`OK the read of the last 24 hours gave ${fmtInt_(all.length)} mentions` +
    (isFinite(total) && total > all.length ? ` (the newest ${fmtInt_(all.length)} of ${fmtInt_(total)}; the figures below are for those)` : ''));
  const notX = all.filter(m => !nsvIsX_(m));
  const noAdded = notX.filter(m => !pwBwTime_(m.added)).length;
  const early = notX.filter(m => pwBwTime_(m.added) && pwBwTime_(m.added) < since - NSV_BW_EARLY_MS_).length;
  if (early) lines.push(`PROBLEM Brandwatch ignored "added since" in the read of the last 24 hours: ${fmtInt_(early)} ${early === 1 ? 'mention was' : 'mentions were'} added before it (left out of the figures below)`);
  if (noAdded) lines.push(`CHECK ${fmtInt_(noAdded)} ${noAdded === 1 ? 'mention' : 'mentions'} of the read of the last 24 hours had no readable added time (left out of the figures below)`);
  const times = all.map(m => pwBwTime_(m.added)).filter(Boolean);
  if (times.some((t, i) => i && t > times[i - 1])) {
    lines.push('CHECK the read of the last 24 hours did not come newest added first (the order asked for was ignored), so a full page may not be the newest mentions');
  }
  const list = notX.filter(m => pwBwTime_(m.added) >= since - NSV_BW_EARLY_MS_);
  if (!list.length) {
    bw.gateWhy = 'the read of the last 24 hours found no mention added in that time';
    lines.push('CHECK no mention added in the last 24 hours came back, so how late each source is could not be measured');
    return null;
  }
  const by = {};
  list.forEach(m => {
    const s = String(m.contentSource || m.pageType || '').trim().toLowerCase() || 'unknown';
    const o = by[s] || (by[s] = { n: 0, words: 0, mins: [] });
    o.n++;
    if (String(m.snippet || m.fullText || '').replace(/\s+/g, ' ').trim().length >= NSV_WORDS_MIN_) o.words++;
    const posted = pwBwTime_(m.date);
    const added = pwBwTime_(m.added);
    if (posted && added) o.mins.push(Math.max(0, (added - posted) / 60000));
  });
  const gate = Object.keys(by).sort((a, b) => by[b].n - by[a].n || (a < b ? -1 : 1)).map(s => {
    const o = by[s];
    const mins = o.mins.sort((a, b) => a - b);
    const median = nsvQuantile_(mins, 0.5);
    const fewWords = o.words * 2 < o.n;
    const slow = median !== null && median > NSV_SLOW_MINUTES_;
    lines.push(`${fewWords || slow || median === null ? 'CHECK' : 'OK'} ${s}: ${fmtInt_(o.n)} mentions, ${fmtInt_(o.words)} with words` +
      `${fewWords ? ' (most came without their words)' : ''}; from posting to added: ` +
      (median === null ? 'no readable times' : `median ${nsvMinutes_(median)}, 90% within ${nsvMinutes_(nsvQuantile_(mins, 0.9))}`));
    return { source: s, n: mins.length, median };
  });
  bw.silent = sources.filter(s => !by[s]);
  if (bw.silent.length) {
    lines.push(`CHECK no mention in the last 24 hours from ${bw.silent.join(', ')}, so how late ${bw.silent.length === 1 ? 'it is' : 'they are'} was not measured`);
  }
  return gate;
}

/**
 * The gate for stage 2, the report's last line: the Brandwatch sources slower than 2 hours. `why`: in plain words, why
 * nothing was measured (used only when `gate` is empty). `silent`: the sources asked for that brought no mention. It
 * starts OK only when every source asked for was judged and none is slow; with no source judged it says "not measured".
 * Pure.
 */
function nsvGateLine_(gate, why, silent) {
  const notMeasured = reason => `CHECK gate for Brandwatch live: not measured (${reason}), so these sources are slower than 2 hours: unknown`;
  if (!gate || !gate.length) return notMeasured(why || 'no read of the last 24 hours gave times');
  const judged = gate.filter(g => g.n >= NSV_SLOW_MIN_COUNT_ && g.median !== null);
  const slow = judged.filter(g => g.median > NSV_SLOW_MINUTES_);
  const few = gate.filter(g => !judged.includes(g)).map(g => `${g.source} (${g.n})`);
  const none = (silent || []).filter(Boolean);
  const tail = (few.length ? `. Too few mentions with times to judge: ${few.join(', ')}` : '') +
    (none.length ? `. No mention in the last 24 hours, so not judged: ${none.join(', ')}` : '');
  if (!judged.length) return notMeasured(`no source had at least ${NSV_SLOW_MIN_COUNT_} mentions with both times`) + tail;
  return slow.length
    ? `CHECK gate for Brandwatch live: these sources are slower than 2 hours: ${slow.map(g => `${g.source} (median ${nsvMinutes_(g.median)})`).join(', ')}; leave them out of what Brandwatch live reads${tail}`
    : `${tail ? 'CHECK' : 'OK'} gate for Brandwatch live: these sources are slower than 2 hours: none${tail}`;
}

/** One BigQuery call (a GET, or a POST of `payload`): {code, body, why} (why: BigQuery's message, addresses removed). */
function nsvBq_(token, url, payload) {
  const r = { code: 0, body: null, why: '' };
  try {
    const params = { method: payload ? 'post' : 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } };
    if (payload) Object.assign(params, { contentType: 'application/json', payload: JSON.stringify(payload) });
    const resp = UrlFetchApp.fetch(url, params);
    r.code = resp.getResponseCode();
    const text = String(resp.getContentText() || '');
    try { r.body = JSON.parse(text); } catch (e) { r.body = null; }
    if (r.code !== 200) r.why = nsvScrub_((r.body && r.body.error && r.body.error.message) || text, '');  // scrubbed, then cut to 300
  } catch (e) {
    r.why = nsvScrub_(e && e.message ? e.message : e, '');
  }
  return r;
}

/** What a refused BigQuery call means for the AMIE table, in plain words. Pure. */
function nsvBqRefusal_(what, r) {
  if (!r.code) return `PROBLEM ${what}: the call to BigQuery did not complete (${r.why})`;
  if (r.code === 403 || /access denied|permission/i.test(r.why)) return `PROBLEM ${what}: BigQuery won't let the bot read the AMIE table (access denied: ${r.why})`;
  if (r.code === 404) return `PROBLEM ${what}: the AMIE table was not found (HTTP 404: ${r.why})`;
  return `PROBLEM ${what}: BigQuery refused (HTTP ${r.code}: ${r.why})`;
}

/**
 * The AMIE table's metadata (BigQuery tables.get, no bytes): the columns and types against the needed and optional
 * lists, the partitioning, when it last changed. Returns {cols: {lowercase name: type}} or null when it was not read.
 */
function nsvAmieSchema_(token, lines, now) {
  const [project, dataset, table] = EWS_AMI_TABLE_.split('.');
  const r = nsvBq_(token, `${BQ_API_BASE_}${project}/datasets/${dataset}/tables/${table}`);
  if (r.code !== 200 || !r.body || !r.body.schema || !Array.isArray(r.body.schema.fields)) {
    lines.push(r.code === 200 ? 'PROBLEM the AMIE table\'s metadata came without its columns' : nsvBqRefusal_('the AMIE table\'s metadata', r));
    return null;
  }
  const cols = {};
  r.body.schema.fields.forEach(f => { cols[String(f.name).toLowerCase()] = (f.mode === 'REPEATED' ? 'REPEATED ' : '') + String(f.type || '').toUpperCase(); });
  const type = c => cols[c.toLowerCase()];
  const missing = Object.keys(EWS_AMI_NEEDED_).filter(c => !type(c));
  const wrong = Object.keys(EWS_AMI_NEEDED_).filter(c => type(c) && type(c) !== EWS_AMI_NEEDED_[c]);
  if (missing.length) lines.push(`PROBLEM the AMIE table has no column ${missing.map(c => `"${c}"`).join(', ')}, which the plan needs`);
  wrong.forEach(c => lines.push(`PROBLEM the AMIE table's column "${c}" holds ${nsvTypeWords_(type(c))}, but the plan needs ${nsvTypeWords_(EWS_AMI_NEEDED_[c])}`));
  if (!missing.length && !wrong.length) lines.push(`OK the AMIE table can be read and has every column the plan needs, of the right type (${r.body.schema.fields.length} columns in all)`);
  const optional = Object.keys(EWS_AMI_OPTIONAL_);
  const optMissing = optional.filter(c => !type(c));
  lines.push(`${optMissing.length ? 'CHECK' : 'OK'} the AMIE table's optional columns: ` + optional.filter(c => type(c))
    .map(c => `${c} (${type(c)})`).concat(optMissing.map(c => `${c} missing (read as empty)`)).join(', '));
  const part = r.body.timePartitioning || null;
  const field = part ? String(part.field || 'the time rows were loaded') : '';
  lines.push(part && field.toLowerCase() === 'ingestiontimestamp'
    ? `OK the AMIE table is partitioned by ${String(part.type || 'DAY').toLowerCase()} on ingestionTimestamp`
    : `PROBLEM the AMIE table is ${part ? `partitioned on ${field}, not on ingestionTimestamp` : 'not partitioned by time'}: a read by ingestionTimestamp would scan more than one day`);
  const changed = Number(r.body.lastModifiedTime) || 0;
  lines.push(!changed ? 'CHECK the AMIE table\'s metadata does not say when it last changed'
    : `${now - changed > ewsAmiCfg_().staleMs ? 'CHECK' : 'OK'} the AMIE table last changed ${nsvMinutes_((now - changed) / 60000)} ago ` +
      `(${new Date(changed).toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
  return { cols };
}

/** A BigQuery column type in plain words, the type after them: "text (STRING)", "a time (TIMESTAMP)". Pure. */
function nsvTypeWords_(type) {
  const t = String(type || '').toUpperCase();
  const words = { STRING: 'text', TIMESTAMP: 'a time', DATETIME: 'a time', DATE: 'a date', INTEGER: 'a whole number', INT64: 'a whole number',
    FLOAT: 'a number', FLOAT64: 'a number', NUMERIC: 'a number', BOOLEAN: 'yes or no', BOOL: 'yes or no', RECORD: 'a group of fields' };
  const base = t.replace(/^REPEATED /, '');
  const w = words[base] ? (t === base ? words[base] : `a list of ${words[base].replace(/^an? /, '')}`) : 'something else';
  return `${w} (${t || 'no type'})`;
}

/** The one-day SELECT of the AMIE table: rows, newest ingestionTimestamp, rows by network, no postTime, the delay. Pure. */
function nsvAmieSql_() {
  return [
    `WITH d AS (SELECT SocialNetwork, postTime, ingestionTimestamp FROM \`${EWS_AMI_TABLE_}\``,
    '  WHERE ingestionTimestamp > TIMESTAMP_MILLIS(@from_ms) AND ingestionTimestamp <= TIMESTAMP_MILLIS(@until_ms))',
    'SELECT \'all\' AS kind, \'\' AS net, COUNT(*) AS n, UNIX_MILLIS(MAX(ingestionTimestamp)) AS newest_ms,',
    '  COUNTIF(postTime IS NULL) AS no_post_time,',
    '  APPROX_QUANTILES(TIMESTAMP_DIFF(ingestionTimestamp, postTime, MINUTE), 100 IGNORE NULLS)[SAFE_OFFSET(50)] AS median_min,',
    '  APPROX_QUANTILES(TIMESTAMP_DIFF(ingestionTimestamp, postTime, MINUTE), 100 IGNORE NULLS)[SAFE_OFFSET(90)] AS p90_min',
    'FROM d',
    'UNION ALL',
    'SELECT \'net\', IFNULL(SocialNetwork, \'\'), COUNT(*), NULL, NULL, NULL, NULL FROM d GROUP BY 2',
  ].join('\n');
}

/**
 * The AMIE table's one-day read: a dry run first (the bytes it would scan); only when that is under 1 GB, the SELECT
 * itself with maximumBytesBilled set, its answer waited for at most twice more. `schema`: nsvAmieSchema_'s, or null
 * (the dry run is still sent: it says on its own whether the bot may read the table).
 */
function nsvAmieRead_(token, lines, schema, now) {
  if (schema && ['SocialNetwork', 'postTime', 'ingestionTimestamp'].some(c => schema.cols[c.toLowerCase()] !== EWS_AMI_NEEDED_[c])) {
    lines.push('CHECK the AMIE table\'s one-day read was not sent: a column it counts by is missing or of another type (above)');
    return;
  }
  const request = {
    query: nsvAmieSql_(), useLegacySql: false, location: 'US', parameterMode: 'NAMED',
    queryParameters: [ewsParam_({ name: 'from_ms', type: 'INT64', value: now - 24 * 60 * 60 * 1000 }),
      ewsParam_({ name: 'until_ms', type: 'INT64', value: now })],
    labels: { purpose: 'live-check', tool: 'burson-qa-bot' },
  };
  const url = `${BQ_API_BASE_}${GCP_PROJECT}/queries`;
  const dry = nsvBq_(token, url, Object.assign({ dryRun: true }, request));
  if (dry.code !== 200 || !dry.body) { lines.push(nsvBqRefusal_('the dry run of the AMIE table\'s one-day read', dry)); return; }
  const bytes = Number(dry.body.totalBytesProcessed);
  if (dry.body.totalBytesProcessed === undefined || !isFinite(bytes)) {
    lines.push('CHECK the dry run of the AMIE table\'s one-day read did not say how many bytes it would scan, so the read was not sent');
    return;
  }
  const gb = `${(bytes / 1e9).toFixed(2)} GB`;
  const cfg = ewsAmiCfg_();
  if (bytes >= cfg.maxBytes) { lines.push(`PROBLEM one day of the AMIE table would scan ${gb} (the limit is ${cfg.maxGb} GB), so the read was not sent`); return; }
  lines.push(`OK one day of the AMIE table scans ${gb} (the dry run's figure; the limit is ${cfg.maxGb} GB)`);
  let r = nsvBq_(token, url, Object.assign({ timeoutMs: 30000, maximumBytesBilled: String(cfg.maxBytes), maxResults: 1000 }, request));
  for (let i = 0; i < 2 && r.code === 200 && r.body && !r.body.jobComplete && r.body.jobReference && r.body.jobReference.jobId; i++) {
    const ref = r.body.jobReference;
    r = nsvBq_(token, `${BQ_API_BASE_}${encodeURIComponent(ref.projectId || GCP_PROJECT)}/queries/${encodeURIComponent(ref.jobId)}` +
      `?location=${encodeURIComponent(ref.location || 'US')}&timeoutMs=30000&maxResults=1000`);
  }
  if (r.code !== 200 || !r.body) { lines.push(nsvBqRefusal_('the AMIE table\'s one-day read', r)); return; }
  if (!r.body.jobComplete) { lines.push('CHECK the AMIE table\'s one-day read did not finish in time; run the check again'); return; }
  const rows = parseBqRows_(r.body);
  const all = rows.find(x => x.kind === 'all') || {};
  const n = Number(all.n) || 0;
  if (!n) { lines.push('CHECK the AMIE table has no row from the last 24 hours'); return; }
  const newest = Number(all.newest_ms) || 0;
  lines.push(`${!newest || now - newest > ewsAmiCfg_().staleMs ? 'CHECK' : 'OK'} the AMIE table, last 24 hours: ${fmtInt_(n)} rows; the newest landed ` +
    (newest ? `${nsvMinutes_((now - newest) / 60000)} ago` : 'at a time it does not say'));
  const nets = rows.filter(x => x.kind === 'net').sort((a, b) => (Number(b.n) || 0) - (Number(a.n) || 0));
  const pct = k => `${Math.round((k / n) * 100)}%`;
  const xRows = nets.filter(x => /^(?:twitter|x)$/i.test(String(x.net || '').trim())).reduce((s, x) => s + (Number(x.n) || 0), 0);
  lines.push(`OK the AMIE table by network: ${nets.slice(0, 8).map(x => `${nsvScrub_(x.net || 'none', '')} ${pct(Number(x.n) || 0)}`).join(', ')}` +
    `${nets.length > 8 ? ', ...' : ''}; X is ${pct(xRows)} of the rows (${fmtInt_(xRows)})`);
  const noTime = Number(all.no_post_time) || 0;
  lines.push(`${noTime * 10 > n ? 'CHECK' : 'OK'} rows with no posting time: ${fmtInt_(noTime)} of ${fmtInt_(n)} (they would be left out)`);
  const med = all.median_min === null || all.median_min === undefined ? null : Number(all.median_min);
  lines.push(med === null ? 'CHECK how late the AMIE table\'s rows come could not be measured (no posting times)'
    : `${med > NSV_SLOW_MINUTES_ ? 'CHECK' : 'OK'} from posting to the AMIE table: median ${nsvMinutes_(med)}, 90% within ${nsvMinutes_(Number(all.p90_min))}` +
      (med > NSV_SLOW_MINUTES_ ? ' (slower than 2 hours: most of its posts would only join stories)' : ''));
}

/**
 * Dry runs of the new Early Detection jobs' SQL, as the plan's Q4 says, each sent with dryRun: true (BigQuery checks the
 * names, the types and the access, scans nothing and says the bytes) and reported as one OK or PROBLEM line: the AMIE
 * job exactly as a check builds it (ewsAmiQuery_, with the optional columns the metadata found in `schema`, or none),
 * and the us-central1 job with its list of the big posts Sonar knew (only sent while a new row is ON). STEP 2b ADDS
 * HERE the Brandwatch job's dry run with three made-up @bwl rows. `now`: the check's time (default the clock).
 */
function nsvNewJobDryRuns_(token, schema, now) {
  const at = Number(now) || Date.now();
  const until = at - EWS_SETTLE_MS_;
  const url = `${BQ_API_BASE_}${GCP_PROJECT}/queries`;
  const gbOf = r => `${(Number(r.body && r.body.totalBytesProcessed) / 1e9).toFixed(2)} GB`;
  const hasBytes = r => !!(r.body && r.body.totalBytesProcessed !== undefined && r.body.totalBytesProcessed !== null &&
    isFinite(Number(r.body.totalBytesProcessed)));
  const dry = (lane, q) => nsvBq_(token, url, Object.assign(JSON.parse(ewsJobRequest_(lane, q, token).payload), { dryRun: true }));
  const out = [];
  // the AMIE job (row 48)
  const cols = (schema && schema.cols) || {};
  const opt = Object.keys(EWS_AMI_OPTIONAL_).filter(c => (EWS_AMI_OPTIONAL_[c] || []).indexOf(String(cols[c.toLowerCase()] || '')) >= 0);
  const cfg = ewsAmiCfg_();
  const ami = dry({ key: 'ami', location: 'US' }, ewsAmiQuery_({ marks: { amiq: { opt } } }, until));
  if (ami.code !== 200 || !ami.body) out.push(nsvBqRefusal_('the dry run of Early Detection\'s AMIE job', ami));
  else if (!hasBytes(ami)) out.push('CHECK the dry run of Early Detection\'s AMIE job did not say how many bytes it would scan');
  else if (Number(ami.body.totalBytesProcessed) > cfg.maxBytes) {
    out.push(`PROBLEM Early Detection's AMIE job would scan ${gbOf(ami)} a read (its limit is ${cfg.maxGb} GB), so it would not be read`);
  } else out.push(`OK Early Detection's AMIE job passes a dry run: ${gbOf(ami)} a read (its limit is ${cfg.maxGb} GB)`);
  // the us-central1 job with its big posts' part
  const c1 = dry({ key: 'c1', location: 'us-central1' }, ewsLaneQuery_('c1', { marks: {} }, until, false, 60, { xbig: true }));
  const what = 'Early Detection\'s us-central1 job with its list of big posts (sent only while a new row is ON)';
  if (c1.code !== 200 || !c1.body) out.push(`PROBLEM the dry run of ${what}: ${c1.code ? `BigQuery refused (HTTP ${c1.code}: ${c1.why})` : `the call to BigQuery did not complete (${c1.why})`}`);
  else out.push(`OK ${what} passes a dry run${hasBytes(c1) ? `: ${gbOf(c1)}` : ''}`);
  return out;
}
