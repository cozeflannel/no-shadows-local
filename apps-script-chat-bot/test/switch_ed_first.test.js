// Early Detection goes first in the one-space setup (AutoCorrect.gs runAutoCorrect_, acEarlyDetectionFirst_; setting
// early_detection_first, default on): the 15-minute story check and the reviews run before the Direct BigQuery poll, so
// a poll with much to read no longer takes the time the reviews need. The poll goes first again in the first run that
// starts 10 minutes or more after its last check. With the setting off, and wherever the Auto-correct flow is not
// working alone (beside a Mirror space, or beside the main flow on the live Burson space), the order is the one it
// always was: the poll, then Early Detection.
//
// Every scenario here turns the fix plan's other settings off (golden.SETTINGS_OFF), so what a later change does by
// default never moves these tests.
'use strict';

module.exports = H => {
  const { test, eq, assert, REAL } = H;
  const golden = require('./golden_flows')(H);
  const W = golden.world;
  const SEC = 1000;
  const MIN = 60 * SEC;
  const ON = Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true });
  const OFF = golden.SETTINGS_OFF;

  /** What a post in a scenario's record is. */
  const kind = m => (!m.reply && /\*\[BigQuery · BSIP\]\*/.test(m.text) ? 'Direct BigQuery card'
    : !m.reply && m.text.indexOf('🚨 *EARLY DETECTION*') === 0 ? 'story card'
      : m.reply && m.text.indexOf('🤖 *Early Detection Review') === 0 ? 'story review note'
        : m.reply && m.text.indexOf('The agentic assistant reviewed this alert') === 0 ? 'card review note' : 'another post');

  /**
   * Gives a world's Direct BigQuery check and story review a cost in run time (w.cost.poll: its BSIP read; w.cost.review:
   * Gemini's answer; both 0 until a test says), and notes when each started (w.polls, w.reviews).
   */
  function timed(w) {
    const { t } = w;
    const cost = { poll: 0, review: 0 };
    const polls = [];
    const reviews = [];
    const fetch = t.g.services.UrlFetchApp.fetch;
    t.g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      if (url.startsWith('https://bigquery.googleapis.com/') && /\/queries$/.test(url) &&
          /"BSIP" AS source_kind/.test(String(JSON.parse(params.payload).query || ''))) {
        polls.push(t.g.clock.now);
        t.g.clock.now += cost.poll;
      }
      return fetch(link, params);
    };
    const answer = t.g.vertex.earlyDetection;
    t.g.vertex.earlyDetection = payload => {
      reviews.push(t.g.clock.now);
      t.g.clock.now += cost.review;
      return (w.review || answer)(payload);
    };
    return Object.assign(w, { cost, polls, reviews });
  }

  /**
   * A world three Direct BigQuery checks in, 5 minutes apart, and one 15-minute story check in: at the run 5 minutes
   * later the story check is due again, and the Direct BigQuery check is due (5 minutes) but not overdue (10).
   */
  function threeChecksIn(w) {
    w.rec.collect('setup');
    w.rec.step('the first run', 1);
    w.rec.step('a check', 5);
    w.rec.step('a check', 5);
    eq(w.polls.length, 3);
    return w;
  }
  const checkAt = t => Number(t.g.props.get('BQ_DIRECT_AT'));

  test('early detection first: in the one-space setup, with a Direct BigQuery candidate, a story waiting and time in the run for only one of them, the story is reviewed and posted first and the Direct BigQuery card comes with the next run; with the setting off the order is the one before the change: the Direct BigQuery card first, the story a run later', () => {
    const run = overrides => {
      const w = threeChecksIn(timed(W.oneSpaceWorld(overrides)));
      const { t, rec, feed, cost } = w;
      const before = checkAt(t);
      // of the 220 seconds the flow has in a run: after the check's read no review can start (it needs 90 left), and
      // after a review no check (it needs 120 left)
      cost.poll = 140 * SEC;
      cost.review = 110 * SEC;
      const start = t.g.clock.now + 5 * MIN;
      rec.step('both wait', 5, () => { feed.bsip = [golden.rows.bsipRow()]; feed.stories = [golden.rows.story()]; });
      const during = { checks: w.polls.length - 3, reviews: w.reviews.length, checkMoved: checkAt(t) !== before,
        waiting: JSON.parse(t.g.props.get('ED_ALERT_QUEUE') || '[]').length };
      rec.step('the next run', 1);
      const out = rec.out();
      const posts = label => out.chat.filter(m => m.run === label).map(kind);
      eq(out.chat.filter(m => m.run !== 'setup').map(m => m.space).filter(s => s !== golden.spaces.AC), []);  // all in the Auto-correct space
      // when the review and the check started, counted from the start of the run both waited in
      return { both: posts('both wait'), next: posts('the next run'), during, reviewAt: w.reviews[0] - start, checkAt: w.polls[3] - start,
        after: { checks: w.polls.length - 3, reviews: w.reviews.length } };
    };
    const soon = ms => ms >= 0 && ms < 10 * SEC;  // at the start of the run
    const first = run(ON);
    eq([first.both, first.next], [['story card', 'story review note'], ['Direct BigQuery card']]);
    // the review started with the run; the check found no time after it (its time of last check didn't move, the story
    // is no longer waiting) and ran in the next run
    eq(first.during, { checks: 0, reviews: 1, checkMoved: false, waiting: 0 });
    eq([soon(first.reviewAt), first.checkAt > 110 * SEC, first.after], [true, true, { checks: 1, reviews: 1 }]);

    const off = run(OFF);
    eq([off.both, off.next], [['Direct BigQuery card'], ['card review note', 'story card', 'story review note']]);
    // the check started with the run; the story was queued and waited for the next run
    eq(off.during, { checks: 1, reviews: 0, checkMoved: true, waiting: 1 });
    eq([soon(off.checkAt), off.reviewAt > 140 * SEC, off.after], [true, true, { checks: 1, reviews: 1 }]);
  });

  // Twelve stories of their own (another product, another claim, other posts), so that a review waits at every run
  const TOPICS = [
    ['chrome_tabs', 'Chrome', 'Chrome closed all my tabs after the update'],
    ['gmail_drafts', 'Gmail', 'Gmail sent my drafts to the wrong contact'],
    ['photos_albums', 'Google Photos', 'Google Photos deleted my backed-up albums'],
    ['calendar_shift', 'Calendar', 'Google Calendar moved every meeting by an hour'],
    ['nest_heating', 'Assistant/Home', 'my Nest thermostat turned the heating off overnight'],
    ['android_auto', 'Android (Android OS & Google TV)', 'Android Auto keeps disconnecting on the highway'],
    ['wallet_double', 'Google Wallet', 'Google Wallet charged my card twice'],
    ['meet_drop', 'Meet', 'Google Meet dropped the call for everyone at once'],
    ['fitbit_steps', 'Fitbit', 'my Fitbit stopped counting steps after the sync'],
    ['translate_menu', 'Translate', 'Google Translate turned the menu into insults'],
    ['keep_notes', 'Keep', 'Google Keep wiped my notes after the update'],
    ['docs_edits', 'Docs', 'Google Docs undid an hour of my edits'],
  ];
  const storyOf = ([id, product, claim], i) => {
    const url = n => `https://x.com/${id}_user${n}/status/21500000000000${String(1000 + i * 10 + n)}`;
    const rep = (n, eng, snippet) => ({ platform: 'X', author_handle: `${id}_user${n}`, followers: 900, engagement_total: eng,
      published_at: '2026-10-14 11:42 UTC', url: url(n), snippet });
    return golden.rows.story({ alert_id: `ED-CLU-clu_${id}-202610141200`, cluster_id: `clu_${id}`, signal_key: `clu_${id}`,
      headline: `Low-tier claim cluster (6 accounts): ${claim}`, topic_product: product, primary_url: url(1),
      representative_posts_json: JSON.stringify([rep(1, 44, `${claim}.`), rep(2, 31, `Same here: ${claim}.`),
        rep(3, 27, `Anyone else? ${claim}.`), rep(4, 19, `Since tonight ${claim}.`)]) });
  };
  /** Gemini's review of one of those stories: worth monitoring, in the story's own words. */
  const reviewOf = payload => {
    const text = payload.contents[0].parts.map(p => p.text || '').join('\n');
    const topic = TOPICS.find(x => text.includes(`clu_${x[0]}`));
    if (!topic) throw new Error('a review of a story this test did not hand over');
    return {
      summary: `Six small accounts on X say ${topic[2]}.`, issue_name: `Reports that ${topic[2]}`,
      emerging_narrative: `Independent users say ${topic[2]}.`,
      early_detection_call: { disposition: 'monitor', severity: 'medium', confidence: 0.86, reason: 'Several independent users describe the same fault',
        build_up_signals: '6 accounts on 1 platform', watch_for: 'An official statement or press pickup' },
      temp_check_draft: { recommended: false, query_suggestion: '', scope_note: '' },
      slrr: { is_slrr: true, confidence: 0.85, exposure_tag: 'Product - Other/general criticism', product: topic[1], other_products: [],
        sensitive_topics: [], location: 'US' },
      known_issue: { matches: false, confidence: 0.9 }, tns: { needed: false, reason: '' }, recommended_groups: [],
      story_title: `Users say ${topic[2]}`, story: `Users say [${topic[2]}](P1).`, web_context: '',
      next_steps: ['Keep monitoring for volume growth and re-check in 2 hours.'], driver_post: 'P1',
    };
  };

  test('early detection first: with a review waiting at every run for 45 minutes (each review, and each Direct BigQuery check, leaving no time for the other), the poll still gets its turn: it goes first in the first run that starts 10 minutes or more after its last check, so two checks are never further apart than 10 minutes and one run; every other run reviews a story. With the setting off the poll goes first whenever it is due (5 minutes), and fewer stories are reviewed in the same time', () => {
    const run = overrides => {
      const w = threeChecksIn(timed(W.oneSpaceWorld(overrides)));
      const { t, rec, feed, cost } = w;
      w.review = reviewOf;
      cost.poll = 140 * SEC;     // then no review can start
      cost.review = 150 * SEC;   // then neither a second review nor a check can start
      feed.stories = TOPICS.map(storyOf);
      const from = t.g.clock.now + 5 * MIN;
      const runs = [];
      for (let n = 0; t.g.clock.now + MIN < from + 45 * MIN; n++) {
        const had = { polls: w.polls.length, reviews: w.reviews.length, last: w.polls[w.polls.length - 1] };
        const waiting = JSON.parse(t.g.props.get('ED_ALERT_QUEUE') || '[]').length;
        const start = t.g.clock.now + (n ? MIN : 5 * MIN);
        rec.step(`run ${n + 1}`, n ? 1 : 5);
        const polled = w.polls.slice(had.polls);
        const reviewed = w.reviews.slice(had.reviews);
        // how long the poll's last check was ago when this run's work started
        runs.push({ start, waiting, polled: polled.length, reviewed: reviewed.length, sinceCheck: (polled.length ? polled[0] : reviewed[0]) - had.last });
      }
      const checks = w.polls.slice(3);
      return { runs, checks, gaps: checks.map((p, i) => p - (i ? checks[i - 1] : w.polls[2])), reviews: w.reviews.length,
        cards: rec.out().chat.filter(m => kind(m) === 'story card').length,
        longestRun: Math.max(...runs.slice(1).map((r, i) => r.start - runs[i].start)) };
    };

    const first = run(ON);
    assert.ok(first.runs.length >= 10, `${first.runs.length} runs`);
    // a story waited at every run (the first run's check queued the first five), and every run did one thing: a review,
    // or the Direct BigQuery check
    eq(first.runs.slice(1).filter(r => r.waiting < 1), []);
    eq(first.runs.filter(r => r.polled + r.reviewed !== 1), []);
    // the check exactly in the runs whose work started 10 minutes or more after the last check
    eq(first.runs.filter(r => (r.polled === 1) !== (r.sinceCheck >= 10 * MIN)), []);
    assert.ok(first.checks.length >= 3, `${first.checks.length} checks`);
    eq(first.gaps.filter(g => g < 10 * MIN || g > 10 * MIN + first.longestRun), []);
    eq(first.cards, first.reviews);  // each review ended in a card

    const off = run(OFF);
    eq(off.runs.filter(r => r.polled + r.reviewed !== 1), []);
    // the order before the change: the check whenever it is due
    eq(off.runs.filter(r => (r.polled === 1) !== (r.sinceCheck >= 5 * MIN)), []);
    eq(off.gaps.filter(g => g < 5 * MIN || g >= 10 * MIN), []);
    // what the setting buys and what it costs, in the same 45 minutes
    assert.ok(first.reviews > off.reviews && first.checks.length < off.checks.length,
      `${first.reviews} reviews and ${first.checks.length} checks first, ${off.reviews} and ${off.checks.length} with the setting off`);
  });

  test('early detection first: only the one-space setup changes. Beside the main flow on the live Burson space (B3 = S-F Burson, B4, B10: the Auto-correct flow hosts the cards, not working alone) and beside a Mirror space (B9 and B10: the Mirror flow hosts them), a run with a Direct BigQuery candidate and a story posts the Direct BigQuery card first, with the setting on as with it off; in the one-space setup the same run posts the story first', () => {
    const SETUPS = {
      'beside the main flow on the live Burson space': { set: t => { t.set('B3', REAL); t.control().getRange(10, 2).setValue(W.names.AC); }, space: golden.spaces.AC },
      'beside a Mirror space': { set: t => { t.control().getRange(9, 2).setValue(W.names.MIRROR); t.control().getRange(10, 2).setValue(W.names.AC); }, space: golden.spaces.MIRROR },
    };
    const both = w => {
      threeChecksIn(w);
      w.rec.step('both wait', 5, () => { w.feed.bsip = [golden.rows.bsipRow()]; w.feed.stories = [golden.rows.story()]; });
      return w.rec.out().chat.filter(m => m.run === 'both wait').map(m => [m.space, kind(m)]);
    };
    const beside = (setup, overrides) => {
      const t = W.start(overrides, [[golden.spaces.AC, W.names.AC], [golden.spaces.MIRROR, W.names.MIRROR]]);
      setup.set(t);
      [15, 19].forEach(r => t.control().getRange(r, 2).setValue('ON'));
      const feed = W.feedsOf(t);
      W.scriptGemini(t);
      return both(timed({ t, feed, rec: W.recorder(t, '') }));
    };
    Object.keys(SETUPS).forEach(name => {
      const setup = SETUPS[name];
      const before = [[setup.space, 'Direct BigQuery card'], [setup.space, 'story card'], [setup.space, 'story review note']];
      eq([name, beside(setup, ON)], [name, before]);
      eq([name, beside(setup, OFF)], [name, before]);
    });
    const AC = golden.spaces.AC;
    eq(both(timed(W.oneSpaceWorld(ON))), [[AC, 'story card'], [AC, 'story review note'], [AC, 'Direct BigQuery card']]);
    eq(both(timed(W.oneSpaceWorld(OFF))), [[AC, 'Direct BigQuery card'], [AC, 'story card'], [AC, 'story review note']]);
  });

  test('early detection first: in the golden one-space scenario, this setting alone (every other new setting off) changes one thing from what the bot put out at f93e31a: in the run where a Direct BigQuery card and a story are both posted, the story card and its review note now come before the Direct BigQuery card. Every post, emoji and email is the same, in the same run', () => {
    const now = golden.oneSpace(ON);
    const was = golden.recorded.one_space;
    const STEP = '09 Direct BigQuery finds the Maps post and a story is found';
    const texts = (out, run) => out.chat.filter(m => m.run === run).map(m => [m.reply, m.text]);
    const sorted = list => list.map(x => JSON.stringify(x)).sort();
    const runsOf = out => Array.from(new Set(out.chat.map(m => m.run)));
    eq(runsOf(now), runsOf(was));
    runsOf(was).filter(r => r !== STEP).forEach(r => eq([r, texts(now, r)], [r, texts(was, r)]));
    eq(sorted(texts(now, STEP)), sorted(texts(was, STEP)));
    eq([now.chat.filter(m => m.run === STEP).map(kind), was.chat.filter(m => m.run === STEP).map(kind)],
      [['story card', 'story review note', 'Direct BigQuery card'], ['Direct BigQuery card', 'story card', 'story review note']]);
    // the review note is under the story card, and the next run's note under the Direct BigQuery card, as before
    const at = (out, k) => out.chat.find(m => m.run === STEP && kind(m) === k);
    eq([at(now, 'story review note').thread, at(was, 'story review note').thread], [at(now, 'story card').thread, at(was, 'story card').thread]);
    const NEXT = '10 the Maps card is reviewed and the watch flags the Maps post too';
    const note = out => out.chat.find(m => m.run === NEXT && kind(m) === 'card review note');
    eq([note(now).thread, note(was).thread], [at(now, 'Direct BigQuery card').thread, at(was, 'Direct BigQuery card').thread]);
    eq(sorted(now.reactions.map(r => [r.run, r.emoji])), sorted(was.reactions.map(r => [r.run, r.emoji])));
    eq([now.emails, now.test_copy, now.outbox], [was.emails, was.test_copy, was.outbox]);
  });

  test('early detection first: the rule itself (acEarlyDetectionFirst_): only when the flow works alone, the setting is not false, and the poll\'s last check started less than 10 minutes ago; never checked, a last check 10 minutes old or more, a clock that went back, a setting or a property that can\'t be read: the poll first, as before', () => {
    const B = H.B;
    const NOW = 1791980000000;
    const props = last => ({ getProperty: k => { if (k !== 'BQ_DIRECT_AT') throw new Error(`read ${k}`); return last === null ? null : String(last); } });
    const ctx = settings => ({ settings, now: () => NOW });
    const first = (standalone, settings, last) => B.acEarlyDetectionFirst_(ctx(settings), standalone, props(last));
    eq([B.ev('AC_POLL_OVERDUE_MS_'), B.ev('BQ_DIRECT_EVERY_MS_'), B.ev('BQ_DIRECT_AT_PROP_')], [10 * MIN, 5 * MIN, 'BQ_DIRECT_AT']);
    eq(B.ev('GEN').settings.early_detection_first, true);
    const recent = NOW - 6 * MIN;
    eq([first(true, { early_detection_first: true }, recent), first(true, {}, recent), first(true, { early_detection_first: false }, recent),
      first(false, { early_detection_first: true }, recent), first(undefined, {}, recent)], [true, true, false, false, false]);
    eq([NOW - 1, NOW - 10 * MIN + 1, NOW - 10 * MIN, NOW - 11 * MIN, null, 0, 'x', NOW + 1].map(last => first(true, {}, last)),
      [true, true, false, false, false, false, false, false]);
    eq(first(true, {}, NOW), true);  // a check in this very moment
    eq([B.acEarlyDetectionFirst_(null, true, props(recent)), B.acEarlyDetectionFirst_({ now: () => NOW }, true, props(recent)),
      B.acEarlyDetectionFirst_(ctx({}), true, { getProperty: () => { throw new Error('the properties service is down'); } }),
      B.acEarlyDetectionFirst_(ctx({}), true, null)], [false, false, false, false]);
    // without a clock of its own on the flow, the script's clock
    eq(B.acEarlyDetectionFirst_({ settings: {} }, true, props(Date.now() - MIN)), true);
  });
};
