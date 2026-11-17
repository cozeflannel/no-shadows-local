// Step S8 of the open-engine plan (velocity made correct), what is built of it: under Control row 51 with the setting
// open_velocity_fix (true), a post whose hour was already counted for good (a late post) and a post the bot read more
// than open_velocity_lag_minutes (60) after it was posted give no velocity row, so the baseline and the current count
// hold the same kind of posts. With row 51 OFF, or the setting false, velocity is as before. Every post is made up.
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

  /** A producer run with BigQuery faked: Sonar's job (c1) answers `rows`; the velocity rows it kept ('acc'). */
  function velocityRows(rows, o) {
    const x = o || {};
    const g = makeGoogle(NOW);
    const orig = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (!String(url).startsWith('https://bigquery.googleapis.com/')) return orig(url, params);
      const body = JSON.parse((params && params.payload) || '{}');
      const job = (body.labels && body.labels.lane) || '';
      const answer = job === 'c1' ? rows : [];
      return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify({
        jobComplete: true, jobReference: { projectId: 'brand-social-central-data', jobId: `ews_${job}`, location: body.location || 'US' },
        schema: { fields: EWS_COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: answer.map(r => ({ f: EWS_COLS.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })) }) };
    };
    const b = loadBot(g.services, g.clock);
    if (x.settings) Object.assign(b.ev('GEN').settings, x.settings);
    b.ewsRunSwitches_(x.on ? { openEngine: true, earlyWave: true } : {});
    b.bqEarlyDetectionRows_(30);
    const acc = JSON.parse(g.cache.get('ews1:acc') || 'null');
    // the rows kept (hours still open) and whether a closed hour was counted into the rollup (a late post's)
    return [acc ? acc.rows.length : 0, String(g.props.get('EWS_ROLLUP') || '')];
  }
  let seq = 0;
  const post = (posted, seen) => {
    seq++;
    return { kind: 'post', lane: 'sonar', mid: `SONAR|v${seq}`, url: `https://x.com/vuser${seq}/status/21700000000000${String(seq).padStart(5, '0')}`,
      platform: 'twitter', author: `vuser${seq}`, audience: 300, eng: 4, posted_ms: posted, seen_ms: seen,
      txt: `Pixel phone screen keeps freezing after the update, case ${seq}, again and again today`, topic: 'Pixel',
      chash: `vh${seq}`, sig: `vs${seq}`, risk: '', brand: true };
  };

  test('open velocity (S8): in a check, a post read soon after posting counts and a post read 70 minutes after posting does not, with row 51 ON; with it OFF, or open_velocity_fix false, both count as before; the lag raised to 2 hours counts both', () => {
    const rows = () => [post(NOW - 20 * MIN, NOW - 18 * MIN), post(NOW - 80 * MIN, NOW - 10 * MIN), post(NOW - 4 * HOUR + 5 * MIN, NOW - 15 * MIN)];
    // (the late post's hour is closed: with the fix off it is counted into the rollup at once, a late post pulling a
    // closed hour; with it on it never is)
    const on = velocityRows(rows(), { on: true });
    const off = velocityRows(rows(), { on: false });
    const fixOff = velocityRows(rows(), { on: true, settings: { open_velocity_fix: false } });
    const lag2h = velocityRows(rows(), { on: true, settings: { open_velocity_lag_minutes: 120 } });  // the lag raised to 2 hours
    // (the 4-hour-old post's hour is closed: it keeps no row either way in a first check; the rule's own test is below)
    eq([on[0], off[0], fixOff[0], lag2h[0]], [1, 2, 2, 2]);
  });

  test('open velocity (S8): the rule itself: a closed hour, the lag, and a post with no read time', () => {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    const fix = { lagMs: 60 * MIN };
    eq([b.ewsVelocityCounts_({ t: NOW - 10 * MIN, seen: NOW - 5 * MIN }, NOW, fix), b.ewsVelocityCounts_({ t: NOW - 61 * MIN, seen: NOW }, NOW, fix),
      b.ewsVelocityCounts_({ t: NOW - 59 * MIN, seen: NOW }, NOW, fix), b.ewsVelocityCounts_({ t: NOW - 3 * HOUR - MIN, seen: 0 }, NOW, fix),
      b.ewsVelocityCounts_({ t: NOW - 90 * MIN, seen: 0 }, NOW, fix), b.ewsVelocityCounts_({ t: NOW - 3 * HOUR }, NOW, null)],
    [true, false, true, false, true, true]);
    eq(b.openVelocityFix_(), null);
    b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    eq(b.openVelocityFix_(), { lagMs: 60 * MIN });
  });
};
