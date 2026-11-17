// Early Detection's allowance in the Auto-correct flow (BigQuery.gs edAllowance_ and earlyWaveCheck_'s
// queueByAllowance; FastTriage.gs edSerious_): with the setting early_wave_reviews_per_hour above 0 (6 by default) the
// review queue no longer stops at 40 signals a day. Every signal read for the first time is ended or queued in that
// check, or left for the next one; serious ones go first; at most 5 are queued a check, 150 a day
// (early_wave_reviews_per_day), 10 in a clock hour (Eastern) and, of those, 6 ordinary ones. One turned away by the
// check's 5 or an hour's limit comes back at the next check (no ending, no count) until it would leave the window a
// check reads; then, as one refused by the day's limit, it is "Never reviewed" with its cause and marks only its own
// id. Every other flow, and the setting at 0, keep the old rule word for word.
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;
  const ends = require('./ed_endings')(H);
  const FX = require('./decisions_fixtures.json');
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DEFAULTS = {};  // the settings as the config gives them: the allowance ON, 6 an hour, 150 a day
  const say = (what, n, mark) => `Pixel owners say ${what}${mark ? ` ${mark}` : ''}, story ${n}`;
  // an ordinary signal (the fast triage answers severity low, not noise) and a serious one (the usual answer: medium)
  const ordinary = (n, at, mark) => ends.signal(n, { at, words: say(`app ${n} is slow`, n, `DECLOW${mark ? ` ${mark}` : ''}`) });
  const serious = (n, at, mark) => ends.signal(n, { at, words: say(`app ${n} crashes`, n, mark) });
  const props = w => w.t.g.services.PropertiesService.getScriptProperties();
  const recsOf = w => w.t.bot.edNotesOfRun_().map(r => w.t.bot.edNoteObj_(r));
  const storyOf = id => String(id).replace(/^ED-[A-Z_]+-(?:CLUSTER-|PRIORITY_TOPIC-|RISK_TERM_GROUP-)?(?:clu_)?ends0*(\d+)-.*$/, '$1');
  const brief = recs => recs.map(r => [storyOf(r.id), r.outcome, r.why]);
  const NEVER_ORDINARY = 'This hour\'s 6 reviews for ordinary stories were used.';

  /** A one-space world whose runs are checked: after each the numbers add up and found is the number of signals counted. */
  const checked = o => {
    const w = ends.world(Object.assign({ flow: 'one-space', row46: false, settings: DEFAULTS }, o || {}));
    const counted = new Set();
    w.calls = { decisions: 0 };
    const fetch = w.t.g.services.UrlFetchApp.fetch;
    w.t.g.services.UrlFetchApp.fetch = (link, params) => {
      if (String(link).includes('/decisions')) w.calls.decisions++;
      return fetch(link, params);
    };
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

  // -----------------------------------------------------------------------------------------------------------
  // Serious: a pure rule, held to the 13 recorded real answers
  // -----------------------------------------------------------------------------------------------------------

  test('early detection allowance: "serious" on the 13 recorded real answers (8 of Nov 6-12, 5 of the live check of Nov 15): the three real risk stories are serious, the ten others are not; an early-watch story and a P0 risk group always are; tag_raised only when there is no answer; a row without facts is ordinary unless its hint is P0', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const q = bot.decSignalQuestions_();
    const plain = { risk_groups: '', tag_raised: false, signal_type: 'CLUSTER_EMERGENCE', priority_hint: 'P1' };
    const recorded = Object.keys(FX.signal_responses).map(id => [id.replace(/-\d{12}$/, ''),
      bot.decCompact_(bot.decRead_(200, JSON.stringify(FX.signal_responses[id]), q, 300).answers)]);
    // the five answers of the owner's live check of 15 November (their headlines in words, the answers as recorded)
    const live = [
      ['They didn\'t even invited / techno gamerz', [0.26, 0.57, 0.11, 0.04, 0.02]],
      ['A Gemini Ultra account service, screenshots', [0.33, 0.2, 0.2, 0.25, 0.03]],
      ['Pace jump 1.9x on Search & Shopping', [0.48, 0.25, 0.14, 0.09, 0.04]],
      ['I can\'t even find the site when googling it', [0.6, 0.27, 0.1, 0.03, 0.01]],
      ['White text on a dark gray background (a picture)', [0.2, 0.4, 0.22, 0.1, 0.08]],
    ].map(([name, sp]) => [name, { sp }]);
    const said = recorded.concat(live).map(([name, dec]) => [name, bot.edSerious_(plain, dec, { conf: 0.55 })]);
    eq(said, [
      ['ED-CLU-CLU-dc5a8afd13da', true],    // a family sues Google over Gemini's answers about suicide
      ['ED-CLU-CLU-56136e76a9a7', true],    // Google sued over suicide-related AI chats
      ['ED-CLU-CLU-e9dddc0be913', true],    // CERT-In warns Android users to update
      ['ED-CLU-CLU-3aa05dedf0a7', false],   // "Likewise. Used Chrome until they ..."
      ['ED-CLU-CLU-3287667bddd9', false],   // a game announcement
      ['ED-CLU-CLU-abe6decf9a2a', false],   // launch day for Google and Samsung
      ['ED-VEL-PRIORITY_TOPIC-2cb939f86090a0ffb4ed1cce8c43c295', false],  // the 1.4x topic count on Chrome Overall
      ['ED-VEL-CLUSTER-1dd1392bf7db140af902df1be556969f', false],         // "Hi, who are tHi"
      ['They didn\'t even invited / techno gamerz', false],
      ['A Gemini Ultra account service, screenshots', false],
      ['Pace jump 1.9x on Search & Shopping', false],
      ['I can\'t even find the site when googling it', false],
      ['White text on a dark gray background (a picture)', false],
    ]);
    // the bar is Control B43: at 0.45 the screenshots of a Gemini Ultra account service (0.48 on medium or higher) are serious
    eq(bot.edSerious_(plain, live[1][1], { conf: 0.45 }), true);
    eq(bot.edSerious_(plain, live[1][1], null), false);  // no bars: the seed (0.55)
    // the sum is read as written: 0.25 + 0.2 + 0.1 is 0.55, at the bar
    eq(bot.edSerious_(plain, { sp: [0.25, 0.2, 0.25, 0.2, 0.1] }, { conf: 0.55 }), true);
    // always serious: an early-watch story, a P0 risk group, a P0 hint (a row from before the facts were told)
    eq(bot.edSerious_(Object.assign({}, plain, { signal_type: 'EARLY_WATCH' }), live[3][1], null), true);
    eq(bot.edSerious_(Object.assign({}, plain, { risk_groups: 'privacy_data_leak' }), live[3][1], null), true);
    eq(bot.edSerious_({ signal_type: 'VELOCITY_SPIKE', priority_hint: 'P0' }, null, null), true);
    // a taxonomy raise counts only without an answer: the answer decides when there is one
    eq(bot.edSerious_(Object.assign({}, plain, { tag_raised: true }), null, null), true);
    eq(bot.edSerious_(Object.assign({}, plain, { tag_raised: true }), live[3][1], null), false);
    // a row without facts and without an answer is ordinary (FastTriage.gs ftProtected_ would call it protected)
    eq([bot.edSerious_({ signal_type: 'CLUSTER_EMERGENCE', priority_hint: 'P1' }, null, null),
      bot.ftProtected_({ signal_type: 'CLUSTER_EMERGENCE', priority_hint: 'P1' })], [false, true]);
    eq([bot.edSerious_(null, null, null), bot.edSerious_({}, { sp: [1] }, null)], [false, false]);
  });

  test('early detection allowance: the words of each refusal, with the limit in force; none holds a decimal', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    eq(['check', 'hour', 'hourOrdinary', 'dayReviews'].map(c => bot.edNeverWhy_(c)), [
      'more than 5 stories arrived in 15 minutes; higher-ranked ones went first',
      'this hour\'s 10 reviews were used',
      'this hour\'s 6 reviews for ordinary stories were used',
      'today\'s limit of 150 reviews was reached',
    ]);
    eq([bot.edNeverWhy_('hourOrdinary', 4), bot.edNeverWhy_('hourOrdinary', 1), bot.edNeverWhy_('dayReviews', 20),
      bot.edNeverWhy_('dayReviews', 1), bot.edNeverWhy_('hour', 10)], [
      'this hour\'s 4 reviews for ordinary stories were used', 'this hour\'s 1 review for ordinary stories was used',
      'today\'s limit of 20 reviews was reached', 'today\'s limit of 1 review was reached', 'this hour\'s 10 reviews were used']);
    // the old rule's words are as they were
    eq(bot.edNeverWhy_('day'), 'today\'s limit of 40 was reached');
    eq([bot.ev('EW_MAX_PER_HOUR_'), bot.ev('EW_ALLOW_PER_DAY_'), bot.ev('EW_MAX_PER_CHECK_'), bot.ev('EW_SEEN_ID_MS_') / HOUR,
      bot.ev('DEC_MAX_PER_DAY_'), bot.ev('DEC_MAX_PER_DAY_ALLOWANCE_'), bot.ev('DEC_MAX_PER_CHECK_')], [10, 150, 5, 3.5, 150, 300, 15]);
    eq([bot.ev('GEN').settings.early_wave_reviews_per_hour, bot.ev('GEN').settings.early_wave_reviews_per_day], [6, 150]);
  });

  // -----------------------------------------------------------------------------------------------------------
  // The day, the hour, the check
  // -----------------------------------------------------------------------------------------------------------

  /**
   * 45 ordinary signals that the review dismisses, from just after midnight: five an hour (two at :05, one at :20, :35
   * and :50) until 9:50; then a serious story at 10:35. -> {w, runs: [{time, look}]}.
   */
  const noisyNight = settings => {
    const w = checked({ settings });
    const runs = [];
    let n = 300;
    for (let h = 0; h < 9; h++) {
      for (const m of [5, 20, 35, 50]) {
        const time = `D2 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        const rows = Array.from({ length: m === 5 ? 2 : 1 }, () => ordinary(++n, time, 'REVDISMISS'));
        runs.push({ time, look: w.step(time, rows) });
      }
    }
    eq(n, 345);
    const story = serious(400, 'D2 10:35');
    runs.push({ time: 'D2 10:35', look: w.step('D2 10:35', [story]) });
    return { w, runs, story };
  };

  test('early detection allowance: the day no longer stops at 40: 45 ordinary signals from midnight are all queued and reviewed, and a serious story at 10:35 AM is queued and gets its card; under the old rule (the setting at 0) the 41st and after, and that story, are never reviewed ("today\'s limit of 40")', () => {
    const now = noisyNight(DEFAULTS);
    const last = now.runs[now.runs.length - 1].look;
    eq(brief(last.recs), [['400', 'Card posted: Monitor build-up', 'Early reports worth watching.']]);
    eq(last.cards.length, 1);
    const all = [].concat(...now.runs.map(r => r.look.recs));
    eq([all.filter(r => r.outcome === 'Reviewed and dismissed').length, all.filter(r => r.outcome === 'Never reviewed').length], [45, 0]);
    eq([last.day.queued, last.day.limit, last.n], [46, 150, { found: 46, cards: 1, under: 0, letgo: 45, never: 0, waiting: 0 }]);
    assert.match(last.c19, /today: 46 found, 1 card, 0 under another alert, 45 let go, 0 never reviewed, 0 waiting/);
    assert.ok(!/daily cap|limit of/.test(last.c19), last.c19);

    const old = noisyNight(ends.OLD_RULE);
    const oldAll = [].concat(...old.runs.map(r => r.look.recs));
    eq(brief(oldAll.filter(r => r.outcome === 'Never reviewed')).map(x => x.slice(1)),
      Array.from({ length: 6 }, () => ['Never reviewed', 'Today\'s limit of 40 was reached.']));
    eq(brief(oldAll.filter(r => storyOf(r.id) === '400')), [['400', 'Never reviewed', 'Today\'s limit of 40 was reached.']]);
    eq(old.runs[old.runs.length - 1].look.cards.length, 0);
    assert.match(old.runs[old.runs.length - 1].look.c19, /daily cap of 40 reached, more tomorrow$/);
  });

  test('early detection allowance: an hour with 9 ordinary signals queues 6 and leaves 3 for the next checks (no ending, not counted); a serious one passes the used-up hour; the hour after has room again and the 3 are queued then; an ordinary one that would leave the window a check reads before the hour has room is never reviewed', () => {
    const w = checked();
    let look = w.step('09:01', [1, 2, 3, 4, 5].map(n => ordinary(n, '09:01')));
    eq([look.recs.filter(r => r.outcome === 'Never reviewed'), look.day.hr], [[], ['2026-10-14 09', 5, 5]]);
    const left = [6, 7, 8, 9].map(n => ordinary(n, '09:16'));
    look = w.step('09:16', left);
    eq([look.recs.filter(r => r.outcome === 'Never reviewed'), look.day.hr, look.n.found], [[], ['2026-10-14 09', 6, 6], 6]);
    assert.ok(look.logs.map(String).includes('early detection: 3 signal(s) left for the next check (this check\'s 5 or this hour\'s limits)'));
    // read again at the next checks: left again, nothing noted; the serious one is queued
    look = w.step('09:31', left.concat([serious(10, '09:31')]));
    eq([look.recs.filter(r => r.outcome === 'Never reviewed'), look.day.hr], [[], ['2026-10-14 09', 7, 6]]);
    assert.ok(w.t.bot.edQueueList_(props(w)).some(e => e.id === serious(10, '09:31').alert_id && e.ser === 1) ||
      look.recs.some(r => storyOf(r.id) === '10' && /^Card posted/.test(r.outcome)), 'the serious one was queued');
    look = w.step('09:46', left);
    eq([look.recs.filter(r => r.outcome === 'Never reviewed'), look.day.hr], [[], ['2026-10-14 09', 7, 6]]);
    // the next hour: the three are queued (an hour of room; they are still in the window the check reads)
    look = w.step('10:01', left);
    eq([look.recs.filter(r => /^Seen before|^Never/.test(r.outcome)), look.day.hr], [[], ['2026-10-14 10', 3, 3]]);
    // every one of them was reviewed in the end: a card each (the review's usual call)
    for (const time of ['10:02', '10:03', '10:04', '10:05']) w.step(time);
    eq(w.t.bot.edDayNumbers_(props(w)), { found: 10, cards: 10, under: 0, letgo: 0, never: 0, waiting: 0 });
    // the hour's 6 ordinary ones used again: a new one is left for later, one made 51 minutes ago would be out of the
    // next check's window (an hour), so it ends now: never reviewed, for this hour's 6
    w.step('10:16', [11, 12, 13].map(n => ordinary(n, '10:16')));
    look = w.step('10:31', [ordinary(14, '09:40'), ordinary(15, '10:31')]);
    eq(brief(look.recs.filter(r => r.outcome === 'Never reviewed')), [['14', 'Never reviewed', NEVER_ORDINARY]]);
    eq(look.day.hr, ['2026-10-14 10', 6, 6]);
    assert.ok(!w.t.bot.edQueueList_(props(w)).some(e => e.id === ordinary(15, '10:31').alert_id), 'story 15 waits for the next check');
  });

  test('early detection allowance: at most 5 queued a check (the rest are left for the next check, where the serious ones go first again: no ending, no count); the hour\'s 10 of any kind; the day\'s limit (150, or the setting), with C19\'s stop', () => {
    const w = checked();
    w.busy = true;  // no review: the queue fills
    let look = w.step('09:01', [1, 2, 3, 4, 5, 6, 7].map(n => serious(n, '09:01')));
    eq([look.recs, look.waiting, look.day.hr, look.n.found], [[], 5, ['2026-10-14 09', 5, 0], 5]);
    // 6 and 7 come back with five new ones: 6, 7, 8, 9 and 10 are queued, 11 and 12 are left for later
    look = w.step('09:16', [1, 2, 3, 4, 5, 6, 7].map(n => serious(n, '09:01')).concat([8, 9, 10, 11, 12].map(n => serious(n, '09:16'))));
    eq([look.recs, look.waiting, look.day.hr], [[], 10, ['2026-10-14 09', 10, 0]]);
    eq(w.t.bot.edQueueList_(props(w)).map(e => storyOf(e.id)).sort((a, b) => a - b), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    // the hour's 10 are used: a new one is left for the next check too
    look = w.step('09:31', [serious(13, '09:31')]);
    eq([look.recs, look.waiting], [[], 10]);
    // the day's limit holds for the day: it ends them
    w.setDay({ queued: 150 });
    look = w.step('10:01', [serious(14, '10:01'), ordinary(15, '10:01')]);
    eq(brief(look.recs), [['14', 'Never reviewed', 'Today\'s limit of 150 reviews was reached.'],
      ['15', 'Never reviewed', 'Today\'s limit of 150 reviews was reached.']]);
    assert.match(look.c19, / · today's limit of 150 reviews is reached, more after midnight ET$/);
    // a smaller day set in the config
    w.t.bot.ev('GEN').settings.early_wave_reviews_per_day = 151;
    look = w.step('10:16', [serious(16, '10:16'), serious(17, '10:16')]);
    eq(brief(look.recs), [['17', 'Never reviewed', 'Today\'s limit of 151 reviews was reached.']]);
    eq([look.day.queued, look.day.limit, look.waiting], [151, 151, 11]);
  });

  test('early detection allowance: rows 38-40 OFF: the producer still tells the risk facts, no Gemini Decisions call is made, and serious means a P0 risk group, a taxonomy raise or an early-watch story; ordinary ones are held to the hour\'s 6', () => {
    const w = checked();
    [38, 39, 40].forEach(r => w.sh.getRange(r, 2).setValue('OFF'));
    const asked = [];
    const producer = w.t.bot.bqEarlyDetectionRows_;
    w.t.bot.bqEarlyDetectionRows_ = function (minutes, opts) { asked.push(opts); return producer.apply(this, arguments); };
    w.busy = true;
    let look = w.step('09:01', [1, 2, 3, 4, 5].map(n => ordinary(n, '09:01')));
    eq([look.recs, look.waiting], [[], 5]);
    const raised = ends.signal(8, { at: '09:16', row: { tag_raised: true } });
    const p0 = ends.signal(9, { at: '09:16', risk: 'privacy_data_leak', words: 'Private photos exposed after a data breach, story 9' });
    const early = ends.signal(10, { au: 3, type: 'EARLY_WATCH', at: '09:16' });
    look = w.step('09:16', [ordinary(6, '09:16'), ordinary(7, '09:16'), raised, p0, early]);
    // (7 is left for the next check: the hour's 6 ordinary ones are used)
    eq(brief(look.recs), [['10', 'Never reviewed', 'Early signals are switched OFF (row 39).']]);
    const queue = w.t.bot.edQueueList_(props(w));
    eq(queue.slice(0, 2).map(e => [storyOf(e.id), e.ser]), [['8', 1], ['9', 1]]);
    eq([queue.length, look.day.hr], [8, ['2026-10-14 09', 8, 6]]);
    eq([w.calls.decisions, asked], [0, [{ facts: true }, { facts: true }]]);
  });

  test('early detection allowance: with the fast triage\'s answers deleted from the script cache before every run, the same signals end the same way', () => {
    const outcomes = clear => {
      const w = checked();
      const out = [];
      const steps = [['09:01', [1, 2, 3, 4, 5].map(n => ordinary(n, '09:01'))], ['09:16', [6, 7, 8, 9].map(n => ordinary(n, '09:16'))],
        ['09:31', [serious(10, '09:31'), ordinary(11, '09:31', 'DECNOISE')]], ['10:01', [ordinary(7, '10:01')]], ['10:02'], ['10:03'], ['10:04']];
      steps.forEach(([time, rows]) => {
        if (clear) w.t.g.cache.clear();
        out.push(...brief(w.step(time, rows).recs).map(x => [time].concat(x)));
      });
      return out;
    };
    const kept = outcomes(false);
    eq(outcomes(true), kept);
    // (7, 8 and 9 were left for the next check at 09:16: the hour's 6 ordinary ones were used)
    eq(kept.filter(x => /^Never|^Held/.test(x[2])).map(x => x.slice(0, 3)), [['09:31', '11', 'Held back as noise (no review)']]);
  });

  test('early detection allowance: Gemini Decisions is asked at most 15 times a check (the rest go on without an answer, never held back for it) and at most 300 times a day', () => {
    const w = checked();
    w.busy = true;
    const look = w.step('09:01', Array.from({ length: 20 }, (_, i) => ordinary(500 + i, '09:01')));
    eq(w.calls.decisions, 15);
    eq([look.waiting, look.recs.length], [5, 0]);  // the other 15 are left for the next check
    assert.ok(look.logs.map(String).includes('fast triage: 5 signals without an answer (15 calls this check): handled as before'));
    // the day's calls: at most DEC_MAX_PER_DAY_ (300); past them no call is made
    const st = w.t.bot.decState_(props(w), w.t.g.clock.now);
    st.asked = 300;
    w.t.bot.decSaveState_(props(w), st);
    w.step('09:16', [ordinary(600, '09:16')]);
    eq(w.calls.decisions, 15);
  });

  // -----------------------------------------------------------------------------------------------------------
  // The queue and the seen map
  // -----------------------------------------------------------------------------------------------------------

  test('early detection allowance: a serious entry (ser: 1) goes first in the queue and a full queue lets the lowest ordinary one go; entries without it keep their order; with the allowance off the mark is taken off', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const p = g.services.PropertiesService.getScriptProperties();
    const sig = (n, pri) => ends.signal(n, { pri });
    for (let n = 1; n <= 11; n++) eq(bot.edQueuePut_(p, sig(n, 'P0'), NOW + n).queued, true);
    eq(bot.edQueuePut_(p, sig(12, 'P2'), NOW + 12, { ser: 1 }).queued, true);
    eq(storyOf(bot.edQueueList_(p)[0].id), '12');  // first, though its hint is P2 and it came last
    const res = bot.edQueuePut_(p, sig(13, 'P2'), NOW + 13, { ser: 1 });
    eq([res.queued, res.pushed.map(x => storyOf(x.entry.id))], [true, ['11']]);  // an ordinary P0 one goes, not a serious one
    eq(bot.edQueueList_(p).map(e => storyOf(e.id)), ['12', '13', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    // without the mark the order is the one it always was
    const plain = [{ k: 'a', pri: 'P2', au: 9, at: 1 }, { k: 'b', pri: 'P1', au: 5, at: 2 }, { k: 'c', pri: 'P1', au: 7, at: 3 }];
    eq(plain.slice().sort(bot.edQueueRank_).map(e => e.k), ['c', 'b', 'a']);
    // the allowance off: the marks come off and the order is the old one
    bot.edQueueUnser_(p);
    eq(bot.edQueueList_(p).map(e => [storyOf(e.id), e.ser]), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '13'].map(n => [n, undefined]));
    const was = g.props.get('ED_ALERT_QUEUE');
    bot.edQueueUnser_(p);
    eq(g.props.get('ED_ALERT_QUEUE'), was);
  });

  test('early detection allowance: in a check under the allowance an entry of the seen map that is only a signal\'s id goes after 3.5 hours (the producer keeps a signal 3), story keys stay 24 hours; elsewhere every entry stays 24 hours', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const map = { id1: NOW - 3.4 * HOUR, id2: NOW - 3.6 * HOUR, st1: [NOW - 3.6 * HOUR, 5], st2: [NOW - 23 * HOUR, 5], st3: [NOW - 25 * HOUR, 5] };
    eq(Object.keys(bot.pruneEarlyWaveSeen_(map, NOW, bot.ev('EW_SEEN_ID_MS_'))).sort(), ['id1', 'st1', 'st2']);
    eq(Object.keys(bot.pruneEarlyWaveSeen_(map, NOW)).sort(), ['id1', 'id2', 'st1', 'st2']);
    eq(Object.keys(bot.pruneEarlyWaveSeen_(map, NOW, 0)).sort(), ['id1', 'id2', 'st1', 'st2']);
  });

  test('early detection allowance: every stored value in its worst case stays under 8,800 characters: the day\'s counts with the hour\'s, the seen map after a day of 150 queued and 300 refused, the queue with its marks', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const p = g.services.PropertiesService.getScriptProperties();
    // the day's counts: every number at seven digits, the newest 120 signals remembered, a long problem, the hour's counts
    const big = 9999999;
    g.props.set('EARLY_DETECTION_TODAY', JSON.stringify({ day: bot.dayKey_(), clusters: big, velocity: big, queued: big, repeats: big,
      dismissed: big, triaged: big, watch: big, watchq: big, at: 'Oct 14, 12:59 PM EDT', problem: 'x'.repeat(300), found: big, cards: big,
      under: big, letgo: big, never: big, limit: big, noted: Array.from({ length: 120 }, (_, i) => `${bot.hashText_(`ED-CLU-${i}`)}=l`) }));
    bot.noteEarlyWave_(p, 0, 0, 'y'.repeat(300), { queued: 1, dayLimit: big, hour: { key: '2026-10-14 23', all: big, ord: big } });
    const day = g.props.get('EARLY_DETECTION_TODAY');
    eq(JSON.parse(day).hr, ['2026-10-14 23', big, big]);
    assert.ok(day.length <= 8800, `EARLY_DETECTION_TODAY: ${day.length}`);
    assert.ok(day.length < 2700, `EARLY_DETECTION_TODAY: ${day.length}`);

    // the seen map: a day of 150 signals queued (id, cluster and post keys) and 300 refused (their ids), saved as a
    // check under the allowance saves it (the newest 200 entries)
    const aDay = idMs => {
      g.props.delete('EARLY_DETECTION_SEEN');
      const day0 = NOW - 24 * HOUR + MIN;
      for (let i = 0; i < 450; i++) {
        const at = day0 + Math.floor(i * (24 * HOUR - 2 * MIN) / 450);
        const seen = bot.earlyWaveSeen_(p, at, idMs);
        const keys = bot.edRowKeys_(ends.signal(1000 + i, { au: 999 }));
        if (i % 3 === 0) keys.forEach(k => seen.add(k, at, k.indexOf('id:') === 0 ? 0 : 999999));
        else seen.add(keys[0], at);
        seen.save();
      }
      const saved = g.props.get('EARLY_DETECTION_SEEN');
      const entries = JSON.parse(saved);
      return { chars: saved.length, entries: Object.keys(entries).length, stories: Object.keys(entries).filter(k => Array.isArray(entries[k])).length };
    };
    const allowed = aDay(bot.ev('EW_SEEN_ID_MS_'));
    assert.ok(allowed.chars <= 8800, `EARLY_DETECTION_SEEN: ${allowed.chars}`);
    eq(allowed.entries, 200);
    // the ids of the last 3.5 hours take their room and the rest is story keys: 134 of the day's 300 (its last 11 hours
    // of queued signals), where without that rule the ids would keep only 80 of them
    eq([allowed.stories, aDay(0).stories], [134, 80]);

    // the queue: 12 entries with the longest id, every ranking key and the allowance's mark
    const list = Array.from({ length: 12 }, (_, i) => ({ k: bot.edQueueKey_(ends.signal(i)), id: `ED-VEL-PRIORITY_TOPIC-${'f'.repeat(58)}`.slice(0, 80),
      at: NOW + i, pri: 'P0', au: 999999, sig: 'v', tries: 2, p0: 1, sv: 3.99, br: 0.99, ser: 1 }));
    bot.edQueueSave_(p, list);
    const queue = g.props.get('ED_ALERT_QUEUE');
    assert.ok(queue.length <= 8800, `ED_ALERT_QUEUE: ${queue.length}`);
  });

  // -----------------------------------------------------------------------------------------------------------
  // The long mixed day under the allowance; the Mirror flow and the setting at 0 as they were
  // -----------------------------------------------------------------------------------------------------------

  // What becomes of each signal of ed_endings.js's long mixed day in the one-space setup under the allowance: [run, story,
  // outcome, why]. Most of its signals are serious (the fast triage's usual answer is severity medium), so the hour's 10
  // and the check's 5 are what hold them up: they wait for a later check, and are reviewed; the day's 40 is no limit
  // any more.
  const DAY = [
    ['08:16', '5', 'Not English', 'Most of its posts are not in English.'],
    ['08:16', '6', 'Its main post already has an alert', 'QA-0906 (BigQuery · BSIP, 8:01 AM ET).'],
    ['08:16', '4', 'Held back as noise (no review)', 'Looks like routine chatter (93% likely), severity low (60% sure).'],
    ['08:16', '1', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['08:16', '2', 'Card posted: Social Alert', 'Several independent owners describe the same concrete failure.'],
    ['08:17', '3', 'Card posted: Needs a human look', 'AI review unavailable, so a person makes the call.'],
    ['08:31', '1', 'Seen before, nothing new', 'Its card of 8:16 AM ET had 6 accounts; 8 now, nothing new.'],
    ['08:31', '12', 'Held back as noise (no review)', 'Looks unrelated to Google (94% likely), severity none (70% sure).'],
    ['08:31', '13', 'Held back as noise (no review)', 'Looks like routine chatter (93% likely), severity low (60% sure).'],
    ['08:31', '10', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['08:31', '7', 'Reviewed and dismissed', 'Benign chatter, nothing for Google to act on.'],
    ['08:32', '8', 'Not English', 'The posts are not in English (Portuguese).'],
    ['08:32', '9', 'Seen before, nothing new', 'Already alerted as a known issue (QA-4228, "Pixel camera crash"): nothing materially new.'],
    ['08:33', '11', 'Reviewed and dismissed', 'Its topic is always around in the listening data ("Shot on Pixel showcase").'],
    ['08:46', '7', 'Seen before, nothing new', 'First seen 8:31 AM ET with 5 accounts; 8 now, nothing new.'],
    ['08:46', '15', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['08:46', '1', 'Update added to its earlier card', '14 accounts now, up from 6; now also on TikTok.'],
    // 16 and 17 met the hour's 10 at 08:46: left for the next check, they are queued in the new hour
    ['09:01', '17', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['09:01', '16', 'Reviewed and dismissed', 'Benign chatter, nothing for Google to act on.'],
    ['09:02', '19', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['09:02', '19', 'Seen before, nothing new', 'Its card of 9:02 AM ET had 12 accounts; 5 now, nothing new.'],
    ['09:17', '21', 'Never reviewed', 'Its review failed twice.'],
    ['09:20', '20', 'Never reviewed', 'Its review failed twice.'],
    ['09:20', '22', 'Reviewed, but its card could not be posted', 'Chat gave no message back for the card.'],
    // the busy morning: the ones the check's 5 and the hour's 10 turned away come back and fill the queue; two later
    // ones find it full (a wall that is not the check's or the hour's: they end there)
    ['10:16', '42', 'Never reviewed', 'The review queue was full.'],
    ['10:16', '43', 'Never reviewed', 'The review queue was full.'],
  ].concat([31, 32, 33].map(n => ['12:35', String(n), 'Never reviewed', 'Waited 3 hours while the bot worked on alerts.']), [
    ['12:35', '44', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['12:35', '41', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['12:36', '34', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['12:36', '35', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['12:37', '36', 'Reviewed and dismissed', 'Benign chatter, nothing for Google to act on.'],
    ['12:37', '37', 'Reviewed and dismissed', 'Benign chatter, nothing for Google to act on.'],
    ['12:38', '38', 'Reviewed and dismissed', 'Benign chatter, nothing for Google to act on.'],
    ['12:38', '39', 'Reviewed and dismissed', 'Benign chatter, nothing for Google to act on.'],
    ['12:51', '51', 'Never reviewed', 'Early signals are switched OFF (row 39).'],
    ['12:51', '40', 'Reviewed and dismissed', 'Benign chatter, nothing for Google to act on.'],
    ['13:05', '52', 'Never reviewed', 'Early signals are switched OFF (row 39).'],
    ['13:20', '53', 'Never reviewed', 'Today\'s 8 early signals were used.'],
    ['23:40', '67', 'Its main post already has an alert', 'QA-0967 (BigQuery · BSIP, 1:50 PM ET).'],
    ['D2 00:05', '65', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['D2 00:05', '64', 'Reviewed and dismissed', 'Benign chatter, nothing for Google to act on.'],
    ['D2 00:06', '63', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['D2 00:06', '62', 'Reviewed and dismissed', 'Benign chatter, nothing for Google to act on.'],
    ['D2 00:07', '61', 'Never reviewed', 'Its saved details were gone when its turn came.'],
    ['D2 00:20', '66', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['D2 00:35', '72', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['D2 00:35', '73', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
    ['D2 00:50', '71', 'Card posted: Monitor build-up', 'Early reports worth watching.'],
  ]);

  test('early detection allowance: the long mixed day in the one-space setup under the allowance: after EVERY run the numbers add up and found is the number of signals counted; what becomes of each signal; the same with the script cache emptied before every run', () => {
    const play = clear => {
      const w = checked();
      const out = [];
      const counted = new Set();
      if (clear) {
        const run = w.run;
        w.run = (time, rows) => { w.t.g.cache.clear(); return run(time, rows); };
      }
      ends.day(w, (run, look) => {
        const recs = recsOf(w);
        recs.forEach(r => { counted.add(r.id); out.push([run.at, storyOf(r.id), r.outcome, r.why]); });
        w.t.bot.edQueueList_(props(w)).forEach(e => counted.add(e.id));
        const n = w.t.bot.edDayNumbers_(props(w));
        eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `the run at ${run.at}: ${JSON.stringify(n)}`);
        // the day changes at midnight: the signals counted before it are counted again only while they wait
        if (run.at === 'D2 00:05') counted.clear();
        assert.ok(!look.logs.map(String).some(l => /did not add up/.test(l)), `the run at ${run.at}`);
        assert.ok(!/daily cap of 40/.test(look.c19), `the run at ${run.at}: ${look.c19}`);
      });
      return out;
    };
    const kept = play(false);
    eq(kept, DAY);
    eq(play(true), DAY);
  });

  test('early detection allowance: the Mirror flow does exactly what it did with the default settings (the old rule, whatever the setting), and so does the one-space setup with early_wave_reviews_per_hour at 0', () => {
    const play = o => {
      const w = ends.world(Object.assign({ row46: false }, o));
      const out = [];
      ends.day(w, (run, look) => {
        recsOf(w).forEach(r => out.push(JSON.stringify([run.at, r])));
        look.cards.forEach(m => out.push(JSON.stringify([run.at, m.text])));
        out.push(JSON.stringify([run.at, look.c19.replace(/^last check [^·(]*/, ''), look.waiting]));
      });
      out.push(JSON.stringify(w.t.chat.botPosts(w.space).map(m => m.text)));
      return out;
    };
    eq(play({ flow: 'mirror', settings: DEFAULTS }), play({ flow: 'mirror', settings: ends.OLD_RULE }));
    eq(play({ flow: 'one-space', settings: { early_wave_reviews_per_hour: 0 } }), play({ flow: 'one-space', settings: ends.OLD_RULE }));
  });
};
