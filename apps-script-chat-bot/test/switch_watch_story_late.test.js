// The "Part of a story" note under a Watch alert whose post's only card was a story's card that sent no Social Alert
// (WatchAlerts.gs pwStoryNotes_) is tried in the run that posts the Watch alert. A run short of time then left it out
// for good; now a later run of the watch that has flags to post looks again (pwStoryNotesLate_, the shape of
// BigQuery.gs bqStoryNotesLate_): the note is posted once, under the same key, and never again.
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
  const WATCH = m => !m.threadReply && /^🔭/.test(m.text);
  const STORY_NOTE = /^🔗 \*Part of a story:\* 6 small accounts on X and Reddit tell it \(story card QA-1001\)$/;

  /**
   * The one-space setup with the watch's alerts going to the Auto-correct space: the story card (monitor), then the
   * watch flags its main post. `short`: the run that posts the Watch alert is short of time for its story note.
   * Later the watch flags another post, so the watch has flags to post again. The notes under the Watch alert after
   * each step.
   */
  const timeline = (overrides, short) => {
    const w = W.oneSpaceWorld(overrides);
    w.t.g.vertex.earlyDetection = monitor;
    if (short) {
      w.t.bot.__storyShort = 1;
      w.t.bot.ev('pwStoryNotes_ = (orig => function (dest, flags, rows, now, left, on) { if (__storyShort && (flags || []).length) ' +
        '{ __storyShort = 0; return orig(dest, flags, rows, now, () => 0, on); } return orig.apply(this, arguments); })(pwStoryNotes_)');
    }
    const notesOf = () => {
      const msgs = w.t.chat.spaces.get(AC).messages.filter(m => m.viaApi);
      const watch = msgs.filter(WATCH);
      return watch.length ? msgs.filter(m => m.threadReply && m.thread.name === watch[0].thread.name && /^🔗/.test(m.text)) : [];
    };
    const counts = [];
    w.rec.collect('setup');
    w.rec.step('first', 1);
    W.watchOn(w.t);
    w.t.control().getRange(35, 2).setValue('Auto-correct space (B10)');
    w.rec.step('chk', 5);
    w.rec.step('chk', 5);
    w.rec.step('story', 15, () => { w.feed.stories = [mapsStory()]; });
    w.rec.step('after', 1);
    w.rec.step('after', 1);
    w.rec.step('flag', 1, () => { w.feed.look = [golden.rows.mapsHit()]; });
    w.rec.step('flag2', 5);
    w.rec.step('flag3', 5);
    w.rec.step('flag4', 5, () => { w.feed.look = []; });
    counts.push(['before the other flag', notesOf().length]);
    w.rec.step('other', 5, () => { w.feed.look = [golden.rows.pixelHit()]; });
    for (let i = 0; i < 4; i++) w.rec.step('after', 5);
    counts.push(['after the other flag', notesOf().length]);
    w.rec.step('more', 5, () => { w.feed.look = [golden.rows.hit()]; });
    for (let i = 0; i < 4; i++) w.rec.step('after', 5);
    counts.push(['after a third flag', notesOf().length]);
    w.rec.out();
    return { w, counts, notes: notesOf() };
  };

  test('watch story note later: the run that posts the Watch alert is short of time, so no note; a later run of the watch posts the "Part of a story" note; later runs never post it again', () => {
    const { counts, notes } = timeline({}, true);
    eq(counts, [['before the other flag', 0], ['after the other flag', 1], ['after a third flag', 1]]);
    assert.ok(STORY_NOTE.test(notes[0].text), notes[0].text);
  });

  test('watch story note later: with time in the run that posts the Watch alert, the note is posted then, once, and the later look adds none', () => {
    const { counts } = timeline({}, false);
    eq(counts, [['before the other flag', 1], ['after the other flag', 1], ['after a third flag', 1]]);
  });

  test('watch story note later: with early_detection_first off, or cross_alert_notes off, no note at any run', () => {
    eq(timeline({ early_detection_first: false }, true).counts.map(c => c[1]), [0, 0, 0]);
    eq(timeline({ cross_alert_notes: false }, true).counts.map(c => c[1]), [0, 0, 0]);
  });

  test('watch story note later: the pure gate (pwStoryNotesLate_): nothing outside the Auto-correct space, without stories first, or with the notes off', () => {
    const B = H.B;
    const now = Date.UTC(2026, 9, 14, 12, 0);
    const dest = o => Object.assign({ choice: 'autocorrect', space: { id: 'spaces/AAQAonespace01' }, bqPastStoryCards: true }, o || {});
    const rows = [{ alert_id: 'QA-1002', space: `spaces/AAQAonespace01${B.ev('AC_PARTITION_SUFFIX_')}`, ingested: 'Watch alert',
      record_key: 'x.com/status/1', forward_thread: 'spaces/AAQAonespace01/threads/t1', forward_message: 'spaces/AAQAonespace01/messages/m1',
      created_at: now - 60000 }];
    eq([B.pwStoryNotesLate_(dest({ choice: 'mirror' }), rows, now, () => Infinity, true),
      B.pwStoryNotesLate_(dest({ bqPastStoryCards: false }), rows, now, () => Infinity, true),
      B.pwStoryNotesLate_(dest(), rows, now, () => Infinity, false),
      B.pwStoryNotesLate_(dest(), rows, now, () => Infinity, true)], [0, 0, 0, 0]);
  });
};
