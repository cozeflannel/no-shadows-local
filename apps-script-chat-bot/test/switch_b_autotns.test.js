// Auto-submit T&S form (Control tab row 12, Drafts.gs autoSubmitTns_, TnsForm.gs submitTnsForm_): when T&S should see an
// alert, the bot submits the T&S Intake Form itself instead of posting the pre-filled link: the test copy while testing,
// the real form only live (and only with TNS_LIVE_FORM_ID), plus the urgent email when it's urgent. OFF changes nothing;
// never twice for a post.
'use strict';

module.exports = H => {
  const { test, eq, assert, F, world, e2e, collectBurson, plain, decodeMime, REAL, TRIAGED } = H;
  const LIVE = { live: true, mailbox: 'im@ops.test', from: 'Brand Social <sender@alerts.test>' };
  const NOT_LIVE = { live: false, mailbox: 'im@ops.test', from: 'Brand Social <im@ops.test>' };
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  // The tester has a Chat DM with the bot's account, so the escalation-protocol message (F.PARIS is a P0) goes there as
  // a DM and each test here counts only its own emails (a tester Chat can't reach gets it by email: run_tests.js and
  // switch_testers.test.js test that)
  const standInWorld = () => {
    const w = world({ drafts: STAND_IN });
    w.chat.addDm(STAND_IN.standIn, 'spaces/DMSTANDIN');
    return w;
  };
  const ON = { autoTns: true };
  const PARIS_LINK = 'https://x.com/paris_tech_press/status/1845000000000000003';
  const AIO_LINK = 'https://x.com/TheChiefNerd/status/1845000000000000001';
  const URGENT_TNS = 'tns-urgent@alerts.test';
  const VETO = () => ({ checks: [], social_alert: { warranted: false, confidence: 0.95, reason: 'Google is only mentioned in passing' } });

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
  const zapier = (w, text) => w.paste(text);
  const forwards = w => w.analystPosts().filter(m => !m.threadReply);
  const notes = w => w.analystPosts().filter(m => m.threadReply).map(m => m.text);
  // Every form response the bot submitted: [form id, {question title: answer}]
  const responses = w => Array.from(w.g.forms.values()).reduce((all, f) => all.concat(f.responses.map(r => [f.id, r])), []);
  const tnsLog = w => JSON.parse(w.g.props.get('TNS_AUTO_LINKS') || '{}');
  const switchNote = w => (JSON.parse(w.g.props.get('SWITCH_NOTES') || '{}').autoTns || {}).text;
  const sentTo = w => w.gmail.sentMessages().map(m => [m.to, m.cc, m.bcc, m.subject]);
  const urgentMails = w => w.gmail.sentMessages().filter(m => /^(\[[^\]]+\] )?URGENT T&S: /.test(m.subject));
  // The real T&S form, as FormApp would open it by its editor id (TNS_LIVE_FORM_ID)
  const liveForm = w => {
    const f = w.g.services.FormApp.create('T&S Intake Form (the real one)');
    w.bot.ev('TNS_QUESTIONS_').forEach(q => {
      const item = q.choices ? (q.radio ? f.addMultipleChoiceItem() : f.addListItem()).setChoiceValues(q.choices)
        : (q.paragraph ? f.addParagraphTextItem() : f.addTextItem());
      item.setTitle(q.title).setRequired(!q.optional);
    });
    w.g.props.set('TNS_LIVE_FORM_ID', f.id);
    w.g.forms.calls.length = 0;
    return f;
  };
  // Everything a run leaves behind: Chat, Gmail, the Alert log, the bot's memory and script properties, the run log,
  // and every form (its responses) and FormApp call
  const snapshot = w => ({
    chat: [w.BUR, w.ANA].map(s => w.chat.spaces.get(s).messages.map(m => [m.name, m.text, m.thread.name, m.threadReply,
      m.clientAssignedMessageId || '', m.reactions.map(r => `${r.user} ${r.emoji}`)])),
    drafts: w.gmail.allDrafts().map(d => [d.id, d.threadId, d.mime]),
    sent: w.gmail.sentMessages().map(m => [m.id, m.threadId, m.mime]),
    gmail: w.gmail.calls.map(c => [c.method, c.path, c.query]),
    rows: plain(w.alertRows()),
    memo: ['open_drafts', 'tns_watch', 'lead_pings', 'auto_sent'].map(k => w.ctx().memo.get(k)),
    props: Array.from(w.g.props.entries()),
    logs: w.g.logs.slice(),
    forms: Array.from(w.g.forms.values()).map(f => [f.id, f.title, f.items.length, plain(f.responses)]),
    formCalls: w.g.forms.calls.slice(),
  });
  // T&S alerts down every path that posts the T&S form details: a Social Alert (P0, urgent), a T&S-only alert (Gemini
  // vetoed the email), the same post again, an alert with no T&S, and quiet runs
  const flow = (w, extra) => {
    zapier(w, F.PARIS);
    runWith(w, extra);
    w.vertex.assess = VETO;
    zapier(w, F.AIO);
    runWith(w, extra);
    w.g.clock.now += 3600e3;
    zapier(w, F.AIO.replace('Commenters are mocking', 'Many commenters are mocking'));
    runWith(w, extra);
    w.vertex.assess = () => ({ checks: [] });
    zapier(w, F.P0_OK);
    runWith(w, extra);
    runWith(w, extra);
  };

  test('auto-submit T&S OFF (or no switches, or anything but ON): every T&S note is today\'s link, nothing is submitted, emailed, noted or remembered', () => {
    [['testing (a stand-in)', () => standInWorld()], ['a test space, drafts', () => world({ drafts: NOT_LIVE })],
      ['live, real distros', () => liveWorld()]].forEach(([name, make]) => {
      const none = make();
      flow(none, {});
      const off = make();
      flow(off, { switches: Object.assign(off.bot.switchesOff_(), { autoTns: false }) });
      const offString = make();
      flow(offString, { switches: { autoTns: 'ON' } });  // only true turns it on
      eq(snapshot(off), snapshot(none), name);
      eq(snapshot(offString), snapshot(none), name);
      eq([responses(none), none.g.props.has('TNS_AUTO_LINKS'), switchNote(none), urgentMails(none).length], [[], false, undefined, 0], name);
      eq(none.g.forms.calls.filter(c => c[0] === 'openById'), [], name);  // the form is never opened to answer it
      const tns = notes(none).filter(n => /T&S form/.test(n));
      assert.ok(tns.length >= 3, name);
      assert.ok(tns.every(n => /T&S form needed \(/.test(n) && !/auto-submitted|already submitted|has been submitted/.test(n)), name);
      assert.ok(none.alertRows().every(r => !r.tns_submitted && !(r.email_input || {}).tns_auto), name);
      assert.ok(none.alertRows().some(r => r.decision === 'T&S form only (AI hallucination)'), name);
    });
  });

  test('auto-submit T&S ON while testing (a stand-in): the test copy gets the alert\'s answers, the email to the stand-in says T&S: Yes, the urgent email goes only to the testers in B30, the note says what was submitted, ✍️ goes on, and later runs do nothing more', () => {
    const w = standInWorld();
    const msg = zapier(w, F.PARIS);
    const r = runWith(w, { switches: ON });
    eq([r.tns_auto, r.tns_urgent, r.drafts_sent, r.errors], [1, 1, 1, []]);
    const bursonPosts = w.bursonPosts().length;  // the fix request (Burson's exposure tag), as with the switch OFF

    // The test copy (made in the tester's Drive), never the real form: one response, the pre-filled link's answers
    eq(responses(w), [['form1', {
      'Google Product:': 'Search', 'Topic Impacted:': 'Violence, Extremism & Hate', 'Link / URL(s) in question:': PARIS_LINK,
      'What\'s the Issue? ': 'A French journalist (@paris_tech_press; 95000 followers) in Paris, France posted a screenshot ' +
        'showing Google Search autocomplete suggesting violent queries related to ongoing protests in Paris. 340 engagements on X.',
      '[Title_Prefix] WD Intake Request': 'Marketing',
    }]]);
    eq(w.g.forms.get('form1').title, 'T&S Intake Form (test copy, only you)');
    assert.ok(w.g.forms.calls.every(c => c[0] === 'create' || c[1] === 'form1'), JSON.stringify(w.g.forms.calls));

    // Gmail: the urgent email, then the Social Alert (T&S: Yes, as the form is in), both only to the stand-in
    eq(sentTo(w).map(s => s.slice(0, 3)), [[['tester@testing.test'], [], []], [['tester@testing.test'], [], []]]);
    const [urgent, alert] = w.gmail.sentMessages();
    eq(urgent.subject, 'URGENT T&S: Search | Search Autocomplete Violent Suggestions in Paris | X');
    eq(urgent.text.split('\n'), [
      'Urgent (P0): we just submitted the T&S Intake Form (Marketing) for this post.', '',
      `Link: ${PARIS_LINK}`, 'Why T&S: viral KOF, AI hallucination',
      'Google Product: Search · Topic Impacted: Violence, Extremism & Hate',
      'What\'s the Issue? A French journalist (@paris_tech_press; 95000 followers) in Paris, France posted a screenshot ' +
        'showing Google Search autocomplete suggesting violent queries related to ongoing protests in Paris. 340 engagements on X.',
      '', 'Testing: this went only to the testers. Live it goes to tns-urgent@alerts.test.']);
    assert.ok(!/bot|analyst|Burson/i.test(urgent.text + urgent.subject), urgent.text);
    assert.match(alert.text, /\nT&S: Yes\n/);

    // The note under the forwarded alert, in place of the pre-filled link: what was submitted, and a link to it (the
    // response on the test copy's Responses tab)
    const SUBMISSION = 'https://docs.google.com/forms/d/form1/edit#response=resp1';
    eq(notes(w), [
      'The alert regarding viral KOF, AI hallucination has been submitted to T&S for review.\n' +
      '- Intake Request: Marketing\n' +
      '- Google Product: Search\n' +
      '- Topic Impacted: Violence, Extremism & Hate\n' +
      `- Link: <${PARIS_LINK}|Search Autocomplete Violent Suggestions in Paris>\n` +
      `- Submission: <${SUBMISSION}|View the submission (test copy)>`]);
    // ✍️ (Reported to T&S) on both posts, with the Social Alert's emojis; the row says so
    assert.ok(w.chat.botReactions(msg.name).includes('✍'));
    assert.ok(w.chat.botReactions(forwards(w)[0].name).includes('✍'));
    const [row] = w.alertRows();
    const mark = plain(row.email_input.tns_auto);
    eq([row.email_status, row.email_groups, row.tns_submitted > 0, row.email_input.tns_submitted, mark],
      ['sent', 'tns', true, true, { at: mark.at, form: 'test', s: 'sent', u: 'sent', t: urgent.threadId, r: SUBMISSION }]);
    assert.ok(mark.at > 0 && mark.at <= row.tns_submitted);
    eq(Object.keys(tnsLog(w)), ['test|x.com/status/1845000000000000003']);
    eq(plain(tnsLog(w)['test|x.com/status/1845000000000000003']),
      { at: mark.at, id: 'QA-1001', s: 'sent', u: 'sent', t: urgent.threadId });  // the link stays on the row only
    // The Results tab never takes either of the bot's emails (both have the post's link) for the IMs'
    eq(Array.from(w.bot.botEmailThreads_(w.alertRows())).sort(), [alert.threadId, urgent.threadId].sort());
    assert.match(switchNote(w), /^1 submitted today · last QA-1001 \(test copy\) at Oct 14, \d{1,2}:\d\d [AP]M EDT$/);
    eq(w.bot.switchStatusTexts_({ autoTns: true }, 'tester@testing.test', JSON.parse(w.g.props.get('SWITCH_NOTES')),
      w.g.clock.now)[1], `✓ ON (testing: submits the test copy of the form; the urgent email goes only to the testers in B30) · ${switchNote(w)}`);

    // Later runs (the T&S watch, the confirmation email arriving): nothing is submitted, sent or posted again
    w.gmail.receive('Issue [#TEST-1234567]: WD Intake Request (test copy)', `Link / URL(s) in question: ${PARIS_LINK}`, 'tester@testing.test');
    runWith(w, { switches: ON });
    runWith(w, { switches: ON });
    eq([responses(w).length, w.gmail.sentMessages().length, notes(w).length, w.bursonPosts().length], [1, 2, 1, bursonPosts]);
    eq(JSON.parse(w.ctx().memo.get('tns_watch')), []);
  });

  test('auto-submit T&S ON, a Gmail draft (a test space with the YAML\'s stand-in): the draft says T&S: Yes and its note has what was submitted in place of the link; ✍️ instead of 👍; the urgent email goes to the stand-in although this run\'s Gmail has no guard', () => {
    const off = world({ drafts: NOT_LIVE });
    off.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    const offMsg = zapier(off, F.AIO);
    off.run();
    const w = world({ drafts: NOT_LIVE });
    w.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    const msg = zapier(w, F.AIO);
    const r = runWith(w, { switches: ON });
    eq([r.tns_auto, r.tns_urgent, r.drafts, r.errors], [1, 1, 1, []]);
    const [draft] = w.gmail.allDrafts();
    const [offDraft] = off.gmail.allDrafts();
    assert.match(draft.text, /\nT&S: Yes\n/);
    eq(draft.text.replace('T&S: Yes', 'T&S: No'), offDraft.text);  // otherwise the very same email
    eq([draft.to, draft.cc], [offDraft.to, offDraft.cc]);
    eq(sentTo(w), [[['tester@testing.test'], [], [], 'URGENT T&S: AI Overviews (AIM, Web Guide) | AI Overviews Historical Treaty Date Error | X']]);
    // The draft's note: the same lines, the T&S form details replaced by what the bot did
    const offLines = notes(off)[0].split('\n');
    const lines = notes(w)[0].split('\n');
    const at = offLines.findIndex(l => /^T&S form needed/.test(l));
    eq(lines.slice(0, at), offLines.slice(0, at));
    eq(lines.slice(at), [
      'The alert regarding AI hallucination has been submitted to T&S for review.',
      '- Intake Request: Marketing',
      '- Google Product: Search (AI Overviews)',
      '- Topic Impacted: Information Quality',
      `- Link: <${AIO_LINK}|AI Overviews Historical Treaty Date Error>`,
      '- Submission: <https://docs.google.com/forms/d/form1/edit#response=resp1|View the submission (test copy)>']);
    eq(off.chat.botReactions(offMsg.name), ['👍']);  // a draft waits on a person
    eq(w.chat.botReactions(msg.name), ['✍']);        // T&S is in: actioned
    eq(responses(w).map(x => x[1]['Link / URL(s) in question:']), [AIO_LINK]);
  });

  test('auto-submit T&S ON, a T&S-only alert (no Social Alert): the Results tab still counts it, the note says what was submitted, ✍️ and no 👍; the same post an hour later is "already submitted" and ✍️, never submitted again', () => {
    const w = standInWorld();
    w.vertex.assess = VETO;
    const first = zapier(w, F.AIO);
    const r = runWith(w, { switches: ON });
    eq([r.tns_auto, r.drafts_sent, w.gmail.allDrafts().length], [1, 0, 0]);
    const [row] = w.alertRows();
    eq([row.email_status, row.decision, row.email_groups], [undefined, 'T&S form only (AI hallucination) · auto-submitted', 'tns']);
    assert.ok(w.bot.resultsFlowInfo_([row]).tns);  // "T&S forms the bot prepared"
    assert.match(notes(w)[0], /^The alert regarding AI hallucination has been submitted to T&S for review\.\n- Intake Request: Marketing\n/);
    eq(w.chat.botReactions(first.name), ['✍']);
    eq(sentTo(w).map(s => s[0]), [['tester@testing.test']]);  // the urgent email (HIGH engagement), to the stand-in

    w.g.clock.now += 3600e3;
    const again = zapier(w, F.AIO.replace('Commenters are mocking', 'Many commenters are mocking'));
    const r2 = runWith(w, { switches: ON });
    eq([r2.tns_auto || 0, responses(w).length, urgentMails(w).length], [0, 1, 1]);
    eq(notes(w)[1], 'The alert was already submitted to T&S for review (test copy): QA-1001, Oct 14, 8:00 AM EDT. ' +
      'Not submitted again.');
    const second = w.alertRows()[1];
    eq([second.decision, second.email_groups, second.tns_submitted], ['T&S form only (AI hallucination)', 'tns', undefined]);
    eq(w.chat.botReactions(again.name), ['✍']);
    runWith(w, { switches: ON });
    eq([responses(w).length, notes(w).length], [1, 2]);
  });

  test('auto-submit T&S, never twice: a Social Alert that fails after the form went in is retried (in the run, then the next) without submitting again; its note (posted once, when it goes) still says it was submitted, and the urgent email went once', () => {
    const w = standInWorld();
    let sends = 0;
    w.gmail.fail = (method, path) => (method === 'post' && path === 'messages/send' && [2, 3].includes(++sends)  // the Social Alert
      ? { code: 429, body: { error: { code: 429, message: 'Rate Limit Exceeded' } } } : null);
    zapier(w, F.PARIS);
    const r = runWith(w, { switches: ON });
    eq([r.tns_auto, w.alertRows()[0].email_status, w.alertRows()[0].email_attempts, notes(w), sends], [1, 'pending', 2, [], 3]);
    const r2 = runWith(w, { switches: ON });  // maintainDrafts_ retries the email
    eq([r2.tns_auto || 0, r2.errors, w.alertRows()[0].email_status, sends], [0, [], 'sent', 4]);
    eq([responses(w).length, urgentMails(w).length], [1, 1]);
    eq(notes(w).length, 1);
    assert.match(notes(w)[0], /^The alert regarding viral KOF, AI hallucination has been submitted to T&S for review\./);
    assert.match(w.gmail.sentMessages().pop().text, /\nT&S: Yes\n/);
    runWith(w, { switches: ON });
    eq([responses(w).length, w.gmail.sentMessages().length], [1, 2]);
  });

  test('auto-submit T&S ON from the Control tab (poll()), the Mirror and auto-correct spaces both on the same live post: the test copy is submitted once, the other space says it was already submitted, nothing touches the live Burson space, and C12 counts it', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.set('B25', REAL);  // S-F Burson: the live space both read
    t.control().getRange(29, 2).setValue('ON');  // the Safety valve: Testing (the test copy of the form), even with B26 blank
    const MIRROR = 'spaces/AAQAmirror1';
    const AC = 'spaces/AAQAautofx1';
    t.chat.addSpace(MIRROR, 'SLRR Zapier Training Mirror');
    t.chat.addSpace(AC, 'SLRR Auto-correct Test');
    t.g.clock.now += 3600e3;
    t.bot.startMirror('SLRR Zapier Training Mirror');
    t.bot.startAutoCorrect('SLRR Auto-correct Test');
    t.control().getRange(12, 2).setValue('ON');
    const live = t.chat.say(REAL, F.AIO, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();
    t.poll();
    eq(t.chat.botPosts(REAL), []);
    eq(t.chat.botReactions(live.name), []);
    const all = Array.from(t.g.forms.values()).reduce((a, f) => a.concat(f.responses.map(r => [f.id, r['Link / URL(s) in question:']])), []);
    eq(all, [['form1', AIO_LINK]]);
    const tnsNote = s => t.chat.botPosts(s).filter(m => m.threadReply).map(m => m.text).find(x => /T&S form|submitted to/.test(x));
    assert.match(tnsNote(MIRROR), /^The alert regarding AI hallucination has been submitted to T&S for review\./);
    assert.match(tnsNote(AC), /^The alert was already submitted to T&S for review \(test copy\): QA-\d+, /);
    // ✍️ in both test spaces, on their own copies
    [MIRROR, AC].forEach(s => assert.ok(t.chat.botReactions(t.chat.botPosts(s).filter(m => !m.threadReply)[0].name).includes('✍'), s));
    // The Alert log: tns_submitted on the space that submitted it only
    const log = t.sheet().getSheetByName('Alert log');
    const col = name => log.rows[0].indexOf(name);
    const rows = log.rows.slice(1).map(x => [/ \(auto-correct\)$/.test(String(x[col('space')])) ? 'ac' : 'mirror',
      Number(x[col('tns_submitted')]) > 0, JSON.parse(x[col('email_input')] || '{}').tns_auto || null]);
    eq(rows.map(x => [x[0], x[1], x[2] && x[2].s]), [['mirror', true, 'sent'], ['ac', false, null]]);
    // The urgent email once, to the stand-in only; every email only to the stand-in
    const sent = t.g.gmail.sentMessages();
    eq(sent.filter(m => /^URGENT T&S: /.test(m.subject)).length, 1);
    assert.ok(sent.every(m => m.to.length === 1 && m.to[0] === 'tester@testing.test' && !m.cc.length), JSON.stringify(sent.map(m => m.to)));
    assert.match(t.control().cell(12, 3), /^✓ ON \(testing: submits the test copy of the form; the urgent email goes only to the testers in B30\) · 1 submitted today · last QA-\d+ \(test copy\) at /);
    eq(t.chat.botPosts(TRIAGED).length, 1);  // only setup's hello
  });

  test('auto-submit T&S: a post a person already reported (an analyst\'s ✍️) isn\'t submitted again: the new alert\'s note says T&S already has it', () => {
    const w = standInWorld();
    w.vertex.assess = VETO;
    zapier(w, F.AIO);
    runWith(w, {});  // OFF: the link, for a person
    w.chat.addReaction(forwards(w)[0].name, '✍️');  // they submitted it
    runWith(w, {});
    eq(w.alertRows()[0].email_groups, 'tns');
    w.g.clock.now += 3600e3;
    const again = zapier(w, F.AIO.replace('Commenters are mocking', 'Many commenters are mocking'));
    const r = runWith(w, { switches: ON });
    eq([r.tns_auto || 0, responses(w), w.g.props.has('TNS_AUTO_LINKS')], [0, [], false]);
    eq(notes(w).pop().split('\n')[0], 'T&S already has this post (QA-1001 is marked ✍️), so the bot didn\'t submit the form again.');
    eq(w.chat.botReactions(again.name), ['✍']);
  });

  test('auto-submit T&S, the stand-in sandbox: with a stand-in anywhere, a Testing run (the Safety valve ON, or B26 set), the auto-correct space or a test space, it\'s the test copy, even with TNS_LIVE_FORM_ID set; the urgent email goes only to the testers in B30, or to nobody in a test space without one; the real form and trustsafety-urgent@ are never touched', () => {
    const testingRun = () => { const w = liveWorld(); w.bot.setRunLive_(false); return w; };  // runMode_ said Testing
    const cases = [
      ['the YAML\'s stand-in (the run is live)', () => { const w = world({ drafts: LIVE }); w.bot.setRunLive_(null); w.bot.ev('GEN').email.stand_in = 'tester@testing.test'; return w; }, {}, 'tester@testing.test'],
      ['the run\'s stand-in', () => world({ drafts: Object.assign({}, LIVE, { standIn: 'tester@testing.test' }) }), {}, 'tester@testing.test'],
      ['a Testing run (the Safety valve ON, or B26 set)', testingRun, {}, null],
      ['the auto-correct space', () => liveWorld(), { sourceReadOnly: true, changeNotes: true, flowTag: 'Auto-correct test' }, null],
      ['a test space', () => liveWorld({ drafts: NOT_LIVE }), {}, null],
    ];
    cases.forEach(([name, make, extra, standIn]) => {
      const w = make();
      const real = liveForm(w);
      zapier(w, F.PARIS);
      runWith(w, Object.assign({ switches: ON }, extra));
      eq(real.responses, [], name);
      eq(responses(w).map(x => x[0]), ['form2'], name);  // the test copy, made after the real one
      assert.ok(!w.g.forms.calls.some(c => c[0] === 'openById' && c[1] === real.id), name);
      const all = w.gmail.sentMessages().concat(w.gmail.allDrafts());
      assert.ok(all.every(m => !m.to.concat(m.cc, m.bcc).includes(URGENT_TNS)), name);
      eq(urgentMails(w).map(m => m.to), standIn ? [[standIn]] : [], name);
      const note = w.analystPosts().map(m => m.text).find(n => /has been submitted to T&S for review/.test(n)) || '';  // (the Mirror: top level)
      assert.ok(note.includes('The alert regarding viral KOF, AI hallucination has been submitted to T&S for review.'), `${name}: ${note}`);
      eq(Object.keys(tnsLog(w)), ['test|x.com/status/1845000000000000003'], name);
    });
    // Which form a run uses
    const w = liveWorld();
    const form = extra => w.bot.tnsAutoForm_(Object.assign({ drafts: { live: true, standIn: '' } }, extra));
    eq([form({}), form({ drafts: { live: false, standIn: '' } }), form({ drafts: { live: true, standIn: 'tester@testing.test' } }),
      form({ outboundBlocked: true }), form({ sourceReadOnly: true }), form({ drafts: undefined })],
    ['live', 'test', 'test', 'live', 'test', 'test']);  // the Mirror space: the real form when the run is LIVE
    w.bot.setRunLive_(null);
    w.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    eq(form({}), 'test');  // no run said LIVE: fails closed to Testing
    w.bot.ev('GEN').email.stand_in = '';
    w.bot.setRunLive_(true);
    eq([form({}), form({ outboundBlocked: true }), form({ sourceReadOnly: true })], ['live', 'live', 'test']);
    w.bot.setRunLive_(false);  // the Safety valve ON, or B26 set
    eq([form({}), form({ outboundBlocked: true })], ['test', 'test']);
  });

  test('auto-submit T&S live (real Burson space, no stand-in anywhere): without TNS_LIVE_FORM_ID the note is exactly today\'s link to the real form and C12 says why; with it the real form gets the answers once, trustsafety-urgent@ the urgent email, and the draft says T&S: Yes', () => {
    const NW = Object.assign({ noWait: true }, ON);  // Never wait on Burson ON (Control row 23) too
    const off = liveWorld({ noWait: true });
    zapier(off, F.PARIS);
    off.run();
    const noId = liveWorld();
    zapier(noId, F.PARIS);
    const r0 = runWith(noId, { switches: NW });
    eq([r0.tns_auto || 0, responses(noId), noId.g.forms.size, urgentMails(noId)], [0, [], 0, []]);
    eq(notes(noId), notes(off));  // the real form's pre-filled link, for a person
    assert.match(notes(noId)[0], /<https:\/\/docs\.google\.com\/forms\/d\/e\/1FAIpQLScd0be[^|]+\|Open the T&S Intake Form, pre-filled>/);
    eq(switchNote(noId), 'live form id not set (script property TNS_LIVE_FORM_ID): posting the link instead');
    eq(plain(tnsLog(noId)['live|x.com/status/1845000000000000003']).w, 'no live form id');
    runWith(noId, { switches: NW });
    eq(responses(noId), []);

    const w = liveWorld();
    const real = liveForm(w);
    const msg = zapier(w, F.PARIS);
    const r = runWith(w, { switches: NW });
    eq([r.tns_auto, r.tns_urgent, r.drafts, r.errors], [1, 1, 1, []]);
    eq(real.responses.map(x => [x['Link / URL(s) in question:'], x['[Title_Prefix] WD Intake Request'], x['Google Product:']]),
      [[PARIS_LINK, 'Marketing', 'Search']]);
    eq(w.g.forms.size, 1);  // no test copy live
    eq(sentTo(w), [[[URGENT_TNS], [], [], 'URGENT T&S: Search | Search Autocomplete Violent Suggestions in Paris | X']]);
    const urgent = urgentMails(w)[0];
    assert.ok(!/Testing/.test(urgent.text));
    // It's from brand-social-sends@ with the post's link, as the IMs' email would be: the Results tab skips it
    const own = w.bot.botEmailThreads_(w.alertRows());
    assert.ok(own.has(urgent.threadId));
    const hit = { id: urgent.id, threadId: urgent.threadId, at: w.g.clock.now, subject: urgent.subject };
    const post = { key: w.bot.postKey_(PARIS_LINK), burson_at: w.g.clock.now - 3600e3, im_draft: null };
    const gmailHits = { messageSummaries: () => [hit] };
    eq([w.bot.speedFindImEmail_(post, gmailHits, 'sender@alerts.test', own),
      w.bot.speedFindImEmail_(post, gmailHits, 'sender@alerts.test', new Set()) === hit], [null, true]);
    const [draft] = w.gmail.allDrafts();
    assert.match(draft.text, /\nT&S: Yes\n/);
    assert.ok(!draft.to.concat(draft.cc, draft.bcc).includes(URGENT_TNS));
    const lines = notes(w)[0].split('\n');
    assert.ok(lines.includes('The alert regarding viral KOF, AI hallucination has been submitted to T&S for review.'), lines.join('\n'));
    assert.ok(lines.includes('- Intake Request: Marketing'), lines.join('\n'));
    assert.ok(lines.includes('- Google Product: Search'), lines.join('\n'));
    assert.ok(lines.includes('- Topic Impacted: Violence, Extremism & Hate'), lines.join('\n'));
    assert.ok(lines.includes(`- Link: <${PARIS_LINK}|Search Autocomplete Violent Suggestions in Paris>`), lines.join('\n'));
    assert.ok(!lines.some(l => /test copy|Testing|pre-filled/.test(l)), lines.join('\n'));
    eq(w.chat.botReactions(msg.name), ['✍']);  // no ⬇️ (Burson's exposure tag was fixed and told, nothing waited for); no 👍 (T&S is in)
    assert.match(switchNote(w), /^1 submitted today · last QA-1001 at Oct 14, /);
    runWith(w, { switches: NW });
    eq([real.responses.length, urgentMails(w).length], [1, 1]);

    // With Auto-send Social Alerts ON too: the email that goes out says T&S: Yes, and its note says the form went in
    const both = liveWorld();
    liveForm(both);
    zapier(both, F.PARIS);
    runWith(both, { switches: { autoSend: true, autoTns: true, noWait: true } });
    const social = both.gmail.sentMessages().filter(m => !/^URGENT/.test(m.subject));
    eq([social.length, both.gmail.allDrafts().length, urgentMails(both).map(m => m.to)], [1, 0, [[URGENT_TNS]]]);
    assert.match(social[0].text, /\nT&S: Yes\n/);
    const note = notes(both)[0];
    assert.match(note, /^Social Alert sent: the bot sent it itself/);
    assert.match(note, /\nThe alert regarding viral KOF, AI hallucination has been submitted to T&S for review\./);
  });

  test('auto-submit T&S: no link, no submit (the link is a required question): the note is today\'s', () => {
    const noLink = F.AIO.replace(`[Link]: ${AIO_LINK}\n`, '');
    const off = standInWorld();
    off.vertex.assess = VETO;
    zapier(off, noLink);
    off.run();
    const w = standInWorld();
    w.vertex.assess = VETO;
    zapier(w, noLink);
    runWith(w, { switches: ON });
    eq([responses(w), w.g.props.has('TNS_AUTO_LINKS'), notes(w)], [[], false, notes(off)]);
    const c = w.ctx();
    c.switches = ON;
    eq(w.bot.autoSubmitTns_(c, { alert_id: 'QA-9' }, { fields: { issue_name: 'x' }, ai_reasons: { tns: 'AI hallucination' } }, {}), '');
    eq(w.g.forms.calls.filter(x => x[0] === 'openById'), []);
  });

  test('auto-submit T&S, time guard: an alert reviewed over a minute past the run\'s time budget is never submitted (its note has the link and says why), and no later run submits it', () => {
    const w = standInWorld();
    w.vertex.assess = () => { w.g.clock.now += 250 * 1000; return { checks: [] }; };  // a slow review uses up the run
    zapier(w, F.PARIS);
    runWith(w, { switches: ON });
    eq([responses(w), urgentMails(w)], [[], []]);
    const [note] = notes(w);
    assert.match(note, /^Not submitted automatically: the run was out of time\. Please submit it with the link below\.\nT&S form needed \(viral KOF, AI hallucination\): <https:\/\/docs\.google\.com\/forms\/d\/e\/pub-form1\//);
    eq(plain(tnsLog(w)['test|x.com/status/1845000000000000003']).w, 'late');
    assert.match(switchNote(w), /^QA-1001 came past the run's time budget at Oct 14, .*: its note has the link$/);
    w.vertex.assess = () => ({ checks: [] });
    runWith(w, { switches: ON });
    eq(responses(w), []);
  });

  test('auto-submit T&S, failures: the form refuses the answers -> the link and why, no ✍️ and no urgent email, never tried again; the test copy can\'t be made -> today\'s note; the urgent email fails -> the form is in, and the note says a person must send it; none of it reaches the run', () => {
    // The form refuses (a T&S-only alert)
    const w = standInWorld();
    w.vertex.assess = VETO;
    w.bot.tnsTestForm_();  // the test copy, made ahead
    w.g.forms.get('form1').failSubmit = 'Forms is temporarily unavailable';
    const msg = zapier(w, F.AIO);
    const r = runWith(w, { switches: ON });
    eq([r.errors, r.tns_auto || 0, responses(w), w.gmail.sentMessages()], [[], 0, [], []]);
    const [note] = notes(w);
    assert.match(note, /^The bot couldn't submit the T&S form itself \(Forms is temporarily unavailable\): please submit it with the link below\.\nT&S form needed \(AI hallucination\): </);
    eq(w.chat.botReactions(msg.name), ['👍']);  // waiting on a person, as with the switch OFF
    eq([w.alertRows()[0].decision, w.alertRows()[0].tns_submitted], ['T&S form only (AI hallucination)', undefined]);
    eq(plain(tnsLog(w)['test|x.com/status/1845000000000000001']).s, 'failed');
    assert.match(switchNote(w), /^couldn't submit the form for QA-1001 at .*: its note has the link$/);
    w.g.forms.get('form1').failSubmit = null;  // Forms is back: still never tried again
    runWith(w, { switches: ON });
    w.g.clock.now += 3600e3;
    zapier(w, F.AIO.replace('Commenters are mocking', 'Many commenters are mocking'));
    runWith(w, { switches: ON });
    eq([responses(w), notes(w).length], [[], 2]);
    assert.match(notes(w).pop(), /^The bot didn't submit the T&S form for this post with QA-1001 \(it couldn't confirm it went in\): if nobody has submitted it, please submit it with the link below\.\nT&S form needed/);

    // The test copy can't be made: the note is as with the switch OFF (it says how to set it up)
    const off = standInWorld();
    off.g.forms.fail = 'You do not have permission to call FormApp.create';
    zapier(off, F.PARIS);
    off.run();
    const v = standInWorld();
    v.g.forms.fail = 'You do not have permission to call FormApp.create';
    zapier(v, F.PARIS);
    const rv = runWith(v, { switches: ON });
    eq([rv.errors, responses(v), notes(v)], [[], [], notes(off)]);
    assert.match(notes(v)[0], /The test copy of the T&S form isn't set up yet: run setupTnsTestForm\(\)/);
    eq(switchNote(v), 'the test copy of the form isn\'t set up (run setupTnsTestForm()): posting the link instead');

    // The urgent email fails: the form is in (✍️), the note says the email still has to be sent
    const u = standInWorld();
    u.gmail.fail = (method, path, query, body) => (method === 'post' && path === 'messages/send' &&
      /^URGENT/.test(decodeMime(body.raw).subject) ? { code: 500, body: { error: { code: 500, message: 'Backend Error' } } } : null);
    const umsg = zapier(u, F.PARIS);
    const ru = runWith(u, { switches: ON });
    eq([ru.errors, ru.tns_auto, ru.tns_urgent || 0, responses(u).length, urgentMails(u).length], [[], 1, 0, 1, 0]);
    assert.ok(u.chat.botReactions(umsg.name).includes('✍'));
    assert.match(notes(u)[0], /\n- Urgent \(P0\): the bot couldn't send the urgent email \(Gmail 500 on sending an email: Backend Error\): live, a person would email tns-urgent@alerts\.test with the link \(not while testing\)\.$/);
    eq(plain(tnsLog(u)['test|x.com/status/1845000000000000003']).u, 'failed');
    runWith(u, { switches: ON });
    eq(u.gmail.calls.filter(c => c.path === 'messages/send').length, 2);  // the urgent email (failed) and the Social Alert, once each
  });

  test('auto-submit T&S, never twice when the memory fails: without the script property the Alert log row still stops a second alert on the post; with neither, nothing is submitted (the note has the link); a broken store never stops the run', () => {
    const blockProp = w => {
      const props = w.g.services.PropertiesService.getScriptProperties;
      w.g.services.PropertiesService.getScriptProperties = () => {
        const p = props();
        return Object.assign({}, p, { setProperty(k, v) {
          if (k === 'TNS_AUTO_LINKS') throw new Error('You have exceeded the property storage quota');
          return p.setProperty(k, v);
        } });
      };
    };
    const w = standInWorld();
    w.vertex.assess = VETO;
    blockProp(w);
    zapier(w, F.AIO);
    const r = runWith(w, { switches: ON });
    eq([r.errors, r.tns_auto, w.g.props.has('TNS_AUTO_LINKS')], [[], 1, false]);
    assert.ok(w.g.logs.some(l => /couldn't note the T&S form for QA-1001: You have exceeded the property storage quota/.test(l)));
    w.g.clock.now += 3600e3;
    const wUpdate = w.backend.updateAlert;  // and the sheet can't take the second alert's ✍️ either: still "already submitted"
    w.backend.updateAlert = function (row, patch) {
      if (patch.email_groups && row.alert_id === 'QA-1002') throw new Error('Service Spreadsheets failed while accessing document');
      return wUpdate.call(this, row, patch);
    };
    zapier(w, F.AIO.replace('Commenters are mocking', 'Many commenters are mocking'));
    const r2 = runWith(w, { switches: ON });
    eq([r2.errors, responses(w).length], [[], 1]);
    assert.match(notes(w).pop(), /^The alert was already submitted to T&S for review \(test copy\): QA-1001, /);
    assert.ok(w.g.logs.some(l => /couldn't mark ✍️ on QA-1002: Service Spreadsheets failed/.test(l)));
    w.backend.updateAlert = wUpdate;

    // Neither the property nor the sheet can take the note: not submitted
    const v = standInWorld();
    v.vertex.assess = VETO;
    blockProp(v);
    const update = v.backend.updateAlert;
    v.backend.updateAlert = function (row, patch) {
      if (patch.email_input && patch.email_input.tns_auto) throw new Error('Service Spreadsheets failed while accessing document');
      return update.call(this, row, patch);
    };
    zapier(v, F.AIO);
    const rv = runWith(v, { switches: ON });
    eq([rv.errors, responses(v)], [[], []]);
    assert.match(notes(v)[0], /^Not submitted automatically: the bot couldn't note it first, and a retry could then submit it twice\. Please submit it with the link below\.\nT&S form needed/);

    // The store throws while the post is looked up: the note as with the switch OFF, and the run goes on
    const s = standInWorld();
    s.vertex.assess = VETO;
    zapier(s, F.AIO);
    const c = s.ctx();
    c.switches = ON;
    const store = c.store;
    store.rowsForRecord = () => { throw new Error('Service Spreadsheets timed out'); };
    Object.defineProperty(c, 'store', { value: store });
    s.g.clock.now += 1000;
    const rs = s.bot.runOnce_(c);
    eq([rs.errors, responses(s)], [[], []]);
    assert.match(notes(s)[0], /^T&S form needed \(AI hallucination\)/);
    assert.ok(s.g.logs.some(l => /Auto-submit T&S form left QA-1001 to a person: Service Spreadsheets timed out/.test(l)));

    // An email input that can't be read: '' (the note as with the switch OFF), never an exception
    const bad = { ai_reasons: { tns: 'AI hallucination' } };
    Object.defineProperty(bad, 'fields', { get() { throw new Error('a damaged cell'); } });
    const cb = s.ctx();
    cb.switches = ON;
    eq(s.bot.autoSubmitTns_(cb, { alert_id: 'QA-77' }, bad, {}), '');
  });

  test('auto-submit T&S, going live: a post the bot only sent to the test copy (testing on the real Burson space) gets the real form and trustsafety-urgent@ when it comes again after go-live; a person\'s ✍️ still counts for both', () => {
    const w = world({ drafts: LIVE });  // the YAML's stand-in: testing, the test copy
    w.bot.setRunLive_(null);
    w.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    w.vertex.assess = VETO;
    zapier(w, F.AIO);
    runWith(w, { switches: ON });
    w.g.clock.now += 3600e3;
    zapier(w, F.AIO.replace('Commenters are mocking', 'Many commenters are mocking'));
    runWith(w, { switches: ON });  // "already submitted": \u270d\ufe0f on QA-1002 too
    eq(responses(w).map(x => x[0]), ['form1']);
    eq(w.alertRows().map(r => [r.email_groups, (r.email_input || {}).tns_by]), [['tns', 'test'], ['tns', 'test']]);
    // Go live: the stand-in cleared, the real form's id set; the same post a day later
    w.bot.ev('GEN').email.stand_in = '';
    w.bot.setRunLive_(true);
    const real = liveForm(w);
    w.g.clock.now += 86400e3;
    zapier(w, F.AIO.replace('Commenters are mocking', 'Commenters keep mocking'));
    const r = runWith(w, { switches: ON });
    eq([r.errors, r.tns_auto, real.responses.map(x => x['Link / URL(s) in question:'])], [[], 1, [AIO_LINK]]);
    eq(urgentMails(w).map(m => m.to), [['tester@testing.test'], [URGENT_TNS]]);
    assert.match(notes(w).pop(), /^The alert regarding AI hallucination has been submitted to T&S for review\.\n- Intake Request: Marketing\n/);
    const third = w.alertRows()[2];
    eq([plain(third.email_input.tns_auto).form, third.tns_submitted > 0, third.email_input.tns_by], ['live', true, 'live']);
    runWith(w, { switches: ON });
    eq([real.responses.length, urgentMails(w).length], [1, 2]);

    // A person's ✍️ (while testing) counts for the real form too: not submitted again after go-live
    const p = world({ drafts: LIVE });
    p.vertex.assess = VETO;
    zapier(p, F.AIO);
    runWith(p, {});  // OFF: the link, for a person
    p.chat.addReaction(forwards(p)[0].name, '✍️');
    runWith(p, {});
    p.bot.ev('GEN').email.stand_in = '';
    const realP = liveForm(p);
    p.g.clock.now += 3600e3;
    zapier(p, F.AIO.replace('Commenters are mocking', 'Many commenters are mocking'));
    runWith(p, { switches: ON });
    eq(realP.responses, []);
    assert.match(notes(p).pop(), /^T&S already has this post \(QA-1001 is marked ✍️\), so the bot didn't submit the form again\./);
  });

  test('auto-submit T&S, a post that turns urgent after its form went in (or after a person\'s ✍️): no second form, and the new alert\'s note says the urgent email is still to be sent, live and while testing', () => {
    const MODERATE = F.AIO.replace('[Engagement]: HIGH (29425 engagements)', '[Engagement]: MODERATE (1500 engagements)')
      .replace(',29425,', ',1500,');
    const HIGH_AGAIN = F.AIO.replace('Commenters are mocking', 'Many commenters are mocking');
    const LINE = '- Urgent (HIGH engagement): the bot didn\'t send the urgent email for this post. ';
    const LIVE_LINE = `${LINE}If nobody has, please email ${URGENT_TNS} with the link: <${AIO_LINK}|AI Overviews Historical Treaty Date Error>`;
    const TEST_LINE = `${LINE}Live, a person would email ${URGENT_TNS} with the link (not while testing).`;
    [['live', () => { const x = liveWorld(); liveForm(x); return x; }, LIVE_LINE],
      ['testing', () => standInWorld(), TEST_LINE]].forEach(([name, make, line]) => {
      const w = make();
      w.vertex.assess = VETO;
      zapier(w, MODERATE);
      runWith(w, { switches: ON });
      eq([responses(w).length, urgentMails(w).length], [1, 0], name);
      assert.ok(!/Urgent/.test(notes(w)[0]), `${name}: ${notes(w)[0]}`);
      w.g.clock.now += 3600e3;
      zapier(w, HIGH_AGAIN);
      runWith(w, { switches: ON });
      eq([responses(w).length, urgentMails(w).length], [1, 0], name);
      const lines = notes(w)[1].split('\n');
      assert.match(lines[0], /^The alert was already submitted to T&S for review/, name);
      eq(lines.slice(1), [line], name);
    });
    // A person's ✍️, then the post turns urgent
    const w = standInWorld();
    w.vertex.assess = VETO;
    zapier(w, MODERATE);
    runWith(w, {});  // OFF: the link, for a person
    w.chat.addReaction(forwards(w)[0].name, '✍️');
    runWith(w, {});
    w.g.clock.now += 3600e3;
    zapier(w, HIGH_AGAIN);
    runWith(w, { switches: ON });
    eq([responses(w), urgentMails(w)], [[], []]);
    eq(notes(w).pop().split('\n'), ['T&S already has this post (QA-1001 is marked ✍️), so the bot didn\'t submit the form again.',
      TEST_LINE]);
  });

  test('auto-submit T&S: when the script property can\'t take the "sent" after the form went in, the Alert log row still says so: the next alert on the post gets "already submitted", not the link', () => {
    const w = standInWorld();
    w.vertex.assess = VETO;
    const props = w.g.services.PropertiesService.getScriptProperties;
    w.g.services.PropertiesService.getScriptProperties = () => {
      const p = props();
      return Object.assign({}, p, { setProperty(k, v) {
        if (k === 'TNS_AUTO_LINKS' && /"s":"sent"/.test(v)) throw new Error('Service invoked too many times');
        return p.setProperty(k, v);
      } });
    };
    zapier(w, F.AIO);
    const r = runWith(w, { switches: ON });
    eq([r.errors, r.tns_auto, plain(tnsLog(w)['test|x.com/status/1845000000000000001']).s, w.alertRows()[0].email_input.tns_auto.s],
      [[], 1, 'trying', 'sent']);
    w.g.clock.now += 3600e3;
    zapier(w, F.AIO.replace('Commenters are mocking', 'Many commenters are mocking'));
    runWith(w, { switches: ON });
    eq(responses(w).length, 1);
    eq(notes(w)[1], 'The alert was already submitted to T&S for review (test copy): QA-1001, Oct 14, 8:00 AM EDT. ' +
      'Not submitted again.');
    // The alert itself, looked at again: its own row says it went in
    const c = w.ctx();
    const done = w.bot.tnsAutoDecided_(c, c.store.alerts[0], 'x.com/status/1845000000000000001',
      'test|x.com/status/1845000000000000001', 'test');
    eq([done.own, done.entry.s, done.entry.id], [true, 'sent', 'QA-1001']);
  });

  test('auto-submit T&S turned OFF between the submit and the email\'s retry: the note still says the bot submitted it (never asks a person to submit it again); a Social Alert that fails for good still gets the T&S note, and the Results tab counts it', () => {
    const failSends = (w, which) => {
      let sends = 0;
      w.gmail.fail = (method, path) => (method === 'post' && path === 'messages/send' && which(++sends)  // the Social Alert
        ? { code: 429, body: { error: { code: 429, message: 'Rate Limit Exceeded' } } } : null);
    };
    const w = standInWorld();
    failSends(w, n => [2, 3].includes(n));
    zapier(w, F.PARIS);
    runWith(w, { switches: ON });
    eq([responses(w).length, w.alertRows()[0].email_status, notes(w)], [1, 'pending', []]);
    runWith(w, { switches: { autoTns: false } });  // turned OFF: maintainDrafts_ retries the email
    eq([w.alertRows()[0].email_status, responses(w).length, urgentMails(w).length], ['sent', 1, 1]);
    eq(notes(w).length, 1);
    assert.match(notes(w)[0], /^The alert regarding viral KOF, AI hallucination has been submitted to T&S for review\./);
    assert.ok(!/T&S form needed|Submit/.test(notes(w)[0]), notes(w)[0]);

    // The Social Alert fails for good (3 tries): the T&S note is still posted, once; the Results tab counts the form
    const off = standInWorld();
    failSends(off, n => n >= 1);
    zapier(off, F.PARIS);
    runWith(off, {});
    runWith(off, {});
    eq([off.alertRows()[0].email_status, notes(off)], ['failed', []]);  // OFF: as before
    const f = standInWorld();
    failSends(f, n => n >= 2);
    zapier(f, F.PARIS);
    runWith(f, { switches: ON });
    runWith(f, { switches: ON });
    runWith(f, { switches: ON });
    const [row] = f.alertRows();
    eq([row.email_status, row.email_attempts, responses(f).length, urgentMails(f).length], ['failed', 3, 1, 1]);
    eq(notes(f).length, 1);
    assert.match(notes(f)[0], /^The alert regarding viral KOF, AI hallucination has been submitted to T&S for review\./);
    assert.ok(f.bot.resultsFlowInfo_([row]).tns);
    assert.ok(!off.bot.resultsFlowInfo_([off.alertRows()[0]]).tns);
  });

  test('auto-submit T&S: the record of posts stays small (30 days, at most 50) and a damaged one reads as empty; submitTnsForm_ answers by question title and submits nothing when a question it must answer is missing', () => {
    const w = world();
    const now = w.g.clock.now;
    const old = {};
    for (let i = 0; i < 70; i++) old[`test|x.com/status/${i}`] = { at: now - (i < 5 ? 31 * 86400e3 : (70 - i) * 60e3), id: `QA-${i}`, s: 'sent' };
    w.g.props.set('TNS_AUTO_LINKS', JSON.stringify(old));
    w.bot.noteTnsAuto_('test|x.com/status/new', { at: now, id: 'QA-NEW', s: 'trying' }, now);
    const kept = tnsLog(w);
    eq([Object.keys(kept).length, Object.keys(kept).pop(), ['0', '4', '5', '19'].some(i => kept[`test|x.com/status/${i}`])],
      [50, 'test|x.com/status/new', false]);
    assert.ok(w.g.props.get('TNS_AUTO_LINKS').length < 9000);
    // Long links: the oldest go first, so it always fits in one property (the newest is kept)
    const long = i => `test|news.example.com/${'a-very-long-article-path/'.repeat(12)}${i}`;
    for (let i = 0; i < 40; i++) w.bot.noteTnsAuto_(long(i), { at: now + i, id: `QA-L${i}`, s: 'failed', w: 'x'.repeat(120) }, now + i);
    const big = w.g.props.get('TNS_AUTO_LINKS');
    assert.ok(big.length <= 8000 && Object.keys(JSON.parse(big)).length > 10, String(big.length));
    eq(Object.keys(JSON.parse(big)).pop(), long(39));
    w.g.props.set('TNS_AUTO_LINKS', '{not json');
    eq(plain(w.bot.tnsAutoLog_()), {});
    w.g.props.set('TNS_AUTO_LINKS', '["x"]');
    eq(plain(w.bot.tnsAutoLog_()), {});

    // The form's questions in another order, with a question the bot doesn't know: answered by title
    const f = w.g.services.FormApp.create('T&S Intake Form');
    const Q = w.bot.ev('TNS_QUESTIONS_');
    f.addTextItem().setTitle('Something new?');
    Q.slice().reverse().forEach(q => {
      const item = q.choices ? (q.radio ? f.addMultipleChoiceItem() : f.addListItem()).setChoiceValues(q.choices)
        : (q.paragraph ? f.addParagraphTextItem() : f.addTextItem());
      item.setTitle(q.title.trim()).setRequired(!q.optional);
    });
    const v = { team: 'Marketing', product: 'Search', topic: 'Information Quality', url: AIO_LINK, issue: 'A wrong date.', notes: '' };
    w.bot.submitTnsForm_(f.id, v);
    eq(plain(f.responses), [{ '[Title_Prefix] WD Intake Request': 'Marketing', 'What\'s the Issue?': 'A wrong date.',
      'Link / URL(s) in question:': AIO_LINK, 'Topic Impacted:': 'Information Quality', 'Google Product:': 'Search' }]);
    // A form without "Topic Impacted:" (T&S changed it): nothing is submitted
    const g = w.g.services.FormApp.create('T&S Intake Form, changed');
    Q.filter(q => q.key !== 'topic').forEach(q => {
      const item = q.choices ? (q.radio ? g.addMultipleChoiceItem() : g.addListItem()).setChoiceValues(q.choices)
        : (q.paragraph ? g.addParagraphTextItem() : g.addTextItem());
      item.setTitle(q.title);
    });
    assert.throws(() => w.bot.submitTnsForm_(g.id, v), /no answer for "Topic Impacted:" on the form, so it wasn't submitted/);
    eq(g.responses, []);
    // A choice the form doesn't have: Forms refuses it, nothing is submitted
    assert.throws(() => w.bot.submitTnsForm_(f.id, Object.assign({}, v, { topic: 'Not a topic' })), /Invalid response/);
    eq(f.responses.length, 1);
    // The urgent reason (the test the note's "Urgent" line has always used)
    const urgent = (fields, esc, ai) => w.bot.tnsUrgent_({ fields, escalation: esc || {}, ai_reasons: ai || {} });
    eq([urgent({}, { priority: 'P0' }), urgent({ engagement_level: 'High' }), urgent({ engagement_level: 'VIRAL KOF' }),
      urgent({}, { ts_reasons: ['child safety'] }), urgent({ engagement_level: 'LOW' }, { priority: 'P1' }, { tns: 'AI hallucination' })],
    ['P0', 'HIGH engagement', 'VIRAL KOF engagement', 'child safety', '']);
  });
};
