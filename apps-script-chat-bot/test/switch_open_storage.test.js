// Step S5 of the open-engine plan: what Early Detection keeps in script properties under Control row 51, at its worst:
// the queue of 24 (one property for the list and one for each signal's row), the list of signals left for a later check
// (150, with the full queue's count), and the open engine's own properties; each property at most 8,800 characters and
// all of them together at most 300 KB. Every story here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, world, NOW } = H;

  test('open storage (S5): the queue of 24 at its worst (every row as long as a row may be) keeps each property under 8,800 characters; with the waiting list of 150, the record of run time, the day\'s counts and the Engine tab\'s numbers all Early Detection\'s properties stay under 300 KB', () => {
    const w = world();
    const b = w.bot;
    b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    const props = w.g.services.PropertiesService.getScriptProperties();
    const long = (s, n) => (s + ' ').repeat(Math.ceil(n / (s.length + 1))).slice(0, n);
    for (let i = 0; i < 30; i++) {
      const reps = Array.from({ length: 10 }, (_, j) => ({ platform: 'X', author_id: `author_${i}_${j}`, audience_size: 4999, engagement: 499,
        posted_at: '2026-10-14T11:42:00Z', url: `https://x.com/author_${i}_${j}/status/2160000000000${String(i * 10 + j).padStart(6, '0')}`,
        snippet: long(`Story ${i} post ${j} says the update broke it`, 600) }));
      const row = { alert_id: `ED-CLU-clu_storage${i}-202610141200`, created_utc: '2026-10-14 12:00 UTC', signal_type: 'CLUSTER_EMERGENCE',
        cluster_id: `clu_storage${i}`, signal_key: `clu_storage${i}`, headline: long(`Low-tier claim cluster (9 accounts): story ${i}`, 200),
        topic_product: 'Chrome', priority_hint: 'P1', unique_low_tier_authors: 9, mention_count: 12, platforms_csv: 'X, Reddit, TikTok',
        platform_count: 3, primary_url: reps[0].url, representative_posts_json: JSON.stringify(reps), taxonomy_hint: long('Product - Other', 200) };
      b.edQueuePut_(props, row, NOW + i * MIN_(), { ser: i % 2 ? 1 : undefined });
    }
    const list = b.edQueueList_(props);
    assert.ok(list.length >= 24 && list.length <= 28, `${list.length}`);  // 24, and up to 4 more places for serious ones
    const deferred = {};
    for (let i = 0; i < 150; i++) deferred[b.hashText_(`id:ED-CLU-clu_wait${i}-202610141200`)] = [29340000 + i, 'r', 999999, 24];
    props.setProperty('EARLY_DETECTION_DEFERRED', JSON.stringify(deferred));
    // the open engine's own, at their worst (their tests make them so: switch_run_ledger, switch_engine_tab)
    props.setProperty('RUN_LEDGER', 'x'.repeat(8800));
    props.setProperty('ENGINE_ACC', 'x'.repeat(8800));
    props.setProperty('OPEN_DAY', JSON.stringify({ d: '2026-10-14', rev: 99999, ql: 999999, wc: 9999999, gb: 99999.999, stop: { k: 'rev', at: NOW },
      h: { k: 'stop', at: NOW }, w: { gemini: 9999, short: 9999, burson: 9999, guard: 9999, pace: 9999, bq: 9999, bw: 9999, storage: 9999, carried: 9999 } }));
    const ours = k => /^(ED_|EARLY_DETECTION|RUN_LEDGER|OPEN_DAY|ENGINE_ACC|ED_TAB)/.test(k);
    const keys = Array.from(w.g.props.keys()).filter(ours);
    const sizes = keys.map(k => [k, String(w.g.props.get(k)).length]);
    sizes.forEach(([k, n]) => assert.ok(n <= 8800, `${k}: ${n}`));
    const rowsN = sizes.filter(([k]) => k.indexOf('ED_ALERT_Q_') === 0).length;
    eq(rowsN, list.length);
    // the worst case: 28 rows of 8,000 characters (ED_ROW_MAX_CHARS_), the other properties as above, the seen map's three
    // and the day's numbers (EARLY_DETECTION_TODAY) at 8,800 each
    const others = sizes.filter(([k]) => k.indexOf('ED_ALERT_Q_') !== 0 && !/^EARLY_DETECTION_(SEEN|TODAY)/.test(k)).reduce((s, [, n]) => s + n, 0);
    const worst = 28 * 8000 + others + 4 * 8800;
    assert.ok(worst <= 300 * 1000, `${worst}`);
  });

  function MIN_() { return 60 * 1000; }
};
