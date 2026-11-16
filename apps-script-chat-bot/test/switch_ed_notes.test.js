// What became of every Early Detection signal (EarlyDetectionNotes.gs edNote_; BigQuery.gs edCount_): one note at
// every ending, today's numbers that add up after every run, a record row that is ready to show and fits, and the two
// kinds of state it rests on (the day's counts in EARLY_DETECTION_TODAY; the run's rows in memory).
//
// The long mixed day is ed_endings.js's: a story signal ends in every way the code has, in the one-space setup and in
// the Mirror flow, with Control row 46 ON and OFF. Its recorded row-46 events are held in
// switch_ed_row46_record.test.js; here the same day is held to what the record says of each signal.
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;
  const ends = require('./ed_endings')(H);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  const OUTCOMES = [
    'Card posted: Social Alert',
    'Card posted: Monitor build-up',
    'Card posted: Needs a human look',
    'Update added to its earlier card',
    'Added under another alert\'s card',
    'Reviewed and dismissed',
    'Held back as noise (no review)',
    'Seen before, nothing new',
    'Its main post already has an alert',
    'Not English',
    'Topic busier than usual, not a story',
    'Never reviewed',
    'Reviewed, but its card could not be posted',
  ];
  const FIELDS = ['at', 'id', 'outcome', 'why', 'story', 'link', 'kind', 'accounts', 'platforms', 'tag', 'card', 'message'];

  // Tags the day's signals get as a first guess, from the scripted fast-triage answers
  const RISK = 'A risk no Exposure Tag names (60% sure) · severity medium';   // the usual answer
  const RAISED = 'A risk no Exposure Tag names (60% sure) · severity high';   // the answers an early signal was raised on
  const NOISE = 'None: not a brand-safety issue (60% sure) · severity low';
  const CARD = 'Card posted: Monitor build-up';
  const WATCHING = 'Early reports worth watching.';
  const BENIGN = 'Benign chatter, nothing for Google to act on.';
  const posting = (n, words) => `${n} accounts posting “${words}”`;
  const problem = n => `Small accounts report problem ${n}`;
  const EARLY = 'Early signal (3-4 accounts)';

  // What the record says of each signal of the long mixed day, run by run: [run, outcome, why, story, kind, accounts,
  // tag, card]. A run that is not here ended no signal.
  const DAY = [
    ['08:16', 'Not English', 'Most of its posts are not in English.', posting(5, `${ends.NOT_ENGLISH} 5`), 'Story', 5, '-', ''],
    ['08:16', 'Its main post already has an alert', 'QA-0906 (BigQuery · BSIP, 8:01 AM ET).',
      posting(5, 'Pixel owners say the speaker crackles, story 6'), 'Story', 5,
      'Risk words: Outage or broken feature; Scam, phishing or malware', 'QA-0906'],
    ['08:16', 'Held back as noise (no review)', 'Looks like routine chatter (93% likely), severity low (60% sure).',
      posting(5, 'People chat about the new Pixel wallpaper DECNOISE, story 4'), 'Story', 5, NOISE, ''],
    ['08:16', CARD, WATCHING, problem(1), 'Story', 6, RISK, 'QA-1001'],
    ['08:16', 'Card posted: Social Alert', 'Several independent owners describe the same concrete failure.', problem(2), 'Story', 5,
      'Product - Other/general criticism', 'QA-1002'],
    ['08:17', 'Card posted: Needs a human look', 'AI review unavailable, so a person makes the call.',
      posting(5, 'Pixel owners say the screen flickers at night REVFAIL, story 3'), 'Story', 5, RISK, 'QA-1003'],
    ['08:31', 'Seen before, nothing new', 'Its card of 8:16 AM ET had 6 accounts; 8 now, nothing new.',
      posting(8, 'Pixel owners say the camera app crashes after the update, story 1'), 'Story', 8, '-', 'QA-1001'],
    ['08:31', 'Held back as noise (no review)', 'Looks unrelated to Google (94% likely), severity none (70% sure).',
      posting(5, 'A pixel art contest draws a crowd DECOFF, story 12'), 'Story', 5,
      'None: not a brand-safety issue (60% sure) · severity none', ''],
    ['08:31', 'Held back as noise (no review)', 'Looks like routine chatter (93% likely), severity low (60% sure).',
      'Topic: Chrome, 22 accounts in an hour (1.4x the usual)', 'Pace jump (topic)', 22, NOISE, ''],
    ['08:31', CARD, WATCHING, problem(10), 'Pace jump (story)', 12, RISK, 'QA-1004'],
    ['08:31', 'Reviewed and dismissed', BENIGN, problem(7), 'Story', 5, RISK, ''],
    ['08:32', 'Not English', 'The posts are not in English (Portuguese).', problem(8), 'Story', 5, RISK, ''],
    ['08:32', 'Seen before, nothing new', 'Already alerted as a known issue (QA-4228, "Pixel camera crash"): nothing materially new.',
      problem(9), 'Story', 5, RISK, ''],
    ['08:33', 'Reviewed and dismissed', 'Its topic is always around in the listening data ("Shot on Pixel showcase").',
      problem(11), 'Story', 5, RISK, ''],
    ['08:46', 'Seen before, nothing new', 'First seen 8:31 AM ET with 5 accounts; 8 now, nothing new.',
      posting(8, 'Pixel owners say the weather widget looks odd REVDISMISS, story 7'), 'Story', 8, '-', ''],
    ['08:46', CARD, WATCHING, problem(15), EARLY, 3, RAISED, 'QA-1005'],
    ['08:46', 'Update added to its earlier card', '14 accounts now, up from 6; now also on TikTok.', problem(1), 'Story', 14, RISK, 'QA-1001'],
    ['08:47', CARD, WATCHING, problem(17), 'Pace jump (risk words)', 9, RISK, 'QA-1007'],
    ['08:47', 'Reviewed and dismissed', BENIGN, problem(16), 'Pace jump (topic)', 36, RISK, ''],
    ['09:01', CARD, WATCHING, problem(19), 'Story', 12, RISK, 'QA-1008'],
    ['09:01', 'Seen before, nothing new', 'Its card of 9:01 AM ET had 12 accounts; 5 now, nothing new.',
      posting(5, 'Pixel owners say calls drop in the car, story 19'), 'Story', 5, RISK, 'QA-1008'],
    ['09:17', 'Never reviewed', 'Its review failed twice.', posting(3, 'My Pixel account got locked out REVFAIL, story 21'), EARLY, 3, RAISED, ''],
    ['09:20', 'Never reviewed', 'Its review failed twice.', posting(6, 'Pixel owners say the keyboard lags CARDFAIL, story 20'), 'Story', 6, RISK, ''],
    ['09:20', 'Reviewed, but its card could not be posted', 'Chat gave no message back for the card.', `${problem(22)} (CARDHELD)`, 'Story', 5, RISK, ''],
    ['10:16', 'Never reviewed', 'Pushed out of the full queue by higher-ranked stories.',
      posting(5, 'Pixel owners say app 12 freezes, story 42'), 'Story', 5, RISK, ''],
    ['10:16', 'Never reviewed', 'The review queue was full.', posting(4, 'Pixel owners say the clock app is late, story 43'), 'Story', 4, RISK, ''],
  ].concat([1, 2, 3, 4, 5].map(i => ['12:35', 'Never reviewed', 'Waited 3 hours while the bot worked on alerts.',
    posting(5, `Pixel owners say app ${i} freezes, story ${30 + i}`), 'Story', 5, RISK, '']), [
    ['12:35', CARD, WATCHING, problem(44), 'Story', 7, RISK, 'QA-1009'],
    ['12:35', CARD, WATCHING, problem(41), 'Story', 6, RISK, 'QA-1010'],
    ['12:36', 'Reviewed and dismissed', BENIGN, problem(36), 'Story', 5, RISK, ''],
    ['12:36', 'Reviewed and dismissed', BENIGN, problem(37), 'Story', 5, RISK, ''],
    ['12:37', 'Reviewed and dismissed', BENIGN, problem(38), 'Story', 5, RISK, ''],
    ['12:37', 'Reviewed and dismissed', BENIGN, problem(39), 'Story', 5, RISK, ''],
    ['12:38', 'Reviewed and dismissed', BENIGN, problem(40), 'Story', 5, RISK, ''],
    ['12:51', 'Never reviewed', 'Early signals are switched OFF (row 39).',
      posting(3, 'A phishing mail copies the Google sign-in page, story 51'), EARLY, 3, RAISED, ''],
    ['13:05', 'Never reviewed', 'Early signals are switched OFF (row 39).', posting(3, 'Malware hides in a fake Pixel update, story 52'), EARLY, 3, RAISED, ''],
    ['13:20', 'Never reviewed', 'Today\'s 8 early signals were used.', posting(4, 'Scam ads use the Google Pay logo, story 53'), EARLY, 4, RAISED, ''],
    ['23:40', 'Its main post already has an alert', 'QA-0967 (BigQuery · BSIP, 1:50 PM ET).',
      posting(5, 'Pixel owners say the night light flickers, story 67'), 'Story', 5, '-', 'QA-0967'],
    ['D2 00:05', CARD, WATCHING, problem(65), 'Story', 9, RISK, 'QA-1011'],
    ['D2 00:05', 'Reviewed and dismissed', BENIGN, problem(64), 'Story', 8, RISK, ''],
    ['D2 00:06', CARD, WATCHING, problem(63), 'Story', 7, RISK, 'QA-1012'],
    ['D2 00:06', 'Reviewed and dismissed', BENIGN, problem(62), 'Story', 6, RISK, ''],
    ['D2 00:07', 'Never reviewed', 'Its saved details were gone when its turn came.', 'A story whose details are gone', 'Story', 5, RISK, ''],
    ['D2 00:20', CARD, WATCHING, problem(66), 'Story', 5, RISK, 'QA-1013'],
    ['D2 00:35', 'Never reviewed', 'Today\'s limit of 40 was reached.',
      posting(3, 'A fake Google prize mail asks for passwords, story 73'), EARLY, 3, RAISED, ''],
    ['D2 00:35', 'Never reviewed', 'Today\'s limit of 40 was reached.', posting(5, 'Pixel owners say the torch stays on, story 71'), 'Story', 5, '-', ''],
    ['D2 00:35', 'Never reviewed', 'Today\'s limit of 40 was reached.',
      posting(9, 'Leaked passwords from a data breach, people say, story 72 (post 1)'), 'Pace jump (risk words)', 9,
      'Risk words: Privacy or data leak', ''],
  ]);

  // The log lines the notes add over the day: one for each ending that had no line of its own
  const NEW_LINES = [
    `early detection: Not English · "${posting(5, `${ends.NOT_ENGLISH} 5`)}" · Most of its posts are not in English.`,
    `early detection: Its main post already has an alert · "${posting(5, 'Pixel owners say the speaker crackles, story 6')}" · QA-0906 (BigQuery · BSIP, 8:01 AM ET).`,
    `early detection: Reviewed, but its card could not be posted · "${problem(22)} (CARDHELD)" · Chat gave no message back for the card.`,
    `early detection: Never reviewed · "${posting(5, 'Pixel owners say app 12 freezes, story 42')}" · Pushed out of the full queue by higher-ranked stories.`,
    `early detection: Never reviewed · "${posting(4, 'Pixel owners say the clock app is late, story 43')}" · The review queue was full.`,
    `early detection: Never reviewed · "${posting(3, 'Malware hides in a fake Pixel update, story 52')}" · Early signals are switched OFF (row 39).`,
    `early detection: Never reviewed · "${posting(4, 'Scam ads use the Google Pay logo, story 53')}" · Today's 8 early signals were used.`,
    `early detection: Its main post already has an alert · "${posting(5, 'Pixel owners say the night light flickers, story 67')}" · QA-0967 (BigQuery · BSIP, 1:50 PM ET).`,
    'early detection: Never reviewed · "A story whose details are gone" · Its saved details were gone when its turn came.',
    `early detection: Never reviewed · "${posting(3, 'A fake Google prize mail asks for passwords, story 73')}" · Today's limit of 40 was reached.`,
    `early detection: Never reviewed · "${posting(5, 'Pixel owners say the torch stays on, story 71')}" · Today's limit of 40 was reached.`,
    `early detection: Never reviewed · "${posting(9, 'Leaked passwords from a data breach, people say, story 72 (post 1)')}" · Today's limit of 40 was reached.`,
  ];
  // Lines the run log had for an ending before the notes: each is still there, word for word
  const OLD_LINES = [
    'early detection: fast triage held back ED-CLU-clu_ends004-202610141216: routine noise (routine noise 0.93, severity low 0.6) · about Google 0.84 · brand risk 0.09 · independent 0.29 · routine noise 0.93 · category "none" 0.6 · severity 1 (low 0.6)',
    'early detection: held back a repeat of "Small accounts report problem 1": 8 accounts vs 6 on its card at 8:16 AM ET (QA-1001), nothing new',
    'early detection: dismissed "Small accounts report problem 7" after its review, so it was filtered out: Benign chatter, nothing for Google to act on',
    'early detection: held back "Small accounts report problem 8" after its review: non-English signal (Portuguese) excluded under the English-language collection rule',
    'early detection: held back "Small accounts report problem 9" after its review: already alerted as a known issue (QA-4228, "Pixel camera crash"): nothing materially new',
    'early detection: dismissed "Small accounts report problem 11" after its review, so it was filtered out: matched evergreen noise pattern "Shot on Pixel showcase"',
    'early detection: held back a repeat of "Low-tier claim cluster (8 accounts): Pixel owners say the weather widget looks odd REVDIS…": already queued in the last 24 hours with 5 accounts, nothing new',
    'early detection: held back a repeat (ED-CLU-clu_ends019-202610141300): 5 accounts vs 12 on its card at 9:01 AM ET (QA-1008), nothing new',
    'early detection: dropped ED-WAT-clu_ends021-202610141316 (its review failed 2 times: no card without a review)',
    'early detection: dropped ED-CLU-clu_ends020-202610141316 (2 reviews started without finishing)',
    'early detection: dropped ED-CLU-clu_ends031-202610141331 (not reviewed within 3 hours of being queued)',
    'early detection: dropped ED-WAT-clu_ends051-202610141650 (the early watch is OFF)',
    'QA-1001 (early detection): 👍 Monitor build-up: Early reports worth watching',
    'QA-1003 (early detection): 👍 Needs a human look: AI review unavailable, so a person makes the call',
  ];

  const obj = (bot, row) => bot.edNoteObj_(row);
  /** The day's numbers after a run, and whether they add up. */
  const sums = look => {
    const d = look.day;
    return { found: d.found, sum: d.cards + d.under + d.letgo + d.never + look.waiting, parts: [d.cards, d.under, d.letgo, d.never, look.waiting] };
  };
  /** Runs the long mixed day in a world; after(run, look, rows): the run, what the bot holds after it, the run's record. */
  const runDay = (o, after, beforeEach) => {
    const w = ends.world(o);
    if (beforeEach) {
      const run = w.run;
      w.run = (time, rows) => { beforeEach(w); return run(time, rows); };
    }
    ends.day(w, (run, look) => after(run, look, w.t.bot.edNotesOfRun_().map(r => obj(w.t.bot, r)), w));
    return w;
  };

  test('early detection notes: the outcomes are thirteen names and no others; each counts in exactly one of the day\'s four numbers; a name that is not one of them is refused: nothing is counted, nothing recorded, and the log says so', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    eq(bot.ev('ED_OUTCOMES_'), OUTCOMES);
    eq(bot.ev('ED_NOTE_FIELDS_'), FIELDS);
    eq(OUTCOMES.map(o => bot.edOutcomeGroup_(o)),
      ['cards', 'cards', 'cards', 'cards', 'under', 'letgo', 'letgo', 'letgo', 'letgo', 'letgo', 'letgo', 'never', 'letgo']);
    eq(bot.ev('Object.keys(ED_OUT_GROUPS_).reduce((all, k) => all.concat(ED_OUT_GROUPS_[k]), []).slice().sort()'), OUTCOMES.slice().sort());

    const errors = [];
    bot.console.error = msg => errors.push(String(msg));
    const ctx = { now: () => g.clock.now, log: () => { throw new Error('no log line for a refused note'); } };
    const sig = ends.signal(1);
    for (const name of ['Card posted', 'never reviewed', 'Dropped', '', undefined]) {
      eq(bot.edNote_(ctx, sig, name, 'because', {}), null, String(name));
    }
    eq([bot.edNotesOfRun_(), g.props.has('EARLY_DETECTION_TODAY'), errors.length], [[], false, 5]);
    assert.match(errors[0], /^early detection: "Card posted" is not one of the outcomes, so nothing was noted$/);
    // and a name that is one: counted and recorded
    const said = [];
    const row = bot.edNote_({ now: () => g.clock.now, log: m => said.push(m) }, sig, 'Not English', 'most of its posts are not in English', {});
    eq(obj(bot, row), { at: g.clock.now, id: sig.alert_id, outcome: 'Not English', why: 'Most of its posts are not in English.',
      story: posting(5, 'Pixel owners say the camera app crashes after the update, story 1'), link: sig.primary_url, kind: 'Story',
      accounts: 5, platforms: 'X, Reddit', tag: '-', card: '', message: '' });
    eq(bot.edNotesOfRun_(), [row]);
    eq(said, [`early detection: Not English · "${posting(5, 'Pixel owners say the camera app crashes after the update, story 1')}" · Most of its posts are not in English.`]);
    const day = JSON.parse(g.props.get('EARLY_DETECTION_TODAY'));
    eq([day.found, day.cards, day.under, day.letgo, day.never], [1, 0, 0, 1, 0]);
  });

  test('early detection notes: over the long mixed day the numbers add up after EVERY run (found = cards + under another alert + let go + never reviewed + waiting), in the one-space setup and in the Mirror flow, with row 46 ON and OFF; the record says of each signal what became of it, in words ready to show, the same in all four', () => {
    const seen = {};
    for (const flow of ['one-space', 'mirror']) {
      for (const row46 of [false, true]) {
        const name = `${flow}, row 46 ${row46 ? 'ON' : 'OFF'}`;
        const rows = [];
        const logs = [];
        let runs = 0;
        const w = runDay({ flow, row46 }, (run, look, recs) => {
          runs++;
          const s = sums(look);
          eq(s.found, s.sum, `${name}, the run at ${run.at} (${run.label}): ${JSON.stringify(s.parts)}`);
          recs.forEach(r => rows.push({ run: run.at, r }));
          logs.push(...look.logs.map(String));
        });
        eq(runs, 37, name);
        eq(rows.map(x => [x.run, x.r.outcome, x.r.why, x.r.story, x.r.kind, x.r.accounts, x.r.tag, x.r.card]), DAY, name);
        // the rest of each row: its signal's id and main post, its platforms, and a card's message in the flow's space
        const sig = ends.dayPlan().signals;
        const byId = new Map([].concat(...Object.keys(sig).map(k => sig[k])).map(x => [x.alert_id, x]));
        rows.forEach(({ r }) => {
          const from = byId.get(r.id);
          assert.ok(from, `${name}: ${r.id}`);
          eq([r.link, r.platforms], r.story === 'A story whose details are gone' ? ['', ''] : [from.primary_url, from.platforms_csv], `${name}: ${r.id}`);
          eq(r.message.indexOf(`${w.space}/messages/`) === 0, r.card !== '', `${name}: ${r.id} ${r.message}`);
          assert.ok(JSON.stringify(FIELDS.map(f => r[f])).length <= 448, `${name}: ${r.id}`);
        });
        // every outcome the code can reach today is in the day (two wait for the parts of the plan that come next)
        eq(OUTCOMES.filter(o => !rows.some(x => x.r.outcome === o)), ['Added under another alert\'s card', 'Topic busier than usual, not a story'], name);
        // the run log: one line for each ending that had none, and the lines it had are as they were
        eq(logs.filter(l => OUTCOMES.some(o => l.indexOf(`early detection: ${o} · `) === 0)), NEW_LINES, name);
        OLD_LINES.forEach(l => assert.ok(logs.includes(l), `${name}: ${l}`));
        // the numbers added up on their own: C19's writer never had to put found right
        eq(logs.filter(l => /did not add up/.test(l)), [], name);
        seen[name] = rows.length;
      }
    }
    eq(seen, { 'one-space, row 46 OFF': 51, 'one-space, row 46 ON': 51, 'mirror, row 46 OFF': 51, 'mirror, row 46 ON': 51 });
  });

  test('early detection notes: a signal whose ending leaves it unmarked is read again at every check and noted once: the cap of 40, the early watch\'s share and switch, a main post another alert covers; with the script cache emptied before every run too (the memory of them is kept with the day\'s counts)', () => {
    const outcomes = cacheGone => {
      const out = [];
      runDay({ flow: 'one-space', row46: false }, (run, look, recs) => {
        const s = sums(look);
        eq(s.found, s.sum, `${cacheGone ? 'cache emptied' : 'cache kept'}, the run at ${run.at}`);
        recs.forEach(r => out.push([run.at, r.id, r.outcome, r.why]));
      }, cacheGone ? w => w.t.g.cache.clear() : null);
      return out;
    };
    const kept = outcomes(false);
    eq(outcomes(true), kept);
    // the signals of those endings were handed over at two or three checks each
    const times = id => kept.filter(x => x[1] === id).map(x => x[0]);
    const G = ends.dayPlan().signals;
    eq([G.S6, G.W52, G.W53, G.S67, G.W73, G.C71, G.C72].map(s => times(s.alert_id)),
      [['08:16'], ['13:05'], ['13:20'], ['23:40'], ['D2 00:35'], ['D2 00:35'], ['D2 00:35']]);
  });

  test('early detection notes: the day\'s counts start again at midnight Eastern with the signals that wait as found; several signals that leave the queue together are each counted; and a day that starts in the middle of a run still adds up', () => {
    const g = makeGoogle(NOW);  // 08:00 Eastern
    const bot = loadBot(g.services, g.clock);
    const props = g.services.PropertiesService.getScriptProperties();
    const ctx = { now: () => g.clock.now, log() {} };
    const numbers = () => bot.edDayNumbers_(props);
    const adds = n => n.found === n.cards + n.under + n.letgo + n.never + n.waiting;
    const sigs = [1, 2, 3, 4].map(n => ends.signal(n));
    sigs.forEach(s => eq(bot.edQueuePut_(props, s, g.clock.now).queued, true));
    eq(bot.edNote_(ctx, ends.signal(5), 'Not English', 'x', {}) !== null, true);
    eq(numbers(), { found: 5, cards: 0, under: 0, letgo: 1, never: 0, waiting: 4 });

    // the next day, 3 hours and more after they were queued: all four leave the queue in one go
    g.clock.now = NOW + 20 * HOUR;
    const pruned = bot.edQueuePrune_(props, g.clock.now);
    eq([pruned.dropped.length, pruned.dropped.map(x => x.cause), pruned.dropped.map(x => x.row.alert_id).sort()],
      [4, ['stale', 'stale', 'stale', 'stale'], sigs.map(s => s.alert_id).sort()]);
    eq(numbers(), { found: 4, cards: 0, under: 0, letgo: 0, never: 0, waiting: 0 });  // the new day began with the four that waited
    pruned.dropped.forEach(x => bot.edNote_(ctx, x.row, 'Never reviewed', bot.edNeverWhy_(x.cause), { waited: true, logged: true }));
    eq(numbers(), { found: 4, cards: 0, under: 0, letgo: 0, never: 4, waiting: 0 });
    eq(JSON.parse(g.props.get('EARLY_DETECTION_TODAY')).day, '2026-10-15');

    // A run that is under way at midnight: three signals leave the queue together before midnight, and are counted after
    sigs.forEach((s, i) => bot.edQueuePut_(props, ends.signal(10 + i), g.clock.now));
    eq(numbers(), { found: 8, cards: 0, under: 0, letgo: 0, never: 4, waiting: 4 });
    g.clock.now = NOW + 39 * HOUR + 59 * MIN;  // 23:59 on the second day
    [10, 11, 12].forEach(n => bot.edQueueDrop_(props, bot.edQueueKey_(ends.signal(n))));
    g.clock.now += 2 * MIN;  // 00:01 on the third
    [10, 11, 12].forEach(n => bot.edNote_(ctx, ends.signal(n), 'Reviewed and dismissed', 'x', { waited: true, logged: true }));
    eq(numbers(), { found: 4, cards: 0, under: 0, letgo: 3, never: 0, waiting: 1 });
    eq([JSON.parse(g.props.get('EARLY_DETECTION_TODAY')).day, adds(numbers())], ['2026-10-16', true]);

    // Counts that went wrong one day are right again the next: found starts at the queue's length, not at what was counted
    g.props.set('EARLY_DETECTION_TODAY', JSON.stringify(Object.assign(JSON.parse(g.props.get('EARLY_DETECTION_TODAY')), { found: 40 })));
    eq(adds(numbers()), false);
    g.clock.now += 24 * HOUR;
    bot.edQueueDrop_(props, bot.edQueueKey_(ends.signal(13)));
    bot.edNote_(ctx, ends.signal(13), 'Reviewed and dismissed', 'x', { waited: true, logged: true });
    eq(numbers(), { found: 1, cards: 0, under: 0, letgo: 1, never: 0, waiting: 0 });

    // The day the bot is updated: the counts it kept until then become its cards and what it let go, and they add up
    g.props.set('EARLY_DETECTION_TODAY', JSON.stringify({ day: '2026-10-17', clusters: 3, velocity: 1, queued: 9, repeats: 2, dismissed: 4,
      triaged: 1, watch: 1, watchq: 2, at: 'Oct 17, 8:01 AM EDT', problem: '' }));
    bot.edQueuePut_(props, ends.signal(20), g.clock.now);
    bot.edQueuePut_(props, ends.signal(21), g.clock.now);
    eq(numbers(), { found: 14, cards: 5, under: 0, letgo: 7, never: 0, waiting: 2 });
    const day = JSON.parse(g.props.get('EARLY_DETECTION_TODAY'));
    eq([day.clusters, day.velocity, day.queued, day.repeats, day.dismissed, day.triaged, day.watch, day.watchq, day.at],
      [3, 1, 9, 2, 4, 1, 1, 2, 'Oct 17, 8:01 AM EDT']);  // what it kept is still there
  });

  test('early detection notes: a signal already in the queue that is handed over as new (its mark was lost) is not counted again; a signal queued is found once, whatever became of it after', () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    const sig = ends.signal(1, { at: '08:16' });
    w.busy = true;  // no review starts
    let look = w.run('08:16', [sig]);
    eq([look.waiting, sums(look)], [1, { found: 1, sum: 1, parts: [0, 0, 0, 0, 1] }]);
    w.t.g.props.delete('EARLY_DETECTION_SEEN');
    look = w.run('08:31', [sig]);
    eq([look.waiting, sums(look), w.t.bot.edNotesOfRun_()], [1, { found: 1, sum: 1, parts: [0, 0, 0, 0, 1] }, []]);
    w.busy = false;
    look = w.run('08:32', [sig]);
    eq([look.waiting, sums(look), w.t.bot.edNotesOfRun_().map(r => obj(w.t.bot, r).outcome)],
      [0, { found: 1, sum: 1, parts: [1, 0, 0, 0, 0] }, ['Card posted: Monitor build-up']]);
  });

  test('early detection notes: the run\'s record is emptied at the start of every run, and holds copies', () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    w.run('08:16', [ends.signal(5, { at: '08:16', words: `${ends.NOT_ENGLISH} 5` })]);
    const first = w.t.bot.edNotesOfRun_();
    eq(first.map(r => obj(w.t.bot, r).outcome), ['Not English']);
    first[0][2] = 'changed by the reader';
    eq(w.t.bot.edNotesOfRun_().map(r => obj(w.t.bot, r).outcome), ['Not English']);
    w.run('08:17');
    eq(w.t.bot.edNotesOfRun_(), []);
  });

  test('early detection notes: a record row is at most 448 characters of JSON in the worst case, so 200 rows fit one 90,000-character cache value; what gives way is the end of the why, then of the title, then the tag, the link and the card\'s message; the outcome and the id never', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const size = row => JSON.stringify(row).length;
    const long = n => Array.from({ length: n }, (_, i) => 'word' + (i % 10)).join(' ');
    const id = `ED-VEL-RISK_TERM_GROUP-${'0123456789abcdef'.repeat(2)}-202610141246`;  // the longest id the producer makes: 68
    eq(id.length, 68);
    const link = `https://www.reddit.com/r/GooglePixel/comments/1abcde/${'a_long_title_in_the_link_'.repeat(3)}/`;
    const message = `spaces/AAQAworstCase1/messages/client-zeda-${'f'.repeat(40)}`;
    const worst = { alert_id: id, signal_type: 'VELOCITY_SPIKE', velocity_grain: 'RISK_TERM_GROUP', signal_key: 'outage_broken_feature',
      unique_low_tier_authors: 999999, platforms_csv: 'X, Reddit, TikTok, YouTube, Instagram, Threads, Bluesky', primary_url: link,
      headline: 'Low-tier velocity 3.2x (RISK_TERM_GROUP: outage_broken_feature)',
      representative_posts_json: JSON.stringify([{ url: link, snippet: long(60) }]) };
    const tag = 'Content - Negative reaction to Google influencer post/activity (unconfirmed, 100% sure)';
    const all = [];
    for (const outcome of OUTCOMES) {
      for (const extra of [{}, { title: `"${long(40)}"`, tag, card: { id: 'QA-123456', message } }]) {
        const row = bot.edNoteRow_(worst, outcome, `${long(80)} "quoted" \\ and so on`, extra, g.clock.now);
        const r = obj(bot, row);
        assert.ok(size(row) <= 448, `${outcome}: ${size(row)}`);
        eq([r.outcome, r.id, r.kind, r.accounts, r.card], [outcome, id, 'Pace jump (risk words)', 999999, extra.card ? 'QA-123456' : '']);
        assert.ok(r.why.length >= 30 && r.story.length >= 20, `${outcome}: ${r.why.length} / ${r.story.length}`);
        all.push(row);
      }
    }
    const rows200 = Array.from({ length: 200 }, (_, i) => all[i % all.length]);
    assert.ok(Math.max(...all.map(size)) <= 448 && JSON.stringify(rows200).length <= 90000, String(JSON.stringify(rows200).length));

    // What gives way, in order. A row that fits is left as it is:
    const story = ends.signal(1, { au: 6 });
    const fits = bot.edNoteRow_(story, OUTCOMES[5], long(30), { title: 'A headline of the review' }, g.clock.now);
    eq([obj(bot, fits).why, obj(bot, fits).story, size(fits) <= 448], [`W${long(30).slice(1)}.`, 'A headline of the review', true]);
    // ... a long why loses its end first, and nothing else changes
    const cutWhy = obj(bot, bot.edNoteRow_(story, OUTCOMES[5], long(60), { title: 'A headline of the review', tag }, g.clock.now));
    eq([cutWhy.story, cutWhy.tag, cutWhy.link, /…$/.test(cutWhy.why), cutWhy.why.length >= 80], ['A headline of the review', tag, story.primary_url, true, true]);
    // ... then the title
    const step = (row, extra) => obj(bot, bot.edNoteRow_(row, OUTCOMES[1], long(60), extra, g.clock.now));
    const short = 'spaces/AAQAfits0001/messages/abc.def';
    const s1 = step(story, { title: long(30), tag, card: { id: 'QA-1001', message: short } });
    eq([s1.why.length, s1.story.length >= 50 && s1.story.length < 100, s1.tag, s1.link, s1.message], [80, true, tag, story.primary_url, short]);
    // ... then the tag (the same row with the longest id)
    const s2 = step(Object.assign({}, story, { alert_id: id }), { title: long(30), tag, card: { id: 'QA-1001', message: short } });
    eq([s2.why.length, s2.story.length, s2.tag, s2.link, s2.message], [80, 50, '-', story.primary_url, short]);
    // ... then the main post's link (a long link, a long message name, many platforms)
    const s3 = step(worst, { title: long(30), tag, card: { id: 'QA-1001', message } });
    eq([s3.why.length, s3.story.length, s3.tag, s3.link, s3.message], [80, 50, '-', '', message]);
    // ... then the card's message name, then more of the why: only when the words are full of characters JSON writes as two
    const hostile = obj(bot, bot.edNoteRow_(Object.assign({}, worst, { alert_id: 'x'.repeat(200), platforms_csv: 'p'.repeat(200) }),
      OUTCOMES[12], '"'.repeat(400), { title: '\\'.repeat(400), tag: '"'.repeat(200), card: { id: 'QA-1001', message } }, g.clock.now));
    assert.ok(size(FIELDS.map(f => hostile[f])) <= 448, String(size(FIELDS.map(f => hostile[f]))));
    eq([hostile.outcome, hostile.id.length, hostile.card, hostile.tag, hostile.link, hostile.message, hostile.why.length >= 30 && hostile.why.length < 80,
      hostile.story.length >= 20], [OUTCOMES[12], 80, 'QA-1001', '-', '', '', true, true]);
    // quotes and backslashes never get into an id, the platforms or a card's id
    const odd = obj(bot, bot.edNoteRow_(Object.assign({}, story, { alert_id: 'ED-"CLU"\\1', platforms_csv: 'X, "Reddit"\n\tTikTok' }),
      OUTCOMES[1], 'x', { card: { id: '"QA-7"', message: short } }, g.clock.now));
    eq([odd.id, odd.platforms, odd.card], ['ED-CLU1', 'X, Reddit TikTok', 'QA-7']);
    // a link too long to keep whole is left out from the start (never cut), and so is a message name that is no message name
    const s4 = step(Object.assign({}, story, { primary_url: `https://example.test/${'c'.repeat(140)}` }), { card: { id: 'QA-1', message: 'not a message' } });
    eq([s4.link, s4.message, s4.card], ['', '', 'QA-1']);
  });

  test('early detection notes: the day\'s counts stay far under a script property\'s 9 KB in the worst case: every count at six digits, the longest problem text, and the newest 120 signals counted', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const props = g.services.PropertiesService.getScriptProperties();
    eq(bot.ev('ED_NOTED_MAX_'), 120);
    // the keys kept cover every signal a check can still be handed: the producer's buffer holds 30 and lets the oldest
    // go first, so between a signal's note and its last read fewer than twice that many others can be counted
    assert.ok(bot.ev('ED_NOTED_MAX_') > 2 * bot.ev('EWS_BUFFER_MAX_'), String(bot.ev('EWS_BUFFER_MAX_')));
    const full = { day: '2026-10-14', clusters: 999999, velocity: 999999, queued: 999999, repeats: 999999, dismissed: 999999, triaged: 999999,
      watch: 999999, watchq: 999999, at: 'Sep 30, 12:59 PM EDT', problem: 'a BigQuery source table was not found',
      found: 999999, cards: 249999, under: 250000, letgo: 250000, never: 250000 };  // six digits that add up
    g.props.set('EARLY_DETECTION_TODAY', JSON.stringify(full));
    const ids = Array.from({ length: 160 }, (_, i) => `ED-VEL-RISK_TERM_GROUP-${String(i).padStart(32, '0')}-202610141246`);
    eq(ids.map(id => bot.edCount_(props, 'never', false, id)), ids.map(() => true));
    const stored = g.props.get('EARLY_DETECTION_TODAY');
    const day = JSON.parse(stored);
    eq([day.noted.length, day.never, day.found], [120, 250000 + 160, 999999 + 160]);
    assert.ok(stored.length <= 8800 && stored.length < 2600, String(stored.length));
    // the newest 120 are remembered: one of them is not counted again, an older one would be
    eq([bot.edCount_(props, 'never', false, ids[159]), bot.edCount_(props, 'never', false, ids[40]), bot.edCount_(props, 'never', false, ids[0])],
      [false, false, true]);
    // the check's own writing of the counts keeps them (noteEarlyWave_ copies what is there; the queue is empty, so the
    // numbers add up as they are)
    bot.noteEarlyWave_(props, 1, 0, 'a BigQuery source table was not found', { queued: 1, repeats: 1, triaged: 1, watch: 1, watchQueued: 1 });
    const after = JSON.parse(g.props.get('EARLY_DETECTION_TODAY'));
    eq([after.noted.length, after.found, after.never, after.clusters], [120, day.found + 1, day.never + 1, 1000000]);
    assert.ok(g.props.get('EARLY_DETECTION_TODAY').length <= 8800);
  });

  test('early detection notes: the words of a row: its kind, its title (the review\'s headline, a topic\'s count, else a plain title: never the producer\'s label), its tag as a first guess (the card\'s own, the fast triage\'s answer, the risk words in plain words, else a dash), and its why as one sentence without decimals', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const sig = (n, o) => ends.signal(n, o);
    // kind
    eq([sig(1), sig(1, { type: 'EARLY_WATCH', au: 3 }), sig(1, { type: 'VELOCITY_SPIKE' }), sig(1, { type: 'VELOCITY_SPIKE', grain: 'PRIORITY_TOPIC' }),
      sig(1, { type: 'VELOCITY_SPIKE', grain: 'RISK_TERM_GROUP' }), {}].map(r => bot.edNoteKind_(r)),
    ['Story', 'Early signal (3-4 accounts)', 'Pace jump (story)', 'Pace jump (topic)', 'Pace jump (risk words)', 'Story']);
    // what is left of a queued signal whose stored row is gone: its kind and accounts, from its queue entry
    eq([{ id: 'ED-CLU-CLU-1-2', sig: 'c', au: 5 }, { id: 'ED-WAT-CLU-1-2', sig: 'w', au: 3 }, { id: 'ED-VEL-CLUSTER-ab-2', sig: 'v', au: 9 },
      { id: 'ED-VEL-PRIORITY_TOPIC-ab-2', sig: 'v', au: 30 }, { id: 'ED-VEL-RISK_TERM_GROUP-ab-2', sig: 'v', au: 8 }, { id: '', sig: 'v' }]
      .map(e => { const r = bot.edEntryRow_(e); return [bot.edNoteKind_(r), r.unique_low_tier_authors, bot.edNoteStory_(r, '')]; }),
    [['Story', 5], ['Early signal (3-4 accounts)', 3], ['Pace jump (story)', 9], ['Pace jump (topic)', 30], ['Pace jump (risk words)', 8],
      ['Pace jump (story)', 0]].map((x, i) => x.concat([i === 3 ? 'Topic: not named, 30 accounts in an hour' : 'A story whose details are gone'])));
    eq(bot.ev('EWS_VEL_WINDOW_MIN_'), 60);  // "in an hour"

    // title
    eq(bot.edNoteStory_(sig(1), '  Owners   report a camera crash '), 'Owners report a camera crash');
    eq(bot.edNoteStory_(sig(2, { au: 6 }), ''), posting(6, 'Pixel owners say the camera app crashes after the update, story 2'));
    eq(bot.edNoteStory_(sig(3, { type: 'EARLY_WATCH', au: 3, words: 'Fake support ads, story 3' }), ''), posting(3, 'Fake support ads, story 3'));
    eq(bot.edNoteStory_(sig(4, { type: 'VELOCITY_SPIKE', au: 12, words: 'The reader fails (again), story 4' }), ''),
      posting(12, 'The reader fails (again), story 4 (post 1)'));
    eq(bot.edNoteStory_(sig(5, { type: 'VELOCITY_SPIKE', grain: 'RISK_TERM_GROUP', key: 'outage_broken_feature', au: 9, words: 'Gmail is down, story 5' }), ''),
      posting(9, 'Gmail is down, story 5 (post 1)'));
    eq(bot.edNoteStory_(sig(6, { type: 'VELOCITY_SPIKE', grain: 'PRIORITY_TOPIC', key: 'Search & Shopping', ratio: '1.9', au: 36 }), ''),
      'Topic: Search & Shopping, 36 accounts in an hour (1.9x the usual)');
    eq(bot.edNoteStory_(sig(6, { type: 'VELOCITY_SPIKE', grain: 'PRIORITY_TOPIC', key: 'Search & Shopping', ratio: '1.9', au: 36 }), 'People can\'t find a shop'),
      'People can\'t find a shop');
    eq(bot.edNoteStory_(Object.assign(sig(6, { type: 'VELOCITY_SPIKE', grain: 'PRIORITY_TOPIC', key: 'Chrome', au: 1 }), { velocity_ratio: 0 }), ''),
      'Topic: Chrome, 1 account in an hour');
    const every = [sig(1), sig(1, { type: 'EARLY_WATCH', au: 3 }), sig(1, { type: 'VELOCITY_SPIKE' }),
      sig(1, { type: 'VELOCITY_SPIKE', grain: 'PRIORITY_TOPIC' }), sig(1, { type: 'VELOCITY_SPIKE', grain: 'RISK_TERM_GROUP', key: 'privacy_data_leak' })];
    every.forEach(r => assert.ok(!/low-tier|claim cluster|early story|velocity|RISK_TERM|PRIORITY_TOPIC|CLUSTER|privacy_data_leak/i.test(bot.edNoteStory_(r, '')),
      bot.edNoteStory_(r, '')));

    // tag
    const dec = (c, cp, l) => ({ g: 0.9, r: 0.5, i: 0.3, n: 0.4, c, cp, p0: 0, s: l, l, sc: 0.57, sp: [0, 0, 0, 0, 0] });
    eq(bot.edNoteTag_(sig(1), dec('Content - Negative reaction to owned social post', 0.32, 1), ''),
      'Content - Negative reaction to owned social post (32% sure) · severity low');
    eq(bot.edNoteTag_(sig(1), dec('none', 0.875, 0), ''), 'None: not a brand-safety issue (88% sure) · severity none');
    eq(bot.edNoteTag_(sig(1), dec('other risk', 0.6, 4), ''), 'A risk no Exposure Tag names (60% sure) · severity critical');
    eq(bot.edNoteTag_(sig(1), dec('other risk', 0.6, 4), 'Product - Perceived bias'), 'Product - Perceived bias');  // after a card: its own
    eq(bot.edNoteTag_(sig(1, { type: 'EARLY_WATCH', au: 3 }), null, ''), 'A risk no Exposure Tag names (60% sure) · severity high');  // the answers it carries
    const kept = sig(7);
    eq(bot.edNoteTag_(kept, null, ''), '-');
    bot.ftRemember_(kept.alert_id, dec('Product - Privacy concerns', 0.41, 2));
    eq(bot.edNoteTag_(kept, null, ''), 'Product - Privacy concerns (41% sure) · severity medium');  // kept from an earlier check
    eq(bot.edNoteTag_(sig(8, { risk: 'privacy_data_leak' }), null, ''), 'Risk words: Privacy or data leak');
    eq(bot.edNoteTag_(sig(8, { risk: 'safety_csam_selfharm,security_scam_malware,not_a_group' }), null, ''),
      'Risk words: Child safety or self-harm; Scam, phishing or malware');
    eq(bot.edNoteTag_(sig(9, { type: 'VELOCITY_SPIKE', grain: 'RISK_TERM_GROUP', key: 'ai_hallucination_bias', pri: 'P0' }), null, ''),
      'Risk words: AI answer wrong or biased');
    eq(bot.edNoteTag_(sig(10, { pri: 'P0' }), null, ''), '-');  // never the producer's P0 / P1 / P2 hint
    eq(bot.ev('EWS_RISK_GROUPS_.map(x => x.key)').map(k => bot.ev('ED_RISK_WORDS_')[k]),
      ['Privacy or data leak', 'Child safety or self-harm', 'Scam, phishing or malware', 'Outage or broken feature',
        'AI answer wrong or biased', 'Legal, antitrust or layoffs']);
    // the tag a card shows: the one the review confirmed, or named without being sure; none without a review
    const rev = slrr => ({ rev: { slrr }, fields: slrr && slrr.confidence >= 0.8 ? { exposure_tag: slrr.tag, priority: 'P0' } : { priority: 'P1' } });
    eq([bot.edCardTag_(rev({ is: true, tag: 'Product - Perceived bias', priority: 'P0', confidence: 0.9 })),
      bot.edCardTag_(rev({ is: true, tag: 'Product - Perceived bias', priority: 'P0', confidence: 0.62 })),
      bot.edCardTag_(rev({ is: false, tag: '', confidence: 0.9 })), bot.edCardTag_(rev(null)), bot.edCardTag_({ rev: null, fields: {} })],
    ['Product - Perceived bias', 'Product - Perceived bias (unconfirmed, 62% sure)', '', '', '']);

    // why
    eq(['its review failed twice', ' Already   a sentence. ', 'cut short…', 'really?', '', null].map(s => bot.edNoteSentence_(s)),
      ['Its review failed twice.', 'Already a sentence.', 'Cut short…', 'Really?', '', '']);
    eq(['day', 'watchDay', 'watchOff', 'full', 'pushed', 'stale', 'failed', 'lost', 'long', 'something else'].map(c => bot.edNeverWhy_(c)),
      ['today\'s limit of 40 was reached', 'today\'s 8 early signals were used', 'early signals are switched OFF (row 39)',
        'the review queue was full', 'pushed out of the full queue by higher-ranked stories', 'waited 3 hours while the bot worked on alerts',
        'its review failed twice', 'its saved details were gone when its turn came', 'its details were too long to keep for a review', '']);
    eq([bot.ev('EW_MAX_PER_DAY_'), bot.ev('EW_WATCH_QUEUE_PER_DAY_'), bot.ev('ED_QUEUE_MAX_AGE_MS_') / HOUR, bot.ev('ED_QUEUE_MAX_TRIES_')], [40, 8, 3, 2]);
    eq(bot.edNoiseWhy_({ g: 0.84, n: 0.9, l: 1, sc: 0.57 }, 'routine noise (routine noise 0.9, severity low 0.57)'),
      'Looks like routine chatter (90% likely), severity low (57% sure)');
    eq(bot.edNoiseWhy_({ g: 0.06, n: 0.5, l: 0, sc: 0.7 }, 'not about Google (about Google 0.06, severity none 0.7)'),
      'Looks unrelated to Google (94% likely), severity none (70% sure)');
    const at = NOW + 2 * HOUR + 51 * MIN;  // 10:51 AM Eastern
    const later = NOW + 5 * HOUR;
    eq(bot.edRepeatWhy_(sig(1, { au: 8 }), {}, { at, au: 5 }, later), 'First seen 10:51 AM ET with 5 accounts; 8 now, nothing new');
    eq(bot.edRepeatWhy_(sig(1, { au: 8 }), {}, { at, au: 1 }, later), 'First seen 10:51 AM ET with 1 account; 8 now, nothing new');
    eq(bot.edRepeatWhy_(sig(1, { au: 8 }), {}, { at, au: Infinity }, later), 'First seen 10:51 AM ET; nothing new since');
    eq(bot.edRepeatWhy_(sig(1, { au: 8 }), {}, null, later), 'Seen in the last 24 hours, nothing new');
    const prior = ed => ({ prior: { au: 6, latest: { at, row: 'QA-1001', ed, msg: 'spaces/AAQAcards0001/messages/abc.def' } } });
    eq(bot.edRepeatWhy_(sig(1, { au: 8 }), prior('ED-CLU-other'), null, later), 'Its card of 10:51 AM ET had 6 accounts; 8 now, nothing new');
    eq(bot.edRepeatWhy_(sig(1, { au: 8 }), prior('ED-CLU-other'), null, later + 24 * HOUR), 'Its card of Oct 14, 10:51 AM ET had 6 accounts; 8 now, nothing new');
    eq(bot.edRepeatWhy_(sig(1, { au: 8 }), prior(sig(1, { au: 8 }).alert_id), null, later), 'Its card is already in the space');
    eq([bot.edPriorCard_(prior('x')), bot.edPriorCard_({})], [{ id: 'QA-1001', message: 'spaces/AAQAcards0001/messages/abc.def' }, null]);
    const alert = (ingested, o) => Object.assign({ alert_id: 'QA-1001', created_at: NOW + 8 * MIN, ingested,
      source_message: 'spaces/AAQAsource001/messages/s.s', forward_message: 'spaces/AAQAcards0001/messages/f.f' }, o || {});
    eq(['BSIP', 'Sprinklr', 'BMIE', '', 'Watch alert', 'Other alert', 'Sheet test alert'].map(i => bot.edAlertWords_(alert(i), later)),
      ['QA-1001 (BigQuery · BSIP, 8:08 AM ET)', 'QA-1001 (BigQuery · Sprinklr, 8:08 AM ET)', 'QA-1001 (BigQuery · BMIE, 8:08 AM ET)',
        'QA-1001 (Burson alert, 8:08 AM ET)', 'QA-1001 (Watch alert, 8:08 AM ET)', 'QA-1001 (Other alert, 8:08 AM ET)',
        'QA-1001 (Sheet test alert, 8:08 AM ET)']);
    eq([bot.edAlertCard_(alert('BSIP')), bot.edAlertCard_(alert('', { forward_message: '' }))],
      [{ id: 'QA-1001', message: 'spaces/AAQAcards0001/messages/f.f' }, { id: 'QA-1001', message: 'spaces/AAQAsource001/messages/s.s' }]);
    // none of the bot's own reasons holds a decimal
    const own = DAY.map(x => x[2]).concat(['day', 'watchDay', 'watchOff', 'full', 'pushed', 'stale', 'failed', 'lost', 'long'].map(c => bot.edNeverWhy_(c)));
    own.forEach(w => assert.ok(!/\d\.\d/.test(w), w));
  });

  test('early detection notes: the queue says who left it: edQueuePut_ hands back the signals a better-ranked one pushed out, each with its stored row, and why a signal was not queued; edQueuePrune_ hands back each signal it gives up on with its row and the cause', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const props = g.services.PropertiesService.getScriptProperties();
    const sig = (n, pri) => ends.signal(n, { pri });
    for (let n = 1; n <= 12; n++) eq(bot.edQueuePut_(props, sig(n, 'P1'), NOW + n), { queued: true, why: '', pushed: [] });
    eq(bot.edQueuePut_(props, sig(3, 'P1'), NOW + 20), { queued: false, why: 'already there', pushed: [] });
    eq(bot.edQueuePut_(props, sig(13, 'P2'), NOW + 21), { queued: false, why: 'ranked out', pushed: [] });
    const big = Object.assign(sig(14, 'P0'), { representative_posts_json: JSON.stringify([{ url: `https://example.test/${'u'.repeat(9000)}`, snippet: 'x' }]) });
    eq(bot.edQueuePut_(props, big, NOW + 22), { queued: false, why: 'too big', pushed: [] });
    const res = bot.edQueuePut_(props, sig(15, 'P0'), NOW + 23);
    eq([res.queued, res.why, res.pushed.length, res.pushed[0].entry.id, res.pushed[0].row.alert_id, res.pushed[0].row.headline],
      [true, '', 1, sig(12).alert_id, sig(12).alert_id, sig(12).headline]);  // the last P1 queued
    eq([bot.edQueueList_(props).length, g.props.has(`ED_ALERT_Q_${bot.edQueueKey_(sig(12))}`)], [12, false]);
    // every signal queued was counted as found; the one pushed out is still to be noted by the caller
    eq(bot.edDayNumbers_(props), { found: 13, cards: 0, under: 0, letgo: 0, never: 0, waiting: 12 });

    bot.edQueueTried_(props, bot.edQueueKey_(sig(15)));
    bot.edQueueTried_(props, bot.edQueueKey_(sig(15)));
    g.props.delete(`ED_ALERT_Q_${bot.edQueueKey_(sig(15))}`);  // its stored row is gone
    const first = bot.edQueuePrune_(props, NOW + MIN);
    eq(first.dropped.map(x => [x.id, x.why, x.cause, x.entry.pri, x.row]), [[sig(15).alert_id, '2 reviews started without finishing', 'failed', 'P0', null]]);
    const rest = bot.edQueuePrune_(props, NOW + 3 * HOUR + MIN);
    eq([rest.dropped.length, rest.dropped.every(x => x.cause === 'stale' && x.why === 'not reviewed within 3 hours of being queued' &&
      x.row.alert_id === x.id && x.entry.k === x.k)], [11, true]);
  });
};
