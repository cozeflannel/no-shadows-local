// Step S14 of the open-engine plan (Direct BigQuery by time): under Control row 51 the poll reads every source (a later
// one no longer waits out a check because the earlier ones found 2), takes 50 candidates a source, ranks them across
// sources (a KOF's post first, then the most engagements) and posts while fewer than 3 of its cards wait unreviewed
// (with 120 s of the flow left); a candidate not posted is not marked, so the next check weighs it again. The 500
// engagements and "Burson first" stay. With row 51 OFF, as before. Every post here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, world } = H;
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

  const open = () => { const w = world(); w.bot.ewsRunSwitches_({ openEngine: true, earlyWave: true }); return w; };
  const kofRow = n => Object.assign(bmieRow(n), { kof: 'VIRAL KOF', total_comments: 700 });

  test('direct BQ open (S14): with row 51 ON every source is read and 50 candidates a source asked for; a KOF\'s post goes first, then the most engagements, across sources; 3 cards while none waits; with row 51 OFF, 2 a check, 15 a source, the later source unread', () => {
    const rows = () => ({ us: [bmieRow(1), kofRow(2)], bsip: [bsipRow(3, 9000), bsipRow(4, 4000), bsipRow(5, 800)], log: [] });
    const w = open();
    const calls = fakeBq(w.g, rows());
    const r = w.bot.pollBigQuerySources_(onCtx(w), w.BUR);
    eq(synth(w.chat, w.BUR).map(linkOf), [url(2), url(3), url(4)]);
    eq([r.bmie + r.bsip, calls.some(c => kindOf(c) === 'bsip')], [3, true]);
    const bsip = calls.find(c => kindOf(c) === 'bsip');
    assert.ok(/\nORDER BY total DESC, seen_at DESC LIMIT 50$/.test(bsip.sql), bsip.sql);
    eq(bsip.params.min_total, '500');  // the 500 floor stays
    const off = world();
    const offCalls = fakeBq(off.g, rows());
    off.bot.pollBigQuerySources_(onCtx(off), off.BUR);
    eq([synth(off.chat, off.BUR).length, offCalls.some(c => kindOf(c) === 'bsip')], [2, false]);
    assert.ok(/LIMIT 15/.test(offCalls.find(c => kindOf(c) === 'bmie').sql));
  });

  test('direct BQ open (S14): cards while fewer than 3 of the poll\'s cards wait unreviewed: with 2 waiting, one more; a candidate not posted is not marked, so the next check weighs it again', () => {
    const w = open();
    const r = { us: [bmieRow(1), bmieRow(2)], bsip: [], log: [] };
    fakeBq(w.g, r);
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR).bmie, 2);
    r.us = [bmieRow(3), bmieRow(4)];
    w.g.clock.now += 5 * 60e3;
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR).bmie, 1);  // 2 waiting: one more makes 3
    const seen = w.bot.bqSeenKeys_(w.g.services.PropertiesService.getScriptProperties());
    const keyOf = n => w.bot.recordKey_({ post_url: url(n) });
    eq([seen.has(keyOf(3)), seen.has(keyOf(4))], [true, false]);
    // the run reviews what waits; the next check posts the one left
    w.g.clock.now += 1000;
    w.bot.runOnce_(onCtx(w));
    w.g.clock.now += 5 * 60e3;
    eq(w.bot.pollBigQuerySources_(onCtx(w), w.BUR).bmie, 1);
    eq(synth(w.chat, w.BUR).map(linkOf).slice(-1), [url(4)]);
  });
};
