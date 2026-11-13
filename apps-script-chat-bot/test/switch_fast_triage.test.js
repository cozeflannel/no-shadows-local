// Gemini Decisions client (Decisions.gs) and ApiGuard decisions ceilings (ApiGuard.gs) — Section 5A.
// Uses recorded Gemini Decisions API responses and real Nov 6-12, 2026 archive signals (decisions_fixtures.json).
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function (H) {
  const { assert, NOW, test, eq, makeGoogle, loadBot } = H;
  const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decisions_fixtures.json'), 'utf8'));
  const TEST_KEY = 'test-only-decisions-key-value-99';

  function makeEnv(responder) {
    const g = makeGoogle(NOW);
    const warnings = [];
    const errors = [];
    const fetches = [];
    let secretCalls = 0;
    let secretReply = () => ({
      code: 200,
      body: { payload: { data: Buffer.from(TEST_KEY, 'utf8').toString('base64') } },
    });
    const origFetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      const u = String(url);
      if (u.includes('secretmanager.googleapis.com/')) {
        secretCalls++;
        fetches.push({ kind: 'secret', url: u, params });
        const s = secretReply(u, params);
        return {
          getResponseCode: () => s.code,
          getContentText: () => (typeof s.body === 'string' ? s.body : JSON.stringify(s.body)),
          getHeaders: () => ({}),
        };
      }
      if (u.includes('/decisions')) {
        fetches.push({ kind: 'decisions', url: u, params });
        const r = responder(u, params, g.clock);
        return {
          getResponseCode: () => r.code,
          getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
          getHeaders: () => ({}),
        };
      }
      return origFetch(url, params);
    };
    const bot = loadBot(g.services, g.clock);
    bot.console = {
      log() {},
      warn: m => warnings.push(String(m)),
      error: m => errors.push(String(m)),
    };
    return {
      g,
      bot,
      fetches,
      warnings,
      errors,
      secretCalls: () => secretCalls,
      setSecret: fn => { secretReply = fn; },
    };
  }

  test('decisions client (5A): Secret Manager key header, endpoint, session caching, and recorded noul / choice / score parsing', () => {
    let reply = { code: 200, body: FX.probe.doc_multi.response.body };
    const env = makeEnv((_u, _p, clock) => {
      clock.now += 340;
      return reply;
    });
    const { bot, g, fetches } = env;

    eq(bot.decUrl_(), 'https://generativelanguage.googleapis.com/v1beta/decisions');
    eq([bot.ev('DEC_API_VERSION_'), bot.ev('DEC_MODEL_'), bot.ev('DEC_SECRET_')], ['v1beta', 'gemini-decision-1', 'agentic_assistant']);

    const session = bot.decSession_(() => 90 * 1000, false);
    const multiReq = FX.probe.doc_multi.request;
    const res1 = bot.decisionsAsk_('Customer audio cuts out on the left earcup.', multiReq.questions, session);
    eq(res1.ok, true);
    eq([res1.tokens, res1.ms, env.secretCalls(), fetches.length], [324, 340, 1, 2]);

    // Verify Secret Manager call matches house pwBwToken_ pattern and key goes only in x-goog-api-key header
    const secCall = fetches[0];
    assert.strictEqual(
      secCall.url,
      `https://secretmanager.googleapis.com/v1/projects/${bot.ev('GCP_PROJECT')}/secrets/agentic_assistant/versions/latest:access`
    );
    eq(secCall.params.headers['x-goog-user-project'], bot.ev('GCP_PROJECT'));
    assert.match(secCall.params.headers.Authorization, /^Bearer /);

    const decCall = fetches[1];
    eq(decCall.url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
    assert.ok(!decCall.url.includes(TEST_KEY), 'key never appears in URL');
    eq(decCall.params.headers['x-goog-api-key'], TEST_KEY);
    const sent = JSON.parse(decCall.params.payload);
    eq([sent.model, sent.input], ['gemini-decision-1', 'Customer audio cuts out on the left earcup.']);

    // Verify parsed noul, choice, and score answers
    eq(res1.answers.is_defect.type, 'noul');
    assert.ok(res1.answers.is_defect.p > 0.93 && res1.answers.is_defect.confidence > 0.93);
    eq([res1.answers.next_action.type, res1.answers.next_action.choice], ['choice', 'human_escalation']);
    assert.ok(res1.answers.next_action.probabilities.replacement_shipment > 0.24);
    eq([res1.answers.churn_risk.type, res1.answers.churn_risk.level, res1.answers.churn_risk.probabilities.length], ['score', 3, 4]);
    assert.ok(res1.answers.churn_risk.score > 2.98);

    // Second call in the same session reuses in-memory session.key without re-calling Secret Manager
    reply = { code: 200, body: FX.probe.doc_quickstart.response.body };
    const res2 = bot.decisionsAsk_(FX.probe.doc_quickstart.request.input, FX.probe.doc_quickstart.request.questions, session);
    eq([res2.ok, res2.answers.is_damaged.p, env.secretCalls(), session.asked], [true, 0.99, 1, 2]);

    // Verify key is never persisted in PropertiesService or CacheService
    for (const [, v] of g.props.entries()) assert.ok(!String(v).includes(TEST_KEY));
    for (const [, v] of g.cache.entries()) assert.ok(!String(v.val || v).includes(TEST_KEY));

    // Verify decSignalAsk_ + decCompact_ + decP0Mass_ across all 8 real archive signals with recorded API responses
    const respIds = Object.keys(FX.signal_responses);
    eq(respIds.length, 8);
    const sigSession = bot.decSession_(() => 120 * 1000, false);
    for (const id of respIds) {
      const row = FX.signals.find(s => s.alert_id === id);
      reply = { code: 200, body: FX.signal_responses[id] };
      const out = bot.decSignalAsk_(row, sigSession);
      eq(out.ok, true, id);
      assert.ok(out.tokens >= 2900, `${id}: expected token count, got ${out.tokens}`);
      ['g', 'r', 'i', 'n', 'cp', 'p0', 's', 'sc'].forEach(k => assert.strictEqual(typeof out.dec[k], 'number', `${id}.${k}`));
      assert.ok(out.dec.l >= 0 && out.dec.l <= 4 && out.dec.sp.length === 5, id);
      assert.ok(out.dec.c.length >= 1 && out.dec.c.length <= 128, id);
    }

    // Verify fallback confidence computation when optional confidence field is omitted (Decision 12(i))
    eq(bot.decAnswer_({ type: 'noul', noul: 0.2 }, { type: 'noul' }), { type: 'noul', p: 0.2, confidence: 0.8 });
    eq(
      bot.decAnswer_({ type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 } }, { type: 'choice', criteria: { a: 'A', b: 'B' } }),
      { type: 'choice', choice: 'a', p: 0.7, probabilities: { a: 0.7, b: 0.3 }, confidence: 0.7 }
    );
    eq(
      bot.decAnswer_({ type: 'score', score: 1.4, probabilities: { '0': 0.1, '1': 0.6, '2': 0.3 } }, { type: 'score', criteria: ['l0', 'l1', 'l2'] }),
      { type: 'score', score: 1.4, level: 1, probabilities: [0.1, 0.6, 0.3], confidence: 0.6 }
    );
    eq(bot.decAnswer_({ type: 'choice', choice: 'unknown', probabilities: { unknown: 1 } }, { type: 'choice', criteria: { a: 'A', b: 'B' } }), null);
    eq(bot.decAnswer_({ type: 'score', score: 5, probabilities: { '0': 0.5, '1': 0.5 } }, { type: 'score', criteria: ['l0', 'l1'] }), null);
  });

  test('decisions client (5A): ApiGuard decisions rolling ceilings, run-deadline gate, SLA-busy gate, and pre-call counting', () => {
    let midCallCounts = null;
    const env = makeEnv(() => {
      midCallCounts = {
        guard: env.bot.apiGuardDecisionsCounts_(),
        state: env.bot.decState_(env.g.services.PropertiesService.getScriptProperties(), env.g.clock.now),
      };
      return { code: 200, body: FX.probe.doc_quickstart.response.body };
    });
    const { bot, g, fetches } = env;
    const q = FX.probe.doc_quickstart.request.questions;
    const props = g.services.PropertiesService.getScriptProperties();

    // Zero Decisions calls leaves existing Gemini/BigQuery bucket shape untouched (no `d` key)
    bot.apiGuardNote_('gemini', 2);
    const rawBefore = g.services.CacheService.getScriptCache().get('api_guard_v1');
    assert.ok(!rawBefore.includes('"d"'), rawBefore);
    eq(bot.apiGuardDecisionsCounts_(), { decisions10m: 0, decisions60m: 0 });
    eq(bot.apiGuardAllowDecisions_(), true);

    // Gate checks skip without touching Secret Manager or UrlFetchApp
    eq(bot.decisionsAsk_('hi', q, bot.decSession_(() => 60000, true)), { ok: false, skipped: true, why: 'the alerts come first' });
    eq(bot.decisionsAsk_('hi', q, bot.decSession_(() => 19999, false)), { ok: false, skipped: true, why: 'too little of the run left' });
    eq(bot.decisionsAsk_('   ', q, bot.decSession_(() => 60000, false)), { ok: false, skipped: true, why: 'nothing to ask' });
    eq(bot.decisionsAsk_('hi', {}, bot.decSession_(() => 60000, false)), { ok: false, skipped: true, why: 'nothing to ask' });
    eq([env.secretCalls(), fetches.length], [0, 0]);

    // Pre-call counting happens before UrlFetchApp.fetch returns
    const s = bot.decSession_(() => 60000, false);
    eq(bot.decisionsAsk_('hi', q, s).ok, true);
    eq([midCallCounts.guard.decisions10m, midCallCounts.state.asked, s.asked], [1, 1, 1]);
    eq(bot.apiGuardCounts_(), { gemini10m: 2, gemini60m: 2, bq10m: 0, bq60m: 0 }); // Gemini/BQ counts unaffected

    // Per-check cap (DEC_MAX_PER_CHECK_ = 15)
    s.asked = bot.ev('DEC_MAX_PER_CHECK_');
    eq(bot.decisionsAsk_('hi', q, s), { ok: false, skipped: true, why: '15 calls this check' });

    // ApiGuard rolling 10m ceiling (30) and 60m ceiling (90)
    bot.apiGuardNote_('decisions', 29);
    eq([bot.apiGuardDecisionsCounts_().decisions10m, bot.apiGuardAllowDecisions_()], [30, false]);
    eq(bot.decisionsAsk_('hi', q, bot.decSession_(() => 60000, false)), { ok: false, skipped: true, why: 'too many calls lately' });

    g.clock.now += 11 * 60 * 1000; // 10m window cools; 60m has 30 < 90
    eq([bot.apiGuardDecisionsCounts_().decisions10m, bot.apiGuardDecisionsCounts_().decisions60m, bot.apiGuardAllowDecisions_()], [0, 30, true]);
    bot.apiGuardNote_('decisions', 60);
    g.clock.now += 11 * 60 * 1000; // 10m window cools again, but 60m is at 90
    eq([bot.apiGuardDecisionsCounts_().decisions10m, bot.apiGuardDecisionsCounts_().decisions60m, bot.apiGuardAllowDecisions_()], [0, 90, false]);
    g.clock.now += 55 * 60 * 1000; // past 60m: all buckets prune
    eq([bot.apiGuardDecisionsCounts_(), bot.apiGuardAllowDecisions_()], [{ decisions10m: 0, decisions60m: 0 }, true]);

    // Daily cap (DEC_MAX_PER_DAY_ = 150) + Control note text
    const st = bot.decState_(props, g.clock.now);
    st.asked = bot.ev('DEC_MAX_PER_DAY_');
    bot.decSaveState_(props, st);
    eq(bot.decisionsAsk_('hi', q, bot.decSession_(() => 60000, false)), { ok: false, skipped: true, why: '150 calls today' });
    assert.match(bot.decStatusText_(props, g.clock.now), /150 asked today · daily cap of 150 reached, more tomorrow$/);
  });

  test('decisions client (5A / Rule 4): live "too_many_requests" and documented "rate_limit_exceeded" 429s, missing/bad key, HTTP/JSON/slow/throw failures, safety refusals without pause, and key redaction', () => {
    let mode = '429_live';
    const env = makeEnv((_u, _p, clock) => {
      if (mode === '429_live') return { code: FX.error_429_live.status, body: FX.error_429_live.body };
      if (mode === '429_doc') return { code: FX.error_429_documented.status, body: FX.error_429_documented.body };
      if (mode === 'bad_key') return { code: FX.probe.error_bad_key.status, body: FX.probe.error_bad_key.body };
      if (mode === 'bad_req') return { code: FX.probe.error_one_option.status, body: FX.probe.error_one_option.body };
      if (mode === '503') return { code: 503, body: { error: { code: 'service_unavailable', message: 'Overloaded' } } };
      if (mode === 'bad_json') return { code: 200, body: '{not-json' };
      if (mode === 'missing_ans') return { code: 200, body: { answers: {}, usage: { total_input_tokens: 10 } } };
      if (mode === 'slow') {
        clock.now += 10500; // > DEC_SLOW_MS_ (10,000 ms)
        return { code: 200, body: FX.probe.doc_quickstart.response.body };
      }
      if (mode === 'throw_key') {
        throw new Error(`DNS lookup failed while sending header ${TEST_KEY} to host`);
      }
      if (mode.startsWith('refusal:')) {
        const code = mode.split(':')[1];
        return { code: 400, body: { error: { code, message: 'Blocked by policy' } } };
      }
      return { code: 200, body: FX.probe.doc_quickstart.response.body };
    });
    const { bot, g, fetches, warnings } = env;
    const props = g.services.PropertiesService.getScriptProperties();
    const q = FX.probe.doc_quickstart.request.questions;
    const PAUSE = bot.ev('DEC_PAUSE_MS_');
    eq(PAUSE, 15 * 60 * 1000);

    // 1a. Live recorded HTTP 429 ("too_many_requests") pauses for 15 minutes and surfaces in Control note
    const r429Live = bot.decisionsAsk_('mug cracked', q, bot.decSession_(() => 60000, false));
    eq(r429Live, { ok: false, why: 'HTTP 429: too_many_requests' });
    assert.match(bot.decStatusText_(props, g.clock.now), /1 asked today · 1 failed · paused until .* \(HTTP 429: too_many_requests\): signals go on without it$/);
    const fetchCountAfterLive429 = fetches.length;
    const skippedDuringPause = bot.decisionsAsk_('mug cracked', q, bot.decSession_(() => 60000, false));
    eq(skippedDuringPause, { ok: false, skipped: true, why: 'paused after a failure (HTTP 429: too_many_requests)' });
    eq(fetches.length, fetchCountAfterLive429); // zero network calls while paused

    // Advance past the 15-minute cooldown and test 1b: documented HTTP 429 ("rate_limit_exceeded")
    g.clock.now += PAUSE + 1;
    mode = '429_doc';
    const r429Doc = bot.decisionsAsk_('mug cracked', q, bot.decSession_(() => 60000, false));
    eq(r429Doc, { ok: false, why: 'HTTP 429: rate_limit_exceeded' });
    assert.match(bot.decStatusText_(props, g.clock.now), /2 asked today · 2 failed · paused until .* \(HTTP 429: rate_limit_exceeded\): signals go on without it$/);
    eq(
      bot.decisionsAsk_('mug cracked', q, bot.decSession_(() => 60000, false)),
      { ok: false, skipped: true, why: 'paused after a failure (HTTP 429: rate_limit_exceeded)' }
    );

    // 2. Remaining Rule 4 failure modes: bad key, invalid_request, 503, unparseable JSON, missing answer, slow call, network throw with key, missing secret
    const cases = [
      ['bad_key', 'HTTP 400: invalid_argument'],
      ['bad_req', 'HTTP 400: invalid_request'],
      ['503', 'HTTP 503: service_unavailable'],
      ['bad_json', 'an answer that couldn\'t be read'],
      ['missing_ans', 'an answer that couldn\'t be read (is_damaged)'],
      ['slow', 'a slow answer (11 s)'],
      ['throw_key', 'DNS lookup failed while sending header [key] to host'],
    ];
    for (const [m, expectedWhy] of cases) {
      g.clock.now += PAUSE + 1;
      mode = m;
      const out = bot.decisionsAsk_('mug cracked', q, bot.decSession_(() => 60000, false));
      eq(out, { ok: false, why: expectedWhy }, m);
      assert.ok(bot.decState_(props, g.clock.now).until > g.clock.now, `${m} sets cooldown`);
    }

    // Missing Secret Manager secret (HTTP 404, then empty secret value) fails open and pauses without throwing
    g.clock.now += PAUSE + 1;
    env.setSecret(() => ({ code: 404, body: { error: { message: 'Secret not found' } } }));
    eq(bot.decisionsAsk_('mug cracked', q, bot.decSession_(() => 60000, false)), { ok: false, why: 'no API key (Secret Manager HTTP 404)' });
    g.clock.now += PAUSE + 1;
    env.setSecret(() => ({ code: 200, body: { payload: { data: Buffer.from('   ', 'utf8').toString('base64') } } }));
    eq(bot.decisionsAsk_('mug cracked', q, bot.decSession_(() => 60000, false)), { ok: false, why: 'no API key (the secret is empty)' });

    // Restore valid secret and verify safety-filter refusals (Decision 12(ii)): counted, NO pause, next signal succeeds immediately
    env.setSecret(() => ({ code: 200, body: { payload: { data: Buffer.from(TEST_KEY, 'utf8').toString('base64') } } }));
    g.clock.now += PAUSE + 1;
    const checkSession = bot.decSession_(() => 60000, false);
    for (const code of ['safety', 'prohibited_content', 'blocklist', 'image_safety', 'content_blocked']) {
      mode = `refusal:${code}`;
      const ref = bot.decisionsAsk_('self-harm report', q, checkSession);
      eq(ref, { ok: false, refused: true, why: `the safety filter refused the input (${code})` });
      eq(bot.decState_(props, g.clock.now).until, 0, `${code} must not pause subsequent signals`);
    }
    mode = 'ok';
    const nextOk = bot.decisionsAsk_('mug cracked', q, checkSession);
    eq(nextOk.ok, true);
    assert.match(bot.decStatusText_(props, g.clock.now), /5 refused by the safety filter/);

    // Rule 10: raw key never appears in warnings, state property, or status text even after throw_key
    warnings.forEach(w => assert.ok(!w.includes(TEST_KEY), w));
    assert.ok(!String(props.getProperty('DECISIONS_STATE') || '').includes(TEST_KEY));
    assert.ok(!bot.decStatusText_(props, g.clock.now).includes(TEST_KEY));
  });

  test('decisions input builder (5A / Rule 8): fixture hygiene, real archive signals, adversarial forbidden-data stripping, and question schema', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);

    // 1. Committed fixture file itself passes email, restricted-ID, and all three Burson leak-guard audits
    const rawFixture = fs.readFileSync(path.join(__dirname, 'decisions_fixtures.json'), 'utf8');
    eq(rawFixture.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [], []);
    assert.ok(!/SPK\||AAQA|1dVGeQjL|19HakS6|MT90an4v|1028310913761|AIza|agentic_assistant|early_detection|all_sundar|raw_brandwatch|reddit_items_raw|bsip|\[BSS\]|SLRR|Zapier/i.test(rawFixture));
    const guardCfg = { terms: ['SLRR Triaged Alerts', 'Mirror Training Space'] };
    eq(Array.from(bot.outboxGuardHits_(rawFixture, guardCfg)), []);
    eq(Array.from(bot.guardHits_(rawFixture, guardCfg)), []);
    eq(Array.from(bot.relayGuardHits_(rawFixture)), []);

    // 2. Every real archive signal builds clean JSON within DEC_INPUT_MAX_CHARS_ and zero Rule 8 leaks
    const allowedTop = new Set(['signal', 'headline', 'accounts', 'posts', 'platforms', 'window', 'pace', 'snippets']);
    const allowedSnip = new Set(['platform', 'posted_at', 'text']);
    const maxChars = bot.ev('DEC_INPUT_MAX_CHARS_');
    assert.ok(FX.signals.length >= 20);
    for (const r of FX.signals) {
      const input = bot.decSignalInput_(r);
      assert.ok(input.length > 0 && input.length <= maxChars, `${r.alert_id}: length ${input.length}`);
      const parsed = JSON.parse(input);
      Object.keys(parsed).forEach(k => assert.ok(allowedTop.has(k), `${r.alert_id}: unexpected key ${k}`));
      assert.ok(Array.isArray(parsed.snippets) && parsed.snippets.length >= 1, r.alert_id);
      parsed.snippets.forEach(s => Object.keys(s).forEach(k => assert.ok(allowedSnip.has(k), `${r.alert_id}: snippet key ${k}`)));

      assert.ok(!/https?:\/\/|www\./i.test(input), `${r.alert_id}: link leaked`);
      assert.ok(!/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,10}\/\S*/i.test(input), `${r.alert_id}: bare domain path leaked`);
      assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(input), `${r.alert_id}: email leaked`);
      assert.ok(!/(^|[^A-Za-z0-9_])@[A-Za-z0-9_]/.test(input), `${r.alert_id}: @handle leaked`);
      assert.ok(!/(^|[^A-Za-z0-9_])u\/[A-Za-z0-9_-]+/i.test(input), `${r.alert_id}: u/ handle leaked`);
      assert.ok(!/\b(?:spaces|users|messages|threads|members)\/[A-Za-z0-9_.-]+/i.test(input), `${r.alert_id}: chat resource leaked`);
      const withoutIso = input.replace(/"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z| UTC|[+-]\d{2}:?\d{2})?"/g, '""');
      assert.ok(!/\d{8,}/.test(withoutIso), `${r.alert_id}: 8+ digit ID leaked`);

      [r.alert_id, r.cluster_id, r.primary_url].forEach(secret => {
        if (secret) assert.ok(!input.includes(secret), `${r.alert_id}: row identifier leaked (${secret})`);
      });
      if (r.signal_key && !String(r.headline || '').includes(r.signal_key)) {
        assert.ok(!input.includes(r.signal_key), `${r.alert_id}: signal_key leaked (${r.signal_key})`);
      }
      const posts = JSON.parse(r.representative_posts_json || '[]');
      const rawPublicText = ([r.headline].concat(posts.map(p => p.snippet || '')).join(' ')).toLowerCase();
      for (const p of posts) {
        if (p.mention_id) assert.ok(!input.includes(p.mention_id), `${r.alert_id}: mention_id leaked`);
        if (p.url) assert.ok(!input.includes(p.url), `${r.alert_id}: post url leaked`);
        const a = String(p.author_id || '').trim();
        if (a.length >= 4 && !rawPublicText.includes(a.toLowerCase())) {
          assert.ok(!input.toLowerCase().includes(a.toLowerCase()), `${r.alert_id}: author_id leaked (${a})`);
        }
      }
    }

    // 3. Adversarial Rule 8 test: forbidden properties on `row` and inline handles/IDs/links/emails/Chat IDs are stripped, while CVE numbers stay
    const poisoned = Object.assign({}, FX.signals[0], {
      headline: 'CVE-2026-125350 reported by @SecResearcher @second.handle and u/net_watcher at https://x.com/SecResearcher/status/1845000000000000001 ' +
        'and status.example.org/incident/99887766 — email analyst@corp.test in spaces/AAQAsecretRoom1 or users/1092837465019283',
      platforms_csv: 'X, Reddit, https://evil.test/drop, spaces/AAQAbad',
      window_start_utc: '2026-11-11T18:00:00Z',
      window_end_utc: '2026-11-11T18:10:00Z',
      author_handle: '@HiddenAuthorHandle',
      author_id: 'hidden_author_9911',
      sender_email: 'im-oncall@corp.test',
      space_id: 'spaces/AAQAinternalSpace',
      message_id: 'spaces/AAQAinternalSpace/messages/msgSecret99',
      im_name: 'Dana InternalIM',
      resources_doc: 'CONFIDENTIAL_RESOURCES_KB_PASSAGE',
      guidance_rule: 'CONFIDENTIAL_GUIDANCE_TAB_TEXT',
      burson_writeup: 'CONFIDENTIAL_BURSON_WRITEUP_BODY',
      gmail_thread: 'CONFIDENTIAL_GMAIL_THREAD_EXCERPT',
      sheet_contents: 'CONFIDENTIAL_SHEET_CELL_VALUE',
      representative_posts_json: JSON.stringify(
        Array.from({ length: 12 }, (_, i) => ({
          mention_id: `MID_SECRET_${i}_9988776655`,
          platform: i % 2 === 0 ? 'X' : 'Reddit',
          author_id: `secret_author_${i}`,
          author_handle: `@secret_author_${i}`,
          url: `https://x.com/secret_author_${i}/status/18450000000000000${10 + i}`,
          posted_at: '2026-11-11T18:05:00Z',
          snippet: `Report ${i + 1}: Chrome CVE-2026-125350 crash cc @helper_account u/mod_user leak@internal.invalid ` +
            `messages/mSecret${i} threads/tSecret${i} members/memSecret${i} id 9876543210123 ` +
            'x'.repeat(300),
        }))
      ),
    });
    const built = bot.decSignalInput_(poisoned);
    assert.ok(built.length > 0 && built.length <= maxChars);
    assert.ok(built.includes('CVE-2026-125350'), '4-7 digit CVE identifier preserved');
    for (const forbidden of [
      'SecResearcher', 'second.handle', 'net_watcher', '1845000000000000001', 'status.example.org', '99887766',
      'analyst@corp.test', 'AAQAsecretRoom1', '1092837465019283', 'evil.test', 'AAQAbad', 'HiddenAuthorHandle',
      'hidden_author_9911', 'im-oncall@corp.test', 'AAQAinternalSpace', 'msgSecret99', 'Dana InternalIM',
      'CONFIDENTIAL_RESOURCES_KB_PASSAGE', 'CONFIDENTIAL_GUIDANCE_TAB_TEXT', 'CONFIDENTIAL_BURSON_WRITEUP_BODY',
      'CONFIDENTIAL_GMAIL_THREAD_EXCERPT', 'CONFIDENTIAL_SHEET_CELL_VALUE', 'MID_SECRET_', 'secret_author_',
      'helper_account', 'mod_user', 'leak@internal.invalid', 'mSecret', 'tSecret', 'memSecret', '9876543210123',
    ]) {
      assert.ok(!built.includes(forbidden), `forbidden token leaked into decSignalInput_: ${forbidden}`);
    }
    const parsedPoisoned = JSON.parse(built);
    eq([parsedPoisoned.platforms, parsedPoisoned.window.length], [['X', 'Reddit'], 'within 15 minutes']);
    assert.ok(parsedPoisoned.snippets.length >= 1 && parsedPoisoned.snippets.length <= 8);

    // Empty row produces '' so decisionsAsk_ skips cleanly
    eq(bot.decSignalInput_({ headline: '@only_handle https://x.com/a/status/1845000000000000001', representative_posts_json: '[]' }), '');

    // 4. decSignalQuestions_ conforms to Gemini Decisions REST specification
    const qs = bot.decSignalQuestions_();
    const qKeys = Object.keys(qs);
    eq(qKeys, ['about_google', 'brand_risk', 'independent_reports', 'routine_noise', 'category', 'severity']);
    qKeys.forEach(k => assert.match(k, /^[A-Za-z0-9_-]{1,64}$/));
    const catKeys = Object.keys(qs.category.criteria);
    eq(catKeys.length, bot.ev('GEN').exposure_tags.length + 2);
    assert.ok(catKeys.length >= 2 && catKeys.length <= 255);
    catKeys.forEach(k => {
      assert.ok(k.length >= 1 && k.length <= 128 && !/^ | $|[^\S ]/.test(k), `bad category option key: ${k}`);
      assert.ok(qs.category.criteria[k].length > 0, `empty description on ${k}`);
    });
    eq(qs.severity.criteria.length, bot.ev('ED_SEVERITIES_').length);
    qs.severity.criteria.forEach((line, idx) => {
      assert.ok(line.startsWith(bot.ev('ED_SEVERITIES_')[idx] + ': ') && line.length > 20);
    });
  });
};
