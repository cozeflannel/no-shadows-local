// Thread notes (ThreadNotes.gs acThreadNote_): the one way the bot puts a note under a card that is already in the
// Auto-correct space (B10). It posts only from the Auto-correct flow (or, for the watch, with its alerts going to the
// Auto-correct space), only under a card whose thread and message are in that space, never in S-F Burson, the Burson test
// copy or a space people outside Google can join, only a note that starts with one of the fixed first words, once per
// key, at most 3 under one card in its life (what the card's thread holds is the truth; the script cache only saves
// reading it) and 6 a run, asking Chat at most 12 times a run about its cards' notes. The bot knows such a note as its
// own and never answers it; the wider guard holds its first
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

  test('thread notes: the fixed first words ("Also flagged by the watch", "Part of a story", "Alert requirements") are registered three ways: the bot knows a note as its own only in the very shape it posts it (with its emoji and bold mark, or as Chat gives it back without them; a person\'s message from the bot\'s account that merely starts with the words stays theirs), the wider guard holds it on any way to S-F Burson (alone, as a note, quoted by an analyst, on a later line), and the leak audit\'s own list denies it; "the alert requirements" in a sentence, or being part of a story, is still anyone\'s to say', () => {
    const heads = B.ev('THREAD_NOTE_HEADS_');
    eq(heads, ['Also flagged by the watch', 'Part of a story', 'Alert requirements', 'Same story', 'Growing']);  // (Growing: a story's growth note, row 51)
    const ctx = { botUser: 'users/bot', store: { isOwnPost: () => false } };
    const own = text => B.isOwnMessage_(ctx, { senderName: 'users/bot', text });
    const held = text => B.outboxGuardHits_(text, GUARD).length > 0;
    // each real note, in the very shape the bot posts it: the bot's own, held by the wider guard, denied by the leak
    // audit. The bot knows a note as its own only in that shape (with its emoji and bold mark, or without them); a
    // message that merely starts with a head's words is a person's, and is relayed and answered as before the notes.
    // "Same story" (the watch's reply under its own alert) is held and denied only in its own shape, "Same story: N more
    // posts": "Same story:" by itself is an analyst's wording too, and reaches S-F Burson as it always did
    const SAME = 'Same story';
    const SHAPES = [WATCH_NOTE, STORY_NOTE, REQ_NOTE, REQ_FINAL, '🔗 *Same story: 1 more post*', 'Same story: 2 more posts',
      '🔗 *Part of a story:* 1 small account on X tells it (<https://chat.google.com/x|story card>)',
      '🔗 *Part of a story:* Small accounts now tell it: a title', '🔭 *Also flagged by the watch “A” and the watch “B”.* No separate Watch alert',
      '*Alert requirements:* not met yet (small accounts, no KOF author, no P0 tag). Posted early because 5 accounts tell the same story.',
      '*Alert requirements, final:* below the Social Alert thresholds (620 engagements). A Social Alert goes out anyway on the review\'s call.',
      '📈 *Growing:* 14 accounts now, up from 9 · https://x.com/b/status/2'];
    SHAPES.concat(SHAPES.map(plainOf)).forEach(text => {
      eq([B.isThreadNoteText_(text), B.isBotFormattedText_(text), own(text), held(text), leakDenied(text)], [true, true, true, true, true], text);
    });
    // every registered head is held and denied by the guard and the leak audit in a note's form (a note with new first
    // words has to be added to each); the guard's own list of them (Outbox.gs OUTBOX_NOTE_PATTERNS_) has one pattern
    // for each. The bot's own: only the shapes above
    // ("Growing", a story's growth note under row 51, is held only in its own shape too: "Growing: N accounts now")
    const shaped = h => (h === SAME ? `${SAME}: 2 more posts` : h === 'Growing' ? 'Growing: 14 accounts now' : h);
    heads.forEach(h => eq([held(`${shaped(h)}: x`), leakDenied(`${shaped(h)}: x`)], [true, true], h));
    heads.map(h => `🔗 *${h}:* and more`).concat(heads, heads.map(h => `${h}: x`), ['Same story as yesterday? Why is the product wrong?',
      'Part of a story we already sent, FYI.', 'Alert requirements look met here, can you confirm the link?',
      'Same story, different account: please hold this one.', 'Also flagged by the watch earlier, please merge',
      'Alert requirements: why was this one not met?', 'Alert requirements: met for a Social Alert?',
      'Part of a story: the one from Monday', '🔗 *Same story:* and more'])
      .forEach(text => eq([B.isThreadNoteText_(text), B.isBotFormattedText_(text), own(text)], [false, false, false], text));
    ['Same story', 'Same story: x', '🔗 *Same story:* and more'].forEach(text => {
      eq([B.isBotFormattedText_(text), held(text), leakDenied(text)], [false, false, false], text);
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

  test('thread notes: at Send, the row of the bot\'s own answer is checked as that answer always was only while its Text cell holds the very text the bot queued: the hidden key of an answer that opens as a note does keeps that text\'s fingerprint, and every other row\'s key is as it always was. A note typed or pasted into an answer\'s row, whichever answer it was, makes the row Blocked and nothing goes to S-F Burson; so does one word changed in an answer that opens as a note does. The unedited answer is sent as written, a Blocked row put back to the text the bot queued is sent, and an answer edited to words no pattern holds is sent as any text is. The same where the bot works on S-F Burson itself', () => {
    const t = golden.mirrorRun(golden.SETTINGS_OFF).t;  // ends LIVE, with rows 22 and 24 ON
    const alert = t.chat.spaces.get(REAL).messages.filter(m => !m.threadReply && /SOCIAL ALERT/.test(m.text)).slice(-1)[0];
    const rows = () => outboxRows(t);
    /** Burson asks, Gemini answers `answer`: the index of the answer's outbox row. */
    const ask = (question, answer) => {
      const n = rows().length;
      t.g.vertex.answer = () => answer;
      t.chat.say(REAL, question, Object.assign({ thread: alert.thread.name }, ALICE));
      t.poll();
      t.poll();
      eq([rows().length, rows()[n][3], /^own:ans:/.test(keyOf(rows()[n]).ck)], [n + 1, answer, true]);
      return n;
    };
    const plain = rows().findIndex(r => r[3] === 'Happy to help with that.' && r[5] === 'Pending');  // the scenario's own answer
    const first = ask('What does a P1 need to be escalated?', ANSWERS[0]);
    const second = ask('And what about a P2 like this one?', ANSWERS[1]);
    const third = ask('Is this post part of something bigger?', ANSWERS[2]);
    // the keys: only an answer that opens as a note does carries the fingerprint of its text
    eq([plain >= 0, Object.keys(keyOf(rows()[plain]))], [true, ['v', 'k', 'kind', 's', 'thread', 'ck']]);
    eq([first, second, third].map(i => Object.keys(keyOf(rows()[i]))), Array(3).fill(['v', 'k', 'kind', 's', 'thread', 'ck', 'tx']));
    eq([first, second, third].map(i => keyOf(rows()[i]).tx), ANSWERS.map(a => B.outboxTextPrint_(a)));
    const posted = () => t.chat.botPosts(REAL).map(m => m.text);
    eq(posted(), []);
    // a note pasted into the ordinary answer's row; another note pasted into an answer that opens as one; one word
    // changed in such an answer; and one left as the bot wrote it
    const PASTED = '🔗 Part of a story: 5 small accounts on X and Reddit now tell it: Pixel 10 owners say the update is the issue';
    send(t, plain, PASTED);
    send(t, first, plainOf(REQ_NOTE));
    send(t, third, ANSWERS[2].replace('Monday', 'Tuesday'));
    send(t, second);
    t.poll();
    eq([plain, first, third, second].map(i => [rows()[i][5], rows()[i][6].replace(/^sent \d{4}-\d\d-\d\d \d\d:\d\d ET: .*$/, 'sent')]), [
      ['Blocked', 'not sent: it mentions "Part of a story". Edit the text, then set Send again.'],
      ['Blocked', 'not sent: it mentions "Alert requirements". Edit the text, then set Send again.'],
      ['Blocked', 'not sent: it mentions "Part of a story". Edit the text, then set Send again.'],
      ['Sent', 'sent']]);
    eq(posted(), [ANSWERS[1]]);
    // put back to the text the bot queued, the first answer goes; edited to words no pattern holds, the third goes as
    // any text does; the ordinary one with its own words back, too
    send(t, first, ANSWERS[0]);
    send(t, third, 'The same post was escalated on Monday.');
    send(t, plain, 'Happy to help with that.');
    t.poll();
    eq([[first, third, plain].map(i => rows()[i][5]), posted()],  // (rows go top to bottom: the scenario's own answer is the first of them)
      [['Sent', 'Sent', 'Sent'], [ANSWERS[1], 'Happy to help with that.', ANSWERS[0], 'The same post was escalated on Monday.']]);

    // The bot working on S-F Burson itself: its answer's row (key "ans:…"), the same way
    const ROOM = 'https://chat.google.com/room/AAQAaa_0I9g';
    const m = e2e();
    m.bot.setup();
    m.set('B25', ROOM);
    m.set('B3', ROOM);
    [11, 23, 24].forEach(r => m.control().getRange(r, 2).setValue('ON'));  // Auto-send, Never wait on Burson, Post in S-F Burson
    m.poll();
    const ok = m.chat.say(REAL, F.P0_OK, ZAPIER);
    m.poll();
    const answerRow = answer => {
      m.g.vertex.answer = () => answer;
      m.chat.say(REAL, 'Why is this one P0?', Object.assign({ thread: ok.thread.name }, ALICE));
      m.poll();
      return outboxRows(m).findIndex(r => r[3] === answer && r[5] === 'Pending');
    };
    const usual = answerRow('Happy to help with that.');
    const likeNote = answerRow(ANSWERS[0]);
    eq([/^ans:/.test(keyOf(outboxRows(m)[usual]).ck), keyOf(outboxRows(m)[usual]).tx, keyOf(outboxRows(m)[likeNote]).tx],
      [true, undefined, B.outboxTextPrint_(ANSWERS[0])]);
    send(m, usual, PASTED);
    send(m, likeNote, `${ANSWERS[0]} (as the note under the card says)`);
    m.poll();
    eq([[usual, likeNote].map(i => outboxRows(m)[i][5]), m.chat.botPosts(REAL).map(x => x.text)], [['Blocked', 'Blocked'], []]);
    send(m, likeNote, ANSWERS[0]);
    m.poll();
    eq([outboxRows(m)[likeNote][5], m.chat.botPosts(REAL).map(x => [x.thread.name, x.text])], ['Sent', [[ok.thread.name, ANSWERS[0]]]]);
  });

  test('thread notes: what tells an answer\'s row at Send (outboxAnswerAsQueued_, outboxTextPrint_, outboxItem_). The fingerprint is the text\'s as the Text cell holds it: the same with the apostrophe put before a first character Sheets would read as a formula, with either kind of line end and with spaces around it, another for any other word. It is kept only for the bot\'s own answer, never for a row the Relay queued, an analyst\'s answer or another reply of the bot\'s, and only when the answer holds a note\'s first words; a row without it, with another text, or of the Relay is checked as every row is', () => {
    const SFB = 'spaces/AAQAaa_0I9g';
    const THREAD = `${SFB}/threads/t9`;
    const print = B.outboxTextPrint_;
    const TEXT = '*Alert requirements:* a P1 exposure tag needs 2,000+ engagements or a KOF author.';
    eq([/^[0-9a-f]{16}$/.test(print(TEXT)), print(`  ${TEXT}\n`), print(TEXT.replace(/ a P1/, '\r\na P1')), print(TEXT.replace(/ a P1/, '\ra P1')),
      print(`'${TEXT}`), print('\'- Alert requirements: a P1 needs 2,000+ engagements.')],
    [true, print(TEXT), print(TEXT.replace(/ a P1/, '\na P1')), print(TEXT.replace(/ a P1/, '\na P1')), print(TEXT), print('- Alert requirements: a P1 needs 2,000+ engagements.')]);
    assert.ok(print(TEXT) !== print(TEXT.replace('P1', 'P2')) && print(TEXT) !== print(TEXT.toLowerCase()) && print('') === print(null) && print(TEXT) !== print(''));
    // the row the bot queues
    const item = (text, key, relay) => B.outboxItem_({ kind: 'reply', text, thread: THREAD, key, from: 'bot', relay }, SFB).key;
    eq([item(TEXT, 'own:ans:m1').tx, item(TEXT, 'ans:m1').tx, item(`Sure!\n${plainOf(REQ_NOTE)}`, 'ans:m1').tx],
      [print(TEXT), print(TEXT), print(`Sure!\n${plainOf(REQ_NOTE)}`)]);
    eq([item('Happy to help with that.', 'own:ans:m1'), item('Please look at the alert requirements for this one.', 'ans:m1'),
      item(TEXT, 'own:fix:m1'), item(TEXT, 'anaans:m1'), item(TEXT, ''), item(TEXT, 'ans:m1', { m: 'spaces/AAQAmirrorgf1', tm: 'x', who: 'Dana Lee' })]
      .map(k => Object.prototype.hasOwnProperty.call(k, 'tx')), Array(6).fill(false));
    // a key as it always was, field by field
    eq(item('Happy to help with that.', 'own:ans:m1'), { v: 1, k: 'p|own:ans:m1', kind: 'reply', s: SFB, thread: THREAD, ck: 'own:ans:m1' });
    // the row at Send
    const asQueued = (key, cell) => B.outboxAnswerAsQueued_(key, cell);
    const key = item(TEXT, 'own:ans:m1');
    eq([asQueued(key, TEXT), asQueued(key, ` ${TEXT} `), asQueued(key, `'${TEXT}`), asQueued(item(TEXT, 'ans:m1'), TEXT)], [true, true, true, true]);
    eq([asQueued(key, TEXT.replace('P1', 'P2')), asQueued(key, plainOf(STORY_NOTE)), asQueued(key, ''), asQueued(key, null),
      asQueued(Object.assign({}, key, { tx: '' }), TEXT), asQueued(Object.assign({}, key, { tx: undefined }), TEXT),
      asQueued(Object.assign({}, key, { ck: 'own:fix:m1' }), TEXT), asQueued(Object.assign({}, key, { ck: 'anaans:m1' }), TEXT),
      asQueued(Object.assign({}, key, { relay: { m: 'spaces/AAQAmirrorgf1' } }), TEXT), asQueued(item('Happy to help with that.', 'own:ans:m1'), 'Happy to help with that.'),
      asQueued(null, TEXT), asQueued({}, TEXT)], Array(12).fill(false));
    // what the guard lets an answer off is exactly the notes' first words: the two checks differ by outboxNoteHits_
    [TEXT, STORY_NOTE, WATCH_NOTE, `Thanks!\n${REQ_NOTE}`, 'Happy to help with that.', '*Alert requirements:* per SLRR, a P1 needs 2,000+ engagements.',
      'Product - Perceived bias is part of a story: see the alert requirements.'].forEach(text => {
      eq(B.outboxGuardHits_(text, GUARD), B.outboxGuardHits_(text, GUARD, true).concat(B.outboxNoteHits_(text)), text);
    });
    eq([B.outboxNoteHits_(TEXT), B.outboxNoteHits_('Happy to help with that.'), B.outboxNoteHits_(null)], [['Alert requirements'], [], []]);
  });

  test('thread notes: the fixed answer that goes to Burson in place of an answer the wider guard holds lists the Resources documents as it always did, also a document whose name opens as a note does ("Alert requirements: …"): the fixed answer is queued with that document, and sent as written on Send; the Mirror space keeps Gemini\'s answer', () => {
    const t = golden.mirrorRun(golden.SETTINGS_OFF).t;
    const resources = t.sheet().getSheetByName('Resources');
    eq(resources.rows[1][0], 'SLRR Collection Requirements');
    resources.rows[1][0] = 'Alert requirements: collection rules';  // someone renames the document on the Resources tab
    const alert = t.chat.spaces.get(REAL).messages.filter(m => !m.threadReply && /SOCIAL ALERT/.test(m.text)).slice(-1)[0];
    const n = outboxRows(t).length;
    const GEMINI = 'Zapier copied it for you.';  // nothing the bot's own check holds, but a tool's name: not for Burson
    t.g.vertex.answer = () => GEMINI;
    t.chat.say(REAL, 'What does a P1 need to be escalated?', Object.assign({ thread: alert.thread.name }, ALICE));
    t.poll();
    t.poll();
    const row = outboxRows(t)[n];
    const links = resources.rows.slice(1, 3).map(r => r[1]);
    const FIXED = 'This alert does not need any updates.\n- Escalation status: This alert is being escalated — we have the escalation email in review ' +
      `right now.\nResources:\n- <${links[0]}|Alert requirements: collection rules>\n- <${links[1]}|KOF lists>`;
    H.ownAnswerInBurson(FIXED);
    eq([outboxRows(t).length, row[1], row[3], row[5], /^own:ans:/.test(keyOf(row).ck), keyOf(row).tx], [n + 1, 'reply', FIXED, 'Pending', true, B.outboxTextPrint_(FIXED)]);
    assert.ok(t.g.logs.some(l => l === 'Post in S-F Burson: the bot\'s answer mentions "Zapier", so the fixed answer goes in its place'), 'the run log says why');
    eq(t.chat.botPosts(MIRROR).slice(-1).map(m => m.text), [GEMINI]);
    send(t, n);
    t.poll();
    eq([outboxRows(t)[n][5], t.chat.botPosts(REAL).map(m => [m.thread.name, m.text])], ['Sent', [[alert.thread.name, FIXED]]]);
  });

  test('thread notes: a note quoted in another of Chat\'s marks is held as well: in italics, struck through, as code, with the colon inside the mark or after it, at the start of a text or after a name. The wider guard holds it on any way to S-F Burson and the leak audit\'s own list denies it; what is anyone\'s to say stays so', () => {
    const held = text => B.outboxGuardHits_(text, GUARD).length > 0;
    ['_Part of a story:_ 5 small accounts on X and Reddit now tell it: a title', 'Dana Lee: _Part of a story:_ 5 small accounts tell it',
      '_Alert requirements:_ met for a Social Alert: P0 exposure tag.', 'Dana Lee: fyi _Alert requirements:_ met', '🔗 _Part of a story:_ 5 accounts',
      'Dana Lee: 🔗 _Part of a story_: 5 accounts', 'Dana Lee: 🔗 *Part of a story*: 5 accounts', 'Dana Lee: ~Alert requirements, final~: met',
      'x_Alert requirements, final:_ met', '~Alert requirements:~ met', '`Alert requirements:` met', '_Also flagged by the watch “X”._ No separate Watch alert',
      'Dana Lee: it was _flagged by the watch_ today', '~Part of a story~ we alerted', '_Alert requirements_ are met', 'see below\n  _Part of a story_ again']
      .forEach(text => eq([held(text), leakDenied(text)], [true, true], text));
    // what the guard says it found: the words, with the mark only where it stands before the colon
    eq([B.outboxNoteHits_('_Part of a story:_ 5 accounts'), B.outboxNoteHits_('Dana Lee: 🔗 _Part of a story_: 5 accounts'),
      B.outboxNoteHits_('Dana Lee: it was _flagged by the watch_ today'), B.outboxNoteHits_('Dana Lee: ~Alert requirements, final~: met')],
    [['Part of a story'], ['Part of a story_:'], ['flagged by the watch'], ['Alert requirements, final~:']]);
    // ...and these are still neither held for a note's words nor denied
    ['What are the _Alert requirements_ for a P1?', 'This post is _part of a story_ we alerted yesterday.', 'Part of a storyline about maps', '_Part of a storyline_',
      'Alert requirementss', 'Also flagged by the watchdog group', 'the watch_flagged by the watcher'].forEach(text => {
      eq([B.outboxNoteHits_(text), leakDenied(text)], [[], false], text);
    });
    eq(B.outboxNoteHits_('PreAlert requirements: none'), []);  // (the words inside another word; the audit's own list is the stricter one there)
    // the bot's own notes are as they were: with the bold mark, or as Chat hands them back without it
    eq(NOTES.concat(NOTES.map(plainOf)).map(text => [B.isThreadNoteText_(text), held(text)]), Array(8).fill([true, true]));
    eq(['_Part of a story:_ 5 accounts', '~Alert requirements:~ met'].map(text => B.isThreadNoteText_(text)), [false, false]);  // a quote is not the bot's own note
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
    // 4. 26 hours after its last note the counts have let the card go: its thread is read, and says 3, for the card's
    // life (the thread just read has shown that this key's note isn't there: Chat isn't asked for it by its id as well)
    t.g.clock.now += 2 * HOUR;
    eq([cacheOf(t).c[t.bot.hashText_(pixel.forward_thread)] !== undefined, tryNotes(t, [[pixel, REQ_FINAL, 'j']]), noteCount(t, pixel.forward_thread)],
      [true, [[false, 1, 0]], 3]);
    eq(cacheOf(t).c[t.bot.hashText_(pixel.forward_thread)][0], 3);
    // a key from before, forgotten with it: its note is there (Chat has it under its id), so it is true and nothing is posted
    eq([tryNotes(t, [[pixel, REQ_NOTE, 'a'], [pixel, STORY_NOTE, 'b']]), noteCount(t, pixel.forward_thread)], [[[true, 0, 1], [true, 0, 1]], 3]);
    // 5. the cache dropped the value: the thread again; the card found full, an old key's note found there while counting
    t.g.cache.delete('ac_thread_notes');
    eq([tryNotes(t, [[pixel, REQ_FINAL, 'k'], [pixel, WATCH_NOTE, 'c']]), noteCount(t, pixel.forward_thread)], [[[false, 1, 0], [true, 0, 1]], 3]);
    t.g.cache.delete('ac_thread_notes');
    eq([tryNotes(t, [[pixel, REQ_NOTE, 'a']]), noteCount(t, pixel.forward_thread)], [[[true, 1, 0]], 3]);
    // (by its id, whatever the words are by now: the same key with other words is that note still)
    t.g.cache.delete('ac_thread_notes');
    eq([tryNotes(t, [[pixel, REQ_FINAL, 'b']]), noteCount(t, pixel.forward_thread)], [[[true, 1, 0]], 3]);
    eq(t.g.logs.filter(l => l === 'thread note not posted: its card already has 3 notes').length, 4);  // d, i, j, k: the run log says why
    // the other cards: two notes under the one that didn't say when, one under each of the others
    eq([noteCount(t, timed.thread), noteCount(t, plain.thread), noteCount(t, fresh.forward_thread)], [1, 2, 1]);
  });

  test('thread notes: a key posted again after the counts lost it is never a second message and never counted twice: with Chat\'s custom ids gone too (and the bot\'s record of its posts), Chat hands the first message back and the card\'s count stays; counting in a thread takes only the bot\'s own notes (a person\'s message that starts with the same words is theirs, one from the bot\'s account in a note\'s very shape counts); and with a thread that can\'t be read, one longer than 200 messages, or a card that is no longer there, no note is posted', () => {
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
    // ...and where the bot's account isn't known, every message in a note's very shape does (a message that only
    // starts with a note's words never does)
    const unknown = untimed(cardNow(t));
    t.chat.say(AC, 'Alert requirements: are they met for this one', Object.assign({ thread: unknown.thread }, DANA));
    t.chat.say(AC, plainOf(STORY_NOTE), Object.assign({ thread: unknown.thread }, DANA));
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
    t.g.cache.set('ac_thread_notes', JSON.stringify({ s: now - 30 * HOUR, c: { old: [3, now - 26 * HOUR], young: [2, now - HOUR], none: [0, now - HOUR] },
      k: { old: now - 26 * HOUR, young: now - HOUR } }));
    eq(t.bot.acNoteState_(now), { s: now - 30 * HOUR, c: { young: [2, now - HOUR], none: [0, now - HOUR] }, k: { young: now - HOUR } });
    // a value with anything in it that isn't as the bot writes it is not taken at its word: its sound entries are kept,
    // and it knows nothing of the cards from before now (`s`: now), so a card it has no count for is counted in its thread
    const sound = { s: now - 30 * HOUR, c: { young: [2, now - HOUR] }, k: { young: now - HOUR } };
    const unsure = { s: now, c: { young: [2, now - HOUR] }, k: { young: now - HOUR } };
    const withC = (h, v) => JSON.stringify(Object.assign({}, sound, { c: Object.assign({}, sound.c, { [h]: v }) }));
    [withC('odd', 'x'), withC('odd', 3), withC('odd', ['3', now - HOUR]), withC('odd', [-1, now - HOUR]), withC('odd', [2.5, now - HOUR]),
      withC('odd', [3]), withC('odd', [3, 'x']), withC('odd', [3, now + 10 * MIN]), withC('odd', null),
      JSON.stringify(Object.assign({}, sound, { k: { young: now - HOUR, odd: 'x' } })),
      JSON.stringify(Object.assign({}, sound, { k: { young: now - HOUR, odd: -5 } }))].forEach(v => {
      t.g.cache.set('ac_thread_notes', v);
      eq(t.bot.acNoteState_(now), unsure, v);
    });
    [[{ s: now - 30 * HOUR, c: [], k: { young: now - HOUR } }, { s: now, c: {}, k: { young: now - HOUR } }],
      [{ s: now - 30 * HOUR, c: { young: [2, now - HOUR] }, k: [] }, { s: now, c: { young: [2, now - HOUR] }, k: {} }],
      [{ s: now - 30 * HOUR, c: 'y', k: 3 }, { s: now, c: {}, k: {} }], [{ s: -5, c: {}, k: {} }, { s: now, c: {}, k: {} }],
      [{ s: now - 30 * HOUR }, { s: now, c: {}, k: {} }]].forEach(([v, want]) => {
      t.g.cache.set('ac_thread_notes', JSON.stringify(v));
      eq(t.bot.acNoteState_(now), want, JSON.stringify(v));
    });
    // (a time a little ahead of this run's clock is another run's clock, not a fault)
    t.g.cache.set('ac_thread_notes', JSON.stringify({ s: now - HOUR, c: { young: [1, now + 5000] }, k: { young: now + 5000 } }));
    eq(t.bot.acNoteState_(now), { s: now - HOUR, c: { young: [1, now + 5000] }, k: { young: now + 5000 } });
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
    // so a card with no count that is younger than the value's knowledge needs no read, and an older one does (three
    // cards of their own, each the first message of its thread, saying how old they are)
    const aged = ms => Object.assign(cardNow(t), { createTime: now - ms });
    const young = aged(300 * 1000);
    const older = aged(900 * 1000);
    const ancient = aged(26 * HOUR);
    t.bot.acNoteSave_({ s: now - 600 * 1000, c: {}, k: {} });
    const reads = threadReads(t);
    eq([note(young, REQ_NOTE, 'y'), threadReads(t) - reads, note(older, REQ_NOTE, 'o'), threadReads(t) - reads], [true, 0, true, 1]);
    // a card that says it is older than 25 hours is read too, however long the value has known
    t.bot.acNoteSave_({ s: now - 40 * HOUR, c: {}, k: {} });
    eq([note(ancient, REQ_NOTE, 'z'), threadReads(t) - reads], [true, 2]);
    // and a time handed over for a card whose thread the flow's Alert log knows to be older is not taken: the Maps
    // card's row is from before the value's knowledge, whatever createTime says
    t.bot.acNoteSave_({ s: now - 600 * 1000, c: {}, k: {} });
    const claimed = { thread: cards.maps.forward_thread, message: cards.maps.forward_message, createTime: now - 300 * 1000 };
    assert.ok(Number(cards.maps.created_at) < now - 600 * 1000, 'the Maps card is older than that');
    eq(tryNotes(t, [[claimed, REQ_NOTE, 'q']]), [[true, 1, 0]]);  // (in a run of its own: the six above were this one's share)
    eq([t.bot.acNoteCardBorn_({ created_at: 500, source_at: 300 }), t.bot.acNoteCardBorn_({ created_at: 500, source_at: 0 }),
      t.bot.acNoteCardBorn_({ created_at: '700' }), t.bot.acNoteCardBorn_({ createTime: 900 }), t.bot.acNoteCardBorn_({ createTime: '2026-10-14T12:00:00Z' }),
      t.bot.acNoteCardBorn_({ thread: 'x' }), t.bot.acNoteCardBorn_(null)], [300, 500, 700, 900, 0, 0, 0]);
    eq(B.ev('[AC_NOTE_PER_CARD_, AC_NOTE_PER_RUN_, AC_NOTE_KEEP_MS_ / 3600000, AC_NOTE_CACHE_SEC_, AC_NOTE_OLD_MS_, AC_NOTE_THREAD_MAX_, ' +
      'AC_NOTE_THREAD_PAGES_, AC_NOTE_ASKS_PER_RUN_, AC_NOTE_ASK_LEFT_MS_]'), [3, 6, 25, 21600, 60000, 200, 4, 12, 20000]);
  });

  // =============================================================================================================
  // The cap is the thread's: a later Alert-log row in a card's thread is never a young card
  // =============================================================================================================

  test('thread notes: the cap of 3 is the thread\'s, whichever of its Alert-log rows a note comes with. An update of a story is posted in the story\'s thread with a row of its own, and Burson\'s resend keeps the first card\'s thread and message under a newer row: neither row is taken for a young card. With the counts gone (the script cache dropped them) and a note under another card since, a note offered with the update\'s row or with the resend\'s row has its thread read, which says 3, and is refused, from the flow and from the watch; and a later row that carries no mark of its own is told by the earliest row the flow\'s Alert log has for that thread', () => {
    const w = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
    const { t, rec, feed } = w;
    hooked(t);
    rec.collect('setup');
    rec.step('the first run', 1);
    golden.world.watchOn(t);
    w.sh.getRange(35, 2).setValue('Auto-correct space (B10)');  // the watch's alerts go to the Auto-correct space
    rec.step('a quiet run', 5);
    rec.step('a quiet run', 5);
    rec.step('a story is found', 5, () => { feed.stories = [golden.rows.story()]; });  // (the story check is due again: 15 minutes)
    rec.step('its review', 1);
    rec.step('Burson alerts, with mistakes', 1, () => { t.chat.say(REAL, F.MISTAKES, ZAPIER); });
    rec.step('Direct BigQuery finds a post', 5, () => { feed.bsip = [golden.rows.bsipRow()]; });
    rec.step('its review', 1);
    const first = alertRows(t);
    const story = first.find(r => r.ingested === 'Early detection');
    const burson = first.find(r => !r.ingested);
    const other = first.find(r => r.ingested === 'BSIP');
    const three = (card, k) => [[card, REQ_NOTE, k + '1'], [card, STORY_NOTE, k + '2'], [card, WATCH_NOTE, k + '3']];
    // three notes under the story card and three under Burson's corrected alert; a fourth under either is refused
    eq(tryNotes(t, three(story, 's').concat(three(burson, 'b'))).map(r => r[0]), Array(6).fill(true));
    eq(tryNotes(t, [[story, REQ_FINAL, 's4'], [burson, REQ_FINAL, 'b4']]).map(r => r[0]), [false, false]);
    // Seven quiet hours: the script cache has dropped the counts. Then a note under another card: the counts begin anew
    const lose = () => {
      t.g.cache.delete('ac_thread_notes');
      eq(cacheOf(t), null);
    };
    t.g.clock.now += 7 * HOUR;
    lose();
    eq(tryNotes(t, [[other, REQ_NOTE, 'o1']]), [[true, 1, 0]]);
    const began = cacheOf(t).s;
    // The story grows: its update goes in the story's thread, with a row of its own. Burson resends the alert, fixed
    rec.step('the story grows', 20, () => {
      feed.stories = [golden.rows.story({ alert_id: 'ED-CLU-clu_chrome_tabs-202610142000', unique_low_tier_authors: 14, mention_count: 16,
        headline: 'Low-tier claim cluster (14 accounts): Chrome closed all my tabs after the update' })];
    });
    rec.step('its review', 1);
    rec.step('Burson resends the alert, fixed', 1, () => { t.chat.say(REAL, F.MISTAKES_FIXED, ZAPIER); });
    rec.step('after', 1);
    const rows = alertRows(t);
    const update = rows.find(r => r.ingested === 'Early detection' && r.alert_id !== story.alert_id);
    const resend = rows.find(r => r.resend_of === burson.alert_id);
    // each is a newer row, made after the counts began, in the first card's thread
    eq([update.forward_thread, update.forward_message !== story.forward_message, update.forwarded_fields.early_detection.update_of,
      Math.min(Number(update.created_at), Number(update.source_at)) > began],
    [story.forward_thread, true, story.alert_id, true]);
    eq([resend.forward_thread, resend.forward_message, Math.min(Number(resend.created_at), Number(resend.source_at)) > began],
      [burson.forward_thread, burson.forward_message, true]);
    eq([story, burson].map(r => cacheOf(t).c[t.bot.hashText_(r.forward_thread)]), [undefined, undefined]);  // (the counts have neither thread)
    // A note with either row: its thread is read (once: the count is then kept), says 3, and nothing is posted
    const before = posted(t).length;
    const counts = () => [posted(t).length - before, noteCount(t, story.forward_thread), noteCount(t, burson.forward_thread)];
    eq(tryNotes(t, [[update, REQ_FINAL, 's5'], [update, REQ_FINAL, 's6'], [resend, REQ_FINAL, 'b5'], [resend, REQ_FINAL, 'b6']]),
      [[false, 1, 0], [false, 0, 1], [false, 1, 0], [false, 0, 1]]);
    eq(counts(), [0, 3, 3]);
    eq(tryNotes(t, [[story, REQ_FINAL, 's7'], [burson, REQ_FINAL, 'b7']]).map(r => r[0]), [false, false]);  // with the first rows as well
    // ...from the watch too, which has no Alert log at hand: the rows' own marks tell
    lose();
    eq(tryNotes(t, [[other, STORY_NOTE, 'o2']]), [[true, 1, 0]]);
    let got = run(t, null, dest => {
      const reads = threadReads(t);
      return [t.bot.acThreadNote_(dest, update, REQ_FINAL, 'w1'), t.bot.acThreadNote_(dest, resend, REQ_FINAL, 'w2'), threadReads(t) - reads];
    });
    eq([got.dest.choice, got.watch, counts()], ['autocorrect', [false, false, 2], [1, 3, 3]]);  // (1: the note under the other card)
    // A later row with no mark of its own: the flow's Alert log has an earlier row in that thread, which says how old
    // the thread is
    lose();
    eq(tryNotes(t, [[other, WATCH_NOTE, 'o3']]), [[true, 1, 0]]);
    const bare = row => Object.assign({}, row, { resend_of: '', forwarded_fields: {} });
    eq(tryNotes(t, [[bare(update), REQ_FINAL, 's8'], [bare(resend), REQ_FINAL, 'b8']]), [[false, 1, 0], [false, 1, 0]]);
    eq(counts(), [2, 3, 3]);
    eq(t.g.logs.filter(l => l === 'thread note not posted: its card already has 3 notes').length, 12);
  });

  test('thread notes: a card says how old its thread is only when it is the thread\'s first message (acNoteThreadBorn_). Never a card handed over as a reply, a resend\'s row, an update\'s row, or a message that Chat\'s own name places in another message\'s thread (Chat names a thread\'s first message "<thread id>.<thread id>"); and where the flow\'s Alert log has other rows in the thread, the earliest of them all says it', () => {
    const S = AC;
    const T = 1791980000000;
    const at = (thread, message, rows) => ({ space: S, thread: `${S}/threads/${thread}`, message: `${S}/messages/${message}`,
      ctx: rows ? { store: { alerts: rows } } : null });
    const born = (c, card) => B.acNoteThreadBorn_(c, card);
    // the first message of its thread: the createTime handed over, an Alert-log row's earliest time
    eq([born(at('t7', 'm7'), { createTime: T }), born(at('t7', 'm7'), { created_at: T, source_at: T - 5000 }), born(at('t7', 'm7'), {}),
      born(at('t7', 'm7'), null)], [T, T - 5000, 0, 0]);
    // handed over as a reply; a resend's row; an update's row
    eq([born(at('t7', 'm9'), { createTime: T, threadReply: true }), born(at('t7', 'm7'), { created_at: T, resend_of: 'QA-1001' }),
      born(at('t7', 'm9'), { created_at: T, forwarded_fields: { early_detection: { update_of: 'QA-1001' } } })], [0, 0, 0]);
    eq([born(at('t7', 'm7'), { createTime: T, threadReply: false }),
      born(at('t7', 'm7'), { created_at: T, resend_of: '', forwarded_fields: { early_detection: { update_of: '' } } }),
      born(at('t7', 'm7'), { created_at: T, forwarded_fields: 'not an object' }), born(at('t7', 'm7'), { created_at: T, forwarded_fields: { triage: {} } })],
    [T, T, T, T]);
    // Chat's own names: only "<thread id>.<thread id>" is a thread's first message; a name without a dot says nothing
    eq([born(at('Abc123', 'Abc123.Abc123'), { createTime: T }), born(at('Abc123', 'Xyz789.Abc123'), { createTime: T }),
      born(at('Abc123', 'Abc123.Xyz789'), { createTime: T }), born(at('Abc123', 'Abc123.Abc1234'), { createTime: T }),
      born(at('Abc123', 'Abc123.'), { createTime: T }), born(at('Abc123', 'client-bqa-0123'), { createTime: T })], [T, 0, 0, 0, 0, T]);
    // the flow's Alert log: the earliest row of the thread; a row of it that doesn't say when: unknown; other threads don't count
    const rows = [{ forward_thread: `${S}/threads/t7`, created_at: T - 9000, source_at: T - 8000 }, { forward_thread: `${S}/threads/t8`, created_at: T - 99000 },
      null, { forward_thread: '' }];
    eq([born(at('t7', 'm9', rows), { created_at: T }), born(at('t8', 'm9', rows), { created_at: T }), born(at('t9', 'm9', rows), { created_at: T }),
      born(at('t7', 'm9', rows), { created_at: T - 20000 }), born(at('t7', 'm9', rows.concat([{ forward_thread: `${S}/threads/t7` }])), { created_at: T }),
      born(at('t7', 'm9', rows), {})], [T - 9000, T - 99000, T, T - 20000, 0, 0]);
    // an Alert log that can't be read, or nothing to go by: unknown
    eq([born({ space: S, thread: `${S}/threads/t7`, message: `${S}/messages/m7`, ctx: { get store() { throw new Error('the Alert log can\'t be read'); } } }, { created_at: T }),
      born(null, { created_at: T }), born({}, { created_at: T })], [0, 0, 0]);
  });

  // =============================================================================================================
  // What the notes cost, and what the counts are worth
  // =============================================================================================================

  test('thread notes: what the notes cost is bounded, not only what is posted. A run asks Chat at most 12 times about its cards\' notes (a page of a card\'s thread, a look for a note by its id): past that, a note that needs asking is refused unasked; a key not found under a full card is asked about once a run, and so is a card whose thread couldn\'t be counted in; a thread is read 4 pages far at most, however short the pages Chat hands over; and a flow with less than 20 seconds of its time left asks nothing, though it still posts a note that needs no asking', () => {
    const { t, cards } = oneSpace();
    const asks = () => threadReads(t) + idReads(t);
    const logged = why => t.g.logs.filter(l => l === 'thread note not posted: ' + why).length;
    const FULL = 'its card already has 3 notes';
    const UNREAD = 'its card\'s thread couldn\'t be read to count the notes it has';
    const ago = ms => new Date(t.g.clock.now - ms).toISOString();
    /** A card with `replies` replies from an analyst under it, all dated back (so the flow has nothing to read in them). */
    const threadOf = replies => {
      const card = untimed(cardNow(t));
      t.chat.message(card.message).createTime = ago(2 * HOUR);
      for (let i = 0; i < replies; i++) t.chat.say(AC, `reply ${i}`, Object.assign({ thread: card.thread }, DANA)).createTime = ago(HOUR);
      return card;
    };
    // 1. A full card and 20 notes with keys of their own in one run: Chat is asked for 12 of them, the others are refused unasked
    eq(tryNotes(t, [[cards.pixel, REQ_NOTE, 'p1'], [cards.pixel, STORY_NOTE, 'p2'], [cards.pixel, WATCH_NOTE, 'p3']]).map(r => r[0]), [true, true, true]);
    let before = asks();
    let got = run(t, ctx => Array.from({ length: 20 }, (x, i) => t.bot.acThreadNote_(ctx, cards.pixel, REQ_FINAL, 'more' + i))).flow;
    eq([got.some(Boolean), asks() - before, logged(FULL)], [false, 12, 20]);
    // the watch's notes count toward the same 12
    before = asks();
    got = run(t, ctx => Array.from({ length: 8 }, (x, i) => t.bot.acThreadNote_(ctx, cards.pixel, REQ_FINAL, 'flow' + i)),
      dest => Array.from({ length: 8 }, (x, i) => t.bot.acThreadNote_(dest, cards.pixel, REQ_FINAL, 'watch' + i)));
    eq([got.flow.concat(got.watch).some(Boolean), asks() - before], [false, 12]);
    // ...and one key tried three times in a run is asked about once (the next run asks again: nothing of it is kept)
    before = asks();
    got = run(t, ctx => [1, 2, 3].map(() => t.bot.acThreadNote_(ctx, cards.pixel, REQ_FINAL, 'again'))).flow;
    eq([got, asks() - before], [[false, false, false], 1]);
    got = run(t, ctx => t.bot.acThreadNote_(ctx, cards.pixel, REQ_FINAL, 'again')).flow;
    eq([got, asks() - before], [false, 2]);
    // 2. A thread too long to count in (its card and 201 replies): read once a run, two pages, however many notes are tried
    const long = threadOf(201);
    before = asks();
    got = run(t, ctx => Array.from({ length: 10 }, (x, i) => t.bot.acThreadNote_(ctx, long, REQ_NOTE, 'long' + i))).flow;
    eq([got.some(Boolean), asks() - before, logged(UNREAD)], [false, 2, 10]);
    // 3. Chat hands over pages shorter than asked (30 messages a page): a thread of 100 messages is counted in its 4
    // pages; one of 130 would need a fifth and gets no note
    const hundred = threadOf(99);
    const more = threadOf(129);
    t.chat.fail = (method, path, query) => {
      const m = method === 'get' && String((query || {}).filter || '').match(/^thread\.name = (\S+)$/);
      if (!m) return null;
      const all = t.chat.spaces.get(AC).messages.filter(x => x.thread.name === m[1]);
      const from = Number(query.pageToken || 0);
      const body = { messages: all.slice(from, from + 30).map(x => t.chat._public(x)) };
      if (from + 30 < all.length) body.nextPageToken = String(from + 30);
      return { code: 200, body };
    };
    eq([tryNotes(t, [[hundred, REQ_NOTE, 'h1']]), tryNotes(t, [[more, REQ_NOTE, 'm1']]), logged(UNREAD)], [[[true, 4, 0]], [[false, 4, 0]], 11]);
    t.chat.fail = null;
    eq([noteCount(t, hundred.thread), noteCount(t, more.thread), noteCount(t, long.thread)], [1, 0, 0]);
    // 4. A flow with less than 20 seconds left asks Chat nothing: a card whose notes would have to be counted and a full
    // card's new key are refused unasked; a card that needs no asking (posted since the counts began, saying when) gets
    // its note. With 20 seconds or more it asks again
    const unknown = untimed(cardNow(t));
    const young = cardNow(t);
    got = run(t, ctx => {
      const from = asks();
      ctx.deadline = ctx.now() + 19 * 1000;
      const out = [t.bot.acThreadNote_(ctx, unknown, REQ_NOTE, 'd1'), t.bot.acThreadNote_(ctx, cards.pixel, REQ_FINAL, 'd2'),
        t.bot.acThreadNote_(ctx, young, REQ_NOTE, 'd3'), asks() - from];
      ctx.deadline = ctx.now() + 20 * 1000;
      return out.concat([t.bot.acThreadNote_(ctx, unknown, REQ_NOTE, 'd1'), asks() - from]);
    }).flow;
    eq([got, logged('the run has too little time left to count its card\'s notes')], [[false, false, true, 0, true, 1], 1]);
    assert.ok(logged('this run already asked Chat 12 times about its cards\' notes') === 0, 'a full card\'s refusal says the card is full');
    // 5. The pages of a thread count toward the run's 12 as the looks by id do: two pages for a thread of 150 messages
    // and ten looks for a full card's new keys make 12, and a card with no count is then refused unasked, and says so
    const twoPages = threadOf(149);
    const ten = Array.from({ length: 10 }, (x, i) => [cards.pixel, REQ_FINAL, 'last' + i]);
    const late = untimed(cardNow(t));
    eq(tryNotes(t, [[twoPages, REQ_NOTE, 't1']].concat(ten, [[late, REQ_NOTE, 'l1']])).filter((r, i) => i === 0 || i === 11), [[true, 2, 0], [false, 0, 0]]);
    eq(logged('this run already asked Chat 12 times about its cards\' notes'), 1);
    // ...and a thread whose second page would be the run's 13th ask is not read to its end: no note for its card
    const eleven = Array.from({ length: 11 }, (x, i) => [cards.pixel, REQ_FINAL, 'eleven' + i]);
    const alsoTwoPages = threadOf(149);
    eq(tryNotes(t, eleven.concat([[alsoTwoPages, REQ_NOTE, 't2']])).slice(-1), [[false, 1, 0]]);
    eq(noteCount(t, alsoTwoPages.thread), 0);
  });

  test('thread notes: the counts are taken only as the bot writes them. A count in the cache value that is no whole number of 0 or more, a time that is none, a list where a map belongs, or a value cut off half way: the card\'s notes are counted in its thread, so a card with 3 notes takes no fourth. And when the counts can\'t be written (the script cache refuses the write), the older value, which lacks the note just posted, is taken out and not read again in that run: every note is then counted in its thread, and a card posted since still gets 3 notes and no more', () => {
    const { t, cards } = oneSpace();
    const pixel = cards.pixel;
    eq(tryNotes(t, [[pixel, REQ_NOTE, 'a'], [pixel, STORY_NOTE, 'b'], [pixel, WATCH_NOTE, 'c']]).map(r => r[0]), [true, true, true]);
    const good = t.g.cache.get('ac_thread_notes');
    const h = t.bot.hashText_(pixel.forward_thread);
    const now = () => t.g.clock.now;
    const VALUES = {
      'a list where the counts belong': () => JSON.stringify({ s: 1, c: [], k: [] }),
      'the count is a word': () => JSON.stringify({ s: 1, c: { [h]: ['x', now()] }, k: {} }),
      'the count is negative': () => JSON.stringify({ s: 1, c: { [h]: [-9, now()] }, k: {} }),
      'the count is a fraction': () => JSON.stringify({ s: 1, c: { [h]: [0.5, now()] }, k: {} }),
      'the entry is a number': () => JSON.stringify({ s: now() - HOUR, c: { [h]: 3 }, k: {} }),
      'the time of its last note is a word': () => JSON.stringify({ s: 1, c: { [h]: [0, 'x'] }, k: {} }),
      'the time of its last note is yet to come': () => JSON.stringify({ s: 1, c: { [h]: [0, now() + HOUR] }, k: {} }),
      'another card\'s count is a word': () => JSON.stringify({ s: 1, c: { other: ['x', now()] }, k: {} }),
      'a key\'s time is a word': () => JSON.stringify({ s: 1, c: {}, k: { other: 'x' } }),
      'since when is yet to come': () => JSON.stringify({ s: now() + HOUR, c: {}, k: {} }),
      'cut off half way': () => good.slice(0, Math.floor(good.length / 2)),
      'not the bot\'s JSON': () => '[3]',
    };
    Object.keys(VALUES).forEach((name, i) => {
      t.g.cache.set('ac_thread_notes', VALUES[name]());
      eq([name, tryNotes(t, [[pixel, REQ_FINAL, 'g' + i]]), noteCount(t, pixel.forward_thread)], [name, [[false, 1, 0]], 3]);
    });

    // The cache refuses the write of the counts
    const fresh = cardNow(t);  // posted since the counts began, saying when: no read needed for its first note
    t.bot.__refuse = true;
    t.bot.ev('CacheService = (cs => ({ getScriptCache: () => { const c = cs.getScriptCache(); return Object.assign({}, c, { put: (k, v, s) => { ' +
      'if (__refuse && k === "ac_thread_notes") throw new Error("Service invoked too many times"); return c.put(k, v, s); } }); } }))(CacheService)');
    eq(tryNotes(t, [[fresh, REQ_NOTE, 'f1'], [fresh, STORY_NOTE, 'f2'], [fresh, WATCH_NOTE, 'f3'], [fresh, REQ_FINAL, 'f4']]),
      [[true, 0, 0], [true, 1, 0], [true, 1, 0], [false, 1, 0]]);
    eq([noteCount(t, fresh.thread), t.g.cache.get('ac_thread_notes') || null, t.bot.ev('AC_NOTE_UNKEPT_')], [3, null, true]);
    assert.ok(t.g.logs.some(l => /^thread notes: couldn't keep the counts \(Service invoked too many times\)/.test(l)), 'the run log says so');
    // ...and once it takes writes again, the counts begin anew: the thread once more, then the count is kept
    t.bot.__refuse = false;
    eq([tryNotes(t, [[fresh, REQ_FINAL, 'f5']]), t.bot.ev('AC_NOTE_UNKEPT_'), cacheOf(t).c[t.bot.hashText_(fresh.thread)][0]], [[[false, 1, 0]], false, 3]);
    eq([tryNotes(t, [[fresh, REQ_FINAL, 'f6']]), noteCount(t, fresh.thread)], [[[false, 0, 1]], 3]);
  });

  test('thread notes: when the script cache refuses both the write of the counts and taking the older value out, that older value stays in the cache, and it lacks the notes just posted: it is still not read again in that run, so a card posted since has its notes counted in its thread and gets 3 notes and no more', () => {
    const { t, cards } = oneSpace();
    eq(tryNotes(t, [[cards.pixel, REQ_NOTE, 'a']]).map(r => r[0]), [true]);
    const older = t.g.cache.get('ac_thread_notes');
    assert.ok(older, 'the counts are kept in the cache');
    t.g.clock.now += 60 * 1000;
    const fresh = cardNow(t);  // posted since the counts began, saying when
    t.bot.ev('CacheService = (cs => ({ getScriptCache: () => { const c = cs.getScriptCache(); const no = () => { throw new Error("Service invoked too many times"); }; ' +
      'return Object.assign({}, c, { put: (k, v, s) => (k === "ac_thread_notes" ? no() : c.put(k, v, s)), remove: k => (k === "ac_thread_notes" ? no() : c.remove(k)) }); } }))(CacheService)');
    const got = tryNotes(t, [[fresh, REQ_NOTE, 'f1'], [fresh, STORY_NOTE, 'f2'], [fresh, WATCH_NOTE, 'f3'], [fresh, REQ_FINAL, 'f4']]);
    eq(got.map(r => r[0]), [true, true, true, false]);
    eq(got.slice(1).map(r => r[1]), [1, 1, 1]);  // after the first failed write every note has its card's thread read
    eq([noteCount(t, fresh.thread), t.g.cache.get('ac_thread_notes') === older, t.bot.ev('AC_NOTE_UNKEPT_')], [3, true, true]);
  });

  test('thread notes: a note is never posted twice for want of an id. With Chat refusing custom message ids and then every record of a note gone (the counts, the bot\'s record of what it posted, Chat\'s memory of the request), the same key again has its card\'s thread read, finds a note of the bot\'s with the very same words there (with its bold marks, or as Chat can hand it back without them) and posts nothing; a note with other words is still posted, and a person\'s message with the same words is not taken for the bot\'s', () => {
    const { t, cards } = oneSpace();
    t.g.props.set('CHAT_CLIENT_IDS_OFF', String(t.g.clock.now));
    eq(tryNotes(t, [[cards.pixel, STORY_NOTE, 'k1']]), [[true, 1, 0]]);
    const note = inThread(t, cards.pixel.forward_thread).find(m => m.text === STORY_NOTE);
    assert.ok(note && !note.clientAssignedMessageId, 'Chat gave it no custom id');
    const forget = () => {
      t.g.cache.delete('ac_thread_notes');
      forgetIds(t);
      t.chat.requestIds.clear();
    };
    forget();
    const posts = posted(t).length;
    eq([tryNotes(t, [[cards.pixel, STORY_NOTE, 'k1']]), posted(t).length - posts, noteCount(t, cards.pixel.forward_thread)], [[[true, 1, 0]], 0, 1]);
    // as Chat can hand the note back: without its bold marks
    note.text = plainOf(STORY_NOTE);
    forget();
    eq([tryNotes(t, [[cards.pixel, STORY_NOTE, 'k1']]), posted(t).length - posts, noteCount(t, cards.pixel.forward_thread)], [[[true, 1, 0]], 0, 1]);
    // another note under the same card is posted, as it should be
    forget();
    eq([tryNotes(t, [[cards.pixel, REQ_NOTE, 'k2']]), posted(t).length - posts, noteCount(t, cards.pixel.forward_thread)], [[[true, 1, 0]], 1, 2]);
    // a person who wrote the same words under another card: theirs, not the bot's note (the bot's account is known)
    t.chat.say(AC, plainOf(STORY_NOTE), Object.assign({ thread: cards.maps.forward_thread }, DANA));
    t.poll();
    forget();
    eq([tryNotes(t, [[cards.maps, STORY_NOTE, 'k3']]), noteCount(t, cards.maps.forward_thread)], [[[true, 1, 0]], 2]);
    eq(B.ev('[acNotePlain_("🔗 *Part of a story:* 5 accounts tell it (<https://chat.google.com/room/x/y|story card>)"), acNotePlain_(" a  _b_ ~c~ `d`\\n e "), ' +
      'acNotePlain_(null), acNotePlain_(undefined)]'), ['🔗 Part of a story: 5 accounts tell it (story card)', 'a b c d e', '', '']);
  });
};
