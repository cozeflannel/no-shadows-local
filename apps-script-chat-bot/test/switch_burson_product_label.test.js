// Burson's live alerts label the product line "[Product(s)]:", not "[Product]:". The bot must read that line as the
// product and, when it corrects the product or adds other products, rewrite THAT line in the corrected alert it posts
// (not only the "SOCIAL ALERT" line above it): the corrected alert has to read right on its own, and the note in its
// thread only says what was changed.
// The same for the rest of the live layout: its fixed lines are no part of the summary, a corrected summary replaces
// Burson's paragraph (and no line elsewhere that the bot doesn't know), a line the bot adds ([Link], [Timestamp]) goes
// before the reminder at the bottom, a corrected level keeps Burson's "(N engagement)", an empty label line gets its
// space, and the Social Alert email carries the corrected alert's own [Code].
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

  test('Burson\'s "[Product(s)]:" line is read as the product (so is "Google Product(s):"; the bare plurals "Products:" and "Google Products:" are not labels: a summary line can start with them), one product or several', () => {
    const index = B.labelIndex_();
    eq(['[Product(s)]: Brand', 'Product(s): Brand', '[Google Product(s)]: Brand', '[Product]: Brand', '[Google Product]: Brand']
      .map(l => { const hit = B.splitLabel_(l, index); return hit ? [hit.spec.name, hit.prefix, hit.value] : null; }),
    [['product', '[Product(s)]: ', 'Brand'], ['product', 'Product(s): ', 'Brand'],
      ['product', '[Google Product(s)]: ', 'Brand'], ['product', '[Product]: ', 'Brand'], ['product', '[Google Product]: ', 'Brand']]);
    eq(B.fieldSpec_('product').labels, ['Product', 'Google Product', 'Product(s)', 'Google Product(s)']);
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

  // -------------------------------------------------------------------------------------------------------------
  // The rest of the live layout: its fixed lines, its summary paragraph, its engagement line, its [Code] line
  // -------------------------------------------------------------------------------------------------------------

  const PARA = 'Instagram user exampleteacher (5.8K followers) criticized Google\'s push for AI adoption in education.';
  const REWRITE = 'A teacher criticized the push for AI tools in schools.';
  const FIXED_LINES = ['Automated Alert via Burson (beta)',
    'Note: This is an automated message, all alerts can be found in Brand Safety Tracking (go/Brand-Safety-Tracking)',
    'Do Not Forward - NTK only', 'This alert does not meet the defined Collection Requirements', 'Click here for link to post'];
  const summaryFix = { checks: [{ id: 'summary_grammar', ok: false, confidence: 0.95, finding: 'The summary can be plainer.', proposed_value: REWRITE }] };

  test('Burson\'s live layout: its fixed lines (the "Automated Alert via Burson" title, the automated-message note, "Do Not Forward", the Collection Requirements line, "Click here for link to post") are no part of the summary: the summary is the paragraph alone (in the Social Alert email too), a corrected summary replaces that paragraph in the corrected alert, and the fixed lines stay as Burson wrote them', () => {
    const text = live('Brand', '[Product(s)]: Brand');
    FIXED_LINES.forEach(l => assert.ok(text.split('\n').includes(l), l));
    const parsed = B.parseAlert_(text);
    eq(parsed.fields.summary, PARA);
    // ... as the email shows it: the summary is the first thing under "SOCIAL ALERT"
    const emailText = B.socialAlertText_(B.emailValues_({ fields: parsed.fields, escalation: {} }));
    assert.ok(emailText.indexOf(`SOCIAL ALERT\n\n${PARA}\n\nLink: https://www.instagram.com/p/DPq1aBcDeFg/`) === 0, emailText.slice(0, 300));
    // the review's summary correction lands in the alert: only the paragraph's line changes
    const r = B.reviewAlert_(parsed, { now: NOW, history: [], llm: summaryFix });
    assert.ok(r.fixes.some(x => x.field === 'summary' && x.new === REWRITE), JSON.stringify(r.fixes.map(x => x.field)));
    const out = B.rebuildAlert_(text, parsed, r.fields, r.changed);
    eq([lineOf(out, 'A teacher'), out.includes(PARA)], [REWRITE, false]);
    eq(out.split('\n').map((l, i) => (l !== text.split('\n')[i] ? i : -1)).filter(i => i >= 0), [text.split('\n').indexOf(PARA)]);
    // the same alert with no blank lines between its parts (as some arrive)
    const tight = text.split('\n').filter(Boolean).join('\n');
    const tp = B.parseAlert_(tight);
    eq([tp.fields.summary, B.rebuildAlert_(tight, tp, Object.assign({}, tp.fields, { summary: REWRITE }), ['summary'])], [PARA, tight.replace(PARA, REWRITE)]);
    // the fixed lines with Chat's bold marks, and a line that only starts like one of them, which is words of a summary
    const bold = B.parseAlert_(text.replace('Do Not Forward - NTK only', '*Do Not Forward - NTK only*'));
    eq(bold.fields.summary, PARA);
    const words = B.parseAlert_(text.replace(PARA, 'Noted: This is an automated message from a bot account, the user claims.'));
    eq(words.fields.summary, 'Noted: This is an automated message from a bot account, the user claims.');
  });

  test('a corrected summary is written into the corrected alert also when Burson\'s paragraph can\'t be found there as one piece (a hyperlink in it, which the summary reads as its address; two paragraphs; a line Burson adds that the bot doesn\'t know yet): the summary\'s own lines are replaced, never left as they were under a note that says the summary was updated', () => {
    const base = live('Brand', '[Product(s)]: Brand');
    const rebuilt = text => {
      const p = B.parseAlert_(text);
      return B.rebuildAlert_(text, p, Object.assign({}, p.fields, { summary: REWRITE }), ['summary']);
    };
    const diff = (a, b) => [a.split('\n').filter(l => !b.split('\n').includes(l)), b.split('\n').filter(l => !a.split('\n').includes(l))];
    // a hyperlink in the paragraph (Chat's markup): the parsed summary has its address, the text has the markup
    const LINKED = 'Instagram user exampleteacher (5.8K followers) criticized Google <https://example.testing.test/a|in this post>.';
    const linked = base.replace(PARA, LINKED);
    eq(B.parseAlert_(linked).fields.summary, 'Instagram user exampleteacher (5.8K followers) criticized Google https://example.testing.test/a.');
    eq(diff(linked, rebuilt(linked)), [[LINKED], [REWRITE]]);
    // two paragraphs, a blank line between them: the one new summary takes their place
    const TWO = ['Instagram user exampleteacher (5.8K followers) criticized Google.', '', 'The post calls for a protest outside schools.'];
    const two = base.replace(PARA, TWO.join('\n'));
    eq(B.parseAlert_(two).fields.summary, [TWO[0], TWO[2]].join('\n'));
    eq([diff(two, rebuilt(two)), rebuilt(two).split('\n').length - two.split('\n').length], [[[TWO[0], TWO[2]], [REWRITE]], -2]);
    // a line the bot doesn't know, away from the paragraph: it is read with the summary (as before), and stays where
    // and as Burson wrote it; the paragraph is what the new summary replaces
    const extra = `Internal: for the on-call IM\n${base}`;
    eq(B.parseAlert_(extra).fields.summary, `Internal: for the on-call IM\n${PARA}`);
    eq(diff(extra, rebuilt(extra)), [[PARA], [REWRITE]]);
    // found as one piece, it is replaced as it always was (a bullet before it stays)
    const bullet = base.replace(PARA, `- ${PARA}`);
    eq(diff(bullet, rebuilt(bullet)), [[`- ${PARA}`], [`- ${REWRITE}`]]);
  });

  test('a corrected summary, when Burson\'s paragraph isn\'t found as one piece, replaces the lines in Burson\'s place for the summary (below the "SOCIAL ALERT" line, above the [Link] line, the reminder or the [Code] line) and no others: lines the bot doesn\'t know above the title, among the footers or at the very end stay as Burson wrote them, also when they are longer than the summary; with nothing in the summary\'s place the alert is left as it is', () => {
    const base = live('Brand', '[Product(s)]: Brand');
    const rebuilt = text => {
      const p = B.parseAlert_(text);
      return B.rebuildAlert_(text, p, Object.assign({}, p.fields, { summary: REWRITE }), ['summary']);
    };
    const diff = (a, b) => [a.split('\n').filter(l => !b.split('\n').includes(l)), b.split('\n').filter(l => !a.split('\n').includes(l))];
    const only = text => [diff(text, rebuilt(text)), rebuilt(text).split('\n').length - text.split('\n').length];
    // two new fixed lines above the title, together longer than the paragraph: read with the summary (the bot doesn't
    // know them), and both still there, where they were; the paragraph is what changes
    const TOP = ['Reviewed by the Burson Brand Safety desk (24/7 coverage)',
      'Escalation contacts and the alert archive are in the Brand Safety Tracking sheet'];
    const top = `${TOP.join('\n')}\n${base}`;
    assert.ok(TOP.join('').length > PARA.length);
    eq(B.parseAlert_(top).fields.summary, TOP.concat([PARA]).join('\n'));
    eq([only(top), rebuilt(top).split('\n').slice(0, 3)], [[[[PARA], [REWRITE]], 0], TOP.concat(['Automated Alert via Burson (beta)'])]);
    // through the review, as a run does it (Gemini's rewrite of the summary), the same
    const p = B.parseAlert_(top);
    const r = B.reviewAlert_(p, { now: NOW, history: [], llm: summaryFix });
    assert.ok(r.fixes.some(x => x.field === 'summary' && x.new === REWRITE), JSON.stringify(r.fixes.map(x => x.field)));
    eq(diff(top, B.rebuildAlert_(top, p, r.fields, r.changed)), [[PARA], [REWRITE]]);
    // one line longer than the paragraph: at the very end (under "Click here for link to post"), among the footers
    // (under the reminder), and between the top lines and the "SOCIAL ALERT" line
    const LONG = 'Questions about this alert? Reply in this thread and the Burson Brand Safety desk will answer within the hour, day or night.';
    assert.ok(LONG.length > PARA.length);
    eq(only(`${base}\n${LONG}`), [[[PARA], [REWRITE]], 0]);
    eq(only(base.replace('go/SLRR-Database.', `go/SLRR-Database.\n${LONG}`)), [[[PARA], [REWRITE]], 0]);
    eq(only(base.replace('Collection Requirements\n', `Collection Requirements\n${LONG}\n`)), [[[PARA], [REWRITE]], 0]);
    // ... and with a hyperlink in the paragraph too, and no [Link] line (the reminder ends the summary's place)
    const LINKED = 'Instagram user exampleteacher (5.8K followers) criticized Google <https://example.testing.test/a|in this post>.';
    eq(only(`${TOP.join('\n')}\n${base.replace(PARA, LINKED)}`), [[[LINKED], [REWRITE]], 0]);
    eq(only(`${base}\n${LONG}`.replace('[Link]: https://www.instagram.com/p/DPq1aBcDeFg/\n\n', '')), [[[PARA], [REWRITE]], 0]);
    // an alert with no "SOCIAL ALERT" line (the older layout without it: the place starts under its first labelled
    // line), a hyperlink in its paragraph and a line above it that is longer than the paragraph
    const WORDY = `${LONG} ${LONG} ${LONG}`;
    const AIO_PARA = F.AIO.split('\n').find(l => l.indexOf('An X user') === 0);
    const AIO_LINKED = AIO_PARA.replace('a screenshot', '<https://example.testing.test/a|a screenshot>');
    const older = `${WORDY}\n${F.AIO.replace('SOCIAL ALERT:\n', '').replace(AIO_PARA, AIO_LINKED)}`;
    assert.ok(WORDY.length > AIO_PARA.length && B.parseAlert_(older).extra.header_line === undefined);
    eq(only(older), [[[AIO_LINKED], [REWRITE]], 0]);
    // nothing in the summary's place (no paragraph; the one line the bot doesn't know stands above the title, with a
    // hyperlink in it, so it isn't found as one piece): Burson's line is not overwritten, the alert is as it was
    const none = `Reviewed by <https://example.testing.test/a|the desk> today\n${base.replace(`${PARA}\n\n`, '')}`;
    eq([B.parseAlert_(none).fields.summary, rebuilt(none) === none], ['Reviewed by https://example.testing.test/a today', true]);
  });

  test('a line the bot adds to a live-layout alert (the "[Link]" it found: Auto-find missing links; the "[Timestamp]" it added: Never wait on Burson) goes where it goes in every layout, before the reminder at the bottom ("As a reminder, all alerts can be found ..."): never above Burson\'s title, whose fixed lines are no reminder', () => {
    const URL = 'https://www.instagram.com/p/DPq1aBcDeFg/';
    const text = live('Brand', '[Product(s)]: Brand');
    const noLink = text.replace(`[Link]: ${URL}\n\n`, '');
    eq([noLink.indexOf('[Link]'), noLink.indexOf('Automated Alert via Burson'), noLink.includes(`${PARA}\n\nAs a reminder, `)], [-1, 0, true]);
    const found = { post_url: { old: '', new: URL } };
    const stamp = [{ video_timestamp: '03:13' }, ['video_timestamp']];
    // the link the bot found: on its own line where Burson's would be, so the alert reads as Burson's with a link does
    eq(B.withFoundLink_(noLink, found), text);
    // the timestamp alone: right under the summary, above the blank line before the reminder
    eq(B.withTimestamp_(noLink, stamp[0], stamp[1]), noLink.replace(`${PARA}\n`, `${PARA}\n[Timestamp]: 03:13\n`));
    // both, as a run adds them (the link, then the timestamp above it)
    eq(B.withTimestamp_(B.withFoundLink_(noLink, found), stamp[0], stamp[1]), text.replace(`[Link]: ${URL}`, `[Timestamp]: 03:13\n[Link]: ${URL}`));
    // the first line is Burson's title in each
    [B.withFoundLink_(noLink, found), B.withTimestamp_(noLink, stamp[0], stamp[1])].forEach(out => eq(out.split('\n')[0], 'Automated Alert via Burson (beta)'));
    // the older layout is as it was
    eq(B.withFoundLink_(F.NO_LINK, { post_url: { old: '', new: 'https://x.com/WasSamLowryEsq/status/2109952063492993159' } }), F.P0_OK);
    // the reminder's lines (RX_FOOTER_) are, word for word, the first of the lines the alert's reading skips
    // (RX_BOILERPLATE_): a footer added to one list and not to the other would be read into the summary, or not found here
    eq(B.ev('RX_BOILERPLATE_').source.indexOf(`${B.ev('RX_FOOTER_').source.slice(0, -1)}|`), 0);
  });

  test('a line of the summary that starts "Google products:" or "Products:" (a boycott list in the post, say) is words of the summary, never the alert\'s product: the product, its other products and so the routing stay the labelled line\'s, the lines stay in the summary, and the product is still corrected', () => {
    const index = B.labelIndex_();
    eq(['Google products: Gmail, Maps, YouTube', 'Products: Gems and Chromebooks', '[Products]: Brand', '[Google Products]: Brand',
      'Amazon products: Alexa, Ring'].map(l => B.splitLabel_(l, index)), [null, null, null, null, null]);
    eq(B.splitLabel_('[Other Google Products]: Search', index).spec.name, 'other_products');
    const LIST = ['Instagram user exampleteacher (5.8K followers) shared a boycott list:', 'Google products: Gmail, Maps, YouTube',
      'Amazon products: Alexa, Ring'];
    const boycott = B.parseAlert_(live('Brand', '[Product(s)]: Brand').replace(PARA, LIST.join('\n')));
    eq([boycott.fields.product, boycott.fields.other_products || [], boycott.fields.product_targets || [], boycott.fields.summary],
      ['Brand', [], [], LIST.join('\n')]);
    // a wrong product on the labelled line is corrected as ever, whatever the summary says of products
    const gems = live('Gems', '[Product(s)]: Gems').replace(PARA, `${PARA}\nProducts: Gems and Chromebooks are named in the caption.`);
    const p = B.parseAlert_(gems);
    eq(p.fields.product, 'Gems');
    const r = B.reviewAlert_(p, { now: NOW, history: [] });
    assert.ok(r.fixes.some(x => x.field === 'product' && x.new === 'Gemini App'), JSON.stringify(r.fixes));
    const out = B.rebuildAlert_(gems, p, r.fields, r.changed);
    eq([lineOf(out, '[Product(s)]:'), lineOf(out, 'Products:')], ['[Product(s)]: Gemini App', 'Products: Gems and Chromebooks are named in the caption.']);
  });

  test('a label line Burson left empty ("[Product(s)]:" with nothing after the colon) is rebuilt with a space after the colon, like every other line: "[Product(s)]: Gemini App", never "[Product(s)]:Gemini App"; a line that has a value keeps its own spacing', () => {
    const empty = live('Gems', '[Product(s)]:');
    const p = B.parseAlert_(empty);
    eq(p.fields.product, 'Gems');  // from the "SOCIAL ALERT" line
    const fixed = B.rebuildAlert_(empty, p, Object.assign({}, p.fields, { product: 'Gemini App' }), ['product']);
    eq(lineOf(fixed, '[Product(s)]'), '[Product(s)]: Gemini App');
    // any field: an empty Sensitive Topic line that gets a value
    const topic = live('Brand', '[Product(s)]: Brand').replace('[Sensitive Topic]: Child Safety', '[Sensitive Topic]:');
    const tp = B.parseAlert_(topic);
    eq(lineOf(B.rebuildAlert_(topic, tp, Object.assign({}, tp.fields, { risk_tags: ['Child Safety'] }), ['risk_tags']), '[Sensitive Topic]'),
      '[Sensitive Topic]: Child Safety');
    // Burson's own spacing after the colon is kept where there is a value: two spaces on its [Name] line, none here
    const name = B.rebuildAlert_(topic, tp, Object.assign({}, tp.fields, { issue_name: 'School protest' }), ['issue_name']);
    eq(lineOf(name, '[Name]'), '[Name]:  School protest / Ongoing Issue');
    const noSpace = topic.replace('[KOF]: No', '[KOF]:No').replace('[Social Network]: Instagram', '[Social Network]:Instagram');
    const np = B.parseAlert_(noSpace);
    eq(lineOf(B.rebuildAlert_(noSpace, np, Object.assign({}, np.fields, { social_network: 'X' }), ['social_network']), '[Social Network]'),
      '[Social Network]:X');
  });

  test('correcting the engagement level keeps what Burson wrote in the parentheses ("(373 engagement)", "(3,111 engagement)"): only the level changes, and the count when it was corrected too', () => {
    const text = live('Brand', '[Product(s)]: Brand');
    const p = B.parseAlert_(text);
    eq([p.fields.engagement_level, p.fields.total_engagement], ['LOW', 373]);
    const level = B.rebuildAlert_(text, p, Object.assign({}, p.fields, { engagement_level: 'MODERATE' }), ['engagement_level']);
    eq(lineOf(level, '[Engagement]'), '[Engagement]: MODERATE (373 engagement)');
    // a count with its comma, as Burson's alerts have it
    const comma = text.replace('LOW (373 engagement)', 'LOW (3,111 engagement)').replace('| 373 Engagements', '| 3111 Engagements');
    const cp = B.parseAlert_(comma);
    eq([cp.fields.total_engagement, lineOf(B.rebuildAlert_(comma, cp, Object.assign({}, cp.fields, { engagement_level: 'HIGH' }), ['engagement_level']), '[Engagement]')],
      [3111, '[Engagement]: HIGH (3,111 engagement)']);
    // the count corrected too: the new count, Burson's word
    const both = B.rebuildAlert_(text, p, Object.assign({}, p.fields, { engagement_level: 'HIGH', total_engagement: 2400 }), ['engagement_level', 'total_engagement']);
    eq(lineOf(both, '[Engagement]'), '[Engagement]: HIGH (2400 engagement)');
    // the layout with "engagements" is as it was
    const r = review(F.MISTAKES);
    eq(lineOf(B.rebuildAlert_(F.MISTAKES, B.parseAlert_(F.MISTAKES), r.fields, r.changed), '[Engagement]'), '[Engagement]: HIGH (29425 engagements)');
  });

  test('standalone Auto-correct space (B10; B9 and B4 blank; B25 the live space, read only; Testing): a live-layout alert with a wrong product, a wrong level and a summary Gemini rewrites is posted corrected in every line the note names (the summary paragraph, "[Product(s)]:", "[Engagement]:" with Burson\'s own "(N engagement)", the "SOCIAL ALERT" and [Code] lines), its fixed lines as Burson wrote them; and the Social Alert email carries the corrected summary and the corrected alert\'s own [Code]', () => {
    const t = e2e(null, { noWait: true });
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    const AC = 'spaces/AAQAautocorrect7';
    t.chat.addSpace(AC, 'SLRR Unified Auto-correct');
    t.set('B25', REAL);
    t.set('B3', `https://chat.google.com/app/chat/${AC.replace('spaces/', '')}`);
    t.set('B4', '');
    t.set('B9', '');
    t.set('B10', 'SLRR Unified Auto-correct');
    t.set('B29', 'ON');
    t.g.vertex.assess = () => summaryFix;
    t.poll();  // the Auto-correct flow starts reading the live space from here
    t.g.clock.now += 60 * 1000;
    const wrong = live('Gems', '[Product(s)]: Gems').replace('LOW (373 engagement)', 'LOW (29425 engagement)')
      .replace('| 373 Engagements', '| 29425 Engagements').replace(',373,exampleteacher,Child Safety,Brand,', ',29425,exampleteacher,Child Safety,Gems,');
    t.chat.say(REAL, wrong, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();
    const top = t.chat.botPosts(AC).filter(m => !m.threadReply && m.text.indexOf('Automated Alert via Burson') === 0);
    eq(top.length, 1);
    const CODE = 'Brand - Consumer boycotts & protests,29425,exampleteacher,Child Safety,Gemini App,Ongoing Issue';
    const was = wrong.split('\n');
    const now = top[0].text.split('\n');
    eq(now.length, was.length);
    eq(now.filter((l, i) => l !== was[i]), [
      '🟥SOCIAL ALERT🟥: Gemini App | "No to Big Tech in Our Schools" Protest | Instagram | 29425 Engagements',
      '[Engagement]: HIGH (29425 engagement)', '[Product(s)]: Gemini App', REWRITE, `[Code]: ${CODE}`]);
    FIXED_LINES.forEach(l => assert.ok(now.includes(l), l));
    const note = t.chat.botPosts(AC).find(m => m.threadReply && m.thread.name === top[0].thread.name && /^Updates made to this alert:/.test(m.text));
    assert.ok(note, 'the thread says what changed');
    ['- Product updated from Gems to Gemini App', `- Summary updated to "${REWRITE}"`].forEach(l => assert.ok(note.text.includes(l), note.text));
    // the Social Alert (only to the tester while Testing): the corrected summary first, and the corrected alert's code
    const social = t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(social.length, 1);
    assert.ok(social[0].text.indexOf(`SOCIAL ALERT\n\n${REWRITE}\n\nLink: https://www.instagram.com/p/DPq1aBcDeFg/`) >= 0, social[0].text.slice(0, 400));
    FIXED_LINES.forEach(l => assert.ok(social[0].text.indexOf(l) < 0, `the email has no "${l}"`));
    assert.ok(social[0].text.includes(`\nProduct: Gemini App\n`) && social[0].text.includes(`\nCode: ${CODE}`), social[0].text);
    assert.ok(social[0].html.includes(`utm_term=${encodeURIComponent(CODE)}`) && !/Gems/.test(social[0].html), 'the HTML has the corrected code too');
    eq(t.chat.botPosts(REAL), []);  // the live space is only read
  });
};
