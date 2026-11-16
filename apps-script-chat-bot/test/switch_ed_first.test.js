// Early Detection goes first in the one-space setup (AutoCorrect.gs runAutoCorrect_, acEarlyDetectionFirst_; setting
// early_detection_first, default on): the 15-minute story check and the reviews run before the Direct BigQuery poll, so
// a poll with much to read no longer takes the time the reviews need. The poll goes first again in the first run that
// starts 10 minutes or more after its last check. With the setting off, and wherever the Auto-correct flow is not
// working alone (beside a Mirror space, or beside the main flow on the live Burson space), the order is the one it
// always was: the poll, then Early Detection.
//
// Where stories go first, a story's card comes before the poll gets to the story's main post. Such a card is not the
// post's own alert: one that sent no Social Alert no longer makes the post "already alerted" for the poll, so the post
// still gets its Direct BigQuery card, and the Social Alert it earns by itself (BigQuery.gs bqStoryCardRow_). With the
// setting off, and in every other setup, a story's card counts as an alert on its main post, as it did.
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

  // -------------------------------------------------------------------------------------------------------------
  // A story's card is not the post's own alert. Where stories go first, a story's card comes before the Direct
  // BigQuery poll gets to its main post; taken for "already alerted", it would stop the post's own card, and with it
  // the Social Alert the post earns by itself (BigQuery.gs bqStoryCardRow_, pollBigQuerySources_)
  // -------------------------------------------------------------------------------------------------------------

  const MAPS = golden.posts.MAPS;  // Direct BigQuery finds it with a P0 exposure tag and 2,400 engagements: a Social Alert
  const TESTER = 'tester@testing.test';
  /** A story whose main post is that post. */
  const mapsStory = () => {
    const rep = (url, author, followers, eng, snippet) => ({ platform: 'X', author_handle: author, followers, engagement_total: eng,
      published_at: '2026-10-14 11:55 UTC', url, snippet });
    return golden.rows.story({ alert_id: 'ED-CLU-clu_maps_bridge-202610141200', cluster_id: 'clu_maps_bridge', signal_key: 'clu_maps_bridge',
      headline: 'Low-tier claim cluster (6 accounts): Google Maps sends drivers onto a closed bridge', topic_product: 'Google Maps', primary_url: MAPS,
      representative_posts_json: JSON.stringify([
        rep(MAPS, 'roadwatcher', 41000, 2400, 'Google Maps keeps sending drivers onto a closed bridge.'),
        rep('https://x.com/commuter_k/status/2150000000000000072', 'commuter_k', 900, 31, 'Same here: Maps routed me onto the closed bridge this morning.'),
        rep('https://x.com/bridge_local/status/2150000000000000073', 'bridge_local', 700, 27, 'Maps still shows the closed bridge as open.')]) });
  };
  /** Gemini's review of it: a build-up worth monitoring; with `escalate`, one that gets a Social Alert of its own. */
  const mapsReview = escalate => () => ({
    summary: 'Six small accounts on X say Google Maps keeps routing drivers onto a closed bridge.',
    issue_name: 'Reports that Google Maps routes drivers onto a closed bridge',
    emerging_narrative: 'Independent drivers describe the same closed-bridge routing.',
    early_detection_call: { disposition: escalate ? 'escalate' : 'monitor', severity: escalate ? 'high' : 'medium', confidence: 0.9,
      reason: 'Several independent drivers describe the same routing fault', build_up_signals: '6 accounts on 1 platform',
      watch_for: 'An official statement or press pickup' },
    temp_check_draft: { recommended: false, query_suggestion: '', scope_note: '' },
    slrr: { is_slrr: true, confidence: 0.85, exposure_tag: 'Product - Other/general criticism', product: 'Maps/Geo', other_products: [],
      sensitive_topics: [], location: 'US' },
    known_issue: { matches: false, confidence: 0.9 }, tns: { needed: false, reason: '' }, recommended_groups: [],
    story_title: 'Drivers say Google Maps routes them onto a closed bridge', story: 'Drivers say Maps [sends them onto a closed bridge](P1).',
    web_context: '', next_steps: ['Keep monitoring for volume growth and re-check in 2 hours.'], driver_post: 'P1',
  });
  /**
   * A world (`w`, three Direct BigQuery checks in) where the story on the Maps post is found `storyFirstBy` minutes
   * before Direct BigQuery finds the post itself (0: in the same run), then run on until everything is worked. What
   * came of it: the posts of each run by kind, the emails, the Alert-log rows on the post, and C15's count.
   */
  const STORY_RUN = 'the story is found';
  const POST_RUN = 'Direct BigQuery finds the post';
  const storyThenPost = (w, opts) => {
    const { t, rec, feed } = w;
    w.review = mapsReview(!!(opts && opts.escalate));
    if (opts && opts.storyFirstBy) rec.step(STORY_RUN, opts.storyFirstBy, () => { feed.stories = [mapsStory()]; });
    rec.step(POST_RUN, 5, () => { feed.bsip = [golden.rows.mapsRow()]; feed.stories = [mapsStory()]; });
    [1, 1, 1, 5, 1].forEach(minutes => rec.step('after', minutes));  // its review, and one more Direct BigQuery check
    const out = rec.out();
    const key = t.bot.recordKey_({ post_url: MAPS });
    const posts = label => out.chat.filter(m => m.run === label).map(kind);
    return {
      story: posts(STORY_RUN), post: posts(POST_RUN), after: posts('after'),
      emails: out.emails.map(e => [e.run, e.kind, e.to, e.subject.split(' | ')[0]]),
      rows: t.bot.sheetBackend_(t.sheet()).loadAlerts().filter(r => r.record_key === key).map(r => [r.ingested, r.email_status || '']).sort(),
      storyId: (t.bot.sheetBackend_(t.sheet()).loadAlerts().find(r => r.record_key === key && r.ingested === 'Early detection') || {}).alert_id,
      today: (String(t.control().cell(15, 3)).match(/· (\d+ posts? today) /) || [])[1],  // C15's count of the day's posts (more follows it)
      // what the run log says of a post the poll looks at although a story's card has it
      said: t.g.logs.filter(l => /^BigQuery direct poll: \S+ is in a story's card/.test(l)),
      elsewhere: out.chat.filter(m => m.run !== 'setup' && m.space !== (w.space || golden.spaces.AC)).length,
      out,
    };
  };
  const oneSpace = overrides => threeChecksIn(timed(W.oneSpaceWorld(overrides)));
  const ALERT = ['after', 'sent', [TESTER], '[Auto-correct test] 🟥SOCIAL ALERT🟥: Google Maps'];  // the post's own Social Alert

  test('early detection first: a post that a story gets to first still gets its own Direct BigQuery card and the Social Alert it earns. Found in the same run as a story\'s main post and as a Direct BigQuery candidate: the story card and its review note, then the post\'s own card; the card\'s review, a run later, sends the Social Alert. With the setting off the two cards come in the order before the change, and the same Social Alert goes out', () => {
    const on = storyThenPost(oneSpace(ON), { storyFirstBy: 0 });
    eq([on.post, on.after, on.emails, on.rows, on.today, on.elsewhere],
      [['story card', 'story review note', 'Direct BigQuery card'], ['card review note'], [ALERT], [['BSIP', 'sent'], ['Early detection', '']], '1 post today', 0]);
    // both cards are on the one post, the story's first; the run log says why the poll still looked at it, once
    const cards = on.out.chat.filter(m => !m.reply && m.text.includes(MAPS)).map(kind);
    eq(cards, ['story card', 'Direct BigQuery card']);
    eq(on.said, [`BigQuery direct poll: ${MAPS} is in a story's card (${on.storyId}) that sent no Social Alert: that card is not the post's own ` +
      'alert, so the post is still looked at']);
    assert.ok(/^QA-\d+$/.test(on.storyId), on.storyId);
    const off = storyThenPost(oneSpace(OFF), { storyFirstBy: 0 });
    eq([off.post, off.after, off.emails, off.rows, off.today, off.elsewhere, off.said],
      [['Direct BigQuery card', 'story card', 'story review note'], ['card review note'], [ALERT], [['BSIP', 'sent'], ['Early detection', '']], '1 post today', 0, []]);
    // the same posts and the same email, whichever came first
    const texts = r => r.out.chat.filter(m => m.run !== 'setup').map(m => m.text).sort();
    eq([texts(on), on.out.emails.map(e => [e.subject, e.text])], [texts(off), off.out.emails.map(e => [e.subject, e.text])]);
  });

  test('early detection first: the story\'s card came a check earlier (5 minutes before Direct BigQuery finds the post): where stories go first the post still gets its own card at that check, and its Social Alert a run later; with the setting off the bot does what it did before the change: the story card counts as an alert on the post, so no Direct BigQuery card and no Social Alert', () => {
    const on = storyThenPost(oneSpace(ON), { storyFirstBy: 5 });
    eq([on.story, on.post, on.after, on.emails, on.rows, on.today, on.said.length],
      [['story card', 'story review note'], ['Direct BigQuery card'], ['card review note'], [ALERT], [['BSIP', 'sent'], ['Early detection', '']], '1 post today', 1]);
    const off = storyThenPost(oneSpace(OFF), { storyFirstBy: 5 });
    eq([off.story, off.post, off.after, off.emails, off.rows, off.today, off.said],
      [['story card', 'story review note'], [], [], [], [['Early detection', '']], '0 posts today', []]);
  });

  test('early detection first: a story whose own review sent a Social Alert still counts as the alert on its main post: no Direct BigQuery card for the post and no second email, with the setting on as with it off', () => {
    [['on', ON], ['off', OFF]].forEach(([name, overrides]) => {
      const got = storyThenPost(oneSpace(overrides), { storyFirstBy: 5, escalate: true });
      eq([name, got.story.slice(0, 2), got.post.concat(got.after).filter(k => k === 'Direct BigQuery card' || k === 'card review note'),
        got.emails.map(e => e.slice(0, 3)), got.rows, got.today, got.said],
      [name, ['story card', 'story review note'], [], [[STORY_RUN, 'sent', [TESTER]]], [['Early detection', 'sent']], '0 posts today', []]);
    });
  });

  test('early detection first: only where stories go first. Beside the main flow on the live Burson space and beside a Mirror space (the setting on), a story\'s card still counts as the alert on its main post, as before the change: no Direct BigQuery card and no Social Alert for it; the flow\'s mark for the poll (ctx.bqPastStoryCards) is set only in the one-space setup with the setting on', () => {
    const marks = t => {  // every flow pass of the world: [the Auto-correct flow?, its mark]
      t.bot.__marks = [];
      t.bot.ev('runOnce_ = (orig => function (ctx) { __marks.push([ctx.sourceReadOnly === true, ctx.bqPastStoryCards]); return orig(ctx); })(runOnce_)');
      return t.bot.__marks;
    };
    const uniq = list => Array.from(new Set(list.map(x => JSON.stringify(x)))).sort().map(x => JSON.parse(x));
    const SETUPS = {
      'beside the main flow on the live Burson space': { set: t => { t.set('B3', REAL); t.control().getRange(10, 2).setValue(W.names.AC); }, space: golden.spaces.AC,
        marks: [[false, null], [true, false]] },
      'beside a Mirror space': { set: t => { t.control().getRange(9, 2).setValue(W.names.MIRROR); t.control().getRange(10, 2).setValue(W.names.AC); }, space: golden.spaces.MIRROR,
        marks: [[false, null], [true, false]] },
    };
    Object.keys(SETUPS).forEach(name => {
      const setup = SETUPS[name];
      const t = W.start(ON, [[golden.spaces.AC, W.names.AC], [golden.spaces.MIRROR, W.names.MIRROR]]);
      setup.set(t);
      [15, 19].forEach(r => t.control().getRange(r, 2).setValue('ON'));
      const feed = W.feedsOf(t);
      W.scriptGemini(t);
      const seen = marks(t);
      const got = storyThenPost(threeChecksIn(timed({ t, feed, rec: W.recorder(t, ''), space: setup.space })), { storyFirstBy: 5 });
      eq([name, got.story, got.post, got.after, got.emails, got.rows, got.elsewhere, got.said],
        [name, ['story card', 'story review note'], [], [], [], [['Early detection', '']], 0, []]);
      eq([name, uniq(seen.map(([ac, mark]) => [ac, mark === undefined ? null : mark]))], [name, setup.marks]);
    });
    const flagged = overrides => {
      const w = W.oneSpaceWorld(overrides);
      const seen = marks(w.t);
      threeChecksIn(timed(w));
      return uniq(seen);
    };
    eq([flagged(ON), flagged(OFF), flagged(undefined)], [[[true, true]], [[true, false]], [[true, true]]]);  // (undefined: the default settings)
  });

  test('early detection first: what the poll takes for "only a story\'s card" (bqStoryCardRow_, bqOnlyStoryCards_, bqIsStoryCard_, bqPriorAlerts_): an Early Detection row with no Social Alert sent or on its way; a post the alert memory has only such rows of this flow for. Never a post a Social Alert went out for, one a Watch alert or a Direct BigQuery card was posted for, one Burson alerted, one another flow saw, or one whose alerts the memory may no longer all have', () => {
    const B = H.B;
    const NOW = 1791980000000;
    const HOUR = 60 * MIN;
    const row = patch => Object.assign({ alert_id: 'QA-1', ingested: 'Early detection', email_status: '', mirrored: '', created_at: NOW - HOUR,
      record_key: 'x.com/roadwatcher/status/2150000000000000002' }, patch || {});
    // 1. a story's card that sent no Social Alert
    eq([row(), row({ email_status: 'failed' }), row({ email_status: 'deleted' }), row({ email_status: 'discarded' }), row({ mirrored: '👍' }),
      row({ mirrored: '❌' }), row({ email_status: 'pending', created_at: NOW - 25 * HOUR })].map(r => B.bqStoryCardRow_(r, NOW)), Array(7).fill(true));
    // ...and never: one whose Social Alert went out, is drafted or on its way, one a team's emoji is on; any other kind of alert
    eq([row({ email_status: 'sent' }), row({ email_status: 'drafted' }), row({ email_status: 'pending' }), row({ mirrored: '👍 📰' }),
      row({ ingested: 'BSIP' }), row({ ingested: 'Watch alert' }), row({ ingested: 'Sprinklr' }), row({ ingested: '' }), row({ ingested: undefined }),
      null, undefined].map(r => B.bqStoryCardRow_(r, NOW)), Array(11).fill(false));
    eq(B.ev('[ED_ALERT_INGESTED_, AM_IDS_KEPT_]'), ['Early detection', 6]);
    // 2. what the alert memory says of a post
    const rows = { E1: row({ alert_id: 'E1' }), E2: row({ alert_id: 'E2', mirrored: '👍' }), SENT: row({ alert_id: 'SENT', email_status: 'sent' }),
      BQ: row({ alert_id: 'BQ', ingested: 'BSIP' }), BURSON: row({ alert_id: 'BURSON', ingested: '' }) };
    const ctx = { store: { alertById: id => rows[id] || null } };
    const seen = patch => Object.assign({ why: 'already seen (E1)', alert_id: 'E1', at: NOW - HOUR, outcome: 'seen', ids: ['E1'], claim: '' }, patch || {});
    const only = (s, c) => B.bqOnlyStoryCards_(c === undefined ? ctx : c, s, NOW);
    eq([only(seen()), only(seen({ ids: ['E1', 'E2'] })), only(seen({ ids: ['E2', 'E1', 'E2', 'E1', 'E2'] }))], [true, true, true]);
    eq([
      only(null),                                             // not seen at all
      only(seen({ outcome: 'emailed' })),                     // a Social Alert went out for the post
      only(seen({ outcome: 'claimed', ids: [], claim: 'watch' })),  // a Watch alert's card was just posted for it
      only(seen({ claim: 'bq' })),                            // a producer's card was claimed, and a story saw it too
      only(seen({ ids: ['E1', 'SENT'] })),                    // one of the stories sent a Social Alert
      only(seen({ ids: ['BQ', 'E1'] })),                      // a Direct BigQuery card is among them
      only(seen({ ids: ['E1', 'BURSON'] })),                  // Burson alerted the post
      only(seen({ ids: ['E1', 'QA-9'] })),                    // an alert that isn't in this flow's Alert log (another flow's)
      only(seen({ ids: [] })), only(seen({ ids: undefined })),
      only(seen({ ids: ['E1', 'E2', 'E1', 'E2', 'E1', 'E2'] })),  // six: the memory keeps no more, an older one may be gone
      only(seen(), {}), only(seen(), null), only(seen(), { store: {} }),
      only(seen(), { store: { alertById: () => { throw new Error('the Alert log can\'t be read'); } } }),
    ], Array(15).fill(false));
    // 3. Step 1's earlier alerts: with the candidates' keys, a story's card on one of those very posts is left out; every
    // other row stays (a story on another post, a story that sent a Social Alert, any other alert on the post)
    const KEY = 'x.com/roadwatcher/status/2150000000000000002';
    const OTHER = 'x.com/pixelcritic/status/2150000000000000001';
    const log = [row({ alert_id: 'E1', record_key: KEY }), row({ alert_id: 'E3', record_key: OTHER }), row({ alert_id: 'SENT', record_key: KEY, email_status: 'sent' }),
      row({ alert_id: 'BQ', record_key: KEY, ingested: 'BSIP' }), row({ alert_id: 'OLD', record_key: KEY, created_at: NOW - 72 * HOUR }),
      row({ alert_id: 'GONE', record_key: KEY, status: 'superseded' })];
    const priors = keys => B.bqPriorAlerts_({ store: { alerts: log } }, NOW, keys).map(p => p.alert_id);
    eq([priors(undefined), priors(null), priors([]), priors([KEY]), priors([OTHER]), priors([KEY, OTHER, ''])],
      [['E1', 'E3', 'SENT', 'BQ'], ['E1', 'E3', 'SENT', 'BQ'], ['E1', 'E3', 'SENT', 'BQ'], ['E3', 'SENT', 'BQ'], ['E1', 'SENT', 'BQ'], ['SENT', 'BQ']]);
    // 4. the bot's own story card among a space's messages: by its id, else by the record of the cards it posted
    const w = oneSpace(ON);
    w.review = mapsReview(false);
    w.rec.step('a story', 5, () => { w.feed.stories = [mapsStory()]; w.feed.bsip = [golden.rows.mapsRow()]; });
    const read = () => w.t.bot.chatListMessages_(golden.spaces.AC, new Date(w.t.g.clock.now - 10 * MIN).toISOString(), 100).filter(m => !m.threadReply);
    const kinds = () => read().map(m => [/^🚨 \*EARLY DETECTION\*/.test(m.text) ? 'story card' : 'Direct BigQuery card', (m.clientId || '').slice(0, 12),
      w.t.bot.bqIsStoryCard_(m)]);
    eq(kinds(), [['story card', 'client-zeda-', true], ['Direct BigQuery card', 'client-zmir-', false]]);
    w.t.chat.spaces.get(golden.spaces.AC).messages.forEach(m => { delete m.clientAssignedMessageId; });
    ['bot_posts', 'bot_post_ids'].forEach(k => w.t.g.cache.delete(k));
    w.t.bot.ev('BOT_MARKS_ = null');
    eq(kinds(), [['story card', '', true], ['Direct BigQuery card', '', false]]);
    eq([w.t.bot.bqIsStoryCard_(null), w.t.bot.bqIsStoryCard_({}), w.t.bot.bqIsStoryCard_({ name: 'spaces/X/messages/m1', clientId: 'client-bqa-abc' })], [false, false, false]);
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
