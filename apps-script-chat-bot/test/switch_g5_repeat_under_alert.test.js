// A story that repeats an alert is shown under that alert (EarlyDetectionCross.gs edRepeatOf_ / edRepeatNote_; the
// Auto-correct flow only, setting cross_alert_notes).
//
// The Maps post (a P0 exposure tag, 2,400 engagements) gets a Direct BigQuery card, which goes out as a Social Alert.
// Then a story whose main post is ANOTHER post (a small account's) and that also links the Maps post is reviewed, and
// Gemini wants to escalate it. One issue, one email: the story is a repeat of the Maps post's alert, so it gets no card
// and no email. Before this change it then ended "Seen before, nothing new" and nothing in the space said that small
// accounts now tell the same story. Now one note goes under the Direct BigQuery card (the note a story whose main post
// is alerted gets, under the same key family, through the one helper and its caps), and the story ends "Added under
// another alert's card", counted on C19 in "under another alert". When the note can't be posted (the card already has
// its 3 notes) the ending stays what it was. With cross_alert_notes off, and in the Mirror flow, nothing changes.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const W = golden.world;
  const MAPS = golden.posts.MAPS;
  const AC = golden.spaces.AC;
  const OTHER = 'https://x.com/commuter_k/status/2150000000000000072';
  const UNDER = 'Added under another alert\'s card';
  const REPEAT = 'Seen before, nothing new';
  const NOTE = '🔗 *Part of a story:*';
  const rep = (url, author, followers, eng, snippet) => ({ platform: 'X', author_handle: author, followers, engagement_total: eng,
    published_at: '2026-10-14 11:55 UTC', url, snippet });
  /** A story whose main post is the other post; it links the Maps post and one more. */
  const story = (n, at) => golden.rows.story({ alert_id: `ED-CLU-clu_maps_bridge-${at || '202610141200'}`,
    cluster_id: 'clu_maps_bridge', signal_key: 'clu_maps_bridge', unique_low_tier_authors: n || 6, mention_count: (n || 6) + 1,
    headline: `Low-tier claim cluster (${n || 6} accounts): Google Maps sends drivers onto a closed bridge`, topic_product: 'Google Maps',
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
  const props = t => t.g.services.PropertiesService.getScriptProperties();

  /**
   * The one-space setup three checks in; then the Maps post's Direct BigQuery card (it goes out as a Social Alert), then
   * the story (`plan` may change things before the story's run: plan.beforeStory(w)). -> {w, recs (every record row of
   * the runs), sent (the Social Alert emails), card (the Direct BigQuery card's Alert-log row), notes (the story notes
   * under it), cards (story cards)}, with the day's numbers checked after every run.
   */
  const run = (overrides, plan) => {
    const p = plan || {};
    const w = (p.world || W.oneSpaceWorld)(overrides);
    w.t.g.vertex.earlyDetection = review;
    const recs = [];
    const step = (label, min, fn) => {
      w.rec.step(label, min, fn);
      w.t.bot.edNotesOfRun_().forEach(r => recs.push(w.t.bot.edNoteObj_(r)));
      const n = w.t.bot.edDayNumbers_(props(w.t));
      eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `after "${label}": ${JSON.stringify(n)}`);
    };
    if (!p.world) {
      w.rec.collect('setup');
      step('first', 1);
      step('chk', 5);
      step('chk', 5);
    }
    step('bq', 5, () => { w.feed.bsip = [golden.rows.mapsRow()]; });
    after(3).forEach(([l, m]) => step(l, m));
    if (p.beforeStory) p.beforeStory(w);
    step('story', 15, () => { w.feed.stories = [story()]; });
    after(6).forEach(([l, m]) => step(l, m));
    if (p.again) p.again(w, step);
    const out = w.rec.out();
    const sent = out.emails.filter(e => e.kind === 'sent' && /SOCIAL ALERT/.test(String(e.subject)));
    const all = w.t.bot.sheetBackend_(w.t.sheet()).loadAlerts();
    const card = all.find(a => a.ingested === 'BSIP');
    const space = w.t.chat.spaces.get(p.space || AC);
    const thread = card && (card.forward_thread || card.source_thread);
    const notes = space.messages.filter(m => m.threadReply && m.thread.name === thread && String(m.text).indexOf(NOTE) === 0 &&
      /closed bridge/.test(String(m.text)));
    return { w, out, recs, sent, card, notes, cards: all.filter(a => a.ingested === 'Early detection'), mine: recs.filter(r => /clu_maps_bridge/.test(r.id)) };
  };

  test('story under its alert: a Direct BigQuery card that went out as a Social Alert, then a story that links its post and that Gemini wants to escalate: no story card, no second email, exactly one note under the Direct BigQuery card, the record says "Added under another alert\'s card" pointing at that card, and C19 counts it under another alert', () => {
    const r = run({});
    eq(r.cards.length, 0);
    eq(r.sent.filter(e => !/^Re:/i.test(String(e.subject))).length, 1, JSON.stringify(r.sent.map(e => e.subject)));
    eq(r.sent.length, 1, JSON.stringify(r.sent.map(e => e.subject)));
    eq(r.notes.length, 1, JSON.stringify(r.notes.map(m => m.text)));
    eq(r.notes[0].text.split(' now tell it: ')[0], `${NOTE} 6 small accounts on X and Reddit`);
    assert.ok(r.notes[0].text.indexOf(`<${MAPS}|@roadwatcher>`) > 0, r.notes[0].text);
    eq(r.notes[0].clientAssignedMessageId.indexOf('client-bqa-'), 0);  // the bot's own message: it never answers it
    eq(r.mine.map(x => x.outcome), [UNDER]);
    const rec = r.mine[0];
    eq([rec.card, rec.message], [r.card.alert_id, r.card.forward_message]);
    // (the row is made to fit its 448 characters: with this story's long title the reason's last words give way)
    assert.match(rec.why, new RegExp(`^One of its posts already had a Social Alert, ${r.card.alert_id} \\(BigQuery · BSIP, [^)]+\\), and the story was added`));
    const n = r.w.t.bot.edDayNumbers_(props(r.w.t));
    eq([n.under, n.cards], [1, 0]);
    assert.match(String(r.w.sh.cell(19, 3)), /1 under another alert/);
    // the tab has the row
    const tab = r.w.t.sheet().getSheetByName('Early Detection');
    assert.ok(tab && tab.rows.some(row => row[1] === UNDER && String(row[9]).indexOf('clu_maps_bridge') >= 0),
      JSON.stringify(tab && tab.rows.slice(4).map(row => [row[1], row[9]])));
  });

  test('story under its alert: nothing but the note changes: the same timeline with the note left out (as when it can\'t be posted) puts out the very same messages, emails and outbox rows, and the story then ends "Seen before, nothing new"', () => {
    const on = run({});
    const without = run({}, { world: o => {
      const w = W.oneSpaceWorld(o);
      w.t.bot.ev('edRepeatNote_ = function () { return null; }');
      w.rec.collect('setup');
      ['first', 'chk', 'chk'].forEach((l, i) => w.rec.step(l, i ? 5 : 1));
      return w;
    } });
    eq(without.notes.length, 0);
    eq(without.mine.map(x => x.outcome), [REPEAT]);
    const lessNote = out => Object.assign({}, out, { chat: out.chat.filter(m => !(m.reply && String(m.text).indexOf(NOTE) === 0 && /closed bridge/.test(m.text))) });
    eq(golden.differences(lessNote(on.out), without.out), []);
  });

  test('story under its alert: with cross_alert_notes off, the same timeline posts no note and no story is recorded "Added under another alert\'s card" (the story escalates on its own, as before)', () => {
    const off = run({ cross_alert_notes: false });
    eq(off.notes.length, 0);
    assert.ok(off.mine.length > 0 && off.mine.every(x => x.outcome !== UNDER), JSON.stringify(off.mine));
    eq(off.cards.length, 1);
  });

  test('story under its alert: in the Mirror flow the same timeline posts no story note and no story is recorded "Added under another alert\'s card"', () => {
    const r = run({}, { world: o => W.mirrorWorld(o), space: golden.spaces.MIRROR });
    assert.ok(r.card, 'the Direct BigQuery card of the Mirror flow');
    eq(r.notes.length, 0);
    const anyNote = r.out.chat.filter(m => String(m.text).indexOf(NOTE) === 0 && /closed bridge/.test(m.text));
    eq(anyNote, []);
    assert.ok(r.mine.length > 0 && r.mine.every(x => x.outcome !== UNDER), JSON.stringify(r.mine));
  });

  test('story under its alert: the story again with fewer than twice the accounts adds no note; with twice the accounts and 3 more (14), a second note under the same card; still one Social Alert email', () => {
    const r = run({}, {
      again: (w, step) => {
        step('story 9', 15, () => { w.feed.stories = [story(9, '202610141230')]; });
        after(4).forEach(([l, m]) => step(`${l} 9`, m));
        step('story 14', 15, () => { w.feed.stories = [story(14, '202610141245')]; });
        after(6).forEach(([l, m]) => step(`${l} 14`, m));
      },
    });
    eq(r.notes.map(m => m.text.split(' now tell it: ')[0]), [`${NOTE} 6 small accounts on X and Reddit`, `${NOTE} 14 small accounts on X and Reddit`]);
    eq(r.mine.filter(x => x.outcome === UNDER).length, 2, JSON.stringify(r.mine.map(x => [x.id, x.outcome])));
    eq([r.cards.length, r.sent.length], [0, 1]);
  });

  test('story under its alert: the rule itself (edRepeatOf_, edRepeatNote_): which earlier alert a repeat is of (the shared post\'s, the follow-up\'s, the known issue\'s, the memory\'s), only in the Auto-correct flow with cross_alert_notes on; a note only under a card in this flow\'s Alert log that is no story card and went out as a Social Alert', () => {
    const B = H.B;
    const ac = o => ({ sourceReadOnly: true, settings: Object.assign({}, o || {}) });
    const esc = { priority: 'P2', engagement_total: 10, sensitive_topics: [] };
    const fu = o => ({ fields: {}, followUp: { by: 'same_post', original: Object.assign({ alert_id: 'QA-0701', outcome: 'alerted', same_post: true,
      exposure_tag: 'Product - Other/general criticism', engagement: 10 }, o || {}) } });
    const ki = { fields: { total_engagement: 10 }, knownIssue: { matches: true, adds_new: false, confidence: 0.95, issue_name: 'Bridge routing',
      entry: { alert_id: 'QA-0702' } } };
    const brief = x => (x ? [x.id, x.alerted, x.by] : null);
    eq(brief(B.edRepeatOf_(ac(), fu(), esc, null)), ['QA-0701', true, 'post']);
    eq(brief(B.edRepeatOf_(ac(), fu(), esc, { alert_id: 'QA-0700', outcome: 'alerted', row: { alert_id: 'QA-0700' } })), ['QA-0700', true, 'post']);
    eq(brief(B.edRepeatOf_(ac(), ki, esc, null)), ['QA-0702', false, 'issue']);
    const at = Date.UTC(2026, 9, 14, 12, 0);
    const mem = { fields: {}, memory: { on: true, at, fields: {}, post: { e: { id: 'QA-0703', at: at - 60 * 1000 } } } };
    eq(brief(B.edRepeatOf_(ac(), mem, esc, null)), ['QA-0703', false, 'post']);
    eq([B.edRepeatOf_(ac({ cross_alert_notes: false }), fu(), esc, null),
      B.edRepeatOf_({ sourceReadOnly: false, settings: {} }, fu(), esc, null),
      B.edRepeatOf_(Object.assign(ac(), { otherSpace: true }), fu(), esc, null),
      B.edRepeatOf_(ac(), fu({ alert_id: '' }), esc, null),  // an alert of the SLRR log: no card of the bot's
      B.edRepeatOf_(ac(), { fields: {} }, esc, null)], [null, null, null, null, null]);

    // edRepeatNote_ refuses before it asks the helper: no row, a story card, one that did not go out, another flow
    const now = Date.UTC(2026, 9, 14, 12, 0);
    const SPACE = 'spaces/AAQAonespace01';
    const row = o => Object.assign({ alert_id: 'QA-0701', ingested: 'BSIP', created_at: now - 3600 * 1000, email_status: 'sent',
      forward_message: `${SPACE}/messages/m1`, forward_thread: `${SPACE}/threads/t1` }, o || {});
    let asked = 0;
    B.ev('var g5Helper_ = acThreadNote_');
    B.ev('acThreadNote_ = function () { g5Asked_ = (typeof g5Asked_ === "number" ? g5Asked_ : 0) + 1; return false; }');
    try {
      const ctxOf = (alerts, o) => Object.assign(ac(o), { store: { alerts } });
      const sig = { alert_id: 'ED-CLU-x-1', unique_low_tier_authors: 6, primary_url: OTHER };
      const of = o => Object.assign({ id: 'QA-0701', alerted: false, by: 'post' }, o || {});
      eq([B.edRepeatNote_(ctxOf([]), sig, of(), now),
        B.edRepeatNote_(ctxOf([row({ ingested: 'Early detection' })]), sig, of(), now),
        B.edRepeatNote_(ctxOf([row({ email_status: 'discarded' })]), sig, of(), now),
        B.edRepeatNote_(ctxOf([row({ forward_thread: '' })]), sig, of(), now),
        B.edRepeatNote_(ctxOf([row()], { cross_alert_notes: false }), sig, of(), now),
        // a pace jump on a topic or on risk words: its posts are only a sample, so no note (as edCrossOf_ gives it none)
        B.edRepeatNote_(ctxOf([row()]), Object.assign({}, sig, { signal_type: 'VELOCITY_SPIKE', velocity_grain: 'PRIORITY_TOPIC' }), of(), now)],
      [null, null, null, null, null, null]);
      asked = B.ev('typeof g5Asked_ === "number" ? g5Asked_ : 0');
      eq(asked, 0);
      // a card that went out: the helper is asked (and its refusal leaves the story as it was)
      eq(B.edRepeatNote_(ctxOf([row()]), sig, of(), now), null);
      eq(B.ev('g5Asked_'), 1);
    } finally {
      B.ev('acThreadNote_ = g5Helper_');
    }
  });

  test('story under its alert: the card already holding its 3 notes: no note, the story ends as before ("Seen before, nothing new"), nothing thrown', () => {
    const r = run({}, {
      beforeStory: w => {
        // three notes of the bot's own already in the Direct BigQuery card's thread, and the helper's counts knowing them
        const card = w.t.bot.sheetBackend_(w.t.sheet()).loadAlerts().find(a => a.ingested === 'BSIP');
        ['one', 'two', 'three'].forEach(k => {
          w.t.chat._add(AC, { text: `${NOTE} 3 small accounts on X now tell it: “filler ${k}”`, sender: { name: w.t.chat.botUser, type: 'BOT' },
            viaApi: true, thread: card.forward_thread, threadReply: true, clientId: `client-bqa-acnote:filler-${k}` });
        });
        const now = w.t.g.clock.now;
        const state = w.t.bot.acNoteState_(now);
        state.c[w.t.bot.hashText_(card.forward_thread)] = [3, now];
        w.t.bot.acNoteSave_(state);
      },
    });
    eq(r.notes.length, 0);
    eq(r.mine.map(x => x.outcome), [REPEAT]);
    eq(r.cards.length, 0);
    eq(r.sent.length, 1);
  });

  test('story under its alert: the same story reviewed a second time at the same size adds no second note', () => {
    const r = run({}, {
      again: (w, step) => {
        // the story's mark and its id come out of the seen map (all of it: the story keys, the older ones and the
        // signals' own ids each have a property), so the very same signal is queued and reviewed again
        ['EARLY_DETECTION_SEEN', 'EARLY_DETECTION_SEEN_2', 'EARLY_DETECTION_SEEN_IDS'].forEach(k => props(w.t).deleteProperty(k));
        step('story again', 15, () => { w.feed.stories = [story()]; });
        after(6).forEach(([l, m]) => step(`${l} again`, m));
      },
    });
    const reviews = (r.w.t.g.vertex.calls || []).filter(c => {
      const p = (((c.payload || {}).generationConfig || {}).responseSchema || {}).properties || {};
      return !!p.early_detection_call;
    }).length;
    assert.ok(reviews >= 2, `reviews: ${reviews}`);
    eq(r.notes.length, 1, JSON.stringify(r.notes.map(m => m.text)));
    eq(r.sent.length, 1);
  });
};
