// "Track post-alert outcomes" (Control tab row 21, Outcomes.gs): for a week after a Social Alert is sent, the bot reads
// the replies on its email thread and the T&S confirmation, writes the outcome in the Alert log (Resolved, T&S confirmed,
// Comms replied, Product replied) with a note under the alert, and shows it on the Results tab while the switch is ON.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, world, e2e, F, TEST_FEED, TRIAGED, resultsRows } = H;
  const MIN = 60 * 1000;
  const DAY = 24 * 3600e3;
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  // The tester has a Chat DM with the bot's account, so the escalation-protocol message (F.PARIS is a P0) goes there as
  // a DM and each test here counts only its own emails (a tester Chat can't reach gets it by email: run_tests.js and
  // switch_testers.test.js test that)
  const standInWorld = () => {
    const w = world({ drafts: STAND_IN });
    w.chat.addDm(STAND_IN.standIn, 'spaces/DMSTANDIN');
    return w;
  };
  const LIVE = { live: true, mailbox: 'im@ops.test', from: 'Brand Social <sender@alerts.test>' };
  const COMMS = 'people-comms@alerts.test';     // People Comms (a comms team's group)
  const SEARCH_POC = 'search@alerts.test'; // one of Search's alert POCs (F.P0_OK and F.PARIS are Search alerts)
  const PARIS_LINK = 'https://x.com/paris_tech_press/status/1845000000000000003';
  const TNS_NOTE = 'Outcome: T&S confirmed\n- Source: WD Intake Request confirmation email received.';
  const BQ = 'https://bigquery.googleapis.com/bigquery/v2/projects/brand-social-central-data/queries';

  /** A world whose runs have these switches (the Control tab's): Track post-alert outcomes ON unless said otherwise. */
  const withSwitches = (w, switches) => {
    const base = w.ctx;
    w.ctx = () => { const c = base(); if (switches !== undefined) c.switches = switches; return c; };
    return w;
  };
  const tracking = (opts, switches) => withSwitches(opts ? world(opts) : standInWorld(),
    switches === undefined ? { trackOutcomes: true } : switches);
  const memo = (w, k) => w.ctx().memo.get(k);
  const later = (w, minutes) => { w.g.clock.now += minutes * MIN; return w.run(); };
  const notes = w => w.analystPosts().filter(m => /^Outcome: /.test(m.text)).map(m => m.text);
  const threadReads = w => w.gmail.calls.filter(c => c.method === 'get' && /^threads\//.test(c.path)).length;
  const tnsSearches = w => w.gmail.calls.filter(c => c.path === 'messages' && /WD Intake Request/.test(c.query.q || '')).map(c => c.query.q);
  /** F.P0_OK (Search, P0) sent to the stand-in: the alert, the run's report, its row. */
  const sendP0 = w => {
    const msg = w.paste(F.P0_OK);
    const r = w.run();
    return { msg, r, row: w.alertRows()[0] };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // OFF: nothing changes
  // ---------------------------------------------------------------------------------------------------------------

  test('outcomes OFF (no switches, or all of them OFF): a week of replies, a resolution and the T&S confirmation change nothing: no list, no thread reads, no outcome, no notes; the same emails, posts, rows and reports', () => {
    const week = switches => {
      const w = withSwitches(standInWorld(), switches);
      const msg = w.paste(F.PARIS);
      const reports = [w.run()];
      const row = w.alertRows()[0];
      w.gmail.reply(row.email_thread, { from: `People PR <${COMMS}>`, body: 'Thanks, we are looking into it.' });
      w.gmail.reply(row.email_thread, { from: `Search PR <${SEARCH_POC}>`, body: 'We rolled back the change, it is fixed.' });
      for (let i = 0; i < 4; i++) reports.push(later(w, 30));
      w.gmail.receive('WD Intake Request - Marketing', 'Submitted link: ' + PARIS_LINK);
      reports.push(later(w, 1));
      w.g.clock.now += 3 * DAY;
      reports.push(w.run());
      return { w, msg, reports };
    };
    const none = week(undefined);
    const off = week(B.switchesOff_());
    for (const x of [none, off]) {
      eq(x.w.gmail.sentMessages().length, 1);                 // the Social Alert only
      eq(threadReads(x.w), 1);                                  // its Message-ID, as always: nobody reads the replies
      eq([memo(x.w, 'outcome_watch'), memo(x.w, 'outcome_seeded'), memo(x.w, 'outcome_day')], [null, null, null]);
      assert.ok(!x.w.alertRows().some(r => 'outcome' in r));
      eq(notes(x.w), []);
      assert.ok(x.reports.every(r => !('outcomes' in r) && !r.errors.length));
      eq(x.reports.reduce((n, r) => n + (r.tns_marked || 0), 0), 1);  // ✍️ as always
      eq(tnsSearches(x.w).filter(q => !/newer_than:3d/.test(q)), []);  // checkTnsEmails_'s searches only, as always
      eq(x.w.g.props.get('SWITCH_NOTES'), undefined);
    }
    const strip = x => JSON.parse(JSON.stringify({ sent: x.w.gmail.sentMessages(), posts: x.w.analystPosts().map(m => [m.text, m.thread.name]),
      burson: x.w.bursonPosts().map(m => m.text), rows: x.w.alertRows(), reports: x.reports, calls: x.w.gmail.calls,
      fetches: x.w.g.fetches.map(f => f.url), reactions: x.w.chat.botReactions(x.msg.name), logs: x.w.g.logs }));
    eq(strip(off), strip(none));
  });

  test('outcomes OFF: trackOutcomes_, the onEmailSent_ step and the T&S hook return before touching anything (memo, log sheet, Gmail, Chat)', () => {
    const touched = [];
    const ctx = { switches: B.switchesOff_(), now: () => NOW, deadline: NOW + 180000, log: t => touched.push('log ' + t) };
    ['memo', 'store', 'gmail', 'drafts', 'chat', 'settings', 'spaces', 'post', 'bq', 'gemini'].forEach(k =>
      Object.defineProperty(ctx, k, { get() { touched.push(k); throw new Error(`${k} was touched`); } }));
    const report = { errors: [] };
    const row = { alert_id: 'QA-1', email_thread: 't1', email_sent_at: NOW, email_status: 'sent', outcome: '' };
    B.trackOutcomes_(ctx, report);
    B.watchOutcome_(ctx, row);
    B.tnsConfirmedOutcome_(ctx, row, report);
    B.onEmailSent_(ctx, row, report);
    eq([touched, report, row.outcome], [[], { errors: [] }, '']);
    delete ctx.switches;  // a run without the Control tab: OFF too
    B.trackOutcomes_(ctx, report);
    B.watchOutcome_(ctx, row);
    B.tnsConfirmedOutcome_(ctx, row, report);
    eq(touched, []);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // ON: the replies, the T&S confirmation
  // ---------------------------------------------------------------------------------------------------------------

  test('outcomes ON: a comms reply on the sent Social Alert\'s thread is "Comms replied"; the product\'s POC saying it\'s rolled back adds "Resolved · Product replied"; strongest first, one note under the alert for each reply, never twice; nothing sent, nothing in the Burson space', () => {
    const w = tracking();
    const { msg, r, row } = sendP0(w);
    eq([r.drafts_sent, r.outcomes, r.errors, row.email_status], [1, undefined, [], 'sent']);
    const [alert] = w.gmail.sentMessages();
    const reactions = w.chat.botReactions(msg.name);
    const list = JSON.parse(memo(w, 'outcome_watch'));
    eq([list.length, list[0].id, list[0].at], [1, row.alert_id, row.email_sent_at]);
    assert.ok(list[0].next >= row.email_sent_at + 30 * MIN && list[0].next <= w.g.clock.now + 30 * MIN, String(list[0].next));

    w.gmail.reply(alert.threadId, { from: `"People PR" <${COMMS}>`, body: 'Thanks, we\'re aware and drafting a holding statement.' });
    const reads = threadReads(w);
    later(w, 28);
    eq(threadReads(w), reads);  // not due yet: the thread isn't read
    const r2 = later(w, 2);
    eq([r2.outcomes, r2.errors, threadReads(w)], [1, [], reads + 1]);
    eq(w.alertRows()[0].outcome, 'Comms replied');
    eq(notes(w), ['Outcome: Comms replied\n- From: People PR (on the Social Alert\'s email thread)\n- Message: "Thanks, we\'re aware and drafting a ' +
      'holding statement."']);
    const note = w.analystPosts().find(m => /^Outcome: /.test(m.text));
    eq([note.threadReply, note.thread.name], [true, row.forward_thread]);

    w.gmail.reply(alert.threadId, { from: `Search PR <${SEARCH_POC}>`, body: 'We rolled back the ranking change last night; the results look right now. Thanks!' });
    const r3 = later(w, 30);
    eq(r3.outcomes, 2);
    eq(w.alertRows()[0].outcome, 'Resolved · Comms replied · Product replied');
    eq(notes(w).slice(1), ['Outcome: Resolved · Product replied\n- From: Search PR (on the Social Alert\'s email thread)\n- Message: "We rolled back ' +
      'the ranking change last night; the results look right now. Thanks!"']);

    // Never twice: more replies of the same kinds, more runs
    w.gmail.reply(alert.threadId, { from: COMMS, body: 'All fixed on our side too.' });
    for (let i = 0; i < 4; i++) later(w, 30);
    eq([notes(w).length, w.alertRows()[0].outcome], [2, 'Resolved · Comms replied · Product replied']);
    eq(memo(w, 'outcome_day'), JSON.stringify({ day: '2026-10-14', n: 3 }));
    eq([w.gmail.sentMessages().length, w.bursonPosts(), w.chat.botReactions(msg.name)], [1, [], reactions]);
  });

  test('outcomes ON: the T&S confirmation email is "T&S confirmed" (✍️ as always, and one note); a later reply adds to it, never replaces it; T&S isn\'t looked for again', () => {
    const w = tracking();
    const msg = w.paste(F.PARIS);
    w.run();
    const row = w.alertRows()[0];
    eq([row.email_status, JSON.parse(memo(w, 'tns_watch'))], ['sent', [row.alert_id]]);
    w.gmail.receive('WD Intake Request - Marketing', 'Submitted link: ' + PARIS_LINK);
    const r = w.run();
    eq([r.tns_marked, r.outcomes, r.errors], [1, 1, []]);
    eq(w.alertRows()[0].outcome, 'T&S confirmed');
    assert.ok(w.chat.botReactions(msg.name).includes('✍'));
    eq(notes(w), [TNS_NOTE]);
    const searched = tnsSearches(w).length;
    w.gmail.reply(row.email_thread, { from: `People PR <${COMMS}>`, body: 'Thanks for flagging.' });
    for (let i = 0; i < 3; i++) later(w, 30);
    eq([w.alertRows()[0].outcome, notes(w).length, tnsSearches(w).length], ['T&S confirmed · Comms replied', 2, searched]);
  });

  test('outcomes ON: T&S marked ✍️ by hand before its confirmation email (so checkTnsEmails_ stops looking): reading the thread still finds the confirmation, once', () => {
    const w = tracking();
    w.paste(F.PARIS);
    w.run();
    const row = w.alertRows()[0];
    const c = w.ctx();
    w.bot.recordTns_(c, c.store.alertById(row.alert_id));  // an analyst's ✍️
    w.run();
    eq(memo(w, 'tns_watch'), '[]');
    w.gmail.receive('WD Intake Request - Marketing', 'Submitted link: ' + PARIS_LINK);
    const r = later(w, 30);
    eq([r.tns_marked, r.outcomes, w.alertRows()[0].outcome, notes(w)], [undefined, 1, 'T&S confirmed', [TNS_NOTE]]);
    eq(tnsSearches(w).slice(-1), ['subject:"WD Intake Request" newer_than:7d "x.com/paris_tech_press/status/1845000000000000003"']);
    const searched = tnsSearches(w).length;
    for (let i = 0; i < 3; i++) later(w, 30);
    eq([tnsSearches(w).length, notes(w).length], [searched, 1]);
  });

  test('outcomes ON: a draft a person sent (live, no stand-in) is tracked from that send: the product\'s POC replying (through a group: Sender) is "Product replied"; the IMs\' own messages from the mailbox never count', () => {
    const w = tracking({ drafts: LIVE });
    w.bot.ev('GEN').email.stand_in = '';
    w.paste(F.P0_OK);
    w.run();
    const [draft] = w.gmail.allDrafts();
    eq(memo(w, 'outcome_watch'), null);  // a draft isn't sent yet
    w.gmail.send(draft.id, 'im@ops.test', '<sent-p0@mail.test>');
    w.run();
    const row = w.alertRows()[0];
    eq([row.email_status, JSON.parse(memo(w, 'outcome_watch')).map(e => [e.id, e.at])], ['sent', [[row.alert_id, row.email_sent_at]]]);
    w.gmail.reply(draft.threadId, { from: 'Brand Social <im@ops.test>', body: 'Resolved, closing this out.' });  // the mailbox itself
    w.gmail.reply(draft.threadId, { from: 'Brand Social <sender@alerts.test>', body: 'Fixed.' });
    w.gmail.reply(draft.threadId, { from: 'Jane Doe <jdoe@ops.test>', sender: SEARCH_POC, body: 'Looping in eng, thanks.' });
    const r = later(w, 30);
    eq([r.outcomes, w.alertRows()[0].outcome, notes(w)], [1, 'Product replied',
      ['Outcome: Product replied\n- From: Jane Doe (on the Social Alert\'s email thread)\n- Message: "Looping in eng, thanks."']]);
    eq([w.gmail.sentMessages(), w.bursonPosts()], [[], []]);
  });

  test('outcomes ON: what doesn\'t count: the bot\'s own messages, out-of-office and bounce messages, replies from before the send, someone else\'s thanks, and "not fixed yet" / "is it fixed?" / "will be"', () => {
    const w = tracking();
    const { row } = sendP0(w);
    const th = row.email_thread;
    w.gmail.reply(th, { from: 'Brand Social <bot@runner.test>', labels: ['SENT'], body: 'Update: this post has been deleted.' });
    w.gmail.reply(th, { from: 'Brand Social <bot@runner.test>', body: 'It is fixed.' });
    w.gmail.reply(th, { from: COMMS, subject: 'Automatic reply: SOCIAL ALERT', body: 'Thanks for your email.' });
    w.gmail.reply(th, { from: SEARCH_POC, body: 'I am currently out of the office with limited access to email.' });
    w.gmail.reply(th, { from: 'Mail Delivery Subsystem <mailer-daemon@mail.test>', body: 'Address not found' });
    w.gmail.reply(th, { from: COMMS, at: row.email_sent_at - 60 * 1000, body: 'An earlier message on the thread.' });
    w.gmail.reply(th, { from: 'Someone <someone@ops.test>', body: 'Thanks for the heads up, will take a look.' });
    w.gmail.reply(th, { from: 'Someone <someone@ops.test>', body: 'This isn\'t fixed yet. Is it resolved on your side? We will roll back tomorrow.' });
    w.gmail.reply(th, { from: 'Someone <someone@ops.test>', body: 'Thanks! On Mon, Oct 12, 2026 at 9:00 AM Brand Social <sender@alerts.test> wrote: the post was removed' });
    const r = later(w, 30);
    eq([r.outcomes, r.errors, w.alertRows()[0].outcome, notes(w)], [undefined, [], undefined, []]);
  });

  test('outcomes: what one reply shows (outcomeOf_): the product\'s alert contacts, the comms teams and the standard CC list, "resolved" in the reply\'s own words; HTML-escaped snippets read as text', () => {
    const row = product => ({ email_input: { escalation: { product }, fields: { product } } });
    const m = (from, snippet, sender) => ({ headers: { from, sender }, snippet });
    eq(B.outcomeOf_(row('Search'), m(`Search PR <${SEARCH_POC}>`, 'Thanks')), ['Product replied']);
    eq(B.outcomeOf_(row('Search'), m('jdoe@ops.test', 'Mitigated as of 10am.', SEARCH_POC)), ['Resolved', 'Product replied']);
    eq(B.outcomeOf_(row('Search'), m(COMMS, 'On it')), ['Comms replied']);
    eq(B.outcomeOf_(row('Search'), m('exec-comms@alerts.test', 'Exec comms is aware')), ['Comms replied']);           // Executive Comms
    eq(B.outcomeOf_(row('Search'), m('stop-leaks@alerts.test', 'Noted')), ['Comms replied']);                    // Stop Leaks
    eq(B.outcomeOf_(row('Search'), m('default-cc@alerts.test', 'Noted')), ['Comms replied']);                       // the standard CC list
    eq(B.outcomeOf_(row('Ads/Merchant Center'), m('default-cc@alerts.test', 'Noted')), ['Product replied']);       // …the Ads POCs' own
    eq(B.outcomeOf_({ email_input: { fields: { product: 'Search' } } }, m(SEARCH_POC, 'ok')), ['Product replied']);  // from the fields
    eq(B.outcomeOf_(row('Search'), m('someone@ops.test', 'The post was taken down this morning.')), ['Resolved']);
    eq(B.outcomeOf_(row('Search'), m('someone@ops.test', 'Thanks')), []);
    eq(B.outcomeOf_(row(''), m(SEARCH_POC, 'Thanks')), []);  // no product on file: no POCs to match
    eq(B.outcomeOf_({}, {}), []);

    const yes = ['Resolved.', 'This is fixed now, thanks!', 'We mitigated it at 10am.', 'The fix has been patched in prod.',
      'We rolled back the change.', 'Rolled it back last night.', 'Rollback is complete.', 'The post was taken down.', 'X took it down.',
      'The tweet has been removed.', 'The account was suspended.', 'We removed the post.', 'Thanks! Fixed.', 'Seen. It’s resolved.'];
    const no = ['Not fixed yet.', 'Is it resolved?', 'It isn’t fixed.', 'We will roll it back.', 'It should be fixed soon.',
      'Let me know if it is resolved.', 'Once fixed we\'ll update.', 'We\'ll have it fixed by Monday.', 'Still not resolved.',
      'Working on a fix, should be resolved shortly.', 'I removed myself from the thread.', 'Unresolved for now.', 'Fixing it now.', ''];
    eq(yes.filter(s => !B.outcomeResolved_(s)), []);
    eq(no.filter(s => B.outcomeResolved_(s)), []);
    eq(B.outcomeOwnText_('Looks good. On Mon, Oct 12, 2026 at 9:00 AM Brand Social <x@ops.test> wrote: The post was removed'), 'Looks good.');
    eq(B.outcomeOwnText_('Seen ---------- Forwarded message --------- From: a'), 'Seen');
    eq(B.gmailSnippet_('We&#39;re on it &amp; it&#39;s &quot;fixed&quot; &lt;soon&gt;'), 'We\'re on it & it\'s "fixed" <soon>');
    eq(B.outcomeNoteText_(['Comms replied'], m('"<users/all>" <x@ops.test>', 'Ping <users/all> now')),
      'Outcome: Comms replied\n- From: users/all (on the Social Alert\'s email thread)\n- Message: "Ping users/all now"');  // no Chat mention
    eq(B.outcomeNoteText_(['Product replied', 'Resolved'], m('y@ops.test', '')),
      'Outcome: Resolved · Product replied\n- From: y@ops.test (on the Social Alert\'s email thread)');
    // The cell: every label once, strongest first, nothing taken away (what someone typed there is kept, after them)
    eq([B.mergeOutcome_('', 'Comms replied'), B.mergeOutcome_('Comms replied', 'Resolved'), B.mergeOutcome_('Resolved · Comms replied', 'Comms replied'),
      B.mergeOutcome_('Escalated to legal', 'T&S confirmed'), B.mergeOutcome_('Product replied', 'Comms replied · T&S confirmed'),
      B.hasOutcome_('Resolved · Comms replied', 'Comms replied'), B.hasOutcome_('', 'Resolved')],
    ['Comms replied', 'Resolved · Comms replied', 'Resolved · Comms replied', 'T&S confirmed · Escalated to legal',
      'T&S confirmed · Comms replied · Product replied', true, false]);
  });

  test('outcomes: Mail.gs getThread gives each message\'s snippet as plain text (one more field; the request is the same)', () => {
    const w = standInWorld();
    w.gmail.reply('thX', { from: COMMS, body: 'We\'re on it & it\'s <b>fixed</b>' });
    const [m] = w.bot.gmailClient_({ onlyTo: 'tester@testing.test' }).getThread('thX');
    eq([m.snippet, m.headers.from, m.labels], ['We\'re on it & it\'s <b>fixed</b>', COMMS, ['INBOX']]);
    eq(w.gmail.calls[0].path, 'threads/thX');
    eq(Object.keys(w.gmail.calls[0].query), ['format', 'metadataHeaders']);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The list: budgets, spacing, the week, seeding, time
  // ---------------------------------------------------------------------------------------------------------------

  /** n sent alerts on the list (rows in the log, threads in Gmail, sent at `at`), each on its own Search post. */
  function seeded(n, opts, at) {
    const w = tracking(opts);
    const c = w.ctx();
    const sent = at === undefined ? NOW : at;
    for (let i = 1; i <= n; i++) {
      const thread = 'tho' + i;
      w.gmail.threads.set(thread, [{ id: 'go' + i, threadId: thread, labelIds: ['SENT'], internalDate: String(sent),
        payload: { headers: [{ name: 'Message-ID', value: `<o${i}@mail.test>` }, { name: 'To', value: 'tester@testing.test' },
          { name: 'Subject', value: `SOCIAL ALERT ${i}` }] } }]);
      w.backend.alerts.push({ alert_id: 'QA-' + i, created_at: sent, space: `${w.BUR} > ${w.ANA}`, record_key: `x.com/status/30000${i}`,
        email_status: 'sent', email_thread: thread, email_message_id: `<o${i}@mail.test>`, email_at: sent, email_sent_at: sent,
        email_input: { fields: { post_url: `https://x.com/u${i}/status/30000${i}`, product: 'Search' }, escalation: { product: 'Search' } } });
    }
    const store = c.store;
    for (let i = 1; i <= n; i++) w.bot.watchOutcome_(c, store.alertById('QA-' + i));
    return w;
  }
  const readsOf = w => w.gmail.calls.filter(c => /^threads\/tho/.test(c.path)).map(c => c.path.replace('threads/tho', ''));
  const listOf = w => JSON.parse(memo(w, 'outcome_watch'));

  test('outcomes ON: at most 5 threads read per run (the longest-waiting first), each every 30 minutes the first day and every 2 hours after; a week after its send it\'s dropped; a quiet run doesn\'t open the log sheet', () => {
    const w = seeded(7);
    eq(listOf(w).map(e => e.id), ['QA-1', 'QA-2', 'QA-3', 'QA-4', 'QA-5', 'QA-6', 'QA-7']);
    w.run();
    eq(readsOf(w), []);  // the first read is 30 minutes after the send
    later(w, 30);
    eq(readsOf(w), ['1', '2', '3', '4', '5']);
    w.run();
    eq(readsOf(w).slice(5), ['6', '7']);
    const loads = w.storeLoads;
    later(w, 27);
    eq([readsOf(w).length, w.storeLoads], [7, loads]);  // nothing due: no Gmail, and the log sheet isn't opened
    later(w, 3);
    eq(readsOf(w).slice(7), ['1', '2', '3', '4', '5']);
    // A day after the send: every 2 hours
    w.g.clock.now = NOW + DAY + MIN;
    w.run();
    const now = w.g.clock.now;
    eq(readsOf(w).slice(-5), ['6', '7', '1', '2', '3']);  // the longest-waiting first
    eq(listOf(w).filter(e => e.next > now).map(e => [e.id, e.next - now]), ['QA-1', 'QA-2', 'QA-3', 'QA-6', 'QA-7'].map(id => [id, 2 * 3600e3]));
    // A week after the send: dropped, without a read
    const read = readsOf(w).length;
    w.g.clock.now = NOW + 7 * DAY + MIN;
    w.run();
    eq([readsOf(w).length, memo(w, 'outcome_watch')], [read, '[]']);
    eq(w.gmail.sentMessages(), []);
  });

  test('outcomes ON: an alert stops being tracked when it isn\'t a sent Social Alert on file any more; the list keeps the newest 100; an alert sent again takes its own place once', () => {
    const w = seeded(3);
    w.backend.alerts.splice(1, 1);                   // QA-2's row is gone from the log
    w.backend.alerts[1].email_status = 'discarded';  // QA-3 isn't a sent Social Alert
    later(w, 30);
    eq([readsOf(w), listOf(w).map(e => e.id)], [['1'], ['QA-1']]);

    const big = seeded(105);
    eq([listOf(big).length, listOf(big)[0].id], [100, 'QA-6']);
    assert.ok(memo(big, 'outcome_watch').length <= 8000);

    const again = seeded(2);
    const c = again.ctx();
    again.bot.watchOutcome_(c, c.store.alertById('QA-1'));
    eq(listOf(again).map(e => e.id), ['QA-2', 'QA-1']);
    again.bot.watchOutcome_(c, Object.assign({}, c.store.alertById('QA-2'), { alert_id: 'QA-9', email_thread: '' }));  // no thread
    eq(listOf(again).map(e => e.id), ['QA-2', 'QA-1']);
  });

  test('outcomes ON: turned on with Social Alerts already sent this week: they go on the list once, due now (from the Alert log, oldest first), not older or unsent ones; while the runs keep coming, the list is topped up again at most once a day', () => {
    const w = withSwitches(standInWorld(), B.switchesOff_());
    const add = (id, at, extra) => {
      const thread = 'th-' + id;
      w.gmail.threads.set(thread, [{ id: 'g-' + id, threadId: thread, labelIds: ['SENT'], internalDate: String(at), payload: { headers: [] } }]);
      w.backend.alerts.push(Object.assign({ alert_id: id, created_at: at, space: `${w.BUR} > ${w.ANA}`, email_status: 'sent',
        email_thread: thread, email_at: at, email_sent_at: at, email_input: { escalation: { product: 'Search' } } }, extra || {}));
      w.gmail.reply(thread, { from: COMMS, at: at + 60 * MIN, body: 'Thanks, on it.' });
    };
    add('QA-1', NOW - 2 * DAY);
    add('QA-2', NOW - 8 * DAY);                               // more than a week ago
    add('QA-3', NOW - DAY, { email_status: 'discarded' });    // never sent
    add('QA-4', NOW - DAY, { email_thread: '' });             // no thread on file
    add('QA-5', NOW - 6 * DAY);
    w.run();
    eq([memo(w, 'outcome_watch'), memo(w, 'outcome_seeded'), threadReads(w)], [null, null, 0]);  // OFF: nothing

    withSwitches(w, { trackOutcomes: true });
    const r = w.run();
    eq(listOf(w).map(e => e.id), ['QA-5', 'QA-1']);
    eq([r.outcomes, w.alertRows().map(a => a.outcome || '')], [2, ['Comms replied', '', '', '', 'Comms replied']]);
    eq(memo(w, 'outcome_seeded'), String(w.g.clock.now));
    const loads = w.storeLoads;
    later(w, 10);
    eq(w.storeLoads, loads);  // filled once

    w.ctx().memo.set('outcome_watch', '[]');
    for (let i = 0; i < 6; i++) later(w, 10);
    eq([w.storeLoads, memo(w, 'outcome_watch')], [loads, '[]']);  // empty, but filled less than a day ago
    w.g.clock.now += DAY;
    w.run();
    eq(listOf(w).map(e => e.id), ['QA-1']);  // QA-5 is more than a week old now

    // The Alert log can't be read when it's time to fill the list: tried again on the next run, not a day later
    const f = withSwitches(standInWorld(), { trackOutcomes: true });
    f.backend.alerts.push({ alert_id: 'QA-7', created_at: NOW - DAY, space: `${f.BUR} > ${f.ANA}`, email_status: 'sent',
      email_thread: 'th-7', email_at: NOW - DAY, email_sent_at: NOW - DAY, email_input: {} });
    const broken = f.ctx();
    Object.defineProperty(broken, 'store', { get() { throw new Error('the sheet is busy'); } });
    assert.throws(() => f.bot.trackOutcomes_(broken, { errors: [] }), /the sheet is busy/);
    eq([memo(f, 'outcome_seeded'), memo(f, 'outcome_watch')], [null, null]);
    f.run();
    eq(listOf(f).map(e => e.id), ['QA-7']);
  });

  test('outcomes ON: the time budget: with under 45 s left the run doesn\'t read any thread; with under 30 s left no alert is checked (they wait, unchanged)', () => {
    const w = seeded(2);
    w.g.clock.now += 30 * MIN;
    const before = memo(w, 'outcome_watch');
    const base = w.ctx;
    w.ctx = () => { const c = base(); c.deadline = w.g.clock.now + 44 * 1000; return c; };
    w.run();
    eq([readsOf(w), memo(w, 'outcome_watch')], [[], before]);
    const c = base();
    c.deadline = w.g.clock.now + 29 * 1000;
    const report = { errors: [] };
    w.bot.trackOutcomes_(c, report);
    eq([readsOf(w), memo(w, 'outcome_watch'), report], [[], before, { errors: [] }]);
    w.ctx = base;
    w.run();
    eq(readsOf(w), ['1', '2']);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Never twice, and failures
  // ---------------------------------------------------------------------------------------------------------------

  test('outcomes ON: never twice: the outcome is on the row before its note; a row that can\'t be written gets no note (read again later, then noted once); a lost list or a retried note adds nothing', () => {
    const w = tracking();
    const { row } = sendP0(w);
    w.gmail.reply(row.email_thread, { from: COMMS, body: 'Seen, thanks.' });
    const update = w.backend.updateAlert.bind(w.backend);
    let failing = true;
    w.backend.updateAlert = (r, patch) => {
      if ('outcome' in patch) {
        if (failing) throw new Error('Service Spreadsheets failed');
        eq(notes(w), []);  // the row first
      }
      return update(r, patch);
    };
    const r1 = later(w, 30);
    eq([r1.outcomes, r1.errors, w.alertRows()[0].outcome, notes(w)], [undefined, [], undefined, []]);
    assert.ok(w.g.logs.some(l => /couldn't check what came of the Social Alert QA-1001: Service Spreadsheets failed/.test(l)));
    failing = false;
    later(w, 30);
    eq([w.alertRows()[0].outcome, notes(w).length], ['Comms replied', 1]);
    // The list is lost and the alert is put back on it (e.g. sent again from another flow): the row still has it
    w.ctx().memo.set('outcome_watch', JSON.stringify([{ id: row.alert_id, at: row.email_sent_at, next: 0 }]));
    later(w, 1);
    eq(notes(w).length, 1);
    // The run stopped between the row and the note, and the note is posted again: Chat keeps the first (its key)
    const posts = w.analystPosts().length;
    w.bot.postDraftNote_(w.ctx(), w.alertRows()[0], 'again', `outcome:${row.alert_id}:Comms replied`);
    eq(w.analystPosts().length, posts);
  });

  test('outcomes ON: Gmail failing is logged and the thread read again later; nothing escapes into the run; only something unexpected (the list can\'t be saved) is reported, like its neighbours', () => {
    const w = tracking();
    const { row } = sendP0(w);
    w.gmail.reply(row.email_thread, { from: COMMS, body: 'Thanks.' });
    w.gmail.fail = (method, path) => (/^threads\//.test(path) ? { code: 500, body: { error: { message: 'Backend Error' } } } : null);
    const r = later(w, 30);
    eq([r.errors, r.outcomes], [[], undefined]);
    assert.ok(w.g.logs.some(l => /couldn't check what came of the Social Alert QA-1001: Gmail 500 on reading a thread: Backend Error/.test(l)));
    eq(listOf(w)[0].next, w.g.clock.now + 30 * MIN);
    w.gmail.fail = null;
    later(w, 30);
    eq(w.alertRows()[0].outcome, 'Comms replied');
    // The T&S search failing: the same
    const t = tracking();
    t.paste(F.PARIS);
    t.run();
    const c0 = t.ctx();
    t.bot.recordTns_(c0, c0.store.alertById(t.alertRows()[0].alert_id));
    t.gmail.fail = (method, path) => (path === 'messages' ? { code: 503, body: {} } : null);
    const r2 = later(t, 30);
    eq([r2.errors, t.alertRows()[0].outcome], [[], undefined]);
    // The list can't be saved
    w.g.clock.now += 30 * MIN;
    const c = w.ctx();
    const memoOf = c.memo;
    c.memo = { get: k => memoOf.get(k), set: (k, v) => { if (k === 'outcome_watch') throw new Error('properties unavailable'); memoOf.set(k, v); } };
    const report = w.bot.runOnce_(c);
    eq(report.errors, ['tracking what came of sent Social Alerts: properties unavailable']);
    eq(w.gmail.sentMessages().length, 1);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The Results tab
  // ---------------------------------------------------------------------------------------------------------------

  const R_FLOWS = { main: { partition: 'spaces/MIRROR > (isolated)', label: 'Mirror space' },
    ac: { partition: 'spaces/AAQAaa_0I9g > spaces/AUTOFIX (auto-correct)', label: 'Auto-correct space' } };
  const withOutcomes = () => resultsRows().map(r => Object.assign(r, { QA_1: { outcome: 'Comms replied' }, QA_2: { outcome: 'Resolved' },
    QA_5: { outcome: 'T&S confirmed · Product replied' } }[r.alert_id.replace('-', '_')] || {}));
  /** The Results tab built in a fresh world from `rows`, with these switches (on the same sheet `ss` when given). */
  const results = (rows, switches, ss0) => {
    const w = world();
    const ss = ss0 || w.g.services.SpreadsheetApp.create('bot');
    const c = w.ctx();
    if (switches) c.switches = switches;
    const props = w.g.services.PropertiesService.getScriptProperties();
    if (ss0) props.setProperty('RESULTS_LAYOUT', ss0.layout);
    w.bot.refreshSpeed_(ss, c, { alerts: rows, drafts: () => [], logged: () => [], flows: R_FLOWS });
    ss.layout = props.getProperty('RESULTS_LAYOUT');
    return { w, ss, tab: ss.getSheetByName('Results') };
  };
  const hidden = tab => Array.from(new Set(tab.hidden)).sort((a, b) => a - b);

  test('outcomes: the Results tab: OFF, the tab is exactly as before even with outcomes on the rows (no Outcome column, column 18 hidden)', () => {
    const plain = results(resultsRows());
    for (const x of [results(withOutcomes()), results(withOutcomes(), B.switchesOff_())]) {
      eq([x.tab.rows, hidden(x.tab), x.tab.merges, x.ss.layout], [plain.tab.rows, hidden(plain.tab), plain.tab.merges, '1']);
    }
    const h = plain.tab.rows.findIndex(x => x[0] === 'Burson posted (ET)' && x.includes('post key'));
    eq([plain.tab.rows[h].includes('Outcome'), plain.tab.rows[h].indexOf('post key'), hidden(plain.tab)], [false, 17, [18, 19, 20, 21]]);
  });

  test('outcomes ON: the Results tab\'s EVERY ALERT has an Outcome column after "Bot alert ids" (a post\'s outcomes from both spaces, together), the hidden columns move one right and are still read back; turned OFF, the tab is as before', () => {
    const on = results(withOutcomes(), { trackOutcomes: true });
    const tab = on.tab;
    const h = tab.rows.findIndex(x => x[0] === 'Burson posted (ET)' && x.includes('post key'));
    const head = tab.rows[h];
    eq(head.slice(15, 19), ['IM', 'Bot alert ids', 'Outcome', 'post key']);
    eq([head.length, hidden(tab), on.ss.layout], [22, [19, 20, 21, 22], '1+outcome']);
    const byKey = {};
    tab.rows.slice(h + 1).forEach(r => { byKey[r[head.indexOf('post key')]] = r[head.indexOf('Outcome')]; });
    eq(byKey, { 'x:20005': '', 'x:20007': '', 'x:20004': '', 'x:20003': 'T&S confirmed · Product replied', 'x:20002': '',
      'x:20001': 'Resolved · Comms replied' });
    eq(Array.from(on.w.bot.readSpeedState_(tab).keys()).sort(), Object.keys(byKey).sort());
    // Every row of the tab is as wide as the table (the summary above included)
    assert.ok(tab.rows.every(r => r.length === 22));
    // The numbers and the summary don't change with it
    const plain = results(resultsRows());
    const above = t => t.rows.slice(0, t.rows.findIndex(x => x[0] === 'Burson posted (ET)' && x.includes('post key'))).map(r => r.slice(0, 17));
    eq(above(tab), above(plain.tab));
    // Turned OFF again (the same sheet): the layout as before
    const off = results(withOutcomes(), B.switchesOff_(), on.ss);
    const h2 = off.tab.rows.findIndex(x => x[0] === 'Burson posted (ET)' && x.includes('post key'));
    eq([off.tab.rows[h2].includes('Outcome'), hidden(off.tab), off.ss.layout], [false, [18, 19, 20, 21], '1']);
    eq(off.tab.rows.slice(0, off.tab.rows.length), plain.tab.rows);
    // The post's outcome, from each space's rows (pure)
    const posts = B.speedPosts_(withOutcomes(), [], [], R_FLOWS);
    const a = posts.find(p => p.key === 'x:20001');
    eq([a.flows.main.outcome, a.flows.ac.outcome, a.outcome, posts.find(p => p.key === 'x:20002').outcome], ['Comms replied', 'Resolved',
      'Resolved · Comms replied', '']);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // End to end, with the Control tab
  // ---------------------------------------------------------------------------------------------------------------

  test('outcomes ON, end to end with the Control tab (row 21 ON): a comms reply on the Social Alert thread lands in the Alert log\'s outcome column, a note under the alert in the analyst space, and the Results tab\'s Outcome column; C21 says what it\'s doing', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.control().getRange(21, 2).setValue('ON');
    t.g.pages.set(BQ, { code: 200, body: { jobComplete: true, schema: { fields: [] }, rows: [] } });  // the Results tab's reads
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    t.poll();
    const [alert] = t.g.gmail.sentMessages();
    eq(alert.to, ['tester@testing.test']);
    eq(t.control().cell(21, 3), '✓ ON: reads replies to sent Social Alerts and T&S confirmations, logs the outcome and keeps the Follow-up tab');
    t.g.gmail.reply(alert.threadId, { from: `People PR <${COMMS}>`, body: 'Thanks, we are tracking this one.' });
    t.g.clock.now += 29 * MIN;
    t.poll();
    const log = t.sheet().getSheetByName('Alert log').rows;
    const col = log[0].indexOf('outcome');
    eq(log.slice(1).map(r => r[col]), ['Comms replied']);
    const note = t.chat.botPosts(TRIAGED).find(m => /^Outcome: /.test(m.text));
    eq([note.text, note.threadReply], ['Outcome: Comms replied\n- From: People PR (on the Social Alert\'s email thread)\n- Message: "Thanks, we are ' +
      'tracking this one."', true]);
    assert.match(t.control().cell(21, 3), /^✓ ON: reads replies to sent Social Alerts and T&S confirmations, logs the outcome and keeps the Follow-up tab · tracking 1 sent alert · last check Oct 14, 8:3\d AM EDT · 1 outcome today$/);
    const res = t.sheet().getSheetByName('Results');
    const h = res.rows.findIndex(x => x[0] === 'Burson posted (ET)' && x.includes('post key'));
    eq(res.rows.slice(h + 1).map(r => r[res.rows[h].indexOf('Outcome')]), ['Comms replied']);
    eq([t.chat.botPosts(TEST_FEED), t.g.gmail.sentMessages().length], [[], 1]);
    for (let i = 0; i < 3; i++) { t.g.clock.now += 30 * MIN; t.poll(); }
    eq(t.chat.botPosts(TRIAGED).filter(m => /^Outcome: /.test(m.text)).length, 1);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Fixes (review): turned OFF and back ON, out-of-office replies, "resolved" with a follow-up, C21 with two flows
  // ---------------------------------------------------------------------------------------------------------------

  test('outcomes ON: turned OFF and back ON within the week: a Social Alert sent while it was OFF is tracked from the first run back (the list is topped up from the Alert log after a gap in the runs), once', () => {
    const w = tracking();
    w.paste(F.P0_OK);
    w.run();
    const a = w.alertRows()[0];
    eq(listOf(w).map(e => e.id), [a.alert_id]);
    const ran = [memo(w, 'outcome_last'), memo(w, 'outcome_seeded'), w.g.props.get('OUTCOME_FLOWS')];
    withSwitches(w, B.switchesOff_());
    later(w, 5);
    w.paste(F.PARIS);
    w.run();
    const b = w.alertRows()[1];
    eq([b.email_status, listOf(w).map(e => e.id)], ['sent', [a.alert_id]]);  // OFF: B isn't put on the list
    eq([memo(w, 'outcome_last'), memo(w, 'outcome_seeded'), w.g.props.get('OUTCOME_FLOWS')], ran);  // …and nothing is noted
    w.gmail.reply(b.email_thread, { from: `People PR <${COMMS}>`, body: 'Resolved, we fixed it.' });
    w.g.clock.now += 2 * 3600e3;
    withSwitches(w, { trackOutcomes: true });
    const r = w.run();
    eq(listOf(w).map(e => e.id), [a.alert_id, b.alert_id]);
    eq([r.errors, w.alertRows()[1].outcome, notes(w)], [[], 'Resolved · Comms replied',
      ['Outcome: Resolved · Comms replied\n- From: People PR (on the Social Alert\'s email thread)\n- Message: "Resolved, we fixed it."']]);
    for (let i = 0; i < 4; i++) later(w, 30);
    eq([notes(w).length, listOf(w).map(e => e.id)], [1, [a.alert_id, b.alert_id]]);
    eq(w.gmail.sentMessages().length, 2);  // the two Social Alerts only
  });

  test('outcomes ON: an alert missing from a list that isn\'t empty (its entry was never saved) is put back within a day, from one read of the Alert log; runs that keep coming don\'t look for it more often', () => {
    const w = seeded(3);
    w.run();
    w.ctx().memo.set('outcome_watch', JSON.stringify(listOf(w).filter(e => e.id !== 'QA-2')));
    const seededAt = memo(w, 'outcome_seeded');
    for (let i = 0; i < 6; i++) later(w, 10);
    eq([listOf(w).map(e => e.id), memo(w, 'outcome_seeded')], [['QA-1', 'QA-3'], seededAt]);
    for (let i = 0; i < 6 * 24; i++) later(w, 10);
    eq(listOf(w).map(e => e.id).sort(), ['QA-1', 'QA-2', 'QA-3']);
    eq(Number(memo(w, 'outcome_seeded')) - Number(seededAt) >= DAY, true);
  });

  test('outcomes ON: out-of-office replies that start with a greeting or thanks don\'t count either (their first words, not only the very start); a real reply that mentions being out of office still does', () => {
    const ooo = ['Thanks for your note. I am out of the office until Monday with limited access to email.',
      'Hi! I\'m currently OOO until 10/20.', 'Hello, I am on vacation through Oct 24 and will reply when I return.',
      'Thank you for your email. I’m out of office and will respond on my return.', 'This is an automatic reply: I am away.',
      'Hi, I\'m out of the office with limited access to email.'];
    const real = ['Sorry for the delay, I was out of office yesterday. We rolled back the change.', 'Thanks, on it.',
      'Looping in eng, thanks.', 'Back in the office tomorrow, but this is fixed.',
      'We\'ve rolled the change back and the issue is resolved. I\'m on leave from tomorrow, so please contact Sam for anything else.',
      'This is fixed now. I\'m away next week; Sam is covering.',
      'Resolved - the post has been taken down. Note: I\'ll be out of office until Monday.'];
    const subject = 'Re: 🟥SOCIAL ALERT🟥: Search | X';
    eq(ooo.filter(t => !B.outcomeAutoReply_({ headers: { subject }, snippet: t })), []);
    eq(real.filter(t => B.outcomeAutoReply_({ headers: { subject }, snippet: t })), []);
    const w = tracking();
    const { row } = sendP0(w);
    w.gmail.reply(row.email_thread, { from: 'Paul Chapa <default-cc@alerts.test>', subject, body: ooo[0] });  // the standard CC list
    w.gmail.reply(row.email_thread, { from: COMMS, subject, body: ooo[1] });
    const r = later(w, 30);
    eq([r.outcomes, r.errors, w.alertRows()[0].outcome, notes(w)], [undefined, [], undefined, []]);
    w.gmail.reply(row.email_thread, { from: COMMS, subject, body: real[0] });
    later(w, 30);
    eq(w.alertRows()[0].outcome, 'Resolved · Comms replied');
  });

  test('outcomes: "Resolved" when the sentence also says what comes next ("will keep monitoring", "no further action needed", "we\'ll keep an eye on it"); that never makes a "not yet", a "will be" or a question resolved', () => {
    const yes = ['We rolled back the change and will keep monitoring.', 'The post has been removed, no further action needed.',
      'This is resolved now, we\'ll keep an eye on it.', 'Fixed, we will continue to monitor.', 'We’ll keep monitoring, it’s fixed now.',
      'The tweet was taken down; no further action is required.'];
    const no = ['We will keep monitoring once fixed.', 'No further action needed until it\'s fixed.', 'Fixed in staging, will be live tomorrow.',
      'We\'ll keep an eye on it, not resolved yet.', 'Will keep monitoring; is it resolved?', 'We will keep monitoring.',
      'No further action needed.'];
    eq(yes.filter(s => !B.outcomeResolved_(s)), []);
    eq(no.filter(s => B.outcomeResolved_(s)), []);
    const row = { email_input: { escalation: { product: 'Search' } } };
    eq(B.outcomeOf_(row, { headers: { from: 'eng@ops.test' }, snippet: 'The post has been removed, no further action needed.' }),
      ['Resolved']);  // anyone's reply counts when it says it's resolved
    eq(B.outcomeOf_(row, { headers: { from: COMMS }, snippet: 'We rolled back the change and will keep monitoring.' }),
      ['Resolved', 'Comms replied']);
  });

  test('outcomes ON: C21 adds up both flows (the main space\'s list and the auto-correct space\'s, each with its own), whichever ran last; a flow that stopped checking drops out of "tracking" after a while, its outcomes today stay', () => {
    const w = tracking();
    const day = '2026-10-14';
    const main = w.ctx();
    main.memo.set('outcome_day', JSON.stringify({ day, n: 2 }));
    w.bot.noteOutcomes_(main, 4);
    const acMemo = new Map();
    const ac = Object.assign(w.ctx(), { sourceReadOnly: true,
      memo: { get: k => (acMemo.has(k) ? acMemo.get(k) : null), set: (k, v) => acMemo.set(k, v) } });
    ac.memo.set('outcome_day', JSON.stringify({ day, n: 1 }));
    w.bot.noteOutcomes_(ac, 1);
    const note = () => JSON.parse(w.g.props.get('SWITCH_NOTES')).trackOutcomes.text;
    assert.match(note(), /^tracking 5 sent alerts · last check Oct 14, 8:00 AM EDT · 3 outcomes today$/);
    w.g.clock.now += MIN;
    w.bot.noteOutcomes_(main, 4);
    assert.match(note(), /^tracking 5 sent alerts · last check Oct 14, 8:01 AM EDT · 3 outcomes today$/);
    w.g.clock.now += 3 * 3600e3;
    w.bot.noteOutcomes_(main, 4);
    assert.match(note(), /^tracking 4 sent alerts · last check Oct 14, 11:01 AM EDT · 3 outcomes today$/);
    // The next day: only that day's outcomes
    w.g.clock.now += DAY;
    main.memo.set('outcome_day', JSON.stringify({ day: '2026-10-15', n: 1 }));
    w.bot.noteOutcomes_(main, 2);
    assert.match(note(), /^tracking 2 sent alerts · last check Oct 15, 11:01 AM EDT · 1 outcome today$/);
  });
};
