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
};
