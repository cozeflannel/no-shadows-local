// The thread-note helper takes a note of the bot's found in a card's thread for the note it is about to post only when
// both say the same and link the same message (ThreadNotes.gs acNoteSame_): two stories' "Part of a story" notes in the
// same words but with different links are two notes. A note Chat hands back without its links is still known by its words.
'use strict';

module.exports = H => {
  const { test, eq, B } = H;
  const golden = require('./golden_flows')(H);
  const { AC } = golden.spaces;
  const T = u => `🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (<https://chat.google.com/room/X/${u}/${u}|story card>)`;

  test('note same link: with the counts gone, a story note in the same words as one under the card but linking another story card is posted; the very same note (its link too) is not posted twice, and one read back without its links is known by its words', () => {
    const t = golden.oneSpaceRun(golden.SETTINGS_OFF).t;
    t.bot.__f = null;
    t.bot.ev('runOnce_ = (orig => function (ctx) { const r = orig(ctx); if (__f) __f(ctx); return r; })(runOnce_)');
    const rows = t.bot.sheetBackend_(t.sheet()).loadAlerts();
    const c = rows.find(r => r.ingested === 'BSIP' && /2150000000000000001/.test(r.record_key));
    const n = () => t.chat.spaces.get(AC).messages.filter(m => m.thread.name === c.forward_thread && m.threadReply).length;
    const step = (text, key) => {
      let r;
      t.bot.__f = ctx => { if (r === undefined) r = t.bot.acThreadNote_(ctx, c, text, key); };
      t.g.clock.now += 2 * 60000;
      t.g.cache.delete('ac_thread_notes');
      ['bot_posts', 'bot_post_ids'].forEach(k => t.g.cache.delete(k));
      t.poll();
      t.bot.__f = null;
      return r;
    };
    const n0 = n();
    eq(step(T('aaa'), 'story:A:1'), true);
    eq(step(T('bbb'), 'story:B:2'), true);
    eq(n() - n0, 2);
    // the same note again under another key (its first key forgotten, Chat's id with it): found in the thread, not posted
    eq(step(T('aaa'), 'story:A:again'), true);
    eq(n() - n0, 2);
    // pure: a note read back without its links is known by its words; with other links it is another note
    eq([B.acNoteSame_(T('aaa'), T('aaa')), B.acNoteSame_(T('aaa').replace(/<[^|]+\|([^>]+)>/, '$1'), T('bbb')),
      B.acNoteSame_(T('aaa'), T('bbb')), B.acNoteSame_(T('aaa').replace(/\*/g, ''), T('aaa'))], [true, true, false, true]);
  });
};
