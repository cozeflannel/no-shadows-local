'use strict';

module.exports = function (H) {
  const { assert, F, NOW, test, eq, makeGoogle, loadBot, e2e } = H;
  const SCHEMA = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] };
  const TEN_GB = String(10 * 1024 * 1024 * 1024);

  test('api guard: every bqQuery_ and bqGeminiJob_ call enforces the 10 GB maximumBytesBilled ceiling and records rolling BigQuery telemetry', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const seenBodies = [];
    const origFetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (url.includes('bigquery.googleapis.com/')) {
        seenBodies.push(JSON.parse(params.payload));
        const isMl = /ML\.GENERATE_TEXT/.test(params.payload);
        const body = isMl
          ? { jobComplete: true, schema: { fields: [{ name: 'res', type: 'STRING' }] }, rows: [{ f: [{ v: '{"ok":true}' }] }] }
          : { jobComplete: true, schema: { fields: [{ name: 'n', type: 'INT64' }] }, rows: [{ f: [{ v: '1' }] }] };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body), getHeaders: () => ({}) };
      }
      return origFetch(url, params);
    };

    eq(bot.bqQuery_('SELECT 1 AS n'), [{ n: 1 }]);
    eq(seenBodies[0].maximumBytesBilled, TEN_GB);
    eq(bot.apiGuardCounts_(), { gemini10m: 0, gemini60m: 0, bq10m: 1, bq60m: 1 });

    g.vertex.fail = () => ({ code: 503, body: { error: { message: 'unavailable' } } });
    eq(bot.geminiGenerate_('sys', 'prompt', SCHEMA, { tries: 1 }), { ok: true });
    eq(seenBodies[1].maximumBytesBilled, TEN_GB);
    eq(bot.apiGuardCounts_(), { gemini10m: 1, gemini60m: 1, bq10m: 2, bq60m: 2 });
  });

  test('api guard: rolling 10m and 60m buckets shed non-SLA background load during spikes and automatically recover once the window cools', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);

    eq(bot.apiGuardAllowBackground_('any', false), true);
    eq(bot.apiGuardAllowBackground_('any', true), false);  // live SLA backlog always defers background work

    // Spike Gemini calls to the 10-minute threshold (25 calls)
    bot.apiGuardNote_('gemini', 25);
    eq(bot.apiGuardCounts_().gemini10m, 25);
    eq(bot.apiGuardAllowBackground_('gemini', false), false);
    eq(bot.apiGuardAllowBackground_('any', false), false);
    eq(bot.apiGuardAllowBackground_('bigquery', false), true);

    // Advance 11 minutes: 10-minute window cools to 0, 60-minute window still holds 25 (< 90), so background resumes
    g.clock.now += 11 * 60 * 1000;
    eq(bot.apiGuardCounts_(), { gemini10m: 0, gemini60m: 25, bq10m: 0, bq60m: 0 });
    eq(bot.apiGuardAllowBackground_('any', false), true);

    // Advance past 60 minutes: old buckets prune completely
    g.clock.now += 55 * 60 * 1000;
    eq(bot.apiGuardCounts_(), { gemini10m: 0, gemini60m: 0, bq10m: 0, bq60m: 0 });
  });

  test('api guard: Vertex AI 429 cooldown skips 3x retry amplification, routes text calls straight to BigQuery ML, and clears on recovery', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    let bqCalls = 0;
    const origFetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (url.includes('bigquery.googleapis.com/')) {
        bqCalls++;
        const body = { jobComplete: true, schema: { fields: [{ name: 'res', type: 'STRING' }] }, rows: [{ f: [{ v: '{"ok":true}' }] }] };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body), getHeaders: () => ({}) };
      }
      return origFetch(url, params);
    };

    // First call hits 429 on all 3 Vertex tries -> sets 30s cooldown and succeeds via BigQuery ML fallback
    g.vertex.fail = () => ({ code: 429, body: { error: { message: 'Resource exhausted' } } });
    eq(bot.geminiGenerate_('sys', 'first', SCHEMA, {}), { ok: true });
    eq([g.vertex.calls.length, bqCalls, bot.apiGuardVertex429Active_()], [3, 1, true]);

    // Second text call within 30s skips Vertex completely (0 new Vertex calls, 0 retry sleeps) and uses BigQuery ML directly
    g.vertex.calls.length = 0;
    eq(bot.geminiGenerate_('sys', 'second', SCHEMA, {}), { ok: true });
    eq([g.vertex.calls.length, bqCalls], [0, 2]);

    // Non-BQ-fallback call during cooldown makes only 1 fast probe instead of 3 retries, and clears cooldown when Vertex recovers
    assert.throws(() => bot.geminiGenerate_('sys', 'no-bq', SCHEMA, { allowBqFallback: false }), /Gemini unavailable after 1 tries: 429/);
    eq(g.vertex.calls.length, 1);
    g.vertex.fail = null;
    g.vertex.calls.length = 0;
    eq(bot.geminiGenerate_('sys', 'recovered', SCHEMA, { allowBqFallback: false }), { ok: true });
    eq([g.vertex.calls.length, bot.apiGuardVertex429Active_()], [1, false]);
  });

  test('api guard: live SLA alert triage is never hindered during an API spike while background Direct BigQuery and Early Wave polls defer', () => {
    const t = e2e();
    t.bot.setup();
    const sh = t.control();
    // Enable Direct BigQuery alerts (row 15) and Early wave check (row 19); verify no new Control tab rows exist
    sh.getRange(15, 2).setValue('ON');
    sh.getRange(19, 2).setValue('ON');
    t.g.vertex.calls.length = 0;

    let bqDirectQueries = 0;
    let bqWaveQueries = 0;
    const origFetch = t.g.services.UrlFetchApp.fetch;
    t.g.services.UrlFetchApp.fetch = (url, params) => {
      if (url.includes('bigquery.googleapis.com/')) {
        const sql = String((params && params.payload) || '');
        if (/sprinklr_candidates|bmie_candidates|sonar_candidates|-- ews:/.test(sql) && !/enrichAlert|sonar_snippets_json/.test(sql)) {
          if (/-- ews:/.test(sql)) bqWaveQueries++;
          else bqDirectQueries++;
        }
        const empty = { jobComplete: true, schema: { fields: [] }, rows: [] };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(empty), getHeaders: () => ({}) };
      }
      return origFetch(url, params);
    };

    // Simulate an active Gemini + BigQuery API spike above background thresholds
    t.bot.apiGuardNote_('gemini', 30);
    t.bot.apiGuardNote_('bigquery', 60);
    eq(t.bot.apiGuardAllowBackground_('any', false), false);

    // Post a live Zapier alert into the Burson feed during the spike and run poll()
    t.set('B30', 'tester@testing.test');
    t.chat.say(H.TEST_FEED, F.AIO, { type: 'BOT', sender: 'users/zapier', displayName: 'Zapier' });
    t.poll();

    // Background polls deferred (0 Direct BQ or Early Wave queries), while the live SLA alert + Social Alert note went out immediately!
    eq([bqDirectQueries, bqWaveQueries], [0, 0]);
    eq(t.chat.spaces.get(H.TRIAGED).messages.filter(m => m.text.includes('TheChiefNerd')).length, 2);
    assert.ok(t.g.vertex.calls.length >= 1, 'live SLA review still called Gemini immediately');
  });
};
