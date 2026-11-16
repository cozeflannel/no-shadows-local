// A story whose main post already has another alert's card (EarlyDetectionCross.gs; the Auto-correct flow only, setting
// cross_alert_notes). When that alert went out as a Social Alert (Escalate.gs earlierOutcome_ says 'alerted'), the story
// is not reviewed: one note goes under that alert's card ("Added under another alert's card"; "Its main post already has
// an alert" when the note can't be posted), and the story adds another note only once it has twice the accounts (and 3
// more). When it did not, the story is reviewed as any other, and its card's review note ends "*Related alert:* …", with
// one note under the other alert's card pointing at it. The line is not on the card: Burson's parser, which reads the
// cards in the space for the posts waiting there, would take its link for the post's (tested below). A pace jump on a topic or risk words
// goes on as any other signal. The setting off, and every other flow: skipped as before, now counted, its id marked.
'use strict';

module.exports = H => {
  const { test, eq, assert, B } = H;
  const ends = require('./ed_endings')(H);
  const golden = require('./golden_flows')(H);
  const fs = require('fs');
  const path = require('path');
  const ON = { cross_alert_notes: true };  // the settings as the config gives them: the allowance and the notes ON
  const OLD_ON = Object.assign({}, ends.OLD_RULE, { cross_alert_notes: true });  // the old 40 a day, the notes ON
  const props = w => w.t.g.services.PropertiesService.getScriptProperties();
  const recsOf = w => w.t.bot.edNotesOfRun_().map(r => w.t.bot.edNoteObj_(r));
  const storyOf = id => String(id).replace(/^ED-[A-Z_]+-(?:CLUSTER-|PRIORITY_TOPIC-|RISK_TERM_GROUP-)?(?:clu_)?ends0*(\d+)-.*$/, '$1');
  const brief = recs => recs.map(r => [storyOf(r.id), r.outcome, r.card]);
  const UNDER = 'Added under another alert\'s card';
  const COVERED = 'Its main post already has an alert';

  /**
   * A one-space world (or o.flow) whose runs are checked: after each the day's numbers add up, found is the number of
   * signals counted, and the numbers never had to be put right. w.step(time, rows) -> w.run's look, with recs and n.
   */
  const checked = o => {
    const w = ends.world(Object.assign({ flow: 'one-space', row46: false, settings: ON }, o || {}));
    const counted = new Set();
    w.step = (time, rows) => {
      const look = w.run(time, rows);
      const recs = recsOf(w);
      recs.forEach(r => counted.add(r.id));
      w.t.bot.edQueueList_(props(w)).forEach(e => counted.add(e.id));
      const n = w.t.bot.edDayNumbers_(props(w));
      eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `the run at ${time}: ${JSON.stringify(n)}`);
      eq(n.found, counted.size, `the run at ${time}: found ${n.found}, signals counted ${[...counted].join(', ')}`);
      assert.ok(!look.logs.map(String).some(l => /did not add up/.test(l)), `the run at ${time}: the numbers were put right`);
      return Object.assign(look, { recs, n });
    };
    return w;
  };

  /**
   * Another path's card on `sig`'s main post, posted now in the world's space by the bot, and its Alert-log row. o: {id,
   * ingested ('BSIP': a Direct BigQuery card; 'Watch alert'; '': Burson's alert, corrected in the space), email (its
   * email_status: 'sent' went out as a Social Alert), where ('space': the card is in the world's space; 'none': the
   * corrected copy was held back, so the row has no thread there; 'other': its thread is in another space)}. -> the row,
   * with `card` (the Chat message).
   */
  const cover = (w, sig, o) => {
    const x = Object.assign({ id: 'QA-0901', ingested: 'BSIP', email: '', where: 'space' }, o || {});
    if (!w.partition) throw new Error('cross alerts: no run has told the flow\'s Alert-log partition yet');
    const card = w.t.chat._add(w.space, { text: `A card of another path (${x.id})`, sender: { name: w.t.chat.botUser, type: 'BOT' },
      viaApi: true, clientId: `client-bqa-cover-${x.id}` });
    const elsewhere = 'spaces/AAQAelsewhere1';
    const row = {
      alert_id: x.id, created_at: w.t.g.clock.now, space: w.partition, status: 'ok', ingested: x.ingested,
      record_key: w.t.bot.recordKey_({ post_url: sig.primary_url }), email_status: x.email,
      source_message: x.ingested ? card.name : `${elsewhere}/messages/burson-${x.id}`,
      source_thread: x.ingested ? card.thread.name : `${elsewhere}/threads/burson-${x.id}`,
      forward_message: x.where === 'space' ? card.name : x.where === 'other' ? `${elsewhere}/messages/copy-${x.id}` : '',
      forward_thread: x.where === 'space' ? card.thread.name : x.where === 'other' ? `${elsewhere}/threads/copy-${x.id}` : '',
    };
    w.t.bot.sheetBackend_(w.t.sheet()).appendAlert(row);
    return Object.assign({}, row, { card });
  };
  /** The bot's replies under a card. */
  const under = (w, card) => w.t.chat.spaces.get(w.space).messages.filter(m => m.thread.name === card.thread.name && m.threadReply);
  /** Gemini's story reviews so far. */
  const reviews = w => (w.t.g.vertex.calls || []).filter(c => {
    const p = (((c.payload || {}).generationConfig || {}).responseSchema || {}).properties || {};
    return !!p.early_detection_call;
  }).length;
  const seenId = (w, sig) => w.t.bot.earlyWaveSeen_(props(w), w.t.g.clock.now).has(`id:${sig.alert_id}`);
  // the note counts the accounts once, in its own words: the plain title's "5 accounts posting" is left out
  const plainTitle = sig => `“${sig.headline.replace(/^Low-tier claim cluster \(\d+ accounts\):\s*/, '')}”`;
  const links = sig => JSON.parse(sig.representative_posts_json).slice(0, 3).map(p => `<${p.url}|@${p.author_handle}>`).join(' · ');

  // -----------------------------------------------------------------------------------------------------------
  // The alert went out as a Social Alert: a note under its card, no review
  // -----------------------------------------------------------------------------------------------------------

  for (const [rule, settings] of [['the allowance', ON], ['the old 40 a day', OLD_ON]]) {
    test(`early detection cross alerts (${rule}): a story whose main post's alert went out as a Social Alert is not reviewed; one note goes under that alert's card ("Added under another alert's card"); the same story again with fewer than twice the accounts adds no note ("Seen before, nothing new"); with twice the accounts and 3 more, a second note; the day's numbers add up after every run`, () => {
      const w = checked({ settings });
      w.step('08:01', []);
      const s1 = ends.signal(1, { au: 5, at: '08:10' });
      const s1b = ends.signal(1, { au: 9, at: '08:25' });
      const s1c = ends.signal(1, { au: 13, at: '08:40' });
      const c = cover(w, s1, { id: 'QA-0901', email: 'sent' });

      const a = w.step('08:16', [s1]);
      eq(brief(a.recs), [['1', UNDER, 'QA-0901']]);
      eq(a.recs[0].why, `Its main post already had a Social Alert, QA-0901 (BigQuery · BSIP, ${w.t.bot.edCardTime_(c.created_at, w.t.g.clock.now)}), and the story was added under its card.`);
      eq(under(w, c.card).map(m => m.text), [`🔗 *Part of a story:* 5 small accounts on X and Reddit now tell it: ${plainTitle(s1)} (${links(s1)})`]);
      eq(under(w, c.card)[0].clientAssignedMessageId.indexOf('client-bqa-'), 0);  // the bot's own message: it never answers it
      eq([a.cards.length, reviews(w), a.waiting, a.n.under], [0, 0, 0, 1]);
      assert.match(a.c19, /today: 1 found, 0 cards, 1 under another alert, 0 let go, 0 never reviewed, 0 waiting/);
      eq([seenId(w, s1), w.t.bot.earlyWaveSeen_(props(w), w.t.g.clock.now).authors([`cl:${s1.cluster_id}`])], [true, 5]);

      const b = w.step('08:31', [s1, s1b]);  // 9 accounts: not twice 5 and 3 more
      eq(brief(b.recs), [['1', 'Seen before, nothing new', '']]);
      eq([under(w, c.card).length, reviews(w), b.n.under], [1, 0, 1]);

      const d = w.step('08:46', [s1, s1b, s1c]);  // 13 accounts: twice 5 and 3 more
      eq(brief(d.recs), [['1', UNDER, 'QA-0901']]);
      eq(under(w, c.card).map(m => m.text.split(' now tell it: ')[0]), [
        '🔗 *Part of a story:* 5 small accounts on X and Reddit',
        '🔗 *Part of a story:* 13 small accounts on X and Reddit']);
      eq([reviews(w), d.n.under, d.n.found], [0, 2, 3]);
      const e = w.step('09:01', [s1, s1b, s1c]);  // read again: nothing more
      eq([e.recs, under(w, c.card).length], [[], 2]);
    });
  }

  test('early detection cross alerts: the covering alert can be any other path\'s (a Direct BigQuery card, a Watch alert, Burson\'s corrected alert): each that went out as a Social Alert gets the note under its card in the space, never under Burson\'s own message', () => {
    for (const [ingested, words] of [['BSIP', 'BigQuery · BSIP'], ['Watch alert', 'Watch alert'], ['', 'Burson alert']]) {
      const w = checked();
      w.step('08:01', []);
      const s = ends.signal(2, { at: '08:10' });
      const c = cover(w, s, { id: 'QA-0902', ingested, email: 'sent' });
      const a = w.step('08:16', [s]);
      eq(brief(a.recs), [['2', UNDER, 'QA-0902']], words);
      assert.ok(a.recs[0].why.indexOf(`QA-0902 (${words}, `) > 0, a.recs[0].why);
      eq(under(w, c.card).length, 1, words);
      eq(a.recs[0].message, c.card.name, words);  // the record points at the card in the space, not at Burson's message
    }
  });

  // -----------------------------------------------------------------------------------------------------------
  // The alert did not go out as a Social Alert: the story is reviewed; its card says so, and a note points at it
  // -----------------------------------------------------------------------------------------------------------

  for (const [rule, settings] of [['the allowance', ON], ['the old 40 a day', OLD_ON]]) {
    test(`early detection cross alerts (${rule}): a story whose main post's alert sent no Social Alert is reviewed as any other; its card is as any card, its review note ends "*Related alert:*", and one note goes under the other alert's card (a Direct BigQuery card, a Watch alert, Burson's alert); the day's numbers add up`, () => {
      for (const [ingested, words] of [['BSIP', 'BigQuery · BSIP'], ['Watch alert', 'Watch alert'], ['', 'Burson alert']]) {
        const w = checked({ settings });
        w.step('08:01', []);
        const s = ends.signal(3, { at: '08:10' });
        const c = cover(w, s, { id: 'QA-0903', ingested, email: '' });
        const a = w.step('08:16', [s]);
        eq([a.cards.length, reviews(w)], [1, 1], words);
        eq(/Related alert/.test(a.cards[0].text), false, words);
        const note = under(w, a.cards[0]).map(m => m.text);
        eq(note.length, 1, words);
        assert.match(note[0], /^🤖 \*Early Detection Review: /, words);
        eq(note[0].split('\n').pop(), `*Related alert:* its main post already has a card (QA-0903 · ${words}, ${w.t.bot.edCardTime_(c.created_at, w.t.g.clock.now)})`, words);
        const logged = w.t.bot.sheetBackend_(w.t.sheet()).loadAlerts().find(r => r.source_message === a.cards[0].name);
        eq(under(w, c.card).map(m => m.text), [`🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (story card ${logged.alert_id})`], words);
        eq(brief(a.recs), [['3', 'Card posted: Monitor build-up', logged.alert_id]], words);
        eq([a.n.cards, a.n.under], [1, 0], words);
        // the story card is its own thread: a question under the other alert's card is still about that alert
        eq(logged.forward_thread === c.forward_thread, false, words);
      }
    });
  }

  test('early detection cross alerts: why the Related alert line is in the review note and not on the card: on the card, with its link to the other card (as live message names give one), Burson\'s parser reads that link as the post\'s own (the posts waiting in the space are read so: BigQuery.gs bqWaitingKeys_); in the review note it is the last line, linked, and the note stays the bot\'s own', () => {
    const rec = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_flows_defaults.json'), 'utf8')).one_space;
    const card = rec.chat.find(m => /^🚨 \*EARLY DETECTION\*/.test(m.text) && /^12 /.test(m.run));
    assert.ok(card, 'the default set has the story card of step 12');
    eq(/Related alert/.test(card.text), false);
    const line = '*Related alert:* its main post already has a card (<https://chat.google.com/room/AAQAonespace01/aB1/aB1|QA-1002 · BigQuery · BSIP, 8:07 AM ET>)';
    const on = card.text.replace(/(\n\*KOF:\*[^\n]*)/, `$1\n${line}`);
    eq(on === card.text, false);
    eq(B.parseAlert_(card.text).fields.post_url, 'https://x.com/pixelcritic/status/2150000000000000001');
    eq(B.parseAlert_(on).fields.post_url, 'https://chat.google.com/room/AAQAonespace01/aB1/aB1');  // misread: so not on the card
    // the note: the story card's review note, its last line, and a message the bot knows as its own
    const review = rec.chat.find(m => /^12 /.test(m.run) && m.reply && /^🤖 \*Early Detection Review/.test(m.text));
    assert.ok(review, 'the review note of step 12');
    eq(review.text.split('\n').pop(), '*Related alert:* its main post already has a card (QA-1002 · BigQuery · BSIP, 8:07 AM ET)');
    eq(B.isBotFormattedText_(review.text), true);
    // linked when the other card's message has a link (a live message name: "T.M"), words alone otherwise
    const ctx = { spaces: { analyst: { id: 'spaces/AAQAonespace01' } } };
    const other = { alert_id: 'QA-1002', ingested: 'BSIP', created_at: 0, forward_message: 'spaces/AAQAonespace01/messages/aB1.aB1' };
    eq(B.edRelatedLine_(ctx, other, Date.now()), '*Related alert:* its main post already has a card (<https://chat.google.com/room/AAQAonespace01/aB1/aB1|QA-1002 · BigQuery · BSIP>)');
    eq(B.edRelatedLine_(ctx, Object.assign({}, other, { forward_message: 'spaces/AAQAelsewhere1/messages/aB1.aB1' }), Date.now()),
      '*Related alert:* its main post already has a card (QA-1002 · BigQuery · BSIP)');
    eq(B.edAlertLabel_({ alert_id: 'QA-7', ingested: '' }, Date.now()), 'QA-7 · Burson alert');
    eq(B.edAlertLabel_({ alert_id: 'QA-8', ingested: 'Watch alert' }, Date.now()), 'QA-8 · Watch alert');
  });

  // -----------------------------------------------------------------------------------------------------------
  // The helper refuses, its caps
  // -----------------------------------------------------------------------------------------------------------

  test('early detection cross alerts: when the note can\'t go under the card (the corrected copy was held back, so it has no thread in the space; the card is in another space) nothing is posted: the story that went out as a Social Alert ends "Its main post already has an alert" with only its id marked; a story whose card is posted still says Related alert, without a link, and no note goes anywhere', () => {
    for (const where of ['none', 'other']) {
      const w = checked();
      w.step('08:01', []);
      const s = ends.signal(4, { at: '08:10' });
      const t = ends.signal(5, { at: '08:10' });
      cover(w, s, { id: 'QA-0904', email: 'sent', where, ingested: '' });
      cover(w, t, { id: 'QA-0905', email: '', where, ingested: '' });
      const before = w.t.chat.spaces.get(w.space).messages.filter(m => m.threadReply).length;
      const a = w.step('08:16', [s, t]);
      const said = where === 'none' ? 'the card has no thread' : 'the card\'s thread is not in the Auto-correct space';
      eq(a.logs.filter(l => /^thread note not posted: /.test(String(l))).map(String), [`thread note not posted: ${said}`, `thread note not posted: ${said}`], where);
      const why = a.recs.find(r => storyOf(r.id) === '4');
      eq([why.outcome, why.why.startsWith('QA-0904 (Burson alert, '), why.why.endsWith('), and no note could be added under its card.')],
        [COVERED, true, true], where);
      eq([seenId(w, s), w.t.bot.earlyWaveSeen_(props(w), w.t.g.clock.now).authors([`cl:${s.cluster_id}`])], [true, null], where);
      eq(a.cards.length, 1, where);
      const note = under(w, a.cards[0]).map(m => m.text);
      assert.ok(/\n\*Related alert:\* its main post already has a card \(QA-0905 · Burson alert, [^)<>|]+\)$/.test(note[0]), `${where}: ${note[0]}`);
      // only the review note under the story card: no reply anywhere else
      eq(w.t.chat.spaces.get(w.space).messages.filter(m => m.threadReply).length - before, 1, where);
      eq([a.n.under, a.n.letgo, a.n.cards], [0, 1, 1], where);
    }
  });

  test('early detection cross alerts: the helper\'s caps hold: a card that already has 3 notes gets no fourth ("Its main post already has an alert"), and a run posts at most 6 notes (the seventh story ends the same way and its id only is marked; at the next check it is not read again)', () => {
    const w = checked();
    w.step('08:01', []);
    const s = ends.signal(6, { at: '08:10' });
    const c = cover(w, s, { id: 'QA-0906', email: 'sent' });
    for (let i = 0; i < 3; i++) {
      w.t.chat._add(w.space, { text: `🔗 *Part of a story:* earlier note ${i + 1}`, thread: c.card.thread.name,
        sender: { name: w.t.chat.botUser, type: 'BOT' }, viaApi: true, clientId: `client-bqa-earlier-${i}` });
    }
    const a = w.step('08:16', [s]);
    eq(brief(a.recs), [['6', COVERED, 'QA-0906']]);
    assert.ok(a.logs.map(String).includes('thread note not posted: its card already has 3 notes'), a.logs.join('\n'));
    eq(under(w, c.card).length, 3);

    const v = checked();
    v.step('08:01', []);
    const sigs = Array.from({ length: 7 }, (_, i) => ends.signal(11 + i, { at: '08:10' }));
    const cards = sigs.map((x, i) => cover(v, x, { id: `QA-091${i}`, email: 'sent' }));
    const b = v.step('08:16', sigs);
    eq(b.recs.map(r => r.outcome), [UNDER, UNDER, UNDER, UNDER, UNDER, UNDER, COVERED]);
    eq(cards.map(x => under(v, x.card).length), [1, 1, 1, 1, 1, 1, 0]);
    assert.ok(b.logs.map(String).includes('thread note not posted: this run already posted 6 notes'), b.logs.join('\n'));
    eq([seenId(v, sigs[6]), v.t.bot.earlyWaveSeen_(props(v), v.t.g.clock.now).authors([`cl:${sigs[6].cluster_id}`])], [true, null]);
    const d = v.step('08:31', sigs);
    eq([d.recs, cards.map(x => under(v, x.card).length)], [[], [1, 1, 1, 1, 1, 1, 0]]);
  });

  // -----------------------------------------------------------------------------------------------------------
  // A pace jump on a topic or risk words; the setting off; another flow
  // -----------------------------------------------------------------------------------------------------------

  test('early detection cross alerts: a pace jump on a topic or on risk words ignores another alert on its main post (only a sample of its posts) and goes on as any other signal: reviewed (held after its review when that alert went out as a Social Alert, the post being alerted already; else its card, with no Related alert line), and no note anywhere; a pace jump on a story is a story (a note under the alert that went out)', () => {
    const jumps = (n, o) => [
      ends.signal(n, Object.assign({ au: 30, type: 'VELOCITY_SPIKE', grain: 'PRIORITY_TOPIC', key: 'Search & Shopping', ratio: '4.2', at: '08:10',
        words: `People cannot find the shop when googling it, story ${n}` }, o)),
      ends.signal(n + 1, Object.assign({ au: 9, type: 'VELOCITY_SPIKE', grain: 'RISK_TERM_GROUP', key: 'outage_broken_feature', ratio: '3.2',
        risk: 'outage_broken_feature', at: '08:10', words: `Gmail is down again for me, story ${n + 1}` }, o)),
    ];
    const w = checked();
    w.step('08:01', []);
    const went = jumps(21);
    const jump = ends.signal(23, { au: 12, type: 'VELOCITY_SPIKE', grain: 'CLUSTER', at: '08:10', words: 'Pixel owners say the fingerprint reader fails, story 23' });
    const notWent = jumps(25);
    const cs = went.concat([jump]).map((x, i) => cover(w, x, { id: `QA-092${i}`, email: 'sent' }))
      .concat(notWent.map((x, i) => cover(w, x, { id: `QA-095${i}`, email: '' })));
    const looks = [w.step('08:16', went.concat([jump], notWent))].concat(['08:17', '08:18', '08:19'].map(t => w.step(t)));
    const recs = [].concat(...looks.map(x => x.recs));
    eq(recs.map(r => [storyOf(r.id), r.outcome]).sort(), [
      ['21', 'Seen before, nothing new'], ['22', 'Seen before, nothing new'], ['23', UNDER],
      ['25', 'Card posted: Monitor build-up'], ['26', 'Card posted: Monitor build-up']]);
    eq(recs.filter(r => /^2[12]$/.test(storyOf(r.id))).map(r => r.why), ['The same post was already alerted (QA-0920).', 'The same post was already alerted (QA-0921).']);
    eq([reviews(w), looks[looks.length - 1].waiting], [4, 0]);
    const cards = [].concat(...looks.map(x => x.cards));
    eq(cards.length, 2);
    eq(cards.map(m => under(w, m).filter(x => /\*Related alert:\*/.test(x.text)).length), [0, 0]);
    eq(cs.map(x => under(w, x.card).length), [0, 0, 1, 0, 0]);
  });

  for (const [name, o] of [
    ['the setting off (the allowance)', { settings: { cross_alert_notes: false } }],
    ['the setting off (the old 40 a day)', { settings: Object.assign({}, ends.OLD_RULE, { cross_alert_notes: false }) }],
    ['the Mirror flow, the setting on', { flow: 'mirror', settings: ON }],
  ]) {
    test(`early detection cross alerts: ${name}: a story whose main post another alert covers is skipped as before (no note, no review, no card), now counted as "Its main post already has an alert" with its id marked, whether or not that alert went out as a Social Alert; read again, it is not counted again`, () => {
      const w = checked(o);
      w.step('08:01', []);
      const s = ends.signal(31, { at: '08:10' });
      const t = ends.signal(32, { at: '08:10' });
      const cs = [cover(w, s, { id: 'QA-0931', email: 'sent' }), cover(w, t, { id: 'QA-0932', email: '' })];
      const a = w.step('08:16', [s, t]);
      eq(brief(a.recs), [['31', COVERED, 'QA-0931'], ['32', COVERED, 'QA-0932']]);
      eq(a.recs.map(r => r.why.slice(0, 26)), ['QA-0931 (BigQuery · BSIP, ', 'QA-0932 (BigQuery · BSIP, ']);
      eq([a.cards.length, reviews(w), a.waiting], [0, 0, 0]);
      eq(cs.map(x => under(w, x.card).length), [0, 0]);
      eq([seenId(w, s), seenId(w, t)], [true, true]);
      eq(a.logs.filter(l => /thread note/.test(String(l))), []);
      const b = w.step('08:31', [s, t]);
      eq([b.recs, b.cards.length, reviews(w)], [[], 0, 0]);
    });
  }

  // -----------------------------------------------------------------------------------------------------------
  // The golden scenarios
  // -----------------------------------------------------------------------------------------------------------

  test('early detection cross alerts: the golden scenarios: with the setting off the one-space setup puts out the default set without its step 12 (a story whose main post is the Pixel post: no card, as before); the Mirror flow with the default settings puts out exactly the f93e31a record', () => {
    const rec = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_flows_defaults.json'), 'utf8')).one_space;
    const step12 = x => /^12 /.test(String(x.run || ''));
    eq(['chat', 'reactions', 'emails'].map(k => (rec[k] || []).filter(step12).length), [3, 1, 0]);
    const without = Object.assign({}, rec, { chat: rec.chat.filter(x => !step12(x)), reactions: rec.reactions.filter(x => !step12(x)) });
    eq(golden.differences(golden.oneSpace({ cross_alert_notes: false }), without), []);
    eq(golden.differences(golden.mirror({}), golden.recorded.mirror), []);
  });
};
