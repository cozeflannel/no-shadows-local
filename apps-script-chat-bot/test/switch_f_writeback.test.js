// Write back to SLRR BigQuery (Control tab row 16, BigQuery.gs bqWriteBack_ / retryBqWriteBacks_, hooks in Drafts.gs):
// a finished alert goes in the shared SLRR tables (live: slrr_alerts, and alert_sends as PROD when sent; testing: only a
// sent one, in alert_sends as TEST), once, with the bot's mark. OFF: no BigQuery write of any kind, nothing changes. The
// Results tab and the bot's own reads of slrr_alerts never take the bot's rows for the IMs'.
'use strict';

module.exports = H => {
  const { test, eq, assert, F, NOW, world, e2e, collectBurson, plain, MAPS_LOW, TEST_FEED, resultsRows, resultsRow } = H;
  const LIVE = { live: true, mailbox: 'im@ops.test', from: 'Brand Social <sender@alerts.test>' };
  const NOT_LIVE = { live: false, mailbox: 'im@ops.test', from: 'Brand Social <im@ops.test>' };
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const ON = { writeBackBq: true };
  const MARK = 'burson-qa-bot';
  const BQ_HOST = 'https://bigquery.googleapis.com/bigquery/v2/projects/brand-social-central-data/';
  const SENDS = 'slrr_feedback.alert_sends';
  const ALERTS = 'slrr_alerts.slrr_alerts';
  const NOT_BOT = 'NOT (IFNULL(CAST(identifier_analyst AS STRING), "") = "burson-qa-bot" OR ' +
    'IFNULL(CAST(source_tab AS STRING), "") = "burson-qa-bot")';
  const iso = ms => new Date(ms).toISOString();
  const MIN = 60 * 1000;

  // Alerts that finish every way: a Social Alert (P0), a correct one below the criteria (❌), a T&S-only one (Gemini
  // vetoes the email), a YouTube one left for a person, and more P0s on other posts and issues (other authors)
  const MAPS_LOW_OK = MAPS_LOW.split('Product - Memes & humorous content').join('Product - Meme about Google products');
  const VETO = () => ({ checks: [], social_alert: { warranted: false, confidence: 0.95, reason: 'Google is only mentioned in passing' } });
  const TOPICS = ['Lyon Flood Coverage Censorship', 'Berlin Marathon Results Hidden', 'Tokyo Election Autocomplete Slant',
    'Cairo Protest Images Missing'];
  const p0 = n => F.P0_OK.split('Alleged Bias in Search Reporting for Paris Riots 2026').join(TOPICS[n])
    .split('WasSamLowryEsq').join(`SamLowry${n}`).split('2109952063492993159').join(`21099520634929${n}0000`);
  const P0_LINK = 'https://x.com/WasSamLowryEsq/status/2109952063492993159';
  const linkOf = n => `https://x.com/SamLowry${n}/status/21099520634929${n}0000`;
  const YT = MAPS_LOW_OK.split('[Product]: Maps').join('[Product]: YouTube').split('LOW (300 engagements)').join('HIGH (4200 engagements)')
    .split(',300,').join(',4200,').split('Google Maps Street View Dog Meme').join('YouTube Shorts Dog Meme')
    .split(',Maps,').join(',YouTube,').split('Google Maps car').join('YouTube camera crew');

  /**
   * BigQuery, faked on this world's UrlFetchApp: every call recorded with its payload ({url, method, headers, body,
   * table: 'dataset.table' for an insertAll}); an insertAll is taken unless `answer(call)` says otherwise ({code, body},
   * or 'throw' for a dropped connection); every query gets no rows unless `query(call)` says otherwise.
   */
  const fakeBq = g => {
    const calls = [];
    const orig = g.services.UrlFetchApp.fetch;
    g.bq = { calls, answer: null, query: null };
    g.services.UrlFetchApp.fetch = (url, params) => {
      if (!String(url).startsWith('https://bigquery.googleapis.com/')) return orig(url, params);
      const body = JSON.parse((params && params.payload) || '{}');
      const m = String(url).match(/\/datasets\/([^/]+)\/tables\/([^/]+)\/insertAll$/);
      const call = { url, method: params.method, headers: params.headers, body, table: m ? `${m[1]}.${m[2]}` : '' };
      calls.push(call);
      let r = m ? (g.bq.answer ? g.bq.answer(call) : null) : (g.bq.query ? g.bq.query(call) : null);
      if (r === 'throw') throw new Error('Address unavailable: ' + url);
      r = r || (m ? { code: 200, body: { kind: 'bigquery#tableDataInsertAllResponse' } }
        : { code: 200, body: { jobComplete: true, schema: { fields: [] }, rows: [] } });
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return { getResponseCode: () => r.code, getContentText: () => text, getHeaders: () => ({}) };
    };
    return g.bq;
  };
  /**
   * The two tables on top of fakeBq: the rows each insertAll commits (a repeat insertId within a minute is dropped, as
   * BigQuery does), what each insert into a table answers, in turn (`plan[table]`: 'ok'; 'lost': committed, then the
   * connection drops; 'slow': committed, then the connection drops 40 seconds later; '503': committed, then an HTTP 503;
   * 'down': not committed, the connection drops; '400': refused),
   * and the write-back's look for its own row (a SELECT 1: a row when the table has it; `g.bq.checkFails` > 0: HTTP 500).
   */
  const fakeTables = (g, plan) => {
    const rows = [];
    Object.assign(g.bq, { rows, checks: [], checkFails: 0 });
    g.bq.answer = call => {
      const how = (plan[call.table] || []).shift() || 'ok';
      if (['ok', 'lost', 'slow', '503'].includes(how)) {
        call.body.rows.forEach(r => {
          const repeat = rows.some(x => x.table === call.table && x.insertId === r.insertId && g.clock.now - x.at < MIN);
          if (!repeat) rows.push({ table: call.table, insertId: r.insertId, json: r.json, at: g.clock.now });
        });
      }
      if (how === 'slow') g.clock.now += 40 * 1000;
      if (how === 'lost' || how === 'slow' || how === 'down') return 'throw';
      if (how === '503') return { code: 503, body: 'Service Unavailable' };
      if (how === '400') return { code: 400, body: { error: { message: 'Bad request' } } };
      return null;
    };
    g.bq.query = call => {
      const q = String(call.body.query || '');
      if (!/^SELECT 1 FROM/.test(q)) return null;
      g.bq.checks.push(call);
      if (g.bq.checkFails > 0) { g.bq.checkFails--; return { code: 500, body: 'Backend error' }; }
      const p = Object.fromEntries((call.body.queryParameters || []).map(x => [x.name, x.parameterValue.value]));
      const table = q.includes(`.${SENDS}\``) ? SENDS : ALERTS;
      const found = rows.some(x => x.table === table && (table === SENDS
        ? x.json.drafted_by === p.mark && x.json.post_url === p.url && String(Date.parse(x.json.draft_created_at)) === p.ms
        : x.json.record_id === p.id && x.json.identifier_analyst === p.mark));
      return { code: 200, body: { jobComplete: true, schema: { fields: [{ name: 'f0_', type: 'INTEGER' }] },
        rows: found ? [{ f: [{ v: '1' }] }] : [] } };
    };
    return g.bq;
  };
  const inserts = g => g.bq.calls.filter(c => c.table);
  const DML = /\b(INSERT\s+INTO|UPDATE\s+`|DELETE\s+FROM|MERGE\s+INTO|CREATE\s+(OR\s+REPLACE\s+)?TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i;
  const writes = g => g.bq.calls.filter(c => c.table || /insertAll|tabledata|\/jobs$/.test(c.url) || DML.test(String(c.body.query || '')));
  const rowsIn = (g, table) => inserts(g).filter(c => c.table === table).map(c => c.body.rows).reduce((a, b) => a.concat(b), []);

  const liveWorld = opts => {
    const w = world(Object.assign({ drafts: LIVE }, opts || {}));
    w.bot.ev('GEN').email.stand_in = '';
    fakeBq(w.g);
    return w;
  };
  const testWorld = opts => {
    const w = world(Object.assign({ drafts: STAND_IN }, opts || {}));
    fakeBq(w.g);
    return w;
  };
  // One run (as w.run()) with these ctx fields on top of the test ctx: switches, outboundBlocked, deadline, …
  const runWith = (w, extra) => {
    w.g.clock.now += 1000;
    const c = w.ctx();
    Object.keys(extra || {}).forEach(k => { c[k] = extra[k]; });
    const report = w.bot.runOnce_(c);
    collectBurson(w.chat, [w.BUR]);
    return report;
  };
  const memoLog = w => JSON.parse(w.ctx().memo.get('bq_writeback') || 'null');
  const switchNote = w => (JSON.parse(w.g.props.get('SWITCH_NOTES') || '{}').writeBackBq || {}).text;
  const forwards = w => w.analystPosts().filter(m => !m.threadReply);
  const rowOf = (w, link) => w.alertRows().find(r => (r.forwarded_fields || {}).post_url === link);
  const gmailFails = path => (method, p) => (method === 'post' && p === path ? { code: 500, body: { error: { message: 'backend error' } } } : null);
  // Everything a run leaves behind: Chat, Gmail, the Alert log, the bot's memory and script properties, the run log,
  // and every BigQuery call with its payload
  const snapshot = w => ({
    chat: [w.BUR, w.ANA].map(s => w.chat.spaces.get(s).messages.map(m => [m.name, m.text, m.thread.name, m.threadReply,
      m.clientAssignedMessageId || '', m.reactions.map(r => `${r.user} ${r.emoji}`)])),
    drafts: w.gmail.allDrafts().map(d => [d.id, d.threadId, d.mime]),
    sent: w.gmail.sentMessages().map(m => [m.id, m.threadId, m.mime]),
    gmail: w.gmail.calls.map(c => [c.method, c.path, c.query]),
    rows: plain(w.alertRows()),
    memo: ['open_drafts', 'tns_watch', 'lead_pings', 'auto_sent', 'bq_writeback'].map(k => w.ctx().memo.get(k)),
    props: Array.from(w.g.props.entries()),
    logs: w.g.logs.slice(),
    bq: w.g.bq.calls.map(c => [c.url, c.method, JSON.stringify(c.body)]),
  });
  // Chat and Gmail only (what people see)
  const seen = w => ({ chat: snapshot(w).chat, drafts: snapshot(w).drafts, sent: snapshot(w).sent, gmail: snapshot(w).gmail });

  // Live (real distros): every way an alert finishes. A person sends the first draft; ❌; T&S only; YouTube; a draft
  // deleted in Gmail; a draft an analyst ❌s; an email Gmail keeps refusing (failed after 3 tries); then quiet runs
  const liveFlow = (w, extra) => {
    w.paste(F.P0_OK);
    runWith(w, extra);
    const first = w.gmail.allDrafts()[0];  // (none when another switch sent it already)
    if (first) w.gmail.send(first.id, 'im@ops.test', '<sent-by-a-person@mail.test>');
    runWith(w, extra);
    w.paste(MAPS_LOW_OK);
    runWith(w, extra);
    w.vertex.assess = VETO;
    w.paste(F.AIO);
    runWith(w, extra);
    w.vertex.assess = () => ({ checks: [] });
    w.paste(YT);
    runWith(w, extra);
    w.paste(p0(0));
    w.paste(p0(1));
    runWith(w, extra);
    const deleting = w.gmail.allDrafts().find(d => d.text.includes(linkOf(0)));
    if (deleting) w.gmail.discard(deleting.id);
    w.chat.addReaction(forwards(w).find(m => m.text.includes(linkOf(1))).name, '❌');
    runWith(w, extra);
    w.gmail.fail = gmailFails('drafts');
    w.paste(p0(2));
    runWith(w, extra);
    runWith(w, extra);
    runWith(w, extra);
    w.gmail.fail = null;
    runWith(w, extra);
    runWith(w, extra);
  };
  // Testing (a stand-in): the Social Alert sent to the stand-in, ❌, T&S only, a send Gmail keeps refusing, quiet runs
  const testFlow = (w, extra) => {
    w.paste(F.P0_OK);
    runWith(w, extra);
    w.paste(MAPS_LOW_OK);
    runWith(w, extra);
    w.vertex.assess = VETO;
    w.paste(F.AIO);
    runWith(w, extra);
    w.vertex.assess = () => ({ checks: [] });
    w.gmail.fail = gmailFails('messages/send');
    w.paste(p0(2));
    runWith(w, extra);
    runWith(w, extra);
    runWith(w, extra);
    w.gmail.fail = null;
    runWith(w, extra);
  };

  test('write-back OFF (or no switches, or anything but ON): every way an alert finishes, live and testing, is byte for byte as before, with no BigQuery call at all and nothing marked, noted or remembered', () => {
    [['live', liveWorld, liveFlow], ['testing (a stand-in)', testWorld, testFlow]].forEach(([name, make, flow]) => {
      const none = make();
      flow(none, {});
      const off = make();
      flow(off, { switches: Object.assign(off.bot.switchesOff_(), { writeBackBq: false }) });
      const offString = make();
      flow(offString, { switches: { writeBackBq: 'ON' } });  // only true turns it on
      eq(snapshot(off), snapshot(none), name);
      eq(snapshot(offString), snapshot(none), name);
      eq([none.g.bq.calls.length, writes(none.g).length], [0, 0], name);  // no BigQuery call of any kind in these flows
      assert.ok(none.alertRows().every(r => !r.bq_written), name);
      eq([none.ctx().memo.get('bq_writeback'), none.g.props.has('BQ_WRITEBACK_DAY'), switchNote(none)], [null, false, undefined], name);
      // Every other switch ON (they do other things): still nothing written to BigQuery
      const others = make();
      flow(others, { switches: Object.assign(others.bot.switchesOff_(), Object.fromEntries(
        others.bot.ev('CONTROL_SWITCHES_').map(s => [s.key, s.key !== 'writeBackBq']))) });
      eq([writes(others.g).length, others.alertRows().filter(r => r.bq_written).length], [0, 0], name);
    });
    // The flows did finish every way (so the hooks were all reached)
    const w = liveWorld();
    liveFlow(w, {});
    eq(w.alertRows().map(r => [r.email_status || '', String(r.decision || '').slice(0, 12)]), [
      ['sent', ''], ['', '❌ P2, 300 en'], ['', 'T&S form onl'], ['', 'YouTube: lef'], ['discarded', ''], ['deleted', ''], ['failed', '']]);
    const t = testWorld();
    testFlow(t, {});
    eq(t.alertRows().map(r => [r.email_status || '', String(r.decision || '').slice(0, 12)]), [
      ['sent', ''], ['', '❌ P2, 300 en'], ['', 'T&S form onl'], ['failed', '']]);
  });

  test('write-back OFF, end to end (poll() and the Control tab): the Social Alert, ❌ and the Results tab read BigQuery as before, and nothing is ever written to it', () => {
    const t = e2e();
    fakeBq(t.g);
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.chat.say(TEST_FEED, F.MISTAKES, { sender: 'users/bot' });  // sent to the stand-in
    t.chat.say(TEST_FEED, MAPS_LOW_OK, { sender: 'users/bot' });  // ❌
    t.poll();
    t.poll();
    t.g.clock.now += 11 * MIN;  // the Results tab's quiet rebuild
    t.poll();
    eq(t.g.gmail.sentMessages().map(m => m.to), [['tester@testing.test']]);
    assert.ok(t.g.bq.calls.length >= 3, `${t.g.bq.calls.length} BigQuery calls`);  // the enrichment and the Results tab's reads
    assert.ok(t.g.bq.calls.every(c => c.url === BQ_HOST + 'queries'), JSON.stringify(t.g.bq.calls.map(c => c.url)));
    eq(writes(t.g), []);
    const log = t.sheet().getSheetByName('Alert log');
    const col = log.rows[0].indexOf('bq_written');
    assert.ok(col > 0);
    const marks = log.rows.slice(1).map(r => r[col]);
    assert.ok(marks.length >= 2 && marks.every(v => v === '' || v === undefined || v === null), JSON.stringify(marks));
    assert.match(t.control().cell(16, 3), /^OFF \(writes only to this sheet: nothing goes to the shared SLRR BigQuery tables\)$/);
    assert.ok(!t.g.props.has('BQ_WRITEBACK_DAY'));
  });

  test('write-back ON while testing (a stand-in): only the Social Alert that was sent goes in, once, as a TEST row in alert_sends with the bot\'s mark; nothing in slrr_alerts; ❌, T&S-only and failed alerts write nothing; Chat and Gmail are as with it OFF; C16 says what goes in', () => {
    const off = testWorld();
    testFlow(off, {});
    const w = testWorld();
    testFlow(w, { switches: ON });
    eq(seen(w), seen(off));  // nothing is posted, reacted or emailed about it
    const [row] = w.alertRows();
    eq(inserts(w.g).map(c => [c.url, c.method, c.headers.Authorization]),
      [[BQ_HOST + 'datasets/slrr_feedback/tables/alert_sends/insertAll', 'post', 'Bearer TOKEN']]);
    eq(inserts(w.g)[0].body, { kind: 'bigquery#tableDataInsertAllRequest', skipInvalidRows: false, ignoreUnknownValues: false, rows: [{
      insertId: `${row.alert_id}:sent`,
      json: { post_url: P0_LINK, subject: row.email_subject, drafted_by: MARK, draft_created_at: iso(row.email_sent_at), environment: 'TEST' },
    }] });
    assert.match(row.email_subject, /^\S+SOCIAL ALERT\S+: Search \| Alleged Bias in Search Reporting for Paris Riots 2026 \| X \|/);
    eq(rowsIn(w.g, ALERTS), []);
    // Marked once, on the row that went in; nothing on the others
    eq(w.alertRows().map(r => [r.alert_id, Number(r.bq_written) > 0]),
      [[row.alert_id, true], ['QA-1002', false], ['QA-1003', false], ['QA-1004', false]]);
    assert.ok(Number(row.bq_written) >= Number(row.email_sent_at));
    eq(memoLog(w).map(e => [e.id, e.k, e.n, e.d, e.s]), [[row.alert_id, 'sent', 1, ['sends'], 'ok']]);
    eq(switchNote(w), 'testing: only sent alerts, as TEST rows in alert_sends; nothing in slrr_alerts · 1 on 2026-10-14 · ' +
      `last ${row.alert_id} (sent) at Oct 14, 8:00 AM EDT`);
    // Later runs write nothing more
    runWith(w, { switches: ON });
    w.g.clock.now += 60 * MIN;
    runWith(w, { switches: ON });
    eq(inserts(w.g).length, 1);
  });

  test('write-back ON live: every finished alert goes in slrr_alerts once, with the bot\'s mark and insertId <alert_id>:<kind>; the sent one in alert_sends too, as PROD; nothing before an alert is finished, and nothing twice', () => {
    // A draft waiting for a person isn't finished: nothing yet
    const w = liveWorld();
    w.paste(F.P0_OK);
    const r = runWith(w, { switches: ON });
    eq([inserts(w.g), w.alertRows()[0].email_status, r.bq_written], [[], 'drafted', undefined]);

    // The whole flow, next to the same flow with the switch OFF
    const off = liveWorld();
    liveFlow(off, {});
    const v = liveWorld();
    liveFlow(v, { switches: ON });
    eq(seen(v), seen(off));  // Chat and Gmail exactly as with it OFF: nothing is posted about it
    const ids = v.alertRows().map(x => x.alert_id);
    // (an analyst's ❌ is read before the drafts are checked: the deleted one goes in before the discarded one)
    eq(inserts(v.g).map(c => [c.table, c.body.rows.map(x => x.insertId)]), [
      [SENDS, [`${ids[0]}:sent`]], [ALERTS, [`${ids[0]}:sent`]],
      [ALERTS, [`${ids[1]}:decided`]], [ALERTS, [`${ids[2]}:decided`]], [ALERTS, [`${ids[3]}:decided`]],
      [ALERTS, [`${ids[5]}:deleted`]], [ALERTS, [`${ids[4]}:discarded`]], [ALERTS, [`${ids[6]}:failed`]]]);
    assert.ok(inserts(v.g).every(c => c.body.kind === 'bigquery#tableDataInsertAllRequest' && c.body.skipInvalidRows === false &&
      c.body.ignoreUnknownValues === false && c.body.rows.length === 1 && c.headers.Authorization === 'Bearer TOKEN'));
    assert.ok(v.alertRows().every(r => Number(r.bq_written) > 0));

    // The Social Alert a person sent: alert_sends as PROD, and the alert in the SLRR log with the emojis it got
    const sent = v.alertRows()[0];
    eq(rowsIn(v.g, SENDS).map(x => x.json), [{ post_url: P0_LINK, subject: sent.email_subject, drafted_by: MARK,
      draft_created_at: iso(sent.email_sent_at), environment: 'PROD' }]);
    const logged = rowsIn(v.g, ALERTS).map(x => x.json);
    const at = logged[0].date_added;
    eq(logged[0], { url: P0_LINK, date_added: at, ingestion_timestamp: at, record_id: sent.alert_id, identifier_analyst: MARK,
      source_tab: MARK, author_handle: '@WasSamLowryEsq', issue_name: 'Alleged Bias in Search Reporting for Paris Riots 2026',
      exposure_tag: 'Product - Perceived bias', product: 'Search', overview: sent.forwarded_fields.summary, engagements_actual: '1',
      google_emoji_1: '📦', google_emoji_2: '🌎' });  // what Burson's post got (not the 👍 receipt)
    assert.ok(Date.parse(at) >= Number(sent.email_sent_at) && Date.parse(at) <= Number(sent.bq_written), at);
    // ❌: the alert, with ❌; T&S only and YouTube: no action emoji yet
    eq([logged[1].url, logged[1].google_emoji_1, logged[1].engagements_actual, logged[1].author_handle],
      ['https://www.reddit.com/r/GoogleMaps/comments/1abcde/street_view_dog/', '❌', '300', 'u/map_enthusiast']);
    eq([logged[2].url, logged[2].issue_name, 'google_emoji_1' in logged[2]],
      ['https://x.com/TheChiefNerd/status/1845000000000000001', 'AI Overviews Historical Treaty Date Error', false]);
    eq([logged[3].product, logged[3].issue_name], ['YouTube', 'YouTube Shorts Dog Meme']);
    eq(logged.slice(4).map(j => [j.url, j.record_id]), [[linkOf(1), ids[5]], [linkOf(0), ids[4]], [linkOf(2), ids[6]]]);
    assert.ok(logged.every(j => j.identifier_analyst === MARK && j.source_tab === MARK && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(j.date_added)));
    assert.ok(logged.every(j => Object.values(j).every(x => typeof x === 'string')));  // text only: BigQuery reads it into any type

    // C16: today's count (of alerts, not rows)
    assert.match(switchNote(v), new RegExp(`^7 written on 2026-10-14 · last ${ids[6]} \\(failed\\) at Oct 14, `));  // alerts, not rows
    // Nothing twice: more runs, an hour on
    const n = inserts(v.g).length;
    runWith(v, { switches: ON });
    v.g.clock.now += 60 * MIN;
    runWith(v, { switches: ON });
    eq(inserts(v.g).length, n);
    eq(memoLog(v).map(e => [e.id, e.s, e.n]).sort(), ids.map(id => [id, 'ok', 1]));
  });

  test('write-back ON in a Testing run (the Safety valve ON or B26 set; in the Mirror space too), the auto-correct space, or a test space with no stand-in: only a sent Social Alert, as TEST, never slrr_alerts; LIVE in the Mirror space, the send goes in as PROD', () => {
    // A Testing run in the Mirror space: the analyst sends the draft; ❌ writes nothing
    const m = liveWorld();
    m.bot.setRunLive_(false);  // runMode_ said Testing
    m.paste(F.P0_OK);
    runWith(m, { switches: ON, outboundBlocked: true });
    m.gmail.send(m.gmail.allDrafts()[0].id, 'im@ops.test', '<x@mail.test>');
    runWith(m, { switches: ON, outboundBlocked: true });
    m.paste(MAPS_LOW_OK);
    runWith(m, { switches: ON, outboundBlocked: true });
    eq(inserts(m.g).map(c => [c.table, c.body.rows[0].json.environment]), [[SENDS, 'TEST']]);
    // LIVE in the Mirror space: the send goes in as PROD, as from S-F Burson
    const ml = liveWorld();
    ml.paste(F.P0_OK);
    runWith(ml, { switches: ON, outboundBlocked: true });
    ml.gmail.send(ml.gmail.allDrafts()[0].id, 'im@ops.test', '<xl@mail.test>');
    runWith(ml, { switches: ON, outboundBlocked: true });
    eq(inserts(ml.g).filter(c => c.table === SENDS).map(c => c.body.rows[0].json.environment), ['PROD']);
    // A test space (drafts addressed to the mailbox), no stand-in anywhere
    const t = world({ drafts: NOT_LIVE });
    t.bot.ev('GEN').email.stand_in = '';
    fakeBq(t.g);
    t.paste(F.P0_OK);
    runWith(t, { switches: ON });
    t.gmail.send(t.gmail.allDrafts()[0].id, 'im@ops.test', '<y@mail.test>');
    runWith(t, { switches: ON });
    t.paste(MAPS_LOW_OK);
    runWith(t, { switches: ON });
    eq(inserts(t.g).map(c => [c.table, c.body.rows[0].json.environment]), [[SENDS, 'TEST']]);
    // The auto-correct space (the live space, read only), even with live drafts and no stand-in: never live
    const a = liveWorld();
    const AC = { switches: ON, sourceReadOnly: true, changeNotes: true };
    a.paste(F.P0_OK);
    runWith(a, AC);
    a.gmail.send(a.gmail.allDrafts()[0].id, 'im@ops.test', '<ac@mail.test>');
    runWith(a, AC);
    a.paste(MAPS_LOW_OK);
    runWith(a, AC);
    eq([a.alertRows().map(r => r.email_status || r.decision.slice(0, 1)), inserts(a.g).map(c => [c.table, c.body.rows[0].json.environment])],
      [['sent', '❌'], [[SENDS, 'TEST']]]);
    eq(a.bursonPosts(), []);
    assert.strictEqual(ml.bot.bqWriteBackLive_(Object.assign(ml.ctx(), AC)), false);
    assert.strictEqual(ml.bot.bqWriteBackLive_(Object.assign(ml.ctx(), { outboundBlocked: true })), true);  // the Mirror space, LIVE
    assert.strictEqual(ml.bot.bqWriteBackLive_(ml.ctx()), true);
    assert.strictEqual(m.bot.bqWriteBackLive_(Object.assign(m.ctx(), { outboundBlocked: true })), false);  // a Testing run
    // And with the YAML's stand-in back (as in this repo), never live either (when no run said LIVE)
    ml.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    assert.strictEqual(ml.bot.bqWriteBackLive_(ml.ctx()), false);
  });

  test('write-back ON: BigQuery refusing a row (an HTTP error, insertErrors, a dropped connection) never stops the run; it\'s tried again on later runs, 5 minutes apart, and given up after 3 tries, saying so on C16 and the Status; a half-written alert only writes what\'s missing', () => {
    const w = liveWorld();
    const tries = [];
    w.g.bq.answer = call => {
      if (call.table !== ALERTS) return null;
      tries.push(call.body.rows[0].insertId);
      return [{ code: 403, body: { error: { message: 'Access Denied' } } },
        { code: 200, body: { insertErrors: [{ index: 0, errors: [{ reason: 'invalid', location: 'engagements_actual', message: 'Cannot convert value to integer.' }] }] } },
        'throw', 'throw'][tries.length - 1] || null;  // (a dropped connection is sent again at once: dropped again)
    };
    w.paste(F.P0_OK);
    runWith(w, { switches: ON });
    w.gmail.send(w.gmail.allDrafts()[0].id, 'im@ops.test', '<z@mail.test>');
    const r1 = runWith(w, { switches: ON });
    const [row] = w.alertRows();
    eq([r1.errors, r1.bq_written, r1.notices, row.email_status, row.bq_written], [[], undefined, undefined, 'sent', undefined]);
    eq(inserts(w.g).map(c => c.table), [SENDS, ALERTS]);
    eq(memoLog(w).map(e => [e.d, e.s, e.n, e.e]), [[['sends'], 'retry', 1, 'BigQuery write HTTP 403: {"error":{"message":"Access Denied"}}']]);
    eq(switchNote(w), '⚠️ QA-1001 not written yet (BigQuery write HTTP 403: {"error":{"message":"Acc…): trying again · ' +
      '0 written on 2026-10-14');
    assert.ok(w.g.logs.some(l => /couldn't write QA-1001 back to SLRR BigQuery \(try 1 of 3\): BigQuery write HTTP 403/.test(l)));

    // A minute later: not yet
    runWith(w, { switches: ON });
    w.g.clock.now += 60 * 1000;
    runWith(w, { switches: ON });
    eq(tries.length, 1);
    // 5 minutes after: only the table it isn't in yet (alert_sends has it), refused again
    w.g.clock.now += 5 * MIN;
    const r2 = runWith(w, { switches: ON });
    eq([tries.length, inserts(w.g).map(c => c.table), r2.errors], [2, [SENDS, ALERTS, ALERTS], []]);
    eq(memoLog(w)[0].e, 'BigQuery refused the row: invalid (engagements_actual): Cannot convert value to integer.');
    // The third try: the connection drops (and again when sent once more at once); given up, for good, saying what's where
    w.g.clock.now += 5 * MIN;
    const r3 = runWith(w, { switches: ON });
    eq([tries.length, r3.errors, memoLog(w)[0].s, memoLog(w)[0].n, w.alertRows()[0].bq_written], [4, [], 'gave_up', 3, undefined]);
    eq(r3.notices.length, 1);
    assert.match(r3.notices[0], /^Couldn't write QA-1001 back to the SLRR BigQuery tables after 3 tries \(Address unavailable: https:\/\/bigquery[^)]*…\)\. It's in alert_sends, may be in slrr_alerts \(BigQuery's answer was lost\): check before adding it by hand\.$/);
    eq(switchNote(w), '⚠️ gave up on QA-1001 after 3 tries (Address unavailable: https://bigquery.googleapis.…) · 0 written on 2026-10-14');
    eq(tries, ['QA-1001:sent', 'QA-1001:sent', 'QA-1001:sent', 'QA-1001:sent']);  // the same insertId each time
    w.g.clock.now += 30 * MIN;
    runWith(w, { switches: ON });
    runWith(w, { switches: ON });
    eq(tries.length, 4);

    // Another alert, taken at once: counted, and the problem stays on C16 for the day
    w.paste(MAPS_LOW_OK);
    runWith(w, { switches: ON });
    eq(rowsIn(w.g, ALERTS).length, 5);
    assert.match(switchNote(w), /^⚠️ gave up on QA-1001 after 3 tries .* · 1 written on 2026-10-14 · last QA-1002 \(decided\) at Oct 14, /);

    // A refusal that clears up on the retry: written once, and the problem with it is gone from C16
    const v = liveWorld();
    let fails = 1;
    v.g.bq.answer = () => (fails-- > 0 ? { code: 403, body: 'Quota exceeded' } : null);
    v.paste(MAPS_LOW_OK);
    runWith(v, { switches: ON });
    eq([inserts(v.g).length, v.alertRows()[0].bq_written], [1, undefined]);
    v.g.clock.now += 5 * MIN;
    const ok = runWith(v, { switches: ON });
    eq([inserts(v.g).length, ok.bq_written, Number(v.alertRows()[0].bq_written) > 0, memoLog(v)[0].s], [2, 1, true, 'ok']);
    assert.match(switchNote(v), /^1 written on 2026-10-14 · last QA-1001 \(decided\) at Oct 14, /);
    v.g.clock.now += 10 * MIN;
    runWith(v, { switches: ON });
    eq(inserts(v.g).length, 2);
  });

  test('write-back ON: never twice. A row whose mark was lost is held back by the bot\'s memory (and the other way round), the same send noted again writes nothing, and an alert finished past the run\'s time is written once by the next run', () => {
    const w = liveWorld();
    w.paste(MAPS_LOW_OK);
    runWith(w, { switches: ON });
    const [row] = w.alertRows();
    eq(inserts(w.g).length, 1);
    const ctx = () => Object.assign(w.ctx(), { switches: ON });
    // The sheet didn't keep bq_written: the memory still says it's in
    delete row.bq_written;
    eq([w.bot.bqWriteBack_(ctx(), row, 'decided', {}), w.bot.bqWriteBack_(ctx(), row, 'sent', {})], [false, false]);
    // The memory is gone but the row has its mark
    row.bq_written = NOW;
    w.ctx().memo.set('bq_writeback', '[]');
    eq(w.bot.bqWriteBack_(ctx(), row, 'decided', {}), false);
    eq(inserts(w.g).length, 1);

    // Testing: the Social Alert's send is noted again (a later step failed, the email was retried): one TEST row
    const t = testWorld();
    t.paste(F.P0_OK);
    runWith(t, { switches: ON });
    const [sent] = t.alertRows();
    t.bot.onEmailSent_(Object.assign(t.ctx(), { switches: ON }), sent, {});
    t.bot.onEmailSent_(Object.assign(t.ctx(), { switches: ON }), sent, {});
    eq(inserts(t.g).length, 1);

    // Finished in a run already past its time budget: nothing written then (that isn't a try), and the next run writes it
    // at once, once
    const late = liveWorld();
    late.paste(MAPS_LOW_OK);
    runWith(late, { switches: ON });
    const other = Object.assign({}, late.alertRows()[0], { alert_id: 'QA-9', bq_written: '' });  // another finished alert
    late.backend.alerts.push(other);
    const out = Object.assign(late.ctx(), { switches: ON, deadline: late.g.clock.now - 1 });
    eq(late.bot.bqWriteBack_(out, other, 'decided', {}), false);
    eq([inserts(late.g).length, memoLog(late).find(e => e.id === 'QA-9')],
      [1, { id: 'QA-9', k: 'decided', t: late.g.clock.now, n: 0, d: [], s: 'retry', l: 1, at: late.g.clock.now }]);
    assert.ok(late.g.logs.includes('QA-9 goes back to SLRR BigQuery on the next run: this run is out of time'));
    runWith(late, { switches: ON });
    eq([inserts(late.g).length, inserts(late.g)[1].body.rows[0].insertId, memoLog(late).find(e => e.id === 'QA-9').s,
      Number(other.bq_written) > 0], [2, 'QA-9:decided', 'ok', true]);
    runWith(late, { switches: ON });
    late.g.clock.now += 10 * MIN;
    runWith(late, { switches: ON });
    eq(inserts(late.g).length, 2);
  });

  test('write-back ON live: a send whose first table took the run past its time writes the second on the next run (once, not counted as a refusal); with Auto-send ON the alert the bot sent itself goes in like one a person sent', () => {
    const w = liveWorld();
    w.g.bq.answer = call => {  // alert_sends takes so long the run is out of time afterwards
      if (call.table === SENDS) w.g.clock.now += 200 * 1000;
      return null;
    };
    w.paste(F.P0_OK);
    runWith(w, { switches: ON });
    w.gmail.send(w.gmail.allDrafts()[0].id, 'im@ops.test', '<late@mail.test>');
    const r = runWith(w, { switches: ON });
    eq([inserts(w.g).map(c => c.table), r.errors, w.alertRows()[0].bq_written], [[SENDS], [], undefined]);
    eq(memoLog(w).map(e => [e.d, e.s, e.n]), [[['sends'], 'retry', 0]]);
    assert.ok(w.g.logs.includes('the rest of QA-1001 goes back to SLRR BigQuery on the next run: this run is out of time'));
    w.g.bq.answer = null;
    const r2 = runWith(w, { switches: ON });  // due at once: it wasn't refused
    eq([inserts(w.g).map(c => c.table), r2.bq_written, memoLog(w)[0].s, memoLog(w)[0].n], [[SENDS, ALERTS], 1, 'ok', 1]);
    w.g.clock.now += 10 * MIN;
    runWith(w, { switches: ON });
    eq(inserts(w.g).length, 2);

    // Auto-send Social Alerts ON too: sent by the bot at once, then written back as a send (PROD) and in the SLRR log
    const a = liveWorld();
    a.paste(F.P0_OK);
    const ra = runWith(a, { switches: { autoSend: true, writeBackBq: true } });
    const [row] = a.alertRows();
    eq([ra.auto_sent, ra.bq_written, row.email_sent_by], [1, 1, 'bot']);
    eq(inserts(a.g).map(c => [c.table, c.body.rows[0].insertId]), [[SENDS, `${row.alert_id}:sent`], [ALERTS, `${row.alert_id}:sent`]]);
    eq(rowsIn(a.g, SENDS)[0].json.environment, 'PROD');
    eq(['google_emoji_1', 'google_emoji_2'].map(k => rowsIn(a.g, ALERTS)[0].json[k]), ['📦', '🌎']);
  });

  test('write-back ON: its memory stays small (30 alerts, under 8,000 characters), alerts waiting for a retry are kept longest, a retry is never started without time left, and at most 3 alerts are retried per run', () => {
    const w = liveWorld();
    const ctx = () => Object.assign(w.ctx(), { switches: ON });
    const save = e => w.bot.saveBqWriteBack_(ctx(), e);
    save({ id: 'QA-W1', k: 'decided', t: NOW, n: 1, at: NOW, d: [], s: 'retry', e: 'x'.repeat(100) });
    for (let i = 0; i < 60; i++) save({ id: `QA-${2000 + i}`, k: 'decided', t: NOW, n: 1, at: NOW, d: ['alerts'], s: 'ok' });
    let log = memoLog(w);
    eq([log.length, log[0].id, log[log.length - 1].id], [30, 'QA-W1', 'QA-2059']);
    assert.ok(w.ctx().memo.get('bq_writeback').length < 8000);
    // Long errors on many waiting alerts: still under 8,000 characters, the newest kept
    for (let i = 0; i < 40; i++) save({ id: `QA-R${i}`, k: 'sent', t: NOW, n: 1, at: NOW, d: ['sends'], s: 'retry', e: 'y'.repeat(100) });
    log = memoLog(w);
    assert.ok(w.ctx().memo.get('bq_writeback').length <= 8000 && log.length <= 30, String(w.ctx().memo.get('bq_writeback').length));
    eq(log[log.length - 1].id, 'QA-R39');
    // Two days on, finished ones are dropped (the ones waiting for a retry stay, for a run to give up on)
    w.g.clock.now += 3 * 24 * 3600e3;
    save({ id: 'QA-NEW', k: 'decided', t: w.g.clock.now, n: 1, at: w.g.clock.now, d: ['alerts'], s: 'ok' });
    eq(memoLog(w).filter(e => e.s !== 'retry').map(e => e.id), ['QA-NEW']);

    // Retries: 3 per run at most, oldest first; none with under 30 seconds left in the run
    const v = liveWorld();
    v.g.bq.answer = () => ({ code: 403, body: 'down' });
    ['QA-1', 'QA-2', 'QA-3', 'QA-4', 'QA-5'].forEach((id, i) => {
      v.backend.alerts.push(Object.assign(resultsRow(id, 'spaces/BURSON > spaces/ANALYST', 'a', NOW), {
        forwarded_fields: { post_url: `https://x.com/u${i}/status/2000000000000${i}`, product: 'Search' }, decision: '❌ P2' }));
    });
    const vctx = () => Object.assign(v.ctx(), { switches: ON });
    ['QA-1', 'QA-2', 'QA-3', 'QA-4', 'QA-5'].forEach(id => v.bot.bqWriteBack_(vctx(), v.backend.alerts.find(r => r.alert_id === id), 'decided', {}));
    eq(inserts(v.g).length, 5);
    v.g.clock.now += 5 * MIN;
    v.bot.retryBqWriteBacks_(Object.assign(vctx(), { deadline: v.g.clock.now + 20 * 1000 }), {});
    eq(inserts(v.g).length, 5);  // under 30 seconds left: none
    v.bot.retryBqWriteBacks_(vctx(), {});
    eq(inserts(v.g).map(c => c.body.rows[0].insertId).slice(5), ['QA-1:decided', 'QA-2:decided', 'QA-3:decided']);
    v.bot.retryBqWriteBacks_(vctx(), {});
    eq(inserts(v.g).length, 10);  // the other two (the first three aren't due yet)
    eq(memoLog(v).map(e => [e.id, e.n]), [['QA-1', 2], ['QA-2', 2], ['QA-3', 2], ['QA-4', 2], ['QA-5', 2]]);
    // An alert that isn't this flow's any more (the Control tab points at other spaces): dropped, never written
    v.backend.alerts.splice(0, 1);
    v.g.clock.now += 5 * MIN;
    v.bot.retryBqWriteBacks_(vctx(), {});
    eq([memoLog(v).map(e => e.id).includes('QA-1'), inserts(v.g).filter(c => c.body.rows[0].insertId === 'QA-1:decided').length],
      [false, 2]);
  });

  test('write-back: the Results tab never takes the bot\'s own rows for the IMs\': a bot-marked draft changes nothing, and the SLRR log is read without the bot\'s rows (the same query otherwise, with the same parameters)', () => {
    const T = NOW - 2 * 86400e3;
    const MAIN = 'spaces/MIRROR > (isolated)';
    const AC = 'spaces/AAQAaa_0I9g > spaces/AUTOFIX (auto-correct)';
    const flows = { main: { partition: MAIN, label: 'Mirror space' }, ac: { partition: AC, label: 'Auto-correct space' } };
    const drafts = () => [
      { post_url: 'https://x.com/auser/status/20001', at: T + 20 * MIN, subject: '⭐ SOCIAL ALERT ⭐: Gemini App | Issue A | X | 5000 Engagements', drafted_by: 'im1@ops.test' },
      { post_url: 'https://x.com/buser/status/20002', at: T + 90 * MIN, subject: '⭐ SOCIAL ALERT ⭐: Search | Issue B | X | 300 Engagements', drafted_by: 'im2@ops.test' },
    ];
    // The bot's own Social Alerts, as Write back to SLRR BigQuery logs them: for a post only the bot alerted (c), and for
    // one the IMs alerted later (b)
    const botDrafts = () => drafts().concat([
      { post_url: 'https://x.com/cuser/status/20003', at: T + 123 * MIN, subject: 'SOCIAL ALERT: Search | Issue C', drafted_by: MARK },
      { post_url: 'https://x.com/buser/status/20002', at: T + 61 * MIN, subject: 'SOCIAL ALERT: Search | Issue B', drafted_by: ' Burson-QA-Bot ' },
    ]);
    const logged = () => [{ url: 'https://x.com/duser/status/20004', day: H.B.etDay_(T) }];
    const tab = (d) => {
      const w = world();
      const ss = w.g.services.SpreadsheetApp.create('bot');
      const out = w.bot.refreshSpeed_(ss, w.ctx(), { alerts: resultsRows(), drafts: d, logged, flows });
      return { rows: ss.getSheetByName('Results').rows, facts: out.facts };
    };
    eq(tab(botDrafts), tab(drafts));
    const posts = H.B.speedPosts_(resultsRows(), botDrafts(), logged(), flows);
    eq(posts.find(p => p.key === 'x:20003').im_draft, null);
    eq(posts.find(p => p.key === 'x:20002').im_draft.by, 'im2@ops.test');
    eq(H.B.resultsHumanDrafts_(botDrafts()).map(d => d.drafted_by), ['im1@ops.test', 'im2@ops.test']);
    eq([H.B.resultsHumanDrafts_(null), H.B.resultsHumanDrafts_([null, { drafted_by: '' }])], [[], [{ drafted_by: '' }]]);

    // The SLRR log read, once the bot has written: the bot's rows left out, nothing else changed
    const w = world();
    fakeBq(w.g);
    w.g.props.set('BQ_WRITEBACK_EVER', 'true');
    w.bot.speedLogged_(NOW - 86400e3, {});
    const [q] = w.g.bq.calls;
    eq(q.body.query, 'SELECT url, FORMAT_TIMESTAMP("%F", SAFE_CAST(date_added AS TIMESTAMP), "America/New_York") AS day FROM ' +
      '`brand-social-central-data.slrr_alerts.slrr_alerts` WHERE url IS NOT NULL AND SAFE_CAST(date_added AS TIMESTAMP) BETWEEN ' +
      `TIMESTAMP_MILLIS(@since) AND TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) AND ${NOT_BOT} LIMIT 20000`);
    eq(q.body.queryParameters, [{ name: 'since', parameterType: { type: 'INT64' }, parameterValue: { value: String(NOW - 86400e3) } }]);
    eq(H.B.bqNotBotRowSql_(), NOT_BOT);
    eq(H.B.bqNotBotRowSql_('s'), NOT_BOT.replace('(identifier_analyst', '(s.identifier_analyst').replace('(source_tab', '(s.source_tab'));
  });

  test('write-back: the bot\'s own reads of the SLRR log (already alerted, the author\'s earlier alerts, alerts this post replies under) leave its rows out once it has written, with the same parameters as before', () => {
    const w = world();
    fakeBq(w.g);
    w.g.props.set('BQ_WRITEBACK_EVER', 'true');
    w.bot.enrichAlertFromBigQuery_({ fields: { post_url: 'https://x.com/someone/status/2111814207448514693', author: '@someone',
      issue_name: 'An issue' }, post: { thread_ids: ['2111814207448514000'] } }, {});
    const q = w.g.bq.calls.find(c => /slrr_alerts\.slrr_alerts/.test(c.body.query));
    assert.ok(q);
    eq(q.body.query.split(NOT_BOT).length - 1, 3);
    ['slrr AS (', 'author_alerts AS (', 'related_alerts AS ('].forEach(cte => {
      const part = q.body.query.split(cte)[1].split('\n),')[0];
      assert.ok(part.includes(`AND ${NOT_BOT}`), cte);
    });
    eq(q.body.queryParameters.map(p => p.name), ['url', 'post_id', 'author', 'related_ids', 'query_text', 'comment_noise_rx']);
    eq(writes(w.g), []);
  });

  test('write-back: what goes in (pure): text values only, no link no row, testing only a send; insertAll\'s request and how a refusal reads', () => {
    const w = liveWorld();
    const B = w.bot;
    const live = Object.assign(w.ctx(), { switches: ON });
    const row = { alert_id: 'QA-7', email_subject: 'S', email_sent_at: NOW, forwarded_fields: { post_url: 'https://x.com/a/status/12345678',
      author: '@a', total_engagement: 'lots', summary: ' ' }, email_input: { fields: { issue_name: 'From the email', product: 'Search' } } };
    const rows = B.bqWriteBackRows_(live, row, 'sent', NOW, '👍 ⬇️ 📰 📦 📰 ❌ ✍️ 💼 🌎');
    eq(rows.map(r => [r.table, r.code, r.insertId]), [[SENDS, 'sends', 'QA-7:sent'], [ALERTS, 'alerts', 'QA-7:sent']]);
    eq(rows[1].json, { url: 'https://x.com/a/status/12345678', date_added: iso(NOW), ingestion_timestamp: iso(NOW), record_id: 'QA-7',
      identifier_analyst: MARK, source_tab: MARK, author_handle: '@a', issue_name: 'From the email', product: 'Search',
      google_emoji_1: '📰', google_emoji_2: '📦', google_emoji_3: '❌', google_emoji_4: '✍️', google_emoji_5: '💼' });
    eq(B.bqWriteBackRows_(live, Object.assign({}, row, { forwarded_fields: {}, email_input: {} }), 'sent', NOW, ''), []);
    eq(B.bqWriteBackRows_(live, Object.assign({}, row, { alert_id: '' }), 'sent', NOW, ''), []);
    eq(B.bqWriteBackRows_(live, row, 'decided', NOW, '').map(r => r.table), [ALERTS]);
    const testing = Object.assign(w.ctx(), { switches: ON, sourceReadOnly: true });  // the auto-correct flow: always Testing
    eq(B.bqWriteBackRows_(testing, row, 'decided', NOW, ''), []);
    eq(B.bqWriteBackRows_(testing, row, 'sent', NOW, '').map(r => [r.table, r.json.environment]), [[SENDS, 'TEST']]);
    const mirror = Object.assign(w.ctx(), { switches: ON, outboundBlocked: true });  // the Mirror space, the run LIVE
    eq(B.bqWriteBackRows_(mirror, row, 'decided', NOW, '').map(r => r.table), [ALERTS]);
    eq(B.bqWriteBackEmojis_(''), []);

    // The request, and what a refusal says
    B.bqInsertAll_(SENDS, [{ insertId: 'QA-7:sent', json: { post_url: 'u' } }]);
    eq(w.g.bq.calls.map(c => [c.url, c.method, c.body]), [[BQ_HOST + 'datasets/slrr_feedback/tables/alert_sends/insertAll', 'post',
      { kind: 'bigquery#tableDataInsertAllRequest', skipInvalidRows: false, ignoreUnknownValues: false, rows: [{ insertId: 'QA-7:sent', json: { post_url: 'u' } }] }]]);
    const refused = answer => { w.g.bq.answer = () => answer; try { B.bqInsertAll_(ALERTS, []); return ''; } catch (e) { return e.message; } };
    eq([refused({ code: 403, body: { error: { message: 'Access Denied' } } }),
      refused({ code: 200, body: { insertErrors: [{ index: 0, errors: [{ reason: 'stopped' }] }, { index: 1, errors: [{ reason: 'invalid', message: 'no such field: x.' }] }] } }),
      refused({ code: 200, body: 'not json' }), refused({ code: 200, body: { kind: 'bigquery#tableDataInsertAllResponse' } })], [
      'BigQuery write HTTP 403: {"error":{"message":"Access Denied"}}', 'BigQuery refused the row: invalid: no such field: x.',
      'BigQuery write: an answer it couldn\'t read (not json)', '']);
    assert.throws(() => B.bqInsertAll_('alert_sends', []), /isn't a dataset\.table/);
    eq(B.bqWriteBackNoteText_({ day: '2026-10-14', live: 2, test: 1, last: 'QA-1 (sent) at x' }, false),
      '2 written on 2026-10-14 (+1 TEST) · last QA-1 (sent) at x');
    eq(B.bqWriteBackNoteText_({ day: '2026-10-14', live: 0, test: 0, problem: '⚠️ p' }, true),
      'testing: only sent alerts, as TEST rows in alert_sends; nothing in slrr_alerts · ⚠️ p · 0 on 2026-10-14');
    // OFF: the entry points do nothing at all (not even read the memory)
    const touched = [];
    const off = Object.assign(w.ctx(), { memo: { get: k => { touched.push(k); return null; }, set: k => touched.push(k) } });
    eq([B.bqWriteBack_(off, row, 'decided', {}), B.bqWriteBackSent_(off, row, {}), B.retryBqWriteBacks_(off, {}), touched], [false, false, undefined, []]);
  });

  test('write-back ON, end to end while testing (poll() and the Control tab): the stand-in\'s Social Alert goes in as one TEST row, the Alert log has bq_written, ❌ writes nothing, and C16 says what goes in', () => {
    const t = e2e();
    fakeBq(t.g);
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.control().getRange(16, 2).setValue('ON');
    t.poll();
    assert.match(t.control().cell(16, 3), /^✓ ON: finalized alerts and sends are written to the shared SLRR BigQuery tables · testing: only sent alerts, as TEST rows in alert_sends; nothing in slrr_alerts · 0 on 2026-10-14$/);
    t.chat.say(TEST_FEED, F.MISTAKES, { sender: 'users/bot' });
    t.chat.say(TEST_FEED, MAPS_LOW_OK, { sender: 'users/bot' });
    t.poll();
    t.poll();
    eq(t.g.gmail.sentMessages().map(m => m.to), [['tester@testing.test']]);
    eq(inserts(t.g).map(c => [c.table, c.body.rows[0].json.environment, c.body.rows[0].json.drafted_by]), [[SENDS, 'TEST', MARK]]);
    eq(writes(t.g).length, 1);
    const log = t.sheet().getSheetByName('Alert log');
    const col = log.rows[0].indexOf('bq_written');
    const status = log.rows[0].indexOf('email_status');
    eq(log.rows.slice(1).map(r => [r[status], Number(r[col]) > 0]), [['sent', true], ['', false]]);
    assert.match(t.control().cell(16, 3), /^✓ ON: .* · testing: only sent alerts, as TEST rows in alert_sends; nothing in slrr_alerts · 1 on 2026-10-14 · last QA-\d+ \(sent\) at Oct 14, /);
    assert.match(t.get('B5'), /^✅ Working/);
    t.poll();
    eq(inserts(t.g).length, 1);
  });

  const refuseOnce = g => {
    let n = 1;
    g.bq.answer = call => (n-- > 0 ? { code: 400, body: { error: { message: 'Bad request' } } } : null);
  };

  test('write-back ON: a retry writes the alert as the run that finished it was (live or testing), never as the run that retries it: a stand-in\'s send stays TEST and out of slrr_alerts after going live, and a live alert still goes in slrr_alerts after a stand-in is back', () => {
    // A: the stand-in's send refused; the switch OFF and ON again, the stand-in cleared and live drafts before the retry
    const t = testWorld();
    refuseOnce(t.g);
    t.paste(F.P0_OK);
    runWith(t, { switches: ON });
    eq([inserts(t.g).map(c => [c.table, c.body.rows[0].json.environment]), memoLog(t).map(e => [e.s, e.n, e.l])],
      [[[SENDS, 'TEST']], [['retry', 1, 0]]]);
    runWith(t, {});
    t.bot.ev('GEN').email.stand_in = '';
    t.g.clock.now += 5 * MIN;
    const r = runWith(t, { switches: ON, drafts: LIVE });
    eq(inserts(t.g).map(c => [c.table, c.body.rows[0].json.environment]), [[SENDS, 'TEST'], [SENDS, 'TEST']]);
    eq([rowsIn(t.g, ALERTS), r.bq_written, memoLog(t)[0].s, Number(t.alertRows()[0].bq_written) > 0], [[], 1, 'ok', true]);

    // B: a live ❌ refused; a stand-in is back before the retry: it still goes in the SLRR log, once
    const w = liveWorld();
    refuseOnce(w.g);
    w.paste(MAPS_LOW_OK);
    runWith(w, { switches: ON });
    eq(memoLog(w).map(e => [e.id, e.s, e.l]), [['QA-1001', 'retry', 1]]);
    w.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    w.g.clock.now += 5 * MIN;
    const r2 = runWith(w, { switches: ON });
    eq(inserts(w.g).map(c => [c.table, c.body.rows[0].insertId]), [[ALERTS, 'QA-1001:decided'], [ALERTS, 'QA-1001:decided']]);
    eq([r2.bq_written, memoLog(w)[0].s, Number(w.alertRows()[0].bq_written) > 0], [1, 'ok', true]);
    w.g.clock.now += 10 * MIN;
    runWith(w, { switches: ON });
    eq(inserts(w.g).length, 2);

    // A note from before the run's kind was kept (no l), with nothing this run can write: given up, saying so, never
    // quietly marked as written
    const o = liveWorld();
    refuseOnce(o.g);
    o.paste(MAPS_LOW_OK);
    runWith(o, { switches: ON });
    o.ctx().memo.set('bq_writeback', JSON.stringify(memoLog(o).map(e => { delete e.l; return e; })));
    o.bot.ev('GEN').email.stand_in = 'tester@testing.test';
    o.g.clock.now += 5 * MIN;
    const r3 = runWith(o, { switches: ON });
    eq([inserts(o.g).length, memoLog(o)[0].s, r3.bq_written, o.alertRows()[0].bq_written], [1, 'gave_up', undefined, undefined]);
    eq(r3.notices, ['Couldn\'t write QA-1001 back to the SLRR BigQuery tables: it was finished in a live run and this run is ' +
      'testing. It\'s in the Alert log only.']);
    assert.match(switchNote(o), /^testing: .* · ⚠️ gave up on QA-1001 \(nothing this run can write\) · 0 on 2026-10-14$/);
  });

  test('write-back ON: an alert left waiting for a retry (the switch turned OFF meanwhile) is never dropped quietly: after 2 days it\'s given up, saying so on C16, and never written that late, whatever else finishes first in the run', () => {
    [false, true].forEach(otherFirst => {
      const w = liveWorld();
      refuseOnce(w.g);
      w.paste(MAPS_LOW_OK);
      runWith(w, { switches: ON });  // QA-1001 refused: waits for a retry
      runWith(w, {});  // the switch is turned OFF
      w.g.clock.now += 3 * 24 * 3600e3;
      if (otherFirst) {  // back ON 3 days later, and another alert finishes in that run before the retries
        w.vertex.assess = VETO;
        w.paste(F.AIO);
      }
      runWith(w, { switches: ON });
      const name = otherFirst ? 'another alert first' : 'only the retry';
      eq(inserts(w.g).map(c => c.body.rows[0].insertId), ['QA-1001:decided'].concat(otherFirst ? ['QA-1002:decided'] : []), name);
      eq(memoLog(w).map(e => [e.id, e.s]).sort(), [['QA-1001', 'gave_up']].concat(otherFirst ? [['QA-1002', 'ok']] : []), name);
      assert.match(switchNote(w), /^⚠️ gave up on QA-1001 \(too old\) · /, name);
      assert.ok(!w.alertRows()[0].bq_written, name);
      w.g.clock.now += 10 * MIN;
      runWith(w, { switches: ON });
      eq(inserts(w.g).length, otherFirst ? 2 : 1, name);
    });
    // Finished ones are still dropped after 2 days; the ones waiting are kept until a run gives up on them
    const v = liveWorld();
    const ctx = () => Object.assign(v.ctx(), { switches: ON });
    v.bot.saveBqWriteBack_(ctx(), { id: 'QA-OK', k: 'decided', t: NOW, n: 1, at: NOW, d: ['alerts'], s: 'ok', l: 1 });
    v.bot.saveBqWriteBack_(ctx(), { id: 'QA-WAIT', k: 'decided', t: NOW, n: 1, at: NOW, d: [], s: 'retry', l: 1 });
    v.g.clock.now += 3 * 24 * 3600e3;
    v.bot.saveBqWriteBack_(ctx(), { id: 'QA-NEW', k: 'decided', t: v.g.clock.now, n: 1, at: v.g.clock.now, d: ['alerts'], s: 'ok', l: 1 });
    eq(memoLog(v).map(e => e.id), ['QA-WAIT', 'QA-NEW']);
  });

  test('write-back ON live: a write whose answer was lost (the connection dropped, or an HTTP 5xx: BigQuery may have the row) is sent once more at once, while BigQuery still drops a repeat; a later try first looks for the row, so it never goes in twice', () => {
    // The answer lost twice (BigQuery did take the row): 5 minutes later the bot finds it and writes nothing more
    const w = liveWorld();
    fakeTables(w.g, { [ALERTS]: ['lost', 'lost'] });
    w.paste(MAPS_LOW_OK);
    const r1 = runWith(w, { switches: ON });
    eq([inserts(w.g).length, w.g.bq.rows.length, r1.bq_written, memoLog(w).map(e => [e.s, e.n, e.d, e.u])],
      [2, 1, undefined, [['retry', 1, [], ['alerts']]]]);
    w.g.clock.now += 5 * MIN;
    const r2 = runWith(w, { switches: ON });
    eq([inserts(w.g).length, w.g.bq.rows.length, w.g.bq.checks.length, r2.bq_written, memoLog(w)[0].s, memoLog(w)[0].d],
      [2, 1, 1, 1, 'ok', ['alerts']]);
    const [check] = w.g.bq.checks;
    eq(check.url, BQ_HOST + 'queries');
    eq(check.body.query, 'SELECT 1 FROM `brand-social-central-data.slrr_alerts.slrr_alerts` WHERE CAST(record_id AS STRING) = @id ' +
      'AND CAST(identifier_analyst AS STRING) = @mark LIMIT 1');
    eq(check.body.queryParameters.map(p => [p.name, p.parameterValue.value]), [['id', 'QA-1001'], ['mark', MARK]]);
    assert.ok(Number(w.alertRows()[0].bq_written) > 0);
    eq(writes(w.g).length, 2);  // the look is a read
    w.g.clock.now += 10 * MIN;
    runWith(w, { switches: ON });
    eq([inserts(w.g).length, w.g.bq.rows.length], [2, 1]);

    // A 503 after BigQuery took it, then the quick second send: one row, written in this run, nothing to look for later
    const v = liveWorld();
    fakeTables(v.g, { [ALERTS]: ['503'] });
    v.paste(MAPS_LOW_OK);
    const rv = runWith(v, { switches: ON });
    eq([inserts(v.g).length, v.g.bq.rows.length, rv.bq_written, memoLog(v).map(e => [e.s, e.n, e.u])], [2, 1, 1, [['ok', 1, undefined]]]);
    v.g.clock.now += 10 * MIN;
    runWith(v, { switches: ON });
    eq([inserts(v.g).length, v.g.bq.checks.length], [2, 0]);

    // The answer lost only after 40 seconds: not sent again at once (BigQuery may no longer drop a repeat); looked for later
    const z = liveWorld();
    fakeTables(z.g, { [ALERTS]: ['slow'] });
    z.paste(MAPS_LOW_OK);
    runWith(z, { switches: ON });
    eq([inserts(z.g).length, z.g.bq.rows.length, memoLog(z).map(e => [e.s, e.u])], [1, 1, [['retry', ['alerts']]]]);
    z.g.clock.now += 5 * MIN;
    runWith(z, { switches: ON });
    eq([inserts(z.g).length, z.g.bq.rows.length, z.g.bq.checks.length, memoLog(z)[0].s], [1, 1, 1, 'ok']);

    // A sent one: alert_sends' answer lost twice, then found by its send time; slrr_alerts goes in once
    const s = liveWorld();
    fakeTables(s.g, { [SENDS]: ['lost', 'lost'] });
    s.paste(F.P0_OK);
    runWith(s, { switches: ON });
    s.gmail.send(s.gmail.allDrafts()[0].id, 'im@ops.test', '<lost@mail.test>');
    runWith(s, { switches: ON });
    eq([inserts(s.g).map(c => c.table), memoLog(s)[0].u], [[SENDS, SENDS], ['sends']]);
    s.g.clock.now += 5 * MIN;
    runWith(s, { switches: ON });
    const sent = s.alertRows()[0];
    eq(inserts(s.g).map(c => c.table), [SENDS, SENDS, ALERTS]);
    eq(s.g.bq.rows.map(x => [x.table, x.insertId]), [[SENDS, `${sent.alert_id}:sent`], [ALERTS, `${sent.alert_id}:sent`]]);
    eq(s.g.bq.checks[0].body.query, 'SELECT 1 FROM `brand-social-central-data.slrr_feedback.alert_sends` WHERE CAST(drafted_by AS STRING) = ' +
      '@mark AND post_url = @url AND UNIX_MILLIS(draft_created_at) = @ms LIMIT 1');
    eq(s.g.bq.checks[0].body.queryParameters.map(p => [p.name, p.parameterType.type, p.parameterValue.value]),
      [['mark', 'STRING', MARK], ['url', 'STRING', P0_LINK], ['ms', 'INT64', String(sent.email_sent_at)]]);
    eq([memoLog(s)[0].s, memoLog(s)[0].d, Number(sent.bq_written) > 0], ['ok', ['sends', 'alerts'], true]);
  });

  test('write-back ON live: when the bot can\'t look for a row whose answer was lost, it counts the try and sends nothing; it sends only once the look says BigQuery hasn\'t got it, and gives up saying the row may be there', () => {
    const w = liveWorld();
    fakeTables(w.g, { [ALERTS]: ['down', 'down'] });  // not taken, but the bot can't know
    w.paste(MAPS_LOW_OK);
    runWith(w, { switches: ON });
    eq([inserts(w.g).length, memoLog(w)[0].u], [2, ['alerts']]);
    w.g.bq.checkFails = 1;
    w.g.clock.now += 5 * MIN;
    const r2 = runWith(w, { switches: ON });
    eq([inserts(w.g).length, w.g.bq.checks.length, r2.bq_written, memoLog(w)[0].s, memoLog(w)[0].n], [2, 1, undefined, 'retry', 2]);
    assert.match(memoLog(w)[0].e, /^couldn't check whether slrr_alerts\.slrr_alerts has it already: BigQuery HTTP 500/);
    w.g.clock.now += 5 * MIN;
    const r3 = runWith(w, { switches: ON });
    eq([inserts(w.g).length, w.g.bq.rows.length, w.g.bq.checks.length, r3.bq_written, memoLog(w)[0].s, memoLog(w)[0].n],
      [3, 1, 2, 1, 'ok', 3]);

    // Never able to look: given up after 3 tries, with no second row, and the Status says BigQuery may have it
    const v = liveWorld();
    fakeTables(v.g, { [ALERTS]: ['lost', 'lost'] });
    v.paste(MAPS_LOW_OK);
    runWith(v, { switches: ON });
    v.g.bq.checkFails = 5;
    v.g.clock.now += 5 * MIN;
    runWith(v, { switches: ON });
    v.g.clock.now += 5 * MIN;
    const rv = runWith(v, { switches: ON });
    eq([inserts(v.g).length, v.g.bq.rows.length, memoLog(v)[0].s, memoLog(v)[0].n], [2, 1, 'gave_up', 3]);
    eq(rv.notices.length, 1);
    assert.match(rv.notices[0], /^Couldn't write QA-1001 back to the SLRR BigQuery tables after 3 tries \(couldn't check .*\)\. It may be in slrr_alerts \(BigQuery's answer was lost\): check before adding it by hand\.$/);

    // A run that stopped during the insert (BigQuery took it): the next try looks first, and finds it
    const t = liveWorld();
    fakeTables(t.g, {});
    t.paste(MAPS_LOW_OK);
    runWith(t, {});
    const row = t.alertRows()[0];
    const at = t.g.clock.now;
    t.ctx().memo.set('bq_writeback', JSON.stringify([{ id: row.alert_id, k: 'decided', t: at, n: 1, at, d: [], s: 'trying', l: 1 }]));
    t.g.bq.rows.push({ table: ALERTS, insertId: `${row.alert_id}:decided`, json: { record_id: row.alert_id, identifier_analyst: MARK,
      url: row.forwarded_fields.post_url }, at });
    t.g.clock.now += 5 * MIN;
    const rt = runWith(t, { switches: ON });
    eq([inserts(t.g).length, t.g.bq.checks.length, t.g.bq.rows.length, rt.bq_written, memoLog(t)[0].s, memoLog(t)[0].d],
      [0, 1, 1, 1, 'ok', ['alerts']]);

    // A clear refusal (HTTP 4xx, insertErrors) isn't sent again at once, and the next try doesn't look first
    const c = liveWorld();
    fakeTables(c.g, { [ALERTS]: ['400'] });
    c.paste(MAPS_LOW_OK);
    runWith(c, { switches: ON });
    eq([inserts(c.g).length, memoLog(c)[0].u], [1, undefined]);
    c.g.clock.now += 5 * MIN;
    runWith(c, { switches: ON });
    eq([inserts(c.g).length, c.g.bq.checks.length, c.g.bq.rows.length, memoLog(c)[0].s], [2, 0, 1, 'ok']);
  });

  test('write-back: insertAll\'s answers the bot can\'t be sure of (a dropped connection, HTTP 5xx, a 2xx it can\'t read) are marked as such; a 4xx or insertErrors is a plain refusal', () => {
    const w = liveWorld();
    const B = w.bot;
    const outcome = answer => {
      w.g.bq.answer = () => answer;
      try { B.bqInsertAll_(ALERTS, [{ insertId: 'QA-1:decided', json: { url: 'u' } }]); return 'taken'; } catch (e) {
        return `${e.unknown ? 'unknown' : 'refused'}: ${e.message}`;
      }
    };
    eq([outcome('throw'), outcome({ code: 500, body: 'x' }), outcome({ code: 503, body: 'Service Unavailable' }),
      outcome({ code: 200, body: 'not json' }), outcome({ code: 403, body: 'Access Denied' }), outcome({ code: 400, body: 'Bad' }),
      outcome({ code: 200, body: { insertErrors: [{ index: 0, errors: [{ reason: 'invalid', message: 'no such field: x.' }] }] } }),
      outcome(null)], [
      `unknown: Address unavailable: ${BQ_HOST}datasets/slrr_alerts/tables/slrr_alerts/insertAll`,
      'unknown: BigQuery write HTTP 500: x', 'unknown: BigQuery write HTTP 503: Service Unavailable',
      'unknown: BigQuery write: an answer it couldn\'t read (not json)', 'refused: BigQuery write HTTP 403: Access Denied',
      'refused: BigQuery write HTTP 400: Bad', 'refused: BigQuery refused the row: invalid: no such field: x.', 'taken']);
    // What the Status says when it gives up: which tables have the alert, may have it, or don't
    const where = (d, u, codes) => B.bqWriteBackWhere_({ d, u }, codes);
    eq([where([], undefined, ['alerts']), where(['sends'], [], ['sends', 'alerts']), where(['sends'], ['alerts'], ['sends', 'alerts']),
      where([], ['sends'], ['sends', 'alerts']), where([], [], ['sends'])], [
      'It\'s in the Alert log only.', 'It\'s in alert_sends, not in slrr_alerts.',
      'It\'s in alert_sends, may be in slrr_alerts (BigQuery\'s answer was lost): check before adding it by hand.',
      'It may be in alert_sends (BigQuery\'s answer was lost), not in slrr_alerts: check before adding it by hand.',
      'It\'s in the Alert log only.']);
  });

  test('write-back: until the bot has sent its first write, its reads of the SLRR log are exactly as before (no bot-row filter in the SQL); from then on they leave its rows out, even with the switch OFF again', () => {
    const PRE = 'SELECT url, FORMAT_TIMESTAMP("%F", SAFE_CAST(date_added AS TIMESTAMP), "America/New_York") AS day FROM ' +
      '`brand-social-central-data.slrr_alerts.slrr_alerts` WHERE url IS NOT NULL AND SAFE_CAST(date_added AS TIMESTAMP) BETWEEN ' +
      'TIMESTAMP_MILLIS(@since) AND TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) LIMIT 20000';
    const w = liveWorld();
    const reads = () => {
      w.g.bq.calls.length = 0;
      w.bot.speedLogged_(NOW - 86400e3, {});
      w.bot.enrichAlertFromBigQuery_({ fields: { post_url: 'https://x.com/someone/status/2111814207448514693', author: '@someone',
        issue_name: 'An issue' }, post: { thread_ids: ['2111814207448514000'] } }, {});
      return w.g.bq.calls.filter(c => /slrr_alerts\.slrr_alerts/.test(c.body.query || '')).map(c => c.body.query);
    };
    // OFF, end to end: nothing written, and the flow's reads have no filter
    liveFlow(w, {});
    const [logged, enriched] = reads();
    eq([logged, enriched.includes(MARK), w.g.props.has('BQ_WRITEBACK_EVER')], [PRE, false, false]);
    // The first write (switch ON): the same reads, each slrr_alerts part with the filter as one more line
    w.paste(p0(3));
    runWith(w, { switches: ON });
    eq(w.g.props.has('BQ_WRITEBACK_EVER'), false);  // a draft: nothing written yet
    w.gmail.send(w.gmail.allDrafts().find(d => d.text.includes(linkOf(3))).id, 'im@ops.test', '<first@mail.test>');
    runWith(w, { switches: ON });
    eq([inserts(w.g).map(c => c.table), w.g.props.get('BQ_WRITEBACK_EVER')], [[SENDS, ALERTS], 'true']);
    const [logged2, enriched2] = reads();
    eq(logged2, PRE.replace(' LIMIT 20000', ` AND ${NOT_BOT} LIMIT 20000`));
    eq([enriched2.split(NOT_BOT).length - 1, enriched2.split(`\n      AND ${NOT_BOT}`).join('')], [3, enriched]);
    // Switched OFF again: the bot's rows are still left out
    runWith(w, {});
    eq(reads(), [logged2, enriched2]);
  });
};
