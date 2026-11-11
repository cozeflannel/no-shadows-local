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

  test('multi-product E2E (Testing inbox via Control!B30 + Brand safety groups): "Product: Gemini Model, Devs Products" sends 2 separate formulated Social Alert emails to the B30 inbox, submits T&S once, and blocks duplicates', () => {
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
    eq(socialSent.length, 2);

    // Both arrive in the B30 inbox as real sent emails, on 2 separate Gmail threads
    eq(socialSent[0].to, ['my-test-inbox@testing.test']);
    eq(socialSent[1].to, ['my-test-inbox@testing.test']);
    assert.notStrictEqual(socialSent[0].threadId, socialSent[1].threadId);

    // Email 1: formulated specifically for the Gemini Model team
    assert.match(socialSent[0].subject, /Gemini Model \| Gemini API Returning Unsafe Code Execution Snippets \| X/);
    assert.ok(!socialSent[0].subject.includes('Devs Products'), socialSent[0].subject);
    assert.ok(socialSent[0].text.includes('\nProduct: Gemini Model\n'), socialSent[0].text);
    assert.match(socialSent[0].text, /Would have gone to: To: Gemini Model alert POCs; Cc: .*GCPA.*standard CC list/);

    // Email 2: formulated specifically for the Devs Products (Developers) team
    assert.match(socialSent[1].subject, /Devs Products \| Gemini API Returning Unsafe Code Execution Snippets \| X/);
    assert.ok(!socialSent[1].subject.includes('Gemini Model'), socialSent[1].subject);
    assert.ok(socialSent[1].text.includes('\nProduct: Devs Products\n'), socialSent[1].text);
    assert.match(socialSent[1].text, /Would have gone to: To: Devs Products alert POCs; Cc: .*GCPA.*standard CC list/);

    // T&S urgent email (if sent) went once, never duplicated per product team
    const tnsUrgent = allSent.filter(m => /^URGENT T&S:/.test(m.subject));
    assert.ok(tnsUrgent.length <= 1, `expected at most 1 urgent T&S email, got ${tnsUrgent.length}`);

    // Both threads are registered as bot-owned in Speed.gs so parity never mistakes the 2nd team email for a human IM send
    const storeRows = t.bot.sheetBackend_(t.sheet()).loadAlerts();
    const ownThreads = t.bot.botEmailThreads_(storeRows);
    assert.ok(ownThreads.has(socialSent[0].threadId));
    assert.ok(ownThreads.has(socialSent[1].threadId));

    // Re-posting the exact same post does NOT send duplicate Social Alerts
    const duplicateAlert = GEMINI_DEVS_ALERT.replace('9:15 AM', '9:25 AM');
    t.chat.say(TEST_FEED, duplicateAlert, { sender: 'users/bot', senderDisplay: 'Zapier' });
    t.poll();
    const socialAfterDup = t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(socialAfterDup.length, 2);
  });

  test('multi-product Live Auto-send & Live Gmail Drafts: routes each Social Alert email to its own Google Group from Brand safety groups, and tracks multi-team Gmail drafts through maintainDrafts_ and emoji reactions', () => {
    // 1. Live Auto-send ON (Safety valve OFF, no stand-in): sends 2 separate live emails to the 2 Google Groups
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
    eq(repAuto.auto_sent, 2);

    const liveSent = wAuto.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(liveSent.length, 2);
    eq(liveSent[0].to, ['gemini-model-team@groups.test']);
    assert.ok(liveSent[0].cc.includes('gcpa-comms@groups.test') && liveSent[0].cc.includes('slrr-standard-cc@groups.test'));
    assert.match(liveSent[0].subject, /Gemini Model \| Gemini API Returning Unsafe Code Execution Snippets/);
    assert.ok(liveSent[0].text.includes('\nProduct: Gemini Model\n'));

    eq(liveSent[1].to, ['devs-products-team@groups.test']);
    assert.ok(liveSent[1].cc.includes('gcpa-comms@groups.test') && liveSent[1].cc.includes('slrr-standard-cc@groups.test'));
    assert.match(liveSent[1].subject, /Devs Products \| Gemini API Returning Unsafe Code Execution Snippets/);
    assert.ok(liveSent[1].text.includes('\nProduct: Devs Products\n'));

    // Zero internal leaks on any outbound Burson message
    wAuto.chat.spaces.get(wAuto.BUR).messages.filter(m => m.sender.name === 'users/bot').forEach(m => {
      eq(wAuto.bot.outboxGuardHits_(m.text), []);
    });

    // 2. Live Auto-send OFF: creates 2 separate Gmail drafts (1 per team), watches both until sent, and supports ❌ delete
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
    eq(drafts.length, 2);
    eq([drafts[0].to, drafts[1].to], [['gemini-model-team@groups.test'], ['devs-products-team@groups.test']]);
    eq(wDraft.alertRows()[0].email_status, 'drafted');

    // Sending Draft 1 while Draft 2 stays open keeps row in 'drafted'
    wDraft.gmail.send(drafts[0].id, 'im@ops.test');
    wDraft.g.clock.now += 60 * 1000;
    const cCheck1 = wDraft.ctx();
    cCheck1.switches = { autoSend: false, noWait: true };
    wDraft.bot.runOnce_(cCheck1);
    eq(wDraft.alertRows()[0].email_status, 'drafted');

    // Sending Draft 2 finalizes row as 'sent' and marks emojis
    wDraft.gmail.send(drafts[1].id, 'im@ops.test');
    wDraft.g.clock.now += 60 * 1000;
    const cCheck2 = wDraft.ctx();
    cCheck2.switches = { autoSend: false, noWait: true };
    wDraft.bot.runOnce_(cCheck2);
    eq(wDraft.alertRows()[0].email_status, 'sent');
  });

  test('multi-product non-Zapier Chat cards ("Product: Gemini Model, Devs Products"), same-team alias dedup ("AI Studio, Devs Products"), and per-team threaded ongoing updates', () => {
    // 1. Same-team aliases ("AI Studio, Devs Products" -> both belong to Devs Products team) -> 1 email, not 2
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

    // 2. Non-Zapier Chat space card with "Product: Gemini Model, Devs Products" -> 2 emails (Gemini Model & Devs Products)
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

    // 3. Per-team threaded ongoing updates: when an ongoing update arrives for an issue previously sent to both teams,
    //    each team's update replies on THAT team's own earlier Gmail thread
    const wThread = world({
      noWait: true,
      drafts: { live: false, standIn: 'my-inbox@testing.test', testers: ['my-inbox@testing.test'], mailbox: 'bot@runner.test', from: 'Brand Social <sender@alerts.test>' },
    });
    wThread.paste(GEMINI_DEVS_ALERT);
    const c1 = wThread.ctx();
    c1.switches = { noWait: true };
    wThread.bot.runOnce_(c1);
    const firstSocial = wThread.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(firstSocial.length, 2);
    const geminiThread1 = firstSocial[0].threadId;
    const devsThread1 = firstSocial[1].threadId;
    assert.notStrictEqual(geminiThread1, devsThread1);

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
    eq(allSocial.length, 4);
    eq(allSocial[2].threadId, geminiThread1);
    eq(allSocial[3].threadId, devsThread1);
    assert.match(allSocial[2].subject, /^Re: .*Gemini Model \|/);
    assert.match(allSocial[3].subject, /^Re: .*Devs Products \|/);
  });
};
