// Step S2 of the open-engine plan: yield to Burson (OpenEngine.gs openYield_, through openMayStart_). Under Control row
// 51, before each background review or batch the bot lists S-F Burson since its cursor; a new post there ends background
// work for this run, and the next minute's run takes the alert first. The day's Burson pick-up times (posted to handled)
// are kept, and while their p90 is over open_burson_pickup_p90_s (120 s) each run keeps more of its time for Burson.
// With row 51 OFF nothing is listed and nothing changes. Every post and account here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, e2e, makeGoogle, loadBot, NOW, F, TEST_FEED, REAL } = H;
  const golden = require('./golden_flows')(H);
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const ZAPIER = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };

  function bot(off) {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    // a test that rewrites the record mid-run: the run's copy (read once a run) is dropped, as a new run would read it
    const setProp = g.props.set.bind(g.props);
    g.props.set = (k, v) => { const r = setProp(k, v); if (k === 'RUN_LEDGER') b.ev('if (OE_RUN_) OE_RUN_.L = null'); return r; };
    if (!off) b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    b.openRunStart_(NOW);
    return { g, b };
  }
  /** A run's context as runOnce_ has it, around a fake list of S-F Burson's posts. */
  function ctxWith(msgs, o) {
    const x = o || {};
    const calls = [];
    const ctx = {
      chat: { list: (id, since, n) => { calls.push([id, since, n]); if (x.throws) throw new Error('Chat is down'); return msgs; } },
      spaces: { burson: { id: 'spaces/AAQAsfburson1' } },
      cursor: { get: () => x.cursor === undefined ? NOW - MIN : x.cursor },
      recent: { has: name => (x.recent || []).indexOf(name) >= 0 },
      store: { isDone: name => (x.done || []).indexOf(name) >= 0 },
      deadline: x.deadline,
    };
    return { ctx, calls };
  }
  const post = (name, at, o) => Object.assign({ name: `spaces/AAQAsfburson1/messages/${name}`, createTime: at, threadReply: false }, o || {});

  test('yield to Burson: a top-level S-F Burson post newer than the cursor, not yet handled, ends background reviews and cards for the run ("Burson first", one list call, none after); quick looks are not held by it; with row 51 OFF nothing is listed', () => {
    const w = bot();
    const { ctx, calls } = ctxWith([post('old', NOW - 2 * MIN), post('reply', NOW - 10 * SEC, { threadReply: true }), post('done', NOW - 20 * SEC), post('new', NOW - 5 * SEC)],
      { done: ['spaces/AAQAsfburson1/messages/done'] });
    eq(w.b.openMayStart_('quick', ctx, {}).ok, true);
    eq(calls.length, 0);
    eq(w.b.openMayStart_('review', ctx, { serious: true }), { ok: false, why: 'a Burson alert came in: it goes first', wall: 'burson' });
    eq([calls.length, calls[0][0], calls[0][1]], [1, 'spaces/AAQAsfburson1', new Date(NOW - MIN).toISOString()]);
    eq([w.b.openMayStart_('card', ctx, {}).ok, w.b.openMayStart_('batch', ctx, {}).ok, calls.length], [false, false, 1]);  // once yielded, for the run
    eq(w.b.openDay_(NOW).w, { burson: 1 });  // a wall is counted once a run
    // nothing new (older than the cursor, a reply, handled, or seen this run): background work goes on, a list a call
    const quiet = bot();
    const q = ctxWith([post('old', NOW - 2 * MIN), post('reply', NOW - 10 * SEC, { threadReply: true }), post('done', NOW - 20 * SEC), post('seen', NOW - 3 * SEC)],
      { done: ['spaces/AAQAsfburson1/messages/done'], recent: ['spaces/AAQAsfburson1/messages/seen'] });
    eq([quiet.b.openMayStart_('review', q.ctx, {}).ok, quiet.b.openMayStart_('review', q.ctx, {}).ok, q.calls.length], [true, true, 2]);
    // a list that throws, or no cursor yet: no yield (never throws)
    const broken = ctxWith([post('new', NOW)], { throws: true });
    eq([bot().b.openMayStart_('review', broken.ctx, {}).ok, bot().b.openYield_(ctxWith([post('new', NOW)], { cursor: 0 }).ctx), bot().b.openYield_(null)], [true, false, false]);
    // row 51 OFF: no list, ever
    const off = bot(true);
    const o = ctxWith([post('new', NOW - 5 * SEC)]);
    eq([off.b.openMayStart_('review', o.ctx, {}).ok, o.calls.length], [true, 0]);
  });

  test('yield to Burson: in a run, a Burson alert that lands during the story\'s check ends the run\'s background reviews; the next run handles the alert first and then reviews the story; with row 51 OFF the story is reviewed in the same run, as before', () => {
    const runs = off => {
      const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true }));
      if (!off) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
      w.rec.collect('setup');
      w.rec.step('the first run', 1);
      w.rec.step('a check', 5);
      w.rec.step('a check', 5);
      let alert = null;
      w.t.bot.__land = () => { if (!alert) alert = w.t.chat.say(REAL, F.MISTAKES, ZAPIER); };
      w.t.bot.ev('earlyWaveCheck_ = (check => ctx => { const r = check(ctx); __land(); return r; })(earlyWaveCheck_)');
      w.rec.step('the story run', 5, () => { w.feed.stories = [golden.rows.story({})]; });
      w.rec.step('the next run', 1);
      const chat = w.rec.out().chat;
      const card = run => chat.filter(m => m.run === run && !m.reply && m.text.indexOf('🚨 *EARLY DETECTION*') === 0).length;
      // (the one-space setup never reacts in S-F Burson: its corrected copy in the Auto-correct space is the alert handled)
      const handled = run => chat.filter(m => m.run === run && !m.reply && m.text.indexOf('🚨 *EARLY DETECTION*') !== 0).length;
      return { card: [card('the story run'), card('the next run')], handled: [handled('the story run'), handled('the next run')],
        walls: JSON.parse(w.t.g.props.get('OPEN_DAY') || '{}').w, logs: w.t.g.logs };
    };
    const open = runs(false);
    eq([open.card, open.handled, open.walls], [[0, 1], [0, 1], { burson: 1 }]);
    assert.ok(open.logs.some(l => /early detection: no more reviews this run: a Burson alert came in: it goes first/.test(l)));
    const asBefore = runs(true);
    eq([asBefore.card, asBefore.handled], [[1, 0], [0, 1]]);
  });

  test('yield to Burson: the pick-up time of each Burson alert its pass handles (posted to handled) is kept for the Eastern day, row 51 OFF too; p90 over 120 s (5 or more) makes each background start keep 30 s more of the run for Burson (60 s at most, a "run short" wall)', () => {
    const t = e2e();
    t.bot.setup();
    const alert = t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    t.g.clock.now += 90 * SEC;  // the alert waited a minute and a half; poll() moves the clock on a minute more
    t.poll();
    const L = JSON.parse(t.g.props.get('RUN_LEDGER'));
    eq([L.p.length, L.p[0] >= 150 && L.p[0] <= 160, L.pd], [1, true, t.bot.openEtDay_(t.g.clock.now)]);
    assert.ok(t.chat.botReactions(alert.name).length > 0);
    // the shrink
    const w = bot();
    const ledger = p => w.g.props.set('RUN_LEDGER', JSON.stringify({ v: 1, h: [], p, pd: w.b.openEtDay_(NOW) }));
    const shrink = () => w.b.openShrinkMs_(w.b.openUsage_(NOW));
    ledger([200, 200, 200, 200]);
    eq(shrink(), 0);  // fewer than 5 pick-ups: no gauge yet
    ledger([30, 40, 50, 60, 121]);
    eq(shrink(), 30 * SEC);
    ledger([30, 40, 50, 60, 120]);
    eq(shrink(), 0);
    ledger([30, 40, 50, 60, 200]);
    eq(shrink(), 60 * SEC);  // 80 s over: 30 s for each 30 s over, at most 60 s
    const { ctx } = ctxWith([], { deadline: NOW + 100 * SEC });
    eq(w.b.openMayStart_('review', ctx, {}), { ok: false, why: 'the run keeps time for Burson\'s alerts', wall: 'short' });
    const roomy = ctxWith([], { deadline: NOW + 130 * SEC });
    eq(w.b.openMayStart_('review', roomy.ctx, {}).ok, true);
    // with row 51 OFF the gauge is only kept
    const off = bot(true);
    off.g.props.set('RUN_LEDGER', JSON.stringify({ v: 1, h: [], p: [500, 500, 500, 500, 500], pd: off.b.openEtDay_(NOW) }));
    eq(off.b.openMayStart_('review', ctxWith([], { deadline: NOW + 10 * SEC }).ctx, {}).ok, true);
  });
};
