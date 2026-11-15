// Direct BigQuery alerts, the review's H2 and H6 (BigQuery.gs): BSIP's placeholder rule needs real engagement on a post
// Pendulum saw in the BigQuery lookback (Control tab B31: 15 to 60 minutes) that went live in the last 48 hours
// (Pendulum's HIGH rating alone no longer counts), the most engaged first; at most 2 posts a check; and no check at all
// while the Burson space's alerts wait: the last run ran out of time, or 3 or more of the posts the poll took are still
// waiting to be reviewed. The numbers are named placeholders for the SLRR leads.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, world, e2e, TEST_FEED } = H;
  const ROW = 15;
  const COLS = {
    us: [['source_kind'], ['id'], ['url'], ['handle'], ['network'], ['product'], ['brand'], ['total_comments', 'INTEGER'],
      ['neg_comments', 'INTEGER'], ['neg_pct', 'FLOAT'], ['snippet'], ['post_time'], ['kof'], ['tier'], ['followers', 'INTEGER'],
      ['top_neg_comments']],
    bsip: [['source_kind'], ['id'], ['url'], ['handle'], ['network'], ['alert_names_json'], ['tags'], ['criticality'],
      ['followers', 'INTEGER'], ['total', 'INTEGER'], ['summary'], ['issue_name'], ['post_time']],
    log: [['url']],
  };
  const url = n => `https://x.com/critic${n}/status/21170000000000000${10 + n}`;
  const bmieRow = n => ({ source_kind: 'BMIE', id: String(-n), url: url(n), handle: `@critic${n}`, network: 'X', product: 'Chrome',
    brand: 'Chrome Overall', total_comments: 1450, neg_comments: 0, neg_pct: 0, snippet: 'The new Chrome update broke my tabs.',
    post_time: '2026-10-14 11:20:00', kof: null, tier: 'MODERATE', followers: 92400, top_neg_comments: null });
  const bsipRow = (n, total) => ({ source_kind: 'BSIP', id: String(n), url: url(n), handle: `critic${n}`, network: 'Twitter',
    alert_names_json: '["Google Maps - Accuracy"]', tags: 'Maps routing', criticality: 'HIGH', followers: 5100, total,
    summary: 'An X user says Google Maps sent drivers onto a closed bridge.', issue_name: 'Maps routing onto a closed bridge',
    post_time: '2026-10-14 11:40:00+00' });
  const kindOf = c => (/^WITH existing_slrr AS \(/.test(c.sql) ? (/sprinklr_candidates AS/.test(c.sql) ? 'spr' : 'bmie')
    : /"BSIP" AS source_kind/.test(c.sql) ? 'bsip' : /SPLIT\(@urls, " "\)/.test(c.sql) ? 'log' : '');
  /** A fake BigQuery for the poll's queries: r = {us, bsip, log} rows (each US query gets its own source's). */
  const fakeBq = (g, r) => {
    const calls = [];
    const orig = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (u, params) => {
      if (!u.startsWith('https://bigquery.googleapis.com/')) return orig(u, params);
      const body = JSON.parse(params.payload);
      const call = { sql: body.query || '', location: body.location || 'US',
        params: Object.fromEntries((body.queryParameters || []).map(p => [p.name, p.parameterValue.value])) };
      calls.push(call);
      const k = kindOf(call);
      const key = k === 'spr' || k === 'bmie' ? 'us' : k;
      const rows = !k ? [] : (r[key] || []).filter(x => key !== 'us' || x.source_kind === (k === 'spr' ? 'SPRINKLR' : 'BMIE'));
      const cols = COLS[key] || [['url']];
      const text = JSON.stringify({ jobComplete: true, schema: { fields: cols.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: rows.map(x => ({ f: cols.map(c => ({ v: x[c[0]] === undefined || x[c[0]] === null ? null : String(x[c[0]]) })) })) });
      return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => text };
    };
    return calls;
  };
  const onCtx = w => {
    const ctx = Object.assign(w.ctx(), { switches: Object.assign(w.bot.switchesOff_(), { directBq: true }) });
    Object.assign(ctx.settings, { bq_direct_poll: true, bq_poll_sprinklr: true, bq_poll_bmie: true, bq_poll_bsip: true });
    return ctx;
  };
  const synth = (chat, space) => chat.botPosts(space).filter(m => !m.threadReply && /^THIS ALERT MEETS/.test(m.text));
  const linkOf = m => m.text.match(/\[Link\]: (\S+)/)[1];
  const note = w => JSON.parse(w.g.props.get('SWITCH_NOTES')).directBq.text;
  /** The poll's result: nothing posted or skipped unless `o` says so */
  const res = o => Object.assign({ sprinklr: 0, bmie: 0, bsip: 0, skipped_duplicates: 0, skipped_step1: 0, skipped_no_count: 0 }, o);

  test('direct BQ limits: the placeholders are named for the SLRR leads (500 engagements, a BSIP post from the last 48 hours that Pendulum saw in the BigQuery lookback: 15 to 60 minutes, 60 unless B31 says otherwise, 2 posts a check, 3 waiting)', () => {
    eq([B.ev('BQ_BSIP_MIN_ENGAGEMENTS_'), B.ev('BQ_POLL_MAX_PER_RUN_'), B.ev('BQ_DIRECT_MAX_WAITING_')], [500, 2, 3]);
    eq([B.ev('BQ_LOOKBACK_SHORTEST_MIN_'), B.ev('BQ_LOOKBACK_LONGEST_MIN_'), B.ev('BQ_LOOKBACK_DEFAULT_MIN_')], [15, 60, 60]);
    eq(B.ev('BQ_BSIP_MAX_AGE_H_'), 48);  // BSIP posts reach 500 engagements hours after going live
    // Whatever the settings say, never more than an hour (nor less than 15 minutes)
    eq([undefined, 0, 'x', 10, 15, 30, 45, 60, 90, 48 * 60].map(n => B.bqLookbackMinutes_({ bq_lookback_minutes: n })),
      [60, 60, 60, 15, 15, 30, 45, 60, 60, 60]);
  });

  test('direct BQ limits: BSIP\'s rule needs the engagement floor (HIGH alone no longer counts) on a post Pendulum saw in the BigQuery lookback that went live in the last 48 hours (its own time, not Pendulum\'s update), the most engaged first; the poll posts in that order', () => {
    const w = world();
    const calls = fakeBq(w.g, { us: [], bsip: [bsipRow(1, 9000), bsipRow(2, 4000), bsipRow(3, 600)], log: [] });
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR), res({ bsip: 2 }));
    eq(synth(w.chat, w.BUR).map(linkOf), [url(1), url(2)]);  // as BigQuery ranked them, 2 a check
    const bsip = calls.find(c => kindOf(c) === 'bsip');
    assert.ok(/total >= @min_total/.test(bsip.sql), bsip.sql);
    assert.ok(!/criticality, ""\)\) = "HIGH"|OR UPPER/.test(bsip.sql), 'the HIGH-only branch is gone');
    assert.ok(bsip.sql.includes('WHERE received_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @minutes MINUTE)'), bsip.sql);  // partition
    assert.ok(bsip.sql.includes('HAVING post_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @max_age_hours HOUR)'), bsip.sql);
    // A go-live window as short as the lookback let no BSIP post through (none reaches 500 engagements that fast)
    assert.ok(!/post_ts >= TIMESTAMP_SUB\(CURRENT_TIMESTAMP\(\), INTERVAL @minutes MINUTE\)/.test(bsip.sql), bsip.sql);
    assert.ok(/\nORDER BY total DESC, seen_at DESC LIMIT 15$/.test(bsip.sql), bsip.sql);
    eq([bsip.location, bsip.params], ['us-central1', { minutes: '60', min_total: '500', max_age_hours: '48' }]);
    // A HIGH post with no engagement isn't a candidate any more (the rule is in the SQL; here BigQuery returns none)
    const card = B.formatBsipSonarAlertText_(bsipRow(4, 0));
    assert.ok(/\[Engagement\]: VERY LOW \(0 engagements\)/.test(card), card);
  });

  test('direct BQ limits: no check while the last run ran out of time (no BigQuery query, column C and the log say why); the next check after a run that finished goes ahead', () => {
    const w = world();
    const calls = fakeBq(w.g, { us: [bmieRow(1)], bsip: [], log: [] });
    w.g.props.set('LAST_RUN', JSON.stringify({ at: '2026-10-14T11:58:00.000Z', errors: ['time budget reached; the rest is handled next run'] }));
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR), res({}));
    eq([calls.length, synth(w.chat, w.BUR)], [0, []]);
    assert.match(note(w), /^last check .* \(not checked: the last run ran out of time; it tries again at the next check\) · 0 posts today$/);
    assert.ok(w.g.logs.includes('BigQuery direct poll skipped: the last run ran out of time (the Burson space\'s alerts come first)'));
    // The next check (5 minutes on), after a run that didn't run out of time
    w.g.props.set('LAST_RUN', JSON.stringify({ at: '2026-10-14T12:03:00.000Z', errors: [] }));
    w.g.clock.now += 5 * 60e3;
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR).bmie, 1);
    // Only a main run writes LAST_RUN. One it left more than 10 minutes ago says nothing about now: with the Auto-correct
    // space working alone (B10, no main run to write a newer one) the poll is not held back for good by that old report
    const alone = world();
    const aloneCalls = fakeBq(alone.g, { us: [bmieRow(1)], bsip: [], log: [] });
    alone.g.props.set('LAST_RUN', JSON.stringify({ at: '2026-10-14T11:40:00.000Z', errors: ['time budget reached; the rest is handled next run'] }));
    eq(alone.bot.pollBigQuerySources_(onCtx(alone), alone.BUR).bmie, 1);
    assert.ok(aloneCalls.length > 0, 'BigQuery was read');
    eq(alone.bot.ev('BQ_DIRECT_LAST_RUN_MS_'), 10 * 60 * 1000);
  });

  test('direct BQ limits: no check while 3 or more posts it took are still waiting to be reviewed (2 aren\'t enough; Burson\'s own alerts waiting don\'t count); once the run reviews them, the poll goes on', () => {
    const w = world();
    const r = { us: [bmieRow(1), bmieRow(2)], bsip: [], log: [] };
    const calls = fakeBq(w.g, r);
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR).bmie, 2);  // 2 waiting now (no run reviewed them)
    w.paste(F.P0_OK);  // and Burson's own alert
    w.paste(F.AIO);
    r.us = [bmieRow(3), bmieRow(4)];
    w.g.clock.now += 5 * 60e3;
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR).bmie, 2);  // 2 of its own waiting: still checks
    r.us = [bmieRow(5)];
    w.g.clock.now += 5 * 60e3;
    const n = calls.length;
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR), res({}));
    eq([calls.length - n, synth(w.chat, w.BUR).length], [0, 4]);
    assert.match(note(w), /\(not checked: 4 posts it took are still waiting to be reviewed; it tries again at the next check\) · 4 posts today$/);
    // The run reviews what's waiting: the next check goes ahead
    w.g.clock.now += 1000;
    w.bot.runOnce_(onCtx(w));
    w.g.clock.now += 5 * 60e3;
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR).bmie, 1);
    eq(synth(w.chat, w.BUR).map(linkOf).slice(-1), [url(5)]);
  });

  test('direct BQ limits: a space that can\'t be read means no BigQuery query at all (what\'s already there can\'t be told), and column C says so', () => {
    const w = world();
    const calls = fakeBq(w.g, { us: [bmieRow(1)], bsip: [bsipRow(2, 900)], log: [] });
    const ctx = onCtx(w);
    ctx.chat = Object.assign({}, ctx.chat, { list: () => { throw new Error('Chat 503'); } });
    eq(w.bot.pollBigQuerySources_(ctx, w.BUR), res({}));
    eq(calls.length, 0);
    assert.match(note(w), /\(couldn't read the space; it tries again at the next check\) · 0 posts today$/);
  });

  test('direct BQ limits, every-minute run: a run that ran out of time makes the next minute\'s poll skip BigQuery; Burson\'s alerts are reviewed first', () => {
    const t = e2e();
    t.bot.setup();
    t.control().getRange(ROW, 2).setValue('ON');
    const calls = fakeBq(t.g, { us: [bmieRow(1)], bsip: [], log: [] });
    t.g.props.set('LAST_RUN', JSON.stringify({ at: 'x', errors: ['time budget reached; the rest is handled next run'] }));
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    t.poll();
    eq([calls.filter(kindOf).length, synth(t.chat, TEST_FEED)], [0, []]);
    assert.ok(t.chat.botPosts('spaces/AAQAaLn375E').some(m => !m.threadReply && m.text.includes('2109952063492993159')));
    t.g.clock.now += 5 * 60e3;  // that run finished in time: the poll goes ahead
    t.poll();
    eq(synth(t.chat, TEST_FEED).map(linkOf), [url(1)]);
  });

  test('direct BQ: the poll asks for the post\'s page picture as before, but in the Auto-correct space (ctx.sourceReadOnly) for the post\'s own imagery only (bqPostCard_ ownOnly: Post.gs alertPicture_ never reads its page)', () => {
    const run = readOnly => {
      const w = world();
      fakeBq(w.g, { us: [], bsip: [bsipRow(1, 9000)], log: [] });
      const asked = [];
      const real = w.bot.bqPostCard_;
      w.bot.bqPostCard_ = function (...args) { asked.push(args.slice(4)); return real.apply(null, args); };
      const ctx = Object.assign(onCtx(w), readOnly ? { sourceReadOnly: true, changeNotes: true, allowDirectBq: true } : {});
      eq(w.bot.pollBigQuerySources_(ctx, readOnly ? w.ANA : w.BUR).bsip, 1);  // the Auto-correct space's cards go in B10
      return asked;
    };
    eq([run(false), run(true)], [[[true, false]], [[true, true]]]);
  });
};
