// Early Detection's record rows (EarlyDetectionNotes.gs): the first-guess tag a queued signal keeps with it, and the
// edges of a row's words (a review that gave no reason, a repeat the review found in the alert log, a title from the
// first post that has words, cuts on whole characters, a long tag that keeps its severity).
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;
  const ends = require('./ed_endings')(H);
  const RISK = 'A risk no Exposure Tag names (60% sure) · severity medium';

  test('early detection record: a queued signal keeps its first-guess tag with it, so a signal that waited longer than the 3 hours the fast triage\'s answers are kept still shows it (the script cache emptied before every run); the guess goes with the stored row only when it fits beside what the review reads, never in place of a post', () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    w.busy = true;
    const sig = ends.signal(80, { at: '09:31', words: 'Pixel owners say the clock app is late, story 80' });
    w.run('09:31', [sig]);
    const stored = JSON.parse(w.t.g.props.get(`ED_ALERT_Q_${w.t.bot.edQueueKey_(sig)}`));
    eq(stored.tag_guess, RISK);
    w.busy = false;
    const run = w.run;
    w.run = (t, r) => { w.t.g.cache.clear(); return run(t, r); };
    w.run('12:35', []);
    const rows = w.t.bot.edNotesOfRun_().map(r => w.t.bot.edNoteObj_(r));
    eq(rows.map(r => [r.outcome, r.why, r.tag]), [['Never reviewed', 'Waited 3 hours while the bot worked on alerts.', RISK]]);

    // the stored row: the same posts with the guess as without it; a guess that does not fit is left out
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const max = bot.ev('ED_ROW_MAX_CHARS_');
    const base = ends.signal(81);
    const withPad = pad => Object.assign({}, base, { representative_posts_json: JSON.stringify(Array.from({ length: 8 }, (_, i) => ({
      url: `https://x.com/a${i}/status/1${i}?${'q'.repeat(i === 0 ? pad : 250)}`, snippet: `${'w'.repeat(270)} ${i}` }))) });
    // a row whose stored form is a few characters under the limit with all its posts
    let pad = 0;
    const whole = c => c && c.posts.length === 8 && JSON.stringify(c).length <= max;
    while (whole(bot.edQueueCompact_(withPad(pad + 1))) && pad < 8000) pad++;
    const edge = withPad(pad);
    const without = bot.edQueueCompact_(edge);
    eq([without.posts.length, JSON.stringify(without).length > max - 20], [8, true]);
    const withGuess = bot.edQueueCompact_(Object.assign({}, edge, { tag_guess: RISK }));
    eq([withGuess.tag_guess, withGuess.posts.length, JSON.stringify(withGuess.posts) === JSON.stringify(without.posts)], [undefined, 8, true]);
    assert.ok(JSON.stringify(withGuess).length <= max);
    eq(bot.edQueueCompact_(Object.assign({}, base, { tag_guess: RISK })).tag_guess, RISK);
    // what the review reads of a queued signal is the same with the guess there
    eq(bot.edFromRow_(withGuess), bot.edFromRow_(without));
    // the record reads it before the 3-hour cache, after the answers a caller hands over
    eq(bot.edNoteTag_({ alert_id: 'x', tag_guess: RISK }, null, ''), RISK);
    eq(bot.edNoteTag_({ alert_id: 'x', tag_guess: RISK }, { c: 'none', cp: 0.9, l: 0 }, ''), 'None: not a brand-safety issue (90% sure) · severity none');
  });

  test('early detection record: the edges of a row\'s words: a review that gave no reason gets a plain sentence for its call (never the bot\'s own basis), the alert log is not named by its internal name, a title comes from the first post that has words, a long tag keeps its sureness and severity, and no cut leaves half a character', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const basis = 'Low-tier semantic cluster (5 distinct authors).';
    eq([
      bot.edRecordWhy_({ basis: 'early_detection', disposition: 'escalate', rev: { reason: '' }, why: basis }),
      bot.edRecordWhy_({ basis: 'early_detection', disposition: 'monitor', rev: {}, why: 'Low-tier velocity spike (CLUSTER), 4.2x baseline.' }),
      bot.edRecordWhy_({ basis: 'early_detection', disposition: 'dismiss', rev: null, why: 'benign or unrelated low-tier chatter' }),
      bot.edRecordWhy_({ basis: 'early_detection', disposition: 'escalate', rev: { reason: 'Owners describe one failure' }, why: basis }),
      bot.edRecordWhy_({ basis: 'p0_tag', disposition: 'escalate', rev: { reason: 'x' }, why: basis }),
      bot.edRecordWhy_({ basis: 'failed', disposition: 'monitor', rev: null, why: 'AI review unavailable, so a person makes the call' }),
      bot.edRecordWhy_({ basis: 'low_confidence', disposition: 'monitor', rev: { reason: 'May grow' }, why: 'May grow (62% sure, so a person decides)' }),
    ], ['The review called for a Social Alert', 'The review found an early build-up worth watching',
      'The review found nothing for Google to act on', 'Owners describe one failure', 'Its Exposure Tag is escalated at any size',
      'AI review unavailable, so a person makes the call', 'May grow (62% sure, so a person decides)']);
    // the card's own Call line is as it was (the record's words are its own)
    eq(bot.edCallWhy_({ basis: 'early_detection', disposition: 'escalate', rev: { reason: '' }, why: basis }), basis);

    // a repeat the review found in the alert log
    const ctx = { now: () => g.clock.now, log() {} };
    const sig = ends.signal(82);
    const held = bot.edNoteReviewed_(ctx, { id: sig.alert_id }, sig, { held: 'the same post was already alerted (QA-1234, SLRR alert log)',
      call: { disposition: 'dismiss', basis: 'repeat', title: 'Owners report a crash' } });
    eq([bot.edNoteObj_(held).outcome, bot.edNoteObj_(held).why], ['Seen before, nothing new', 'The same post was already alerted (QA-1234).']);

    // a title from the first post that has words
    const posts = [{ url: 'https://x.com/a/status/1', snippet: '' }, { url: 'https://x.com/b/status/2', snippet: 'The fingerprint reader fails' }];
    const spike = Object.assign(ends.signal(83, { type: 'VELOCITY_SPIKE', au: 12 }), { representative_posts_json: JSON.stringify(posts) });
    eq(bot.edNoteStory_(spike, ''), '12 accounts posting “The fingerprint reader fails”');

    // the longest tag names keep their sureness and severity
    const tag = bot.edNoteTag_({}, { c: 'Product - Product failures - general hardware issues/product damage', cp: 0.32, l: 1 }, '');
    assert.ok(tag.length <= 100 && /\(32% sure\) · severity low$/.test(tag), tag);
    const long = bot.edNoteTag_({}, { c: `Product - ${'very long category '.repeat(10)}`, cp: 0.5, l: 3 }, '');
    assert.ok(long.length <= 100 && /…\s?\(50% sure\) · severity high$/.test(long), long);
    const row = bot.edNoteObj_(bot.edNoteRow_(sig, 'Reviewed and dismissed', 'x', { dec: { c: 'Product - Product failures - general hardware issues/product damage', cp: 0.32, l: 1 } }, g.clock.now));
    assert.ok(/severity low$/.test(row.tag), row.tag);

    // cuts on whole characters: emoji text, and text with half characters in it, never leave one
    const half = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (const n of [178, 179, 180, 181]) {
      const why = `${'a'.repeat(n - 180 + 179)}😀😀😀😀`;
      const r = bot.edNoteObj_(bot.edNoteRow_(sig, 'Not English', why, { title: '😀'.repeat(120) }, g.clock.now));
      assert.ok(!half.test(r.why) && !half.test(r.story), `${n}: ${JSON.stringify([r.why.slice(-3), r.story.slice(-3)])}`);
    }
    const lone = '\ud83d'.repeat(300);
    const odd = bot.edNoteRow_(Object.assign({}, sig, { platforms_csv: '\udc00'.repeat(60) }), 'Not English', lone, { title: '\udc00x'.repeat(200), tag: lone }, g.clock.now);
    assert.ok(JSON.stringify(odd).length <= 448, String(JSON.stringify(odd).length));
    bot.ev('ED_NOTE_FIELDS_').forEach((f, i) => assert.ok(typeof odd[i] !== 'string' || !half.test(odd[i]), f));
  });
};
