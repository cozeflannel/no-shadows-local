// Early Detection under the Auto-correct flow's allowance: a story signal left for the next check (the check's 5, the
// hour's limits) that no later check reads again in time (checks were skipped, or busier stories filled the rows a
// check reads) still gets its one ending. It is remembered (BigQuery.gs ED_DEFERRED_PROP_, its tab details in the
// script cache) and, at the first check that runs after it left the window a check reads, ends "Never reviewed", with
// its row on the Early Detection tab, counted once. With the allowance off nothing is remembered.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const ends = require('./ed_endings')(H);
  const MIN = 60 * 1000;
  const props = w => w.t.g.services.PropertiesService.getScriptProperties();
  const recsOf = w => w.t.bot.edNotesOfRun_().map(r => w.t.bot.edNoteObj_(r));
  const serious = (n, at) => ends.signal(n, { at, words: `Pixel owners say app ${n} leaks their photos, story ${n}` });
  const ordinary = (n, at) => ends.signal(n, { at, words: `Pixel owners say app ${n} is slow DECLOW, story ${n}` });
  const madeAt = r => Date.parse(r.created_utc.replace(' UTC', 'Z').replace(' ', 'T'));
  const tabRows = w => {
    const tab = w.t.sheet().getSheetByName('Early Detection');
    return tab ? tab.rows.slice(4).map(r => ({ id: String(r[9]).replace(/^'/, ''), outcome: String(r[1]).replace(/^'/, ''),
      why: String(r[3]).replace(/^'/, '') })) : [];
  };
  const times = (from, to) => {
    const out = [];
    const m = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    for (let x = m(from); x <= m(to); x++) out.push(`${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`);
    return out;
  };

  /**
   * A day in the one-space setup with the default settings, every minute from 09:01 to `until`. The producer hands over,
   * as it really reads, only the rows made within the check's lookback, more accounts first, then the oldest first, at
   * most `cap` (25). `batches`: [[made at, first story, how many, accounts]] (odd ones serious, even ones ordinary);
   * `skip`: [[from, to]]: no check runs then (as when the API guard or a busy run skips it). Returns what was read, what
   * ended, the tab and the numbers.
   */
  const day = o => {
    const w = ends.world({ flow: 'one-space', row46: false, settings: o.settings || {} });
    const rows = [];
    o.batches.forEach(([at, first, n, au]) => {
      for (let i = 0; i < n; i++) {
        const r = (i % 2 ? ordinary : serious)(first + i, at);
        if (au) r.unique_low_tier_authors = au;
        rows.push(r);
      }
    });
    const read = new Set();
    w.t.bot.bqEarlyDetectionRows_ = minutes => {
      const now = w.t.g.clock.now;
      const out = rows.filter(r => madeAt(r) >= now - minutes * MIN && madeAt(r) <= now)
        .sort((a, b) => b.unique_low_tier_authors - a.unique_low_tier_authors || madeAt(a) - madeAt(b))
        .slice(0, o.cap || 25).map(r => JSON.parse(JSON.stringify(r)));
      out.forEach(r => read.add(r.alert_id));
      return out;
    };
    let clock = '';
    w.t.bot.__edDeferredSkip = () => (o.skip || []).some(s => clock >= s[0] && clock <= s[1]);
    w.t.bot.ev('earlyWaveCheck_ = (check => function (ctx) { return __edDeferredSkip() ? null : check(ctx); })(earlyWaveCheck_)');
    const endings = {};
    const queued = new Set();
    const sizes = [];
    times('09:01', o.until || '12:30').forEach(time => {
      clock = time;
      const look = w.run(time);
      recsOf(w).forEach(r => { (endings[r.id] = endings[r.id] || []).push(r.outcome); });
      w.t.bot.edQueueList_(props(w)).forEach(e => queued.add(e.id));
      const n = w.t.bot.edDayNumbers_(props(w));
      eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `the run at ${time}: ${JSON.stringify(n)}`);
      assert.ok(!look.logs.map(String).some(l => /did not add up/.test(l)), `the run at ${time}`);
      sizes.push(String(w.t.g.props.get('EARLY_DETECTION_DEFERRED') || '').length);
    });
    return { w, read, endings, queued, n: w.t.bot.edDayNumbers_(props(w)), tab: tabRows(w), sizes,
      deferred: w.t.g.props.get('EARLY_DETECTION_DEFERRED') || null };
  };

  const everyReadEndsOnce = (r, label) => {
    const ids = Array.from(r.read);
    const lost = ids.filter(id => !r.endings[id]);
    eq(lost, [], `${label}: signals read that never ended`);
    eq(ids.filter(id => r.endings[id].length !== 1), [], `${label}: signals with more than one ending`);
    eq(r.n.found, ids.length, `${label}: found is the number of signals read`);
    eq(r.n.waiting, 0, label);
    ids.forEach(id => eq(r.tab.filter(x => x.id === id).length, 1, `${label}: ${id} has one row on the tab`));
  };

  test('early detection deferred: no check from 10:15 to 10:40 (the API guard, busy runs) with 25 stories made at 09:30: the ones left for a later check that no check read again end "Never reviewed" at the next check, each once, with its row on the tab; found is every signal read', () => {
    const r = day({ batches: [['09:30', 1, 25]], skip: [['10:15', '10:40']] });
    eq(r.read.size, 25);
    everyReadEndsOnce(r, 'skipped checks');
    const late = r.tab.filter(x => /read it again in time/.test(x.why));
    assert.ok(late.length >= 1, `${late.length} ended at the check after the gap`);
    late.forEach(x => {
      eq(x.outcome, 'Never reviewed');
      assert.ok(/^This hour's|^More than 5/.test(x.why), x.why);
    });
    eq(r.deferred, null);  // nothing is left remembered once each has its ending
  });

  test('early detection deferred: 25 stories at 09:30 with 5 accounts, then 10 at 09:44 with 8 accounts, a check reading at most 25: the ones the busier stories pushed out of the read end once, each with its row on the tab', () => {
    const r = day({ batches: [['09:30', 1, 25], ['09:44', 31, 10, 8]], cap: 25 });
    eq(r.read.size, 35);
    everyReadEndsOnce(r, 'a full read');
    assert.ok(r.tab.some(x => /read it again in time/.test(x.why)));
    eq(r.deferred, null);
  });

  test('early detection deferred: with the cache of their details deleted before every run, the same signals still end once each and C19 adds up (their rows name no story)', () => {
    // the full day with the cache emptied before each run
    const w = ends.world({ flow: 'one-space', row46: false, settings: {} });
    const rows = Array.from({ length: 25 }, (_, i) => (i % 2 ? ordinary : serious)(1 + i, '09:30'));
    const read = new Set();
    w.t.bot.bqEarlyDetectionRows_ = minutes => {
      const now = w.t.g.clock.now;
      const out = rows.filter(x => madeAt(x) >= now - minutes * MIN && madeAt(x) <= now).map(x => JSON.parse(JSON.stringify(x)));
      out.forEach(x => read.add(x.alert_id));
      return out;
    };
    let clock = '';
    w.t.bot.__edDeferredSkip = () => clock >= '10:15' && clock <= '10:40';
    w.t.bot.ev('earlyWaveCheck_ = (check => function (ctx) { return __edDeferredSkip() ? null : check(ctx); })(earlyWaveCheck_)');
    const endings = [];
    times('09:01', '12:30').forEach(time => {
      clock = time;
      w.t.g.services.CacheService.getScriptCache().remove('ed_deferred_rows');
      w.run(time);
      recsOf(w).forEach(x => endings.push(x));
      const n = w.t.bot.edDayNumbers_(props(w));
      eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `the run at ${time}`);
    });
    const late = endings.filter(x => /read it again in time/.test(x.why));
    assert.ok(late.length >= 1);
    late.forEach(x => eq([x.outcome, x.story], ['Never reviewed', 'A story whose details are gone']));
    const n = w.t.bot.edDayNumbers_(props(w));
    eq(n.found, read.size);
    eq(endings.length, read.size);
  });

  test('early detection deferred: the remembered list in its worst case (150 entries, the longest numbers) is saved under 8,800 characters; past 150 the oldest are handed back to end at once', () => {
    const t = ends.world({ flow: 'one-space', row46: false, settings: {} }).t;
    const p = t.g.services.PropertiesService.getScriptProperties();
    const list = {};
    for (let i = 0; i < 151; i++) list[`${'f'.repeat(8)}:${100 + i}`] = [99999999 - (i === 7 ? 50 : 0), 'o', 999999];
    eq(t.bot.ev('ED_DEFERRED_MAX_'), 150);
    eq(t.bot.edDeferredTrim_(list), ['ffffffff:107']);
    eq(Object.keys(list).length, 150);
    t.bot.edDeferredSave_(p, list, {});
    const text = String(t.g.props.get('EARLY_DETECTION_DEFERRED'));
    eq(Object.keys(JSON.parse(text)).length, 150);
    assert.ok(text.length <= 8800, `${text.length}`);
    // their rows in the cache, each as long as it can be, stay under 90,000 characters
    const rows = {};
    Object.keys(list).forEach((h, i) => {
      rows[h] = t.bot.edDeferredRow_({ alert_id: `ED-VEL-PRIORITY_TOPIC-${'x'.repeat(60)}-${i}`, signal_type: 'VELOCITY_SPIKE',
        velocity_grain: 'PRIORITY_TOPIC', signal_key: 'k'.repeat(300), velocity_ratio: 1.4, unique_low_tier_authors: 9999999,
        platforms_csv: 'X, Reddit, TikTok, YouTube, Instagram, Facebook, Threads', primary_url: `https://x.com/${'a'.repeat(120)}/status/1`,
        row: {} }, { c: 'c'.repeat(300), cp: 0.33, l: 4 });
    });
    t.bot.edDeferredSave_(p, list, rows);
    const cached = String(t.g.services.CacheService.getScriptCache().get('ed_deferred_rows'));
    assert.ok(cached.length <= 90000, `${cached.length}`);
    // an empty list takes the property and the cache value out
    t.bot.edDeferredSave_(p, {}, {});
    eq(t.g.props.get('EARLY_DETECTION_DEFERRED') || null, null);
    eq(t.g.services.CacheService.getScriptCache().get('ed_deferred_rows'), null);
  });

  test('early detection deferred: with the list full (150 remembered), a check that leaves 20 more for later ends the 20 oldest at once ("Never reviewed", counted once) instead of dropping any', () => {
    const w = ends.world({ flow: 'one-space', row46: false, settings: {} });
    const made = Math.floor(ends.at('09:31') / MIN);
    const full = {};
    for (let i = 0; i < 150; i++) full[`0000${String(i).padStart(4, '0')}:30`] = [made - 10 + Math.floor(i / 15), 'k', 5];  // all made in the last 10 minutes
    w.t.g.props.set('EARLY_DETECTION_DEFERRED', JSON.stringify(full));
    const rows = Array.from({ length: 25 }, (_, i) => (i % 2 ? ordinary : serious)(1 + i, '09:31'));
    const look = w.run('09:31', rows);
    const recs = recsOf(w);
    eq(look.waiting + recs.filter(r => /^Card posted/.test(r.outcome)).length, 5);  // five queued (two reviewed in this run)
    const ended = recs.filter(r => /read it again in time/.test(r.why));
    eq(ended.length, 20);
    ended.forEach(r => eq([r.outcome, r.story, r.id], ['Never reviewed', 'A story whose details are gone', '']));
    const kept = JSON.parse(w.t.g.props.get('EARLY_DETECTION_DEFERRED'));
    eq(Object.keys(kept).length, 150);
    Array.from({ length: 20 }, (_, i) => `0000${String(i).padStart(4, '0')}:30`).forEach(h => assert.ok(!kept[h], h));
    const n = w.t.bot.edDayNumbers_(props(w));
    eq([n.found, n.never, n.cards + n.waiting], [25, 20, 5]);
  });

  test('early detection deferred: with the allowance off (early_wave_reviews_per_hour 0) nothing is remembered', () => {
    const r = day({ batches: [['09:30', 1, 25]], skip: [['10:15', '10:40']], settings: ends.OLD_RULE, until: '11:00' });
    eq(r.deferred, null);
    eq(r.sizes.filter(Boolean), []);
  });
};
