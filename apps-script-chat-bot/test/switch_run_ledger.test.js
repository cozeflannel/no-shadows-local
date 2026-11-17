// Step S2 of the open-engine plan: the record of run time and outside calls (OpenEngine.gs, RUN_LEDGER). It runs with
// Control row 51 OFF too, and only records: each run's seconds and outside calls in its hour's bucket (every request of a
// fetchAll counted once), the runs that found the lock taken, a run that died, Burson's pick-up times and the calls of
// its busiest pass; 24 hours kept, never more than 8,800 characters. Under row 51: the account type read once an Eastern
// day (no part of the address kept), the budgets it sets, the graded steps and the outside-call steps. Every address
// here is made up, on .test (and one on gmail.com, which only says which kind of account it is).
'use strict';

module.exports = H => {
  const { test, eq, assert, e2e, makeGoogle, loadBot, NOW, F, TEST_FEED } = H;
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const hourOf = ms => Math.floor(ms / HOUR) * HOUR;

  /** A bot on fake services, at NOW; `sw`: the run's switches (row 51 ON with row 19 by default when `on`). */
  function bot(o) {
    const x = o || {};
    const g = makeGoogle(x.at || NOW);
    if (x.user !== undefined) g.services.Session = { getEffectiveUser: () => ({ getEmail: x.user }) };
    const b = loadBot(g.services, g.clock);
    // a test that rewrites the record mid-run: the run's copy (read once a run) is dropped, as a new run would read it
    const setProp = g.props.set.bind(g.props);
    g.props.set = (k, v) => { const r = setProp(k, v); if (k === 'RUN_LEDGER') b.ev('if (OE_RUN_) OE_RUN_.L = null'); return r; };
    if (x.on) b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    if (x.settings) Object.entries(x.settings).forEach(([k, v]) => b.ev(`GEN.settings.${k} = ${JSON.stringify(v)}`));
    const ledger = () => JSON.parse(g.props.get('RUN_LEDGER') || 'null');
    const put = L => g.props.set('RUN_LEDGER', JSON.stringify(L));
    /** One run: it starts, makes `calls` (a list of fetch / fetchAll sizes), lasts `sec` seconds, and is recorded. */
    const run = (sec, calls, tookOver) => {
      const start = g.clock.now;
      b.openRunStart_(start);
      (calls || []).forEach(n => {
        if (n === 1) b.UrlFetchApp.fetch('https://example.test/one');
        else b.UrlFetchApp.fetchAll(Array.from({ length: n }, (_, i) => ({ url: `https://example.test/all/${i}` })));
      });
      g.clock.now += (sec || 0) * SEC;
      b.openLedgerRecord_(start, g.clock.now, tookOver || null);
      b.openRunEnd_();
    };
    return { g, b, ledger, put, run };
  }

  // -----------------------------------------------------------------------------------------------------------------
  // What it records
  // -----------------------------------------------------------------------------------------------------------------

  test('run ledger: a run (row 51 OFF) adds its seconds, its outside calls and itself to its hour; a fetchAll of 3 is 3 calls, never 6; UrlFetchApp is put back after', () => {
    const w = bot();
    const fetch0 = w.g.services.UrlFetchApp.fetch;
    const all0 = w.g.services.UrlFetchApp.fetchAll;
    w.run(42, [1, 3, 1]);
    eq(w.ledger().h, [[hourOf(NOW), 42, 5, 1, 0]]);
    eq(w.g.fetches.length, 5);  // the fake's own record of what went out: the same five
    eq([w.g.services.UrlFetchApp.fetch === fetch0, w.g.services.UrlFetchApp.fetchAll === all0, w.g.services.UrlFetchApp.__oe], [true, true, undefined]);
    w.run(18.25, [2]);
    eq(w.ledger().h, [[hourOf(NOW), 60.3, 7, 2, 0]]);
    // row 51 OFF: no account type is read, and nothing but the ledger is written
    eq([w.ledger().a, Array.from(w.g.props.keys()).sort()], [undefined, ['RUN_LEDGER']]);
  });

  test('run ledger: through poll(), every outside call of a run is counted (the fake\'s own record of them agrees), with row 51 OFF and nothing else changed', () => {
    const t = e2e();
    t.bot.setup();
    const before = t.g.fetches.length;
    // what the record costs a run: one read and one write of its property (row 51 OFF)
    const used = { get: 0, set: 0 };
    const sp = t.g.services.PropertiesService.getScriptProperties;
    t.g.services.PropertiesService.getScriptProperties = () => {
      const p = sp();
      return Object.assign({}, p, {
        getProperty: k => { if (k === 'RUN_LEDGER') used.get++; return p.getProperty(k); },
        setProperty(k, v) { if (k === 'RUN_LEDGER') used.set++; p.setProperty(k, v); return this; },
      });
    };
    t.chat.say(TEST_FEED, F.MISTAKES, { sender: 'users/bot' });
    t.poll();
    eq(used, { get: 1, set: 1 });
    t.poll();
    eq(used, { get: 2, set: 2 });
    const L = JSON.parse(t.g.props.get('RUN_LEDGER'));
    const calls = L.h.reduce((s, b) => s + b[2], 0);
    const runs = L.h.reduce((s, b) => s + b[3], 0);
    eq([calls, runs], [t.g.fetches.length - before, 2]);
    assert.ok(calls > 0, 'the alert\'s review made outside calls');
    // Burson's pass of the first run reviewed the alert: its calls are the day's busiest pass (Burson's reserve)
    eq([L.r.length, L.r[0][0]], [1, t.bot.openEtDay_(t.g.clock.now)]);
    assert.ok(L.r[0][1] > 0 && L.r[0][1] <= calls, JSON.stringify(L.r));
    eq([t.g.services.UrlFetchApp.__oe, t.control().cell(51, 3)], [undefined, 'OFF (Early Detection, the Watch and Direct BigQuery keep today\'s limits)']);
  });

  test('run ledger: the runs that found the lock taken are counted (each start adds to a cache counter before the lock is tried) and cost open_lock_loss_seconds each', () => {
    const w = bot();
    for (let i = 0; i < 5; i++) w.b.openEntry_();  // five starts this hour: one ran, four found the lock taken
    w.run(30, []);
    eq(w.ledger().h, [[hourOf(NOW), 30, 0, 1, 5]]);
    eq(w.b.openUsage_(w.g.clock.now).runSec, 30 + 4 * 2);
    w.b.ev('GEN.settings.open_lock_loss_seconds = 5');
    eq(w.b.openUsage_(w.g.clock.now).runSec, 30 + 4 * 5);
    // through poll(): a run that finds the lock taken returns at once, counted all the same
    const t = e2e();
    t.bot.setup();
    t.g.services.LockService = { getScriptLock: () => ({ tryLock: () => false, waitLock: () => {}, releaseLock: () => {} }) };
    t.bot.LockService = t.g.services.LockService;
    t.bot.poll();
    t.bot.poll();
    eq(Number(t.g.cache.get(`oe_entries:${hourOf(t.g.clock.now)}`)), 2);
  });

  test('run ledger: a run that died is counted by the run that takes over, from its claim\'s start, never more than 6 minutes', () => {
    const w = bot();
    w.run(20, [], { started: NOW - 3 * MIN });
    // (NOW is on the hour: the dead run's 3 minutes are in its own hour, the one before)
    eq(w.ledger().h, [[hourOf(NOW) - HOUR, 180, 0, 0, 0], [hourOf(NOW), 20, 0, 1, 0]]);
    eq(w.b.openUsage_(w.g.clock.now).runSec, 20 + 180);
    const v = bot();
    v.run(20, [], { started: NOW - 50 * MIN });  // a claim 50 minutes old: counted as 6 minutes, in its own hour
    eq(v.b.openUsage_(v.g.clock.now).runSec, 20 + 360);
    eq(v.ledger().h.map(b => b[1]).reduce((s, x) => s + x, 0), 380);
  });

  test('run ledger: 24 hours kept, rolling: a bucket older than 24 hours is dropped and no longer counted', () => {
    const w = bot();
    const H0 = hourOf(NOW);
    w.put({ v: 1, h: [[H0 - 30 * HOUR, 999, 50, 9, 9], [H0 - 24 * HOUR, 100, 10, 1, 1], [H0 - 23 * HOUR, 200, 20, 2, 2], [H0 - HOUR, 300, 30, 3, 3]], p: [] });
    eq(w.b.openUsage_(NOW).runSec, 100 + 200 + 300);  // the bucket of 24 hours ago still reaches into the last 24 hours
    w.run(10, [1]);
    eq(w.ledger().h.map(b => b[0]), [H0 - 23 * HOUR, H0 - HOUR, H0]);  // kept: the buckets that end after NOW - 24 h
    w.g.clock.now += 22 * HOUR;
    eq(w.b.openUsage_(w.g.clock.now).runSec, 300 + 10);
    w.g.clock.now += 3 * HOUR;
    eq([w.b.openUsage_(w.g.clock.now).runSec, w.b.openUsage_(w.g.clock.now).fetches], [0, 0]);
  });

  test('run ledger: the worst case (24 full buckets, 60 pick-up times, 7 days of Burson\'s passes, the account, calls not counted) is at most 8,800 characters, and nothing the ledger does not know is kept', () => {
    const w = bot({ on: true });
    const H0 = hourOf(NOW);
    const big = 99999999.9;
    w.put({ v: 1, h: Array.from({ length: 24 }, (_, i) => [H0 - (23 - i) * HOUR, big, 99999999, 99999, 99999]), p: Array.from({ length: 500 }, () => 86399),
      pd: w.b.openEtDay_(NOW), r: Array.from({ length: 7 }, (_, i) => [w.b.openEtDay_(NOW - i * 24 * HOUR), 99999999]), nc: 1 });
    w.b.openRunStart_(NOW);
    w.b.ev('OE_RUN_.counting = false; OE_RUN_.pickups = Array.from({ length: 60 }, () => 86399); OE_RUN_.burson = 99999999');
    w.b.openLedgerRecord_(NOW, NOW + 59 * SEC, { started: NOW - 6 * MIN });
    w.b.openRunEnd_();
    const raw = w.g.props.get('RUN_LEDGER');
    const L = JSON.parse(raw);
    eq([L.h.length, L.p.length, L.r.length, L.nc, typeof L.a], [24, 60, 7, 1, 'object']);
    assert.ok(raw.length <= 8800, `${raw.length} characters`);
    // a ledger with what it does not know (a long junk key, an account with more in it): that is not kept
    w.put(Object.assign(JSON.parse(raw), { junk: 'x'.repeat(9000), a: { d: w.b.openEtDay_(NOW), w: 1, extra: 'y'.repeat(500) } }));
    w.run(1, []);
    const kept = JSON.parse(w.g.props.get('RUN_LEDGER'));
    eq([Object.keys(kept).sort(), kept.a, kept.h.length], [['a', 'h', 'p', 'pd', 'r', 'v'], { d: w.b.openEtDay_(NOW), w: 1 }, 24]);
    assert.ok(w.g.props.get('RUN_LEDGER').length <= 8800);
  });

  test('run ledger: it never throws: a broken ledger, a property store that throws, a cache that throws and a fetch that cannot be wrapped each leave the run as it was', () => {
    const w = bot();
    w.g.props.set('RUN_LEDGER', '{not json');
    w.run(5, [1]);
    eq(w.ledger().h, [[hourOf(NOW), 5, 1, 1, 0]]);
    w.g.props.set('RUN_LEDGER', '[1,2,3]');
    w.run(5, []);
    eq(w.ledger().h, [[hourOf(NOW), 5, 0, 1, 0]]);
    const props = w.b.PropertiesService;
    w.b.PropertiesService = { getScriptProperties: () => { throw new Error('quota'); } };
    w.b.openEntry_();
    w.b.openRunStart_(NOW);
    w.b.openLedgerRecord_(NOW, NOW + SEC, null);
    eq(w.b.openUsage_(NOW).runSec, 0);
    w.b.openRunEnd_();
    w.b.PropertiesService = props;
    w.b.CacheService = { getScriptCache: () => { throw new Error('cache down'); } };
    w.b.openEntry_();
    w.run(3, [1]);
    eq(w.ledger().h, [[hourOf(NOW), 8, 1, 2, 0]]);
    // UrlFetchApp that cannot be wrapped (frozen): the calls are not counted, and the ledger says so
    const v = bot({ on: true });
    v.b.UrlFetchApp = Object.freeze({ fetch: v.g.services.UrlFetchApp.fetch, fetchAll: v.g.services.UrlFetchApp.fetchAll });
    v.run(5, [1, 2]);
    eq([v.ledger().h, v.ledger().nc, v.b.openUsage_(v.g.clock.now).counted], [[[hourOf(NOW), 5, 0, 1, 0]], 1, false]);
    assert.ok(!/calls /.test(v.b.openC51Text_(v.g.clock.now)), v.b.openC51Text_(v.g.clock.now));
  });

  test('run ledger: Burson\'s pick-up times (posted to handled) are kept for the Eastern day, p50 and p90; Burson\'s busiest pass of 7 days, doubled, is its reserve of outside calls', () => {
    const w = bot({ on: true, settings: { open_fetch_day: 1000 } });
    w.b.openRunStart_(NOW);
    [30, 40, 50, 60, 200].forEach(s => w.b.openPickup_(NOW - s * SEC, NOW));
    w.b.openPickup_(NOW + 5 * SEC, NOW);  // a post time after the pick-up: not kept
    const before = w.b.openFetches_();
    w.b.UrlFetchApp.fetchAll([{ url: 'https://example.test/a' }, { url: 'https://example.test/b' }]);
    w.b.UrlFetchApp.fetch('https://example.test/c');
    w.b.openBursonPass_(before);
    w.b.UrlFetchApp.fetch('https://example.test/d');  // after Burson's pass: background work
    w.b.openLedgerRecord_(NOW, NOW + 30 * SEC, null);
    w.b.openRunEnd_();
    const u = w.b.openUsage_(NOW + 30 * SEC);
    eq([u.pickup, w.ledger().r, u.reserve, u.fetchBudget], [{ p50: 50, p90: 200, n: 5 }, [[w.b.openEtDay_(NOW), 3]], 6, 994]);
    // the reserve keeps the busiest pass of the last 7 days, at most half the day's calls
    w.put(Object.assign(w.ledger(), { r: [[w.b.openEtDay_(NOW - 8 * 24 * HOUR), 900], [w.b.openEtDay_(NOW - 6 * 24 * HOUR), 120], [w.b.openEtDay_(NOW), 3]] }));
    eq([w.b.openUsage_(NOW).reserve, w.b.openUsage_(NOW).fetchBudget], [240, 760]);
    w.put(Object.assign(w.ledger(), { r: [[w.b.openEtDay_(NOW), 400]] }));
    eq([w.b.openUsage_(NOW).reserve, w.b.openUsage_(NOW).fetchBudget], [500, 500]);
    // the next Eastern day: pick-up times start again
    eq(w.b.openUsage_(NOW + 24 * HOUR).pickup, { p50: null, p90: null, n: 0 });
  });

  // -----------------------------------------------------------------------------------------------------------------
  // The account type and the budgets (row 51)
  // -----------------------------------------------------------------------------------------------------------------

  test('run ledger: under row 51 the account type is read once an Eastern day: an address on a .test domain gives the Workspace budgets (6 h less 1.5 h of run time, 100,000 calls); the gmail.com and googlemail.com domains, an address that cannot be read and one with no "@" give the lower (1.5 h less 0.75 h, 20,000); no part of the address is kept, logged or written', () => {
    // (the rules allow made-up addresses only on .test, so a consumer account is tested on its domain alone, below)
    eq(['gmail.com', 'GoogleMail.com', ' gmail.com ', 'agency.test', 'example.test', '', 'mail.gmail.com.test'].map(d => bot().b.openWorkspaceDomain_(d)),
      [false, false, false, true, true, false, true]);
    const cases = [
      ['owner.one@agency.test', true, 4.5 * 3600, 100000],
      ['owner-without-a-domain', false, 0.75 * 3600, 20000],
      [null, false, 0.75 * 3600, 20000],
      ['', false, 0.75 * 3600, 20000],
    ];
    cases.forEach(([address, workspace, budgetSec, fetchBudget]) => {
      let reads = 0;
      const w = bot({ on: true, user: () => { reads++; if (address === null) throw new Error('no permission'); return address; } });
      w.run(10, []);
      w.run(10, []);
      const u = w.b.openUsage_(w.g.clock.now);
      eq([u.workspace, u.budgetSec, u.fetchBudget, u.budgetFrom, reads], [workspace, budgetSec, fetchBudget, 'account', 1], String(address));
      eq(w.ledger().a, { d: w.b.openEtDay_(NOW), w: workspace ? 1 : 0 });
      // nothing of the address anywhere: properties, cache, logs, the C51 note
      const everything = JSON.stringify([Array.from(w.g.props.entries()), Array.from(w.g.cache.entries()), w.g.logs, w.b.openC51Text_(w.g.clock.now)]);
      ['owner', 'agency', 'domain', '@'].forEach(s => assert.ok(!everything.toLowerCase().includes(s), `${address}: ${s}`));
      // the next Eastern day reads it again, once
      w.g.clock.now += 24 * HOUR;
      w.run(1, []);
      w.run(1, []);
      eq(reads, 2, String(address));
    });
    // row 51 OFF: the address is not read at all; the settings, when set, win over the account's figures
    let reads = 0;
    const off = bot({ user: () => { reads++; return 'owner.one@agency.test'; } });
    off.run(10, []);
    eq([reads, off.ledger().a, off.b.openUsage_(off.g.clock.now).budgetSec], [0, undefined, 0.75 * 3600]);
    const set = bot({ on: true, settings: { open_runtime_budget_hours: 3, open_runtime_other_hours: 1, open_fetch_day: 5000 } });
    set.run(10, []);
    eq([set.b.openUsage_(set.g.clock.now).budgetSec, set.b.openUsage_(set.g.clock.now).fetchBudget, set.b.openUsage_(set.g.clock.now).budgetFrom], [2 * 3600, 5000, 'setting']);
    // "other scripts" takes at most half the quota
    const half = bot({ on: true, settings: { open_runtime_budget_hours: 2, open_runtime_other_hours: 5 } });
    eq(half.b.openUsage_(NOW).budgetSec, 3600);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // The graded steps
  // -----------------------------------------------------------------------------------------------------------------

  test('run ledger: the graded steps on run time (0.60, 0.70, 0.80, 0.90, 0.97 of the budget) say what may start under row 51; with row 51 OFF everything may', () => {
    const B = 4.5 * 3600;  // a Workspace account's budget
    const at = (f, on) => {
      const w = bot({ on });
      w.put({ v: 1, h: [[hourOf(NOW), Math.round(f * B * 10) / 10, 0, 1, 0]], p: [], a: { d: w.b.openEtDay_(NOW), w: 1 } });
      const may = (kind, serious) => w.b.openMayStart_(kind, null, { serious }).ok;
      return [w.b.openUsage_(NOW).step, may('review', false), may('review', true), may('card', true), may('quick', false)];
    };
    eq(at(0.59, true), [0, true, true, true, true]);
    eq(at(0.60, true), [1, true, true, true, true]);
    eq(at(0.70, true), [2, true, true, true, true]);
    eq(at(0.80, true), [3, false, true, true, true]);   // only serious work starts
    eq(at(0.90, true), [4, false, false, false, true]);  // no background reviews or cards
    eq(at(0.97, true), [5, false, false, false, false]); // Burson's reserve: no background work at all
    eq(at(0.99, false), [5, true, true, true, true]);   // row 51 OFF: the bot as it was
    // and a "no" counts its wall today ("pace")
    const w = bot({ on: true });
    w.put({ v: 1, h: [[hourOf(NOW), 0.95 * B, 0, 1, 0]], p: [], a: { d: w.b.openEtDay_(NOW), w: 1 } });
    w.b.openRunStart_(NOW);
    w.b.openMayStart_('review', null, {});
    w.b.openMayStart_('card', null, {});
    eq(w.b.openDay_(NOW).w, { pace: 1 });  // once a run
    w.b.openDaySave_();  // the run's end
    w.b.openRunStart_(NOW + MIN);  // the next run
    w.b.openMayStart_('review', null, {});
    eq(w.b.openDay_(NOW + MIN).w, { pace: 2 });
  });

  test('run ledger: outside calls: with a budget of 1,000 no quick look starts from 700 calls, no background work from 900; the steps are shown on C51; Burson\'s alerts are never asked', () => {
    const at = calls => {
      const w = bot({ on: true, settings: { open_fetch_day: 1000 } });
      w.put({ v: 1, h: [[hourOf(NOW), 60, calls, 1, 0]], p: [], a: { d: w.b.openEtDay_(NOW), w: 1 } });
      const may = kind => w.b.openMayStart_(kind, null, { serious: true }).ok;
      return [w.b.openUsage_(NOW).fetchStep, may('quick'), may('review'), may('card'), w.b.openC51Text_(NOW)];
    };
    eq(at(699).slice(0, 4), [0, true, true, true]);
    eq(at(700).slice(0, 4), [1, false, true, true]);
    eq(at(900).slice(0, 4), [2, false, false, false]);
    assert.ok(at(700)[4].startsWith('⏸ outside calls ahead of pace (700 of 1,000 in 24 h): no quick looks. Burson\'s alerts go on'), at(700)[4]);
    assert.ok(at(900)[4].startsWith('⏸ outside calls nearly used (900 of 1,000 in 24 h): no background work. Burson\'s alerts go on'), at(900)[4]);
  });

  test('run ledger: with a budget of 1,000 calls and 700 used, the story quick look (Decisions) asks nothing and says why, and a Burson alert in the same run is still read and reviewed as it is with row 51 OFF', () => {
    const w = bot({ on: true, settings: { open_fetch_day: 1000 } });
    w.put({ v: 1, h: [[hourOf(NOW), 60, 699, 1, 0]], p: [], a: { d: w.b.openEtDay_(NOW), w: 1 } });
    const session = w.b.decSession_(() => 200 * SEC, false);
    eq(w.b.decSkipWhy_(session, { until: 0, asked: 0 }, NOW), '');
    w.put({ v: 1, h: [[hourOf(NOW), 60, 700, 1, 0]], p: [], a: { d: w.b.openEtDay_(NOW), w: 1 } });
    eq(w.b.decSkipWhy_(session, { until: 0, asked: 0 }, NOW), 'the day\'s outside calls are ahead of pace: no quick looks');
    eq(w.b.decisionsAsk_('Drivers say Maps routes them onto a closed bridge', { q: { type: 'noul', text: 'Is it about Google?' } }, session),
      { ok: false, skipped: true, why: 'the day\'s outside calls are ahead of pace: no quick looks' });
    eq(w.g.fetches, []);
    // a Burson alert: with every step at its worst under row 51 (calls and run time nearly used, the day's stop reached), its
    // pass reads, reviews and posts exactly what it does with row 51 OFF
    const runWith = on => {
      const t = e2e();
      t.bot.setup();
      if (on) {
        t.bot.ev('openOn_ = () => true');
        t.g.props.set('RUN_LEDGER', JSON.stringify({ v: 1, h: [[hourOf(t.g.clock.now), 99999, 99999, 1, 0]], p: [] }));
        t.g.props.set('OPEN_DAY', JSON.stringify({ d: t.bot.openEtDay_(t.g.clock.now), rev: 5000, ql: 0, wc: 0, gb: 0, stop: { k: 'rev', at: t.g.clock.now }, w: {} }));
      }
      const alert = t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
      t.poll();
      return { posts: t.chat.botPosts(H.TRIAGED).map(m => m.text), reactions: t.chat.botReactions(alert.name), reviews: t.g.vertex.calls.length };
    };
    const off = runWith(false);
    const on = runWith(true);
    eq(on, off);
    assert.ok(off.reviews > 0 && off.posts.length > 0, JSON.stringify(off));
  });

  test('run ledger: row 51 needs row 19: with row 19 OFF the open engine is off (everything may start, nothing is counted)', () => {
    const w = bot();
    w.b.ewsRunSwitches_({ openEngine: true });
    eq([w.b.openOn_(), w.b.openMayStart_('review', null, {}).ok], [false, true]);
    w.b.openRunStart_(NOW);
    w.b.openCountReview_(5);
    w.b.openDaySave_();
    eq(w.g.props.get('OPEN_DAY'), undefined);
    w.b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    eq(w.b.openOn_(), true);
  });
};
