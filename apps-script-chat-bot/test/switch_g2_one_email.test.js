// One issue, one new Social Alert email (the Auto-correct flow only, setting cross_alert_notes; matched by the post's
// record key, never by the issue's name).
//
// The Maps post (a P0 exposure tag, 2,400 engagements) gets a Direct BigQuery card, which sends a Social Alert by itself.
// A story whose main post is ANOTHER post (a small account's) also links the Maps post, and its review escalates.
// Before this change both sent a new Social Alert email, in either order and in the same run, with two different
// issue names ("Maps routing onto a closed bridge" and "Reports that Google Maps routes drivers onto a closed bridge").
// Now:
//   - a story about to escalate one of whose linked posts has a row in this flow's Alert log, within the novelty
//     window, that went out as a Social Alert (Escalate.gs earlierOutcome_ 'alerted') is an ongoing issue of that alert:
//     the bot's existing ongoing-issue path decides (EarlyDetection.gs edDecide_: its follow-up is that alert, so it is a
//     repeat unless the stakes rose, and then an update on that email's thread);
//   - the reverse for a Direct BigQuery card (Bot.gs) or a Watch alert (OtherAlerts.gs) whose post a story card that
//     went out as a Social Alert links: the story's alert is an earlier alert on that very post.
// Never when the earlier alert did not go out as a Social Alert. With the setting off, and in the Mirror flow, the
// emails are what they were.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const W = golden.world;
  const MAPS = golden.posts.MAPS;
  const OTHER = 'https://x.com/commuter_k/status/2150000000000000072';
  const rep = (url, author, followers, eng, snippet) => ({ platform: 'X', author_handle: author, followers, engagement_total: eng,
    published_at: '2026-10-14 11:55 UTC', url, snippet });
  /** A story whose main post is `main`; it links the Maps post and one more. */
  const story = (main, n, at) => golden.rows.story({ alert_id: `ED-CLU-clu_maps_bridge-${at || '202610141200'}`,
    cluster_id: 'clu_maps_bridge', signal_key: 'clu_maps_bridge', unique_low_tier_authors: n || 6, mention_count: (n || 6) + 1,
    headline: `Low-tier claim cluster (${n || 6} accounts): Google Maps sends drivers onto a closed bridge`, topic_product: 'Google Maps',
    primary_url: main, representative_posts_json: JSON.stringify([
      rep(OTHER, 'commuter_k', 900, 31, 'Same here: Maps routed me onto the closed bridge this morning.'),
      rep(MAPS, 'roadwatcher', 41000, 2400, 'Google Maps keeps sending drivers onto a closed bridge.'),
      rep('https://x.com/bridge_local/status/2150000000000000073', 'bridge_local', 700, 27, 'Maps still shows the closed bridge as open.')]) });
  const review = escalate => () => ({
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
    web_context: '', next_steps: ['Keep monitoring.'], driver_post: 'P1',
  });

  const after = n => Array.from({ length: n }, (_, i) => [`after${i}`, i % 3 === 2 ? 5 : 1]);
  /** The one-space setup three checks in, then `plan`: [[label, minutes, before]]. Its Social Alert emails, as sent. */
  const run = (overrides, plan, escalate) => {
    const w = W.oneSpaceWorld(overrides);
    w.t.g.vertex.earlyDetection = review(escalate !== false);
    w.rec.collect('setup');
    w.rec.step('first', 1);
    w.rec.step('chk', 5);
    w.rec.step('chk', 5);
    plan(w).forEach(([label, min, fn]) => w.rec.step(label, min, fn));
    const out = w.rec.out();
    const sent = out.emails.filter(e => e.kind === 'sent');
    return { w, out, sent, fresh: sent.filter(e => /SOCIAL ALERT/.test(String(e.subject)) && !/^Re:/i.test(String(e.subject))) };
  };
  const bq = w => () => { w.feed.bsip = [golden.rows.mapsRow()]; };
  const st = (w, main, n, at) => () => { w.feed.stories = [story(main, n, at)]; };
  const PLANS = {
    'story first, then the post\'s own card': w => [['story', 15, st(w, OTHER)]].concat(after(3), [['bq', 5, bq(w)]], after(6)),
    'the post\'s own card first, then the story': w => [['bq', 5, bq(w)]].concat(after(3), [['story', 15, st(w, OTHER)]], after(6)),
    'both in the same run': w => [['both', 15, () => { bq(w)(); st(w, OTHER)(); }]].concat(after(8)),
    'the post\'s own card first, then a bigger story (14 accounts)': w => [['bq', 5, bq(w)]].concat(after(3),
      [['story', 15, st(w, OTHER, 14, '202610141245')]], after(6)),
  };
  const subjects = r => r.fresh.map(e => String(e.subject).split(' | ')[0]);

  const SA = 'SOCIAL ALERT';
  const STORY_SUBJECT = '[Auto-correct test] ⬛SOCIAL ALERT⬛: Maps/Geo';
  const POST_SUBJECT = '[Auto-correct test] 🟥SOCIAL ALERT🟥: Google Maps';
  const rows = r => r.w.t.bot.sheetBackend_(r.w.t.sheet()).loadAlerts();
  // what each order sends: the new Social Alert, and whether the other path follows it on its thread
  const EXPECTED = {
    'story first, then the post\'s own card': { fresh: STORY_SUBJECT, update: true },
    'the post\'s own card first, then the story': { fresh: POST_SUBJECT, update: false },
    'both in the same run': { fresh: STORY_SUBJECT, update: true },
    'the post\'s own card first, then a bigger story (14 accounts)': { fresh: POST_SUBJECT, update: false },
  };
  Object.keys(PLANS).forEach(name => {
    test(`one issue one email: ${name}: one new Social Alert email for the issue; the other path sends none of its own (an update on that email's thread when the stakes rose, else nothing)`, () => {
      const r = run({}, PLANS[name]);
      eq(subjects(r), [EXPECTED[name].fresh], JSON.stringify(r.sent.map(e => e.subject)));
      const updates = r.sent.filter(e => /^Re: /.test(String(e.subject)) && String(e.subject).indexOf(SA) >= 0);
      eq(updates.length, EXPECTED[name].update ? 1 : 0, JSON.stringify(r.sent.map(e => e.subject)));
      const all = rows(r);
      if (EXPECTED[name].update) {
        // the post's own card (P0, 2,400 engagements: the stakes rose) went out on the story email's thread
        const storyRow = all.find(a => a.ingested === 'Early detection');
        const cardRow = all.find(a => a.ingested === 'BSIP');
        eq([storyRow.email_status, cardRow.email_status, cardRow.email_thread === storyRow.email_thread], ['sent', 'sent', true]);
        assert.ok(updates[0].subject.indexOf(`Re: ${STORY_SUBJECT}`) === 0, updates[0].subject);
      } else {
        // the story is an ongoing issue of the post's alert, with nothing that raises the stakes: a repeat, no card, no email
        eq(all.filter(a => a.ingested === 'Early detection').length, 0);
        assert.ok(r.w.t.g.logs.some(l => /one of its posts was already alerted \(QA-1001\)/.test(l)),
          r.w.t.g.logs.filter(l => /QA-|repeat|already/.test(l)).slice(-6).join(' / '));
      }
    });
    test(`one issue one email: ${name}: with cross_alert_notes off, both paths send a new Social Alert email, as before`, () => {
      const r = run({ cross_alert_notes: false }, PLANS[name]);
      eq(subjects(r).sort(), [POST_SUBJECT, STORY_SUBJECT].sort(), JSON.stringify(r.sent.map(e => e.subject)));
    });
  });

  /** The story (main post: the other post) escalates; then the watch flags the Maps post. */
  const watchPlan = w => [['watch on', 1, () => { W.watchOn(w.t); w.t.control().getRange(35, 2).setValue('Auto-correct space (B10)'); }],
    ['story', 15, st(w, OTHER)]].concat(after(2), [['flag', 1, () => { w.feed.look = [golden.rows.mapsHit()]; }], ['flag2', 5], ['flag3', 5],
    ['flag4', 5, () => { w.feed.look = []; }]], after(4));
  test('one issue one email: a story that went out as a Social Alert, then the watch flags one of its other posts: the Watch alert\'s review takes the story\'s alert for an earlier alert on its post, so no second new Social Alert email; with cross_alert_notes off, two as before', () => {
    const on = run({}, watchPlan);
    eq(subjects(on), [STORY_SUBJECT], JSON.stringify(on.sent.map(e => e.subject)));
    eq(on.sent.filter(e => String(e.subject).indexOf(`Re: ${STORY_SUBJECT}`) === 0).length, 1);
    const off = run({ cross_alert_notes: false }, watchPlan);
    eq(off.fresh.length, 2, JSON.stringify(off.sent.map(e => e.subject)));
  });

  test('one issue one email: a story card that sent NO Social Alert (monitor) never makes the post\'s own card an ongoing issue: the Direct BigQuery card still sends its own new Social Alert', () => {
    const r = run({}, PLANS['story first, then the post\'s own card'], false);
    eq(subjects(r), [POST_SUBJECT], JSON.stringify(r.sent.map(e => e.subject)));
  });

  test('one issue one email: the rule itself (edSharedPostAlert_, edWithSharedPost_): only in the Auto-correct flow with cross_alert_notes on; only a row that went out as a Social Alert within the novelty window; for a post\'s own card only a story card that links the post without it being its main post; the list is numbered again', () => {
    const B = H.B;
    const now = Date.UTC(2026, 9, 14, 12, 0);
    const HOUR = 3600 * 1000;
    const KEY = 'x.com/status/2150000000000000002';
    const ac = o => ({ sourceReadOnly: true, settings: Object.assign({}, o || {}) });
    const storyRow = o => Object.assign({ alert_id: 'QA-1001', ingested: 'Early detection', record_key: 'x.com/status/2150000000000000072',
      created_at: now - HOUR, email_status: 'sent', email_thread: 'th1',
      fields: { post_url: OTHER, early_detection: { post_keys: ['x.com/status/2150000000000000072', KEY] } } }, o || {});
    const cardRow = o => Object.assign({ alert_id: 'QA-1002', ingested: 'BSIP', record_key: KEY, created_at: now - HOUR,
      email_status: 'sent', email_thread: 'th2', fields: { post_url: MAPS } }, o || {});
    const id = e => (e ? e.alert_id : null);
    // a post's own card: the story card that links it
    eq([id(B.edSharedPostAlert_(ac(), [KEY], [storyRow()], now, false)),
      id(B.edSharedPostAlert_(ac({ cross_alert_notes: false }), [KEY], [storyRow()], now, false)),
      id(B.edSharedPostAlert_({ sourceReadOnly: false, settings: {} }, [KEY], [storyRow()], now, false)),
      id(B.edSharedPostAlert_(Object.assign(ac(), { outboundBlocked: true }), [KEY], [storyRow()], now, false)),
      id(B.edSharedPostAlert_(Object.assign(ac(), { otherSpace: true }), [KEY], [storyRow()], now, false)),
      id(B.edSharedPostAlert_(ac(), [KEY], [storyRow({ email_status: '' })], now, false)),
      id(B.edSharedPostAlert_(ac(), [KEY], [storyRow({ created_at: now - 30 * 24 * HOUR })], now, false)),
      id(B.edSharedPostAlert_(ac(), [KEY], [storyRow({ record_key: KEY })], now, false)),
      id(B.edSharedPostAlert_(ac(), [KEY], [storyRow({ ingested: 'BSIP' })], now, false)),
      id(B.edSharedPostAlert_(ac(), ['x.com/status/1'], [storyRow()], now, false))],
    ['QA-1001', null, null, null, null, null, null, null, null, null]);
    // a story: any row on one of its posts that went out as a Social Alert, the newest
    eq([id(B.edSharedPostAlert_(ac(), [KEY, 'x.com/status/1'], [cardRow({ alert_id: 'QA-1003', created_at: now - 2 * HOUR }), cardRow()], now, true)),
      id(B.edSharedPostAlert_(ac(), [KEY], [cardRow({ email_status: 'discarded' })], now, true)),
      id(B.edSharedPostAlert_(ac({ cross_alert_notes: false }), [KEY], [cardRow()], now, true))],
    ['QA-1002', null, null]);
    const e = B.edSharedPostAlert_(ac(), [KEY], [storyRow()], now, false);
    eq([e.same_post, e.outcome, e.url, e.row.alert_id], [true, 'alerted', OTHER, 'QA-1001']);
    // the list of a post's own card: put first and numbered again, unless the post already has its Social Alert there
    const earlier = [{ n: 1, alert_id: 'QA-0900', same_post: false, outcome: 'alerted' }];
    eq(B.edWithSharedPost_(ac(), earlier, KEY, [storyRow()], now).map(x => [x.n, x.alert_id]), [[1, 'QA-1001'], [2, 'QA-0900']]);
    const had = [{ n: 1, alert_id: 'QA-0800', same_post: true, outcome: 'alerted' }];
    assert.strictEqual(B.edWithSharedPost_(ac(), had, KEY, [storyRow()], now), had);
    const plainList = [{ n: 1, alert_id: 'QA-0900' }];
    assert.strictEqual(B.edWithSharedPost_(ac({ cross_alert_notes: false }), plainList, KEY, [storyRow()], now), plainList);
    assert.strictEqual(B.edWithSharedPost_({ sourceReadOnly: false, settings: {} }, plainList, KEY, [storyRow()], now), plainList);
  });
};
