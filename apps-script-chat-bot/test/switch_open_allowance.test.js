// Step S5 of the open-engine plan (O3 "Full reviews most serious first; nothing dropped while there is room; the rest
// wait"): under Control row 51 the allowance's counts (5 a check, the hour's 10 and 6 ordinary, the day's 150) are no
// longer refusals. Serious stories go first; the queue holds 24; a story that does not fit waits unmarked and comes back
// at every check while it is in the producer's 180 minutes; the drain has no count a run (its time bounds it). With row
// 51 OFF the allowance is as it was (switch_ed_allowance.test.js and switch_ed_burst.test.js). Every story is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const MIN = 60 * 1000;

  const rep = (n, i) => ({ platform: 'X', author_handle: `acct${n}_${i}`, followers: 900, engagement_total: 20,
    published_at: '2026-10-14 11:42 UTC', url: `https://x.com/acct${n}_${i}/status/21600000000${String(n).padStart(4, '0')}${i}`,
    snippet: `Story ${n}: post ${i} about the same problem with the update.` });
  /** Story `n` (serious when `serious`: a taxonomy hint raised it), its own posts and cluster. */
  const story = (n, serious) => golden.rows.story({
    alert_id: `ED-CLU-clu_open${n}-202610141200`, cluster_id: `clu_open${n}`, signal_key: `clu_open${n}`,
    headline: `Low-tier claim cluster (6 accounts): ${serious ? 'serious' : 'ordinary'} story ${n}`, priority_hint: 'P2',
    primary_url: rep(n, 0).url, tag_raised: serious, risk_groups: '',
    representative_posts_json: JSON.stringify([0, 1, 2, 3].map(i => rep(n, i))) });

  /**
   * The one-space setup under the allowance (6 ordinary an hour), the fast triage OFF; `stories` all found at the first
   * check; each review takes 40 s of the run; `runs` minutes of runs. Row 51 ON unless `off`.
   */
  function run(stories, runs, off, o) {
    const x = o || {};
    const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF,
      { early_detection_first: true, early_wave_reviews_per_hour: 6, early_wave_reviews_per_day: 150 }));
    [38, 39, 40].forEach(r => w.sh.getRange(r, 2).setValue('OFF'));
    if (!off) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
    w.t.bot.__reviewed = [];
    w.t.bot.__run = 0;
    w.t.bot.__hold = false;
    w.t.bot.ev(`edReviewAndPost_ = (f => (ctx, row, report) => { __clock.now += ${x.cost || 40000}; __reviewed.push([__run, String(row.headline || "")]); return f(ctx, row, report); })(edReviewAndPost_)`);
    w.t.bot.ev('poll = (p => () => { __run++; return p(); })(poll)');
    w.t.bot.ev('edDrainQueue_ = (d => (ctx, report) => (__hold ? null : d(ctx, report)))(edDrainQueue_)');
    w.rec.collect('setup');
    w.rec.step('the first run', 1);
    if (x.hold) w.t.bot.__hold = true;
    w.rec.step('the stories', 15, () => { w.feed.stories = stories; });
    if (x.later) w.rec.step('a later check', 15, () => { w.feed.stories = stories.concat(x.later); });
    w.t.bot.__hold = false;
    for (let i = 0; i < runs; i++) w.rec.step('a run', 1);
    const props = w.t.bot.PropertiesService.getScriptProperties();
    const day = w.t.bot.edDayNumbers_(props, w.t.bot.edDayState_(props));
    const queue = w.t.bot.edQueueList_(props);
    const perRun = {};
    w.t.bot.__reviewed.forEach(([r]) => { perRun[r] = (perRun[r] || 0) + 1; });
    return { reviewed: w.t.bot.__reviewed.map(([, h]) => h), perRun: Object.values(perRun), day, queue, logs: w.t.g.logs,
      deferred: JSON.parse(w.t.g.props.get('EARLY_DETECTION_DEFERRED') || '{}') };
  }
  const n = h => Number((String(h).match(/story (\d+)$/) || [])[1]);

  test('open allowance (S5): 25 stories, 10 of them serious, in one check: with row 51 ON all 25 are reviewed over the next runs, the 10 serious first, none ends "Never reviewed" while fresh, and C19\'s numbers add up; with row 51 OFF the allowance reviews fewer in the same time', () => {
    const stories = Array.from({ length: 25 }, (_, i) => story(i + 1, i % 5 < 2));  // 1, 2, 6, 7, ... are serious
    const r = run(stories, 40, false, { cost: 20000 });
    eq(r.reviewed.length, 25);
    assert.ok(Math.max(...r.perRun) > 2, `reviews a run: ${r.perRun.join(', ')}`);  // no count of 2 a run: its time bounds it
    const firstTen = r.reviewed.slice(0, 10);
    eq(firstTen.every(h => /serious/.test(h)), true, firstTen.join(' | '));
    eq(new Set(r.reviewed.map(n)).size, 25);
    eq([r.day.never, r.day.found, r.day.cards + r.day.under + r.day.letgo + r.day.never + r.day.waiting], [0, 25, 25]);
    const off = run(stories, 40, true);
    assert.ok(off.reviewed.length < 25, `${off.reviewed.length} with row 51 OFF`);
  });

  test('open allowance (S5): a full queue (24) keeps the lowest-ranked stories waiting, unmarked: they come back at the next checks and are reviewed, none ended while fresh; a serious one takes the lowest-ranked place', () => {
    const stories = Array.from({ length: 30 }, (_, i) => story(i + 1, false)).concat([story(31, true)]);
    const r = run(stories, 0);
    eq([r.queue.length <= 24, r.day.never], [true, 0]);
    // the ones that did not fit wait, remembered with the queue's count (the reason they would give)
    const waiting = Object.values(r.deferred).filter(e => e[1] === 'r');
    eq([waiting.length, waiting.every(e => e[3] === 24)], [7, true]);
    const later = run(stories, 70);
    eq([later.reviewed.length, later.day.never, /serious/.test(later.reviewed[0])], [31, 0, true]);
  });

  test('open allowance (S5): a serious story that comes when the queue of 24 is full goes in (none is pushed out unreviewed) and is reviewed first', () => {
    const r = run(Array.from({ length: 30 }, (_, i) => story(i + 1, false)), 60, false, { hold: true, later: [story(40, true)] });
    eq([/serious story 40$/.test(r.reviewed[0]), r.day.never, r.reviewed.length], [true, 0, 31]);
  });

  test('open allowance (S5): the producer\'s buffer under row 51 keeps 300 rows in several cache items (their counts in its state) and reads them back; a dropped item is counted as lost on the Engine tab; with row 51 OFF one item of 30, as before', () => {
    const w = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
    const b = w.t.bot;
    const rows = Array.from({ length: 320 }, (_, i) => ({ alert_id: `ED-CLU-buf${i}`, _at: 1, headline: 'x'.repeat(400) }));
    const st = {};
    const items = {};
    b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    b.ewsBufferPut_(items, st, rows);
    eq([st.bf.reduce((s, x) => s + x, 0), st.bf.length > 1, items.buf], [300, true, undefined]);
    const cache = b.ewsCache_();
    b.ewsCachePut_(cache, items);
    eq(b.ewsReadBuffer_(cache, st).map(r => r.alert_id), rows.slice(-300).map(r => r.alert_id));
    b.engRunStart_();
    cache.remove(b.ev('EWS_CACHE_PREFIX_') + 'bf:1');
    eq([b.ewsReadBuffer_(cache, st).length, b.ev('ENG_RUN_').n.lost], [300 - st.bf[1], st.bf[1]]);
    b.ewsRunSwitches_({});
    const off = {};
    const st2 = { bf: [1] };
    b.ewsBufferPut_(off, st2, rows);
    eq([off.buf.length <= 30, Object.keys(off).filter(k => /^bf:/.test(k)), st2.bf], [true, [], undefined]);
  });

  test('open allowance (S5): the reasons a waiting story gives when it leaves the window unreviewed under row 51: a full queue names how many went first; the safety stop and the pace say so', () => {
    const w = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
    const b = w.t.bot;
    eq([b.edDeferredWhy_('r', 'now', 24), b.edDeferredWhy_('s', 'now'), b.edDeferredWhy_('p', 'now')], [
      'It waited 3 hours while 24 more serious stories were reviewed first.',
      'Today\'s safety stop of 2,000 reviews was reached (Burson\'s alerts went on).',
      'The day\'s run time was nearly used, so only serious stories were reviewed.']);
    b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    eq([b.openQueueMax_(), b.edLookbackMinutes_({ bq_lookback_minutes: 30 }, 0, 0)], [24, 180]);
    b.ev('GEN.settings.open_queue_max = 30');
    eq(b.openQueueMax_(), 30);
    b.ewsRunSwitches_({});
    eq(b.openQueueMax_(), 12);
  });
};
