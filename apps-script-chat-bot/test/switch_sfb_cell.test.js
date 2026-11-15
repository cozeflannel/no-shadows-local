// S-F Burson is the Control tab's B25 ("S-F Burson space"), never a constant in the code: resolved once per run like the
// other space cells (a Chat link, spaces/ID, the bare ID or the exact name), with C25 saying what the bot found. Blank
// or not found, everything that needs it fails closed: the Mirror (B9), the Auto-correct space (B10) and the Relay (row
// 22) don't run, the Burson outbox sends and queues nothing, and the bot is never live. Whatever B25 says, the bot never
// posts or reacts itself in a space people outside Google can join. Changing B25 takes effect on the next run.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, e2e, makeGoogle, loadBot, NOW, REAL, TRIAGED, TEST_FEED, VENDOR } = H;
  const ROOM = 'https://chat.google.com/room/AAQAaa_0I9g';
  const MIRROR = 'spaces/AAQAmirror1';
  const AC = 'spaces/AAQAautofx1';
  const NEW = 'spaces/AAQAnewsfb1';  // another space someone may set as S-F Burson
  const ZAP = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const ALICE = { sender: 'users/burson7', displayName: 'Alice Smith' };
  const DANA = { sender: 'users/analyst9', displayName: 'Dana Lee' };
  const BLANK_NOTE = B.ev('SFB_BLANK_NOTE_');
  const PAUSED_BLANK = '⏸ Paused: it needs the S-F Burson space (B25), which is blank';
  const OUTSIDE_LOG = /^A space people outside Google can join that isn't S-F Burson \(B25\): held back this run \(nothing was posted or queued there\): /;

  const writesIn = (t, space) => t.chat.calls.filter(c => c.method !== 'get' && String(c.path).indexOf(space + '/') === 0);
  const outboxTab = t => t.sheet().getSheetByName('Burson outbox');
  const outbox = t => (outboxTab(t) ? outboxTab(t).rows.slice(1) : []).map(r => ({ kind: r[1], where: r[2], text: r[3], from: r[4], status: r[5], note: r[6] }));
  const tops = (t, space) => t.chat.botPosts(space).filter(m => !m.threadReply);
  const switchNote = (t, row) => t.control().cell(row, 3);

  test('S-F Burson space (B25): row 25 of a new Control tab, blank; resolved like the other space cells (a Chat link, spaces/ID, the bare ID or the exact name) once per run, C25 saying the space found; any space can be S-F Burson; one it can\'t open or a name no space has is ✗ with what to fix; nothing configured needs it, so the bot works on in a Google-only Burson space', () => {
    const t = e2e();
    t.chat.addSpace(NEW, 'Some Google-only space');
    t.bot.setup();
    eq([t.control().cell(25, 1), t.get('B25'), t.get('C25'), t.bot.sfBursonId_()], ['S-F Burson space', '', BLANK_NOTE, '']);
    t.poll();
    eq([t.get('C25'), t.get('B5'), t.bot.sfBursonId_()], [BLANK_NOTE, '✅ Working', '']);  // blank, and nothing set needs it
    for (const value of [ROOM, 'https://mail.google.com/chat/u/0/#chat/space/AAQAaa_0I9g', 'spaces/AAQAaa_0I9g', ' AAQAaa_0I9g ',
      '[S-F] Burson Automated Alerts V3']) {
      t.set('B25', value);
      t.poll();
      eq([t.get('C25'), t.bot.sfBursonId_(), t.get('B5')], ['✓ [S-F] Burson Automated Alerts V3', REAL, '✅ Working'], value);
    }
    // Any space at all: only the cell decides
    t.set('B25', 'https://chat.google.com/room/AAQAnewsfb1');
    t.poll();
    eq([t.get('C25'), t.bot.sfBursonId_(), t.bot.sfBurson_().externalUserAllowed], ['✓ Some Google-only space', NEW, false]);
    // Not found: ✗ with what to fix, and no S-F Burson is known
    t.set('B25', 'spaces/NOPENOPE123');
    t.poll();
    eq([t.get('C25'), t.bot.sfBursonId_(), t.get('B5')],
      ['\u2717 Can\'t open spaces/NOPENOPE123. Check the link, and that bot@runner.test is a member of that space.', '', '\u2705 Working']);
    t.set('B25', 'No Such Space');
    t.poll();
    eq([t.get('C25'), t.bot.sfBursonId_()], ['✗ No space named "No Such Space" (S-F Burson space). Paste the space\'s link instead.', '']);
    t.set('B25', '');
    t.poll();
    eq([t.get('C25'), t.bot.sfBursonId_()], [BLANK_NOTE, '']);
    // A label someone cleared is put back, with the value they set kept
    t.set('B25', ROOM);
    t.control().getRange(25, 1).setValue('');
    t.poll();
    eq([t.control().cell(25, 1), t.get('B25'), t.get('C25')], ['S-F Burson space', ROOM, '✓ [S-F] Burson Automated Alerts V3']);
    t.bot.setup();  // setup() keeps it too
    eq([t.get('B25'), t.get('C25'), t.bot.status().sf_burson_space], [ROOM, '✓ [S-F] Burson Automated Alerts V3',
      `[S-F] Burson Automated Alerts V3 (${REAL})`]);
  });

  test('S-F Burson blank (fail closed): the Mirror (B9) doesn\'t run (nothing copied, no alert worked anywhere, C9 says it needs B25, Status says what to fix); set, the Mirror starts from S-F Burson\'s last 15 minutes', () => {
    const t = e2e();
    t.bot.setup();
    t.chat.addSpace(MIRROR, 'SLRR Zapier Training Mirror');
    t.chat.say(REAL, F.P0_OK, ZAP);  // an hour before: never copied
    t.g.clock.now += 3600e3;
    t.set('B9', 'SLRR Zapier Training Mirror');
    const alert = t.chat.say(REAL, F.MISTAKES, ZAP);
    t.poll();
    t.poll();
    eq([t.chat.botPosts(MIRROR), t.chat.botPosts(REAL), t.chat.botReactions(alert.name), t.chat.botPosts(TRIAGED).length], [[], [], [], 1]);
    eq([t.get('C9'), t.get('B5')], [PAUSED_BLANK, '⚠️ S-F Burson space (B25) is blank: paste S-F Burson\'s link there. Until then ' +
      'the Mirror (B9) is paused. The bot tries again every minute.']);
    // Not found is the same, with what to fix
    t.set('B25', 'spaces/NOPENOPE123');
    t.poll();
    eq(t.chat.botPosts(MIRROR), []);
    eq([t.get('C9'), t.get('B5')], ['⏸ Paused: it needs the S-F Burson space (B25), which can\'t be found (see C25)',
      '\u26a0\ufe0f S-F Burson space (B25): Can\'t open spaces/NOPENOPE123. Check the link, and that bot@runner.test is a member of that ' +
      'space. Until then the Mirror (B9) is paused. The bot tries again every minute.']);
    // Set: the Mirror starts, from S-F Burson's last 15 minutes (the alert posted while it was paused, not the older one)
    t.set('B25', ROOM);
    t.poll();
    eq(tops(t, MIRROR).map(m => m.text), [F.MISTAKES]);
    eq([t.get('C9'), t.get('B5')], ['✓ SLRR Zapier Training Mirror (Zapier-only mirror · outbounds blocked)', '🔴 LIVE · ✅ Working']);
    eq([t.chat.botPosts(REAL), writesIn(t, REAL)], [[], []]);
  });

  test('S-F Burson blank (fail closed): the Auto-correct space (B10) doesn\'t run (C10 says it needs B25) while the main flow goes on in the Google-only test feed as before, Status saying the Auto-correct space is paused; set, it starts from S-F Burson\'s last 15 minutes', () => {
    const t = e2e();
    t.bot.setup();
    t.chat.addSpace(AC, 'SLRR Auto-correct Test');
    t.set('B10', 'SLRR Auto-correct Test');
    const live = t.chat.say(REAL, F.MISTAKES, ZAP);
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });  // a tester's alert in the test feed
    t.poll();
    eq([t.chat.botPosts(AC), t.chat.botReactions(live.name), switchNote(t, 10)], [[], [], PAUSED_BLANK]);
    eq(tops(t, TRIAGED).length, 2);  // the hello, and the test feed's alert: the main flow works as before
    eq(t.get('B5'), '⚠️ S-F Burson space (B25) is blank: paste S-F Burson\'s link there. Until then the Auto-correct space (B10) is paused.');
    t.set('B25', REAL);
    t.poll();
    eq([tops(t, AC).map(m => m.text), t.get('B5'), t.chat.botPosts(REAL)],
      [['✅ *Reviewed and corrected by the agentic assistant*\n' + F.MISTAKES_FIXED], '✅ Working', []]);
    assert.match(switchNote(t, 10), /^✓ SLRR Auto-correct Test · today: 1 alert, 1 corrected/);
  });

  test('S-F Burson blank (fail closed): the Relay (row 22 ON) doesn\'t run and C22 says it needs B25; never live: Auto-send and the DMs to the leads behave as testing even in the real space; the Burson outbox sends nothing (a row set to Send waits, C24 says why) and nothing new is queued', () => {
    // The relay: ON, but no S-F Burson (and no Mirror space)
    const r = e2e();
    r.bot.setup();
    r.control().getRange(22, 2).setValue('ON');
    r.poll();
    eq([switchNote(r, 22).split(' · ').pop(), r.g.props.get('RELAY_CURSORS')], ['not relaying: it needs the S-F Burson space (B25) and the Mirror space (B9)', undefined]);
    eq(r.get('B5'), '⚠️ S-F Burson space (B25) is blank: paste S-F Burson\'s link there. Until then the Relay (row 22) is paused.');
    // Never live: the run's ctx is LIVE only when its mode is (runMode_: the Burson space is B25's, B26 blank, the valve
    // OFF), as poll() builds it; a ctx with no mode is Testing
    const cfg = sfBurson => {
      const c = { burson: { id: REAL, name: 'S-F' }, analyst: { id: TRIAGED, name: 'A' }, sfBurson };
      c.mode = r.bot.runMode_(r.bot.switchesOff_(), '', sfBurson, c);
      return c;
    };
    eq([r.bot.buildCtx_(cfg(null), r.sheet()).drafts.live, r.bot.buildCtx_(cfg({ id: REAL }), r.sheet()).drafts.live,
      r.bot.buildCtx_(cfg({ id: NEW }), r.sheet()).drafts.live,
      r.bot.buildCtx_(Object.assign(cfg({ id: REAL }), { mode: undefined }), r.sheet()).drafts.live], [false, true, false, false]);

    // The outbox: rows queued while B25 was set, one set to Send; then B25 cleared
    const t = e2e();
    t.bot.setup();
    t.set('B25', ROOM);
    t.set('B3', ROOM);
    t.control().getRange(24, 2).setValue('ON');
    t.poll();
    const ok = t.chat.say(REAL, F.P0_OK, ZAP);
    t.poll();
    const queued = outbox(t).length;
    assert.ok(queued > 0, 'the bot\'s emojis wait on the outbox');
    outboxTab(t).getRange(2, 6).setValue('Send');
    t.set('B25', '');
    t.chat.say(REAL, 'Why is this one P0?', Object.assign({ thread: ok.thread.name }, ALICE));
    t.poll();
    t.poll();
    eq([writesIn(t, REAL), outbox(t).length, outbox(t)[0].status], [[], queued, 'Send']);  // waits; nothing new queued
    assert.match(switchNote(t, 24), /not sending or queuing: the S-F Burson space \(B25\) is blank or can't be found$/);
    assert.ok(t.g.logs.some(l => OUTSIDE_LOG.test(l)), 'the answer to Alice was held back');
    // Set again: the row set to Send goes, once
    t.set('B25', ROOM);
    t.poll();
    eq([outbox(t)[0].status, t.chat.botReactions(ok.name).length], ['Sent', 1]);
    H.collectBurson(t.chat, [REAL]);
  });

  test('the safety net, whatever B25 says: a Burson space (B3) people outside Google can join with B25 blank is read and its alerts reach analysts, but nothing is posted or reacted there (held back, counted in the run log), nothing is queued even with Post in S-F Burson ON, C3 and Status say why, and Chat.gs refuses a write there too', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B3', ROOM);
    t.control().getRange(24, 2).setValue('ON');
    t.poll();
    const bad = t.chat.say(REAL, F.MISTAKES, ZAP);
    const pasted = t.chat.say(REAL, F.AIO, { sender: 'users/bot' });  // the bot's own account in a space outsiders can join: never an alert
    t.chat.say(REAL, 'Why is this one wrong?', Object.assign({ thread: bad.thread.name }, ALICE));
    t.poll();
    t.poll();
    eq([writesIn(t, REAL), t.chat.botPosts(REAL), t.chat.botReactions(bad.name), outboxTab(t)], [[], [], [], null]);
    eq(tops(t, TRIAGED).map(m => m.text.split('\n')[0]).slice(1), [F.MISTAKES_FIXED.split('\n')[0]]);  // analysts get it, corrected
    assert.ok(!tops(t, TRIAGED).some(m => /TheChiefNerd/.test(m.text)), 'the bot account\'s paste is no alert');
    assert.ok(t.chat.botReactions(pasted.name).length === 0);
    eq(t.get('C3'), '⚠️ [S-F] Burson Automated Alerts V3: people outside Google can join it and it isn\'t the S-F Burson space (B25), ' +
      'so the bot posts nothing there (see Status)');
    eq(t.get('B5'), '⚠️ S-F Burson space (B25) is blank: paste S-F Burson\'s link there. Until then nothing is posted or reacted in ' +
      'the Burson space (B3), which people outside Google can join.');
    assert.ok(t.g.logs.some(l => OUTSIDE_LOG.test(l)), t.g.logs.filter(l => /held back/.test(l)).join('\n'));
    assert.ok(!t.g.logs.some(l => /^S-F Burson: (withheld|queued) this run/.test(l)));
    eq([switchNote(t, 11).slice(0, 3), t.bot.buildCtx_({ burson: { id: REAL }, analyst: { id: TRIAGED } }, t.sheet()).drafts.live], ['OFF', false]);
    assert.throws(() => t.bot.chatPostMessage_(REAL, 'x', {}), /^Error: Refusing to write in spaces\/AAQAaa_0I9g: people outside Google can join it, and it isn't the S-F Burson space \(Control tab B25\)\.$/);
    assert.throws(() => t.bot.chatReact_(`${bad.name}`, '👍'), /Refusing to write in spaces\/AAQAaa_0I9g/);
  });

  test('the safety net: with B25 another space, a Burson space (B3) people outside Google can join gets nothing either (C3 and Status name both); with B3 the B25 space itself the flow is today\'s: Post in S-F Burson OFF withholds, ON queues on the outbox', () => {
    const t = e2e();
    t.chat.addSpace(NEW, '[S-F] Burson Automated Alerts V4', { external: true });
    t.bot.setup();
    t.set('B25', NEW);
    t.set('B3', ROOM);
    t.poll();
    const one = t.chat.say(REAL, F.MISTAKES, ZAP);
    t.poll();
    eq([writesIn(t, REAL), writesIn(t, NEW), t.chat.botReactions(one.name), outboxTab(t)], [[], [], [], null]);
    eq(t.get('B5'), '⚠️ The Burson space (B3) "[S-F] Burson Automated Alerts V3" allows people outside Google and isn\'t the S-F ' +
      'Burson space in B25 ("[S-F] Burson Automated Alerts V4"), so the bot posts and reacts nothing there. If it is S-F Burson, ' +
      'paste it in B25 too; to test, use a space only Google people can join.');
    assert.match(t.get('C3'), /^⚠️ \[S-F\] Burson Automated Alerts V3: people outside Google can join it and it isn't the S-F Burson space \(B25\)/);
    assert.ok(t.g.logs.some(l => OUTSIDE_LOG.test(l)));
    // B3 = B25: today's flow. OFF: withheld (counted); ON: each write waits on the outbox
    t.set('B25', ROOM);
    const two = t.chat.say(REAL, F.MAPS, ZAP);
    t.poll();
    eq([writesIn(t, REAL), t.get('C3'), t.get('B5')], [[], '✓ [S-F] Burson Automated Alerts V3', '🔴 LIVE · ✅ Working']);
    assert.ok(t.g.logs.some(l => /^S-F Burson: withheld this run/.test(l)));
    t.control().getRange(24, 2).setValue('ON');
    t.chat.say(REAL, 'Why is this one wrong?', Object.assign({ thread: two.thread.name }, ALICE));
    t.poll();
    eq([writesIn(t, REAL), outbox(t).map(r => [r.kind, r.status])], [[], [['reply', 'Pending']]]);
    assert.ok(outbox(t)[0].where.indexOf(ROOM + '/') === 0, outbox(t)[0].where);
    H.collectBurson(t.chat, [REAL]);
  });

  test('changing B25 takes effect on the next run: the Mirror and Auto-correct start on the new space from its last 15 minutes, the relay starts again (saying so in the Mirror space), outbox rows queued for the old space are Blocked and never sent, and Chat.gs refuses the new space', () => {
    const t = e2e(null, { noWait: true });
    t.chat.addSpace(NEW, '[S-F] Burson Automated Alerts V4', { external: true });
    t.chat.addSpace(MIRROR, 'SLRR Zapier Training Mirror');
    t.chat.addSpace(AC, 'SLRR Auto-correct Test');
    t.bot.setup();
    const oldNew = t.chat.say(NEW, F.AIO, ZAP);  // in the new space long before the change: never pulled
    t.g.clock.now += 3600e3;
    t.set('B25', REAL);
    t.bot.startMirror('SLRR Zapier Training Mirror');
    t.bot.startAutoCorrect('SLRR Auto-correct Test');
    t.control().getRange(22, 2).setValue('ON');
    t.control().getRange(24, 2).setValue('ON');
    t.poll();
    const zap = t.chat.say(REAL, F.P0_OK, ZAP);
    t.poll();
    const copy = tops(t, MIRROR).find(m => m.text === F.P0_OK);
    t.chat.say(MIRROR, 'Thanks, all good', Object.assign({ thread: copy.thread.name }, DANA));
    t.poll();
    eq(outbox(t).map(r => [r.kind, r.text, r.status]), [['reaction', '👍', 'Pending'], ['reply', 'Dana Lee: Thanks, all good', 'Pending']]);
    const startNotes = () => t.chat.botPosts(MIRROR).filter(m => /^The relay with S-F Burson is on from/.test(m.text)).length;
    eq([startNotes(), JSON.parse(t.g.props.get('RELAY_CURSORS')).sfb], [1, REAL]);
    // Someone sets the queued relay row to Send, and changes S-F Burson before the next run
    outboxTab(t).getRange(3, 6).setValue('Send');
    const recentNew = t.chat.say(NEW, F.MAPS, ZAP);  // in the new space a few minutes before the change
    t.g.clock.now += 5 * 60e3;
    t.set('B25', NEW);
    H.markAs(t, ALICE.sender, 'Burson');  // her org on the Relay names tab: she shows as "Alice Smith (Burson)"
    t.chat.say(NEW, 'Morning from the new space', ALICE);
    t.poll();
    t.poll();
    eq([t.get('C25'), t.bot.sfBursonId_()], ['✓ [S-F] Burson Automated Alerts V4', NEW]);
    // The row queued for the old space: Blocked, never sent (nothing written in either space)
    const danaRow = outbox(t).find(r => r.text === 'Dana Lee: Thanks, all good');
    eq([danaRow.status, danaRow.note], ['Blocked', 'not sent: it was queued for a different S-F Burson space (B25 has changed since)']);
    eq([writesIn(t, REAL), writesIn(t, NEW), t.chat.botPosts(REAL), t.chat.botReactions(zap.name)], [[], [], [], []]);
    // The Mirror and Auto-correct: the new space's last 15 minutes only
    eq(tops(t, MIRROR).filter(m => m.text === F.MAPS).length, 1);
    eq(tops(t, MIRROR).filter(m => m.text === F.AIO).length, 0);
    assert.ok(tops(t, AC).some(m => /MAPS|Maps/.test(m.text)), tops(t, AC).map(m => m.text.split('\n')[0]).join(' | '));
    assert.ok(!tops(t, AC).some(m => /TheChiefNerd/.test(m.text)), 'the old post in the new space isn\'t pulled');
    eq([t.g.props.get('LAST_MIRROR_SOURCE'), t.g.props.get('LAST_AC_SOURCE')], [NEW, NEW]);
    // The relay started again on the new space, and says so; Burson's message there came over
    eq([startNotes(), JSON.parse(t.g.props.get('RELAY_CURSORS')).sfb], [2, NEW]);
    assert.ok(t.chat.botPosts(MIRROR).some(m => m.text === 'Alice Smith (Burson): Morning from the new space'));
    // A reply under the old space's alert copy can't go to the new space: it stays in the Mirror space
    t.chat.say(MIRROR, 'Another one under the old alert', Object.assign({ thread: copy.thread.name }, DANA));
    t.poll();
    eq(outbox(t).filter(r => r.from !== 'bot').map(r => r.text), ['Dana Lee: Thanks, all good']);
    // Chat.gs: the new S-F Burson refuses any direct write; the old one is now just a space the bot doesn't use
    assert.throws(() => t.bot.chatPostMessage_(NEW, 'x', { key: 'k' }), /Refusing to write in S-F Burson/);
    assert.ok(oldNew && recentNew);
  });

  test('upgrading from the build before B25: a Mirror it left copying (its cursor, no source noted) carries on from its cursor once B25 names S-F Burson, as on that build: nothing it had passed is copied again, even with its recent-messages cache gone; the source is noted, so a later change of B25 still starts afresh', () => {
    const t = e2e();
    t.chat.addSpace(MIRROR, 'SLRR Zapier Training Mirror');
    t.bot.setup();
    t.set('B25', ROOM);
    t.set('B9', 'SLRR Zapier Training Mirror');
    t.poll();
    t.chat.say(REAL, F.P0_OK, ZAP);
    t.poll();
    t.g.clock.now += 8 * 60e3;
    t.chat.say(REAL, 'Morning all', ALICE);  // a newer message: the cursor moves past the alert and its overlap
    t.poll();
    eq(tops(t, MIRROR).filter(m => m.text === F.P0_OK).length, 1);
    // What the build before B25 leaves: no LAST_MIRROR_SOURCE (and, at worst, its recent-messages cache gone)
    t.g.props.delete('LAST_MIRROR_SOURCE');
    t.g.cache.delete('recent:mirror:' + MIRROR);
    const cursor = t.g.props.get('MIRROR_CURSOR:' + MIRROR);
    const writes = writesIn(t, MIRROR).length;
    t.poll();
    // not copied again: not even asked of Chat (whose request id would have kept a second copy out anyway)
    eq([tops(t, MIRROR).filter(m => m.text === F.P0_OK).length, writesIn(t, MIRROR).length], [1, writes]);
    eq([t.g.props.get('MIRROR_CURSOR:' + MIRROR), t.g.props.get('LAST_MIRROR_SOURCE')], [cursor, REAL]);
    // A later change of B25 still starts afresh, from the new space's last 15 minutes
    t.chat.addSpace(NEW, '[S-F] Burson Automated Alerts V4', { external: true });
    t.chat.say(NEW, F.MAPS, ZAP);
    t.set('B25', NEW);
    t.poll();
    eq([tops(t, MIRROR).filter(m => m.text === F.MAPS).length, t.g.props.get('LAST_MIRROR_SOURCE')], [1, NEW]);
  });

  test('Chat.gs\'s backstop uses the resolved S-F Burson id (whatever space B25 names): every write there is refused but an outbox row being sent; a space the run noted as outside Google is refused always; with none known, only those', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const OTHER = 'spaces/AAQAother001';
    [OTHER, REAL, VENDOR].forEach(s => g.chat.addSpace(s, s));
    bot.setSfBurson_({ id: OTHER, name: 'Other' });
    assert.throws(() => bot.chatPostMessage_(OTHER, 'x', {}), /^Error: Refusing to write in S-F Burson: only a Burson outbox row someone set to Send is posted there\.$/);
    assert.throws(() => bot.chatReact_(`${OTHER}/messages/m1`, '👍'), /Refusing to write in S-F Burson/);
    bot.ev('OUTBOX_WRITING_ = true');
    eq(bot.chatPostMessage_(OTHER, 'from the outbox', {}).text, 'from the outbox');
    bot.ev('OUTBOX_WRITING_ = false');
    eq(bot.chatPostMessage_(REAL, 'not S-F Burson this run', {}).text, 'not S-F Burson this run');
    bot.noteOutsideSpace_(VENDOR);
    bot.noteOutsideSpace_(OTHER);  // S-F Burson itself is never noted as outside
    assert.throws(() => bot.chatPostMessage_(VENDOR, 'x', {}), /people outside Google can join it/);
    bot.ev('OUTBOX_WRITING_ = true');
    assert.throws(() => bot.chatPostMessage_(VENDOR, 'x', {}), /people outside Google can join it/);  // never, even then
    eq(bot.chatPostMessage_(OTHER, 'again from the outbox', {}).text, 'again from the outbox');
    bot.ev('OUTBOX_WRITING_ = false');
    eq([bot.chatWriteRefusal_(`${OTHER}/messages`).slice(0, 34), bot.chatWriteRefusal_(`${VENDOR}/messages`).slice(0, 35), bot.chatWriteRefusal_(`${REAL}/messages`)],
      ['Refusing to write in S-F Burson: o', `Refusing to write in ${VENDOR}`.slice(0, 35), '']);
    bot.setSfBurson_(null);  // a new run with no S-F Burson known: the outside spaces of the last run are forgotten too
    eq([bot.sfBursonId_(), bot.chatWriteRefusal_(`${OTHER}/messages`), bot.chatWriteRefusal_(`${VENDOR}/messages`)], ['', '', '']);
    eq(bot.chatListMessages_(OTHER, '', 10).length, 2);  // reading is never refused
  });

  test('no space id in any .gs file: S-F Burson is never named in the code (no REAL_BURSON_SPACE, no [S-F] Burson id), and the only space id left is the analyst space a brand-new Control tab is pre-filled with', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..');
    const files = fs.readdirSync(dir).filter(f => /\.gs$/.test(f));
    assert.ok(files.length > 20, files.join(','));
    const ids = [];
    files.forEach(f => {
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        assert.ok(!/AAQAaa_0I9g|REAL_BURSON_SPACE/.test(line), `${f}:${i + 1}: ${line}`);
        (line.match(/spaces\/[A-Za-z0-9_-]{6,}|\bAAQA[A-Za-z0-9_-]{7}\b/g) || []).forEach(id => ids.push(`${f}: ${id}: ${line.trim()}`));
      });
    });
    eq(ids, ['Config.gs: spaces/AAQAaLn375E: const START_ANALYST_SPACE = \'spaces/AAQAaLn375E\';  // SLRR Triaged Alerts']);
    eq([B.ev('typeof REAL_BURSON_SPACE'), B.ev('typeof START_BURSON_SPACE'), B.ev('START_BURSON_SPACE')], ['undefined', 'string', 'SLRR Test Feed (Burson Sim)']);
  });
};
