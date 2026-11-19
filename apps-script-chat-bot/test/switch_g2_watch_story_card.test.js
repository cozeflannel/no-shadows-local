// A story's card that sent no Social Alert never stands in for a post's own alert, for the watch either (the
// one-space setup with stories first: ctx.bqPastStoryCards, AutoCorrect.gs acStoriesFirst_; the watch learns it from
// its destination, dest.bqPastStoryCards, set in Main.gs only when its alerts go to the Auto-correct space).
//
// A story's main post is the Maps post (a P0 exposure tag, 2,400 engagements: a Social Alert by itself). Gemini calls
// the story "monitor": its card sends no Social Alert. Then the watch flags the Maps post:
//   - stories first (the default): the flag goes on as its own Watch alert, whose review sends the post's Social Alert
//     (its triage history leaves the story's row out, as Bot.gs does for a Direct BigQuery card), and one note under
//     the Watch alert points at the story's card ("🔗 *Part of a story:* ...", through the one helper);
//   - early_detection_first off: the flag is closed as already alerted, as before, with no note;
//   - and never, in any setting, "this card already covers the post" under a card that sent no Social Alert.
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

  const STORY = m => !m.threadReply && m.text.indexOf('🚨 *EARLY DETECTION*') === 0;
  const WATCH = m => !m.threadReply && /^🔭/.test(m.text);
  const COVERS = 'this card already covers the post';

  /** The one-space setup with the watch's alerts going to the Auto-correct space; the story first, then the watch's flag. */
  const timeline = (overrides, between, hit) => {
    const w = W.oneSpaceWorld(overrides);
    w.t.g.vertex.earlyDetection = monitor;
    // the history each Watch alert's triage decides with (OtherAlerts.gs handleOtherAlert_ -> otherDecide_)
    w.t.bot.__histories = [];
    w.t.bot.ev('otherDecide_ = (orig => function (ctx, parsed, tri, llm, history, now) { ' +
      '__histories.push([(history || []).map(h => [h.alert_id, h.ingested || ""]), (parsed.earlier || []).length]); ' +
      'return orig.apply(this, arguments); })(otherDecide_)');
    w.rec.collect('setup');
    w.rec.step('first', 1);
    W.watchOn(w.t);
    w.t.control().getRange(35, 2).setValue('Auto-correct space (B10)');
    w.rec.step('chk', 5);
    w.rec.step('chk', 5);
    w.rec.step('story', 15, () => { w.feed.stories = [mapsStory()]; });
    w.rec.step('after', 1);
    w.rec.step('after', 1);
    if (between) between(w);
    w.rec.step('flag', 1, () => { w.feed.look = [hit || golden.rows.mapsHit()]; });
    w.rec.step('flag2', 5);
    w.rec.step('flag3', 5);
    w.rec.step('flag4', 5, () => { w.feed.look = []; });
    for (let i = 0; i < 4; i++) w.rec.step('after', i % 3 === 2 ? 5 : 1);
    const out = w.rec.out();
    const msgs = w.t.chat.spaces.get(AC).messages.filter(m => m.viaApi);
    return { w, out, msgs, sent: out.emails.filter(e => e.kind === 'sent') };
  };

  test('watch and story cards: stories first, a flag on the main post of a story card that sent no Social Alert goes on as its own Watch alert, sends the post\'s one Social Alert, and gets one "Part of a story" note pointing at the story card; "this card already covers the post" is never posted', () => {
    const { w, msgs, sent } = timeline({});
    const story = msgs.filter(STORY);
    const watch = msgs.filter(WATCH);
    eq([story.length, watch.length], [1, 1]);
    eq(msgs.filter(m => m.text.indexOf(COVERS) >= 0).length, 0);
    eq(sent.length, 1);
    assert.ok(/SOCIAL ALERT/.test(sent[0].subject), sent[0].subject);
    const notes = msgs.filter(m => m.threadReply && m.thread.name === watch[0].thread.name && /^🔗 \*Part of a story:\*/.test(m.text));
    eq(notes.length, 1);
    assert.ok(/^🔗 \*Part of a story:\* 6 small accounts on X and Reddit tell it \(story card QA-1001\)$/.test(notes[0].text), notes[0].text);
    // the watch flag's row says it was posted (a: 'p'), never "already alerted"
    assert.ok(!w.t.g.logs.some(l => /Watch alerts: not posting https:\/\/x\.com\/roadwatcher/.test(l)));
    // its review leaves the story's row out of its history: no repeat of the story, no "Ongoing Issue"
    eq(sent.filter(e => /Ongoing Issue/i.test(String(e.subject))).length, 0);
  });

  test('watch and story cards: stories first, the Watch alert\'s review leaves the story card on its own post out of its history (as Bot.gs does for a Direct BigQuery card): the earlier alerts its triage weighs (and Gemini is shown) hold no story card, so the post is not an ongoing issue of it', () => {
    const triagePrompts = w => w.t.g.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.stream_call)
      .map(c => c.payload.contents[0].parts.map(p => p.text || '').join('\n'));
    const { w, sent } = timeline({});
    const prompts = triagePrompts(w);
    eq(prompts.length, 1);
    assert.ok(prompts[0].indexOf('roadwatcher') >= 0);
    eq(w.t.bot.__histories.length, 1);
    eq(w.t.bot.__histories[0], [[], 0]);
    eq(sent.length, 1);
    assert.ok(!/Ongoing/i.test(sent[0].subject), sent[0].subject);
  });

  test('watch and story cards: early_detection_first off, the flag on the story card\'s post is closed as already alerted, as before, and no note says the story card covers it', () => {
    const { w, msgs, sent } = timeline({ early_detection_first: false });
    eq([msgs.filter(STORY).length, msgs.filter(WATCH).length, sent.length], [1, 0, 0]);
    eq(msgs.filter(m => m.text.indexOf(COVERS) >= 0).length, 0);
    eq(msgs.filter(m => /Part of a story/.test(m.text)).length, 0);
    assert.ok(w.t.g.logs.some(l => /Watch alerts: not posting https:\/\/x\.com\/roadwatcher\S*: it already had an alert/.test(l)));
  });

  test('watch and story cards: with every setting of the plan off, the flag on the story card\'s post is closed as at f93e31a: no Watch alert, no note, no email', () => {
    const { msgs, sent } = timeline(golden.SETTINGS_OFF);
    eq([msgs.filter(STORY).length, msgs.filter(WATCH).length, sent.length], [1, 0, 0]);
    eq(msgs.filter(m => m.threadReply && /^(🔭|🔗)/.test(m.text)).length, 0);
  });

  test('watch and story cards: the pure rule (pwStoryCardOnly_): only where stories go first (dest.bqPastStoryCards), only for the Auto-correct space, only when every alert the memory has on the post is a story card of the Auto-correct flow that sent no Social Alert', () => {
    const B = H.B;
    const now = Date.UTC(2026, 9, 14, 12, 0);
    const AC_SUFFIX = B.ev('AC_PARTITION_SUFFIX_');
    const row = (id, o) => Object.assign({ alert_id: id, space: `spaces/AAQAonespace01${AC_SUFFIX}`, ingested: 'Early detection',
      created_at: now - 3600 * 1000, email_status: '', record_key: 'x.com/status/2150000000000000002' }, o || {});
    const rows = [row('QA-1001'), row('QA-1002', { email_status: 'sent' }), row('QA-1003', { ingested: '' }),
      row('QA-1004', { space: 'spaces/AAQAmirrorgf1' })];
    const dest = o => Object.assign({ choice: 'autocorrect', space: { id: 'spaces/AAQAonespace01' }, bqPastStoryCards: true }, o || {});
    const seen = ids => ({ outcome: 'seen', ids });
    eq([B.pwStoryCardOnly_(dest(), rows, seen(['QA-1001']), now),
      B.pwStoryCardOnly_(dest({ bqPastStoryCards: false }), rows, seen(['QA-1001']), now),
      B.pwStoryCardOnly_(dest({ bqPastStoryCards: undefined }), rows, seen(['QA-1001']), now),
      B.pwStoryCardOnly_(dest({ choice: 'mirror' }), rows, seen(['QA-1001']), now),
      B.pwStoryCardOnly_(dest({ choice: 'other' }), rows, seen(['QA-1001']), now),
      B.pwStoryCardOnly_(dest(), rows, seen(['QA-1002']), now),
      B.pwStoryCardOnly_(dest(), rows, seen(['QA-1001', 'QA-1003']), now),
      B.pwStoryCardOnly_(dest(), rows, seen(['QA-1004']), now),
      B.pwStoryCardOnly_(dest(), rows, seen(['QA-9999']), now),
      B.pwStoryCardOnly_(dest(), rows, Object.assign(seen(['QA-1001']), { claim: true }), now),
      B.pwStoryCardOnly_(dest(), rows, null, now),
      B.pwStoryCardOnly_(null, rows, seen(['QA-1001']), now)],
    [true, false, false, false, false, false, false, false, false, false, false, false]);
  });
};
