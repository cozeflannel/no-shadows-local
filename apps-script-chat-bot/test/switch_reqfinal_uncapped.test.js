// The "*Alert requirements, final:*" line (RequirementLine.gs requirementFinal_) corrects what the review's own note
// said, and comes at most once an alert: no cap of the thread-note helper (6 notes a run, 3 a card) refuses it, it
// counts against neither, and it never takes another note's place. It keeps the helper's other checks: only a thread of
// the Auto-correct space, once per key.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const { AC } = golden.spaces;
  const FINAL = '*Alert requirements, final:* ';
  const NOTE = n => `🔗 *Part of a story:* ${n} small accounts tell it (story card)`;

  const world = () => {
    const t = golden.oneSpaceRun(golden.SETTINGS_OFF).t;
    t.bot.__f = null;
    t.bot.ev('runOnce_ = (orig => function (ctx) { const r = orig(ctx); if (__f) __f(ctx); return r; })(runOnce_)');
    const rows = t.bot.sheetBackend_(t.sheet()).loadAlerts();
    const cards = {
      burson: rows.find(r => !r.ingested),
      pixel: rows.find(r => r.ingested === 'BSIP' && /2150000000000000001/.test(r.record_key)),
      maps: rows.find(r => r.ingested === 'BSIP' && /2150000000000000002/.test(r.record_key)),
    };
    Object.keys(cards).forEach(k => assert.ok(cards[k] && String(cards[k].forward_thread).indexOf(AC + '/threads/') === 0, k));
    return { t, cards };
  };
  const inRun = (t, fn) => {
    let out;
    t.bot.__f = ctx => { if (out === undefined) out = fn(ctx); };
    t.g.clock.now += 60 * 1000;
    t.poll();
    t.bot.__f = null;
    return out;
  };
  const replies = (t, thread) => t.chat.spaces.get(AC).messages.filter(m => m.thread.name === thread && m.threadReply).map(m => m.text);
  // the line said a Social Alert goes out; none was made: the final line says so
  const final = (t, ctx, row) => t.bot.requirementFinal_(ctx, { d: { sent: true, met: true, why: '' }, line: 'x', stale: false },
    { name: row.forward_message, thread: row.forward_thread }, row.source_message, null, 'a repeat of QA-1001');

  test('reqfinal uncapped: after the run\'s 6 notes the final line of a card is still posted, and the run\'s count of notes is not moved by it', () => {
    const { t, cards } = world();
    const before = replies(t, cards.burson.forward_thread).length;
    const got = inRun(t, ctx => {
      const r = [];
      for (let i = 0; i < 3; i++) r.push(t.bot.acThreadNote_(ctx, cards.pixel, NOTE(i + 3), `p${i}`));
      for (let i = 0; i < 3; i++) r.push(t.bot.acThreadNote_(ctx, cards.maps, NOTE(i + 3), `m${i}`));
      final(t, ctx, cards.burson);
      return r.concat([t.bot.acThreadNoteLast_().posted, t.bot.ev('AC_NOTE_RUN_.n')]);
    });
    eq(got, [true, true, true, true, true, true, true, 6]);
    const after = replies(t, cards.burson.forward_thread).slice(before);
    eq([after.length, after[0].indexOf(FINAL) === 0], [1, true]);
  });

  test('reqfinal uncapped: a card that took 3 notes in earlier runs still takes its final line; the final line takes no note\'s place: a card with 2 notes and its final line still takes a third note, from the counts and from its thread (the counts gone, also with Chat\'s ids gone)', () => {
    const { t, cards } = world();
    const card = cards.burson;
    const before = replies(t, card.forward_thread).length;
    ['a', 'b', 'c'].forEach((k, i) => eq(inRun(t, ctx => t.bot.acThreadNote_(ctx, card, NOTE(i + 3), k)), true, k));
    eq(inRun(t, ctx => t.bot.acThreadNote_(ctx, card, NOTE(9), 'd')), false);
    inRun(t, ctx => final(t, ctx, card));
    const after = replies(t, card.forward_thread).slice(before);
    eq([after.length, after[3].indexOf(FINAL) === 0], [4, true]);

    // two notes, then the final line, then a third note: posted
    const other = world();
    const pixel = other.cards.pixel;
    eq(inRun(other.t, ctx => [other.t.bot.acThreadNote_(ctx, pixel, NOTE(3), 'a'), other.t.bot.acThreadNote_(ctx, pixel, NOTE(4), 'b')]), [true, true]);
    inRun(other.t, ctx => final(other.t, ctx, pixel));
    other.t.g.cache.delete('ac_thread_notes');  // its thread is read: the final line is not one of its notes
    eq(inRun(other.t, ctx => [other.t.bot.acThreadNote_(ctx, pixel, NOTE(5), 'c'), other.t.bot.acThreadNote_(ctx, pixel, NOTE(6), 'd')]), [true, false]);
    eq(replies(other.t, pixel.forward_thread).filter(x => x.indexOf(FINAL) === 0).length, 1);

    // the same with Chat's ids gone (and the bot's record of its posts): the final line is known by its shape
    const third = world();
    const maps = third.cards.maps;
    eq(inRun(third.t, ctx => [third.t.bot.acThreadNote_(ctx, maps, NOTE(3), 'a'), third.t.bot.acThreadNote_(ctx, maps, NOTE(4), 'b')]), [true, true]);
    inRun(third.t, ctx => final(third.t, ctx, maps));
    third.t.chat.spaces.get(AC).messages.filter(m => m.thread.name === maps.forward_thread && m.threadReply)
      .forEach(m => { delete m.clientAssignedMessageId; });
    ['ac_thread_notes', 'bot_posts', 'bot_post_ids', 'bot_reactions'].forEach(k => third.t.g.cache.delete(k));
    third.t.bot.ev('BOT_MARKS_ = null');
    eq(inRun(third.t, ctx => [third.t.bot.acThreadNote_(ctx, maps, NOTE(5), 'c'), third.t.bot.acThreadNote_(ctx, maps, NOTE(6), 'd')]), [true, false]);
  });

  test('reqfinal uncapped: the final line keeps the helper\'s other checks: never outside the Auto-correct space, and once per key', () => {
    const { t, cards } = world();
    const card = cards.maps;
    const before = replies(t, card.forward_thread).length;
    inRun(t, ctx => final(t, ctx, card));
    inRun(t, ctx => final(t, ctx, card));
    t.g.cache.delete('ac_thread_notes');
    inRun(t, ctx => final(t, ctx, card));
    eq(replies(t, card.forward_thread).slice(before).filter(x => x.indexOf(FINAL) === 0).length, 1);
    const elsewhere = Object.assign({}, card, { forward_thread: 'spaces/AAQAother01/threads/x', forward_message: 'spaces/AAQAother01/messages/x.x' });
    eq(inRun(t, ctx => t.bot.acThreadNote_(ctx, elsewhere, `${FINAL}met for a Social Alert (KOF author), but none was sent: a repeat of QA-1001.`,
      `reqfinal:${elsewhere.forward_message}`) || t.bot.acThreadNoteLast_().code), 'not_here');
  });
};
