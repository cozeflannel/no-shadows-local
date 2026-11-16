// Thread notes (ThreadNotes.gs acThreadNote_): the one way the bot puts a note under a card that is already in the
// Auto-correct space (B10). It posts only from the Auto-correct flow (or, for the watch, with its alerts going to the
// Auto-correct space), only under a card whose thread and message are in that space, never in S-F Burson, the Burson test
// copy or a space people outside Google can join, only a note that starts with one of the fixed first words, once per
// key, at most 3 under one card in its life (what the card's thread holds is the truth; the script cache only saves
// reading it) and 6 a run. The bot knows such a note as its own and never answers it; the wider guard holds its first
// words on any way to S-F Burson but one: the bot's own answer to a question of Burson's, which is checked as it always
// was. Nothing in the bot calls the helper yet: these tests call it directly.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, e2e, REAL, TEST_FEED, TRIAGED, leakDenied } = H;
  const golden = require('./golden_flows')(H);
  const { AC, MIRROR, COPY } = golden.spaces;
  const ZAPIER = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const ALICE = { sender: 'users/burson7', displayName: 'Alice Smith' };  // someone at Burson
  const DANA = { sender: 'users/analyst9', displayName: 'Dana Lee' };     // an analyst
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const GUARD = { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] };

  // The notes of the plan, as they are worded
  const WATCH_NOTE = '🔭 *Also flagged by the watch “Google brand safety (all)”.* No separate Watch alert: this card already covers the post.';
  const STORY_NOTE = '🔗 *Part of a story:* 5 small accounts on X and Reddit now tell it: Pixel 10 owners say the update is the issue';
  const REQ_NOTE = '*Alert requirements:* met for a Social Alert: P0 exposure tag (Product - Perceived bias).';
  const REQ_FINAL = '*Alert requirements, final:* met for a Social Alert (2,400 engagements), but none was sent: a repeat of QA-1001.';
  const NOTES = [WATCH_NOTE, STORY_NOTE, REQ_NOTE, REQ_FINAL];
  const plainOf = s => s.replace(/\*/g, '');  // as Chat can give a message back: without its bold marks

  /** Every message the bot posted, in every space: [name]. */
  const posted = t => {
    const out = [];
    t.chat.spaces.forEach(s => s.messages.forEach(m => { if (m.viaApi) out.push(m.name); }));
    return out;
  };
  const inThread = (t, thread) => t.chat.spaces.get(thread.split('/threads/')[0]).messages.filter(m => m.thread.name === thread && m.threadReply);
  const alertRows = t => t.bot.sheetBackend_(t.sheet()).loadAlerts();
  const check = (t, from, card, text) => t.bot.acThreadNoteCheck_(from, card, text);

  /**
   * A world's runs with a way in: `t.bot.__inFlow` (called with each flow's ctx, inside the run, right after the flow's
   * pass) and `t.bot.__inWatch` (called with the watch's destination, inside the run, right after the watch).
   */
  const hooked = t => {
    t.bot.__inFlow = null;
    t.bot.__inWatch = null;
    t.bot.ev('runOnce_ = (orig => function (ctx) { const r = orig(ctx); if (__inFlow) __inFlow(ctx); return r; })(runOnce_)');
    t.bot.ev('runProactiveWatch_ = (orig => function (ss, runStart, opts) { const r = orig(ss, runStart, opts); ' +
      'if (__inWatch) __inWatch(opts && opts.alerts); return r; })(runProactiveWatch_)');
    return t;
  };
  /** One run, with `fn(ctx)` called inside the flow (and `watch(dest)` inside the watch); what each returned. */
  const run = (t, fn, watch) => {
    const got = { flow: undefined, watch: undefined, ctx: null, dest: null };
    t.bot.__inFlow = ctx => { got.ctx = ctx; if (fn) got.flow = fn(ctx); };
    t.bot.__inWatch = dest => { got.dest = dest; if (watch) got.watch = watch(dest); };
    t.poll();
    t.bot.__inFlow = null;
    t.bot.__inWatch = null;
    return got;
  };

  /**
   * The one-space setup after the golden scenario: in the Auto-correct space, Burson's corrected alert (its row's
   * source_thread is Burson's own thread in S-F Burson), two Direct BigQuery cards, a story card and a watch alert.
   */
  const oneSpace = () => {
    const t = hooked(golden.oneSpaceRun(golden.SETTINGS_OFF).t);
    const rows = alertRows(t);
    const cards = {
      burson: rows.find(r => !r.ingested),
      pixel: rows.find(r => r.ingested === 'BSIP' && /2150000000000000001/.test(r.record_key)),
      maps: rows.find(r => r.ingested === 'BSIP' && /2150000000000000002/.test(r.record_key)),
      story: rows.find(r => r.ingested === 'Early detection'),
      watch: rows.find(r => r.ingested === 'Watch alert'),
    };
    Object.keys(cards).forEach(k => assert.ok(cards[k] && String(cards[k].forward_thread).indexOf(AC + '/threads/') === 0, k));
    return { t, cards };
  };

  // =============================================================================================================
  // The fixed first words
  // =============================================================================================================

  test('thread notes: the fixed first words ("Also flagged by the watch", "Part of a story", "Alert requirements") are registered three ways: the bot knows a note that starts with one as its own (with its emoji and bold mark, or as Chat gives it back without them), the wider guard holds it on any way to S-F Burson (alone, as a note, quoted by an analyst, on a later line), and the leak audit\'s own list denies it; "the alert requirements" in a sentence, or being part of a story, is still anyone\'s to say', () => {
    const heads = B.ev('THREAD_NOTE_HEADS_');
    eq(heads, ['Also flagged by the watch', 'Part of a story', 'Alert requirements', 'Same story']);
    const ctx = { botUser: 'users/bot', store: { isOwnPost: () => false } };
    const own = text => B.isOwnMessage_(ctx, { senderName: 'users/bot', text });
    const held = text => B.outboxGuardHits_(text, GUARD).length > 0;
    // each head by itself, and each real note: the bot's own, held by the wider guard, denied by the leak audit. "Same
    // story" (the watch's reply under its own alert) is held and denied only in its own shape, "Same story: N more
    // posts": "Same story:" by itself is an analyst's wording too, and reaches S-F Burson as it always did
    const SAME = 'Same story';
    const shaped = h => (h === SAME ? `${SAME}: 2 more posts` : h);
    heads.map(shaped).concat(NOTES, NOTES.map(plainOf), heads.map(h => (h === SAME ? `🔗 *${SAME}: 1 more post*` : `🔗 *${h}:* and more`))).forEach(text => {
      eq([B.isThreadNoteText_(text), B.isBotFormattedText_(text), own(text), held(text), leakDenied(text)], [true, true, true, true, true], text);
    });
    // every registered head is on all three lists (a note with new first words has to be added to each); the guard's
    // own list of them (Outbox.gs OUTBOX_NOTE_PATTERNS_) has one pattern for each
    heads.forEach(h => eq([B.isBotFormattedText_(`${shaped(h)}: x`), held(`${shaped(h)}: x`), leakDenied(`${shaped(h)}: x`)], [true, true, true], h));
    ['Same story', 'Same story: x', '🔗 *Same story:* and more'].forEach(text => {
      eq([B.isBotFormattedText_(text), held(text), leakDenied(text)], [true, false, false], text);
    });
    eq(B.ev('OUTBOX_NOTE_PATTERNS_.length'), heads.length);
    // what the guard says it found is the words, not the line break or the emoji before them
    eq([B.outboxGuardHits_(WATCH_NOTE, GUARD), B.outboxGuardHits_(STORY_NOTE, GUARD), B.outboxGuardHits_(`Thanks!\n${REQ_NOTE}`, GUARD)],
      [['flagged by the watch'], ['Part of a story'], ['Alert requirements']]);
    // on a way to S-F Burson a note is held wherever it stands: after an analyst's name (the Relay), on a later line
    [`Dana Lee: ${STORY_NOTE}`, `Dana Lee: ${plainOf(REQ_NOTE)}`, `Dana Lee: ${plainOf(REQ_FINAL)}`, `Dana Lee: see below\n${plainOf(STORY_NOTE)}`,
      `Dana Lee: it was ${plainOf(WATCH_NOTE)}`].forEach(text => eq([held(text), leakDenied(text)], [true, true], text));
    // ...but only in those forms: these are neither the bot's own nor held
    ['Please look at the alert requirements for this one.', 'It comes from the alert requirements: https://docs.google.com/document/d/abc/edit.',
      'What are the Alert requirements for a P1?', 'This post is part of a story we alerted yesterday.', 'Part of a storyline about maps',
      'Alert requirementss', 'Also flagged by the watchdog group', 'The watch company flagged it', 'This is the same story as yesterday.',
      'Same storyline about maps'].forEach(text => {
      eq([B.isThreadNoteText_(text), B.outboxGuardHits_(text, GUARD).filter(h => /story|requirements|flagged/i.test(h)), leakDenied(text)],
        [false, [], false], text);
    });
    // a person's own message from the bot's account that only mentions the words mid-sentence stays theirs
    assert.ok(!own('Why does this one not meet the Alert requirements?'));
    // the bot's answers to Burson that name the alert requirements pass as before
    eq(B.outboxGuardHits_('Please check this alert against the alert requirements.', GUARD), []);
  });

  // =============================================================================================================
  // The bot's own answer to Burson is no note
  // =============================================================================================================

  // Answers Gemini can well give Burson (the rules it answers from stand under "[Alert requirements]"): each opens, or
  // has a line that opens, as a note does. They reach a Burson space in the tests below, so the leak audit is told
  const ANSWERS = [
    '*Alert requirements:* a P1 exposure tag needs 2,000+ engagements or a KOF author.',
    'Sure!\nAlert requirements for a P1: 2,000+ engagements or a KOF author.',
    'Part of a story we already alerted: the same post was escalated on Monday.',
  ];
  ANSWERS.forEach(H.ownAnswerInBurson);
  const outboxTab = t => t.sheet().getSheetByName('Burson outbox');
  const outboxRows = t => (outboxTab(t) ? outboxTab(t).rows.slice(1) : []);
  const keyOf = row => JSON.parse(String(row[7]));
  /** A person sets outbox row i (0: the first under the header) to Send, after typing `text` in its Text cell if given. */
  const send = (t, i, text) => {
    if (text !== undefined) outboxTab(t).getRange(i + 2, 4).setValue(text);
    outboxTab(t).getRange(i + 2, 6).setValue('Send');
  };

  test('thread notes: the bot\'s own answer to a question of Burson\'s is checked as it always was: the wider guard holds a text for a note\'s first words everywhere but there (outboxGuardHits_ asked for the bot\'s own answer), still holds that answer for every internal word, and knows the answer by its key ("ans:…" as the main flow queues it, "own:ans:…" from the Mirror space), never an analyst\'s answer, a fix request or what the Relay queued', () => {
    const asAnswer = text => B.outboxGuardHits_(text, GUARD, true);
    const plainNotes = [WATCH_NOTE, STORY_NOTE, REQ_NOTE];  // (REQ_FINAL names an alert's id, which no reply to Burson may)
    ANSWERS.concat(plainNotes, plainNotes.map(plainOf)).forEach(text => {
      eq([B.outboxGuardHits_(text, GUARD).length > 0, asAnswer(text)], [true, []], text);
    });
    eq([B.outboxGuardHits_(REQ_FINAL, GUARD), asAnswer(REQ_FINAL)], [['QA-1001', 'Alert requirements'], ['QA-1001']]);
    // only `true` asks for it: anything else is every other text's check
    [undefined, null, false, 0, 1, 'true', {}].forEach(v => assert.ok(B.outboxGuardHits_(REQ_NOTE, GUARD, v).length > 0, String(v)));
    // the answer's check is the wider guard as it was before the notes: the internal setup, the tools and the spaces
    eq([B.ev('OUTBOX_GUARD_PATTERNS_.length'), B.ev('OUTBOX_GUARD_PATTERNS_.map(String).filter(p => /story|requirements|flagged/i.test(p))')], [15, []]);
    ['*Alert requirements:* per SLRR, a P1 needs 2,000+ engagements.', 'Alert requirements: the bot checks them.', 'It was autocorrected.',
      'See the Mirror for that.', 'Zapier copied it.', 'It is on the outbox tab.', 'Ask in SLRR Triaged Alerts.', 'It was forwarded.',
      'See spaces/AAQAaLn375E for more.'].forEach(text => assert.ok(asAnswer(text).length > 0, text));
    eq(asAnswer('*Alert requirements:* per SLRR, a P1 needs 2,000+ engagements.'), ['SLRR']);
    // the leak audit (run_tests.js) takes only an answer a test named for the answer it is: a note, the same answer
    // with a word more, and a named answer that holds anything else on its lists are still held against a Burson space
    const INTERNAL = '*Alert requirements:* ask in the analyst space.';
    H.ownAnswerInBurson(INTERNAL);
    eq(ANSWERS.map(H.leakAuditDenied), [false, false, false]);
    eq([REQ_NOTE, STORY_NOTE, WATCH_NOTE, `${ANSWERS[0]} Thanks!`, ANSWERS[0].replace('P1', 'P2'), INTERNAL, 'It was forwarded.']
      .map(H.leakAuditDenied), Array(7).fill(true));
    eq(['Please check this alert against the alert requirements.', 'Happy to help with that.'].map(H.leakAuditDenied), [false, false]);
    // which rows and replies are the bot's own answer
    const M = 'spaces/AAQAmirrorgf1/messages/m7';
    eq([`ans:${M}`, `own:ans:${M}`].map(k => B.outboxOwnAnswerKey_(k)), [true, true]);
    eq([`anaans:${M}`, `own:anaans:${M}`, `fix:${M}`, `own:fix:${M}`, `human:${M}`, `rel-out:${M}`, `edtri:${M}`, `acnote:ans:${M}`,
      `own:own:ans:${M}`, ` ans:${M}`, `ANS:${M}`, 'answer', 'own:', '', null, undefined, 7, {}].map(k => B.outboxOwnAnswerKey_(k)),
    Array(18).fill(false));
  });

  test('thread notes: in the Mirror flow, an answer of the bot\'s to Burson that opens as a note does reaches Burson as it did before the notes. LIVE (the Relay and Post in S-F Burson ON): it waits on the Burson outbox as written, never the fixed answer in its place, and goes to S-F Burson once a person sets it to Send. An analyst\'s message with the same words is still not relayed, an analyst\'s row a person edited to hold a note is Blocked, and a reply of the bot\'s that is no answer still stays in the Mirror space', () => {
    const t = hooked(golden.mirrorRun(golden.SETTINGS_OFF).t);  // ends LIVE, with rows 22 and 24 ON
    const first = outboxRows(t).length;
    const alert = t.chat.spaces.get(REAL).messages.filter(m => !m.threadReply && /SOCIAL ALERT/.test(m.text)).slice(-1)[0];
    const copy = t.chat.botPosts(MIRROR).filter(m => !m.threadReply && m.text === alert.text).slice(-1)[0];
    const QUESTIONS = ['What does a P1 need to be escalated?', 'And what about a P2 like this one?', 'Is this post part of something bigger?'];
    ANSWERS.forEach((answer, i) => {
      t.g.vertex.answer = () => answer;
      t.chat.say(REAL, QUESTIONS[i], Object.assign({ thread: alert.thread.name }, ALICE));
      t.poll();
      t.poll();
      // in the Mirror space, the answer under the alert's copy; on the outbox, the same words, for the alert's own thread
      eq(inThread(t, copy.thread.name).slice(-1).map(m => m.text), [answer], answer);
    });
    const added = outboxRows(t).slice(first);
    eq(added.map(r => [r[1], r[3], r[4], r[5], keyOf(r).thread, /^own:ans:/.test(keyOf(r).ck), !!keyOf(r).relay]),
      ANSWERS.map(answer => ['reply', answer, 'bot', 'Pending', alert.thread.name, true, false]));
    eq(t.chat.botPosts(REAL), []);
    // a person sets them to Send: each goes to S-F Burson as written, in the alert's thread
    ANSWERS.forEach((answer, i) => send(t, first + i));
    t.poll();
    eq([outboxRows(t).slice(first).map(r => [r[5], /^sent \d{4}-\d\d-\d\d \d\d:\d\d ET: /.test(r[6])]),
      t.chat.botPosts(REAL).map(m => [m.thread.name, m.threadReply, m.text])],
    [ANSWERS.map(() => ['Sent', true]), ANSWERS.map(answer => [alert.thread.name, true, answer])]);
    const sentToBurson = t.chat.botPosts(REAL).length;

    // The same words from an analyst are not relayed, as a line's first words or after the name
    const before = outboxRows(t).length;
    const said = ['Two things:\nAlert requirements look fine\nand the link works.', 'Alert requirements: all met.',
      'It was flagged by the watch team this morning.'];
    said.forEach(text => t.chat.say(MIRROR, text, Object.assign({ thread: copy.thread.name }, DANA)));
    t.poll();
    t.poll();
    eq([outboxRows(t).length, inThread(t, copy.thread.name).filter(m => m.viaApi).slice(-3).map(m => m.text.replace(/\. Post it again[\s\S]*$/, ''))],
      [before, ['Not sent to S-F Burson: it mentions "Alert requirements"', 'Not sent to S-F Burson: it mentions "Alert requirements:"',
        'Not sent to S-F Burson: it mentions "flagged by the watch"']]);
    // An analyst's row on the outbox that a person edited to hold a note: Blocked at Send, never written
    const relayed = outboxRows(t).findIndex(r => /^relay: /.test(String(r[4])) && r[5] === 'Pending');
    assert.ok(relayed >= 0 && keyOf(outboxRows(t)[relayed]).relay, 'an analyst\'s row is waiting');
    send(t, relayed, `Dana Lee: ${plainOf(REQ_NOTE)}`);
    t.poll();
    eq([outboxRows(t)[relayed][5], outboxRows(t)[relayed][6], t.chat.botPosts(REAL).length],
      ['Blocked', 'not sent: it mentions "Alert requirements:". Edit the text, then set Send again.', sentToBurson]);
    // A reply of the bot's that is no answer (a fix request, anything bursonOut_ posts under another key) is held for a
    // note's first words as any text is: it stays in the Mirror space. The same words as its answer are queued
    const rows = outboxRows(t).length;
    const got = run(t, ctx => [
      t.bot.forwardOwnBurson_(ctx, { type: 'post', text: 'Alert requirements: please add the link.', thread: copy.thread.name, key: 'fix:probe1' }),
      t.bot.forwardOwnBurson_(ctx, { type: 'post', text: plainOf(STORY_NOTE), thread: copy.thread.name, key: 'human:probe2' }),
      t.bot.forwardOwnBurson_(ctx, { type: 'post', text: ANSWERS[0], thread: copy.thread.name, key: 'ans:probe3' }),
    ]);
    eq([got.ctx.outboundBlocked, got.flow, outboxRows(t).slice(rows).map(r => [r[3], keyOf(r).ck])],
      [true, ['', '', 'queued'], [[ANSWERS[0], 'own:ans:probe3']]]);
    assert.ok(t.g.logs.some(l => l === 'Post in S-F Burson: the bot\'s reply stays in the Mirror space: it mentions "Alert requirements"'), 'the run log says why');
  });

  test('thread notes: in the Mirror flow while Testing (a Burson test copy in B26), such an answer goes to the test copy as written, where S-F Burson would get it, never the fixed answer in its place; and where the bot works on S-F Burson itself (B3 = S-F Burson, Post in S-F Burson ON), the answer\'s outbox row is sent as written, while a reply of the bot\'s that is no answer, edited to hold a note, is Blocked, and so is the answer when a person types an internal word into it', () => {
    // Testing, with the test copy
    const w = golden.world.mirrorWorld(golden.SETTINGS_OFF);
    let alert = null;
    w.rec.step('a Burson alert', 1, () => { alert = w.t.chat.say(REAL, F.MISTAKES, ZAPIER); });
    w.t.g.vertex.answer = () => ANSWERS[0];
    w.rec.step('Burson asks', 1, () => { w.t.chat.say(REAL, 'What does a P1 need to be escalated?', Object.assign({ thread: alert.thread.name }, ALICE)); });
    w.rec.step('a quiet run', 1);
    const out = w.rec.out();
    eq(out.test_copy.map(c => [c.reply, c.text.split('\n')[0]]), [
      [false, F.MISTAKES.split('\n')[0]],
      [true, 'Please make the following updates and resend the alert here:'],
      [true, 'Alice Smith: What does a P1 need to be escalated?'],
      [true, ANSWERS[0]],
    ]);
    eq([out.outbox, w.t.chat.botPosts(REAL), out.chat.filter(c => c.reply && c.text === ANSWERS[0]).map(c => c.space)], [[], [], [MIRROR]]);

    // The bot working on S-F Burson itself (no Mirror space): its answer is queued by the main flow, key "ans:…"
    const ROOM = 'https://chat.google.com/room/AAQAaa_0I9g';
    const t = e2e();
    t.bot.setup();
    t.set('B25', ROOM);
    t.set('B3', ROOM);
    [11, 23, 24].forEach(r => t.control().getRange(r, 2).setValue('ON'));  // Auto-send, Never wait on Burson, Post in S-F Burson
    t.poll();
    const ok = t.chat.say(REAL, F.P0_OK, ZAPIER);
    const bad = t.chat.say(REAL, F.MISTAKES, ZAPIER);
    t.poll();
    t.g.vertex.answer = () => ANSWERS[1];
    t.chat.say(REAL, 'Why is this one P0?', Object.assign({ thread: ok.thread.name }, ALICE));
    t.poll();
    const rows = () => outboxRows(t);
    const answerRow = rows().findIndex(r => r[3] === ANSWERS[1]);
    const noteRow = rows().findIndex(r => r[1] === 'reply' && keyOf(r).thread === bad.thread.name);  // what the bot changed on the alert with mistakes
    assert.ok(answerRow >= 0 && noteRow >= 0 && /^ans:/.test(keyOf(rows()[answerRow]).ck) && !/^(?:own:)?ans:/.test(keyOf(rows()[noteRow]).ck),
      JSON.stringify(rows().map(r => [r[1], keyOf(r).ck])));
    send(t, answerRow);
    send(t, noteRow, plainOf(STORY_NOTE));
    t.poll();
    eq([rows()[answerRow][5], rows()[noteRow][5], rows()[noteRow][6], t.chat.botPosts(REAL).map(m => [m.thread.name, m.text])],
      ['Sent', 'Blocked', 'not sent: it mentions "Part of a story". Edit the text, then set Send again.', [[ok.thread.name, ANSWERS[1]]]]);
    // the answer's row is still held for everything it was held for before: a person types an internal word into another one
    t.g.vertex.answer = () => ANSWERS[0];
    t.chat.say(REAL, 'And this one?', Object.assign({ thread: ok.thread.name }, ALICE));
    t.poll();
    const second = rows().findIndex(r => r[3] === ANSWERS[0]);
    send(t, second, `${ANSWERS[0]} The bot checks this.`);
    t.poll();
    eq([rows()[second][5], rows()[second][6], t.chat.botPosts(REAL).length],
      ['Blocked', 'not sent: it mentions "The bot". Edit the text, then set Send again.', 1]);
  });

  // =============================================================================================================
  // Where a note goes
  // =============================================================================================================

  test('thread notes: from the Auto-correct flow a note is posted once in the thread of a card in the Auto-correct space, as the bot\'s own message (its id starts client-bqa-, it is among the run\'s recent messages), under an Alert-log row\'s forward_thread or a card just posted ({thread, message}); the watch, which has no flow ctx, posts one with its destination (B35 = the Auto-correct space); nothing goes to any other space', () => {
    const { t, cards } = oneSpace();
    const before = posted(t);
    let recent = null;
    const got = run(t, ctx => {
      const said = [t.bot.acThreadNote_(ctx, cards.pixel, STORY_NOTE, 'story:pixel'),
        t.bot.acThreadNote_(ctx, { thread: cards.maps.forward_thread, message: cards.maps.forward_message }, REQ_NOTE, 'req:maps')];
      recent = inThread(t, cards.pixel.forward_thread).filter(m => m.text === STORY_NOTE).map(m => ctx.recent.has(m.name));
      return said;
    }, dest => t.bot.acThreadNote_(dest, cards.burson, WATCH_NOTE, 'watch:burson'));
    eq([got.flow, got.watch, recent, got.ctx.sourceReadOnly, got.dest.choice, got.dest.space.id], [[true, true], true, [true], true, 'autocorrect', AC]);
    const fresh = posted(t).filter(n => before.indexOf(n) < 0).map(n => t.chat.message(n));
    eq(fresh.map(m => [m.name.split('/messages/')[0], m.thread.name, m.threadReply, m.text]), [
      [AC, cards.pixel.forward_thread, true, STORY_NOTE],
      [AC, cards.maps.forward_thread, true, REQ_NOTE],
      [AC, cards.burson.forward_thread, true, WATCH_NOTE],
    ]);
    assert.ok(fresh.every(m => /^client-bqa-[0-9a-f]{40}$/.test(m.clientAssignedMessageId)), 'the bot\'s own ids');
    eq(t.chat.botPosts(REAL), []);
    // Burson's own thread (the row's source_thread, in S-F Burson) got nothing: only forward_thread is ever read
    assert.ok(String(cards.burson.source_thread).indexOf(REAL + '/threads/') === 0);
    eq(inThread(t, cards.burson.source_thread), []);
    // the check alone (it posts and counts nothing): ok, with the space, the thread and the text a note would have
    const flowCheck = check(t, got.ctx, cards.pixel, `  ${STORY_NOTE}\n`);
    const watchCheck = check(t, got.dest, cards.pixel, WATCH_NOTE);
    eq([flowCheck.ok, flowCheck.space, flowCheck.thread, flowCheck.text, flowCheck.ctx === got.ctx],
      [true, AC, cards.pixel.forward_thread, STORY_NOTE, true]);
    eq([watchCheck.ok, watchCheck.space, watchCheck.thread, watchCheck.text, watchCheck.ctx], [true, AC, cards.pixel.forward_thread, WATCH_NOTE, null]);
    eq(posted(t).length, before.length + 3);
  });

  test('thread notes: the bot never answers its own note: at the next runs each note gets no reply and no Gemini call, read back with its message id and with no id at all (Chat\'s custom ids gone and the bot\'s record of its posts dropped: only the first words tell); a message from the bot\'s account in the same threads that doesn\'t start with one of the fixed first words is answered', () => {
    const { t, cards } = oneSpace();
    const notes = [[cards.pixel, STORY_NOTE, 'k1'], [cards.maps, REQ_NOTE, 'k2'], [cards.story, REQ_FINAL, 'k3']];
    run(t, ctx => notes.map(([card, text, key]) => t.bot.acThreadNote_(ctx, card, text, key)),
      dest => t.bot.acThreadNote_(dest, cards.watch, WATCH_NOTE, 'k4'));
    const all = notes.concat([[cards.watch, WATCH_NOTE, 'k4']]);
    const repliesOf = card => inThread(t, card.forward_thread).map(m => m.text);
    const baseline = all.map(([card]) => repliesOf(card));
    all.forEach(([card, text], i) => assert.strictEqual(baseline[i][baseline[i].length - 1], text));
    const answers = () => t.g.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.answer).length;
    const asked = answers();
    // 1. with their ids: the next runs leave them alone
    t.poll();
    t.poll();
    eq([all.map(([card]) => repliesOf(card)), answers()], [baseline, asked]);
    // 2. with no id at all: Chat's custom ids gone, the bot's record of what it posted dropped, nothing remembered as
    // handled; the notes are read again (the flow re-reads the last minutes) and still get no answer
    const forget = () => {
      t.chat.spaces.get(AC).messages.filter(m => m.threadReply && NOTES.indexOf(m.text) >= 0).forEach(m => { delete m.clientAssignedMessageId; });
      ['bot_posts', 'bot_post_ids', 'bot_reactions', 'recent:AC:' + REAL].forEach(k => t.g.cache.delete(k));
      t.bot.ev('BOT_MARKS_ = null');
    };
    forget();
    const ctx = run(t).ctx;
    const read = t.bot.chatListMessages_(AC, new Date(t.g.clock.now - 20 * MIN).toISOString(), 1000).filter(m => NOTES.indexOf(m.text) >= 0);
    eq([read.length, read.map(m => m.clientId), read.map(m => t.bot.isOwnMessage_(ctx, m))], [4, ['', '', '', ''], [true, true, true, true]]);
    eq([all.map(([card]) => repliesOf(card)), answers()], [baseline, asked]);
    forget();
    t.poll();
    eq([all.map(([card]) => repliesOf(card)), answers()], [baseline, asked]);
    // 3. the same threads do answer: a message from the bot's account (a person can write from it) that names an alert
    // field but starts with none of the fixed first words gets its answer, with or without ids
    const ask = t.chat.say(AC, 'Another post on this issue: 2,400 engagements, 88K followers', { thread: cards.pixel.forward_thread, sender: 'users/bot' });
    forget();
    t.poll();
    eq([answers(), repliesOf(cards.pixel).slice(-2)], [asked + 1, [ask.text, 'Happy to help with that.']]);
  });

  test('thread notes: refused, with nothing posted anywhere: any flow that is not the Auto-correct flow (the Mirror flow, a test feed with its analyst space, the bot working directly in B25 under row 32, the Other alerts space; nor a flow that only carries the Auto-correct flow\'s flag in a space that flow doesn\'t work in), and from the Auto-correct flow a thread in any of those spaces, a card whose message is in another space, a blank thread (source_thread is never used), a space people outside Google can join, S-F Burson or the Burson test copy; from the watch, alerts that go anywhere but the Auto-correct space, or a space the Auto-correct flow never worked in; a note that starts with other words; no key', () => {
    const { t, cards } = oneSpace();
    const OTHER = 'spaces/AAQAotherGf01';
    const DIRECT = 'spaces/AAQAdirectGf1';
    t.chat.addSpace(MIRROR, 'SLRR Zapier Training Mirror');
    t.chat.addSpace(OTHER, 'Midterms 2026');
    t.chat.addSpace(DIRECT, 'Campaign alerts');
    // a card in each of the other spaces, as its flow's Alert-log row would have it
    const cardIn = space => {
      const m = t.chat.say(space, 'a card', { sender: 'users/bot' });
      return { forward_thread: m.thread.name, forward_message: m.name, source_thread: m.thread.name, source_message: m.name };
    };
    const elsewhere = { mirror: cardIn(MIRROR), feed: cardIn(TEST_FEED), triaged: cardIn(TRIAGED), direct: cardIn(DIRECT), other: cardIn(OTHER) };
    const live = t.chat.say(REAL, F.P0_OK, { sender: 'users/zapier', type: 'BOT' });
    const got = run(t);
    const ac = got.ctx;
    const dest = got.dest;
    const sfb = { id: REAL, name: '[S-F] Burson Automated Alerts V3', externalUserAllowed: true };
    const space = (id, name) => ({ id, name, externalUserAllowed: false });
    const flow = cfg => t.bot.buildCtx_(cfg, t.sheet(), t.bot.switchesOff_());
    const flows = {
      mirror: flow({ burson: space(MIRROR, 'Mirror'), analyst: space(MIRROR, 'Mirror'), mirror: space(MIRROR, 'Mirror'), outboundBlocked: true, sfBurson: sfb }),
      feed: flow({ burson: space(TEST_FEED, 'Feed'), analyst: space(TRIAGED, 'Analysts'), sfBurson: sfb }),
      direct: flow(t.bot.directCfg_(space(DIRECT, 'Campaign alerts'))),
      other: flow(t.bot.otherSpaceCfg_(space(OTHER, 'Midterms 2026'))),
    };
    t.bot.setSfBurson_(sfb);  // buildCtx_ is the run's: the run's S-F Burson stays as poll() set it
    const before = posted(t);
    const NOT_AC = 'this is not the Auto-correct flow';
    const refused = (from, card, text, why, key) => {
      eq([t.bot.acThreadNote_(from, card, text, key === undefined ? 'k' : key), check(t, from, card, text)], [false, { ok: false, why }], why);
    };
    // 1. other flows, each with a card of its own space
    refused(flows.mirror, elsewhere.mirror, STORY_NOTE, NOT_AC);
    refused(flows.feed, elsewhere.triaged, STORY_NOTE, NOT_AC);
    refused(flows.feed, elsewhere.feed, STORY_NOTE, NOT_AC);
    refused(flows.direct, elsewhere.direct, STORY_NOTE, NOT_AC);
    refused(flows.other, elsewhere.other, STORY_NOTE, NOT_AC);
    // ...and with a card that is in the Auto-correct space: the flow decides, not the card
    Object.keys(flows).forEach(k => refused(flows[k], cards.pixel, STORY_NOTE, NOT_AC));
    // a flow that only carries the Auto-correct flow's flag is not taken for it: its space must be the one the
    // Auto-correct flow works in (LAST_AC_SPACE), with a card of its own space as with one in the Auto-correct space
    const forged = Object.assign({}, flows.feed, { sourceReadOnly: true });
    eq([forged.spaces.analyst.id, t.g.props.get('LAST_AC_SPACE')], [TRIAGED, AC]);
    refused(forged, elsewhere.triaged, STORY_NOTE, 'the Auto-correct flow hasn\'t worked in that space');
    refused(forged, cards.pixel, STORY_NOTE, 'the Auto-correct flow hasn\'t worked in that space');
    refused(Object.assign({}, flows.feed, { sourceReadOnly: 'true' }), elsewhere.triaged, STORY_NOTE, NOT_AC);
    // 2. the Auto-correct flow, with a card that isn't in the Auto-correct space
    const NOT_THERE = 'the card\'s thread is not in the Auto-correct space';
    ['mirror', 'feed', 'triaged', 'direct', 'other'].forEach(k => refused(ac, elsewhere[k], STORY_NOTE, NOT_THERE));
    refused(ac, { forward_thread: live.thread.name, forward_message: live.name }, STORY_NOTE, NOT_THERE);  // the live Burson space
    refused(ac, { thread: cards.pixel.forward_thread, message: elsewhere.mirror.forward_message }, STORY_NOTE,
      'the card\'s message is not in the Auto-correct space');
    refused(ac, { thread: cards.pixel.forward_thread, message: '' }, STORY_NOTE, 'the card\'s message is not in the Auto-correct space');
    refused(ac, { thread: AC + '/threads', message: cards.pixel.forward_message }, STORY_NOTE, NOT_THERE);
    // a blank thread: the row of an alert whose copy was held back has no forward_thread, and source_thread never stands in
    refused(ac, Object.assign({}, cards.burson, { forward_thread: '' }), STORY_NOTE, 'the card has no thread');
    refused(ac, { forward_thread: '', forward_message: '', source_thread: cards.pixel.forward_thread, source_message: cards.pixel.forward_message },
      STORY_NOTE, 'the card has no thread');
    refused(ac, null, STORY_NOTE, 'the card has no thread');
    // 3. a space that may not be written: open to people outside Google, S-F Burson itself, the Burson test copy
    const like = patch => Object.assign({}, ac, patch);
    const OUTSIDE = 'people outside Google can join the space';
    refused(like({ spaces: { burson: ac.spaces.burson, analyst: Object.assign({}, ac.spaces.analyst, { externalUserAllowed: true }) } }),
      cards.pixel, STORY_NOTE, OUTSIDE);
    t.bot.noteOutsideSpace_(AC);
    refused(ac, cards.pixel, STORY_NOTE, OUTSIDE);
    refused(dest, cards.pixel, WATCH_NOTE, OUTSIDE);
    t.bot.setSfBurson_(sfb);  // (forgets the outside spaces noted)
    refused(like({ spaces: { burson: ac.spaces.burson, analyst: ac.spaces.burson } }), { thread: live.thread.name, message: live.name }, STORY_NOTE,
      'the space is S-F Burson');
    t.bot.setSfBurson_({ id: AC, name: 'x' });
    refused(like({ sfBurson: null, spaces: { burson: space(TEST_FEED, 'Feed'), analyst: ac.spaces.analyst } }), cards.pixel, STORY_NOTE,
      'the space is S-F Burson');
    refused(dest, cards.pixel, WATCH_NOTE, 'the space is S-F Burson');
    t.bot.setSfBurson_(sfb);
    t.bot.setTestCopy_({ id: AC, name: 'x' });
    refused(ac, cards.pixel, STORY_NOTE, 'the space is the Burson test copy');
    refused(dest, cards.pixel, WATCH_NOTE, 'the space is the Burson test copy');
    t.bot.setTestCopy_(null);
    refused(like({ spaces: { burson: ac.spaces.burson, analyst: null } }), cards.pixel, STORY_NOTE, 'there is no Auto-correct space');
    // 4. the watch: its alerts go elsewhere (or nowhere), or to a space the Auto-correct flow never worked in
    const ELSE = 'the watch\'s alerts don\'t go to the Auto-correct space';
    refused({ choice: 'mirror', space: { id: MIRROR, name: 'Mirror' }, problem: '' }, elsewhere.mirror, WATCH_NOTE, ELSE);
    refused({ choice: 'mirror', space: { id: AC, name: 'x' }, problem: '' }, cards.pixel, WATCH_NOTE, ELSE);
    refused({ choice: 'other', space: { id: OTHER, name: 'Midterms 2026' }, problem: '' }, elsewhere.other, WATCH_NOTE, ELSE);
    refused({ choice: '', space: null, problem: '' }, cards.pixel, WATCH_NOTE, ELSE);
    refused({ choice: 'autocorrect', space: null, problem: 'the Auto-correct space (B10) is blank' }, cards.pixel, WATCH_NOTE, 'there is no Auto-correct space');
    refused({ choice: 'autocorrect', space: { id: MIRROR, name: 'Mirror' }, problem: '' }, elsewhere.mirror, WATCH_NOTE,
      'the Auto-correct flow hasn\'t worked in that space');
    refused(dest, elsewhere.mirror, WATCH_NOTE, NOT_THERE);
    const lastAc = t.g.props.get('LAST_AC_SPACE');
    t.g.props.delete('LAST_AC_SPACE');
    refused(dest, cards.pixel, WATCH_NOTE, 'the Auto-correct flow hasn\'t worked in that space');
    t.g.props.set('LAST_AC_SPACE', lastAc);
    // 5. nobody's flow, a note that starts with other words, no text, no key
    refused(null, cards.pixel, STORY_NOTE, 'there is no flow or watch destination');
    refused({}, cards.pixel, STORY_NOTE, 'there is no flow or watch destination');
    const FIRST = 'the note doesn\'t start with one of the fixed first words';
    ['Another post on this issue: 2,400 engagements', '🔗 *Same thread: 2 more posts*', 'FYI: Part of a story: 5 accounts', 'part of a story: 5 accounts']
      .forEach(text => refused(ac, cards.pixel, text, FIRST));
    refused(ac, cards.pixel, '  ', 'there is no text');
    refused(ac, cards.pixel, null, 'there is no text');
    eq([t.bot.acThreadNote_(ac, cards.pixel, STORY_NOTE, ''), t.bot.acThreadNote_(ac, cards.pixel, STORY_NOTE, null)], [false, false]);
    // nothing was posted anywhere, and the same card takes a note once everything is in place again
    eq(posted(t), before);
    eq([t.bot.acThreadNote_(ac, cards.pixel, STORY_NOTE, 'k'), t.bot.acThreadNote_(dest, cards.maps, WATCH_NOTE, 'k2'), posted(t).length], [true, true, before.length + 2]);
  });

  test('thread notes: in the Mirror flow itself (rows 15, 19, 22, 24 and 34 ON; first Testing with a Burson test copy, then LIVE) nothing is posted under a card: not from the flow, not from the watch whose alerts go to the Mirror space, not on a card\'s source_thread; the Mirror space, the test copy and the Burson outbox are as they were; and an analyst who quotes a note in the Mirror space is not relayed to S-F Burson (the wider guard holds its first words)', () => {
    const t = hooked(golden.mirrorRun().t);
    const rows = alertRows(t);
    const state = () => JSON.stringify([posted(t), (t.sheet().getSheetByName('Burson outbox') || { rows: [] }).rows]);
    const before = state();
    const said = [];
    const got = run(t, ctx => rows.forEach(row => {
      NOTES.forEach((text, i) => said.push(t.bot.acThreadNote_(ctx, row, text, `m:${row.alert_id}:${i}`)));
      said.push(t.bot.acThreadNote_(ctx, { thread: row.source_thread, message: row.source_message }, STORY_NOTE, `s:${row.alert_id}`));
    }), dest => rows.forEach(row => said.push(t.bot.acThreadNote_(dest, row, WATCH_NOTE, `w:${row.alert_id}`))));
    eq([rows.length >= 5, said.length, said.some(Boolean), got.ctx.outboundBlocked, got.ctx.sourceReadOnly, got.dest.choice, got.dest.space.id],
      [true, rows.length * 6, false, true, false, 'mirror', MIRROR]);
    eq(state(), before);
    // LIVE, with the Relay: an analyst pastes a note under an alert's copy. It stays in the Mirror space
    const copy = t.chat.botPosts(MIRROR).filter(m => !m.threadReply && /SOCIAL ALERT/.test(m.text)).slice(-1)[0];
    const quote = t.chat.say(MIRROR, `fyi ${plainOf(STORY_NOTE)}`, { thread: copy.thread.name, sender: 'users/analyst9', displayName: 'Dana Lee' });
    t.poll();
    const outbox = t.sheet().getSheetByName('Burson outbox').rows.slice(1);
    assert.ok(!outbox.some(r => /Part of a story/.test(String(r[3]))), 'not queued for S-F Burson');
    eq(inThread(t, quote.thread.name).slice(-1).map(m => m.text),
      ['Not sent to S-F Burson: it mentions "Part of a story:". Post it again without that, or start it with "internal:" to keep it here.']);
    eq([t.chat.botPosts(REAL), t.chat.botPosts(COPY).some(m => /Part of a story/.test(m.text))], [[], false]);
  });

  // =============================================================================================================
  // Once per key, 3 under one card, 6 a run
  // =============================================================================================================

  test('thread notes: once per key (the same key again posts nothing and is still true, also with the counts gone: Chat keeps the message\'s id); at most 3 notes under one card, of all kinds together (the fourth is refused, and again in later runs; other cards still take theirs); at most 6 a run, the flow\'s and the watch\'s together (the next run takes more); a note Chat refuses counts for nothing', () => {
    const { t, cards } = oneSpace();
    const count = card => inThread(t, card.forward_thread).filter(m => NOTES.indexOf(m.text) >= 0).length;
    const cache = () => JSON.parse(t.g.cache.get('ac_thread_notes') || 'null');
    // once per key
    let got = run(t, ctx => [t.bot.acThreadNote_(ctx, cards.pixel, STORY_NOTE, 'same'), t.bot.acThreadNote_(ctx, cards.pixel, STORY_NOTE, 'same'),
      t.bot.acThreadNote_(ctx, cards.pixel, REQ_NOTE, 'same')]);
    eq([got.flow, count(cards.pixel), Object.keys(cache().k).length, Object.values(cache().c).map(v => v[0])], [[true, true, true], 1, 1, [1]]);
    got = run(t, ctx => t.bot.acThreadNote_(ctx, cards.pixel, STORY_NOTE, 'same'), dest => t.bot.acThreadNote_(dest, cards.pixel, STORY_NOTE, 'same'));
    eq([got.flow, got.watch, count(cards.pixel)], [true, true, 1]);
    // the counts gone (the script cache dropped them): the same key still makes no second message
    t.g.cache.delete('ac_thread_notes');
    got = run(t, ctx => t.bot.acThreadNote_(ctx, cards.pixel, STORY_NOTE, 'same'));
    eq([got.flow, count(cards.pixel)], [true, 1]);
    t.g.cache.delete('ac_thread_notes');

    // 3 under one card, all kinds together: two from the flow and one from the watch, then no more
    got = run(t, ctx => [t.bot.acThreadNote_(ctx, cards.maps, STORY_NOTE, 'a'), t.bot.acThreadNote_(ctx, cards.maps, REQ_NOTE, 'b')],
      dest => [t.bot.acThreadNote_(dest, cards.maps, WATCH_NOTE, 'c'), t.bot.acThreadNote_(dest, cards.maps, REQ_FINAL, 'd')]);
    eq([got.flow, got.watch, count(cards.maps)], [[true, true], [true, false], 3]);
    got = run(t, ctx => [t.bot.acThreadNote_(ctx, cards.maps, REQ_FINAL, 'd'), t.bot.acThreadNote_(ctx, cards.maps, STORY_NOTE, 'a'),
      t.bot.acThreadNote_(ctx, cards.story, REQ_FINAL, 'e')]);
    eq([got.flow, count(cards.maps), count(cards.story)], [[false, true, true], 3, 1]);  // 'a' is there already: true, nothing new
    assert.ok(t.g.logs.some(l => l === 'thread note not posted: its card already has 3 notes'), 'the run log says why');

    // 6 a run, the flow's and the watch's together; a seventh waits for the next run
    const keys = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
    const order = [cards.burson, cards.burson, cards.burson, cards.watch, cards.watch, cards.watch, cards.pixel, cards.story];
    const asked = () => threadReads(t) + idReads(t);  // what Chat was asked to find out about a card or a note
    got = run(t, ctx => keys.slice(0, 4).map((k, i) => t.bot.acThreadNote_(ctx, order[i], REQ_NOTE, k)),
      dest => keys.slice(4).map((k, i) => {
        const before = asked();
        return [t.bot.acThreadNote_(dest, order[i + 4], WATCH_NOTE, k), asked() - before];
      }));
    eq([got.flow, got.watch.map(r => r[0]), count(cards.burson), count(cards.watch)], [[true, true, true, true], [true, true, false, false], 3, 3]);
    eq(got.watch.slice(2), [[false, 0], [false, 0]]);  // past the run's 6, nothing is read or asked for a note either
    assert.ok(t.g.logs.some(l => l === 'thread note not posted: this run already posted 6 notes'), 'the run log says why');
    got = run(t, ctx => [t.bot.acThreadNote_(ctx, cards.pixel, WATCH_NOTE, 'r7'), t.bot.acThreadNote_(ctx, cards.story, WATCH_NOTE, 'r8')]);
    eq([got.flow, count(cards.pixel), count(cards.story)], [[true, true], 2, 2]);

    // a note Chat refuses is not posted, not counted, and can go at a later run
    const failed = oneSpace();
    failed.t.chat.fail = (method, path) => (method === 'post' && path === AC + '/messages' ? { code: 500, body: { error: { message: 'backend error' } } } : null);
    got = run(failed.t, ctx => failed.t.bot.acThreadNote_(ctx, failed.cards.pixel, STORY_NOTE, 'x'),
      dest => failed.t.bot.acThreadNote_(dest, failed.cards.maps, WATCH_NOTE, 'y'));
    eq([got.flow, got.watch, failed.t.g.cache.get('ac_thread_notes') || null], [false, false, null]);
    failed.t.chat.fail = null;
    got = run(failed.t, ctx => failed.t.bot.acThreadNote_(ctx, failed.cards.pixel, STORY_NOTE, 'x'));
    eq([got.flow, inThread(failed.t, failed.cards.pixel.forward_thread).filter(m => m.text === STORY_NOTE).length], [true, 1]);
  });

  // How often a card's thread was read to count its notes, and how often Chat was asked for a note by its id
  const threadReads = t => t.chat.calls.filter(c => c.method === 'get' && /\/messages$/.test(c.path) &&
    /^thread\.name = /.test(String((c.query || {}).filter || ''))).length;
  const idReads = t => t.chat.calls.filter(c => c.method === 'get' && /\/messages\/client-bqa-[0-9a-f]{40}$/.test(c.path)).length;
  const cacheOf = t => JSON.parse(t.g.cache.get('ac_thread_notes') || 'null');
  const noteCount = (t, thread) => inThread(t, thread).filter(m => NOTES.indexOf(m.text) >= 0 || NOTES.map(plainOf).indexOf(m.text) >= 0).length;
  /** One run in which each of `list` ([card, text, key]) is tried: [[posted or there, threads read for it, asked by id for it]]. */
  const tryNotes = (t, list) => run(t, ctx => list.map(([card, text, key]) => {
    const before = [threadReads(t), idReads(t)];
    return [t.bot.acThreadNote_(ctx, card, text, key), threadReads(t) - before[0], idReads(t) - before[1]];
  })).flow;
  /** A card posted now in the Auto-correct space, as a caller hands over one this run posted: {thread, message, createTime}. */
  const cardNow = t => {
    const m = t.chat.say(AC, 'a card', { sender: 'users/bot' });
    return { thread: m.thread.name, message: m.name, createTime: t.bot.parseRfc3339_(m.createTime) };
  };
  const untimed = card => ({ thread: card.thread, message: card.message });
  /** Chat's custom ids gone from the notes, and the bot's record of what it posted dropped: a note has no id to be known by. */
  const forgetIds = t => {
    t.chat.spaces.get(AC).messages.filter(m => m.threadReply && NOTES.indexOf(m.text) >= 0).forEach(m => { delete m.clientAssignedMessageId; });
    ['bot_posts', 'bot_post_ids', 'bot_reactions'].forEach(k => t.g.cache.delete(k));
    t.bot.ev('BOT_MARKS_ = null');
  };

  test('thread notes: the cap of 3 holds for a card\'s life, and what its thread holds is the truth; the counts in the script cache only save reading it. A card from before the counts began has its notes counted in its thread, once; a card that came after and says when (the createTime of a card this run posted, an Alert-log row\'s times) needs no read; one that doesn\'t say is read once. A full card stays full a day later (by the counts), 26 hours later (the counts no longer have it: its thread says 3) and with the cache value gone; a key from before is then still true, with no second message', () => {
    const { t, cards } = oneSpace();
    const pixel = cards.pixel;
    // 1. no counts yet, a card that was there before: one read of its thread for its first note, none for the next ones;
    // the fourth is refused (Chat is asked once whether that key's note is there after all)
    eq(tryNotes(t, [[pixel, REQ_NOTE, 'a'], [pixel, STORY_NOTE, 'b'], [pixel, WATCH_NOTE, 'c'], [pixel, REQ_FINAL, 'd']]),
      [[true, 1, 0], [true, 0, 0], [true, 0, 0], [false, 0, 1]]);
    const began = cacheOf(t).s;
    eq([noteCount(t, pixel.forward_thread), cacheOf(t).c[t.bot.hashText_(pixel.forward_thread)][0], began > 0 && began <= t.g.clock.now], [3, 3, true]);
    // 2. cards that came after the counts began: one that says when it was posted is not read; one that doesn't is, once
    const timed = cardNow(t);
    const plain = cardNow(t);
    eq(tryNotes(t, [[timed, REQ_NOTE, 'e'], [untimed(plain), REQ_NOTE, 'f'], [untimed(plain), STORY_NOTE, 'g']]), [[true, 0, 0], [true, 1, 0], [true, 0, 0]]);
    // ...and so is an Alert-log row made since: Burson's next alert, corrected and posted in the space
    t.chat.say(REAL, F.P0_OK, ZAPIER);
    t.poll();
    const fresh = alertRows(t).filter(r => !r.ingested).slice(-1)[0];
    assert.ok(fresh.alert_id !== cards.burson.alert_id && Number(fresh.source_at) > began && Number(fresh.created_at) > began, 'a row made since');
    eq(tryNotes(t, [[fresh, REQ_NOTE, 'h']]), [[true, 0, 0]]);
    eq(cacheOf(t).s, began);  // the counts have known every note since they began
    // 3. a day later the card is still full, by the counts
    t.g.clock.now += 24 * HOUR;
    eq([tryNotes(t, [[pixel, REQ_NOTE, 'i']]), noteCount(t, pixel.forward_thread)], [[[false, 0, 1]], 3]);
    // 4. 26 hours after its last note the counts have let the card go: its thread is read, and says 3, for the card's life
    t.g.clock.now += 2 * HOUR;
    eq([cacheOf(t).c[t.bot.hashText_(pixel.forward_thread)] !== undefined, tryNotes(t, [[pixel, REQ_NOTE, 'j']]), noteCount(t, pixel.forward_thread)],
      [true, [[false, 1, 1]], 3]);
    eq(cacheOf(t).c[t.bot.hashText_(pixel.forward_thread)][0], 3);
    // a key from before, forgotten with it: its note is there (Chat has it under its id), so it is true and nothing is posted
    eq([tryNotes(t, [[pixel, REQ_NOTE, 'a'], [pixel, STORY_NOTE, 'b']]), noteCount(t, pixel.forward_thread)], [[[true, 0, 1], [true, 0, 1]], 3]);
    // 5. the cache dropped the value: the thread again; the card found full, an old key's note found there while counting
    t.g.cache.delete('ac_thread_notes');
    eq([tryNotes(t, [[pixel, REQ_FINAL, 'k'], [pixel, WATCH_NOTE, 'c']]), noteCount(t, pixel.forward_thread)], [[[false, 1, 1], [true, 0, 1]], 3]);
    t.g.cache.delete('ac_thread_notes');
    eq([tryNotes(t, [[pixel, REQ_NOTE, 'a']]), noteCount(t, pixel.forward_thread)], [[[true, 1, 0]], 3]);
    eq(t.g.logs.filter(l => l === 'thread note not posted: its card already has 3 notes').length, 4);  // d, i, j, k: the run log says why
    // the other cards: two notes under the one that didn't say when, one under each of the others
    eq([noteCount(t, timed.thread), noteCount(t, plain.thread), noteCount(t, fresh.forward_thread)], [1, 2, 1]);
  });

  test('thread notes: a key posted again after the counts lost it is never a second message and never counted twice: with Chat\'s custom ids gone too (and the bot\'s record of its posts), Chat hands the first message back and the card\'s count stays; counting in a thread takes only the bot\'s own notes (a person\'s message that starts with the same words is theirs, one from the bot\'s account counts); and with a thread that can\'t be read, one longer than 200 messages, or a card that is no longer there, no note is posted', () => {
    const { t, cards } = oneSpace();
    const count = card => noteCount(t, card.thread || card.forward_thread);
    const entry = card => (cacheOf(t).c || {})[t.bot.hashText_(card.thread || card.forward_thread)] || null;
    // two notes under a card, then every record of them gone but the messages themselves
    const card = untimed(cardNow(t));
    eq(tryNotes(t, [[card, REQ_NOTE, 'a'], [card, STORY_NOTE, 'b']]), [[true, 1, 0], [true, 0, 0]]);
    t.g.cache.delete('ac_thread_notes');
    forgetIds(t);
    const posts = posted(t).length;
    // the same keys again: the thread says 2 (no id tells whose they are), Chat hands back each first message; nothing
    // new is posted and the count stays 2, so the card still takes its third note and not a fourth
    eq([tryNotes(t, [[card, REQ_NOTE, 'a'], [card, STORY_NOTE, 'b']]), posted(t).length, count(card), entry(card)[0]], [[[true, 1, 0], [true, 0, 0]], posts, 2, 2]);
    eq([tryNotes(t, [[card, WATCH_NOTE, 'c'], [card, REQ_FINAL, 'd']]), count(card), entry(card)[0]], [[[true, 0, 0], [false, 0, 1]], 3, 3]);

    // only the bot's own notes count
    const mixed = untimed(cardNow(t));
    t.chat.say(AC, 'Alert requirements: are they met for this one', Object.assign({ thread: mixed.thread }, DANA));
    t.chat.say(AC, plainOf(STORY_NOTE), { thread: mixed.thread, sender: 'users/bot' });
    t.poll();
    eq([tryNotes(t, [[mixed, REQ_NOTE, 'm1']]), entry(mixed)[0]], [[[true, 1, 0]], 2]);
    // ...and where the bot's account isn't known, every message that starts as a note does
    const unknown = untimed(cardNow(t));
    t.chat.say(AC, 'Alert requirements: are they met for this one', Object.assign({ thread: unknown.thread }, DANA));
    t.poll();
    const dest = run(t).dest;
    const botUser = t.g.props.get('BOT_USER');
    t.g.props.delete('BOT_USER');
    eq([botUser, t.bot.acThreadNote_(dest, unknown, WATCH_NOTE, 'u1'), entry(unknown)[0]], ['users/bot', true, 2]);
    t.g.props.set('BOT_USER', botUser);

    // a thread that can't be read: nothing is posted, and the try leaves no count behind
    const dark = untimed(cardNow(t));
    t.chat.fail = (method, path, query) => (method === 'get' && /^thread\.name = /.test(String((query || {}).filter || ''))
      ? { code: 500, body: { error: { message: 'backend error' } } } : null);
    eq([tryNotes(t, [[dark, REQ_NOTE, 'x1']]).map(r => r[0]), entry(dark)], [[false], null]);
    t.chat.fail = null;
    const unread = () => t.g.logs.filter(l => l === 'thread note not posted: its card\'s thread couldn\'t be read to count the notes it has').length;
    eq(unread(), 1);  // the run log says why
    // a thread too long to count in (its card, then 201 replies): none either, after two pages of it
    const long = untimed(cardNow(t));
    const ago = ms => new Date(t.g.clock.now - ms).toISOString();  // (dated back, so the flow has nothing to read in them)
    t.chat.message(long.message).createTime = ago(2 * HOUR);
    for (let i = 0; i < 201; i++) t.chat.say(AC, `reply ${i}`, Object.assign({ thread: long.thread }, DANA)).createTime = ago(HOUR);
    eq([tryNotes(t, [[long, REQ_NOTE, 'x2']]), entry(long), unread()], [[[false, 2, 0]], null, 2]);
    // a card that is no longer in the space (someone deleted it; its row and its thread are still there)
    const gone = untimed(cardNow(t));
    t.chat.say(AC, 'a reply under it', Object.assign({ thread: gone.thread }, DANA));
    const space = t.chat.spaces.get(AC);
    space.messages = space.messages.filter(m => m.name !== gone.message);
    eq([tryNotes(t, [[gone, REQ_NOTE, 'x3']]), entry(gone)], [[[false, 1, 0]], null]);
    assert.ok(t.g.logs.some(l => l === 'thread note not posted: its card is no longer in the space'), 'the run log says why');
    eq([dark, long, gone].map(c => noteCount(t, c.thread)), [0, 0, 0]);
    // once they can be read again, the dark card takes its note
    eq(tryNotes(t, [[dark, REQ_NOTE, 'x1']]), [[true, 1, 0]]);
  });

  test('thread notes: the counts are one script-cache value {s, c, k}: a card\'s count and a key kept 25 hours after its last note, written again at every note tried (the cache keeps a value 6 hours at most), `s` since when it has known every note. Its worst case, 500 cards and 1,500 keys, stays under the 90,000 characters a cache value should hold; a card\'s count that goes for room moves `s` up to that card\'s last note, so its notes are counted in its thread again; a value that can\'t be read, or one from before `s` was kept, knows nothing from before now', () => {
    const { t, cards } = oneSpace();
    const puts = [];  // every write of the value: [seconds it is kept]
    t.bot.ev('CacheService = (cs => ({ getScriptCache: () => { const c = cs.getScriptCache(); return Object.assign({}, c, { put: (k, v, s) => { ' +
      'if (k === "ac_thread_notes") __puts.push(s); return c.put(k, v, s); } }); } }))(CacheService)');
    t.bot.__puts = puts;
    const ctx = run(t).ctx;  // the Auto-correct flow's ctx, used below as a run built by hand
    const note = (card, text, key) => t.bot.acThreadNote_(ctx, card, text, key);
    const at = t.g.clock.now;
    // every try writes the value again for 6 hours: a note posted, the same key again, a refused one
    eq([['a', 'b', 'b', 'c', 'd'].map(k => note(cards.pixel, REQ_NOTE, k)), puts], [[true, true, true, true, false], [21600, 21600, 21600, 21600, 21600]]);
    const value = cacheOf(t);
    eq([Object.keys(value).sort(), value.s, Object.keys(value.c).length, Object.values(value.c).map(v => v[0]), Object.keys(value.k).length],
      [['c', 'k', 's'], at, 1, [3], 3]);
    // read back: what is younger than 25 hours, with since when
    const now = t.g.clock.now;
    t.g.cache.set('ac_thread_notes', JSON.stringify({ s: now - 30 * HOUR, c: { old: [3, now - 26 * HOUR], young: [2, now - HOUR], odd: 'x' },
      k: { old: now - 26 * HOUR, young: now - HOUR } }));
    eq(t.bot.acNoteState_(now), { s: now - 30 * HOUR, c: { young: [2, now - HOUR] }, k: { young: now - HOUR } });
    // a value from before `s` was kept, one that says a time to come, and one that isn't the bot's JSON: nothing is known from before now
    [JSON.stringify({ c: { young: [2, now - HOUR] }, k: {} }), JSON.stringify({ s: now + HOUR, c: { young: [2, now - HOUR] }, k: {} }),
      JSON.stringify({ s: 'x', c: { young: [2, now - HOUR] }, k: {} })].forEach(v => {
      t.g.cache.set('ac_thread_notes', v);
      eq(t.bot.acNoteState_(now), { s: now, c: { young: [2, now - HOUR] }, k: {} }, v);
    });
    ['not json', '[1,2]', '"text"', 'null', '7'].forEach(v => {
      t.g.cache.set('ac_thread_notes', v);
      eq(t.bot.acNoteState_(now), { s: now, c: {}, k: {} }, v);
    });
    t.g.cache.delete('ac_thread_notes');
    eq(t.bot.acNoteState_(now), { s: now, c: {}, k: {} });
    // the worst case of the value: the newest 500 cards and 1,500 keys
    const state = { s: now - 20 * HOUR, c: {}, k: {} };
    const cardHash = i => t.bot.hashText_(`${AC}/threads/${'t'.repeat(40)}${i}`);
    const keyHash = i => t.bot.hashText_(`${'k'.repeat(900)}${i}`);
    for (let i = 0; i < 700; i++) state.c[cardHash(i)] = [3, now - i * 1000];
    for (let i = 0; i < 2500; i++) state.k[keyHash(i)] = now - i * 1000;
    t.bot.acNoteSave_(state);
    const saved = t.g.cache.get('ac_thread_notes');
    const kept = JSON.parse(saved);
    eq([Object.keys(kept.c).length, Object.keys(kept.k).length, saved.length <= 90000, saved.length > 50000], [500, 1500, true, true]);
    assert.ok(kept.c[cardHash(0)] && kept.c[cardHash(499)] && !kept.c[cardHash(500)] && kept.k[keyHash(0)] && !kept.k[keyHash(2499)], 'the newest are kept');
    // the newest card that went for room had its last note 500 seconds ago: the value no longer knows every note of a
    // card that old (a key that goes costs nothing: Chat keeps the message under its id)
    eq(kept.s, now - 500 * 1000);
    const roomy = { s: now - 20 * HOUR, c: { one: [1, now - HOUR] }, k: {} };
    t.bot.acNoteSave_(roomy);
    eq(cacheOf(t).s, now - 20 * HOUR);  // with room for every card, since when stays
    // so a card with no count that is younger than the value's knowledge needs no read, and an older one does
    t.bot.acNoteSave_({ s: now - 600 * 1000, c: {}, k: {} });
    const reads = threadReads(t);
    const young = { thread: cards.maps.forward_thread, message: cards.maps.forward_message, createTime: now - 300 * 1000 };
    const older = { thread: cards.story.forward_thread, message: cards.story.forward_message, createTime: now - 900 * 1000 };
    eq([note(young, REQ_NOTE, 'y'), threadReads(t) - reads, note(older, REQ_NOTE, 'o'), threadReads(t) - reads], [true, 0, true, 1]);
    // a card that says it is older than 25 hours is read too, however long the value has known
    t.bot.acNoteSave_({ s: now - 40 * HOUR, c: {}, k: {} });
    const ancient = { thread: cards.watch.forward_thread, message: cards.watch.forward_message, createTime: now - 26 * HOUR };
    eq([note(ancient, REQ_NOTE, 'z'), threadReads(t) - reads], [true, 2]);
    eq([t.bot.acNoteCardBorn_({ created_at: 500, source_at: 300 }), t.bot.acNoteCardBorn_({ created_at: 500, source_at: 0 }),
      t.bot.acNoteCardBorn_({ created_at: '700' }), t.bot.acNoteCardBorn_({ createTime: 900 }), t.bot.acNoteCardBorn_({ createTime: '2026-10-14T12:00:00Z' }),
      t.bot.acNoteCardBorn_({ thread: 'x' }), t.bot.acNoteCardBorn_(null)], [300, 500, 700, 900, 0, 0, 0]);
    eq(B.ev('[AC_NOTE_PER_CARD_, AC_NOTE_PER_RUN_, AC_NOTE_KEEP_MS_ / 3600000, AC_NOTE_CACHE_SEC_, AC_NOTE_OLD_MS_, AC_NOTE_THREAD_MAX_]'),
      [3, 6, 25, 21600, 60000, 200]);
  });
};
