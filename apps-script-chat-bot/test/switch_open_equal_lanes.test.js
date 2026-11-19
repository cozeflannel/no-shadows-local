// Step S9 of the open-engine plan (equal standing), what is built of it: under Control row 51 with the setting
// open_equal_lanes (true), freshness by the bot's own read time replaces the source's name: a fresh post of any source
// (Tubular's too) may start a story, and a late one (read more than open_fresh_minutes, 180, after posting), of any
// source, only joins one; each of a signal's posts says which source it came from; and the story's review gets one line
// when most of its posts come from a source whose same-story grouping has not been checked yet (measured bars from
// open_lane_bars or the script property OPEN_LANE_BARS mean it has). With row 51 OFF, or the setting false, as before.
'use strict';

module.exports = H => {
  const { test, eq, NOW, makeGoogle, loadBot } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const EWS_COLS = [
    ['kind'], ['lane'], ['mid'], ['url'], ['platform'], ['author'],
    ['audience', 'INTEGER'], ['eng', 'INTEGER'], ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'],
    ['txt'], ['topic'], ['chash'], ['sig'], ['risk'], ['brand', 'BOOLEAN'],
  ];
  const TOPIC = 'Waymo robotaxi stopped dead in the intersection blocking an ambulance during rush hour traffic';
  const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];

  function bot(o) {
    const x = o || {};
    const g = makeGoogle(NOW);
    const orig = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (!String(url).startsWith('https://bigquery.googleapis.com/')) return orig(url, params);
      const body = JSON.parse((params && params.payload) || '{}');
      const job = (body.labels && body.labels.lane) || '';
      const answer = (x.rows && x.rows[job]) || [];
      return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify({
        jobComplete: true, jobReference: { projectId: 'brand-social-central-data', jobId: `ews_${job}`, location: body.location || 'US' },
        schema: { fields: EWS_COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: answer.map(r => ({ f: EWS_COLS.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })) }) };
    };
    const b = loadBot(g.services, g.clock);
    if (x.settings) Object.assign(b.ev('GEN').settings, x.settings);
    b.ewsRunSwitches_(x.on ? { openEngine: true, earlyWave: true } : {});
    return { g, b };
  }
  /** Five fresh Tubular videos by five accounts on one story (us-central1's job), posted `ago` before the check. */
  const tubular = ago => WORDS.slice(0, 5).map((w, i) => ({ kind: 'post', lane: 'tub', mid: `TUB|v${i}`, url: `https://www.youtube.com/watch?v=tubvid${i}`,
    platform: 'youtube', author: `channel${i}`, audience: 300, eng: 4, posted_ms: NOW - ago - i * MIN, seen_ms: NOW - ago - i * MIN + 5 * MIN,
    txt: `${TOPIC} ${w}`, topic: 'Waymo', chash: `tv${i}`, sig: `ts${i}`, risk: '', brand: true }));
  const stories = env => {
    let n = 0;
    for (const [k, v] of env.g.cache.entries()) if (k.startsWith('ews1:cl:')) n += (JSON.parse(v) || []).length;
    return n;
  };

  test('equal lanes (S9): five fresh Tubular videos start a story with row 51 ON; with it OFF, or open_equal_lanes false, Tubular never starts one (by its name), as before', () => {
    const run = o => {
      const env = bot(Object.assign({ rows: { c1: tubular(30 * MIN) } }, o));
      env.b.bqEarlyDetectionRows_(30);
      return stories(env);
    };
    eq([run({ on: true }) > 0, run({ on: false }), run({ on: true, settings: { open_equal_lanes: false } })], [true, 0, 0]);
  });

  test('equal lanes (S9): a post read more than 3 hours after it was posted is late, whatever its source; with equal standing off a post is late only by its source\'s name', () => {
    const { b } = bot({ on: true });
    eq([b.ewsLate_({ t: NOW - 30 * MIN, slow: true }, NOW), b.ewsLate_({ t: NOW - 4 * HOUR, slow: false }, NOW), b.ewsLate_({ t: NOW - 179 * MIN }, NOW)],
      [false, true, false]);
    b.ev('GEN.settings.open_fresh_minutes = 60');
    eq(b.ewsLate_({ t: NOW - 61 * MIN }, NOW), true);
    const off = bot({ on: false }).b;
    eq([off.ewsLate_({ t: NOW - 30 * MIN, slow: true }, NOW), off.ewsLate_({ t: NOW - 4 * HOUR, slow: false }, NOW)], [true, false]);
  });

  test('equal lanes (S9): each post of a signal says which source it came from (row 51 ON), and the review gets one line when most of them come from a source not yet checked; none for Sonar, for a source with measured bars, or with row 51 OFF', () => {
    const { b, g } = bot({ on: true });
    const reps = [{ i: 'TUB|a', p: 'YouTube', a: 'YouTube:x', u: 'https://www.youtube.com/watch?v=a', t: NOW, s: 'x' },
      { i: 'TUB|b', p: 'YouTube', a: 'YouTube:y', u: 'https://www.youtube.com/watch?v=b', t: NOW, s: 'y' },
      { i: 'SONAR|c', p: 'X', a: 'X:z', u: 'https://x.com/z/status/1', t: NOW, s: 'z' }];
    const json = b.ewsRepsJson_(reps);
    eq(JSON.parse(json).map(p => p.source), ['tub', 'tub', 'sonar']);
    const line = b.openReviewerLine_({ representative_posts_json: json });
    eq(line, 'Most of these posts come from Tubular, where the same-story grouping has not been checked yet: weigh whether they really tell one story.');
    // the review's prompt carries it
    const ed = b.edFromRow_({ alert_id: 'ED-CLU-x', signal_type: 'CLUSTER_EMERGENCE', headline: 'Waymo blocks an ambulance', primary_url: reps[0].u,
      representative_posts_json: json });
    eq(ed.lanesLine, line);
    // mostly Sonar: no line; Tubular measured (the property step S1 writes): no line
    eq(b.openReviewerLine_({ representative_posts_json: b.ewsRepsJson_([reps[2], reps[2], reps[0]]) }), '');
    g.props.set('OPEN_LANE_BARS', JSON.stringify({ date: '2026-11-17', lanes: { tub: { start: 0.83, join: 0.85 } } }));
    eq([b.openReviewerLine_({ representative_posts_json: json }), b.openLaneBars_()], ['', { tub: { start: 0.83, join: 0.85 } }]);
    b.ev(`GEN.settings.open_lane_bars = '{"bw": {"start": 0.84, "join": 0.86}}'`);
    eq(b.openLaneBars_(), { bw: { start: 0.84, join: 0.86 } });  // the setting, when filled, wins
    g.props.set('OPEN_LANE_BARS', 'not json');
    b.ev("GEN.settings.open_lane_bars = ''");
    eq(b.openLaneBars_(), {});
    // row 51 OFF: no source on the posts, no line
    const off = bot({ on: false }).b;
    const offJson = off.ewsRepsJson_(reps);
    eq([JSON.parse(offJson)[0].source, off.openReviewerLine_({ representative_posts_json: json }), off.edFromRow_({ alert_id: 'x', representative_posts_json: json }).lanesLine],
      [undefined, '', undefined]);
  });
  test('equal lanes (S9): in a run, the story review\'s instructions carry the line when most of the story\'s posts come from Tubular (row 51 ON); none with row 51 OFF', () => {
    const golden = require('./golden_flows')(H);
    const run = on => {
      const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true }));
      if (on) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
      w.rec.collect('setup');
      w.rec.step('the first run', 1);
      const base = golden.rows.story({});
      const reps = JSON.parse(base.representative_posts_json).map((p, i) => Object.assign({}, p, { source: i < 3 ? 'tub' : 'sonar' }));
      w.rec.step('the story', 15, () => { w.feed.stories = [Object.assign({}, base, { representative_posts_json: JSON.stringify(reps) })]; });
      [1, 1].forEach(m => w.rec.step('after', m));
      return w.t.g.vertex.calls.map(c => JSON.stringify(c.payload)).filter(s => /early_detection_call/.test(s));
    };
    const on = run(true);
    eq([on.length > 0, on.every(s => s.includes('Most of these posts come from Tubular'))], [true, true]);
    eq(run(false).some(s => s.includes('Most of these posts come from')), false);
  });
};
