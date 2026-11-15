// Early detection (clusters & velocity) (Control row 19, earlyWave -> BigQuery.gs earlyWaveCheck_ & EarlyDetection.gs):
// Open-world, topic-agnostic early-warning layer replacing the legacy Pendulum earlyWaveSql_ + CacheService rise check.
// Casts a wide net over low-tier mentions (Cap 1: Vertex AI semantic embedding clusters; Cap 2: multi-grain velocity
// spikes across CLUSTER, RISK_TERM_GROUP, PRIORITY_TOPIC) without reusing ProactiveWatch / WatchAlerts / OtherAlerts.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, NOW, world, makeGoogle, loadBot, TEST_FEED, TRIAGED, REAL } = H;
  const e2e = (...args) => {
    const t = H.e2e(...args);
    const origRows = t.bot.bqEarlyDetectionRows_;
    t.bot.bqEarlyDetectionRows_ = minutes => {
      if (!t.g._edHook) return origRows(minutes);
      return t.g._edHook(minutes);
    };
    return t;
  };
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0xff, 0xd9]);
  const embed = id => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${B.xEmbedToken_(id)}`;
  const REDDIT_URL = 'https://www.reddit.com/r/GooglePixel/comments/1k9xyz/dialer_freeze/';
  const GROUNDING_URI = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc123';

  const ROW = 19;
  const LOOKBACK_ROW = 31;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const MIRROR = 'spaces/AAQAmirrorEd1';
  const MIRROR_NAME = 'SLRR Zapier Training Mirror';
  const COPY = 'spaces/AAQAcopyEd1';
  const COPY_NAME = 'Burson Relay Test Copy';
  const ROOM = 'https://chat.google.com/room/AAQAaa_0I9g'; // live S-F Burson
  const ON_TEXT = '✓ ON: every 15 min, groups new low-reach posts from the BigQuery source tables into stories itself and ' +
    'sends story clusters and velocity spikes for full triage';
  const OFF_TEXT = 'OFF (one post at a time)';

  const COLS = [
    ['alert_id'], ['created_utc'], ['signal_type'], ['velocity_grain'], ['cluster_id'], ['signal_key'],
    ['headline'], ['topic_product'], ['priority_hint'], ['unique_low_tier_authors', 'INTEGER'],
    ['mention_count', 'INTEGER'], ['platform_count', 'INTEGER'], ['platforms_csv'],
    ['baseline_authors', 'FLOAT'], ['velocity_ratio', 'FLOAT'], ['absolute_author_delta', 'FLOAT'],
    ['primary_url'], ['representative_posts_json'], ['chatbot_card_text'],
  ];

  const CLUSTER_URL = 'https://x.com/pixelowner1/status/2140000000000000001';
  const VELOCITY_URL = 'https://www.reddit.com/r/Android/comments/1k9abc0/update_locked_vault/';
  const NOISE_URL = 'https://x.com/astrofan9/status/2140000000000000009';

  const clusterRow = o => Object.assign({
    alert_id: 'ED-CLU-20261014-001',
    created_utc: '2026-10-14 12:00 UTC',
    signal_type: 'CLUSTER_EMERGENCE',
    velocity_grain: '',
    cluster_id: 'clu_8f91a2',
    signal_key: 'clu_8f91a2',
    headline: 'Multiple users report Pixel 9 emergency dialer freezing after overnight update',
    topic_product: 'Unclassified',
    priority_hint: 'P1',
    unique_low_tier_authors: 9,
    mention_count: 11,
    platform_count: 3,
    platforms_csv: 'X, Reddit, Owned Social',
    baseline_authors: 0,
    velocity_ratio: 0,
    absolute_author_delta: 9,
    primary_url: CLUSTER_URL,
    representative_posts_json: JSON.stringify([
      { platform: 'X', author_handle: 'pixelowner1', followers: 410, engagement_total: 18,
        published_at: '2026-10-14 11:42 UTC', url: CLUSTER_URL,
        snippet: 'Overnight update froze the emergency dialer screen completely on my phone.' },
      { platform: 'Reddit', author_handle: 'u_droidcommuter', followers: null, engagement_total: 14,
        published_at: '2026-10-14 11:49 UTC', url: 'https://www.reddit.com/r/GooglePixel/comments/1k9xyz/dialer_freeze/',
        snippet: 'Same thing here after the October patch, emergency call button hangs for 30 seconds.' },
      { platform: 'Instagram', author_handle: 'westcoast_dad', followers: 620, engagement_total: 7,
        published_at: '2026-10-14 11:55 UTC', url: 'https://www.instagram.com/p/DBabc123/',
        snippet: 'Anyone else seeing phone dialer lock up right after installing last night\'s update?' },
    ]),
    chatbot_card_text: '',
  }, o || {});

  const velocityRow = o => Object.assign({
    alert_id: 'ED-VEL-CLUSTER-9912-202610141200',
    created_utc: '2026-10-14 12:00 UTC',
    signal_type: 'VELOCITY_SPIKE',
    velocity_grain: 'CLUSTER',
    cluster_id: 'clu_vault_lock',
    signal_key: 'clu_vault_lock',
    headline: 'Low-tier velocity 5.4x (CLUSTER: Photos locked folder disappearing)',
    topic_product: 'Photos',
    priority_hint: 'P1',
    unique_low_tier_authors: 12,
    mention_count: 15,
    platform_count: 2,
    platforms_csv: 'Reddit, X',
    baseline_authors: 2.2,
    velocity_ratio: 5.4,
    absolute_author_delta: 9.8,
    primary_url: VELOCITY_URL,
    representative_posts_json: JSON.stringify([
      { platform: 'Reddit', author_handle: 'photo_archiver', followers: null, engagement_total: 22,
        published_at: '2026-10-14 11:50 UTC', url: VELOCITY_URL,
        snippet: 'My Locked Folder in Photos looks completely empty after syncing this morning.' },
      { platform: 'X', author_handle: 'cameraroll_uk', followers: 880, engagement_total: 11,
        published_at: '2026-10-14 11:54 UTC', url: 'https://x.com/cameraroll_uk/status/2140000000000000002',
        snippet: 'Did Photos wipe Locked Folder backups or is sync down right now?' },
    ]),
    chatbot_card_text: '',
  }, o || {});

  function fakeBq(g, answer) {
    const calls = [];
    calls.all = [];
    const orig = g.services.UrlFetchApp.fetch;
    const resp = (code, body) => ({
      getResponseCode: () => code,
      getHeaders: () => ({}),
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    g._edHook = minutes => {
      const clamped = Math.min(180, Math.max(15, Math.round(Number(minutes)) || 60));
      const call = {
        url: 'https://bigquery.googleapis.com/bigquery/v2/projects/brand-social-central-data/queries',
        location: 'US',
        sql: 'SELECT signal_type, velocity_grain /* EarlyWaveSource */',
        params: { minutes: String(clamped), max_rows: '25' },
        types: { minutes: 'INT64', max_rows: 'INT64' },
      };
      calls.push(call);
      const a = answer(call);
      if (a && a.code) {
        const msg = (a.body && a.body.error && a.body.error.message) || String(a.body || 'Error');
        throw new Error(`BigQuery HTTP ${a.code}: ${msg}`);
      }
      if (a && a.timeout) throw new Error('BigQuery: query did not finish in time');
      return (a && a.rows) || [];
    };
    g.services.UrlFetchApp.fetch = (link, params) => {
      calls.all.push([String((params && params.method) || 'get'), link, (params && params.payload) || '']);
      if (!link.startsWith('https://bigquery.googleapis.com/')) return orig(link, params);
      const body = JSON.parse(params.payload);
      const call = {
        url: link,
        location: body.location || 'US',
        sql: body.query || '',
        params: Object.fromEntries((body.queryParameters || []).map(p => [p.name, p.parameterValue.value])),
        types: Object.fromEntries((body.queryParameters || []).map(p => [p.name, p.parameterType.type])),
      };
      calls.push(call);
      const a = answer(call);
      if (!a) return resp(200, { jobComplete: true, schema: { fields: [['url']].map(c => ({ name: c[0], type: 'STRING' })) }, rows: [] });
      if (a.code) return resp(a.code, a.body || 'Error');
      if (a.timeout) return resp(200, { jobComplete: false });
      const cols = a.cols || COLS;
      return resp(200, {
        jobComplete: true,
        schema: { fields: cols.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: (a.rows || []).map(r => ({
          f: cols.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })),
        })),
      });
    };
    return calls;
  }

  const isEdQuery = c => /SELECT[\s\S]+signal_type[\s\S]+velocity_grain/.test(c.sql);
  const edQueries = calls => calls.filter(isEdQuery);
  const routes = rows => c => {
    if (!isEdQuery(c)) return null;
    const v = typeof rows === 'function' ? rows(c) : rows;
    if (v && !Array.isArray(v)) return v;
    return { cols: COLS, rows: v || [] };
  };

  const switchOn = (t, v) => t.control().getRange(ROW, 2).setValue(v || 'ON');
  const ready = t => { t.bot.setup(); t.set('B30', 'tester@testing.test'); t.chat.addDm('tester@testing.test', 'spaces/DMSTANDIN'); return t; };
  const note = t => t.control().cell(ROW, 3);
  const lastRun = t => JSON.parse(t.g.props.get('LAST_RUN'));
  const edProps = g => Array.from(g.props.keys()).filter(k => /^(?:EARLY_DETECTION_|ED_ALERT_)/.test(k)).sort();
  const edCards = (chat, space) => chat.botPosts(space).filter(m => !m.threadReply && /^client-zeda-/.test(m.clientAssignedMessageId || ''));

  // ===========================================================================================================
  // 1. Switch OFF no-op parity & legacy row upgrade to OFF
  // ===========================================================================================================

  test('early detection OFF: poll() is an exact no-op for early detection (zero queries, zero properties, zero cards) and upgrades legacy row 19 to OFF', () => {
    const runOff = takenOut => {
      const t = ready(e2e());
      let called = 0;
      if (takenOut) t.bot.earlyWaveCheck_ = () => { called++; return null; };
      const calls = fakeBq(t.g, routes([clusterRow(), velocityRow()]));
      t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
      t.poll();
      t.g.clock.now += 15 * MIN;
      t.chat.say(TEST_FEED, F.NO_LINK, { sender: 'users/bot' });
      t.poll();
      const snap = JSON.stringify({
        chat: Array.from(t.chat.spaces.values()).map(s => [s.name, s.messages.map(m => [m.name, m.text, m.thread.name,
          m.clientAssignedMessageId || '', m.reactions])]),
        sheets: t.sheet().sheets.map(sh => [sh.name, sh.rows]),
        sent: t.g.gmail.sentMessages(),
        drafts: t.g.gmail.allDrafts(),
        fetches: calls.all,
        props: Array.from(t.g.props).filter(([k]) => k !== 'LAST_RUN'),
        lastRun: Object.assign(lastRun(t), { at: '' }),
        logs: t.g.logs,
      });
      return { t, calls, snap, called: () => called };
    };
    const off = runOff(false);
    const without = runOff(true);
    assert.strictEqual(off.snap, without.snap);
    eq(without.called(), 0);
    eq(edQueries(off.calls), []);
    eq(edProps(off.t.g), []);
    eq([edCards(off.t.chat, TEST_FEED), edCards(off.t.chat, TRIAGED), off.t.chat.botPosts(REAL)], [[], [], []]);
    assert.strictEqual(note(off.t), OFF_TEXT);
    eq(lastRun(off.t).errors, []);

    // A pre-switch Control tab without row 19 gets it safely initialized to OFF when upgraded
    const legacy = e2e();
    legacy.bot.setup();
    legacy.control().getRange(ROW, 1, 1, 3).setValues([['• old help text', 'ON', 'old note']]);
    legacy.bot.ensureControlTab_(legacy.sheet(), 'tester@testing.test');
    eq([legacy.control().cell(ROW, 1), legacy.control().cell(ROW, 2), legacy.control().cell(ROW, 3)],
      ['Early wave & velocity check', 'OFF', OFF_TEXT]);
  });

  // ===========================================================================================================
  // 2. Parameterized SQL, view validation, card formatting & Burson leak-guard compliance
  // ===========================================================================================================

  test('early detection SQL & cards: EarlyWaveSource parameterized US & us-central1 queries use only the 6 approved tables, clamp B31 lookback, format unknown clusters & multi-grain velocity with zero leak-guard hits, and ignore non-bot copies', () => {
    const usQ = B.ewsLaneQuery_('us', { marks: {} }, Date.UTC(2026, 9, 14, 12, 0), true, 30);
    const c1Q = B.ewsLaneQuery_('c1', { marks: {} }, Date.UTC(2026, 9, 14, 12, 0), true, 30);
    assert.ok(usQ.sql.includes('`brand-social-central-data.reporting_data.sprinklr_inbound_comments`'));
    assert.ok(usQ.sql.includes('`brand-social-central-data.raw_data.brandwatch_raw_mentions_base`'));
    assert.ok(usQ.sql.includes('`brand-social-central-data.reporting_data.sprinklr_outbound_reporting`'));
    assert.ok(usQ.sql.includes('`brand-social-central-data.DSD.DSD-story-selection`'));
    assert.ok(!/bsip-s-bsip-gg-26-2cf3|tubular_videos|vw_chatbot_pending_early_alerts/.test(usQ.sql), usQ.sql);
    assert.ok(c1Q.sql.includes('`bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`'));
    assert.ok(c1Q.sql.includes('`brand-social-central-data.google_tubular_mentions.tubular_videos`'));
    assert.ok(!/reporting_data|raw_data|DSD|vw_chatbot_pending_early_alerts/.test(c1Q.sql), c1Q.sql);
    eq(usQ.win.until - usQ.win.since, 30 * MIN);
    eq(c1Q.win.until - c1Q.win.since, 30 * MIN);

    // Lookback: B31 on the first check; afterwards everything since 20 min before the last check (never < B31, <= 180)
    const T0 = Date.UTC(2026, 9, 14, 12, 0);
    eq([
      B.edLookbackMinutes_({ bq_lookback_minutes: 15 }, 0, T0),
      B.edLookbackMinutes_({ bq_lookback_minutes: 15 }, T0 - 16 * MIN, T0),
      B.edLookbackMinutes_({ bq_lookback_minutes: 60 }, T0 - 16 * MIN, T0),
      B.edLookbackMinutes_({ bq_lookback_minutes: 15 }, T0 - 5 * HOUR, T0),
      B.edLookbackMinutes_({ bq_lookback_minutes: 30 }, T0 + MIN, T0),
    ], [15, 36, 60, 180, 30]);

    // The view's own representative_posts struct (TO_JSON_STRING of mention_id, platform, author_id, audience_size,
    // engagement, posted_at, url, snippet) gives the card its handle, audience, interactions and post time
    const liveCard = B.edAlertCardText_(clusterRow({ representative_posts_json: JSON.stringify([
      { mention_id: 'm1', platform: 'X', author_id: 'pixelowner1', audience_size: 410, engagement: 18,
        posted_at: '2026-10-14T11:42:00Z', url: CLUSTER_URL, snippet: 'Overnight update froze the emergency dialer screen.' },
      { mention_id: 'm2', platform: 'Reddit', author_id: 'u_droidcommuter', audience_size: null, engagement: 14,
        posted_at: '2026-10-14T11:49:00Z', url: 'https://www.reddit.com/r/GooglePixel/comments/1k9xyz/dialer_freeze/',
        snippet: 'Same thing here after the October patch.' },
    ]) }));
    ['• *Handle:* pixelowner1', '• *Audience:* 410', '• *Interactions:* 18', '• *Captured:* 2026-10-14T11:42:00Z']
      .forEach(s => assert.ok(liveCard.includes(s), s + '\n' + liveCard));
    assert.ok(!B.detectAlert_(liveCard, B.parseAlert_(liveCard), ''));

    const card1 = B.edAlertCardText_(clusterRow());
    const card2 = B.edAlertCardText_(velocityRow({ velocity_grain: 'RISK_TERM_GROUP', signal_key: 'outage_broken_feature' }));
    const card3 = B.edAlertCardText_(velocityRow({ velocity_grain: 'PRIORITY_TOPIC', signal_key: 'Pixel' }));
    for (const card of [card1, card2, card3]) {
      assert.ok(card.startsWith('🚨 *Early Detection Alert: '), card);
      eq(B.outboxGuardHits_(card, { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] }), []);
      eq(B.guardHits_(card, { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] }), []);
      assert.ok(!B.detectAlert_(card, B.parseAlert_(card), 'Lucas Hammonds'), 'never mistaken for a Zapier/Burson alert');
    }

    const parsed1 = B.edParseCard_(card1, []);
    eq([parsed1.url, parsed1.platform, parsed1.author, parsed1.distinctAuthors, parsed1.mentionCount, parsed1.sampleUrls.length],
      [CLUSTER_URL, 'X', 'pixelowner1', 9, 11, 2]);
    const parsed2 = B.edParseCard_(card2, []);
    eq([parsed2.velocityRatio, parsed2.baselineAuthors], [5.4, 2.2]);

    // Ownership enforcement: only client-zeda- or botUser + edAlertPosted_ is accepted; human copies or thread replies return null
    const t = ready(e2e());
    const ctx = { botUser: 'users/bot' };
    const baseMsg = { name: 'spaces/AAQAmirrorEd1/messages/m1', text: card1, senderName: 'users/bot', clientId: 'client-zeda-123' };
    t.bot.edRememberPosted_(baseMsg.name, { alertId: 'ED-1', signalType: 'CLUSTER_EMERGENCE', clusterId: 'clu_1',
      distinctAuthors: 9, mentionCount: 11, sourceCount: 3, priorityHint: 'P1', samples: [{ platform: 'X', author: 'pixelowner1', engagement: 18, snippet: 'dialer froze' }] });
    const recognized = t.bot.edAlertOf_(ctx, baseMsg);
    eq([recognized.alertId, recognized.signalType, recognized.clusterId, recognized.samples.length], ['ED-1', 'CLUSTER_EMERGENCE', 'clu_1', 1]);
    eq(t.bot.edAlertOf_(ctx, Object.assign({}, baseMsg, { threadReply: true })), null);
    eq(t.bot.edAlertOf_(ctx, Object.assign({}, baseMsg, { clientId: 'client-zmir-123' })), null);
    eq(t.bot.edAlertOf_(ctx, Object.assign({}, baseMsg, { clientId: '', senderName: 'users/analyst9' })), null);
    eq(t.bot.edAlertOf_(ctx, Object.assign({}, baseMsg, { clientId: '' })).alertId, 'ED-1'); // fallback when Chat strips custom IDs
  });

  // ===========================================================================================================
  // 3. Space safety refusals, 15m throttle, deduplication & BigQuery error resilience
  // ===========================================================================================================

  test('early detection safety & resilience: refuses live S-F Burson, external spaces, auto-correct, direct B25, and dry_run; throttles to 15m, caps at 5 cards, deduplicates, and handles unprovisioned/timeout BQ gracefully', () => {
    const w = world();
    // Refusals
    eq(w.bot.earlyWaveRefusal_(Object.assign(w.ctx(), { sourceReadOnly: true })), 'the auto-correct space doesn\'t check');
    eq(w.bot.earlyWaveRefusal_(Object.assign(w.ctx(), { direct: true })).includes('so its own alerts aren\'t mixed'), true);
    eq(w.bot.earlyWaveRefusal_(Object.assign(w.ctx(), { sfBurson: w.BUR })), 'the Burson space is the live one (use Mirror space B9 or a test feed)');
    eq(w.bot.earlyWaveRefusal_(Object.assign(w.ctx(), { spaces: { burson: { id: w.BUR, externalUserAllowed: true }, analyst: { id: w.ANA } } })),
      'the space allows people outside Google');
    eq(w.bot.earlyWaveRefusal_(Object.assign(w.ctx(), { settings: Object.assign({}, w.ctx().settings, { dry_run: true }) })),
      'dry run (nothing is posted)');

    // Unprovisioned view -> clean status note in C19, zero poll errors
    const t = ready(e2e());
    switchOn(t);
    t.control().getRange(LOOKBACK_ROW, 2).setValue(30);
    let mode = 'not_found';
    // seven different stories: each its own cluster and its own posts (the same posts would make them one story, and the
    // same-story dedup would hold the rest back)
    const manyRows = Array.from({ length: 7 }, (_, i) => clusterRow({
      alert_id: `ED-CLU-${i + 1}`,
      cluster_id: `clu_${i + 1}`,
      signal_key: `clu_${i + 1}`,
      primary_url: `https://x.com/u${i + 1}/status/214100000000000000${i + 1}`,
      representative_posts_json: JSON.stringify([
        { platform: 'X', author_handle: `owner${i + 1}`, followers: 410, engagement_total: 18, published_at: '2026-10-14 11:42 UTC',
          url: `https://x.com/u${i + 1}/status/214100000000000000${i + 1}`, snippet: `Report ${i + 1}: the overnight update froze my phone dialer.` },
        { platform: 'Reddit', author_handle: `u_commuter${i + 1}`, followers: null, engagement_total: 14, published_at: '2026-10-14 11:49 UTC',
          url: `https://www.reddit.com/r/GooglePixel/comments/1k9z${i + 1}/dialer_freeze/`, snippet: `Same here after the patch (${i + 1}).` },
      ]),
    }));
    const calls = fakeBq(t.g, c => {
      if (!isEdQuery(c)) return null;
      if (mode === 'not_found') return { code: 404, body: { error: { message: 'Not found: Table brand-social-central-data:DSD.DSD-story-selection' } } };
      if (mode === 'timeout') return { timeout: true };
      return { cols: COLS, rows: manyRows };
    });

    t.poll();
    eq(edQueries(calls).length, 1);
    eq([edQueries(calls)[0].location, edQueries(calls)[0].params], ['US', { minutes: '30', max_rows: '25' }]);
    assert.match(note(t), /a BigQuery source table was not found; it tries again at the next check/);
    eq(lastRun(t).errors, []);

    // Within 15 minutes: throttled (no second query)
    t.g.clock.now += 5 * MIN;
    t.poll();
    eq(edQueries(calls).length, 1);

    // 15 minutes later: timeout -> clean status note
    mode = 'timeout';
    t.g.clock.now += 11 * MIN;
    t.poll();
    eq(edQueries(calls).length, 2);
    assert.match(note(t), /BigQuery didn't finish in time; it tries again at the next check/);

    // 15 minutes later: 7 rows available -> the check only queues them (5 a check; nothing is posted by the check), and
    // the queue posts at most 2 story cards a run, each one only after its review
    mode = 'rows';
    t.g.clock.now += 15 * MIN;
    t.poll();
    eq(edQueries(calls).length, 3);
    eq(edCards(t.chat, TEST_FEED).length, 2);
    assert.match(note(t), / · 3 waiting for review · 2 cluster, 0 velocity alerts today$/);
    eq(JSON.parse(t.g.props.get('ED_ALERT_QUEUE')).length, 3);
    for (let i = 0; i < 2; i++) { t.g.clock.now += MIN; t.poll(); }
    eq(edCards(t.chat, TEST_FEED).length, 5);
    assert.match(note(t), / · last check [^·]+ · 5 cluster, 0 velocity alerts today$/);
    eq([t.g.props.has('ED_ALERT_QUEUE'), Array.from(t.g.props.keys()).filter(k => /^ED_ALERT_Q_/.test(k))], [false, []]);
    eq(edQueries(calls).length, 3);  // reviewing the queue reads nothing more from BigQuery
    // every card was posted only after its review: each one's copy in the analyst space has the review note in its thread
    const fwd = t.chat.botPosts(TRIAGED).filter(p => !p.threadReply && /\*EARLY DETECTION\*/.test(p.text));
    eq(fwd.length, 5);
    fwd.forEach(c => assert.ok(t.chat.botPosts(TRIAGED).some(p => p.threadReply && p.thread.name === c.thread.name &&
      /Early Detection Review/.test(p.text)), c.text));

    // the next check (15 minutes after the last one) queues the 2 left and skips the 5 seen ones
    t.g.clock.now += 13 * MIN;
    t.poll();
    eq(edQueries(calls).length, 4);
    eq(edCards(t.chat, TEST_FEED).length, 7);
    assert.match(note(t), /7 cluster, 0 velocity alerts today$/);

    // the daily ceiling: once EW_MAX_PER_DAY_ signals were queued today, no more queries or reviews run until tomorrow PT
    const day = JSON.parse(t.g.props.get('EARLY_DETECTION_TODAY'));
    eq(day.queued, 7);
    t.g.props.set('EARLY_DETECTION_TODAY', JSON.stringify(Object.assign(day, { queued: 40 })));
    manyRows.push(clusterRow({ alert_id: 'ED-CLU-AT-THE-CAP', cluster_id: 'clu_at_cap', signal_key: 'clu_at_cap' }));  // a new story, at the cap
    t.g.clock.now += 15 * MIN;
    t.poll();
    eq([edQueries(calls).length, edCards(t.chat, TEST_FEED).length], [4, 7]);
    eq([t.g.props.has('ED_ALERT_QUEUE'), JSON.parse(t.g.props.get('EARLY_DETECTION_TODAY')).queued, edReviewsOf(t)], [false, 40, 7]);
    assert.match(note(t), / · daily cap of 40 reached, more tomorrow · 7 cluster, 0 velocity alerts today$/);
    eq(lastRun(t).errors, []);
  });

  // ===========================================================================================================
  // 4. End-to-End Open-World Build-Up Review in Mirror Space (B9) with Relay & Outbox Active
  // ===========================================================================================================

  test('early detection E2E in Mirror space (B9): discovers unknown build-up, drafts Social Alert + Temp Check + T&S behind human gate, marks \ud83d\udc4d on monitor, filters out benign noise (a dismissal gets through on no level: its reason logged, C19 counts it), and NEVER leaks or relays to S-F Burson (B25) or test copy (B26)', () => {
    const t = e2e();
    t.chat.addSpace(MIRROR, MIRROR_NAME);
    t.chat.addSpace(COPY, COPY_NAME);
    ready(t);
    t.set('B25', ROOM);
    t.set('B26', `https://chat.google.com/app/chat/${COPY.split('/')[1]}`);
    t.bot.startMirror(MIRROR_NAME);
    t.control().getRange(22, 2).setValue('ON'); // Relay ON
    t.control().getRange(29, 2).setValue('ON'); // Safety valve: Testing (sandboxed to tester@testing.test)
    switchOn(t);

    const benignRow = clusterRow({
      alert_id: 'ED-CLU-NOISE-1',
      cluster_id: 'clu_noise_1',
      signal_key: 'clu_noise_1',
      headline: 'Casual mentions of pixel art wallpaper packs',
      primary_url: NOISE_URL,
      representative_posts_json: JSON.stringify([
        { platform: 'X', author_handle: 'astrofan9', followers: 180, engagement_total: 4, url: NOISE_URL,
          snippet: 'Check out my retro pixel art wallpaper pack for desktop setups!' },
      ]),
    });

    fakeBq(t.g, routes([clusterRow(), velocityRow(), benignRow]));
    // the driver post (P1) has a photo: it goes under its card
    const PHOTO = 'https://pbs.twimg.com/media/Dialer1.jpg';
    t.g.pages.set(embed('2140000000000000001'), JSON.stringify({ id_str: '2140000000000000001', text: 'Overnight update froze the emergency dialer',
      user: { screen_name: 'pixelowner1' }, mediaDetails: [{ type: 'photo', media_url_https: PHOTO }] }));
    t.g.pages.set(PHOTO, { code: 200, bytes: JPEG, headers: { 'Content-Type': 'image/jpeg' } });
    // the review's web search: one source
    t.g.vertex.grounding = () => ({ webSearchQueries: ['pixel 9 emergency dialer freeze update'],
      groundingChunks: [{ web: { uri: GROUNDING_URI, title: 'support.google.com' } }] });

    // Open-world Gemini reviews keyed on the signal in <early_detection_signal>
    t.g.vertex.earlyDetection = payload => {
      const txt = payload.contents[0].parts.map(p => p.text || '').join('\n');
      assert.ok(payload.systemInstruction.parts[0].text.includes('ONE unified brand-safety system serving two coordinated stages'));
      assert.ok(!payload.systemInstruction.parts[0].text.includes('THE STREAM / WATCH:'), 'does NOT reuse targeted Watcher stream prompt');
      if (txt.includes('ED-CLU-20261014-001')) {
        return {
          summary: 'Nine low-tier users across X, Reddit, and Instagram report the Pixel 9 emergency dialer freezing after an overnight update.',
          issue_name: 'Pixel 9 emergency dialer freeze reports after update',
          emerging_narrative: 'Independent Pixel owners across three platforms report emergency call UI hangs right after installing the overnight update.',
          early_detection_call: {
            disposition: 'escalate',
            severity: 'high',
            confidence: 0.91,
            reason: 'Cross-platform reports of emergency dialer freezing pose a concrete safety-critical product regression',
            build_up_signals: '9 distinct low-tier authors across X, Reddit, and owned comments within 20 minutes describing identical symptoms',
            watch_for: 'Official Pixel support acknowledgement or broader carrier reports',
          },
          temp_check_draft: {
            recommended: true,
            query_suggestion: '("Pixel" OR "Android") AND ("emergency dialer" OR "emergency call") AND (freeze OR frozen OR hangs)',
            scope_note: 'Last 6h across X and Reddit',
          },
          slrr: {
            is_slrr: true,
            confidence: 0.92,
            exposure_tag: 'Product - Dangerous results (e.g. medical/legal)',
            product: 'Pixel',
            other_products: ['Android'],
            sensitive_topics: [],
            location: 'US',
          },
          known_issue: { matches: false, confidence: 0.95 },
          tns: { needed: true, reason: 'Emergency calling reliability safety concern' },
          recommended_groups: [{ code: 'comms', reason: 'Hardware safety regression reports' }],
          story_title: 'Pixel 9 owners say the overnight update froze the emergency dialer',
          story: 'Nine small accounts on X, Reddit and Instagram said within 20 minutes that the October update left the ' +
            'emergency dialer [frozen on the call screen](P1); a Reddit user says the call button [hangs for 30 seconds](P2) ' +
            'and others ask [if anyone else sees it](P3). A [made-up link](https://evil.example.com/x) and [a post it never had](P9) stay plain.',
          web_context: 'No news coverage or official Pixel support statement yet.',
          next_steps: ['Size it with the Temp Check query in the thread and re-check in 2 hours',
            'Send the Social Alert draft to Comms per the escalation guide if 15+ owners report it'],
          driver_post: 'P1',
        };
      }
      if (txt.includes('ED-VEL-CLUSTER-9912')) {
        return {
          summary: 'Twelve low-tier authors on Reddit and X ask whether Google Photos Locked Folder items disappeared or sync is delayed.',
          issue_name: 'Photos Locked Folder sync delay reports',
          emerging_narrative: 'Users on Reddit and X are questioning whether Locked Folder items are failing to render after morning sync.',
          early_detection_call: {
            disposition: 'monitor',
            severity: 'medium',
            confidence: 0.84,
            reason: '5.4x velocity spike across Reddit and X could be a transient sync delay or a broader data-visibility bug',
            build_up_signals: '12 distinct authors (5.4x smoothed baseline) reporting empty Locked Folder views',
            watch_for: 'Confirmed permanent photo loss or 25+ distinct authors',
          },
          temp_check_draft: {
            recommended: true,
            query_suggestion: '"Google Photos" AND "Locked Folder" AND (empty OR missing OR disappeared OR sync)',
            scope_note: 'Check hourly volume vs 7d baseline',
          },
          slrr: {
            is_slrr: false,
            confidence: 0.85,
            product: 'Google Photos',
            other_products: [],
            sensitive_topics: [],
          },
          known_issue: { matches: false, confidence: 0.9 },
          tns: { needed: false },
          recommended_groups: [],
        };
      }
      return {
        summary: 'Users sharing retro 8-bit pixel art desktop wallpapers unrelated to Google.',
        issue_name: 'Retro pixel art wallpaper posts',
        emerging_narrative: 'Off-brand homonym cluster around retro pixel art graphics.',
        early_detection_call: {
          disposition: 'dismiss',
          severity: 'none',
          confidence: 0.96,
          reason: 'Off-brand pixel-art homonym unrelated to Google Pixel devices',
        },
        slrr: { is_slrr: false, confidence: 0.97 },
        known_issue: { matches: false, confidence: 0.95 },
        tns: { needed: false },
      };
    };

    // Pass 1: earlyWaveCheck_ reads US BigQuery and queues the 3 signals (nothing posted yet); the queue reviews 2 and
    // posts each as one story card, its review note in the thread. Pass 2 (1 minute later): the third, which the review
    // dismisses, so it's filtered out: nothing of it gets through (no card, note, mark, Alert-log row, Social Alert or
    // T&S intake); its reason is logged and Control C19 counts it
    t.poll();
    eq(edCards(t.chat, MIRROR).length, 2);
    t.g.clock.now += MIN;
    t.poll();
    const cards = edCards(t.chat, MIRROR);
    eq(cards.length, 2);
    const cardFor = rx => cards.find(c => rx.test(c.text));
    const ordered = [cardFor(/Pixel 9 owners say/), cardFor(/Locked Folder/)];
    assert.ok(ordered.every(Boolean), cards.map(c => c.text).join('\n----\n'));
    assert.ok(t.g.vertex.calls.some(c => c.payload.contents[0].parts.map(p => p.text || '').join('').includes('ED-CLU-NOISE-1')),
      'the benign signal was reviewed');
    eq(t.chat.botPosts(MIRROR).filter(m => /pixel art|astrofan9/i.test(m.text)), []);
    assert.ok(t.g.logs.some(l => /early detection: dismissed "Casual mentions of pixel art wallpaper packs" after its review, so it was filtered out: Off-brand pixel-art homonym unrelated to Google Pixel devices/.test(l)),
      t.g.logs.join('\n'));
    assert.match(note(t), / · 1 cluster, 1 velocity alerts today · 1 dismissal filtered out$/);

    const rows = t.bot.sheetBackend_(t.sheet()).loadAlerts().filter(r => r.ingested === 'Early detection');
    eq(rows.length, 2);

    // The escalated cluster's card: the siren header, Gemini's headline on its own line, the SLRR lines, its story with
    // ONLY the signal's posts linked inline (a made-up link and a post it never had stay plain words), next steps, what
    // the web says with its source, the call and the activity in words, every post as a link, and the driver post's photo
    const story = ordered[0].text;
    eq(story.split('\n').slice(0, 7), [
      '\ud83d\udea8 *EARLY DETECTION* \u00b7 New story',
      '*Pixel 9 owners say the overnight update froze the emergency dialer*',
      '*Product:* Pixel, Android (Android OS & Google TV)',
      '*Exposure Tag:* Product - Dangerous results (e.g. medical/legal) (P0)',
      '*Sensitive Topic:* None',
      '*KOF:* No (9 small, non-KOF accounts)',
      '']);
    [`<${CLUSTER_URL}|frozen on the call screen>`, `<${REDDIT_URL}|hangs for 30 seconds>`,
      '<https://www.instagram.com/p/DBabc123/|if anyone else sees it>', 'A made-up link and a post it never had stay plain.',
      `\n*Web:* No news coverage or official Pixel support statement yet. (<${GROUNDING_URI}|support.google.com>)\n`,
      '\n*Next steps:*\n1. Size it with the Temp Check query in the thread and re-check in 2 hours\n2. Send the Social Alert draft',
      '\n*Call:* \ud83d\udce6 Social Alert (early build-up): Cross-platform reports of emergency dialer freezing pose a concrete safety-critical product regression\n',
      '\n*Activity:* 9 small accounts on X, Reddit and Owned Social posted about this 11 times between 7:42 AM and 7:55 AM ET\n',
      `\n*Posts:* <${CLUSTER_URL}|@pixelowner1> (X) \u00b7 <${REDDIT_URL}|@u_droidcommuter> (Reddit) \u00b7 <https://www.instagram.com/p/DBabc123/|@westcoast_dad> (Instagram)`,
    ].forEach(x => assert.ok(story.includes(x), x + '\n' + story));
    // the card's lines keep one order: What's happening, Web, Call, Activity, Next steps, Posts
    eq(story.split('\n').slice(7).map(l => (l.match(/^\*([A-Za-z' ]+):\*/) || [])[1]).filter(Boolean),
      ["What's happening", 'Web', 'Call', 'Activity', 'Next steps', 'Posts']);
    assert.ok(story.split('\n')[7].startsWith("*What's happening:* "), story);
    assert.ok(!/\(P\d\)/.test(story.replace(/^\*Exposure Tag:\*.*$/m, '')), story);  // no leftover post refs
    assert.ok(!/https?:\/\//.test(story.replace(/<https?:\/\/[^|>\s]+\|[^>]*>/g, '')), 'every link is a <url|text> link');
    eq((ordered[0].attachment || []).map(a => a.contentType), ['image/jpeg']);
    // No AI story (the monitor review gave none): a plain headline from the posts; the call and why in words
    assert.ok(ordered[1].text.startsWith('\ud83d\udea8 *EARLY DETECTION* \u00b7 New story\n*12 accounts posting \u201cMy Locked Folder in Photos'), ordered[1].text);
    assert.ok(ordered[1].text.includes('\n*Call:* \ud83d\udc4d Monitor build-up: 5.4x velocity spike across Reddit and X could be a transient sync delay or a broader data-visibility bug\n'), ordered[1].text);
    for (const c of ordered) {
      eq(B.outboxGuardHits_(c.text, { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] }), []);
      assert.ok(!B.detectAlert_(c.text, B.parseAlert_(c.text), 'Lucas Hammonds'), 'never mistaken for a Zapier/Burson alert');
      assert.ok(c.text.length <= 3900);
    }
    // the review got the posts as P1… refs, never their links
    const edCall = t.g.vertex.calls.find(c => c.payload.contents[0].parts.map(p => p.text || '').join('').includes('ED-CLU-20261014-001'));
    const sent = JSON.parse(edCall.payload.contents[0].parts.map(p => p.text || '').join('').match(/<early_detection_signal>\n([\s\S]*)\n<\/early_detection_signal>/)[1]);
    eq(sent.posts.map(p => [p.ref, p.author]), [['P1', 'pixelowner1'], ['P2', 'u_droidcommuter'], ['P3', 'westcoast_dad']]);
    assert.ok(edCall.payload.systemInstruction.parts[0].text.includes('STORY CARD'));
    assert.ok(!JSON.stringify(sent.posts).includes('https://'));

    // Card 1 (escalate): Social Alert sent ONLY to stand-in tester (Testing valve ON), EARLY_DETECTION reason included,
    // Temp Check query + T&S form posted in thread
    const c1Replies = t.chat.botPosts(MIRROR).filter(p => p.thread.name === ordered[0].thread.name && p.name !== ordered[0].name);
    assert.ok(c1Replies.some(p => p.text.includes('*Early Detection Review: \ud83d\udce6 Social Alert (early build-up)*') &&
      p.text.includes('*Draft Temp Check query:* `("Pixel" OR "Android")')));
    assert.ok(c1Replies.some(p => p.text.includes('T&S Intake Form, pre-filled')), 'T&S intake link drafted for human submission');
    const mails = t.g.gmail.sentMessages();
    eq(mails.length, 1);
    eq([mails[0].to, mails[0].cc, mails[0].bcc], [['tester@testing.test'], [], []]);
    assert.match(mails[0].text, /Nine low-tier users across X, Reddit, and Instagram report the Pixel 9 emergency dialer freezing/);
    const escalated = rows.find(r => r.source_message === ordered[0].name);
    assert.ok(B.escalationWhyBullets_(escalated.email_input.escalation).some(b => /Early detection: low-tier semantic cluster \(9 distinct authors\)/.test(b)));
    assert.ok(c1Replies.some(p => /\*Why:\* low-tier semantic cluster \(9 distinct authors/.test(p.text)));

    // Card 2 (monitor): 👍 reaction + Temp Check query in thread, no Social Alert email
    const c2Replies = t.chat.botPosts(MIRROR).filter(p => p.thread.name === ordered[1].thread.name && p.name !== ordered[1].name);
    assert.ok(c2Replies.some(p => p.text.includes('*Early Detection Review: \ud83d\udc4d Monitor build-up*') &&
      p.text.includes('*Draft Temp Check query:* `"Google Photos" AND "Locked Folder"')));
    assert.ok(t.chat.botReactions(ordered[1].name).includes('\ud83d\udc4d'));

    // Zero leaks or relays to live S-F Burson (REAL), Burson test copy (COPY), or Burson outbox
    eq(t.chat.botPosts(REAL), []);
    eq(t.chat.botPosts(COPY).filter(m => /Early Detection|EARLY SIGNAL|\*UPDATE\*|dialer|Locked Folder|pixel art/i.test(m.text)), []);
    const outboxTab = t.sheet().getSheetByName('Burson outbox');
    eq(outboxTab ? outboxTab.rows.slice(1) : [], []);
    eq(lastRun(t).errors, []);
  });

  test('early detection: a dismissed signal is filtered out on every level, even when its review saw a T&S angle (a T&S form or Social Alert only ever follows a card in the space and its review): no card, review note, mark, Alert-log row, email or T&S intake; its reason is logged and C19 counts it', () => {
    const t = e2e();
    t.chat.addSpace(MIRROR, MIRROR_NAME);
    t.chat.addSpace(COPY, COPY_NAME);
    ready(t);
    t.set('B25', ROOM);
    t.set('B26', `https://chat.google.com/app/chat/${COPY.split('/')[1]}`);
    t.bot.startMirror(MIRROR_NAME);
    t.control().getRange(22, 2).setValue('ON'); // Relay ON
    t.control().getRange(29, 2).setValue('ON'); // Safety valve: Testing
    switchOn(t);
    fakeBq(t.g, routes([clusterRow()]));
    t.g.vertex.earlyDetection = () => ({
      summary: 'A few Pixel owners say the dialer froze once after the update and works after a restart.',
      issue_name: 'One-off Pixel dialer freeze',
      emerging_narrative: 'Scattered one-off reports that clear after a restart.',
      early_detection_call: { disposition: 'dismiss', severity: 'low', confidence: 0.9,
        reason: 'One-off glitch that clears after a restart, nothing to escalate' },
      slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Product - Unexpected Responses', product: 'Pixel', other_products: [],
        sensitive_topics: [] },
      known_issue: { matches: false, confidence: 0.9 },
      tns: { needed: true, reason: 'Emergency calling glitch' },
      recommended_groups: [],
    });
    t.poll();
    assert.ok(t.g.vertex.calls.some(c => c.payload.contents[0].parts.map(p => p.text || '').join('').includes('ED-CLU-20261014-001')),
      'the signal was reviewed');
    eq(edCards(t.chat, MIRROR), []);
    eq(t.chat.botPosts(MIRROR).filter(m => /dialer|T&S (?:Intake|form)|Early Detection|EARLY SIGNAL|\*UPDATE\*/i.test(m.text)), []);
    eq([t.g.gmail.sentMessages().length, t.g.gmail.allDrafts().length], [0, 0]);
    eq(t.bot.sheetBackend_(t.sheet()).loadAlerts().filter(r => r.ingested === 'Early detection'), []);
    assert.ok(t.g.logs.some(l => /early detection: dismissed "Multiple users report Pixel 9 emergency dialer freezing after overnight update" after its review, so it was filtered out: One-off glitch that clears after a restart, nothing to escalate/.test(l)),
      t.g.logs.join('\n'));
    assert.match(note(t), / · 0 cluster, 0 velocity alerts today · 1 dismissal filtered out$/);
    eq(lastRun(t).errors, []);
  });

  // ===========================================================================================================
  // 5. Two-Space Flow (TEST_FEED -> TRIAGED) + Human Gmail Draft Gate when Live (Auto-Send OFF)
  // ===========================================================================================================

  test('early detection two-space flow (TEST_FEED -> TRIAGED): forwards card to analyst space, leaves Gmail draft for human gate when live with Auto-send OFF, and suppresses already-alerted issues with \u274c', () => {
    const t = ready(e2e());
    switchOn(t);
    fakeBq(t.g, routes([velocityRow()]));
    t.g.vertex.earlyDetection = () => ({
      summary: 'Accelerating low-tier reports of Photos Locked Folder sync failures.',
      issue_name: 'Photos Locked Folder sync failure',
      emerging_narrative: 'Multi-platform spike of users unable to view Locked Folder photos.',
      early_detection_call: {
        disposition: 'escalate',
        severity: 'high',
        confidence: 0.88,
        reason: '5.4x low-tier velocity spike reporting inaccessible user photos',
        build_up_signals: '12 distinct authors across Reddit and X',
      },
      temp_check_draft: { recommended: true, query_suggestion: '"Locked Folder" AND Photos' },
      slrr: {
        is_slrr: true,
        confidence: 0.88,
        exposure_tag: 'Product - Perceived bias',
        product: 'Google Photos',
        other_products: [],
        sensitive_topics: [],
      },
      known_issue: { matches: false, confidence: 0.9 },
      tns: { needed: false },
      recommended_groups: [],
    });

    // Pass 1: posts card in TEST_FEED; Pass 2: forwards to TRIAGED and reviews there
    t.poll();
    eq(edCards(t.chat, TEST_FEED).length, 1);
    t.g.clock.now += MIN;
    t.poll();

    const triagedPosts = t.chat.botPosts(TRIAGED);
    const fwdCard = triagedPosts.find(m => !m.threadReply && m.text.includes('*EARLY DETECTION*'));
    assert.ok(fwdCard, 'card forwarded to TRIAGED analyst space');
    const threadNotes = triagedPosts.filter(m => m.threadReply && m.thread.name === fwdCard.thread.name);
    assert.ok(threadNotes.some(m => m.text.includes('*Early Detection Review: \ud83d\udce6 Social Alert (early build-up)*')));

    // Verify human gate when drafts.live is true and Auto-send is OFF -> creates a Gmail draft, never auto-sends
    const w = world({ drafts: { live: true, standIn: '', from: 'im@ops.test', mailbox: 'im@ops.test' } });
    const liveCtx = Object.assign(w.ctx(), {
      switches: Object.assign(w.bot.switchesOff_(), { autoSend: false }),
    });
    const cardText = B.edAlertCardText_(clusterRow());
    const srcMsg = w.chat.say(w.BUR, cardText, { sender: 'users/bot' });
    srcMsg.clientAssignedMessageId = 'client-zeda-live1';
    w.bot.edRememberPosted_(srcMsg.name, { alertId: 'ED-LIVE-1', signalType: 'CLUSTER_EMERGENCE', distinctAuthors: 9, mentionCount: 11 });
    w.g.vertex.earlyDetection = () => ({
      summary: 'Nine users report Pixel emergency dialer freeze.',
      issue_name: 'Pixel emergency dialer freeze',
      emerging_narrative: 'Cross-platform emergency dialer hang reports.',
      early_detection_call: { disposition: 'escalate', severity: 'high', confidence: 0.9, reason: 'Safety regression build-up' },
      slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Product - Dangerous results (e.g. medical/legal)', product: 'Pixel' },
      known_issue: { matches: false, confidence: 0.9 },
      tns: { needed: false },
    });
    const normMsg = w.bot.normalizeMessage_(w.chat._public(srcMsg));
    const edObj = w.bot.edAlertOf_(liveCtx, normMsg);
    const rep = { alerts: 0, drafts: 0, drafts_sent: 0, errors: [] };
    w.bot.handleEarlyDetection_(liveCtx, normMsg, edObj, rep);
    eq([w.g.gmail.sentMessages().length, w.g.gmail.allDrafts().length, rep.drafts], [0, 1, 1]);
  });

  // ===========================================================================================================
  // 6. The story card: Gemini's story with only the signal's posts linked inline, web sources, next steps, posts
  // ===========================================================================================================

  test('early detection story card: Gemini\'s headline and story with ONLY the signal\'s posts linked inline (made-up links, raw URLs and unknown refs dropped), what the web says with https sources, next steps, every post linked; a plain story from the posts when Gemini gives none; under Chat\'s size; zero leak-guard hits', () => {
    const ed = B.edFromRow_(B.edQueueCompact_(clusterRow()));
    eq([ed.alertId, ed.url, ed.distinctAuthors, ed.mentionCount, ed.platformsCsv, ed.samples.length], ['ED-CLU-20261014-001', CLUSTER_URL, 9, 11, 'X, Reddit, Owned Social', 3]);
    const posts = B.edPostsOf_(ed);
    eq(posts.map(p => p.author), ['pixelowner1', 'u_droidcommuter', 'westcoast_dad']);
    eq(B.edLinkify_('They say it [froze](P1) and [hangs](P2); see [this](https://bad.testing.test) or [that](P7) https://raw.testing.test/x (P3).', posts),
      `They say it <${CLUSTER_URL}|froze> and <${REDDIT_URL}|hangs>; see this or that.`);
    eq(B.edLinkify_('A <https://bad.testing.test|chat link> | and <b>tags</b>', posts), 'A chat link and b tags /b');
    eq(B.edLinkify_('Posts [who are they](P1) and again [the same post](P1).', posts), `Posts <${CLUSTER_URL}|who are they> and again the same post.`);
    eq(B.edStoryOf_({ story_title: 'Owners say *it* froze.', story: '', next_steps: ['1. Re-check', '- Escalate', ''], driver_post: 'P2' }),
      { title: 'Owners say it froze', text: '', web: '', steps: ['Re-check', 'Escalate'], driver: 2 });
    eq([B.edStoryOf_({}), B.edStoryOf_(null), B.edStoryOf_({ story: 'x', driver_post: 'the second' }).driver], [null, null, null]);
    eq([B.edMs_('2026-10-14 11:42 UTC'), B.edMs_('2026-10-14T11:42:00Z'), B.edMs_('2026-10-14T15:14:59.947Z'), B.edMs_('2026-10-14 07:42-04:00')],
      [Date.UTC(2026, 9, 14, 11, 42), Date.UTC(2026, 9, 14, 11, 42), Date.UTC(2026, 9, 14, 15, 14, 59, 947), Date.UTC(2026, 9, 14, 11, 42)]);

    const d = { disposition: 'monitor', basis: 'early_detection', why: 'Worth watching', rev: { story: B.edStoryOf_({
      story_title: 'Pixel 9 owners say the overnight update froze the emergency dialer.',
      story: 'Nine small accounts said the dialer [froze](P1) after the update; one says the call button [hangs](P2).',
      web_context: 'No coverage yet.',
      next_steps: ['1. Re-check in 2 hours', '- Escalate if [more owners](P3) report it'],
      driver_post: 'P2' }) },
      web: { sources: [{ title: 'support.google.com', uri: GROUNDING_URI }, { title: 'plain http', uri: 'http://insecure.testing.test/a' }] } };
    const text = B.edStoryCardText_(ed, d, NOW);
    eq(text.split('\n'), [
      '\ud83d\udea8 *EARLY DETECTION* \u00b7 New story',
      '*Pixel 9 owners say the overnight update froze the emergency dialer*',
      '*Product:* Brand',
      '*Exposure Tag:* None identified',
      '*Sensitive Topic:* None',
      '*KOF:* No (9 small, non-KOF accounts)',
      '',
      `*What's happening:* Nine small accounts said the dialer <${CLUSTER_URL}|froze> after the update; one says the call button <${REDDIT_URL}|hangs>.`,
      `*Web:* No coverage yet. (<${GROUNDING_URI}|support.google.com>)`,
      '*Call:* \ud83d\udc4d Monitor build-up: Worth watching',
      '*Activity:* 9 small accounts on X, Reddit and Owned Social posted about this 11 times between 7:42 AM and 7:55 AM ET',
      '*Next steps:*',
      '1. Re-check in 2 hours',
      '2. Escalate if <https://www.instagram.com/p/DBabc123/|more owners> report it',
      `*Posts:* <${CLUSTER_URL}|@pixelowner1> (X) \u00b7 <${REDDIT_URL}|@u_droidcommuter> (Reddit) \u00b7 <https://www.instagram.com/p/DBabc123/|@westcoast_dad> (Instagram)`,
    ]);
    const parsed = B.edParseCard_(text, []);
    eq([parsed.headline, parsed.url], ['Pixel 9 owners say the overnight update froze the emergency dialer', CLUSTER_URL]);
    // the first line names the kind (the bot's own card: Alert.gs OWN_CARD_TYPES_); the lines under it never change order.
    // A story flagged below the usual bar says so there, with the accounts it rests on against the usual bar; an update of
    // an earlier card says it is one, with what's new under the headline. An update is not a card to review (as before)
    eq(B.ownCardHeadParse_(text.split('\n')[0]), { type: 'story', detail: 'New story' });
    const signalText = B.edStoryCardText_(Object.assign({}, ed, { signalType: 'EARLY_WATCH', distinctAuthors: 3 }), d, NOW);
    eq(signalText.split('\n').slice(0, 2), ['\u26a1 *EARLY SIGNAL* \u00b7 3 accounts so far (a story is usually flagged at 5)',
      '*Pixel 9 owners say the overnight update froze the emergency dialer*']);
    eq([signalText.split('\n').slice(2, 7), B.edParseCard_(signalText, []).headline],
      [text.split('\n').slice(2, 6).map(l => l.replace('9 small', '3 small')).concat(['']), parsed.headline]);
    const updateText = B.edStoryCardText_(Object.assign({}, ed, { update: { news: '18 accounts now, up from 9', at: NOW - 2 * 3600 * 1000, thread: 'spaces/x/threads/y' } }), d, NOW);
    eq(updateText.split('\n').slice(0, 2), ['\ud83d\udcc8 *UPDATE* \u00b7 More on a story already alerted',
      '*Pixel 9 owners say the overnight update froze the emergency dialer*']);
    assert.match(updateText.split('\n')[2], /^\*What's new:\* 18 accounts now, up from 9 \(since the .+ card\)\.$/);
    eq([updateText.split('\n')[3], B.edParseCard_(updateText, [])], ['*Product:* Brand', null]);
    eq([text, signalText, updateText].map(c => B.isOwnAlertCardHeader_(c)), [true, true, true]);
    eq([text, signalText, updateText].map(c => B.outboxGuardHits_(c.split('\n')[0], { terms: [] })), [[], [], []]);
    // a card from before the shared layout still reads: the header alone on the first line, the headline under it
    eq(B.edParseCard_(`\ud83d\udea8 *Early Detection Alert* \ud83d\udea8\n*Pixel dialer freeze*\n*Product:* Pixel\n\nIt froze: ${CLUSTER_URL}`, []).headline,
      'Pixel dialer freeze');
    // a card in the older one-line header still reads
    eq(B.edParseCard_(`\ud83d\udea8 *Early Detection Alert: Pixel dialer freeze* \ud83d\udea8\n*Link:* ${CLUSTER_URL}`, []).headline, 'Pixel dialer freeze');
    eq(B.outboxGuardHits_(text, { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] }), []);
    eq(B.guardHits_(text, { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] }), []);
    assert.ok(!B.detectAlert_(text, B.parseAlert_(text), 'Lucas Hammonds'));
    // the SLRR lines: the review's confident view (all its products); an unconfirmed tag says how sure; no review: not assessed
    const tax = (fields, slrr) => B.edTaxonomyLines_(ed, { fields, rev: { slrr } });
    eq(tax({ product: 'Pixel', other_products: ['Android (Android OS & Google TV)'], exposure_tag: 'Product - Dangerous results (e.g. medical/legal)',
      priority: 'P0', risk_tags: ['Child Safety'] }, { is: true, tag: 'Product - Dangerous results (e.g. medical/legal)', priority: 'P0',
      confidence: 0.9, topics: ['Child Safety'] }), ['*Product:* Pixel, Android (Android OS & Google TV)',
      '*Exposure Tag:* Product - Dangerous results (e.g. medical/legal) (P0)', '*Sensitive Topic:* Child Safety', '*KOF:* No (9 small, non-KOF accounts)']);
    eq(tax({ product: 'Photos', priority: 'P2' }, { is: true, tag: 'Product - Privacy & security concerns', priority: 'P1', confidence: 0.6, topics: [] })[1],
      '*Exposure Tag:* Product - Privacy & security concerns (P1, unconfirmed: 60% sure)');
    eq(B.edTaxonomyLines_(ed, { disposition: 'monitor', basis: 'failed' }).slice(1, 3),
      ['*Exposure Tag:* not assessed (the AI review was unavailable)', '*Sensitive Topic:* not assessed (the AI review was unavailable)']);

    // The bot's rules changed Gemini's call (already alerted): the card's steps say what that call means, never Gemini's
    // "send a Social Alert" under a ❌
    const repeat = Object.assign({}, d, { disposition: 'dismiss', basis: 'repeat', rev: Object.assign({}, d.rev, { disposition: 'escalate' }),
      why: 'already alerted as a known issue (QA-4228, "AI Mode Teen Safety Lawsuit")' });
    const repeatText = B.edStoryCardText_(ed, repeat, NOW);
    assert.ok(repeatText.includes('\n*Call:* \u274c Already alerted: already alerted as a known issue (QA-4228, "AI Mode Teen Safety Lawsuit")\n'), repeatText);
    assert.ok(repeatText.includes('1. No new Social Alert: already alerted as a known issue (QA-4228, "AI Mode Teen Safety Lawsuit").\n'), repeatText);
    const unsure = B.edCardSteps_({ disposition: 'monitor', basis: 'low_confidence', why: 'May be a regression (70% sure, so a person decides)',
      rev: { disposition: 'escalate' } }, { steps: ['Send the Social Alert to Comms'] });
    eq(unsure, ['You decide on the Social Alert: May be a regression (70% sure, so a person decides).', 'Send the Social Alert to Comms']);
    // Which reviewed calls are filtered out: every dismissal, whatever the review saw (even a T&S angle: a T&S form only
    // ever follows a card in the space and its review); a monitor, an unsure or failed review, or a Social Alert posts
    eq([{ disposition: 'dismiss', basis: 'early_detection' }, { disposition: 'dismiss', basis: 'evergreen' },
      { disposition: 'dismiss', basis: 'early_detection', tnsPlanned: true }, { disposition: 'dismiss', basis: 'repeat' },
      { disposition: 'dismiss', basis: 'non_english' }, { disposition: 'monitor', basis: 'failed' },
      { disposition: 'monitor', basis: 'low_confidence' }, { disposition: 'escalate', basis: 'p0_tag' }].map(x => B.edDismissed_(x)),
    [true, true, true, true, true, false, false, false]);

    // No AI review: a plain headline, story and next step from the posts themselves
    const plain = B.edStoryCardText_(ed, { disposition: 'monitor', basis: 'failed', why: 'AI review unavailable, so a person makes the call' }, NOW);
    assert.ok(plain.startsWith('\ud83d\udea8 *EARLY DETECTION* \u00b7 New story\n*9 accounts posting \u201cMultiple users report Pixel 9 emergency dialer freezing after overnig\u2026\u201d*\n*Product:* '), plain);
    assert.ok(plain.includes('\n*Exposure Tag:* not assessed (the AI review was unavailable)\n'), plain);
    assert.ok(plain.includes('\n*Call:* \ud83d\udc4d Needs a human look: AI review unavailable, so a person makes the call\n'), plain);
    assert.ok(plain.includes(`9 small accounts on X, Reddit, Owned Social posted about this 11 times. A typical post: \u201cOvernight update froze the emergency dialer screen completely on my phone.\u201d (<${CLUSTER_URL}|@pixelowner1>, <${REDDIT_URL}|@u_droidcommuter>, <https://www.instagram.com/p/DBabc123/|@westcoast_dad>).`), plain);
    assert.ok(plain.includes('1. Read the posts below and make the call: the AI review wasn\'t available this time.'), plain);
    assert.ok(!plain.includes('*Web:*'));

    // Long everything: still under Chat's size, the headline, story and steps kept (fewer post links first)
    const many = B.edFromRow_(B.edQueueCompact_(clusterRow({ representative_posts_json: JSON.stringify(Array.from({ length: 8 }, (_, i) => ({
      platform: 'Reddit', author_id: `user_${i}`, url: `https://www.reddit.com/r/GooglePixel/comments/${'k'.repeat(180)}${i}/long_title_${'x'.repeat(120)}/`,
      snippet: 'z'.repeat(270) }))) })));
    const longD = { disposition: 'monitor', basis: 'early_detection', why: 'w', rev: { story: B.edStoryOf_({
      story_title: 'T'.repeat(200), story: Array.from({ length: 8 }, (_, i) => `[claim ${i}](P${i + 1}) ${'w'.repeat(80)}`).join(' '),
      web_context: 'v'.repeat(400), next_steps: ['s'.repeat(300), 's'.repeat(300), 's'.repeat(300), 's'.repeat(300)] }) },
      web: { sources: [{ title: 'a', uri: 'https://news.testing.test/' + 'u'.repeat(350) }, { title: 'b', uri: 'https://docs.testing.test/' + 'u'.repeat(350) }] } };
    const big = B.edStoryCardText_(many, longD, NOW);
    assert.ok(big.length <= 3900, String(big.length));
    assert.ok(big.startsWith('\ud83d\udea8 *EARLY DETECTION* \u00b7 New story\n*TTT') && big.includes('\n*Next steps:*\n1. sss'), big.slice(0, 300));
  });

  test('early detection story card: a Markdown link in words from outside ("[words](address)": Gemini\'s headline, the call\'s reason, a web source\'s name, the signal\'s own headline, a post\'s own words in the plain story, a platform\'s name, an update\'s news) stays words when the card is posted (every post goes through normalizeChatLinks_): the card links only the signal\'s posts and its https web sources', () => {
    const EVIL = 'https://phish.testing.test/login';
    const MD = `[the leaked memo](${EVIL})`;
    const linked = text => (text.match(/<https?:\/\/[^|>\s]+\|[^>]*>/g) || []).map(l => l.slice(1, l.indexOf('|')));
    const sent = text => B.normalizeChatLinks_(text);  // as chatPostMessage_ posts it
    const story = o => B.edStoryOf_(Object.assign({ story_title: 'Owners say the dialer froze.', story: 'Nine accounts said it [froze](P1).',
      web_context: 'No coverage yet.', next_steps: ['Re-check in 2 hours'], driver_post: 'P1' }, o));
    const d = o => ({ disposition: 'monitor', basis: 'early_detection', why: 'Worth watching', rev: { story: story(o) } });
    const plain = { disposition: 'monitor', basis: 'failed', why: 'AI review unavailable, so a person makes the call' };
    const ed = B.edFromRow_(B.edQueueCompact_(clusterRow()));
    const onePost = snippet => JSON.stringify([{ platform: 'X', author_handle: 'pixelowner1', followers: 410, engagement_total: 18,
      published_at: '2026-10-14 11:42 UTC', url: CLUSTER_URL, snippet }]);
    const twoNets = JSON.stringify([
      { platform: `[X](${EVIL})`, author_handle: 'pixelowner1', followers: 410, engagement_total: 18, published_at: '2026-10-14 11:42 UTC',
        url: CLUSTER_URL, snippet: 'It froze.' },
      { platform: 'Reddit', author_handle: 'u_droidcommuter', followers: null, engagement_total: 14, published_at: '2026-10-14 11:49 UTC',
        url: REDDIT_URL, snippet: 'Same here.' }]);
    const cards = {
      'Gemini\'s headline': [ed, d({ story_title: `Owners say ${MD}` })],
      'the call\'s reason': [ed, Object.assign(d({}), { why: `Because ${MD}` })],
      'a web source\'s name': [ed, Object.assign(d({}), { web: { sources: [{ title: `[news](${EVIL})`, uri: GROUNDING_URI }] } })],
      'the signal\'s own headline': [B.edFromRow_(B.edQueueCompact_(clusterRow({ headline: `Dialer ${MD} freezing` }))), plain],
      'a post\'s own words': [B.edFromRow_(B.edQueueCompact_(clusterRow({ representative_posts_json: onePost(`It froze ${MD} look`) }))), plain],
      'a platform\'s name': [B.edFromRow_(B.edQueueCompact_(clusterRow({ platforms_csv: `[X](${EVIL})`, representative_posts_json: twoNets }))), d({})],
      'an update\'s news': [Object.assign({}, ed, { update: { news: `more accounts ${MD}`, at: NOW - 3600 * 1000, thread: 'spaces/x/threads/y' } }), d({})],
    };
    for (const name of Object.keys(cards)) {
      const text = sent(B.edStoryCardText_(cards[name][0], cards[name][1], NOW));
      eq(linked(text).filter(u => u.indexOf('phish.testing.test') >= 0), [], name);
      assert.ok(text.indexOf('] (https://phish.testing.test') >= 0, `${name}: the words stay, the address in the open`);
      assert.ok(linked(text).indexOf(CLUSTER_URL) >= 0, `${name}: the signal's post is still linked`);
    }
    // Gemini's own Markdown links in the story are as before: a post's reference is linked, any other is words only
    const own = sent(B.edStoryCardText_(ed, d({ story: `Nine accounts said it [froze](P1); see [this](${EVIL}).` }), NOW));
    assert.ok(own.includes(`*What's happening:* Nine accounts said it <${CLUSTER_URL}|froze>; see this.`), own);
  });

  test('early detection and watch cards: the bot\'s own alert cards are known by their first line (Alert.gs ownCardHeadParse_, isOwnAlertCardHeader_; the same list as tests/test_parser.py for the Python twin): the four first lines of today, with or without the mark Chat can put after an emoji, and the headers the cards had before the shared layout (cards posted then are still in the spaces), are the bot\'s own and never a Burson alert; the emoji and the capitals are both needed, and nothing but " \u00b7 detail" may follow the kind, so a person\'s or another tool\'s line is never taken for a card', () => {
    // the lines under the first: enough labelled lines to pass for a Burson alert (as a Watch alert and an Early Detection card have)
    const taxonomy = '*Product:* Waymo\n*Exposure Tag:* Product - Product failures - physical safety issues (P1)\n' +
      '*Sensitive Topic:* None\n*KOF:* No\n*Author:* FOX 29\n*Summary:* A federal investigation into a Waymo recall.\n';
    const card = head => `${head}\n*Link:* https://x.com/someone/status/1234567890123\n${taxonomy}`;
    const verdict = head => [B.isOwnAlertCardHeader_(card(head)), B.detectAlert_(card(head), B.parseAlert_(card(head)), 'Zapier')];
    const SIREN = '\ud83d\udea8';
    const BOLT = '\u26a1';
    const CHART = '\ud83d\udcc8';
    const SCOPE = '\ud83d\udd2d';
    const VS = '\ufe0f';  // the variation mark Chat can hand back after an emoji
    const own = [
      // the bot's own card today: its first line names the kind of alert (Alert.gs OWN_CARD_TYPES_)
      `${SIREN} *EARLY DETECTION* \u00b7 New story`,
      `${BOLT} *EARLY SIGNAL* \u00b7 3 accounts so far (a story is usually flagged at 5)`,
      `${CHART} *UPDATE* \u00b7 More on a story already alerted`,
      `${SCOPE} *WATCH* \u00b7 Google brand safety (all)`,
      // ... with the mark after the emoji, each of the four
      `${SIREN}${VS} *EARLY DETECTION* \u00b7 New story`,
      `${BOLT}${VS} *EARLY SIGNAL* \u00b7 3 accounts so far (a story is usually flagged at 5)`,
      `${CHART}${VS} *UPDATE* \u00b7 More on a story already alerted`,
      `${SCOPE}${VS} *WATCH* \u00b7 Google brand safety (all)`,
      // ... without Chat's bold marks, and the kind alone (no detail)
      `${SCOPE} WATCH \u00b7 Google brand safety (all)`,
      `${SCOPE} *WATCH*`,
      `${CHART} *UPDATE*`,
      // the headers the cards had before: still the bot's own (cards posted then are still in the spaces)
      `${SCOPE} *Watch alert \u00b7 Google brand safety (all)*`,
      `${SIREN} *Early Detection Alert* ${SIREN}`,
      `${SIREN} *Early Detection Alert: Pixel dialer freeze* ${SIREN}`,
      `${CHART} *Early Detection Update*`,
    ];
    eq(own.filter(head => JSON.stringify(verdict(head)) !== '[true,false]'), []);
    // the cards as the bot writes them and as it wrote them before, whole
    const oldCards = [
      `${SIREN} *Early Detection Alert* ${SIREN}\n*Pixel dialer freeze*\n${taxonomy}\nIt froze: ${CLUSTER_URL}`,
      `${SIREN} *Early Detection Alert: Pixel dialer freeze* ${SIREN}\n*Link:* ${CLUSTER_URL}\n${taxonomy}`,
      `${CHART} *Early Detection Update*\n*Pixel dialer freeze*\n*What's new:* 18 accounts now, up from 9.\n${taxonomy}`,
    ];
    eq(oldCards.map(c => [B.isOwnAlertCardHeader_(c), B.detectAlert_(c, B.parseAlert_(c), 'Zapier')]), oldCards.map(() => [true, false]));
    // not a card: the emoji and the capitals are both needed, and only " \u00b7 detail" may follow the kind
    const notCards = ['Update \u00b7 More on a story', 'WATCH \u00b7 this space', `${SCOPE} Watch \u00b7 this`, `${SCOPE} watch \u00b7 this`,
      `${SCOPE} WATCHING this`, `${SCOPE} WATCH this space`, `${CHART} UPDATE: numbers`, `${CHART} UPDATED figures`,
      `${SIREN} EARLY DETECTIONS \u00b7 New story`, `${BOLT} Early signal \u00b7 3 accounts so far`, `${SIREN} New Alert`];
    eq(notCards.filter(head => B.isOwnAlertCardHeader_(card(head)) || B.ownCardHeadParse_(head)), []);
    // ... so with a Burson alert's lines under it and Zapier as its sender, such a message is still an alert
    eq(notCards.filter(head => B.detectAlert_(card(head), B.parseAlert_(card(head)), 'Zapier') !== true), []);
    // what the first line says, read back: the kind and its detail
    eq([`${SIREN} *EARLY DETECTION* \u00b7 New story`, `${BOLT}${VS} *EARLY SIGNAL* \u00b7 3 accounts so far (a story is usually flagged at 5)`,
      `${CHART} UPDATE \u00b7 More on a story already alerted`, `${SCOPE} *WATCH* \u00b7 Google brand safety (all)`, `${SCOPE} *WATCH*`,
      `${SCOPE} *Watch alert \u00b7 x*`].map(B.ownCardHeadParse_),
    [{ type: 'story', detail: 'New story' }, { type: 'signal', detail: '3 accounts so far (a story is usually flagged at 5)' },
      { type: 'update', detail: 'More on a story already alerted' }, { type: 'watch', detail: 'Google brand safety (all)' },
      { type: 'watch', detail: '' }, null]);
    // the first line as it is written: a detail from outside (a watch's name) carries no markup of its own into it
    eq([B.ownCardHead_('watch', 'A*B <https://evil.example/x|c> | d'), B.ownCardHead_('watch', ''), B.ownCardHead_('story', 'New story')],
      [`${SCOPE} *WATCH* \u00b7 A B https://evil.example/x c d`, `${SCOPE} *WATCH*`, `${SIREN} *EARLY DETECTION* \u00b7 New story`]);
    eq(B.ownCardHeadParse_(B.ownCardHead_('watch', 'A*B <https://evil.example/x|c> | d')), { type: 'watch', detail: 'A B https://evil.example/x c d' });

    // Each kind of card is read back only by its own reader: a Watch alert is no Early Detection card to review, and
    // an Early Detection story, early signal or update is no Watch alert
    const ed = B.edFromRow_(B.edQueueCompact_(clusterRow()));
    const d = { disposition: 'monitor', basis: 'early_detection', why: 'Worth watching', rev: { story: B.edStoryOf_({
      story_title: 'Pixel 9 owners say the overnight update froze the emergency dialer.', story: 'Nine small accounts said the dialer [froze](P1).',
      web_context: '', next_steps: ['Re-check in 2 hours'] }) } };
    const update = { news: '18 accounts now, up from 9', at: NOW - 2 * 3600 * 1000, thread: 'spaces/x/threads/y' };
    const story = B.edStoryCardText_(ed, d, NOW);
    const signal = B.edStoryCardText_(Object.assign({}, ed, { signalType: 'EARLY_WATCH', distinctAuthors: 3 }), d, NOW);
    const updated = B.edStoryCardText_(Object.assign({}, ed, { update }), d, NOW);
    const watch = B.pwAlertText_({ watch: 'Google brand safety (all)', url: CLUSTER_URL, author: '@pixelowner1', network: 'X',
      summary: 'Owners say the overnight update froze the emergency dialer.', products: ['Pixel'], classified: true });
    eq([story, signal, updated, watch].map(c => B.ownCardHeadParse_(c.split('\n')[0]).type), ['story', 'signal', 'update', 'watch']);
    eq([story, signal, updated].map(c => B.pwAlertParse_(c)), [null, null, null]);
    eq([B.edParseCard_(watch, []), B.edParseCard_(watch, [CLUSTER_URL]), B.pwAlertParse_(watch).watch], [null, null, 'Google brand safety (all)']);
    eq([story, signal].map(c => B.edParseCard_(c, []).headline), new Array(2).fill('Pixel 9 owners say the overnight update froze the emergency dialer'));

    // An early signal that is itself an update of an earlier card (the story grew, still below the usual bar) is an
    // UPDATE in that card's thread, with what's new under its headline: never a second EARLY SIGNAL card
    const signalUpdate = B.edStoryCardText_(Object.assign({}, ed, { signalType: 'EARLY_WATCH', distinctAuthors: 4, update }), d, NOW);
    eq(signalUpdate.split('\n').slice(0, 2), [`${CHART} *UPDATE* \u00b7 More on a story already alerted`,
      '*Pixel 9 owners say the overnight update froze the emergency dialer*']);
    assert.match(signalUpdate.split('\n')[2], /^\*What's new:\* 18 accounts now, up from 9 \(since the .+ card\)\.$/);
    eq([signalUpdate.split('\n')[3], B.edParseCard_(signalUpdate, [])], ['*Product:* Brand', null]);
    // the early signal's detail: how many accounts so far, against the usual bar
    eq([3, 1, 0, undefined].map(n => B.edEarlyDetail_({ distinctAuthors: n })), ['3 accounts so far (a story is usually flagged at 5)',
      '1 account so far (a story is usually flagged at 5)', 'a few accounts so far (a story is usually flagged at 5)',
      'a few accounts so far (a story is usually flagged at 5)']);
  });

  test('early detection and watch cards: the words people read say what the code does: the README names every own card\'s first line as the code writes it (an update\'s too: never the header it had before), the Control tab\'s help for row 19 names the card by its first line and says where it goes (the Auto-correct space, B10, when it works alone, too), and the README\'s Direct BigQuery rule gives the 10 minutes after which the last run\'s report no longer counts', () => {
    const readme = require('fs').readFileSync(require('path').join(__dirname, '..', 'README.md'), 'utf8');
    // the first lines the README quotes in code marks are the ones the code writes: all four kinds are there, and
    // whatever it quotes behind the update's or the early signal's emoji is that kind's first line
    const heads = { story: B.ownCardHead_('story', 'New story'), update: B.ownCardHead_('update', 'More on a story already alerted') };
    const quoted = readme.match(/`(?:🚨|⚡|📈|🔭)[^`\n]*`/g) || [];
    const kindOf = q => (B.ownCardHeadParse_(q.slice(1, -1)) || {}).type || '';
    eq(Array.from(new Set(quoted.map(kindOf).filter(Boolean))).sort(), ['signal', 'story', 'update', 'watch']);
    eq(quoted.filter(q => /^`(?:⚡|📈)/.test(q)).map(kindOf).filter(k => k !== 'signal' && k !== 'update'), []);
    eq(quoted.filter(q => kindOf(q) === 'update' || kindOf(q) === 'story').filter(q => q !== `\`${heads.update}\`` && q !== `\`${heads.story}\``), []);
    assert.ok(quoted.filter(q => q === `\`${heads.update}\``).length >= 3, 'the update\'s first line: the cards table, row 19\'s rules and row 39');
    assert.ok(!/Early Detection Update/.test(readme), 'the README no longer names the update by the header it had before');
    const before = readme.match(/Cards posted before this layout \(([^)]*)\) are still read as the bot's own/);
    eq(before && before[1].replace(/\s+/g, ' '), '`🚨 *Early Detection Alert* 🚨`, `🔭 *Watch alert · …*`');
    // the Control tab's help, row 19: the card by its first line, and every place it can go
    const help = B.ev('CONTROL_HELP_').filter(l => /^• Early wave & velocity check: row 19/.test(l));
    eq(help.length, 1);
    assert.match(help[0], /Each one goes out as the bot's own alert card \(its first line says EARLY DETECTION, or UPDATE when it adds to a story already alerted\) in the Mirror space or test feed, or in the Auto-correct space \(B10\) when it works alone \(never S-F Burson\)/);
    assert.ok(!B.ev('CONTROL_HELP_').some(l => /Early Detection Alert card/.test(l)), 'no help line names the card it was before');
    // ... and row 39: an early signal is the same alert card, told apart by its first line
    const help39 = B.ev('CONTROL_HELP_').filter(l => /^• Fast triage: rank and early watch: row 39/.test(l));
    eq(help39.length, 1);
    assert.match(help39[0], /posted as an alert card whose first line says it is an early signal and how many accounts it rests on \(when the story reaches the usual size, that goes in the same thread, never as a second alert\)\.$/);
    eq([heads.story, heads.update].map(h => B.ownCardHeadParse_(h).type), ['story', 'update']);
    assert.ok(heads.story.includes('*EARLY DETECTION*') && heads.update.includes('*UPDATE*'));
    // Direct BigQuery alerts: the last run's report counts for 10 minutes (BigQuery.gs BQ_DIRECT_LAST_RUN_MS_)
    const minutes = B.ev('BQ_DIRECT_LAST_RUN_MS_') / MIN;
    eq(minutes, 10);
    assert.ok(readme.replace(/\s+/g, ' ').includes(`one from more than ${minutes} minutes ago doesn't count (\`BQ_DIRECT_LAST_RUN_MS_\`)`),
      'the README says when the last run\'s report stops counting');
  });

  // ===========================================================================================================
  // 7. The review queue's ceilings: ranking, size, tries and age
  // ===========================================================================================================

  test('early detection review queue: P0 > P1 > P2 then accounts, at most 12 waiting (the lowest-ranked goes, its row too), a queued row under the 9 KB property limit, each signal reviewed at most twice (a run that dies mid-review counts) and dropped 3 hours after it was queued', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const props = g.services.PropertiesService.getScriptProperties();
    const row = (id, pri, au) => clusterRow({ alert_id: id, cluster_id: id, signal_key: id, priority_hint: pri,
      unique_low_tier_authors: au, primary_url: `https://x.com/u/status/${id}` });
    bot.edQueuePut_(props, row('A', 'P2', 30), NOW);
    bot.edQueuePut_(props, row('B', 'P1', 5), NOW + 1);
    bot.edQueuePut_(props, row('C', 'P1', 9), NOW + 2);
    bot.edQueuePut_(props, row('D', 'P0', 2), NOW + 3);
    eq(bot.edQueueList_(props).map(e => e.id), ['D', 'C', 'B', 'A']);
    eq(bot.edQueuePut_(props, row('C', 'P1', 9), NOW + 4), false);
    for (let i = 0; i < 10; i++) bot.edQueuePut_(props, row(`E${i}`, 'P1', 3), NOW + 10 + i);
    const ids = bot.edQueueList_(props).map(e => e.id);
    eq([ids.length, ids.includes('A'), ids[0]], [12, false, 'D']);
    eq(Array.from(g.props.keys()).filter(k => /^ED_ALERT_Q_/.test(k)).length, 12);
    eq(bot.edQueuePut_(props, row('F', 'P2', 1), NOW + 30), false);  // ranked out: never stored

    const long = clusterRow({ representative_posts_json: JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
      platform: 'Reddit', author_id: 'u' + i, url: `https://www.reddit.com/r/x/comments/${'a'.repeat(900)}${i}/`, snippet: 'y'.repeat(2000) }))) });
    const c = bot.edQueueCompact_(long);
    assert.ok(JSON.stringify(c).length <= 8000 && c.posts.length >= 1 && c.posts.length <= 8, String(JSON.stringify(c).length));
    assert.ok(c.posts.every(p => p.snippet.length <= 280));

    const top = bot.edQueueList_(props)[0];
    bot.edQueueTried_(props, top.k);
    bot.edQueueTried_(props, top.k);
    const pruned = bot.edQueuePrune_(props, NOW + 30 * MIN);
    eq([pruned.dropped.map(x => [x.id, x.why]), pruned.list.length], [[['D', '2 reviews started without finishing']], 11]);
    eq(props.getProperty('ED_ALERT_Q_' + top.k), null);
    const stale = bot.edQueuePrune_(props, NOW + 3 * HOUR + MIN);
    eq([stale.dropped.length, stale.list.length, props.getProperty('ED_ALERT_QUEUE')], [11, 0, null]);
    eq(Array.from(g.props.keys()).filter(k => /^ED_ALERT_Q_/.test(k)), []);

    // In a run: Chat not taking the card leaves the signal queued with its review counted; after a second try it's
    // dropped, so a failing signal costs at most 2 Gemini reviews
    const t = ready(e2e());
    switchOn(t);
    fakeBq(t.g, routes([clusterRow()]));
    t.chat.fail = (method, path, query, body) => (method === 'post' && /\/messages$/.test(path) && body && /\*EARLY DETECTION\*/.test(body.text || '')
      ? { code: 500, body: { error: { code: 500, message: 'backend error' } } } : null);
    const edReviews = () => t.g.vertex.calls.filter(x => ((x.payload.generationConfig.responseSchema || {}).properties || {}).early_detection_call).length;
    t.poll();
    eq([JSON.parse(t.g.props.get('ED_ALERT_QUEUE')).map(e => e.tries), edCards(t.chat, TEST_FEED).length, edReviews()], [[1], 0, 1]);
    t.g.clock.now += MIN;
    t.poll();
    eq([JSON.parse(t.g.props.get('ED_ALERT_QUEUE')).map(e => e.tries), edReviews()], [[2], 2]);
    t.g.clock.now += MIN;
    t.poll();
    eq([t.g.props.has('ED_ALERT_QUEUE'), edCards(t.chat, TEST_FEED).length, edReviews()], [false, 0, 2]);
    assert.ok(t.g.logs.some(l => /early detection: dropped ED-CLU-20261014-001 \(2 reviews started without finishing\)/.test(l)), t.g.logs.join('\n'));
  });

  // ===========================================================================================================
  // 8. Same-story dedup: one story, one card, unless it materially grew (then ONE update in the card's thread)
  // ===========================================================================================================

  const edReviewsOf = t => t.g.vertex.calls.filter(x => ((x.payload.generationConfig.responseSchema || {}).properties || {}).early_detection_call).length;
  const monitorReview = title => () => ({
    summary: 'Pixel owners report the dialer freezing after the update.',
    issue_name: 'Pixel dialer freeze after update',
    emerging_narrative: 'Owners say the October update froze the emergency dialer.',
    early_detection_call: { disposition: 'monitor', severity: 'medium', confidence: 0.82, reason: 'Early reports worth watching' },
    known_issue: { matches: false, confidence: 0.9 },
    tns: { needed: false },
    story_title: title || 'Pixel 9 owners say the overnight update froze the emergency dialer',
    story: 'Small accounts say the dialer [froze](P1) after the update.',
    web_context: 'No coverage yet.',
    next_steps: ['Re-check in 2 hours'],
    driver_post: 'P1',
  });

  test('early detection same-story dedup: a repeat with nothing new is held back without a review; a story that doubled and reached a new platform gets ONE update in its first card\'s thread saying what\'s new (the earlier card in the review\'s prompt, no picture); a different cluster sharing 2+ posts is the same story; Control C19 counts the repeats held back', () => {
    const t = ready(e2e());
    switchOn(t);
    let rows = [clusterRow()];
    fakeBq(t.g, routes(() => rows));
    const prompts = [];
    t.g.vertex.earlyDetection = payload => {
      prompts.push(payload);
      const txt = payload.contents[0].parts.map(p => p.text || '').join('\n');
      return monitorReview(txt.includes('"previous_card"') ? 'Dialer freeze reports double and reach TikTok' : null)();
    };

    // 1. The first signal on the story: one review, one card
    t.poll();
    eq([edCards(t.chat, TEST_FEED).length, edReviewsOf(t)], [1, 1]);
    const first = edCards(t.chat, TEST_FEED)[0];

    // 2. The same cluster 15 minutes later with 11 accounts (not 2x 9): held back at the check, no review, no card
    rows = [clusterRow({ alert_id: 'ED-CLU-20261014-002', unique_low_tier_authors: 11, mention_count: 13 })];
    t.g.clock.now += 15 * MIN;
    t.poll();
    eq([edCards(t.chat, TEST_FEED).length, edReviewsOf(t), t.g.props.has('ED_ALERT_QUEUE')], [1, 1, false]);
    assert.ok(t.g.logs.some(l => /early detection: held back a repeat of "Pixel 9 owners say the overnight update froze the emergency dialer": 11 accounts vs 9 on its card at \d{1,2}:\d\d [AP]M ET \(QA-\d+\), nothing new/.test(l)), t.g.logs.join('\n'));
    assert.match(note(t), / · 1 cluster, 0 velocity alert today · 1 repeat held back$/);

    // 3. The same cluster with 21 accounts and a new platform: an update, reviewed with the earlier card in its prompt and
    // posted in the first card's thread (no new top-level card, no picture), its copy in the first copy's thread
    rows = [clusterRow({ alert_id: 'ED-CLU-20261014-003', unique_low_tier_authors: 21, mention_count: 25, platforms_csv: 'X, Reddit, Owned Social, TikTok' })];
    t.g.clock.now += 15 * MIN;
    t.poll();
    eq([edCards(t.chat, TEST_FEED).length, edReviewsOf(t)], [1, 2]);
    const update = t.chat.botPosts(TEST_FEED).find(m => m.threadReply && /^\ud83d\udcc8 \*UPDATE\* \u00b7 More on a story already alerted\n/.test(m.text));
    assert.ok(update, t.chat.botPosts(TEST_FEED).map(m => m.text).join('\n---\n'));
    eq([update.thread.name, /^client-zeda-/.test(update.clientAssignedMessageId || '')], [first.thread.name, true]);
    assert.ok(update.text.startsWith('\ud83d\udcc8 *UPDATE* \u00b7 More on a story already alerted\n*Dialer freeze reports double and reach TikTok*\n' +
      '*What\'s new:* 21 accounts now, up from 9; now also on TikTok (since the '), update.text);
    assert.ok(/ \(since the \d{1,2}:\d\d [AP]M ET card\)\.\n\*Product:\* /.test(update.text), update.text);
    assert.ok(update.text.includes('\n*Call:* \ud83d\udc4d Monitor build-up: Early reports worth watching\n' +
      '*Activity:* 21 small accounts on X, Reddit, Owned Social and TikTok posted about this 25 times'), update.text);
    eq(update.attachment || [], []);
    eq(B.outboxGuardHits_(update.text, { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] }), []);
    assert.ok(update.text.length <= 3900);
    const sent = JSON.parse(prompts[1].contents[0].parts.map(p => p.text || '').join('').match(/<early_detection_signal>\n([\s\S]*)\n<\/early_detection_signal>/)[1]);
    eq([sent.previous_card.title, sent.previous_card.accounts, sent.previous_card.platforms, sent.previous_card.whats_new],
      ['Pixel 9 owners say the overnight update froze the emergency dialer', 9, 'X, Reddit, Owned Social', '21 accounts now, up from 9; now also on TikTok']);
    assert.ok(prompts[1].systemInstruction.parts[0].text.includes('`previous_card` (only on an update)'));
    const firstCopy = t.chat.botPosts(TRIAGED).find(m => !m.threadReply && /\*EARLY DETECTION\*/.test(m.text));
    const updCopy = t.chat.botPosts(TRIAGED).find(m => m.threadReply && /^\ud83d\udcc8 \*UPDATE\*/.test(m.text));
    assert.ok(firstCopy && updCopy, t.chat.botPosts(TRIAGED).map(m => m.text).join('\n---\n'));
    eq(updCopy.thread.name, firstCopy.thread.name);
    assert.ok(t.chat.botPosts(TRIAGED).some(m => m.threadReply && m.thread.name === firstCopy.thread.name && m.name !== updCopy.name &&
      /Early Detection Review: 👍 Monitor build-up/.test(m.text) && m.createTime >= updCopy.createTime), 'the update\'s review note is in the thread');
    const edRows = t.bot.sheetBackend_(t.sheet()).loadAlerts().filter(r => r.ingested === 'Early detection');
    eq(edRows.length, 2);
    eq([edRows[0].forwarded_fields.early_detection.cluster_id, edRows[0].forwarded_fields.early_detection.ed_alert_id,
      edRows[0].forwarded_fields.early_detection.post_keys, edRows[1].forwarded_fields.early_detection.update_of],
      ['clu_8f91a2', 'ED-CLU-20261014-001', ['x.com/status/2140000000000000001', 'reddit.com/comments/1k9xyz', 'instagram.com/p/DBabc123'], edRows[0].alert_id]);

    // 4. A different cluster sharing 2 of the posts, with 30 accounts (not 2x the 21 on the update): the same story, held back
    rows = [clusterRow({ alert_id: 'ED-CLU-OTHER-1', cluster_id: 'clu_other', signal_key: 'clu_other', unique_low_tier_authors: 30,
      primary_url: 'https://x.com/newposter/status/2140000000000000077',
      representative_posts_json: JSON.stringify([
        { platform: 'X', author_handle: 'newposter', url: 'https://x.com/newposter/status/2140000000000000077', snippet: 'The dialer froze again' },
        { platform: 'X', author_handle: 'pixelowner1', url: CLUSTER_URL, snippet: 'Overnight update froze the emergency dialer' },
        { platform: 'Reddit', author_handle: 'u_droidcommuter', url: REDDIT_URL, snippet: 'Same thing here' },
      ]) })];
    t.g.clock.now += 15 * MIN;
    t.poll();
    eq([edCards(t.chat, TEST_FEED).length, edReviewsOf(t), t.chat.botPosts(TEST_FEED).filter(m => /^\ud83d\udcc8 \*UPDATE\*/.test(m.text)).length], [1, 2, 1]);
    assert.ok(t.g.logs.some(l => /held back a repeat of "Dialer freeze reports double and reach TikTok": 30 accounts vs 21 on its card/.test(l)), t.g.logs.join('\n'));
    assert.match(note(t), / · 2 cluster, 0 velocity alerts today · 2 repeats held back$/);
    eq(lastRun(t).errors, []);
  });

  test('early detection same-story dedup after the review: a review that finds the issue already alerted with nothing materially new posts no card (one Gemini call, the signal leaves the queue, C19 counts it)', () => {
    const t = ready(e2e());
    switchOn(t);
    fakeBq(t.g, routes([clusterRow()]));
    t.g.vertex.earlyDetection = monitorReview();
    t.bot.ev('knownIssueSkip_ = () => \'already alerted as a known issue (QA-4228, "AI Mode Teen Safety Lawsuit"): nothing materially new\'');
    t.poll();
    eq([edCards(t.chat, TEST_FEED).length, edReviewsOf(t), t.g.props.has('ED_ALERT_QUEUE')], [0, 1, false]);
    eq(t.chat.botPosts(TRIAGED).filter(m => /Early Detection|EARLY DETECTION|EARLY SIGNAL|\*UPDATE\*/.test(m.text)), []);
    assert.ok(t.g.logs.some(l => /early detection: held back "Pixel 9 owners say the overnight update froze the emergency dialer" after its review: already alerted as a known issue \(QA-4228/.test(l)), t.g.logs.join('\n'));
    assert.match(note(t), / · 0 cluster, 0 velocity alerts today · 1 repeat held back$/);
    eq(lastRun(t).errors, []);
  });

  test('early detection skips a signal whose primary post another alert (Burson\'s, Direct BigQuery\'s) covered in the last 24h, reading this space pair\'s Alert log; a signal on another post is still queued and carded', () => {
    const t = ready(e2e());
    switchOn(t);
    t.bot.sheetBackend_(t.sheet()).appendAlert({ alert_id: 'QA-0999', created_at: t.g.clock.now, space: `${TEST_FEED} > ${TRIAGED}`,
      source_message: `${TEST_FEED}/messages/burson1`, record_key: 'x.com/status/2140000000000000001', status: 'ok', ingested: '' });
    let rows = [clusterRow()];
    fakeBq(t.g, routes(() => rows));
    t.g.vertex.earlyDetection = monitorReview();
    t.poll();
    eq([edCards(t.chat, TEST_FEED).length, edReviewsOf(t), t.g.props.has('ED_ALERT_QUEUE')], [0, 0, false]);
    rows = [velocityRow()];
    t.g.clock.now += 15 * MIN;
    t.poll();
    eq([edCards(t.chat, TEST_FEED).length, edReviewsOf(t)], [1, 1]);
  });

  test('early detection same-story dedup at review time: of two queued signals on one story, the bigger is carded first and the smaller is dropped without a review once that card exists', () => {
    const t = ready(e2e());
    switchOn(t);
    fakeBq(t.g, routes([]));
    t.g.vertex.earlyDetection = monitorReview();
    const props = t.g.services.PropertiesService.getScriptProperties();
    t.bot.edQueuePut_(props, clusterRow({ alert_id: 'ED-CLU-SMALL', unique_low_tier_authors: 9 }), t.g.clock.now);
    t.bot.edQueuePut_(props, clusterRow({ alert_id: 'ED-CLU-BIG', unique_low_tier_authors: 14, primary_url: REDDIT_URL }), t.g.clock.now + 1);
    t.poll();
    eq([edCards(t.chat, TEST_FEED).length, edReviewsOf(t), t.g.props.has('ED_ALERT_QUEUE')], [1, 1, false]);
    assert.ok(edCards(t.chat, TEST_FEED)[0].text.includes('\n*Activity:* 14 small accounts on'), edCards(t.chat, TEST_FEED)[0].text);
    assert.ok(t.g.logs.some(l => /early detection: held back a repeat \(ED-CLU-SMALL\): 9 accounts vs 14 on its card at \d{1,2}:\d\d [AP]M ET \(QA-\d+\), nothing new/.test(l)), t.g.logs.join('\n'));
    assert.match(note(t), / · 1 cluster, 0 velocity alert today · 1 repeat held back$/);
  });

  test('early detection same-story dedup rules: what counts as new (2x and 3 more accounts, or a platform the card didn\'t list), which cards tell the same story (same cluster, the alert BigQuery says it updates, the same term group, 2+ shared posts, its own card), the seen counts in both formats, and the seen map under the 9 KB property limit', () => {
    const story = o => B.edRowStory_(clusterRow(o || {}));
    eq([
      B.edUpdateNews_(story({ unique_low_tier_authors: 18 }), { au: 9, plats: [] }),
      B.edUpdateNews_(story({ unique_low_tier_authors: 17 }), { au: 9, plats: [] }),
      B.edUpdateNews_(story({ unique_low_tier_authors: 4 }), { au: 2, plats: [] }),
      B.edUpdateNews_(story({ unique_low_tier_authors: 6 }), { au: 3, plats: [] }),
      B.edUpdateNews_(story({ platforms_csv: 'X, Reddit, TikTok, YouTube' }), { au: 9, plats: ['x', 'Reddit'] }),
      B.edUpdateNews_(story({ platforms_csv: 'X, TikTok' }), { au: 9, plats: [] }),
      B.edUpdateNews_(story({ unique_low_tier_authors: 50 }), { au: Infinity, plats: [] }),
      B.edUpdateNews_(story({ unique_low_tier_authors: 50 }), { au: 0, plats: [] }),
    ], ['18 accounts now, up from 9', '', '', '6 accounts now, up from 3', 'now also on TikTok and YouTube', '', '', '']);

    const card = { row: 'QA-1', ed: 'ED-CLU-A', cid: 'clu_a', sk: 'clu_a', sig: 'CLUSTER_EMERGENCE', grain: '', au: 9, plats: ['X'],
      keys: new Set(['x.com/status/1', 'x.com/status/2']), msg: 'spaces/S/messages/m1', thread: 'spaces/S/threads/t1',
      fwdThread: 'spaces/A/threads/f1', title: 'Card one', at: NOW };
    const posts = urls => JSON.stringify(urls.map(u => ({ platform: 'X', author_id: 'a', url: u, snippet: 's' })));
    const same = o => !!B.edStoryPrior_(story(Object.assign({ cluster_id: 'clu_b', primary_url: 'https://x.com/z/status/9', representative_posts_json: '[]' }, o)), [card]);
    eq([
      same({ cluster_id: 'clu_a' }),
      same({ update_of_alert_id: 'ED-CLU-A' }),
      same({ alert_id: 'ED-CLU-A' }),
      same({ primary_url: 'https://x.com/u/status/1', representative_posts_json: posts(['https://x.com/u/status/1', 'https://twitter.com/v/statuses/2', 'https://x.com/w/status/3']) }),
      same({ primary_url: 'https://x.com/u/status/1', representative_posts_json: posts(['https://x.com/u/status/1', 'https://x.com/w/status/3']) }),
      same({ primary_url: 'https://x.com/u/status/1', representative_posts_json: '[]' }),
      same({}),
    ], [true, true, true, true, false, true, false]);
    const termCard = { row: 'QA-2', ed: 'ED-VEL-1', cid: '', sk: 'outage_broken_feature', sig: 'VELOCITY_SPIKE', grain: 'RISK_TERM_GROUP', au: 8, plats: [], keys: new Set(), at: NOW };
    const term = o => B.edRowStory_(velocityRow(Object.assign({ cluster_id: '', velocity_grain: 'RISK_TERM_GROUP', signal_key: 'Outage_Broken_Feature', primary_url: '', representative_posts_json: '[]' }, o)));
    eq([!!B.edStoryPrior_(term(), [termCard]), !!B.edStoryPrior_(term({ velocity_grain: 'PRIORITY_TOPIC' }), [termCard])], [true, false]);

    eq(B.edStoryVerdict_(clusterRow({ cluster_id: 'clu_new' }), [card], null, NOW), {});
    eq(B.edStoryVerdict_(clusterRow({ cluster_id: 'clu_new' }), [card], 9, NOW).hold, 'already queued in the last 24 hours with 9 accounts, nothing new');
    eq(B.edStoryVerdict_(clusterRow({ cluster_id: 'clu_new' }), [card], Infinity, NOW).hold, 'already queued in the last 24 hours, nothing new');
    eq(B.edStoryVerdict_(clusterRow({ cluster_id: 'clu_new', unique_low_tier_authors: 21 }), [card], 9, NOW), {});
    eq(B.edStoryVerdict_(clusterRow({ cluster_id: 'clu_a', unique_low_tier_authors: 12, platforms_csv: 'X' }), [card], null, NOW).hold, '12 accounts vs 9 on its card at 8:00 AM ET (QA-1), nothing new');
    const upd = B.edStoryVerdict_(clusterRow({ cluster_id: 'clu_a', unique_low_tier_authors: 21 }), [card], null, NOW).update;
    eq(upd, { row: 'QA-1', ed: 'ED-CLU-A', msg: 'spaces/S/messages/m1', thread: 'spaces/S/threads/t1', fwd: 'spaces/A/threads/f1', title: 'Card one',
      au: 9, plats: 'X', at: NOW, news: '21 accounts now, up from 9; now also on Reddit and Owned Social' });
    eq(B.edStoryVerdict_(clusterRow({ alert_id: 'ED-CLU-A', cluster_id: 'clu_a', unique_low_tier_authors: 90 }), [card], null, NOW).hold, 'its card is already in the space (QA-1)');
    // the update rides along in the queued row and back out to the review
    const queued = B.edQueueCompact_(Object.assign(clusterRow(), { update_of: upd }));
    eq([B.edFromRow_(queued).update.news, B.edFromRow_(B.edQueueCompact_(clusterRow())).update], ['21 accounts now, up from 9; now also on Reddit and Owned Social', null]);

    eq(B.edRowKeys_(clusterRow()), ['id:ED-CLU-20261014-001', 'cl:clu_8f91a2', 'url:x.com/status/2140000000000000001']);
    eq(B.edRowKeys_(velocityRow({ cluster_id: '', velocity_grain: 'RISK_TERM_GROUP', signal_key: 'Outage' })),
      ['id:ED-VEL-CLUSTER-9912-202610141200', 'sk:VELOCITY_SPIKE:RISK_TERM_GROUP:outage', 'url:reddit.com/comments/1k9abc0']);
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const props = g.services.PropertiesService.getScriptProperties();
    props.setProperty('EARLY_DETECTION_SEEN', JSON.stringify({ [bot.hashText_('cl:old')]: NOW - HOUR }));
    const seen = bot.earlyWaveSeen_(props, NOW);
    seen.add('cl:new', NOW, 12);
    seen.add('id:x', NOW, 0);
    assert.strictEqual(seen.authors(['cl:old']), Infinity);  // from before the counts were kept: held back as it always was
    eq([seen.authors(['cl:new', 'url:none']), seen.authors(['url:none']), seen.has('id:x'), seen.has('cl:old')], [12, null, true, true]);
    seen.save();
    const saved = JSON.parse(props.getProperty('EARLY_DETECTION_SEEN'));
    eq([saved[bot.hashText_('cl:new')], saved[bot.hashText_('id:x')], saved[bot.hashText_('cl:old')]], [[NOW, 12], NOW, NOW - HOUR]);
    const big = {};
    for (let i = 0; i < 400; i++) big[bot.hashText_(`url:x.com/status/${1e15 + i}`)] = [NOW - i * 1000, 100000 + i];
    const pruned = bot.pruneEarlyWaveSeen_(big, NOW);
    assert.ok(Object.keys(pruned).length <= 200 && JSON.stringify(pruned).length <= 8800, String(JSON.stringify(pruned).length));
    eq(Object.keys(bot.pruneEarlyWaveSeen_({ a: NOW - 25 * HOUR, b: [NOW - 25 * HOUR, 3], c: [NOW, 3] }, NOW)), ['c']);
  });

  test('standalone Auto-correct space (B10 with B9 and B4 blank): hosts rewritten auto-corrected Burson alerts AND Early Detection cards in B10 with zero writes to S-F Burson', () => {
    const t = ready(e2e());
    const AC = 'spaces/AAQAautocorrect1';
    t.chat.addSpace(AC, 'SLRR Unified Auto-correct');
    t.set('B25', REAL);
    t.control().getRange(3, 2).setValue(`https://chat.google.com/app/chat/${AC.replace('spaces/', '')}`);
    t.control().getRange(4, 2).setValue('');   // B4 blank (user's single-space B10 layout)
    t.control().getRange(9, 2).setValue('');   // B9 blank -> Early Wave routes to B10
    t.control().getRange(10, 2).setValue('SLRR Unified Auto-correct');
    t.control().getRange(23, 2).setValue('ON');
    switchOn(t);
    fakeBq(t.g, routes([clusterRow()]));
    t.g.vertex.earlyDetection = monitorReview();

    t.poll();  // initializes AC cursor floor & posts first Early Detection story card into B10
    t.g.clock.now += MIN;
    t.chat.say(REAL, H.F.MISTAKES, { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' });
    t.poll();

    eq(t.get('B5'), '\u2705 Working');
    const acTop = t.chat.botPosts(AC).filter(m => !m.threadReply);
    assert.ok(acTop.some(m => m.text === '\u2705 *Reviewed and corrected by the agentic assistant*\n' + H.F.MISTAKES_FIXED),
      'rewritten auto-corrected Burson card in B10 (no raw Zapier card)');
    assert.ok(!acTop.some(m => m.text === H.F.MISTAKES || m.text.endsWith('\n' + H.F.MISTAKES)), 'raw Zapier card is NEVER posted in B10');
    assert.ok(acTop.some(m => /^\ud83d\udea8 \*EARLY DETECTION\* \u00b7 New story\n\*Pixel 9 owners say the overnight update froze the emergency dialer\*/.test(m.text)),
      'Early Detection story card posted in B10 when B9 is blank');
    const edReplies = t.chat.botPosts(AC).filter(m => m.threadReply && /Early Detection Review:/.test(m.text));
    eq(edReplies.length, 1);
    eq(t.chat.botPosts(REAL), []);
  });

};
