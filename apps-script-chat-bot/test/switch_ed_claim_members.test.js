// Step 3a of the new sources: while Control row 50 (the Watch's AMIE source, the plan's stage 3, which needs it) is ON,
// every post a story's card links is seen by that card in the alert memory, as its main post is (EarlyDetection.gs
// edNoteMembers_, AlertMemory.gs notePosts; setting early_detection_claim_members), when the card is posted and when an
// update adds posts. With row 50 OFF the bot is as it was: a linked post is no post's own alert anywhere, as the fix
// plan built it (switch_bq_story_notes, switch_g2_one_email). So the checks that ask the alert memory about a post (seenPost: the Watch, the Direct BigQuery poll) treat a
// linked post exactly as they treat the story's main post, with everything the fix plan built on them: where stories go
// first, a story's card that sent no Social Alert is no post's own alert (BigQuery.gs bqOnlyStoryCards_, WatchAlerts.gs
// pwStoryCardOnly_); a story's card that went out as a Social Alert is the alert on the posts it links. The card's text
// does not change, and nothing is noted for a story that got no card. Every post and account here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const W = golden.world;
  const MIN = 60 * 1000;
  const ON = Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true });
  const OFF = golden.SETTINGS_OFF;
  const MAPS = golden.posts.MAPS;  // Direct BigQuery finds it with a P0 exposure tag and 2,400 engagements: a Social Alert
  const MAIN = 'https://x.com/commuter_k/status/2150000000000000072';
  const BRIDGE = 'https://x.com/bridge_local/status/2150000000000000073';
  const NEW1 = 'https://x.com/late_driver/status/2150000000000000081';
  const NEW2 = 'https://www.reddit.com/r/googlemaps/comments/1brg81/closed_bridge_again/';
  const TESTER = 'tester@testing.test';
  const STORY_RUN = 'the story is found';
  const POST_RUN = 'Direct BigQuery finds the post';

  const kind = m => (!m.reply && /\*\[BigQuery · BSIP\]\*/.test(m.text) ? 'Direct BigQuery card'
    : !m.reply && m.text.indexOf('🚨 *EARLY DETECTION*') === 0 ? 'story card'
      : m.reply && m.text.indexOf('🤖 *Early Detection Review') === 0 ? 'story review note'
        : m.reply && m.text.indexOf('The agentic assistant reviewed this alert') === 0 ? 'card review note' : 'another post');

  /** A world three Direct BigQuery checks in (as switch_ed_first.test.js has it), the story review answered by w.review. */
  function ready(w) {
    const answer = w.t.g.vertex.earlyDetection;
    w.t.g.vertex.earlyDetection = payload => (w.review || answer)(payload);
    w.rec.collect('setup');
    w.rec.step('the first run', 1);
    w.rec.step('a check', 5);
    w.rec.step('a check', 5);
    return w;
  }
  // Row 50 (key watchAmie) is built by step 3b: these worlds read it ON, but for `off`
  const row50 = w => { w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { watchAmie: true }))(readSwitches_)'); return w; };
  const oneSpace = (overrides, off) => ready(off ? W.oneSpaceWorld(overrides) : row50(W.oneSpaceWorld(overrides)));

  const rep = (url, author, followers, eng, snippet) => ({ platform: url.includes('reddit') ? 'Reddit' : 'X', author_handle: author, followers,
    engagement_total: eng, published_at: '2026-10-14 11:55 UTC', url, snippet });
  const POSTS = {
    [MAPS]: rep(MAPS, 'roadwatcher', 41000, 2400, 'Google Maps keeps sending drivers onto a closed bridge.'),
    [MAIN]: rep(MAIN, 'commuter_k', 900, 31, 'Same here: Maps routed me onto the closed bridge this morning.'),
    [BRIDGE]: rep(BRIDGE, 'bridge_local', 700, 27, 'Maps still shows the closed bridge as open.'),
    [NEW1]: rep(NEW1, 'late_driver', 600, 12, 'Maps sent me to the closed bridge again tonight.'),
    [NEW2]: rep(NEW2, 'redditor_brg', 300, 9, 'Google Maps still routes onto the closed bridge, anyone else?'),
  };
  /**
   * The story on the closed bridge: its main post `main` (MAPS, as the fix plan's tests have it, or MAIN, which leaves
   * MAPS a post the card links), its posts `urls` (the three first when not given), `accounts` of them.
   */
  const bridgeStory = (main, urls, accounts) => golden.rows.story({
    alert_id: `ED-CLU-clu_maps_bridge-2026101412${accounts ? String(accounts).padStart(2, '0') : '00'}`, cluster_id: 'clu_maps_bridge',
    signal_key: 'clu_maps_bridge', headline: `Low-tier claim cluster (${accounts || 6} accounts): Google Maps sends drivers onto a closed bridge`,
    topic_product: 'Google Maps', primary_url: main, unique_low_tier_authors: accounts || 6,
    platforms_csv: (urls || []).some(u => u.includes('reddit')) ? 'X, Reddit' : 'X', platform_count: (urls || []).some(u => u.includes('reddit')) ? 2 : 1,
    representative_posts_json: JSON.stringify((urls || [MAIN, MAPS, BRIDGE]).sort((a, b) => (a === main ? -1 : b === main ? 1 : 0)).map(u => POSTS[u])) });
  const bridgeReview = escalate => () => ({
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
   * The story is found `by` minutes before Direct BigQuery finds MAPS (0: the same run), its main post `main`; then the
   * world runs on until everything is worked. What came of it, as switch_ed_first.test.js reads it.
   */
  const storyThenPost = (w, main, opts) => {
    const { t, rec, feed } = w;
    const o = opts || {};
    w.review = bridgeReview(!!o.escalate);
    const stories = () => [bridgeStory(main)];
    if (o.by) rec.step(STORY_RUN, o.by, () => { feed.stories = stories(); });
    rec.step(POST_RUN, 5, () => { feed.bsip = [golden.rows.mapsRow()]; feed.stories = stories(); });
    [1, 1, 1, 5, 1].forEach(minutes => rec.step('after', minutes));
    const out = rec.out();
    const key = t.bot.recordKey_({ post_url: MAPS });
    const posts = label => out.chat.filter(m => m.run === label).map(kind);
    const rows = t.bot.sheetBackend_(t.sheet()).loadAlerts();
    return {
      story: posts(STORY_RUN), post: posts(POST_RUN), after: posts('after'),
      emails: out.emails.map(e => [e.run, e.kind, e.to, e.subject.split(' | ')[0]]),
      names: out.emails.map(e => (String(e.text).match(/^Name: .*$/m) || [''])[0]),
      // the rows on MAPS that are not the story card's (the story card's row is on its main post)
      own: rows.filter(r => r.record_key === key && r.ingested !== 'Early detection').map(r => [r.ingested, r.email_status || '', String(r.decision || '')]),
      cards: out.chat.filter(m => !m.reply && m.text.includes(MAPS)).map(kind),
      storyText: (out.chat.find(m => kind(m) === 'story card') || {}).text || '',
    };
  };
  // what is the same for a linked post as for the main post: the posts of each run by kind, the emails, the post's own
  // Alert-log rows and what was decided for them
  const same = r => [r.story, r.post, r.after, r.emails, r.names, r.own];

  test('claim members (3a): where stories go first, a post the story\'s card links, like its main post, still gets its own Direct BigQuery card and the Social Alert it earns when the card sent no Social Alert, in the same run and when the story came a check earlier', () => {
    [0, 5].forEach(by => {
      const main = storyThenPost(oneSpace(ON), MAPS, { by });
      const linked = storyThenPost(oneSpace(ON), MAIN, { by });
      eq([by, same(linked)], [by, same(main)]);
      eq([by, linked.post.concat(linked.after).filter(k => k === 'Direct BigQuery card' || k === 'card review note')], [by, ['Direct BigQuery card', 'card review note']]);
      eq([by, linked.emails.map(e => e.slice(1, 3))], [by, [['sent', [TESTER]]]]);
      eq([by, linked.names], [by, ['Name: Maps routing onto a closed bridge / New']]);  // a new issue: the story's card is no earlier alert on it
    });
  });

  test('claim members (3a): a post the story\'s card links, like its main post, gets no Direct BigQuery card of its own once that card went out as a Social Alert, whichever setup; and where stories do not go first, a story\'s card counts as the alert on each post it links, as on its main post', () => {
    // (the story's own Social Alert follows its main post, so its tier is not compared: what came of MAPS is)
    const post = r => [r.story, r.post, r.after, r.emails.map(e => e.slice(0, 3)), r.own];
    [['stories first', ON], ['as before', OFF]].forEach(([name, settings]) => {
      const main = storyThenPost(oneSpace(settings), MAPS, { by: 5, escalate: true });
      const linked = storyThenPost(oneSpace(settings), MAIN, { by: 5, escalate: true });
      eq([name, post(linked)], [name, post(main)]);
      eq([name, linked.post.concat(linked.after).filter(k => k === 'Direct BigQuery card'), linked.emails.map(e => e[0])], [name, [], [STORY_RUN]]);
    });
    const main = storyThenPost(oneSpace(OFF), MAPS, { by: 5 });
    const linked = storyThenPost(oneSpace(OFF), MAIN, { by: 5 });
    eq(same(linked), same(main));
    eq([linked.post, linked.after, linked.emails], [[], [], []]);
  });

  test('claim members (3a): the card\'s text is what it was, and nothing is noted for a story that got no card (its review let it go)', () => {
    const got = storyThenPost(oneSpace(ON), MAIN, { by: 5 });
    assert.ok(got.storyText.includes(MAPS) && got.storyText.indexOf('🚨 *EARLY DETECTION*') === 0, got.storyText);
    // the same story with the step taken out: the same card, word for word
    const without = oneSpace(ON);
    without.t.bot.edNoteMembers_ = () => {};
    eq(storyThenPost(without, MAIN, { by: 5 }).storyText, got.storyText);
    // a story the review lets go: no card, so the memory knows none of its posts
    const v = oneSpace(ON);
    v.review = () => Object.assign(bridgeReview(false)(), { early_detection_call: { disposition: 'dismiss', severity: 'low', confidence: 0.9,
      reason: 'Routine chatter' } });
    v.rec.step(STORY_RUN, 5, () => { v.feed.stories = [bridgeStory(MAIN)]; });
    v.rec.step('after', 1);
    v.rec.out();
    const mem = v.t.bot.alertMemoryStart_(v.t.sheet());
    eq([MAIN, MAPS, BRIDGE].map(u => mem.seenPost(u)), [null, null, null]);
  });

  test('claim members (3a): with row 50 OFF (as it is until step 3b) or the setting early_detection_claim_members off, nothing is noted: a post the story\'s card links is no post\'s own alert, and it gets its own Direct BigQuery card where stories do not go first, as the fix plan built it', () => {
    const asked = w => {
      w.review = bridgeReview(false);
      w.rec.step(STORY_RUN, 5, () => { w.feed.stories = [bridgeStory(MAIN)]; });
      [1, 1].forEach(m => w.rec.step('after', m));
      w.rec.out();
      const mem = w.t.bot.alertMemoryStart_(w.t.sheet());
      return [MAPS, BRIDGE].map(u => mem.seenPost(u));
    };
    eq(asked(oneSpace(ON, 'off')), [null, null]);
    const noSetting = oneSpace(ON);
    noSetting.t.bot.ev('GEN').settings.early_detection_claim_members = false;
    eq(asked(noSetting), [null, null]);
    eq(asked(oneSpace(ON)).map(s => s && s.outcome), ['seen', 'seen']);
    // where stories do not go first: with row 50 OFF the linked post gets its card, with it ON it does not (as the main post)
    const off = storyThenPost(oneSpace(OFF, 'off'), MAIN, { by: 5 });
    eq([off.post, off.after.filter(k => k === 'card review note')], [['Direct BigQuery card'], ['card review note']]);
    eq(storyThenPost(oneSpace(OFF), MAIN, { by: 5 }).post, []);
  });

  test('claim members (3a): what the Watch asks the alert memory (seenPost, then pwStoryCardOnly_ where stories go first) is the same for a linked post as for the main post: a card that sent no Social Alert is no post\'s own alert there (the Watch alert goes on), one that went out as a Social Alert is the alert on each (no Watch alert)', () => {
    const asked = (main, escalate) => {
      const w = oneSpace(ON);
      w.review = bridgeReview(escalate);
      w.rec.step(STORY_RUN, 5, () => { w.feed.stories = [bridgeStory(main)]; });
      [1, 1].forEach(m => w.rec.step('after', m));
      w.rec.out();
      const b = w.t.bot;
      const mem = b.alertMemoryStart_(w.t.sheet());
      const seen = mem.seenPost(MAPS);
      const rows = b.sheetBackend_(w.t.sheet()).loadAlerts();
      const dest = { choice: 'autocorrect', bqPastStoryCards: true };
      return { seen: seen && [seen.outcome, seen.claim || '', (seen.ids || []).length, rows.some(r => r.alert_id === seen.alert_id && r.ingested === 'Early detection')],
        storyOnly: b.pwStoryCardOnly_(dest, rows, seen, w.t.g.clock.now), watchSkips: !!seen && !b.pwStoryCardOnly_(dest, rows, seen, w.t.g.clock.now),
        others: [BRIDGE].map(u => !!mem.seenPost(u)) };
    };
    [false, true].forEach(escalate => {
      const main = asked(MAPS, escalate);
      const linked = asked(MAIN, escalate);
      // the Watch's call (skip the post, or let its alert go on with the story's note) is the same for both
      eq([escalate, linked.storyOnly, linked.watchSkips], [escalate, main.storyOnly, main.watchSkips]);
      eq([escalate, linked.seen, linked.watchSkips, linked.others], [escalate, ['seen', '', 1, true], escalate, [true]]);
      // (the main post of a story whose email went out is "emailed", 14 days; a linked post is seen by the card, as a
      // producer's claim would be: 24 hours, or the window a late source asks for)
      eq([escalate, main.seen && main.seen[0]], [escalate, escalate ? 'emailed' : 'seen']);
    });
  });

  test('claim members (3a): an update that adds two posts to a story\'s card notes them, as seen by the update\'s own row; the posts noted before stay', () => {
    const w = oneSpace(ON);
    w.review = bridgeReview(false);
    w.rec.step(STORY_RUN, 5, () => { w.feed.stories = [bridgeStory(MAIN)]; });
    [1, 1].forEach(m => w.rec.step('after', m));
    w.rec.step('it grows', 20, () => { w.feed.stories = [bridgeStory(MAIN, [MAIN, MAPS, BRIDGE, NEW1, NEW2], 13)]; });
    [1, 1, 1].forEach(m => w.rec.step('after it grew', m));
    const out = w.rec.out();
    const b = w.t.bot;
    const rows = b.sheetBackend_(w.t.sheet()).loadAlerts().filter(r => r.ingested === 'Early detection');
    const update = rows.find(r => ((r.forwarded_fields || {}).early_detection || {}).update_of);
    assert.ok(update, `an update was posted: ${JSON.stringify(out.chat.filter(m => m.run !== 'setup').map(m => [m.run, kind(m), !!m.reply]))}`);
    const mem = b.alertMemoryStart_(w.t.sheet());
    eq([NEW1, NEW2].map(u => { const s = mem.seenPost(u); return s && [s.outcome, s.alert_id]; }), [['seen', update.alert_id], ['seen', update.alert_id]]);
    eq([MAPS, BRIDGE].map(u => { const s = mem.seenPost(u); return s && s.ids.indexOf(rows[0].alert_id) >= 0; }), [true, true]);
  });

  test('claim members (3a): notePosts leaves out the card\'s main post and repeats, notes nothing for a row with no id, never throws, and the memory\'s stored size holds in its worst case (300 cards of 8 posts with 300-character links, each post seen by more alerts than it keeps)', () => {
    const w = W.oneSpaceWorld(OFF);
    const b = w.t.bot;
    const mem = b.alertMemoryStart_(w.t.sheet());
    const now = w.t.g.clock.now;
    const row = (i, main) => ({ alert_id: `QA-${9000 + i}`, created_at: now - i * 1000, space: 'SLRR Auto-correct Test (auto-correct)',
      forwarded_fields: { post_url: main }, ingested: 'Early detection' });
    eq(mem.notePosts(row(0, MAIN), [MAIN, MAPS, MAPS, BRIDGE, '', null, 'not a link']), 2);
    eq([mem.seenPost(MAPS).ids, mem.seenPost(BRIDGE).ids, mem.seenPost(MAIN)], [['QA-9000'], ['QA-9000'], null]);
    eq([mem.notePosts({ created_at: now }, [MAPS]), mem.notePosts(null, [MAPS]), mem.notePosts(row(1, MAIN), 'not a list')], [0, 0, 0]);
    eq(b.alertMemory_ && b.ev('AM_OFF_').notePosts(row(2, MAIN), [MAPS]), 0);
    // the worst case: 300 cards, 8 posts each, links of 300 characters; the 8 posts of the first card seen by 10 cards
    const long = (i, j) => `https://www.reddit.com/r/googlemaps/comments/${String(i).padStart(6, '0')}${j}/${'a_very_long_title_'.repeat(20)}`.slice(0, 300);
    for (let i = 0; i < 300; i++) mem.notePosts(row(10 + i, `https://x.com/main_${i}/status/1`), Array.from({ length: 8 }, (_, j) => long(i < 10 ? 0 : i, j)));
    eq(mem.seenPost(long(0, 3)).ids.length, b.ev('AM_IDS_KEPT_'));
    mem.flush();
    const tab = w.t.sheet().getSheetByName(b.ev('AM_TAB_'));
    const cells = tab.rows.slice(1).map(r => r.map(v => String(v === undefined || v === null ? '' : v)));
    assert.ok(cells.length >= 290 * 8, `rows ${cells.length}`);
    const longest = Math.max(...cells.map(r => Math.max(...r.map(v => v.length))));
    assert.ok(longest <= b.ev('AM_CELL_MAX_'), `longest cell ${longest}`);
    assert.ok(longest < 2000, `a linked post's cell stays small: ${longest}`);
  });
};
