// A story added under the card of the alert it repeats marks its story's keys (EarlyDetectionCross.gs edRepeatNote_;
// the Auto-correct flow only, setting cross_alert_notes), as P4a's caller marks a story added under its main post's card.
//
// The marks the story got when it was queued can be gone by the time its review ends (the seen map is one script
// property, written over by other checks and trimmed): the note's own marks then still keep a later signal of the same
// story at the same size from being reviewed again and adding a second note under the same card (its key names the
// signal, so a new signal would get a new key).
// Also case b of the decision, through the whole flow: a repeat of the same post, found by the review.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const W = golden.world;
  const MAPS = golden.posts.MAPS;
  const AC = golden.spaces.AC;
  const OTHER = 'https://x.com/commuter_k/status/2150000000000000072';
  const NOTE = '🔗 *Part of a story:*';
  const rep = (url, author, followers, eng, snippet) => ({ platform: 'X', author_handle: author, followers, engagement_total: eng,
    published_at: '2026-10-14 11:55 UTC', url, snippet });
  const story = at => golden.rows.story({ alert_id: `ED-CLU-clu_maps_bridge-${at}`,
    cluster_id: 'clu_maps_bridge', signal_key: 'clu_maps_bridge', unique_low_tier_authors: 6, mention_count: 7,
    headline: 'Low-tier claim cluster (6 accounts): Google Maps sends drivers onto a closed bridge', topic_product: 'Google Maps',
    primary_url: OTHER, representative_posts_json: JSON.stringify([
      rep(OTHER, 'commuter_k', 900, 31, 'Same here: Maps routed me onto the closed bridge this morning.'),
      rep(MAPS, 'roadwatcher', 41000, 2400, 'Google Maps keeps sending drivers onto a closed bridge.'),
      rep('https://x.com/bridge_local/status/2150000000000000073', 'bridge_local', 700, 27, 'Maps still shows the closed bridge as open.')]) });
  const review = () => ({
    summary: 'Six small accounts on X say Google Maps keeps routing drivers onto a closed bridge.',
    issue_name: 'Reports that Google Maps routes drivers onto a closed bridge',
    emerging_narrative: 'Independent drivers describe the same closed-bridge routing.',
    early_detection_call: { disposition: 'escalate', severity: 'high', confidence: 0.9,
      reason: 'Several independent drivers describe the same routing fault', build_up_signals: '6 accounts on 1 platform',
      watch_for: 'An official statement or press pickup' },
    temp_check_draft: { recommended: false, query_suggestion: '', scope_note: '' },
    slrr: { is_slrr: true, confidence: 0.85, exposure_tag: 'Product - Other/general criticism', product: 'Maps/Geo', other_products: [],
      sensitive_topics: [], location: 'US' },
    known_issue: { matches: false, confidence: 0.9 }, tns: { needed: false, reason: '' }, recommended_groups: [],
    story_title: 'Drivers say Google Maps routes them onto a closed bridge', story: 'Drivers say Maps [sends them onto a closed bridge](P1).',
    web_context: '', next_steps: ['Keep monitoring.'], driver_post: 'P1',
  });
  const after = n => Array.from({ length: n }, (_, i) => [`after${i}`, i % 3 === 2 ? 5 : 1]);
  const reviews = t => (t.g.vertex.calls || []).filter(c => {
    const p = (((c.payload || {}).generationConfig || {}).responseSchema || {}).properties || {};
    return !!p.early_detection_call;
  }).length;

  test('story under its alert, marks: with the queue\'s marks gone when the note is posted, the note\'s own marks keep a later signal of the same story at the same size from a second review and a second note under the same card', () => {
    const w = W.oneSpaceWorld({});
    w.t.g.vertex.earlyDetection = review;
    // the story's queue-time marks are gone by the time its review ends (as when the seen map was written over)
    w.t.bot.ev('var g5mOrig_ = edRepeatNote_; edRepeatNote_ = function () { ' +
      'PropertiesService.getScriptProperties().deleteProperty(ED_SEEN_PROP_); return g5mOrig_.apply(this, arguments); }');
    const recs = [];
    const step = (label, min, fn) => {
      w.rec.step(label, min, fn);
      w.t.bot.edNotesOfRun_().forEach(r => recs.push(w.t.bot.edNoteObj_(r)));
    };
    w.rec.collect('setup');
    step('first', 1);
    step('chk', 5);
    step('chk', 5);
    step('bq', 5, () => { w.feed.bsip = [golden.rows.mapsRow()]; });
    after(3).forEach(([l, m]) => step(l, m));
    step('story', 15, () => { w.feed.stories = [story('202610141200')]; });
    after(6).forEach(([l, m]) => step(l, m));
    const first = reviews(w.t);
    assert.ok(first >= 1, `reviews: ${first}`);
    step('story later', 15, () => { w.feed.stories = [story('202610141230')]; });
    after(6).forEach(([l, m]) => step(`${l} later`, m));
    const all = w.t.bot.sheetBackend_(w.t.sheet()).loadAlerts();
    const card = all.find(a => a.ingested === 'BSIP');
    const notes = w.t.chat.spaces.get(AC).messages.filter(m => m.threadReply && m.thread.name === card.forward_thread &&
      String(m.text).indexOf(NOTE) === 0 && /closed bridge/.test(String(m.text)));
    eq(notes.length, 1, JSON.stringify(notes.map(m => m.text)));
    eq(reviews(w.t), first, 'the later signal is not reviewed again');
    const mine = recs.filter(r => /clu_maps_bridge/.test(r.id));
    eq(mine.map(r => r.outcome), ['Added under another alert\'s card', 'Seen before, nothing new'],
      JSON.stringify(mine.map(r => [r.id, r.outcome])));
  });

  // Case b of the decision: a repeat by 'same_post'. A story whose MAIN post had a Social Alert in the last 24 hours is
  // added under that card at the check, before any review (P4a); one whose main post went out longer ago (but within
  // the novelty window) is reviewed, and the review finds the same post already alerted.
  test('story under its alert, same post: a story whose main post went out as a Social Alert 25 hours earlier is reviewed, ends as a repeat of that alert and is added under its card with one note; no story card, no second email; with cross_alert_notes off no note', () => {
    const go = overrides => {
      const w = W.oneSpaceWorld(overrides);
      w.t.g.vertex.earlyDetection = review;
      const recs = [];
      const step = (label, min, fn) => {
        w.rec.step(label, min, fn);
        w.t.bot.edNotesOfRun_().forEach(r => recs.push(w.t.bot.edNoteObj_(r)));
        const n = w.t.bot.edDayNumbers_(w.t.g.services.PropertiesService.getScriptProperties());
        eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `after "${label}": ${JSON.stringify(n)}`);
      };
      w.rec.collect('setup');
      step('first', 1);
      step('chk', 5);
      step('chk', 5);
      step('bq', 5, () => { w.feed.bsip = [golden.rows.mapsRow()]; });
      after(3).forEach(([l, m]) => step(l, m));
      step('a day later', 25 * 60);
      step('story', 15, () => { w.feed.stories = [Object.assign(story('202610151300'), { primary_url: MAPS })]; });
      after(6).forEach(([l, m]) => step(l, m));
      const out = w.rec.out();
      const all = w.t.bot.sheetBackend_(w.t.sheet()).loadAlerts();
      const card = all.find(a => a.ingested === 'BSIP');
      const notes = w.t.chat.spaces.get(AC).messages.filter(m => m.threadReply && m.thread.name === card.forward_thread &&
        String(m.text).indexOf(NOTE) === 0 && /closed bridge/.test(String(m.text)));
      return { notes, card, reviews: reviews(w.t), mine: recs.filter(r => /clu_maps_bridge/.test(r.id)),
        cards: all.filter(a => a.ingested === 'Early detection'),
        sent: out.emails.filter(e => e.kind === 'sent' && /SOCIAL ALERT/.test(String(e.subject))) };
    };
    const on = go({});
    assert.ok(on.reviews >= 1, `reviews: ${on.reviews}`);
    eq(on.notes.length, 1, JSON.stringify(on.notes.map(m => m.text)));
    eq(on.mine.map(r => r.outcome), ['Added under another alert\'s card'], JSON.stringify(on.mine));
    eq([on.mine[0].card, on.mine[0].message], [on.card.alert_id, on.card.forward_message]);
    assert.match(on.mine[0].why, new RegExp(`^One of its posts already had a Social Alert, ${on.card.alert_id} `));
    eq([on.cards.length, on.sent.length], [0, 1]);
    const off = go({ cross_alert_notes: false });
    eq(off.notes.length, 0);
    assert.ok(off.mine.length > 0 && off.mine.every(r => r.outcome !== 'Added under another alert\'s card'), JSON.stringify(off.mine));
  });
};
