// The BSIP card's [KOF] line (BigQuery.gs formatBsipSonarAlertText_ with opts.kof, bsipKofValue_). The Direct BigQuery
// poll takes a BSIP post for its size or because its author is on one of the feed's influencer lists (the row's `kof`
// column), yet the card it posted always said "[KOF]: No". In the Auto-correct flow only (ctx.sourceReadOnly), and unless
// the setting requirement_line is off, the line now says what the feed says:
//   [KOF]: Yes (<the list's name, without its own brackets>)   when the column names a list that Alert.gs
//                                                             RX_NOT_KOF_LIST_ does not exclude
//   [KOF]: No                                                 otherwise (no list, a Google-owned channel, a Google rep)
// A card that says Yes is a KOF's alert for its review: it gets its Social Alert at any size, as Burson's alerts do.
// In the Mirror flow, in a test feed and with the setting off the card is byte for byte what it was. No query changes.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, world } = H;
  const golden = require('./golden_flows')(H);
  const TESTER = 'tester@testing.test';

  // A BSIP post under the Social Alert bar by itself (a P2 tag, 620 engagements) whose author is on a KOF list
  const KOF_URL = 'https://x.com/gadgetdesk/status/2160000000000000001';
  const kofRow = o => Object.assign({ source_kind: 'BSIP', id: '2160000000000000001', url: KOF_URL, handle: 'gadgetdesk', network: 'Twitter',
    alert_names_json: '["Pixel - Reliability"]', tags: 'Pixel camera | Product - Other/general criticism', criticality: 'HIGH', followers: 88000,
    total: 620, summary: 'An X user says the Google Pixel 10 camera app crashes every time they record video.',
    issue_name: 'Pixel 10 camera app crashes on video', language: 'en', post_time: '2026-10-14 11:40:00+00', kof: 'Viral KOFs (KOFs)' }, o || {});
  // ...and one of the same size from a Google-owned channel (the feed lists those too: no KOF)
  const OWNED_URL = 'https://x.com/madebyfans/status/2160000000000000002';
  const ownedRow = o => kofRow(Object.assign({ id: '2160000000000000002', url: OWNED_URL, handle: 'madebyfans', alert_names_json: '["Chrome"]',
    tags: 'Chrome tabs | Product - Other/general criticism', followers: 51000, total: 640,
    summary: 'An X user says the Chrome update closed every tab they had open.', issue_name: 'Chrome update closes every open tab',
    kof: 'Google Owned Channels' }, o || {}));
  // The KOF post's card as the builder made it before this change (written out from the code at 3be2e06)
  const BASE_CARD = [
    'THIS ALERT MEETS P2 CRITERIA · 🔷🔍 *[BigQuery · BSIP]*',
    '',
    '🟨SOCIAL ALERT🟨: Pixel | Pixel 10 camera app crashes on video | X | 620 Engagements',
    '[Name]: Pixel 10 camera app crashes on video / NEW',
    '[Engagement]: MODERATE (620 engagements)',
    '[Product]: Pixel',
    '[Social Network]: X',
    '[Exposure Tag]: Product - Other/general criticism',
    '[Sensitive Topic]: -',
    '[KOF]: No',
    '',
    'An X user says the Google Pixel 10 camera app crashes every time they record video.',
    '',
    `[Link]: ${KOF_URL}`,
    '',
    '[Time/Date Post Went Live]: 2026-10-14 11:40 UTC',
    '',
    '[Code]: Product - Other/general criticism,620,gadgetdesk,-,Pixel,NEW',
  ].join('\n');
  const KOF_LINE = '[KOF]: Yes (Viral KOFs KOFs)';
  const KOF_CARD = BASE_CARD.replace('[KOF]: No', KOF_LINE);

  // The poll's BSIP read with the feed's KOF column, in the order the query selects (BigQuery.gs bqBsipCandidates_)
  const BSIP_COLS = [['source_kind'], ['id'], ['url'], ['handle'], ['network'], ['alert_names_json'], ['tags'], ['criticality'],
    ['followers', 'INTEGER'], ['total', 'INTEGER'], ['summary'], ['issue_name'], ['language'], ['post_time'], ['kof']];
  /** Makes `g`'s BigQuery answer the poll's BSIP read with feed.bsip, the KOF column included; every other request as before. */
  function bsipFeed(g, others) {
    const feed = { bsip: [] };
    const inner = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      const isQuery = url.startsWith('https://bigquery.googleapis.com/') && /\/queries$/.test(url) &&
        String((params && params.method) || '').toLowerCase() === 'post';
      const sql = isQuery ? String(JSON.parse(params.payload).query || '') : '';
      if (!isQuery || (!/"BSIP" AS source_kind/.test(sql) && !others)) return inner(link, params);
      const [cols, rows] = /"BSIP" AS source_kind/.test(sql) ? [BSIP_COLS, feed.bsip] : [[['url']], []];
      const text = JSON.stringify({ jobComplete: true, schema: { fields: cols.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: rows.map(x => ({ f: cols.map(c => ({ v: x[c[0]] === undefined || x[c[0]] === null ? null : String(x[c[0]]) })) })) });
      return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => text };
    };
    return feed;
  }
  const cardsIn = (out, run) => out.chat.filter(m => m.run === run && !m.reply && /\*\[BigQuery · BSIP\]\*/.test(m.text));
  const rowsOf = t => t.bot.sheetBackend_(t.sheet()).loadAlerts();

  test('BSIP KOF line: the value. "Google Owned Channels" and a Google rep are no KOF: No. "Viral KOFs (KOFs)": Yes, with the name kept and its brackets taken out. A list without the words KOF or INF: Yes. Several lists: the ones that count, each name whole. No list at all: No. Without the flag the card says "[KOF]: No" whatever the feed says, exactly as before; with it only that one line differs', () => {
    const value = kof => B.bsipKofValue_(kof);
    eq(['Google Owned Channels', 'google owned channel', 'Google Reps', 'Google Rep (EMEA)', '', '   ', null, undefined, 'No', 'none', '-', 'n/a'].map(value),
      Array(12).fill('No'));
    eq([value('Viral KOFs (KOFs)'), value('Tech Reviewers'), value('CAM Tech/AI (INFs)'), value('I/O 2026 KOFs')],
      ['Yes (Viral KOFs KOFs)', 'Yes (Tech Reviewers)', 'Yes (CAM Tech/AI INFs)', 'Yes (I/O 2026 KOFs)']);
    // several lists (apart by a comma, a semicolon, a bar or a line break, as the parser splits a list of names): the ones
    // that count, each name whole; a comma inside a name's own brackets goes with the brackets
    eq([value('Exec following #4 (INFs), CAM Tech/AI (INFs)'), value('Google Owned Channels, Viral KOFs (KOFs)'),
      value('Viral KOFs (KOFs) | Tech Reviewers; Google Reps\nI/O 2026 KOFs'), value('KOFs (US, Tech)'), value('No Limits Creators (INFs)')],
    ['Yes (Exec following #4 INFs, CAM Tech/AI INFs)', 'Yes (Viral KOFs KOFs)', 'Yes (Viral KOFs KOFs, Tech Reviewers, I/O 2026 KOFs)',
      'Yes (KOFs US Tech)', 'Yes (No Limits Creators INFs)']);
    eq(B.ev('RX_NOT_KOF_LIST_').source, '^google (?:owned channels?|reps?\\b)');

    // the card: without the flag it is the card of before, whatever the row's KOF column says
    const card = (row, opts) => B.formatBsipSonarAlertText_(row, opts);
    eq([card(kofRow()), card(kofRow(), {}), card(kofRow(), { kof: false }), card(kofRow(), { kof: 'yes' }), card(kofRow({ kof: '' })),
      card(kofRow({ kof: 'Google Owned Channels' })), card(kofRow({ kof: undefined }))], Array(7).fill(BASE_CARD));
    // with it, the one line says what the feed says
    eq(card(kofRow(), { kof: true }), KOF_CARD);
    const diff = (a, b) => a.split('\n').map((line, i) => [line, b.split('\n')[i]]).filter(([x, y]) => x !== y);
    eq(diff(card(kofRow(), { kof: true }), BASE_CARD), [[KOF_LINE, '[KOF]: No']]);
    eq([card(kofRow({ kof: 'Google Owned Channels' }), { kof: true }), card(kofRow({ kof: '' }), { kof: true }), card(kofRow({ kof: null }), { kof: true })],
      Array(3).fill(BASE_CARD));
    eq(diff(card(kofRow({ kof: 'Tech Reviewers' }), { kof: true }), BASE_CARD), [['[KOF]: Yes (Tech Reviewers)', '[KOF]: No']]);
  });

  test('BSIP KOF line: the card with the new line is read back by the bot\'s own parser with the same fields as before, except KOF: the author is a KOF, on the list the feed named. Its review changes nothing on it (a "not a KOF" from Gemini is not taken against a list the feed named), and the Social Alert rule escalates it as a KOF\'s post at 620 engagements; the card of before, and the one of a Google-owned channel, stay below the bar', () => {
    const read = text => B.parseAlert_(text);
    const before = read(BASE_CARD);
    const after = read(KOF_CARD);
    assert.ok(B.detectAlert_(KOF_CARD, after, '') && B.detectAlert_(BASE_CARD, before, ''));
    eq([before.fields.kof, before.fields.kof_lists, after.fields.kof, after.fields.kof_lists], [false, undefined, true, ['Viral KOFs KOFs']]);
    const rest = p => Object.assign({}, p.fields, { kof: null, kof_lists: null });
    eq(rest(after), rest(before));
    eq([after.missing, after.flags, after.matched - before.matched], [before.missing, before.flags, 1]);  // one more field: the lists
    eq(B.recordKey_(after.fields), B.recordKey_(before.fields));
    // the names a list can have come back whole: two lists, one without the words KOF or INF, one with a slash
    const lists = kof => read(B.formatBsipSonarAlertText_(kofRow({ kof }), { kof: true })).fields;
    eq([lists('Exec following #4 (INFs), CAM Tech/AI (INFs)').kof_lists, lists('Tech Reviewers').kof_lists, lists('Tech Reviewers').kof,
      lists('Google Owned Channels').kof, lists('Google Owned Channels').kof_lists],
    [['Exec following #4 INFs', 'CAM Tech/AI INFs'], ['Tech Reviewers'], true, false, undefined]);
    // (written the way the feed has it, the name would be lost: what the brackets are taken out for)
    eq(read(BASE_CARD.replace('[KOF]: No', '[KOF]: Yes (Viral KOFs (KOFs))')).fields.kof_lists, undefined);

    // the review and the Social Alert rule
    const judged = (text, llm) => {
      const r = B.reviewAlert_(read(text), { now: NOW, history: [], llm });
      const esc = B.escalation_(r.fields, { now: NOW });
      return [r.fixes.map(x => x.field), r.fields.kof, r.fields.engagement_level, esc.escalated, esc.track, esc.reasons];
    };
    const NOT_KOF = { checks: [{ id: 'kof_fit', ok: false, confidence: 0.97, finding: 'Not a KOF author', proposed_value: 'No' }] };
    eq([judged(KOF_CARD), judged(KOF_CARD, NOT_KOF)], Array(2).fill([[], true, 'MODERATE', true, 'URGENT', ['KOF']]));
    eq([judged(BASE_CARD), judged(B.formatBsipSonarAlertText_(ownedRow(), { kof: true }))], Array(2).fill([[], false, 'MODERATE', false, null, []]));
    eq(judged(B.formatBsipSonarAlertText_(kofRow({ kof: 'Tech Reviewers' }), { kof: true })).slice(3), [true, 'URGENT', ['KOF']]);
  });

  /**
   * A one-space world three runs in: Direct BigQuery finds the KOF post and the owned channel's (or `rows`), then their
   * cards are reviewed.
   */
  const FOUND = 'Direct BigQuery finds the two posts';
  const oneSpace = (overrides, rows) => {
    const { t, rec } = golden.world.oneSpaceWorld(overrides);
    const feed = bsipFeed(t.g);
    rec.collect('setup');
    rec.step('the first run', 1);
    rec.step(FOUND, 5, () => { feed.bsip = rows || [kofRow(), ownedRow()]; });
    rec.step('the cards are reviewed', 1);
    rec.step('a quiet run', 1);
    return { t, out: rec.out() };
  };
  const NO_KOF_COLUMN = [kofRow({ kof: '' }), ownedRow({ kof: '' })];  // the same two posts with nothing in the feed's KOF column

  test('BSIP KOF line: in the one-space setup the card of a post whose author is on a KOF list says so, and its review sends the Social Alert a KOF\'s post gets at any size (here 620 engagements, a P2 tag), to the tester only; the card of a post from a Google-owned channel says No and gets none. With the setting requirement_line off both cards are what they were before, and no email goes out', () => {
    const on = oneSpace(Object.assign({}, golden.SETTINGS_OFF, { requirement_line: true }));
    eq(cardsIn(on.out, FOUND).map(m => [m.space, m.text]),
      [[golden.spaces.AC, KOF_CARD], [golden.spaces.AC, B.formatBsipSonarAlertText_(ownedRow())]]);
    assert.ok(cardsIn(on.out, FOUND)[1].text.includes('\n[KOF]: No\n'));
    // the email outcome: one Social Alert, for the KOF's post, sent to the tester; none for the owned channel's
    eq(on.out.emails.map(e => [e.run, e.kind, e.to, e.cc, e.bcc]), [['the cards are reviewed', 'sent', [TESTER], [], []]]);
    const mail = on.out.emails[0];
    assert.ok(mail.subject.indexOf('[Auto-correct test] ') === 0 && mail.subject.includes('Pixel 10 camera app crashes on video'), mail.subject);
    assert.ok(/(^|\n)KOF: Yes \(Viral KOFs KOFs\)(\n|$)/.test(mail.text), mail.text);
    assert.ok(mail.text.includes(KOF_URL) && !mail.text.includes(OWNED_URL), mail.text);
    // their Alert-log rows: a KOF's alert that went out, and one with no email
    const key = url => on.t.bot.recordKey_({ post_url: url });
    const row = url => rowsOf(on.t).find(r => r.record_key === key(url));
    eq([KOF_URL, OWNED_URL].map(u => [row(u).ingested, row(u).email_status || '', row(u).forwarded_fields.kof, row(u).forwarded_fields.kof_lists || []]),
      [['BSIP', 'sent', true, ['Viral KOFs KOFs']], ['BSIP', '', false, []]]);
    eq(row(KOF_URL).email_input.escalation.reasons, ['KOF']);

    // the setting off (alone, and with every new setting off): the cards of before, and the outcome of before
    [{ requirement_line: false }, golden.SETTINGS_OFF].forEach(overrides => {
      const off = oneSpace(overrides);
      eq(cardsIn(off.out, FOUND).map(m => m.text), [BASE_CARD, B.formatBsipSonarAlertText_(ownedRow())]);
      eq(off.out.emails, []);
      eq(rowsOf(off.t).filter(r => r.ingested === 'BSIP').map(r => [r.email_status || '', r.forwarded_fields.kof]), [['', false], ['', false]]);
      // ...and everything the flow puts out (every post, emoji and email) is what it puts out when the feed's KOF column
      // is blank: with the setting off the column is not read at all
      eq(golden.differences(off.out, oneSpace(overrides, NO_KOF_COLUMN).out), []);
    });
    // (that comparison is no empty one: with the setting on the two records differ)
    assert.ok(golden.differences(on.out, oneSpace(Object.assign({}, golden.SETTINGS_OFF, { requirement_line: true }), NO_KOF_COLUMN).out).length > 0);
    // and the default settings have it on
    eq(cardsIn(oneSpace(undefined).out, FOUND).map(m => m.text.split('\n')[9]), [KOF_LINE, '[KOF]: No']);
  });

  test('BSIP KOF line: only the Auto-correct flow. In the Mirror flow (Testing with the Burson test copy, then LIVE), with the default settings, the card of the same KOF post is byte for byte the card of before ("[KOF]: No"), and what follows is as before: no Social Alert, nothing for Burson. In a test feed the poll\'s card is the card of before too', () => {
    const SECOND = kofRow({ id: '2160000000000000003', url: 'https://x.com/photodesk/status/2160000000000000003', handle: 'photodesk',
      alert_names_json: '["Google Photos"]', tags: 'Photos backup | Product - Other/general criticism',
      summary: 'An X user says Google Photos lost their albums after the backup.', issue_name: 'Photos albums gone after the backup',
      kof: 'CAM Tech/AI (INFs)' });
    /** The Mirror flow, Testing then LIVE, with a KOF post found in each (`blank`: with nothing in the feed's KOF column). */
    const mirror = blank => {
      const { t, rec } = golden.world.mirrorWorld(undefined);
      const feed = bsipFeed(t.g);
      const rows = list => (blank ? list.map(r => Object.assign({}, r, { kof: '' })) : list);
      rec.step('a quiet run', 1);
      rec.step('Testing: Direct BigQuery finds the KOF post', 5, () => { feed.bsip = rows([kofRow()]); });
      rec.step('Testing: after its review', 1);
      rec.step('LIVE', 1, () => { t.set('B26', ''); });
      rec.step('LIVE: Direct BigQuery finds another KOF post', 5, () => { feed.bsip = rows([kofRow(), SECOND]); });
      rec.step('LIVE: after its review', 1);
      return { t, out: rec.out() };
    };
    const { t, out } = mirror(false);
    eq(cardsIn(out, 'Testing: Direct BigQuery finds the KOF post').map(m => [m.space, m.text]), [[golden.spaces.MIRROR, BASE_CARD]]);
    eq(cardsIn(out, 'LIVE: Direct BigQuery finds another KOF post').map(m => [m.space, m.text]),
      [[golden.spaces.MIRROR, B.formatBsipSonarAlertText_(SECOND)]]);
    assert.ok(B.formatBsipSonarAlertText_(SECOND).includes('\n[KOF]: No\n'));
    // as before: neither card is a KOF's alert, so no email and no draft; nothing in the test copy or on the Burson outbox
    eq([out.emails, out.test_copy.filter(m => /2160000000000000/.test(m.text)), out.outbox.filter(r => /2160000000000000/.test(JSON.stringify(r)))],
      [[], [], []]);
    eq(rowsOf(t).filter(r => r.ingested === 'BSIP').map(r => [r.email_status || '', r.forwarded_fields.kof, r.forwarded_fields.kof_lists || []]),
      [['', false, []], ['', false, []]]);
    eq(out.chat.filter(m => m.text.includes('[KOF]: Yes')), []);
    // and everything the Mirror flow puts out (every post, what goes to the test copy, every emoji, email and outbox row)
    // is what it puts out when the feed's KOF column is blank: there the column is not read at all
    eq(golden.differences(out, mirror(true).out), []);
    assert.ok(out.chat.length > 4 && out.reactions.length > 0, 'the record holds the cards and what followed them');

    // a test feed (the main flow, as Main.gs runs the poll with the switch ON): the card of before
    const tf = world();
    const tfFeed = bsipFeed(tf.g, true);
    tfFeed.bsip = [kofRow()];
    const ctx = Object.assign(tf.ctx(), { switches: Object.assign(tf.bot.switchesOff_(), { directBq: true }) });
    Object.assign(ctx.settings, { bq_direct_poll: true, bq_poll_sprinklr: true, bq_poll_bmie: true, bq_poll_bsip: true });
    eq(tf.bot.pollBigQuerySources_(ctx, tf.BUR).bsip, 1);
    eq(tf.chat.botPosts(tf.BUR).filter(m => !m.threadReply).map(m => m.text), [BASE_CARD]);
    eq(tf.bot.ev('GEN').settings.requirement_line, true);
  });
};
