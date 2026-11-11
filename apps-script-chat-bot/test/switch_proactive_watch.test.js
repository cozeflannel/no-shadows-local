// Proactive watch (Control tab row 34, proactiveWatch, ProactiveWatch.gs): spotting Google brand-safety issues before
// Burson's alert space does. With the switch ON (it starts OFF, like every switch), every 5 minutes the bot
// sends two read-only BigQuery scripts, one a location (us-central1: Pendulum's sonar_raw and Tubular's videos; US:
// Brandwatch's mentions of Google's products, Sprinklr's report of Google's own posts and the Brandwatch query "2026
// Election Alerts" read straight from Brandwatch's API). Each keeps its sources' new rows in a temporary table, then asks
// Gemini inside BigQuery (AI.IF for each watch ON on the Watches tab: the yes/no question its SLRR exposure tags and
// Sensitive Topics make, from the Watch tags tab; AI.SCORE for the posts that match, AI.CLASSIFY for the exposure tags of
// those at or near its bar). A later run collects them and records what scores at a watch's bar (and the near misses)
// on the Watch detections tab, whose scorecard compares it with Burson's alerts in the Alert log; the Watch sources tab
// says which sources are live. With Watch alerts (row 35) OFF, as here, nothing is posted or emailed (switch_watch_alerts
// covers the posting); a tab of the same name people made is never touched.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, e2e } = H;
  const ROW = 34;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const ON_TEXT = '✓ ON (Watch alerts, row 35, is OFF: nothing is posted or emailed): every 5 min, Gemini checks what\'s new in ' +
    'Sonar, Brandwatch, Sprinklr and Tubular against the watches ON on the Watches tab (the exposure tags they pick); ' +
    'what it flags is listed on the Watch detections tab';
  const OFF_TEXT = 'OFF (the bot reviews only the alerts posted in Chat)';
  const BRAND = 'Google brand safety (all)';
  const MIDTERMS = 'Midterms 2026 × Google';
  const POST1 = 'https://twitter.com/newsdesk/status/2116390716536770729';
  const POST2 = 'https://www.tiktok.com/@phonehackz1/video/7702553392157134102';
  const C1 = 'us-central1';
  const US = 'US';
  const C1_SOURCES = ['sonar', 'tubular'];
  const US_SOURCES = ['bwm', 'owned', 'comments', 'bwq'];
  const BWQ = 'Brandwatch: 2026 Election Alerts';
  const BWM = 'Brandwatch mentions';
  const OWNED = 'Sprinklr owned posts';
  const COMMENTS = 'Sprinklr comments';
  const SOURCE_NAMES = ['Sonar', 'Tubular', BWM, OWNED, COMMENTS, BWQ];
  const NETWORKS = "IN ('twitter', 'reddit', 'bluesky', 'facebook', 'instagram', 'youtube', 'tiktok')";
  const REMOVED_TABLES = /all_sundar_mentions|DSD-story-selection|stg_sprinklr_outbound|@chat\b/;
  // A look's result columns (pwSql_'s final SELECT): 'hit' rows (a post a watch) and 'src' rows (a source)
  const COLS = [['kind'], ['source'], ['why'], ['idx', 'INTEGER'], ['watch'], ['post_url'], ['platform'], ['author'], ['followers', 'INTEGER'],
    ['eng', 'INTEGER'], ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'], ['issue'], ['issue_new', 'BOOLEAN'], ['summary'],
    ['impact', 'FLOAT'], ['bar', 'FLOAT'], ['topic'], ['found', 'INTEGER'], ['checked', 'INTEGER'], ['newest_ms', 'INTEGER'],
    ['mod_ms', 'INTEGER'], ['err'], ['detail']];
  const TAGGED = 'P1 · Product - Privacy & security concerns';
  /** A row a look returns: a Sonar post at the bar of the brand-safety watch unless `o` says otherwise. */
  const hit = o => Object.assign({ kind: 'hit', source: 'sonar', idx: 1, watch: BRAND, post_url: POST1, platform: 'twitter',
    author: 'News Desk', followers: 147460, eng: 12, posted_ms: null, seen_ms: null, issue: 'Gmail scanning claim', issue_new: true,
    summary: 'Twitter user newsdesk (147.5K followers) claims Gmail scans every message for AI training.', impact: 8, bar: 7,
    topic: TAGGED }, o || {});
  /** A source's row (nothing new unless `o` says otherwise). */
  const src = (source, o) => Object.assign({ kind: 'src', source, found: 0, checked: 0, newest_ms: null, mod_ms: null, err: null }, o || {});
  /** A row for each of `keys`, with `o[key]`'s fields. */
  const srcs = (keys, o) => keys.map(k => src(k, (o || {})[k]));
  /** A Watches row in its new layout (PW_WATCHES_HEADER_): name, On, P0, P1, P2, Sensitive, question, rubric, bar, networks. */
  const wrow = (name, on, p0, p1, p2, sens, q, rubric, bar, nets) => [name, on, p0 || '', p1 || '', p2 || '', sens || '', q || '',
    rubric || '', bar === undefined ? '' : bar, nets || '', ''];

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
  const tagsTab = t => tab(t, 'Watch tags');
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
  /** A first look's SQL for one lane, for `watches` (pwWatchFrom_ rows), as the bot builds it. */
  const lookSql = (lane, list, until) => B.pwSql_(lane, list, { since: until - 15 * MIN, until, froms: B.pwFroms_({}, until) });

  // ===========================================================================================================
  // OFF
  // ===========================================================================================================

  test('proactive watch OFF (row 34, as every switch starts): nothing changes: no tab is made, no BigQuery look, nothing remembered; C34 says what OFF means; what a look left behind before it was switched OFF is forgotten', () => {
    const { t, bq } = world();
    for (let i = 0; i < 6; i++) t.poll();
    eq([t.control().cell(ROW, 1), t.control().cell(ROW, 2), note(t), t.control().validations[`${ROW},2`].values],
      ['Proactive watch', 'OFF', OFF_TEXT, ['ON', 'OFF']]);
    eq([tab(t, 'Watches'), tab(t, 'Watch detections'), sources(t), tagsTab(t), bq.looks.length, bq.gets.length, pwProps(t)],
      [null, null, null, null, 0, 0, []]);
    ['PW_AT', 'PW_SINCE', 'PW_JOB', 'PW_TRIES', 'PW_LAST', 'PW_US_AT', 'PW_US_SINCE', 'PW_US_JOB', 'PW_US_TRIES', 'PW_MARKS']
      .forEach(k => t.g.props.set(k, '1'));
    t.poll();
    eq(pwProps(t), []);
    eq(t.bot.status().proactive_watch, 'OFF');
  });

  // ===========================================================================================================
  // ON: the tabs, a look, its rows
  // ===========================================================================================================

  test('proactive watch ON: the first run makes its four tabs (Watches: two watches, both OFF, with the On dropdown, the brand-safety watch picking All four tag columns; Watch detections, after it: its title, the scorecard\'s and the detections\' headers, protected with a warning but for Rating, the key column hidden; Watch sources, after that: one row a source, each waiting for its first look; Watch tags, after that: the team\'s 58 exposure tags and Sensitive Topics, each ON); with no watch ON nothing is asked and C34 says why; people\'s edits are kept', () => {
    const { t, bq } = world();
    switchOn(t);
    t.poll();
    const w = watches(t);
    eq(w.rows[0], B.ev('PW_WATCHES_HEADER_'));
    eq(w.rows.slice(1).map(r => [r[0], r[1], r[2], r[3], r[4], r[5], r[8]]),
      [[MIDTERMS, 'OFF', '', '', '', '', 7], [BRAND, 'OFF', 'All', 'All', 'All', 'All', 7]]);
    assert.ok(/^Does this post connect Google/.test(w.cell(2, 7)) && w.cell(3, 7) === '', 'Midterms asks its own question; the brand-safety watch none');
    eq([w.validations['2,2'].values, w.frozenRows], [['ON', 'OFF'], 1]);
    const d = dets(t);
    eq([d.cell(1, 1), d.rows[2], d.rows[12], d.hidden], [B.ev('PW_DET_TITLE_'), B.ev('PW_SCORE_HEADER_'), B.ev('PW_DET_HEADER_'), [19]]);
    eq(d.rows[12][4], 'Exposure tags');
    eq([d.protections.length, d.protections[0].warningOnly, d.protections[0].unprotected.length], [1, true, 1]);
    const s = sources(t);
    eq([s.cell(1, 1), s.rows[2], s.rows.slice(3).map(r => r[0]), s.protections.length, s.protections[0].warningOnly],
      [B.ev('PW_SRC_TITLE_'), B.ev('PW_SRC_HEADER_'), SOURCE_NAMES, 1, true]);
    eq(s.rows.slice(3).map(r => r[3]), SOURCE_NAMES.map(() => '... waiting for its first look'));
    eq(s.rows.slice(3).map(r => r[2]), ['bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw', 'brand-social-central-data.google_tubular_mentions.tubular_videos',
      'brand-social-central-data.raw_data.brandwatch_raw_mentions_base', 'brand-social-central-data.reporting_data.sprinklr_outbound_reporting',
      'brand-social-central-data.reporting_data.sprinklr_inbound_comments',
      'Brandwatch\'s API: project 1998344909, query 2004167929 (with the shared token in Secret Manager)']);
    // the Watch tags tab: the team's list, one row a tag, every one ON; merged tags' old names as also known as
    const g = tagsTab(t);
    eq([g.rows[0], g.rows.length - 1, g.frozenRows, g.validations['2,6'].values, g.protections.length],
      [B.ev('PW_TAGS_HEADER_'), 58, 1, ['ON', 'OFF'], 0]);
    eq(['P0', 'P1', 'P2', 'Sensitive topic'].map(p => g.rows.slice(1).filter(r => r[0] === p).length), [11, 17, 18, 12]);
    eq(g.rows.slice(1).every(r => r[5] === 'ON' && r[2] && r[3]), true);
    const row = name => g.rows.slice(1).find(r => r[1] === name);
    eq(row('Content - Negative reaction to owned social post')[4], 'Content - Negative discussion of owned content');
    eq(row('Brand - Litigation')[4], 'Product - Litigation');
    assert.ok(row('Employees - Misconduct allegations'), 'the *NEW* mark is not part of the name');
    assert.ok(/^Content produced by government designated foreign terrorist organizations/.test(row('Violence / Weapons')[2]));
    eq(row('Violence / Weapons')[3], B.lookupTopic_('Violence / Weapons').description);  // the short version: the bot's own line
    const names = t.sheet().sheets.map(x => x.name);
    eq([names.indexOf('Watch detections') - names.indexOf('Watches'), names.indexOf('Watch sources') - names.indexOf('Watch detections'),
      names.indexOf('Watch tags') - names.indexOf('Watch sources')], [1, 1, 1]);
    eq([bq.looks.length, note(t)], [0, `${ON_TEXT} · waiting: no watch is ON (set a watch's On to ON on the Watches tab)`]);
    eq([w.cell(2, 11), w.cell(3, 11)], ['OFF: not watched', 'OFF: not watched']);
    w.getRange(2, 7).setValue('My own question?');
    w.getRange(4, 1, 1, 7).setValues([['My watch', 'OFF', '', '', '', '', 'Is it about Pixel batteries?']]);
    g.getRange(2, 3).setValue('Our own words for it');
    t.poll();
    eq([t.sheet().sheets.filter(x => x.name === 'Watches').length, w.cell(2, 7), w.rows[3].slice(0, 7), w.cell(4, 11), g.cell(2, 3)],
      [1, 'My own question?', ['My watch', 'OFF', '', '', '', '', 'Is it about Pixel batteries?'], 'OFF: not watched', 'Our own words for it']);
    eq(t.bot.status().proactive_watch, 'ON (Watch alerts row 35 is OFF: its flags are only listed)');
  });

  test('proactive watch: with a watch ON, a look goes out as two read-only BigQuery scripts, one a location: us-central1 (Sonar\'s new posts, Tubular\'s new videos) and US (Brandwatch\'s mentions of Google\'s products and Sprinklr\'s report of Google\'s own posts, each read only when its table changed, and the Brandwatch query), each source in a block of its own; the window the last 15 minutes up to a minute ago, every other source from its first-look start; the watch\'s question built from its tags, its words and the tags only as query parameters; a 5 GB cap and its label; a later run collects both: each post at or above the bar, and each near miss, goes on the Watch detections tab once, with its exposure tags, its source and the Rating dropdown; C34, the watch\'s status and the Watch sources tab say how it\'s doing; nothing is posted or emailed', () => {
    const { t, bq } = watching();
    const chatWrites = writes(t);
    const sent0 = t.g.gmail.sentMessages().length;
    t.poll();
    const { c1, us } = lanes(bq);
    eq([bq.looks.length, c1.length, us.length], [2, 1, 1]);
    const sentAt = t.g.clock.now;
    const until = sentAt - MIN;
    const seed = B.ev('PW_WATCH_SEEDS_')[1];
    const tags = B.pwSeedTags_();
    const question = B.pwQuestion_(tags, '');
    [[c1[0], 'c1'], [us[0], 'us']].forEach(([look, key]) => {
      eq([look.body.useLegacySql, look.body.parameterMode, look.body.labels, look.body.maximumBytesBilled],
        [false, 'NAMED', { purpose: 'proactive-watch', tool: 'burson-qa-bot', lane: key }, String(5 * 1024 ** 3)]);
      eq([Number(look.params.until_ms), Number(look.params.since_ms)], [until, sentAt - 16 * MIN]);
      eq([look.types.since_ms, look.types.until_ms, look.types.w1_name, look.types.w1_bar, look.types.w1_tags, look.types.tags],
        ['INT64', 'INT64', 'STRING', 'FLOAT64', 'STRING', 'ARRAY']);
      eq([look.params.w1_name, look.params.w1_cond, look.params.w1_rubric, look.params.w1_bar, look.params.w1_nets, look.params.w2_name],
        [BRAND, question, seed[7], '7', '', undefined]);
      eq(look.params.w1_tags.split('|').length, 58);
      // AI.CLASSIFY's categories: the watch's tags, each with its full description, as a parameter
      eq([look.arrays.tags.length, look.arrays.tags[0]], [58, { category: 'P0 · Brand - Perceived bias - brand',
        description: B.ev('PW_TAG_SEEDS_')[0][3] }]);
      assert.ok(!look.sql.includes('Does this post fall under') && !look.sql.includes(BRAND) && !look.sql.includes('Perceived bias'),
        'the watch\'s words and the tags are parameters, never in the SQL');
      for (const piece of ['CREATE TEMP TABLE pw_new (', 'EXCEPTION WHEN ERROR THEN', 'AND AI.IF(CONCAT(w.cond', 'AI.SCORE(CONCAT(rubric',
        'DECLARE pw_tags ARRAY<STRUCT<category STRING, description STRING>> DEFAULT @tags;',
        "AI.CLASSIFY(s.txt, pw_tags, output_mode => 'multi') AS tags FROM scored s WHERE s.impact >= GREATEST(1, s.bar - 2)",
        "WHERE k.tagset = '' OR t IN UNNEST(SPLIT(k.tagset, '|'))), '; ') AS topic", '.__TABLES__`']) {
        assert.ok(look.sql.includes(piece), `${key}: ${piece}`);
      }
      assert.ok(!/\b(?:INSERT INTO|DELETE FROM|UPDATE|MERGE INTO|CREATE (?:OR REPLACE )?TABLE)\s+`/i.test(look.sql),
        'nothing is written but the script\'s own temporary tables');
      assert.ok(!REMOVED_TABLES.test(look.sql), `${key}: the sources dropped Nov 10 are read no more`);
    });
    eq([c1[0].body.location, us[0].body.location], [C1, US]);
    for (const piece of ['FROM `bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`', 'w.followers >= 1000 OR w.eng >= 100', 'INTERVAL 24 HOUR',
      "WHEN NOT p.was_eligible THEN 'grew'", "WHEN w.eng >= 1000 AND w.eng >= 10 * GREATEST(IFNULL(p.eng_before, 0), 1) THEN 'broke out'",
      "INTERVAL IF(why = 'new', 24, 72) HOUR", '`brand-social-central-data.google_tubular_mentions.tubular_videos`',
      "STRUCT('sonar' AS source, 150 AS cap), STRUCT('tubular' AS source, 60 AS cap)])"]) {
      assert.ok(c1[0].sql.includes(piece), piece);
    }
    assert.ok(!c1[0].sql.includes('IF pw_mod_'), 'no table read only when it changed in us-central1');
    for (const piece of ['DECLARE pw_mod_bwm INT64 DEFAULT NULL;', 'DECLARE pw_mod_owned INT64 DEFAULT NULL;',
      'IF pw_mod_bwm > @bwm_mod THEN', '`brand-social-central-data.raw_data.brandwatch_raw_mentions_base`',
      'IF pw_mod_owned > @owned_mod THEN', '`brand-social-central-data.reporting_data.sprinklr_outbound_reporting`',
      "STRUCT('bwm' AS source, 1000 AS cap), STRUCT('owned' AS source, 40 AS cap), STRUCT('comments' AS source, 30 AS cap), STRUCT('bwq' AS source, 100 AS cap)",
      "IFNULL(n.why, '') != 'skipped'"]) {
      assert.ok(us[0].sql.includes(piece), piece);
    }
    assert.ok(!/brandwatch_daily|content_vectors|reddit_items_raw/.test(us[0].sql + c1[0].sql), 'the stale feeds are not read');
    assert.ok(!us[0].sql.includes('sonar_raw') && !c1[0].sql.includes('brandwatch_raw_mentions_base'), 'each location reads only its own tables');
    // a first look: every source that keeps its own place starts its firstMs back; no table read yet
    eq(Number(c1[0].params.tubular_from), until - 24 * HOUR);
    eq([us[0].params.bwm_from, us[0].params.owned_from, us[0].params.bwm_mod, us[0].params.owned_mod].map(Number),
      [until - 2 * HOUR, until - 30 * HOUR, 0, 0]);
    eq(Object.keys(us[0].params).filter(k => /^(bwdaily|vectors|reddit|bmie|story|outbound)_/.test(k)), []);
    eq([us[0].types.chat, us[0].types.bwq, us[0].types.bwq_err, c1[0].types.bwq, c1[0].types.bwq_err], [undefined, 'ARRAY', 'STRING', undefined, undefined]);
    eq(JSON.parse(t.g.props.get('PW_JOB')), { since: sentAt - 16 * MIN, until, at: sentAt, tries: 0, id: 'pwjob_1',
      project: 'brand-social-central-data', location: C1 });
    eq(JSON.parse(t.g.props.get('PW_US_JOB')), { since: sentAt - 16 * MIN, until, at: sentAt, tries: 0, id: 'pwjob_2',
      project: 'brand-social-central-data', location: US });
    assert.match(note(t), / · first look sent Oct 14, \d+:\d\d [AP]M EDT \(1 watch, 6 sources\); its results come in a minute or two$/);
    // The next run collects both
    const seen = sentAt - 4 * MIN;
    bq.answers = {
      [C1]: { rows: [hit({ seen_ms: seen, posted_ms: seen - 3 * MIN }),
        hit({ source: 'tubular', post_url: POST2, platform: 'tiktok', author: 'phonehackz1', followers: 4921, eng: 0, impact: 5.5,
          issue: 'Tubular', issue_new: false, summary: '=HYPERLINK("x") a data leak video', topic: 'Sensitive · Privacy', seen_ms: seen + MIN })]
        .concat(srcs(C1_SOURCES, { sonar: { found: 27, checked: 27, newest_ms: seen + MIN, mod_ms: sentAt - 2 * MIN },
          tubular: { found: 300, checked: 60, newest_ms: seen } })) },
      [US]: { rows: srcs(US_SOURCES, { bwm: { found: 12, checked: 12 } }) },
    };
    t.poll();
    eq([bq.gets.length, t.g.props.get('PW_JOB'), t.g.props.get('PW_US_JOB'), Number(t.g.props.get('PW_SINCE')),
      Number(t.g.props.get('PW_US_SINCE')), t.g.props.get('PW_TRIES')], [2, undefined, undefined, until, until, undefined]);
    assert.match(bq.gets[0], /\/projects\/brand-social-central-data\/queries\/pwjob_1\?location=us-central1&timeoutMs=3000$/);
    assert.match(bq.gets[1], /\/projects\/brand-social-central-data\/queries\/pwjob_2\?location=US&timeoutMs=3000$/);
    const rows = dataRows(t);
    eq(rows.length, 2);
    eq(rows[0].slice(0, 18), [B.pwTime_(seen), BRAND, 8, 'Yes', TAGGED, POST1, 'Sonar', 'X', 'News Desk', 147460, 12,
      B.pwTime_(seen - 3 * MIN), 'Gmail scanning claim', 'Yes', 'Twitter user newsdesk (147.5K followers) claims Gmail scans every ' +
      'message for AI training.', '', '', '']);
    eq(JSON.parse(rows[0][18]), { k: B.recordKey_({ post_url: POST1 }), w: BRAND, s: seen, b: 1 });
    // the formula-looking summary went in with a leading apostrophe: Sheets keeps it as plain text (shown without it)
    eq([rows[1][2], rows[1][3], rows[1][4], rows[1][6], rows[1][7], rows[1][11], rows[1][13], rows[1][14]],
      [5.5, 'No', 'Sensitive · Privacy', 'Tubular', 'TikTok', '', '', '=HYPERLINK("x") a data leak video']);
    eq(dets(t).validations['14,18'].values, ['Useful', 'Noise']);
    assert.match(note(t), / · last look Oct 14, \d+:\d\d [AP]M EDT: 99 new posts, 1 flagged · today: 1 flagged, 1 near miss · all 6 sources live \(Watch sources tab\)$/);
    assert.match(watches(t).cell(3, 11), /^✓ watched \(58 tags\) · today: 1 flagged, 1 near miss · last look \d+:\d\d [AP]M$/);
    eq(watches(t).cell(2, 11), 'OFF: not watched');
    const today = JSON.parse(t.g.props.get('PW_TODAY'));
    eq([today.looks, today.checked, today.flagged, today.near, today.w, today.src.sonar, today.src.tubular, today.src.bwm, today.src.owned],
      [2, 99, 1, 1, { [BRAND]: [1, 1] }, [27, 1], [60, 0], [12, 0], [0, 0]]);
    // Sonar goes by the window; the others had nothing new; Brandwatch counts the 12 it handed Gemini today
    eq(JSON.parse(t.g.props.get('PW_MARKS')), { tubular: seen, bwm_day: B.pwDay_(t.g.clock.now), bwm_n: 12 });
    const s = sources(t).rows;
    eq([s[3][3], s[3][4], s[3][5], s[3][6], s[3][7], s[3][8]],
      ['✓ live: 27 new at the last look', B.pwTime_(sentAt - 2 * MIN), B.pwTime_(seen + MIN), '27 / 27', 27, 1]);
    eq([s[4][3], s[4][6], s[4][7], s[5][3], s[5][6]], ['✓ live: 300 new at the last look', '300 / 60', 60, '✓ live: 12 new at the last look', '12 / 12']);
    eq([writes(t), t.g.gmail.sentMessages().length], [chatWrites, sent0]);  // nothing posted in Chat, nothing emailed
    assert.match(t.bot.status().proactive_watch_status, /^✓ ON \(Watch alerts, row 35, is OFF: nothing is posted or emailed\)/);
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
    eq([second.params.since_ms, Number(second.params.until_ms), second.params.w1_name, second.params.w2_name, second.params.w1_tags],
      [first.params.until_ms, t.g.clock.now - MIN, MIDTERMS, BRAND, '']);
    eq(lanes(bq).us[1].params.since_ms, firstUs.params.until_ms);
    bq.answer = { rows: [hit({ idx: 2, seen_ms: t.g.clock.now - 3 * MIN }), hit({ idx: 1, watch: MIDTERMS, impact: 7.5, topic: 'Sensitive · Politics',
      seen_ms: t.g.clock.now - 3 * MIN })] };
    t.poll();
    eq(dataRows(t).map(r => [r[1], r[2], r[4], r[5]]), [[BRAND, 8, TAGGED, POST1], [MIDTERMS, 7.5, 'Sensitive · Politics', POST1]]);
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
    assert.match(note(t), / · ⚠️ the last look at Sonar and Tubular failed \(BigQuery HTTP 500: Backend error\); it tries again at the next look$/);
    for (let i = 0; i < 4; i++) t.poll();
    eq(c1().length, 1, 'not again before 5 minutes');
    t.poll();  // try 2
    t.poll();
    for (let i = 0; i < 4; i++) t.poll();  // try 3, 5 minutes after try 2
    eq([c1().length, c1().map(l => l.params.since_ms)], [3, [start, start, start]]);
    eq([t.g.props.get('PW_TRIES'), t.g.props.get('PW_SINCE')], [undefined, c1()[2].params.until_ms]);
    assert.match(note(t), / · ⚠️ skipped \d\d:\d\d-\d\d:\d\d for Sonar and Tubular after 3 tries \(BigQuery HTTP 500: Backend error\); the next look carries on$/);
    // the skipped window moved the location's other sources past it
    const marks = JSON.parse(t.g.props.get('PW_MARKS'));
    eq(marks.tubular, Number(c1()[2].params.until_ms));
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
    assert.match(note(t), / · ⚠️ the last look at Sonar and Tubular failed \(BigQuery took more than 4 minutes\); it tries again at the next look$/);
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

  test('proactive watch: Brandwatch\'s mentions table is read in the US look, in a block of its own, only when the table changed: the mentions of Google\'s product configs first loaded since the newest it handed over (2 hours back on a first look, never more than 6), each mention once (the table loads mentions again), negative, English, no shares, Reddit / Bluesky / Facebook / Instagram only, tagged by Brandwatch with an SLRR exposure tag (those tags go to Gemini and on the card), the reach floor, with text, posted within 72 hours, the last days\' partitions only; the biggest first; a post it hands over is recorded as Brandwatch mentions; its row says stale after 30 hours without a change', () => {
    const until = Date.UTC(2026, 10, 10, 23, 0);
    const watch = B.pwWatchFrom_(wrow(BRAND, 'ON', 'All'), 3);
    const q = lookSql('us', [watch], until);
    const at = q.sql.indexOf("SELECT 'bwm', ROW_NUMBER()");
    const block = q.sql.slice(at, q.sql.indexOf('EXCEPTION WHEN ERROR THEN', at));
    for (const piece of ['FROM `brand-social-central-data.raw_data.brandwatch_raw_mentions_base`',
      'WHERE report_date >= DATE_SUB(DATE(TIMESTAMP_MILLIS(@until_ms)), INTERVAL 3 DAY)',
      "AND product_config_name IN ('Google Search', 'Google AI', 'Google Cloud', 'Gemini', 'Google Pixel', 'Google Glasses', 'Googlebook') AND language = 'en'",
      "AND LOWER(IFNULL(sentiment, '')) = 'negative' AND LOWER(IFNULL(thread_entry_type, '')) != 'share'",
      "IN ('reddit', 'bluesky', 'facebook', 'instagram')",
      "WHERE c.parent_name = 'V2 [MAIN] EN BSafety Landscape: Exposure & Risk Tags' AND c.name IS NOT NULL) AS xtags",
      'GROUP BY mention_id', 'HAVING MIN(load_timestamp) > TIMESTAMP_MILLIS(@bwm_from) AND ARRAY_LENGTH(ARRAY_CONCAT_AGG(xtags)) > 0',
      "WHERE body != '' AND (IFNULL(followers, 0) >= 1000 OR IFNULL(eng, 0) >= 100)",
      'AND (posted IS NULL OR posted >= TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 72 HOUR))',
      'ORDER BY IFNULL(followers, 0) + 10 * IFNULL(eng, 0) DESC', "'\\nBrandwatch exposure tags: ', cats",
      "TO_JSON_STRING(JSON_OBJECT('p', SPLIT(configs, ', '), 't', cats)) AS tax"]) {
      assert.ok(at > 0 && block.includes(piece), piece);
    }
    assert.ok(!/'skipped'|sentiment != 'positive'/.test(block), 'X mentions without text and the non-negative ones are never read');
    for (const piece of ["SET pw_mod_bwm = (SELECT last_modified_time FROM `brand-social-central-data.raw_data.__TABLES__` WHERE table_id = 'brandwatch_raw_mentions_base');",
      "INSERT INTO pw_src (source, mod_ms) VALUES ('bwm', pw_mod_bwm);", 'IF pw_mod_bwm > @bwm_mod THEN', "INSERT INTO pw_src (source, err) VALUES ('bwm'"]) {
      assert.ok(q.sql.includes(piece), piece);
    }
    assert.ok(!q.sql.includes("SELECT 'bwm', last_modified_time"), 'its table time comes from its own read, not the others\'');
    eq([q.params.find(p => p.name === 'bwm_from'), q.params.find(p => p.name === 'bwm_mod')],
      [{ name: 'bwm_from', type: 'INT64', value: until - 2 * HOUR }, { name: 'bwm_mod', type: 'INT64', value: 0 }]);
    assert.ok(!lookSql('c1', [watch], until).sql.includes('brandwatch_raw_mentions_base'), 'US only');
    // where it starts: the newest mention it handed over, never more than 6 hours back
    eq([B.pwFroms_({ bwm: until - HOUR }, until).bwm, B.pwFroms_({ bwm: until - 9 * HOUR }, until).bwm], [until - HOUR, until - 6 * HOUR]);
    // end to end: its posts recorded with their source, its place and its table's time move, a table unchanged 31 hours is stale
    const { t, bq } = watching();
    t.poll();
    const now = t.g.clock.now;
    const REDDIT = 'https://www.reddit.com/r/google/comments/1xyz/search_is_broken/';
    bq.answers = {
      [US]: { rows: [hit({ source: 'bwm', why: 'negative', post_url: REDDIT, platform: 'reddit', author: 'u/searcher', followers: 0, eng: 140,
        issue: 'Brandwatch · Product - Factual inaccuracies', issue_new: null, summary: 'Search results are full of spam today', impact: 6,
        seen_ms: now - 5 * MIN })]
        .concat(srcs(US_SOURCES, { bwm: { found: 12, checked: 12, newest_ms: now - 5 * MIN, mod_ms: now - 31 * HOUR } })) },
      [C1]: { rows: srcs(C1_SOURCES) },
    };
    t.poll();
    eq(dataRows(t).map(r => [r[5], r[6], r[7], r[8], r[9], r[12]]),
      [[REDDIT, BWM, 'Reddit', 'u/searcher', 0, 'Brandwatch · Product - Factual inaccuracies']]);
    eq(JSON.parse(t.g.props.get('PW_MARKS')), { bwm: now - 5 * MIN, bwm_mod: now - 31 * HOUR, bwm_day: B.pwDay_(now), bwm_n: 12 });
    const row = sources(t).rows.slice(3).find(r => r[0] === BWM);
    eq([row[2], row[6]], ['brand-social-central-data.raw_data.brandwatch_raw_mentions_base', '12 / 12']);
    assert.match(row[3], /^⚠️ stale: its table hasn't changed since /);
    assert.match(row[1], /1,000 a day at most \(X comes from Sonar; YouTube and TikTok from Tubular and Sonar\)$/);
    // the next look (5 minutes after the first) starts after it, and reads the table again only once it changed again
    for (let i = 0; i < 4; i++) t.poll();
    const next = lanes(bq).us[1];
    eq([next.params.bwm_from, next.params.bwm_mod].map(Number), [now - 5 * MIN, now - 31 * HOUR]);
  });

  test('proactive watch: never more than 1,000 of Brandwatch\'s mentions a day go to Gemini: a look gives it what\'s left of today\'s (ET), counted from what each look handed over; a new day starts from 1,000 again; a look that failed counts nothing', () => {
    const until = Date.UTC(2026, 10, 10, 23, 0);
    const today = B.pwDay_(until);
    const watch = B.pwWatchFrom_(wrow(BRAND, 'ON', 'All'), 3);
    const capIn = sql => Number((sql.match(/STRUCT\('bwm' AS source, (\d+) AS cap\)/) || [])[1]);
    eq(B.pwFroms_({}, until).bwm_left, 1000);
    eq(B.pwFroms_({ bwm_day: today, bwm_n: 960 }, until).bwm_left, 40);
    eq(B.pwFroms_({ bwm_day: today, bwm_n: 1200 }, until).bwm_left, 0);
    eq(B.pwFroms_({ bwm_day: '2026-11-09', bwm_n: 1000 }, until).bwm_left, 1000, 'a new day');
    const sqlWith = marks => B.pwSql_('us', [watch], { since: until - 15 * MIN, until, froms: B.pwFroms_(marks, until), tags: B.pwSeedTags_() }).sql;
    eq([capIn(sqlWith({})), capIn(sqlWith({ bwm_day: today, bwm_n: 960 })), capIn(sqlWith({ bwm_day: today, bwm_n: 1000 }))], [1000, 40, 0]);
    assert.ok(/STRUCT\('owned' AS source, 40 AS cap\)/.test(sqlWith({ bwm_day: today, bwm_n: 1000 })), 'the other sources keep their caps');
    // counting: today's handed over add up; a failed look counts nothing; yesterday's count is dropped
    eq(B.pwAdvanceMarks_({ bwm_day: today, bwm_n: 100 }, [src('bwm', { checked: 25, newest_ms: 5 })], until), { bwm: 5, bwm_day: today, bwm_n: 125 });
    eq(B.pwAdvanceMarks_({ bwm_day: today, bwm_n: 100 }, [src('bwm', { checked: 25, err: 'x' })], until), { bwm_day: today, bwm_n: 100 });
    eq(B.pwAdvanceMarks_({ bwm_day: '2026-11-09', bwm_n: 900 }, [src('bwm', { checked: 7, newest_ms: 5 })], until), { bwm: 5, bwm_day: today, bwm_n: 7 });
    eq(B.pwAdvanceMarks_({ bwm_day: '2026-11-09', bwm_n: 900 }, [], until), {});
  });

  test('proactive watch: Sprinklr\'s comments on Google\'s own posts are read in the US look by its window (the rows the table got in the last hour): people\'s comments only (never the brand\'s, nor deleted, spam or hidden ones), on the team\'s networks, not in another script; a pile-on (5+ negative within the hour, crossing in this window) or a negative comment from a 100K+ account; recorded as Sprinklr comments (· big voice when that\'s why); every source reads only the team\'s networks (X, Reddit, Bluesky, Facebook, Instagram, YouTube, TikTok)', () => {
    const until = Date.UTC(2026, 10, 10, 23, 0);
    const watch = B.pwWatchFrom_(wrow(BRAND, 'ON', 'All'), 3);
    const us = lookSql('us', [watch], until);
    const at = us.sql.indexOf("SELECT 'comments', ROW_NUMBER()");
    const block = us.sql.slice(at, us.sql.indexOf('EXCEPTION WHEN ERROR THEN', at));
    for (const piece of ['FROM APPENDS(TABLE `brand-social-central-data.reporting_data.sprinklr_inbound_comments`, ' +
      'TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 60 MINUTE), TIMESTAMP_MILLIS(@until_ms))',
      "IFNULL(is_brand_post, '') != 'Brand' AND LOWER(IFNULL(is_deleted, '')) != 'true'",
      "AND LOWER(IFNULL(is_spam, '')) != 'true' AND LOWER(IFNULL(is_hidden, '')) != 'true'", NETWORKS,
      "COUNT(DISTINCT IF(is_neg AND _CHANGE_TIMESTAMP > TIMESTAMP_MILLIS(@since_ms), comment_id, NULL)) AS neg_win",
      'WHERE (neg >= 5 AND neg - neg_win < 5) OR top_f_win >= 100000;', "IF(neg >= 5 AND neg - neg_win < 5, 'pile-on', 'big voice')"]) {
      assert.ok(at > 0 && block.includes(piece), piece);
    }
    assert.ok(!us.params.some(p => p.name === 'comments_from'), 'it goes by the window, with no place of its own');
    assert.ok(!lookSql('c1', [watch], until).sql.includes('sprinklr_inbound_comments'), 'US only');
    // the team's networks, everywhere: Sonar, Tubular, Sprinklr's report, the Brandwatch query (and Brandwatch's own four)
    const c1 = lookSql('c1', [watch], until).sql;
    for (const [sql, from] of [[c1, "SELECT 'sonar', ROW_NUMBER()"], [c1, "SELECT 'tubular', ROW_NUMBER()"], [us.sql, "SELECT 'owned', ROW_NUMBER()"]]) {
      const i = sql.indexOf(from);  // its block: from its BEGIN to its EXCEPTION
      assert.ok(i > 0 && sql.slice(sql.lastIndexOf('BEGIN', i), sql.indexOf('EXCEPTION WHEN ERROR THEN', i)).includes(NETWORKS), from);
    }
    assert.ok(us.sql.includes(`FROM UNNEST(@bwq) c WHERE IFNULL(c.u, '') != '' AND IFNULL(c.n, '') ${NETWORKS};`), 'the Brandwatch query');
    assert.ok(B.pwNetSql_('platform').includes("WHEN 'facebookpublic' THEN 'facebook' WHEN 'instagrampublic' THEN 'instagram'"));
    // end to end
    const { t, bq } = watching();
    t.poll();
    const now = t.g.clock.now;
    const YT = 'https://www.youtube.com/watch?v=abc123XYZ';
    const IG = 'https://www.instagram.com/p/DQpile0001/';
    bq.answers = {
      [US]: { rows: [hit({ source: 'comments', why: 'pile-on', post_url: IG, platform: 'instagram', author: 'Google', followers: 2400, eng: 9,
        issue: 'Comments on Google\'s post: 9 negative of 30 in an hour', issue_new: null, summary: 'This ad is offensive', seen_ms: now - 4 * MIN }),
      hit({ source: 'comments', why: 'big voice', post_url: YT, platform: 'youtube', author: 'YouTube', followers: 250000, eng: 1,
        issue: 'Comments on Google\'s post: 1 negative of 3 in an hour', issue_new: null, summary: 'You lied to creators', seen_ms: now - 4 * MIN })]
        .concat(srcs(US_SOURCES, { comments: { found: 2, checked: 2, newest_ms: now - 4 * MIN, mod_ms: now - 2 * MIN } })) },
      [C1]: { rows: srcs(C1_SOURCES) },
    };
    t.poll();
    eq(dataRows(t).map(r => [r[5], r[6], r[7]]), [[IG, COMMENTS, 'Instagram'], [YT, `${COMMENTS} · big voice`, 'YouTube']]);
    eq(sources(t).rows.slice(3).find(r => r[0] === COMMENTS).slice(2, 4),
      ['brand-social-central-data.reporting_data.sprinklr_inbound_comments', '✓ live: 2 new at the last look']);
  });

  test('proactive watch: Sprinklr\'s report of Google\'s own posts is read in the US look, in a block of its own, only when the table changed: Google\'s posts (never the other brands\' accounts it tracks) refreshed since the newest it handed over (30 hours back on a first look, never more than 48), posted within 72 hours, not deleted, whose comments turned negative (25+ negative, or 30%+ of 20+), the most negative first, 40 a look; a post it hands over is recorded as Sprinklr owned posts; its row says stale after 36 hours without a change', () => {
    const until = Date.UTC(2026, 10, 10, 23, 0);
    const watch = B.pwWatchFrom_(wrow(BRAND, 'ON', 'Content - Negative reaction to owned social post'), 3);
    const q = lookSql('us', [watch], until);
    const at = q.sql.indexOf("SELECT 'owned', ROW_NUMBER()");
    const block = q.sql.slice(at, q.sql.indexOf('EXCEPTION WHEN ERROR THEN', at));
    for (const piece of ['FROM `brand-social-central-data.reporting_data.sprinklr_outbound_reporting`',
      'WHERE Report_Date >= DATE_SUB(DATE(TIMESTAMP_MILLIS(@until_ms)), INTERVAL 3 DAY) AND Post_Permalink IS NOT NULL',
      'AND NOT IFNULL(Is_Deleted, FALSE) AND NOT IFNULL(Is_External, FALSE)', 'GROUP BY Outbound_Post_ID',
      'WHERE loaded > TIMESTAMP_MILLIS(@owned_from) AND loaded <= TIMESTAMP_MILLIS(@until_ms)',
      'AND posted >= TIMESTAMP_SUB(TIMESTAMP_MILLIS(@until_ms), INTERVAL 72 HOUR)',
      'AND (IFNULL(neg, 0) >= 25 OR (IFNULL(comments, 0) >= 20 AND IFNULL(pct, 0) >= 30));',
      'ORDER BY neg DESC, IFNULL(eng, 0) DESC', 'SAFE_CAST(ROUND(100 * LEAST(MAX(Pct_Negative_Comments), 1)) AS INT64) AS pct',
      "'\\nReaction so far: ', CAST(IFNULL(comments, 0) AS STRING), ' comments, '"]) {
      assert.ok(at > 0 && block.includes(piece), piece);
    }
    for (const piece of ['IF pw_mod_owned > @owned_mod THEN', "INSERT INTO pw_src (source, mod_ms) VALUES ('owned', pw_mod_owned);"]) {
      assert.ok(q.sql.includes(piece), piece);
    }
    eq(q.params.find(p => p.name === 'owned_from'), { name: 'owned_from', type: 'INT64', value: until - 30 * HOUR });
    assert.ok(!lookSql('c1', [watch], until).sql.includes('sprinklr_outbound_reporting'), 'US only');
    eq([B.pwFroms_({ owned: until - 20 * HOUR }, until).owned, B.pwFroms_({ owned: until - 60 * HOUR }, until).owned],
      [until - 20 * HOUR, until - 48 * HOUR]);
    // end to end
    const { t, bq } = watching();
    t.poll();
    const now = t.g.clock.now;
    const IG = 'https://www.instagram.com/p/DQabc123/';
    bq.answers = {
      [US]: { rows: [hit({ source: 'owned', why: 'negative comments', post_url: IG, platform: 'instagram', author: 'Google', followers: 15000000,
        eng: 9200, issue: 'Google\'s own post · Google', issue_new: null, summary: 'Our new holiday ad', impact: 7, seen_ms: now - 6 * HOUR,
        topic: 'P0 · Content - Negative reaction to owned social post' })]
        .concat(srcs(US_SOURCES, { owned: { found: 3, checked: 3, newest_ms: now - 6 * HOUR, mod_ms: now - 37 * HOUR } })) },
      [C1]: { rows: srcs(C1_SOURCES) },
    };
    t.poll();
    eq(dataRows(t).map(r => [r[4], r[5], r[6], r[7], r[8], r[12]]),
      [['P0 · Content - Negative reaction to owned social post', IG, OWNED, 'Instagram', 'Google', 'Google\'s own post · Google']]);
    eq(JSON.parse(t.g.props.get('PW_MARKS')), { owned: now - 6 * HOUR, owned_mod: now - 37 * HOUR });
    const row = sources(t).rows.slice(3).find(r => r[0] === OWNED);
    eq([row[2], row[6]], ['brand-social-central-data.reporting_data.sprinklr_outbound_reporting', '3 / 3']);
    assert.match(row[3], /^⚠️ stale: its table hasn't changed since /);
  });

  test('proactive watch: each source that keeps its own place starts where it stopped (the newest item it handed over), never further back than its limit; a source that failed starts where it was; a table read only when it changed is read again only once it changed again; the places of the sources dropped Nov 10 are forgotten', () => {
    const { t, bq } = watching();
    t.g.props.set('PW_MARKS', JSON.stringify({ bmie: 99, story: 98, chat: 97, outbound: 96, outbound_mod: 95 }));  // left from before
    t.poll();
    const T0 = t.g.clock.now;
    bq.answers = {
      [C1]: { rows: srcs(C1_SOURCES, { tubular: { found: 900, checked: 60, newest_ms: T0 - 3 * HOUR } }) },
      [US]: { rows: srcs(US_SOURCES, { bwm: { found: 40, checked: 40, newest_ms: T0 - 2 * MIN, mod_ms: T0 - 3 * MIN },
        owned: { err: 'Access Denied: Table brand-social-central-data:reporting_data.sprinklr_outbound_reporting', mod_ms: T0 - HOUR } }) },
    };
    t.poll();
    eq(JSON.parse(t.g.props.get('PW_MARKS')), { tubular: T0 - 3 * HOUR, bwm: T0 - 2 * MIN, bwm_mod: T0 - 3 * MIN, bwm_day: B.pwDay_(T0), bwm_n: 40 });
    for (let i = 0; i < 4; i++) t.poll();  // the next look, 5 minutes after the first
    const { c1, us } = lanes(bq);
    eq([c1.length, us.length], [2, 2]);
    const until = Number(c1[1].params.until_ms);
    eq(Number(c1[1].params.tubular_from), T0 - 3 * HOUR);
    eq([us[1].params.bwm_from, us[1].params.bwm_mod, us[1].params.owned_from, us[1].params.owned_mod].map(Number),
      [T0 - 2 * MIN, T0 - 3 * MIN, until - 30 * HOUR, 0]);
    // never further back than a source's limit (Brandwatch's mentions: 6 hours; Tubular: 24 hours); never moved back; a failed source stays put
    eq([B.pwFroms_({ bwm: 1000, tubular: until - 30 * HOUR }, until).bwm, B.pwFroms_({ tubular: until - 30 * HOUR }, until).tubular],
      [until - 6 * HOUR, until - 24 * HOUR]);
    eq(B.pwAdvanceMarks_({ bwm: 5000, bmie: 9, outbound_mod: 7 }, [src('bwm', { newest_ms: 4000 }), src('owned', { newest_ms: 9000, err: 'x' }),
      src('sonar', { newest_ms: 7000 }), src('owned', { mod_ms: 8000, err: 'y' }), src('story', { newest_ms: 9999 })]), { bwm: 5000 });
  });

  test('proactive watch: the sources dropped (Nov 1, as stale: the daily Brandwatch export, the DSD content vectors, Reddit Pulse; Nov 10: BMIE, Sprinklr\'s older export, the DSD story selection feed, the Other alerts space) are read in neither look, with no parameter for them; a Watch sources tab made when the watch read more sources loses its leftover rows at its next write, keeping one row a current source', () => {
    const until = Date.UTC(2026, 9, 14, 12, 0);
    const watch = B.pwWatchFrom_(wrow(BRAND, 'ON', '', '', '', '', 'Q?'), 3);
    ['c1', 'us'].forEach(lane => {
      const q = lookSql(lane, [watch], until);
      assert.ok(!/brandwatch_daily|content_vectors|reddit_pulse|'bwdaily'|'vectors'|'reddit' AS|'bmie'|'story'|'chat'|'outbound'/.test(q.sql), lane);
      assert.ok(!REMOVED_TABLES.test(q.sql), lane);
      eq(q.params.filter(p => /^(bwdaily|vectors|reddit|bmie|story|chat|comments|outbound)(_|$)/.test(p.name)).map(p => p.name), []);
    });
    eq(B.ev('PW_SOURCES_').map(s => s.key), C1_SOURCES.concat(US_SOURCES));
    // a tab from before (rows for 9 sources): the rows below the 6 current ones are cleared, the current ones kept
    const { t } = watching();
    const s = sources(t);
    s.getRange(10, 1, 3, 3).setValues([['Brandwatch (BMIE)', 'old', 'x'], ['DSD story selection', 'old', 'y'], ['Other alerts space', 'old', 'z']]);
    t.poll();
    eq([s.getLastRow(), s.rows.slice(3).map(r => r[0])], [3 + SOURCE_NAMES.length, SOURCE_NAMES]);
  });

  test('proactive watch: the Watch sources tab has a row a source: live, stale (its table hasn\'t changed for longer than it usually goes) or an error at its last look, what was new and checked, and today\'s numbers; C34 sums the sources up (under its 200-character cap) and names a failing one, whichever location reported it; status() lists them', () => {
    const { t, bq } = watching();
    t.poll();
    const now = t.g.clock.now;
    bq.answers = {
      [C1]: { rows: [hit({ seen_ms: now - 2 * MIN })].concat(srcs(C1_SOURCES, { sonar: { found: 27, checked: 27, newest_ms: now - 2 * MIN, mod_ms: now - MIN } })) },
      [US]: { rows: srcs(US_SOURCES, { owned: { mod_ms: now - 2 * 24 * HOUR },
        bwm: { err: 'Access Denied: Table brand-social-central-data:raw_data.brandwatch_raw_mentions_base' } }) },
    };
    t.poll();
    const row = name => sources(t).rows.slice(3).find(r => r[0] === name);
    eq([row('Sonar')[3], row('Sonar')[6], row('Sonar')[7], row('Sonar')[8]], ['✓ live: 27 new at the last look', '27 / 27', 27, 1]);
    eq([row(OWNED)[3], row(OWNED)[4]],
      [`⚠️ stale: its table hasn't changed since ${B.pwTime_(now - 2 * 24 * HOUR)} ET (its rows count again once it has new ones)`,
        B.pwTime_(now - 2 * 24 * HOUR)]);
    eq(row(BWM)[3], '⚠️ error at the last look: Access Denied: Table brand-social-central-data:raw_data.brandwatch_raw_mentions_base ' +
      '(tried again at the next look)');
    eq([row('Tubular')[3], row(BWQ)[3]], ['✓ live: nothing new at the last look', '✓ live: nothing new at the last look']);
    assert.match(note(t), / · sources: 4 live, 1 stale, 1 failing: Brandwatch mentions \(Watch sources tab\)$/);
    const st = t.bot.status().proactive_watch_sources;
    eq(st.length, 6);
    assert.ok(st.some(x => /^Sprinklr owned posts: ⚠️ stale/.test(x)) && st.includes('Sonar: ✓ live: 27 new at the last look'), st.join('\n'));
    eq(B.pwSourcesSummary_({}, now), '');
  });

  test('proactive watch: the same post from two sources (Sonar in us-central1, Brandwatch\'s mentions in US as twitter.com/.../statuses/...) goes on the tab once a watch, from the source collected first; a source that hands a post over late never claims a lead it couldn\'t have had (seen is the look\'s window start at the earliest)', () => {
    const { t, bq } = watching();
    t.poll();
    const job = JSON.parse(t.g.props.get('PW_US_JOB'));
    bq.answers = {
      [C1]: { rows: [hit({ seen_ms: t.g.clock.now - 3 * MIN })] },
      [US]: { rows: [hit({ source: 'bwm', post_url: 'http://twitter.com/newsdesk/statuses/2116390716536770729', seen_ms: t.g.clock.now - 20 * HOUR }),
        hit({ source: 'bwm', post_url: POST2, platform: 'tiktok', seen_ms: t.g.clock.now - 20 * HOUR })] },
    };
    t.poll();
    const rows = dataRows(t);
    eq(rows.map(r => [r[5], r[6]]), [[POST1, 'Sonar'], [POST2, BWM]]);
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
    assert.match(note(t), / · sources: 5 live, 1 failing: Sonar \(Watch sources tab\)$/);
    assert.match(sources(t).rows[3][3], /^⚠️ error at the last look: Access Denied/);
    for (let i = 0; i < 4; i++) t.poll();
    eq(lanes(bq).c1[1].params.since_ms, first.params.since_ms, 'Sonar\'s window is looked at again');
  });

  test('proactive watch: what may not be noticeable at first still gets a look: a Sonar post that grew past the reach floor later, or broke out after it was checked; Brandwatch\'s negative mentions go first; each row says why it was asked about when it isn\'t the usual reason, and the Watch sources tab shows the breakdown, how many were not sent too; a look sent before the sources changed can\'t record a row from a source dropped since', () => {
    const { t, bq } = watching();
    t.poll();
    const now = t.g.clock.now;
    bq.answers = {
      [C1]: { rows: [hit({ why: 'new', seen_ms: now - 2 * MIN }),
        hit({ why: 'grew', post_url: 'https://www.tiktok.com/@smallacct/video/7702553392157130001', platform: 'tiktok', seen_ms: now - 2 * MIN }),
        hit({ why: 'broke out', post_url: 'https://x.com/viral/status/2116390716536770003', impact: 9, seen_ms: now - 2 * MIN })]
        .concat(srcs(C1_SOURCES, { sonar: { found: 24, checked: 24, newest_ms: now - 2 * MIN, detail: 'new 21, grew 2, broke out 1' } })) },
      [US]: { rows: [hit({ source: 'bwm', why: 'negative', post_url: 'https://www.reddit.com/r/apac/comments/5/x/', platform: 'reddit', seen_ms: now - 2 * MIN }),
        hit({ source: 'comments', why: 'big voice', post_url: 'https://www.instagram.com/p/DQbig0002/', platform: 'instagram', seen_ms: now - 2 * MIN }),
        hit({ source: 'bmie', why: 'sample', post_url: 'http://twitter.com/nba/statuses/2116390716536770006', impact: 9, seen_ms: now - 2 * MIN }),
        hit({ source: 'story', post_url: 'https://x.com/ThePrimeagen/status/2116390716536770123', impact: 9, seen_ms: now - 2 * MIN })]
        .concat(srcs(US_SOURCES, { bwm: { found: 41, checked: 41, newest_ms: now - 2 * MIN, detail: 'negative 41' } })) },
    };
    t.poll();
    eq(dataRows(t).map(r => r[6]), ['Sonar', 'Sonar · grew', 'Sonar · broke out', BWM, `${COMMENTS} · big voice`]);
    const row = name => sources(t).rows.slice(3).find(r => r[0] === name);
    eq([row('Sonar')[6], row(BWM)[6]], ['24 / 24 (new 21, grew 2, broke out 1)', '41 / 41 (negative 41)']);
    assert.match(row('Sonar')[1], /grew past the reach floor later, and posts that broke out \(10x the engagements, 1,000\+\)$/);
    assert.match(row(BWM)[1], /^Brandwatch's mentions of Google's products \(Google Search, Google AI, Google Cloud, Gemini, Google Pixel, Google Glasses, Googlebook\) on Reddit, Bluesky, Facebook and Instagram/);
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
        issue: 'Brandwatch · 2026 Election Alerts', issue_new: null, impact: 8, topic: 'Sensitive · Politics', seen_ms: T - 2 * MIN,
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

  test('proactive watch: posts by Grok (X\'s AI account, @grok) are left out from every source: Gemini is never asked about them (Sonar\'s twitter.com/grok links, the Brandwatch query\'s x.com/grok ones, @grok as the author), they aren\'t counted as checked and the Watch sources tab counts them as "Grok left out"; one in a look sent before the change is never recorded, so never a watch alert; people\'s posts that mention or reply to Grok stay in', () => {
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
    const watch = B.pwWatchFrom_(wrow(MIDTERMS, 'ON', '', '', '', '', 'Q?'), 3);
    for (const lane of ['c1', 'us']) {
      const q = lookSql(lane, [watch], until).sql;
      for (const piece of [`IFNULL(n.why, '') != 'skipped' AND NOT ${sql}\n  ) WHERE dup = 1`, `AND NOT ${sql}) AS checked`,
        "'Grok left out', why) AS why"]) assert.ok(q.includes(piece), `${lane}: ${piece}`);
    }
    // a look sent before the change: its Grok rows are never recorded (so never queued as watch alerts); the others are
    const { t, bq } = watching();
    t.poll();
    const now = t.g.clock.now;
    const PERSON = 'https://x.com/ElectionWatcher/status/2117095906554290591';
    bq.answers = {
      [US]: { rows: [hit({ source: 'bwm', post_url: grok[0], author: '@grok', followers: 9300000, seen_ms: now - 2 * MIN }),
        hit({ source: 'bwq', post_url: grok[2], author: '@grok', seen_ms: now - 2 * MIN }),
        hit({ source: 'bwm', post_url: PERSON, author: '@ElectionWatcher', seen_ms: now - 2 * MIN })].concat(srcs(US_SOURCES)) },
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
  // The tags: the Watch tags tab, a watch's tag columns, the question they make, the exposure tags of a flag
  // ===========================================================================================================

  test('proactive watch: a watch picks SLRR exposure tags and Sensitive Topics in its four tag columns: All (every tag ON under that priority), blank, or names (any case, commas, semicolons or lines; a merged tag\'s old name; the *NEW* mark, spaces around a slash and & or "and" aside; without "Product - " and the like, and without its parenthetical, when only one tag fits; a name under the wrong priority still found); a tag switched OFF on the Watch tags tab is never picked; names no single tag has are reported; the question lists the tags by priority with their short versions, then the watch\'s own words', () => {
    const tags = B.pwSeedTags_();
    const label = name => tags.find(t => t.name === name).label;
    const pick = (cells, list) => B.pwPickTags_(cells, list || tags);
    eq(pick([['P0', 'All']]).tags.length, 11);
    eq([pick([['P1', 'all']]).tags.length, pick([['P2', 'ALL']]).tags.length, pick([['Sensitive', 'All']]).tags.length], [17, 18, 12]);
    const got = pick([['P0', 'Dangerous results; perceived bias\n*NEW* Employees - Misconduct allegations'],
      ['P1', 'Product - Litigation, Value and Earnings'], ['P2', 'Content - Negative discussion of owned content'],
      ['Sensitive', 'violence/weapons, Criminal / Dangerous Activity, Privacy & security concerns, Nope']]);
    eq(got.tags.map(t => t.label), [label('Content - Negative reaction to owned social post'), label('Employees - Misconduct allegations'),
      label('Product - Dangerous results (e.g. medical/legal)'), label('Product - Perceived bias'), label('Brand - Litigation'),
      label('Brand - Value & Earnings'), label('Criminal/Dangerous Activity'), label('Violence / Weapons')]);
    eq(got.unknown, ['Privacy & security concerns', 'Nope']);  // two tags have that name (Brand and Product); none has the other
    const off = tags.map(t => (t.name === 'Child Safety' ? Object.assign({}, t, { on: false }) : t));
    eq([pick([['Sensitive', 'Child Safety']], off).tags, pick([['Sensitive', 'All']], off).tags.length], [[], 11]);
    // a watch row (PW_WATCHES_HEADER_): its tags, its own words, the question they make
    const w = B.pwWatchFrom_([' Waymo  safety ', 'on', 'Product - Product failures - physical safety issues; Perceived bias', '', '', 'politics',
      'Only posts about Waymo.', '', '12', 'X, IG, bsky, Mastodon', 'old status'], 5, tags);
    eq([w.row, w.name, w.on, w.bar, w.nets, w.tags.map(t => t.label), w.unknown, w.own, w.rubric, w.problem],
      [5, 'Waymo safety', true, 7, ['twitter', 'instagram', 'bluesky', 'mastodon'],
        ['P0 · Product - Perceived bias', 'P1 · Product - Product failures - physical safety issues', 'Sensitive · Politics'], [],
        'Only posts about Waymo.', B.ev('PW_DEFAULT_RUBRIC_'), '']);
    const short = name => tags.find(t => t.name === name).short;
    eq(w.cond, ['Does this post fall under at least one of the issues below for Google (its products, services, employees, executives or ' +
      'its own content)? Answer yes only when the post itself clearly fits one of them; answer no when Google is only mentioned in ' +
      'passing or nothing below fits.', '', 'P0 exposure tags:', `- Product - Perceived bias: ${short('Product - Perceived bias')}`, '',
    'P1 exposure tags:', `- Product - Product failures - physical safety issues: ${short('Product - Product failures - physical safety issues')}`,
    '', 'Sensitive topics:', `- Politics: ${short('Politics')}`, '', 'Also: Only posts about Waymo.'].join('\n'));
    // with no tags, its own words are the question, as they were; with neither, or only names no tag has, it isn't watched
    eq(B.pwWatchFrom_(wrow('A', 'ON', '', '', '', '', 'Is it about Pixel batteries?'), 2, tags).cond, 'Is it about Pixel batteries?');
    eq([B.pwWatchFrom_(wrow('A', 'ON'), 2, tags).problem, B.pwWatchFrom_(wrow('A', 'ON', 'Nope, Nada'), 2, tags).problem],
      ['it picks no tags and asks no question (columns C-G are empty)', 'no single tag on the Watch tags tab has its tags\' names (Nope, Nada)']);
    eq([B.pwWatchFrom_(wrow('A', 'ON', 'All', '', '', '', '', 'R', '6.5'), 2, tags).bar, B.pwWatchFrom_(wrow('A', 'ON', 'All', '', '', '', '', 'R', ''), 2, tags).bar,
      B.pwWatchFrom_(wrow('A', 'ON', 'All', '', '', '', '', 'R', 0), 2, tags).bar], [6.5, 7, 7]);
    eq([B.pwWatchFrom_(['', 'ON', 'All'], 2, tags), B.pwWatchFrom_(wrow('A', 'OFF', 'All'), 2, tags).on], [null, false]);
    const many = ['a', 'b', 'a', 'c', 'd', 'e', 'f'].map((n, i) => B.pwWatchFrom_(wrow(n, 'ON', 'All'), i + 2, tags));
    eq(B.pwActive_(many).map(x => x.name), ['a', 'b', 'c', 'd', 'e']);
    // the Watch tags tab's rows as the bot reads them: priorities as people write them, blanks filled in, OFF kept
    eq(JSON.parse(JSON.stringify(B.pwTagFrom_([' p 1 ', '*NEW*  Product - Something new', 'A long description. With two sentences.', '',
      'Old name; Older name', 'off']))), { priority: 'P1', name: 'Product - Something new', desc: 'A long description. With two sentences.',
      short: 'A long description.', aka: ['Old name', 'Older name'], on: false, label: 'P1 · Product - Something new' });
    eq([B.pwTagFrom_(['Sensitive Topics', 'X', '', 'Short', '', ''])].map(t => [t.priority, t.desc, t.on]), [['Sensitive', 'Short', true]]);
    eq([B.pwTagFrom_(['P3', 'X']), B.pwTagFrom_(['P0', ''])], [null, null]);
    // what AI.CLASSIFY chooses from: every tag the watches pick, once; a watch that picks none brings every tag ON
    const p0 = B.pwWatchFrom_(wrow('a', 'ON', 'All'), 2, tags);
    const pol = B.pwWatchFrom_(wrow('b', 'ON', '', '', '', 'Politics, Privacy'), 3, tags);
    eq(B.pwClassifyTags_([p0, pol], tags).length, 13);
    eq(B.pwClassifyTags_([pol, B.pwWatchFrom_(wrow('c', 'ON', '', '', '', '', 'Q?'), 4, tags)], tags).length, 58);
    eq(B.pwClassifyTags_([pol], off).map(t => t.name), ['Politics', 'Privacy']);
  });

  test('proactive watch: the Watch tags tab is the watches\' list: a tag people add, rename or switch OFF there counts at the next look (the question and AI.CLASSIFY\'s categories follow it); a watch whose names it doesn\'t have says so in its Status, OFF or ON; a "Watch tags" tab people made is left alone and the watches pick from the team\'s list', () => {
    const { t, bq } = watching();
    const g = tagsTab(t);
    const w = watches(t);
    w.getRange(3, 3, 1, 4).setValues([['', '', '', 'Child Safety; Elections']]);  // the brand-safety watch: one topic now, and a name no tag has
    g.getRange(g.getLastRow() + 1, 1, 1, 6).setValues([['Sensitive topic', 'Elections', 'Posts about elections and voting.', '', '', 'ON']]);
    t.poll();
    let look = lanes(bq).us[0];
    eq(look.params.w1_tags, 'Sensitive · Child Safety|Sensitive · Elections');
    assert.ok(look.params.w1_cond.includes('- Elections: Posts about elections and voting.'), look.params.w1_cond);
    eq(look.arrays.tags.map(x => x.category), ['Sensitive · Child Safety', 'Sensitive · Elections']);
    assert.match(w.cell(3, 11), /^✓ watched \(2 tags\)/);
    // switched OFF there: the watch keeps what's left, and its Status names what it lost
    const row = g.rows.findIndex(r => r[1] === 'Child Safety') + 1;
    g.getRange(row, 6).setValue('OFF');
    for (let i = 0; i < 5; i++) t.poll();
    look = lanes(bq).us[1];
    eq(look.params.w1_tags, 'Sensitive · Elections');
    assert.match(w.cell(3, 11), / · ⚠️ no single tag on the Watch tags tab is named Child Safety$/);
    w.getRange(2, 1, 1, 6).setValues([[MIDTERMS, 'OFF', 'Biass', '', '', '']]);
    t.poll();
    eq(w.cell(2, 11), 'OFF: not watched · ⚠️ no single tag on the Watch tags tab is named Biass');
    // someone else's "Watch tags" tab: never read or written; the team's list instead
    const other = world();
    const theirs = other.t.sheet().insertSheet('Watch tags');
    theirs.getRange(1, 1, 1, 2).setValues([['Tag', 'Owner']]);
    switchOn(other.t);
    other.t.poll();
    watches(other.t).getRange(3, 2).setValue('ON');
    other.t.poll();
    eq([theirs.rows, lanes(other.bq).us[0].arrays.tags.length], [[['Tag', 'Owner']], 58]);
  });

  test('proactive watch: the bot\'s Watches tab from before the exposure tags is converted in place on its first run: each watch keeps its name, On, question, rubric, bar, networks and status (its topics go); the brand-safety watch, named so or asking its first question, is "Google brand safety (all)", picking All the tags in place of that question; On never changes', () => {
    const { t, bq } = world();
    const old = t.sheet().insertSheet('Watches');
    const rubric = B.ev('PW_DEFAULT_RUBRIC_');
    old.getRange(1, 1, 5, 8).setValues([B.ev('PW_WATCHES_OLD_HEADER_'),
      ['Midterms 2026 × Civics', 'OFF', 'Does this post connect Google to the midterms?', 'Midterms rubric', 'Election info', 6, '', 'OFF: not watched'],
      ['Google brand safety', 'OFF', B.ev('PW_OLD_BRAND_Q_'), rubric, 'Scams and fraud', 10, '', 'OFF: not watched'],
      ['Pixel batteries', 'ON', 'Is it about Pixel batteries?', '', 'Batteries', '', 'X', ''],
      ['Asks the old question', 'OFF', B.ev('PW_OLD_BRAND_Q_'), '', '', 8, '', '']]);
    switchOn(t);
    t.poll();
    const w = watches(t);
    assert.strictEqual(w, old, 'the same tab');
    eq(w.rows[0], B.ev('PW_WATCHES_HEADER_'));
    eq(w.rows.slice(1, 5).map(r => r.slice(0, 10)), [
      ['Midterms 2026 × Civics', 'OFF', '', '', '', '', 'Does this post connect Google to the midterms?', 'Midterms rubric', 6, ''],
      [BRAND, 'OFF', 'All', 'All', 'All', 'All', '', rubric, 10, ''],
      ['Pixel batteries', 'ON', '', '', '', '', 'Is it about Pixel batteries?', '', '', 'X'],
      [BRAND, 'OFF', 'All', 'All', 'All', 'All', '', '', 8, '']]);
    eq(w.validations['2,2'].values, ['ON', 'OFF']);
    // the watch that was ON is watched at once, with its own question
    const look = lanes(bq).c1[0];
    eq([look.params.w1_name, look.params.w1_cond, look.params.w1_tags, look.params.w1_nets], ['Pixel batteries', 'Is it about Pixel batteries?', '', 'twitter']);
    assert.match(w.cell(4, 11), /^✓ watched · today: 0 flagged, 0 near misses/);
    t.poll();
    eq(w.rows[0], B.ev('PW_WATCHES_HEADER_'), 'converted once');
  });

  test('proactive watch: once, on its first run after Nov 10, the Watch detections tab loses the rows from the sources the watch stopped reading (BMIE, DSD story selection, the Other alerts space, Sprinklr\'s old export; Sprinklr comments, read again, keeps its rows), the others kept in their order with their ratings and as text, and its Topic column becomes Exposure tags; later runs leave it be', () => {
    const { t } = watching();
    const d = dets(t);
    t.g.props.delete('PW_SCHEMA');  // as on the live tab before this change
    d.getRange(13, 5).setValue('Topic');
    const row = (n, source, rating) => ['\'2026-11-0' + n + ' 09:58', BRAND, 8, 'Yes', 'Privacy and security', `https://x.com/a/status/${n}`, source,
      'X', '@a', 10, 1, '\'2026-11-0' + n + ' 09:00', 'Issue', '', n === 2 ? '=HYPERLINK("x") summary' : 'Summary', '', '', rating || '',
      JSON.stringify({ k: `x.com/a/status/${n}`, w: BRAND, s: n, b: 1 })];
    d.getRange(14, 1, 7, 19).setValues([row(1, 'Sonar', 'Useful'), row(2, 'Brandwatch (BMIE) · negative'), row(3, 'Sprinklr comments'),
      row(4, 'Tubular · grew', 'Noise'), row(5, 'DSD story selection'), row(6, 'Other alerts space'), row(7, `${BWQ}`)]);
    t.poll();
    eq(dataRows(t).map(r => [r[6], r[17]]), [['Sonar', 'Useful'], [COMMENTS, ''], ['Tubular · grew', 'Noise'], [BWQ, '']]);
    eq([d.rows[12][4], t.g.props.get('PW_SCHEMA'), d.getLastRow()], ['Exposure tags', '2', 17]);
    // written back as text: the times and anything that starts like a formula keep their leading apostrophe
    eq(B.pwKeepText_(row(2, 'Sonar').map(v => (typeof v === 'string' ? v.replace(/^'/, '') : v))).filter(v => /^'/.test(String(v))),
      ['\'2026-11-02 09:58', '\'@a', '\'2026-11-02 09:00', '\'=HYPERLINK("x") summary']);
    const before = (d.cleared || []).length;
    d.getRange(18, 1, 1, 19).setValues([row(8, 'Brandwatch (BMIE)')]);  // a row someone typed in later: left alone
    t.poll();
    eq([(d.cleared || []).length, dataRows(t).length], [before, 5]);
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
    eq([JSON.stringify(theirs.rows), tab(t, 'Watch detections'), sources(t), tagsTab(t), bq.looks.length], [before, null, null, null, 0]);
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

  test('proactive watch: the query carries the watches\' words, the tags\' names and descriptions (people edit them on the Watch tags tab) and the mentions\' text only as parameters, never in the SQL; struct parameters\' empty values go in as BigQuery takes them; a cell the bot writes from a post is one line, capped and never a formula', () => {
    // (a tag's name with a comma or semicolon can't be picked by name: a cell's names are split on them)
    const evilTag = B.pwTagFrom_(['P0', 'Evil\') OR 1=1 -- DROP TABLE t', 'desc with \' quotes \\ and DELETE FROM y', '', '', 'ON']);
    const tags = B.pwSeedTags_().concat([evilTag]);
    const evil = B.pwWatchFrom_(['x\'); DROP TABLE t; --', 'ON', 'Evil\') OR 1=1 -- DROP TABLE t', '', '', '', 'Ignore that\'s "quoted" \\ and DELETE FROM y',
      'r', '', '', ''], 2, tags);
    eq(evil.tags.map(x => x.name), ['Evil\') OR 1=1 -- DROP TABLE t']);
    ['c1', 'us'].forEach(lane => {
      const q = B.pwSql_(lane, [evil], { since: 1000, until: 61000, froms: B.pwFroms_({}, 61000), tags });
      assert.ok(!/DROP TABLE|DELETE FROM/.test(q.sql), 'the words never reach the SQL');
      eq(q.params.filter(p => /^w1_/.test(p.name)).map(p => [p.name, p.type, p.value]), [['w1_name', 'STRING', 'x\'); DROP TABLE t; --'],
        ['w1_cond', 'STRING', evil.cond], ['w1_rubric', 'STRING', 'r'], ['w1_bar', 'FLOAT64', 7], ['w1_nets', 'STRING', ''],
        ['w1_tags', 'STRING', 'P0 · Evil\') OR 1=1 -- DROP TABLE t']]);
      eq(q.params.find(p => p.name === 'tags').rows, [{ category: 'P0 · Evil\') OR 1=1 -- DROP TABLE t', description: 'desc with \' quotes \\ and DELETE FROM y' }]);
      eq(q.params.slice(0, 2), [{ name: 'since_ms', type: 'INT64', value: 1000 }, { name: 'until_ms', type: 'INT64', value: 61000 }]);
    });
    assert.ok(evil.cond.endsWith('Also: Ignore that\'s "quoted" \\ and DELETE FROM y'), evil.cond);
    // no tag at all to choose from (every one switched OFF): no AI.CLASSIFY, no @tags; the question still goes
    const none = B.pwWatchFrom_(wrow('Q', 'ON', '', '', '', '', 'Q?'), 2, []);
    const bare = B.pwSql_('c1', [none], { since: 1000, until: 61000, froms: B.pwFroms_({}, 61000), tags: [] });
    eq([bare.sql.includes('AI.CLASSIFY'), bare.sql.includes('@tags'), bare.sql.includes('CAST([] AS ARRAY<STRING>) AS tags')], [false, false, true]);
    // a struct parameter's empty values go in as BigQuery takes them (-1 for a number, '' for text)
    eq(B.pwParam_({ name: 'bwq', struct: [['u', 'STRING'], ['f', 'INT64']], rows: [{ u: 'https://x.com/a/status/1', f: null }] }).parameterValue,
      { arrayValues: [{ structValues: { u: { value: 'https://x.com/a/status/1' }, f: { value: '-1' } } }] });
    // a cell the bot writes from a post is one line, capped, and never a formula
    eq([B.pwCell_('=1+1'), B.pwCell_('+x'), B.pwCell_('@me'), B.pwCell_('-5'), B.pwCell_('a\n b'), B.pwCell_('x'.repeat(600), 500).length],
      ['\'=1+1', '\'+x', '\'@me', '\'-5', 'a b', 500]);
  });

  test('proactive watch: no cell it writes comes near the 49,000-character cap (each text capped, the Watch tags tab\'s too), and a look\'s rows with no post (a source\'s row, or no hit at all) are none', () => {
    const big = 'y'.repeat(60000);
    // a watch's name is capped where it's read (the query hands back that name)
    const name = B.pwWatchFrom_(wrow(big, 'ON', '', '', '', '', 'Q?'), 2, []).name;
    eq(name.length <= 80, true);
    const d = B.pwDetections_([hit({ summary: big, issue: big, author: big, topic: big, watch: name, post_url: `https://x.com/a/status/1${'9'.repeat(10)}`, seen_ms: 1 }),
      { checked: 12, watch: null, post_url: null, impact: null }, src('sonar', { found: 3, checked: 3 })], new Set());
    eq(d.rows.length, 1);
    assert.ok(d.rows[0].every(c => String(c).length <= 500), 'every cell capped');
    eq(B.pwDetections_([{ checked: 3 }], new Set()).rows, []);
    assert.ok(B.pwTagSeedRows_().every(r => r.every(c => String(c).length <= 1500)), 'the Watch tags tab\'s cells too');
    const tg = B.pwTagFrom_(['P0', big, big, big, big, 'ON']);
    eq([tg.name.length <= 120, tg.desc.length <= 1500, tg.short.length <= 300, tg.aka.every(a => a.length <= 60000)], [true, true, true, true]);
    assert.ok(B.pwQuestion_(Array.from({ length: 200 }, () => tg), big).length <= 20000, 'the question too (a parameter, never a cell)');
  });
};
