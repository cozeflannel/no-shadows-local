'use strict';

module.exports = H => {
  const { test, eq, assert, B, e2e, NOW } = H;

  test('review fixes: Results tab ownership (Speed.gs isResultsTab_ / writeResultsTab_) refuses a custom Results tab without clearing it', () => {
    const t = e2e();
    t.bot.setup();
    const sh = t.sheet().insertSheet('Results');
    sh.getRange(1, 1, 1, 2).setValues([['My custom Results sheet', 'Notes']]);
    sh.getRange(2, 1, 1, 2).setValues([['keep', 'this']]);
    eq(t.bot.isResultsTab_(sh), false);
    assert.throws(() => t.bot.writeResultsTab_(sh, { posts: [], summary: {}, synopsis: '', now: NOW, stale: false }),
      /Results tab/);
    eq(sh.rows.slice(0, 2), [['My custom Results sheet', 'Notes'], ['keep', 'this']]);
  });

  test('review fixes: outbox leak guard (Outbox.gs outboxGuardHits_) catches internal terms while allowing generic bot words', () => {
    assert.ok(B.outboxGuardHits_('Check the outbox before sending.', []).length > 0);
    assert.ok(B.outboxGuardHits_('Our bot flagged this.', []).length > 0);
    assert.ok(B.outboxGuardHits_('The qa bot saw it.', []).length > 0);
    assert.ok(B.outboxGuardHits_('From the auto correct space.', []).length > 0);
    eq(B.outboxGuardHits_('The post comes from a bot account and a chatbot.', []), []);
  });

  test('review fixes: old pending emails (>24h) no longer count as alerted in earlierOutcome_', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const recent = { email_status: 'pending', created_at: NOW - 2 * 60 * 60 * 1000, action_taken: '' };
    const stale = { email_status: 'pending', created_at: NOW - 2 * DAY, action_taken: '' };
    eq(B.earlierOutcome_(recent, NOW), 'alerted');
    eq(B.earlierOutcome_(stale, NOW), '');
  });

  test('review fixes: SheetTestAlert.gs parseInt fallback preserves explicit 0 engagements', () => {
    const t = e2e();
    t.chat.addSpace('spaces/AAQAmirror1', 'SLRR Zapier Training Mirror');
    t.bot.setup();
    t.set('B25', 'https://chat.google.com/room/AAQAaa_0I9g');
    t.bot.startMirror('SLRR Zapier Training Mirror');
    const testTab = t.bot.ensureTestAlertTab_(t.sheet());
    testTab.getRange(2, 2).setValue('SEND NOW');
    testTab.getRange(16, 2).setValue('0');
    const wanted = t.bot.readControl_(t.control());
    const sfb = { space: { id: 'spaces/AAQAaa_0I9g', name: 'S-F Burson' } };
    const res = t.bot.postSheetTestAlert_(t.sheet(), wanted, sfb);
    eq(res.posted, true);
    const posted = t.chat.botPosts('spaces/AAQAmirror1');
    assert.ok(posted.some(m => /0 Engagements/.test(m.text)), 'explicit 0 engagements preserved');
  });
};
