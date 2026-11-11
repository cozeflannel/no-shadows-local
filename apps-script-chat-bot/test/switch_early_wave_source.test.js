// EarlyWaveSource.gs: in-Apps-Script low-tier embedding cluster & velocity producer over the 6 approved BigQuery social
// tables + Vertex AI text-embedding-005 (Vectors.gs), feeding BigQuery.gs bqEarlyDetectionRows_ (Control row 19).
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, makeGoogle, loadBot } = H;
  const MIN = 60 * 1000;

  const EWS_COLS = [
    ['kind'], ['lane'], ['mid'], ['url'], ['platform'], ['author'],
    ['audience', 'INTEGER'], ['eng', 'INTEGER'], ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'],
    ['txt'], ['topic'], ['chash'], ['sig'], ['risk'], ['brand', 'BOOLEAN'],
  ];

  function makeEnv(answer) {
    const g = makeGoogle(NOW);
    const bqCalls = [];
    const origFetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (!String(url).startsWith('https://bigquery.googleapis.com/')) return origFetch(url, params);
      const body = JSON.parse(params.payload || '{}');
      const loc = body.location || 'US';
      bqCalls.push({ url, loc, sql: body.query || '', params: body.queryParameters || [] });
      const rows = (answer && answer(loc, body)) || [];
      return {
        getResponseCode: () => 200,
        getHeaders: () => ({}),
        getContentText: () => JSON.stringify({
          jobComplete: true,
          jobReference: { projectId: 'brand-social-central-data', jobId: `ews_${bqCalls.length}`, location: loc },
          schema: { fields: EWS_COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
          rows: rows.map(r => ({
            f: EWS_COLS.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })),
          })),
        }),
      };
    };
    return { g, b: loadBot(g.services, g.clock), bqCalls };
  }

  const postRow = (i, o) => Object.assign({
    kind: 'post',
    lane: i % 2 === 0 ? 'sonar' : 'spk',
    mid: `M-${i}`,
    url: i % 2 === 0 ? `https://x.com/pixeluser${i}/status/215000000000000000${i}` : `https://www.reddit.com/r/GooglePixel/comments/1z${i}abc/dialer_freeze/`,
    platform: i % 2 === 0 ? 'twitter' : 'reddit',
    author: `pixeluser${i}`,
    audience: 320,
    eng: 14,
    posted_ms: NOW - (10 - i) * MIN,
    seen_ms: NOW - (9 - i) * MIN,
    txt: 'Pixel 9 emergency dialer screen freezes completely right after installing the overnight Android update patch',
    topic: 'Pixel',
    chash: `hash_${i}`,
    sig: `sig_author_${i}`,
    risk: 'outage_broken_feature,safety_harm',
    brand: true,
  }, o || {});

  test('EarlyWaveSource SQL: strict 6-table & cross-region isolation, read-only temporary queries, B31 initial window', () => {
    const T = Date.UTC(2026, 10, 11, 14, 0);
    const us = B.ewsLaneQuery_('us', { marks: {} }, T, true, 45);
    const c1 = B.ewsLaneQuery_('c1', { marks: {} }, T, true, 45);
    eq([us.win.until - us.win.since, c1.win.until - c1.win.since], [45 * MIN, 45 * MIN]);
    assert.ok(us.sql.includes('`brand-social-central-data.reporting_data.sprinklr_inbound_comments`'));
    assert.ok(us.sql.includes('`brand-social-central-data.raw_data.brandwatch_raw_mentions_base`'));
    assert.ok(us.sql.includes('`brand-social-central-data.reporting_data.sprinklr_outbound_reporting`'));
    assert.ok(us.sql.includes('`brand-social-central-data.DSD.DSD-story-selection`'));
    assert.ok(!/bsip-s-bsip-gg-26-2cf3|tubular_videos|vw_chatbot_pending_early_alerts/.test(us.sql));
    assert.ok(c1.sql.includes('`bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`'));
    assert.ok(c1.sql.includes('`brand-social-central-data.google_tubular_mentions.tubular_videos`'));
    assert.ok(!/reporting_data|raw_data|DSD|vw_chatbot_pending_early_alerts/.test(c1.sql));
    assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|CREATE\s+TABLE)\b/i.test(us.sql + '\n' + c1.sql));
  });

  test('EarlyWaveSource producer (ewsRows_): embeds low-tier posts via Vertex AI, drops evergreen noise & DSD/own exclusions, promotes cross-platform cluster, enforces cooldown & property/cache caps', () => {
    const c1Rows = [
      postRow(1, { lane: 'sonar', platform: 'twitter', url: 'https://x.com/u1/status/2150000000000000001', author: 'u1' }),
      postRow(2, { lane: 'sonar', platform: 'twitter', url: 'https://x.com/u2/status/2150000000000000002', author: 'u2' }),
      postRow(3, { lane: 'sonar', platform: 'reddit', url: 'https://www.reddit.com/r/GooglePixel/comments/1z3abc/dialer_freeze/', author: 'u3' }),
      // Evergreen noise post -> must be dropped by vecEvergreenOfVecs_
      postRow(7, { lane: 'sonar', platform: 'twitter', url: 'https://x.com/photog/status/2150000000000000007', author: 'photog',
        txt: 'Shot on Pixel #TeamPixel', chash: 'evergreen_1', risk: '' }),
      // Already alerted in DSD -> must be excluded by xurl
      postRow(8, { lane: 'sonar', platform: 'twitter', url: 'https://x.com/alerted/status/2150000000000000008', author: 'alerted',
        chash: 'excl_url' }),
      // KOF author in DSD -> must be excluded by xkof
      postRow(9, { lane: 'sonar', platform: 'twitter', url: 'https://x.com/bigkof/status/2150000000000000009', author: 'bigkof',
        chash: 'excl_kof' }),
    ];
    const usRows = [
      postRow(4, { lane: 'spk', platform: 'instagram', url: 'https://www.instagram.com/p/DCdialer4/', author: 'u4' }),
      postRow(5, { lane: 'spk', platform: 'youtube', url: 'https://www.youtube.com/watch?v=dialerFreeze5', author: 'u5' }),
      // Owned Google account -> must be excluded by own
      postRow(6, { lane: 'spk', platform: 'twitter', url: 'https://x.com/madebygoogle/status/2150000000000000006', author: 'madebygoogle',
        chash: 'excl_own' }),
      { kind: 'xurl', lane: 'dsd', url: 'https://x.com/alerted/status/2150000000000000008' },
      { kind: 'xkof', lane: 'dsd', platform: 'twitter', author: 'bigkof' },
      { kind: 'own', lane: 'outbound', platform: 'twitter', author: 'madebygoogle' },
    ];

    let batch = 'first';
    const { g, b, bqCalls } = makeEnv(loc => {
      if (batch !== 'first') return [];
      return loc === 'us-central1' ? c1Rows : usRows;
    });

    const emitted = b.bqEarlyDetectionRows_(30);
    eq(bqCalls.map(c => c.loc).sort(), ['US', 'us-central1']);
    eq(emitted.length, 1);
    const sig = emitted[0];
    eq(sig.signal_type, 'CLUSTER_EMERGENCE');
    eq(sig.unique_low_tier_authors, 5);
    assert.ok(sig.platform_count >= 2, String(sig.platform_count));
    const reps = JSON.parse(sig.representative_posts_json);
    assert.ok(reps.length >= 2 && reps.every(r => !['alerted', 'bigkof', 'madebygoogle', 'photog'].includes(r.author_handle)));

    // Card formatting & leak guard clean
    const card = b.edAlertCardText_(sig);
    assert.ok(card.startsWith('🚨 *Early Detection Alert: '), card);
    eq(b.outboxGuardHits_(card, { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] }), []);

    // State & cache limits respected
    const st = JSON.parse(g.props.get('EWS_STATE'));
    eq(st.last.evergreen, 1);
    assert.ok(g.props.get('EWS_STATE').length < 8500);
    assert.ok((g.props.get('EWS_ROLLUP') || '').length < 8500);
    for (const v of g.cache.values()) assert.ok(String(v).length < 95000, `cache item too large: ${String(v).length}`);

    // Next check 15 min later with no new posts: buffer still holds the emitted row, zero duplicate re-emission
    batch = 'empty';
    g.clock.now += 15 * MIN;
    const again = b.bqEarlyDetectionRows_(30);
    eq(again.map(r => r.alert_id), [sig.alert_id]);
  });
};
