// Post in S-F Burson (Control row 24) and the Burson outbox tab (Outbox.gs): nothing ever reaches S-F Burson
// (REAL_BURSON_SPACE) but a row of the bot's Burson outbox that a person set to Send. OFF (the default): whatever the bot
// would post, reply or react there, from any flow, is withheld: nothing is written or queued, the flow carries on as if
// it was done (nothing fails or is retried), and the run log counts it. ON: each one waits on the outbox, Pending, until
// a person sets it to Send (written once, on the next run, from the bot's account, after a wider leak guard) or Skip.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, e2e, REAL, TRIAGED } = H;
  const ZAP = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const ALICE = { sender: 'users/burson7', displayName: 'Alice Smith' };
  const HEADER = ['Queued (ET)', 'Kind', 'Where', 'Text or emoji', 'From', 'Status', 'Note', 'Key (written by the Burson QA bot)'];
  const ROOM = 'https://chat.google.com/room/AAQAaa_0I9g';
  const OFF_NOTE = 'not sent: Post in S-F Burson (Control tab row 24) was OFF. Set Send again to send it.';

  /** Every write call that reached Chat for S-F Burson (posts, replies, reactions), whether it worked or not. */
  const writes = t => t.chat.calls.filter(c => c.method !== 'get' && String(c.path).indexOf(REAL) === 0);
  const tab = t => t.sheet().getSheetByName('Burson outbox');
  const outbox = t => (tab(t) ? tab(t).rows.slice(1) : []).map(r => ({ kind: r[1], where: r[2], text: r[3], from: r[4], status: r[5], note: r[6] }));
  const statuses = t => outbox(t).map(r => r.status);
  /** A person sets row i (0 = the first under the header) to `status`, after typing `text` in its Text cell if given. */
  const mark = (t, i, status, text) => {
    if (text !== undefined) tab(t).getRange(i + 2, 4).setValue(text);
    tab(t).getRange(i + 2, 6).setValue(status);
  };
  const failures = t => t.sheet().getSheetByName('Message log').rows.slice(1).filter(r => /failed|dead/.test(r[2]) || r[4] || r[5]);
  const withheldLogs = t => t.g.logs.filter(l => /^S-F Burson: withheld this run/.test(l));

  /**
   * setup(); the Burson space switched to S-F Burson (the live space; no Mirror space); Post in S-F Burson as asked. The
   * bot is LIVE (B25 set, B3 is S-F Burson, B26 blank, the Safety valve OFF): the outbox queues and sends only then.
   * Auto-send (row 11) ON: the bot sends each Social Alert itself, so its team emojis go on the alert (LIVE, a draft
   * would wait for a person). noWait: Never wait on Burson (row 23) ON, the flow the traffic below was written for (its
   * row numbers). The default flow (OFF, as LIVE: ⬇️ and a fix request on the alert with mistakes) has its own test below.
   */
  const liveWorld = (post, noWait) => {
    const t = e2e();
    t.bot.setup();
    t.set('B25', ROOM);  // S-F Burson (Control tab B25)
    t.set('B3', ROOM);
    t.control().getRange(11, 2).setValue('ON');
    t.control().getRange(24, 2).setValue(post ? 'ON' : 'OFF');
    if (noWait) t.control().getRange(23, 2).setValue('ON');
    t.poll();
    return t;
  };
  /**
   * Burson's traffic, handled: a clean alert (the bot's team emojis on it), one with mistakes (the bot's reply in its
   * thread), then a question in the first one's thread (the bot's answer) and an analyst's 👍 on its copy (copied over).
   * The outbox, when ON (with Never wait on Burson ON; LIVE, so no 📰: press has no address on file, and a real email
   * didn't reach it): 0-1 📦 🌎 on `ok`, 2 📦 on `bad`, 3 the reply under `bad`, 4 the answer, 5 the 👍.
   */
  const traffic = t => {
    const ok = t.chat.say(REAL, F.P0_OK, ZAP);
    const bad = t.chat.say(REAL, F.MISTAKES, ZAP);
    t.poll();
    const copies = t.chat.botPosts(TRIAGED).filter(m => !m.threadReply).slice(1);
    t.chat.say(REAL, 'Why is this one P0?', Object.assign({ thread: ok.thread.name }, ALICE));
    t.chat.addReaction(copies[0].name, '👍', 'users/analyst1', 'Dana');
    t.poll();
    return { ok, bad, copies };
  };

  test('outbox: Post in S-F Burson OFF (the default), S-F Burson the Burson space: nothing the bot would post, reply or react there is written or queued, the alerts go on as usual (forwarded, answered, emojis copied), nothing fails or is retried, and the run log counts what was withheld', () => {
    const t = liveWorld(false, true);
    assert.match(t.control().cell(24, 3), /^OFF \(nothing is posted or reacted in S-F Burson\)$/);
    const { ok, bad, copies } = traffic(t);
    eq([writes(t), t.chat.botPosts(REAL), t.chat.botReactions(ok.name), t.chat.botReactions(bad.name), tab(t)], [[], [], [], [], null]);
    // The rest of the flow as usual: both alerts forwarded (with their emojis), the question answered, the 👍 handled
    eq(copies.length, 2);
    eq(t.chat.botReactions(copies[0].name).slice(0, 2), ['📦', '🌎']);
    eq(t.sheet().getSheetByName('Message log').rows.slice(1).map(r => r[2]), ['alert', 'alert', 'question']);
    eq([failures(t), t.get('B5'), t.g.props.get('FAIL_STREAK') || '0'], [[], '🔴 LIVE · ✅ Working', '0']);
    eq(withheldLogs(t), ['S-F Burson: withheld this run (Post in S-F Burson is OFF, so nothing was posted or queued): 1 reply, 3 reactions',
      'S-F Burson: withheld this run (Post in S-F Burson is OFF, so nothing was posted or queued): 1 reply, 1 reaction']);
    // Nothing is tried again on later runs (nothing failed), and nothing waits to go later
    t.poll();
    t.poll();
    eq([writes(t), withheldLogs(t).length, tab(t), failures(t)], [[], 2, null, []]);
    // Turned ON later: nothing withheld before is queued (or sent)
    t.control().getRange(24, 2).setValue('ON');
    t.poll();
    t.poll();
    eq([writes(t), outbox(t)], [[], []]);
  });

  test('outbox: Post in S-F Burson ON: each post, reply and reaction the bot would make in S-F Burson waits on its Burson outbox tab, Pending, and nothing is written; the tab is the bot\'s own (its header), protected with a warning, its key column hidden, each Status a Pending / Send / Skip dropdown; ON never sends a row by itself', () => {
    const t = liveWorld(true, true);
    const { ok, bad } = traffic(t);
    eq([writes(t), t.chat.botPosts(REAL)], [[], []]);
    const rows = outbox(t);
    eq(rows.map(r => [r.kind, r.text, r.from, r.status, r.note]).filter((r, i) => i !== 3), [
      ['reaction', '📦', 'bot', 'Pending', ''], ['reaction', '🌎', 'bot', 'Pending', ''], ['reaction', '📦', 'bot', 'Pending', ''],
      ['reply', 'Happy to help with that.', 'bot', 'Pending', ''], ['reaction', '👍', 'bot', 'Pending', '']]);
    eq([rows[3].kind, rows[3].from, rows[3].status], ['reply', 'bot', 'Pending']);  // the bot's reply under the alert with mistakes
    assert.match(rows[3].text, /^The alert has been updated, so there is no need to resend it\./);
    const msg = name => `${ROOM} (message ${name.split('/messages/')[1]})`;
    const thr = name => `${ROOM}/${name.split('/threads/')[1]}`;
    eq(rows.map(r => r.where), [msg(ok.name), msg(ok.name), msg(bad.name), thr(bad.thread.name), thr(ok.thread.name), msg(ok.name)]);
    const sh = tab(t);
    eq([sh.rows[0], sh.hidden, sh.protections.map(p => p.warningOnly), t.bot.isOutboxTab_(sh)], [HEADER, [8], [true], true]);
    eq(rows.map((_, i) => sh.validations[`${i + 2},6`].values), rows.map(() => ['Pending', 'Send', 'Skip']));
    rows.forEach((_, i) => assert.match(sh.cell(i + 2, 1), /^2026-10-14 \d\d:\d\d$/));
    eq([failures(t), t.get('B5'), t.g.logs.filter(l => /^S-F Burson: queued this run/.test(l))], [[], '🔴 LIVE · ✅ Working',
      ['S-F Burson: queued this run on the Burson outbox tab (each waits for Send): 1 reply, 3 reactions',
        'S-F Burson: queued this run on the Burson outbox tab (each waits for Send): 1 reply, 1 reaction']]);
    // More runs: nothing is written or queued twice; every row stays Pending (ON never sends a row by itself)
    t.poll();
    t.poll();
    eq([writes(t), outbox(t).length, statuses(t)], [[], 6, Array(6).fill('Pending')]);
    assert.match(t.control().cell(24, 3), /^✓ ON: posts only the Burson outbox rows set to Send · 6 waiting on the Burson outbox tab$/);
  });

  test('outbox: a row set to Send is written once, on the next run, from the bot\'s account, as its Text cell says (edited or not), then Sent with a link; Skip is never written; a text that names anything internal, or a reaction that isn\'t one emoji Burson may see, is Blocked with the reason; a row that fails is Failed and never tried again by itself; a Sent row never goes twice', () => {
    const t = liveWorld(true, true);
    const { ok } = traffic(t);
    // two more questions in the clean alert's thread: their answers are rows 6 and 7
    t.chat.say(REAL, 'Who else is on it?', Object.assign({ thread: ok.thread.name }, ALICE));
    t.chat.say(REAL, 'Anything we should watch for?', Object.assign({ thread: ok.thread.name }, ALICE));
    t.poll();
    eq(outbox(t).map(r => r.kind), ['reaction', 'reaction', 'reaction', 'reply', 'reply', 'reaction', 'reply', 'reply']);
    let down = true;
    let tries = 0;
    t.chat.fail = (method, path, query, body) => (down && method === 'post' && path === `${ok.name}/reactions` && body.emoji.unicode === '👍'
      ? (tries++, { code: 500, body: { error: { message: 'backend error' } } }) : null);
    mark(t, 0, 'Send');                                    // 📦 on the clean alert, as queued
    mark(t, 1, 'Send', '👎');                              // never shown to Burson
    mark(t, 2, 'Send', 'ok');                              // not an emoji
    mark(t, 3, 'Send', 'We fixed this one in the auto-correct flow, all good.');  // names the internal setup
    mark(t, 4, 'Send', 'Thanks Alice: it is P0 because of the exposure tag.');    // edited
    mark(t, 5, 'Send');                                    // 👍: Chat fails
    mark(t, 6, 'Skip');                                    // the second answer: never
    eq(writes(t), []);  // nothing until the next run (row 7, the third answer, stays Pending)
    t.poll();
    const STATUSES = ['Sent', 'Blocked', 'Blocked', 'Blocked', 'Sent', 'Failed', 'Skip', 'Pending'];
    eq(statuses(t), STATUSES);
    const live = t.chat.botPosts(REAL);
    eq(live.map(m => [m.text, m.thread.name, m.threadReply, m.sender.name]), [['Thanks Alice: it is P0 because of the exposure tag.', ok.thread.name, true, 'users/bot']]);
    eq(t.chat.botReactions(ok.name), ['📦']);
    const notes = outbox(t).map(r => r.note);
    assert.match(notes[0], new RegExp(`^sent 2026-10-14 \\d\\d:\\d\\d ET: ${ROOM.replace(/[./]/g, '\\$&')} \\(message ${ok.name.split('/messages/')[1]}\\)$`));
    assert.match(notes[4], new RegExp(`^sent 2026-10-14 \\d\\d:\\d\\d ET: ${ROOM.replace(/[./]/g, '\\$&')} \\(message ${live[0].name.split('/messages/')[1]}\\)$`));
    eq([notes[1], notes[2], notes[3], notes[6], notes[7]], ['not sent: 👎 is never shown to Burson', 'not sent: it isn\'t a single emoji',
      'not sent: it mentions "auto-correct". Edit the text, then set Send again.', '', '']);
    assert.match(notes[5], /^not sent: Chat API 500 on reacting 👍 on spaces\/AAQAaa_0I9g\/messages\/m\d+: backend error$/);
    const sh = tab(t);
    eq([0, 2, 5].map(i => sh.validations[`${i + 2},6`].values), [['Sent'], ['Blocked', 'Send', 'Skip'], ['Failed', 'Send', 'Skip']]);
    // The bot's own post there is never taken for Burson's (the Message log knows it)
    assert.ok(t.sheet().getSheetByName('Message log').rows.some(r => r[0] === live[0].name && r[2] === 'own_post'));
    // More runs: nothing again (Failed isn't retried, Blocked and Skip stay, Sent never goes twice); the one failed send
    // was one Chat call (which retries a 500 itself a few times), never repeated on a later run
    const calls = writes(t).length;
    const tried = tries;
    t.poll();
    t.poll();
    eq([writes(t).length, tries, statuses(t)], [calls, tried, STATUSES]);
    // A person sets the Failed one to Send again (Chat works now): it goes. A Sent one set to Send again doesn't go twice.
    down = false;
    mark(t, 5, 'Send');
    mark(t, 4, 'Send');
    t.poll();
    eq([t.chat.botReactions(ok.name), t.chat.botPosts(REAL).length, statuses(t)[5], statuses(t)[4]], [['📦', '👍'], 1, 'Sent', 'Sent']);
    assert.match(outbox(t)[4].note, /^already sent 2026-10-14 \d\d:\d\d ET: /);
    // The Blocked one, its text fixed, goes as edited
    mark(t, 3, 'Send', 'We fixed the product and the priority on this one, all good.');
    t.poll();
    eq([t.chat.botPosts(REAL).map(m => m.text).slice(-1), statuses(t)[3]], [['We fixed the product and the priority on this one, all good.'], 'Sent']);
    H.collectBurson(t.chat, [REAL]);
  });

  test('outbox: turned OFF between queueing and sending, nothing is written (rows set to Send go back to Pending, saying so), and nothing new is queued; turned back ON, nothing goes by itself: only a row set to Send again; turned OFF in the middle of a run\'s sending, the rest stays', () => {
    const t = liveWorld(true, true);
    const { ok, bad } = traffic(t);
    mark(t, 0, 'Send');
    mark(t, 4, 'Send');
    t.control().getRange(24, 2).setValue('OFF');
    t.chat.say(REAL, 'Another question while it is OFF?', Object.assign({ thread: ok.thread.name }, ALICE));
    t.poll();
    eq([writes(t), outbox(t).length, statuses(t)[0], statuses(t)[4], outbox(t)[0].note], [[], 6, 'Pending', 'Pending', OFF_NOTE]);
    eq(withheldLogs(t), ['S-F Burson: withheld this run (Post in S-F Burson is OFF, so nothing was posted or queued): 1 reply']);
    // Back ON: the rows wait (Pending), however many runs
    t.control().getRange(24, 2).setValue('ON');
    t.poll();
    t.poll();
    eq([writes(t), statuses(t)], [[], Array(6).fill('Pending')]);
    // Set to Send again: it goes
    mark(t, 4, 'Send');
    t.poll();
    eq([t.chat.botPosts(REAL).map(m => m.text), statuses(t)[4]], [['Happy to help with that.'], 'Sent']);
    // OFF while a run is sending (it's read again right before each write): the first goes, the next ones don't
    t.chat.fail = (method, path) => {
      if (method === 'post' && path === `${ok.name}/reactions`) t.control().getRange(24, 2).setValue('OFF');
      return null;
    };
    mark(t, 0, 'Send');
    mark(t, 2, 'Send');
    mark(t, 3, 'Send');
    t.poll();
    eq([t.chat.botReactions(ok.name), t.chat.botReactions(bad.name), statuses(t).slice(0, 4)], [['📦'], [], ['Sent', 'Pending', 'Pending', 'Pending']]);
    eq([outbox(t)[2].note, outbox(t)[3].note], [OFF_NOTE, OFF_NOTE]);
    H.collectBurson(t.chat, [REAL]);
  });

  test('outbox: the default flow (Never wait on Burson OFF, as LIVE): the ⬇️ and the fix request the bot would put on the alert with mistakes are withheld like the rest with Post in S-F Burson OFF, or wait on the outbox, Pending, with it ON; nothing is written either way', () => {
    // OFF: withheld and counted; nothing queued, nothing fails
    const off = liveWorld(false);
    traffic(off);
    eq([writes(off), off.chat.botPosts(REAL), tab(off), failures(off)], [[], [], null, []]);
    eq(withheldLogs(off), ['S-F Burson: withheld this run (Post in S-F Burson is OFF, so nothing was posted or queued): 1 reply, 4 reactions',
      'S-F Burson: withheld this run (Post in S-F Burson is OFF, so nothing was posted or queued): 1 reply, 1 reaction']);
    // ON: each one waits, Pending, from the bot
    const DOWN = off.bot.ev('GEN').legend.find(l => l.code === 'superseded').emoji;
    const t = liveWorld(true);
    const { ok, bad } = traffic(t);
    const rows = outbox(t);
    const msg = name => `${ROOM} (message ${name.split('/messages/')[1]})`;
    const thr = name => `${ROOM}/${name.split('/threads/')[1]}`;
    eq([writes(t), t.chat.botPosts(REAL), rows.length, rows.filter(r => r.from !== 'bot' || r.status !== 'Pending')], [[], [], 7, []]);
    eq(rows.filter(r => r.kind === 'reaction' && r.where === msg(ok.name)).map(r => r.text), ['📦', '🌎', '👍']);
    eq(rows.filter(r => r.kind === 'reaction' && r.where === msg(bad.name)).map(r => r.text), [DOWN, '📦']);  // ⬇️ first (Bot.gs step 2)
    const fix = rows.filter(r => r.kind === 'reply' && r.where === thr(bad.thread.name));
    eq(fix.length, 1);
    assert.match(fix[0].text, /resend the alert here/);
    eq(rows.filter(r => r.kind === 'reply' && r.where === thr(ok.thread.name)).length, 1);  // the answer to Alice
    t.poll();
    eq([writes(t), outbox(t).length, failures(t)], [[], 7, []]);
  });

  test('outbox: only a run from the bot\'s own account sends (one from someone else, e.g. poll() run from the editor, leaves the rows set to Send waiting and says why), never a dry run; a tab named "Burson outbox" the bot didn\'t make is never read or written, and nothing is queued (or posted) instead', () => {
    const t = liveWorld(true);
    const { ok } = traffic(t);
    const session = t.g.services.Session.getEffectiveUser;
    t.g.services.Session.getEffectiveUser = () => ({ getEmail: () => 'someone@runner.test' });
    mark(t, 0, 'Send');
    t.poll();
    eq([writes(t), statuses(t)[0]], [[], 'Send']);
    assert.match(t.control().cell(24, 3), /not sending: this run is from someone@runner\.test, not the bot's account in "Runs as" \(B8\)/);
    t.g.services.Session.getEffectiveUser = session;
    const GEN = t.bot.ev('GEN');
    GEN.settings.dry_run = true;
    t.poll();
    eq([writes(t), statuses(t)[0]], [[], 'Send']);
    GEN.settings.dry_run = false;
    t.poll();
    eq([t.chat.botReactions(ok.name), statuses(t)[0]], [['📦'], 'Sent']);
    // Someone's own tab with that name: never read or written; the bot's writes aren't queued (nor posted), and it says so
    const ss = t.sheet();
    ss.sheets = ss.sheets.filter(s => s.name !== 'Burson outbox');
    const theirs = ss.insertSheet('Burson outbox');
    theirs.appendRow(['My notes', 'Send']);
    const calls = writes(t).length;
    t.chat.say(REAL, 'One more question?', Object.assign({ thread: ok.thread.name }, ALICE));
    t.poll();
    t.poll();
    eq([theirs.rows, writes(t).length, t.get('B5'), failures(t)], [[['My notes', 'Send']], calls, '🔴 LIVE · ✅ Working', []]);
    assert.match(t.control().cell(24, 3), /⚠️ a tab named "Burson outbox" that the bot didn't make is in the way: rename it, and the bot makes its own/);
    eq(t.bot.isOutboxTab_(theirs), false);
    H.collectBurson(t.chat, [REAL]);
  });

  test('outbox: the auto-correct and Mirror spaces never write in S-F Burson; the auto-correct space never queues anything for it; the Mirror space, LIVE with Post in S-F Burson ON, queues its own Burson replies and emojis for S-F Burson\'s alert (row 24), each waiting for Send, and Testing with no test copy (the Safety valve ON) queues nothing', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B25', ROOM);  // S-F Burson: the live space both read
    const MIRROR = 'spaces/AAQAmirror1';
    const AC = 'spaces/AAQAautofx1';
    t.chat.addSpace(MIRROR, 'SLRR Zapier Training Mirror');
    t.chat.addSpace(AC, 'SLRR Auto-correct Test');
    t.bot.startMirror('SLRR Zapier Training Mirror');
    t.bot.startAutoCorrect('SLRR Auto-correct Test');
    t.control().getRange(24, 2).setValue('ON');
    t.poll();
    const zap = t.chat.say(REAL, F.MISTAKES, ZAP);
    t.chat.say(REAL, 'Product should be Gemini App, please update and resend', Object.assign({ thread: zap.thread.name }, ALICE));
    t.chat.addReaction(zap.name, '⬇️', ALICE.sender);
    t.poll();
    const copy = t.chat.botPosts(MIRROR).find(m => !m.threadReply && m.text === F.MISTAKES);
    t.chat.addReaction(copy.name, '👍', 'users/analyst9', 'Dana Lee');
    t.chat.say(AC, 'why is this Gemini App?', { thread: t.chat.botPosts(AC).filter(m => !m.threadReply)[0].thread.name, sender: 'users/trainer' });
    t.poll();
    t.poll();
    eq([writes(t), t.chat.botPosts(REAL), t.chat.botReactions(zap.name)], [[], [], []]);
    assert.ok(copy, 'the Mirror space has its copy');
    assert.ok(t.chat.botPosts(AC).length >= 2, 'the auto-correct space has its corrected alert');
    // LIVE: the Mirror space's own Burson actions wait on the outbox for S-F Burson's alert (the ⬇️ on it, and the
    // request to fix and resend in its thread); nothing from the auto-correct space, nothing of Dana's (the relay is OFF)
    const rows = outbox(t);
    const msg = name => `${ROOM} (message ${name.split('/messages/')[1]})`;
    const thr = name => `${ROOM}/${name.split('/threads/')[1]}`;
    assert.ok(rows.length >= 2 && rows.every(r => r.from === 'bot' && r.status === 'Pending' && r.where.indexOf(ROOM) === 0), JSON.stringify(rows));
    assert.ok(rows.some(r => r.kind === 'reaction' && r.where === msg(zap.name)), JSON.stringify(rows));
    assert.ok(rows.some(r => r.kind === 'reply' && r.where === thr(zap.thread.name) && /resend/.test(r.text)), JSON.stringify(rows));
    assert.ok(!rows.some(r => r.text === '👍' && r.from !== 'bot'));
    assert.ok(t.g.logs.some(l => /^S-F Burson: queued this run on the Burson outbox tab/.test(l)));
    // Testing with no test copy (the Safety valve ON, B26 blank): nothing more is queued, and nothing is written there
    t.control().getRange(29, 2).setValue('ON');
    const before = outbox(t).length;
    t.chat.say(REAL, F.MAPS, ZAP);
    t.poll();
    t.poll();
    eq([writes(t), outbox(t).length], [[], before]);
  });

  test('outbox: the wider leak guard for what goes to S-F Burson (OUTBOX_GUARD_PATTERNS_, on top of the bot\'s own) names the internal setup, tools and spaces; product names are set aside; the bot\'s own guard (GUARD_PATTERNS_) is unchanged', () => {
    const guard = { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E', 'SLRR Zapier Training Mirror'] };
    const internal = ['the auto-correct space shows it', 'it was autocorrected', 'the write-back ran', 'written back to the table',
      'per SLRR', 'see the Mirror', 'mirrored there', 'I relayed it', 'the relay is on', 'the bot did it', 'our automation',
      'automated reply', 'it was auto-sent', 'auto-submitted the form', 'Zapier copied it', 'the stand-in got it',
      'on the Control tab', 'see the Relay tab', 'the Results tab says', 'from the outbox tab', 'in the analyst space',
      'posted in SLRR Triaged Alerts', 'see spaces/AAQAaLn375E', 'the SLRR Zapier Training Mirror has it'];
    internal.forEach(s => assert.ok(B.outboxGuardHits_(s, guard).length, s));
    ['Thanks Alice: it is P0 because of the exposure tag.', 'The product is Gemini App, and the network is X.', '👍',
      'Mirrorless cameras are fine', 'We fixed the product and the priority on this one, all good.']
      .forEach(s => eq(B.outboxGuardHits_(s, guard), [], s));
    eq(B.outboxGuardHits_('it mentions the analyst space', guard)[0], 'analyst space');
    // The bot's own guard stays as it was for its own texts: none of the new words (the outbox adds them, at send time)
    ['the auto-correct space shows it', 'the write-back ran', 'per SLRR', 'the bot did it', 'Zapier copied it', 'on the Control tab']
      .forEach(s => eq(B.guardHits_(s, { terms: [] }), [], s));
    // The Where column: the thread, or the message (Chat's ids with a dot give the thread and the message)
    eq([B.outboxMessageLink_(`${REAL}/messages/AbC.dEf`), B.outboxMessageLink_(`${REAL}/messages/m7`)],
      [`${ROOM}/AbC/dEf`, `${ROOM} (message m7)`]);
    // Only writes in this run's S-F Burson (B25) become rows, each keyed with that space; none at all while none is known
    eq(B.outboxItem_({ kind: 'reaction', message: 'spaces/OTHER/messages/m1', emoji: '👍' }, REAL), null);
    eq(B.outboxItem_({ kind: 'post', text: 'x', thread: 'spaces/OTHER/threads/t1' }, REAL), null);
    eq(B.outboxItem_({ kind: 'post', text: '  ' }, REAL), null);
    eq([B.outboxItem_({ kind: 'reaction', message: `${REAL}/messages/m1`, emoji: '👍' }, REAL).key.s,
      B.outboxItem_({ kind: 'post', text: 'x', thread: `${REAL}/threads/t1` }, REAL).key.s, B.outboxItem_({ kind: 'post', text: 'x' }, REAL).key.s],
    [REAL, REAL, REAL]);
    eq([B.outboxItem_({ kind: 'reaction', message: `${REAL}/messages/m1`, emoji: '👍' }, ''), B.outboxItem_({ kind: 'post', text: 'x' }, '')], [null, null]);
    eq([B.outboxWhere_({ kind: 'post', s: REAL }), B.outboxWhere_({ kind: 'reply', s: REAL, thread: `${REAL}/threads/T1` })], [ROOM, `${ROOM}/T1`]);
    eq([B.outboxKeySpace_({ s: 'spaces/X' }), B.outboxKeySpace_({ message: `${REAL}/messages/m1` }), B.outboxKeySpace_({ thread: `${REAL}/threads/t` }),
      B.outboxKeySpace_({ kind: 'post' }), B.outboxWhereSpace_(ROOM), B.outboxWhereSpace_('the thread of its first message, once that row is sent')],
    ['spaces/X', REAL, REAL, '', REAL, '']);
  });
};
