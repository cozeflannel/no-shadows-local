// Burson's live alerts label the product line "[Product(s)]:", not "[Product]:". The bot must read that line as the
// product and, when it corrects the product or adds other products, rewrite THAT line in the corrected alert it posts
// (not only the "SOCIAL ALERT" line above it): the corrected alert has to read right on its own, and the note in its
// thread only says what was changed.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, NOW, e2e } = H;
  const REAL = 'spaces/AAQAaa_0I9g';
  const review = text => B.reviewAlert_(B.parseAlert_(text), { now: NOW, history: [] });
  const lineOf = (text, start) => String(text).split('\n').find(l => l.indexOf(start) === 0);

  // An alert laid out as Burson's live alerts are today (a made-up author and post)
  const live = (headerProducts, productLine) => [
    'Automated Alert via Burson (beta)',
    'Note: This is an automated message, all alerts can be found in Brand Safety Tracking (go/Brand-Safety-Tracking)',
    'Do Not Forward - NTK only',
    '',
    'This alert does not meet the defined Collection Requirements',
    '',
    `🟨SOCIAL ALERT🟨: ${headerProducts} | "No to Big Tech in Our Schools" Protest | Instagram | 373 Engagements`,
    '[Name]:  "No to Big Tech in Our Schools" Protest / Ongoing Issue',
    '[Engagement]: LOW (373 engagement)',
    productLine,
    '[Social Network]: Instagram',
    '[Exposure Tag]: Brand - Consumer boycotts & protests',
    '[Sensitive Topic]: Child Safety',
    '[KOF]: No',
    '',
    'Instagram user exampleteacher (5.8K followers) criticized Google\'s push for AI adoption in education.',
    '',
    '[Link]: https://www.instagram.com/p/DPq1aBcDeFg/',
    '',
    'As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.',
    '',
    '[Time/Date Post Went Live]:  11/14/2026,7:51 PM',
    '',
    '[Code]: Brand - Consumer boycotts & protests,373,exampleteacher,Child Safety,Brand,Ongoing Issue',
    '',
    'Click here for link to post',
  ].join('\n');

  test('Burson\'s "[Product(s)]:" line is read as the product (so are "Products:" and "Google Product(s):"), one product or several', () => {
    const index = B.labelIndex_();
    eq(['[Product(s)]: Brand', 'Product(s): Brand', '[Products]: Brand', '[Google Product(s)]: Brand', '[Google Products]: Brand', '[Product]: Brand']
      .map(l => { const hit = B.splitLabel_(l, index); return hit ? [hit.spec.name, hit.prefix, hit.value] : null; }),
    [['product', '[Product(s)]: ', 'Brand'], ['product', 'Product(s): ', 'Brand'], ['product', '[Products]: ', 'Brand'],
      ['product', '[Google Product(s)]: ', 'Brand'], ['product', '[Google Products]: ', 'Brand'], ['product', '[Product]: ', 'Brand']]);
    // the other-products labels are still their own field
    eq(B.splitLabel_('[Other Google Products]: Search', index).spec.name, 'other_products');

    const one = B.parseAlert_(live('Brand', '[Product(s)]: Brand'));
    eq([one.fields.product, one.fields.other_products || []], ['Brand', []]);
    const several = B.parseAlert_(live('Brand, Google for Education, Search', '[Product(s)]: Brand, Google for Education, Search'));
    eq([several.fields.product, several.fields.other_products], ['Brand', ['Google for Education', 'Search']]);
    // the line itself is read, not only the "SOCIAL ALERT" line: a product named only there is the alert's product
    const lineOnly = B.parseAlert_(live('Brand', '[Product(s)]: Search'));
    eq(lineOnly.fields.product, 'Search');
  });

  test('the corrected alert rewrites Burson\'s "[Product(s)]:" line itself: other products added, and a product corrected', () => {
    // other products added (the alert in the owner's report): the line and the "SOCIAL ALERT" line both list them
    const text = live('Brand', '[Product(s)]: Brand');
    const parsed = B.parseAlert_(text);
    const added = B.rebuildAlert_(text, parsed, Object.assign({}, parsed.fields, { other_products: ['Google for Education', 'Search'] }),
      ['other_products']);
    eq([lineOf(added, '[Product(s)]:'), lineOf(added, '🟨SOCIAL ALERT')], ['[Product(s)]: Brand, Google for Education, Search',
      '🟨SOCIAL ALERT🟨: Brand, Google for Education, Search | "No to Big Tech in Our Schools" Protest | Instagram | 373 Engagements']);
    // nothing else moved
    eq(added.split('\n').filter((l, i) => l !== text.split('\n')[i]).length, 2);

    // a product corrected: the line, the "SOCIAL ALERT" line and the [Code] line all carry the right product
    const wrong = F.MISTAKES.replace('[Product]: Gems', '[Product(s)]: Gems');
    const r = review(wrong);
    assert.ok(r.fixes.some(x => x.field === 'product' && x.new === 'Gemini App'), 'the product is corrected');
    const fixed = B.rebuildAlert_(wrong, B.parseAlert_(wrong), r.fields, r.changed);
    eq(fixed, F.MISTAKES_FIXED.replace('[Product]: Gemini App', '[Product(s)]: Gemini App'));
  });

  test('auto-correct space: a live alert with a wrong "[Product(s)]:" line is posted with that line corrected, and its thread says what changed', () => {
    const t = e2e(null, { noWait: true });
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.set('B25', REAL);
    t.set('B29', 'ON');
    const AC = 'spaces/AAQAautofx9';
    t.chat.addSpace(AC, 'SLRR Auto-correct Test');
    t.g.clock.now += 3600e3;
    t.bot.startAutoCorrect('SLRR Auto-correct Test');
    const wrong = F.MISTAKES.replace('[Product]: Gems', '[Product(s)]: Gems');
    t.chat.say(REAL, wrong, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();
    const top = t.chat.botPosts(AC).filter(m => !m.threadReply);
    const replies = t.chat.botPosts(AC).filter(m => m.threadReply);
    eq(top.map(m => m.text), [F.MISTAKES_FIXED.replace('[Product]: Gemini App', '[Product(s)]: Gemini App')]);
    assert.ok(replies.some(m => /^Updates made to this alert:\n- Product updated from Gems to Gemini App\n/.test(m.text)),
      'the thread says what changed');
    eq(t.chat.botPosts(REAL), []);  // the live space is only read
  });
};
