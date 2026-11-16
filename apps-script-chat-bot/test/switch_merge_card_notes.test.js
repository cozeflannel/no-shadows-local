// Where three lanes' notes under one card meet (built apart, all through the one helper, ThreadNotes.gs acThreadNote_):
// the Direct BigQuery lane's "Part of a story" note under its own card (key 'bqstory:<card message>'), the story lane's
// note under another alert's card (key 'story:<alert id>:<signal id>') and the Watch's note under a card that already
// covers its post (key 'watch:<card message>'). Their keys differ, so none takes another's place, and the cap of 3 notes
// a card holds for all of them together.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const AC = 'spaces/AAQAonespace01';

  const hooked = t => {
    t.bot.__inFlow = null;
    t.bot.__inWatch = null;
    t.bot.ev('runOnce_ = (orig => function (ctx) { const r = orig(ctx); if (__inFlow) __inFlow(ctx); return r; })(runOnce_)');
    t.bot.ev('runProactiveWatch_ = (orig => function (ss, runStart, opts) { const r = orig(ss, runStart, opts); ' +
      'if (__inWatch) __inWatch(opts && opts.alerts); return r; })(runProactiveWatch_)');
    return t;
  };
  /** One run, with `fn(ctx)` called inside the Auto-correct flow and `watch(dest)` inside the watch. */
  const run = (t, fn, watch) => {
    const got = { flow: undefined, watch: undefined };
    t.bot.__inFlow = ctx => { if (fn && got.flow === undefined) got.flow = fn(ctx); };
    t.bot.__inWatch = dest => { if (watch && got.watch === undefined) got.watch = watch(dest); };
    t.poll();
    t.bot.__inFlow = null;
    t.bot.__inWatch = null;
    return got;
  };
  const replies = (t, thread) => t.chat.spaces.get(AC).messages.filter(m => m.thread.name === thread && m.threadReply);

  test('merged lanes, notes under one card: the Direct BigQuery lane\'s story note, the story lane\'s note under another alert\'s card and the Watch\'s note all go under one card (different keys); a fourth note of any lane is refused there, the cap of 3 holding for them together', () => {
    const t = hooked(golden.oneSpaceRun(golden.SETTINGS_OFF).t);
    const rows = t.bot.sheetBackend_(t.sheet()).loadAlerts();
    const card = rows.find(r => r.ingested === 'BSIP' && /2150000000000000001/.test(r.record_key));
    const story = rows.find(r => r.ingested === 'Early detection');
    assert.ok(card && story, 'the golden scenario has a Direct BigQuery card and a story card');
    const before = replies(t, card.forward_thread).length;
    const signal = { alert_id: 'ED-CLU-CLU-merge0001-202611150800', unique_low_tier_authors: 5, platforms_csv: 'X, Reddit' };
    const bqText = t.bot.bqStoryNoteText_({ au: 5, plats: ['X', 'Reddit'], msg: story.forward_message });
    const bqKey = `bqstory:${card.forward_message}`;
    const edText = t.bot.edCrossNoteText_(Object.assign({ headline: 'Low-tier claim cluster (5 accounts): Pixel owners say the update is the issue' }, signal));
    const edKey = `story:${card.alert_id}:${t.bot.edNoteKey_(signal)}`;
    const watchText = t.bot.pwAlsoFlaggedText_(['Google brand safety (all)']);
    const watchKey = `watch:${card.forward_message}`;
    assert.notStrictEqual(bqKey, edKey);
    let got = run(t, ctx => [t.bot.acThreadNote_(ctx, card, bqText, bqKey), t.bot.acThreadNote_(ctx, card, edText, edKey)],
      dest => t.bot.pwThreadNote_(dest, card, watchText, watchKey));
    eq([got.flow, got.watch], [[true, true], { ok: true, posted: true, full: false }]);
    eq(replies(t, card.forward_thread).slice(before).map(m => m.text), [bqText, edText, watchText]);
    // a fourth note under that card, of any lane, is refused; each of the three is still known by its key
    got = run(t, ctx => [t.bot.acThreadNote_(ctx, card, '🔗 *Part of a story:* 9 small accounts tell it (story card)', 'story:QA-9:ED-other'),
      t.bot.acThreadNote_(ctx, card, bqText, bqKey), t.bot.acThreadNote_(ctx, card, edText, edKey)],
    dest => t.bot.pwThreadNote_(dest, card, t.bot.pwAlsoFlaggedText_(['Midterms']), `watch:${card.forward_message}:2`));
    eq([got.flow, got.watch], [[false, true, true], { ok: false, posted: false, full: true }]);
    eq(replies(t, card.forward_thread).length - before, 3);
  });
};
