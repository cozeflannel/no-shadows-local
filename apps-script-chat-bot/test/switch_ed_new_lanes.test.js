// Early Detection's new lanes (EarlyWaveSource.gs): the rules a new source's posts follow inside the check (the slow
// split, velocity and covered hours, the pool share, the embedding split and day bar, the carry, the split same-author
// signatures, stitching one post / one person, the promotion limits and the trial), proven with a fake lane before any
// real new source exists. With no new switch ON, every request and stored value is what it was at commit 3be2e06.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, makeGoogle, loadBot } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const BASE = require('./ed_new_lanes_base_requests.json');

  const EWS_COLS = [
    ['kind'], ['lane'], ['mid'], ['url'], ['platform'], ['author'],
    ['audience', 'INTEGER'], ['eng', 'INTEGER'], ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'],
    ['txt'], ['topic'], ['chash'], ['sig'], ['risk'], ['brand', 'BOOLEAN'],
  ];

  // A world with BigQuery faked: `answer(job, body)` gives the rows of a job ('us', 'c1' or a fake lane's key, read from
  // the job's label). Every request body is recorded.
  function makeEnv(answer, opts) {
    const g = makeGoogle((opts && opts.now) || NOW);
    const bq = [];
    const origFetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (!String(url).startsWith('https://bigquery.googleapis.com/')) return origFetch(url, params);
      const body = JSON.parse((params && params.payload) || '{}');
      const job = (body.labels && body.labels.lane) || '';
      bq.push({ url, job, location: body.location, payload: params && params.payload, method: (params && params.method) || 'get' });
      const rows = (answer && answer(job, body)) || [];
      return {
        getResponseCode: () => 200,
        getHeaders: () => ({}),
        getContentText: () => JSON.stringify({
          jobComplete: true,
          jobReference: { projectId: 'brand-social-central-data', jobId: `ews_${bq.length}`, location: body.location || 'US' },
          schema: { fields: EWS_COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
          rows: rows.map(r => ({ f: EWS_COLS.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })),
        }),
      };
    };
    const b = loadBot(g.services, g.clock);
    return { g, b, bq };
  }

  // The fake lane: one more job in the US location, read while switch `edFake` is ON (or `sw`), whose rows the test
  // gives under any new lane's name.
  function addFakeLane(b, o) {
    const def = Object.assign({ key: 'fk', location: 'US', sw: 'edFake',
      query: (st, until) => ({ sql: '-- ews:fk (a fake new lane)\nSELECT 1', params: [{ name: 'until_ms', type: 'INT64', value: until }],
        win: { since: until - 15 * MIN, until }, flags: {} }) }, o || {});
    b.ev('EWS_NEW_LANE_DEFS_').push(def);
    return def;
  }

  let seq = 0;
  // A post row (16 columns). `lane` decides real time / slow / new.
  const row = (o) => {
    seq++;
    return Object.assign({
      kind: 'post', lane: 'sonar', mid: `SONAR|m${seq}`, url: `https://x.com/user${seq}/status/21500000000000${String(seq).padStart(5, '0')}`,
      platform: 'twitter', author: `user${seq}`, audience: 300, eng: 4, posted_ms: NOW - 20 * MIN, seen_ms: NOW - 18 * MIN,
      txt: `Pixel phone screen keeps freezing after the update number ${seq} again today`, topic: 'Pixel',
      chash: `h${seq}`, sig: `s${seq}`, risk: '', brand: true,
    }, o || {});
  };

  const snapshotOf = env => {
    const props = {};
    for (const [k, v] of env.g.props.entries ? env.g.props.entries() : Object.entries(env.g.props)) props[k] = v;
    const cache = {};
    for (const [k, v] of env.g.cache.entries()) cache[k] = v;
    return { props, cache };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // 1. Lane lists, the slow split, the nl mark, today's requests unchanged
  // ---------------------------------------------------------------------------------------------------------------

  test('new lanes: with no new switch ON the US and us-central1 request bodies of two checks are byte for byte the ones recorded at commit 3be2e06 (E1), with or without a fake lane registered', () => {
    for (const variant of ['plain', 'fake lane, switch never set', 'fake lane, switches all OFF']) {
      const env = makeEnv(() => []);
      if (variant !== 'plain') addFakeLane(env.b);
      if (variant === 'fake lane, switches all OFF' && typeof env.b.ewsRunSwitches_ === 'function') env.b.ewsRunSwitches_({ edFake: false, edAmie: false, edBwLive: false });
      env.b.bqEarlyDetectionRows_(30);
      env.g.clock.now += 15 * MIN;
      env.b.bqEarlyDetectionRows_(30);
      const got = env.bq.filter(c => c.method === 'post' && /\/queries$/.test(c.url)).map(c => c.payload);
      eq([variant, got.length], [variant, BASE.bodies.length]);
      got.forEach((p, i) => assert.strictEqual(p, BASE.bodies[i].payload, `${variant}: request ${i + 1} (${BASE.bodies[i].location}) changed`));
    }
  });

  test('new lanes: the slow-lane list in the gate SQL is today\'s text without the argument, and a new source\'s job adds only its own slow lane names (amis / bwls) in the three places', () => {
    const plain = B.ewsGateCtes_('lanes') + '\n' + B.ewsPostSelectSql_();
    eq((plain.match(/IN \('bw', 'tub'\)/g) || []).length, 3);
    eq(B.ewsGateCtes_('lanes', []), B.ewsGateCtes_('lanes'));
    eq(B.ewsPostSelectSql_([]), B.ewsPostSelectSql_());
    const ami = B.ewsGateCtes_('lanes', ['amis']) + '\n' + B.ewsPostSelectSql_(['amis']);
    eq([(ami.match(/IN \('bw', 'tub', 'amis'\)/g) || []).length, /IN \('bw', 'tub'\)/.test(ami)], [3, false]);
    eq(B.ewsSlowSqlList_(['bwls', "x'); DROP", 'bw']), "'bw', 'tub', 'bwls', 'xdrop'");
    eq([B.ev('EWS_SLOW_LANES_'), B.ev('EWS_NEW_LANES_')], [['bw', 'tub', 'amis', 'bwls'], ['ami', 'amis', 'bwl', 'bwls']]);
  });

  test('new lanes: a post of a new lane is marked nl (real time for ami / bwl, slow for amis / bwls), and only its member and pool records carry nl: a post of today\'s lanes is as before', () => {
    const base = { kind: 'post', mid: 'X|1', url: 'https://www.reddit.com/r/google/comments/1abcde/t/', platform: 'reddit', author: 'alice',
      posted_ms: NOW, seen_ms: NOW, txt: 'some words', topic: 'Pixel', chash: 'c', sig: 's', risk: '', brand: true };
    const of = lane => B.ewsPostOf_(Object.assign({}, base, { lane }));
    eq(['sonar', 'spk', 'bw', 'tub', 'ami', 'amis', 'bwl', 'bwls'].map(l => [l, of(l).slow, of(l).nl === true, 'nl' in of(l)]), [
      ['sonar', false, false, false], ['spk', false, false, false], ['bw', true, false, false], ['tub', true, false, false],
      ['ami', false, true, true], ['amis', true, true, true], ['bwl', false, true, true], ['bwls', true, true, true]]);
    const m = B.ewsMember_(of('sonar'), 1, NOW);
    eq(['nl' in m, B.ewsMember_(of('bwl'), 1, NOW).nl], [false, 1]);
    const back = B.ewsPostOfPool_(Object.assign(B.ewsMember_(of('ami'), 1, NOW), { v: '', g: NOW }));
    eq([back.nl, 'nl' in B.ewsPostOfPool_(Object.assign(m, { v: '', g: NOW }))], [true, false]);
  });

  test('new lanes: ewsLanes_ is today\'s two jobs with no switch ON; a fake lane joins the list only while its switch is ON and it is ready, and is sent in the same fetchAll after today\'s two', () => {
    const env = makeEnv(() => []);
    const b = env.b;
    eq(b.ewsLanes_(null, {}).map(l => l.key), ['us', 'c1']);
    eq(JSON.stringify(b.ewsLanes_({}, {})), JSON.stringify(b.ev('EWS_LANES_')));
    let ready = false;
    addFakeLane(b, { ready: () => ready });
    eq(b.ewsLanes_({ edFake: true }, {}).map(l => l.key), ['us', 'c1']);
    ready = true;
    eq(b.ewsLanes_({ edFake: true }, {}).map(l => l.key), ['us', 'c1', 'fk']);
    eq(b.ewsLanes_({ edFake: 'ON' }, {}).map(l => l.key), ['us', 'c1']);
    const fetchAll = [];
    const orig = env.g.services.UrlFetchApp.fetchAll;
    env.g.services.UrlFetchApp.fetchAll = reqs => { fetchAll.push(reqs.map(r => JSON.parse(r.payload).labels.lane)); return orig(reqs); };
    const st = b.ewsState_(env.g.services.PropertiesService.getScriptProperties());
    const read = b.ewsReadLanes_(st, NOW, NOW + 40000, false, 30, b.ewsLanes_({ edFake: true }, st));
    eq([fetchAll, Object.keys(read.lanes), read.lanes.fk.state], [[['us', 'c1', 'fk']], ['us', 'c1', 'fk'], 'done']);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 2. How a run tells the producer which rows are ON
  // ---------------------------------------------------------------------------------------------------------------

  test('new lanes: ewsRunSwitches_ reads all OFF until a run sets it (fail closed), keeps only switches that are exactly true, and a check reads the fake lane only while its switch is set ON', () => {
    const env = makeEnv(job => (job === 'fk' ? [row({ lane: 'bwl', mid: 'BWL|a1' })] : []));
    const b = env.b;
    addFakeLane(b);
    eq(b.ewsRunSwitches_(), {});
    b.bqEarlyDetectionRows_(30);
    eq(env.bq.filter(c => c.job === 'fk').length, 0);
    eq(b.ewsRunSwitches_({ edFake: true, edAmie: 'ON', edBwLive: 1, relay: false }), { edFake: true });
    const copy = b.ewsRunSwitches_();
    copy.edAmie = true;
    eq(b.ewsRunSwitches_(), { edFake: true });
    env.g.clock.now += 15 * MIN;
    b.bqEarlyDetectionRows_(30);
    eq(env.bq.filter(c => c.job === 'fk').length, 1);
    eq(b.ewsRunSwitches_(null), {});
    env.g.clock.now += 15 * MIN;
    b.bqEarlyDetectionRows_(30);
    eq(env.bq.filter(c => c.job === 'fk').length, 1);
  });

  test('new lanes: the settings of the new sources are in GEN.settings with their defaults (config/default_config.yaml, BursonQAConfig), and ewsNewCfg_ reads them: 0 is kept (no trial), a missing or bad one is its default', () => {
    const S = B.ev('GEN').settings;
    const defaults = { early_wave_new_embed_per_check: 100, early_wave_new_embed_per_day: 5000, early_wave_new_late_minutes: 180,
      early_wave_new_pool_max: 300, early_wave_new_pool_minutes: 120, early_wave_new_carry_max: 100, early_wave_new_trial_days: 7,
      early_wave_new_lifted_per_hour: 2, early_wave_new_lifted_per_day: 20 };
    eq(Object.fromEntries(Object.keys(defaults).map(k => [k, S[k]])), defaults);
    eq(B.ewsNewCfg_(), { embedPerCheck: 100, embedPerDay: 5000, lateMinutes: 180, poolMax: 300, poolMinutes: 120, carryMax: 100,
      trialDays: 7, liftedPerHour: 2, liftedPerDay: 20 });
    const b = loadBot(makeGoogle(NOW).services);
    const s = b.ev('GEN').settings;
    s.early_wave_new_trial_days = 0;
    s.early_wave_new_pool_max = 'many';
    s.early_wave_new_embed_per_check = -5;
    delete s.early_wave_new_lifted_per_day;
    const c = b.ewsNewCfg_();
    eq([c.trialDays, c.poolMax, c.embedPerCheck, c.liftedPerDay], [0, 300, 100, 20]);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 3. Velocity and covered hours leave the new lanes out
  // ---------------------------------------------------------------------------------------------------------------

  // Four simulated days, a check an hour: Sonar brings 12 accounts an hour on the topic Pixel; from the start of day 3
  // the fake lane adds 20 more an hour (or nothing, when `withNew` is false).
  function velocityRun(withNew) {
    let check = 0;
    const env = makeEnv(job => {
      const now = env.g.clock.now;
      const out = [];
      if (job === 'c1') {
        for (let i = 0; i < 12; i++) {
          out.push(row({ lane: 'sonar', mid: `SONAR|v${check}_${i}`, author: `sonar_${(check * 12 + i) % 400}`,
            url: `https://x.com/sonar_${(check * 12 + i) % 400}/status/2160${String(check).padStart(4, '0')}${String(i).padStart(3, '0')}`,
            posted_ms: now - (5 + i * 4) * MIN, seen_ms: now - 2 * MIN, chash: `vs${check}_${i}`, sig: `vs${check}_${i}`,
            txt: `Pixel ${check} battery report ${i}: ${['charging', 'drains', 'overnight', 'percent', 'warm'][i % 5]} words ${check * 100 + i}` }));
        }
      }
      if (job === 'fk' && check >= 48) {
        for (let i = 0; i < 20; i++) {
          out.push(row({ lane: 'bwl', mid: `BWL|v${check}_${i}`, author: `bw_${(check * 20 + i) % 700}`, platform: 'reddit',
            url: `https://www.reddit.com/r/GooglePixel/comments/v${check}x${i}/t/`,
            posted_ms: now - (3 + i * 2) * MIN, seen_ms: now - 2 * MIN, chash: `vb${check}_${i}`, sig: `vb${check}_${i}`,
            txt: `Pixel ${check} battery thread ${i}: ${['charging', 'drains', 'overnight', 'percent', 'warm'][i % 5]} note ${check * 100 + i}` }));
        }
      }
      return out;
    });
    addFakeLane(env.b);
    env.b.ewsRunSwitches_({ edFake: withNew });
    const velocity = new Set();
    const accRows = [];
    for (check = 0; check < 96; check++) {
      env.b.bqEarlyDetectionRows_(60).forEach(r => { if (r.signal_type === 'VELOCITY_SPIKE') velocity.add(r.alert_id); });
      const acc = JSON.parse(env.g.cache.get('ews1:acc') || '{"rows":[]}');
      accRows.push(acc.rows.length);
      env.g.clock.now += HOUR;
    }
    return { velocity: Array.from(velocity).sort(), accRows, roll: JSON.parse(env.g.props.get('EWS_ROLLUP')), env };
  }

  test('new lanes: over four simulated days of steady inflow a new lane\'s posts add no row to the accounts kept for velocity and fire no velocity signal: the accounts and the signals are those of today\'s lanes alone (E5)', () => {
    const off = velocityRun(false);
    const on = velocityRun(true);
    eq(on.accRows, off.accRows);
    eq(on.velocity, off.velocity);
    eq(on.roll.k['T|Pixel'], off.roll.k['T|Pixel']);
    assert.ok(on.accRows.some(n => n > 0), 'Sonar\'s rows are counted');
  });

  test('new lanes: the hours a new source\'s job read are not covered hours: only today\'s two jobs\' windows count', () => {
    const env = makeEnv(() => []);
    addFakeLane(env.b, { query: (st, until) => ({ sql: '-- ews:fk\nSELECT 1', params: [], win: { since: until - 9 * HOUR, until: until - 7 * HOUR }, flags: {} }) });
    env.b.ewsRunSwitches_({ edFake: true });
    env.b.bqEarlyDetectionRows_(30);
    const cov = JSON.parse(env.g.props.get('EWS_ROLLUP')).cov;
    const h = Math.floor((NOW - MIN) / HOUR);
    eq([cov.includes(h), cov.includes(h - 8), cov.includes(h - 9)], [true, false, false]);
  });
};
