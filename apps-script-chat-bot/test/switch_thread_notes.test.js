// Thread notes (ThreadNotes.gs acThreadNote_): the one way the bot puts a note under a card that is already in the
// Auto-correct space (B10). It posts only from the Auto-correct flow (or, for the watch, with its alerts going to the
// Auto-correct space), only under a card whose thread and message are in that space, never in S-F Burson, the Burson test
// copy or a space people outside Google can join, only a note that starts with one of the fixed first words, once per
// key, at most 3 under one card and 6 a run. The bot knows such a note as its own and never answers it; the wider guard
// holds its first words on any way to S-F Burson. Nothing in the bot calls it yet: these tests call it directly.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, REAL, TEST_FEED, TRIAGED, leakDenied } = H;
  const golden = require('./golden_flows')(H);
  const { AC, MIRROR, COPY } = golden.spaces;
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
    eq(heads, ['Also flagged by the watch', 'Part of a story', 'Alert requirements']);
    const ctx = { botUser: 'users/bot', store: { isOwnPost: () => false } };
    const own = text => B.isOwnMessage_(ctx, { senderName: 'users/bot', text });
    const held = text => B.outboxGuardHits_(text, GUARD).length > 0;
    // each head by itself, and each real note: the bot's own, held by the wider guard, denied by the leak audit
    heads.concat(NOTES, NOTES.map(plainOf), heads.map(h => `🔗 *${h}:* and more`)).forEach(text => {
      eq([B.isThreadNoteText_(text), B.isBotFormattedText_(text), own(text), held(text), leakDenied(text)], [true, true, true, true, true], text);
    });
    // every registered head is on all three lists (a note with new first words has to be added to each)
    heads.forEach(h => eq([B.isBotFormattedText_(`${h}: x`), held(`${h}: x`), leakDenied(`${h}: x`)], [true, true, true], h));
    // what the guard says it found is the words, not the line break or the emoji before them
    eq([B.outboxGuardHits_(WATCH_NOTE, GUARD), B.outboxGuardHits_(STORY_NOTE, GUARD), B.outboxGuardHits_(`Thanks!\n${REQ_NOTE}`, GUARD)],
      [['flagged by the watch'], ['Part of a story'], ['Alert requirements']]);
    // on a way to S-F Burson a note is held wherever it stands: after an analyst's name (the Relay), on a later line
    [`Dana Lee: ${STORY_NOTE}`, `Dana Lee: ${plainOf(REQ_NOTE)}`, `Dana Lee: ${plainOf(REQ_FINAL)}`, `Dana Lee: see below\n${plainOf(STORY_NOTE)}`,
      `Dana Lee: it was ${plainOf(WATCH_NOTE)}`].forEach(text => eq([held(text), leakDenied(text)], [true, true], text));
    // ...but only in those forms: these are neither the bot's own nor held
    ['Please look at the alert requirements for this one.', 'It comes from the alert requirements: https://docs.google.com/document/d/abc/edit.',
      'What are the Alert requirements for a P1?', 'This post is part of a story we alerted yesterday.', 'Part of a storyline about maps',
      'Alert requirementss', 'Also flagged by the watchdog group', 'The watch company flagged it'].forEach(text => {
      eq([B.isThreadNoteText_(text), B.outboxGuardHits_(text, GUARD).filter(h => /story|requirements|flagged/i.test(h)), leakDenied(text)],
        [false, [], false], text);
    });
    // a person's own message from the bot's account that only mentions the words mid-sentence stays theirs
    assert.ok(!own('Why does this one not meet the Alert requirements?'));
    // the bot's answers to Burson that name the alert requirements pass as before
    eq(B.outboxGuardHits_('Please check this alert against the alert requirements.', GUARD), []);
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

  test('thread notes: refused, with nothing posted anywhere: any flow that is not the Auto-correct flow (the Mirror flow, a test feed with its analyst space, the bot working directly in B25 under row 32, the Other alerts space), and from the Auto-correct flow a thread in any of those spaces, a card whose message is in another space, a blank thread (source_thread is never used), a space people outside Google can join, S-F Burson or the Burson test copy; from the watch, alerts that go anywhere but the Auto-correct space, or a space the Auto-correct flow never worked in; a note that starts with other words; no key', () => {
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
    ['Another post on this issue: 2,400 engagements', '🔗 *Same story: 2 more posts*', 'FYI: Part of a story: 5 accounts', 'part of a story: 5 accounts']
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
    got = run(t, ctx => keys.slice(0, 4).map((k, i) => t.bot.acThreadNote_(ctx, order[i], REQ_NOTE, k)),
      dest => keys.slice(4).map((k, i) => t.bot.acThreadNote_(dest, order[i + 4], WATCH_NOTE, k)));
    eq([got.flow, got.watch, count(cards.burson), count(cards.watch)], [[true, true, true, true], [true, true, false, false], 3, 3]);
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

  test('thread notes: the counts are one script-cache value, a card\'s and a key\'s kept 25 hours after its last note (a card with 3 notes takes a fourth after that; the same key is new again), written again at every note tried (the cache keeps a value 6 hours at most); its worst case, 500 cards and 1,500 keys, stays under the 90,000 characters a cache value should hold, the oldest going first; a value that can\'t be read counts as none', () => {
    const { t, cards } = oneSpace();
    const count = card => inThread(t, card.forward_thread).filter(m => NOTES.indexOf(m.text) >= 0).length;
    const cache = () => JSON.parse(t.g.cache.get('ac_thread_notes') || 'null');
    const puts = [];  // every write of the value: [seconds it is kept]
    t.bot.ev('CacheService = (cs => ({ getScriptCache: () => { const c = cs.getScriptCache(); return Object.assign({}, c, { put: (k, v, s) => { ' +
      'if (k === "ac_thread_notes") __puts.push(s); return c.put(k, v, s); } }); } }))(CacheService)');
    t.bot.__puts = puts;
    const ctx = run(t).ctx;  // the Auto-correct flow's ctx, used below as a run built by hand (the clock moved by hand)
    const note = (card, text, key) => t.bot.acThreadNote_(ctx, card, text, key);
    eq([['a', 'b', 'c', 'd'].map(k => note(cards.pixel, REQ_NOTE, k)), count(cards.pixel), puts], [[true, true, true, false], 3, [21600, 21600, 21600, 21600]]);
    // 24 hours later the card is still full; the refused try writes the value again, so the cache keeps it 6 more hours
    t.g.clock.now += 24 * HOUR;
    eq([note(cards.pixel, REQ_NOTE, 'e'), count(cards.pixel), Object.values(cache().c).map(v => v[0]), puts.length], [false, 3, [3], 5]);
    // 25 hours after its last note the card's count and the keys are no longer kept: it takes a note again, and a key
    // from before is new (Chat still has that message under its id, so there is no second one)
    t.g.clock.now += 2 * HOUR;
    eq([note(cards.pixel, REQ_FINAL, 'e'), count(cards.pixel), Object.values(cache().c).map(v => v[0]), Object.keys(cache().k).length], [true, 4, [1], 1]);
    eq([note(cards.pixel, REQ_NOTE, 'a'), count(cards.pixel)], [true, 4]);
    // the cache dropped the value (6 hours with no note tried): the counts start again, as after 25 hours
    t.g.cache.delete('ac_thread_notes');
    eq([note(cards.maps, REQ_NOTE, 'f'), Object.values(cache().c).map(v => v[0])], [true, [1]]);
    // the worst case of the value
    const now = t.g.clock.now;
    const state = { c: {}, k: {} };
    for (let i = 0; i < 700; i++) state.c[t.bot.hashText_(`${AC}/threads/${'t'.repeat(40)}${i}`)] = [3, now - i * 1000];
    for (let i = 0; i < 2500; i++) state.k[t.bot.hashText_(`${'k'.repeat(900)}${i}`)] = now - i * 1000;
    t.bot.acNoteSave_(state);
    const saved = t.g.cache.get('ac_thread_notes');
    const kept = JSON.parse(saved);
    eq([Object.keys(kept.c).length, Object.keys(kept.k).length, saved.length <= 90000, saved.length > 50000], [500, 1500, true, true]);
    // the newest are kept: the oldest card and key went
    assert.ok(kept.c[t.bot.hashText_(`${AC}/threads/${'t'.repeat(40)}0`)] && !kept.c[t.bot.hashText_(`${AC}/threads/${'t'.repeat(40)}699`)]);
    assert.ok(kept.k[t.bot.hashText_(`${'k'.repeat(900)}0`)] && !kept.k[t.bot.hashText_(`${'k'.repeat(900)}2499`)]);
    // read back: only what is younger than 25 hours; a value that isn't the bot's JSON is no counts at all
    t.g.cache.set('ac_thread_notes', JSON.stringify({ c: { old: [3, now - 26 * HOUR], young: [2, now - HOUR], odd: 'x' }, k: { old: now - 26 * HOUR, young: now - HOUR } }));
    eq(t.bot.acNoteState_(now), { c: { young: [2, now - HOUR] }, k: { young: now - HOUR } });
    ['not json', '[1,2]', '"text"', 'null'].forEach(v => {
      t.g.cache.set('ac_thread_notes', v);
      eq(t.bot.acNoteState_(now), { c: {}, k: {} }, v);
    });
    eq(B.ev('[AC_NOTE_PER_CARD_, AC_NOTE_PER_RUN_, AC_NOTE_KEEP_MS_ / 3600000, AC_NOTE_CACHE_SEC_]'), [3, 6, 25, 21600]);
  });
};
