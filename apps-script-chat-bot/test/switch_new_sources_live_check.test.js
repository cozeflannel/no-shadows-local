// The read-only live check of the two new sources (LiveVerify.gs verifyNewSourcesLive, the plan's stage 0): run by hand
// from the editor, it asks Brandwatch (GET only, with the shared key read the way the Watch reads it) for the project's
// queries, the account's content sources, five mentions with every filter the reader will send and the last 24 hours;
// and BigQuery for the AMIE table's metadata, a dry run of a one-day read and, under 1 GB, that read. It writes nothing
// and posts nothing; its report has one OK / CHECK / PROBLEM line a finding and the gate for Brandwatch live last.
// Everything here is made up: query names, links, authors and the token.
'use strict';

module.exports = H => {
  const { test, eq, assert, NOW, makeGoogle, loadBot, e2e } = H;
  const MIN = 60 * 1000;
  const TOKEN = 'bw-shared-token-0f1e2d3c4b5a';
  const ADDRESS = 'analyst.one@example.test';
  const AMIE_PATH = '/projects/brand-social-central-data/datasets/social_alerts_dataset/tables/all_sundar_mentions';
  const POST_TEXT = 'My Pixel phone keeps restarting after the overnight update and nothing I try fixes it at all';
  const AUTHOR = 'made_up_author';

  /** A Brandwatch time as its API writes it ("2026-10-14T11:58:00.000+0000"). */
  const bwTime = ms => new Date(ms).toISOString().replace('Z', '+0000');
  /** A made-up mention: added `addedAgo` minutes ago, posted `delay` minutes before that. */
  const mention = (i, o) => {
    const x = Object.assign({ q: 111, src: 'reddit', addedAgo: 10, delay: 10 }, o || {});
    const m = {
      queryId: x.q, queryName: 'Google Pixel test', contentSource: x.src, pageType: x.src, guid: `g${i}`, resourceId: `r${i}`,
      url: `https://www.reddit.com/r/pixeltest/comments/abc${i}/`, added: bwTime(NOW - x.addedAgo * MIN),
      date: bwTime(NOW - (x.addedAgo + x.delay) * MIN), language: 'en', sentiment: 'neutral', threadEntryType: 'post',
      snippet: POST_TEXT, potentialAudience: 120, author: AUTHOR,
    };
    return Object.assign(m, x.m || {});
  };
  /** Healthy data: reddit fast with words, forum slow, two facebook (too few to judge), one X, one of another query. */
  const healthyMentions = () => [].concat(
    [0, 1, 2, 3, 4, 5].map(i => mention(i, { addedAgo: 50 - i * 5, delay: 10 })),
    [6, 7, 8, 9, 10].map(i => mention(i, { src: 'forum', q: 222, addedAgo: 300 + i, delay: 200 })),
    [11, 12].map(i => mention(i, { src: 'facebook', addedAgo: 500 + i, delay: 30 })),
    [mention(13, { src: 'reddit', addedAgo: 180, delay: 5 })],   // added 3 hours ago: before the test read's "added since"
    [mention(14, { src: 'twitter', addedAgo: 55, delay: 1, m: { url: '', guid: '2116390716536770729', snippet: '' } })],
    [mention(15, { q: 333, addedAgo: 5 })]);

  /**
   * A made-up world: Secret Manager answers the token (or w.secret: {code, message}); Brandwatch's queries/summary,
   * /metrics and /data/mentions answer w.queries, w.sources and w.mentions, the mentions call applying queryId,
   * pageType, sinceAdded, orderDirection, page and pageSize unless w.ignore names the filter; w.fail[part] ('summary',
   * 'metrics', 'test' for pageSize 5, 'day' for pageSize 500) answers {code, body} or throws ('throw'); every answer
   * carries w.headers; w.order ('asc' or 'desc') forces the order of every mentions answer. BigQuery answers tables.get
   * with w.table, a dry run with w.bytes and the SELECT (and a GET of its job, kind 'results') with w.rows, the first
   * w.incomplete answers of those saying the job is not complete yet; w.tableFail, w.dryFail, w.selectFail and
   * w.resultsFail answer {code, message} (BigQuery's JSON error), {code, text} (a body that is not JSON) or throw
   * ('throw'). Every call is recorded in w.calls: {host, method, path, payload, headers, kind}.
   */
  function world() {
    const g = makeGoogle(NOW);
    const w = {
      secret: null, ignore: {}, fail: {}, calls: [],
      headers: { 'x-rate-limit': '600/10m', 'x-rate-limit-used': '37' },
      queries: [
        { id: 111, name: 'Google Pixel test', contentSources: ['reddit', 'facebook'], languages: ['en'], lastModifiedUsername: ADDRESS, lockedByUsername: ADDRESS },
        { id: 333, name: 'Competitor phones test', contentSources: ['reddit'], languages: ['en'], lastModifiedUsername: ADDRESS },
        { id: 222, name: 'Gemini app test', contentSources: ['forum'], languages: ['en', 'es'], lastModifiedUsername: ADDRESS },
        { id: 444, name: 'Android test', contentSources: ['reddit'], languages: ['en'], lastModifiedUsername: ADDRESS },
      ],
      sources: ['twitter', 'reddit', 'facebook', 'facebook_public', 'instagram', 'instagram_public', 'tiktok', 'youtube', 'threads',
        'tumblr', 'forum', 'bluesky', 'news', 'blog', 'linkedin'],
      mentions: healthyMentions(),
      table: {
        lastModifiedTime: String(NOW - 4 * MIN),
        timePartitioning: { type: 'DAY', field: 'ingestionTimestamp' },
        schema: { fields: [['url'], ['alert_source'], ['snippet'], ['authorHandle'], ['SocialNetwork'], ['Sentiment'],
          ['postTime', 'TIMESTAMP'], ['ingestionTimestamp', 'TIMESTAMP'], ['followers', 'INTEGER'], ['KOF'], ['product'], ['engagement']]
          .map(([name, type]) => ({ name, type: type || 'STRING', mode: 'NULLABLE' })) },
      },
      tableFail: null, dryFail: null, selectFail: null, resultsFail: null, incomplete: 0, bytes: 80 * 1000 * 1000,
      rows: [
        { kind: 'all', net: '', n: 24000, newest_ms: NOW - 3 * MIN, no_post_time: 12, median_min: 1320, p90_min: 4320 },
        { kind: 'net', net: 'Twitter', n: 15000 }, { kind: 'net', net: 'Reddit', n: 6000 }, { kind: 'net', net: 'Facebook', n: 3000 },
      ],
    };
    const resp = (code, body, headers) => ({ getResponseCode: () => code, getHeaders: () => headers || {},
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    const prev = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      const p = params || {};
      const call = { url, method: String(p.method || 'get').toLowerCase(), payload: p.payload === undefined ? null : p.payload, headers: p.headers || {} };
      if (url.startsWith('https://secretmanager.googleapis.com/')) {
        w.calls.push(Object.assign(call, { host: 'secret' }));
        if (w.secret) return resp(w.secret.code, { error: { code: w.secret.code, message: w.secret.message } });
        return resp(200, { name: 'v', payload: { data: Buffer.from(TOKEN, 'utf8').toString('base64') } });
      }
      if (url.startsWith('https://api.brandwatch.com/')) {
        const u = new URL(url);
        const q = u.searchParams;
        const part = /\/queries\/summary$/.test(u.pathname) ? 'summary' : u.pathname === '/metrics' ? 'metrics'
          : q.get('pageSize') === '5' ? 'test' : 'day';
        w.calls.push(Object.assign(call, { host: 'brandwatch', part, path: u.pathname, params: q }));
        const f = w.fail[part];
        if (f === 'throw') throw new Error(`Address unavailable: ${url} (bearer ${TOKEN}, for ${ADDRESS})`);
        if (f) return resp(f.code, f.body, w.headers);
        if (part === 'summary') return resp(200, { results: w.queries }, w.headers);
        if (part === 'metrics') return resp(200, { contentSources: w.sources, sentiments: ['negative', 'neutral', 'positive'] }, w.headers);
        const ids = q.getAll('queryId').map(Number);
        const types = q.getAll('pageType');
        const since = Date.parse(q.get('sinceAdded'));
        const at = m => Date.parse(m.added.replace('+0000', 'Z'));
        let list = w.mentions.filter(m => ids.includes(m.queryId));
        if (!w.ignore.pageType) list = list.filter(m => types.includes(m.contentSource));
        if (!w.ignore.sinceAdded) list = list.filter(m => at(m) > since);
        const dir = w.order || (w.ignore.orderDirection ? 'desc' : q.get('orderDirection'));
        list = list.slice().sort((a, b) => (dir === 'asc' ? at(a) - at(b) : at(b) - at(a)));
        const size = Number(q.get('pageSize'));
        const page = Number(q.get('page'));
        return resp(200, { resultsTotal: list.length, resultsPage: page, resultsPageSize: size, results: list.slice(page * size, page * size + size) }, w.headers);
      }
      if (url.startsWith('https://bigquery.googleapis.com/')) {
        const body = call.payload ? JSON.parse(call.payload) : null;
        const kind = url.endsWith(AMIE_PATH) && call.method === 'get' ? 'tables.get'
          : /\/queries$/.test(url) && body && body.dryRun === true ? 'dryRun'
            : /\/queries$/.test(url) && body ? 'select'
              : call.method === 'get' && /\/projects\/brand-social-central-data\/queries\/nsv_1\?/.test(url) ? 'results' : 'other';
        w.calls.push(Object.assign(call, { host: 'bigquery', kind, body }));
        const failed = f => {
          if (f === 'throw') throw new Error(`BigQuery unreachable for ${ADDRESS}`);
          return f.text !== undefined ? resp(f.code, f.text) : resp(f.code, { error: { code: f.code, message: f.message } });
        };
        if (kind === 'tables.get') return w.tableFail ? failed(w.tableFail) : resp(200, w.table);
        if (kind === 'dryRun') {
          return w.dryFail ? failed(w.dryFail)
            : resp(200, { kind: 'bigquery#queryResponse', jobComplete: true, totalBytesProcessed: String(w.bytes) });
        }
        if (kind === 'select' && w.selectFail) return failed(w.selectFail);
        if (kind === 'results' && w.resultsFail) return failed(w.resultsFail);
        if (kind === 'select' || kind === 'results') {
          const cols = [['kind'], ['net'], ['n', 'INTEGER'], ['newest_ms', 'INTEGER'], ['no_post_time', 'INTEGER'], ['median_min', 'INTEGER'], ['p90_min', 'INTEGER']];
          const ref = { projectId: 'brand-social-central-data', jobId: 'nsv_1', location: 'US' };
          if (w.incomplete > 0) { w.incomplete--; return resp(200, { jobComplete: false, jobReference: ref }); }
          return resp(200, {
            jobComplete: true, jobReference: ref,
            schema: { fields: cols.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
            rows: w.rows.map(r => ({ f: cols.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })),
          });
        }
        return resp(404, { error: { code: 404, message: 'not found' } });
      }
      return prev(link, params);
    };
    return { g, w };
  }

  /** Runs the check in a fresh bot of `env` (the world): {report, lines, logs}. */
  function run(env, ids) {
    const b = loadBot(env.g.services, env.g.clock);
    const report = ids === undefined ? b.verifyNewSourcesLive() : b.verifyNewSourcesLive(ids);
    return { report, lines: report.split('\n'), logs: env.g.logs.join('\n') };
  }
  const line = (r, rx) => r.lines.find(l => rx.test(l)) || '';
  const findings = r => r.lines.filter(l => /^(OK|CHECK|PROBLEM) /.test(l));

  test('new sources live check: on healthy answers the report says each finding in a plain OK / CHECK / PROBLEM line, the gate last, and holds no key, address, post text or author', () => {
    const env = world();
    const r = run(env);
    // the head, every finding with its word first, the query list, the gate last
    assert.match(r.lines[0], /^Live check of the new sources \(read only\), 2026-10-14 12:00 UTC$/);
    const qStart = r.lines.indexOf('The project\'s Brandwatch queries (id | name | collects | languages | suggested):');
    assert.ok(qStart > 0, r.report);
    r.lines.slice(1, qStart).forEach(l => assert.match(l, /^(OK|CHECK|PROBLEM) /, l));
    eq(r.lines.slice(qStart + 1, -1), [
      '- 111 | Google Pixel test | reddit, facebook | en | yes',
      '- 222 | Gemini app test | forum | en, es | yes',
      '- 444 | Android test | reddit | en | yes',
      '- 333 | Competitor phones test | reddit | en | no',
    ]);
    eq(r.lines[r.lines.length - 1], 'CHECK gate for Brandwatch live: these sources are slower than 2 hours: forum (median 3 h 20 min); ' +
      'leave them out of what Brandwatch live reads. Too few mentions with times to judge: facebook (2)');
    eq(findings(r).slice(0, 17), [
      'OK Brandwatch project 1998344909 has 4 queries; 3 look like Google\'s by the plan\'s rule ("Google Pixel test", "Gemini app test", "Android test")',
      'OK this Brandwatch account has 15 content sources: twitter, reddit, facebook, facebook_public, instagram, instagram_public, tiktok, youtube, threads, tumblr, forum, bluesky, news, blog, linkedin',
      'OK the two Brandwatch reads use 2 queries: "Google Pixel test" (111), "Gemini app test" (222), and these content sources: reddit, bluesky, facebook, facebook_public, instagram, instagram_public, tiktok, youtube, threads, tumblr, forum',
      'OK no X post came back in the test read',
      'OK "added since" was honoured: none of the 5 mentions was added before it',
      'OK the mentions came oldest added first',
      'OK every mention had contentSource, guid, resourceId, url, added, date, language, sentiment',
      'OK other fields: pageType on 5 of 5, threadEntryType on 5 of 5',
      'OK a follower count on 5 of 5 mentions (potentialAudience on 5)',
      'OK the read of the last 24 hours gave 14 mentions',
      'OK reddit: 7 mentions, 7 with words; from posting to added: median 10 min, 90% within 10 min',
      'CHECK forum: 5 mentions, 5 with words; from posting to added: median 3 h 20 min, 90% within 3 h 20 min',
      'OK facebook: 2 mentions, 2 with words; from posting to added: median 30 min, 90% within 30 min',
      'OK call-count headers on the answer to the test read: x-rate-limit-used "37"; x-rate-limit "600/10m": 600 calls in 10 minutes',
      'OK the AMIE table can be read and has every column the plan needs, of the right type (12 columns in all)',
      'OK the AMIE table\'s optional columns: followers (INTEGER), KOF (STRING), product (STRING), engagement (STRING)',
      'OK the AMIE table is partitioned by day on ingestionTimestamp',
    ]);
    eq(findings(r).slice(17, -1), [
      'OK the AMIE table last changed 4 min ago (2026-10-14 11:56 UTC)',
      'OK one day of the AMIE table scans 0.08 GB (the dry run\'s figure; the limit is 1 GB)',
      'OK the AMIE table, last 24 hours: 24,000 rows; the newest landed 3 min ago',
      'OK the AMIE table by network: Twitter 63%, Reddit 25%, Facebook 13%; X is 63% of the rows (15,000)',
      'OK rows with no posting time: 12 of 24,000 (they would be left out)',
      'CHECK from posting to the AMIE table: median 22 h, 90% within 3 days (slower than 2 hours: most of its posts would only join stories)',
    ]);
    // the X mention the day read did not ask for never came (pageType honoured); query 333 was never asked for
    const mentionCalls = env.w.calls.filter(c => c.part === 'test' || c.part === 'day');
    eq(mentionCalls.map(c => c.params.getAll('queryId')), [['111', '222'], ['111', '222']]);
    // every parameter of the plan's request, never X or LinkedIn
    const test5 = mentionCalls[0].params;
    eq([test5.get('startDate'), test5.get('endDate'), test5.get('sinceAdded'), test5.get('orderBy'), test5.get('orderDirection'),
      test5.get('pageSize'), test5.get('page'), test5.get('language'), test5.get('xthreadEntryType'), test5.get('sourceType')],
    ['2026-10-11T12:00:00.000Z', '2026-10-14T12:05:00.000Z', '2026-10-14T11:00:00.000Z', 'added', 'asc', '5', '0', 'en', 'share', 'new']);
    eq(test5.getAll('pageType'), ['reddit', 'bluesky', 'facebook', 'facebook_public', 'instagram', 'instagram_public', 'tiktok', 'youtube', 'threads', 'tumblr', 'forum']);
    const day = mentionCalls[1].params;
    eq([day.get('sinceAdded'), day.get('orderDirection'), day.get('pageSize')], ['2026-10-13T12:00:00.000Z', 'desc', '500']);
    // the report and the log: no key, no address, no post text, no author; the log holds the report
    [r.report, r.logs].forEach(t => {
      assert.ok(!t.includes(TOKEN) && !t.includes('@') && !t.includes(POST_TEXT.slice(0, 20)) && !t.includes(AUTHOR), t);
    });
    assert.ok(r.logs.includes('LIVE_VERIFY_NEW_SOURCES\n' + r.report));
    // the query ids given by hand are used instead of the suggested ones
    const env2 = world();
    const r2 = run(env2, [444, '333']);
    assert.match(line(r2, /^OK the two Brandwatch reads use/), /^OK the two Brandwatch reads use 2 queries: "Android test" \(444\), "Competitor phones test" \(333\), and/);
    eq(env2.w.calls.filter(c => c.part === 'test').map(c => c.params.getAll('queryId')), [['444', '333']]);
  });

  test('new sources live check: "added since" ignored, the order ignored, an X mention, no mention in the hour and no Google query are each said in plain words', () => {
    let env = world();
    env.w.ignore.sinceAdded = true;
    let r = run(env);
    eq(line(r, /added since/), 'PROBLEM Brandwatch ignored "added since": 5 of 5 mentions were added before it');
    env = world();
    env.w.ignore.orderDirection = true;
    r = run(env);
    eq(line(r, /oldest added first/), 'PROBLEM the mentions did not come oldest added first (the order asked for was ignored)');
    env = world();
    env.w.ignore.pageType = true;
    r = run(env);
    eq([line(r, /X post.*test read/), line(r, /X post.*last 24 hours/)], [
      'PROBLEM Brandwatch sent 1 X post in the test read although the bot asked for none',
      'PROBLEM Brandwatch sent 1 X post in the read of the last 24 hours although the bot asked for none']);
    // the X post is not counted as a source of its own
    eq(line(r, /^(OK|CHECK) twitter:/), '');
    // an X link alone (no content source) counts as X too
    env = world();
    env.w.mentions.push(mention(20, { addedAgo: 2, m: { url: 'https://x.com/someone/status/2116390716536770730', contentSource: 'reddit' } }));
    r = run(env);
    assert.match(line(r, /X post.*last 24 hours/), /^PROBLEM Brandwatch sent 1 X post/);
    // nothing added in the last hour
    env = world();
    env.w.mentions = env.w.mentions.filter(m => Date.parse(m.added.replace('+0000', 'Z')) < NOW - 2 * 60 * MIN);
    r = run(env);
    assert.match(line(r, /test read found no mention/), /^CHECK the test read found no mention added in the last 60 minutes/);
    // no query that looks like Google's: nothing read, the person is told how to name two
    env = world();
    env.w.queries = env.w.queries.filter(q => q.id === 333);
    r = run(env);
    eq(line(r, /no query looks like/), 'CHECK no query looks like Google\'s by the plan\'s rule, so no mention was read: run it again with two query ids, as verifyNewSourcesLive([123, 456])');
    eq(env.w.calls.filter(c => c.part === 'test' || c.part === 'day').length, 0);
    eq(r.lines[r.lines.length - 1], 'CHECK gate for Brandwatch live: not measured (no query was chosen, so the read of the last 24 hours was not sent), so these sources are slower than 2 hours: unknown');
    // the account lacks some of the plan's sources: they are not asked for
    env = world();
    env.w.sources = ['twitter', 'reddit', 'forum'];
    r = run(env);
    eq(line(r, /not on this account/), 'CHECK on the plan\'s list but not on this account (they are not asked for): bluesky, facebook, facebook_public, instagram, instagram_public, tiktok, youtube, threads, tumblr');
    eq(env.w.calls.find(c => c.part === 'test').params.getAll('pageType'), ['reddit', 'forum']);
    // mentions with little or no text: said per source
    env = world();
    env.w.mentions.forEach(m => { if (m.contentSource === 'reddit') m.snippet = 'short'; });
    r = run(env);
    eq(line(r, /^(OK|CHECK) reddit:/), 'CHECK reddit: 7 mentions, 0 with words (most came without their words); from posting to added: median 10 min, 90% within 10 min');
  });

  test('new sources live check: the call-count headers are found in any letter case and read in both forms; missing ones are said', () => {
    const cases = [
      [{ 'X-Rate-Limit': '600/10m', 'X-Rate-Limit-Used': '452' },
        'OK call-count headers on the answer to the test read: X-Rate-Limit-Used "452"; X-Rate-Limit "600/10m": 600 calls in 10 minutes'],
      [{ 'x-rate-limit': '600', 'x-rate-limit-used': '37' },
        'OK call-count headers on the answer to the test read: x-rate-limit-used "37"; x-rate-limit "600", a bare number: 600 calls (the minutes not given)'],
      [{ 'X-RATE-LIMIT': '600/10M', 'x-Rate-limit-USED': '5' },
        'OK call-count headers on the answer to the test read: x-Rate-limit-USED "5"; X-RATE-LIMIT "600/10M": 600 calls in 10 minutes'],
      [{ 'x-rate-limit-used': '37' },
        'CHECK call-count headers on the answer to the test read: x-rate-limit-used "37"; x-rate-limit missing'],
      [{ 'Content-Type': 'application/json' },
        'CHECK no call-count header on Brandwatch\'s answer to the test read (looked for x-rate-limit and x-rate-limit-used in any letter case): the reader would show the shared login\'s use as unknown'],
    ];
    cases.forEach(([headers, want]) => {
      const env = world();
      env.w.headers = headers;
      eq(line(run(env), /call-count header/), want);
    });
  });

  test('new sources live check: each Brandwatch call refused (401, 403 with an address in its body, 429, 500) or thrown is said in plain words, the rest goes on, and no address or key reaches the report or the log', () => {
    const answers = {
      401: { code: 401, body: { errors: [{ code: 401, message: 'invalid token' }] } },
      403: { code: 403, body: { errors: [{ code: 403, message: `User ${ADDRESS} may not read project 1998344909` }] } },
      429: { code: 429, body: { errors: [{ code: 429, message: 'rate limit exceeded: Limit = 600 per 10 minute(s)' }] } },
      500: { code: 500, body: 'Internal error' },
      throw: 'throw',
    };
    const what = { summary: 'Brandwatch query list', metrics: 'Brandwatch content sources', test: 'Brandwatch test read', day: 'Brandwatch read of the last 24 hours' };
    const words = {
      401: 'Brandwatch refused the shared key (HTTP 401). The service that renews it may be down',
      403: 'Brandwatch refused it (HTTP 403: User [address] may not read project 1998344909)',
      429: 'Brandwatch said too many calls on the shared login (HTTP 429; other tools share it). Try again in 10 minutes',
      500: 'Brandwatch failed (HTTP 500: Internal error)',
    };
    Object.keys(what).forEach(part => {
      Object.keys(answers).forEach(kind => {
        const env = world();
        env.w.fail[part] = answers[kind];
        const r = run(env, part === 'summary' ? [111, 222] : undefined);
        const said = line(r, new RegExp(`^PROBLEM ${what[part]}: `));
        if (kind === 'throw') assert.match(said, new RegExp(`^PROBLEM ${what[part]}: the call to Brandwatch did not complete \\(Address unavailable: https://api\\.brandwatch\\.com/`), `${part} ${kind}`);
        else eq(said, `PROBLEM ${what[part]}: ${words[kind]}${part === 'metrics' ? '; the reads below ask for the plan\'s whole list' : ''}`);
        [r.report, r.logs].forEach(t => assert.ok(!t.includes(TOKEN) && !t.includes('@') && !/%40/.test(t), `${part} ${kind}: ${t}`));
        // the other parts went on: the AMIE table was still read, and the gate is the last line
        assert.ok(line(r, /^OK the AMIE table, last 24 hours/), `${part} ${kind}`);
        assert.match(r.lines[r.lines.length - 1], /gate for Brandwatch live: /);
        // the other Brandwatch calls were still made (the two mention reads need a query list or ids given)
        eq(Object.keys(what).filter(p => env.w.calls.some(c => c.part === p)), Object.keys(what), `${part} ${kind}`);
      });
    });
    // the query list refused and no ids given: no mention read, said so
    const env = world();
    env.w.fail.summary = answers[403];
    const r = run(env);
    eq(line(r, /^CHECK no mention was read/), 'CHECK no mention was read: the query list could not be read and no query ids were given');
    // the shared key itself can't be read: Brandwatch is not asked anything, BigQuery still is
    const env2 = world();
    env2.w.secret = { code: 403, message: `Permission denied for ${ADDRESS}` };
    const r2 = run(env2);
    eq(line(r2, /Secret Manager/), 'PROBLEM the bot could not read the shared Brandwatch key from Secret Manager (Secret Manager HTTP 403 reading the shared Brandwatch token: Permission denied for [address]), so Brandwatch was not asked anything');
    eq([env2.w.calls.filter(c => c.host === 'brandwatch').length, env2.w.calls.filter(c => c.host === 'bigquery').length], [0, 3]);
  });

  test('new sources live check: the AMIE table with a needed column missing, a column of another type, access denied, or a read over 1 GB (then no SELECT is sent)', () => {
    const drop = (env, name) => { env.w.table.schema.fields = env.w.table.schema.fields.filter(f => f.name !== name); };
    // snippet missing: said; the read (which does not count by snippet) still goes
    let env = world();
    drop(env, 'snippet');
    drop(env, 'engagement');
    let r = run(env);
    eq([line(r, /no column/), line(r, /optional columns/)], [
      'PROBLEM the AMIE table has no column "snippet", which the plan needs',
      'CHECK the AMIE table\'s optional columns: followers (INTEGER), KOF (STRING), product (STRING), engagement missing (read as empty)']);
    eq(env.w.calls.filter(c => c.host === 'bigquery').map(c => c.kind), ['tables.get', 'dryRun', 'select']);
    // postTime as STRING: said; the read counts by it, so nothing is sent after the metadata
    env = world();
    env.w.table.schema.fields.find(f => f.name === 'postTime').type = 'STRING';
    r = run(env);
    eq([line(r, /"postTime"/), line(r, /one-day read was not sent/)], [
      'PROBLEM the AMIE table\'s column "postTime" holds text (STRING), but the plan needs a time (TIMESTAMP)',
      'CHECK the AMIE table\'s one-day read was not sent: a column it counts by is missing or of another type (above)']);
    eq(env.w.calls.filter(c => c.host === 'bigquery').map(c => c.kind), ['tables.get']);
    // not partitioned on ingestionTimestamp, and stale
    env = world();
    env.w.table.timePartitioning = { type: 'DAY' };
    env.w.table.lastModifiedTime = String(NOW - 5 * 60 * MIN);
    r = run(env);
    eq([line(r, /partitioned/), line(r, /last changed/)], [
      'PROBLEM the AMIE table is partitioned on the time rows were loaded, not on ingestionTimestamp: a read by ingestionTimestamp would scan more than one day',
      'CHECK the AMIE table last changed 5 h ago (2026-10-14 07:00 UTC)']);
    // access denied, an address in BigQuery's words: both refusals said, no address, no SELECT
    env = world();
    env.w.tableFail = { code: 403, message: `Access Denied: Table brand-social-central-data:social_alerts_dataset.all_sundar_mentions: User does not have permission (${ADDRESS})` };
    env.w.dryFail = env.w.tableFail;
    r = run(env);
    eq(findings(r).filter(l => /AMIE/.test(l)), [
      'PROBLEM the AMIE table\'s metadata: BigQuery won\'t let the bot read the AMIE table (access denied: Access Denied: Table brand-social-central-data:social_alerts_dataset.all_sundar_mentions: User does not have permission ([address]))',
      'PROBLEM the dry run of the AMIE table\'s one-day read: BigQuery won\'t let the bot read the AMIE table (access denied: Access Denied: Table brand-social-central-data:social_alerts_dataset.all_sundar_mentions: User does not have permission ([address]))']);
    eq(env.w.calls.filter(c => c.host === 'bigquery').map(c => c.kind), ['tables.get', 'dryRun']);
    assert.ok(!r.report.includes('@') && !r.logs.includes('@'));
    // the dry run says 3.2 GB: no SELECT
    env = world();
    env.w.bytes = 3.2e9;
    r = run(env);
    eq(line(r, /would scan/), 'PROBLEM one day of the AMIE table would scan 3.20 GB (the limit is 1 GB), so the read was not sent');
    eq(env.w.calls.filter(c => c.host === 'bigquery').map(c => c.kind), ['tables.get', 'dryRun']);
    // the Brandwatch part is not stopped by any of it
    assert.ok(line(r, /^OK the read of the last 24 hours/));
  });

  test('new sources live check: every Brandwatch request is a GET with no body sent only to Brandwatch with the key, BigQuery gets only tables.get, the dry run and the bounded SELECT, and a run writes nothing (properties, cache, sheet, Chat)', () => {
    const env = world();
    const t = e2e(env.g);
    t.bot.setup();
    const props = JSON.stringify(Array.from(env.g.props.entries()));
    const cache = JSON.stringify(Array.from(env.g.cache.entries()));
    const tabs = () => JSON.stringify(t.sheet().getSheets().map(s => [s.getName(), s.rows]));
    const sheet = tabs();
    const posts = JSON.stringify(Array.from(env.g.chat.spaces.keys()).map(id => env.g.chat.botPosts(id).length));
    const before = env.g.fetches.length;
    env.w.calls.length = 0;
    const report = t.bot.verifyNewSourcesLive();
    assert.ok(report.split('\n').length > 20, report);
    // writes nothing
    eq([JSON.stringify(Array.from(env.g.props.entries())) === props, JSON.stringify(Array.from(env.g.cache.entries())) === cache, tabs() === sheet,
      JSON.stringify(Array.from(env.g.chat.spaces.keys()).map(id => env.g.chat.botPosts(id).length)) === posts], [true, true, true, true]);
    // no request but these three hosts (no Chat, mail, sheet or Drive call went through the base fake)
    eq(env.g.fetches.slice(before).map(f => f.url), []);
    eq(Array.from(new Set(env.w.calls.map(c => c.host))).sort(), ['bigquery', 'brandwatch', 'secret']);
    // Brandwatch: GET only, no body, the key only in its header
    const bwCalls = env.w.calls.filter(c => c.host === 'brandwatch');
    eq(bwCalls.map(c => c.part), ['summary', 'metrics', 'test', 'day']);
    eq(bwCalls.filter(c => c.method !== 'get' || c.payload !== null), []);
    eq(Array.from(new Set(bwCalls.map(c => c.headers.Authorization))), [`bearer ${TOKEN}`]);
    assert.ok(bwCalls.every(c => !c.url.includes(TOKEN)));
    eq(bwCalls.filter(c => c.params.getAll('pageType').some(p => /^(twitter|x|linkedin)/.test(p))), []);
    // the key goes to no other host
    assert.ok(env.w.calls.filter(c => c.host !== 'brandwatch').every(c => !JSON.stringify([c.url, c.headers, c.payload]).includes(TOKEN)));
    // BigQuery: the table's metadata (GET), one dry run, one SELECT with its bytes capped; nothing else
    const bq = env.w.calls.filter(c => c.host === 'bigquery');
    eq(bq.map(c => [c.kind, c.method]), [['tables.get', 'get'], ['dryRun', 'post'], ['select', 'post']]);
    const [, dry, sel] = bq;
    eq([dry.body.dryRun, dry.body.maximumBytesBilled, sel.body.dryRun, sel.body.maximumBytesBilled, sel.body.location, sel.body.useLegacySql],
      [true, undefined, undefined, '1000000000', 'US', false]);
    eq(dry.body.query, sel.body.query);
    assert.match(sel.body.query, /^WITH d AS \(SELECT SocialNetwork, postTime, ingestionTimestamp FROM `brand-social-central-data\.social_alerts_dataset\.all_sundar_mentions`\n  WHERE ingestionTimestamp > TIMESTAMP_MILLIS\(@from_ms\) AND ingestionTimestamp <= TIMESTAMP_MILLIS\(@until_ms\)\)/);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sel.body.query), 'a SELECT only');
    eq(sel.body.queryParameters.map(p => [p.name, p.parameterValue.value]), [['from_ms', String(env.g.clock.now - 24 * 60 * MIN)], ['until_ms', String(env.g.clock.now)]]);
    // the key is in no output: the report, the log, a property, the cache, the sheet
    [report, env.g.logs.join('\n'), JSON.stringify(Array.from(env.g.props.entries())), JSON.stringify(Array.from(env.g.cache.entries())), tabs()]
      .forEach(text => assert.ok(!text.includes(TOKEN)));
    // the user names Brandwatch keeps on a query are in no output either
    assert.ok(!report.includes(ADDRESS) && !env.g.logs.join('\n').includes(ADDRESS));
  });

  test('new sources live check: its helpers: the scrub of outside texts, the X test, the quantiles and the plain minutes', () => {
    const b = loadBot(makeGoogle(NOW).services);
    eq(b.nsvScrub_(`token ${TOKEN} for ${ADDRESS} and someone%40example.test\nnext`, TOKEN), 'token [token] for [address] and [address] next');
    eq([b.nsvIsX_({ contentSource: 'twitter' }), b.nsvIsX_({ pageType: 'X' }), b.nsvIsX_({ url: 'https://mobile.twitter.com/a/status/1' }),
      b.nsvIsX_({ originalUrl: 'x.com/a/status/1' }), b.nsvIsX_({ guid: '2116390716536770729' }),
      b.nsvIsX_({ contentSource: 'reddit', url: 'https://www.reddit.com/r/x/comments/1/' }), b.nsvIsX_({ url: 'https://box.com/a' })],
    [true, true, true, true, true, false, false]);
    eq([b.nsvQuantile_([], 0.5), b.nsvQuantile_([1, 2, 3, 4], 0.5), b.nsvQuantile_([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)], [null, 2, 9]);
    eq([0, 14, 60, 190, 2879, 2880, 4400].map(m => b.nsvMinutes_(m)), ['0 min', '14 min', '1 h', '3 h 10 min', '47 h 59 min', '2 days', '3 days 1 h']);
    // the place where steps 1c and 2b add the new jobs' dry runs sends nothing yet
    eq(b.nsvNewJobDryRuns_('TOKEN'), []);
  });

  test('new sources live check: an address or the key late in a long outside text or in a header is scrubbed before anything cuts it short', () => {
    const KEY_START = TOKEN.slice(0, 8);
    const clean = (t, why) => assert.ok(!t.includes('@') && !/%40/i.test(t) && !t.includes(KEY_START) && !t.includes('example.test'), `${why}: ${t}`);
    // a 403 whose message holds an address and the key around character 190 (pwHttpWhy_ cuts at 200), for every Brandwatch call
    ['summary', 'metrics', 'test', 'day'].forEach(part => {
      for (let n = 150; n <= 210; n += 3) {
        const env = world();
        env.w.fail[part] = { code: 403, body: { errors: [{ code: 403, message: `${'z'.repeat(n)} ${ADDRESS} ${TOKEN}` }] } };
        const r = run(env, part === 'summary' ? [111, 222] : undefined);
        [r.report, r.logs].forEach(t => clean(t, `${part} ${n}`));
        assert.ok(line(r, /HTTP 403: zzz/), `${part} ${n}: ${r.report}`);
      }
    });
    // the same in a body that is not JSON, and URL-encoded
    for (let n = 180; n <= 200; n += 2) {
      const env = world();
      env.w.fail.test = { code: 500, body: `${'z'.repeat(n)} analyst.one%40example.test ${TOKEN}` };
      const r = run(env);
      [r.report, r.logs].forEach(t => clean(t, `text ${n}`));
    }
    // the key and an address inside the call-count headers (the report cuts a value it can't read to 40 characters)
    for (let n = 10; n <= 40; n += 2) {
      const env = world();
      env.w.headers = { 'x-rate-limit-used': `${'y'.repeat(n)} ${TOKEN}`, 'x-rate-limit': `${'y'.repeat(n)} ${ADDRESS}` };
      const r = run(env);
      [r.report, r.logs].forEach(t => clean(t, `headers ${n}`));
      assert.match(line(r, /call-count headers/), /^CHECK call-count headers on the answer to the test read: x-rate-limit-used "y+/);
    }
    // Secret Manager's refusal (cut at 200 by the Watch's reader) with an address near the cut
    for (let n = 120; n <= 200; n += 4) {
      const env = world();
      env.w.secret = { code: 403, message: `${'s'.repeat(n)} ${ADDRESS}` };
      const r = run(env);
      [r.report, r.logs].forEach(t => clean(t, `secret ${n}`));
    }
    // BigQuery: a body that is not JSON (cut at 300) with an address near the cut
    for (let n = 270; n <= 300; n += 3) {
      const env = world();
      env.w.tableFail = { code: 500, text: `${'q'.repeat(n)} ${ADDRESS}` };
      const r = run(env);
      [r.report, r.logs].forEach(t => clean(t, `bigquery ${n}`));
    }
    // the scrub itself: an address another helper cut short is caught too; a handle with no name before the @ stays
    const b = loadBot(makeGoogle(NOW).services);
    eq([b.nsvScrub_('see analyst.one@exampl…)', ''), b.nsvScrub_('analyst.one@…', ''), b.nsvScrub_('{"message":"a.b%40exa"}', '', true),
      b.nsvScrub_('Pixel @madebygoogle', ''), b.nsvScrub_(`${'w'.repeat(320)} ${TOKEN}`, TOKEN).includes(KEY_START)],
    ['see [address])', '[address]', '{"message":"[address]"}', 'Pixel @madebygoogle', false]);
  });

  test('new sources live check: the gate says why nothing was measured, the content-source refusal says the plan\'s list is used only when a read is sent, and ids given that can\'t be used are said', () => {
    const gate = r => r.lines[r.lines.length - 1];
    const tail = '), so these sources are slower than 2 hours: unknown';
    const refuseAll = env => ['summary', 'metrics', 'test', 'day'].forEach(p => { env.w.fail[p] = { code: 401, body: { errors: [{ message: 'invalid token' }] } }; });
    // 401 on every Brandwatch call: no read is sent, and the gate and the content-source line say so
    let env = world();
    refuseAll(env);
    let r = run(env);
    eq(line(r, /^PROBLEM Brandwatch content sources/), 'PROBLEM Brandwatch content sources: Brandwatch refused the shared key (HTTP 401). The service that renews it may be down');
    eq(gate(r), 'CHECK gate for Brandwatch live: not measured (no query was chosen, so the read of the last 24 hours was not sent' + tail);
    eq(env.w.calls.filter(c => c.part === 'test' || c.part === 'day').length, 0);
    // the same with ids given: the reads are sent, so the content-source line says they ask for the plan's whole list
    env = world();
    refuseAll(env);
    r = run(env, [111, 222]);
    eq(line(r, /^PROBLEM Brandwatch content sources/), 'PROBLEM Brandwatch content sources: Brandwatch refused the shared key (HTTP 401). The service that renews it may be down; the reads below ask for the plan\'s whole list');
    eq(gate(r), 'CHECK gate for Brandwatch live: not measured (the read of the last 24 hours was refused or failed (said above)' + tail);
    // the key can't be read
    env = world();
    env.w.secret = { code: 403, message: 'Permission denied' };
    eq(gate(run(env)), 'CHECK gate for Brandwatch live: not measured (the shared Brandwatch key could not be read, so Brandwatch was not asked' + tail);
    // the day read thrown
    env = world();
    env.w.fail.day = 'throw';
    eq(gate(run(env)), 'CHECK gate for Brandwatch live: not measured (the read of the last 24 hours was refused or failed (said above)' + tail);
    // no mention added in the last 24 hours
    env = world();
    env.w.mentions = [];
    eq(gate(run(env)), 'CHECK gate for Brandwatch live: not measured (the read of the last 24 hours found no mention added in that time' + tail);
    // none of the account's content sources is on the plan's list
    env = world();
    env.w.sources = ['twitter', 'news', 'linkedin'];
    eq(gate(run(env)), 'CHECK gate for Brandwatch live: not measured (no content source was left to ask for, so the read of the last 24 hours was not sent' + tail);
    // ids given that are not query ids: said, and the suggested queries are used
    env = world();
    r = run(env, ['abc']);
    eq(line(r, /query ids? given/), 'CHECK none of the query id given is a Brandwatch query id (a whole number), so the queries that look like Google\'s were used instead');
    assert.match(line(r, /^OK the two Brandwatch reads use/), /"Google Pixel test" \(111\), "Gemini app test" \(222\)/);
    env = world();
    r = run(env, ['abc', 1.5]);
    eq(line(r, /query ids? given/), 'CHECK none of the 2 query ids given is a Brandwatch query id (a whole number), so the queries that look like Google\'s were used instead');
    // the query list refused too: nothing to fall back on
    env = world();
    env.w.fail.summary = { code: 500, body: 'Internal error' };
    r = run(env, ['abc']);
    eq([line(r, /query ids? given/), line(r, /^CHECK no mention was read/)], [
      'CHECK none of the query id given is a Brandwatch query id (a whole number), so none was used',
      'CHECK no mention was read: the query list could not be read and no usable query id was given']);
    // some usable, some not, some over the limit
    env = world();
    r = run(env, [111, 'abc', 222]);
    eq(line(r, /query ids given/), 'CHECK of the 3 query ids given, 1 is not a whole number; it was left out');
    eq(env.w.calls.find(c => c.part === 'test').params.getAll('queryId'), ['111', '222']);
    env = world();
    r = run(env, Array.from({ length: 23 }, (_, i) => 1000 + i).concat(['x']));
    eq(line(r, /query ids given/), 'CHECK of the 24 query ids given, 1 is not a whole number and 3 are over the 20 a read may carry; they were left out');
    eq(env.w.calls.find(c => c.part === 'test').params.getAll('queryId').length, 20);
    // one id given as a number, not in a list: used
    env = world();
    r = run(env, 444);
    eq(line(r, /query ids? given/), '');
    eq(env.w.calls.find(c => c.part === 'test').params.getAll('queryId'), ['444']);
    // ids that all work: no such line
    env = world();
    eq(line(run(env, [111, 222]), /query ids? given/), '');
  });

  test('new sources live check: the read of the last 24 hours says what it left out (added before the 24 hours, no added time) and when it did not come newest first', () => {
    // "added since" ignored: two mentions added over 24 hours ago and one with no added time come back and are said, not counted
    let env = world();
    env.w.ignore.sinceAdded = true;
    env.w.mentions.push(mention(30, { addedAgo: 30 * 60, delay: 10 }), mention(31, { addedAgo: 31 * 60, delay: 10 }));
    env.w.mentions.push(mention(32, { addedAgo: 20, m: { added: '' } }));
    let r = run(env);
    eq([line(r, /ignored "added since" in the read of the last 24 hours/), line(r, /no readable added time/)], [
      'PROBLEM Brandwatch ignored "added since" in the read of the last 24 hours: 2 mentions were added before it (left out of the figures below)',
      'CHECK 1 mention of the read of the last 24 hours had no readable added time (left out of the figures below)']);
    // the per-source figures are the healthy ones: what was left out is not in them
    eq(line(r, /^(OK|CHECK) reddit:/), 'OK reddit: 7 mentions, 7 with words; from posting to added: median 10 min, 90% within 10 min');
    // healthy answers: none of these lines
    env = world();
    r = run(env);
    eq([line(r, /in the read of the last 24 hours: \d/), line(r, /no readable added time/), line(r, /did not come newest added first/)], ['', '', '']);
    // the order of the day read ignored (oldest first)
    env = world();
    env.w.order = 'asc';
    r = run(env);
    eq(line(r, /did not come newest added first/), 'CHECK the read of the last 24 hours did not come newest added first (the order asked for was ignored), so a full page may not be the newest mentions');
  });

  test('new sources live check: BigQuery refusing, throwing or answering late at each step is said in plain words, and BigQuery is only ever asked for the table\'s metadata, dry runs, the one bounded SELECT and that job\'s results', () => {
    const allowed = c => (c.kind === 'tables.get' && c.method === 'get' && c.payload === null)
      || (c.kind === 'dryRun' && c.method === 'post' && c.body.dryRun === true)
      || (c.kind === 'select' && c.method === 'post' && c.body.maximumBytesBilled === '1000000000' && !c.body.dryRun)
      || (c.kind === 'results' && c.method === 'get' && c.payload === null);
    const go = setUp => {
      const env = world();
      setUp(env.w);
      const r = run(env);
      const bq = env.w.calls.filter(c => c.host === 'bigquery');
      bq.forEach(c => assert.ok(allowed(c), `not allowed: ${c.kind} ${c.method} ${c.url}`));
      [r.report, r.logs].forEach(t => assert.ok(!t.includes('@') && !t.includes(TOKEN), t));
      // the Brandwatch part and the gate are not stopped by it
      assert.ok(line(r, /^OK the read of the last 24 hours/), r.report);
      assert.match(r.lines[r.lines.length - 1], /gate for Brandwatch live: /);
      return { r, kinds: bq.map(c => c.kind) };
    };
    // the AMIE lines that say something went wrong (the healthy fixture's slow-delay CHECK left aside)
    const amie = r => findings(r).filter(l => /AMIE/.test(l) && /^(PROBLEM|CHECK)/.test(l) && !/^CHECK from posting to the AMIE table/.test(l));
    // the SELECT refused (bytes billed over the cap) or thrown
    let o = go(w => { w.selectFail = { code: 400, message: 'Query exceeded limit for bytes billed: 1000000000. 2000000000 or higher required.' }; });
    eq(amie(o.r), ['PROBLEM the AMIE table\'s one-day read: BigQuery refused (HTTP 400: Query exceeded limit for bytes billed: 1000000000. 2000000000 or higher required.)']);
    eq(o.kinds, ['tables.get', 'dryRun', 'select']);
    o = go(w => { w.selectFail = 'throw'; });
    eq(amie(o.r), ['PROBLEM the AMIE table\'s one-day read: the call to BigQuery did not complete (BigQuery unreachable for [address])']);
    // the metadata read failed (500 with a body that is not JSON, or thrown): said; the dry run and the bounded SELECT still go
    o = go(w => { w.tableFail = { code: 500, text: '<html>Backend Error</html>' }; });
    eq(amie(o.r), ['PROBLEM the AMIE table\'s metadata: BigQuery refused (HTTP 500: <html>Backend Error</html>)']);
    eq(o.kinds, ['tables.get', 'dryRun', 'select']);
    assert.ok(line(o.r, /^OK the AMIE table, last 24 hours: 24,000 rows/));
    o = go(w => { w.tableFail = 'throw'; });
    eq(amie(o.r), ['PROBLEM the AMIE table\'s metadata: the call to BigQuery did not complete (BigQuery unreachable for [address])']);
    eq(o.kinds, ['tables.get', 'dryRun', 'select']);
    // the dry run refused (500) or thrown: no SELECT
    o = go(w => { w.dryFail = { code: 500, message: 'Backend error' }; });
    eq(amie(o.r), ['PROBLEM the dry run of the AMIE table\'s one-day read: BigQuery refused (HTTP 500: Backend error)']);
    eq(o.kinds, ['tables.get', 'dryRun']);
    o = go(w => { w.dryFail = 'throw'; });
    eq(amie(o.r), ['PROBLEM the dry run of the AMIE table\'s one-day read: the call to BigQuery did not complete (BigQuery unreachable for [address])']);
    eq(o.kinds, ['tables.get', 'dryRun']);
    // the dry run says nothing about bytes: no SELECT
    o = go(w => { w.bytes = undefined; });
    eq(o.kinds, ['tables.get', 'dryRun']);
    // the SELECT not complete at first: its own job is asked again, at most twice, with a GET
    o = go(w => { w.incomplete = 2; });
    eq(o.kinds, ['tables.get', 'dryRun', 'select', 'results', 'results']);
    eq(amie(o.r), []);
    assert.ok(line(o.r, /^OK the AMIE table, last 24 hours: 24,000 rows/));
    o = go(w => { w.incomplete = 3; });
    eq(o.kinds, ['tables.get', 'dryRun', 'select', 'results', 'results']);
    eq(amie(o.r), ['CHECK the AMIE table\'s one-day read did not finish in time; run the check again']);
    o = go(w => { w.incomplete = 1; w.resultsFail = { code: 404, message: 'Not found: Job nsv_1' }; });
    eq(o.kinds, ['tables.get', 'dryRun', 'select', 'results']);
    eq(amie(o.r), ['PROBLEM the AMIE table\'s one-day read: the AMIE table was not found (HTTP 404: Not found: Job nsv_1)']);
    // a counted column missing: only the metadata is read
    o = go(w => { w.table.schema.fields = w.table.schema.fields.filter(f => f.name !== 'ingestionTimestamp'); });
    eq(o.kinds, ['tables.get']);
    eq(amie(o.r).slice(0, 1), ['PROBLEM the AMIE table has no column "ingestionTimestamp", which the plan needs']);
    // the type words
    const b = loadBot(makeGoogle(NOW).services);
    eq(['STRING', 'TIMESTAMP', 'INTEGER', 'REPEATED STRING', 'GEOGRAPHY', ''].map(t => b.nsvTypeWords_(t)),
      ['text (STRING)', 'a time (TIMESTAMP)', 'a whole number (INTEGER)', 'a list of text (REPEATED STRING)', 'something else (GEOGRAPHY)', 'something else (no type)']);
  });
};
