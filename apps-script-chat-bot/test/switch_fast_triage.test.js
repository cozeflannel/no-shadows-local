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

  // ===========================================================================================================
  // Section 5B — Fast triage at queue time (Control rows 38-40, FastTriage.gs, BigQuery.gs, EarlyWaveSource.gs)
  // ===========================================================================================================

  const { e2e, TEST_FEED } = H;
  const MIN = 60 * 1000;
  const SIGNAL_IDS_WITH_ANSWERS = [
    'ED-CLU-CLU-dc5a8afd13da-202611061731', // P0 group, P1 hint, s=3.73, l=4
    'ED-CLU-CLU-56136e76a9a7-202611072301', // P0 group, P1 hint, s=3.74, l=4
    'ED-CLU-CLU-e9dddc0be913-202611071746', // Android CERT-In, P1 hint, s=2.53, l=3
    'ED-CLU-CLU-3aa05dedf0a7-202611072231', // Chrome adblock, P1 hint, s=0.96, l=1, sc=0.60, n=0.95
    'ED-CLU-CLU-3287667bddd9-202611101231', // Dragon Quest, P1 hint, s=0.19, l=0, sc=0.88, g=0.32
    'ED-CLU-CLU-abe6decf9a2a-202611121446', // XR glasses launch, P1 hint, s=0.22, l=0, sc=0.86, n=0.89
    'ED-VEL-PRIORITY_TOPIC-2cb939f86090a0ffb4ed1cce8c43c295-202611091217', // Velocity P2, s=0.52, l=0, sc=0.62
    'ED-VEL-CLUSTER-1dd1392bf7db140af902df1be556969f-202611080402', // Velocity P2, s=0.25, l=0, sc=0.84, g=0.07
  ];

  function signalWithFacts(bot, rawRow, extra) {
    const r = JSON.parse(JSON.stringify(rawRow));
    const posts = JSON.parse(r.representative_posts_json || '[]');
    const text = [r.headline].concat(posts.map(p => p.snippet || '')).join('\n');
    const groups = bot.ev('EWS_RISK_GROUPS_').map(x => ({
      key: x.key,
      rx: new RegExp(String(x.rx).replace(/^\(\?i\)/, ''), 'i'),
    }));
    const hits = groups.filter(g => g.rx.test(text)).map(g => g.key);
    return Object.assign(r, { risk_groups: hits.join(','), tag_raised: false }, extra || {});
  }

  const MIRROR = 'spaces/AAQAmirrorFt1';
  const MIRROR_NAME = 'SLRR Zapier Training Mirror';
  const ROOM = 'https://chat.google.com/room/AAQAaa_0I9g';

  function makeFastTriageE2e(rowsFn, decResponder) {
    const t = e2e();
    t.chat.addSpace(MIRROR, MIRROR_NAME);
    t.bot.setup();
    t.set('B25', ROOM);
    t.set('B30', 'tester@testing.test');
    t.chat.addDm('tester@testing.test', 'spaces/DMSTANDIN');
    t.bot.startMirror(MIRROR_NAME);
    t.control().getRange(29, 2).setValue('ON'); // Safety valve ON -> Testing mode
    let decCalls = 0;
    let secretCalls = 0;
    const seenOpts = [];
    t.bot.bqEarlyDetectionRows_ = (minutes, opts) => {
      seenOpts.push(opts || null);
      const list = typeof rowsFn === 'function' ? rowsFn(minutes, opts, t.bot) : rowsFn;
      return (list || []).map(r => (opts && opts.facts ? signalWithFacts(t.bot, r) : JSON.parse(JSON.stringify(r))));
    };
    const origFetch = t.g.services.UrlFetchApp.fetch;
    t.g.services.UrlFetchApp.fetch = (url, params) => {
      const u = String(url);
      if (u.includes('secretmanager.googleapis.com/')) {
        secretCalls++;
        const s = decResponder && decResponder.secret
          ? decResponder.secret()
          : { code: 200, body: { payload: { data: Buffer.from(TEST_KEY, 'utf8').toString('base64') } } };
        return {
          getResponseCode: () => s.code,
          getContentText: () => (typeof s.body === 'string' ? s.body : JSON.stringify(s.body)),
          getHeaders: () => ({}),
        };
      }
      if (u.includes('/decisions')) {
        decCalls++;
        const payload = JSON.parse((params && params.payload) || '{}');
        const ans = decResponder ? decResponder(payload, t.g.clock, decCalls) : null;
        return {
          getResponseCode: () => ans.code,
          getContentText: () => (typeof ans.body === 'string' ? ans.body : JSON.stringify(ans.body)),
          getHeaders: () => ({}),
        };
      }
      if (u.startsWith('https://bigquery.googleapis.com/')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ jobComplete: true, schema: { fields: [{ name: 'url', type: 'STRING' }] }, rows: [] }),
          getHeaders: () => ({}),
        };
      }
      return origFetch(url, params);
    };
    t.g.vertex.earlyDetection = payload => {
      const txt = payload.contents[0].parts.map(p => p.text || '').join('\n');
      const hit = FX.signals.find(s => txt.includes(s.alert_id));
      const id = (hit && hit.alert_id) || 'ED-SIGNAL';
      return {
        summary: `Verified review for ${id}.`,
        issue_name: `Issue ${id}`,
        emerging_narrative: `Multiple accounts report ${id}.`,
        early_detection_call: {
          disposition: 'monitor',
          severity: 'medium',
          confidence: 0.88,
          reason: 'Early multi-account cluster worth tracking',
          build_up_signals: 'Multiple low-tier accounts across social platforms',
          watch_for: 'Broader growth or official response',
        },
        temp_check_draft: { recommended: false, query_suggestion: '', scope_note: '' },
        slrr: {
          is_slrr: false,
          confidence: 0.85,
          exposure_tag: 'Product - Other/general criticism',
          product: 'Chrome',
          other_products: [],
          sensitive_topics: [],
          location: 'US',
        },
        known_issue: { matches: false, confidence: 0.9 },
        tns: { needed: false, reason: '' },
        recommended_groups: [],
        story_title: `Story card for ${id}`,
        story: `Accounts discussed ${id} on [the first post](P1).`,
        web_context: 'No external coverage found.',
        next_steps: ['Keep monitoring for volume growth.'],
      };
    };
    return { t, seenOpts, decCalls: () => decCalls, secretCalls: () => secretCalls };
  }

  function matchRecordedResponse(bot, payload) {
    for (const id of SIGNAL_IDS_WITH_ANSWERS) {
      const row = FX.signals.find(s => s.alert_id === id);
      if (bot.decSignalInput_(row) === payload.input) {
        return { code: 200, body: FX.signal_responses[id] };
      }
    }
    return { code: 200, body: FX.probe.six_questions_doc_input.response.body };
  }

  const edCardsOf = t => t.chat.botPosts(MIRROR).filter(m => !m.threadReply && /^client-zeda-/.test(m.clientAssignedMessageId || ''));

  test('fast triage (5B / 9.2): Control rows 38-40 default OFF, waiting notes hold, and with rows 38-40 OFF queueing, ordering, review, and story cards are unchanged', () => {
    const batch = SIGNAL_IDS_WITH_ANSWERS.slice(0, 6).map(id => FX.signals.find(s => s.alert_id === id));

    const runScenario = disableFastTriageHooks => {
      const env = makeFastTriageE2e(() => batch, () => {
        throw new Error('Decisions API must never be called when rows 38-40 are OFF');
      });
      const { t } = env;
      const sh = t.control();
      eq([sh.cell(38, 1), sh.cell(38, 2), sh.validations['38,2'].values], ['Fast triage (Gemini Decisions)', 'OFF', ['ON', 'OFF']]);
      eq([sh.cell(39, 1), sh.cell(39, 2), sh.validations['39,2'].values], ['Fast triage: rank and early watch', 'OFF', ['ON', 'OFF']]);
      eq([sh.cell(40, 1), sh.cell(40, 2), sh.validations['40,2'].values], ['Fast triage: hold back noise', 'OFF', ['ON', 'OFF']]);
      eq([sh.cell(41, 1), sh.cell(42, 1)], ['', 'How it works']);

      if (disableFastTriageHooks) {
        t.bot.ftStart_ = () => null;
        t.bot.ftOn_ = () => false;
        t.bot.ftRankOn_ = () => false;
        t.bot.ftHoldOn_ = () => false;
      }

      sh.getRange(19, 2).setValue('ON');
      const propsSvc = t.g.services.PropertiesService.getScriptProperties();
      t.poll(); // Check 1 queues 5 of 6 in original order and reviews the top 2 (by pri, then au, then queued order)
      const qAfter1 = t.bot.edQueueList_(propsSvc);
      const qRowsAfter1 = qAfter1.map(entry => t.bot.edQueueRow_(propsSvc, entry.k));
      t.g.clock.now += 2 * MIN;
      t.poll(); // Run 2 reviews next 2
      t.g.clock.now += 2 * MIN;
      t.poll(); // Run 3 reviews the 5th

      const props = Array.from(t.g.props.entries())
        .filter(([k]) => /^(?:EARLY_DETECTION_|ED_ALERT_|DECISIONS_)/.test(k))
        .sort(([a], [b]) => (a < b ? -1 : 1));
      return {
        env,
        qAfter1,
        qRowsAfter1,
        cards: edCardsOf(t).map(m => m.text),
        alertRows: t.sheet().getSheetByName('Alert log').rows,
        hasFtTab: !!t.sheet().getSheetByName('Fast triage'),
        c19: sh.cell(19, 3),
        props,
      };
    };

    const withCodePresent = runScenario(false);
    const baselineEquiv = runScenario(true);

    eq([withCodePresent.env.decCalls(), withCodePresent.env.secretCalls(), withCodePresent.hasFtTab], [0, 0, false]);
    eq(withCodePresent.env.seenOpts, [null]); // bqEarlyDetectionRows_ called without opts when row 38 is OFF
    withCodePresent.qAfter1.forEach((entry, idx) => {
      eq(Object.keys(entry).sort(), ['at', 'au', 'id', 'k', 'pri', 'sig', 'tries']);
      eq(withCodePresent.qRowsAfter1[idx].dec, undefined);
    });
    eq(withCodePresent.qAfter1, baselineEquiv.qAfter1);
    eq(withCodePresent.qRowsAfter1, baselineEquiv.qRowsAfter1);
    eq(withCodePresent.cards.length, 5);
    eq(withCodePresent.cards, baselineEquiv.cards);
    eq(withCodePresent.alertRows, baselineEquiv.alertRows);
    eq(withCodePresent.c19, baselineEquiv.c19);
    eq(withCodePresent.props, baselineEquiv.props);

    // Waiting notes when parent switches are OFF
    const { t } = withCodePresent.env;
    const sh = t.control();
    sh.getRange(19, 2).setValue('OFF');
    sh.getRange(38, 2).setValue('ON');
    t.g.clock.now += MIN;
    t.poll();
    assert.match(sh.cell(38, 3), /^✓ ON, but waiting: it needs Early wave & velocity check \(row 19\) ON/);
    sh.getRange(38, 2).setValue('OFF');
    sh.getRange(39, 2).setValue('ON');
    sh.getRange(40, 2).setValue('ON');
    t.g.clock.now += MIN;
    t.poll();
    assert.match(sh.cell(39, 3), /^✓ ON, but waiting: it needs Fast triage \(row 38\) ON/);
    assert.match(sh.cell(40, 3), /^✓ ON, but waiting: it needs Fast triage \(row 38\) ON/);
  });

  test('fast triage (5B): producer facts (opts.facts), ordering rules (ftRank_, edQueueRank_, ftQueueUnrank_), and hold-back safety gates (ftP0Group_, ftProtected_, ftHoldWhy_)', () => {
    const g = makeGoogle(NOW);
    const EWS_COLS = [
      ['kind'], ['lane'], ['mid'], ['url'], ['platform'], ['author'],
      ['audience', 'INTEGER'], ['eng', 'INTEGER'], ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'],
      ['txt'], ['topic'], ['chash'], ['sig'], ['risk'], ['brand', 'BOOLEAN'],
    ];
    const origFetch = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (!String(url).startsWith('https://bigquery.googleapis.com/')) return origFetch(url, params);
      const body = JSON.parse(params.payload || '{}');
      const loc = body.location || 'US';
      const rows = loc === 'us-central1'
        ? [1, 2, 3, 4, 5].map(i => ({
          kind: 'post',
          lane: 'sonar',
          mid: `M-${i}`,
          url: i % 2 === 0 ? `https://x.com/u${i}/status/215000000000000000${i}` : `https://www.reddit.com/r/Chrome/comments/1z${i}ab/crash/`,
          platform: i % 2 === 0 ? 'twitter' : 'reddit',
          author: `user_${i}`,
          audience: 250,
          eng: 10,
          posted_ms: g.clock.now - (10 - i) * MIN,
          seen_ms: g.clock.now - (9 - i) * MIN,
          txt: 'Chrome leaked passwords exposed in plaintext after installing the overnight browser update patch',
          topic: 'Chrome',
          chash: `ch_${i}`,
          sig: `sig_${i}`,
          risk: 'privacy_data_leak',
          brand: true,
        }))
        : [];
      return {
        getResponseCode: () => 200,
        getHeaders: () => ({}),
        getContentText: () => JSON.stringify({
          jobComplete: true,
          jobReference: { projectId: 'brand-social-central-data', jobId: `j_${loc}`, location: loc },
          schema: { fields: EWS_COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
          rows: rows.map(r => ({ f: EWS_COLS.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })),
        }),
      };
    };
    const bot = loadBot(g.services, g.clock);

    // Without opts.facts: row shape is unchanged (no risk_groups / tag_raised). With opts.facts: both are attached
    const plainRows = bot.bqEarlyDetectionRows_(30);
    eq([plainRows.length, plainRows[0].risk_groups, plainRows[0].tag_raised], [1, undefined, undefined]);
    eq(bot.ftProtected_(plainRows[0]), true); // rows lacking facts are never held back

    g.clock.now += 15 * MIN;
    g.props.clear();
    g.cache.clear();
    const factRows = bot.bqEarlyDetectionRows_(30, { facts: true });
    eq([factRows.length, factRows[0].risk_groups, typeof factRows[0].tag_raised], [1, 'privacy_data_leak', 'boolean']);
    eq([bot.ftP0Group_(factRows[0]), bot.ftProtected_(factRows[0])], [true, true]);

    // Pure protection & hold-back rules (Rule 3 & Section 5B)
    const baseRow = { priority_hint: 'P1', risk_groups: '', tag_raised: false };
    const lowNotGoogle = { g: 0.05, r: 0.02, i: 0.1, n: 0.4, s: 0.12, l: 0, sc: 0.91 };
    const lowNoise = { g: 0.96, r: 0.04, i: 0.2, n: 0.92, s: 0.65, l: 1, sc: 0.85 };
    eq(bot.ftHoldReady_(), false);
    eq(bot.ftHoldWhy_(baseRow, lowNotGoogle), ''); // default bars are null -> never holds back

    const bars = { about: 0.15, noise: 0.85, conf: 0.8 };
    eq(bot.ftHoldWhy_(baseRow, null, bars), ''); // no answer -> fail open
    eq(bot.ftHoldWhy_({ priority_hint: 'P0', risk_groups: '', tag_raised: false }, lowNotGoogle, bars), ''); // P0 priority protected
    eq(bot.ftHoldWhy_({ priority_hint: 'P2', risk_groups: 'safety_csam_selfharm', tag_raised: false }, lowNotGoogle, bars), ''); // P0 group protected
    eq(bot.ftHoldWhy_({ priority_hint: 'P2', risk_groups: '', tag_raised: true }, lowNoise, bars), ''); // taxonomy raise protected
    eq(bot.ftHoldWhy_(baseRow, Object.assign({}, lowNotGoogle, { l: 2 }), bars), ''); // medium+ severity never held back
    eq(bot.ftHoldWhy_(baseRow, Object.assign({}, lowNotGoogle, { sc: 0.8 }), bars), ''); // must be strictly above conf bar
    eq(bot.ftHoldWhy_(baseRow, lowNotGoogle, bars), 'not about Google (about Google 0.05, severity none 0.91)');
    eq(bot.ftHoldWhy_(baseRow, lowNoise, bars), 'routine noise (routine noise 0.92, severity low 0.85)');

    // Pure ordering (ftRank_ and edQueueRank_ + ftQueueUnrank_): P0 group > tier > unanswered (fail-open) > severity > brand_risk > prior order
    const items = [
      { idx: 0, row: { id: 'p1_low', priority_hint: 'P1', risk_groups: '' }, dec: { s: 0.4, r: 0.2 } },
      { idx: 1, row: { id: 'p1_high_r1', priority_hint: 'P1', risk_groups: '' }, dec: { s: 2.8, r: 0.6 } },
      { idx: 2, row: { id: 'p1_high_r2', priority_hint: 'P1', risk_groups: '' }, dec: { s: 2.8, r: 0.9 } },
      { idx: 3, row: { id: 'p1_no_ans', priority_hint: 'P1', risk_groups: '' }, dec: null },
      { idx: 4, row: { id: 'p1_p0group', priority_hint: 'P1', risk_groups: 'privacy_data_leak' }, dec: { s: 1.1, r: 0.3 } },
      { idx: 5, row: { id: 'p2_high', priority_hint: 'P2', risk_groups: '' }, dec: { s: 3.5, r: 0.95 } },
    ];
    eq(items.slice().sort(bot.ftRank_).map(x => x.row.id), [
      'p1_p0group', 'p1_no_ans', 'p1_high_r2', 'p1_high_r1', 'p1_low', 'p2_high',
    ]);

    const props = g.services.PropertiesService.getScriptProperties();
    const rLowManyAu = Object.assign({}, FX.signals[4], { alert_id: 'ED-LOW-AU20', unique_low_tier_authors: 20, risk_groups: '', tag_raised: false });
    const rHighFewAu = Object.assign({}, FX.signals[2], { alert_id: 'ED-HIGH-AU4', unique_low_tier_authors: 4, risk_groups: '', tag_raised: false });
    bot.edQueuePut_(props, rLowManyAu, g.clock.now, bot.ftRankKeys_(rLowManyAu, { s: 0.2, r: 0.05 }));
    bot.edQueuePut_(props, rHighFewAu, g.clock.now + 1000, bot.ftRankKeys_(rHighFewAu, { s: 2.53, r: 0.94 }));
    eq(bot.edQueueList_(props).map(e => e.id), ['ED-HIGH-AU4', 'ED-LOW-AU20']); // severity wins while ranked
    bot.ftQueueUnrank_(props);
    eq(bot.edQueueList_(props).map(e => e.id), ['ED-LOW-AU20', 'ED-HIGH-AU4']); // row 39 OFF -> back to author-count order
  });

  test('fast triage (5B): earlyWaveCheck_ recording-only (row 38), queue ranking + answer cache (row 39), and calibrated hold-back with C19 count & log line (row 40)', () => {
    // 1. Recording-only (Row 38 ON alone): asks only on the 5 queued signals, attaches `dec` without dropping posts, changes neither queue order nor cards
    const sixP1 = [
      'ED-CLU-CLU-3287667bddd9-202611101231', // s=0.19 (pos 1)
      'ED-CLU-CLU-abe6decf9a2a-202611121446', // s=0.22 (pos 2)
      'ED-CLU-CLU-3aa05dedf0a7-202611072231', // s=0.96 (pos 3)
      'ED-VEL-PRIORITY_TOPIC-2cb939f86090a0ffb4ed1cce8c43c295-202611091217', // P2, s=0.52 (pos 4)
      'ED-VEL-CLUSTER-1dd1392bf7db140af902df1be556969f-202611080402', // P2, s=0.25 (pos 5)
      'ED-CLU-CLU-e9dddc0be913-202611071746', // Android CERT-In, P1, s=2.53 (pos 6 — beyond EW_MAX_PER_CHECK_=5 without row 39!)
    ].map(id => FX.signals.find(s => s.alert_id === id));

    const recordOnly = makeFastTriageE2e(() => sixP1, (payload) => matchRecordedResponse(recordOnly.t.bot, payload));
    recordOnly.t.control().getRange(19, 2).setValue('ON');
    recordOnly.t.control().getRange(38, 2).setValue('ON');
    recordOnly.t.poll();
    eq(recordOnly.decCalls(), 5); // only the 5 queued candidates were asked; 6th was untouched in recording-only mode
    assert.match(recordOnly.t.control().cell(38, 3), /5 asked today/);
    const recordQueue = recordOnly.t.bot.edQueueList_(recordOnly.t.g.services.PropertiesService.getScriptProperties());
    eq(recordQueue.length, 3); // 5 queued - 2 reviewed this run = 3 waiting
    assert.ok(!recordQueue.some(e => e.id === 'ED-CLU-CLU-e9dddc0be913-202611071746'));
    recordQueue.forEach(e => {
      eq([e.sv, e.br], [undefined, undefined]); // no ranking keys with row 39 OFF
      const row = recordOnly.t.bot.edQueueRow_(recordOnly.t.g.services.PropertiesService.getScriptProperties(), e.k);
      assert.strictEqual(typeof row.dec.s, 'number');
    });

    // 2. Order (Rows 38 + 39 ON): asks all 6 candidates, promotes Android CERT-In (s=2.53) to #1, and caches the 6th candidate's answer for the next check
    const ranked = makeFastTriageE2e(() => sixP1, (payload) => matchRecordedResponse(ranked.t.bot, payload));
    ranked.t.control().getRange(19, 2).setValue('ON');
    ranked.t.control().getRange(38, 2).setValue('ON');
    ranked.t.control().getRange(39, 2).setValue('ON');
    ranked.t.poll();
    eq(ranked.decCalls(), 6); // all 6 candidates asked before picking top 5
    const firstTwoCards = edCardsOf(ranked.t);
    eq(firstTwoCards.length, 2);
    assert.ok(firstTwoCards[0].text.includes('ED-CLU-CLU-e9dddc0be913-202611071746'), 'highest-severity signal reviewed & carded first');

    // Next check 15 min later: the 6th unqueued signal ('ED-VEL-CLUSTER-...') is picked up from FT_ANSWER_CACHE_PREFIX_ with 0 new Decisions API calls!
    ranked.t.g.clock.now += 15 * MIN;
    ranked.t.poll();
    eq(ranked.decCalls(), 6);

    // 3. Hold-back (Rows 38 + 40 ON): default null bars hold back 0; calibrated bars hold back noise/off-topic while protecting P0 risk groups & taxonomy raises
    const holdSignals = [
      FX.signals.find(s => s.alert_id === 'ED-CLU-CLU-dc5a8afd13da-202611061731'), // P0 group -> protected
      FX.signals.find(s => s.alert_id === 'ED-CLU-CLU-abe6decf9a2a-202611121446'), // n=0.89, l=0, sc=0.86 -> held back (routine noise)
      FX.signals.find(s => s.alert_id === 'ED-VEL-CLUSTER-1dd1392bf7db140af902df1be556969f-202611080402'), // g=0.07, l=0, sc=0.84 -> held back (not about Google)
      FX.signals.find(s => s.alert_id === 'ED-CLU-CLU-3aa05dedf0a7-202611072231'), // n=0.95, l=1, sc=0.60 <= 0.80 -> NOT held back
    ];
    const holdDefault = makeFastTriageE2e(() => holdSignals, (payload) => matchRecordedResponse(holdDefault.t.bot, payload));
    holdDefault.t.control().getRange(19, 2).setValue('ON');
    holdDefault.t.control().getRange(38, 2).setValue('ON');
    holdDefault.t.control().getRange(40, 2).setValue('ON');
    holdDefault.t.poll();
    assert.match(holdDefault.t.control().cell(40, 3), /^✓ ON, but nothing is held back yet: its bars are not set/);
    assert.ok(!holdDefault.t.control().cell(19, 3).includes('filtered by fast triage'));

    const holdCal = makeFastTriageE2e(() => holdSignals, (payload) => {
      // Force low/noise answers even for the P0-group signal to prove Rule 3 protection holds under worst-case model output
      const p0Row = FX.signals.find(s => s.alert_id === 'ED-CLU-CLU-dc5a8afd13da-202611061731');
      if (holdCal.t.bot.decSignalInput_(p0Row) === payload.input) {
        return { code: 200, body: FX.signal_responses['ED-VEL-CLUSTER-1dd1392bf7db140af902df1be556969f-202611080402'] };
      }
      return matchRecordedResponse(holdCal.t.bot, payload);
    });
    holdCal.t.bot.ftHoldBars_ = () => ({ about: 0.15, noise: 0.85, conf: 0.8 });
    holdCal.t.control().getRange(19, 2).setValue('ON');
    holdCal.t.control().getRange(38, 2).setValue('ON');
    holdCal.t.control().getRange(40, 2).setValue('ON');
    holdCal.t.poll();

    assert.match(holdCal.t.control().cell(19, 3), / · 2 filtered by fast triage$/);
    eq(edCardsOf(holdCal.t).length, 2); // P0-group signal + low-confidence Chrome adblock signal both reviewed and carded!
    assert.ok(edCardsOf(holdCal.t).some(m => m.text.includes('ED-CLU-CLU-dc5a8afd13da-202611061731')), 'P0-group signal never held back');
    assert.ok(edCardsOf(holdCal.t).some(m => m.text.includes('ED-CLU-CLU-3aa05dedf0a7-202611072231')), 'below-confidence signal never held back');
    const logs = holdCal.t.g.logs.join('\n');
    assert.match(logs, /early detection: fast triage held back ED-CLU-CLU-abe6decf9a2a-202611121446: routine noise/);
    assert.match(logs, /early detection: fast triage held back ED-VEL-CLUSTER-1dd1392bf7db140af902df1be556969f-202611080402: not about Google/);
    const ftSh = holdCal.t.sheet().getSheetByName('Fast triage');
    assert.ok(ftSh && ftSh.rows.some(r => r[1] === 'ED-CLU-CLU-abe6decf9a2a-202611121446' && String(r[16]).startsWith('held back: routine noise')));
  });

  test('fast triage (5B / 9.3): each Rule 4 failure mode in earlyWaveCheck_ falls back to today\'s queueing, ordering, review, and cards', () => {
    const twoReal = [
      FX.signals.find(s => s.alert_id === 'ED-CLU-CLU-abe6decf9a2a-202611121446'),
      FX.signals.find(s => s.alert_id === 'ED-VEL-CLUSTER-1dd1392bf7db140af902df1be556969f-202611080402'),
    ];

    // Baseline OFF cards on the same two signals
    const offEnv = makeFastTriageE2e(() => twoReal, () => ({ code: 500, body: '{}' }));
    offEnv.t.control().getRange(19, 2).setValue('ON');
    offEnv.t.poll();
    const baselineCards = edCardsOf(offEnv.t).map(m => m.text);
    eq(baselineCards.length, 2);

    const failureModes = [
      { name: 'missing_key', secret: () => ({ code: 404, body: { error: { message: 'Not found' } } }), responder: () => ({ code: 200, body: '{}' }), paused: true },
      { name: 'http_429', responder: () => ({ code: 429, body: FX.error_429_live.body }), paused: true },
      { name: 'http_503', responder: () => ({ code: 503, body: { error: { code: 'service_unavailable' } } }), paused: true },
      { name: 'unparseable_body', responder: () => ({ code: 200, body: '<<<not json>>>' }), paused: true },
      { name: 'slow_timeout', responder: (_p, clock) => { clock.now += 11000; return { code: 200, body: FX.probe.six_questions_doc_input.response.body }; }, paused: true },
      { name: 'network_throw', responder: () => { throw new Error('Socket reset by peer'); }, paused: true },
      { name: 'safety_refusal', responder: () => ({ code: 400, body: { error: { code: 'safety', message: 'Blocked' } } }), paused: false },
    ];

    for (const fm of failureModes) {
      const responder = (payload, clock, n) => fm.responder(payload, clock, n);
      if (fm.secret) responder.secret = fm.secret;
      const env = makeFastTriageE2e(() => twoReal, responder);
      // Enable ALL THREE switches (38, 39, 40) AND active hold-back bars that WOULD hold both signals back if Decisions succeeded!
      env.t.bot.ftHoldBars_ = () => ({ about: 0.15, noise: 0.85, conf: 0.8 });
      env.t.control().getRange(19, 2).setValue('ON');
      env.t.control().getRange(38, 2).setValue('ON');
      env.t.control().getRange(39, 2).setValue('ON');
      env.t.control().getRange(40, 2).setValue('ON');
      env.t.poll();

      eq(JSON.parse(env.t.g.props.get('LAST_RUN')).errors, [], fm.name);
      eq(edCardsOf(env.t).map(m => m.text), baselineCards, `${fm.name}: cards identical to OFF baseline`);
      assert.ok(!env.t.control().cell(19, 3).includes('filtered by fast triage'), fm.name);
      const c38 = env.t.control().cell(38, 3);
      if (fm.paused) {
        assert.match(c38, /paused until .*: signals go on without it/, `${fm.name}: C38 shows cooldown`);
      } else {
        assert.match(c38, /2 refused by the safety filter/, `${fm.name}: C38 counts refusals without pausing`);
        assert.ok(!c38.includes('paused until'), `${fm.name}: safety refusal does not pause`);
      }
    }
  });
};

