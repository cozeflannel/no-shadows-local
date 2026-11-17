// A Direct BigQuery card whose post is in a story's card says so, in its thread (BigQuery.gs bqStoryNotes_,
// bqStoryNoteText_; setting cross_alert_notes, default on; the Auto-correct flow only):
//   🔗 *Part of a story:* 6 small accounts on X and Reddit tell it (story card)        "story card" links that card
// Where stories go first (the one-space setup with early_detection_first on) a story's card that sent no Social Alert no
// longer stops the Direct BigQuery card of the story's main post, so the post has two cards: this note is what ties them
// together. It is also posted for a post the story's card links that is not its main post. The poll looks the post up
// among the Early Detection cards of the last 24 hours (EarlyDetection.gs edLedger_, by the post's record key), once
// every card of the check is posted and only with 45 seconds of the flow left; the note goes through the one helper
// (ThreadNotes.gs acThreadNote_). A card that went without its note at its own check (the flow was short of time, or
// the note could not be posted) gets it at a later check of its first hour (bqStoryNotesLate_), with nothing new kept
// for that: only a card that was posted when the story's card was already there, only once, and only at a check that
// reads the Alert log anyway. With the setting off, in the Mirror flow and in every flow that is not the Auto-correct
// flow, nothing is posted and nothing else changes.
//
// Every scenario here turns the fix plan's other settings off (golden.SETTINGS_OFF), so what a later change does by
// default never moves these tests.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, REAL, leakDenied } = H;
  const golden = require('./golden_flows')(H);
  const W = golden.world;
  const { AC, MIRROR } = golden.spaces;
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const TESTER = 'tester@testing.test';
  const NOTES = Object.assign({}, golden.SETTINGS_OFF, { cross_alert_notes: true });  // the notes alone
  const FIRST = Object.assign({}, NOTES, { early_detection_first: true });            // ...where stories go first
  const FIRST_NO_NOTES = Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true });
  const OFF = golden.SETTINGS_OFF;

  // -----------------------------------------------------------------------------------------------------------
  // A story on the Maps post, and what Direct BigQuery reads
  // -----------------------------------------------------------------------------------------------------------

  const MAPS = golden.posts.MAPS;  // the story's main post; Direct BigQuery finds it with a P0 exposure tag (a Social Alert)
  const OTHER = 'https://x.com/commuter_k/status/2150000000000000072';  // a post the story's card links that is not its main post
  const rep = (url, author, followers, eng, snippet) => ({ platform: 'X', author_handle: author, followers, engagement_total: eng,
    published_at: '2026-10-14 11:55 UTC', url, snippet });
  /** A story whose main post is the Maps post: 6 small accounts on X and Reddit (`o`: what a later signal on it has). */
  const mapsStory = o => golden.rows.story(Object.assign({ alert_id: 'ED-CLU-clu_maps_bridge-202610141200', cluster_id: 'clu_maps_bridge',
    signal_key: 'clu_maps_bridge', headline: 'Low-tier claim cluster (6 accounts): Google Maps sends drivers onto a closed bridge',
    topic_product: 'Google Maps', primary_url: MAPS,
    representative_posts_json: JSON.stringify([
      rep(MAPS, 'roadwatcher', 41000, 2400, 'Google Maps keeps sending drivers onto a closed bridge.'),
      rep(OTHER, 'commuter_k', 900, 31, 'Same here: Maps routed me onto the closed bridge this morning.'),
      rep('https://x.com/bridge_local/status/2150000000000000073', 'bridge_local', 700, 27, 'Maps still shows the closed bridge as open.')]) }, o || {}));
  /** Gemini's review of it: a build-up worth monitoring (no Social Alert of its own). */
  const mapsReview = () => ({
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
    web_context: '', next_steps: ['Keep monitoring for volume growth and re-check in 2 hours.'], driver_post: 'P1',
  });
  /** BSIP's row for the other post of the story: an issue name of its own, a P2 tag and 640 engagements (no Social Alert). */
  const otherRow = () => golden.rows.bsipRow({ id: '2150000000000000072', url: OTHER, handle: 'commuter_k',
    alert_names_json: '["Google Maps - Accuracy"]', tags: 'Maps routing | Product - Other/general criticism', followers: 900, total: 640,
    summary: 'An X user says Google Maps routed them onto a closed bridge this morning.',
    issue_name: 'Commuter complaint about a Google Maps detour', post_time: '2026-10-14 11:58:00+00' });

  // -----------------------------------------------------------------------------------------------------------
  // The worlds
  // -----------------------------------------------------------------------------------------------------------

  /**
   * Chat names a message spaces/S/messages/T.M (its thread's id, a dot, its own id), and a link to a message is made
   * from that name (Voice.gs originalAlertLink_). The harness's Chat names its messages m12, which gives no link. This
   * makes a world's Chat name them as Chat does (the thread t12 and the message m12 become "t12.m12").
   */
  const realNames = t => {
    const add = t.chat._add.bind(t.chat);
    t.chat._add = (spaceId, o) => {
      const m = add(spaceId, o);
      m.name = `${spaceId}/messages/${m.thread.name.split('/threads/')[1]}.${m.name.split('/messages/')[1]}`;
      return m;
    };
    return t;
  };
  /** The link Chat opens a message by, from the message itself: its space, its thread and its own id. */
  const linkTo = m => {
    const [space, thread] = m.thread.name.split('/threads/');
    return `https://chat.google.com/room/${space.replace(/^spaces\//, '')}/${thread}/${m.name.split('.').pop()}`;
  };

  /**
   * A world's Direct BigQuery check with a cost in run time (w.cost.poll: its BSIP read; 0 until a test says), what the
   * story notes were given at each check (w.noteCalls: [time of the flow left (ms), hasTime, cards]), and how many
   * requests went to BigQuery (w.bigquery.n).
   */
  const timed = w => {
    const { t } = w;
    const cost = { poll: 0 };
    const bigquery = { n: 0 };
    const fetch = t.g.services.UrlFetchApp.fetch;
    t.g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      if (url.startsWith('https://bigquery.googleapis.com/')) bigquery.n++;
      if (url.startsWith('https://bigquery.googleapis.com/') && /\/queries$/.test(url) &&
          /"BSIP" AS source_kind/.test(String(JSON.parse(params.payload).query || ''))) t.g.clock.now += cost.poll;
      return fetch(link, params);
    };
    t.bot.__noteCalls = [];
    t.bot.ev('bqStoryNotes_ = (orig => function (ctx, cards, now, hasTime) { ' +
      '__noteCalls.push([ctx && ctx.deadline ? ctx.deadline - ctx.now() : null, hasTime, (cards || []).length]); ' +
      'return orig(ctx, cards, now, hasTime); })(bqStoryNotes_)');
    return Object.assign(w, { cost, bigquery, noteCalls: t.bot.__noteCalls });
  };

  /** A world three Direct BigQuery checks in, 5 minutes apart (the next check is due 5 minutes on, and not overdue). */
  const started = w => {
    w.t.g.vertex.earlyDetection = mapsReview;
    w.rec.collect('setup');
    w.rec.step('the first run', 1);
    w.rec.step('a check', 5);
    w.rec.step('a check', 5);
    return w;
  };
  /** The one-space setup, started, its Chat naming messages as Chat does. */
  const oneSpace = overrides => {
    const w = W.oneSpaceWorld(overrides);
    realNames(w.t);
    return started(timed(w));
  };

  /** What a message the bot posted is. */
  const kind = m => (!m.threadReply && /\*\[BigQuery · BSIP\]\*/.test(m.text) ? 'Direct BigQuery card'
    : !m.threadReply && m.text.indexOf('🚨 *EARLY DETECTION*') === 0 ? 'story card'
      : m.threadReply && m.text.indexOf('📈 *UPDATE*') === 0 ? 'story update'
        : m.threadReply && m.text.indexOf('🤖 *Early Detection Review') === 0 ? 'story review note'
          : m.threadReply && m.text.indexOf('The agentic assistant reviewed this alert') === 0 ? 'card review note'
            : m.threadReply && /Part of a story/.test(m.text) ? 'story note' : 'another post');
  /** The bot's posts in a space, in the order it made them. */
  const botPosts = (t, space) => t.chat.spaces.get(space).messages.filter(m => m.viaApi);
  const kinds = (t, space, from) => botPosts(t, space).slice(from || 0).map(kind);
  /** The bot's posts in every other space than `space`, since setup: there must be none. */
  const elsewhere = (t, space, known) => {
    const out = [];
    t.chat.spaces.forEach((s, id) => { if (id !== space) s.messages.forEach(m => { if (m.viaApi && !known.has(m.name)) out.push([id, m.text.slice(0, 60)]); }); });
    return out;
  };
  const everyPost = t => { const all = new Set(); t.chat.spaces.forEach(s => s.messages.forEach(m => { if (m.viaApi) all.add(m.name); })); return all; };
  const cardOf = (t, space, url) => botPosts(t, space).find(m => kind(m) === 'Direct BigQuery card' && m.text.includes(`[Link]: ${url}`));
  const under = (t, card) => botPosts(t, card.name.split('/messages/')[0]).filter(m => m.threadReply && m.thread.name === card.thread.name);
  const alertRows = t => t.bot.sheetBackend_(t.sheet()).loadAlerts();
  const c15 = t => String(t.control().cell(15, 3));
  const said = t => t.g.logs.filter(l => /^BigQuery direct poll: (?:a note is|no note) under the new card of /.test(l));
  const saidLate = t => t.g.logs.filter(l => /^BigQuery direct poll: a note is under the card of /.test(l));  // a note added at a later check
  const noteLogs = t => t.g.logs.filter(l => /^thread note not posted/.test(l));
  const storyNotes = t => botPosts(t, AC).filter(m => kind(m) === 'story note');
  const mails = t => t.g.gmail.sentMessages().map(m => [m.to, m.subject.split(' | ')[0]]);
  const ALERT = [[TESTER], '[Auto-correct test] 🟥SOCIAL ALERT🟥: Google Maps'];  // the Maps post's own Social Alert

  // -----------------------------------------------------------------------------------------------------------
  // The note's words
  // -----------------------------------------------------------------------------------------------------------

  test('story notes: the note\'s words (bqStoryNoteText_): "🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (story card)", with the accounts and the platforms the story\'s card had and a link that opens that card; one account "tells it"; a card with no count says "small accounts", one with no platform leaves the place out; a platform\'s name can\'t break the link; a card whose message name gives no link is named by its Alert-log id. Every form is one of the registered notes: the bot knows it as its own, the wider guard holds it on any way to S-F Burson, and the leak audit denies it', () => {
    const CARD = 'spaces/AAQAonespace01/messages/Xk2b9zQ1.Xk2b9zQ1';   // a story's card, as Chat names it
    const UPDATE = 'spaces/AAQAonespace01/messages/Xk2b9zQ1.Pq7c3wR5';  // an update in that card's thread
    const text = o => B.bqStoryNoteText_(Object.assign({ row: 'QA-1002', au: 5, plats: ['X', 'Reddit'], msg: CARD }, o));
    const LINK = '<https://chat.google.com/room/AAQAonespace01/Xk2b9zQ1/Xk2b9zQ1|story card>';
    eq(text({}), `🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (${LINK})`);
    eq([text({ au: 1, plats: ['X'] }), text({ au: 2400, plats: ['X', 'Reddit', 'Threads'] }), text({ au: 0 }), text({ au: undefined, plats: [] }),
      text({ plats: undefined }), text({ msg: UPDATE })],
    [`🔗 *Part of a story:* 1 small account on X tells it (${LINK})`,
      `🔗 *Part of a story:* 2,400 small accounts on X, Reddit and Threads tell it (${LINK})`,
      `🔗 *Part of a story:* small accounts on X and Reddit tell it (${LINK})`,
      `🔗 *Part of a story:* small accounts tell it (${LINK})`,
      `🔗 *Part of a story:* 5 small accounts tell it (${LINK})`,
      '🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (<https://chat.google.com/room/AAQAonespace01/Xk2b9zQ1/Pq7c3wR5|story card>)']);
    // a platform's name is the feed's: the marks Chat reads as a link or as bold are taken out of it
    eq(text({ plats: ['X', 'Red|dit>', '*Threads*', '<https://evil.example|TikTok', '  '] }),
      `🔗 *Part of a story:* 5 small accounts on X, Red dit, Threads and https://evil.example TikTok tell it (${LINK})`);
    // no link from the card's message name (the harness's Chat names a message m12): its Alert-log id says which card
    eq([text({ msg: 'spaces/AAQAonespace01/messages/m12' }), text({ msg: '', row: '' }), text({ msg: undefined, row: undefined }),
      B.bqStoryNoteText_(null), B.bqStoryNoteText_({})],
    ['🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (story card QA-1002)',
      '🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (story card)',
      '🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (story card)',
      '🔗 *Part of a story:* small accounts tell it (story card)', '🔗 *Part of a story:* small accounts tell it (story card)']);
    // each is a note the helper posts and the bot knows as its own; none can go to S-F Burson
    const own = t => B.isOwnMessage_({ botUser: 'users/bot', store: { isOwnPost: () => false } }, { senderName: 'users/bot', text: t });
    [text({}), text({ au: 1, plats: ['X'] }), text({ au: 0, plats: [] }), text({ msg: 'spaces/AAQAonespace01/messages/m12' })].forEach(t => {
      eq([B.isThreadNoteText_(t), own(t), B.outboxGuardHits_(t, { terms: [] }).length > 0, leakDenied(t), t.length < 300], [true, true, true, true, true], t);
    });
    eq(B.ev('BQ_STORY_NOTE_LEFT_MS_'), 45 * SEC);
  });

  // -----------------------------------------------------------------------------------------------------------
  // The story's card first, then the post's own card, then the note
  // -----------------------------------------------------------------------------------------------------------

  /**
   * In a started one-space world: the story on the Maps post is found `storyFirstBy` minutes before Direct BigQuery
   * finds `row`'s post (0: in the same run), then the flow runs on until everything is worked (the card's review, and
   * two more Direct BigQuery checks). What came of it.
   */
  const storyThenPost = (w, row, storyFirstBy) => {
    const { t, rec, feed } = w;
    const setupPosts = everyPost(t);
    if (storyFirstBy) rec.step('the story is found', storyFirstBy, () => { feed.stories = [mapsStory()]; });
    const before = botPosts(t, AC).length;
    rec.step('Direct BigQuery finds the post', 5, () => { feed.bsip = [row]; feed.stories = [mapsStory()]; });
    const found = botPosts(t, AC).length;
    [1, 1, 1, 5, 1, 5, 1].forEach(minutes => rec.step('after', minutes));
    const story = botPosts(t, AC).find(m => kind(m) === 'story card');
    const card = cardOf(t, AC, row.url);
    return { story, card, atCheck: kinds(t, AC).slice(before, found), after: kinds(t, AC, found), notes: card ? under(t, card) : [],
      elsewhere: elsewhere(t, AC, setupPosts) };
  };

  test('story notes: where stories go first, a post a story gets to first has two cards, the story\'s and its own, and one note under its own card ties them together: "🔗 *Part of a story:* 6 small accounts on X and Reddit tell it (story card)", where "story card" is a link that opens the story\'s card. Found in one run (the story card and its review note, then the post\'s card, then the note) and with the story a check ahead. The note is the bot\'s own message in the card\'s thread, posted once; the bot never answers it; the card\'s review and its Social Alert come a run later, as before', () => {
    [0, 5].forEach(storyFirstBy => {
      const w = oneSpace(FIRST);
      const { t } = w;
      const got = storyThenPost(w, golden.rows.mapsRow(), storyFirstBy);
      const name = `the story ${storyFirstBy} minutes ahead`;
      eq([name, got.atCheck], [name, (storyFirstBy ? [] : ['story card', 'story review note']).concat(['Direct BigQuery card', 'story note'])]);
      // the note: under the post's own card, with a link made from the story card's own space, thread and message
      const [note] = got.notes;
      const LINK = linkTo(got.story);
      assert.match(LINK, /^https:\/\/chat\.google\.com\/room\/AAQAonespace01\/t\d+\/m\d+$/);
      eq(note.text, `🔗 *Part of a story:* 6 small accounts on X and Reddit tell it (<${LINK}|story card>)`);
      eq([note.thread.name, note.threadReply, note.thread.name !== got.story.thread.name, /^client-bqa-[0-9a-f]{40}$/.test(note.clientAssignedMessageId)],
        [got.card.thread.name, true, true, true]);
      // both cards are on the one post, the story's first
      eq(botPosts(t, AC).filter(m => !m.threadReply && m.text.includes(MAPS)).map(kind), ['story card', 'Direct BigQuery card']);
      // afterwards: the card's review note under the same card, nothing more (no second note, no answer to the note), the
      // post's own Social Alert to the tester, and nothing in any other space
      eq([got.after, got.notes.map(kind), mails(t), got.elsewhere], [['card review note'], ['story note', 'card review note'], [ALERT], []]);
      eq(alertRows(t).filter(r => r.record_key === t.bot.recordKey_({ post_url: MAPS })).map(r => [r.ingested, r.email_status || '']).sort(),
        [['BSIP', 'sent'], ['Early detection', '']]);
      const storyId = alertRows(t).find(r => r.ingested === 'Early detection').alert_id;
      eq([said(t), noteLogs(t)], [[`BigQuery direct poll: a note is under the new card of ${MAPS}, whose post is in a story's card (${storyId})`], []]);
      assert.ok(/ · 1 post today \(1 for a Social Alert, 0 monitoring only\) /.test(c15(t)), c15(t));
      // the poll asked for the notes at each check, with the time the flow had left; only that one check had a new card
      eq([w.noteCalls.every(c => c[0] > 45 * SEC && c[1] === true), w.noteCalls.filter(c => c[2] > 0).length], [true, 1]);
    });
  });

  test('story notes: a post the story\'s card links that is not its main post gets the note too, whether or not stories go first (such a post was never taken for already alerted): its Direct BigQuery card, then the note with the link to the story\'s card. A card posted before the story\'s card exists (the poll first, the story in the same run) gets none from the poll', () => {
    [['stories first', FIRST], ['the poll first', NOTES]].forEach(([name, overrides]) => {
      const w = oneSpace(overrides);
      const { t } = w;
      const got = storyThenPost(w, otherRow(), 5);
      // (its review, a run later, changes nothing on the card and sends no Social Alert: no review note, no email)
      eq([name, got.atCheck, got.notes.map(kind), got.after, mails(t), got.elsewhere],
        [name, ['Direct BigQuery card', 'story note'], ['story note'], [], [], []]);
      eq(alertRows(t).map(r => [r.ingested, r.email_status || '']), [['Early detection', ''], ['BSIP', '']]);
      eq(got.notes[0].text, `🔗 *Part of a story:* 6 small accounts on X and Reddit tell it (<${linkTo(got.story)}|story card>)`);
      eq(said(t).length, 1);
      // the story's main post has no card of its own here: only the story's
      eq(botPosts(t, AC).filter(m => !m.threadReply).map(kind), ['story card', 'Direct BigQuery card']);
    });
    // the poll first, and the story found in the same run: the card is posted before the story's card
    const w = oneSpace(NOTES);
    const got = storyThenPost(w, otherRow(), 0);
    eq([got.atCheck, got.notes.map(kind), got.after, said(w.t)], [['Direct BigQuery card', 'story card', 'story review note'], [], [], []]);

    // Two posts of the story in one check (where stories go first: its main post and the other one): two cards, and each
    // gets its own note, under its own card, with the same link
    const two = oneSpace(FIRST);
    two.rec.step('the story is found', 5, () => { two.feed.stories = [mapsStory()]; });
    two.rec.step('Direct BigQuery finds both posts', 5, () => { two.feed.bsip = [golden.rows.mapsRow(), otherRow()]; });
    const story = botPosts(two.t, AC)[0];
    const NOTE = `🔗 *Part of a story:* 6 small accounts on X and Reddit tell it (<${linkTo(story)}|story card>)`;
    eq([kinds(two.t, AC, 2), [MAPS, OTHER].map(url => under(two.t, cardOf(two.t, AC, url)).map(m => m.text))],
      [['Direct BigQuery card', 'Direct BigQuery card', 'story note', 'story note'], [[NOTE], [NOTE]]]);
    eq(two.noteCalls.filter(c => c[2] > 0).map(c => c[2]), [2]);  // asked once, when both cards were posted
  });

  test('story notes: the Auto-correct flow gets the note beside the main flow too (B3 = S-F Burson, B4 and B10: the Auto-correct flow hosts the story cards and the Direct BigQuery cards without working alone): a story\'s card, then the card of another post it links, then the note under that card, all in the Auto-correct space', () => {
    const t = realNames(W.start(NOTES, [[AC, W.names.AC]]));
    t.set('B3', REAL);
    t.control().getRange(10, 2).setValue(W.names.AC);
    [15, 19].forEach(r => t.control().getRange(r, 2).setValue('ON'));
    const feed = W.feedsOf(t);
    W.scriptGemini(t);
    const w = started(timed({ t, feed, rec: W.recorder(t, '') }));
    const got = storyThenPost(w, otherRow(), 5);
    eq([got.atCheck, got.notes.map(m => m.text), got.elsewhere],
      [['Direct BigQuery card', 'story note'], [`🔗 *Part of a story:* 6 small accounts on X and Reddit tell it (<${linkTo(got.story)}|story card>)`], []]);
    eq([got.story.name.indexOf(AC + '/messages/'), got.card.name.indexOf(AC + '/messages/')], [0, 0]);
  });

  test('story notes: the story card named is the newest one that has the post, an update in the story\'s thread included (the note then gives the update\'s accounts and platforms, and links the update); a story card older than 24 hours is not named: the post\'s card gets no note', () => {
    // the story grows to 13 accounts on a third platform: its update goes in the story card's thread
    const w = oneSpace(NOTES);
    const { t, rec, feed } = w;
    rec.step('the story is found', 5, () => { feed.stories = [mapsStory()]; });
    rec.step('the story grows', 15, () => {
      feed.stories = [mapsStory({ alert_id: 'ED-CLU-clu_maps_bridge-202610141230', unique_low_tier_authors: 13, mention_count: 15, platforms_csv: 'X, Reddit, Threads' })];
    });
    rec.step('after', 1);
    eq(kinds(t, AC), ['story card', 'story review note', 'story update', 'story review note']);
    rec.step('Direct BigQuery finds the other post', 5, () => { feed.bsip = [otherRow()]; });
    const update = botPosts(t, AC).find(m => kind(m) === 'story update');
    const [note] = under(t, cardOf(t, AC, OTHER));
    eq(note.text, `🔗 *Part of a story:* 13 small accounts on X, Reddit and Threads tell it (<${linkTo(update)}|story card>)`);
    eq([update.thread.name, linkTo(update) !== linkTo(botPosts(t, AC)[0])], [botPosts(t, AC)[0].thread.name, true]);

    // 23 hours after the story's card the post still gets its note; 25 hours after, none
    [[23, ['story note']], [25, []]].forEach(([hours, expected]) => {
      const x = oneSpace(NOTES);
      x.rec.step('the story is found', 5, () => { x.feed.stories = [mapsStory()]; });
      x.feed.stories = [];
      x.rec.step('Direct BigQuery finds the other post', hours * 60, () => { x.feed.bsip = [otherRow()]; });
      const card = cardOf(x.t, AC, OTHER);
      assert.ok(card, `${hours} hours on: the post has its card`);
      eq([hours, under(x.t, card).map(kind)], [hours, expected]);
    });
    eq(B.ev('EW_SEEN_MS_'), 24 * HOUR);
  });

  // -----------------------------------------------------------------------------------------------------------
  // The setting off, and the flows that are not the Auto-correct flow
  // -----------------------------------------------------------------------------------------------------------

  test('story notes: with the setting off (cross_alert_notes false) no note is posted, and everything else the one-space setup puts out is what it puts out with the setting on: the same posts but the note, the same emojis and the same email. The note costs no Gemini call, no embedding and no BigQuery request: each is asked as often with the setting on as with it off. In the golden one-space scenario and in the golden Mirror scenario the setting changes nothing of this lane (only the Watch\'s and the story lane\'s notes it also turns on)', () => {
    const run = overrides => {
      const w = oneSpace(overrides);
      storyThenPost(w, golden.rows.mapsRow(), 0);
      const t = w.t;
      const reactions = [];
      t.chat.spaces.forEach(s => s.messages.forEach(m => m.reactions.forEach(r => { if (r.user === t.chat.botUser) reactions.push([m.text.slice(0, 40), r.emoji]); })));
      return { posts: botPosts(t, AC).map(m => [m.threadReply, m.text]), reactions, mails: t.g.gmail.sentMessages().map(m => [m.to, m.subject, m.text]),
        said: said(t), calls: w.noteCalls.filter(c => c[2] > 0).length,
        asked: { gemini: t.g.vertex.calls.length, embeddings: t.g.vertex.embedCalls.length, bigquery: w.bigquery.n } };
    };
    const on = run(FIRST);
    const off = run(FIRST_NO_NOTES);
    const isNote = p => /Part of a story/.test(p[1]);
    eq([on.posts.filter(isNote).length, off.posts.filter(isNote).length, off.said], [1, 0, []]);
    eq(off.posts, on.posts.filter(p => !isNote(p)));
    eq([off.reactions, off.mails], [on.reactions, on.mails]);
    eq([on.calls, off.calls], [1, 1]);  // the poll asks either way; with the setting off nothing is looked up or posted
    // nothing is looked up by meaning and nothing more is read from the feeds: Gemini, the embeddings and BigQuery are
    // asked exactly as often with the note as without it (and each was asked: the story's review, Step 1, the feeds)
    eq(on.asked, off.asked);
    assert.ok(on.asked.gemini >= 3 && on.asked.bigquery >= 10, JSON.stringify(on.asked));
    // the two golden scenarios hold no card on a post that a story's card has: with the notes alone turned on, each puts
    // out exactly what it did at f93e31a
    // The same setting also turns on two other lanes' notes, which the golden one-space scenario does show: the Watch's
    // note under the Maps card (WatchAlerts.gs) and step 12's story card with its review note and its note under the
    // Pixel card (EarlyDetectionCross.gs). Without exactly those, the scenario is what it was at f93e31a
    const step12 = x => /^12 /.test(String(x.run || ''));
    const watchNote = x => /^🔭 \*Also flagged by the watch /.test(String(x.text || ''));
    const without = out => Object.assign({}, out, { chat: out.chat.filter(x => !step12(x) && !watchNote(x)),
      reactions: out.reactions.filter(x => !step12(x)) });
    const one = golden.oneSpace(NOTES);
    // ...and exactly what they are (the same in switch_bq_bigger_post, switch_bq_story_notes): the Watch's note under
    // the Maps card, and step 12's story card, its review note and its note under the Pixel card, with the emoji on the card
    const OTHERS = [
      { run: '10 the Maps card is reviewed and the watch flags the Maps post too', space: 'spaces/AAQAonespace01', thread: 'spaces/AAQAonespace01/threads/t9', reply: true,
        text: '🔭 *Also flagged by the watch “Google brand safety (all)”.* No separate Watch alert: this card already covers the post.' },
      { run: '12 a story whose main post is the Pixel post', space: 'spaces/AAQAonespace01', thread: 'spaces/AAQAonespace01/threads/t14', reply: false,
        text: '🚨 *EARLY DETECTION* · New story\n' +
        '*Pixel 10 owners say batteries are swelling after the update*\n' +
        '*Product:* Pixel\n' +
        '*Exposure Tag:* Product - Other/general criticism (P2)\n' +
        '*Sensitive Topic:* None\n' +
        '*KOF:* No (5 small, non-KOF accounts)\n' +
        '\n' +
        '*What\'s happening:* Owners describe <https://x.com/pixelcritic/status/2150000000000000001|swollen batteries> on X and <https://www.reddit.com/r/GooglePixel/comments/1p9xyz/battery_swelling/|Reddit>.\n' +
        '*Post:* "My Pixel 10 battery swelled up after the latest update, the back cover is lifting."\n' +
        '*Call:* 👍 Monitor build-up: Several independent owners describe the same hardware safety symptom\n' +
        '*Activity:* 5 small accounts on X and Reddit posted about this 6 times at 7:42 AM ET\n' +
        '*Next steps:*\n' +
        '1. Keep monitoring for volume growth and re-check in 2 hours.\n' +
        '*Posts:* <https://x.com/pixelcritic/status/2150000000000000001|@pixelcritic> (X) · <https://x.com/droidfan22/status/2150000000000000022|@droidfan22> (X) · <https://www.reddit.com/r/GooglePixel/comments/1p9xyz/battery_swelling/|@u_pixel_owner> (Reddit)' },
      { run: '12 a story whose main post is the Pixel post', space: 'spaces/AAQAonespace01', thread: 'spaces/AAQAonespace01/threads/t14', reply: true,
        text: '🤖 *Early Detection Review: 👍 Monitor build-up* · medium (86% sure)\n' +
        '*Why:* Several independent owners describe the same hardware safety symptom.\n' +
        '• *SLRR:* Product - Other/general criticism (P2) · Pixel.\n' +
        '• *Draft Temp Check query:* `"Pixel 10" AND (battery OR swelling OR swollen)` (Last 6 hours across X and Reddit)\n' +
        '• *Escalate if:* An official statement or press pickup.\n' +
        '*Related alert:* its main post already has a card (QA-1002 · BigQuery · BSIP, 8:07 AM ET)' },
      { run: '12 a story whose main post is the Pixel post', space: 'spaces/AAQAonespace01', thread: 'spaces/AAQAonespace01/threads/t5', reply: true,
        text: '🔗 *Part of a story:* 5 small accounts on X and Reddit tell it (story card QA-1006)' },
    ];
    const OTHER_REACTIONS = [{ run: '12 a story whose main post is the Pixel post', on: 'spaces/AAQAonespace01/messages/m14', emoji: '👍' }];
    eq([one.chat.filter(x => step12(x) || watchNote(x)), one.reactions.filter(step12)], [OTHERS, OTHER_REACTIONS]);
    eq(golden.differences(without(one), golden.recorded.one_space), []);
    eq(golden.differences(golden.mirror(NOTES), golden.recorded.mirror), []);
  });

  test('story notes: in the Mirror flow nothing changes. A story is carded in the Mirror space and Direct BigQuery then cards two posts that story\'s card links, one while Testing with the Burson test copy and one LIVE: no note, and every Chat post, test copy post, emoji, email and Burson outbox row is the same with the setting on as with it off', () => {
    const POSTS = ['https://x.com/devnotes_k/status/2150000000000000012', 'https://x.com/latenightcoder/status/2150000000000000014'];  // posts the golden story links
    const row = (url, n) => golden.rows.bsipRow({ id: url.split('/').pop(), url, handle: url.split('/')[3], alert_names_json: '["Chrome"]',
      tags: 'Chrome tabs | Product - Other/general criticism', followers: 900, total: 600 + n,
      summary: `An X user says the Google Chrome update wiped every open tab (${n}).`,
      issue_name: n === 1 ? 'Chrome tabs gone after the update' : 'Lost browser session overnight', post_time: '2026-10-14 11:42:00+00' });
    const run = overrides => {
      const { t, feed, rec } = W.mirrorWorld(overrides);
      rec.step('a story is found', 15, () => { feed.stories = [golden.rows.story()]; });
      rec.step('quiet run', 1);
      rec.step('Direct BigQuery finds a post of the story (Testing)', 5, () => { feed.stories = []; feed.bsip = [row(POSTS[0], 1)]; });
      rec.step('its card is reviewed', 1);
      rec.step('the test copy is cleared: LIVE', 1, () => { t.set('B26', ''); });
      rec.step('Direct BigQuery finds another post of the story (LIVE)', 5, () => { feed.bsip = [row(POSTS[0], 1), row(POSTS[1], 2)]; });
      rec.step('its card is reviewed', 1);
      return { t, out: rec.out() };
    };
    const on = run(NOTES);
    const off = run(OFF);
    eq(golden.differences(on.out, off.out), []);
    // the scenario is the one a note would be posted in: the story's card is in the Mirror space, and both posts it links
    // got their Direct BigQuery cards after it
    const tops = on.out.chat.filter(m => m.space === MIRROR && !m.reply && (/^🚨 \*EARLY DETECTION\*/.test(m.text) || /\*\[BigQuery · BSIP\]\*/.test(m.text)));
    eq(tops.map(m => (/^🚨/.test(m.text) ? 'story card' : m.text.match(/\[Link\]: (\S+)/)[1])), ['story card'].concat(POSTS));
    POSTS.forEach(url => assert.ok(tops[0].text.includes(url), url));
    const all = on.out.chat.concat(on.out.test_copy).map(m => m.text).concat(on.out.outbox.map(r => String(r[3])));
    eq([all.filter(text => /Part of a story/.test(text)), said(on.t), noteLogs(on.t)], [[], [], []]);
  });

  /** One run of a world with `fn(ctx)` called inside each flow's pass, right after it (what the last call returned). */
  const inFlow = (t, fn) => {
    if (!t.bot.__flowHook) {
      t.bot.__flowHook = { fn: null };
      t.bot.ev('runOnce_ = (orig => function (ctx) { const r = orig(ctx); if (__flowHook.fn) __flowHook.fn(ctx); return r; })(runOnce_)');
    }
    let got;
    t.bot.__flowHook.fn = ctx => { got = fn(ctx); };
    t.poll();
    t.bot.__flowHook.fn = null;
    return got;
  };

  test('story notes: only the Auto-correct flow, only with the setting on, only with time, and only through the helper (bqStoryNotes_ called by hand on a card that has no note yet): a flow that is not the Auto-correct flow, a flow that only looks like it, the setting off and a run short of time post nothing; a card in another space, a ledger that can\'t be read and a card without a message post nothing and throw nothing; then the note is posted once, and asked again it is not posted twice', () => {
    // the one-space setup with the notes OFF: the story's card, then the card of the other post it links, without a note
    const w = oneSpace(OFF);
    const { t } = w;
    storyThenPost(w, otherRow(), 5);
    const card = cardOf(t, AC, OTHER);
    eq(under(t, card), []);
    const key = t.bot.recordKey_({ post_url: OTHER });
    const cardOfMsg = m => ({ key, url: OTHER, msg: { name: m.name, thread: m.thread.name, createTime: Date.parse(m.createTime) } });
    const mine = [cardOfMsg(card)];
    const live = t.chat.say(REAL, 'A message in S-F Burson');
    const count = () => everyPost(t).size;
    const got = inFlow(t, ctx => {
      const now = ctx.now();
      const before = count();
      const on = Object.assign({}, ctx.settings, { cross_alert_notes: true });
      const flow = patch => Object.assign({}, ctx, { settings: on }, patch || {});
      const call = (c, cards, hasTime) => t.bot.bqStoryNotes_(c, cards === undefined ? mine : cards, now, hasTime === undefined ? true : hasTime);
      const broken = flow();
      Object.defineProperty(broken, 'store', { get() { throw new Error('the Alert log can\'t be read'); } });
      return {
        isAc: ctx.sourceReadOnly === true && ctx.settings.cross_alert_notes === false,
        refused: [
          call(ctx),                                        // the setting off (this world's own)
          call(flow({ settings: Object.assign({}, on, { cross_alert_notes: false }) })),
          call(flow({ sourceReadOnly: false })),            // not the Auto-correct flow
          call(flow({ sourceReadOnly: undefined })),
          call(flow({ sourceReadOnly: 'true' })),           // (only the flow's own true counts)
          call(flow({ outboundBlocked: true })),            // a flow that looks like it: the Mirror flow's mark (the helper refuses)
          call(flow({ direct: true })),                     // ...working directly in B25
          call(flow({ otherSpace: true })),                 // ...the Other alerts space
          call(flow(), mine, false),                        // no time
          call(flow(), [{ key, url: OTHER, msg: { name: live.name, thread: live.thread.name, createTime: now } }]),  // a card in S-F Burson
          call(broken),                                     // the Alert log can't be read
          call(flow(), null), call(flow(), []), call(flow(), [{}]), call(flow(), [{ key, url: OTHER }]), call(flow(), [null]),
          call(null), call(undefined), call({}),
          call(flow(), [{ key: 'x.com/status/1', url: 'https://x.com/a/status/1', msg: mine[0].msg }]),  // a post no story card has
        ],
        afterRefusals: count() - before,
        posted: call(flow()),
        again: call(flow()),
        afterPosting: count() - before,
      };
    });
    eq([got.isAc, got.refused, got.afterRefusals], [true, Array(20).fill(0), 0]);
    eq([got.posted, got.again, got.afterPosting, under(t, card).map(kind)], [1, 1, 1, ['story note']]);
    // what the run log says of the ones it found and did not post
    const storyId = alertRows(t).find(r => r.ingested === 'Early detection').alert_id;
    const WHOSE = `under the new card of ${OTHER}, whose post is in a story's card (${storyId})`;
    eq(said(t).map(l => l.replace('BigQuery direct poll: ', '')), [
      `no note ${WHOSE}: it could not be posted`,  // the Mirror flow's mark
      `no note ${WHOSE}: it could not be posted`,  // B25
      `no note ${WHOSE}: it could not be posted`,  // the Other alerts space
      `no note ${WHOSE}: the flow had 45 seconds or less left (a check in the next hour adds it)`,
      `no note ${WHOSE}: it could not be posted`,  // a card in S-F Burson
      `a note is ${WHOSE}`, `a note is ${WHOSE}`,
    ]);
    eq(noteLogs(t), ['thread note not posted: the card\'s thread is not in the Auto-correct space']);
    eq(t.chat.botPosts(REAL), []);
  });

  // -----------------------------------------------------------------------------------------------------------
  // The helper refusing, and a run short of time
  // -----------------------------------------------------------------------------------------------------------

  test('story notes: when the note can\'t be posted (Chat refuses it) nothing is posted and nothing is thrown: the check ends as it does without a note (the card posted, remembered and counted, its review and its Social Alert a run later), and the run log says the note is missing. The next check tries the note again: nothing while Chat still refuses it. Once Chat takes it the note is under the card, once, the same note the card\'s own check would have posted, and the run log says it was added at a later check; no check after that tries or posts anything more', () => {
    const w = oneSpace(FIRST);
    const { t, rec, feed } = w;
    // Chat refuses every reply that is a note of this kind
    const REFUSED = (method, path, query, body) => (method === 'post' && /\/messages$/.test(path) && body && /Part of a story/.test(String(body.text || ''))
      ? { code: 500, body: { error: { message: 'Internal error encountered.' } } } : null);
    const tries = () => t.chat.calls.filter(c => c.method === 'post' && c.body && /Part of a story/.test(String(c.body.text || ''))).length;
    const refusals = () => noteLogs(t).map(l => l.replace(/Chat API 500 on posting to \S+: /, 'Chat API 500: '));
    t.chat.fail = REFUSED;
    const before = botPosts(t, AC).length;
    rec.step('the story and the post are found in one run', 5, () => { feed.stories = [mapsStory()]; feed.bsip = [golden.rows.mapsRow()]; });
    eq(kinds(t, AC, before), ['story card', 'story review note', 'Direct BigQuery card']);
    const story = botPosts(t, AC).find(m => kind(m) === 'story card');
    const card = cardOf(t, AC, MAPS);
    const storyId = alertRows(t).find(r => r.ingested === 'Early detection').alert_id;
    eq(said(t), [`BigQuery direct poll: no note under the new card of ${MAPS}, whose post is in a story's card (${storyId}): it could not be posted`]);
    const once = tries();
    eq([once > 0, refusals()], [true, ['thread note not posted: Chat API 500: Internal error encountered.']]);
    // the poll kept what it posted: the post is not carded again, and C15 counts the card
    eq([JSON.parse(t.g.props.get('BQ_INGESTED_KEYS')).length, JSON.parse(t.g.props.get('BQ_INGESTED_MSGS')).length], [1, 1]);
    rec.step('the card is reviewed', 1);
    eq([under(t, card).map(kind), mails(t)], [['card review note'], [ALERT]]);
    // the next check tries the note again, as often as the first did, and Chat refuses it again
    rec.step('the next check: Chat still refuses the note', 4);
    eq([under(t, card).map(kind), tries(), refusals().length, saidLate(t)], [['card review note'], 2 * once, 2, []]);
    assert.ok(/ · 1 post today \(1 for a Social Alert, 0 monitoring only\) /.test(c15(t)), c15(t));
    // Chat works again: the check after that posts the note
    t.chat.fail = null;
    rec.step('the check after: Chat takes the note', 5);
    const cardId = alertRows(t).find(r => r.ingested === 'BSIP').alert_id;
    const [note] = storyNotes(t);
    eq([under(t, card).map(kind), storyNotes(t).length, tries()], [['card review note', 'story note'], 1, 2 * once + 1]);
    eq(note.text, `🔗 *Part of a story:* 6 small accounts on X and Reddit tell it (<${linkTo(story)}|story card>)`);
    eq([note.thread.name, note.threadReply, /^client-bqa-[0-9a-f]{40}$/.test(note.clientAssignedMessageId)], [card.thread.name, true, true]);
    eq(saidLate(t), [`BigQuery direct poll: a note is under the card of ${MAPS} (${cardId}), whose post is in a story's card (${storyId}): added at a later check`]);
    // the checks after that: the note is there, nothing is tried or posted again, and the bot never answers it
    const posts = botPosts(t, AC).length;
    [1, 4, 5, 5].forEach(minutes => rec.step('later', minutes));
    eq([botPosts(t, AC).length, tries(), saidLate(t).length, refusals().length, mails(t)], [posts, 2 * once + 1, 1, 2, [ALERT]]);
  });

  test('story notes: a note needs more than 45 seconds of the flow left once the cards are posted. With 45 seconds or less the card is posted and remembered as always and the note is not, and the run log says so; the next check, which has its time, adds the note: once, the very note the card\'s own check would have posted, under the same card. With a millisecond more the note is posted at the card\'s own check, and no later check adds a second one. A check with too little time for the card itself posts the card at a later check, and the note with it', () => {
    // how much of the flow is left when the notes are asked for, in a check that costs nothing
    const probe = oneSpace(FIRST);
    storyThenPost(probe, golden.rows.mapsRow(), 5);
    const [free] = probe.noteCalls.filter(c => c[2] > 0).map(c => c[0]);
    assert.ok(free > 100 * SEC, `${free} ms left in a check that costs nothing`);
    const run = left => {
      const w = oneSpace(FIRST);
      const notes = () => { const card = cardOf(w.t, AC, MAPS); return card ? under(w.t, card).map(kind) : 'no card'; };
      w.rec.step('the story is found', 5, () => { w.feed.stories = [mapsStory()]; });
      w.cost.poll = free - left;  // the check's read takes all but `left` of the flow's time
      w.rec.step('Direct BigQuery finds the post', 5, () => { w.feed.bsip = [golden.rows.mapsRow()]; });
      w.cost.poll = 0;
      const first = { call: w.noteCalls.filter(c => c[2] > 0), notes: notes() };
      w.rec.step('the card is reviewed', 1);
      const reviewed = notes();
      [1, 5, 1, 5, 1].forEach(minutes => w.rec.step('after', minutes));
      return Object.assign(first, { t: w.t, reviewed, later: notes(), calls: w.noteCalls.filter(c => c[2] > 0).length,
        texts: storyNotes(w.t).map(m => m.text), late: saidLate(w.t) });
    };
    const short = run(45 * SEC);
    eq([short.call, short.notes, short.reviewed, short.later, short.calls], [[[45 * SEC, false, 1]], [], ['card review note'], ['card review note', 'story note'], 1]);
    assert.match(said(short.t).join('\n'),
      /^BigQuery direct poll: no note under the new card of \S+, whose post is in a story's card \(QA-\d+\): the flow had 45 seconds or less left \(a check in the next hour adds it\)$/);
    assert.match(short.late.join('\n'),
      /^BigQuery direct poll: a note is under the card of \S+ \(QA-\d+\), whose post is in a story's card \(QA-\d+\): added at a later check$/);
    eq([mails(short.t), JSON.parse(short.t.g.props.get('BQ_INGESTED_KEYS')).length, noteLogs(short.t)], [[ALERT], 1, []]);
    const enough = run(45 * SEC + 1);
    eq([enough.call, enough.notes, enough.later, enough.calls, enough.late], [[[45 * SEC + 1, true, 1]], ['story note'], ['story note', 'card review note'], 1, []]);
    // the note added later is the one the card's own check posts: the same words, the same link to the story's card
    eq([short.texts.length, short.texts], [1, enough.texts]);
    assert.match(short.texts[0], /^🔗 \*Part of a story:\* 6 small accounts on X and Reddit tell it \(<https:\/\/chat\.google\.com\/room\/AAQAonespace01\/t\d+\/m\d+\|story card>\)$/);
    // less still: a card needs 30 seconds, so with 40 there is a card and no note; the next check adds it
    const less = run(40 * SEC);
    eq([less.call, less.notes, less.later, less.texts], [[[40 * SEC, false, 1]], [], ['card review note', 'story note'], enough.texts]);
    // ...and with 20 there is no card in that check: it comes at the next one, which has its time, and the note with it
    const none = run(20 * SEC);
    eq([none.call, none.notes, none.later, none.calls, none.late], [[], 'no card', ['story note', 'card review note'], 1, []]);
  });

  // -----------------------------------------------------------------------------------------------------------
  // A note added at a later check: when, for which card, and at what cost
  // -----------------------------------------------------------------------------------------------------------

  /**
   * From now on a world's Direct BigQuery checks end with `w.leave.ms` of the flow left (null: as they come): the check's
   * BSIP read takes all the rest of the flow's time. (The harness's Chat takes a second for each message it is given,
   * so this is exact for a check that posts nothing after its read.)
   */
  const leaving = w => {
    w.leave = { ms: null };
    w.t.bot.__leave = w.leave;
    w.t.bot.__cost = w.cost;
    w.t.bot.ev('pollBigQuerySources_ = (orig => function (ctx, target) { ' +
      'if (__leave.ms !== null && ctx && ctx.deadline) __cost.poll = Math.max(0, ctx.deadline - ctx.now() - __leave.ms); ' +
      'return orig(ctx, target); })(pollBigQuerySources_)');
    return w;
  };
  /** How often a world's flows opened the Alert log (each flow's store is made when the run first needs it). */
  const logOpens = t => {
    t.bot.__opens = { n: 0 };
    t.bot.ev('makeStore_ = (orig => function () { __opens.n++; return orig.apply(this, arguments); })(makeStore_)');
    return t.bot.__opens;
  };
  /**
   * A started one-space world where the story on the Maps post is carded, and five minutes on Direct BigQuery cards
   * `row`'s post in a check that ends with 40 seconds of the flow left: the card has no note. {w, card, noNote}.
   */
  const cardWithoutItsNote = (overrides, row) => {
    const w = leaving(oneSpace(overrides));
    w.rec.step('the story is found', 5, () => { w.feed.stories = [mapsStory()]; });
    w.leave.ms = 40 * SEC;
    w.rec.step('Direct BigQuery finds the post with little time left', 5, () => { w.feed.bsip = [row]; });
    w.leave.ms = null;
    w.cost.poll = 0;
    const card = cardOf(w.t, AC, row.url);
    assert.ok(card, 'the card is posted');
    // (with the setting off there is no note to miss, and nothing is said)
    const on = w.t.bot.ev('GEN').settings.cross_alert_notes !== false;
    eq([under(w.t, card).map(kind), said(w.t).length, on ? /45 seconds or less left \(a check in the next hour adds it\)$/.test(said(w.t)[0]) : true],
      [[], on ? 1 : 0, true]);
    return { w, card };
  };

  test('story notes: the later look has the same 45 seconds, and one hour. A card went without its note; while every check after it ends with 45 seconds or less of the flow left, no note is added; the first check with a millisecond more adds it. A card whose first hour passes that way never gets the note: a check with all its time, 61 minutes after the card, adds nothing', () => {
    // every later check short of time, then one with 45,001 ms left: that one adds the note
    const { w, card } = cardWithoutItsNote(FIRST, otherRow());
    const { t, rec } = w;
    rec.step('the card is reviewed', 1);
    w.leave.ms = 45 * SEC;
    [4, 5, 5].forEach(minutes => rec.step('a check with 45 seconds left', minutes));
    eq([under(t, card).map(kind), saidLate(t), said(t).length, noteLogs(t)], [[], [], 1, []]);
    w.leave.ms = 45 * SEC + 1;
    rec.step('a check with a millisecond more', 5);
    eq([under(t, card).map(kind), saidLate(t).length], [['story note'], 1]);
    w.leave.ms = null;
    w.cost.poll = 0;
    [5, 5].forEach(minutes => rec.step('later', minutes));
    eq([storyNotes(t).length, saidLate(t).length], [1, 1]);

    // the whole first hour short of time: the note is never added, not even by a check that has all its time
    const late = cardWithoutItsNote(FIRST, otherRow());
    late.w.rec.step('the card is reviewed', 1);
    late.w.leave.ms = 30 * SEC;
    // (a run short of time takes most of its flow's minutes: the clock is read, not added up)
    const posted = Date.parse(late.card.createTime);
    const since = () => late.w.t.g.clock.now - posted;
    const checks = late.w.noteCalls.length;
    while (since() < 50 * MIN) late.w.rec.step('a check short of time', 1);
    late.w.leave.ms = null;
    late.w.cost.poll = 0;
    assert.ok(since() > 50 * MIN && since() < 60 * MIN, 'still inside the card\'s first hour');
    assert.ok(late.w.noteCalls.length - checks >= 8, `checks were made in that hour: ${late.w.noteCalls.length - checks}`);
    late.w.rec.step('61 minutes after the card: a check with all its time', Math.ceil((61 * MIN - since()) / MIN) + 1);
    assert.ok(late.w.t.g.clock.now - posted > 60 * MIN, 'the card\'s first hour has passed');
    [5, 5].forEach(minutes => late.w.rec.step('later', minutes));
    eq([under(late.w.t, late.card).map(kind), storyNotes(late.w.t), saidLate(late.w.t)], [[], [], []]);
    eq(B.ev('[BQ_STORY_NOTE_LATE_MS_, BQ_STORY_NOTE_LEFT_MS_]'), [HOUR, 45 * SEC]);
  });

  test('story notes: a note is added later only under a card that was posted into a story: the story\'s card was there before the post\'s own card. A card posted before the story\'s card (the poll first and the story in the same run; or the story found a check after the card) never gets one from the poll, however many checks follow, with stories first or not: the poll\'s note is not for a story that comes after the card', () => {
    // the poll first, the story found in the same run: the card is posted before the story's card
    const same = oneSpace(NOTES);
    const got = storyThenPost(same, otherRow(), 0);
    eq([got.atCheck, got.notes.map(kind), storyNotes(same.t), saidLate(same.t)], [['Direct BigQuery card', 'story card', 'story review note'], [], [], []]);
    // (the later look did see that card: it is one the poll posted in the last hour, and the story's card has its post)
    const rows = alertRows(same.t);
    const [cardRow, storyRow] = [rows.find(r => r.ingested === 'BSIP'), rows.find(r => r.ingested === 'Early detection')];
    eq([cardRow.record_key, storyRow.forwarded_fields.early_detection.post_keys.indexOf(cardRow.record_key) >= 0, storyRow.created_at > cardRow.source_at,
      same.t.g.clock.now - cardRow.source_at < HOUR], [same.t.bot.recordKey_({ post_url: OTHER }), true, true, true]);

    // the story found a check after the card, where stories go first and where they don't
    [['stories first', FIRST], ['the poll first', NOTES]].forEach(([name, overrides]) => {
      const w = oneSpace(overrides);
      const { t, rec, feed } = w;
      rec.step('Direct BigQuery finds the other post', 5, () => { feed.bsip = [otherRow()]; });
      rec.step('its card is reviewed', 1);
      rec.step('the story is found', 14, () => { feed.stories = [mapsStory()]; });
      [1, 4, 5, 5, 5].forEach(minutes => rec.step('later', minutes));
      eq([name, botPosts(t, AC).filter(m => !m.threadReply).map(kind), storyNotes(t), saidLate(t), said(t), noteLogs(t)],
        [name, ['Direct BigQuery card', 'story card'], [], [], [], []]);
    });
  });

  test('story notes: the later look opens nothing for itself. A check whose feeds give no post did not read the Alert log, and makes no later look: there the note waits, and the flows open the Alert log exactly as often with the notes on as with them off. The next check that reads the log anyway (the feed gives the post again) adds the note. Gemini, the embeddings and BigQuery are asked as often with the notes on as with them off', () => {
    const run = overrides => {
      const { w, card } = cardWithoutItsNote(overrides, otherRow());
      const { t, rec, feed } = w;
      const opens = logOpens(t);
      // the checks that made a later look (it is made only at a check that has read the Alert log for its posts)
      t.bot.__looks = { n: 0 };
      t.bot.ev('bqStoryNotesLate_ = (orig => function () { __looks.n++; return orig.apply(this, arguments); })(bqStoryNotesLate_)');
      const looks = [];
      const asked = () => [t.g.vertex.calls.length, t.g.vertex.embedCalls.length, w.bigquery.n];
      rec.step('the card is reviewed', 1);
      const at = [opens.n];
      looks.push(t.bot.__looks.n);
      rec.step('a check whose feeds give nothing', 4, () => { feed.bsip = []; });
      at.push(opens.n);
      looks.push(t.bot.__looks.n);
      const quiet = under(t, card).map(kind);
      rec.step('a check that reads the post again', 5, () => { feed.bsip = [otherRow()]; });
      at.push(opens.n);
      looks.push(t.bot.__looks.n);
      [1, 4].forEach(minutes => rec.step('later', minutes));
      return { quiet, later: under(t, card).map(kind), opens: at.concat([opens.n]), asked: asked(), late: saidLate(t).length,
        looks: looks.concat([t.bot.__looks.n]) };
    };
    const on = run(FIRST);
    const off = run(FIRST_NO_NOTES);
    eq([on.quiet, on.later, on.late], [[], ['story note'], 1]);
    eq([off.quiet, off.later, off.late], [[], [], 0]);
    eq([on.opens, on.asked], [off.opens, off.asked]);
    // the quiet check made no later look; the one that read the post again made one (with the notes off too: the look
    // itself then returns at once)
    eq([on.looks[1] - on.looks[0], on.looks[2] - on.looks[1] >= 1], [0, true]);
  });

  test('story notes: a card whose thread can\'t be read when it is posted (the helper counts a card\'s notes in its thread, and Chat fails the read) goes without its note at that check; the next check, with Chat answering again, adds it', () => {
    const w = oneSpace(FIRST);
    const { t, rec, feed } = w;
    rec.step('the story is found', 5, () => { feed.stories = [mapsStory()]; });
    t.g.cache.delete('ac_thread_notes');  // (the helper remembers nothing: it counts the new card's notes in its thread)
    t.chat.fail = (method, path, query) => (method === 'get' && /\/messages$/.test(path) && /thread\.name/.test(String((query && query.filter) || ''))
      ? { code: 503, body: { error: { code: 503, message: 'The service is currently unavailable.' } } } : null);
    rec.step('Direct BigQuery finds the post', 5, () => { feed.bsip = [golden.rows.mapsRow()]; });
    t.chat.fail = null;
    const card = cardOf(t, AC, MAPS);
    eq([under(t, card).map(kind), noteLogs(t), said(t).length], [[], ['thread note not posted: its card\'s thread couldn\'t be read to count the notes it has'], 1]);
    rec.step('the card is reviewed', 1);
    rec.step('the next check', 4);
    eq([under(t, card).map(kind), saidLate(t).length, storyNotes(t).length, mails(t)], [['card review note', 'story note'], 1, 1, [ALERT]]);
  });

  test('story notes: the later look by hand (bqStoryNotesLate_), on a card of the last hour that was posted into a story and has no note. It posts nothing and logs nothing in a flow that is not the Auto-correct flow, in one that only looks like it, with the setting off and with no time; for a card older than an hour, one whose row doesn\'t say when it was posted, one that was not reviewed where it stands, one in another space, an alert that is no Direct BigQuery card, a post no story has, and a story whose card came with or after the post\'s card; an Alert log that can\'t be read throws nothing. Then the note is posted once, as the card\'s own check posts it; asked again, also with the helper\'s memory gone, and by the card\'s own check, nothing more is posted', () => {
    const w = oneSpace(OFF);  // the notes off: the story's card, then the card of the other post it links, without a note
    const { t } = w;
    storyThenPost(w, otherRow(), 5);
    const card = cardOf(t, AC, OTHER);
    const story = botPosts(t, AC).find(m => kind(m) === 'story card');
    eq(under(t, card), []);
    const live = t.chat.say(REAL, 'A message in S-F Burson');
    const count = () => everyPost(t).size;
    const got = inFlow(t, ctx => {
      const now = ctx.now();
      const before = count();
      const logged = t.g.logs.length;
      const on = Object.assign({}, ctx.settings, { cross_alert_notes: true });
      const flow = patch => Object.assign({}, ctx, { settings: on }, patch || {});
      const late = (c, at, hasTime) => t.bot.bqStoryNotesLate_(c, at === undefined ? now : at, hasTime === undefined ? true : hasTime);
      const rows = ctx.store.alerts;
      const cardRow = rows.find(r => r.ingested === 'BSIP');
      const storyRow = rows.find(r => r.ingested === 'Early detection');
      // a flow whose Alert log holds `list`: the story's row and the card's row with something changed
      const withRows = list => flow({ store: { alerts: list, alertById: id => list.find(r => r.alert_id === id) || null } });
      const cardAs = patch => withRows([storyRow, Object.assign({}, cardRow, patch)]);
      const broken = flow();
      Object.defineProperty(broken, 'store', { get() { throw new Error('the Alert log can\'t be read'); } });
      const out = {
        facts: [ctx.sourceReadOnly === true, ctx.settings.cross_alert_notes === false, cardRow.source_message === card.name,
          cardRow.forward_message === card.name, cardRow.forward_thread === card.thread.name, cardRow.source_at === Date.parse(card.createTime),
          now - cardRow.source_at > 10 * MIN && now - cardRow.source_at < HOUR, storyRow.created_at < cardRow.source_at],
        passedOver: [
          late(ctx),                                                  // the setting off (this world's own)
          late(flow({ settings: Object.assign({}, on, { cross_alert_notes: false }) })),
          late(flow({ sourceReadOnly: false })), late(flow({ sourceReadOnly: undefined })), late(flow({ sourceReadOnly: 'true' })),
          late(flow({ outboundBlocked: true })),                      // a flow that only looks like it: the helper would refuse, so it is passed over
          late(flow({ direct: true })), late(flow({ otherSpace: true })),
          late(flow(), now, false), late(flow(), now, () => false),   // no time
          late(flow(), now, (() => { let asked = 0; return () => asked++ === 0; })()),  // time at the start, none left for the note
          late(flow(), cardRow.source_at + HOUR),                     // the card's first hour is over
          late(flow(), cardRow.source_at - 1),                        // (a card from after the check)
          late(cardAs({ source_at: 0 })), late(cardAs({ source_at: undefined })), late(cardAs({ source_at: '' })),  // no time of its own
          late(cardAs({ forward_message: `${card.name}x` })),         // not reviewed where it stands: the alert post is another message
          late(cardAs({ source_message: '' })), late(cardAs({ forward_message: '' })), late(cardAs({ forward_thread: '' })),
          late(cardAs({ source_message: live.name, forward_message: live.name, forward_thread: live.thread.name })),  // a card in S-F Burson
          late(cardAs({ ingested: 'Early detection' })), late(cardAs({ ingested: 'Watch alert' })), late(cardAs({ ingested: '' })),
          late(cardAs({ record_key: '' })), late(cardAs({ record_key: 'x.com/status/1' })),  // a post no story's card has
          late(cardAs({ source_at: storyRow.created_at })),           // the story's card came with the post's card,
          late(cardAs({ source_at: storyRow.created_at - 1 })),       // ...or after it
          late(withRows([cardRow])),                                  // no story's card at all
          late(broken), late(null), late(undefined), late({}),
        ],
      };
      out.afterPassedOver = [count() - before, t.g.logs.slice(logged)];
      out.posted = late(flow());
      out.again = late(flow());
      t.g.cache.delete('ac_thread_notes');  // the helper's memory gone: the note under the card is still the same note
      out.forgotten = late(flow());
      out.ownCheck = t.bot.bqStoryNotes_(flow(), [{ key: cardRow.record_key, url: OTHER,
        msg: { name: card.name, thread: card.thread.name, createTime: Date.parse(card.createTime) } }], now, true);
      out.afterPosting = count() - before;
      out.ids = [cardRow.alert_id, storyRow.alert_id];
      return out;
    });
    eq([got.facts, got.passedOver, got.afterPassedOver], [Array(8).fill(true), Array(33).fill(0), [0, []]]);
    // posted once: 1 note posted now; asked again 0; with the helper's memory gone 0; the card's own check finds its note there
    eq([got.posted, got.again, got.forgotten, got.ownCheck, got.afterPosting], [1, 0, 0, 1, 1]);
    const [note] = under(t, card);
    eq([under(t, card).map(kind), note.text], [['story note'], `🔗 *Part of a story:* 6 small accounts on X and Reddit tell it (<${linkTo(story)}|story card>)`]);
    eq(saidLate(t), [`BigQuery direct poll: a note is under the card of ${OTHER} (${got.ids[0]}), whose post is in a story's card (${got.ids[1]}): added at a later check`]);
    eq([noteLogs(t), t.chat.botPosts(REAL)], [[], []]);
  });
};
