// The Control tab's switches (rows 11-24, 27-29, 32, 34 and 36, Control.gs) and the 49,000-character cell cap (Sheets.gs, Speed.gs).
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, e2e, makeGoogle, TRIAGED } = H;
  const LABELS = ['Auto-send Social Alerts', 'Auto-submit T&S form', 'KB & Guidance can start alerts', 'Auto-find missing links',
    'Direct BigQuery alerts', 'Write back to SLRR BigQuery', 'Learn from IM calls', 'Watch sent alerts (24h)',
    'Early wave & velocity check', 'Check outage & comms docs', 'Track post-alert outcomes', 'Relay with S-F Burson',
    'Never wait on Burson', 'Post in S-F Burson', 'Draft follow-ups', 'Draft answers to questions', 'Safety valve',
    'Work directly in B25 (Google-only)', 'Proactive watch', 'Temp checks', 'Group test emails'];
  const KEYS = ['autoSend', 'autoTns', 'kbStartAlerts', 'autoFindLinks', 'directBq', 'writeBackBq', 'learnIm', 'watchSent',
    'earlyWave', 'outageComms', 'trackOutcomes', 'relay', 'noWait', 'postBurson', 'draftFollowUps', 'draftAnswers', 'safetyValve',
    'directB25', 'proactiveWatch', 'tempChecks', 'bsgTestEmails'];
  const ROWS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 27, 28, 29, 32, 34, 36, 37];  // rows 25-26 the space cells, 30-31 B30 / B31, 33 B33, 35 B35
  const rows = (t, col) => ROWS.map(r => t.control().cell(r, col));
  const allOff = () => Object.fromEntries(KEYS.map(k => [k, false]));
  const VALVE = KEYS.indexOf('safetyValve');

  test('switches: a new Control tab has all 21, each an ON / OFF dropdown set to OFF, with what OFF means in column C; rows 11-24, 27-29, 32, 34, 36 and 37 are the switches, row 25 the S-F Burson space (blank), row 26 the Burson test copy (blank), row 30 Testing: send to (blank), row 31 the BigQuery lookback (60 minutes, its own dropdown), row 33 the Other alerts space (blank, no dropdown), row 35 Watch alerts (OFF, its own dropdown) and "How it works" follows from row 39', () => {
    const t = e2e();
    t.bot.setup();
    eq(B.switchRows_(), ROWS);
    eq(rows(t, 1), LABELS);
    eq(rows(t, 2), LABELS.map(() => 'OFF'));
    ROWS.forEach(r => eq(t.control().validations[`${r},2`].values, ['ON', 'OFF']));
    // column C: what OFF means (the Safety valve's: B26 decides, until a run knows the mode)
    eq(rows(t, 3), B.ev('CONTROL_SWITCHES_').map(s => B.switchOffText_(s)));
    rows(t, 3).forEach(c => assert.match(c, /^OFF \(/));
    t.poll();  // the first run: C29 says the run's mode (Testing here: no S-F Burson)
    assert.match(rows(t, 3)[VALVE], /^OFF \u00b7 \ud83e\uddea Testing \(S-F Burson, B25, isn't set or found\): nothing goes to S-F Burson, and every email goes only to the stand-in \(B30\)\. With B26 blank and S-F Burson set, the bot is fully LIVE$/);
    assert.match(t.control().cell(16, 3), /writes only to this sheet: nothing goes to the shared SLRR BigQuery tables/);
    eq([25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39].map(r => t.control().cell(r, 1)), ['S-F Burson space', 'Burson test copy', 'Draft follow-ups',
      'Draft answers to questions', 'Safety valve', 'Testing: send to', 'BigQuery lookback', 'Work directly in B25 (Google-only)',
      'Other alerts space', 'Proactive watch', 'Watch alerts', 'Temp checks', 'Group test emails', '', 'How it works']);
    eq([t.control().validations['25,2'], t.control().validations['26,2'], t.control().validations['33,2']], [undefined, undefined, undefined]);  // a space goes there
    // B31 is no switch: 60 minutes, with its own 15 / 30 / 45 / 60 minutes dropdown
    eq([t.control().cell(31, 2), t.control().validations['31,2'].values], ['60 minutes', ['15 minutes', '30 minutes', '45 minutes', '60 minutes']]);
    // B35 is no switch either: OFF, with its own OFF / Other alerts space (B33) / Mirror space (B9) dropdown
    eq([t.control().cell(35, 2), t.control().validations['35,2'].values],
      ['OFF', ['OFF', 'Other alerts space (B33)', 'Mirror space (B9)', 'Auto-correct space (B10)']]);
    const help = Array.from({ length: 40 }, (_, i) => t.control().cell(40 + i, 1)).join('\n');
    LABELS.forEach(l => assert.ok(help.includes(`• ${l}: `), l));
    eq(t.bot.readControl_(t.control()).switches, allOff());
    eq(B.ev('CONTROL_SWITCHES_').map(s => s.key), KEYS);
  });

  test('switches: a Control tab from before them gets them in place, all OFF; B2:B10 and the people\'s values are kept, and the old help text is gone', () => {
    const t = e2e();
    t.bot.setup();
    const sh = t.control();
    // The tab as the earlier build left it: help text from row 11 (column A only), and values people set in B2:B10
    sh.rows = sh.rows.slice(0, 10);
    sh.validations = { '2,2': sh.validations['2,2'] };
    const oldHelp = ['How it works'].concat(Array.from({ length: 12 }, (_, i) => `• old help line ${i + 1}`));
    oldHelp.forEach((line, i) => { sh.rows[10 + i] = [line]; });
    t.set('B2', 'ON');
    t.set('B9', 'https://mail.google.com/chat/u/0/#chat/space/AAQAmirror1');
    const people = () => [1, 2, 3, 4, 8, 9, 10].map(r => [sh.cell(r, 1), sh.cell(r, 2)]);  // B5:B7 are the bot's
    const before = people();
    t.poll();  // the every-minute run adds them: nobody has to run setup() after an update
    eq(people(), before);
    eq(rows(t, 1), LABELS);
    eq(rows(t, 2), LABELS.map(() => 'OFF'));
    ROWS.forEach(r => eq(sh.validations[`${r},2`].values, ['ON', 'OFF']));
    eq([25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39].map(r => sh.cell(r, 1)), ['S-F Burson space', 'Burson test copy', 'Draft follow-ups',
      'Draft answers to questions', 'Safety valve', 'Testing: send to', 'BigQuery lookback', 'Work directly in B25 (Google-only)',
      'Other alerts space', 'Proactive watch', 'Watch alerts', 'Temp checks', 'Group test emails', '', 'How it works']);
    // the BigQuery lookback row comes in too: 60 minutes, with its dropdown (the tab had only B2's)
    eq([sh.cell(31, 2), sh.validations['31,2'].values], ['60 minutes', ['15 minutes', '30 minutes', '45 minutes', '60 minutes']]);
    eq([sh.cell(25, 2), t.bot.readControl_(sh).sfBurson, sh.cell(26, 2), t.bot.readControl_(sh).testCopy], ['', '', '', '']);
    assert.ok(!sh.rows.some(r => /old help line/.test(String(r[0]))));
    eq(t.bot.readControl_(sh).switches, allOff());

    // A switch someone turned ON stays ON through setup() and later runs; so does one they turned back OFF
    sh.getRange(13, 2).setValue('ON');
    sh.getRange(16, 2).setValue('OFF');
    sh.getRange(28, 2).setValue('ON');
    t.bot.setup();
    t.poll();
    eq([sh.cell(13, 2), sh.cell(16, 2), sh.cell(28, 2)], ['ON', 'OFF', 'ON']);
    eq(t.bot.readControl_(sh).switches, Object.assign(allOff(), { kbStartAlerts: true, draftAnswers: true }));
  });

  test('switches: ON only on the switch\'s own row with its own label (lower-case on is ON; anything else, or a row that isn\'t the switch, is OFF)', () => {
    const on = { kbStartAlerts: true, trackOutcomes: true };
    const grid = LABELS.map((l, i) => [l, KEYS[i] === 'kbStartAlerts' ? 'on' : (KEYS[i] === 'trackOutcomes' ? 'ON' : 'yes')]);
    eq(B.parseSwitches_(grid), Object.assign(allOff(), on));
    eq(B.parseSwitches_(grid.map(r => ['• some help text', r[1]])), allOff());
    eq(B.parseSwitches_([]), allOff());
    eq(B.parseSwitches_(LABELS.map(l => [l, true])), Object.fromEntries(KEYS.map(k => [k, true])));
    assert.strictEqual(B.switchOn_({ switches: { autoSend: true } }, 'autoSend'), true);
    eq([B.switchOn_({}, 'autoSend'), B.switchOn_(null, 'autoSend'), B.switchOn_({ switches: { autoSend: 'ON' } }, 'autoSend')], [false, false, false]);
  });

  test('switches: each run\'s ctx has them (OFF unless ON on the tab), and column C says what an ON switch is doing, with the stand-in while testing', () => {
    const t = e2e();
    t.bot.setup();
    const sh = t.control();
    t.set('B30', 'tester@testing.test');
    sh.getRange(11, 2).setValue('ON');
    sh.getRange(19, 2).setValue('ON');
    t.bot.noteSwitch_('earlyWave', 'last check 8:15 AM · 1 wave today');
    t.bot.noteSwitch_('directBq', 'a note for a switch that is OFF');
    t.bot.earlyWaveCheck_ = () => null;  // the check itself (it writes its own note) is tested in switch_i_early_wave.test.js
    t.poll();
    assert.strictEqual(sh.cell(11, 3), '✓ ON (testing: sending only to the testers in B30)');
    assert.match(sh.cell(19, 3), /^✓ ON: every 15 min, .* · last check 8:15 AM · 1 wave today$/);
    assert.match(sh.cell(15, 3), /^OFF \(/);
    eq(B.switchStatusTexts_({ autoSend: true }, '', {}, NOW)[0], '✓ ON: the bot sends the Social Alert email itself');
    // A note from more than a day ago is left out
    eq(B.switchStatusTexts_({ earlyWave: true }, '', { earlyWave: { text: 'old', at: NOW - 25 * 3600e3 } }, NOW)[8],
      B.switchStatusTexts_({ earlyWave: true }, '', {}, NOW)[8]);
    const ctx = t.bot.buildCtx_({ burson: { id: H.TEST_FEED, name: 'Feed' }, analyst: { id: TRIAGED, name: 'Analysts' } }, t.sheet());
    eq(ctx.switches, Object.assign(allOff(), { autoSend: true, earlyWave: true }));
    const given = t.bot.buildCtx_({ burson: { id: H.TEST_FEED, name: 'Feed' }, analyst: { id: TRIAGED, name: 'Analysts' } }, t.sheet(), { learnIm: true });
    eq(given.switches, Object.assign(allOff(), { learnIm: true }));
    // Paused, column C is still kept up to date
    t.set('B2', 'OFF');
    sh.getRange(11, 2).setValue('OFF');
    t.poll();
    assert.match(sh.cell(11, 3), /^OFF \(/);
  });

  test('switches: a note a switch keeps writing (a reason that lasts, like "live form id not set") stays in column C past a day; one it stopped writing drops out after a day', () => {
    const t = e2e();
    t.bot.setup();
    t.control().getRange(12, 2).setValue('ON');
    t.control().getRange(13, 2).setValue('ON');
    const LASTING = 'live form id not set (script property TNS_LIVE_FORM_ID): posting the link instead';
    t.bot.noteSwitch_('kbStartAlerts', 'an old note');
    for (let h = 0; h < 30; h++) {
      t.bot.noteSwitch_('autoTns', LASTING);
      t.g.clock.now += 3600e3;
    }
    t.poll();
    assert.ok(t.control().cell(12, 3).endsWith(` · ${LASTING}`), t.control().cell(12, 3));
    assert.ok(!/an old note/.test(t.control().cell(13, 3)), t.control().cell(13, 3));
    // The same note within the hour isn't written again (one property write an hour at most); after it, it is
    t.bot.noteSwitch_('autoTns', LASTING);
    const at = JSON.parse(t.g.props.get('SWITCH_NOTES')).autoTns.at;
    t.g.clock.now += 59 * 60e3;
    t.bot.noteSwitch_('autoTns', LASTING);
    eq(JSON.parse(t.g.props.get('SWITCH_NOTES')).autoTns.at, at);
    t.g.clock.now += 60e3;
    t.bot.noteSwitch_('autoTns', LASTING);
    eq(JSON.parse(t.g.props.get('SWITCH_NOTES')).autoTns.at, at + 3600e3);
  });

  test('cell cap: no cell the bot writes goes over 49,000 characters; a JSON column stays JSON that parses, keeping its short fields', () => {
    assert.strictEqual(B.ev('SHEET_CELL_MAX_CHARS_'), 49000);
    const huge = 'x'.repeat(120000);
    eq([B.encodeCell_('author', huge).length, B.encodeCell_('author', '=' + huge).slice(0, 2)], [49000, '\'=']);
    assert.strictEqual(B.speedText_(huge).length, 49000);
    assert.strictEqual(B.speedText_('=SUM(A1)'), '\'=SUM(A1)');
    const input = { escalation: { text: huge, product: 'Gemini App', track: 'URGENT' }, screenshot: { url: 'https://x.com/a.png', label: 'Screenshot of the post', base64: huge },
      recommended_groups: ['PRESS'], summary: huge };
    const cell = B.encodeCell_('email_input', input);
    assert.ok(cell.length <= 49000, String(cell.length));
    const back = B.decodeCell_('email_input', cell);
    eq([back.escalation.product, back.escalation.track, back.screenshot.url, back.recommended_groups, 'base64' in back.screenshot],
      ['Gemini App', 'URGENT', 'https://x.com/a.png', ['PRESS'], false]);
    assert.ok(back.escalation.text.startsWith('xxx') && back.escalation.text.endsWith('…'));
    // A list that's too long is shortened, still a list; a small value is written exactly as before
    const tokens = Array.from({ length: 20000 }, (_, i) => 'token' + i);
    const list = B.decodeCell_('issue_tokens', B.encodeCell_('issue_tokens', tokens));
    assert.ok(list.length > 1000 && list.length < 20000 && list[0] === 'token0');
    eq(B.encodeCell_('email_input', { a: 1, b: 'two' }), JSON.stringify({ a: 1, b: 'two' }));
    // Written through the store's table (as poll() does), the row reads back
    const rowsWritten = [];
    const io = { lastRow: () => rowsWritten.length + 1, read: (f, c) => rowsWritten.slice(f - 2, f - 2 + c), append: v => { rowsWritten.push(v); return rowsWritten.length + 1; },
      write: (r, v) => { rowsWritten[r - 2] = v; }, keyAt: (r, c) => rowsWritten[r - 2][c - 1], findRow: () => null };
    const table = B.tableOver_(io, ['alert_id', 'email_input', 'decision'], 'alert_id', 100);
    table.append({ alert_id: 'QA-1', email_input: input, decision: huge });
    rowsWritten[0].forEach(v => assert.ok(String(v).length <= 49000));
    const [row] = table.load();
    eq([row.alert_id, row.email_input.escalation.product, row.decision.length], ['QA-1', 'Gemini App', 49000]);
  });

  test('cell cap: a huge email_input (a long alert text) no longer stops the run that writes it', () => {
    const g = makeGoogle(NOW);
    const t = e2e(g);
    t.bot.setup();
    const log = t.sheet().getSheetByName('Alert log');
    const header = log.rows[0];
    const row = header.map(h => (h === 'alert_id' ? 'QA-9' : ''));
    log.appendRow(row);
    const table = t.bot.sheetBackend_(t.sheet());
    const [r] = table.loadAlerts();
    table.updateAlert(r, { email_input: { escalation: { text: 'y'.repeat(200000) } }, decision: 'z'.repeat(60000) });
    log.rows.forEach(vals => vals.forEach(v => assert.ok(String(v).length <= 49000)));
    const [again] = t.bot.sheetBackend_(t.sheet()).loadAlerts();
    assert.ok(again.email_input.escalation.text.length < 49000);
  });
};
