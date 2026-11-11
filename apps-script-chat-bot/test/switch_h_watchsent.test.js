// "Watch sent alerts (24h)" (Control tab row 18, Watch.gs): for a day after a Social Alert is sent, the bot re-checks the
// post every 30 minutes and replies once on the email thread for an engagement surge, a deleted post or press pickup.
'use strict';
const POSTS = require('./posts.json');  // real responses from X's embed endpoint (the Waymo post) and Bluesky's API

module.exports = H => {
  const { test, eq, assert, B, NOW, world, e2e, F, TEST_FEED, TRIAGED } = H;
  const MIN = 60 * 1000;
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const LIVE = { live: true, mailbox: 'im@ops.test', from: 'Brand Social <sender@alerts.test>' };
  const WAYMO = '2111814207448514693';    // F.WAYMO_KOF's post (Burson: 11 engagements); X has 46 likes + 8 replies
  const AIO = '1845000000000000001';      // F.AIO's post (Burson: 29,425 engagements)
  const P0 = '2109952063492993159';       // F.P0_OK's post (Burson: 1 engagement)
  const X_API = id => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${B.xEmbedToken_(id)}`;
  const BSKY_API = (who, rk) => 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=' +
    `${encodeURIComponent(`at://${who}/app.bsky.feed.post/${rk}`)}&depth=0&parentHeight=2`;
  const BQ = 'https://bigquery.googleapis.com/bigquery/v2/projects/brand-social-central-data/queries';
  const SURGE_LINE = 'Update: this post now has 120,008 engagements, up from 11 when this Social Alert went out.';
  const FOOTER = '\n\nTesting: live, this reply would go to everyone the Social Alert went to.';
  /** A reply's text without its "The post: <link>" line (every reply names its post: a thread can carry other posts' alerts). */
  const withoutPost = text => String(text).replace(/\nThe post: \S+/, '');

  /** X's embed data for post `id` with `likes` (and 8 replies), as X serves it (no video, so reviews stay quick). */
  const xPost = (id, likes, who) => JSON.stringify(Object.assign({}, POSTS.x_original, { id_str: id, favorite_count: likes,
    mediaDetails: [], user: Object.assign({}, POSTS.x_original.user, who ? { screen_name: who } : {}) }));
  /** The post on X now (the bot's 30-minute lookup cache is cleared, as 30 minutes have gone by). */
  const setPost = (w, id, likes, who) => { w.g.pages.set(X_API(id), xPost(id, likes, who)); w.g.cache.delete('post:x:' + id); };
  const goneOnX = (w, id) => { w.g.pages.set(X_API(id), { code: 404, body: '' }); w.g.cache.delete('post:x:' + id); };
  const xFetches = (w, id) => w.g.fetches.filter(f => f.url === X_API(id)).length;
  /** A world whose runs have these switches (the Control tab's): Watch sent alerts ON unless said otherwise. */
  const withSwitches = (w, switches) => {
    const base = w.ctx;
    w.ctx = () => { const c = base(); if (switches !== undefined) c.switches = switches; return c; };
    return w;
  };
  const watching = (opts, switches) => withSwitches(world(Object.assign({ post: true }, opts || {})),
    switches === undefined ? { watchSent: true } : switches);
  const memo = (w, k) => w.ctx().memo.get(k);
  const later = (w, minutes) => { w.g.clock.now += minutes * MIN; return w.run(); };
  /** F.WAYMO_KOF sent to the stand-in (the post on X with `likes`): the alert, the run's report and its row. */
  const sendWaymo = (w, likes) => {
    setPost(w, WAYMO, likes === undefined ? 46 : likes);
    const msg = w.paste(F.WAYMO_KOF);
    const r = w.run();
    return { msg, r, row: w.alertRows()[0] };
  };
  const notes = w => w.analystPosts().filter(m => m.threadReply && /^Update: /.test(m.text)).map(m => m.text);
  /** Gemini's answers to the press check (the rest of the reviews as usual): `answer` (+ web sources unless `noWeb`). */
  const press = (w, answer, noWeb) => {
    const calls = [];
    w.vertex.fail = payload => {
      if (!((payload.generationConfig.responseSchema || {}).properties || {}).covered) return null;
      calls.push(payload);
      const cand = { content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' };
      if (!noWeb) {
        cand.groundingMetadata = { webSearchQueries: ['waymo remote operators philippines video'],
          groundingChunks: [{ web: { title: 'reuters.com', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc' } }] };
      }
      return { code: 200, body: { candidates: [cand] } };
    };
    return calls;
  };
  const COVERED = { covered: true, confidence: 0.95, outlet: 'Reuters', headline: 'Waymo says remote staff in the Philippines don\'t drive its cars' };

  // ---------------------------------------------------------------------------------------------------------------
  // OFF: nothing changes
  // ---------------------------------------------------------------------------------------------------------------

  test('watch sent alerts OFF (no switches, or all of them OFF): a day of a surging, then deleted, post changes nothing: no watch list, no lookups, no replies, no notes, the same rows', () => {
    const day = switches => {
      const w = withSwitches(world({ drafts: STAND_IN, post: true }), switches);
      const { msg, row } = sendWaymo(w);
      const reports = [];
      setPost(w, WAYMO, 120000);
      for (let i = 0; i < 6; i++) reports.push(later(w, 30));
      goneOnX(w, WAYMO);
      for (let i = 0; i < 4; i++) reports.push(later(w, 10));
      w.g.clock.now += 20 * 3600e3;
      reports.push(w.run());
      return { w, msg, row, reports };
    };
    const none = day(undefined);
    const off = day(B.switchesOff_());
    for (const x of [none, off]) {
      eq(x.w.gmail.sentMessages().length, 1);              // the Social Alert only
      eq(xFetches(x.w, WAYMO), 1);                          // the review's lookup only: nothing re-checks the post
      eq([memo(x.w, 'sent_watch'), memo(x.w, 'sent_watch_day')], [null, null]);
      assert.ok(!('watch_state' in x.row.email_input));
      eq(notes(x.w), []);
      eq(x.w.gmail.calls.filter(c => c.path === 'messages/send').length, 1);
      assert.ok(x.reports.every(r => !('watch_updates' in r) && !r.errors.length));
      eq(x.w.g.props.get('SWITCH_NOTES'), undefined);
      eq(x.w.vertex.calls.filter(c => (c.payload.generationConfig.responseSchema.properties || {}).covered).length, 0);
    }
    // Both runs are the same, message for message and row for row
    const strip = x => JSON.parse(JSON.stringify({ sent: x.w.gmail.sentMessages(), posts: x.w.analystPosts().map(m => m.text),
      burson: x.w.bursonPosts().map(m => m.text), rows: x.w.alertRows(), reports: x.reports, fetches: x.w.g.fetches.map(f => f.url),
      reactions: x.w.chat.botReactions(x.msg.name) }));
    eq(strip(off), strip(none));
  });

  test('watch sent alerts OFF: watchSentAlerts_ and the onEmailSent_ step return before touching anything (memo, log sheet, Gmail, lookups)', () => {
    const touched = [];
    const ctx = { switches: B.switchesOff_(), now: () => NOW, deadline: NOW + 180000, log: t => touched.push('log ' + t) };
    ['memo', 'store', 'gmail', 'post', 'bq', 'bqEngagement', 'gemini', 'drafts', 'chat', 'settings'].forEach(k =>
      Object.defineProperty(ctx, k, { get() { touched.push(k); throw new Error(`${k} was touched`); } }));
    const report = { errors: [] };
    B.watchSentAlerts_(ctx, report);
    B.watchSentAlert_(ctx, { alert_id: 'QA-1', email_thread: 't1', email_input: { fields: { post_url: 'https://x.com/a/status/123456' } } });
    B.onEmailSent_(ctx, { alert_id: 'QA-1', email_thread: 't1' }, report);
    eq([touched, report], [[], { errors: [] }]);
    delete ctx.switches;  // a run without the Control tab: OFF too
    B.watchSentAlerts_(ctx, report);
    eq(touched, []);
  });

  test('watch sent alerts OFF, end to end (the Control tab as setup() leaves it): the Social Alert goes to the stand-in and that\'s all; C18 says OFF', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    setPost(t, WAYMO, 46);
    t.chat.say(TEST_FEED, F.WAYMO_KOF, { sender: 'users/bot' });
    t.poll();
    eq(t.g.gmail.sentMessages().length, 1);
    setPost(t, WAYMO, 120000);
    for (let i = 0; i < 4; i++) { t.g.clock.now += 30 * MIN; t.poll(); }
    eq([t.g.gmail.sentMessages().length, xFetches(t, WAYMO)], [1, 1]);
    assert.ok(!Array.from(t.g.props.keys()).some(k => /sent_watch/.test(k)));
    eq([t.control().cell(18, 1), t.control().cell(18, 2), t.control().cell(18, 3)],
      ['Watch sent alerts (24h)', 'OFF', 'OFF (stops once the Social Alert is sent)']);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // ON: a surge, a deleted post, press pickup
  // ---------------------------------------------------------------------------------------------------------------

  test('watch sent alerts ON: right after the send the post is seen up (the baseline is Burson\'s 11); a surge past 50K (and 3x) sends one reply on the Social Alert thread, to the stand-in only, and one note under the alert; never a second', () => {
    const w = watching({ drafts: STAND_IN });
    const { msg, r, row } = sendWaymo(w);
    eq([r.drafts_sent, r.watch_updates, r.errors], [1, undefined, []]);
    const [entry] = JSON.parse(memo(w, 'sent_watch'));
    eq([JSON.parse(memo(w, 'sent_watch')).length, entry.id, entry.at, entry.alive], [1, row.alert_id, row.email_sent_at, 1]);
    assert.ok(entry.next >= row.email_sent_at + 30 * MIN && entry.next <= w.g.clock.now + 30 * MIN);  // checked in the same run
    eq(row.email_input.watch_state, { baseline: 11, last: 54, milestones: [] });  // X: 46 likes + 8 replies
    const [alert] = w.gmail.sentMessages();
    const reactions = w.chat.botReactions(msg.name);
    eq(reactions, ['📰', '📦']);

    // 29 minutes later: not due yet (no lookup at all)
    setPost(w, WAYMO, 120000);
    const fetched = xFetches(w, WAYMO);
    later(w, 29);
    eq([w.gmail.sentMessages().length, xFetches(w, WAYMO)], [1, fetched]);
    const r2 = later(w, 1);
    eq([r2.watch_updates, r2.errors], [1, []]);
    const sent = w.gmail.sentMessages();
    eq(sent.length, 2);
    const reply = sent[1];
    eq([reply.to, reply.cc, reply.bcc], [['tester@testing.test'], [], []]);
    eq([reply.threadId, reply.inReplyTo, reply.references, reply.subject],
      [alert.threadId, alert.messageId, alert.messageId, 'Re: ' + alert.subject]);
    eq(withoutPost(reply.text), SURGE_LINE + FOOTER);
    assert.ok(reply.text.includes(`${SURGE_LINE}\nThe post: https://x.com/ICannot_Enough/status/${WAYMO}\n`), reply.text);
    assert.match(reply.html, /Update: this post now has 120,008 engagements, up from 11 when this Social Alert went out\./);
    assert.ok(reply.html.includes(`The post: <a href="https://x.com/ICannot_Enough/status/${WAYMO}">`), reply.html);
    eq(notes(w), [`${SURGE_LINE}\n- I replied on the Social Alert's email thread (testing: only to the testers).`]);
    const note = w.analystPosts().find(m => /^Update: /.test(m.text));
    eq(note.thread.name, row.forward_thread);
    eq(w.alertRows()[0].email_input.watch_state, { baseline: 11, last: 120008, milestones: [50000] });

    // Never twice: more growth, more runs, the rest of the day
    setPost(w, WAYMO, 400000);
    for (let i = 0; i < 4; i++) later(w, 30);
    eq([w.gmail.sentMessages().length, notes(w).length], [2, 1]);
    eq(w.alertRows()[0].email_input.watch_state.last, 400008);
    // Nothing in the Burson space: no post, no new emoji
    eq([w.bursonPosts(), w.chat.botReactions(msg.name)], [[], reactions]);
  });

  test('watch sent alerts ON: a small rise sends nothing (40K is under 50K; for an alert sent at 29,425, 60K isn\'t 3x); 3x and 50K+ does', () => {
    const w = watching({ drafts: STAND_IN });
    sendWaymo(w);
    setPost(w, WAYMO, 40000);
    later(w, 30);
    eq([w.gmail.sentMessages().length, notes(w), w.alertRows()[0].email_input.watch_state.last], [1, [], 40008]);

    const a = watching({ drafts: STAND_IN });
    setPost(a, AIO, 100, 'TheChiefNerd');
    a.paste(F.AIO);
    a.run();
    eq([a.gmail.sentMessages().length, a.alertRows()[0].email_input.watch_state], [1, { baseline: 29425, last: 108, milestones: [] }]);
    setPost(a, AIO, 60000, 'TheChiefNerd');
    later(a, 30);
    eq(a.gmail.sentMessages().length, 1);
    setPost(a, AIO, 90000, 'TheChiefNerd');
    later(a, 30);
    eq(withoutPost(a.gmail.sentMessages()[1].text),
      'Update: this post now has 90,008 engagements, up from 29,425 when this Social Alert went out (3×).' + FOOTER);
    // The rule itself, and the line
    eq([B.watchSurge_(49999, 0), B.watchSurge_(50000, 0), B.watchSurge_(88274, 29425), B.watchSurge_(88275, 29425)], [false, true, false, true]);
    eq(B.watchSurgeLine_(152300, 48000), 'Update: this post now has 152,300 engagements, up from 48,000 when this Social Alert went out (3.1×).');
    eq(B.watchSurgeLine_(600000, 20000), 'Update: this post now has 600,000 engagements, up from 20,000 when this Social Alert went out (30×).');
  });

  test('watch sent alerts ON: with no count from Burson, the first count is the baseline (never itself a surge); the count is the higher of the post\'s own and Sonar\'s (BigQuery)', () => {
    let sonar = null;
    const asked = [];
    const { w } = seeded(1, { post: () => ({ platform: 'X', likes: 70000, replies: 8 }) }, { escalation: {} });
    const base = w.ctx;
    w.ctx = () => { const c = base(); c.bqEngagement = url => { asked.push(url); return sonar; }; return c; };
    w.run();
    eq([w.gmail.sentMessages().length, w.alertRows()[0].email_input.watch_state], [0, { baseline: 70008, last: 70008, milestones: [] }]);
    eq(asked, ['https://x.com/u1/status/100001']);
    sonar = 150000;   // Sonar sees more than X's likes + replies
    later(w, 30);
    eq([w.gmail.sentMessages().length, w.alertRows()[0].email_input.watch_state.last], [0, 150000]);  // not 3x 70,008
    sonar = 220000;
    later(w, 30);
    eq(w.gmail.sentMessages().map(m => [m.to, m.threadId, m.inReplyTo, m.subject, withoutPost(m.text)]), [[['tester@testing.test'], 'thw1',
      '<w1@mail.test>', 'Re: SOCIAL ALERT 1',
      'Update: this post now has 220,000 engagements, up from 70,008 when this Social Alert went out (3.1×).' + FOOTER]]);
  });

  test('watch sent alerts ON: a deleted post (X: not found) is checked again 10 minutes later, then one reply and one note; watching it ends there', () => {
    const w = watching({ drafts: STAND_IN });
    const { row } = sendWaymo(w);
    goneOnX(w, WAYMO);
    later(w, 30);
    eq([w.gmail.sentMessages().length, notes(w)], [1, []]);  // once isn't enough
    const entry = JSON.parse(memo(w, 'sent_watch'))[0];
    eq([entry.alive, entry.next - entry.gone], [1, 10 * MIN]);
    const fetched = xFetches(w, WAYMO);
    later(w, 5);
    eq(xFetches(w, WAYMO), fetched);  // not due yet
    const r = later(w, 5);
    eq(r.watch_updates, 1);
    const reply = w.gmail.sentMessages()[1];
    eq([reply.to, withoutPost(reply.text)], [['tester@testing.test'], 'Update: this post has been deleted or taken down (its link no longer shows it).' + FOOTER]);
    eq(notes(w), ['Update: this post has been deleted or taken down (its link no longer shows it).\n- I replied on the Social Alert\'s ' +
      'email thread (testing: only to the testers).']);
    const deleted = w.alertRows()[0].email_input.watch_state.deleted;
    assert.ok(deleted >= entry.gone + 10 * MIN && deleted <= w.g.clock.now, String(deleted));
    eq(memo(w, 'sent_watch'), '[]');
    for (let i = 0; i < 3; i++) later(w, 30);
    eq([w.gmail.sentMessages().length, xFetches(w, WAYMO)], [2, fetched + 2]);  // nothing re-checks it any more
    eq(row.alert_id, w.alertRows()[0].alert_id);
  });

  test('watch sent alerts ON: a post that fails once and is back 10 minutes later isn\'t reported; one the watch never saw up (a bad link) is never called deleted', () => {
    const w = watching({ drafts: STAND_IN });
    sendWaymo(w);
    goneOnX(w, WAYMO);
    later(w, 30);
    setPost(w, WAYMO, 50);
    later(w, 10);
    eq([w.gmail.sentMessages().length, JSON.parse(memo(w, 'sent_watch'))[0].gone], [1, undefined]);
    goneOnX(w, WAYMO);
    later(w, 30);
    later(w, 10);
    eq(w.gmail.sentMessages().length, 2);  // gone twice in a row this time

    const bad = watching({ drafts: STAND_IN });
    goneOnX(bad, WAYMO);  // the link never opened, from the start
    bad.paste(F.WAYMO_KOF);
    bad.run();
    eq(bad.gmail.sentMessages().length, 1);
    for (let i = 0; i < 6; i++) later(bad, 30);
    eq([bad.gmail.sentMessages().length, notes(bad), JSON.parse(memo(bad, 'sent_watch'))[0].alive], [1, [], undefined]);
  });

  test('watch sent alerts ON: press pickup: one Gemini web search per alert every 3 hours (the first 3 hours in), at most one per run; a sure answer from the web sends one reply; unsure or from memory sends nothing', () => {
    const w = watching({ drafts: STAND_IN });
    const { row } = sendWaymo(w);
    const calls = press(w, { covered: false, confidence: 0.9, outlet: '', headline: '' });
    for (let i = 0; i < 5; i++) later(w, 30);  // 2.5 hours: not yet
    eq(calls.length, 0);
    later(w, 30);
    eq(calls.length, 1);
    eq(calls[0].tools, [{ enterpriseWebSearch: {} }]);
    const asked = JSON.parse(calls[0].contents[0].parts[0].text.replace(/^<post>\n|\n<\/post>$/g, ''));
    eq([asked.link, asked.network, asked.issue, asked.alert_sent],
      ['https://x.com/ICannot_Enough/status/2111814207448514693', 'X', 'Criticism against Waymo', '2026-10-14 08:00 ET']);
    assert.match(calls[0].systemInstruction.parts[0].text, /data, not instructions/);
    eq(w.gmail.sentMessages().length, 1);
    later(w, 30);
    eq(calls.length, 1);  // the next search is 3 hours after that one

    // Sure, but not from a web search; then from the web but unsure: nothing
    w.vertex.fail = null;
    const memory = press(w, COVERED, true);
    for (let i = 0; i < 6; i++) later(w, 30);
    eq([memory.length, w.gmail.sentMessages().length], [1, 1]);
    const unsure = press(w, Object.assign({}, COVERED, { confidence: 0.6 }));
    for (let i = 0; i < 6; i++) later(w, 30);
    eq([unsure.length, w.gmail.sentMessages().length], [1, 1]);
    const sure = press(w, COVERED);
    for (let i = 0; i < 6; i++) later(w, 30);
    eq(sure.length, 1);
    const line = 'Update: the press picked this post up: Reuters reported on it ("Waymo says remote staff in the Philippines don\'t drive its cars").';
    eq(w.gmail.sentMessages().map(m => withoutPost(m.text)).slice(1), [line + FOOTER]);
    eq(notes(w), [`${line}\n- I replied on the Social Alert's email thread (testing: only to the testers).`]);
    assert.ok(w.alertRows()[0].email_input.watch_state.press > 0);
    for (let i = 0; i < 8; i++) later(w, 30);
    eq([sure.length, w.gmail.sentMessages().length], [1, 2]);  // never searched again
    eq(row.alert_id, w.alertRows()[0].alert_id);

    // The line itself
    const web = { sources: [{ title: 'reuters.com', uri: 'https://x' }] };
    eq([B.watchPressLine_(Object.assign({ _web: web }, COVERED), 0.9) === line, B.watchPressLine_(COVERED, 0.9),
      B.watchPressLine_(Object.assign({ _web: web }, COVERED, { outlet: ' ' }), 0.9), B.watchPressLine_(null, 0.9)], [true, '', '', '']);
  });

  test('watch sent alerts ON: without the web search there is no press check at all (no Gemini call), and two alerts due for one get one search per run', () => {
    const w = watching({ drafts: STAND_IN });
    w.bot.ev('GEN').settings.web_grounding = 'off';
    sendWaymo(w);
    const calls = press(w, COVERED);
    for (let i = 0; i < 12; i++) later(w, 30);
    eq([calls.length, w.gmail.sentMessages().length], [0, 1]);
    eq(B.ev('GEN').settings.web_grounding, 'enterprise');  // only that world's

    // Two watched alerts due for a press search in the same run: one search in that run, the other 30 minutes later
    const two = seeded(2).w;
    const twoCalls = press(two, { covered: false, confidence: 0, outlet: '', headline: '' });
    two.ctx().memo.set('sent_watch', JSON.stringify(['QA-1', 'QA-2'].map(id => ({ id, at: NOW, next: NOW + 3 * 3600e3 }))));
    two.g.clock.now = NOW + 3 * 3600e3;
    two.run();
    eq(twoCalls.length, 1);
    later(two, 30);
    eq(twoCalls.length, 2);
    later(two, 30);
    eq(twoCalls.length, 2);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Who gets the reply: the stand-in while testing; everyone the Social Alert went to only when live with no stand-in
  // ---------------------------------------------------------------------------------------------------------------

  test('watch sent alerts ON, the stand-in sandbox: a live draft a person sent still gets its update only to the stand-in while escalation.stand_in is set; with no stand-in anywhere, to everyone the email actually went to', () => {
    const run = standIn => {
      const w = watching({ drafts: LIVE });
      w.bot.ev('GEN').email.stand_in = standIn;
      setPost(w, P0, 10, 'WasSamLowryEsq');
      w.paste(F.P0_OK);
      w.run();
      const [draft] = w.gmail.allDrafts();
      const drop = draft.to.slice(-1);  // the IM took one address off before sending, and added someone
      const msgId = w.gmail.send(draft.id, 'im@ops.test', '<sent-p0@mail.test>', { drop, addCc: ['someone-new@ops.test'] });
      w.run();
      eq([w.alertRows()[0].email_status, w.alertRows()[0].email_message_id], ['sent', msgId]);
      setPost(w, P0, 80000, 'WasSamLowryEsq');
      later(w, 30);
      return { w, draft, drop, msgId, reply: w.gmail.sentMessages()[0] };
    };
    const testing = run('tester@testing.test');
    eq([testing.reply.to, testing.reply.cc, testing.reply.bcc], [['tester@testing.test'], [], []]);
    assert.ok(testing.reply.text.endsWith(FOOTER));
    eq(testing.w.gmail.sentMessages().length, 1);

    const live = run('');
    const { reply, draft, drop, msgId } = live;
    eq(reply.to, draft.to.filter(a => !drop.includes(a)));
    eq(reply.cc, draft.cc.concat(['someone-new@ops.test']));
    eq([reply.bcc, reply.from, reply.inReplyTo, reply.threadId, reply.subject],
      [[], 'Brand Social <sender@alerts.test>', msgId, draft.threadId, 'Re: ' + draft.subject]);
    eq(withoutPost(reply.text), 'Update: this post now has 80,008 engagements, up from 1 when this Social Alert went out.');  // no testing line
    eq(notes(live.w), ['Update: this post now has 80,008 engagements, up from 1 when this Social Alert went out.\n- I replied on ' +
      'the Social Alert\'s email thread.']);
    eq(live.w.bursonPosts(), []);
  });

  test('watch sent alerts ON: who the reply goes to in each flow: the Mirror space follows the run\'s mode (LIVE: the distros); a Testing run, the auto-correct space and a test space are never live (the mailbox, or the stand-in); bcc mode replies to the distros it was drafted with', () => {
    const w = watching({ drafts: LIVE });
    const GEN = w.bot.ev('GEN');
    GEN.email.stand_in = '';
    setPost(w, P0, 10, 'WasSamLowryEsq');
    w.paste(F.P0_OK);
    w.run();
    const [draft] = w.gmail.allDrafts();
    w.gmail.send(draft.id, 'im@ops.test', '<sent-p0@mail.test>');
    w.run();
    const row = w.alertRows()[0];
    const to = c => { const r = w.bot.watchRecipients_(c, row); return [r.to, r.cc, r.bcc]; };
    const ctx = extra => Object.assign(w.ctx(), extra);
    eq(to(ctx({})), [draft.to, draft.cc, []]);
    eq(to(ctx({ outboundBlocked: true })), [draft.to, draft.cc, []]);  // the Mirror space, the run LIVE
    eq(to(ctx({ sourceReadOnly: true })), [['im@ops.test'], [], []]);
    eq(to(ctx({ drafts: Object.assign({}, LIVE, { live: false }) })), [['im@ops.test'], [], []]);
    eq(to(ctx({ drafts: Object.assign({}, LIVE, { standIn: 'tester@testing.test' }) })), [['tester@testing.test'], [], []]);
    w.bot.setRunLive_(false);  // a Testing run (the Safety valve ON, or B26 set): never the distros, in the Mirror space neither
    eq([to(ctx({})), to(ctx({ outboundBlocked: true }))], [[['im@ops.test'], [], []], [['im@ops.test'], [], []]]);
    w.bot.setRunLive_(null);
    GEN.email.stand_in = 'tester@testing.test';
    eq(to(ctx({})), [['tester@testing.test'], [], []]);
    GEN.email.stand_in = '';
    w.bot.setRunLive_(true);
    GEN.email.recipients_in = 'bcc';
    const [bt, bc, bb] = to(ctx({}));
    eq([bt, bc], [draft.to, draft.cc]);
    assert.ok(bb.length > 0 && bb.includes(draft.to[0]));
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Budgets, time, idempotency and failures
  // ---------------------------------------------------------------------------------------------------------------

  /** n sent alerts on the watch list (rows in the log, threads in Gmail), each on its own post; `looked` records lookups. */
  function seeded(n, opts, input) {
    const looked = [];
    const w = watching(Object.assign({ drafts: STAND_IN, post: url => { looked.push(url); return { platform: 'X', likes: 10, replies: 0 }; } }, opts || {}));
    const c = w.ctx();
    for (let i = 1; i <= n; i++) {
      const thread = 'thw' + i;
      w.gmail.threads.set(thread, [{ id: 'gw' + i, threadId: thread, labelIds: ['SENT'], internalDate: String(NOW),
        payload: { headers: [{ name: 'Message-ID', value: `<w${i}@mail.test>` }, { name: 'To', value: 'tester@testing.test' },
          { name: 'Subject', value: `SOCIAL ALERT ${i}` }] } }]);
      w.backend.alerts.push({ alert_id: 'QA-' + i, created_at: NOW, space: `${w.BUR} > ${w.ANA}`, record_key: `x.com/status/10000${i}`,
        email_status: 'sent', email_thread: thread, email_message_id: `<w${i}@mail.test>`, email_subject: `SOCIAL ALERT ${i}`,
        email_at: NOW, email_sent_at: NOW, email_input: Object.assign({ fields: { post_url: `https://x.com/u${i}/status/10000${i}` },
          escalation: { engagement_total: 100 } }, input || {}) });
    }
    const store = c.store;
    for (let i = 1; i <= n; i++) w.bot.watchSentAlert_(c, store.alertById('QA-' + i));
    return { w, looked };
  }

  test('watch sent alerts ON: at most 3 alerts re-checked per run, each at most every 30 minutes (the longest-waiting first); a quiet run doesn\'t open the log sheet', () => {
    const { w, looked } = seeded(5);
    eq(JSON.parse(memo(w, 'sent_watch')).map(e => e.id), ['QA-1', 'QA-2', 'QA-3', 'QA-4', 'QA-5']);
    w.run();
    eq(looked.map(u => u.split('/').pop()), ['100001', '100002', '100003']);
    w.run();
    eq(looked.length, 5);
    const loads = w.storeLoads;
    w.run();
    later(w, 28);
    eq([looked.length, w.storeLoads], [5, loads]);  // nothing due: no lookups, and the log sheet isn't opened
    later(w, 2);
    eq(looked.slice(5).map(u => u.split('/').pop()), ['100001', '100002', '100003']);
    later(w, 0);
    eq(looked.length, 10);
    eq(w.gmail.sentMessages(), []);  // 10 engagements: nothing to report
  });

  test('watch sent alerts ON: an alert is watched for a day after its send, only while it is a sent Social Alert on file; the list keeps the newest 50; a newer alert on the same post takes the place of the older', () => {
    const { w, looked } = seeded(3);
    w.backend.alerts.splice(1, 1);  // QA-2's row is gone from the log
    w.backend.alerts[1].email_status = 'discarded';  // and QA-3 isn't a sent Social Alert (any more)
    w.run();
    eq([looked.length, JSON.parse(memo(w, 'sent_watch')).map(e => e.id)], [1, ['QA-1']]);
    w.g.clock.now = NOW + 24 * 3600e3 + MIN;
    w.run();
    eq([looked.length, memo(w, 'sent_watch')], [1, '[]']);  // a day on: dropped without a lookup

    const big = seeded(55);
    eq(JSON.parse(memo(big.w, 'sent_watch')).map(e => e.id).slice(0, 2), ['QA-6', 'QA-7']);
    eq(JSON.parse(memo(big.w, 'sent_watch')).length, 50);
    assert.ok(memo(big.w, 'sent_watch').length <= 8000);

    const same = seeded(2);
    const c = same.w.ctx();
    const newer = Object.assign({}, same.w.alertRows()[0], { alert_id: 'QA-9', email_thread: 'thw1' });
    same.w.backend.alerts.push(newer);
    same.w.bot.watchSentAlert_(c, c.store.alertById('QA-9'));
    eq(JSON.parse(memo(same.w, 'sent_watch')).map(e => e.id), ['QA-2', 'QA-9']);
    // No thread to reply on, or no link: not watched
    same.w.bot.watchSentAlert_(c, Object.assign({}, newer, { alert_id: 'QA-10', email_thread: '' }));
    same.w.bot.watchSentAlert_(c, Object.assign({}, newer, { alert_id: 'QA-11', email_input: { fields: {} }, forwarded_fields: {} }));
    eq(JSON.parse(memo(same.w, 'sent_watch')).map(e => e.id), ['QA-2', 'QA-9']);
  });

  test('watch sent alerts ON: the time budget: with under 45 s left the run doesn\'t watch at all; with under 30 s left no alert is checked (they wait, unchanged)', () => {
    const { w, looked } = seeded(2);
    const before = memo(w, 'sent_watch');
    const base = w.ctx;
    w.ctx = () => { const c = base(); c.deadline = w.g.clock.now + 44 * 1000; return c; };
    w.run();
    eq([looked.length, memo(w, 'sent_watch')], [0, before]);
    const c = base();
    c.deadline = w.g.clock.now + 29 * 1000;
    const report = { errors: [] };
    w.bot.watchSentAlerts_(c, report);
    eq([looked.length, memo(w, 'sent_watch'), report], [0, before, { errors: [] }]);
    w.ctx = base;
    w.run();
    eq(looked.length, 2);
  });

  test('watch sent alerts ON: never twice: the update is written on the row before the reply goes out; a row that can\'t be written sends nothing (tried again, then once); a lost watch list doesn\'t resend', () => {
    const { w } = seeded(1, { post: () => ({ platform: 'X', likes: 90000, replies: 0 }) });
    const update = w.backend.updateAlert.bind(w.backend);
    let failing = true;
    w.backend.updateAlert = (row, patch) => {
      if (failing && patch.email_input) throw new Error('Service Spreadsheets failed');
      if (patch.email_input) eq(w.gmail.sentMessages().length, 0);  // the state is on the row before anything is sent
      return update(row, patch);
    };
    const r = w.run();
    eq([w.gmail.sentMessages().length, r.errors, w.alertRows()[0].email_input.watch_state], [0, [], undefined]);
    assert.ok(w.g.logs.some(l => /couldn't re-check the sent Social Alert QA-1: Service Spreadsheets failed/.test(l)));
    failing = false;
    later(w, 30);
    eq(w.gmail.sentMessages().length, 1);
    eq(w.alertRows()[0].email_input.watch_state, { baseline: 100, last: 90000, milestones: [50000] });
    // The watch list is lost and the alert is put back on it (e.g. sent again from another flow): the row still says it
    w.ctx().memo.set('sent_watch', JSON.stringify([{ id: 'QA-1', at: w.g.clock.now, next: 0 }]));
    later(w, 30);
    eq(w.gmail.sentMessages().length, 1);
  });

  test('watch sent alerts ON: a reply Gmail refuses isn\'t retried (it could go out twice): the note asks the IM to send it, and it is a notice for the Control tab (not a retried error); nothing else breaks', () => {
    const w = watching({ drafts: STAND_IN });
    sendWaymo(w);
    w.gmail.fail = (method, path) => (method === 'post' && path === 'messages/send' ? { code: 500, body: { error: { message: 'Backend Error' } } } : null);
    setPost(w, WAYMO, 120000);
    const r = later(w, 30);
    eq([r.errors, r.watch_updates], [[], 1]);
    eq(r.notices, ['Couldn\'t send the update on the Social Alert thread for QA-1001: Gmail 500 on sending an email: Backend Error']);
    eq(notes(w), [`${SURGE_LINE}\n- <users/bot> I couldn't reply on the Social Alert's email thread (Gmail 500 on sending an ` +
      'email: Backend Error), so please send this update yourself.']);
    for (let i = 0; i < 3; i++) later(w, 30);
    eq(w.gmail.calls.filter(c => c.path === 'messages/send').length, 2);  // the Social Alert, and the one failed reply
    eq(notes(w).length, 1);
  });

  test('watch sent alerts ON: a lookup, BigQuery or the log sheet failing is logged and tried again in 30 minutes; nothing escapes into the run', () => {
    const w = watching({ drafts: STAND_IN, post: () => { throw new Error('X is down'); } });
    const base = w.ctx;
    let storeFails = false;
    w.ctx = () => {
      const c = base();
      c.bqEngagement = () => { throw new Error('BigQuery is down'); };
      const real = Object.getOwnPropertyDescriptor(c, 'store').get;
      Object.defineProperty(c, 'store', { get() {
        const s = real.call(c);
        if (storeFails) s.alertById = () => { throw new Error('the sheet is busy'); };
        return s;
      } });
      return c;
    };
    w.paste(F.WAYMO_KOF);
    const r = w.run();
    eq([r.drafts_sent, r.errors], [1, []]);
    eq(w.alertRows()[0].email_input.watch_state, { baseline: 11, milestones: [] });  // no count from anywhere
    storeFails = true;
    const r2 = later(w, 30);
    eq(r2.errors, []);
    assert.ok(w.g.logs.some(l => /couldn't re-check the sent Social Alert QA-1001: the sheet is busy/.test(l)));
    eq(JSON.parse(memo(w, 'sent_watch'))[0].next, w.g.clock.now + 30 * MIN);
    // Something unexpected in the watch itself (its list can't be saved): reported like its neighbours, and the run returns
    storeFails = false;
    w.g.clock.now += 30 * MIN;
    const c = w.ctx();
    const memoOf = c.memo;
    c.memo = { get: k => memoOf.get(k), set: (k, v) => { if (k === 'sent_watch') throw new Error('properties unavailable'); memoOf.set(k, v); } };
    const report = w.bot.runOnce_(c);
    eq(report.errors, ['watching sent Social Alerts: properties unavailable']);
    eq(w.gmail.sentMessages().length, 1);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Post.gs postGone_, BigQuery.gs bqPostEngagement_, the Control tab
  // ---------------------------------------------------------------------------------------------------------------

  test('Post.gs postGone_: X not found or a "deleted" notice, Bluesky NotFound, YouTube not found -> true; there -> false; anything unclear (an age-restricted notice, errors, other platforms) -> null; lookupPost_ is unchanged', () => {
    const w = world();
    const bot = w.bot;
    const x = 'https://x.com/ICannot_Enough/status/2111814207448514693';
    const p = (url, page) => { w.g.pages.set(url, page); return bot.postGone_(x); };
    w.g.pages.set(X_API(WAYMO), JSON.stringify(POSTS.x_original));
    eq(bot.postGone_(x), false);
    eq(p(X_API(WAYMO), { code: 404, body: '' }), true);
    eq(bot.lookupPost_(x), null);  // as before: nothing to tell "gone" from "unavailable"
    const tomb = text => JSON.stringify({ __typename: 'TweetTombstone', tombstone: { text: { text, entities: [], rtl: false } } });
    eq(p(X_API(WAYMO), tomb('This Post was deleted by the Post author. Learn more')), true);
    eq(p(X_API(WAYMO), tomb('This Post is from an account that no longer exists. Learn more')), true);
    eq(p(X_API(WAYMO), tomb('Age-restricted adult content. This content might not be appropriate for people under 18 years old.')), null);
    eq(p(X_API(WAYMO), { code: 503, body: 'overloaded' }), null);
    eq(p(X_API(WAYMO), { code: 429, body: '' }), null);

    const bs = 'https://bsky.app/profile/iwillnotbesilenced.bsky.social/post/3mobtlvo7ec25';
    const bapi = BSKY_API('iwillnotbesilenced.bsky.social', '3mobtlvo7ec25');
    w.g.pages.set(bapi, JSON.stringify(POSTS.bsky_video));
    eq(bot.postGone_(bs), false);
    w.g.pages.set(bapi, { code: 400, body: { error: 'NotFound', message: 'Post not found: at://…' } });
    eq(bot.postGone_(bs), true);
    w.g.pages.set(bapi, { code: 200, body: { thread: { $type: 'app.bsky.feed.defs#notFoundPost', uri: 'at://…', notFound: true } } });
    eq(bot.postGone_(bs), true);
    w.g.pages.set(bapi, { code: 400, body: { error: 'InvalidRequest', message: 'Unable to resolve handle' } });
    eq(bot.postGone_(bs), null);  // a renamed handle isn't a deleted post

    const yt = 'https://youtu.be/dQw4w9WgXcQ';
    const oembed = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    w.g.pages.set(oembed, JSON.stringify({ title: 'A video', author_name: 'Someone' }));
    eq(bot.postGone_(yt), false);
    w.g.pages.set(oembed, { code: 404, body: 'Not Found' });
    eq(bot.postGone_(yt), true);
    w.g.pages.set(oembed, { code: 401, body: 'Unauthorized' });
    eq(bot.postGone_(yt), null);  // private: not something the bot can tell apart from a removal
    eq([bot.postGone_('https://www.reddit.com/r/x/comments/abc/def/'), bot.postGone_(''), bot.postGone_(null)], [null, null, null]);
  });

  test('BigQuery.gs bqPostEngagement_: one small read of the post\'s count in Sonar (us-central1), never a write; null when off, missing or failing', () => {
    const w = world();
    const calls = [];
    let answer = { jobComplete: true, schema: { fields: [{ name: 'interactions', type: 'INTEGER' }] }, rows: [{ f: [{ v: '61234' }] }] };
    const orig = w.g.services.UrlFetchApp.fetch;
    w.g.services.UrlFetchApp.fetch = (url, params) => {
      if (url !== BQ) return orig(url, params);
      const body = JSON.parse(params.payload);
      calls.push(body);
      return { getResponseCode: () => (answer ? 200 : 500), getContentText: () => JSON.stringify(answer || { error: 'boom' }), getHeaders: () => ({}) };
    };
    const S = w.bot.ev('GEN').settings;
    eq(w.bot.bqPostEngagement_('https://x.com/ICannot_Enough/status/2111814207448514693', S), 61234);
    const [q] = calls;
    eq(q.location, 'us-central1');
    assert.match(q.query, /^SELECT MAX\(IFNULL\(engagement_likes, 0\)\) \+ MAX\(IFNULL\(engagement_comments, 0\)\) \+ MAX\(IFNULL\(engagement_shares, 0\)\) AS interactions\nFROM `bsip-s-bsip-gg-26-2cf3\.google_bg\.sonar_raw`/);
    assert.ok(!/insert|update|delete|merge/i.test(q.query.replace(/last_received_at/g, '')));
    eq(q.queryParameters.map(p => [p.name, p.parameterValue.value]), [['url', 'https://x.com/ICannot_Enough/status/2111814207448514693'], ['post_id', WAYMO], ['hours', '24']]);
    answer = { jobComplete: true, schema: { fields: [{ name: 'interactions', type: 'INTEGER' }] }, rows: [] };
    eq(w.bot.bqPostEngagement_('https://x.com/a/status/123456', S), null);
    answer = null;
    eq(w.bot.bqPostEngagement_('https://x.com/a/status/123456', S), null);
    const n = calls.length;
    eq([w.bot.bqPostEngagement_('https://x.com/a/status/123456', Object.assign({}, S, { bq_enrich: false })),
      w.bot.bqPostEngagement_('https://x.com/a/status/123456', Object.assign({}, S, { bq_bsip_enrich: false })), w.bot.bqPostEngagement_('', S)],
    [null, null, null]);
    eq(calls.length, n);
    // The run's ctx has it (Main.gs buildCtx_)
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    eq(typeof t.bot.buildCtx_({ burson: { id: TEST_FEED, name: 'Feed' }, analyst: { id: TRIAGED, name: 'Analysts' } }, t.sheet()).bqEngagement, 'function');
  });

  test('watch sent alerts ON, end to end with the Control tab (row 18 ON): the surge reply goes to the stand-in on the Social Alert thread, and C18 says what the watch is doing', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.control().getRange(18, 2).setValue('ON');
    setPost(t, WAYMO, 46);
    t.chat.say(TEST_FEED, F.WAYMO_KOF, { sender: 'users/bot' });
    t.poll();
    const [alert] = t.g.gmail.sentMessages();
    eq(alert.to, ['tester@testing.test']);
    assert.match(t.control().cell(18, 3), /^✓ ON \(testing: the updates go only to the testers in B30\): re-checks sent alerts every 30 min for a day \(engagement surge, deleted post, press pickup\) · watching 1 sent alert · last check Oct 14, 8:01 AM EDT · 0 updates today$/);
    setPost(t, WAYMO, 120000);
    t.g.clock.now += 29 * MIN;
    t.poll();
    const sent = t.g.gmail.sentMessages();
    eq(sent.length, 2);
    eq([sent[1].to, sent[1].cc, sent[1].bcc, sent[1].threadId, sent[1].inReplyTo, withoutPost(sent[1].text)],
      [['tester@testing.test'], [], [], alert.threadId, alert.messageId, 'Update: this post now has 120,008 engagements, up from 11 when this Social Alert went out.' + FOOTER]);
    assert.match(t.control().cell(18, 3), / · watching 1 sent alert · last check Oct 14, 8:31 AM EDT · 1 update today$/);
    const note = t.chat.botPosts(TRIAGED).find(m => /^Update: this post now has 120,008/.test(m.text));
    assert.ok(note && note.threadReply);
    eq(t.chat.botPosts(TEST_FEED), []);
    for (let i = 0; i < 3; i++) { t.g.clock.now += 30 * MIN; t.poll(); }
    eq(t.g.gmail.sentMessages().length, 2);
    eq(B.switchStatusTexts_({ watchSent: true }, '', {}, NOW)[7],
      '✓ ON: re-checks sent alerts every 30 min for a day and replies on their email thread (engagement surge, deleted post, press pickup)');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Regressions
  // ---------------------------------------------------------------------------------------------------------------

  /** Live, no stand-in: F.P0_OK drafted, then sent by the IM (opts as for gmail.send); the world and the draft. */
  const liveSent = opts => {
    const w = watching({ drafts: LIVE });
    w.bot.ev('GEN').email.stand_in = '';
    setPost(w, P0, 10, 'WasSamLowryEsq');
    w.paste(F.P0_OK);
    w.run();
    const [draft] = w.gmail.allDrafts();
    w.gmail.send(draft.id, 'im@ops.test', '<sent-p0@mail.test>', opts);
    w.run();
    eq(w.alertRows()[0].email_status, 'sent');
    return { w, draft };
  };

  test('watch sent alerts ON, live: when Gmail can\'t say who the Social Alert went to (its thread can\'t be read, or is gone), no reply goes out (never to the distros it was drafted with): the note asks the IM to send it, once', () => {
    ['unreadable', 'gone'].forEach(how => {
      const { w, draft } = liveSent({ drop: [] });
      const kept = draft.to.slice(0, 1);
      w.gmail.threads.get(draft.threadId).forEach(m => m.payload.headers.forEach(h => {  // the IM sent it to one address
        if (h.name === 'To') h.value = kept.join(', ');
        if (h.name === 'Cc') h.value = '';
      }));
      if (how === 'unreadable') {
        const busy = { code: 503, body: { error: { message: 'Backend Error' } } };
        w.gmail.fail = (method, path) => (method === 'get' && /^threads\//.test(path) ? busy : null);
      } else {
        w.gmail.threads.delete(draft.threadId);
      }
      setPost(w, P0, 80000, 'WasSamLowryEsq');
      const r = later(w, 30);
      const sends = w.gmail.calls.filter(c => c.path === 'messages/send').length;
      eq([w.gmail.sentMessages(), sends, r.errors, r.watch_updates], [[], 0, [], 1], how);
      eq(notes(w), ['Update: this post now has 80,008 engagements, up from 1 when this Social Alert went out.\n- <users/bot> I couldn\'t ' +
        'reply on the Social Alert\'s email thread (couldn\'t read who the Social Alert went to in Gmail), so please send this update yourself.'], how);
      eq(r.notices, ['Couldn\'t send the update on the Social Alert thread for QA-1001: couldn\'t read who the Social Alert went ' +
        'to in Gmail'], how);
      assert.ok(w.g.logs.some(l => /couldn't read the Social Alert thread for QA-1001/.test(l)) || how === 'gone', how);
      for (let i = 0; i < 3; i++) later(w, 30);  // never retried
      eq([w.gmail.sentMessages().length, notes(w).length], [0, 1], how);
    });
    // Read: the reply goes to the one address it was sent to (not the distros it was drafted with)
    const { w, draft } = liveSent({ drop: [] });
    w.gmail.threads.get(draft.threadId).forEach(m => m.payload.headers.forEach(h => {
      if (h.name === 'To') h.value = draft.to[0];
      if (h.name === 'Cc') h.value = '';
    }));
    setPost(w, P0, 80000, 'WasSamLowryEsq');
    later(w, 30);
    eq(w.gmail.sentMessages().map(m => [m.to, m.cc, m.bcc]), [[[draft.to[0]], [], []]]);
  });

  test('watch sent alerts ON, live: a follow-up Social Alert still a draft on the thread holds the update (the note asks the IM to add it): a draft the IM then deletes is ❌ discarded, not taken as sent; one the IM sends is its own send', () => {
    const P0B = '2109952063492999999';
    ['discard', 'send'].forEach(mode => {
      const { w, draft: d1 } = liveSent();
      const qa1 = w.alertRows()[0];
      // 40 minutes later, a follow-up on the same issue (another post) is drafted as a reply on the Social Alert's thread
      w.g.clock.now += 40 * MIN;
      setPost(w, P0B, 4200, 'AnotherUser');
      w.paste(F.P0_OK.replace('https://x.com/WasSamLowryEsq/status/2109952063492993159', `https://x.com/AnotherUser/status/${P0B}`)
        .replace('VERY LOW (1 engagements)', 'HIGH (4200 engagements)').replace(',1,WasSamLowryEsq,', ',4200,AnotherUser,'));
      w.run();
      const qa2 = w.alertRows()[w.alertRows().length - 1];
      const [d2] = w.gmail.allDrafts();
      eq([qa2.alert_id, qa2.email_status, qa2.email_thread, qa2.email_reply_to, d2.threadId],
        ['QA-1002', 'drafted', d1.threadId, qa1.email_message_id, d1.threadId], mode);
      // The post surges: nothing goes on the thread while the follow-up is a draft there
      setPost(w, P0, 80000, 'WasSamLowryEsq');
      w.g.clock.now += 31 * MIN;
      const r = w.run();
      eq([w.gmail.sentMessages(), r.errors, r.watch_updates], [[], [], 1], mode);
      eq(notes(w), ['Update: this post now has 80,008 engagements, up from 1 when this Social Alert went out.\n- <users/bot> I didn\'t ' +
        'reply on the Social Alert\'s email thread because the follow-up Social Alert QA-1002 isn\'t sent yet, so please add this ' +
        'update to it, or send it yourself.'], mode);
      eq(w.alertRows()[0].email_input.watch_state.milestones, [50000], mode);  // never sent later on its own
      if (mode === 'discard') w.gmail.discard(d2.id);
      else w.gmail.send(d2.id, 'im@ops.test', '<sent-qa2@mail.test>');
      w.g.clock.now += 5 * MIN;
      const r2 = w.run();
      const row = w.alertRows().find(a => a.alert_id === 'QA-1002');
      if (mode === 'discard') {
        eq([row.email_status, row.email_message_id || '', r2.drafts_sent], ['discarded', '', 0]);
        eq(w.chat.botReactions(row.forward_message), ['❌']);
        eq(JSON.parse(memo(w, 'sent_watch')).map(e => e.id), ['QA-1001']);
      } else {
        eq([row.email_status, row.email_message_id, row.email_sent_by, r2.drafts_sent],
          ['sent', '<sent-qa2@mail.test>', 'im@ops.test', 1]);
      }
      for (let i = 0; i < 3; i++) later(w, 30);
      eq([w.gmail.sentMessages(), notes(w).length], [[], 1], mode);
    });
    // Only a draft the draft check still waits on holds the update (not one it gave up on, e.g. too old)
    [false, true].forEach(waiting => {
      const { w } = seeded(1, { post: () => ({ platform: 'X', likes: 90000, replies: 0 }) });
      w.gmail.drafts.set('d8', { id: 'd8', threadId: 'thw1', messageId: 'gm8', raw: '' });
      w.backend.alerts.push(Object.assign({}, w.alertRows()[0], { alert_id: 'QA-8', email_status: 'drafted', email_draft: 'd8',
        email_reply_to: '<w1@mail.test>', email_input: {} }));
      if (waiting) w.ctx().memo.set('open_drafts', JSON.stringify(['QA-8']));
      w.run();
      eq(w.gmail.sentMessages().map(m => m.threadId), waiting ? [] : ['thw1'], String(waiting));
    });
  });

  test('watch sent alerts ON: a newer alert on the same post that goes out on the same thread doesn\'t repeat the press pickup the earlier one reported there; on another thread it can', () => {
    const run = thread => {
      const { w } = seeded(1);
      const c = w.ctx();
      const qa1 = c.store.alertById('QA-1');
      c.store.updateAlert(qa1, { email_input: Object.assign({}, qa1.email_input, { watch_state: { baseline: 100, last: 10, milestones: [],
        press: NOW + 3 * 3600e3 } }) });
      if (thread !== 'thw1') w.gmail.threads.set(thread, [{ id: 'gw9', threadId: thread, labelIds: ['SENT'], internalDate: String(NOW),
        payload: { headers: [{ name: 'Message-ID', value: '<w9@mail.test>' }, { name: 'To', value: 'tester@testing.test' }] } }]);
      w.g.clock.now = NOW + 4 * 3600e3;
      w.backend.alerts.push(Object.assign({}, qa1, { alert_id: 'QA-9', email_thread: thread, email_message_id: '<w9@mail.test>',
        email_sent_at: w.g.clock.now, email_input: { fields: qa1.email_input.fields, escalation: { engagement_total: 100 } } }));
      w.bot.watchSentAlert_(c, c.store.alertById('QA-9'));
      const calls = press(w, COVERED);
      for (let i = 0; i < 9; i++) later(w, 30);  // past QA-9's first press check (3 hours in)
      return { w, calls };
    };
    const same = run('thw1');
    eq(JSON.parse(memo(same.w, 'sent_watch')).map(e => [e.id, e.done]), [['QA-9', ['press']]]);
    eq([same.calls.length, same.w.gmail.sentMessages(), notes(same.w)], [0, [], []]);
    const other = run('thw9');
    eq([other.calls.length, other.w.gmail.sentMessages().map(m => m.threadId)], [1, ['thw9']]);
  });

  test('watch sent alerts ON: turned on after Social Alerts went out, the ones sent in the last day are watched too: one per post (its newest), not one sent over a day ago, not a draft, not one whose post the watch saw deleted; the Alert log is read for them at most every 3 hours', () => {
    const sw = B.switchesOff_();
    const looked = [];
    const post = url => { looked.push(url.split('/').pop()); return { platform: 'X', likes: 90000, replies: 0 }; };
    const w = withSwitches(world({ drafts: STAND_IN, post }), sw);
    const row = (id, post, at, extra) => {
      const thread = 'th' + id;
      w.gmail.threads.set(thread, [{ id: 'g' + id, threadId: thread, labelIds: ['SENT'], internalDate: String(at),
        payload: { headers: [{ name: 'Message-ID', value: `<${id}@mail.test>` }, { name: 'To', value: 'tester@testing.test' }] } }]);
      w.backend.alerts.push(Object.assign({ alert_id: id, created_at: at, space: `${w.BUR} > ${w.ANA}`,
        record_key: `x.com/status/${post}`, email_status: 'sent', email_thread: thread, email_message_id: `<${id}@mail.test>`,
        email_subject: `SOCIAL ALERT ${id}`, email_at: at, email_sent_at: at,
        email_input: { fields: { post_url: `https://x.com/u/status/${post}` }, escalation: { engagement_total: 100 } } }, extra || {}));
    };
    const H_ = 3600e3;
    row('QA-1', 200001, NOW - 25 * H_);     // sent over a day ago
    row('QA-2', 200002, NOW - 5 * H_);      // an older alert on the post QA-3 is about
    row('QA-3', 200002, NOW - 2 * H_);
    row('QA-4', 200004, NOW - 3 * H_, { email_input: { fields: { post_url: 'https://x.com/u/status/200004' },
      escalation: { engagement_total: 100 }, watch_state: { baseline: 100, milestones: [], deleted: NOW - H_ } } });
    row('QA-5', 200005, NOW - H_, { email_status: 'drafted' });
    row('QA-6', 200006, NOW - 4 * H_);
    w.run();  // the switch is OFF: nothing
    eq([memo(w, 'sent_watch'), looked], [null, []]);
    sw.watchSent = true;
    const r = w.run();
    const seededAt = w.g.clock.now;
    eq(JSON.parse(memo(w, 'sent_watch')).map(e => e.id), ['QA-6', 'QA-3']);
    eq([looked, r.watch_updates, w.gmail.sentMessages().map(m => m.threadId)], [['200006', '200002'], 2, ['thQA-6', 'thQA-3']]);
    const loads = w.storeLoads;
    later(w, 1);
    eq(w.storeLoads, loads);  // nothing due: the log sheet isn't opened
    // Turned OFF and back ON: the alert sent meanwhile is found at the next look (3 hours after the last); nothing goes twice
    sw.watchSent = false;
    row('QA-7', 200007, w.g.clock.now);
    later(w, 10);
    sw.watchSent = true;
    for (let i = 0; i < 5; i++) later(w, 30);
    eq(JSON.parse(memo(w, 'sent_watch')).map(e => e.id), ['QA-6', 'QA-3']);
    w.g.clock.now = seededAt + 3 * H_;
    w.run();
    eq(JSON.parse(memo(w, 'sent_watch')).map(e => e.id), ['QA-6', 'QA-3', 'QA-7']);
    eq(w.gmail.sentMessages().map(m => m.threadId), ['thQA-6', 'thQA-3', 'thQA-7']);
  });

  test('watch sent alerts ON: the auto-correct space\'s own watch doesn\'t write C18 (it shows the main run\'s figures)', () => {
    const { w } = seeded(1);
    const notesNow = () => JSON.parse(w.g.props.get('SWITCH_NOTES') || '{}').watchSent;
    const ac = Object.assign(w.ctx(), { sourceReadOnly: true });
    w.bot.watchSentAlerts_(ac, { errors: [] });
    eq([notesNow(), JSON.parse(memo(w, 'sent_watch'))[0].next > NOW], [undefined, true]);
    w.ctx().memo.set('sent_watch', JSON.stringify([{ id: 'QA-1', at: NOW, next: 0 }]));
    w.bot.watchSentAlerts_(w.ctx(), { errors: [] });
    assert.match(notesNow().text, /^watching 1 sent alert · last check /);
  });
};
