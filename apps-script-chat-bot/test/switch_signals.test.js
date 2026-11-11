// Signals (Signals.gs) and the watchdog (Watchdog.gs): the two-track SLRR system on the bot's side. Its results reach the
// chat through the flows the Control tab already routes: Track 1's qualifying classifications become flags on the Watch
// detections tab, posted as watch alerts where Watch alerts (row 35) says and worked there like any alert (even with the
// Proactive watch, row 34, OFF); the radar's promoted or high-likelihood clusters join the Early detection review queue
// (row 19). Each hand-off is recorded once in slrr_signals.handoffs; rows 35 and 19 OFF, nothing is handed over. The
// bot-made "Signals" tab holds the rest, each switch OFF until a person turns it ON: sync to BigQuery (taxonomy from the
// Watch tags tab, alert history, ratings), the daily archive of old rows (copied, checked, then trimmed), the long memory
// for analyst answers, and a watchdog that notices (and, when ON, pauses) a background step that keeps getting runs
// stopped. Its last two rows say how each track's hand-off and the Cloud Run engine are doing.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, e2e, REAL } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const TAB = 'Signals';
  const T1 = 'Classification (Collection Requirements)';
  const tab = (t, name) => t.sheet().getSheetByName(name);
  const setting = (t, key, v) => tab(t, TAB).getRange(3 + B.ev('SIG_ROWS_').findIndex(r => r[0] === key), 2).setValue(v);
  const status = (t, key) => tab(t, TAB).cell(3 + B.ev('SIG_ROWS_').findIndex(r => r[0] === key), 3);
  const ROWS = [
    ['Sync taxonomy, alert history and ratings to BigQuery', 'OFF'], ['Archive old rows to BigQuery, then trim them here', 'OFF'],
    ['Archive: days of the Alert log kept on the sheet', 21], ['Archive: days of the Message log kept on the sheet', 14],
    ['Archive: days of the Relay tab kept on the sheet', 30], ['Pause a background step that keeps getting stuck (30 min)', 'OFF'],
    ['Classified alerts (Track 1): posted as Watch alerts', 'Control row 35'],
    ['Radar alerts (Track 2): reviewed as Early detection', 'Control row 19']];
  const T1_OFF = 'waiting: Watch alerts (Control row 35) is OFF, so classified alerts stay in BigQuery';
  const T2_OFF = 'waiting: Early wave & velocity check (Control row 19) is OFF, so radar alerts stay in BigQuery';
  // The retired dry-run mode's name, spelled with [h] so that a search of the repo for the word doesn't find this file.
  const RETIRED_RX = /s[h]adow/i;

  /**
   * A fake BigQuery for Signals: queries answer `bq.answer(sql, params)` (rows), inserts (tabledata.insertAll) are kept
   * in bq.inserts[table] (with insert ids); every call is recorded. bq.refuse: insert errors to return.
   */
  function fakeBq(g) {
    const bq = { queries: [], inserts: {}, ids: {}, answer: () => [], refuse: null };
    const prev = g.services.UrlFetchApp.fetch;
    const resp = (code, body) => ({ getResponseCode: () => code, getHeaders: () => ({}), getContentText: () => JSON.stringify(body) });
    g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      if (!url.startsWith('https://bigquery.googleapis.com/')) return prev(link, params);
      const body = params && params.payload ? JSON.parse(params.payload) : {};
      const ins = url.match(/\/datasets\/slrr_signals\/tables\/([a-z_]+)\/insertAll$/);
      if (ins) {
        if (bq.refuse) return resp(200, { insertErrors: bq.refuse });
        (bq.inserts[ins[1]] = bq.inserts[ins[1]] || []).push(...body.rows.map(r => r.json));
        (bq.ids[ins[1]] = bq.ids[ins[1]] || []).push(...body.rows.map(r => r.insertId));
        return resp(200, {});
      }
      if (/\/queries$/.test(url)) {
        const p = Object.fromEntries((body.queryParameters || []).map(q => [q.name, q.parameterValue.value !== undefined
          ? q.parameterValue.value : (q.parameterValue.arrayValues || []).map(v => v.value)]));
        if (!/slrr_signals/.test(body.query || '')) return prev(link, params);
        bq.queries.push({ sql: body.query, params: p });
        const rows = bq.answer(body.query, p) || [];
        const names = rows.length ? Object.keys(rows[0]) : [];
        return resp(200, { jobComplete: true, schema: { fields: names.map(n => ({ name: n, type: typeof rows[0][n] === 'number' ? 'INTEGER'
          : typeof rows[0][n] === 'boolean' ? 'BOOLEAN' : 'STRING' })) },
          rows: rows.map(r => ({ f: names.map(n => ({ v: r[n] === null || r[n] === undefined ? null : String(r[n]) })) })) });
      }
      return prev(link, params);
    };
    return bq;
  }

  const world = () => {
    const t = e2e();
    t.bot.setup();
    return { t, bq: fakeBq(t.g) };
  };

  // ===========================================================================================================
  // The tab: made by the bot, every switch OFF; with Control rows 35 and 19 OFF nothing is handed over
  // ===========================================================================================================

  test('signals: the first run makes the Signals tab (each switch OFF with its ON/OFF dropdown, the days kept, the two tracks\' rows saying where the Control tab routes them); with everything OFF nothing is sent to or read from BigQuery, nothing is handed over and nothing is trimmed; no other tab is made, no word of the retired dry-run mode anywhere; a "Signals" tab people made is never touched', () => {
    const { t, bq } = world();
    for (let i = 0; i < 3; i++) t.poll();
    const sh = tab(t, TAB);
    eq([sh.cell(1, 1), sh.rows[1]], [B.ev('SIG_TITLE_'), B.ev('SIG_HEADER_')]);
    eq(sh.rows.slice(2, 10).map(r => r.slice(0, 2)), ROWS);
    eq(['3,2', '4,2', '8,2'].map(k => sh.validations[k].values), [['ON', 'OFF'], ['ON', 'OFF'], ['ON', 'OFF']]);
    eq(['5,2', '6,2', '7,2', '9,2', '10,2'].map(k => sh.validations[k] || null), [null, null, null, null, null]);
    eq([bq.queries.length, Object.keys(bq.inserts).length], [0, 0]);
    eq([status(t, 'sync'), status(t, 'archive'), status(t, 'track1'), status(t, 'track2')],
      ['OFF: nothing is sent to BigQuery', 'OFF: every row stays on the sheet', T1_OFF, T2_OFF]);
    assert.match(status(t, 'watchdog'), /^OFF: a step that keeps stopping runs is only reported here/);
    eq(t.sheet().getSheets().map(s => s.getName()).filter(n => /track|radar/i.test(n) || RETIRED_RX.test(n)), []);
    assert.ok(!RETIRED_RX.test(JSON.stringify(sh.rows)), 'nothing of the retired dry-run mode on the tab');
    // once its statuses are there, an all-OFF tab costs no writes a run
    let writes = 0;
    const getRange = sh.getRange.bind(sh);
    sh.getRange = (...a) => {
      const r = getRange(...a);
      ['setValue', 'setValues'].forEach(m => { const f = r[m].bind(r); r[m] = v => { writes++; return f(v); }; });
      return r;
    };
    t.poll();
    eq(writes, 0);
    // someone's own "Signals" tab
    const other = world();
    const theirs = other.t.sheet().insertSheet(TAB);
    theirs.getRange(1, 1, 1, 2).setValues([['My', 'notes']]);
    other.t.poll();
    eq([theirs.rows, other.bq.queries.length], [[['My', 'notes']], 0]);
  });

  test('signals: the tab from before Nov 11 (with its "Show Track 1 and the radar" row) is laid out anew on the next run: that row is gone, every value a person gave is kept by its label, the dropdowns sit on the switches only, the two tracks\' rows are added', () => {
    const { t, bq } = world();
    t.poll();
    const sh = tab(t, TAB);
    const old = [['Sync taxonomy, alert history and ratings to BigQuery', 'OFF', 'OFF: nothing is sent to BigQuery'],
      ['Show Track 1 and the radar on this sheet', 'ON', 'old words'], ['Archive old rows to BigQuery, then trim them here', 'OFF', ''],
      ['Archive: days of the Alert log kept on the sheet', 25, ''], ['Archive: days of the Message log kept on the sheet', 14, ''],
      ['Archive: days of the Relay tab kept on the sheet', 30, ''], ['Pause a background step that keeps getting stuck (30 min)', 'ON', '']];
    sh.rows = sh.rows.slice(0, 2).concat(old.map(r => r.slice()));
    sh.validations = { '3,2': { values: ['ON', 'OFF'] }, '4,2': { values: ['ON', 'OFF'] }, '5,2': { values: ['ON', 'OFF'] },
      '9,2': { values: ['ON', 'OFF'] } };
    t.poll();
    eq(sh.rows.slice(2, 10).map(r => r.slice(0, 2)), [ROWS[0], ROWS[1], [ROWS[2][0], 25], ROWS[3], ROWS[4], [ROWS[5][0], 'ON'],
      ROWS[6], ROWS[7]]);
    eq(sh.rows.length, 10);
    eq(['3,2', '4,2', '5,2', '6,2', '7,2', '8,2', '9,2', '10,2'].map(k => (sh.validations[k] ? sh.validations[k].values : null)),
      [['ON', 'OFF'], ['ON', 'OFF'], null, null, null, ['ON', 'OFF'], null, null]);
    assert.ok(!/Show Track 1|old words/.test(JSON.stringify(sh.rows)));
    eq(B.sigSettingsOf_(sh.getRange(3, 2, 8, 1).getValues()), { sync: false, archive: false, alertDays: 25, messageDays: 14,
      relayDays: 30, watchdog: true });
    eq(bq.queries.length, 0);
    // laid out once: the next run only reads it
    let writes = 0;
    const getRange = sh.getRange.bind(sh);
    sh.getRange = (...a) => {
      const r = getRange(...a);
      ['setValue', 'setValues', 'clearContent'].forEach(m => { const f = r[m].bind(r); r[m] = v => { writes++; return f(v); }; });
      return r;
    };
    t.poll();
    eq(writes, 0);
  });

  test('signals: while the bot is paused (B2 OFF) the Signals tab is still made, every switch OFF, so it can be set up first; nothing of it runs (no BigQuery, no other tab) until the bot is ON again', () => {
    const { t, bq } = world();
    t.set('B2', 'OFF');
    t.poll();
    const sh = tab(t, TAB);
    eq([sh.cell(1, 1), sh.rows.slice(2, 10).map(r => r[1])], [B.ev('SIG_TITLE_'), ROWS.map(r => r[1])]);
    setting(t, 'sync', 'ON');
    t.poll();
    eq([bq.queries.length, Object.keys(bq.inserts).length, status(t, 'sync')], [0, 0, 'OFF']);
    t.set('B2', 'ON');
    t.poll();
    eq(bq.inserts.taxonomy.length, 58, 'ON again: the sync runs');
  });

  test('signals: settings read ON only when they say ON; days below a tab\'s least count as it (the Alert log 15, as the bot\'s 14-day already-reported check reads the sheet; the others 7); blank or unreadable days are the defaults; the two tracks\' rows are no settings', () => {
    const S = B.sigSettingsOf_([['ON'], ['yes'], [3], ['x'], [''], ['on '], ['ON'], ['ON']]);
    eq(S, { sync: true, archive: false, alertDays: 15, messageDays: 14, relayDays: 30, watchdog: true });
    eq(B.sigSettingsOf_(null).alertDays, 21);
    const T = B.sigSettingsOf_([['OFF'], ['OFF'], [20], [3], [45], ['OFF']]);
    eq([T.alertDays, T.messageDays, T.relayDays], [20, 7, 45]);
  });

  // ===========================================================================================================
  // Track 1 -> Watch alerts (Control row 35)
  // ===========================================================================================================

  const ROOM = 'https://chat.google.com/room/AAQAaa_0I9g';
  const MIRROR = 'spaces/AAQAmirrorS1';
  const MIRROR_NAME = 'SLRR Zapier Training Mirror';
  const AC = 'spaces/AAQAautocorrectS1';
  const AC_NAME = 'SLRR Auto-correct Unified';
  const POST = 'https://x.com/CorrDove/status/1980000000000000001';
  const KEY = 'x.com/status/1980000000000000001';
  /** Gemini's triage of a watch alert (FakeVertex.triage), as in switch_watch_alerts. */
  const triage = () => () => ({
    summary: 'An X post says Gemini told them to mix bleach and ammonia to clean a bathroom.',
    issue_name: 'Gemini bleach-and-ammonia advice',
    stream_fit: 'A dangerous-advice claim about Gemini.',
    risks: ['dangerous_advice'],
    stream_call: { action: 'escalate', severity: 'medium', confidence: 0.9, reason: 'Dangerous advice attributed to Gemini',
      watch_for: 'A KOF or press pickup' },
    slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Product - Dangerous results (e.g. medical/legal)', product: 'Gemini',
      sensitive_topics: [], warranted: true, warranted_confidence: 0.9, why: 'A dangerous result attributed to Gemini' },
    tns: { needed: false },
  });
  /** A qualifying Track 1 row, as the hand-off's query returns it. */
  const t1Row = (t, o) => Object.assign({ mention_key: KEY, source: 'sonar', post_url: POST, platform: 'twitter', author: '@CorrDove',
    engagement: 40, posted_ms: t.g.clock.now - 20 * MIN, classified_ms: t.g.clock.now - MIN,
    exposure_tag: 'Product - Dangerous results (e.g. medical/legal)', exposure_priority: 'P0', risk_tag: '', products: 'Gemini',
    issue_name: 'Gemini bleach-and-ammonia advice', issue_status: 'NEW',
    summary: 'An X post (@CorrDove) says Gemini told them to mix bleach and ammonia to clean a bathroom.', urgency: 'urgent',
    confidence: 0.92, rule_track: 'urgent', followers: 1700, kof_lists: '' }, o || {});

  /**
   * setup(); S-F Burson in B25; Testing (the Safety valve ON); the Auto-correct space (B10) as the only test space (B4 and
   * B9 blank: the setup this team runs); Watch alerts (row 35) to the Auto-correct space; the Proactive watch (row 34) OFF.
   */
  const routed = () => {
    const t = e2e();
    t.chat.addSpace(MIRROR, MIRROR_NAME);
    t.chat.addSpace(AC, AC_NAME);
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    const bq = fakeBq(t.g);
    t.set('B25', ROOM);
    t.bot.startMirror(MIRROR_NAME);
    t.control().getRange(29, 2).setValue('ON');  // Testing
    t.control().getRange(4, 2).setValue('');
    t.control().getRange(9, 2).setValue('');
    t.control().getRange(10, 2).setValue(AC_NAME);
    t.control().getRange(35, 2).setValue('Auto-correct space (B10)');
    t.g.vertex.triage = triage();
    return { t, bq };
  };
  const watchPosts = (t, space) => t.chat.botPosts(space).filter(m => !m.threadReply && /^client-zwat-/.test(m.clientAssignedMessageId || ''));
  const detKeys = t => tab(t, 'Watch detections').rows.slice(13).filter(r => (r || []).some(v => v !== '' && v != null)).map(r => JSON.parse(r[18]));
  const handed = bq => (bq.inserts.handoffs || []).map(h => h.mention_key);

  test('signals Track 1 (Watch alerts ON, row 35): each qualifying classification not handed over yet goes on the Watch detections tab as a flag queued for posting (watch "Classification (Collection Requirements)", its score Gemini\'s confidence out of 10 against a bar of 8, its exposure tags, Track 1\'s classification marked firm), recorded once in slrr_signals.handoffs; the next run posts it in the Auto-correct space (B10) as a watch alert carrying Track 1\'s Exposure Tag, even with the Proactive watch (row 34) OFF, and the space\'s flow works it like any alert (its Social Alert only to the testers); nothing reaches S-F Burson', () => {
    const { t, bq } = routed();
    bq.answer = sql => (/classified_mentions/.test(sql) ? [t1Row(t)].filter(r => !handed(bq).includes(r.mention_key))
      : /run_log/.test(sql) ? [{ endpoint: 'tick', status: 'ok', started_ms: t.g.clock.now - MIN }]
        : /v_source_health/.test(sql) ? [{ source: 'sonar', status: 'live' }, { source: 'tubular', status: 'failing (3): 403' }] : []);
    t.poll();
    // the hand-off: one flag, queued, Track 1's
    const k = detKeys(t);
    eq(k.map(x => [x.w, x.k, x.a, x.sc, x.br, x.b]), [[T1, KEY, 'q', 9, 8, 1]]);
    eq([k[0].x.f, k[0].x.t, k[0].x.p, k[0].x.k], [1, 'Product - Dangerous results (e.g. medical/legal)', ['Gemini App'], false]);
    const row = tab(t, 'Watch detections').rows[13];
    eq([row[1], row[2], row[3], row[4], row[5], row[6]], [T1, 9, 'Yes', 'P0 · Product - Dangerous results (e.g. medical/legal)', POST,
      'Sonar · classified, urgent track']);
    eq(bq.inserts.handoffs.map(h => [h.mention_key, h.outcome]), [[KEY, 'watch_alerts']]);
    eq(bq.ids.handoffs, [`t1:${KEY}`]);
    const q = bq.queries.find(x => /classified_mentions/.test(x.sql));
    eq([q.params.hours, q.params.limit], ['3', '10']);
    assert.match(q.sql, /WHERE c\.qualifies AND h\.mention_key IS NULL/);
    assert.match(status(t, 'track1'), /^✓ .* ET: 1 handed to Watch alerts \(Auto-correct space \(B10\)\) · 1 today · engine: last run .* ET \(ok\) · sources live 1 of 2 \(tubular: failing \(3\): 403\)$/);
    // the next run posts it (row 34 OFF), as a watch alert with Track 1's lines
    t.poll();
    const out = watchPosts(t, AC);
    eq(out.length, 1);
    const lines = out[0].text.split('\n');
    eq(lines[0], `\ud83d\udd2d *Watch alert · ${T1}*`);
    assert.ok(lines.some(l => /^\*Exposure Tag:\* Product - Dangerous results \(e\.g\. medical\/legal\)/.test(l)), out[0].text);
    assert.ok(lines.includes('*Product:* Gemini App') && lines.includes('*KOF:* No'), out[0].text);
    eq(detKeys(t)[0].a, 'p');
    assert.match(t.control().cell(35, 3), /^✓ SLRR Auto-correct Unified \(B10\): .* · today: 1 posted$/);
    // ...and the space's flow works it
    out[0].formattedText = out[0].text;
    out[0].text = out[0].text.replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, '$2');
    t.poll();
    const notes = t.chat.botPosts(AC).filter(p => p.thread.name === out[0].thread.name && p.name !== out[0].name);
    // its triage note (the classification's call, as a watch's), then the T&S note a Gemini dangerous result needs
    eq(notes.length, 2);
    assert.match(notes[0].text, /^\ud83e\udd16 \*Triage: \ud83d\udce6 Social Alert \(the watch\)\* · medium\n.*the Classification \(Collection Requirements\) watch scored it 9 of 10 \(it flags at 8\)/);
    assert.match(notes[1].text, /^T&S form needed/);
    const alert = t.bot.sheetBackend_(t.sheet()).loadAlerts().find(r => r.source_message === out[0].name);
    eq(alert.ingested, 'Watch alert');
    t.g.gmail.sentMessages().forEach(m => eq(m.to, ['tester@testing.test'], m.subject));
    eq(t.chat.calls.filter(c => c.method !== 'get' && String(c.path).indexOf(REAL) === 0), []);
    // handed over once: later looks find nothing new (2 minutes apart at most)
    t.g.clock.now += 3 * MIN;
    t.poll();
    eq([detKeys(t).length, bq.inserts.handoffs.length], [1, 1]);
    assert.match(status(t, 'track1'), /^✓ checked .* ET: nothing new to hand over · 1 handed to Watch alerts \(Auto-correct space \(B10\)\) today/);
  });

  test('signals Track 1: Watch alerts OFF (row 35), nothing is handed over and nothing is read for it (the classifications wait in BigQuery); with the Proactive watch ON too, a classified alert goes out with the watch\'s own flags', () => {
    const { t, bq } = routed();
    t.control().getRange(35, 2).setValue('OFF');
    bq.answer = sql => (/classified_mentions/.test(sql) ? [t1Row(t)] : []);
    t.poll();
    t.poll();
    eq([bq.queries.filter(x => /classified_mentions|run_log|v_source_health/.test(x.sql)).length, bq.inserts.handoffs, status(t, 'track1')],
      [0, undefined, T1_OFF]);
    t.control().getRange(35, 2).setValue('Auto-correct space (B10)');
    t.control().getRange(34, 2).setValue('ON');
    t.poll();
    t.poll();
    eq(watchPosts(t, AC).map(m => m.text.split('\n')[0]), [`\ud83d\udd2d *Watch alert · ${T1}*`]);
  });

  test('signals Track 1: a classification becomes the flag the watch alerts post (sigT1Flag_); the card keeps Track 1\'s Product / Exposure Tag / Sensitive Topic whatever the pre-read says (firm), while a watch\'s flag still takes the pre-read\'s', () => {
    const f = B.sigT1Flag_({ post_url: POST, source: 'tubular', confidence: 0.81, classified_ms: 1000, exposure_tag: 'Brand - Litigation',
      exposure_priority: 'P1', risk_tag: 'Politics', products: 'Search|Gemini', rule_track: '2k', issue_status: 'ONGOING', engagement: 2400 });
    eq([f.watch, f.impact, f.bar, f.seen_ms, f.topic, f.issue_new, f.why, f.eng], [T1, 8, 8, 1000,
      'P1 · Brand - Litigation; Sensitive · Politics', false, 'classified, 2K+ track', 2400]);
    eq(JSON.parse(f.tax), { p: ['Search', 'Gemini'], t: 'Brand - Litigation', s: ['Politics'], f: 1 });  // no KOF word: unknown
    const tax = B.pwTaxOf_(f.tax);
    eq([tax.f, tax.t, tax.s, tax.k], [1, 'Brand - Litigation', ['Politics'], null]);
    const pre = { summary: 'Pre-read words', products: ['YouTube'], tag: 'Content - Negative reaction to owned social post', topics: [],
      about: false, meaningful: true };
    const firm = B.pwCardOf_({ a: { summary: 's', tax } }, pre, null, null);
    eq([firm.products, firm.topics, firm.notGoogle, /Brand - Litigation/.test(firm.tag)], [['Search', 'Gemini App'], ['Politics'], undefined, true]);
    const loose = B.pwCardOf_({ a: { summary: 's', tax: Object.assign({}, tax, { f: undefined }) } }, Object.assign({}, pre, { about: true }), null, null);
    eq([loose.products, loose.tag], [['YouTube'], 'Content - Negative reaction to owned social post']);
  });

  // ===========================================================================================================
  // Track 2 -> the Early detection review (Control row 19)
  // ===========================================================================================================

  /** A radar assessment, as the hand-off's query returns it. */
  const radarRow = (t, o) => Object.assign({ cluster_id: 'ed:c1', origin: 'early_detection', origin_ref: 'c1',
    assessed_ms: t.g.clock.now - 2 * MIN, headline: 'Pixel 10 batteries swelling after the update',
    texts: JSON.stringify(['My Pixel 10 battery is bulging after the update', 'Same here, phone case popped open']),
    urls: JSON.stringify(['https://www.reddit.com/r/GooglePixel/comments/abc', 'https://x.com/u2/status/1980000000000000009']),
    mentions: 14, authors: 9, platforms: 'reddit, twitter', velocity_ratio: 4.5, likelihood: 'high', action: 'promote',
    closest_tag: 'Product - Product failures - physical safety issues', closest_priority: 'P1',
    rationale: 'Battery swelling reports are spreading across two networks within hours.', first_ms: t.g.clock.now - 5 * HOUR,
    last_ms: t.g.clock.now - 10 * MIN }, o || {});

  test('signals Track 2 (Early wave ON, row 19): each assessment Gemini promoted or rated high, not handed over yet, joins the Early detection review queue as a RADAR signal (the cluster early_detection knows it by, its posts with their links, reach and pace, its closest tag\'s priority, the radar\'s outlook), recorded once in slrr_signals.handoffs; row 19 OFF, nothing is handed over or read for it', () => {
    const { t, bq } = routed();
    bq.answer = sql => (/v_radar_latest/.test(sql) ? [radarRow(t)].filter(r => !handed(bq).includes(`radar:${r.cluster_id}@${r.assessed_ms}`)) : []);
    t.poll();
    eq([bq.queries.filter(x => /v_radar_latest/.test(x.sql)).length, status(t, 'track2').slice(0, T2_OFF.length)], [0, T2_OFF]);
    t.control().getRange(19, 2).setValue('ON');
    t.poll();
    const queue = JSON.parse(t.g.props.get(B.ev('ED_QUEUE_PROP_')));
    eq(queue.map(e => [e.pri, e.au, e.sig, e.tries]), [['P1', 9, 'c', 0]]);
    const row = JSON.parse(t.g.props.get(B.ev('ED_QUEUE_ROW_PREFIX_') + queue[0].k));
    eq([row.signal_type, row.cluster_id, row.priority_hint, row.primary_url, row.platforms_csv, row.radar_likelihood, row.radar_tag],
      ['RADAR', 'c1', 'P1', 'https://www.reddit.com/r/GooglePixel/comments/abc', 'reddit, twitter', 'high',
        'P1 · Product - Product failures - physical safety issues']);
    eq(row.posts.map(p => [p.url, p.snippet]), [['https://www.reddit.com/r/GooglePixel/comments/abc', 'My Pixel 10 battery is bulging after the update'],
      ['https://x.com/u2/status/1980000000000000009', 'Same here, phone case popped open']]);
    const assessedMs = radarRow(t).assessed_ms;
    eq(bq.inserts.handoffs.map(h => [h.mention_key, h.outcome, /^radar-[0-9a-f]{12}$/.test(h.alert_id)]),
      [[`radar:ed:c1@${assessedMs}`, 'early_detection_queue', true]]);
    assert.match(bq.queries.find(x => /v_radar_latest/.test(x.sql)).sql, /\(l\.action = 'promote' OR l\.likelihood = 'high'\)/);
    assert.match(status(t, 'track2'), /^✓ .* ET: 1 handed to the Early detection review · 1 today/);
  });

  test('signals Track 2: a radar signal reads as an Early detection signal of its own kind: its label and summary carry the radar\'s outlook; its accounts are "small" only when its cluster came from early_detection', () => {
    const { t } = world();
    const fromEd = B.edFromRow_(B.edQueueCompact_(B.sigRadarRow_(radarRow(t))));
    eq([fromEd.signalType, fromEd.signalLabel, fromEd.clusterId, fromEd.priorityHint, fromEd.lowTier],
      ['RADAR', 'Emerging story the radar rates likely to become an alert', 'c1', 'P1', true]);
    assert.match(fromEd.summary, /^Emerging story the radar rates likely to become an alert: 9 distinct low-tier authors \(14 mentions across reddit, twitter\), 4\.5x its earlier pace\. Radar outlook: high likelihood of meeting the Collection Requirements if left alone \(promote\); closest tag: P1 · Product - Product failures - physical safety issues\. Battery swelling/);
    const issue = B.edFromRow_(B.edQueueCompact_(B.sigRadarRow_(radarRow(t, { cluster_id: 'issue:9f2', origin: 'raw_mentions',
      origin_ref: 'Pixel battery swelling' }))));
    eq([issue.clusterId, issue.signalKey, issue.lowTier], ['issue:9f2', 'Pixel battery swelling', false]);
    // a closest tag Gemini gave as its "P0 · <name>" label (its priority then blank): read by its name, P0 from the label
    const labelled = B.sigRadarRow_(radarRow(t, { closest_tag: 'P0 · Product - Public leak (e.g. features/models)', closest_priority: null }));
    eq([labelled.priority_hint, labelled.radar_tag], ['P0', 'P0 · Product - Public leak (e.g. features/models)']);
    eq(B.sigRadarRow_(radarRow(t, { closest_tag: 'Sensitive · Politics', closest_priority: '' })).radar_tag, 'Sensitive · Politics');
    assert.match(B.edActivityLine_(issue, [], t.g.clock.now), /^• \*Activity:\* 9 accounts on reddit and twitter posted about this 14 times/);
    assert.match(B.edActivityLine_(fromEd, [], t.g.clock.now), /^• \*Activity:\* 9 small accounts on reddit and twitter/);
  });

  // ===========================================================================================================
  // The Watch detections tab's title
  // ===========================================================================================================

  test('the Watch detections tab with its title from before Nov 11 is still the bot\'s, and its title is brought up to date on the next run; a tab of that name people made stays theirs', () => {
    const { t } = world();
    const ss = t.sheet();
    const made = t.bot.pwDetectionsTab_(ss, true).sh;
    made.getRange(1, 1).setValue('Proactive watch: what the bot would have flagged (an older title)');
    eq(t.bot.isPwDetectionsTab_(made), true);
    eq(t.bot.pwDetectionsTab_(ss, false).foreign, false);
    eq(made.cell(1, 1), B.ev('PW_DET_TITLE_'));
    assert.ok(!RETIRED_RX.test(made.cell(1, 1)));
    made.getRange(1, 1).setValue('Our own detections');
    eq(t.bot.pwDetectionsTab_(ss, false).foreign, true);
    // with the bot paused (B2 OFF), its next run brings the title up to date too
    made.getRange(1, 1).setValue('Proactive watch: what the bot would have flagged (an older title)');
    t.set('B2', 'OFF');
    t.poll();
    eq(made.cell(1, 1), B.ev('PW_DET_TITLE_'));
  });

  // ===========================================================================================================
  // The retired dry-run mode never comes back
  // ===========================================================================================================

  test('the retired dry-run mode never comes back: its name is in no file git tracks (both Apps Script projects, the two-track service, the Python agent, the Console, the add-on, config, docs, SQL, infra and these tests); the word is left only in the topic keyword for posts about being "...banned" and in the CSS styling of buttons and cards', () => {
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    const root = path.join(__dirname, '..', '..');
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
      .filter(f => f && !/\.(png|jpe?g|gif|ico|svg|webp|pdf|woff2?|ttf|eot|zip|gz|sqlite|db|pyc)$/i.test(f));
    const allowed = new RegExp([
      String.raw`s[h]adow \?-\?ban`, String.raw`s[h]adow[ -]?ban\w*`,  // the topic keyword (posts about being "...banned")
      String.raw`box-?s[h]adow`, String.raw`transition-s[h]adow`, String.raw`\bs[h]adow-(?:sm|md|lg|xl|2xl|inner|none)\b`,  // CSS
    ].join('|'), 'gi');
    const hits = [];
    files.forEach(f => {
      const full = path.join(root, f);
      if (!fs.existsSync(full)) return;  // deleted in the working tree, not committed yet
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (RETIRED_RX.test(line.replace(allowed, ''))) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    });
    assert.ok(files.length > 300, `${files.length} files read`);
    eq(hits, []);
  });

  // ===========================================================================================================
  // Sync
  // ===========================================================================================================

  test('signals sync (ON): the Watch tags tab goes to slrr_signals.taxonomy (every tag, ON or OFF, one version a change, again once a day), the Alert log\'s forwarded alerts updated since the last sync go to issue_history (each with its post, issue and tag), and ratings on the Watch detections tab go to feedback_corrections once each (a classified alert\'s as Track 1\'s); at most every 10 minutes', () => {
    const { t, bq } = world();
    t.poll();
    setting(t, 'sync', 'ON');
    t.bot.sheetBackend_(t.sheet()).appendAlert({ alert_id: 'QA-1', created_at: t.g.clock.now - HOUR, updated_at: t.g.clock.now - HOUR,
      record_key: 'x.com/status/1', forward_message: 'spaces/A/messages/1', exposure_tag: 'Product - Dangerous results (e.g. medical/legal)',
      author: '@a', status: 'ok', email_status: 'sent', forwarded_fields: { issue_name: 'Gemini bleach advice', post_url: 'https://x.com/a/status/1',
        priority: 'P0', product: 'Gemini' } });
    t.bot.sheetBackend_(t.sheet()).appendAlert({ alert_id: 'QA-2', created_at: t.g.clock.now, updated_at: t.g.clock.now, record_key: 'x.com/status/2' });
    t.poll();
    eq(bq.inserts.taxonomy.length, 58);
    eq(Object.keys(bq.inserts.taxonomy[0]).sort(), ['also_known_as', 'description', 'is_on', 'kind', 'label', 'name', 'priority',
      'short_version', 'updated_at', 'updated_from', 'value', 'version']);
    eq([bq.inserts.taxonomy[0].kind, bq.inserts.taxonomy[0].updated_from, bq.inserts.taxonomy.every(r => r.is_on)], ['tag', 'watch_tags_tab', true]);
    eq(bq.inserts.issue_history.map(h => [h.alert_id, h.record_key, h.issue_name, h.priority, h.post_url, h.source, h.products]),
      [['QA-1', 'x.com/status/1', 'Gemini bleach advice', 'P0', 'https://x.com/a/status/1', 'alert_log', ['Gemini']]]);
    assert.match(status(t, 'sync'), /^✓ ON · .* ET: taxonomy 58 tags \(version [0-9a-f]{12}\), 1 alert to issue history, 0 ratings to feedback$/);
    // within 10 minutes: nothing again; after: only what changed (a tag switched OFF, ratings on the Watch detections tab)
    t.poll();
    eq(bq.inserts.taxonomy.length, 58);
    const tags = tab(t, 'Watch tags');
    const row = tags.rows.findIndex(r => r[1] === 'Child Safety') + 1;
    tags.getRange(row, 6).setValue('OFF');
    const det = t.bot.pwDetectionsTab_(t.sheet(), true).sh;
    t.bot.pwRecord_(det, [B.sigT1Flag_(t1Row(t)), { post_url: 'https://x.com/b/status/2', watch: 'Midterms 2026 × Google', impact: 6, bar: 4,
      source: 'sonar', summary: 'A post.' }], 0, false);
    det.getRange(14, 18).setValue('Useful');
    det.getRange(15, 18).setValue('Noise');
    t.g.clock.now += 11 * MIN;
    t.poll();
    eq([bq.inserts.taxonomy.length, bq.inserts.taxonomy.slice(58).filter(r => !r.is_on).map(r => r.name)], [116, ['Child Safety']]);
    eq(bq.inserts.issue_history.length, 1, 'nothing new in the Alert log');
    eq(bq.inserts.feedback_corrections.map(f => [f.track, f.item_key, f.rating]).sort(), [['track1', KEY, 'Useful'],
      ['watch', 'Midterms 2026 × Google|x.com/status/2', 'Noise']].sort());
    t.g.clock.now += 11 * MIN;
    t.poll();
    eq(bq.inserts.feedback_corrections.length, 2, 'once each');
  });

  // ===========================================================================================================
  // Archive
  // ===========================================================================================================

  test('signals archive: only the oldest rows from row 2 down, all older than the cutoff, stopping at the first that isn\'t (or has no time), never more than the cap', () => {
    eq(B.sigArchivePrefix_([1, 2, 3, 10, 2], 5, 100), 3);
    eq(B.sigArchivePrefix_([1, 0, 2], 5, 100), 1);
    eq(B.sigArchivePrefix_([1, 2, 3], 5, 2), 2);
    eq(B.sigArchivePrefix_([9], 5, 100), 0);
    eq([B.sigMs_(new Date(5000)), B.sigMs_(1794358000000), B.sigMs_('2026-11-10T00:00:00Z'), B.sigMs_('')], [5000, 1794358000000, Date.parse('2026-11-10T00:00:00Z'), 0]);
  });

  test('signals archive (ON): once a day after 3 AM ET, the Alert log\'s, Message log\'s and Relay\'s rows older than their days kept are copied to slrr_signals.sheet_archive (each row whole, with its post and alert), counted there, and only then trimmed from the top; if BigQuery doesn\'t have them all, nothing is trimmed; OFF or before 3 AM, every row stays', () => {
    const { t, bq } = world();
    t.poll();
    const backend = t.bot.sheetBackend_(t.sheet());
    const now = Date.UTC(2026, 10, 11, 8, 30);  // the alerts' ages count from the archive's run below (3:30 AM ET, Nov 11)
    [40, 30, 22, 2].forEach((d, i) => backend.appendAlert({ alert_id: `QA-${i + 1}`, created_at: now - d * DAY, updated_at: now - d * DAY,
      record_key: `x.com/status/${i + 1}`, forwarded_fields: { issue_name: `issue ${i + 1}` } }));
    const log = tab(t, 'Alert log');
    const before = log.getLastRow();
    t.poll();
    eq(log.getLastRow(), before, 'OFF: nothing trimmed');
    setting(t, 'archive', 'ON');
    let sent = 0;
    bq.answer = (sql, p) => (/COUNT\(\*\) AS n FROM .*sheet_archive/.test(sql)
      ? [{ n: (bq.inserts.sheet_archive || []).filter(r => r.archive_batch === p.batch).length - sent }] : []);
    t.g.clock.now = Date.UTC(2026, 10, 11, 7, 30);  // 2:30 AM ET: not yet
    t.poll();
    eq([log.getLastRow(), bq.inserts.sheet_archive], [before, undefined]);
    assert.match(status(t, 'archive'), /^✓ ON: once a day after 3 AM ET \(last never\); keeps 21 days of the Alert log/);
    t.g.clock.now = Date.UTC(2026, 10, 11, 8, 30);  // 3:30 AM ET
    t.poll();
    const archived = bq.inserts.sheet_archive.filter(r => r.tab === 'Alert log');
    eq(archived.map(r => [r.alert_id, r.record_key, JSON.parse(r.row_json).forwarded_fields.issue_name]),
      [['QA-1', 'x.com/status/1', 'issue 1'], ['QA-2', 'x.com/status/2', 'issue 2'], ['QA-3', 'x.com/status/3', 'issue 3']]);
    eq([log.getLastRow(), log.deleted.slice(-1)[0], log.rows[1][0]], [before - 3, '2,3', 'QA-4']);
    assert.match(status(t, 'archive'), /^✓ ON · .* ET: Alert log: 3 archived · Message log: \d+ archived · Relay: 0 archived$/);
    // the same day again: nothing (once a day)
    t.poll();
    eq(bq.inserts.sheet_archive.filter(r => r.tab === 'Alert log').length, 3);
    // the next day, BigQuery missing a row: the copies stay, nothing is trimmed
    backend.appendAlert({ alert_id: 'QA-9', created_at: Date.UTC(2026, 9, 1), updated_at: Date.UTC(2026, 9, 1) });
    const log2 = tab(t, 'Alert log');
    log2.rows.splice(1, 0, log2.rows.pop());  // as the oldest row
    const rowsBefore = log2.getLastRow();
    sent = 1;
    t.g.clock.now = Date.UTC(2026, 10, 12, 8, 30);
    t.poll();
    eq(log2.getLastRow(), rowsBefore);
    assert.match(status(t, 'archive'), /Alert log: ⚠️ BigQuery has 0 of the 1 rows sent: nothing trimmed/);
  });

  // ===========================================================================================================
  // Memory
  // ===========================================================================================================

  test('signals memory: an analyst answer gets the earlier alerts on its post from the BigQuery archive and issue history, only while the Archive is ON (nothing has left the sheet otherwise), one query a post an hour, never the alert itself, and nothing on an error', () => {
    const { t, bq } = world();
    t.poll();
    const alert = { alert_id: 'QA-50', record_key: 'x.com/status/7' };
    eq(t.bot.signalsMemoryFor_(alert), []);
    eq(bq.queries.length, 0);
    t.g.services.CacheService.getScriptCache().put('sig_flags', JSON.stringify({ archive: true, watchdog: false }), 600);
    bq.answer = () => [{ alert_id: 'QA-50', issue_name: 'x', exposure_tag: 't', alerted_at: '2026-10-01', status: 'ok', email_status: 'sent', source: 'alert_log' },
      { alert_id: 'QA-7', issue_name: 'Gemini bleach advice', exposure_tag: 'Product - Dangerous results (e.g. medical/legal)',
        alerted_at: '2026-10-01 10:00:00 UTC', status: 'ok', email_status: 'sent', source: 'sheet_archive' }];
    eq(t.bot.signalsMemoryFor_(alert), ['- QA-7: Gemini bleach advice (Product - Dangerous results (e.g. medical/legal)) on 2026-10-01 10:00:00 UTC, email sent, from sheet_archive']);
    t.bot.signalsMemoryFor_(alert);
    eq([bq.queries.length, bq.queries[0].params.key], [1, 'x.com/status/7']);
    bq.answer = () => { throw new Error('boom'); };
    eq(t.bot.signalsMemoryFor_({ alert_id: 'QA-51', record_key: 'x.com/status/8' }), []);
    const p = B.answerAnalystPrompts_('what happened before?', null, { memory: ['- QA-7: earlier'] }, null);
    assert.ok(p.prompt.includes('[Earlier alerts on this post, from the bot\'s long memory') && p.prompt.includes('- QA-7: earlier'));
  });

  // ===========================================================================================================
  // Watchdog
  // ===========================================================================================================

  test('watchdog: a background step a run never finished (Apps Script stopped it) is counted at the next run; 3 within an hour pause it for 30 minutes only when the Signals tab says ON (else only reported); a paused step is skipped until then; steps that finish leave nothing behind', () => {
    const now = Date.UTC(2026, 10, 10, 12, 0);
    let st = { deaths: {}, paused: {} };
    for (let i = 0; i < 3; i++) st = B.wdAfterDeath_(st, 'proactiveWatch', now + i * MIN, false);
    eq([st.deaths.proactiveWatch.length, st.paused, st.last.paused], [3, {}, false]);
    st = B.wdAfterDeath_(st, 'proactiveWatch', now + 3 * MIN, true);
    eq([st.paused.proactiveWatch, st.last.n, st.last.paused], [now + 33 * MIN, 4, true]);
    eq(B.wdAfterDeath_({ deaths: { x: [now - 2 * HOUR] }, paused: { y: now - 1 } }, 'x', now, true), {
      deaths: { x: [now] }, paused: {}, last: { name: 'x', at: now, n: 1, paused: false } }, 'old stops and ended pauses drop');
    eq([B.wdIsPaused_(st, 'proactiveWatch', now + 10 * MIN, true), B.wdIsPaused_(st, 'proactiveWatch', now + 10 * MIN, false),
      B.wdIsPaused_(st, 'proactiveWatch', now + 40 * MIN, true)], [true, false, false]);
    // end to end in the bot: a step that "dies" (its mark left in the cache, as when Apps Script stops a run)
    const { t } = world();
    t.poll();
    const cache = t.g.services.CacheService.getScriptCache();
    const die = name => cache.put('wd_running', JSON.stringify({ name, at: t.g.clock.now }), 600);
    die('resultsTab');
    t.poll();
    eq(JSON.parse(t.g.props.get('WD_STATE')).last, { name: 'resultsTab', at: JSON.parse(t.g.props.get('WD_STATE')).last.at, n: 1, paused: false });
    eq(cache.get('wd_running'), null, 'a run that finishes leaves no mark');
    setting(t, 'watchdog', 'ON');
    t.poll();
    die('resultsTab');
    t.poll();
    die('resultsTab');
    t.poll();
    const s2 = JSON.parse(t.g.props.get('WD_STATE'));
    eq([s2.last.n, s2.last.paused], [3, true]);
    t.poll();
    assert.match(status(t, 'watchdog'), /^✓ ON: .* · paused now: resultsTab until .* ET · last stop: "resultsTab"/);
    let ran = 0;
    eq([t.bot.bgStep_('resultsTab', () => { ran++; return 1; }), t.bot.bgStep_('signals', () => { ran++; return 2; }), ran], [undefined, 2, 1]);
  });
};
