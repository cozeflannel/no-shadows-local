/**
 * End-to-end tests for multi-product -> per-team Social Alert email formulation & delivery:
 * - "Product: Gemini Model, Devs Products" (Zapier/Burson [Product], header-only, & / +, and non-Zapier Chat cards)
 * - Dynamic Google Group resolution from the workbook's `Brand safety groups` tab
 * - Real inbox delivery to `Control!B30` while Testing (`Control!B29 = ON`), and live Google Group delivery / Gmail
 *   Drafts when controlled via the `Control` tab (`B29 = OFF`, `B11 = ON/OFF`)
 * - Same-team alias grouping ("AI Studio, Devs Products" -> 1 email to Developers team)
 * - Per-team threaded ongoing updates, T&S single-submission, `Speed.gs` bot-thread exclusion, and `AlertMemory` dedup
 */
'use strict';

module.exports = function (H) {
  const { assert, B, NOW, test, eq, plain, world, e2e, TEST_FEED } = H;

  const populateBrandSafetyGroups = ss => {
    let bsg = ss.getSheetByName('Brand safety groups');
    if (!bsg) bsg = ss.insertSheet('Brand safety groups');
    const rows = [
      ['Google Group Name', 'Google Group Email'],
      ['Gemini Model', 'gemini-model-team@groups.test'],
      ['Devs Products', 'devs-products-team@groups.test'],
      ['Gemini App', 'gemini-app-team@groups.test'],
      ['Search', 'search-team@groups.test'],
      ['GCPA', 'gcpa-comms@groups.test'],
      ['Civics', 'civics-team@groups.test'],
      ['Default CC', 'slrr-standard-cc@groups.test'],
      ['Brand Social Sender', 'sender@groups.test'],
      ['T&S Urgent', 'tns-urgent@groups.test'],
    ];
    bsg.getRange(1, 1, rows.length, 2).setValues(rows);
    return bsg;
  };

  const GEMINI_DEVS_ALERT = [
    '\ud83d\udea8THIS ALERT MEETS P0 CRITERIA\ud83d\udea8',
    '',
    '\ud83d\udfe5SOCIAL ALERT\ud83d\udfe5: Gemini Model, Devs Products | Gemini API Returning Unsafe Code Execution Snippets | X | 3200 Engagements',
    '[Name]: Gemini API Returning Unsafe Code Execution Snippets / New / not previously reported over the past 14 days',
    '[Engagement]: HIGH (3200 engagements)',
    '[Product]: Gemini Model, Devs Products',
    '[Social Network]: X',
    '[Exposure Tag]: Product - Dangerous results (e.g. medical/legal)',
    '[Sensitive Topic]: Malicious & Unwanted Software',
    '[KOF]: No',
    '',
    'X user @dev_sec_researcher (48,200 followers) posted screenshots showing Gemini 3 Pro via Google AI Studio generating unsafe shell snippets when prompted about package setup.',
    '',
    '[Link]: https://x.com/dev_sec_researcher/status/2120000000000000101',
    '',
    '[Time/Date Post Went Live]: October 13, 2026, 9:15 AM',
    '',
    '[Code]: Product - Dangerous results (e.g. medical/legal),3200,dev_sec_researcher,Malicious & Unwanted Software,Gemini Model,New / not previously reported over the past 14 days',
  ].join('\n');

  test('multi-product E2E (Testing inbox via Control!B30 + Brand safety groups): "Product: Gemini Model, Devs Products" sends ONE single Social Alert email to B30 with ALL product teams listed in Cc:, submits T&S once, and blocks duplicates', () => {
    const t = e2e(null, { noWait: true });
    t.bot.setup();
    populateBrandSafetyGroups(t.sheet());
    t.bot.syncBrandSafetyGroups_(t.sheet(), { force: true });

    // Controlled via the Control tab: Safety valve ON (row 29), inbox recipient in B30 (row 30), Auto-submit T&S ON (row 12)
    t.control().getRange(29, 2).setValue('ON');
    t.control().getRange(30, 2).setValue('my-test-inbox@testing.test');
    t.control().getRange(12, 2).setValue('ON');

    t.chat.say(TEST_FEED, GEMINI_DEVS_ALERT, { sender: 'users/bot', senderDisplay: 'Zapier' });
    t.poll();

    const allSent = t.g.gmail.sentMessages();
    const socialSent = allSent.filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(socialSent.length, 1);

    // Single Social Alert arrives in B30 inbox showing both products in Subject/Body, with ALL product teams in Cc:
    eq(socialSent[0].to, ['my-test-inbox@testing.test']);
    assert.match(socialSent[0].subject, /Gemini Model, Devs Products \| Gemini API Returning Unsafe Code Execution Snippets \| X/);
    assert.ok(socialSent[0].text.includes('\nProduct: Gemini Model, Devs Products\n'), socialSent[0].text);
    assert.match(socialSent[0].text, /Would have gone to: Cc: Gemini Model alert POCs, Devs Products alert POCs, .*GCPA.*standard CC list/);

    // T&S urgent email (if sent) went once
    const tnsUrgent = allSent.filter(m => /^URGENT T&S:/.test(m.subject));
    assert.ok(tnsUrgent.length <= 1, `expected at most 1 urgent T&S email, got ${tnsUrgent.length}`);

    // Thread is registered as bot-owned in Speed.gs
    const storeRows = t.bot.sheetBackend_(t.sheet()).loadAlerts();
    const ownThreads = t.bot.botEmailThreads_(storeRows);
    assert.ok(ownThreads.has(socialSent[0].threadId));

    // Re-posting the exact same post does NOT send duplicate Social Alerts
    const duplicateAlert = GEMINI_DEVS_ALERT.replace('9:15 AM', '9:25 AM');
    t.chat.say(TEST_FEED, duplicateAlert, { sender: 'users/bot', senderDisplay: 'Zapier' });
    t.poll();
    const socialAfterDup = t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(socialAfterDup.length, 1);
  });

  test('multi-product Live Auto-send & Live Gmail Drafts: sends ONE Social Alert email with ALL product Google Groups in Cc: (To: empty), and tracks single Gmail draft lifecycle', () => {
    // 1. Live Auto-send ON (Safety valve OFF, no stand-in): sends 1 single live email with ALL product teams in Cc: (To: empty)
    const wAuto = world({
      noWait: true,
      drafts: { live: true, standIn: '', testers: [], mailbox: 'im@ops.test', from: 'Brand Social <sender@groups.test>' },
    });
    wAuto.bot.applyBrandSafetyGroups_([
      ['Gemini Model', ['gemini-model-team@groups.test']],
      ['Devs Products', ['devs-products-team@groups.test']],
      ['GCPA', ['gcpa-comms@groups.test']],
      ['Civics', ['civics-team@groups.test']],
      ['Default CC', ['slrr-standard-cc@groups.test']],
      ['Brand Social Sender', ['sender@groups.test']],
    ]);
    wAuto.bot.ev('GEN').email.stand_in = '';
    wAuto.paste(GEMINI_DEVS_ALERT);
    const baseCtx = wAuto.ctx();
    baseCtx.switches = Object.assign({}, baseCtx.switches || {}, { autoSend: true, noWait: true });
    const repAuto = wAuto.bot.runOnce_(baseCtx);
    eq(repAuto.errors, []);

    const liveSent = wAuto.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(liveSent.length, 1);
    eq(liveSent[0].to, []);
    assert.ok(liveSent[0].cc.includes('gemini-model-team@groups.test'), `expected gemini-model in CC: ${liveSent[0].cc}`);
    assert.ok(liveSent[0].cc.includes('devs-products-team@groups.test'), `expected devs-products in CC: ${liveSent[0].cc}`);
    assert.ok(liveSent[0].cc.includes('gcpa-comms@groups.test') && liveSent[0].cc.includes('slrr-standard-cc@groups.test'));
    assert.match(liveSent[0].subject, /Gemini Model, Devs Products \| Gemini API Returning Unsafe Code Execution Snippets/);
    assert.ok(liveSent[0].text.includes('\nProduct: Gemini Model, Devs Products\n'));

    // Zero internal leaks on any outbound Burson message
    wAuto.chat.spaces.get(wAuto.BUR).messages.filter(m => m.sender.name === 'users/bot').forEach(m => {
      eq(wAuto.bot.outboxGuardHits_(m.text), []);
    });

    // 2. Live Auto-send OFF: creates 1 single Gmail draft with ALL product teams in Cc: (To: empty)
    const wDraft = world({
      noWait: true,
      drafts: { live: true, standIn: '', testers: [], mailbox: 'im@ops.test', from: 'Brand Social <sender@groups.test>' },
    });
    wDraft.bot.applyBrandSafetyGroups_([
      ['Gemini Model', ['gemini-model-team@groups.test']],
      ['Devs Products', ['devs-products-team@groups.test']],
      ['GCPA', ['gcpa-comms@groups.test']],
      ['Civics', ['civics-team@groups.test']],
      ['Default CC', ['slrr-standard-cc@groups.test']],
      ['Brand Social Sender', ['sender@groups.test']],
    ]);
    wDraft.bot.ev('GEN').email.stand_in = '';
    wDraft.paste(GEMINI_DEVS_ALERT);
    const cDraft = wDraft.ctx();
    cDraft.switches = Object.assign({}, cDraft.switches || {}, { autoSend: false, noWait: true });
    wDraft.bot.runOnce_(cDraft);

    const drafts = wDraft.gmail.allDrafts();
    eq(drafts.length, 1);
    eq(drafts[0].to, []);
    assert.ok(drafts[0].cc.includes('gemini-model-team@groups.test'));
    assert.ok(drafts[0].cc.includes('devs-products-team@groups.test'));
    eq(wDraft.alertRows()[0].email_status, 'drafted');

    // Sending that single Draft finalizes row as 'sent' and marks emojis
    wDraft.gmail.send(drafts[0].id, 'im@ops.test');
    wDraft.g.clock.now += 60 * 1000;
    const cCheck = wDraft.ctx();
    cCheck.switches = { autoSend: false, noWait: true };
    wDraft.bot.runOnce_(cCheck);
    eq(wDraft.alertRows()[0].email_status, 'sent');
  });

  test('multi-product non-Zapier Chat cards ("Product: Gemini Model, Devs Products"), same-team alias dedup ("AI Studio, Devs Products"), and single-thread ongoing updates', () => {
    // 1. Same-team aliases ("AI Studio, Devs Products" -> both belong to Devs Products team) -> 1 target
    const sameTeamAlert = GEMINI_DEVS_ALERT
      .replace('Gemini Model, Devs Products |', 'AI Studio, Devs Products |')
      .replace('[Product]: Gemini Model, Devs Products', '[Product]: AI Studio, Devs Products')
      .replace('2120000000000000101', '2120000000000000202');
    const parsedSame = B.parseAlert_(sameTeamAlert);
    const revSame = B.reviewAlert_(parsedSame, { now: NOW });
    const escSame = B.escalation_(revSame.fields, { now: NOW });
    const inpSame = B.emailInput_(revSame.fields, escSame, true);
    const sameTargets = B.productEmailTargets_(inpSame, []);
    eq(sameTargets.length, 1);
    eq(sameTargets[0].single, true);

    // 2. Non-Zapier Chat space card with "Product: Gemini Model, Devs Products" parses primary + other_products cleanly
    const otherCardText = [
      '\ud83d\udea8 *X Alert: Developer & Model Security* \ud83d\udea8',
      '*Author:* @cloud_dev_lead',
      '*Followers:* 82,000',
      '*Engagement:* High (3,400)',
      '*Product:* Gemini Model, Devs Products',
      '*Sentiment:* Negative',
      '*Text:* Serious regression in Gemini 3 Pro tool-calling via the Developers SDK.',
      '*Link:* https://x.com/cloud_dev_lead/status/2120000000000000303',
    ].join('\n');
    const otherParsed = B.otherAlertOf_(otherCardText, 'Monitoring App', []);
    assert.ok(otherParsed);
    const baseFields = B.otherBaseFields_(otherParsed);
    eq(baseFields.product, 'Gemini Model');
    eq(plain(baseFields.other_products), ['Devs Products']);
    eq(plain(baseFields.product_targets), ['Gemini Model', 'Devs Products']);

    // 3. Single-thread ongoing updates: when an ongoing update arrives for a multi-product issue, it replies on that single Gmail thread
    const wThread = world({
      noWait: true,
      drafts: { live: false, standIn: 'my-inbox@testing.test', testers: ['my-inbox@testing.test'], mailbox: 'bot@runner.test', from: 'Brand Social <sender@alerts.test>' },
    });
    wThread.paste(GEMINI_DEVS_ALERT);
    const c1 = wThread.ctx();
    c1.switches = { noWait: true };
    wThread.bot.runOnce_(c1);
    const firstSocial = wThread.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(firstSocial.length, 1);
    const thread1 = firstSocial[0].threadId;

    // Second post on the same issue 2 hours later from a KOF author (raises stakes -> ongoing update)
    wThread.g.clock.now += 2 * 3600 * 1000;
    const updateAlert = GEMINI_DEVS_ALERT
      .replace('New / not previously reported over the past 14 days', 'Ongoing Issue')
      .replace(',New / not previously reported over the past 14 days', ',Ongoing Issue')
      .replace('[KOF]: No', '[KOF]: Viral KOFs (KOFs)')
      .replace('dev_sec_researcher', 'kof_sec_lead')
      .replace('2120000000000000101', '2120000000000000404');
    wThread.paste(updateAlert);
    const c2 = wThread.ctx();
    c2.switches = { noWait: true };
    wThread.bot.runOnce_(c2);

    const allSocial = wThread.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(allSocial.length, 2);
    eq(allSocial[1].threadId, thread1);
    assert.match(allSocial[1].subject, /^Re: .*Gemini Model, Devs Products \|/);
  });

  test('Group test emails switch (Control row 37 + Brand safety groups column C): ON sends ONE Social Alert with primary group test email in To: and additional group test emails in Cc:, skips groups with no test email, and OFF routes to live column B To: + Cc:', () => {
    const REAL_SFB = H.REAL;
    const MIRROR = 'spaces/AAQAmirror9';
    const t = e2e(null, { noWait: true, blankStandIn: true });
    t.chat.addSpace(MIRROR, 'SLRR Mirror Space', { external: false });
    t.bot.setup();

    // Populate the workbook's Brand safety groups tab with 3 columns: Group Name | Live Email | Test Email
    const bsg = t.sheet().insertSheet('Brand safety groups');
    const bsgValues = [
      ['Google Group Name', 'Google Group Email', 'Test Email'],
      ['Gemini Model', 'gemini-live@groups.test', 'gemini-tester@testing.test'],
      ['Devs Products', 'devs-live@groups.test', 'devs-tester@testing.test'],
      ['Search', 'search-live@groups.test', ''],  // intentionally NO test email set!
      ['GCPA', 'gcpa-live@groups.test', ''],
      ['Default CC', 'slrr-cc-live@groups.test', ''],
      ['Brand Social Sender', 'sender@groups.test', ''],
      ['T&S Urgent', 'tns-urgent-live@groups.test', ''],
    ];
    bsg.getRange(1, 1, bsgValues.length, 3).setValues(bsgValues);

    // Configure Mirror space + S-F Burson + Auto-send ON + Never wait ON, Safety valve OFF, and Group test emails (row 37) ON
    const ctrl = t.control();
    ctrl.getRange(9, 2).setValue(MIRROR);
    ctrl.getRange(25, 2).setValue(REAL_SFB);
    ctrl.getRange(11, 2).setValue('ON');  // Auto-send Social Alerts
    ctrl.getRange(23, 2).setValue('ON');  // Never wait on Burson
    ctrl.getRange(29, 2).setValue('OFF'); // Safety valve OFF — row 37 ON alone must enforce Testing!
    ctrl.getRange(30, 2).setValue('flat-b30@testing.test'); // Even if B30 has an email, row 37 ON uses Brand safety groups col C
    ctrl.getRange(37, 2).setValue('ON');  // Group test emails ON
    t.poll();

    assert.ok(!/^🔴 LIVE/.test(t.get('B5')), t.get('B5'));
    assert.match(ctrl.cell(37, 3), /^✓ ON · 🧪 Testing \(Brand safety groups column C\): .* \(2 groups set\)/);

    // 1. Post a 3-product alert ("Gemini Model, Devs Products, Search"):
    //    - Sends ONE single Social Alert email with ALL matched product test emails in Cc: (To: empty):
    //      To: []
    //      Cc: ['gemini-tester@testing.test', 'devs-tester@testing.test']
    //      Search (no Col C test email) -> logged as skipped!
    const threeProductAlert = GEMINI_DEVS_ALERT
      .replace('Gemini Model, Devs Products |', 'Gemini Model, Devs Products, Search |')
      .replace('[Product]: Gemini Model, Devs Products', '[Product]: Gemini Model, Devs Products, Search');
    t.chat.say(REAL_SFB, threeProductAlert, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();

    const sentTesting = t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(sentTesting.length, 1);
    eq(sentTesting[0].to, []);
    eq(sentTesting[0].cc, ['gemini-tester@testing.test', 'devs-tester@testing.test']);
    assert.match(sentTesting[0].subject, /Gemini Model, Devs Products, Search \| Gemini API Returning Unsafe Code Execution Snippets/);
    assert.ok(t.g.logs.some(l => /no test email set for Search in Brand safety groups/.test(l)),
      'expected missing Search test email to be logged');

    // 2. Post a single-product alert for Search (which has NO test email in column C):
    //    - Sends 0 additional emails, logs the skip, marks skipped_no_test_email, and does NOT loop on next poll()
    const singleSearchAlert = GEMINI_DEVS_ALERT
      .replace('Gemini Model, Devs Products | Gemini API Returning Unsafe Code Execution Snippets', 'Search | Search Ranking Bug Reported')
      .replace('[Name]: Gemini API Returning Unsafe Code Execution Snippets', '[Name]: Search Ranking Bug Reported')
      .replace('[Product]: Gemini Model, Devs Products', '[Product]: Search')
      .replace('dev_sec_researcher', 'search_reporter_99')
      .replace('2120000000000000101', '2120000000000000888');
    t.chat.say(REAL_SFB, singleSearchAlert, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();
    t.poll();
    const afterSkippedSingle = t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(afterSkippedSingle.length, 1);
    const searchRow = t.bot.sheetBackend_(t.sheet()).loadAlerts().find(r => /2120000000000000888/.test(String(r.record_key || '')));
    assert.ok(searchRow);
    eq(searchRow.email_status, 'skipped_no_test_email');
    eq(searchRow.email_error, 'no test email set in Brand safety groups for Search');

    // 3. Turn Group test emails (row 37) OFF while leaving test emails in Column C:
    //    - Bot is now LIVE (Safety valve row 29 is OFF, B26 blank, S-F Burson set)
    //    - A new 3-product alert sends ONE single live Social Alert email with ALL product teams in Cc: (To: empty):
    ctrl.getRange(37, 2).setValue('OFF');
    const liveThreeProductAlert = [
      '\ud83d\udea8THIS ALERT MEETS P0 CRITERIA\ud83d\udea8',
      '',
      '\ud83d\udfe5SOCIAL ALERT\ud83d\udfe5: Gemini Model, Devs Products, Search | Widespread Cloud Auth Token Outage | X | 5400 Engagements',
      '[Name]: Widespread Cloud Auth Token Outage / New / not previously reported over the past 14 days',
      '[Engagement]: HIGH (5400 engagements)',
      '[Product]: Gemini Model, Devs Products, Search',
      '[Social Network]: X',
      '[Exposure Tag]: Product - Dangerous results (e.g. medical/legal)',
      '[Sensitive Topic]: Malicious & Unwanted Software',
      '[KOF]: No',
      '',
      'X user @infra_status_watch (91,000 followers) shared error logs showing authentication token failures across Gemini endpoints, Developer SDKs, and Search grounding APIs.',
      '',
      '[Link]: https://x.com/infra_status_watch/status/2120000000000000999',
      '',
      '[Time/Date Post Went Live]: October 13, 2026, 10:05 AM',
      '',
      '[Code]: Product - Dangerous results (e.g. medical/legal),5400,infra_status_watch,Malicious & Unwanted Software,Gemini Model,New / not previously reported over the past 14 days',
    ].join('\n');
    t.chat.say(REAL_SFB, liveThreeProductAlert, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();

    const allSocialNow = t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    const liveSent = allSocialNow.slice(1);
    eq(liveSent.length, 1);
    eq(liveSent[0].to, []);
    assert.ok(liveSent[0].cc.includes('gemini-live@groups.test'), `expected gemini-live in CC: ${liveSent[0].cc}`);
    assert.ok(liveSent[0].cc.includes('devs-live@groups.test'), `expected devs-live in CC: ${liveSent[0].cc}`);
    assert.ok(liveSent[0].cc.includes('search-live@groups.test'), `expected search-live in CC: ${liveSent[0].cc}`);
    assert.ok(liveSent[0].cc.includes('slrr-cc-live@groups.test'));
    assert.ok(!liveSent[0].cc.includes('gemini-tester@testing.test') && !liveSent[0].cc.includes('devs-tester@testing.test'));
  });

  test('SheetTestAlert.gs + sidepanel 🧪 Test Alert menu: posts multi-product alert into test Chat space, picks up from Chat, and sends ONE Social Alert email with ALL product teams in Cc: (and single-product in To:)', () => {
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const REAL_SFB = H.REAL;
    const AC_SPACE = 'spaces/AAQAacsheet';
    const t = e2e(null, { noWait: true, blankStandIn: true });
    t.chat.addSpace(AC_SPACE, 'SLRR Agentic Assistant', { external: false });
    t.bot.setup();

    const ss = t.sheet();
    const bsg = ss.insertSheet('Brand safety groups');
    const bsgValues = [
      ['Google Group Name', 'Google Group Email', 'Test Email'],
      ['Gemini App', 'gemini-app-live@groups.test', 'gemini-app-qa@testing.test'],
      ['Waymo', 'waymo-live@groups.test', 'waymo-qa@testing.test'],
      ['Executives', 'exec-live@groups.test', 'exec-qa@testing.test'],
      ['Cloud', 'cloud-live@groups.test', ''],  // no test email set
      ['Brand Social Sender', 'sender@groups.test', ''],
    ];
    bsg.getRange(1, 1, bsgValues.length, 3).setValues(bsgValues);

    // Standalone B10 mode (B3, B4, B9 blank; B10 set; Group test emails row 37 ON)
    const ctrl = t.control();
    ctrl.getRange(3, 2).setValue('');
    ctrl.getRange(4, 2).setValue('');
    ctrl.getRange(9, 2).setValue('');
    ctrl.getRange(10, 2).setValue(AC_SPACE);
    ctrl.getRange(25, 2).setValue(REAL_SFB);
    ctrl.getRange(29, 2).setValue('ON');
    ctrl.getRange(37, 2).setValue('ON');

    // First poll auto-creates the Test alert tab right next to Brand safety groups
    t.poll();
    const testSh = ss.getSheetByName('Test alert');
    assert.ok(testSh, 'Test alert tab should be auto-created when Brand safety groups exists');
    assert.ok(t.bot.isTestAlertTab_(testSh));
    eq(testSh.cell(2, 2), 'Idle');

    let active = ss.sheets[0];
    const toasts = [];
    const panelCtx = vm.createContext({
      console,
      SpreadsheetApp: Object.assign({}, t.g.services.SpreadsheetApp, {
        getActiveSpreadsheet: () => Object.assign(ss, {
          getActiveSheet: () => active,
          setActiveSheet: sh => { active = sh; return sh; },
          toast: msg => { toasts.push(msg); },
        }),
        getUi: () => ({
          createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() { return this; } }),
          showSidebar: () => {},
        }),
      }),
      HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; } }) }) },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script-sheet-sidepanel', 'Code.gs'), 'utf8'), panelCtx);

    testSh.getRange(5, 2).setValue('Gemini App');
    testSh.getRange(6, 2).setValue('Waymo');
    testSh.getRange(7, 2).setValue('Executives');
    testSh.getRange(8, 2).setValue('Cloud');
    const q1 = panelCtx.sendSheetTestAlert();
    eq(q1.queued, true);
    eq(plain(q1.products), ['Gemini App', 'Waymo', 'Executives', 'Cloud']);
    eq(testSh.cell(2, 2), 'SEND NOW');

    // Step 1 verification: postSheetTestAlert_ ONLY posts the SOCIAL ALERT into the test Chat space (zero emails sent yet!)
    const wanted1 = t.bot.readControl_(ctrl);
    const sfb1 = t.bot.sfBursonFor_(ctrl, wanted1);
    const posted1 = t.bot.postSheetTestAlert_(ss, wanted1, sfb1);
    eq(posted1.posted, true);
    eq(posted1.spaceId, AC_SPACE);
    eq(testSh.cell(2, 2), 'Idle');
    assert.match(testSh.cell(2, 3), /^📨 Posted to SLRR Agentic Assistant/);
    eq(t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject)).length, 0);
    const chatAlertMsg = t.chat.message(posted1.messageName);
    assert.ok(chatAlertMsg && /🟧SOCIAL ALERT🟧: Gemini App, Waymo, Executives, Cloud/.test(chatAlertMsg.text));

    // Step 2 verification: next Chat poll picks up that posted alert FROM the test Chat space, reacts on it,
    // and sends ONE single Social Alert email with ALL matched products in Cc: (To: empty)!
    t.poll();
    assert.match(testSh.cell(2, 3), /^✅ Picked up in Chat & Sent at /);
    assert.match(testSh.cell(3, 2), /Cc: gemini-app-qa@testing\.test, waymo-qa@testing\.test, exec-qa@testing\.test/);
    assert.match(testSh.cell(3, 2), /skipped \(no Test Email in Brand safety groups Col C\): Cloud/);

    const sent1 = t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(sent1.length, 1);
    eq(sent1[0].to, []);
    eq(sent1[0].cc, ['gemini-app-qa@testing.test', 'waymo-qa@testing.test', 'exec-qa@testing.test']);
    assert.ok(t.chat.reactionsOn(posted1.messageName).some(r => r[1] === '📦'));
    eq(t.chat.botPosts(REAL_SFB).length, 0);

    // Single-product alert ("Waymo" alone) still uses To:
    panelCtx.clearExtraTestProducts();
    eq([testSh.cell(6, 2), testSh.cell(7, 2), testSh.cell(8, 2)], ['', '', '']);
    testSh.getRange(5, 2).setValue('Waymo');
    panelCtx.sendSheetTestAlert();
    t.poll();
    const sent2 = t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(sent2.length, 2);
    eq(sent2[1].to, ['waymo-qa@testing.test']);
    eq(sent2[1].cc, []);

    // Multi-product regression: Product 1 = Executives + Gemini App + Waymo + low Engagements (500) -> ALL 3 go in Cc: (To: empty)
    testSh.getRange(5, 2).setValue('Executives');
    testSh.getRange(6, 2).setValue('Gemini App');
    testSh.getRange(7, 2).setValue('Waymo');
    testSh.getRange(16, 2).setValue('500');
    panelCtx.sendSheetTestAlert();
    t.poll();
    const sent3 = t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(sent3.length, 3);
    eq(sent3[2].to, []);
    eq(sent3[2].cc, ['exec-qa@testing.test', 'gemini-app-qa@testing.test', 'waymo-qa@testing.test']);
    assert.match(sent3[2].text, /Would have gone to: Cc: Executives(?: alert POCs)?, Gemini App alert POCs, Waymo alert POCs/);

    // Tab ownership safeguard: refuses to overwrite or read a custom user tab named "Test alert"
    const ssCustom = new H.FakeSpreadsheet('custom-sheet', 'User Workbook');
    const customTab = ssCustom.insertSheet('Test alert');
    customTab.getRange(1, 1).setValue('My Custom Notes');
    customTab.getRange(2, 2).setValue('SEND NOW');
    eq(t.bot.isTestAlertTab_(customTab), false);
    eq(t.bot.ensureTestAlertTab_(ssCustom), null);
    eq(customTab.cell(1, 1), 'My Custom Notes');
  });

  test('B10 throughput & cursor safety: pollAnalystMessages_ flags analyst_backlog when Watch/BQ cards hit deadline and never advances analyst_cursor past a failed card when answering a question', () => {
    const w = world({ noWait: true });
    const ctx = Object.assign(w.ctx(), {
      sourceReadOnly: true,
      outboundBlocked: false,
      botUser: 'users/bot99',
    });
    const ANA = ctx.spaces.analyst.id;

    // Post an ingested Direct-BQ card that will fail during handleAlert_ (t1), followed by a human question (t2)
    const bqCardText = GEMINI_DEVS_ALERT.replace('[Product]: Gemini Model, Devs Products', '[Product]: Waymo');
    w.g.clock.now += 1000;
    const mCard = w.g.chat.say(ANA, bqCardText, { sender: 'users/bot99', type: 'BOT' });
    const cardCreateTime = Date.parse(mCard.createTime);
    w.g.props.set('BQ_INGESTED_MSGS', JSON.stringify([[w.bot.hashText_(mCard.name), 'BSIP']]));
    w.g.clock.now += 4000;
    w.g.chat.say(ANA, 'What is the exposure tag rule here?', {
      sender: 'users/human1',
      type: 'HUMAN',
      displayName: 'Analyst Jane',
    });

    // 1. Deadline already reached while mCard is waiting -> flags analyst_backlog + time budget error
    const expiredCtx = Object.assign({}, ctx, { deadline: w.g.clock.now - 1 });
    const expiredReport = { seen: 0, handled: 0, alerts: 0, answers: 0, errors: [] };
    w.bot.pollAnalystMessages_(expiredCtx, expiredReport);
    eq(expiredReport.analyst_backlog, true);
    assert.ok(expiredReport.errors.some(e => /^time budget/.test(e)));

    // 2. Transient error on mCard (t1) while later human question (t2) succeeds -> cursor must NOT jump past mCard!
    const realNextId = ctx.store.nextAlertId.bind(ctx.store);
    ctx.store.nextAlertId = () => { throw new Error('transient sheet error'); };
    const report = { seen: 0, handled: 0, alerts: 0, answers: 0, errors: [] };
    w.bot.pollAnalystMessages_(ctx, report);
    ctx.store.nextAlertId = realNextId;

    eq(report.answers, 1);
    eq(report.analyst_backlog, true);
    const savedCursor = Number(ctx.memo.get('analyst_cursor') || 0);
    assert.ok(savedCursor < cardCreateTime, `expected cursor (${savedCursor}) to stay before failed card (${cardCreateTime})`);
  });
};

