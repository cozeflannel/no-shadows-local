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

  // ---------------------------------------------------------------------------------------------------------------
  // 4. The pool share, the embedding split, the day bar, the carry
  // ---------------------------------------------------------------------------------------------------------------

  // A text that shares no word with any other (so it joins nothing and stays in the pool)
  const lone = (tag, n) => Array.from({ length: 9 }, (_, j) => `${tag}${n}q${j}z`).join(' ');
  const sonarN = (k, tag, o) => Array.from({ length: k }, (_, i) => row(Object.assign({ lane: 'sonar', mid: `SONAR|${tag}${i}`,
    author: `${tag}a${i}`, url: `https://x.com/${tag}a${i}/status/${2170000000000000 + i}`, txt: lone(`${tag}s`, i),
    chash: `${tag}s${i}`, sig: `${tag}s${i}`, posted_ms: NOW - (2 + (i % 50)) * MIN }, o || {})));
  const newN = (k, tag, o) => Array.from({ length: k }, (_, i) => row(Object.assign({ lane: 'bwl', mid: `BWL|${tag}${i}`,
    platform: 'reddit', author: `${tag}r${i}`, url: `https://www.reddit.com/r/google/comments/${tag}${i}/t/`, txt: lone(`${tag}n`, i),
    chash: `${tag}n${i}`, sig: `${tag}n${i}`, posted_ms: NOW - (1 + (i % 50)) * MIN }, o || {})));

  // A world whose embedding calls are recorded (`embedded`: the texts of every call)
  function embedEnv(rowsOf) {
    const env = makeEnv((job, body) => rowsOf(job, env.g.clock.now, body));
    env.embedded = [];
    env.b.__emb = env.embedded;
    env.b.ev('embedTexts_ = (orig => (texts, o) => { __emb.push(...texts); return orig(texts, o); })(embedTexts_)');
    addFakeLane(env.b, { src: 'bwl' });
    env.b.ewsRunSwitches_({ edFake: true });
    return env;
  }
  const kinds = (texts, a, b2) => [a, b2].map(x => texts.filter(t => new RegExp(`^${x}\\d+q0z `).test(t)).length);

  test('new lanes: embedding a check gives today\'s lanes 300 of the 400 and the new lanes 100 (500 + 200 texts), room one side leaves goes to the other (50 + 500: 50 and 350), and with no new-lane post today\'s lanes get all 400 as before (E9)', () => {
    let env = embedEnv((job) => (job === 'c1' ? sonarN(500, 'a') : job === 'fk' ? newN(200, 'a') : []));
    env.b.bqEarlyDetectionRows_(30);
    eq(kinds(env.embedded, 'as', 'an'), [300, 100]);
    env = embedEnv((job) => (job === 'c1' ? sonarN(50, 'b') : job === 'fk' ? newN(500, 'b') : []));
    env.b.bqEarlyDetectionRows_(30);
    eq(kinds(env.embedded, 'bs', 'bn'), [50, 350]);
    env = embedEnv((job) => (job === 'c1' ? sonarN(500, 'c') : []));
    env.b.bqEarlyDetectionRows_(30);
    eq(kinds(env.embedded, 'cs', 'cn'), [400, 0]);
    // the order itself (pure): today's lanes first, carried posts first among the new lanes'
    const need = [{ chash: 't1' }, { chash: 'n1', nl: true }, { chash: 't2' }, { chash: 'n2', nl: true, _carry: true }, { chash: 't1' }];
    const cfg = Object.assign(B.ewsNewCfg_(), { embedPerCheck: 1 });
    const sp = B.ewsEmbedSplit_(need, 3, 0, 0, NOW, cfg);
    eq([sp.order.map(p => p.chash), sp.today, sp.fresh, sp.barred], [['t1', 't2', 'n2'], 2, 1, false]);
    eq(B.ewsEmbedSplit_(need, 2, 0, 0, NOW, cfg).order.map(p => p.chash), ['t1', 'n2']);
  });

  test('new lanes: the day bar stops the new lanes\' embedding (the day\'s total at its pace, or their own 5,000) and the day record says so; the room they leave goes to today\'s lanes (E9)', () => {
    const pace = Math.floor(20000 * (new Date(NOW).getUTCHours() + 1) / 24);
    for (const [embedded, nl, sonar, want] of [[pace, 0, 50, [50, 0]], [0, 5000, 50, [50, 0]], [pace, 0, 500, [400, 0]]]) {
      const env = embedEnv((job) => (job === 'c1' ? sonarN(sonar, 'd') : job === 'fk' ? newN(200, 'd') : []));
      env.g.props.set('EWS_STATE', JSON.stringify({ v: 1, marks: {}, jobs: {}, day: { key: new Date(NOW).toISOString().slice(0, 10), embedded, nl } }));
      env.b.bqEarlyDetectionRows_(30);
      eq([embedded, nl, kinds(env.embedded, 'ds', 'dn')], [embedded, nl, want]);
      const rec = JSON.parse(env.g.props.get('EWS_SRC_DAY'));
      eq(rec.d[new Date(NOW).toISOString().slice(0, 10)].bar, 1);
    }
    // under the bar: the new lanes' own count for the day is kept
    const env = embedEnv((job) => (job === 'fk' ? newN(20, 'e') : []));
    env.b.bqEarlyDetectionRows_(30);
    const st = JSON.parse(env.g.props.get('EWS_STATE'));
    eq([st.day.embedded, st.day.nl], [20, 20]);
    eq(B.ewsEmbedSplit_([{ chash: 'n', nl: true }], 400, pace - 1, 0, NOW, B.ewsNewCfg_()).fresh, 1);
  });

  test('new lanes: new-lane posts left without a vector are carried (the newest 100) and embedded first at the next check; the rest, and carried posts older than 2 hours, are counted "not embedded" (E9)', () => {
    let check = 1;
    const env = embedEnv((job) => {
      if (check === 1) return job === 'c1' ? sonarN(50, 'f') : job === 'fk' ? newN(500, 'f') : [];
      return job === 'c1' ? sonarN(300, 'g') : job === 'fk' ? newN(50, 'g') : [];
    });
    env.b.bqEarlyDetectionRows_(30);
    const day = new Date(NOW).toISOString().slice(0, 10);
    const carry = JSON.parse(env.g.cache.get('ews1:carry'));
    eq(carry.length, 100);
    let rec = JSON.parse(env.g.props.get('EWS_SRC_DAY'));
    eq([rec.d[day].bwl.ne, rec.d[day].bwl.emb, rec.on.bwl], [50, 350, day]);
    // the carried are the newest of the 150 left
    const carriedIds = carry.map(r => r[0]);
    const left = newN(500, 'f').map(r => r.mid);
    assert.ok(carriedIds.every(id => left.includes(id)));
    const before = env.embedded.length;
    check = 2;
    env.g.clock.now += 15 * MIN;
    env.b.bqEarlyDetectionRows_(30);
    const second = env.embedded.slice(before);
    eq(kinds(second, 'gs', 'gn').concat([kinds(second, 'fn', 'zz')[0]]), [300, 0, 100]);
    eq(JSON.parse(env.g.cache.get('ews1:carry')).length, 50);
    // two hours on, what is still carried is counted as never embedded
    check = 3;
    env.g.clock.now += 2 * HOUR + MIN;
    env.b.ev('embedTexts_ = () => []');
    env.b.bqEarlyDetectionRows_(30);
    rec = JSON.parse(env.g.props.get('EWS_SRC_DAY'));
    eq(rec.d[day].bwl.ne, 100);
    // the carry item stays under the cache item limit with 100 posts of the longest texts and links
    const big = Array.from({ length: 100 }, (_, i) => ({ id: `BWL|${i}`, lane: 'bwl', url: 'https://www.reddit.com/' + 'x'.repeat(600),
      platform: 'Reddit', author: 'a'.repeat(200), audience: 5000, eng: 499, t: NOW - i, seen: NOW, text: 'w'.repeat(600), topic: 't'.repeat(80),
      chash: 'c'.repeat(16), risk: ['privacy_data_leak', 'safety_csam_selfharm'], brand: true, k: 'k'.repeat(16) }));
    const out = B.ewsCarryOut_(big, NOW, 100);
    assert.ok(JSON.stringify(out.records).length <= B.ev('EWS_CACHE_ITEM_CHARS_'));
    eq(out.records.length + (out.dropped.bwl || 0), 100);
  });

  test('new lanes: the pool keeps at most early_wave_new_pool_max new-lane posts (the newest) and none older than early_wave_new_pool_minutes; today\'s lanes\' posts are untouched (E8)', () => {
    // pure: 1,000 Sonar and 600 new-lane records
    const recs = [];
    for (let i = 0; i < 1000; i++) recs.push({ i: `S${i}`, t: NOW - i * 1000 });
    for (let i = 0; i < 600; i++) recs.push({ i: `N${i}`, t: NOW - i * 1000, nl: 1 });
    const kept = B.ewsNewPoolShare_(recs, 0, 300);
    eq([kept.filter(r => !r.nl).length, kept.filter(r => r.nl).length, kept.filter(r => r.nl).every(r => Number(r.i.slice(1)) < 300)], [1000, 300, true]);
    eq(B.ewsNewPoolShare_(recs, 250, 300).filter(r => r.nl).length, 50);
    eq(B.ewsNewPoolShare_(recs.slice(0, 1000), 999, 300), recs.slice(0, 1000));
    // in a check: a pool of 3 new-lane posts at most, for 120 minutes
    let check = 1;
    const env = makeEnv(job => {
      if (check !== 1) return [];
      if (job === 'c1') return sonarN(6, 'h');
      if (job === 'fk') return newN(8, 'h');
      return [];
    });
    env.b.ev('GEN').settings.early_wave_new_pool_max = 3;
    addFakeLane(env.b, { src: 'bwl' });
    env.b.ewsRunSwitches_({ edFake: true });
    const poolNow = () => {
      const st = JSON.parse(env.g.props.get('EWS_STATE'));
      const out = [];
      (st.pool || []).forEach(([stamp, n]) => { for (let j = 0; j < n; j++) JSON.parse(env.g.cache.get(`ews1:pv:${stamp}:${j}`) || '[]').forEach(p => out.push(p)); });
      return out;
    };
    env.b.bqEarlyDetectionRows_(30);
    let pool = poolNow();
    eq([pool.filter(p => !p.nl).length, pool.filter(p => p.nl).length], [6, 3]);
    eq(pool.filter(p => p.nl).map(p => p.i).sort(), ['BWL|h0', 'BWL|h1', 'BWL|h2']);
    check = 2;
    env.g.clock.now += 121 * MIN;
    env.b.bqEarlyDetectionRows_(30);
    pool = poolNow();
    eq([pool.filter(p => !p.nl).length, pool.filter(p => p.nl).length], [6, 0]);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 5. Split same-author signatures
  // ---------------------------------------------------------------------------------------------------------------

  test('new lanes: today\'s lanes check and write only their own same-author signatures, exactly as with no new lane; a new lane\'s post is checked against both sets and writes only its own (sn:N)', () => {
    const batches = [
      { c1: [row({ mid: 'SONAR|p1', sig: 'sigX', chash: 'p1' })], fk: [row({ lane: 'bwl', mid: 'BWL|q1', sig: 'sigY', chash: 'q1', platform: 'reddit', url: 'https://www.reddit.com/r/google/comments/q1/t/' })] },
      // Sonar repeats the new lane's signature (kept: today's lanes never check the new set); the new lane repeats
      // Sonar's (dropped) and its own (dropped); in one batch, a new-lane copy of a Sonar signature posted earlier is dropped
      { c1: [row({ mid: 'SONAR|p2', sig: 'sigY', chash: 'p2' }), row({ mid: 'SONAR|p3', sig: 'sigZ', chash: 'p3', posted_ms: NOW - 5 * MIN })],
        fk: [row({ lane: 'bwl', mid: 'BWL|q2', sig: 'sigX', chash: 'q2', url: 'https://www.reddit.com/r/google/comments/q2/t/' }),
          row({ lane: 'bwl', mid: 'BWL|q3', sig: 'sigY', chash: 'q3', url: 'https://www.reddit.com/r/google/comments/q3/t/' }),
          row({ lane: 'bwl', mid: 'BWL|q4', sig: 'sigZ', chash: 'q4', posted_ms: NOW - 50 * MIN, url: 'https://www.reddit.com/r/google/comments/q4/t/' })] },
    ];
    const run = withLane => {
      let i = 0;
      const env = makeEnv(job => (batches[i] && batches[i][job]) || []);
      addFakeLane(env.b, { src: 'bwl' });
      env.b.ewsRunSwitches_({ edFake: withLane });
      const kept = [];
      for (i = 0; i < batches.length; i++) {
        env.b.bqEarlyDetectionRows_(30);
        kept.push(JSON.parse(env.g.props.get('EWS_STATE')).last.kept);
        env.g.clock.now += 15 * MIN;
      }
      return { env, kept, sg: env.g.cache.get('ews1:sg:0'), sn: env.g.cache.get('ews1:sn:0'), st: JSON.parse(env.g.props.get('EWS_STATE')) };
    };
    const off = run(false);
    const on = run(true);
    eq([off.kept, on.kept], [[1, 2], [2, 2]]);
    eq(on.sg, off.sg);
    const fnv = s => on.env.b.ewsFnv_(s);
    const sn = [].concat(...JSON.parse(on.sn).map(r => r[1]));
    eq([sn, on.st.sn, off.st.sn, off.sn], [[fnv('sigY')], 1, undefined, undefined]);
    // pure: with no new-lane post, the split is the old function
    const sigsA = {};
    const sigsB = {};
    const posts = [{ id: 'a', t: 2, sig: 'x' }, { id: 'b', t: 1, sig: 'x' }, { id: 'c', t: 3, sig: 'y' }];
    eq(B.ewsDedupSigsSplit_(posts.map(p => Object.assign({}, p)), sigsA, {}, NOW), B.ewsDedupSigs_(posts.map(p => Object.assign({}, p)), sigsB, NOW));
    eq(sigsA, sigsB);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 6. Stitching: one post, one alert
  // ---------------------------------------------------------------------------------------------------------------

  const STORY = 'Pixel 9 emergency dialer screen freezes completely right after installing the overnight Android update patch';
  const DAY = new Date(NOW).toISOString().slice(0, 10);

  // Checks in a row with the fake lane ON (source bwl), `batches[i]` the rows of check i by job; `gap` minutes apart
  function stitchEnv(batches, o) {
    let i = 0;
    const env = makeEnv(job => (batches[i] && batches[i][job]) || []);
    addFakeLane(env.b, { src: (o && o.src) || 'bwl' });
    env.b.ewsRunSwitches_(Object.assign({ edFake: true }, (o && o.sw) || {}));
    env.run = () => {
      for (i = 0; i < batches.length; i++) {
        if (o && o.before) o.before(i, env);
        env.b.bqEarlyDetectionRows_(30);
        if (i < batches.length - 1) env.g.clock.now += ((o && o.gap) || 15) * MIN;
      }
      return env;
    };
    env.items = prefix => {
      const out = [];
      for (const [k, v] of env.g.cache.entries()) if (k.startsWith(`ews1:${prefix}`)) JSON.parse(v).forEach(x => out.push(x));
      return out;
    };
    env.members = () => [].concat(...env.items('cl:').map(c => c.m || []));
    env.ids = () => env.members().map(m => m.i).concat(env.items('pv:').map(p => p.i)).sort();
    env.day = src => ((JSON.parse(env.g.props.get('EWS_SRC_DAY') || '{}').d || {})[DAY] || {})[src] || {};
    return env;
  }

  test('new lanes (stitching, Q8): the same X post from Sonar (x.com/newsdesk/status/N) and from the AMIE table (twitter.com/newsdesk/statuses/N) in one check is one post, Sonar\'s; the copy is counted "same post as another source"', () => {
    const env = stitchEnv([{
      c1: [row({ mid: 'SONAR|nd', url: 'https://x.com/newsdesk/status/2116390716536770729', author: 'newsdesk', chash: 'nd1', txt: STORY })],
      fk: [row({ lane: 'ami', mid: 'AMI|nd', url: 'https://twitter.com/newsdesk/statuses/2116390716536770729', author: 'newsdesk', chash: 'nd2', txt: STORY })],
    }], { src: 'ami' }).run();
    eq(env.ids(), ['SONAR|nd']);
    eq([env.day('ami').same, env.day('ami').sl, env.day('ami').used], [1, 1, undefined]);
  });

  test('new lanes (stitching, E6 and Q8): a Brandwatch-live Reddit post at 10:15 joins a story; Sonar\'s copy at 10:45 takes its place (one member, not two), keeps its velocity row (the accounts kept are those of the run with the lane OFF), and "seen first" counts 30 minutes for the new source', () => {
    const t0 = NOW;
    const sonar = (i, o) => row(Object.assign({ mid: `SONAR|st${i}`, author: `st${i}`, url: `https://x.com/st${i}/status/21800000000000${i}`,
      txt: `${STORY} ${['today', 'again', 'still'][i]}`, chash: `st${i}`, posted_ms: t0 - (10 + i) * MIN, seen_ms: t0 - 2 * MIN }, o || {}));
    const reddit = 'https://www.reddit.com/r/GooglePixel/comments/1zalice/dialer_freezes/';
    const bw = row({ lane: 'bwl', mid: 'BWL|alice', author: 'alice', platform: 'reddit', url: reddit, txt: `${STORY} reddit`,
      chash: 'alice1', posted_ms: t0 - 20 * MIN, seen_ms: t0 - 2 * MIN });
    const copy = row({ mid: 'SONAR|alice', author: reddit.toLowerCase(), platform: 'reddit', url: reddit, txt: `${STORY} reddit`,
      chash: 'alice1', posted_ms: t0 - 20 * MIN, seen_ms: t0 + 28 * MIN });
    const batches = withLane => [{ c1: [sonar(0), sonar(1), sonar(2)], fk: withLane ? [bw] : [] }, { c1: [copy] }];
    const on = stitchEnv(batches(true), { gap: 30 }).run();
    const off = stitchEnv(batches(false), { gap: 30 });
    off.b.ewsRunSwitches_({});
    off.run();
    const story = on.items('cl:').find(c => (c.m || []).some(m => m.i === 'SONAR|alice'));
    assert.ok(story, 'the copy is in the story');
    eq([story.m.length, new Set(story.m.map(m => m.a)).size, story.m.some(m => m.i === 'BWL|alice'), story.m.some(m => m.nl)], [4, 4, false, false]);
    const member = story.m.find(m => m.i === 'SONAR|alice');
    eq([member.a, member.p, member.u], [`Reddit:${reddit.toLowerCase()}`, 'Reddit', reddit]);
    eq(JSON.parse(on.g.cache.get('ews1:acc')).rows.length, JSON.parse(off.g.cache.get('ews1:acc')).rows.length);
    const accRow = JSON.parse(on.g.cache.get('ews1:acc'));
    const row4 = accRow.rows.find(r => r[4] === on.b.ewsFnv_('SONAR|alice'));
    assert.ok(row4 && row4[3].map(k => accRow.keys[k]).includes(`C|${story.id}`), 'its velocity row is in the story');
    eq([on.day('bwl').rp, on.day('bwl').sf, on.day('bwl').sfb], [1, 1, [0, 1, 0, 0, 0]]);
  });

  test('new lanes (stitching, Q8): Instagram /p/C1abc/ from Brandwatch live and /reel/C1abc/ from Sonar are one post (ig:C1abc); within one check Brandwatch live is kept before the AMIE table', () => {
    let env = stitchEnv([{
      c1: [row({ mid: 'SONAR|ig', platform: 'instagram', url: 'https://www.instagram.com/reel/C1abc/', author: 'maker', chash: 'ig', txt: STORY })],
      fk: [row({ lane: 'bwl', mid: 'BWL|ig', platform: 'instagram', url: 'https://www.instagram.com/p/C1abc/', author: 'maker', chash: 'ig', txt: STORY })],
    }]).run();
    eq(env.ids(), ['SONAR|ig']);
    env = stitchEnv([{ fk: [
      row({ lane: 'ami', mid: 'AMI|two', platform: 'instagram', url: 'https://www.instagram.com/p/C2two/', author: 'maker', chash: 'two', posted_ms: NOW - 40 * MIN, txt: STORY }),
      row({ lane: 'bwl', mid: 'BWL|two', platform: 'instagram', url: 'https://www.instagram.com/reel/C2two/', author: 'maker', chash: 'two', posted_ms: NOW - 30 * MIN, txt: STORY }),
    ] }]).run();
    eq([env.ids(), env.day('ami').same], [['BWL|two'], 1]);
  });

  test('new lanes (stitching, Q8): two Reddit comments sharing the thread link, by different authors with different words, are two posts ("same link, different post"); the same author on that link is one post', () => {
    const thread = 'https://www.reddit.com/r/google/comments/1thr/a_thread/';
    let env = stitchEnv([{ fk: [
      row({ lane: 'bwl', mid: 'BWL|c1', platform: 'reddit', url: thread, author: 'bob', chash: 'cbob', txt: lone('cb', 1) }),
      row({ lane: 'bwl', mid: 'BWL|c2', platform: 'reddit', url: thread, author: 'carol', chash: 'ccar', txt: lone('cc', 1) }),
    ] }]).run();
    eq(env.ids(), ['BWL|c1', 'BWL|c2']);
    env = stitchEnv([{ fk: [
      row({ lane: 'bwl', mid: 'BWL|c1', platform: 'reddit', url: thread, author: 'bob', chash: 'cbob', txt: lone('cb', 1) }),
      row({ lane: 'bwl', mid: 'BWL|c3', platform: 'reddit', url: thread, author: 'bob', chash: 'cbo2', txt: lone('cb', 2), posted_ms: NOW - 10 * MIN }),
    ] }]).run();
    eq(env.ids(), ['BWL|c1']);
    // pure: authors or texts equal -> one post; both different -> two
    eq([B.ewsSameWho_(B.ewsWho_('bob', 'aaaa1'), B.ewsWho_('bob', 'bbbb1')), B.ewsSameWho_(B.ewsWho_('bob', 'aaaa1'), B.ewsWho_('carol', 'aaaa1')),
      B.ewsSameWho_(B.ewsWho_('bob', 'aaaa1'), B.ewsWho_('carol', 'bbbb1'))], [true, true, false]);
  });

  test('new lanes (stitching, Q8): a TikTok post Sonar knew as big (the xbig list) and then from Brandwatch live with followers unknown is left out; so is a post by an excluded author, and one the alert memory has seen (a Watch alert claimed it an hour ago, then the AMIE table); today\'s lanes are not filtered by these lists', () => {
    const tiktok = 'https://www.tiktok.com/@bigmaker/video/7301234567890123456';
    const seenUrl = 'https://www.reddit.com/r/google/comments/1seen/t/';
    const env = stitchEnv([{
      c1: [row({ mid: 'SONAR|kofpost', author: 'kofperson', url: 'https://x.com/kofperson/status/2190000000000000001', chash: 'k1', txt: lone('kf', 1) })],
      fk: [
        row({ lane: 'bwl', mid: 'BWL|tt', platform: 'tiktok', url: tiktok, author: 'bigmaker', audience: null, chash: 'tt', txt: lone('tt', 1) }),
        row({ lane: 'bwl', mid: 'BWL|kof', platform: 'reddit', url: 'https://www.reddit.com/r/google/comments/1kof/t/', author: 'kofperson', chash: 'k2', txt: lone('kf', 2) }),
        row({ lane: 'ami', mid: 'AMI|seen', platform: 'reddit', url: seenUrl, author: 'someone', chash: 'sn', txt: lone('sn', 1) }),
        row({ lane: 'ami', mid: 'AMI|fine', platform: 'reddit', url: 'https://www.reddit.com/r/google/comments/1fine/t/', author: 'fine', chash: 'fn', txt: lone('fn', 1) }),
      ],
    }], { before: (i, e) => {
      const key = e.b.ewsKeyHash_(e.b.amPostKey_(tiktok));
      e.g.cache.set('ews1:xb', JSON.stringify([[key, NOW - HOUR]]));
      e.g.cache.set('ews1:ak', JSON.stringify([['kofperson', NOW - 2 * 24 * HOUR]]));
      e.b.__seenUrl = seenUrl;
      e.b.ev('AM_RUN_ = { seenPost: url => (url === __seenUrl ? { why: "claimed", at: Date.now() - 3600000 } : null) }');
    } }).run();
    eq(env.ids(), ['AMI|fine', 'SONAR|kofpost']);
    eq([env.day('bwl').big, env.day('bwl').ex, env.day('ami').al, env.day('ami').used, env.day('bwl').used], [1, 1, 1, 1, undefined]);
  });

  test('new lanes (stitching): the post-key index keeps a new lane\'s posts (and today\'s, while a new source is ON) for 72 hours, so a copy from another new source hours later is dropped once its first copy has left the pool; it is hashed (16 hex characters and 8 of who wrote what) and stays under the cache item limit', () => {
    const url = 'https://www.reddit.com/r/google/comments/1late/t/';
    const env = stitchEnv([
      { fk: [row({ lane: 'bwl', mid: 'BWL|late', platform: 'reddit', url, author: 'dana', chash: 'late', txt: lone('lt', 1) })] },
      { fk: [row({ lane: 'amis', mid: 'AMI|late', platform: 'reddit', url, author: 'dana', chash: 'late', txt: lone('lt', 1), posted_ms: NOW - 20 * MIN })] },
    ], { gap: 180 }).run();
    eq([env.ids().includes('AMI|late'), env.day('bwl').used, env.day('ami').same], [false, 1, 1]);
    const st = JSON.parse(env.g.props.get('EWS_STATE'));
    const nk = env.items('nk:');
    const entries = [].concat(...nk.map(r => r[1]));
    const key = env.b.ewsKeyHash_(env.b.amPostKey_(url));
    eq([st.nk, key.length, entries.filter(e => e.startsWith(key)).length, entries.every(e => /^[0-9a-f]{20}\w{4}$/.test(e))], [1, 16, 1, true]);
    assert.ok(!JSON.stringify(nk).includes('1late'), 'no link in the index');
    // worst case: 72 hours at the ceiling, each item under the limit
    const index = {};
    const h0 = Math.floor(NOW / HOUR);
    for (let h = 0; h < 72; h++) index[String(h0 - h)] = Array.from({ length: 400 }, (_, j) => (h * 1000 + j).toString(16).padStart(24, 'f'));
    const chunks = B.ewsChunks_(B.ewsSigRecords_(index, B.ev('EWS_NK_MAX_'), B.ev('EWS_NK_RECORD_')));
    eq([chunks.length <= 4, chunks.every(ch => JSON.stringify(ch).length <= B.ev('EWS_CACHE_ITEM_CHARS_'))], [true, true]);
    eq(chunks.reduce((s, ch) => s + ch.reduce((t, r) => t + r[1].length, 0), 0), 12000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 7. One person: ewsNewAuthor_
  // ---------------------------------------------------------------------------------------------------------------

  test('new lanes (one person): ewsNewAuthor_ takes the handle from an X, Bluesky, TikTok or Threads link as Sonar\'s lane does but never "i", "intent", "home", "search" or "web"; strips @, u/ and /u/; never a subreddit; an author shaped like an email address, or a blank one, becomes the link; the platform comes from the link, an unknown site is Web', () => {
    const reddit = 'https://www.reddit.com/r/GooglePixel/comments/1zabc/t/';
    const cases = [
      ['twitter', 'NewsDesk', 'https://twitter.com/NewsDesk/statuses/2116390716536770729', 'newsdesk'],
      ['twitter', 'NewsDesk', 'https://x.com/i/status/2116390716536770729', 'newsdesk'],
      ['twitter', 'Handle', 'https://twitter.com/i/web/status/2116390716536770729', 'handle'],
      ['twitter', '', 'https://x.com/intent/status/2116390716536770729', 'https://x.com/intent/status/2116390716536770729'],
      ['twitter', '@Web', 'https://x.com/web/status/1', 'web'],
      ['bluesky', 'Someone', 'https://bsky.app/profile/did:plc:abc/post/K2', 'did:plc:abc'],
      ['tiktok', '', 'https://www.tiktok.com/@Maker/video/7301234567890123456', 'maker'],
      ['threads', '', 'https://www.threads.net/@Writer/post/C9', 'writer'],
      ['reddit', 'u/Alice', reddit, 'alice'],
      ['reddit', '/u/alice', reddit, 'alice'],
      ['reddit', '@Alice', reddit, 'alice'],
      ['reddit', 'r/GooglePixel', reddit, reddit.toLowerCase()],
      ['reddit', 'Someone@Example.test', reddit, reddit.toLowerCase()],
      ['forum', '', 'https://Example-Forum.test/T/9', 'https://example-forum.test/t/9'],
    ];
    eq(cases.map(c => B.ewsNewAuthor_(c[0], c[1], c[2])), cases.map(c => c[3]));
    eq([B.ewsNewPlatform_(reddit), B.ewsNewPlatform_('https://example-forum.test/t/9'), B.ewsNewPlatform_('')], ['Reddit', 'Web', 'Web']);
    // Q8: Brandwatch live's "u/alice" and Sonar's "alice" on two different posts are one account; today's lanes keep theirs
    const of = o => B.ewsPostOf_(Object.assign({ kind: 'post', mid: 'X|1', url: reddit, platform: 'reddit', posted_ms: NOW, txt: 'w' }, o));
    eq([of({ lane: 'bwl', author: 'u/alice' }).ak, of({ lane: 'sonar', author: 'alice' }).ak, of({ lane: 'sonar', author: 'u/alice' }).ak,
      of({ lane: 'ami', author: '', platform: 'forum', url: 'https://example-forum.test/t/9' }).ak],
    ['Reddit:alice', 'Reddit:alice', 'Reddit:u/alice', 'Web:https://example-forum.test/t/9']);
  });

  test('new lanes (one person, Q8): five AMIE X posts written x.com/i/status/<n> by five handles are five accounts (never X:i); an author shaped like an email address is kept nowhere', () => {
    const env = stitchEnv([{ fk: [1, 2, 3, 4, 5].map(i => row({ lane: 'ami', mid: `AMI|i${i}`, author: `handle${i}`,
      url: `https://x.com/i/status/21163907165367707${i}0`, chash: `xi${i}`, txt: `${STORY} ${['one', 'two', 'three', 'four', 'five'][i - 1]}`,
      posted_ms: NOW - (10 + i) * MIN }))
      .concat([row({ lane: 'bwl', mid: 'BWL|mail', platform: 'reddit', author: 'Someone@Example.test', chash: 'ml',
        url: 'https://www.reddit.com/r/google/comments/1mail/t/', txt: lone('ml', 1) })]) }], { src: 'ami' }).run();
    const accounts = env.members().filter(m => /^AMI\|i/.test(m.i)).map(m => m.a).sort();
    eq(accounts, ['X:handle1', 'X:handle2', 'X:handle3', 'X:handle4', 'X:handle5']);
    const stored = [...env.g.cache.values(), ...env.g.props.values()].join('\n');
    assert.ok(!/example\.test/i.test(stored), 'no address stored');
    assert.ok(env.ids().includes('BWL|mail'));
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 8. The three limits at promotion, the trial, the day record
  // ---------------------------------------------------------------------------------------------------------------

  const TOPICS = [
    'Gmail inbox keeps deleting archived messages without warning since yesterday morning sync',
    'Chromebook keyboard backlight flickers constantly after enabling the newest battery saver mode',
    'Waymo robotaxi stopped dead in the intersection blocking an ambulance during rush hour traffic',
  ];
  const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];
  // `n` new-lane posts of topic `t` by `n` accounts, each on its own link, posted in the last hour
  const liftRows = (t, n, o) => Array.from({ length: n }, (_, i) => row(Object.assign({ lane: 'bwl', mid: `BWL|t${t}p${i}`,
    platform: 'reddit', author: `t${t}author${i}`, url: `https://www.reddit.com/r/google/comments/t${t}p${i}/x/`,
    txt: `${TOPICS[t]} ${WORDS[i]}`, chash: `t${t}c${i}`, sig: `t${t}s${i}`, posted_ms: NOW - (5 + i * 3) * MIN }, o || {})));
  const signals = rows => rows.filter(r => r.signal_type === 'CLUSTER_EMERGENCE');

  function liftRun(fkRows, o) {
    const env = makeEnv(job => (job === 'fk' ? fkRows : job === 'c1' ? (o && o.c1) || [] : []));
    if (o && o.settings) Object.assign(env.b.ev('GEN').settings, o.settings);
    if (o && o.srcDay) env.g.props.set('EWS_SRC_DAY', JSON.stringify(o.srcDay));
    addFakeLane(env.b, { src: 'bwl' });
    env.b.ewsRunSwitches_({ edFake: true });
    env.rows = env.b.bqEarlyDetectionRows_(30);
    env.rec = JSON.parse(env.g.props.get('EWS_SRC_DAY'));
    env.lifted = env.b.ewsLiftedStories_();
    return env;
  }

  test('new lanes (promotion, E4): a story started by new-lane posts alone (5 accounts in the last hour) is noted, not signalled, during the trial; with the trial over, or early_wave_new_trial_days at 0, it is signalled; the trial date is the day the source\'s row first went ON', () => {
    let env = liftRun(liftRows(0, 5));
    eq([signals(env.rows).length, env.rec.on.bwl, env.lifted.length, env.lifted[0].sent, env.lifted[0].trial, env.lifted[0].accounts],
      [0, DAY, 1, false, true, 5]);
    eq([env.rec.d[DAY].bwl.lf, env.rec.d[DAY].bwl.lfn, env.rec.d[DAY].bwl.sb, env.rec.d[DAY].bwl.st, env.rec.d[DAY].bwl.in],
      [1, 1, 1, 1, 5]);
    // the same story at the next check is listed once, not counted again
    env.g.clock.now += 15 * MIN;
    env.b.bqEarlyDetectionRows_(30);
    eq([JSON.parse(env.g.props.get('EWS_SRC_DAY')).d[DAY].bwl.lf, env.b.ewsLiftedStories_().length], [1, 1]);
    // trial over: the source first went ON 8 days ago (7-day trial)
    const old = new Date(NOW - 8 * 24 * HOUR).toISOString().slice(0, 10);
    env = liftRun(liftRows(0, 5), { srcDay: { v: 1, on: { bwl: old }, d: {} } });
    eq([signals(env.rows).length, env.lifted[0].sent, env.rec.on.bwl], [1, true, old]);
    // 6 days ago: still in the trial
    env = liftRun(liftRows(0, 5), { srcDay: { v: 1, on: { bwl: new Date(NOW - 6 * 24 * HOUR).toISOString().slice(0, 10) }, d: {} } });
    eq(signals(env.rows).length, 0);
    // no trial
    env = liftRun(liftRows(0, 5), { settings: { early_wave_new_trial_days: 0 } });
    eq([signals(env.rows).length, env.lifted[0].sent, env.lifted[0].trial, env.rec.d[DAY].bwl.lfs], [1, true, false, 1]);
    eq(JSON.parse(signals(env.rows)[0].representative_posts_json).length, 5);
  });

  test('new lanes (promotion, E4): after the trial at most 2 lifted stories an hour and 20 a day go for review, the rest are noted; a story over the bar with today\'s lanes alone is never held back, even in the trial', () => {
    let env = liftRun([].concat(liftRows(0, 5), liftRows(1, 5), liftRows(2, 5)), { settings: { early_wave_new_trial_days: 0 } });
    eq([signals(env.rows).length, env.lifted.filter(s => s.sent).length, env.lifted.filter(s => !s.sent).length], [2, 2, 1]);
    eq([env.rec.lh[1], env.rec.ld[1]], [2, 2]);
    env = liftRun(liftRows(0, 5), { settings: { early_wave_new_trial_days: 0 }, srcDay: { v: 1, on: {}, d: {}, ld: [DAY, 20] } });
    eq([signals(env.rows).length, env.lifted[0].sent], [0, false]);
    // five Sonar accounts and two new-lane ones, in the trial: over the bar with today's lanes alone
    const sonar = Array.from({ length: 5 }, (_, i) => row({ mid: `SONAR|t0q${i}`, author: `sonar${i}`, url: `https://x.com/sonar${i}/status/2190000000000000${i}`,
      txt: `${TOPICS[0]} ${WORDS[i]} plus`, chash: `t0q${i}`, posted_ms: NOW - (6 + i * 3) * MIN }));
    env = liftRun(liftRows(0, 2), { c1: sonar });
    eq([signals(env.rows).length, env.lifted.length], [1, 0]);
    eq(signals(env.rows)[0].unique_low_tier_authors, 7);
  });

  test('new lanes (promotion, E13): five Reddit comments in one thread by five accounts do not promote: their links fold to one thread, under the 2 links needed', () => {
    const env = liftRun(Array.from({ length: 5 }, (_, i) => row({ lane: 'bwl', mid: `BWL|cm${i}`, platform: 'reddit', author: `commenter${i}`,
      url: `https://www.reddit.com/r/google/comments/1thr/a_thread/c${i}x/`, txt: `${TOPICS[1]} ${WORDS[i]}`, chash: `cm${i}`,
      posted_ms: NOW - (5 + i) * MIN })), { settings: { early_wave_new_trial_days: 0 } });
    eq(signals(env.rows).length, 0);
    const story = (() => { for (const [k, v] of env.g.cache.entries()) if (k.startsWith('ews1:cl:')) return JSON.parse(v)[0]; return null; })();
    eq([story && story.m.length, story && new Set(story.m.map(m => m.a)).size], [5, 5]);
  });

  test('new lanes (promotion, E14 and limit 1): a new lane\'s Forum beside Sonar\'s Forums adds no platform (the bar stays 5, the priority P2), a member by an excluded author or of a big post is not counted, and the card still shows every platform', () => {
    const m = (i, o) => Object.assign({ i: `SONAR|f${i}`, a: `Forums:person${i}`, p: 'Forums', u: `https://forum.example.test/t/${i}`, t: NOW - 10 * MIN,
      s: 'Pixel update broke the dialer for everyone on the forum', d: 0.9, h: `h${i}`, b: 1 }, o || {});
    const story = members => ({ id: 'CLU-test', s: '', n: members.length, t0: NOW - HOUR, ts: NOW, m: members, tp: { Pixel: members.length } });
    const four = [m(1), m(2), m(3), m(4, { i: 'BWL|f4', a: 'Web:person4', p: 'Forum', nl: 1, k: 'bigkey0000000000' })];
    eq(B.ewsPromote_([story(four)], [], NOW).length, 0);
    const w = B.ewsStoryWindow_(story(four), NOW);
    eq([w.platforms, w.allPlatforms, w.authors, w.todayAuthors], [['Forums'], ['Forum', 'Forums'], 4, 3]);
    // without the rule a second platform would lower the bar to 4: the same story with Sonar's own Forum post is promoted
    const sonarOnly = [m(1), m(2), m(3), m(4, { p: 'Forum', a: 'Forum:person4' })];
    eq(B.ewsPromote_([story(sonarOnly)], [], NOW).map(x => [x.authors, x.priority, x.lifted]), [[4, 'P1', undefined]]);
    // five accounts with one new-lane member: promoted, lifted (four from today's lanes), shown on both platforms
    const five = [m(1), m(2), m(3), m(5), m(4, { i: 'BWL|f4', a: 'Web:person4', p: 'Forum', nl: 1, k: 'bigkey0000000000' })];
    const got = B.ewsPromote_([story(five)], [], NOW);
    eq(got.map(x => [x.authors, x.priority, x.lifted, x.platforms]), [[5, 'P2', true, ['Forums']]]);
    const card = B.ewsClusterRow_(got[0], NOW, null, false);
    eq([card.platform_count, card.platforms_csv], [2, 'Forum, Forums']);
    // limit 1: the same member left out by the excluded authors or the big posts list
    const lim = (authors, big) => ({ authors: new Set(authors), big: new Set(big) });
    eq(B.ewsPromote_([story(five)], [], NOW, lim(['person4'], [])).length, 0);
    eq(B.ewsPromote_([story(five)], [], NOW, lim([], ['bigkey0000000000'])).length, 0);
    eq(B.ewsPromote_([story(five)], [], NOW, lim(['person1'], [])).length, 1);
    // with no new-lane member the window is what it was
    eq(Object.keys(B.ewsStoryWindow_(story([m(1), m(2)]), NOW)).sort(), ['authors', 'brand', 'end', 'members', 'platforms', 'reps', 'risk', 'start', 'texts', 'urls']);
  });

  test('new lanes: the day record EWS_SRC_DAY stays under 8,800 characters in its worst case (7 days, both sources, every count large, 20 lifted stories with long headlines), keeps the date a source first went ON, and drops days older than 7', () => {
    const big = { in: 999999, used: 999999, same: 999999, sl: 999999, big: 999999, ex: 999999, al: 999999, rp: 999999, sf: 999999,
      sfb: [99999, 99999, 99999, 99999, 99999], dl: [99999, 99999, 99999, 99999, 99999], ne: 999999, emb: 999999, st: 999999, sb: 999999,
      lf: 999999, lfs: 999999, lfn: 999999 };
    const rec = B.ewsSrcDay_({ getProperty: () => null });
    rec.on = { ami: '2026-10-01', bwl: '2026-10-02' };
    for (let d = 0; d < 9; d++) rec.d[new Date(NOW - d * 24 * HOUR).toISOString().slice(0, 10)] = { ami: Object.assign({}, big), bwl: Object.assign({}, big), bar: 1 };
    for (let i = 0; i < 20; i++) rec.ls.push([NOW, `CLU-${'a'.repeat(12)}`, 99, 99, 'h'.repeat(100), 1, 'ami,bwl', 1]);
    rec.lh = [999999, 99];
    rec.ld = [DAY, 99];
    const store = {};
    B.ewsSaveSrcDay_({ setProperty: (k, v) => { store[k] = v; } }, rec, NOW);
    const saved = JSON.parse(store.EWS_SRC_DAY);
    assert.ok(store.EWS_SRC_DAY.length <= 8800, String(store.EWS_SRC_DAY.length));
    eq([saved.on, Object.keys(saved.d).length <= 7, Object.keys(saved.d).includes(DAY)], [rec.on, true, true]);
    const lifted = B.ewsLiftedStories_.call(null);
    eq(Array.isArray(lifted), true);
  });

  test('new lanes (E10): a new source\'s post first seen long after it was posted comes as amis / bwls: it joins a story that exists, cannot start one, is not pooled and adds no velocity row', () => {
    const late = (t, n) => liftRows(t, n, {}).map((r, i) => Object.assign(r, { lane: 'bwls', mid: `BWL|late${t}_${i}`,
      posted_ms: NOW - 5 * HOUR - i * MIN, seen_ms: NOW - MIN }));
    let env = liftRun(late(0, 5), { settings: { early_wave_new_trial_days: 0 } });
    let st = JSON.parse(env.g.props.get('EWS_STATE'));
    eq([signals(env.rows).length, st.last.formed, st.last.pool, JSON.parse(env.g.cache.get('ews1:acc')).rows.length], [0, 0, 0, 0]);
    // a story of three Sonar accounts exists: the late posts join it
    const sonar = Array.from({ length: 3 }, (_, i) => row({ mid: `SONAR|j${i}`, author: `sj${i}`, url: `https://x.com/sj${i}/status/2191000000000000${i}`,
      txt: `${TOPICS[0]} ${WORDS[i]} sonar`, chash: `j${i}`, posted_ms: NOW - (20 + i) * MIN }));
    let check = 1;
    env = makeEnv(job => (check === 1 ? (job === 'c1' ? sonar : []) : (job === 'fk' ? late(0, 3) : [])));
    addFakeLane(env.b, { src: 'bwl' });
    env.b.ewsRunSwitches_({ edFake: true });
    env.b.bqEarlyDetectionRows_(30);
    check = 2;
    env.g.clock.now += 15 * MIN;
    env.b.bqEarlyDetectionRows_(30);
    st = JSON.parse(env.g.props.get('EWS_STATE'));
    const members = [];
    for (const [k, v] of env.g.cache.entries()) if (k.startsWith('ews1:cl:')) JSON.parse(v).forEach(c => (c.m || []).forEach(m => members.push(m)));
    eq([members.filter(m => /^BWL\|late/.test(m.i)).length, members.filter(m => m.sl && m.nl).length, st.last.joined], [3, 3, 3]);
  });

  test('new lanes (E1): with the new rows OFF a fake lane changes nothing: six checks send two jobs each with the bodies of the base, read no other service, and leave every property and cache item exactly as with no new lane at all (no EWS_SRC_DAY, no carry, no index, no new signatures)', () => {
    const batch = i => ({
      c1: sonarN(6, `e${i}`).concat([row({ mid: `SONAR|e${i}st`, txt: `${TOPICS[2]} ${WORDS[i % 7]}`, chash: `e${i}st`, sig: `e${i}st`, author: `es${i}`,
        url: `https://x.com/es${i}/status/2192000000000000${i}` })]),
      us: [row({ lane: 'spk', mid: `SPK|e${i}`, platform: 'instagram', url: `https://www.instagram.com/p/E${i}x/`, author: `ek${i}`,
        txt: `${TOPICS[2]} ${WORDS[(i + 3) % 7]} comment`, chash: `ek${i}`, sig: `ek${i}` })],
      fk: [row({ lane: 'bwl', mid: `BWL|e${i}`, platform: 'reddit', url: `https://www.reddit.com/r/google/comments/e${i}/t/`, author: `eb${i}`,
        txt: `${TOPICS[2]} ${WORDS[(i + 5) % 7]} thread`, chash: `eb${i}`, sig: `eb${i}` })],
    });
    const run = variant => {
      let i = 0;
      const env = makeEnv(job => batch(i)[job] || []);
      const others = [];
      const orig = env.g.services.UrlFetchApp.fetch;
      env.g.services.UrlFetchApp.fetch = (url, params) => {
        if (!String(url).startsWith('https://bigquery.googleapis.com/') && !/aiplatform|vertex/.test(String(url))) others.push(String(url));
        return orig(url, params);
      };
      if (variant !== 'none') addFakeLane(env.b, { src: 'bwl' });
      if (variant === 'off') env.b.ewsRunSwitches_({ edFake: false, edAmie: false, edBwLive: false, relay: true });
      for (i = 0; i < 6; i++) { env.b.bqEarlyDetectionRows_(30); env.g.clock.now += 15 * MIN; }
      return { env, others, posts: env.bq.filter(c => c.method === 'post' && /\/queries$/.test(c.url)), state: snapshotOf(env) };
    };
    const none = run('none');
    for (const variant of ['registered', 'off']) {
      const got = run(variant);
      eq([variant, got.posts.length, got.posts.map(c => c.job).filter(j => j !== 'us' && j !== 'c1')], [variant, 12, []]);
      got.posts.forEach((c, k) => assert.strictEqual(c.payload, none.posts[k].payload));
      eq(got.state, none.state);
      eq(got.others, none.others);
    }
    eq(none.posts.slice(0, 4).map(c => c.payload), BASE.bodies.map(b => b.payload));
    const names = Object.keys(none.state.cache).concat(Object.keys(none.state.props));
    eq(names.filter(n => /EWS_SRC_DAY|ews1:(carry|nk:|sn:|xb|ak)/.test(n)), []);
    const st = JSON.parse(none.state.props.EWS_STATE);
    eq(['nk', 'sn'].filter(k => k in st).concat('nl' in (st.day || {}) ? ['day.nl'] : []), []);
    assert.ok(none.state.cache['ews1:cl:0'], 'the run made stories');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // 9. After the review: what "lifted" means, a row turned OFF, the trial's start, and the rules no test held before
  // ---------------------------------------------------------------------------------------------------------------

  // Story members as ewsStoryWindow_ reads them: today's lanes' (X) and a new lane's (Reddit, nl)
  const sm = (i, o) => Object.assign({ i: `SONAR|L${i}`, a: `X:p${i}`, p: 'X', u: `https://x.com/p${i}/status/219300000000000${String(i).padStart(2, '0')}`,
    t: NOW - 10 * MIN, s: 'Pixel dialer froze after the update', d: 0.9, h: `h${i}`, b: 1 }, o || {});
  const nm = (i, o) => sm(i, Object.assign({ i: `BWL|L${i}`, a: `Reddit:r${i}`, p: 'Reddit', u: `https://www.reddit.com/r/google/comments/L${i}/t/`, nl: 1 }, o || {}));
  const lstory = (members, o) => Object.assign({ id: 'CLU-lift', s: '', n: members.length, t0: NOW - HOUR, ts: NOW, m: members, tp: {} }, o || {});
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

  test('new lanes (promotion): a story is "lifted" whenever today\'s lanes\' members alone would not pass, not only on accounts: the 2-links bar, the cooldown, the copy-paste test and the same-story check are each worked out on today\'s members alone', () => {
    const P = (members, priors, o) => B.ewsPromote_([lstory(members, o)], priors || [], NOW).map(x => [x.authors, x.urls, !!x.lifted]);
    // links: five Sonar accounts on one link, one new-lane post on a second link
    const oneLink = range(0, 5).map(i => sm(i, { u: 'https://x.com/p0/status/21930000000000000' }));
    eq([P(oneLink.concat([nm(5)])), P(oneLink)], [[[6, 2, true]], []]);
    // cooldown: signalled an hour ago at 5 accounts; 6 new-lane accounts take it to 11 (2x): lifted; 10 Sonar and 1 new: not
    const cool = { al: { at: NOW - HOUR, au: 5, id: 'ED-1' } };
    eq([P(range(0, 5).map(i => sm(i)).concat(range(5, 11).map(i => nm(i))), [], cool), P(range(0, 10).map(i => sm(i)).concat([nm(10)]), [], cool)],
      [[[11, 11, true]], [[11, 11, false]]]);
    // the copy-paste test: five Sonar accounts with one text that never names Google; two new-lane texts break the ring
    const ring = range(0, 5).map(i => sm(i, { s: 'buy cheap followers now at my shop today', b: 0, h: 'ring' }));
    eq([P(ring.concat([nm(5, { s: 'buy cheap followers now', b: 0, h: 'n5' }), nm(6, { s: 'cheap followers here', b: 0, h: 'n6' })])), P(ring)],
      [[[7, 7, true]], []]);
    // the same-story check: told 7 hours ago at 5 accounts (out of its cooldown, inside the day); new-lane growth alone
    const priors = [{ id: 'ED-1', cid: 'CLU-lift', at: NOW - 7 * HOUR, au: 5, pl: ['X'] }];
    eq([P(range(0, 5).map(i => sm(i)).concat(range(5, 11).map(i => nm(i))), priors), P(range(0, 5).map(i => sm(i)), priors),
      P(range(0, 10).map(i => sm(i)).concat([nm(10)]), priors)], [[[11, 11, true]], [], [[11, 11, false]]]);
    // with no new-lane member nothing is marked
    eq(P(range(0, 5).map(i => sm(i))), [[5, 5, false]]);
  });

  test('new lanes (promotion): in a full check, five Sonar accounts on one link and one Brandwatch-live post on a second link are noted in the trial (lifted), not signalled; with no trial they go for review', () => {
    const sonar = Array.from({ length: 5 }, (_, i) => row({ mid: `SONAR|ol${i}`, author: `ol${i}`, url: 'https://x.com/ol0/status/2194000000000000001',
      txt: `${TOPICS[0]} ${WORDS[i]} same link`, chash: `ol${i}`, sig: `ol${i}`, posted_ms: NOW - (6 + i * 3) * MIN }));
    const bw = liftRows(0, 1);
    let env = liftRun(bw, { c1: sonar });
    eq([signals(env.rows).length, env.lifted.length, env.lifted[0].trial], [0, 1, true]);
    env = liftRun([], { c1: sonar });
    eq(signals(env.rows).length, 0);
    env = liftRun(bw, { c1: sonar, settings: { early_wave_new_trial_days: 0 } });
    eq([signals(env.rows).length, env.lifted[0].sent], [1, true]);
  });

  test('new lanes (promotion): a story only a new lane lifted, noted in its trial, stays held back once every new row is OFF (its posts stay in the story), and the hour cap still holds then; the next hour, after the trial, it goes for review', () => {
    let check = 1;
    let env = makeEnv(job => (check === 1 && job === 'fk' ? liftRows(0, 5) : []));
    addFakeLane(env.b, { src: 'bwl' });
    env.b.ewsRunSwitches_({ edFake: true });
    eq(signals(env.b.bqEarlyDetectionRows_(30)).length, 0);
    check = 2;
    env.g.clock.now += 15 * MIN;
    env.b.ewsRunSwitches_({});
    eq(signals(env.b.bqEarlyDetectionRows_(30)).length, 0);
    eq(env.b.ewsLiftedStories_().map(s => [s.accounts, s.sent, s.trial]), [[5, false, true]]);
    eq(env.bq.filter(c => c.job === 'fk').length, 1);
    // no trial; this hour's 2 already sent: noted while ON, still noted when OFF in the same hour, sent the next hour OFF
    check = 1;
    const hour = Math.floor(NOW / HOUR);
    env = makeEnv(job => (check === 1 && job === 'fk' ? liftRows(1, 5) : []));
    Object.assign(env.b.ev('GEN').settings, { early_wave_new_trial_days: 0 });
    env.g.props.set('EWS_SRC_DAY', JSON.stringify({ v: 1, on: {}, d: {}, lh: [hour, 2], ld: [DAY, 2] }));
    addFakeLane(env.b, { src: 'bwl' });
    env.b.ewsRunSwitches_({ edFake: true });
    eq(signals(env.b.bqEarlyDetectionRows_(30)).length, 0);
    check = 2;
    env.b.ewsRunSwitches_({});
    env.g.clock.now += 15 * MIN;
    eq(new Date(NOW + 15 * MIN).getUTCHours(), new Date(NOW).getUTCHours());  // the same UTC hour
    eq(signals(env.b.bqEarlyDetectionRows_(30)).length, 0);
    env.g.clock.now = (hour + 1) * HOUR + 5 * MIN;
    eq(signals(env.b.bqEarlyDetectionRows_(30)).length, 1);
    const rec = JSON.parse(env.g.props.get('EWS_SRC_DAY'));
    eq([rec.lh, rec.ld[1]], [[hour + 1, 1], 3]);
  });

  test('new lanes (trial): a source\'s trial starts the first day its job is collected, not the day its switch goes ON: a switch ON with no source built yet, or a lane with nothing to read, sets no date; the first date is kept on later days', () => {
    const env = makeEnv(() => []);
    let ready = false;
    addFakeLane(env.b, { src: 'bwl', ready: () => ready });
    env.b.ewsRunSwitches_({ edFake: true, edAmie: true, edBwLive: true });
    env.b.bqEarlyDetectionRows_(30);
    eq(JSON.parse(env.g.props.get('EWS_SRC_DAY')).on, {});
    ready = true;
    env.g.clock.now += 15 * MIN;
    env.b.bqEarlyDetectionRows_(30);
    eq(JSON.parse(env.g.props.get('EWS_SRC_DAY')).on, { bwl: DAY });
    env.g.clock.now += 3 * 24 * HOUR;
    env.b.bqEarlyDetectionRows_(30);
    eq(JSON.parse(env.g.props.get('EWS_SRC_DAY')).on, { bwl: DAY });
    eq([B.ewsSrcOfDef_({ sw: 'edAmie' }), B.ewsSrcOfDef_({ sw: 'edFake' }), B.ewsSrcOfDef_({ sw: 'edAmie', src: 'bwl' })], ['ami', 'new', 'bwl']);
  });

  test('new lanes (E9): the day-bar flag is raised only when the day bar held new-lane texts back, not when the check\'s own share did', () => {
    const cfg = B.ewsNewCfg_();
    const need = range(0, 300).map(i => ({ chash: `t${i}` })).concat(range(0, 200).map(i => ({ chash: `n${i}`, nl: true })));
    // 100 left for the day and 100 left in the check: the check's share held the rest back
    let sp = B.ewsEmbedSplit_(need, 400, 0, cfg.embedPerDay - 100, NOW, cfg);
    eq([sp.today, sp.fresh, sp.barred], [300, 100, false]);
    // 50 left for the day: the bar held 50 back
    sp = B.ewsEmbedSplit_(need, 400, 0, cfg.embedPerDay - 50, NOW, cfg);
    eq([sp.today, sp.fresh, sp.barred], [300, 50, true]);
    // nothing left for the day and today's lanes fill the check: barred (the new lanes would have had 100)
    sp = B.ewsEmbedSplit_(range(0, 500).map(i => ({ chash: `u${i}` })).concat(need.slice(300)), 400, 0, cfg.embedPerDay, NOW, cfg);
    eq([sp.today, sp.fresh, sp.barred], [400, 0, true]);
    // no bar and no share reached: nothing held back
    sp = B.ewsEmbedSplit_(need.slice(250), 400, 0, 0, NOW, cfg);
    eq([sp.today, sp.fresh, sp.barred], [50, 200, false]);
  });

  test('new lanes (stitching): the post-key index keeps the new lanes\' keys ahead of today\'s when it is full (today\'s keep at least 3,000 places), stays under 4 cache items, and drops every key older than 72 hours, its own and today\'s', () => {
    const h0 = Math.floor(NOW / HOUR);
    const keys = (n, tag) => Array.from({ length: n }, (_, j) => `${tag}${j.toString(16).padStart(23, '0')}`);
    const index = {};
    for (let h = 0; h < 10; h++) { index[String(h0 - h)] = keys(1500, 'a'); index[`t${h0 - h}`] = keys(3000, 'b'); }
    const recs = B.ewsNkRecords_(index);
    const count = pred => recs.filter(r => pred(String(r[0]))).reduce((n, r) => n + r[1].length, 0);
    eq([count(h => !h.startsWith('t')), count(h => h.startsWith('t')), recs.filter(r => r[0].startsWith('t')).every(r => r[0] === `t${h0}`)], [9000, 3000, true]);
    eq(B.ewsChunks_(recs).length <= 4 && B.ewsChunks_(recs).every(ch => JSON.stringify(ch).length <= B.ev('EWS_CACHE_ITEM_CHARS_')), true);
    // few new-lane keys: today's fill the rest
    const few = { [String(h0)]: keys(500, 'a'), [`t${h0}`]: keys(3000, 'b'), [`t${h0 - 1}`]: keys(3000, 'b'), [`t${h0 - 9}`]: keys(9000, 'b') };
    const r2 = B.ewsNkRecords_(few);
    eq([r2.reduce((n, r) => n + r[1].length, 0), r2.filter(r => r[0] === `t${h0 - 9}`).reduce((n, r) => n + r[1].length, 0)], [12000, 5500]);
    eq(B.ewsNkRecords_({}), []);
    // in a check: keys older than 72 hours go, both kinds; this check's keys come in
    const env = stitchEnv([{ fk: [row({ lane: 'bwl', mid: 'BWL|nk1', platform: 'reddit', url: 'https://www.reddit.com/r/google/comments/1nk/t/', author: 'nk', chash: 'nk1', txt: lone('nk', 1) })],
      c1: [row({ mid: 'SONAR|nk2', chash: 'nk2', txt: lone('nk', 2) })] }], { before: (i, e) => {
      e.g.cache.set('ews1:nk:0', JSON.stringify([[String(h0 - 73), ['f'.repeat(24)]], [`t${h0 - 73}`, ['e'.repeat(24)]], [String(h0 - 71), ['d'.repeat(24)]], [`t${h0 - 71}`, ['c'.repeat(24)]]]));
      e.g.props.set('EWS_STATE', JSON.stringify({ v: 1, marks: {}, jobs: {}, day: {}, nk: 1 }));
    } }).run();
    const got = {};
    env.items('nk:').forEach(r => { got[r[0]] = (got[r[0]] || []).concat(r[1]); });
    eq(Object.keys(got).sort(), [String(h0 - 71), String(h0), `t${h0 - 71}`, `t${h0}`].sort());
    eq([got[String(h0)].length, got[`t${h0}`].length], [1, 1]);
  });

  test('new lanes (E10): the late split holds in the producer too: a post of ami / bwl first seen more than early_wave_new_late_minutes after posting is slow (amis / bwls) whatever its job said; within that it stays real time', () => {
    const of = (lane, lateMin) => B.ewsPostOf_({ kind: 'post', lane, mid: 'X|1', url: 'https://www.reddit.com/r/google/comments/1l/t/', platform: 'reddit',
      author: 'a', posted_ms: NOW - lateMin * MIN, seen_ms: NOW, txt: 'w' });
    eq([['bwl', 181], ['bwl', 180], ['ami', 240], ['ami', 30], ['sonar', 600], ['bw', 600]].map(([l, m]) => [of(l, m).lane, of(l, m).slow]),
      [['bwls', true], ['bwl', false], ['amis', true], ['ami', false], ['sonar', false], ['bw', true]]);
    const b = loadBot(makeGoogle(NOW).services);
    b.ev('GEN').settings.early_wave_new_late_minutes = 300;
    eq(b.ewsPostOf_({ kind: 'post', lane: 'bwl', mid: 'X|1', url: 'https://www.reddit.com/r/google/comments/1l/t/', posted_ms: NOW - 240 * MIN, seen_ms: NOW, txt: 'w' }).lane, 'bwl');
  });

  test('new lanes: the early watch leaves out the new lanes\' members on the leave-out lists, as the promotion does; with no list it is as before', () => {
    const story = lstory([sm(0), sm(1), nm(2, { a: 'Reddit:gone' })]);
    eq(B.ewsWatchPick_([story], [], {}, NOW, 3).length, 1);
    eq(B.ewsWatchPick_([story], [], {}, NOW, 3, { authors: new Set(['gone']), big: new Set() }).length, 0);
    eq(B.ewsWatchPick_([story], [], {}, NOW, 3, { authors: new Set(['other']), big: new Set() }).length, 1);
  });
};
