// Auto-find missing links (Control row 14, autoFindLinks): an alert without its link or author gets them from the
// listening feeds (BigQuery.gs bqFindMissingLink_, as ctx.findLink in Bot.gs handleAlert_) before Burson is asked. The
// tests below that run with "Never wait on Burson" ON (Control row 23: switchesNoWait, world/e2e noWait) check that,
// found or not, nothing waits on Burson: a link still missing is processed without, and Burson is told it was missing.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, NOW, world, e2e, collectBurson, TEST_FEED, TRIAGED } = H;

  const SAM = 'https://x.com/WasSamLowryEsq/status/2109952063492993159';
  const ISSUE = 'Alleged Bias in Search Reporting for Paris Riots 2026';
  const TOLD_LINK = 'The alert has been updated, so there is no need to resend it. The following updates were made:\n- Link was missing. Please include it in future alerts.';
  // NO_LINK without the author too (the summary and the [Code] line named them)
  const NO_LINK_NO_AUTHOR = F.NO_LINK.replace('X user @WasSamLowryEsq (652 followers)', 'An X user').replace(',1,WasSamLowryEsq,-,', ',1,,-,');
  // An Instagram alert with its link but no author (the link doesn't name them)
  const INSTA = 'https://www.instagram.com/p/DPq1aBcDeFg/';
  const INSTA_NO_AUTHOR = F.P0_OK.split(SAM).join(INSTA).replace('| X |', '| Instagram |').replace('[Social Network]: X', '[Social Network]: Instagram')
    .replace('X user @WasSamLowryEsq (652 followers)', 'An Instagram user').replace(',1,WasSamLowryEsq,-,', ',1,,-,');
  const EDER = 'https://x.com/edervolcelazz/status/2109566527900926417';
  const PARTLY_NO_LINK = F.MISTAKES_PARTLY_FIXED.replace(`[Link]: ${EDER}\n`, '');
  const FIXED_NO_LINK = F.MISTAKES_FIXED.replace(`[Link]: ${EDER}\n`, '');
  const FOUND = { post_url: SAM, author: '', confidence: 0.97, how: 'author and issue name' };

  /** One run of the bot with the world's ctx plus `extra` (switches, findLink, …). */
  const runWith = (w, extra) => {
    w.g.clock.now += 1000;
    const report = w.bot.runOnce_(Object.assign(w.ctx(), extra || {}));
    collectBurson(w.chat, [w.BUR]);
    return report;
  };
  const switches = (w, on) => Object.assign(w.bot.switchesOff_(), on ? { autoFindLinks: true } : {});
  // ...with "Never wait on Burson" ON too (Control row 23): the tests of the no-wait flow (processed without the link,
  // Burson told) run with it; with it OFF Burson is asked for the link as before (switch_nowait.test.js)
  const switchesNoWait = (w, on) => Object.assign(switches(w, on), { noWait: true });
  const spy = result => { const f = p => { f.calls.push(JSON.parse(JSON.stringify(p.fields))); if (result instanceof Error) throw result; return result; }; f.calls = []; return f; };
  /** Everything the bot did that anyone could see or that it kept: posts, reactions, rows, what Gemini was sent, the report. */
  const outcome = (w, alert, report) => ({
    burson: w.bursonPosts().map(m => [m.text, !!m.threadReply]), analyst: w.analystPosts().map(m => [m.text, !!m.threadReply]),
    reactions: w.chat.botReactions(alert.name), rows: H.plain(w.alertRows()), gemini: w.vertex.calls.map(c => c.payload), report,
  });

  // A fake BigQuery: records each query and answers it with answer(call) -> {rows, cols} | {code, body} | {timeout: true}
  const LINK_COLS = [['src'], ['url'], ['author'], ['network'], ['issue_name'], ['summary'], ['interactions', 'INTEGER'], ['posted_at'],
    ['in_feeds', 'BOOLEAN'], ['kw_hits', 'INTEGER']];
  const AUTHOR_COLS = [['url'], ['author'], ['network']];
  function fakeBq(g, answer) {
    const calls = [];
    const orig = g.services.UrlFetchApp.fetch;
    const resp = (code, body) => ({ getResponseCode: () => code, getHeaders: () => ({}), getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (!url.startsWith('https://bigquery.googleapis.com/')) return orig(url, params);
      const body = JSON.parse(params.payload);
      const call = { url, method: params.method, location: body.location || 'US', sql: body.query,
        params: Object.fromEntries((body.queryParameters || []).map(p => [p.name, p.parameterValue.value])),
        types: Object.fromEntries((body.queryParameters || []).map(p => [p.name, p.parameterType.type])) };
      calls.push(call);
      const a = answer(call) || { rows: [] };
      if (a.code) return resp(a.code, a.body || 'Internal error');
      const cols = a.cols || LINK_COLS;
      if (a.timeout) return resp(200, { jobComplete: false });
      return resp(200, { jobComplete: true, schema: { fields: cols.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: (a.rows || []).map(r => ({ f: cols.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })) });
    };
    return calls;
  }
  const isLinkQuery = c => /"sonar" AS src/.test(c.sql);
  const isSlrrLinkQuery = c => /"slrr" AS src/.test(c.sql);
  const isAuthorQuery = c => /SELECT post_url AS url, TRIM\(IFNULL\(JSON_VALUE\(payload, "\$\.detail\.channel\.username"\), ""\)\) AS author/.test(c.sql);
  const feedRow = o => Object.assign({ src: 'sonar', url: SAM, author: 'WasSamLowryEsq', network: 'Twitter', issue_name: ISSUE,
    summary: 'An X user says Search results about the Paris riots are biased.', interactions: 3, posted_at: '2026-10-13 07:19:00+00',
    in_feeds: true, kw_hits: 4 }, o);
  const realFind = w => p => w.bot.bqFindMissingLink_(p);

  // ===========================================================================================================
  // OFF: nothing changes
  // ===========================================================================================================

  test('auto-find links OFF: a link-less alert is processed and Burson told exactly as before (same posts, emojis, rows and Gemini request with the switches absent, all OFF, or this one OFF); no lookup', () => {
    const results = [undefined, 'all off', 'this off'].map(mode => {
      const w = world({ noWait: true });
      const finder = spy(FOUND);
      const alert = w.paste(F.NO_LINK);
      const extra = mode === undefined ? {} : { switches: mode === 'all off' ? Object.assign(w.bot.switchesOff_(), { noWait: true }) : { autoFindLinks: false, noWait: true }, findLink: finder };
      const report = runWith(w, extra);
      eq(finder.calls, []);
      eq([w.g.props.get('LINK_FINDS_TODAY'), w.g.props.get('SWITCH_NOTES')], [null, null]);
      assert.ok(!w.g.logs.some(l => /auto-find/.test(l)));
      return outcome(w, alert, report);
    });
    eq(results[1], results[0]);
    eq(results[2], results[0]);
    eq(results[0].burson, [[TOLD_LINK, true]]);
    assert.match(results[0].analyst[0][0], /QA: Link missing \(processed without waiting for Burson; Burson was told\)$/);
    eq([results[0].rows[0].status, results[0].rows[0].record_key, results[0].rows[0].requested], ['fix_requested', '', [{ field: 'post_url', problem: 'missing' }]]);
    eq(Object.keys(results[0].report).filter(k => /link/.test(k)), []);
    // The review and the forwarded copy are the same with no parsed.found (the switch never set it)
    const p = B.parseAlert_(F.NO_LINK);
    eq(B.reviewAlert_(p, { now: NOW, history: [] }), B.reviewAlert_(B.parseAlert_(F.NO_LINK), { now: NOW, history: [] }));
    assert.strictEqual(B.withFoundLink_(F.NO_LINK, undefined), F.NO_LINK);
  });

  test('auto-find links OFF in the every-minute run: no lookup reaches BigQuery, Burson is told the link was missing, column C says OFF', () => {
    const t = e2e(null, { noWait: true });
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    // every query gets the feed row, but the list of issues alerted lately (IssueNames.gs): none
    const calls = fakeBq(t.g, c => (/ AS alert_count/.test(c.sql) ? { rows: [] } : { rows: [feedRow()] }));
    t.chat.say(TEST_FEED, F.NO_LINK, { sender: 'users/bot' });
    t.poll();
    eq(calls.filter(c => isLinkQuery(c) || isAuthorQuery(c)), []);
    assert.ok(calls.every(c => !/google_bg\.slrr` l/.test(c.sql)));
    assert.ok(t.chat.botPosts(TEST_FEED).some(m => m.text === TOLD_LINK));
    assert.match(t.control().cell(14, 3), /^OFF \((?:a missing link or author: processed without it, and Burson is told|asks Burson when the link or the author is missing)\)$/);
    assert.ok(!t.g.props.has('LINK_FINDS_TODAY'));
  });

  // ===========================================================================================================
  // ON: found
  // ===========================================================================================================

  test('auto-find links ON: the link found -> no fix request (👍), analysts get the alert with its [Link] line and how it was found; the record key, post lookup, enrichment and Gemini all use it', () => {
    const posts = [];
    const enriched = [];
    const w = world({ post: url => { posts.push(url); return null; }, bq: p => { enriched.push(p.fields.post_url); return null; } });
    const finder = spy(FOUND);
    const alert = w.paste(F.NO_LINK);
    const report = runWith(w, { switches: switches(w, true), findLink: finder });
    eq(finder.calls.length, 1);
    eq([finder.calls[0].post_url, finder.calls[0].author, finder.calls[0].issue_name], [undefined, '@WasSamLowryEsq', ISSUE]);
    eq([posts, enriched], [[SAM], [SAM]]);
    eq(w.bursonPosts(), []);
    eq(w.chat.botReactions(alert.name), ['👍']);
    const [fwd] = w.analystPosts();
    assert.strictEqual(fwd.text, `${F.P0_OK}\n\nQA corrected:\n- Link updated to ${SAM} (was (blank))\n` +
      `QA: Burson's alert had no link; found the post in the listening feeds by its author and issue name (97% sure): ${SAM}. Check it's the right post`);
    const [row] = w.alertRows();
    eq([row.status, row.record_key, row.requested, row.forwarded_fields.post_url, row.author], ['ok', 'x.com/status/2109952063492993159', [], SAM, '@WasSamLowryEsq']);
    assert.ok(w.vertex.calls[0].payload.contents[0].parts[0].text.includes(SAM));  // Gemini reviews the post at its link
    eq([report.link_lookups, report.links_found, report.errors], [1, 1, []]);
    assert.ok(w.g.logs.includes(`auto-find missing links: found ${SAM} (author and issue name, 97% sure)`));
    const note = JSON.parse(w.g.props.get('SWITCH_NOTES')).autoFindLinks.text;
    assert.match(note, /^found 1 of 1 today · last look Oct 14, \d{1,2}:\d\d (AM|PM) EDT$/);
    // Nothing about it reaches Burson
    assert.ok(!w.bursonPosts().some(m => /listening feed|bigquery|pendulum|found/i.test(m.text)));
  });

  test('auto-find links ON: link and author both missing -> both found, neither asked of Burson; analysts see both corrections', () => {
    const w = world({ noWait: true });
    const finder = spy({ post_url: SAM, author: '@WasSamLowryEsq', confidence: 0.92, how: 'issue name' });
    const off = world({ noWait: true });
    off.paste(NO_LINK_NO_AUTHOR);
    off.run();
    eq(off.bursonPosts().map(m => m.text), ['The alert has been updated, so there is no need to resend it. The following updates were made:\n- Author was missing. Please include it in future alerts.\n- Link was missing. Please include it in future alerts.']);
    const alert = w.paste(NO_LINK_NO_AUTHOR);
    runWith(w, { switches: switchesNoWait(w, true), findLink: finder });
    eq([w.bursonPosts(), w.chat.botReactions(alert.name)], [[], ['👍']]);
    const [fwd] = w.analystPosts();
    assert.ok(fwd.text.includes(`\n\n[Link]: ${SAM}\n\nAs a reminder`));
    assert.ok(fwd.text.includes(`QA corrected:\n- Link updated to ${SAM} (was (blank))\n- Author updated to @WasSamLowryEsq (was (blank))`));
    assert.ok(fwd.text.endsWith(`by its issue name (92% sure): ${SAM} (author @WasSamLowryEsq). Check it's the right post`));
    eq([w.alertRows()[0].author, w.alertRows()[0].requested], ['@WasSamLowryEsq', []]);
  });

  test('auto-find links ON: a link but no author -> the author from the post\'s own entry in the feeds (one us-central1 query); not asked of Burson', () => {
    const off = world({ noWait: true });
    off.paste(INSTA_NO_AUTHOR);
    off.run();
    eq(off.bursonPosts().map(m => m.text), ['The alert has been updated, so there is no need to resend it. The following updates were made:\n- Author was missing. Please include it in future alerts.']);
    const w = world({ noWait: true });
    const calls = fakeBq(w.g, c => (isAuthorQuery(c) ? { cols: AUTHOR_COLS, rows: [{ url: INSTA, author: 'paris.watch', network: 'Instagram' }] } : null));
    const alert = w.paste(INSTA_NO_AUTHOR);
    runWith(w, { switches: switchesNoWait(w, true), findLink: realFind(w) });
    eq(calls.map(c => [isAuthorQuery(c), c.location, c.params.url, c.params.post_id, c.types.post_id]), [[true, 'us-central1', INSTA, 'DPq1aBcDeFg', 'STRING']]);
    eq([w.bursonPosts(), w.chat.botReactions(alert.name)], [[], ['👍']]);
    const [fwd] = w.analystPosts();
    assert.ok(fwd.text.includes('QA corrected:\n- Author updated to @paris.watch (was (blank))'));
    assert.ok(fwd.text.endsWith('QA: Burson\'s alert had no author; the listening feeds\' entry for the post gives @paris.watch'));
    eq(w.alertRows()[0].author, '@paris.watch');
    // Another post's entry, or one on another network, is never used
    eq(B.authorForPost_(B.parseAlert_(INSTA_NO_AUTHOR).fields, [{ url: 'https://www.instagram.com/p/OTHERpost1/', author: 'x' }]), null);
    eq(B.authorForPost_(B.parseAlert_(INSTA_NO_AUTHOR).fields, [{ url: 'https://www.instagram.com/p/DPq1aBcDeFg/?igsh=abc', author: 'paris.watch' }]).author, '@paris.watch');
  });

  test('auto-find links ON, the real lookup: read-only us-central1 query over sonar_raw plus US query over slrr_alerts (no cross-region mix, no write), and a clear match is used', () => {
    const w = world();
    const calls = fakeBq(w.g, c => (isLinkQuery(c) ? { rows: [feedRow(), feedRow({ url: 'https://x.com/someoneElse/status/2109952063492990001', author: 'someoneElse' })] } : null));
    const alert = w.paste(F.NO_LINK);
    const report = runWith(w, { switches: switches(w, true), findLink: realFind(w) });
    eq(calls.length, 2);
    const [q, qSlrr] = calls;
    eq([q.method, q.location, q.url], ['post', 'us-central1', 'https://bigquery.googleapis.com/bigquery/v2/projects/brand-social-central-data/queries']);
    assert.ok(q.sql.includes('`bsip-s-bsip-gg-26-2cf3.google_bg.sonar_raw`'));
    assert.ok(!/brand-social-central-data\./.test(q.sql), 'a US table in a us-central1 query');
    eq([qSlrr.method, qSlrr.location], ['post', 'US']);
    assert.ok(qSlrr.sql.includes('`brand-social-central-data.slrr_alerts.slrr_alerts`'));
    assert.ok(!/bsip-s-bsip-gg-26-2cf3\./.test(qSlrr.sql), 'a us-central1 table in a US query');
    assert.ok(calls.every(c => !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(c.sql) && !/insertAll/.test(c.url)));
    assert.match(q.sql, /INTERVAL @hours HOUR/);
    eq(q.params, { issue: ISSUE.toLowerCase(), author: 'wassamlowryesq', kws: 'reporting,search,paris,bias', hours: '48' });
    eq(q.types.hours, 'INT64');
    eq([w.bursonPosts(), w.chat.botReactions(alert.name), report.links_found], [[], ['👍'], 1]);
    assert.ok(w.analystPosts()[0].text.startsWith(F.P0_OK));
    // The same alert again (a retry, or the other flow): the find is kept, no second query
    eq(w.bot.bqFindMissingLink_(B.parseAlert_(F.NO_LINK)), { post_url: SAM, author: '', confidence: 0.97, how: 'author and issue name' });
    eq(calls.length, 2);
    // A kept answer is only ever for the same alert: another alert whose short key is the same is looked up itself
    const [key] = Array.from(w.g.cache.keys()).filter(k => k.startsWith('bq_link:'));
    const other = B.parseAlert_(NO_LINK_NO_AUTHOR.split('Paris Riots').join('Lyon Floods'));
    const otherKey = 'bq_link:' + w.bot.hashText_(JSON.stringify(['link', 'X', '', 'alleged bias in search reporting for lyon floods 2026',
      w.bot.linkKeywords_(other.fields), other.fields.post_date, 1]));
    w.g.cache.set(otherKey, w.g.cache.get(key));  // as if the two keys were the same: the kept answer names the other alert
    eq(w.bot.bqFindMissingLink_(other), null);
    eq(calls.length, 4);
    assert.match(JSON.parse(w.g.cache.get(otherKey)).ident, /lyon floods/);  // the same key: now the other alert's own answer
    // A malformed find changes nothing in the review
    const plainReview = B.reviewAlert_(B.parseAlert_(F.NO_LINK), { now: NOW, history: [] });
    eq(B.reviewAlert_(Object.assign(B.parseAlert_(F.NO_LINK), { found: {} }), { now: NOW, history: [] }), plainReview);
  });

  test('auto-find links ON: the auto-correct test space posts the corrected alert with the link, says so in its note, and no longer waits on Burson for it', () => {
    const off = world({ noWait: true });
    off.paste(F.NO_LINK);
    runWith(off, { sourceReadOnly: true, changeNotes: true });
    eq(off.analystPosts().map(m => m.text), [F.NO_LINK, 'Processed without waiting for Burson: Link missing']);
    const w = world({ noWait: true });
    w.paste(F.NO_LINK);
    runWith(w, { sourceReadOnly: true, changeNotes: true, switches: switchesNoWait(w, true), findLink: spy(FOUND) });
    eq(w.analystPosts().map(m => m.text), [F.P0_OK, `Updates made to this alert:\n- Link updated from (blank) to ${SAM}`]);
    eq(w.bursonPosts(), []);
  });

  test('auto-find links ON: Burson\'s resend of an alert whose link the bot found (still without it) is matched to it, as a resend', () => {
    const w = world({ noWait: true });
    const finder = spy({ post_url: EDER, author: '', confidence: 0.97, how: 'author and issue name' });
    const original = w.paste(PARTLY_NO_LINK);
    runWith(w, { switches: switchesNoWait(w, true), findLink: finder });
    eq(w.bursonPosts().map(m => m.text), ['The alert has been updated, so there is no need to resend it. The following updates were made:\n- Engagement updated to HIGH.']);
    w.paste(FIXED_NO_LINK);
    const report = runWith(w, { switches: switchesNoWait(w, true), findLink: finder });
    eq([report.resends, finder.calls.length], [1, 2]);
    eq(w.chat.botReactions(original.name), ['👍', '⬇']);
    eq(w.analystPosts().filter(m => !m.threadReply).length, 1);  // nothing forwarded twice
    eq(w.alertRows().map(r => [r.status, r.record_key]), [['superseded', 'x.com/status/2109566527900926417'], ['fixed', 'x.com/status/2109566527900926417']]);
  });

  // ===========================================================================================================
  // ON: not sure, or failing -> processed without it (Burson told), as with the switch OFF
  // ===========================================================================================================

  test('auto-find links ON: two close posts, another network, another author, a day apart or BigQuery failing -> processed without it exactly as with the switch OFF, and the run goes on', () => {
    const base = (() => { const w = world({ noWait: true }); const a = w.paste(F.NO_LINK); const r = runWith(w); return { w, a, r }; })();
    const baseOut = outcome(base.w, base.a, base.r);
    const cases = {
      'two posts': { rows: [feedRow(), feedRow({ url: 'https://x.com/WasSamLowryEsq/status/2109952063492990002' })] },  // both theirs
      'other network': { rows: [feedRow({ url: 'https://bsky.app/profile/wassamlowryesq.bsky.social/post/3m2abcdefgh', network: 'Bluesky' })] },
      'other author': { rows: [feedRow({ url: 'https://x.com/someoneElse/status/2109952063492990003', author: 'someoneElse' })] },
      'a day apart': { rows: [feedRow({ posted_at: '2026-10-11 07:19:00+00' })] },
      'BigQuery error': { code: 500, body: '{"error":{"message":"Backend error"}}' },
      'too slow': { timeout: true },
    };
    Object.entries(cases).forEach(([name, answer]) => {
      const w = world({ noWait: true });
      const calls = fakeBq(w.g, c => (isLinkQuery(c) ? answer : null));
      const alert = w.paste(F.NO_LINK);
      const report = runWith(w, { switches: switchesNoWait(w, true), findLink: realFind(w) });
      const failed = /error|slow/.test(name);
      eq(calls.length, failed ? 1 : 2, name);
      const out = outcome(w, alert, report);
      eq([report.link_lookups, report.links_found, report.errors], [1, undefined, []], name);
      delete out.report.link_lookups;
      eq(out, baseOut, name);
      assert.ok(w.g.logs.includes('auto-find missing links: no sure match for the missing link; the alert is processed without it'), name);
      assert.match(JSON.parse(w.g.props.get('SWITCH_NOTES')).autoFindLinks.text, /^found 0 of 1 today · /, name);
      // "Nothing sure" is kept a while; a BigQuery failure isn't (the next try asks again)
      w.bot.bqFindMissingLink_(B.parseAlert_(F.NO_LINK));
      eq(calls.length, 2, name);
    });
  });

  test('auto-find links ON: a lookup that throws, no time left, or the per-run cap reached -> no find, processed without it, the run goes on', () => {
    const w = world({ noWait: true });
    const alert = w.paste(F.NO_LINK);
    const report = runWith(w, { switches: switchesNoWait(w, true), findLink: spy(new Error('boom')) });
    eq([w.bursonPosts().map(m => m.text), report.errors, report.links_found], [[TOLD_LINK], [], undefined]);
    assert.ok(w.g.logs.includes('auto-find missing links failed: boom'));
    eq(w.chat.botReactions(alert.name), ['👍']);

    const v = world({ noWait: true });
    v.paste(F.NO_LINK);
    const finder = spy(FOUND);
    const r2 = runWith(v, { switches: switchesNoWait(v, true), findLink: finder, deadline: v.g.clock.now + 20 * 1000 });
    eq([finder.calls.length, v.bursonPosts().map(m => m.text), r2.link_lookups], [0, [TOLD_LINK], undefined]);
    assert.ok(v.g.logs.includes('auto-find missing links: no time left this run, so the missing link isn\'t looked up; the alert is processed without it'));

    // At most BQ_LINK_MAX_PER_RUN_ lookups in a run
    const max = B.ev('BQ_LINK_MAX_PER_RUN_');
    eq(max, 10);
    const u = world({ noWait: true });
    const ctx = Object.assign(u.ctx(), { switches: switchesNoWait(u, true), findLink: spy(FOUND) });
    const rep = { link_lookups: max };
    const parsed = B.parseAlert_(F.NO_LINK);
    u.bot.findMissingLink_(ctx, parsed, rep);
    eq([ctx.findLink.calls.length, parsed.found, parsed.fields.post_url], [0, undefined, undefined]);
    assert.ok(u.g.logs.includes('auto-find missing links: already 10 lookups this run, so the missing link isn\'t looked up; the alert is processed without it'));
    rep.link_lookups = max - 1;
    u.bot.findMissingLink_(ctx, parsed, rep);
    eq([ctx.findLink.calls.length, parsed.fields.post_url, rep.link_lookups], [1, SAM, max]);
    // A find that isn't a link (or an empty author) is ignored
    const odd = B.parseAlert_(NO_LINK_NO_AUTHOR);
    u.bot.findMissingLink_(Object.assign(u.ctx(), { findLink: () => ({ post_url: 'not a link', author: '  ', confidence: 1 }) }), odd, {});
    eq([odd.found, odd.fields.post_url, odd.fields.author], [undefined, undefined, undefined]);
  });

  // ===========================================================================================================
  // The match rules (pure)
  // ===========================================================================================================

  test('auto-find links: the match rules: never another network or author, a day apart, or a far different count; one sure post with no close second', () => {
    const f = B.parseAlert_(F.NO_LINK).fields;
    const noAuthor = B.parseAlert_(NO_LINK_NO_AUTHOR).fields;
    const score = (c, fields) => B.linkMatch_(fields || f, feedRow(c)).score;
    eq(score({}), 0.97);
    eq(score({ author: '' }), 0.97);                                                                // an X link names its author
    eq(score({ issue_name: 'Search results on Paris riots called biased', kw_hits: 3 }), 0.95);  // same author, about the same
    eq(score({ issue_name: 'Pixel battery drain', summary: '', kw_hits: 0 }), 0.5);                // same author, something else
    eq(score({}, noAuthor), 0.92);                                                                  // only the issue name says it
    eq(score({ issue_name: 'Search reporting bias on the Paris riots 2026', kw_hits: 3 }, noAuthor), 0.85);
    eq(score({ url: 'https://bsky.app/profile/a.bsky.social/post/3m2abcdefgh', network: 'Bluesky', author: '' }), 0);
    eq(score({ url: 'https://example.com/a', network: '', author: '' }), 0);                       // can't tell the network
    eq(score({ author: 'someoneElse', url: 'https://x.com/someoneElse/status/1' }), 0);
    eq(score({ author: '', url: 'https://x.com/someoneElse/status/1' }), 0);                        // the link names another author
    eq(score({ posted_at: '2026-10-14 09:00:00+00' }), 0);                                          // more than a day after
    eq(score({ posted_at: '2026-10-13T20:00:00Z' }), 0.97);
    eq(score({ url: 'not a link' }), 0);
    const big = Object.assign({}, f, { total_engagement: 29425 });
    eq([score({ interactions: 1000 }, big), score({ interactions: 9000 }, big), score({ interactions: 40000 }, big)], [0, 0.97, 0.97]);
    eq(score({ interactions: 3 }, Object.assign({}, f, { total_engagement: 40 })), 0.97);          // small counts are noisy
    eq(B.linkMatch_(Object.assign({}, f, { social_network: 'twitter' }), feedRow({})).score, 0.97);  // "twitter" is X
    // BSIP's SLRR log: alone, never sure enough (unless Pendulum saw the post lately and it's the same author)
    eq([score({ src: 'slrr', in_feeds: false }), score({ src: 'slrr', in_feeds: true }, noAuthor), score({ src: 'slrr', in_feeds: true }),
      score({ src: 'slrr', in_feeds: true, issue_name: 'Something else' })], [0.8, 0.85, 0.95, 0]);

    const pick = (rows, fields) => B.pickLinkMatch_(fields || f, rows.map(feedRow));
    eq(pick([{}]), { post_url: SAM, author: '', confidence: 0.97, how: 'author and issue name' });
    eq(pick([{}, { url: 'https://x.com/WasSamLowryEsq/status/2109952063492990002' }]), null);     // two of their posts: can't tell
    eq(pick([{}, { url: 'https://x.com/other/status/2', author: 'other' }]), pick([{}]));          // another author's isn't close
    eq(pick([{}, { url: 'https://x.com/WasSamLowryEsq/status/2', issue_name: 'Pixel battery drain', summary: '', kw_hits: 0 }]),
      pick([{}]));                                                                                  // their post about something else
    eq(pick([{}], noAuthor).confidence, 0.92);
    eq(pick([{}, { url: 'https://x.com/other/status/2', author: 'other' }], noAuthor), null);       // no author to tell them apart
    eq(pick([{}, { src: 'slrr', in_feeds: false, url: 'https://x.com/earlier/status/3', author: '' }], noAuthor), null);  // an earlier logged post
    eq(pick([{ src: 'slrr', in_feeds: false }]), null);
    eq(pick([{}, { src: 'slrr', in_feeds: true, url: 'https://twitter.com/WasSamLowryEsq/status/2109952063492993159?s=20' }]).confidence, 0.97);  // the same post twice
    eq(pick([]), null);
    // The author, when the alert has none: from the link (X), else the feed's, as Burson writes one
    eq(pick([{ author: '' }], noAuthor).author, '@WasSamLowryEsq');
    eq(B.pickLinkMatch_(Object.assign({}, noAuthor, { social_network: 'Bluesky' }),
      [feedRow({ url: 'https://bsky.app/profile/sam.bsky.social/post/3m2abcdefgh', network: 'Bluesky', author: 'sam.bsky.social' })]).author, '@sam.bsky.social');
    eq(B.pickLinkMatch_(Object.assign({}, noAuthor, { social_network: 'Reddit' }),
      [feedRow({ url: 'reddit.com/r/google/comments/1abcd/x/', network: 'reddit', author: 'map_fan' })]),
    { post_url: 'https://reddit.com/r/google/comments/1abcd/x/', author: 'u/map_fan', confidence: 0.92, how: 'issue name' });

    // Small helpers
    eq(['@Foo', 'u/Foo', '/u/foo', ' FOO ', 'r/Google', ''].map(B.linkHandle_), ['foo', 'foo', 'foo', 'foo', '', '']);
    eq([B.feedHandle_('foo', 'X'), B.feedHandle_('foo', 'Reddit'), B.feedHandle_('@foo', 'X'), B.feedHandle_('Linus Tech Tips', 'YouTube'), B.feedHandle_('', 'X')],
      ['@foo', 'u/foo', '@foo', 'Linus Tech Tips', '']);
    eq(['2026-10-13 07:19:00+00', '2026-10-13T07:19:00Z', '2026-10-13 07:19:00', '2026-10-13 03:19:00-04', '2026-10-13 07:19:00 UTC', '1791875940', 'soon', null, '2026-10-13']
      .map(B.bqTimeMs_), [1791875940000, 1791875940000, 1791875940000, 1791875940000, 1791875940000, 1791875940000, null, null, null]);
    eq(score({ posted_at: '2026-10-11' }), 0.97);  // a day without a time isn't compared
    eq([B.linkKeywords_(f), B.linkKeywords_({ issue_name: 'Gemini 2026' }), B.linkKeywords_({})], ['reporting,search,paris,bias', 'gemini', '']);
  });

  test('auto-find links: the [Link] line goes where Burson puts it (before the reminder, else before [Code], else at the end), only when the link isn\'t already there', () => {
    const found = { post_url: { old: '', new: SAM } };
    assert.strictEqual(B.withFoundLink_(F.NO_LINK, found), F.P0_OK);
    assert.strictEqual(B.withFoundLink_(F.P0_OK, found), F.P0_OK);
    const aio = F.AIO.replace('[Link]: https://x.com/TheChiefNerd/status/1845000000000000001\n', '');
    const url = 'https://x.com/TheChiefNerd/status/1845000000000000001';
    assert.ok(B.withFoundLink_(aio, { post_url: { new: url } }).endsWith(`[Link]: ${url}\n[Code]: ${F.AIO.split('[Code]: ')[1]}`));
    eq(B.withFoundLink_('[Name]: a\n[Product]: b\n', { post_url: { new: url } }), `[Name]: a\n[Product]: b\n\n[Link]: ${url}`);
    eq(B.withFoundLink_('x', { author: { new: '@a' } }), 'x');
  });

  test('auto-find links: counted once a day per alert (two flows or a retry count once), shown in column C', () => {
    const w = world();
    w.bot.noteLinkFind_('alert one', false);
    w.bot.noteLinkFind_('alert one', true);
    w.bot.noteLinkFind_('alert one', true);
    w.bot.noteLinkFind_('alert two', false);
    assert.match(JSON.parse(w.g.props.get('SWITCH_NOTES')).autoFindLinks.text, /^found 1 of 2 today · last look Oct 14, /);
    w.g.clock.now += 86400e3;  // a new day starts over
    w.bot.noteLinkFind_('alert two', true);
    assert.match(JSON.parse(w.g.props.get('SWITCH_NOTES')).autoFindLinks.text, /^found 1 of 1 today · last look Oct 15, /);
    w.g.props.set('LINK_FINDS_TODAY', 'not json');  // a broken count starts over, never throws
    w.bot.noteLinkFind_('alert three', true);
    eq(JSON.parse(w.g.props.get('LINK_FINDS_TODAY')).found.length, 1);
  });

  // ===========================================================================================================
  // End to end: the every-minute run, switched ON on the Control tab
  // ===========================================================================================================

  test('auto-find links ON in the every-minute run (Control row 14): the real lookup, the link to analysts and in the Social Alert, column C says what it found, Burson hears nothing of it', () => {
    const t = e2e(null, { noWait: true });
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.control().getRange(14, 2).setValue('ON');
    const calls = fakeBq(t.g, c => (isLinkQuery(c) ? { rows: [feedRow()] } : null));
    const alert = t.chat.say(TEST_FEED, F.NO_LINK, { sender: 'users/bot' });
    t.poll();
    eq(calls.filter(isLinkQuery).length, 1);
    eq(calls.filter(isLinkQuery)[0].location, 'us-central1');
    assert.ok(calls.every(c => !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(c.sql) && !/insertAll/.test(c.url)));
    assert.ok(!t.chat.botPosts(TEST_FEED).some(m => /Link was missing/.test(m.text)));
    assert.ok(!t.chat.botPosts(TEST_FEED).some(m => /listening feed|bigquery|pendulum|found/i.test(m.text)));
    assert.ok(!t.chat.botReactions(alert.name).includes('⬇'));
    const fwd = t.chat.botPosts(TRIAGED).slice(1).find(m => !m.threadReply);
    assert.ok(fwd.text.startsWith(F.P0_OK));
    assert.ok(fwd.text.includes('found the post in the listening feeds by its author and issue name (97% sure)'));
    const sent = t.g.gmail.sentMessages();  // the Social Alert, only to the stand-in while testing, has the link
    eq([sent.length, sent[0].to, sent[0].text.includes(SAM)], [1, ['tester@testing.test'], true]);
    const log = t.sheet().getSheetByName('Alert log');
    eq(log.rows[1][log.rows[0].indexOf('record_key')], 'x.com/status/2109952063492993159');
    assert.match(t.control().cell(14, 3), /^✓ ON: looks in BigQuery \(SLRR, Sonar\) for a missing link or author(?:; processed with what it finds| before asking Burson) · found 1 of 1 today · last look /);
    // Switched back OFF: the next link-less alert is processed without it (Burson told), with no lookup
    t.control().getRange(14, 2).setValue('OFF');
    t.chat.say(TEST_FEED, NO_LINK_NO_AUTHOR.split('Paris Riots').join('Lyon Floods'), { sender: 'users/bot' });
    t.poll();
    eq(calls.filter(isLinkQuery).length, 1);
    assert.ok(t.chat.botPosts(TEST_FEED).some(m => /Link was missing/.test(m.text)));
    assert.match(t.control().cell(14, 3), /^OFF \(/);
  });

  // ===========================================================================================================
  // Regressions (round 2 review)
  // ===========================================================================================================

  /** The arguments of every CONTAINS_SUBSTR(…) call in `sql`, split at its top-level commas. */
  const containsSubstrArgs = sql => {
    const out = [];
    const rx = /CONTAINS_SUBSTR\s*\(/gi;
    let m;
    while ((m = rx.exec(sql))) {
      const args = [];
      let depth = 0, quote = '', cur = '';
      for (let i = m.index + m[0].length; i < sql.length; i++) {
        const ch = sql[i];
        if (quote) { cur += ch; if (ch === quote && sql[i - 1] !== '\\') quote = ''; continue; }
        if (ch === '"' || ch === '\'') { quote = ch; cur += ch; continue; }
        if (ch === '(') depth++;
        if (ch === ')' && depth-- === 0) { args.push(cur.trim()); break; }
        if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
        cur += ch;
      }
      out.push(args);
    }
    return out;
  };

  test('auto-find links: the link query is SQL BigQuery accepts: CONTAINS_SUBSTR only ever looks for a constant (a query parameter or literal); the issue-name words are counted with STRPOS on the lower-case text', () => {
    const w = world();
    const calls = fakeBq(w.g, c => (isLinkQuery(c) ? { rows: [feedRow()] } : isAuthorQuery(c) ? { cols: AUTHOR_COLS, rows: [] } : null));
    w.bot.bqFindMissingLink_(B.parseAlert_(F.NO_LINK));
    w.bot.bqFindMissingLink_(B.parseAlert_(INSTA_NO_AUTHOR));
    eq(calls.map(c => [isLinkQuery(c), isSlrrLinkQuery(c), isAuthorQuery(c)]), [[true, false, false], [false, true, false], [false, false, true]]);
    calls.forEach(c => containsSubstrArgs(c.sql).forEach(args => {
      eq(args.length, 2, c.sql);
      assert.match(args[1], /^(?:@\w+|"[^"]*")$/, `CONTAINS_SUBSTR(${args.join(', ')}) looks for a value that changes per row`);
    }));
    assert.match(calls[0].sql, /\(SELECT COUNT\(1\) FROM UNNEST\(SPLIT\(@kws, ","\)\) k\n {6}WHERE k != "" AND STRPOS\(LOWER\(CONCAT\(issue_name, " ", summary\)\), k\) > 0\) AS kw_hits/);
    // The words are already lower case letters and digits, so STRPOS on the lower-case text matches them as before
    eq(B.linkKeywords_({ issue_name: 'Élysée Crowds: Pixel-9 OUTAGE in PARIS' }), 'outage,crowd,paris,pixel');
  });

  /** A findLink stand-in that gives each answer in turn (the last one again after that). */
  const answers = (...list) => { const f = p => { f.calls.push(p.fields.post_url || ''); return list[Math.min(f.calls.length - 1, list.length - 1)]; }; f.calls = []; return f; };
  const EDER_FOUND = { post_url: EDER, author: '', confidence: 0.97, how: 'author and issue name' };

  test('auto-find links ON: Burson\'s resend (still without the link) of an alert whose link the bot found is its resend even when the resend\'s own lookup finds nothing: one forward, no "Link is missing", the found link kept', () => {
    // With the switch OFF the pair is one alert and its resend
    const off = world({ noWait: true });
    off.paste(PARTLY_NO_LINK);
    off.run();
    off.paste(FIXED_NO_LINK);
    eq(off.run().resends, 1);
    // ON: the original's link was found; the resend's own lookup finds nothing (BigQuery down, the cap, a second post...)
    const w = world({ noWait: true });
    const finder = answers(EDER_FOUND, null);
    const original = w.paste(PARTLY_NO_LINK);
    runWith(w, { switches: switchesNoWait(w, true), findLink: finder });
    const resend = w.paste(FIXED_NO_LINK);
    const report = runWith(w, { switches: switchesNoWait(w, true), findLink: finder });
    eq([report.resends, finder.calls.length], [1, 2]);
    eq(w.analystPosts().filter(m => !m.threadReply).length, 1);  // nothing forwarded twice
    assert.ok(!w.bursonPosts().some(m => /Link was missing|Issue status/.test(m.text)), w.bursonPosts().map(m => m.text).join('\n'));
    eq([w.chat.botReactions(original.name), w.chat.botReactions(resend.name)], [['👍', '⬇'], ['👍']]);
    eq(w.alertRows().map(r => [r.status, r.record_key, r.resend_of, r.forwarded_fields.post_url, !!r.forwarded_fields.link_found]), [
      ['superseded', 'x.com/status/2109566527900926417', '', EDER, true],
      ['fixed', 'x.com/status/2109566527900926417', 'QA-1001', EDER, true]]);
    eq(w.alertRows()[0].forwarded_fields.link_found, { how: 'author and issue name', confidence: 0.97 });
    assert.ok(w.g.logs.includes(`auto-find missing links: the link found for QA-1001 is kept for Burson's resend of it: ${EDER}`), w.g.logs.join('\n'));
    // Burson's link on a later resend takes the place of the found one (and the row is then an ordinary one)
    w.paste(F.MISTAKES_FIXED);
    eq(runWith(w, { switches: switchesNoWait(w, true), findLink: finder }).resends, 1);
    eq(w.alertRows().map(r => [r.status, !!r.forwarded_fields.link_found]), [['superseded', true], ['superseded', true], ['fixed', false]]);
    eq(w.analystPosts().filter(m => !m.threadReply).length, 1);

    // The original already alerted (its Social Alert sent): the resend's own lookup finding that post again isn't taken
    // (an alerted post), but the resend still keeps the original's link
    const u = world({ noWait: true, drafts: { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' } });
    u.paste(PARTLY_NO_LINK);
    runWith(u, { switches: switchesNoWait(u, true), findLink: spy(EDER_FOUND) });
    eq(u.alertRows()[0].email_status, 'sent');
    u.paste(FIXED_NO_LINK);
    eq(runWith(u, { switches: switchesNoWait(u, true), findLink: spy(EDER_FOUND) }).resends, 1);
    assert.ok(u.g.logs.includes(`auto-find missing links: ${EDER} was already alerted (QA-1001), so it isn't taken for this alert`));
    eq([u.analystPosts().filter(m => !m.threadReply).length, u.gmail.sentMessages().length], [1, 1]);
    eq(u.bursonPosts().map(m => m.text), ['The alert has been updated, so there is no need to resend it. The following updates were made:\n- Engagement updated to HIGH.']);
    eq(u.alertRows().map(r => [r.status, r.record_key]), [['superseded', 'x.com/status/2109566527900926417'], ['fixed', 'x.com/status/2109566527900926417']]);

    // Nothing was asked of the original (its link found, all else right): a link-less alert matched to it may be a new
    // post, so it doesn't get the found link; it's handled as with the switch OFF: the resend, with Burson told the link was missing
    const pair = on => {
      const v = world({ noWait: true });
      const finder = answers(FOUND, null);
      v.paste(F.NO_LINK);
      runWith(v, { switches: switchesNoWait(v, on), findLink: finder });
      const again = v.paste(F.NO_LINK);
      const r = runWith(v, { switches: switchesNoWait(v, on), findLink: finder });
      return { v, r, asked: v.bursonPosts().filter(m => m.thread.name === again.thread.name).map(m => m.text) };
    };
    const [o, n] = [pair(false), pair(true)];
    eq([n.r.resends, n.asked, n.v.analystPosts().filter(m => !m.threadReply).length], [o.r.resends, o.asked, 1]);
    eq([o.r.resends, n.v.alertRows().map(r => [r.status, r.record_key])], [1, [['superseded', 'x.com/status/2109952063492993159'], ['fix_requested', 'x.com/status/2109952063492993159']]]);
    assert.ok(n.asked.some(t => t.includes('Link was missing')), n.asked.join('\n'));
  });

  test('auto-find links ON, auto-correct and Mirror flows: the live IMs still ask Burson for the link; Burson\'s resend with it is the resend of the alert whose link the bot found (no second post), also when Burson\'s link is another post', () => {
    const OTHER = 'https://x.com/WasSamLowryEsq/status/2109952063492990002';
    const flows = { 'auto-correct': { sourceReadOnly: true, changeNotes: true }, Mirror: { outboundBlocked: true } };
    Object.entries(flows).forEach(([flow, extra]) => {
      [SAM, OTHER].forEach(link => {
        const name = `${flow}, Burson's link ${link === SAM ? 'the found one' : 'another post'}`;
        const w = world({ drafts: { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' } });
        const ctx = Object.assign({ switches: switches(w, true), findLink: spy(FOUND) }, extra);
        const original = w.paste(F.NO_LINK);
        runWith(w, ctx);
        eq(w.alertRows()[0].status, 'ok', name);
        const top = () => w.analystPosts().filter(m => !m.threadReply).length;
        const before = top();
        const resend = w.paste(F.NO_LINK_RESENT.split(SAM).join(link));
        const report = runWith(w, ctx);
        eq(report.resends, 1, name);
        eq(top(), before, name);  // no second alert post
        eq(w.alertRows().map(r => [r.status, r.resend_of, r.forwarded_fields.post_url, !!r.forwarded_fields.link_found]),
          [['superseded', '', SAM, true], ['fixed', 'QA-1001', link, false]], name);
        assert.ok(!w.g.logs.some(l => /❌ no Social Alert needed/.test(l)), name);
        eq(w.gmail.sentMessages().length, 1, name);  // one Social Alert, for the original
        if (link === OTHER && flow === 'auto-correct') {
          assert.ok(w.analystPosts().some(m => m.threadReply && m.text.includes(`Link updated to <${OTHER}|${ISSUE}> (was ${SAM})`)), name);
        }
        eq(w.chat.botReactions(original.name).includes('⬇'), flow === 'Mirror', name);  // the Mirror space marks its own copy
        eq(w.chat.botReactions(resend.name).includes('❌'), false, name);
      });
    });
  });

  test('auto-find links ON: a found link whose post the bot already alerted isn\'t taken (processed without a link, Burson told), so a new post by the same author on the same issue isn\'t dropped as "the same post was already alerted"', () => {
    const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
    // The second post: the same author and issue, 10.6 hours later, Pendulum hasn't seen it yet
    const LATER = F.NO_LINK.replace('October 13, 2026, 3:19 AM', 'October 13, 2026, 1:55 PM')
      .replace('criticized Search for allegedly presenting a curated selection of results', 'posted again that Search shows a curated selection of results');
    const pair = on => {
      const w = world({ noWait: true, drafts: STAND_IN });
      fakeBq(w.g, c => (isLinkQuery(c) ? { rows: [feedRow(), feedRow({ src: 'slrr', in_feeds: true, kw_hits: 0 })] } : null));
      w.paste(F.P0_OK);
      runWith(w, { switches: switchesNoWait(w, on), findLink: realFind(w) });
      eq(w.alertRows()[0].email_status, 'sent');
      const second = w.paste(LATER);
      runWith(w, { switches: switchesNoWait(w, on), findLink: realFind(w) });
      return { w, second, asked: w.bursonPosts().filter(m => m.thread.name === second.thread.name).map(m => m.text) };
    };
    const off = pair(false);
    assert.ok(off.asked.some(t => t.includes('Link was missing')), off.asked.join('\n'));
    const { w, second, asked } = pair(true);
    assert.ok(w.g.logs.includes(`auto-find missing links: ${SAM} was already alerted (QA-1001), so it isn't taken for this alert`), w.g.logs.join('\n'));
    // Processed right away as a post of its own, as with the switch OFF: decided on the rules (an ongoing issue under
    // 2K engagements), never dropped as "the same post was already alerted"
    const decision = String(w.alertRows()[1].decision || '');
    eq([decision, String(off.w.alertRows()[1].decision || '')], [`❌ ongoing issue, no KOF author and under 2K engagements`, decision]);
    assert.ok(!w.g.logs.some(l => /QA-1002: ❌ .*(?:already alerted|same post)/i.test(l)), w.g.logs.join('\n'));
    eq(asked, off.asked);  // Burson is told as with the switch OFF
    eq(w.chat.botReactions(second.name), off.w.chat.botReactions(off.second.name));
    const row = w.alertRows()[1];
    eq([row.alert_id, row.record_key, row.status, row.forwarded_fields.link_found], ['QA-1002', '', 'fix_requested', undefined]);
    // A found post the bot forwarded but didn't alert (no Social Alert, or ❌) is still taken
    const v = world({ noWait: true });
    v.paste(F.P0_OK);
    v.run();
    v.paste(LATER);
    runWith(v, { switches: switchesNoWait(v, true), findLink: spy(FOUND) });
    eq(v.alertRows()[1].record_key, 'x.com/status/2109952063492993159');
  });

  test('auto-find links: a feed post whose author the feeds don\'t know is never taken on its issue name alone for an alert that names its author (it can still make another guess ambiguous)', () => {
    const IG = F.P0_OK.split(`[Link]: ${SAM}\n`).join('').replace('| X |', '| Instagram |').replace('[Social Network]: X', '[Social Network]: Instagram')
      .replace('X user @WasSamLowryEsq', 'Instagram user @paris.watch').replace(',1,WasSamLowryEsq,-,', ',1,paris.watch,-,');
    const f = B.parseAlert_(IG).fields;
    eq([f.author, f.social_network, f.post_url], ['@paris.watch', 'Instagram', undefined]);
    const ig = o => feedRow(Object.assign({ url: 'https://www.instagram.com/p/ABCdef123/', network: 'Instagram', author: '' }, o));
    eq(B.linkMatch_(f, ig()), { score: 0.8, how: 'issue name' });
    eq(B.pickLinkMatch_(f, [ig()]), null);
    eq(B.linkMatch_(f, ig({ author: 'paris.watch' })).score, 0.97);   // the feeds know it's theirs
    eq(B.linkMatch_(f, ig({ author: 'someone.else' })).score, 0);     // another author's: never
    eq(B.pickLinkMatch_(f, [ig({ author: 'paris.watch' }), ig({ url: 'https://www.instagram.com/p/XYZother9/' })]), null);  // ...but it's close
    const noAuthor = B.parseAlert_(NO_LINK_NO_AUTHOR).fields;  // no author named: the issue name alone still does
    eq(B.linkMatch_(noAuthor, feedRow({ author: '', url: 'https://x.com/i/status/2109952063492993159' })).score, 0.92);
  });
};
