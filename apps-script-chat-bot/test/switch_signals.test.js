// Signals (Signals.gs) and the watchdog (Watchdog.gs): the two-track SLRR system's side on the bot's sheet. A bot-made
// "Signals" tab whose settings all start OFF: sync to BigQuery (taxonomy from the Watch tags tab, alert history, ratings),
// the Track 1 (shadow) and Radar tabs, the daily archive of old rows (copied, checked, then trimmed), the long memory for
// analyst answers, and a watchdog that notices (and, when ON, pauses) a background step that keeps getting runs stopped.
// Nothing here posts in Chat or emails anyone.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, e2e } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const TAB = 'Signals';
  const tab = (t, name) => t.sheet().getSheetByName(name);
  const setting = (t, key, v) => tab(t, TAB).getRange(3 + B.ev('SIG_ROWS_').findIndex(r => r[0] === key), 2).setValue(v);
  const status = (t, key) => tab(t, TAB).cell(3 + B.ev('SIG_ROWS_').findIndex(r => r[0] === key), 3);

  /**
   * A fake BigQuery for Signals: queries answer `bq.answer(sql, params)` (rows), inserts (tabledata.insertAll) are kept
   * in bq.inserts[table] (with insert ids); every call is recorded. bq.refuse: insert errors to return.
   */
  function fakeBq(g) {
    const bq = { queries: [], inserts: {}, ids: {}, answer: () => [], refuse: null };
    const prev = g.services.UrlFetchApp.fetch;
    const resp = (code, body) => ({ getResponseCode: () => code, getHeaders: () => ({}), getContentText: () => JSON.stringify(body) });
    g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      if (!url.startsWith('https://bigquery.googleapis.com/')) return prev(link, params);
      const body = params && params.payload ? JSON.parse(params.payload) : {};
      const ins = url.match(/\/datasets\/slrr_signals\/tables\/([a-z_]+)\/insertAll$/);
      if (ins) {
        if (bq.refuse) return resp(200, { insertErrors: bq.refuse });
        (bq.inserts[ins[1]] = bq.inserts[ins[1]] || []).push(...body.rows.map(r => r.json));
        (bq.ids[ins[1]] = bq.ids[ins[1]] || []).push(...body.rows.map(r => r.insertId));
        return resp(200, {});
      }
      if (/\/queries$/.test(url)) {
        const p = Object.fromEntries((body.queryParameters || []).map(q => [q.name, q.parameterValue.value !== undefined
          ? q.parameterValue.value : (q.parameterValue.arrayValues || []).map(v => v.value)]));
        if (!/slrr_signals/.test(body.query || '')) return prev(link, params);
        bq.queries.push({ sql: body.query, params: p });
        const rows = bq.answer(body.query, p) || [];
        const names = rows.length ? Object.keys(rows[0]) : [];
        return resp(200, { jobComplete: true, schema: { fields: names.map(n => ({ name: n, type: typeof rows[0][n] === 'number' ? 'INTEGER'
          : typeof rows[0][n] === 'boolean' ? 'BOOLEAN' : 'STRING' })) },
          rows: rows.map(r => ({ f: names.map(n => ({ v: r[n] === null || r[n] === undefined ? null : String(r[n]) })) })) });
      }
      return prev(link, params);
    };
    return bq;
  }

  const world = () => {
    const t = e2e();
    t.bot.setup();
    return { t, bq: fakeBq(t.g) };
  };

  // ===========================================================================================================
  // The tab: made by the bot, every setting OFF; nothing else happens until a person turns one ON
  // ===========================================================================================================

  test('signals: the first run makes the Signals tab, every switch OFF with its ON/OFF dropdown and the days kept; with everything OFF nothing is sent to or read from BigQuery, no Track 1 or Radar tab is made, and nothing is trimmed; a "Signals" tab people made is never touched', () => {
    const { t, bq } = world();
    for (let i = 0; i < 3; i++) t.poll();
    const sh = tab(t, TAB);
    eq([sh.cell(1, 1), sh.rows[1]], [B.ev('SIG_TITLE_'), B.ev('SIG_HEADER_')]);
    eq(sh.rows.slice(2, 9).map(r => r.slice(0, 2)), [
      ['Sync taxonomy, alert history and ratings to BigQuery', 'OFF'], ['Show Track 1 and the radar on this sheet', 'OFF'],
      ['Archive old rows to BigQuery, then trim them here', 'OFF'], ['Archive: days of the Alert log kept on the sheet', 21],
      ['Archive: days of the Message log kept on the sheet', 14], ['Archive: days of the Relay tab kept on the sheet', 30],
      ['Pause a background step that keeps getting stuck (30 min)', 'OFF']]);
    eq(['3,2', '4,2', '5,2', '9,2'].map(k => sh.validations[k].values), [['ON', 'OFF'], ['ON', 'OFF'], ['ON', 'OFF'], ['ON', 'OFF']]);
    eq([bq.queries.length, Object.keys(bq.inserts).length, tab(t, 'Track 1 (shadow)'), tab(t, 'Radar')], [0, 0, null, null]);
    eq([status(t, 'sync'), status(t, 'archive')], ['OFF: nothing is sent to BigQuery', 'OFF: every row stays on the sheet']);
    assert.match(status(t, 'watchdog'), /^OFF: a step that keeps stopping runs is only reported here/);
    // once its statuses are there, an all-OFF tab costs no writes a run
    let writes = 0;
    const getRange = sh.getRange.bind(sh);
    sh.getRange = (...a) => {
      const r = getRange(...a);
      ['setValue', 'setValues'].forEach(m => { const f = r[m].bind(r); r[m] = v => { writes++; return f(v); }; });
      return r;
    };
    t.poll();
    eq(writes, 0);
    // someone's own "Signals" tab
    const other = world();
    const theirs = other.t.sheet().insertSheet(TAB);
    theirs.getRange(1, 1, 1, 2).setValues([['My', 'notes']]);
    other.t.poll();
    eq([theirs.rows, other.bq.queries.length], [[['My', 'notes']], 0]);
  });

  test('signals: while the bot is paused (B2 OFF) the Signals tab is still made, every setting OFF, so it can be set up first; nothing of it runs (no BigQuery, no other tab) until the bot is ON again', () => {
    const { t, bq } = world();
    t.set('B2', 'OFF');
    t.poll();
    const sh = tab(t, TAB);
    eq([sh.cell(1, 1), sh.rows.slice(2, 9).map(r => r[1])], [B.ev('SIG_TITLE_'), ['OFF', 'OFF', 'OFF', 21, 14, 30, 'OFF']]);
    setting(t, 'sync', 'ON');
    t.poll();
    eq([bq.queries.length, Object.keys(bq.inserts).length, status(t, 'sync')], [0, 0, 'OFF']);
    t.set('B2', 'ON');
    t.poll();
    eq(bq.inserts.taxonomy.length, 58, 'ON again: the sync runs');
  });

  test('signals: settings read ON only when they say ON; days below a tab\'s least count as it (the Alert log 15, as the bot\'s 14-day already-reported check reads the sheet; the others 7); blank or unreadable days are the defaults', () => {
    const S = B.sigSettingsOf_([['ON'], ['on '], ['yes'], [3], ['x'], [''], ['OFF']]);
    eq(S, { sync: true, show: true, archive: false, alertDays: 15, messageDays: 14, relayDays: 30, watchdog: false });
    eq(B.sigSettingsOf_(null).alertDays, 21);
    const T = B.sigSettingsOf_([['OFF'], ['OFF'], ['OFF'], [20], [3], [45], ['OFF']]);
    eq([T.alertDays, T.messageDays, T.relayDays], [20, 7, 45]);
  });

  // ===========================================================================================================
  // Sync
  // ===========================================================================================================

  test('signals sync (ON): the Watch tags tab goes to slrr_signals.taxonomy (every tag, ON or OFF, one version a change, again once a day), the Alert log\'s forwarded alerts updated since the last sync go to issue_history (each with its post, issue and tag), and ratings people gave go to feedback_corrections once each; at most every 10 minutes', () => {
    const { t, bq } = world();
    t.poll();
    setting(t, 'sync', 'ON');
    t.bot.sheetBackend_(t.sheet()).appendAlert({ alert_id: 'QA-1', created_at: t.g.clock.now - HOUR, updated_at: t.g.clock.now - HOUR,
      record_key: 'x.com/status/1', forward_message: 'spaces/A/messages/1', exposure_tag: 'Product - Dangerous results (e.g. medical/legal)',
      author: '@a', status: 'ok', email_status: 'sent', forwarded_fields: { issue_name: 'Gemini bleach advice', post_url: 'https://x.com/a/status/1',
        priority: 'P0', product: 'Gemini' } });
    t.bot.sheetBackend_(t.sheet()).appendAlert({ alert_id: 'QA-2', created_at: t.g.clock.now, updated_at: t.g.clock.now, record_key: 'x.com/status/2' });
    t.poll();
    eq(bq.inserts.taxonomy.length, 58);
    eq(Object.keys(bq.inserts.taxonomy[0]).sort(), ['also_known_as', 'description', 'is_on', 'kind', 'label', 'name', 'priority',
      'short_version', 'updated_at', 'updated_from', 'value', 'version']);
    eq([bq.inserts.taxonomy[0].kind, bq.inserts.taxonomy[0].updated_from, bq.inserts.taxonomy.every(r => r.is_on)], ['tag', 'watch_tags_tab', true]);
    eq(bq.inserts.issue_history.map(h => [h.alert_id, h.record_key, h.issue_name, h.priority, h.post_url, h.source, h.products]),
      [['QA-1', 'x.com/status/1', 'Gemini bleach advice', 'P0', 'https://x.com/a/status/1', 'alert_log', ['Gemini']]]);
    assert.match(status(t, 'sync'), /^✓ ON · .* ET: taxonomy 58 tags \(version [0-9a-f]{12}\), 1 alert to issue history, 0 ratings to feedback$/);
    // within 10 minutes: nothing again; after: only what changed (a tag switched OFF, a rating)
    t.poll();
    eq(bq.inserts.taxonomy.length, 58);
    const tags = tab(t, 'Watch tags');
    const row = tags.rows.findIndex(r => r[1] === 'Child Safety') + 1;
    tags.getRange(row, 6).setValue('OFF');
    t.g.clock.now += 11 * MIN;
    t.poll();
    eq([bq.inserts.taxonomy.length, bq.inserts.taxonomy.slice(58).filter(r => !r.is_on).map(r => r.name)], [116, ['Child Safety']]);
    eq(bq.inserts.issue_history.length, 1, 'nothing new in the Alert log');
  });

  // ===========================================================================================================
  // Show
  // ===========================================================================================================

  test('signals show (ON): the Track 1 (shadow) and Radar tabs from BigQuery, made after the Signals tab, warning-protected, the key column hidden; people\'s Review (a dropdown) is kept across refreshes and synced as feedback once; a tab of that name people made is left alone', () => {
    const { t, bq } = world();
    t.poll();
    setting(t, 'show', 'ON');
    setting(t, 'sync', 'ON');
    bq.answer = sql => (/v_track1_latest/.test(sql)
      ? [{ mention_key: 'x.com/status/1', classified_at: String(t.g.clock.now / 1000), qualifies: true, exposure_priority: 'P0',
        exposure_tag: 'Product - Dangerous results (e.g. medical/legal)', risk_tag: '', urgency: 'urgent', confidence: 0.93, track: 'URGENT',
        meets_requirements: true, post_url: 'https://x.com/a/status/1', platform: 'twitter', author: '@a', engagement: 3, source: 'sonar',
        issue_name: 'Gemini bleach advice', summary: 'An X user says Gemini told them to mix bleach and ammonia.', rationale: 'Dangerous.',
        rule_reasons: 'P0_HINT:keyword', web_context: 'Nothing public yet.' }]
      : /v_radar_latest/.test(sql)
        ? [{ cluster_id: 'ed:c1', assessed_at: String(t.g.clock.now / 1000), likelihood: 'high', action: 'promote',
          closest_tag: 'Product - Product failures - physical safety issues', closest_priority: 'P1', headline: 'Pixel batteries swelling',
          mentions: 9, authors: 7, velocity_ratio: 4, growth_per_hour: 2, platforms: 'reddit, twitter', post_urls: 'https://r/x',
          rationale: 'Spreading.', web_context: '', origin: 'early_detection' }]
        : []);
    t.poll();
    const t1 = tab(t, 'Track 1 (shadow)');
    const radar = tab(t, 'Radar');
    eq([t1.rows[0], radar.rows[0]], [B.ev('SIG_T1_HEADER_'), B.ev('SIG_RADAR_HEADER_')]);
    eq(t1.rows[1].slice(1, 10), ['Yes', 'P0', 'Product - Dangerous results (e.g. medical/legal)', '', 'urgent', 0.93, 'URGENT', 'Met',
      'https://x.com/a/status/1']);
    eq([t1.rows[1][20], radar.rows[1].slice(1, 6), radar.rows[1][16]], ['x.com/status/1',
      ['high', 'promote', 'Product - Product failures - physical safety issues', 'P1', 'Pixel batteries swelling'], 'ed:c1']);
    eq([t1.hidden, t1.protections[0].warningOnly, t1.validations['2,20'].values], [[21], true, B.ev('SIG_T1_REVIEWS_')]);
    const names = t.sheet().getSheets().map(s => s.getName());
    eq([names.indexOf('Track 1 (shadow)') - names.indexOf(TAB), names.indexOf('Radar') - names.indexOf(TAB)], [2, 1]);
    // a person's review: kept at the next refresh, sent as feedback once
    t1.getRange(2, 20).setValue('Correct');
    t.g.clock.now += 11 * MIN;
    t.poll();
    eq([t1.cell(2, 20), bq.inserts.feedback_corrections.map(f => [f.track, f.item_key, f.rating])], ['Correct',
      [['track1', 'x.com/status/1', 'Correct']]]);
    t.g.clock.now += 11 * MIN;
    t.poll();
    eq(bq.inserts.feedback_corrections.length, 1, 'once');
    // someone's own "Radar" tab
    const other = world();
    other.t.poll();
    const theirs = other.t.sheet().insertSheet('Radar');
    theirs.getRange(1, 1).setValue('Mine');
    other.t.sheet().getSheetByName(TAB).getRange(4, 2).setValue('ON');
    other.bq.answer = () => [];
    other.t.poll();
    eq(theirs.rows, [['Mine']]);
    assert.match(other.t.sheet().getSheetByName(TAB).cell(4, 3), /⚠️ a "Radar" tab people made is left alone/);
  });

  // ===========================================================================================================
  // Archive
  // ===========================================================================================================

  test('signals archive: only the oldest rows from row 2 down, all older than the cutoff, stopping at the first that isn\'t (or has no time), never more than the cap', () => {
    eq(B.sigArchivePrefix_([1, 2, 3, 10, 2], 5, 100), 3);
    eq(B.sigArchivePrefix_([1, 0, 2], 5, 100), 1);
    eq(B.sigArchivePrefix_([1, 2, 3], 5, 2), 2);
    eq(B.sigArchivePrefix_([9], 5, 100), 0);
    eq([B.sigMs_(new Date(5000)), B.sigMs_(1794358000000), B.sigMs_('2026-11-10T00:00:00Z'), B.sigMs_('')], [5000, 1794358000000, Date.parse('2026-11-10T00:00:00Z'), 0]);
  });

  test('signals archive (ON): once a day after 3 AM ET, the Alert log\'s, Message log\'s and Relay\'s rows older than their days kept are copied to slrr_signals.sheet_archive (each row whole, with its post and alert), counted there, and only then trimmed from the top; if BigQuery doesn\'t have them all, nothing is trimmed; OFF or before 3 AM, every row stays', () => {
    const { t, bq } = world();
    t.poll();
    const backend = t.bot.sheetBackend_(t.sheet());
    const now = Date.UTC(2026, 10, 11, 8, 30);  // the alerts' ages count from the archive's run below (3:30 AM ET, Nov 11)
    [40, 30, 22, 2].forEach((d, i) => backend.appendAlert({ alert_id: `QA-${i + 1}`, created_at: now - d * DAY, updated_at: now - d * DAY,
      record_key: `x.com/status/${i + 1}`, forwarded_fields: { issue_name: `issue ${i + 1}` } }));
    const log = tab(t, 'Alert log');
    const before = log.getLastRow();
    t.poll();
    eq(log.getLastRow(), before, 'OFF: nothing trimmed');
    setting(t, 'archive', 'ON');
    let sent = 0;
    bq.answer = (sql, p) => (/COUNT\(\*\) AS n FROM .*sheet_archive/.test(sql)
      ? [{ n: (bq.inserts.sheet_archive || []).filter(r => r.archive_batch === p.batch).length - sent }] : []);
    t.g.clock.now = Date.UTC(2026, 10, 11, 7, 30);  // 2:30 AM ET: not yet
    t.poll();
    eq([log.getLastRow(), bq.inserts.sheet_archive], [before, undefined]);
    assert.match(status(t, 'archive'), /^✓ ON: once a day after 3 AM ET \(last never\); keeps 21 days of the Alert log/);
    t.g.clock.now = Date.UTC(2026, 10, 11, 8, 30);  // 3:30 AM ET
    t.poll();
    const archived = bq.inserts.sheet_archive.filter(r => r.tab === 'Alert log');
    eq(archived.map(r => [r.alert_id, r.record_key, JSON.parse(r.row_json).forwarded_fields.issue_name]),
      [['QA-1', 'x.com/status/1', 'issue 1'], ['QA-2', 'x.com/status/2', 'issue 2'], ['QA-3', 'x.com/status/3', 'issue 3']]);
    eq([log.getLastRow(), log.deleted.slice(-1)[0], log.rows[1][0]], [before - 3, '2,3', 'QA-4']);
    assert.match(status(t, 'archive'), /^✓ ON · .* ET: Alert log: 3 archived · Message log: \d+ archived · Relay: 0 archived$/);
    // the same day again: nothing (once a day)
    t.poll();
    eq(bq.inserts.sheet_archive.filter(r => r.tab === 'Alert log').length, 3);
    // the next day, BigQuery missing a row: the copies stay, nothing is trimmed
    backend.appendAlert({ alert_id: 'QA-9', created_at: Date.UTC(2026, 9, 1), updated_at: Date.UTC(2026, 9, 1) });
    const log2 = tab(t, 'Alert log');
    log2.rows.splice(1, 0, log2.rows.pop());  // as the oldest row
    const rowsBefore = log2.getLastRow();
    sent = 1;
    t.g.clock.now = Date.UTC(2026, 10, 12, 8, 30);
    t.poll();
    eq(log2.getLastRow(), rowsBefore);
    assert.match(status(t, 'archive'), /Alert log: ⚠️ BigQuery has 0 of the 1 rows sent: nothing trimmed/);
  });

  // ===========================================================================================================
  // Memory
  // ===========================================================================================================

  test('signals memory: an analyst answer gets the earlier alerts on its post from the BigQuery archive and issue history, only while the Archive is ON (nothing has left the sheet otherwise), one query a post an hour, never the alert itself, and nothing on an error', () => {
    const { t, bq } = world();
    t.poll();
    const alert = { alert_id: 'QA-50', record_key: 'x.com/status/7' };
    eq(t.bot.signalsMemoryFor_(alert), []);
    eq(bq.queries.length, 0);
    t.g.services.CacheService.getScriptCache().put('sig_flags', JSON.stringify({ archive: true, watchdog: false }), 600);
    bq.answer = () => [{ alert_id: 'QA-50', issue_name: 'x', exposure_tag: 't', alerted_at: '2026-10-01', status: 'ok', email_status: 'sent', source: 'alert_log' },
      { alert_id: 'QA-7', issue_name: 'Gemini bleach advice', exposure_tag: 'Product - Dangerous results (e.g. medical/legal)',
        alerted_at: '2026-10-01 10:00:00 UTC', status: 'ok', email_status: 'sent', source: 'sheet_archive' }];
    eq(t.bot.signalsMemoryFor_(alert), ['- QA-7: Gemini bleach advice (Product - Dangerous results (e.g. medical/legal)) on 2026-10-01 10:00:00 UTC, email sent, from sheet_archive']);
    t.bot.signalsMemoryFor_(alert);
    eq([bq.queries.length, bq.queries[0].params.key], [1, 'x.com/status/7']);
    bq.answer = () => { throw new Error('boom'); };
    eq(t.bot.signalsMemoryFor_({ alert_id: 'QA-51', record_key: 'x.com/status/8' }), []);
    const p = B.answerAnalystPrompts_('what happened before?', null, { memory: ['- QA-7: earlier'] }, null);
    assert.ok(p.prompt.includes('[Earlier alerts on this post, from the bot\'s long memory') && p.prompt.includes('- QA-7: earlier'));
  });

  // ===========================================================================================================
  // Watchdog
  // ===========================================================================================================

  test('watchdog: a background step a run never finished (Apps Script stopped it) is counted at the next run; 3 within an hour pause it for 30 minutes only when the Signals tab says ON (else only reported); a paused step is skipped until then; steps that finish leave nothing behind', () => {
    const now = Date.UTC(2026, 10, 10, 12, 0);
    let st = { deaths: {}, paused: {} };
    for (let i = 0; i < 3; i++) st = B.wdAfterDeath_(st, 'proactiveWatch', now + i * MIN, false);
    eq([st.deaths.proactiveWatch.length, st.paused, st.last.paused], [3, {}, false]);
    st = B.wdAfterDeath_(st, 'proactiveWatch', now + 3 * MIN, true);
    eq([st.paused.proactiveWatch, st.last.n, st.last.paused], [now + 33 * MIN, 4, true]);
    eq(B.wdAfterDeath_({ deaths: { x: [now - 2 * HOUR] }, paused: { y: now - 1 } }, 'x', now, true), {
      deaths: { x: [now] }, paused: {}, last: { name: 'x', at: now, n: 1, paused: false } }, 'old stops and ended pauses drop');
    eq([B.wdIsPaused_(st, 'proactiveWatch', now + 10 * MIN, true), B.wdIsPaused_(st, 'proactiveWatch', now + 10 * MIN, false),
      B.wdIsPaused_(st, 'proactiveWatch', now + 40 * MIN, true)], [true, false, false]);
    // end to end in the bot: a step that "dies" (its mark left in the cache, as when Apps Script stops a run)
    const { t } = world();
    t.poll();
    const cache = t.g.services.CacheService.getScriptCache();
    const die = name => cache.put('wd_running', JSON.stringify({ name, at: t.g.clock.now }), 600);
    die('resultsTab');
    t.poll();
    eq(JSON.parse(t.g.props.get('WD_STATE')).last, { name: 'resultsTab', at: JSON.parse(t.g.props.get('WD_STATE')).last.at, n: 1, paused: false });
    eq(cache.get('wd_running'), null, 'a run that finishes leaves no mark');
    setting(t, 'watchdog', 'ON');
    t.poll();
    die('resultsTab');
    t.poll();
    die('resultsTab');
    t.poll();
    const s2 = JSON.parse(t.g.props.get('WD_STATE'));
    eq([s2.last.n, s2.last.paused], [3, true]);
    t.poll();
    assert.match(status(t, 'watchdog'), /^✓ ON: .* · paused now: resultsTab until .* ET · last stop: "resultsTab"/);
    let ran = 0;
    eq([t.bot.bgStep_('resultsTab', () => { ran++; return 1; }), t.bot.bgStep_('signals', () => { ran++; return 2; }), ran], [undefined, 2, 1]);
  });
};
