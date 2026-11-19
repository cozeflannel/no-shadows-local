// The thread-note helper (ThreadNotes.gs acThreadNote_) tells a caller why it refused a note without the caller reading
// its log: acThreadNoteLast_() gives {posted, code, lasting} of its last call. The watch (WatchAlerts.gs pwThreadNote_)
// goes by that, never by the log's words or the run's count of notes.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const { AC } = golden.spaces;
  const WATCH_NOTE = '🔭 *Also flagged by the watch “Google brand safety (all)”.* No separate Watch alert: this card already covers the post.';
  const STORY_NOTE = n => `🔗 *Part of a story:* ${n} small accounts on X and Reddit now tell it: Pixel 10 owners say the update is the issue`;

  const hooked = t => {
    t.bot.__inFlow = null;
    t.bot.__inWatch = null;
    t.bot.ev('runOnce_ = (orig => function (ctx) { const r = orig(ctx); if (__inFlow) __inFlow(ctx); return r; })(runOnce_)');
    t.bot.ev('runProactiveWatch_ = (orig => function (ss, runStart, opts) { const r = orig(ss, runStart, opts); ' +
      'if (__inWatch) __inWatch(opts && opts.alerts); return r; })(runProactiveWatch_)');
    return t;
  };
  const run = (t, fn, watch) => {
    const got = { flow: undefined, watch: undefined };
    t.bot.__inFlow = ctx => { if (fn && got.flow === undefined) got.flow = fn(ctx); };
    t.bot.__inWatch = dest => { if (watch && got.watch === undefined) got.watch = watch(dest); };
    t.poll();
    t.bot.__inFlow = null;
    t.bot.__inWatch = null;
    return got;
  };
  const cardNow = t => {
    const m = t.chat.say(AC, 'a card', { sender: 'users/bot' });
    return { thread: m.thread.name, message: m.name, createTime: t.bot.parseRfc3339_(m.createTime) };
  };
  const untimed = card => ({ thread: card.thread, message: card.message });
  const last = t => t.bot.acThreadNoteLast_();
  /** acThreadNote_ then acThreadNoteLast_, for each of `list` ([card, text, key]) in one flow run. */
  const tries = (t, list, ctxPatch) => run(t, ctx => list.map(([card, text, key]) => {
    const c = ctxPatch ? Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, ctxPatch) : ctx;
    const ok = t.bot.acThreadNote_(c, card, text, key);
    return [ok].concat([last(t)].map(l => [l.posted, l.code, l.lasting])[0]);
  })).flow;

  test('note reasons: the helper says what came of its last call: posted now; there already under its key (not posted now, no reason); and each refusal by its code, the lasting ones (no note shape, not the Auto-correct space, a full card, a card gone, a thread that cannot be read) apart from the passing ones (the run\'s 6 notes, no asking left, Chat refusing the note)', () => {
    const t = hooked(golden.oneSpaceRun(golden.SETTINGS_OFF).t);
    const card = cardNow(t);
    eq(tries(t, [[card, STORY_NOTE(5), 'a'], [card, STORY_NOTE(5), 'a'], [card, 'Hello there', 'b'], [card, STORY_NOTE(6), ''],
      [{ thread: 'spaces/OTHER/threads/x', message: 'spaces/OTHER/messages/x' }, STORY_NOTE(6), 'c'],
      [card, STORY_NOTE(7), 'd'], [card, STORY_NOTE(8), 'e'], [card, STORY_NOTE(9), 'f']]),
    [[true, true, '', false], [true, false, '', false], [false, false, 'no_note', true], [false, false, 'no_note', true],
      [false, false, 'not_here', true], [true, true, '', false], [true, true, '', false], [false, false, 'card_full', true]]);
    // the run's 6 notes (passing)
    const cards = [0, 1, 2, 3, 4, 5, 6].map(() => cardNow(t));
    const got = tries(t, cards.map((c, i) => [c, STORY_NOTE(5), `r${i}`]));
    eq(got.slice(-1), [[false, false, 'run_full', false]]);
    // a card gone, and a thread that cannot be read (both need its thread read: a card that doesn't say how old it is)
    const gone = untimed(cardNow(t));
    t.chat.spaces.get(AC).messages = t.chat.spaces.get(AC).messages.filter(m => m.name !== gone.message);
    eq(tries(t, [[gone, STORY_NOTE(5), 'g']]), [[false, false, 'card_gone', true]]);
    const dark = untimed(cardNow(t));
    t.chat.fail = (method, path, query) => (method === 'get' && /^thread\.name = /.test(String((query || {}).filter || ''))
      ? { code: 500, body: { error: { message: 'backend error' } } } : null);
    eq(tries(t, [[dark, STORY_NOTE(5), 'u']]), [[false, false, 'unread', true]]);
    t.chat.fail = null;
    // no asking left: a flow with less than 20 seconds of its time left, for a card whose thread has to be read
    const late = untimed(cardNow(t));
    eq(tries(t, [[late, STORY_NOTE(5), 'n']], { deadline: Date.now() + 5000, now: () => Date.now() }), [[false, false, 'no_asking', false]]);
    // Chat refuses the note (its call fails: passing)
    const refused = cardNow(t);
    t.chat.fail = (method, path) => (method === 'post' && /\/messages$/.test(path) ? { code: 500, body: { error: { message: 'no' } } } : null);
    eq(tries(t, [[refused, STORY_NOTE(5), 'x']]), [[false, false, 'error', false]]);
    t.chat.fail = null;
  });

  test('note reasons: the watch goes by the helper\'s code, not by its log\'s words: with the helper\'s log line for a full card worded otherwise, the watch still knows the card is full, and a note posted is "posted" whatever the run\'s count of notes says', () => {
    const t = hooked(golden.oneSpaceRun(golden.SETTINGS_OFF).t);
    const card = cardNow(t);
    t.bot.ev('console.log = (orig => function (msg) { return orig(String(msg).replace(/^thread note not posted: .*$/, "a note was left out")); })(console.log)');
    const keys = ['w1', 'w2', 'w3', 'w4'];
    const got = run(t, null, dest => keys.map(k => t.bot.pwThreadNote_(dest, card, WATCH_NOTE.replace('(all)', k), k))).watch;
    eq(got.map(x => [x.ok, x.posted, x.full, x.why, x.lasting]),
      [[true, true, false, '', false], [true, true, false, '', false], [true, true, false, '', false], [false, false, true, 'card_full', true]]);
    assert.ok(t.g.logs.some(l => /a note was left out/.test(String(l))), 'the log line was worded otherwise');
  });
};
