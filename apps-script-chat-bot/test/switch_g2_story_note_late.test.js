// When the Direct BigQuery poll is overdue it goes first (AutoCorrect.gs acEarlyDetectionFirst_): a post can then get
// its own Direct BigQuery card and, in the same run, a story's card on it. The card's own check had no story to point
// at, and the story's review could not see the card (it is only in the Alert log once it is reviewed, the next run).
// The card now gets its "🔗 *Part of a story:*" note at a later check of its first hour (BigQuery.gs
// bqStoryNotesLate_): a story's card that was there before the card's Alert-log row counts, not only one there before
// the card was posted. Once, under the same key; the Auto-correct flow only, with cross_alert_notes on.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const W = golden.world;
  const { AC } = golden.spaces;
  const MAPS = golden.posts.MAPS;
  const OTHER = 'https://x.com/commuter_k/status/2150000000000000072';
  const rep = (url, author, followers, eng, snippet) => ({ platform: 'X', author_handle: author, followers, engagement_total: eng,
    published_at: '2026-10-14 11:55 UTC', url, snippet });
  const mapsStory = () => golden.rows.story({ alert_id: 'ED-CLU-clu_maps_bridge-202610141200', cluster_id: 'clu_maps_bridge',
    signal_key: 'clu_maps_bridge', unique_low_tier_authors: 6, mention_count: 7,
    headline: 'Low-tier claim cluster (6 accounts): Google Maps sends drivers onto a closed bridge', topic_product: 'Google Maps',
    primary_url: MAPS, representative_posts_json: JSON.stringify([
      rep(MAPS, 'roadwatcher', 41000, 2400, 'Google Maps keeps sending drivers onto a closed bridge.'),
      rep(OTHER, 'commuter_k', 900, 31, 'Same here: Maps routed me onto the closed bridge this morning.'),
      rep('https://x.com/bridge_local/status/2150000000000000073', 'bridge_local', 700, 27, 'Maps still shows the closed bridge as open.')]) });
  const monitor = () => ({
    summary: 'Six small accounts on X say Google Maps keeps routing drivers onto a closed bridge.',
    issue_name: 'Reports that Google Maps routes drivers onto a closed bridge',
    emerging_narrative: 'Independent drivers describe the same closed-bridge routing.',
    early_detection_call: { disposition: 'monitor', severity: 'medium', confidence: 0.9,
      reason: 'Several independent drivers describe the same routing fault', build_up_signals: '6 accounts on 1 platform',
      watch_for: 'An official statement or press pickup' },
    temp_check_draft: { recommended: false, query_suggestion: '', scope_note: '' },
    slrr: { is_slrr: true, confidence: 0.85, exposure_tag: 'Product - Other/general criticism', product: 'Maps/Geo', other_products: [],
      sensitive_topics: [], location: 'US' },
    known_issue: { matches: false, confidence: 0.9 }, tns: { needed: false, reason: '' }, recommended_groups: [],
    story_title: 'Drivers say Google Maps routes them onto a closed bridge', story: 'Drivers say Maps [sends them onto a closed bridge](P1).',
    web_context: '', next_steps: ['Keep monitoring.'], driver_post: 'P1',
  });

  const CARD = m => !m.threadReply && /\*\[BigQuery · BSIP\]\*/.test(m.text);
  const STORY = m => !m.threadReply && m.text.indexOf('🚨 *EARLY DETECTION*') === 0;
  /** The Direct BigQuery row and the story arrive together 15 minutes after the last check: the poll is overdue. */
  const run = overrides => {
    const w = W.oneSpaceWorld(overrides);
    w.t.g.vertex.earlyDetection = monitor;
    w.rec.collect('setup');
    w.rec.step('first', 1);
    w.rec.step('chk', 5);
    w.rec.step('chk', 5);
    w.rec.step('both', 15, () => { w.feed.bsip = [golden.rows.mapsRow()]; w.feed.stories = [mapsStory()]; });
    for (let i = 0; i < 8; i++) w.rec.step('after', i % 3 === 2 ? 5 : 1);
    const msgs = w.t.chat.spaces.get(AC).messages.filter(m => m.viaApi);
    const card = msgs.find(CARD);
    const under = card ? msgs.filter(m => m.threadReply && m.thread.name === card.thread.name) : [];
    return { w, msgs, card, notes: under.filter(m => /^🔗 \*Part of a story:\*/.test(m.text)) };
  };

  test('story note late: the poll overdue goes first, the post gets its Direct BigQuery card and a story card in the same run; the card gets one "Part of a story" note at a later check', () => {
    const r = run({});
    assert.ok(r.card, 'the Direct BigQuery card');
    eq(r.msgs.filter(STORY).length, 1);
    // the card was posted before the story's card: this is the overdue order
    assert.ok(r.msgs.indexOf(r.card) < r.msgs.indexOf(r.msgs.find(STORY)));
    eq(r.notes.length, 1);
    assert.ok(/^🔗 \*Part of a story:\* 6 small accounts on X and Reddit tell it \(story card QA-\d+\)$/.test(r.notes[0].text), r.notes[0].text);
    eq(r.w.t.g.logs.filter(l => /^BigQuery direct poll: a note is under the card of .*added at a later check$/.test(l)).length, 1);
  });

  test('story note late: with cross_alert_notes off, no note, as before', () => {
    const r = run({ cross_alert_notes: false });
    assert.ok(r.card);
    eq(r.notes.length, 0);
  });
};
