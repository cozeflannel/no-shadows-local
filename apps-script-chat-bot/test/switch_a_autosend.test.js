// Auto-send Social Alerts (Control tab row 11, Drafts.gs autoSend_): live, with no stand-in, the bot sends the Social
// Alert itself instead of leaving a Gmail draft. OFF, while testing, and in the Mirror / auto-correct / test spaces,
// nothing changes. Never sent twice.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, NOW, world, e2e, collectBurson, plain, TEST_FEED, TRIAGED } = H;
  const LIVE = { live: true, mailbox: 'im@ops.test', from: 'Brand Social <sender@alerts.test>' };
  const NOT_LIVE = { live: false, mailbox: 'im@ops.test', from: 'Brand Social <im@ops.test>' };
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const ON = { autoSend: true };
  const PARIS_LINK = 'https://x.com/paris_tech_press/status/1845000000000000003';
  // A Brand alert (Politics, so always escalated): Brand has no alert contacts, so its email has nobody in To
  const BRAND = [
    'THIS ALERT MEETS P2 CRITERIA', '',
    '⬛SOCIAL ALERT⬛: Brand | Alleged Election Interference | X | 0 Engagements',
    '[Name]: Alleged Election Interference / New / not previously reported over the past 14 days',
    '[Engagement]: VERY LOW (0 engagement)', '[Product]: Brand', '[Social Network]: X',
    '[Exposure Tag]: Brand - Conspiratorial theories about Google', '[Sensitive Topic]: Politics', '[KOF]: No', '',
    'X user helpfulmeerkat (46 followers) accuses Anthropic of planning to interfere in an upcoming election. Google and Meta are ' +
      'also named, with the user arguing they should face similar actions.', '',
    '[Link]: https://x.com/helpfulmeerkat/status/2111095982725468221', '',
    '[Time/Date Post Went Live]: October 13, 2026, 7:04 AM', '',
    '[Code]: Brand - Conspiratorial theories about Google,0,helpfulmeerkat,Politics,Brand,New / not previously reported over the past 14 days',
  ].join('\n');

  // Real distros, as live: no stand-in anywhere (the YAML's is cleared too)
  const liveWorld = opts => {
    const w = world(Object.assign({ drafts: LIVE }, opts || {}));
    w.bot.ev('GEN').email.stand_in = '';
    return w;
  };
  // One run (as w.run()) with these ctx fields on top of the test ctx: switches, outboundBlocked, a memo, …
  const runWith = (w, extra) => {
    w.g.clock.now += 1000;
    const c = w.ctx();
    Object.keys(extra || {}).forEach(k => { c[k] = extra[k]; });
    const report = w.bot.runOnce_(c);
    collectBurson(w.chat, [w.BUR]);
    return report;
  };
  const sends = w => w.gmail.calls.filter(c => c.method === 'post' && c.path === 'messages/send').length;
  const memo = (w, k) => w.ctx().memo.get(k);
  const forwards = w => w.analystPosts().filter(m => !m.threadReply);
  const notes = w => w.analystPosts().filter(m => m.threadReply).map(m => m.text);
  const switchNotes = w => JSON.parse(w.g.props.get('SWITCH_NOTES') || '{}');
  // Gmail delivers the send but answers with an error anyway (a 503, or a timeout after it went out). Returns the undo.
  const deliveredBut = (w, code) => {
    w.gmail.handle = function (url, params) {
      const res = Object.getPrototypeOf(this).handle.call(this, url, params);
      return /\/messages\/send$/.test(url) ? { code, body: { error: { code, message: 'Unavailable' } } } : res;
    };
    return () => { delete w.gmail.handle; };
  };
  const sentSearches = w => w.gmail.calls.filter(c => c.method === 'get' && c.path === 'messages' && /\bin:sent\b/.test(c.query.q || ''));
  const CHECK_SENT = 'check Sent in Gmail before sending this draft. If it went, don\'t send it again: the bot finds it there, ' +
    'marks the alert sent and removes this draft.';
  // Everything a run leaves behind: Chat (posts, threads, every reaction), Gmail (drafts, sends, every call), the Alert
  // log, the bot's memory and script properties, and the run log
  const snapshot = w => ({
    chat: [w.BUR, w.ANA].map(s => w.chat.spaces.get(s).messages.map(m => [m.name, m.text, m.thread.name, m.threadReply,
      m.clientAssignedMessageId || '', m.reactions.map(r => `${r.user} ${r.emoji}`)])),
    drafts: w.gmail.allDrafts().map(d => [d.id, d.threadId, d.mime]),
    sent: w.gmail.sentMessages().map(m => [m.id, m.threadId, m.mime]),
    gmail: w.gmail.calls.map(c => [c.method, c.path, c.query]),
    rows: plain(w.alertRows()),
    memo: ['open_drafts', 'tns_watch', 'lead_pings', 'auto_sent'].map(k => memo(w, k)),
    props: Array.from(w.g.props.entries()),
    logs: w.g.logs.slice(),
  });
  // Two alerts (one with T&S), a person sending the first draft, a T&S confirmation, and quiet runs: as the bot runs
  const flow = (w, extra) => {
    w.paste(F.P0_OK);
    runWith(w, extra);
    w.paste(F.PARIS);
    runWith(w, extra);
    const draft = w.gmail.allDrafts()[0];
    if (draft) w.gmail.send(draft.id, 'im@ops.test', '<sent-by-a-person@mail.test>');
    w.gmail.receive('WD Intake Request - Marketing', `Submitted link: ${PARIS_LINK}`);
    runWith(w, extra);
    runWith(w, extra);
  };

  test('auto-send OFF (or no switches at all): live, the Social Alert is still a Gmail draft for a person, exactly as before; nothing is sent, noted or remembered', () => {
    const none = liveWorld();
    flow(none, {});
    const off = liveWorld();
    flow(off, { switches: Object.assign(off.bot.switchesOff_(), { autoSend: false }) });
    const offString = liveWorld();
    flow(offString, { switches: { autoSend: 'ON' } });  // only true turns it on
    eq(snapshot(off), snapshot(none));
    eq(snapshot(offString), snapshot(none));
    eq([sends(none), none.gmail.sentMessages().length, none.gmail.allDrafts().length], [0, 0, 1]);  // one sent by a person, one waiting
    eq(none.alertRows().map(r => r.email_status), ['sent', 'drafted']);
    assert.strictEqual(none.alertRows()[0].email_sent_by, 'im@ops.test');
    eq([memo(none, 'auto_sent'), switchNotes(none).autoSend], [null, undefined]);
    assert.ok(notes(none).every(n => !/Auto-send|sent it itself/.test(n)));
  });

  test('auto-send ON, live: the Social Alert goes out at once, the very email the draft would have been; the row is sent with its thread, the emojis are those of who it went to, a note goes under the forwarded alert, and there\'s no draft and no 👍', () => {
    const off = liveWorld();  // the same alert with the switch OFF: a draft, then a person sends it unchanged
    const offMsg = off.paste(F.P0_OK);
    off.run();
    const [draft] = off.gmail.allDrafts();
    const offNote = notes(off)[0];
    off.gmail.send(draft.id, 'im@ops.test');
    off.run();

    const w = liveWorld();
    w.bot.__afterSend = [];
    w.bot.ev('onEmailSent_ = function (ctx, row, report) { __afterSend.push(row.alert_id + ":" + row.email_status); }');
    const msg = w.paste(F.P0_OK);
    const r = runWith(w, { switches: ON });
    eq([r.auto_sent, r.drafts_sent, r.drafts, r.errors, w.gmail.allDrafts().length, sends(w)], [1, 1, 0, [], 0, 1]);
    const [sent] = w.gmail.sentMessages();
    eq([sent.mime, sent.from], [draft.mime, 'Brand Social <sender@alerts.test>']);  // byte for byte the draft
    assert.ok(sent.to.includes('search@alerts.test') && sent.cc.includes('france-leads@alerts.test'));
    const [row] = w.alertRows();
    eq([row.email_status, row.email_draft, row.email_thread, row.email_message_id, row.email_sent_by, row.email_error],
      ['sent', '', sent.threadId, sent.messageId, 'bot', '']);
    assert.ok(row.email_at > 0 && row.email_sent_at === row.email_at, String(row.email_sent_at));
    eq(w.bot.__afterSend, [`${row.alert_id}:sent`]);  // what the other switches do after a send

    // The emojis a person's send would have brought, without the 👍 that only says a person still has to act
    const fwd = forwards(w)[0];
    eq(w.chat.botReactions(fwd.name), off.chat.botReactions(forwards(off)[0].name));
    eq(w.chat.botReactions(fwd.name), ['📦', '🌎']);
    eq(w.chat.botReactions(msg.name), off.chat.botReactions(offMsg.name).filter(e => e !== '👍'));
    eq(w.bursonPosts(), []);

    // The note: the draft's note, with "sent" in place of its first line, in the alert's analyst thread
    const [note] = notes(w);
    const lines = note.split('\n');
    eq(lines[0], 'Social Alert sent: the bot sent it itself (Auto-send Social Alerts is ON).');
    eq(lines.slice(1), offNote.split('\n').slice(1));
    assert.match(lines[2], /^- To: Search alert POCs \(\d+\)$/);
    assert.strictEqual(w.analystPosts().find(m => m.threadReply).thread.name, fwd.thread.name);

    // Column C: today's count and the last one
    const status = switchNotes(w).autoSend.text;
    assert.match(status, /^1 sent today · last QA-1001 at Oct 14, \d{1,2}:\d\d [AP]M EDT$/);
    eq(w.bot.switchStatusTexts_({ autoSend: true }, '', switchNotes(w), w.g.clock.now)[0],
      `✓ ON: the bot sends the Social Alert email itself · ${status}`);
    eq(plain(JSON.parse(memo(w, 'auto_sent'))).map(e => [e.id, e.thread, e.msg, e.sent]), [['QA-1001', sent.threadId, sent.id, true]]);

    // Later runs: nothing more is sent, posted or marked
    runWith(w, { switches: ON });
    runWith(w, { switches: ON });
    eq([sends(w), notes(w).length, w.gmail.allDrafts().length, w.chat.botReactions(msg.name)], [1, 1, 0, ['📦', '🌎']]);
    eq(w.bot.__afterSend.length, 1);
  });

  test('auto-send ON, live: T&S alerts get the form details in the note and ✍️ once confirmed; a follow-up goes out as a reply on the same thread; each alert once', () => {
    const w = liveWorld();
    const paris = w.paste(F.PARIS);
    const r = runWith(w, { switches: ON });
    eq([r.auto_sent, w.gmail.allDrafts().length], [1, 0]);
    const note = notes(w)[0];
    assert.match(note, /^Social Alert sent: the bot sent it itself/);
    assert.match(note, /\nT&S form needed \(viral KOF, AI hallucination\): <https:\/\/docs\.google\.com\/forms\/d\/e\/1FAIpQLScd0be[^|]+\|Open the T&S Intake Form, pre-filled>/);
    eq(JSON.parse(memo(w, 'tns_watch')), ['QA-1001']);
    w.gmail.receive('WD Intake Request - Marketing', `Submitted link: ${PARIS_LINK}`);
    runWith(w, { switches: ON });
    assert.ok(w.chat.botReactions(paris.name).includes('✍'));
    assert.ok(w.chat.botReactions(forwards(w)[0].name).includes('✍'));

    // A follow-up on the same issue, two hours later: sent as an update, on the first email's thread
    const v = liveWorld();
    v.paste(F.P0_OK);
    runWith(v, { switches: ON });
    v.g.clock.now += 2 * 3600 * 1000;
    v.paste(F.P0_OK
      .replace('https://x.com/WasSamLowryEsq/status/2109952063492993159', 'https://x.com/AnotherUser/status/2109952063492999999')
      .replace('VERY LOW (1 engagements)', 'HIGH (4200 engagements)')
      .replace(',1,WasSamLowryEsq,', ',4200,AnotherUser,'));
    runWith(v, { switches: ON });
    const [first, update] = v.gmail.sentMessages();
    eq([update.threadId, update.inReplyTo, update.references, update.subject],
      [first.threadId, first.messageId, first.messageId, 'Re: ' + first.subject]);
    eq(v.alertRows().map(x => [x.email_status, x.email_thread, x.email_sent_by]),
      [['sent', first.threadId, 'bot'], ['sent', first.threadId, 'bot']]);
    assert.match(notes(v)[1], /^Social Alert sent \(as an update on the earlier email\): the bot sent it itself/);
    runWith(v, { switches: ON });
    eq([sends(v), v.gmail.allDrafts().length], [2, 0]);
    assert.match(switchNotes(v).autoSend.text, /^2 sent today · last QA-1002 at /);
  });

  test('auto-send ON while testing (a stand-in): exactly today\'s send to the stand-in, nothing else; with a stand-in in the YAML only, a Testing run (the Safety valve ON, or B26 set), the auto-correct space or a test space, a draft as with it OFF; LIVE in the Mirror space, it sends', () => {
    const off = world({ drafts: STAND_IN });
    flow(off, {});
    const on = world({ drafts: STAND_IN });
    flow(on, { switches: ON });
    eq(snapshot(on), snapshot(off));
    assert.ok(on.gmail.sentMessages().length >= 2);
    on.gmail.sentMessages().forEach(m => eq([m.to, m.cc, m.bcc], [['tester@testing.test'], [], []]));
    eq([memo(on, 'auto_sent'), switchNotes(on).autoSend], [null, undefined]);

    // The YAML still has the stand-in (only the run's drafts settings are live): a real-distro draft, never a send
    const testingRun = () => { const w = liveWorld(); w.bot.setRunLive_(false); return w; };  // runMode_ said Testing
    const cases = [
      ['the YAML\'s stand-in', () => { const w = world({ drafts: LIVE }); w.bot.setRunLive_(null); w.bot.ev('GEN').email.stand_in = 'tester@testing.test'; return w; }, {}],
      ['a Testing run (the Safety valve ON, or B26 set)', testingRun, {}],
      ['the auto-correct space', () => liveWorld(), { sourceReadOnly: true, changeNotes: true, flowTag: '[Auto-correct test]' }],
      ['a test space (not the real Burson space)', () => liveWorld({ drafts: NOT_LIVE }), {}],
    ];
    cases.forEach(([name, make, extra]) => {
      const a = make();
      flow(a, extra);
      const b = make();
      flow(b, Object.assign({ switches: ON }, extra));
      eq(snapshot(b), snapshot(a), name);
      eq([sends(b), memo(b, 'auto_sent'), switchNotes(b).autoSend], [0, null, undefined], name);
      assert.ok(b.gmail.allDrafts().length >= 1, name);
    });

    // LIVE in the Mirror space (S-F Burson's alerts, the Safety valve OFF, B26 blank): it sends, as from S-F Burson
    const mirror = liveWorld();
    flow(mirror, { switches: ON, outboundBlocked: true });
    assert.ok(sends(mirror) >= 1);
    assert.ok(mirror.gmail.sentMessages().every(m => !m.to.includes('tester@testing.test')));
  });

  test('auto-send applies only with the switch ON and the run LIVE (no stand-in anywhere), from the Mirror space too, never in the auto-correct space', () => {
    const w = liveWorld();
    const on = extra => w.bot.autoSendOn_(Object.assign({ switches: { autoSend: true }, drafts: { live: true, standIn: '' } }, extra));
    eq([on({}), on({ switches: { autoSend: false } }), on({ switches: undefined }), on({ switches: { kbStartAlerts: true } }),
      on({ drafts: { live: false, standIn: '' } }), on({ drafts: { live: true, standIn: 'tester@testing.test' } }),
      on({ outboundBlocked: true }), on({ sourceReadOnly: true }), on({ drafts: undefined })],
    [true, false, false, false, false, false, true, false, false]);
    w.bot.setRunLive_(null);
    w.bot.ev('GEN').email.stand_in = ' tester@testing.test ';
    eq(on({}), false);  // no run said LIVE: fails closed to Testing
    w.bot.ev('GEN').email.stand_in = '';
    w.bot.setRunLive_(true);  // the run is LIVE (runMode_)
    eq([on({}), on({ outboundBlocked: true })], [true, true]);
    w.bot.setRunLive_(false);  // the run is Testing (the Safety valve ON, or B26 set): never, whatever the drafts settings say
    eq([on({}), on({ outboundBlocked: true })], [false, false]);
  });

  test('auto-send, never twice: a retry after the sheet lost the "sent" mark marks it sent again from memory (its thread and Message-ID too) without sending; an alert retried after its run failed isn\'t sent again', () => {
    const w = liveWorld();
    w.paste(F.P0_OK);
    runWith(w, { switches: ON });
    const [row] = w.alertRows();
    const [sent] = w.gmail.sentMessages();
    // The sheet didn't keep the send (a write that failed), and the alert is tried again
    Object.assign(row, { email_status: 'pending', email_thread: '', email_message_id: '', email_sent_by: '', email_sent_at: '' });
    w.ctx().memo.set('open_drafts', JSON.stringify([row.alert_id]));
    const r = runWith(w, { switches: ON });
    eq([sends(w), w.gmail.allDrafts().length, r.auto_sent || 0, r.errors], [1, 0, 0, []]);
    eq([row.email_status, row.email_thread, row.email_message_id, row.email_sent_by], ['sent', sent.threadId, sent.messageId, 'bot']);
    eq(notes(w).length, 1);  // the note went up once (by its key)
    assert.ok(w.g.logs.some(l => /QA-1001 already went out \(auto-send\); marking it sent, not sending it again/.test(l)));
    eq(JSON.parse(memo(w, 'open_drafts')), []);

    // The run fails after the send (the message log write): the alert is retried and finished, never sent again
    const v = liveWorld();
    const append = v.backend.appendMessage;
    let failOnce = true;
    v.backend.appendMessage = function (obj) {
      if (failOnce && obj.kind === 'alert') { failOnce = false; throw new Error('Service Spreadsheets timed out'); }
      return append.call(this, obj);
    };
    const msg = v.paste(F.P0_OK);
    const r1 = runWith(v, { switches: ON });
    assert.ok(r1.errors.some(e => /timed out/.test(e)), JSON.stringify(r1.errors));
    runWith(v, { switches: ON });
    runWith(v, { switches: ON });
    eq([sends(v), v.gmail.allDrafts().length, v.alertRows().length, v.alertRows()[0].email_status], [1, 0, 1, 'sent']);
    eq(v.chat.botReactions(msg.name), ['📦', '🌎']);
  });

  test('auto-send: when Gmail refuses the send, the alert gets the usual draft with a warning to check Sent first, and the send is never tried again (not even when the draft has to be retried)', () => {
    const w = liveWorld();
    w.gmail.fail = (method, path) => (method === 'post' && path === 'messages/send'
      ? { code: 500, body: { error: { code: 500, message: 'Backend Error' } } } : null);
    const msg = w.paste(F.P0_OK);
    const r = runWith(w, { switches: ON });
    eq([r.auto_sent || 0, r.drafts, r.drafts_sent, sends(w), w.gmail.sentMessages().length, w.gmail.allDrafts().length, r.errors],
      [0, 1, 0, 1, 0, 1, []]);
    eq(w.alertRows()[0].email_status, 'drafted');
    const lines = notes(w)[0].split('\n');
    assert.match(lines[0], /^\S+ Social Alert draft is in Gmail Drafts: review and send it/);
    eq(lines[1], '- The bot tried to send this Social Alert itself (Auto-send Social Alerts) and Gmail said: Gmail 500 on ' +
      `sending an email: Backend Error. It may have gone out anyway: ${CHECK_SENT}`);
    assert.match(switchNotes(w).autoSend.text, /^the send for QA-1001 failed at Oct 14, .*: it's a draft for a person$/);
    eq(w.chat.botReactions(msg.name), ['👍']);  // waiting on a person, as any draft
    w.gmail.fail = null;
    runWith(w, { switches: ON });
    eq([sends(w), w.gmail.allDrafts().length], [1, 1]);
    // A person sends it: the usual emojis
    w.gmail.send(w.gmail.allDrafts()[0].id, 'im@ops.test');
    runWith(w, { switches: ON });
    eq([sends(w), w.alertRows()[0].email_status, w.alertRows()[0].email_sent_by, w.chat.botReactions(msg.name)],
      [1, 'sent', 'im@ops.test', ['\ud83d\udc4d', '\ud83d\udce6', '\ud83c\udf0e']]);

    // The send fails and so does the draft, twice: the email is retried as a draft only, with a warning
    const v = liveWorld();
    let draftFails = 2;
    v.gmail.fail = (method, path) => {
      if (method === 'post' && path === 'messages/send') return { code: 503, body: { error: { code: 503, message: 'Unavailable' } } };
      if (method === 'post' && path === 'drafts' && draftFails-- > 0) return { code: 400, body: { error: { code: 400, message: 'Bad Request' } } };
      return null;
    };
    v.paste(F.P0_OK);
    runWith(v, { switches: ON });
    eq([sends(v), v.gmail.allDrafts().length, v.alertRows()[0].email_status, v.alertRows()[0].email_attempts], [1, 0, 'pending', 2]);
    runWith(v, { switches: ON });
    runWith(v, { switches: ON });
    eq([sends(v), v.gmail.allDrafts().length, v.alertRows()[0].email_status], [1, 1, 'drafted']);
    eq(notes(v)[0].split('\n')[1], '- The bot already tried to send this Social Alert itself (Auto-send Social Alerts) and ' +
      `can't tell whether it went out: ${CHECK_SENT}`);
  });

  test('auto-send: an alert with nobody to send it to (no alert contacts for the product) stays a draft, saying why', () => {
    const w = liveWorld();
    w.paste(BRAND);
    const r = runWith(w, { switches: ON });
    eq([sends(w), w.gmail.allDrafts().length, r.drafts, w.alertRows()[0].email_status], [0, 1, 1, 'drafted']);
    const lines = notes(w)[0].split('\n');
    eq(lines[1], '- Not sent automatically: the To line would be empty (no alert contacts on file for this product). Add ' +
      'the recipients in Gmail, then send it.');
    assert.ok(lines.some(l => /^- To: empty \(Brand has no alert contacts on file\)/.test(l)), lines.join('\n'));
    assert.match(switchNotes(w).autoSend.text, /^QA-1001 has no alert contacts on file, so it's a draft/);
    eq(memo(w, 'auto_sent'), null);
  });

  test('auto-send: a run out of time never starts a send; the next run sends it (once)', () => {
    const w = liveWorld();
    w.vertex.assess = () => { w.g.clock.now += 200 * 1000; return { checks: [] }; };  // a slow review uses up the run
    const msg = w.paste(F.P0_OK);
    const r = runWith(w, { switches: ON });
    eq([sends(w), w.gmail.allDrafts().length, w.alertRows()[0].email_status, r.auto_sent || 0], [0, 0, 'pending', 0]);
    eq(JSON.parse(memo(w, 'open_drafts')), ['QA-1001']);
    eq(w.chat.botReactions(msg.name), ['👍']);
    assert.ok(w.g.logs.some(l => /QA-1001 goes out on the next run \(auto-send\): this run is out of time/.test(l)));
    w.vertex.assess = () => ({ checks: [] });
    const r2 = runWith(w, { switches: ON });
    eq([r2.auto_sent, sends(w), w.gmail.allDrafts().length, w.alertRows()[0].email_status], [1, 1, 0, 'sent']);
    eq(w.chat.botReactions(msg.name), ['👍', '📦', '🌎']);
    runWith(w, { switches: ON });
    eq(sends(w), 1);
  });

  test('auto-send: nothing after the send can undo it or send it again (Gmail, Chat, the sheet, the memory and the other switches all failing); a memory that can\'t note it first means a draft, not a send', () => {
    const w = liveWorld();
    w.gmail.fail = (method, path) => (method === 'get' && /^threads\//.test(path)
      ? { code: 500, body: { error: { code: 500, message: 'Backend Error' } } } : null);
    w.chat.fail = (method, path) => (method === 'post' && /\/reactions$/.test(path)
      ? { code: 500, body: { error: { code: 500, message: 'Internal error' } } } : null);
    w.bot.ev('onEmailSent_ = function () { throw new Error("a switch broke"); }');
    const update = w.backend.updateAlert;
    w.backend.updateAlert = function (row, patch) {  // as the sheet does: the row in memory changes, the write throws
      update.call(this, row, patch);
      if (patch.email_status === 'sent') throw new Error('Service Spreadsheets failed while accessing document');
    };
    const base = w.ctx().memo;
    const memoFailing = { get: base.get, set: (k, v) => {
      if (k === 'auto_sent' && /"sent":true/.test(v)) throw new Error('Argument too large: value');
      return base.set(k, v);
    } };
    w.paste(F.P0_OK);
    const r = runWith(w, { switches: ON, memo: memoFailing });
    eq([sends(w), r.auto_sent, r.drafts, r.errors, w.gmail.allDrafts().length], [1, 1, 0, [], 0]);
    const [row] = w.alertRows();
    eq([row.email_status, row.email_message_id, row.email_sent_by], ['sent', '', 'bot']);
    ['reading its Message-ID', 'marking it sent', 'the after-send switches'].forEach(step =>
      assert.ok(w.g.logs.some(l => l.includes(`after auto-sending the Social Alert for QA-1001, ${step} failed`)), step));
    assert.ok(w.g.logs.some(l => /couldn't note that the Social Alert for QA-1001 was sent: Argument too large/.test(l)));
    // The sheet lost it, and the memory only says it was tried: retried, it's a draft with a warning, never a second send
    w.gmail.fail = null;
    w.chat.fail = null;
    w.backend.updateAlert = update;
    Object.assign(row, { email_status: 'pending' });
    base.set('open_drafts', JSON.stringify([row.alert_id]));
    runWith(w, { switches: ON });
    eq([sends(w), w.gmail.allDrafts().length, row.email_status], [1, 1, 'drafted']);
    assert.match(notes(w).pop(), /\n- The bot already tried to send this Social Alert itself .* can't tell whether it went out/);

    // The memory can't take the note before the send: no send at all, a draft that says why
    const v = liveWorld();
    const vBase = v.ctx().memo;
    const noNotes = { get: vBase.get, set: (k, val) => {
      if (k === 'auto_sent') throw new Error('You have exceeded the property storage quota');
      return vBase.set(k, val);
    } };
    v.paste(F.P0_OK);
    const rv = runWith(v, { switches: ON, memo: noNotes });
    eq([sends(v), v.gmail.allDrafts().length, rv.errors], [0, 1, []]);
    eq(notes(v)[0].split('\n')[1], '- Not sent automatically: the bot couldn\'t note the send first (You have exceeded the ' +
      'property storage quota), and a retry could then send it twice. Review and send it.');
  });

  test('auto-send: the bot\'s memory of its sends stays small (two days, at most 60 alerts) and a damaged one is read as empty', () => {
    const w = liveWorld();
    const c = w.ctx();
    const old = Array.from({ length: 70 }, (_, i) => ({ id: `QA-${i}`, at: w.g.clock.now - (i < 5 ? 3 * 86400e3 : 3600e3), sent: true }));
    c.memo.set('auto_sent', JSON.stringify(old));
    w.bot.noteAutoSend_(c, { id: 'QA-NEW', at: w.g.clock.now });
    const kept = JSON.parse(c.memo.get('auto_sent'));
    eq([kept.length, kept[kept.length - 1].id, kept.some(e => ['QA-0', 'QA-4'].includes(e.id))], [60, 'QA-NEW', false]);
    assert.ok(c.memo.get('auto_sent').length < 9000);
    w.bot.noteAutoSend_(c, { id: 'QA-NEW', at: w.g.clock.now, thread: 'th9', sent: true });  // the same alert: replaced
    eq(JSON.parse(c.memo.get('auto_sent')).filter(e => e.id === 'QA-NEW').map(e => e.thread), ['th9']);
    c.memo.set('auto_sent', '{not json');
    eq(plain(w.bot.autoSendLog_(c)), []);
    c.memo.set('auto_sent', '{"id": "QA-1"}');
    eq(plain(w.bot.autoSendLog_(c)), []);
  });

  test('auto-send ON, live: an alert missing what only Burson knows (its link) stays the draft it is with the switch OFF, for a person, saying why (nothing waits on Burson); a resend doesn\'t send it either', () => {
    const NW = Object.assign({ noWait: true }, ON);  // Never wait on Burson ON (Control row 23) too
    const off = liveWorld({ noWait: true });
    off.paste(F.NO_LINK);
    off.run();
    const w = liveWorld();
    const msg = w.paste(F.NO_LINK);
    const r = runWith(w, { switches: NW });
    eq([sends(w), r.auto_sent || 0, r.drafts, w.gmail.allDrafts().length, w.alertRows()[0].email_status, r.errors],
      [0, 0, 1, 1, 'drafted', []]);
    eq(w.gmail.allDrafts()[0].mime, off.gmail.allDrafts()[0].mime);
    const lines = notes(w)[0].split('\n');
    eq(lines[1], '- Not sent automatically: Burson\'s alert has a problem the bot can\'t fix itself: Link (missing). Fix it in Gmail, then send it.');
    eq(lines.filter((l, i) => i !== 1), notes(off)[0].split('\n'));
    assert.match(switchNotes(w).autoSend.text, /^QA-1001 lacks what only Burson knows \(Link\), so it's a draft \(Oct 14, /);
    eq([memo(w, 'auto_sent'), w.chat.botReactions(msg.name)], [null, ['👍']]);  // 👍: the draft waits on a person
    // Burson resends it with the link: analysts get the link under the alert, and the draft is still a person's to send
    w.paste(F.NO_LINK_RESENT);
    runWith(w, { switches: NW });
    runWith(w, { switches: NW });
    eq([sends(w), w.gmail.allDrafts().length, memo(w, 'auto_sent')], [0, 1, null]);
    assert.ok(notes(w).some(n => /^Burson resent this alert with updates:\n- Link: <https:\/\/x\.com\/WasSamLowryEsq\//.test(n)),
      notes(w).join('\n---\n'));
  });

  test('auto-send: a send Gmail reported as failed that went out anyway is found in Sent: the alert is marked sent by the bot on the thread it went to, with its emojis and the after-send steps, and the leftover draft is removed; never ❌', () => {
    const w = liveWorld();
    w.bot.__afterSend = [];
    w.bot.ev('onEmailSent_ = function (ctx, row, report) { __afterSend.push(row.alert_id + ":" + row.email_status); }');
    const restore = deliveredBut(w, 503);
    const msg = w.paste(F.P0_OK);
    const r = runWith(w, { switches: ON });
    restore();
    eq([sends(w), w.gmail.sentMessages().length, w.gmail.allDrafts().length, r.errors], [1, 1, 0, []]);
    const [sent] = w.gmail.sentMessages();
    const [row] = w.alertRows();
    eq([row.email_status, row.email_thread, row.email_message_id, row.email_sent_by],
      ['sent', sent.threadId, sent.messageId, 'bot']);
    assert.ok(row.email_input.auto_send_try > 0 && row.email_sent_at >= row.email_input.auto_send_try, JSON.stringify(row.email_input));
    eq(w.bot.__afterSend, ['QA-1001:sent']);
    eq(w.chat.botReactions(msg.name), ['👍', '📦', '🌎']);
    assert.ok(!String(row.mirrored).includes('❌'), row.mirrored);
    const [draftNote, found] = notes(w);
    eq(draftNote.split('\n')[1], '- The bot tried to send this Social Alert itself (Auto-send Social Alerts) and Gmail said: ' +
      `Gmail 503 on sending an email: Unavailable. It may have gone out anyway: ${CHECK_SENT}`);
    eq(found, 'Social Alert sent after all: the bot\'s own send went out in spite of Gmail\'s error (it\'s in Sent), so the ' +
      'bot marked the alert sent and removed the draft. Don\'t send it again.');
    assert.match(switchNotes(w).autoSend.text, /^QA-1001 went out after all \(found in Sent at Oct 14, /);
    // Later runs: nothing more is sent, searched or posted
    const searches = sentSearches(w).length;
    runWith(w, { switches: ON });
    runWith(w, { switches: ON });
    eq([sends(w), notes(w).length, sentSearches(w).length, w.bot.__afterSend.length, w.alertRows()[0].email_status],
      [1, 2, searches, 1, 'sent']);
  });

  test('auto-send: after a send that may have gone out, a person who checks Sent and deletes the draft gets the alert marked sent (not ❌ No action taken); only a send that really didn\'t go out is discarded', () => {
    const w = liveWorld();
    const restore = deliveredBut(w, 503);
    w.gmail.fail = (method, path) => (method === 'get' && path === 'messages'  // Gmail search is down for now
      ? { code: 500, body: { error: { code: 500, message: 'Backend Error' } } } : null);
    const msg = w.paste(F.P0_OK);
    runWith(w, { switches: ON });
    restore();
    eq([sends(w), w.gmail.allDrafts().length, w.alertRows()[0].email_status], [1, 1, 'drafted']);
    w.gmail.fail = null;
    // Half an hour on, the bot no longer looks in Sent while the draft is there
    w.g.clock.now += 31 * 60 * 1000;
    const searches = sentSearches(w).length;
    runWith(w, { switches: ON });
    eq([sentSearches(w).length, w.gmail.allDrafts().length, w.alertRows()[0].email_status], [searches, 1, 'drafted']);
    // A person sees it in Sent and deletes the draft: marked sent, by the bot, on the thread it went to
    w.gmail.discard(w.gmail.allDrafts()[0].id);
    runWith(w, { switches: ON });
    const [sent] = w.gmail.sentMessages();
    const [row] = w.alertRows();
    eq([row.email_status, row.email_thread, row.email_message_id, row.email_sent_by], ['sent', sent.threadId, sent.messageId, 'bot']);
    eq(w.chat.botReactions(msg.name), ['👍', '📦', '🌎']);
    assert.ok(!String(row.mirrored).includes('❌'), row.mirrored);
    assert.match(notes(w).pop(), /^Social Alert sent after all: the bot's own send went out in spite of Gmail's error \(it's in Sent\)\.$/);

    // Gmail refused it and it never went: deleting the draft is a skip, ❌ No action taken, as before; an email with the
    // same subject sent long after the bot's try (a person's, for another alert) isn't taken for it
    const v = liveWorld();
    v.gmail.fail = (method, path) => (method === 'post' && path === 'messages/send'
      ? { code: 500, body: { error: { code: 500, message: 'Backend Error' } } } : null);
    const vMsg = v.paste(F.P0_OK);
    runWith(v, { switches: ON });
    v.gmail.fail = null;
    eq([v.gmail.sentMessages().length, v.gmail.allDrafts().length], [0, 1]);
    const [vDraft] = v.gmail.allDrafts();
    v.g.clock.now += 3600e3;
    v.gmail.handle('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {  // an hour later, by a person
      method: 'post', payload: JSON.stringify({ raw: Buffer.from(vDraft.mime, 'utf8').toString('base64url') }) });
    v.gmail.discard(vDraft.id);
    runWith(v, { switches: ON });
    eq([v.alertRows()[0].email_status, v.chat.botReactions(vMsg.name)], ['discarded', ['👍', '❌']]);
    assert.ok(sentSearches(v).length >= 1);
  });

  test('auto-send ON: C11 says the bot sends the Social Alert itself only where it does (LIVE: runMode_); while Testing with no stand-in it says they stay drafts', () => {
    const c11 = (standIn, live) => B.switchStatusTexts_({ autoSend: true }, standIn, {}, NOW, live)[0];
    eq([c11('', true), c11('', undefined), c11('', false), c11('tester@testing.test', false), c11('tester@testing.test', true)], [
      '✓ ON: the bot sends the Social Alert email itself', '✓ ON: the bot sends the Social Alert email itself',
      '✓ ON (Testing: Social Alerts stay drafts)', '✓ ON (testing: sending only to the testers in B30)',
      '✓ ON (testing: sending only to the testers in B30)']);
    // only C11, the Relay (C22), Post in S-F Burson (C24) and the Safety valve (C29) say whether the run is LIVE
    const keys = B.ev('CONTROL_SWITCHES_').map(s => s.key);
    const byMode = ['autoSend', 'relay', 'postBurson', 'safetyValve'].map(k => keys.indexOf(k));
    const others = texts => texts.filter((_, i) => !byMode.includes(i));
    const all = Object.assign(B.switchesOff_(), {});
    Object.keys(all).forEach(k => { all[k] = true; });
    eq(others(B.switchStatusTexts_(all, '', {}, NOW, false)), others(B.switchStatusTexts_(all, '', {}, NOW, true)));
    eq(others(B.switchStatusTexts_({}, '', {}, NOW, false)), others(B.switchStatusTexts_({}, '', {}, NOW)));
    // poll(), with no stand-in in the YAML: the test feed (Testing), then the real Burson space
    const t = e2e();
    t.bot.setup();
    t.bot.ev('GEN').email.stand_in = '';
    t.control().getRange(11, 2).setValue('ON');
    t.poll();
    eq(t.control().cell(11, 3), '✓ ON (Testing: Social Alerts stay drafts)');
    t.set('B3', 'https://mail.google.com/chat/u/0/#chat/space/AAQAaa_0I9g');
    t.poll();
    // S-F Burson (B25) blank: the real space is never live (fail closed), so its Social Alerts stay drafts
    eq(t.control().cell(11, 3), '✓ ON (Testing: Social Alerts stay drafts)');
    t.set('B25', 'https://chat.google.com/room/AAQAaa_0I9g');  // B3 is S-F Burson, B26 blank, the Safety valve OFF: LIVE
    t.poll();
    eq([t.control().cell(11, 3), t.get('B5')], ['✓ ON: the bot sends the Social Alert email itself', '🔴 LIVE · ✅ Working']);
    t.control().getRange(29, 2).setValue('ON');  // the Safety valve: back to Testing on the next run
    t.poll();
    eq([t.control().cell(11, 3), t.get('B5')], ['✓ ON (Testing: Social Alerts stay drafts)', '✅ Working']);
  });

  test('auto-send ON from the Control tab while testing (poll()): the Social Alert still goes only to the stand-in, exactly as with it OFF', () => {
    const run = on => {
      const t = e2e();
      t.bot.setup();
      t.set('B30', 'tester@testing.test');
      if (on) t.control().getRange(11, 2).setValue('ON');
      t.chat.say(TEST_FEED, F.MISTAKES, { sender: 'users/bot' });
      t.poll();
      t.poll();
      return t;
    };
    const off = run(false);
    const on = run(true);
    const view = t => ({
      sent: t.g.gmail.sentMessages().map(m => [m.threadId, m.mime]), drafts: t.g.gmail.allDrafts().length,
      chat: [TEST_FEED, TRIAGED].map(s => t.chat.spaces.get(s).messages.map(m => [m.text, m.thread.name, m.reactions.map(r => r.emoji)])),
      log: t.sheet().getSheetByName('Alert log').rows,
    });
    eq(view(on), view(off));
    eq(on.g.gmail.sentMessages().map(m => m.to), [['tester@testing.test']]);
    eq([on.control().cell(11, 3), off.control().cell(11, 3).slice(0, 4)], ['✓ ON (testing: sending only to the testers in B30)', 'OFF ']);
    assert.ok(!on.g.props.has('SWITCH_NOTES') || !JSON.parse(on.g.props.get('SWITCH_NOTES')).autoSend);
  });
};
