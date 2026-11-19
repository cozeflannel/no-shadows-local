// Step S4 of the open-engine plan (its WL-1 answer and O4 "Background cards must not make Burson look busy"): under
// Control row 51, in the one-space setup, the bot's own Watch alerts and Direct BigQuery cards that wait in the
// Auto-correct space are the bot's backlog (report.bg_backlog), never Burson's: they no longer make the flow look busy,
// so Early Detection keeps checking; an ordinary one waits while the story queue's next signal is serious; and the Watch
// posts a new card there only while fewer than 3 of the bot's own wait unreviewed. With row 51 OFF the flow is as it
// was. Every post and account here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, F } = H;
  const golden = require('./golden_flows')(H);
  const recorded = require('./golden_flows_f93e31a.json');
  const AC = golden.spaces.AC;
  const CARD = (recorded.one_space || recorded.oneSpace).chat.find(m => !m.reply && /\[BigQuery · BSIP\]/.test(m.text)).text;
  const LINK = 'https://x.com/pixelcritic/status/2150000000000000001';
  const ZAPIER = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };

  /**
   * The one-space setup, stories first; row 51 ON unless `off`. `cards` of the bot's own Direct BigQuery cards land in
   * the Auto-correct space with a serious story (P1) in the same check; each card's review takes 20 seconds of the run.
   */
  function world(cards, off, o) {
    const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true }));
    if (!off) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
    w.t.bot.ev('handleAlert_ = (h => (ctx, m, p, r) => { __clock.now += 20000; return h(ctx, m, p, r); })(handleAlert_)');
    w.rec.collect('setup');
    w.rec.step('the first run', 1);
    const at = () => w.t.g.props.get('EARLY_DETECTION_AT');
    const checks = [];
    w.rec.step('cards and a story', 15, () => {
      const hashes = [];
      for (let i = 0; i < cards; i++) {
        const text = CARD.split(LINK).join(`https://x.com/pixelcritic/status/21500000000000${String(1000 + i)}`);
        const m = w.t.chat.say(AC, text, { sender: w.t.chat.botUser });
        hashes.push([w.t.bot.hashText_(m.name), 'BSIP']);
      }
      w.t.g.props.set('BQ_INGESTED_MSGS', JSON.stringify(hashes));
      w.feed.stories = [golden.rows.story({})];
      if (o && o.burson) w.t.chat.say(golden.spaces.REAL, F.MISTAKES, ZAPIER);
    });
    checks.push(at());
    w.rec.step('the next run', 1);
    checks.push(at());
    w.rec.step('the run after', 1);
    const out = w.rec.out();
    const storyCard = run => out.chat.filter(m => m.run === run && !m.reply && m.text.indexOf('🚨 *EARLY DETECTION*') === 0).length;
    return { w, out, checks, story: ['cards and a story', 'the next run', 'the run after'].map(storyCard),
      logs: w.t.g.logs };
  }

  test('background backlog (S4): 30 of the bot\'s own cards waiting and one serious story in the same check: with row 51 ON the check runs and the story is reviewed within one run of its signal, while the cards wait without making the flow look busy; with row 51 OFF the cards keep Early Detection from checking', () => {
    const open = world(30);
    assert.ok(open.story[0] + open.story[1] === 1, JSON.stringify(open.story));  // reviewed in the check's run or the next
    assert.ok(open.logs.some(l => /the bot's own ordinary cards wait for the next run: a serious story is next in the review queue/.test(l)) || open.story[0] === 1,
      'the ordinary cards waited behind the story');
    const off = world(30, true);
    eq(off.story.slice(0, 2), [0, 0]);  // the cards' backlog made the flow look busy: no check, no story card yet
    assert.ok(off.checks[0] === off.checks[1], 'no check ran while the cards waited (row 51 OFF)');
  });

  /**
   * The flow's own report (its log line "auto-correct space: {...}") of the run where `cards` bot cards land, with no
   * check due (it ran a minute before) and, with `queue`, a serious signal next in the review queue.
   */
  function reportOf(cards, off, queue, o) {
    const x = o || {};
    const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true }, x.settings || {}));
    if (!off) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
    w.t.bot.ev('handleAlert_ = (h => (ctx, m, p, r) => { __clock.now += 20000; return h(ctx, m, p, r); })(handleAlert_)');
    w.rec.collect('setup');
    w.rec.step('the first run', 1);
    let mark = 0;
    w.rec.step('cards', 1, () => {
      const hashes = [];
      for (let i = 0; i < cards; i++) {
        const text = CARD.split(LINK).join(`https://x.com/pixelcritic/status/21500000000000${String(1000 + i)}`);
        hashes.push([w.t.bot.hashText_(w.t.chat.say(AC, text, { sender: w.t.chat.botUser }).name), 'BSIP']);
      }
      w.t.g.props.set('BQ_INGESTED_MSGS', JSON.stringify(hashes));
      w.t.g.props.set('EARLY_DETECTION_AT', String(w.t.g.clock.now - (x.due ? 20 * 60 * 1000 : 0)));  // a check due, or not
      if (queue) w.t.g.props.set('ED_ALERT_QUEUE', JSON.stringify([{ k: 'clu_x', id: 'ED-CLU-x', at: w.t.g.clock.now, pri: 'P0', au: 6, ser: 1 }]));
      mark = w.t.g.logs.length;
    });
    const line = w.t.g.logs.slice(mark).reverse().find(l => /^auto-correct space: \{/.test(l));
    return { report: line ? JSON.parse(line.slice('auto-correct space: '.length)) : null, logs: w.t.g.logs.slice(mark),
      checked: Number(w.t.g.props.get('EARLY_DETECTION_AT')) > w.t.g.clock.now - 5 * 60 * 1000,
      notes: w.rec.out().chat.filter(m => m.run === 'cards' && m.reply).length };
  }

  test('background backlog (S4): when only the bot\'s own cards are left at the run\'s end, with row 51 ON they are its own backlog (bg_backlog: no "analyst backlog", no time-budget error, its reviews not counted against Burson\'s), so the flow does not look busy; with row 51 OFF they make it busy as before', () => {
    const on = reportOf(30).report;
    eq([on.bg_backlog, on.analyst_backlog, (on.errors || []).some(e => /^time budget/.test(e)), on.handled - on.bg_handled], [true, undefined, false, 0]);
    assert.ok(on.bg_waiting > 0, JSON.stringify(on));
    const off = reportOf(30, true).report;
    eq([off.bg_backlog, off.analyst_backlog, (off.errors || []).some(e => /^time budget/.test(e))], [undefined, true, true]);
  });

  test('background backlog (S4): at the flow\'s count of messages a run, the bot\'s own cards that wait are its own backlog and the cards it reviewed are not counted against Burson\'s: Early Detection\'s due check runs (row 51 ON); with row 51 OFF the count makes the flow busy and the check waits', () => {
    const on = reportOf(10, false, false, { settings: { max_messages_per_run: 3 }, due: true });
    eq([on.report.handled, on.report.bg_handled, on.report.bg_backlog, on.report.analyst_backlog, on.checked], [3, 3, true, undefined, true]);
    const off = reportOf(10, true, false, { settings: { max_messages_per_run: 3 }, due: true });
    eq([off.report.handled, off.report.analyst_backlog, off.checked], [3, true, false]);
  });

  test('background backlog (S4): with a serious signal next in the review queue the bot\'s own ordinary cards wait for the next run (one line in the log), and none of them is reviewed this run', () => {
    const r = reportOf(5, false, true);
    eq([r.report && r.report.handled, r.notes], [null, 0]);  // nothing reviewed: no review note, no report line of activity
    eq(r.logs.filter(l => /the bot's own ordinary cards wait for the next run: a serious story is next in the review queue/.test(l)).length, 1);
    const free = reportOf(5, false, false);
    eq([free.report.bg_handled, free.notes > 0], [5, true]);
  });

  test('background backlog (S4): a Burson alert behind the bot\'s own waiting cards is handled in the same run with row 51 ON, as it is with row 51 OFF and no cards at all', () => {
    const corrected = r => r.out.chat.filter(m => m.run === 'cards and a story' && !m.reply && /Mistakes|MISTAKES|Pixel/.test(m.text) && !/\[BigQuery · BSIP\]/.test(m.text)).length;
    const none = world(0, true, { burson: true });
    const open = world(30, false, { burson: true });
    eq(corrected(open), corrected(none));
  });

  test('background backlog (S4): in the Auto-correct space the Watch posts a new card only while fewer than 3 of the bot\'s own cards wait unreviewed there (no count a run); elsewhere, and with row 51 OFF, its counts a run are as before', () => {
    const w = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
    const b = w.t.bot;
    const max = d => b.pwAlertsMax_(d);
    eq([max({ choice: 'autocorrect', bgWaiting: 0 }), max({ choice: 'mirror' }), max({ choice: 'other' })], [2, 2, 5]);  // row 51 OFF
    b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    eq([0, 1, 2, 3, 7].map(n => max({ choice: 'autocorrect', bgWaiting: n })), [3, 2, 1, 0, 0]);
    eq([max({ choice: 'autocorrect' }), max({ choice: 'mirror', bgWaiting: 0 }), max({ choice: 'other', bgWaiting: 0 })], [2, 2, 5]);
  });

  test('background backlog (S4): which of the bot\'s own cards are serious (Watch: KOF, 2,000+, a P0 / P1 tag, a Sensitive Topic; Direct: KOF, 2,000+), and the queue\'s next signal', () => {
    const w = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
    const b = w.t.bot;
    const watch = o => Object.assign({ kof: null, engagement: { count: 40 }, unknown: [] }, o);
    eq([b.openCardSerious_('watch', watch({})), b.openCardSerious_('watch', watch({ kof: true })),
      b.openCardSerious_('watch', watch({ engagement: { count: 2000 } })), b.openCardSerious_('watch', watch({ engagement: { count: 1999 } })),
      b.openCardSerious_('watch', watch({ unknown: [{ label: 'card_sensitive_topics', value: 'Child Safety' }] })),
      b.openCardSerious_('watch', watch({ unknown: [{ label: 'card_exposure_tag', value: 'Product - Other/general criticism' }] }))],
    [false, true, true, false, true, false]);
    const direct = text => b.openCardSerious_('direct', b.parseAlert_(text));
    eq([direct(CARD), direct(CARD.replace('[KOF]: No', '[KOF]: Yes (Tech Journalists)')),
      direct(CARD.replace('MODERATE (800 engagements)', 'HIGH (2,400 engagements)').replace(',800,', ',2400,'))], [false, true, true]);
    w.t.g.props.set('ED_ALERT_QUEUE', JSON.stringify([{ k: 'a', id: 'A', at: 1, ser: 1 }, { k: 'b', id: 'B', at: 2 }]));
    eq(b.openQueueTopSerious_(), true);
    w.t.g.props.set('ED_ALERT_QUEUE', JSON.stringify([{ k: 'b', id: 'B', at: 2 }]));
    eq(b.openQueueTopSerious_(), false);
  });
};
