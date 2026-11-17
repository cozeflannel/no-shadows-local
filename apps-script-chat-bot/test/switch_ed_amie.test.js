// The AMIE table in Early Detection (EarlyWaveSource.gs, Control row 48, the plan's step 1c): its own BigQuery job in
// the same fetchAll as today's two, its SQL (the shared gates once, its own rows for the mark and the authors to leave
// out), its mark taken from the data with a 60-minute overlap, the table's checks (the metadata hourly, a dry run daily
// and after a failure) and what stops or pauses it, the leave-out lists (the big posts Sonar knew, its staff and KOF
// authors, the alert memory), and the approved-tables rule changed on purpose (the owner's approval of 16 November
// 2026). No test runs SQL: the SQL's wording is pinned instead. Every post, author, link and feed name here is made up.
'use strict';

const fs = require('fs');

module.exports = H => {
  const { test, eq, assert, B, NOW, makeGoogle, loadBot } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = new Date(NOW).toISOString().slice(0, 10);
  const TABLE_PATH = '/projects/brand-social-central-data/datasets/social_alerts_dataset/tables/all_sundar_mentions';
  const ADDRESS = 'analyst.two@example.test';
  const COLS = [['kind'], ['lane'], ['mid'], ['url'], ['platform'], ['author'], ['audience', 'INTEGER'], ['eng', 'INTEGER'],
    ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'], ['txt'], ['topic'], ['chash'], ['sig'], ['risk'], ['brand', 'BOOLEAN']];

  /** The AMIE table's metadata as tables.get gives it (made up): every needed column, the optional ones, split by day. */
  const table = () => ({
    lastModifiedTime: String(NOW - 4 * MIN),
    timePartitioning: { type: 'DAY', field: 'ingestionTimestamp' },
    schema: { fields: [['url'], ['alert_source'], ['snippet'], ['authorHandle'], ['SocialNetwork'], ['Sentiment'],
      ['postTime', 'TIMESTAMP'], ['ingestionTimestamp', 'TIMESTAMP'], ['followers', 'INTEGER'], ['KOF'], ['product'], ['engagement']]
      .map(([name, type]) => ({ name, type: type || 'STRING', mode: 'NULLABLE' })) },
  });

  /**
   * A world with BigQuery faked: tables.get of the AMIE table answers w.table (or w.tableFail: {code, message}); a dry
   * run answers w.bytes (or w.dryFail); a job answers w.rows[lane] (an array, or a function of the request body and the
   * check's number) or w.jobFail[lane]. Every BigQuery call is recorded in w.calls ({kind: 'tables.get' | 'dry' | 'job'
   * | 'cancel' | 'other', lane, method, url, body}), every fetchAll as the lanes it sent. Row 48 is ON unless `sw` says.
   */
  function amieEnv(o) {
    const opts = o || {};
    const g = makeGoogle(opts.now || NOW);
    const w = { table: table(), tableFail: null, bytes: 80 * 1000 * 1000, dryFail: null, rows: {}, jobFail: {}, calls: [], fetchAll: [], check: 0 };
    const resp = (code, body) => ({ getResponseCode: () => code, getHeaders: () => ({}), getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    const fail = f => resp(f.code, { error: { code: f.code, message: f.message } });
    const orig = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      const u = String(url);
      if (!u.startsWith('https://bigquery.googleapis.com/')) return orig(url, params);
      const method = String((params && params.method) || 'get').toLowerCase();
      let body = null;
      try { body = params && params.payload ? JSON.parse(params.payload) : null; } catch (e) { body = null; }
      const kind = u.endsWith(TABLE_PATH) && method === 'get' ? 'tables.get' : /\/cancel\?/.test(u) ? 'cancel'
        : /\/queries$/.test(u) && body ? (body.dryRun === true ? 'dry' : 'job') : 'other';
      const lane = (body && body.labels && body.labels.lane) || '';
      w.calls.push({ kind, lane, method, url: u, body });
      if (kind === 'tables.get') return w.tableFail ? fail(w.tableFail) : resp(200, w.table);
      if (kind === 'dry') return w.dryFail ? fail(w.dryFail) : resp(200, { kind: 'bigquery#queryResponse', jobComplete: true, totalBytesProcessed: String(w.bytes) });
      if (kind === 'job') {
        if (w.jobFail[lane]) return fail(w.jobFail[lane]);
        const r = typeof w.rows[lane] === 'function' ? w.rows[lane](body, w.check) : w.rows[lane] || [];
        return resp(200, {
          jobComplete: true, jobReference: { projectId: 'brand-social-central-data', jobId: `job_${w.calls.length}`, location: body.location || 'US' },
          schema: { fields: COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
          rows: r.map(x => ({ f: COLS.map(c => ({ v: x[c[0]] === undefined || x[c[0]] === null ? null : String(x[c[0]]) })) })),
        });
      }
      return resp(200, {});
    };
    const origAll = g.services.UrlFetchApp.fetchAll;
    g.services.UrlFetchApp.fetchAll = reqs => {
      w.fetchAll.push((reqs || []).map(r => { try { return JSON.parse(r.payload).labels.lane; } catch (e) { return ''; } }));
      return origAll(reqs);
    };
    const b = loadBot(g.services, g.clock);
    b.ewsRunSwitches_(opts.sw || { edAmie: true });
    const env = { g, b, w };
    env.run = () => { w.check++; return b.bqEarlyDetectionRows_(30); };
    env.next = (ms) => { g.clock.now += ms === undefined ? 15 * MIN : ms; return env.run(); };
    env.state = () => JSON.parse(g.props.get('EWS_STATE') || '{}');
    env.kinds = () => w.calls.filter(c => c.kind !== 'job' || c.lane).map(c => (c.kind === 'job' ? `job:${c.lane}` : c.kind));
    env.since = n => env.kinds().slice(n);
    env.day = src => ((JSON.parse(g.props.get('EWS_SRC_DAY') || '{}').d || {})[DAY] || {})[src] || {};
    env.items = prefix => {
      const out = [];
      for (const [k, v] of g.cache.entries()) if (k.startsWith(`ews1:${prefix}`)) JSON.parse(v).forEach(x => out.push(x));
      return out;
    };
    env.ids = () => [].concat(...env.items('cl:').map(c => (c.m || []).map(m => m.i))).concat(env.items('pv:').map(p => p.i)).sort();
    env.members = () => [].concat(...env.items('cl:').map(c => c.m || [])).concat(env.items('pv:'));
    env.jobBody = lane => w.calls.filter(c => c.kind === 'job' && c.lane === lane).map(c => c.body);
    env.param = (body, name) => ((body.queryParameters || []).find(p => p.name === name) || {}).parameterValue;
    return env;
  }

  let seq = 0;
  /** An AMIE post row as the job returns it (made up). */
  const ami = o => {
    seq++;
    return Object.assign({
      kind: 'post', lane: 'ami', mid: `AMI|p${seq}`, url: `https://twitter.com/maker${seq}/statuses/22100000000000${String(seq).padStart(5, '0')}`,
      platform: 'X', author: `maker${seq}`, audience: 120, eng: null, posted_ms: NOW - 30 * MIN, seen_ms: NOW - 10 * MIN,
      txt: `Gemini keeps refusing to open my shared drive files after the update number ${seq} and support is no help`,
      topic: 'Gemini', chash: `ah${seq}`, sig: `as${seq}`, risk: '', brand: true,
    }, o || {});
  };
  /** The 'amark' row: new rows taken, of them with no posting time, rows taken in all, the newest ingestion time. */
  const amark = (newest, fresh, npt, all) => ({ kind: 'amark', lane: 'ami', audience: fresh || 0, eng: npt || 0, posted_ms: all || fresh || 0, seen_ms: newest });
  const sonar = o => {
    seq++;
    return Object.assign({
      kind: 'post', lane: 'sonar', mid: `SONAR|s${seq}`, url: `https://x.com/sonaruser${seq}/status/23100000000000${String(seq).padStart(5, '0')}`,
      platform: 'twitter', author: `sonaruser${seq}`, audience: 300, eng: 4, posted_ms: NOW - 20 * MIN, seen_ms: NOW - 18 * MIN,
      txt: `Pixel screen keeps freezing after the update today, number ${seq}, nothing helps`, topic: 'Pixel',
      chash: `sh${seq}`, sig: `ss${seq}`, risk: '', brand: true,
    }, o || {});
  };

  // ---------------------------------------------------------------------------------------------------------------
  // 1. Row 48 OFF: nothing of it (E1); ON: its own job in the same fetchAll (E3)
  // ---------------------------------------------------------------------------------------------------------------

  test('ed amie (E1): with row 48 OFF, six checks never read the AMIE table\'s metadata, never send a dry run or an AMIE job, name the AMIE table nowhere, keep no AMIE mark, and the us-central1 job has no big posts\' part', () => {
    const env = amieEnv({ sw: {} });
    env.run();
    for (let i = 0; i < 5; i++) env.next();
    eq(Array.from(new Set(env.kinds())), ['job:us', 'job:c1']);
    eq(env.w.calls.filter(c => /all_sundar_mentions|social_alerts_dataset/.test(c.url + JSON.stringify(c.body))), []);
    eq(env.w.fetchAll.every(l => JSON.stringify(l) === '["us","c1"]'), true);
    eq(env.jobBody('c1').filter(b2 => /'xbig'/.test(b2.query)), []);
    const st = env.state();
    eq([Object.keys(st.marks).filter(k => /^ami/.test(k)), Object.keys(st.jobs).filter(k => k === 'ami')], [[], []]);
    eq(Array.from(env.g.cache.keys()).filter(k => /^ews1:(xb|ak|nk:|sn:|carry)/.test(k)), []);
    eq(env.g.props.get('EWS_SRC_DAY') || null, null);
    eq(env.b.ewsAmiStatus_().state, 'starting');
  });

  test('ed amie (E3): with row 48 ON the first check reads the table\'s metadata, sends the AMIE job as a dry run, then the AMIE job in the same fetchAll after today\'s two (US, its own 1 GB byte limit); the US job is byte for byte the one with row 48 OFF and the us-central1 job gains only its big posts\' part', () => {
    const off = amieEnv({ sw: {} });
    off.run();
    const on = amieEnv();
    on.run();
    eq(on.kinds(), ['tables.get', 'dry', 'job:us', 'job:c1', 'job:ami']);
    eq(on.w.fetchAll, [['us', 'c1', 'ami']]);
    eq(on.w.calls.filter(c => c.kind === 'job' && c.lane === 'us').map(c => JSON.stringify(c.body)),
      off.w.calls.filter(c => c.kind === 'job' && c.lane === 'us').map(c => JSON.stringify(c.body)));
    const [c1On] = on.jobBody('c1');
    const [c1Off] = off.jobBody('c1');
    eq(c1On.query, `${c1Off.query}\n${B.ewsC1BigSql_().join('\n')}`);
    eq(Object.assign({}, c1On, { query: '' }), Object.assign({}, c1Off, { query: '' }));
    const [job] = on.jobBody('ami');
    eq([job.location, job.maximumBytesBilled, job.useLegacySql, job.parameterMode, job.labels], ['US', '1000000000', false, 'NAMED',
      { purpose: 'early-wave', tool: 'burson-qa-bot', lane: 'ami' }]);
    const [dry] = on.w.calls.filter(c => c.kind === 'dry').map(c => c.body);
    eq([dry.query, JSON.stringify(dry.queryParameters)], [job.query, JSON.stringify(job.queryParameters)]);
    // the next check (15 minutes): no metadata, no dry run; an hour after the first: the metadata again; a new UTC day: a dry run
    const n = on.kinds().length;
    on.next();
    eq(on.since(n), ['job:us', 'job:c1', 'job:ami']);
    const n2 = on.kinds().length;
    on.next(45 * MIN);
    eq(on.since(n2), ['tables.get', 'job:us', 'job:c1', 'job:ami']);
    const n3 = on.kinds().length;
    on.g.clock.now = Date.UTC(2026, 9, 15, 0, 5);
    on.run();
    eq(on.since(n3).slice(0, 2), ['tables.get', 'dry']);
    eq(on.b.ewsAmiStatus_().state, 'ok');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 2. The SQL (pinned by its wording: no test runs SQL)
  // ---------------------------------------------------------------------------------------------------------------

  test('ed amie (Q4, Q6): the AMIE job\'s SQL has each of the plan\'s rules, the shared gates applied once to `lanes` and nothing else feeding the post select, its two extra kinds of rows, and only parameters it names (none holds SQL)', () => {
    const until = NOW - MIN;
    const q = B.ewsAmiQuery_({ marks: { amiq: { opt: ['followers', 'KOF', 'product', 'engagement'] } } }, until);
    const sql = q.sql;
    // the shared gates once, on `lanes`, then the post select, exactly as every other lane's (slow: 'amis')
    const gates = B.ewsGateCtes_('lanes', ['amis']);
    const post = B.ewsPostSelectSql_(['amis']);
    const at = sql.indexOf(gates);
    assert.ok(at > 0 && sql.indexOf(gates, at + 1) < 0, 'the gates once');
    assert.ok(sql.indexOf(`${gates}\n${post}\nUNION ALL\nSELECT 'amark'`) === at, 'the post select right after the gates');
    eq([(sql.match(/cleaned AS \(/g) || []).length, (sql.match(/\bFROM lanes\b/g) || []).length, (sql.match(/\bFROM gated\b/g) || []).length], [1, 1, 1]);
    eq((sql.match(/^lanes AS \(/gm) || []).length, 1);
    // only the AMIE table, read only
    eq(Array.from(new Set(sql.match(/`[^`]+`/g))), ['`brand-social-central-data.social_alerts_dataset.all_sundar_mentions`']);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql));
    // the window and the rows taken: the overlap again, then the oldest new rows after the mark; the partition filter
    assert.match(sql, /WHERE ingestionTimestamp > TIMESTAMP_MILLIS\(@ami_from_ms\)\n    AND ingestionTimestamp <= TIMESTAMP_MILLIS\(@until_ms\) AND url IS NOT NULL/);
    assert.match(sql, /SELECT \* FROM ami_raw WHERE ingestionTimestamp <= TIMESTAMP_MILLIS\(@ami_mark_ms\)\n  UNION ALL\n  SELECT \* FROM \(SELECT \* FROM ami_raw WHERE ingestionTimestamp > TIMESTAMP_MILLIS\(@ami_mark_ms\)\n    ORDER BY ingestionTimestamp, url LIMIT @ami_take\)/);
    // one post a link and author across the feeds; the rules of the plan's Q6
    for (const rule of [
      'GROUP BY url, h',
      "NOT REGEXP_CONTAINS(LOWER(IFNULL(alert_source, '')), r'positive')",
      `NOT REGEXP_CONTAINS(LOWER(TRIM(IFNULL(alert_source, ''))), r'${B.ev('BQ_NON_GOOGLE_SOURCES_RX_')}')`,
      `LOGICAL_OR(REGEXP_CONTAINS(LOWER(TRIM(IFNULL(alert_source, ''))), r'${B.ev('EWS_AMI_GOOGLE_FEEDS_RX_')}')) AS gfeed`,
      "REGEXP_CONTAINS(LOWER(IFNULL(alert_source, '')), r'kof|kol|\\binfs?\\b|exec|googler|reps|posts by google')",
      "REGEXP_CONTAINS(IFNULL(KOF, ''), r'(?i)^(yes|true|1)|\\b(KOFs?|INFs?|KOLs?)\\b')) AS kof",
      "LOGICAL_OR(UPPER(IFNULL(tier, '')) IN ('MODERATE', 'HIGH')) AS big",
      "LOGICAL_AND(LOWER(IFNULL(Sentiment, '')) != 'positive') AS notpos",
      'WHERE NOT kof AND NOT big AND notpos AND posted IS NOT NULL',
      "OR REGEXP_CONTAINS(LOWER(IFNULL(net, '')), r'^forums?$'))",
      "AND NOT (LOWER(IFNULL(net, '')) IN UNNEST(@skip_nets))",
      `AND (gfeed OR REGEXP_CONTAINS(LOWER(IFNULL(raw, '')), r'${B.ev('EWS_ENTITY_RX_')}'))`,
      `AND ${B.ewsEnglishWordsSql_('raw')}`,
      "IF(TIMESTAMP_DIFF(seen, posted, MINUTE) > @late_min, 'amis', 'ami') AS lane",
      "CONCAT('AMI|', SUBSTR(TO_HEX(SHA256(CONCAT(url, '|', h))), 1, 24)) AS mid",
      'CAST(NULL AS INT64) AS eng',
      "SELECT 'amark', 'ami',",
      'UNIX_MILLIS(MAX(ingestionTimestamp))',
      "SELECT DISTINCT 'xkof', 'ami', CAST(NULL AS STRING), url, net, h,",
      "WHERE kof AND h != ''",
    ]) assert.ok(sql.includes(rule), `missing: ${rule}`);
    // the social networks' links (from GEN.platform_domains), never a news site
    const social = new RegExp(B.ewsAmiSocialRx_());
    eq(['https://x.com/a/status/1', 'https://www.reddit.com/r/google/comments/1/', 'https://m.facebook.com/p/1', 'https://news.example.test/a',
      'https://x.com.example.test/a'].map(u => social.test(u)), [true, true, true, false, false]);
    // its parameters: each one the SQL names, and each name in the SQL a parameter; numbers and an empty list, never SQL
    const named = Array.from(new Set(sql.match(/@[a-z_]+/g).map(s => s.slice(1)))).sort();
    eq(q.params.map(p => p.name).sort(), named);
    q.params.forEach(p => assert.ok(p.array ? Array.isArray(p.value) && p.value.length === 0 : /^-?\d+$/.test(String(p.value)), p.name));
    eq(B.ewsParam_(q.params.find(p => p.name === 'skip_nets')), { name: 'skip_nets', parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: [] } });
    eq(Object.fromEntries(q.params.filter(p => !p.array).map(p => [p.name, p.value])), {
      ami_from_ms: until - HOUR, until_ms: until, ami_mark_ms: until - HOUR, ami_take: 300, late_min: 180, max_audience: 5000, eng_ceiling: 500,
      min_chars: 40, min_tokens: 7, min_distinct: 5, rt_max: 300, slow_max: 300 });
    eq([q.maxBytes, q.win, q.flags], ['1000000000', { since: until - HOUR, until }, { mark: 0 }]);
  });

  test('ed amie (E15): an optional column the metadata did not find (or of a type the job can\'t use) is read as an empty value; one it found is read; a staff-feeds setting that could break the SQL is not used (the default is)', () => {
    const all = B.ewsAmiSql_(['followers', 'KOF', 'product', 'engagement']);
    assert.ok(all.includes('followers AS followers, KOF AS KOF, product AS product, engagement AS tier'));
    const none = B.ewsAmiSql_([]);
    assert.ok(none.includes('CAST(NULL AS STRING) AS followers, CAST(NULL AS STRING) AS KOF, CAST(NULL AS STRING) AS product, CAST(NULL AS STRING) AS tier'));
    // the metadata decides: engagement missing, KOF a number (unusable), followers a FLOAT (usable)
    const env = amieEnv();
    env.w.table.schema.fields = env.w.table.schema.fields.filter(f => f.name !== 'engagement');
    env.w.table.schema.fields.find(f => f.name === 'KOF').type = 'INTEGER';
    env.w.table.schema.fields.find(f => f.name === 'followers').type = 'FLOAT';
    env.run();
    eq(env.state().marks.amiq.opt, ['followers', 'product']);
    const [job] = env.jobBody('ami');
    assert.ok(job.query.includes('followers AS followers, CAST(NULL AS STRING) AS KOF, product AS product, CAST(NULL AS STRING) AS tier'));
    // the setting: a quote, a line break or a pattern that doesn't compile keeps the default; a good one is used
    const def = B.ev('EWS_AMI_STAFF_RX_');
    eq(["kof' OR TRUE --", 'a\nb', '(unclosed', 'trailing\\', '', null].map(v => B.ewsAmiRx_(v, def)), [def, def, def, def, def, def]);
    eq(B.ewsAmiRx_('kof|staff feed', def), 'kof|staff feed');
    assert.ok(B.ewsAmiSql_([], 'kof|staff feed').includes("r'kof|staff feed')"));
    assert.ok(B.ewsAmiSql_([], "x') OR TRUE --").includes(`r'${def}')`));
  });

  test('ed amie (Q8 rule 5): the us-central1 job lists the big posts Sonar first saw (too many followers or engagements, or on an influencer list) only while a new row is ON; without it its text is exactly today\'s', () => {
    eq(B.ewsC1Sql_(false), B.ewsC1Sql_());
    const T = NOW - MIN;
    eq(B.ewsLaneQuery_('c1', { marks: {} }, T, false, 30).sql, B.ewsC1Sql_());
    eq(B.ewsLaneQuery_('c1', { marks: {} }, T, false, 30, { xbig: true }).sql, `${B.ewsC1Sql_()}\n${B.ewsC1BigSql_().join('\n')}`);
    eq(B.ewsLaneQuery_('c1', { marks: {} }, T, false, 30, { xbig: true }).params, B.ewsLaneQuery_('c1', { marks: {} }, T, false, 30).params);
    const part = B.ewsC1BigSql_().join('\n');
    for (const rule of ["SELECT 'xbig', 'sonar'", 'JOIN fs ON fs.post_url = s.post_url AND fs.first_at = s.received_at',
      'IFNULL(SAFE_CAST(s.follower_count AS INT64), 0) > @max_audience', '>= @eng_ceiling',
      "JSON_QUERY_ARRAY(s.payload, '$.detail.classification.influencer_list_names')), 0) > 0", "TRIM(IFNULL(s.influencer_list, '')) != ''",
      B.englishLangSql_('s.language')]) assert.ok(part.includes(rule), rule);
    // the lanes: only while a new switch is ON does the us-central1 entry carry it
    eq([B.ewsLanes_({}, {}).some(l => l.xbig), B.ewsLanes_({ edAmie: true }, { marks: { amiq: { pu: 8.64e15 } } }).find(l => l.key === 'c1').xbig], [false, true]);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 3. The window and the mark (E16)
  // ---------------------------------------------------------------------------------------------------------------

  test('ed amie (E16): the first read starts an hour back; the mark is the newest ingestion time taken (the amark row), not the clock, and never goes back; each later read starts 60 minutes before it and never more than 6 hours back; with nothing taken the mark waits', () => {
    const env = amieEnv();
    const marks = [NOW - 7 * MIN, NOW + 5 * MIN, NOW - 30 * MIN, null];
    env.w.rows.ami = (body, check) => (marks[check - 1] === null ? [amark(null, 0, 0, 0)] : [amark(marks[check - 1], 3, 0, 3)]);
    env.run();
    const first = env.jobBody('ami')[0];
    eq([env.param(first, 'ami_from_ms').value, env.param(first, 'ami_mark_ms').value], [String(NOW - MIN - HOUR), String(NOW - MIN - HOUR)]);
    eq(env.state().marks.ami, NOW - 7 * MIN);
    env.next();
    const second = env.jobBody('ami')[1];
    eq([env.param(second, 'ami_from_ms').value, env.param(second, 'ami_mark_ms').value], [String(NOW - 67 * MIN), String(NOW - 7 * MIN)]);
    eq(env.state().marks.ami, NOW + 5 * MIN);
    env.next();
    eq(env.state().marks.ami, NOW + 5 * MIN);  // never back
    env.next();
    eq(env.state().marks.ami, NOW + 5 * MIN);  // nothing taken: it waits for the rows
    // never more than 6 hours back
    const q = B.ewsAmiQuery_({ marks: { ami: NOW - 10 * HOUR } }, NOW);
    eq([q.win.since, q.params.find(p => p.name === 'ami_mark_ms').value], [NOW - 6 * HOUR, NOW - 6 * HOUR]);
    // the settings: the overlap and the rows a read
    const b2 = loadBot(makeGoogle(NOW).services);
    Object.assign(b2.ev('GEN').settings, { amie_overlap_minutes: 30, amie_rows_per_check: 500 });
    const q2 = b2.ewsAmiQuery_({ marks: { ami: NOW - HOUR } }, NOW);
    eq([q2.win.since, q2.params.find(p => p.name === 'ami_take').value], [NOW - 90 * MIN, 500]);
    eq(B.ewsAmiCfg_(), { take: 300, overlapMin: 60, maxGb: 1, maxBytes: 1e9, staleHours: 3, staleMs: 3 * HOUR,
      staffRx: 'kof|kol|\\binfs?\\b|exec|googler|reps|posts by google' });
  });

  test('ed amie (E16): a row landing 45 minutes late is caught by the overlap once, not twice: it is counted "late caught"; the overlap\'s repeats are dropped (by their id while a story or the pool holds them, else as the source\'s own repeat by the post-key index), never counted as the same post as another source', () => {
    const env = amieEnv();
    const a = ami({ mid: 'AMI|early', url: 'https://www.reddit.com/r/google/comments/1early/t/', platform: 'Reddit', author: 'early_one',
      seen_ms: NOW - 10 * MIN, posted_ms: NOW - 20 * MIN, txt: 'Google Maps sent me down a closed road twice today and the report button does nothing at all' });
    // landed 45 minutes after its ingestion time: not there at the first read, there at the second (inside the overlap)
    const late = ami({ mid: 'AMI|late', url: 'https://www.reddit.com/r/google/comments/1late/t/', platform: 'Reddit', author: 'late_one',
      seen_ms: NOW - 25 * MIN, posted_ms: NOW - 40 * MIN, txt: 'Google Photos deleted my whole album after the backup finished and nobody can explain it' });
    env.w.rows.ami = (body, check) => (check === 1 ? [a, amark(NOW - 8 * MIN, 2)] : [a, late, amark(NOW - 8 * MIN, 0, 0, 2)]);
    env.run();
    eq(env.ids().filter(i => /^AMI/.test(i)), ['AMI|early']);
    env.next();
    eq(env.ids().filter(i => /^AMI/.test(i)), ['AMI|early', 'AMI|late']);
    eq([env.day('ami').lc, env.day('ami').used, env.day('ami').same], [1, 2, undefined]);
    env.next();
    eq(env.ids().filter(i => /^AMI/.test(i)), ['AMI|early', 'AMI|late']);
    eq([env.day('ami').lc, env.day('ami').used, env.day('ami').same], [1, 2, undefined]);
    // a repeat no story or pool holds any more: the post-key index knows it, and it was seen before the source's mark,
    // so it is the source's own repeat ('rep'); seen after the mark, it is the same post as another source ('same')
    const p = (mid, seen) => B.ewsPostOf_(ami({ mid, url: 'https://www.reddit.com/r/google/comments/1rep/t/', platform: 'Reddit', author: 'rep_one', chash: 'rp1', seen_ms: seen }));
    const index = {};
    B.ewsStitch_([p('AMI|rep0', NOW - 30 * MIN)], { index, now: NOW - HOUR });
    const again = B.ewsStitch_([p('AMI|rep1', NOW - 30 * MIN)], { index, now: NOW, marks: { ami: NOW - 20 * MIN } });
    const newer = B.ewsStitch_([p('AMI|rep2', NOW - 10 * MIN)], { index, now: NOW, marks: { ami: NOW - 20 * MIN } });
    const noMark = B.ewsStitch_([p('AMI|rep3', NOW - 30 * MIN)], { index, now: NOW });
    eq([again.drops, newer.drops, noMark.drops], [{ ami: { rep: 1 } }, { ami: { same: 1 } }, { ami: { same: 1 } }]);
    // caught in the oldest quarter of the overlap: counted apart too (the overlap may be too short)
    const env2 = amieEnv();
    const edge = ami({ mid: 'AMI|edge', url: 'https://www.reddit.com/r/google/comments/1edge/t/', platform: 'Reddit', author: 'edge_one',
      seen_ms: NOW - 55 * MIN, posted_ms: NOW - 70 * MIN, txt: 'Google Pay charged me twice for one coffee this morning and the refund button is gone' });
    env2.w.rows.ami = (body, check) => (check === 1 ? [amark(NOW - 5 * MIN, 1)] : [edge, amark(NOW - 5 * MIN, 0, 0, 1)]);
    env2.run();
    env2.next();
    eq([env2.day('ami').lc, env2.day('ami').le], [1, 1]);
  });

  test('ed amie (E16): no new row for amie_stale_hours makes the state stale (the newest row taken or the table\'s last change, whichever is later); nothing is skipped: the next read still starts from the mark', () => {
    const env = amieEnv();
    env.w.table.lastModifiedTime = String(NOW - 4 * HOUR);
    env.w.rows.ami = [amark(NOW - 5 * HOUR, 1)];
    env.run();
    const s = env.b.ewsAmiStatus_();
    eq([s.state, s.kind, s.why, s.stale, s.newest, s.mark, s.changed, s.since], ['ok', 'stale', 'the AMIE table has had no new rows', true,
      NOW - 4 * HOUR, NOW - 5 * HOUR, NOW - 4 * HOUR, NOW - 4 * HOUR]);
    env.next();
    const body = env.jobBody('ami')[1];
    eq(env.param(body, 'ami_mark_ms').value, String(NOW - 5 * HOUR));
    // a recent row: not stale
    eq(env.b.ewsAmiStatus_(NOW, { marks: { ami: NOW - 2 * HOUR, amiq: { rd: NOW, chg: NOW - 5 * HOUR } } }).stale, false);
  });

  test('ed amie (E11): a row with no posting time never becomes a post (the SQL leaves it out, before and in the gates) and is counted; the rows read are counted too', () => {
    const sql = B.ewsAmiSql_([]);
    assert.ok(sql.includes('WHERE NOT kof AND NOT big AND notpos AND posted IS NOT NULL'));
    assert.ok(sql.includes('WHERE mid IS NOT NULL AND url IS NOT NULL AND posted IS NOT NULL'));
    assert.ok(sql.includes('COUNTIF(ingestionTimestamp > TIMESTAMP_MILLIS(@ami_mark_ms) AND postTime IS NULL)'));
    assert.ok(!/COALESCE\(postTime/.test(sql), 'no posting time made up');
    const env = amieEnv();
    env.w.rows.ami = [amark(NOW - 5 * MIN, 240, 17, 300)];
    env.run();
    eq([env.day('ami').rows, env.day('ami').npt], [240, 17]);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 4. What stops or pauses it (E15): today's lanes go on
  // ---------------------------------------------------------------------------------------------------------------

  test('ed amie (E15): a needed column missing, or of another type, stops the AMIE table for the UTC day with a plain reason; today\'s lanes are read and their marks move; the next checks that day ask nothing about it; the next day it is checked again', () => {
    const env = amieEnv();
    env.w.table.schema.fields = env.w.table.schema.fields.filter(f => f.name !== 'snippet');
    env.run();
    eq(env.kinds(), ['tables.get', 'job:us', 'job:c1']);
    const st = env.state();
    eq([st.marks.spk, st.marks.sonar], [NOW - MIN, NOW - MIN]);
    let s = env.b.ewsAmiStatus_();
    eq([s.state, s.kind, s.why, s.since, s.until], ['stopped', 'column', 'the AMIE table has no column "snippet" any more, so it isn\'t read',
      NOW, Date.UTC(2026, 9, 15)]);
    const n = env.kinds().length;
    env.next();
    env.next(3 * HOUR);
    eq(env.since(n), ['job:us', 'job:c1', 'job:us', 'job:c1']);
    // the next UTC day: checked again (still missing: stopped again, since when kept)
    env.g.clock.now = Date.UTC(2026, 9, 15, 0, 10);
    env.run();
    s = env.b.ewsAmiStatus_();
    eq([s.state, s.since], ['stopped', NOW]);
    // fixed: read again, the problem gone
    env.w.table = Object.assign(table(), { lastModifiedTime: String(Date.UTC(2026, 9, 16, 0, 5)) });
    env.g.clock.now = Date.UTC(2026, 9, 16, 0, 10);
    env.run();
    eq([env.b.ewsAmiStatus_().state, env.b.ewsAmiStatus_().kind], ['ok', '']);
    // postTime as text: the same, in its own words
    const env2 = amieEnv();
    env2.w.table.schema.fields.find(f => f.name === 'postTime').type = 'STRING';
    env2.run();
    eq(env2.b.ewsAmiStatus_().why, 'the AMIE table\'s column "postTime" no longer holds a time, so it isn\'t read');
    // no longer split by day on ingestionTimestamp
    const env3 = amieEnv();
    env3.w.table.timePartitioning = { type: 'DAY' };
    env3.run();
    eq([env3.b.ewsAmiStatus_().kind, env3.kinds()], ['partition', ['tables.get', 'job:us', 'job:c1']]);
  });

  test('ed amie (E15): access denied (with an address in BigQuery\'s words) is said in plain words and stops it for the day; the address is kept, logged or written nowhere', () => {
    const env = amieEnv();
    env.w.tableFail = { code: 403, message: `Access Denied: Table brand-social-central-data:social_alerts_dataset.all_sundar_mentions: User ${ADDRESS} does not have permission` };
    env.run();
    const s = env.b.ewsAmiStatus_();
    eq([s.state, s.kind, s.why], ['stopped', 'access', 'BigQuery won\'t let the bot read the AMIE table (access denied), so it isn\'t read']);
    eq(env.kinds(), ['tables.get', 'job:us', 'job:c1']);
    const all = [JSON.stringify(Array.from(env.g.props.entries())), JSON.stringify(Array.from(env.g.cache.entries())), env.g.logs.join('\n')].join('\n');
    assert.ok(!all.includes(ADDRESS) && !all.includes('@example'), all.slice(0, 400));
    // the dry run refused the same way: the same
    const env2 = amieEnv();
    env2.w.dryFail = { code: 403, message: `Access Denied: ${ADDRESS}` };
    env2.run();
    eq([env2.b.ewsAmiStatus_().kind, env2.kinds()], ['access', ['tables.get', 'dry', 'job:us', 'job:c1']]);
    // the table gone
    const env3 = amieEnv();
    env3.w.tableFail = { code: 404, message: 'Not found: Table brand-social-central-data:social_alerts_dataset.all_sundar_mentions' };
    env3.run();
    eq(env3.b.ewsAmiStatus_().why, 'BigQuery can\'t find the AMIE table, so it isn\'t read');
    // the scrub itself
    eq(B.ewsScrub_(`denied for ${ADDRESS}, also someone%40example.test and a cut one: person@exam…`), 'denied for [address], also [address] and a cut one: [address]');
  });

  test('ed amie (E15): a dry run over amie_max_gb stops it for the day ("would scan 3.2 GB"); the AMIE job is never sent; under it, the job goes with that byte limit', () => {
    const env = amieEnv();
    env.w.bytes = 3.2e9;
    env.run();
    const s = env.b.ewsAmiStatus_();
    eq([s.state, s.kind, s.why], ['stopped', 'cost', 'one read of the AMIE table would scan 3.2 GB (the limit is 1 GB)']);
    eq(env.kinds(), ['tables.get', 'dry', 'job:us', 'job:c1']);
    env.next();
    eq(env.jobBody('ami'), []);
    // a bigger limit in the settings: read, with that limit
    const env2 = amieEnv();
    env2.w.bytes = 3.2e9;
    Object.assign(env2.b.ev('GEN').settings, { amie_max_gb: 5 });
    env2.run();
    eq([env2.jobBody('ami').length, env2.jobBody('ami')[0].maximumBytesBilled, env2.b.ewsAmiStatus_().gb], [1, '5000000000', 3.2]);
  });

  test('ed amie (E15): a failed AMIE job pauses it an hour (today\'s lanes go on, its mark stays), then a dry run must pass before its next job; a read collected clears the problem', () => {
    const env = amieEnv();
    env.w.rows.ami = [amark(NOW - 5 * MIN, 1)];
    env.run();
    eq(env.state().marks.ami, NOW - 5 * MIN);
    env.w.jobFail.ami = { code: 400, message: `Query exceeded limit for bytes billed: 1000000000. 2000000000 or higher required. ${ADDRESS}` };
    const n = env.kinds().length;
    const t1 = env.g.clock.now + 15 * MIN;
    env.next();
    eq(env.since(n), ['job:us', 'job:c1', 'job:ami']);
    let s = env.b.ewsAmiStatus_();
    eq([s.state, s.kind, s.since, s.until], ['paused', 'failed', t1, t1 + HOUR]);
    eq(s.why, 'BigQuery refused the AMIE read (Query exceeded limit for bytes billed: 1000000000. 20000000…)');  // 60 characters of BigQuery's words
    assert.ok(!s.why.includes(ADDRESS) && s.why.length <= 200, s.why);
    eq([env.state().marks.ami, env.state().marks.spk], [NOW - 5 * MIN, t1 - MIN]);
    assert.ok(!env.g.logs.join('\n').includes(ADDRESS));
    // paused: nothing asked about it for the hour
    const n2 = env.kinds().length;
    env.next();
    env.next(30 * MIN);
    eq(env.since(n2), ['job:us', 'job:c1', 'job:us', 'job:c1']);
    // after the hour: a dry run first (the metadata too: an hour has passed), then the job
    delete env.w.jobFail.ami;
    const n3 = env.kinds().length;
    env.next(16 * MIN);
    eq(env.since(n3), ['tables.get', 'dry', 'job:us', 'job:c1', 'job:ami']);
    s = env.b.ewsAmiStatus_();
    eq([s.state, s.kind, s.why], ['ok', '', '']);
    // a failed dry run (not access, not cost) pauses it too
    const env2 = amieEnv();
    env2.w.dryFail = { code: 500, message: 'Backend error' };
    env2.run();
    eq([env2.b.ewsAmiStatus_().state, env2.b.ewsAmiStatus_().why, env2.kinds()],
      ['paused', 'BigQuery refused the AMIE read (Backend error)', ['tables.get', 'dry', 'job:us', 'job:c1']]);
  });

  test('ed amie: the state for the note (ewsAmiStatus_) has its whole shape, a stop or pause before stale (one warning), and reads EWS_STATE when not given; it never throws', () => {
    const keys = ['state', 'kind', 'why', 'since', 'until', 'read', 'mark', 'changed', 'newest', 'stale', 'gb'];
    eq(Object.keys(B.ewsAmiStatus_(NOW, { marks: {} })).sort(), keys.slice().sort());
    eq(B.ewsAmiStatus_(NOW, { marks: {} }), { state: 'starting', kind: '', why: '', since: 0, until: 0, read: 0, mark: null, changed: null,
      newest: null, stale: false, gb: null });
    const stale = { ami: NOW - 10 * HOUR, amiq: { rd: NOW - HOUR, chg: NOW - 9 * HOUR, gb: 0.08, pu: NOW + HOUR, prob: { k: 'failed', w: 'BigQuery refused the AMIE read (x)', at: NOW - MIN } } };
    const s = B.ewsAmiStatus_(NOW, { marks: stale });
    eq([s.state, s.kind, s.stale, s.gb, s.read], ['paused', 'failed', true, 0.08, NOW - HOUR]);
    eq(B.ewsAmiStatus_(NOW, { marks: { amiq: 'nonsense' } }).state, 'starting');
    const g = makeGoogle(NOW);
    const b2 = loadBot(g.services, g.clock);
    g.props.set('EWS_STATE', '{broken');
    eq(b2.ewsAmiStatus_().state, 'starting');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 5. The leave-out lists and one post (E12, E7)
  // ---------------------------------------------------------------------------------------------------------------

  test('ed amie (E12): the staff and KOF feeds\' authors come back as xkof rows and are kept 7 days: their new-lane posts stay out (this check and later ones), while a Sonar post by the same author is untouched', () => {
    const env = amieEnv();
    const exec = 'https://x.com/exec_person/status/2240000000000000001';
    const other = ami({ mid: 'AMI|execpost', url: 'https://x.com/exec_person/status/2240000000000000002', author: 'exec_person',
      txt: 'Gemini is getting a big update next week and I cannot wait for everyone to try the new features' });
    const fine = ami({ mid: 'AMI|fine', url: 'https://www.reddit.com/r/google/comments/1fine/t/', platform: 'Reddit', author: 'fine_person',
      txt: 'Google Drive keeps failing to sync my folders since the last update and nothing seems to fix it' });
    const sonarCopy = sonar({ mid: 'SONAR|exec', url: 'https://x.com/exec_person/status/2240000000000000003', author: 'exec_person',
      txt: 'Pixel event recap: what we showed today and why the new camera tools matter for everyone' });
    env.w.rows.ami = (body, check) => (check === 1 ? [other, fine, { kind: 'xkof', lane: 'ami', url: exec, platform: 'X', author: 'exec_person' }, amark(NOW - 5 * MIN, 3)]
      : [ami({ mid: 'AMI|execlater', url: 'https://x.com/exec_person/status/2240000000000000004', author: 'exec_person',
        txt: 'Another Gemini post from the same person about the update and the features coming soon' }), amark(NOW + 10 * MIN, 1)]);
    env.w.rows.c1 = (body, check) => (check === 1 ? [sonarCopy] : []);
    env.run();
    eq(env.ids(), ['AMI|fine', 'SONAR|exec']);
    eq(env.day('ami').ex, 1);
    eq(JSON.parse(env.g.cache.get('ews1:ak')).map(e => e[0]), ['exec_person']);
    env.next();
    eq(env.ids(), ['AMI|fine', 'SONAR|exec']);
    eq(env.day('ami').ex, 2);
    // the SQL side: such a row is never a post (NOT kof), only an xkof row
    const sql = B.ewsAmiSql_([]);
    assert.ok(sql.includes('WHERE NOT kof AND NOT big') && sql.includes("SELECT DISTINCT 'xkof'"));
  });

  test('ed amie (E7, Q8 rule 5): a big post Sonar first saw (the us-central1 job\'s xbig row) is kept 24 hours by its post key, and the AMIE table\'s copy of it is left out; the list fits one cache item', () => {
    const env = amieEnv();
    const tiktok = 'https://www.tiktok.com/@bigmaker/video/7301234567890123456';
    env.w.rows.c1 = (body, check) => (check === 1 ? [{ kind: 'xbig', lane: 'sonar', url: tiktok, seen_ms: NOW - 5 * MIN }] : []);
    env.w.rows.ami = (body, check) => (check === 2 ? [ami({ mid: 'AMI|tt', url: tiktok, platform: 'TikTok', author: 'bigmaker', audience: null,
      txt: 'Google search results are full of spam again this week and the reports button does nothing' }), amark(NOW + 10 * MIN, 1)] : [amark(NOW - 5 * MIN, 0)]);
    env.run();
    const xb = JSON.parse(env.g.cache.get('ews1:xb'));
    eq(xb, [[B.ewsKeyHash_(B.amPostKey_(tiktok)), NOW]]);
    env.next();
    eq([env.ids(), env.day('ami').big], [[], 1]);
    // many big posts: the newest that one cache item holds
    const g = makeGoogle(NOW);
    const b2 = loadBot(g.services, g.clock);
    const leave = { big: new Set(), authors: new Set() };
    const rows = Array.from({ length: 4000 }, (_, i) => ({ kind: 'xbig', url: `https://x.com/u${i}/status/22500000000${String(i).padStart(8, '0')}` }));
    b2.ewsNewLeaveAdd_(b2.ewsCache_(), NOW, leave, rows);
    const kept = JSON.parse(g.cache.get('ews1:xb'));
    assert.ok(kept.length > 2000 && kept.length < 4000 && g.cache.get('ews1:xb').length <= 95000, String(kept.length));
    eq(leave.big.size, 4000);
  });

  test('ed amie (E7): the same X post from Sonar (x.com/newsdesk/status/N) and from the AMIE table (twitter.com/newsdesk/statuses/N) in one check is one post, Sonar\'s; five AMIE X posts linked as x.com/i/status/N by five handles are five accounts (never X:i); a post a Watch alert claimed an hour ago is left out', () => {
    const env = amieEnv();
    const story = 'Gemini told me my flight was cancelled when it was not and I nearly missed it at the airport';
    const claimed = 'https://www.reddit.com/r/google/comments/1claimed/t/';
    env.b.__claimed = claimed;
    env.b.ev('AM_RUN_ = { seenPost: url => (url === __claimed ? { why: "claimed", at: Date.now() - 3600000 } : null) }');
    env.w.rows.c1 = [sonar({ mid: 'SONAR|nd', url: 'https://x.com/newsdesk/status/2116390716536770729', author: 'newsdesk', chash: 'nd1', txt: story })];
    env.w.rows.ami = [
      ami({ mid: 'AMI|nd', url: 'https://twitter.com/newsdesk/statuses/2116390716536770729', author: 'newsdesk', chash: 'nd2', txt: story }),
      ...[1, 2, 3, 4, 5].map(i => ami({ mid: `AMI|i${i}`, url: `https://x.com/i/status/226000000000000000${i}`, author: `handle${i}`, chash: `i${i}`,
        txt: `${story} (${['again', 'today', 'twice', 'still', 'really'][i - 1]} number ${i})` })),
      ami({ mid: 'AMI|claimed', url: claimed, platform: 'Reddit', author: 'someone', txt: 'Google Maps sent me the wrong way again today and I was late for work' }),
      amark(NOW - 5 * MIN, 7),
    ];
    env.run();
    eq(env.ids().filter(i => /\|nd$/.test(i)), ['SONAR|nd']);
    const accounts = env.members().filter(m => /^AMI\|i/.test(m.i)).map(m => m.a).sort();
    eq(accounts, ['X:handle1', 'X:handle2', 'X:handle3', 'X:handle4', 'X:handle5']);
    eq([env.day('ami').same, env.day('ami').al, env.ids().includes('AMI|claimed')], [1, 1, false]);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 6. Turning row 48 OFF, and the approved tables (E28)
  // ---------------------------------------------------------------------------------------------------------------

  test('ed amie: turning row 48 OFF forgets its mark and its checks (a stop or a pause too), so ON again checks the table afresh and reads from the last hour; its job left running is cancelled', () => {
    const env = amieEnv();
    env.w.rows.ami = [amark(NOW - 5 * MIN, 1)];
    env.run();
    eq(Object.keys(env.state().marks).filter(k => /^ami/.test(k)).sort(), ['ami', 'amiq']);
    env.b.ewsAmieOff_({});
    const st = env.state();
    eq(Object.keys(st.marks).filter(k => /^ami/.test(k)), []);
    eq([st.marks.spk > 0, st.marks.sonar > 0], [true, true]);
    env.b.ewsRunSwitches_({ edAmie: true });
    const n = env.kinds().length;
    env.next();
    eq(env.since(n), ['tables.get', 'dry', 'job:us', 'job:c1', 'job:ami']);
    const body = env.jobBody('ami')[1];
    eq(env.param(body, 'ami_from_ms').value, String(env.g.clock.now - MIN - HOUR));
    // a job of its own still running when the row goes OFF: cancelled
    const env2 = amieEnv();
    env2.run();
    const st2 = env2.state();
    st2.jobs.ami = { id: 'job_left', location: 'US', at: NOW, project: 'brand-social-central-data' };
    env2.g.props.set('EWS_STATE', JSON.stringify(st2));
    env2.b.ewsAmieOff_({});
    eq(env2.w.calls.filter(c => c.kind === 'cancel').map(c => /job_left/.test(c.url)), [true]);
    eq('ami' in env2.state().jobs, false);
  });

  test('ed amie (E28): the approved-tables test passes with the AMIE table named (Early Detection\'s job and the live check), and a .gs naming a table outside the list still fails it', () => {
    let approvedTest = null;
    const fakeH = new Proxy({}, { get: (t, k) => (k === 'test' ? (name, fn) => { if (/approved-tables invariant/.test(name)) approvedTest = fn; } : k === 'eq' ? eq : k === 'assert' ? assert : undefined) });
    require('./switch_alert_memory.test.js')(fakeH);
    assert.ok(approvedTest, 'the approved-tables test is there');
    approvedTest();  // as the repository is: passes
    const dir = require('path').join(__dirname, '..');
    const readdir = fs.readdirSync;
    const read = fs.readFileSync;
    const extra = {
      'ZzOtherTable.gs': "const ZZ_T_ = 'brand-social-central-data.social_alerts_dataset.brandwatch_mentions';\n",
      'ZzAmieCopy.gs': "const ZZ_C_ = 'brand-social-central-data.social_alerts_dataset.all_sundar_mentions_copy';\n",
      'ZzRetired.gs': "const ZZ_R_ = 'early_detection.vw_chatbot_pending_early_alerts';\n",
    };
    for (const name of Object.keys(extra)) {
      fs.readdirSync = (d, ...rest) => { const out = readdir.call(fs, d, ...rest); return String(d) === dir ? out.concat([name]) : out; };
      fs.readFileSync = (p, ...rest) => (String(p) === require('path').join(dir, name) ? extra[name] : read.call(fs, p, ...rest));
      let failed = false;
      try { approvedTest(); } catch (e) { failed = true; } finally { fs.readdirSync = readdir; fs.readFileSync = read; }
      eq([name, failed], [name, true]);
    }
    // the Watch still never reads it (its own tests stay as they are until stage 3)
    const src = read.call(fs, require('path').join(dir, 'ProactiveWatch.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/all_sundar_mentions/.test(src));
  });
};
