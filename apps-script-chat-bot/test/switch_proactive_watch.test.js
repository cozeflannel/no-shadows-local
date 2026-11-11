// Proactive watch (Control tab row 34, proactiveWatch, ProactiveWatch.gs): a shadow test of spotting Google brand-safety
// issues before Burson's alert space does. With the switch ON (it starts OFF, like every switch), every 5 minutes the bot
// sends two read-only BigQuery scripts, one a location (us-central1: Pendulum's sonar_raw, Tubular's videos and Sprinklr's
// export of Google's own posts; US: Brandwatch's BMIE mentions, the comments on Google's own posts, the DSD story
// selection feed, the Other alerts space's alerts from the Alert log and the Brandwatch query "2026 Election Alerts"
// read straight from Brandwatch's API). Each keeps its sources' new rows in a temporary table, then asks Gemini inside
// BigQuery (AI.IF for each watch ON on the Watches tab, AI.SCORE and AI.CLASSIFY for the posts that match). A later run
// collects them and records what scores at a watch's bar (and the near misses) on the Watch detections tab, whose
// scorecard compares it with Burson's alerts in the Alert log; the Watch sources tab says which sources are live.
// Nothing is posted or emailed; a tab of the same name people made is never touched.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, e2e } = H;
  const ROW = 34;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const ON_TEXT = '✓ ON (shadow test: nothing is posted or emailed): every 5 min, Gemini checks what\'s new in Sonar, ' +
    'Brandwatch, Sprinklr, Tubular and the Other alerts space against the watches ON on the Watches tab; what ' +
    'it would flag goes on the Watch detections tab';
  const OFF_TEXT = 'OFF (the bot reviews only the alerts posted in Chat)';
  const BRAND = 'Google brand safety (all)';
  const MIDTERMS = 'Midterms 2026 × Google';
  const POST1 = 'https://twitter.com/newsdesk/status/2116390716536770729';
  const POST2 = 'https://www.tiktok.com/@phonehackz1/video/7702553392157134102';
  const C1 = 'us-central1';
  const US = 'US';
  const C1_SOURCES = ['sonar', 'tubular', 'outbound'];
  const US_SOURCES = ['bmie', 'comments', 'story', 'chat', 'bwq'];
  const BWQ = 'Brandwatch: 2026 Election Alerts';
  const SOURCE_NAMES = ['Sonar', 'Tubular', 'Sprinklr outbound', 'Brandwatch (BMIE)', 'Sprinklr comments', 'DSD story selection',
    'Other alerts space', BWQ];
  // A look's result columns (pwSql_'s final SELECT): 'hit' rows (a post a watch) and 'src' rows (a source)
  const COLS = [['kind'], ['source'], ['why'], ['idx', 'INTEGER'], ['watch'], ['post_url'], ['platform'], ['author'], ['followers', 'INTEGER'],
    ['eng', 'INTEGER'], ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'], ['issue'], ['issue_new', 'BOOLEAN'], ['summary'],
    ['impact', 'FLOAT'], ['bar', 'FLOAT'], ['topic'], ['found', 'INTEGER'], ['checked', 'INTEGER'], ['newest_ms', 'INTEGER'],
    ['mod_ms', 'INTEGER'], ['err'], ['detail']];
  /** A row a look returns: a Sonar post at the bar of the brand-safety watch unless `o` says otherwise. */
  const hit = o => Object.assign({ kind: 'hit', source: 'sonar', idx: 1, watch: BRAND, post_url: POST1, platform: 'twitter',
    author: 'News Desk', followers: 147460, eng: 12, posted_ms: null, seen_ms: null, issue: 'Gmail scanning claim', issue_new: true,
    summary: 'Twitter user newsdesk (147.5K followers) claims Gmail scans every message for AI training.', impact: 8, bar: 7,
    topic: 'Privacy and security' }, o || {});
  /** A source's row (nothing new unless `o` says otherwise). */
  const src = (source, o) => Object.assign({ kind: 'src', source, found: 0, checked: 0, newest_ms: null, mod_ms: null, err: null }, o || {});
  /** A row for each of `keys`, with `o[key]`'s fields. */
  const srcs = (keys, o) => keys.map(k => src(k, (o || {})[k]));

  /**
   * A fake BigQuery for the watch's looks. jobs.query (POST .../queries) of a look's script answers `bq.submit` (an answer,
   * or a function of the look; default: not done yet, with a job id) and is recorded in bq.looks ({body, sql, location,
   * params, types, arrays, jobId}); jobs.getQueryResults (GET .../queries/pwjob_N) answers bq.answers[its location], else
   * bq.answer ({rows} | {pending: true} | {code, message}); jobs.cancel is recorded. Any other query gets no rows.
   */
  function fakeBq(g) {
    const bq = { looks: [], gets: [], cancels: [], others: 0, answer: { rows: [] }, answers: {}, submit: null, seq: 0, where: {} };
    const orig = g.services.UrlFetchApp.fetch;
    const resp = (code, body) => ({ getResponseCode: () => code, getHeaders: () => ({}),
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    const answer = (a, jobId) => {
      const location = bq.where[jobId] || C1;
      if (a.code) return resp(a.code, { error: { code: a.code, message: a.message || 'Internal error' } });
      if (a.pending) return resp(200, { jobComplete: false, jobReference: { projectId: 'brand-social-central-data', jobId, location } });
      return resp(200, { jobComplete: true, jobReference: { projectId: 'brand-social-central-data', jobId, location },
        schema: { fields: COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: (a.rows || []).map(r => ({ f: COLS.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })) });
    };
    g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      if (!url.startsWith('https://bigquery.googleapis.com/')) return orig(link, params);
      const method = String((params && params.method) || 'get').toLowerCase();
      if (method === 'post' && /\/jobs\/[^/]+\/cancel/.test(url)) { bq.cancels.push(url); return resp(200, {}); }
      if (method === 'post' && /\/queries$/.test(url)) {
        const body = JSON.parse(params.payload);
        if (!/CREATE TEMP TABLE pw_new/.test(body.query || '')) {
          bq.others++;
          return resp(200, { jobComplete: true, schema: { fields: [] }, rows: [] });
        }
        const qp = body.queryParameters || [];
        const look = { url, body, sql: body.query, location: body.location, jobId: `pwjob_${++bq.seq}`,
          params: Object.fromEntries(qp.filter(p => 'value' in p.parameterValue).map(p => [p.name, p.parameterValue.value])),
          types: Object.fromEntries(qp.map(p => [p.name, p.parameterType.type])),
          arrays: Object.fromEntries(qp.filter(p => p.parameterValue.arrayValues).map(p => [p.name, p.parameterValue.arrayValues
            .map(v => Object.fromEntries(Object.entries(v.structValues).map(([k, x]) => [k, x.value])))])) };
        bq.where[look.jobId] = look.location;
        bq.looks.push(look);
        const sub = typeof bq.submit === 'function' ? bq.submit(look) : bq.submit;
        return answer(sub || { pending: true }, look.jobId);
      }
      if (method === 'get' && /\/queries\/pwjob_\d+\?/.test(url)) {
        bq.gets.push(url);
        const jobId = url.match(/pwjob_\d+/)[0];
        return answer((bq.answers || {})[bq.where[jobId]] || bq.answer, jobId);
      }
      return orig(link, params);
    };
    return bq;
  }

  /** setup(), and the fake BigQuery. */
  const world = () => {
    const t = e2e();
    t.bot.setup();
    return { t, bq: fakeBq(t.g) };
  };

  /**
   * A fake Brandwatch for the watch's query, over the fake BigQuery: Secret Manager answers the shared token (or
   * bw.secret: {code, message}); the mentions call answers bw.pages[its page] (mentions, or {code, message}); X's embed
   * data answers bw.x[id] (else 404). Every call is recorded (bw.calls: {host, url, headers}).
   */
  function fakeBw(g) {
    const bw = { token: 'bw-shared-token-0f1e2d3c4b5a', secret: null, pages: [[]], x: {}, calls: [] };
    const prev = g.services.UrlFetchApp.fetch;
    const resp = (code, body) => ({ getResponseCode: () => code, getHeaders: () => ({}),
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      const headers = (params && params.headers) || {};
      if (url.startsWith('https://secretmanager.googleapis.com/')) {
        bw.calls.push({ host: 'secret', url, headers });
        if (bw.secret) return resp(bw.secret.code, { error: { code: bw.secret.code, message: bw.secret.message } });
        return resp(200, { name: 'v', payload: { data: Buffer.from(bw.token, 'utf8').toString('base64') } });
      }
      if (url.startsWith('https://api.brandwatch.com/')) {
        bw.calls.push({ host: 'brandwatch', url, headers });
        const size = Number((url.match(/[?&]pageSize=(\d+)/) || [])[1] || 100);
        const page = bw.pages[Number((url.match(/[?&]page=(\d+)/) || [])[1] || 0)] || [];
        if (!Array.isArray(page)) return resp(page.code, { errors: [{ code: page.code, message: page.message }] });
        return resp(200, { resultsTotal: 999, resultsPageSize: size, results: page.slice(0, size) });
      }
      if (url.startsWith('https://cdn.syndication.twimg.com/')) {
        bw.calls.push({ host: 'x', url, headers });
        const post = bw.x[(url.match(/[?&]id=(\d+)/) || [])[1]];
        return post ? resp(200, post) : resp(404, '');
      }
      return prev(link, params);
    };
    return bw;
  }
  /** A Brandwatch time as its API writes it ("2026-10-14T11:58:00.000+0000"). */
  const bwTime = ms => new Date(ms).toISOString().replace('Z', '+0000');
  /** A mention of the query, as Brandwatch's API gives it. */
  const mention = o => Object.assign({ queryId: 2004167929, queryName: '2026 Election Alerts', sentiment: 'neutral' }, o);
  /** An X post as X's embed data gives it. */
  const xPost = (id, handle, text, o) => Object.assign({ __typename: 'Tweet', id_str: id, text, user: { screen_name: handle, name: handle },
    favorite_count: 0, conversation_count: 0 }, o || {});
  const switchOn = (t, v) => t.control().getRange(ROW, 2).setValue(v || 'ON');
  const tab = (t, name) => t.sheet().getSheetByName(name);
  const watches = t => tab(t, 'Watches');
  const dets = t => tab(t, 'Watch detections');
  const sources = t => tab(t, 'Watch sources');
  const dataRows = t => dets(t).rows.slice(13).filter(r => (r || []).some(v => v !== '' && v !== undefined && v !== null));
  const pwProps = t => Array.from(t.g.props.keys()).filter(k => /^PW_/.test(k)).sort();
  const note = t => t.control().cell(ROW, 3);
  const writes = t => t.chat.calls.filter(c => c.method !== 'get').length;
  /** The looks sent so far, by location. */
  const lanes = bq => ({ c1: bq.looks.filter(l => l.location === C1), us: bq.looks.filter(l => l.location === US) });
  /** The switch ON and the brand-safety watch (row 3) ON; one run made the tabs. */
  const watching = () => {
    const w = world();
    switchOn(w.t);
    w.t.poll();
    watches(w.t).getRange(3, 2).setValue('ON');
    return w;
  };

  // ===========================================================================================================
  // OFF
  // ===========================================================================================================

  test('proactive watch OFF (row 34, as every switch starts): nothing changes: no tab is made, no BigQuery look, nothing remembered; C34 says what OFF means; what a look left behind before it was switched OFF is forgotten', () => {
    const { t, bq } = world();
    for (let i = 0; i < 6; i++) t.poll();
    eq([t.control().cell(ROW, 1), t.control().cell(ROW, 2), note(t), t.control().validations[`${ROW},2`].values],
      ['Proactive watch', 'OFF', OFF_TEXT, ['ON', 'OFF']]);
    eq([tab(t, 'Watches'), tab(t, 'Watch detections'), sources(t), bq.looks.length, bq.gets.length, pwProps(t)],
      [null, null, null, 0, 0, []]);
    ['PW_AT', 'PW_SINCE', 'PW_JOB', 'PW_TRIES', 'PW_LAST', 'PW_US_AT', 'PW_US_SINCE', 'PW_US_JOB', 'PW_US_TRIES', 'PW_MARKS']
      .forEach(k => t.g.props.set(k, '1'));
    t.poll();
    eq(pwProps(t), []);
    eq(t.bot.status().proactive_watch, 'OFF');
  });

  // ===========================================================================================================
  // ON: the tabs, a look, its rows
  // ===========================================================================================================

  test('proactive watch ON: the first run makes its three tabs (Watches: two watches, both OFF, with the On dropdown; Watch detections, after it: its title, the scorecard\'s and the detections\' headers, protected with a warning but for Rating, the key column hidden; Watch sources, after that: one row a source, each waiting for its first look); with no watch ON nothing is asked and C34 says why; people\'s edits are kept', () => {
    const { t, bq } = world();
    switchOn(t);
    t.poll();
    const w = watches(t);
    eq(w.rows[0], B.ev('PW_WATCHES_HEADER_'));
    eq(w.rows.slice(1).map(r => [r[0], r[1], r[5]]), [[MIDTERMS, 'OFF', 7], [BRAND, 'OFF', 7]]);
    eq([w.validations['2,2'].values, w.frozenRows], [['ON', 'OFF'], 1]);
    const d = dets(t);
    eq([d.cell(1, 1), d.rows[2], d.rows[12], d.hidden], [B.ev('PW_DET_TITLE_'), B.ev('PW_SCORE_HEADER_'), B.ev('PW_DET_HEADER_'), [19]]);
    eq([d.protections.length, d.protections[0].warningOnly, d.protections[0].unprotected.length], [1, true, 1]);
    const s = sources(t);
    eq([s.cell(1, 1), s.rows[2], s.rows.slice(3).map(r => r[0]), s.protections.length, s.protections[0].warningOnly],
      [B.ev('PW_SRC_TITLE_'), B.ev('PW_SRC_HEADER_'), SOURCE_NAMES, 1, true]);
    eq(s.rows.slice(3).map(r => r[3]), SOURCE_NAMES.map(() => '... waiting for its first look'));
    eq([s.rows[3][2], s.rows[9][2]], ['bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw', 'The Alert log (the Other alerts space\'s alerts, Control B33)']);
    const names = t.sheet().sheets.map(x => x.name);
    eq([names.indexOf('Watch detections') - names.indexOf('Watches'), names.indexOf('Watch sources') - names.indexOf('Watch detections')], [1, 1]);
    eq([bq.looks.length, note(t)], [0, `${ON_TEXT} · waiting: no watch is ON (set a watch's On to ON on the Watches tab)`]);
    eq([w.cell(2, 8), w.cell(3, 8)], ['OFF: not watched', 'OFF: not watched']);
    w.getRange(2, 3).setValue('My own question?');
    w.getRange(4, 1, 1, 3).setValues([['My watch', 'OFF', 'Is it about Pixel batteries?']]);
    t.poll();
    eq([t.sheet().sheets.filter(x => x.name === 'Watches').length, w.cell(2, 3), w.rows[3].slice(0, 3), w.cell(4, 8)],
      [1, 'My own question?', ['My watch', 'OFF', 'Is it about Pixel batteries?'], 'OFF: not watched']);
    eq(t.bot.status().proactive_watch, 'ON (shadow test: nothing is posted)');
  });

  test('proactive watch: with a watch ON, a look goes out as two read-only BigQuery scripts, one a location: us-central1 (Sonar\'s new posts, Tubular\'s new videos, Sprinklr\'s export of Google\'s own posts only when it changed) and US (BMIE, the comments on Google\'s own posts, the DSD story selection feed, the Other alerts space\'s alerts), each source in a block of its own; the window the last 15 minutes up to a minute ago, every other source from its first-look start; the watch\'s words only as query parameters; a 5 GB cap and its label; a later run collects both: each post at or above the bar, and each near miss, goes on the Watch detections tab once, with its source and the Rating dropdown; C34, the watch\'s status and the Watch sources tab say how it\'s doing; nothing is posted or emailed', () => {
    const { t, bq } = watching();
    const chatWrites = writes(t);
    const sent0 = t.g.gmail.sentMessages().length;
    t.poll();
    const { c1, us } = lanes(bq);
    eq([bq.looks.length, c1.length, us.length], [2, 1, 1]);
    const sentAt = t.g.clock.now;
    const until = sentAt - MIN;
    const seed = B.ev('PW_WATCH_SEEDS_')[1];
    [[c1[0], 'c1'], [us[0], 'us']].forEach(([look, key]) => {
      eq([look.body.useLegacySql, look.body.parameterMode, look.body.labels, look.body.maximumBytesBilled],
        [false, 'NAMED', { purpose: 'proactive-watch', tool: 'burson-qa-bot', lane: key }, String(5 * 1024 ** 3)]);
      eq([Number(look.params.until_ms), Number(look.params.since_ms)], [until, sentAt - 16 * MIN]);
      eq([look.types.since_ms, look.types.until_ms, look.types.w1_name, look.types.w1_bar], ['INT64', 'INT64', 'STRING', 'FLOAT64']);
      eq([look.params.w1_name, look.params.w1_cond, look.params.w1_rubric, look.params.w1_bar, look.params.w1_nets, look.params.w2_name],
        [BRAND, seed[2], seed[3], '7', '', undefined]);
      assert.ok(!look.sql.includes(seed[2].slice(0, 40)) && !look.sql.includes(BRAND), 'the watch\'s words are parameters, never in the SQL');
      for (const piece of ['CREATE TEMP TABLE pw_new (', 'EXCEPTION WHEN ERROR THEN', 'AND AI.IF(CONCAT(w.cond', 'AI.SCORE(CONCAT(rubric',
        'AI.CLASSIFY(s.txt', '.__TABLES__`']) {
        assert.ok(look.sql.includes(piece), `${key}: ${piece}`);
      }
      assert.ok(!/\b(?:INSERT INTO|DELETE FROM|UPDATE|MERGE INTO|CREATE (?:OR REPLACE )?TABLE)\s+`/i.test(look.sql),
        'nothing is written but the script\'s own temporary tables');
    });
    eq([c1[0].body.location, us[0].body.location], [C1, US]);
    for (const piece of ['FROM `bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`', 'w.followers >= 1000 OR w.eng >= 100', 'INTERVAL 24 HOUR',
      "WHEN NOT p.was_eligible THEN 'grew'", "WHEN w.eng >= 1000 AND w.eng >= 10 * GREATEST(IFNULL(p.eng_before, 0), 1) THEN 'broke out'",
      "INTERVAL IF(why = 'new', 24, 72) HOUR",
      '`brand-social-central-data.google_tubular_mentions.tubular_videos`', 'IF pw_out_mod > @outbound_mod THEN',
      '`brand-social-central-data.external_data_share.stg_sprinklr_outbound_media_assets_json_source`',
      "STRUCT('sonar' AS source, 150 AS cap), STRUCT('tubular' AS source, 60 AS cap), STRUCT('outbound' AS source, 40 AS cap)"]) {
      assert.ok(c1[0].sql.includes(piece), piece);
    }
    for (const piece of ['`brand-social-central-data.social_alerts_dataset.all_sundar_mentions`',
      'APPENDS(TABLE `brand-social-central-data.reporting_data.sprinklr_inbound_comments`',
      '`brand-social-central-data.DSD.DSD-story-selection`', 'FROM UNNEST(@chat) c',
      "CASE WHEN full_q THEN 'brand-safety query' WHEN neg THEN 'negative' WHEN kof_author THEN 'KOF author'",
      "WHEN risk THEN 'risk words' WHEN ABS(MOD(FARM_FINGERPRINT(url), 100)) < 5 THEN 'sample' ELSE 'skipped' END AS why",
      `r'${B.ev('PW_BMIE_FULL_RX_')}'`, `r'${B.ev('PW_RISK_WORDS_RX_')}'`, "IFNULL(n.why, '') != 'skipped'"]) {
      assert.ok(us[0].sql.includes(piece), piece);
    }
    assert.ok(!/brandwatch_daily|content_vectors|reddit_items_raw/.test(us[0].sql + c1[0].sql), 'the stale feeds are not read');
    assert.ok(!us[0].sql.includes('sonar_raw') && !c1[0].sql.includes('all_sundar_mentions'), 'each location reads only its own tables');
    assert.ok(c1[0].sql.includes("['AI answers and Gemini', 'Privacy and security', 'Scams and fraud', 'Product failure or outage', " +
      "'Legal and regulation', 'Bias or censorship claims', 'Executives and workplace', 'Elections and civics', 'Other']"));
    // a first look: every source that keeps its own place starts its firstMs back; the export hasn't been read yet
    eq([c1[0].params.tubular_from, c1[0].params.outbound_from, c1[0].params.outbound_mod].map(Number), [until - 24 * HOUR, until - 72 * HOUR, 0]);
    eq([us[0].params.bmie_from, us[0].params.story_from].map(Number), [until - 15 * MIN, until - 2 * HOUR]);
    eq(Object.keys(us[0].params).filter(k => /^(bwdaily|vectors|reddit)_/.test(k)), []);
    eq([us[0].types.chat, us[0].arrays.chat, c1[0].types.chat], ['ARRAY', [], undefined]);
    eq([us[0].types.bwq, us[0].types.bwq_err, c1[0].types.bwq, c1[0].types.bwq_err], ['ARRAY', 'STRING', undefined, undefined]);
    eq(JSON.parse(t.g.props.get('PW_JOB')), { since: sentAt - 16 * MIN, until, at: sentAt, tries: 0, id: 'pwjob_1',
      project: 'brand-social-central-data', location: C1 });
    eq(JSON.parse(t.g.props.get('PW_US_JOB')), { since: sentAt - 16 * MIN, until, at: sentAt, tries: 0, id: 'pwjob_2',
      project: 'brand-social-central-data', location: US });
    assert.match(note(t), / · first look sent Oct 14, \d+:\d\d [AP]M EDT \(1 watch, 8 sources\); its results come in a minute or two$/);
    // The next run collects both
    const seen = sentAt - 4 * MIN;
    bq.answers = {
      [C1]: { rows: [hit({ seen_ms: seen, posted_ms: seen - 3 * MIN }),
        hit({ source: 'tubular', post_url: POST2, platform: 'tiktok', author: 'phonehackz1', followers: 4921, eng: 0, impact: 5.5,
          issue: 'Tubular', issue_new: false, summary: '=HYPERLINK("x") a data leak video', topic: 'Privacy and security', seen_ms: seen + MIN })]
        .concat(srcs(C1_SOURCES, { sonar: { found: 27, checked: 27, newest_ms: seen + MIN, mod_ms: sentAt - 2 * MIN },
          tubular: { found: 300, checked: 60, newest_ms: seen } })) },
      [US]: { rows: srcs(US_SOURCES, { bmie: { found: 12, checked: 12 } }) },
    };
    t.poll();
    eq([bq.gets.length, t.g.props.get('PW_JOB'), t.g.props.get('PW_US_JOB'), Number(t.g.props.get('PW_SINCE')),
      Number(t.g.props.get('PW_US_SINCE')), t.g.props.get('PW_TRIES')], [2, undefined, undefined, until, until, undefined]);
    assert.match(bq.gets[0], /\/projects\/brand-social-central-data\/queries\/pwjob_1\?location=us-central1&timeoutMs=3000$/);
    assert.match(bq.gets[1], /\/projects\/brand-social-central-data\/queries\/pwjob_2\?location=US&timeoutMs=3000$/);
    const rows = dataRows(t);
    eq(rows.length, 2);
    eq(rows[0].slice(0, 18), [B.pwTime_(seen), BRAND, 8, 'Yes', 'Privacy and security', POST1, 'Sonar', 'X', 'News Desk', 147460, 12,
      B.pwTime_(seen - 3 * MIN), 'Gmail scanning claim', 'Yes', 'Twitter user newsdesk (147.5K followers) claims Gmail scans every ' +
      'message for AI training.', '', '', '']);
    eq(JSON.parse(rows[0][18]), { k: B.recordKey_({ post_url: POST1 }), w: BRAND, s: seen, b: 1 });
    // the formula-looking summary went in with a leading apostrophe: Sheets keeps it as plain text (shown without it)
    eq([rows[1][2], rows[1][3], rows[1][6], rows[1][7], rows[1][11], rows[1][13], rows[1][14]],
      [5.5, 'No', 'Tubular', 'TikTok', '', '', '=HYPERLINK("x") a data leak video']);
    eq(dets(t).validations['14,18'].values, ['Useful', 'Noise']);
    assert.match(note(t), / · last look Oct 14, \d+:\d\d [AP]M EDT: 99 new posts, 1 flagged · today: 1 flagged, 1 near miss · all 8 sources live \(Watch sources tab\)$/);
    assert.match(watches(t).cell(3, 8), /^✓ watched · today: 1 flagged, 1 near miss · last look \d+:\d\d [AP]M$/);
    eq(watches(t).cell(2, 8), 'OFF: not watched');
    const today = JSON.parse(t.g.props.get('PW_TODAY'));
    eq([today.looks, today.checked, today.flagged, today.near, today.w, today.src.sonar, today.src.tubular, today.src.bmie, today.src.story],
      [2, 99, 1, 1, { [BRAND]: [1, 1] }, [27, 1], [60, 0], [12, 0], [0, 0]]);
    eq(JSON.parse(t.g.props.get('PW_MARKS')), { tubular: seen });  // Sonar goes by the window; the others had nothing new
    const s = sources(t).rows;
    eq([s[3][3], s[3][4], s[3][5], s[3][6], s[3][7], s[3][8]],
      ['✓ live: 27 new at the last look', B.pwTime_(sentAt - 2 * MIN), B.pwTime_(seen + MIN), '27 / 27', 27, 1]);
    eq([s[4][3], s[4][6], s[4][7], s[6][3], s[6][6]], ['✓ live: 300 new at the last look', '300 / 60', 60, '✓ live: 12 new at the last look', '12 / 12']);
    eq([writes(t), t.g.gmail.sentMessages().length], [chatWrites, sent0]);  // nothing posted in Chat, nothing emailed
    assert.match(t.bot.status().proactive_watch_status, /^✓ ON \(shadow test/);
  });

  test('proactive watch: looks go out at most every 5 minutes, each location\'s window starting where its last one ended (none skipped, none twice); a post a watch already flagged isn\'t recorded again (nor its copy from the other location), another watch flagging it is; after a long gap only the last 30 minutes are looked at', () => {
    const { t, bq } = watching();
    t.poll();  // look 1 sent (both locations)
    const first = lanes(bq).c1[0];
    const firstUs = lanes(bq).us[0];
    bq.answer = { rows: [hit({ seen_ms: t.g.clock.now - 2 * MIN })] };  // both locations hand over the same post
    t.poll();  // collected
    eq(dataRows(t).length, 1, 'the same post from both locations: once a watch');
    for (let i = 0; i < 3; i++) t.poll();
    eq(bq.looks.length, 2, 'not again before 5 minutes');
    watches(t).getRange(2, 2).setValue('ON');  // the Midterms watch too
    t.poll();  // 5 minutes after look 1
    eq(bq.looks.length, 4);
    const second = lanes(bq).c1[1];
    eq([second.params.since_ms, Number(second.params.until_ms), second.params.w1_name, second.params.w2_name],
      [first.params.until_ms, t.g.clock.now - MIN, MIDTERMS, BRAND]);
    eq(lanes(bq).us[1].params.since_ms, firstUs.params.until_ms);
    bq.answer = { rows: [hit({ idx: 2, seen_ms: t.g.clock.now - 3 * MIN }), hit({ idx: 1, watch: MIDTERMS, impact: 7.5, topic: 'Election misinformation',
      seen_ms: t.g.clock.now - 3 * MIN })] };
    t.poll();
    eq(dataRows(t).map(r => [r[1], r[2], r[5]]), [[BRAND, 8, POST1], [MIDTERMS, 7.5, POST1]]);
    // the same rows again (a window collected twice can't happen, but a retried one could): nothing new
    eq(B.pwDetections_([hit({ seen_ms: 1 }), hit({ watch: MIDTERMS, seen_ms: 1 })],
      new Set([`${BRAND}|${B.recordKey_({ post_url: POST1 })}`, `${MIDTERMS}|${B.recordKey_({ post_url: POST1 })}`])).rows, []);
    // a long gap (the bot stopped, say): the next look takes only the last 30 minutes
    t.g.clock.now += 3 * HOUR;
    t.poll();
    const third = lanes(bq).c1[2];
    eq([Number(third.params.until_ms) - Number(third.params.since_ms), Number(third.params.until_ms)], [30 * MIN, t.g.clock.now - MIN]);
  });

  test('proactive watch: a look BigQuery refuses is noted (naming its sources) and tried again at the next look from the same start, the other location carrying on; after 3 tries its window is skipped (noted), so one bad window never stops the watch; a look still running after 4 minutes is cancelled and counts as a try', () => {
    const { t, bq } = watching();
    bq.submit = look => (look.location === C1 ? { code: 500, message: 'Backend error' } : null);  // us-central1 refuses; US is fine
    bq.answers = { [US]: { rows: [] } };
    const c1 = () => lanes(bq).c1;
    t.poll();  // try 1
    const start = c1()[0].params.since_ms;
    eq([t.g.props.get('PW_TRIES'), t.g.props.get('PW_SINCE'), t.g.props.get('PW_JOB'), t.g.props.get('PW_US_TRIES'), lanes(bq).us.length],
      ['1', start, undefined, undefined, 1]);
    assert.match(note(t), / · ⚠️ the last look at Sonar, Tubular and Sprinklr outbound failed \(BigQuery HTTP 500: Backend error\); it tries again at the next look$/);
    for (let i = 0; i < 4; i++) t.poll();
    eq(c1().length, 1, 'not again before 5 minutes');
    t.poll();  // try 2
    t.poll();
    for (let i = 0; i < 4; i++) t.poll();  // try 3, 5 minutes after try 2
    eq([c1().length, c1().map(l => l.params.since_ms)], [3, [start, start, start]]);
    eq([t.g.props.get('PW_TRIES'), t.g.props.get('PW_SINCE')], [undefined, c1()[2].params.until_ms]);
    assert.match(note(t), / · ⚠️ skipped \d\d:\d\d-\d\d:\d\d for Sonar, Tubular and Sprinklr outbound after 3 tries \(BigQuery HTTP 500: Backend error\); the next look carries on$/);
    // the skipped window moved the location's other sources past it
    const marks = JSON.parse(t.g.props.get('PW_MARKS'));
    eq([marks.tubular, marks.outbound], [Number(c1()[2].params.until_ms), Number(c1()[2].params.until_ms)]);
    eq(Number(lanes(bq).us[lanes(bq).us.length - 1].params.since_ms) > Number(start), true, 'US carried on meanwhile');
    // the next look carries on from there; this one stays "running"
    bq.submit = null;
    bq.answer = { pending: true };
    for (let i = 0; i < 5; i++) t.poll();
    eq([c1().length, c1()[3].params.since_ms], [4, c1()[2].params.until_ms]);
    for (let i = 0; i < 4; i++) t.poll();
    eq(bq.cancels.length, 0, 'not cancelled within 4 minutes');
    t.poll();
    // cancelled, counted as a try, and tried again at once from the same start (the next look was due)
    const retry = JSON.parse(t.g.props.get('PW_JOB'));
    eq([bq.cancels.length, c1().length, retry.tries, retry.since, t.g.props.get('PW_TRIES')],
      [1, 5, 1, Number(c1()[3].params.since_ms), '1']);
    assert.match(bq.cancels[0], new RegExp(`/projects/brand-social-central-data/jobs/${c1()[3].jobId}/cancel\\?location=us-central1$`));
    assert.match(note(t), / · ⚠️ the last look at Sonar, Tubular and Sprinklr outbound failed \(BigQuery took more than 4 minutes\); it tries again at the next look$/);
  });

  test('proactive watch: while the bot is paused nothing is looked at; back ON, the watch starts afresh from the last 15 minutes (not from where it stopped), every source from its first-look start', () => {
    const { t, bq } = watching();
    t.poll();
    bq.answer = { rows: srcs(C1_SOURCES, { tubular: { newest_ms: t.g.clock.now - 2 * HOUR } }) };
    t.poll();
    const stopped = Number(t.g.props.get('PW_SINCE'));
    eq(JSON.parse(t.g.props.get('PW_MARKS')).tubular > 0, true);
    t.set('B2', 'OFF');
    for (let i = 0; i < 30; i++) t.poll();
    eq([bq.looks.length, t.g.props.get('PW_PAUSED')], [2, 'true']);
    t.set('B2', 'ON');
    t.poll();
    const look = lanes(bq).c1[1];
    eq([t.g.props.get('PW_PAUSED'), Number(look.params.since_ms) > stopped, Number(look.params.until_ms) - Number(look.params.since_ms),
      Number(look.params.until_ms) - Number(look.params.tubular_from)], [undefined, true, 15 * MIN, 24 * HOUR]);
  });

  // ===========================================================================================================
  // The sources
  // ===========================================================================================================

  test('proactive watch: the US look carries the alerts the bot read in the Other alerts space (B33) since the last one as the @chat parameter: alerts in other formats (Brandwatch\'s), in that space\'s partition of the Alert log, with a link; never Burson\'s, another space\'s, one without a link or one older than the first look\'s hour; recorded with their source, and the next look carries only what came after', () => {
    const { t, bq } = watching();
    const backend = t.bot.sheetBackend_(t.sheet());
    const OS = 'spaces/AAQAmidterm1 > (isolated) (other alerts)';
    const LINK = 'https://x.com/votewatch/status/2116390716536770001';
    const other = (id, at, o) => backend.appendAlert(Object.assign({ alert_id: id, created_at: at, updated_at: at, space: OS, record_key: 'x',
      source_at: at, status: 'ok', ingested: B.ev('OTHER_INGESTED_'), author: 'votewatch',
      forwarded_fields: { post_url: LINK, social_network: 'X', issue_name: 'Wrong polling places in Search', total_engagement: 2400,
        triage: { stream: '2026 Midterm Elections / Civics', summary: 'Says Google Search shows voters the wrong polling places.',
          engagement: 'High (2000+)' } } }, o || {}));
    const now = t.g.clock.now;
    other('QA-3001', now - 10 * MIN);
    other('QA-3002', now - 20 * MIN, { ingested: '' });                                              // Burson's alert in that space
    other('QA-3003', now - 20 * MIN, { space: 'spaces/AAQAaa_0I9g > spaces/AAQAnWE2vpo (isolated)' });  // the Mirror space's
    other('QA-3004', now - 2 * HOUR);                                                                 // before the first look's hour
    other('QA-3005', now - 5 * MIN, { forwarded_fields: { issue_name: 'no link here' } });           // no link
    t.poll();
    const look = lanes(bq).us[0];
    eq(look.arrays.chat.length, 1);
    const c = look.arrays.chat[0];
    eq([c.u, c.n, c.a, c.f, c.e, c.p, Number(c.s), c.i], [LINK, 'twitter', 'votewatch', '-1', '2400', '0', now - 10 * MIN,
      'Other alerts space · 2026 Midterm Elections / Civics']);
    eq(c.t, 'An alert posted in the Other alerts space ("2026 Midterm Elections / Civics").\nIssue: Wrong polling places in Search\n' +
      'What it is: Says Google Search shows voters the wrong polling places.\nAuthor: votewatch\nEngagement: High (2000+)');
    assert.ok(!look.sql.includes('polling'), 'the alerts\' words are a parameter, never in the SQL');
    bq.answers = {
      [US]: { rows: [hit({ source: 'chat', post_url: LINK, author: 'votewatch', followers: null, eng: 2400, seen_ms: now - 10 * MIN,
        issue: c.i, issue_new: null, summary: 'Says Google Search shows voters the wrong polling places.', impact: 9, topic: 'Elections and civics' })]
        .concat(srcs(US_SOURCES, { chat: { found: 1, checked: 1, newest_ms: now - 10 * MIN } })) },
      [C1]: { rows: srcs(C1_SOURCES) },
    };
    t.poll();
    eq(dataRows(t).map(r => [r[1], r[2], r[6], r[7], r[8], r[12]]),
      [[BRAND, 9, 'Other alerts space', 'X', 'votewatch', 'Other alerts space · 2026 Midterm Elections / Civics']]);
    eq(JSON.parse(t.g.props.get('PW_MARKS')).chat, now - 10 * MIN);
    for (let i = 0; i < 3; i++) t.poll();
    other('QA-3006', t.g.clock.now - MIN / 2, { forwarded_fields: { post_url: 'https://x.com/ballots/status/2116390716536770002' } });
    t.poll();  // 5 minutes after the first look
    eq(lanes(bq).us[1].arrays.chat.map(x => x.u), ['https://x.com/ballots/status/2116390716536770002']);
  });

  test('proactive watch: each source that keeps its own place starts where it stopped (the newest item it handed over), never further back than its limit; a source that failed starts where it was; Sprinklr\'s export is read again only once it changed', () => {
    const { t, bq } = watching();
    t.poll();
    const T0 = t.g.clock.now;
    bq.answers = {
      [C1]: { rows: srcs(C1_SOURCES, { tubular: { found: 900, checked: 60, newest_ms: T0 - 3 * HOUR },
        outbound: { found: 1400, checked: 40, newest_ms: T0 - 30 * HOUR, mod_ms: T0 - 20 * HOUR } }) },
      [US]: { rows: srcs(US_SOURCES, { bmie: { found: 40, checked: 40, newest_ms: T0 - 2 * MIN },
        story: { err: 'Access Denied: Table brand-social-central-data:DSD.DSD-story-selection' } }) },
    };
    t.poll();
    eq(JSON.parse(t.g.props.get('PW_MARKS')), { tubular: T0 - 3 * HOUR, outbound: T0 - 30 * HOUR, outbound_mod: T0 - 20 * HOUR, bmie: T0 - 2 * MIN });
    for (let i = 0; i < 4; i++) t.poll();  // the next look, 5 minutes after the first
    const { c1, us } = lanes(bq);
    eq([c1.length, us.length], [2, 2]);
    const until = Number(c1[1].params.until_ms);
    eq([c1[1].params.tubular_from, c1[1].params.outbound_from, c1[1].params.outbound_mod].map(Number), [T0 - 3 * HOUR, T0 - 30 * HOUR, T0 - 20 * HOUR]);
    eq([us[1].params.bmie_from, us[1].params.story_from].map(Number), [T0 - 2 * MIN, until - 2 * HOUR]);
    // never further back than a source's limit (BMIE: 30 minutes; Tubular: 24 hours); never moved back; a failed source stays put
    eq([B.pwFroms_({ bmie: 1000, tubular: until - 30 * HOUR }, until).bmie, B.pwFroms_({ tubular: until - 30 * HOUR }, until).tubular],
      [until - 30 * MIN, until - 24 * HOUR]);
    eq(B.pwAdvanceMarks_({ bmie: 5000 }, [src('bmie', { newest_ms: 4000 }), src('story', { newest_ms: 9000, err: 'x' }),
      src('sonar', { newest_ms: 7000 }), src('outbound', { mod_ms: 8000, err: 'y' })]), { bmie: 5000 });
  });

  test('proactive watch: the DSD story selection feed (Brandwatch\'s HIGH and KOF alert emails, one row a post) is read in the US look, in a block of its own: what was ingested since the newest post it handed over (2 hours back on a first look, never more than 6), posted within 72 hours, with text; no reach floor (the feed has no follower or engagement counts; all zeros or 500/500/500/2000 go to Gemini as unknown), KOF first, 40 a look; a post it hands over is recorded as DSD story selection; its row says stale after 6 hours without a change', () => {
    const until = Date.UTC(2026, 9, 14, 12, 0);
    const watch = B.pwWatchFrom_([BRAND, 'ON', 'Q?', '', '', '', '', ''], 3);
    const q = B.pwSql_('us', [watch], { since: until - 15 * MIN, until, froms: B.pwFroms_({}, until), chat: [] });
    const at = q.sql.indexOf("SELECT 'story', ROW_NUMBER()");
    const block = q.sql.slice(at, q.sql.indexOf('EXCEPTION WHEN ERROR THEN', at));
    for (const piece of ['FROM `brand-social-central-data.DSD.DSD-story-selection`',
      'WHERE ingestion_time > TIMESTAMP_MILLIS(@story_from) AND ingestion_time <= TIMESTAMP_MILLIS(@until_ms) AND url IS NOT NULL',
      "ORDER BY IF(UPPER(IFNULL(alert_type, '')) = 'KOF', 0, 1), IFNULL(eng, 0) DESC, ingestion_time DESC",
      'IF((likes = 500 AND shares = 500 AND comments = 500 AND total_engagements = 2000)',
      'OR IFNULL(total_engagements, 0) = 0, NULL, total_engagements) AS eng', "WHERE TRIM(IFNULL(snippet, '')) != ''",
      'AND (post_time IS NULL OR post_time >= TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 72 HOUR));']) {
      assert.ok(at > 0 && block.includes(piece), piece);
    }
    assert.ok(!/>=\s*1000\b/.test(block), 'no reach floor');
    for (const piece of ["INSERT INTO pw_src (source, err) VALUES ('story'", "STRUCT('story' AS source, 40 AS cap)",
      "FROM `brand-social-central-data.DSD.__TABLES__` WHERE table_id = 'DSD-story-selection'"]) {
      assert.ok(q.sql.includes(piece), piece);
    }
    eq(q.params.find(p => p.name === 'story_from'), { name: 'story_from', type: 'INT64', value: until - 2 * HOUR });
    assert.ok(!B.pwSql_('c1', [watch], { since: until - 15 * MIN, until, froms: B.pwFroms_({}, until) }).sql.includes('DSD-story-selection'),
      'US only');
    // where it starts: the newest post it handed over, never more than 6 hours back
    eq([B.pwFroms_({ story: until - HOUR }, until).story, B.pwFroms_({ story: until - 9 * HOUR }, until).story], [until - HOUR, until - 6 * HOUR]);
    // end to end: its post is recorded with its source, its place moves to it, and a table unchanged for 7 hours is stale
    const { t, bq } = watching();
    t.poll();
    const look = lanes(bq).us[0];
    eq(Number(look.params.story_from), Number(look.params.until_ms) - 2 * HOUR);
    const now = t.g.clock.now;
    const POST = 'https://x.com/ThePrimeagen/status/2116390716536770123';
    const ISSUE = 'DSD story selection · KOF · [V3] Google (EN + X + ORIGINAL POST)';
    bq.answers = {
      [US]: { rows: [hit({ source: 'story', post_url: POST, author: '@ThePrimeagen', followers: null, eng: null, issue: ISSUE, issue_new: null,
        summary: 'Don\'t get mad at me Google cooked with Argon 4', impact: 7.5, seen_ms: now - 5 * MIN })]
        .concat(srcs(US_SOURCES, { story: { found: 3, checked: 3, newest_ms: now - 5 * MIN, mod_ms: now - 7 * HOUR } })) },
      [C1]: { rows: srcs(C1_SOURCES) },
    };
    t.poll();
    eq(dataRows(t).map(r => [r[5], r[6], r[7], r[8], r[9], r[10], r[12]]), [[POST, 'DSD story selection', 'X', '@ThePrimeagen', 0, 0, ISSUE]]);
    eq(JSON.parse(t.g.props.get('PW_MARKS')).story, now - 5 * MIN);
    const row = sources(t).rows.slice(3).find(r => r[0] === 'DSD story selection');
    eq([row[2], row[6]], ['brand-social-central-data.DSD.DSD-story-selection', '3 / 3']);
    assert.match(row[3], /^⚠️ stale: its table hasn't changed since /);
  });

  test('proactive watch: the stale feeds (the daily Brandwatch export, the DSD content vectors, Reddit Pulse: no new rows since Sep 20, Sep 24 and Oct 25) are read in neither look, with no parameter for them; a Watch sources tab made when the watch read more sources loses its leftover rows at its next write, keeping one row a current source', () => {
    const until = Date.UTC(2026, 9, 14, 12, 0);
    const watch = B.pwWatchFrom_([BRAND, 'ON', 'Q?', '', '', '', '', ''], 3);
    ['c1', 'us'].forEach(lane => {
      const q = B.pwSql_(lane, [watch], { since: until - 15 * MIN, until, froms: B.pwFroms_({}, until), chat: [] });
      assert.ok(!/brandwatch_daily|content_vectors|reddit_pulse|'bwdaily'|'vectors'|'reddit'/.test(q.sql), lane);
      eq(q.params.filter(p => /^(bwdaily|vectors|reddit)_/.test(p.name)).map(p => p.name), []);
    });
    eq(B.ev('PW_SOURCES_').map(s => s.key), C1_SOURCES.concat(US_SOURCES));
    // a tab from before (rows for 10 sources): the rows below the 8 current ones are cleared, the current ones kept
    const { t } = watching();
    const s = sources(t);
    s.getRange(11, 1, 3, 3).setValues([['DSD story selection', 'old', 'x'], ['Reddit', 'old', 'reddit_pulse.reddit_items_raw'],
      ['Other alerts space', 'old', 'y']]);
    t.poll();
    eq([s.getLastRow(), s.rows.slice(3).map(r => r[0])], [3 + SOURCE_NAMES.length, SOURCE_NAMES]);
  });

  test('proactive watch: the Watch sources tab has a row a source: live, stale (its table hasn\'t changed for longer than it usually goes) or an error at its last look, what was new and checked, and today\'s numbers; C34 sums the sources up (under its 200-character cap) and names a failing one, whichever location reported it; status() lists them', () => {
    const { t, bq } = watching();
    t.poll();
    const now = t.g.clock.now;
    bq.answers = {
      [C1]: { rows: [hit({ seen_ms: now - 2 * MIN })].concat(srcs(C1_SOURCES, { sonar: { found: 27, checked: 27, newest_ms: now - 2 * MIN, mod_ms: now - MIN } })) },
      [US]: { rows: srcs(US_SOURCES, { story: { mod_ms: now - 2 * 24 * HOUR }, comments: { mod_ms: now - 3 * HOUR },
        bmie: { err: 'Access Denied: Table brand-social-central-data:social_alerts_dataset.all_sundar_mentions' } }) },
    };
    t.poll();
    const row = name => sources(t).rows.slice(3).find(r => r[0] === name);
    eq([row('Sonar')[3], row('Sonar')[6], row('Sonar')[7], row('Sonar')[8]], ['✓ live: 27 new at the last look', '27 / 27', 27, 1]);
    eq([row('DSD story selection')[3], row('DSD story selection')[4]],
      [`⚠️ stale: its table hasn't changed since ${B.pwTime_(now - 2 * 24 * HOUR)} ET (its rows count again once it has new ones)`,
        B.pwTime_(now - 2 * 24 * HOUR)]);
    assert.match(row('Sprinklr comments')[3], /^⚠️ stale: /);
    eq(row('Brandwatch (BMIE)')[3], '⚠️ error at the last look: Access Denied: Table brand-social-central-data:social_alerts_dataset.all_sundar_mentions ' +
      '(tried again at the next look)');
    eq([row('Tubular')[3], row('Other alerts space')[3]], ['✓ live: nothing new at the last look', '✓ live: nothing new at the last look']);
    assert.match(note(t), / · sources: 5 live, 2 stale, 1 failing: Brandwatch \(BMIE\) \(Watch sources tab\)$/);
    const st = t.bot.status().proactive_watch_sources;
    eq(st.length, 8);
    assert.ok(st.some(x => /^DSD story selection: ⚠️ stale/.test(x)) && st.includes('Sonar: ✓ live: 27 new at the last look'), st.join('\n'));
    eq(B.pwSourcesSummary_({}, now), '');
  });

  test('proactive watch: the same post from two sources (Sonar in us-central1, BMIE in US as twitter.com/.../statuses/...) goes on the tab once a watch, from the source collected first; a source that hands a post over late never claims a lead it couldn\'t have had (seen is the look\'s window start at the earliest)', () => {
    const { t, bq } = watching();
    t.poll();
    const job = JSON.parse(t.g.props.get('PW_US_JOB'));
    bq.answers = {
      [C1]: { rows: [hit({ seen_ms: t.g.clock.now - 3 * MIN })] },
      [US]: { rows: [hit({ source: 'bmie', post_url: 'http://twitter.com/newsdesk/statuses/2116390716536770729', seen_ms: t.g.clock.now - 20 * HOUR }),
        hit({ source: 'bmie', post_url: POST2, platform: 'tiktok', seen_ms: t.g.clock.now - 20 * HOUR })] },
    };
    t.poll();
    const rows = dataRows(t);
    eq(rows.map(r => [r[5], r[6]]), [[POST1, 'Sonar'], [POST2, 'Brandwatch (BMIE)']]);
    eq([rows[1][0], JSON.parse(rows[1][18]).s], [B.pwTime_(job.since), job.since]);
  });

  test('proactive watch: a source that fails inside a look is noted (C34 and the Watch sources tab) while the others\' rows are recorded; Sonar failing keeps its window, so it\'s looked at again', () => {
    const { t, bq } = watching();
    t.poll();
    const first = lanes(bq).c1[0];
    bq.answers = {
      [C1]: { rows: [hit({ source: 'tubular', post_url: POST2, platform: 'tiktok', seen_ms: t.g.clock.now - 2 * MIN })]
        .concat(srcs(C1_SOURCES, { sonar: { err: 'Access Denied: Table bsip-s-bsip-gg-26-2cf3:google_bg.sonar_raw' },
          tubular: { found: 1, checked: 1, newest_ms: t.g.clock.now - 2 * MIN } })) },
      [US]: { rows: srcs(US_SOURCES) },
    };
    t.poll();
    eq(dataRows(t).map(r => [r[5], r[6]]), [[POST2, 'Tubular']]);
    eq([t.g.props.get('PW_SINCE'), Number(t.g.props.get('PW_US_SINCE'))], [first.params.since_ms, Number(lanes(bq).us[0].params.until_ms)]);
    assert.match(note(t), / · sources: 7 live, 1 failing: Sonar \(Watch sources tab\)$/);
    assert.match(sources(t).rows[3][3], /^⚠️ error at the last look: Access Denied/);
    for (let i = 0; i < 4; i++) t.poll();
    eq(lanes(bq).c1[1].params.since_ms, first.params.since_ms, 'Sonar\'s window is looked at again');
  });

  test('proactive watch: what may not be noticeable at first still gets a look: a Sonar post that grew past the reach floor later, or broke out after it was checked; BMIE checks every mention from the brand-safety and Google product queries and, from the other queries, those with a sign something is wrong plus a sample of the rest; each row says why it was asked about when it isn\'t the usual reason, and the Watch sources tab shows the breakdown, how many were not sent too', () => {
    const { t, bq } = watching();
    t.poll();
    const now = t.g.clock.now;
    bq.answers = {
      [C1]: { rows: [hit({ why: 'new', seen_ms: now - 2 * MIN }),
        hit({ why: 'grew', post_url: 'https://www.tiktok.com/@smallacct/video/7702553392157130001', platform: 'tiktok', seen_ms: now - 2 * MIN }),
        hit({ why: 'broke out', post_url: 'https://x.com/viral/status/2116390716536770003', impact: 9, seen_ms: now - 2 * MIN })]
        .concat(srcs(C1_SOURCES, { sonar: { found: 24, checked: 24, newest_ms: now - 2 * MIN, detail: 'new 21, grew 2, broke out 1' } })) },
      [US]: { rows: [hit({ source: 'bmie', why: 'brand-safety query', post_url: 'http://twitter.com/critic/statuses/2116390716536770004', seen_ms: now - 2 * MIN }),
        hit({ source: 'bmie', why: 'negative', post_url: 'http://twitter.com/apac/statuses/2116390716536770005', seen_ms: now - 2 * MIN }),
        hit({ source: 'bmie', why: 'sample', post_url: 'http://twitter.com/nba/statuses/2116390716536770006', impact: 5, seen_ms: now - 2 * MIN })]
        .concat(srcs(US_SOURCES, { bmie: { found: 41, checked: 41, newest_ms: now - 2 * MIN,
          detail: 'brand-safety query 30, negative 6, KOF author 2, sample 3, not sent 120' } })) },
    };
    t.poll();
    eq(dataRows(t).map(r => r[6]), ['Sonar', 'Sonar · grew', 'Sonar · broke out', 'Brandwatch (BMIE)', 'Brandwatch (BMIE) · negative',
      'Brandwatch (BMIE) · sample']);
    const row = name => sources(t).rows.slice(3).find(r => r[0] === name);
    eq([row('Sonar')[6], row('Brandwatch (BMIE)')[6]], ['24 / 24 (new 21, grew 2, broke out 1)',
      '41 / 41 (brand-safety query 30, negative 6, KOF author 2, sample 3, not sent 120)']);
    assert.match(row('Brandwatch (BMIE)')[1], /every one from the brand-safety and Google product queries.*5% sample of the rest/);
    assert.match(row('Sonar')[1], /grew past the reach floor later, and posts that broke out \(10x the engagements, 1,000\+\)$/);
    // the queries checked in full, and the words that count as a sign of trouble
    const full = new RegExp(B.ev('PW_BMIE_FULL_RX_'));
    eq(['all slrr kofs/inf', 'all sundar', 'google spikes', 'ai digest - general criticism', 'ai digest - sustainability & environment',
      'v2 policy mar - elections', 'googlers posting on x', 'chrome overall', 'today in android', 'search', 'gemini', 'g4d developer ai 2']
      .filter(q => !full.test(q)), []);
    eq(['apac vt', 'today in nba', 'nfl', 'culture accounts - ind', 'new ai digest approach', 'ai digest - openai', 'searching for growth']
      .filter(q => full.test(q)), []);
    const risk = new RegExp(B.ev('PW_RISK_WORDS_RX_'));
    eq(['google faces an antitrust lawsuit', 'gmail is down again', 'a data breach at', 'chrome zero-day exploited', 'ai overviews hallucinated',
      'deforestation for a data center'].filter(x => !risk.test(x)), []);
    eq(['great game last night', 'the biased coin', 'download the app'].filter(x => risk.test(x)), ['the biased coin']);
  });

  test('proactive watch: the Brandwatch query "2026 Election Alerts" (project 1998344909, query 2004167929) is read straight from Brandwatch\'s API when the US look goes out: the shared token from Secret Manager (billed to the project; never in a query, the sheet or the logs), what Brandwatch added since the last look (an hour back on a first look, never after the look\'s end), posted within 72 hours, the newest added first; X posts\' text from X\'s embed data in one go (an X post X won\'t show is counted, never asked about); the mentions are a query parameter, never SQL; a post it hands over is recorded with its source, its place moves to the newest one, and the next look asks only for what came after', () => {
    const { t, bq } = watching();
    const bw = fakeBw(t.g);
    const T = t.g.clock.now;  // the next look ends here (it goes out a minute later)
    const XID = '2117095906554290591';
    const XURL = `https://x.com/ElectionWatcher/status/${XID}`;
    const NEWS = 'https://www.examplenews.com/2026/11/google-maps-polling-places';
    const BSKY = 'https://bsky.app/profile/voter.bsky.social/post/3m4abcdefgh';
    const REDDIT = 'https://www.reddit.com/r/politics/comments/1abc/polling/';
    bw.pages = [[
      mention({ added: bwTime(T + 30 * 1000), pageType: 'reddit', url: REDDIT, title: 'Polling', snippet: 'Google says polls close at 7' }),
      mention({ added: bwTime(T - 2 * MIN), pageType: 'twitter', guid: XID, url: null, author: null, snippet: '', date: null,
        potentialAudience: 4470, impact: 7.4, sentiment: 'negative' }),
      mention({ added: bwTime(T - 5 * MIN), pageType: 'news', url: NEWS, author: 'Jane Doe', publicationName: 'Example News',
        title: 'Google Maps sends Harris County voters to closed polling places',
        snippet: 'Voters in Harris County said Google Maps sent them to polling places that had closed...', date: bwTime(T - 40 * MIN),
        potentialAudience: 2275251, impact: 44.9 }),
      mention({ added: bwTime(T - 7 * MIN), pageType: 'bluesky', url: BSKY, author: 'voter.bsky.social',
        snippet: 'Gemini told me election day is Wednesday??', date: bwTime(T - 9 * MIN), blueskyFollowers: 9914, potentialAudience: 9914,
        likes: 8, comments: 1, shares: 2 }),
      mention({ added: bwTime(T - 9 * MIN), pageType: 'twitter', guid: '2117000000000000001', url: null, snippet: '', potentialAudience: 120 }),
      mention({ added: bwTime(T - 2 * HOUR), pageType: 'news', url: 'https://old.example.com/a', title: 'Old', snippet: 'Old news' }),
    ]];
    bw.x[XID] = xPost(XID, 'ElectionWatcher', 'Asked Gemini who won the Ohio Senate race and it named the wrong person.', {
      created_at: new Date(T - 3 * MIN).toISOString(), favorite_count: 40, conversation_count: 12,
      quoted_tweet: { id_str: '2117000000000000009', text: 'Results are not final yet', user: { screen_name: 'OhioSOS' } } });
    t.poll();
    const look = lanes(bq).us[0];
    // where it read: the token from Secret Manager (the script's own token, billed to the project), then Brandwatch with it
    eq(bw.calls.map(c => c.host), ['secret', 'brandwatch', 'x', 'x']);
    eq(bw.calls[0].url, 'https://secretmanager.googleapis.com/v1/projects/brand-social-central-data/secrets/slrr-campaigns-bw-token/versions/latest:access');
    eq(bw.calls[0].headers, { Authorization: 'Bearer TOKEN', 'x-goog-user-project': 'brand-social-central-data' });
    const call = bw.calls[1];
    assert.ok(call.url.startsWith('https://api.brandwatch.com/projects/1998344909/data/mentions?queryId=2004167929&'), call.url);
    for (const piece of [`startDate=${encodeURIComponent(new Date(T - 72 * HOUR).toISOString())}`, 'pageSize=20', 'page=0',
      'orderBy=added', 'orderDirection=desc']) assert.ok(call.url.includes(piece), piece);
    eq(call.headers, { Authorization: `bearer ${bw.token}`, Accept: 'application/json' });
    // X's embed data for the X posts, the biggest account first
    assert.match(bw.calls[2].url, new RegExp(`^https://cdn\\.syndication\\.twimg\\.com/tweet-result\\?id=${XID}&`));
    assert.match(bw.calls[3].url, /\?id=2117000000000000001&/);
    // what the look carries: the four Brandwatch added in the hour up to the look's end, as @bwq; nothing went wrong
    eq([look.types.bwq, look.params.bwq_err], ['ARRAY', '']);
    const rows = look.arrays.bwq;
    eq(rows.map(r => r.u), [XURL, NEWS, BSKY, 'https://x.com/i/status/2117000000000000001']);
    eq(rows[0], { u: XURL, n: 'twitter', a: '@ElectionWatcher', f: '4470', e: '52', p: String(T - 3 * MIN), s: String(T - 2 * MIN),
      i: 'Brandwatch · 2026 Election Alerts', m: 'Asked Gemini who won the Ohio Senate race and it named the wrong person.',
      t: 'Post text: Asked Gemini who won the Ohio Senate race and it named the wrong person.\nQuoting @OhioSOS: Results are not final yet\n' +
        'Brandwatch: negative sentiment, potential audience 4,470, impact 7.4 of 100' });
    eq([rows[1].n, rows[1].a, rows[1].f, rows[1].e, rows[1].p], ['news', 'Jane Doe', '-1', '-1', String(T - 40 * MIN)]);
    eq(rows[1].t, 'Title: Google Maps sends Harris County voters to closed polling places\n' +
      'Post text: Voters in Harris County said Google Maps sent them to polling places that had closed...\nSite: Example News\n' +
      'Brandwatch: neutral sentiment, potential audience 2,275,251, impact 44.9 of 100');
    eq([rows[2].n, rows[2].a, rows[2].f, rows[2].e], ['bluesky', 'voter.bsky.social', '9914', '11']);
    eq([rows[3].n, rows[3].t, rows[3].f], ['twitter', '', '120']);  // X wouldn't show it: counted, never asked about
    // the SQL: the mentions are a parameter (never in it); those with no text 'skipped'; a read error goes on the source's row
    for (const piece of ['FROM UNNEST(@bwq) c', "IF(IFNULL(c.t, '') = '', 'skipped', 'new')", "STRUCT('bwq' AS source, 100 AS cap)",
      "INSERT INTO pw_src (source, err) SELECT 'bwq', @bwq_err FROM UNNEST([1]) WHERE @bwq_err != '';"]) {
      assert.ok(look.sql.includes(piece), piece);
    }
    assert.ok(!/Harris County|Ohio Senate|ElectionWatcher/.test(look.sql), 'the mentions\' words are a parameter, never in the SQL');
    assert.ok(!lanes(bq).c1[0].sql.includes('@bwq'), 'US only');
    // the token goes only to Brandwatch: never in a query, a log line or the sheet
    const sheetText = JSON.stringify(Array.from(t.g.spreadsheets.values()).map(ss => ss.sheets.map(sh => sh.rows)));
    assert.ok(![JSON.stringify(bq.looks), t.g.logs.join('\n'), sheetText].some(s => s.includes(bw.token)), 'the token stays out');
    // collected: its post recorded with its source; its place moves to the newest it handed over
    bq.answers = {
      [US]: { rows: [hit({ source: 'bwq', why: 'new', post_url: XURL, author: '@ElectionWatcher', followers: 4470, eng: 52,
        issue: 'Brandwatch · 2026 Election Alerts', issue_new: null, impact: 8, topic: 'Elections and civics', seen_ms: T - 2 * MIN,
        posted_ms: T - 3 * MIN, summary: 'Asked Gemini who won the Ohio Senate race and it named the wrong person.' })]
        .concat(srcs(US_SOURCES, { bwq: { found: 3, checked: 3, newest_ms: T - 2 * MIN, detail: 'new 3, not sent 1' } })) },
      [C1]: { rows: srcs(C1_SOURCES) },
    };
    t.poll();
    eq(dataRows(t).map(r => [r[5], r[6], r[7], r[8], r[9], r[12]]), [[XURL, BWQ, 'X', '@ElectionWatcher', 4470, 'Brandwatch · 2026 Election Alerts']]);
    eq(JSON.parse(t.g.props.get('PW_MARKS')).bwq, T - 2 * MIN);
    const row = sources(t).rows.slice(3).find(r => r[0] === BWQ);
    eq([row[2], row[3], row[6]], ['Brandwatch\'s API: project 1998344909, query 2004167929 (with the shared token in Secret Manager)',
      '✓ live: 3 new at the last look', '3 / 3 (new 3, not sent 1)']);
    // the next look (5 minutes after the first) takes only what Brandwatch added after that one: one page reaches it
    bw.calls.length = 0;
    for (let i = 0; i < 4; i++) t.poll();
    eq([lanes(bq).us.length, lanes(bq).us[1].arrays.bwq.map(r => r.u), bw.calls.map(c => c.host)], [2, [REDDIT], ['secret', 'brandwatch']]);
  });

  test('proactive watch: posts by Grok (X\'s AI account, @grok) are left out from every source: Gemini is never asked about them (Sonar\'s and BMIE\'s twitter.com/grok links, the Brandwatch query\'s x.com/grok ones, @grok as the author), they aren\'t counted as checked and the Watch sources tab counts them as "Grok left out"; one in a look sent before the change is never recorded, so never a watch alert; people\'s posts that mention or reply to Grok stay in', () => {
    // the JavaScript test and the same pattern in the SQL (BigQuery reads it as RE2, which agrees with JavaScript here)
    const grok = ['http://twitter.com/grok/statuses/2117021393208438919', 'https://twitter.com/grok/status/2116482042229670165',
      'https://x.com/grok/status/2117199347171385704', 'https://mobile.twitter.com/Grok/status/1', 'https://www.x.com/grok/status/2'];
    const people = ['https://x.com/JainalMomin/status/104', 'https://x.com/grokfan/status/5', 'https://x.com/i/status/6',
      'https://www.reddit.com/r/grok/comments/7/x/', 'https://www.youtube.com/watch?v=grok'];
    eq(grok.filter(u => !B.pwByGrok_(u, '')), []);
    eq(people.filter(u => B.pwByGrok_(u, 'Someone')), []);
    eq([B.pwByGrok_('https://x.com/i/status/8', ' @Grok '), B.pwByGrok_('https://x.com/i/status/8', 'Grok fan')], [true, false]);
    const sql = B.pwGrokSql_('n');
    const rx = new RegExp(sql.match(/r'([^']+)'/)[1]);
    eq(grok.map(u => u.toLowerCase()).filter(u => !rx.test(u)), []);
    eq(people.map(u => u.toLowerCase()).filter(u => rx.test(u)), []);
    assert.ok(sql.includes("LOWER(TRIM(IFNULL(n.author, ''))) = '@grok'"), sql);
    // both looks: left out before Gemini, not counted as checked, counted on the Watch sources tab
    const until = Date.UTC(2026, 10, 2, 11, 0);
    const watch = B.pwWatchFrom_([MIDTERMS, 'ON', 'Q?', '', '', '', '', ''], 3);
    for (const lane of ['c1', 'us']) {
      const q = B.pwSql_(lane, [watch], { since: until - 15 * MIN, until, froms: B.pwFroms_({}, until), chat: [] }).sql;
      for (const piece of [`IFNULL(n.why, '') != 'skipped' AND NOT ${sql}\n  ) WHERE dup = 1`, `AND NOT ${sql}) AS checked`,
        "'Grok left out', why) AS why"]) assert.ok(q.includes(piece), `${lane}: ${piece}`);
    }
    // a look sent before the change: its Grok rows are never recorded (so never queued as watch alerts); the others are
    const { t, bq } = watching();
    t.poll();
    const now = t.g.clock.now;
    const PERSON = 'https://x.com/ElectionWatcher/status/2117095906554290591';
    bq.answers = {
      [US]: { rows: [hit({ source: 'bmie', post_url: grok[0], author: '@grok', followers: 9300000, seen_ms: now - 2 * MIN }),
        hit({ source: 'bwq', post_url: grok[2], author: '@grok', seen_ms: now - 2 * MIN }),
        hit({ source: 'bmie', post_url: PERSON, author: '@ElectionWatcher', seen_ms: now - 2 * MIN })].concat(srcs(US_SOURCES)) },
      [C1]: { rows: [hit({ post_url: grok[1], author: 'Grok', followers: 9260628, seen_ms: now - 2 * MIN })].concat(srcs(C1_SOURCES)) },
    };
    t.poll();
    eq(dataRows(t).map(r => r[5]), [PERSON]);
  });

  test('proactive watch: when the Brandwatch query can\'t be read (Secret Manager refuses, Brandwatch refuses the token, too many calls) the look still goes out for the other sources, with the error as @bwq_err for the source\'s row (its place stays, so those mentions are read again next time; the token is cut out of any error); what was read before an error still counts; a page of 20 first (on a quiet look all it reads: Brandwatch\'s X allowance is shared), then pages of 100 until one reaches where the last look left off, 3 at most', () => {
    const { t, bq } = watching();
    const bw = fakeBw(t.g);
    bw.secret = { code: 403, message: 'Permission \'secretmanager.versions.access\' denied' };
    t.poll();
    const look = lanes(bq).us[0];
    eq([look.params.bwq_err, look.arrays.bwq, lanes(bq).c1.length, bw.calls.map(c => c.host)],
      ['Secret Manager HTTP 403 reading the shared Brandwatch token: Permission \'secretmanager.versions.access\' denied', [], 1, ['secret']]);
    eq(B.pwAdvanceMarks_({ bwq: 5000 }, [src('bwq', { newest_ms: 9000, err: 'Brandwatch HTTP 401' })]), { bwq: 5000 });  // it keeps its place
    // Brandwatch refusing the token (an answer that repeats it has it cut out)
    bw.secret = null;
    const T = t.g.clock.now;
    bw.pages = [{ code: 401, message: `Invalid access token: ${bw.token}` }];
    eq(t.bot.pwBwqItems_(T - HOUR, T), { rows: [], err: 'Brandwatch HTTP 401 (the shared token was refused): Invalid access token: [token]' });
    // pages: the newest added first: 20, then 100 a page (the first 20 again, skipped) until one reaches what came before;
    // 3 pages of 100 at most; an error after the first keeps what was read
    const batch = (n, from) => Array.from({ length: n }, (_, i) => mention({ added: bwTime(from - i * 1000), pageType: 'news',
      url: `https://news.example.com/a${from - i * 1000}`, title: 'T', snippet: 'Google and the election' }));
    const pagesAsked = () => bw.calls.filter(c => c.host === 'brandwatch')
      .map(c => `${c.url.match(/[?&]pageSize=(\d+)/)[1]}/${c.url.match(/[?&]page=(\d+)/)[1]}`);
    bw.calls.length = 0;
    bw.pages = [batch(5, T - MIN).concat(batch(15, T - 2 * HOUR))];  // a quiet look: 5 new, then what the last look had
    let got = t.bot.pwBwqItems_(T - HOUR, T);
    eq([got.rows.length, got.err, pagesAsked()], [5, '', ['20/0']]);
    bw.calls.length = 0;
    bw.pages = [batch(100, T - MIN), batch(2, T - 3 * MIN).concat(batch(1, T - 2 * HOUR))];
    got = t.bot.pwBwqItems_(T - HOUR, T);
    eq([got.rows.length, got.err, pagesAsked()], [102, '', ['20/0', '100/0', '100/1']]);
    bw.calls.length = 0;
    bw.pages = [batch(100, T - MIN), batch(100, T - 5 * MIN), batch(100, T - 10 * MIN), batch(100, T - 15 * MIN)];
    got = t.bot.pwBwqItems_(T - HOUR, T);
    eq([got.rows.length, pagesAsked()], [300, ['20/0', '100/0', '100/1', '100/2']]);
    bw.pages = [batch(100, T - MIN), { code: 429, message: 'Rate limit exceeded' }];
    got = t.bot.pwBwqItems_(T - HOUR, T);
    eq([got.rows.length, got.err], [100, 'Brandwatch HTTP 429 (too many calls for now): Rate limit exceeded']);
  });

  test('proactive watch: Brandwatch\'s mentions as the watch reads them: networks as Sonar names them (facebook_public is Facebook), the author\'s followers only where Brandwatch\'s potential audience is that (else unknown), zero counts as unknown, a title said once; X posts\' text from X\'s embed data, with the post they reply to, looked up together (60 a look at most, the biggest accounts first; none when the run is short of time) and kept for lookupPost_', () => {
    eq(B.pwBwTime_('2026-11-02T03:27:59.359+0000'), Date.UTC(2026, 10, 2, 3, 27, 59, 359));
    eq([B.pwBwTime_(''), B.pwBwTime_('soon'), B.pwBwTime_(null)], [0, 0, 0]);
    const fb = B.pwBwRow_(mention({ added: bwTime(5000), pageType: 'facebook_public', url: 'https://www.facebook.com/abc/posts/1', author: 'ABC News',
      snippet: 'Google ads and the midterms', potentialAudience: 552183, likes: 8, comments: 2, shares: 2 }), null);
    eq([fb.n, fb.f, fb.e, fb.a, fb.s], ['facebook', 552183, 12, 'ABC News', 5000]);
    const yt = B.pwBwRow_(mention({ added: bwTime(5000), pageType: 'youtube', url: 'https://www.youtube.com/watch?v=abc&lc=1', author: '@someone',
      title: 'Comment on video https://www.youtube.com/watch?v=abc', snippet: 'Google refuses to answer who won', potentialAudience: 0,
      youtubeSubscriberCount: 0, likes: 0, engagementScore: 0 }), null);
    eq([yt.n, yt.f, yt.e, yt.m], ['youtube', -1, -1, 'Google refuses to answer who won']);
    assert.ok(yt.t.startsWith('Title: Comment on video https://www.youtube.com/watch?v=abc\nPost text: Google refuses'), yt.t);
    const news = B.pwBwRow_(mention({ added: bwTime(5000), pageType: 'news', url: 'https://n.example.com/a', title: 'Candidates make a final push',
      snippet: 'Candidates make a final push in Pennsylvania', domain: 'n.example.com' }), null);
    eq(news.t, 'Post text: Candidates make a final push in Pennsylvania\nSite: n.example.com\nBrandwatch: neutral sentiment');
    const reply = B.pwBwRow_(mention({ added: bwTime(5000), pageType: 'twitter', guid: '2117000000000000002', snippet: '' }),
      { url: 'https://x.com/a/status/2117000000000000002', author: 'a', text: 'This is wrong', likes: 0, replies: 0, created_at: '',
        parent: { author: 'b', text: 'Google Maps lists my polling place as closed' } });
    eq([reply.u, reply.a, reply.e, reply.p, reply.t], ['https://x.com/a/status/2117000000000000002', '@a', 0, 0,
      'Post text: This is wrong\nReplying to @b: Google Maps lists my polling place as closed\nBrandwatch: neutral sentiment']);
    // X's embed data: looked up together, and kept for lookupPost_
    const { t } = watching();
    const bw = fakeBw(t.g);
    bw.x['2117000000000000003'] = xPost('2117000000000000003', 'c', 'Search hides results for my candidate');
    eq(Object.keys(t.bot.lookupXPosts_(['2117000000000000003', '2117000000000000004', 'nope'])), ['2117000000000000003']);
    eq(bw.calls.map(c => c.host), ['x', 'x']);
    bw.calls.length = 0;
    eq(t.bot.lookupPost_('https://x.com/c/status/2117000000000000003').text, 'Search hides results for my candidate');
    eq(t.bot.lookupXPosts_(['2117000000000000003'])['2117000000000000003'].author, 'c');
    eq(bw.calls.length, 0, 'from the cache');
    // 60 a look at most, the biggest accounts first; none when the run is short of time
    const T = t.g.clock.now;
    bw.pages = [Array.from({ length: 70 }, (_, i) => mention({ added: bwTime(T - (i + 1) * 1000), pageType: 'twitter',
      guid: String(2117100000000000000n + BigInt(i)), snippet: '', potentialAudience: i }))];
    t.bot.pwBwqItems_(T - HOUR, T);
    const asked = bw.calls.filter(c => c.host === 'x').map(c => Number(c.url.match(/[?&]id=(\d+)/)[1].slice(-2)));
    eq([asked.length, asked[0], asked[59]], [60, 69, 10]);
    bw.calls.length = 0;
    // short of time: only the first page of 20, and none of their X text
    const short = t.bot.pwBwqItems_(T - HOUR, T, () => 30 * 1000);
    eq([short.rows.length, short.rows.every(r => r.t === ''), bw.calls.filter(c => c.host === 'x').length], [20, true, 0]);
  });

  // ===========================================================================================================
  // The scorecard
  // ===========================================================================================================

  test('proactive watch scorecard: Burson\'s alerts (the Alert log\'s posts that reached S-F Burson today; never one the bot took from BigQuery or an Other alerts space\'s) against the watches\' flags: caught, caught first and the median lead; flagged, near misses and ratings; each row gets "Burson alerted" and its lead; the 7-day total', () => {
    const { t, bq } = watching();
    t.poll();
    const seen = t.g.clock.now - 3 * MIN;
    const backend = t.bot.sheetBackend_(t.sheet());
    const alert = (id, url, at, o) => backend.appendAlert(Object.assign({ alert_id: id, created_at: at, updated_at: at,
      space: 'spaces/AAQAaa_0I9g > spaces/AAQAUCmnBds (auto-correct)', record_key: B.recordKey_({ post_url: url }), source_at: at,
      status: 'ok' }, o || {}));
    alert('QA-2001', POST1, seen + 90 * MIN);                                       // flagged 90 minutes before Burson
    alert('QA-2002', 'https://www.instagram.com/reel/DfISJpCgOP2/', seen - 30 * MIN);  // Burson's, never flagged
    alert('QA-2003', 'https://x.com/someone/status/999', seen, { ingested: 'BSIP' });    // the bot's own: not Burson's
    alert('QA-2004', 'https://x.com/other/status/998', seen, { space: 'spaces/AAQAmidterm1 > (isolated) (other alerts)' });
    bq.answer = { rows: [hit({ seen_ms: seen }), hit({ post_url: POST2, platform: 'tiktok', impact: 5, seen_ms: seen })] };
    t.poll();
    const d = dets(t);
    const today = B.pwDay_(t.g.clock.now);
    eq(d.rows[3], [today, 2, 1, 1, 90, 1, 1, 0, 0]);
    eq(d.rows[10], ['Last 7 days', 2, 1, 1, 90, 1, 1, 0, 0]);
    eq(dataRows(t).map(r => [r[15], r[16]]), [[B.pwTime_(seen + 90 * MIN), 90], ['', '']]);
    // people rate the rows; the scorecard counts them at its next refresh (every 10 minutes)
    d.getRange(14, 18).setValue('Useful');
    d.getRange(15, 18).setValue('Noise');
    for (let i = 0; i < 10; i++) t.poll();
    eq(d.rows[3], [today, 2, 1, 1, 90, 1, 1, 1, 1]);
    eq(B.pwScorecard_([{ k: 'a', s: 0, b: 1 }, { k: 'b', s: 0, b: 1 }, { k: 'c', s: 0, b: 1 }, { k: 'd', s: 0, b: 1 }],
      { a: 10 * MIN, b: 20 * MIN, c: 25 * MIN, d: -5 * MIN }, ['D'], () => 'D')[0], ['D', 4, 4, 3, 20, 4, 0, 0, 0]);
  });

  // ===========================================================================================================
  // Safety and parsing
  // ===========================================================================================================

  test('proactive watch: a "Watches" or "Watch detections" tab people made is never read or written (nor a tab made beside it); C34 says to rename it; a "Watch sources" tab people made is left alone while the watch carries on', () => {
    const { t, bq } = world();
    const theirs = t.sheet().insertSheet('Watches');
    theirs.getRange(1, 1, 2, 2).setValues([['Show', 'Night'], ['Bake Off', 'Tuesday']]);
    const before = JSON.stringify(theirs.rows);
    switchOn(t);
    t.poll();
    t.poll();
    eq([JSON.stringify(theirs.rows), tab(t, 'Watch detections'), sources(t), bq.looks.length], [before, null, null, 0]);
    assert.match(note(t), / · ⚠️ not watching: a tab named "Watches" exists that the bot didn't make \(rename it and the bot makes its own\)$/);
    const other = world();
    const mine = other.t.sheet().insertSheet('Watch detections');
    mine.getRange(1, 1).setValue('My notes');
    switchOn(other.t);
    other.t.poll();
    eq([mine.rows, other.bq.looks.length], [[['My notes']], 0]);
    assert.match(note(other.t), /⚠️ not watching: a tab named "Watch detections" exists that the bot didn't make/);
    const third = world();
    const list = third.t.sheet().insertSheet('Watch sources');
    list.getRange(1, 1, 1, 2).setValues([['Feed', 'Owner']]);
    switchOn(third.t);
    third.t.poll();
    watches(third.t).getRange(3, 2).setValue('ON');
    third.t.poll();
    eq([list.rows, third.bq.looks.length], [[['Feed', 'Owner']], 2]);
  });

  test('proactive watch: a watch row reads as written (a bar outside 1-10 or blank is 7; networks as Sonar names them; topics cleaned and each once; a blank rubric or topics the defaults; no question, not watched; no name, no watch); at most 5 watches ON, each name once; the query carries the watches\' words only as parameters and the topics cleaned of quotes and backslashes', () => {
    const w = B.pwWatchFrom_([' Waymo  safety ', 'on', 'Is it about a Waymo crash?', '', 'Crashes; Recalls, crashes, "Rider\'s" \\stuff, Other',
      '12', 'X, IG, bsky, Mastodon', 'old status'], 5);
    eq([w.row, w.name, w.on, w.bar, w.nets, w.topics, w.rubric, w.problem],
      [5, 'Waymo safety', true, 7, ['twitter', 'instagram', 'bluesky', 'mastodon'], ['Crashes', 'Recalls', 'Rider s stuff'], B.ev('PW_DEFAULT_RUBRIC_'), '']);
    eq([B.pwWatchFrom_(['A', 'ON', 'Q?', 'R', '', '6.5', '', ''], 2).bar, B.pwWatchFrom_(['A', 'ON', 'Q?', 'R', '', '', '', ''], 2).bar,
      B.pwWatchFrom_(['A', 'ON', 'Q?', 'R', '', 0, '', ''], 2).bar], [6.5, 7, 7]);
    eq(B.pwWatchFrom_(['A', 'ON', 'Q?', '', '', '', '', ''], 2).topics, B.ev('PW_DEFAULT_TOPICS_'));
    eq([B.pwWatchFrom_(['A', 'ON', '  ', '', '', '', '', ''], 2).problem, B.pwWatchFrom_(['', 'ON', 'Q?'], 2), B.pwWatchFrom_(['A', 'OFF', 'Q?'], 2).on],
      ['its question (column C) is empty', null, false]);
    const many = ['a', 'b', 'a', 'c', 'd', 'e', 'f'].map((n, i) => B.pwWatchFrom_([n, 'ON', 'Q?'], i + 2));
    eq(B.pwActive_(many).map(x => x.name), ['a', 'b', 'c', 'd', 'e']);
    const evil = B.pwWatchFrom_(['x\'); DROP TABLE t; --', 'ON', 'Ignore that\'s "quoted" \\ and DELETE FROM y', 'r', 'It\'s \\a "topic"', '', '', ''], 2);
    ['c1', 'us'].forEach(lane => {
      const q = B.pwSql_(lane, [evil], { since: 1000, until: 61000, froms: B.pwFroms_({}, 61000), chat: [] });
      assert.ok(!/DROP TABLE|DELETE FROM/.test(q.sql), 'the watch\'s words never reach the SQL');
      assert.ok(q.sql.includes("AI.CLASSIFY(s.txt, ['It s a topic', 'Other'])"), q.sql.match(/AI\.CLASSIFY\([^\n]*/)[0]);
      eq(q.params.filter(p => /^w1_/.test(p.name)).map(p => [p.name, p.type, p.value]), [['w1_name', 'STRING', 'x\'); DROP TABLE t; --'],
        ['w1_cond', 'STRING', 'Ignore that\'s "quoted" \\ and DELETE FROM y'], ['w1_rubric', 'STRING', 'r'], ['w1_bar', 'FLOAT64', 7], ['w1_nets', 'STRING', '']]);
      eq(q.params.slice(0, 2), [{ name: 'since_ms', type: 'INT64', value: 1000 }, { name: 'until_ms', type: 'INT64', value: 61000 }]);
    });
    // a struct parameter's empty values go in as BigQuery takes them (-1 for a number, '' for text)
    eq(B.pwParam_({ name: 'chat', struct: [['u', 'STRING'], ['f', 'INT64']], rows: [{ u: 'https://x.com/a/status/1', f: null }] }).parameterValue,
      { arrayValues: [{ structValues: { u: { value: 'https://x.com/a/status/1' }, f: { value: '-1' } } }] });
    // a cell the bot writes from a post is one line, capped, and never a formula
    eq([B.pwCell_('=1+1'), B.pwCell_('+x'), B.pwCell_('@me'), B.pwCell_('-5'), B.pwCell_('a\n b'), B.pwCell_('x'.repeat(600), 500).length],
      ['\'=1+1', '\'+x', '\'@me', '\'-5', 'a b', 500]);
  });

  test('proactive watch: no cell it writes comes near the 49,000-character cap (each text capped, the Other alerts space\'s alerts too), and a look\'s rows with no post (a source\'s row, or no hit at all) are none', () => {
    const big = 'y'.repeat(60000);
    const d = B.pwDetections_([hit({ summary: big, issue: big, author: big, topic: big, source: big, post_url: `https://x.com/a/status/1${'9'.repeat(10)}`, seen_ms: 1 }),
      { checked: 12, watch: null, post_url: null, impact: null }, src('sonar', { found: 3, checked: 3 })], new Set());
    eq(d.rows.length, 1);
    assert.ok(d.rows[0].every(c => String(c).length <= 500), 'every cell capped');
    eq(B.pwDetections_([{ checked: 3 }], new Set()).rows, []);
    const items = B.pwChatItems_([{ ingested: B.ev('OTHER_INGESTED_'), space: 'x (other alerts)', source_at: 5000, author: big,
      forwarded_fields: { post_url: 'https://x.com/a/status/2', issue_name: big, triage: { stream: big, summary: big } } }], 0, 10000);
    eq(items.length, 1);
    assert.ok(Object.values(items[0]).every(v => String(v).length <= 1500), 'every field capped');
  });
};
