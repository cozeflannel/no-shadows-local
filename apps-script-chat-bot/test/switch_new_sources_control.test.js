// The new sources' Control rows (Control.gs, Main.gs, EarlyWaveSource.gs): row 48, "Early Detection: also read the AMIE
// table", written OFF and never set ON by the bot; "How it works" moved once to row 52 (rows 49 and 50 kept blank for
// the next two switches, row 51 the blank row above the help); the seam that tells Early Detection's source which new
// rows are ON (ewsRunSwitches_, set right after the Control tab is read); and what a row turned OFF forgets
// (ewsAmieOff_). With row 48 OFF nothing new happens anywhere; with it ON the AMIE table is read by a job of its own
// (its tests are in switch_ed_amie.test.js), and column C says so plainly.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, e2e, makeGoogle, loadBot } = H;
  const MIN = 60 * 1000;
  const BASE = require('./ed_new_lanes_base_requests.json');
  const LABEL = 'Early Detection: also read the AMIE table';
  const OFF_TEXT = 'OFF (Early Detection does not read the AMIE table)';
  const WAITING = '✓ ON, but waiting: it needs Early wave & velocity check (row 19) ON, which it adds posts to';
  const ON_TEXT = '✓ ON: each Early Detection check also reads new rows of the AMIE table (Brandwatch\'s alert feeds, X with its words)';
  const ON_OFF = ['ON', 'OFF'];
  const cells = (sh, r) => [1, 2, 3].map(c => sh.cell(r, c));
  const lists = sh => Object.fromEntries(Object.entries(sh.validations).map(([k, v]) => [k, v && v.values]));
  const EWS_COLS = ['kind', 'lane', 'mid', 'url', 'platform', 'author', 'audience', 'eng', 'posted_ms', 'seen_ms', 'txt', 'topic',
    'chash', 'sig', 'risk', 'brand'];

  // A world after setup(), with BigQuery answering every early-wave job at once with no rows; every request body kept.
  const world = () => {
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    const bq = [];
    const orig = t.g.services.UrlFetchApp.fetch;
    t.g.services.UrlFetchApp.fetch = (url, params) => {
      if (!String(url).startsWith('https://bigquery.googleapis.com/')) return orig(url, params);
      const payload = (params && params.payload) || '';
      let body = {};
      try { body = JSON.parse(payload || '{}'); } catch (e) { body = {}; }
      bq.push({ url: String(url), lane: (body.labels && body.labels.lane) || '', location: body.location, payload, method: (params && params.method) || 'get' });
      return {
        getResponseCode: () => 200,
        getHeaders: () => ({}),
        getContentText: () => JSON.stringify({
          jobComplete: true,
          jobReference: { projectId: 'brand-social-central-data', jobId: `job_${bq.length}`, location: body.location || 'US' },
          schema: { fields: EWS_COLS.map(name => ({ name, type: 'STRING' })) },
          rows: [],
        }),
      };
    };
    return { t, bq, sh: t.control() };
  };
  // Early Detection's jobs (each names its lane in a label: 'us', 'c1', or a new source's); the bot's other BigQuery
  // reads (sends, alerts) are not Early Detection's
  const jobs = w => w.bq.filter(c => c.method === 'post' && /\/queries$/.test(c.url) && c.lane);
  // anything sent to Secret Manager or Brandwatch, a BigQuery table read (tables.get) or a dry run, or naming the AMIE table
  const newCalls = w => w.t.g.fetches.filter(f => /secretmanager|api\.brandwatch\.com|\/tables\//.test(f.url))
    .concat(w.bq.filter(c => /all_sundar_mentions|"dryRun"/.test(c.payload + c.url)));
  const newState = w => {
    const names = Array.from(w.t.g.props.keys()).concat(Array.from(w.t.g.cache.keys()));
    return names.filter(n => /^EWS_SRC_DAY$|^BWL_|^ews1:(carry|nk:|sn:|xb|ak|bwl)/.test(n));
  };

  // -----------------------------------------------------------------------------------------------------------------
  // E27: the row, its help line, and the help at row 52
  // -----------------------------------------------------------------------------------------------------------------

  test('new sources control (E27): a new Control tab has row 48, "Early Detection: also read the AMIE table", OFF with its ON / OFF dropdown and what OFF means in C48 (starting "OFF ("); rows 49-51 are blank and "How it works" is at row 52 with a help line for the row', () => {
    const { t, sh } = world();
    eq(cells(sh, 48), [LABEL, 'OFF', OFF_TEXT]);
    assert.match(sh.cell(48, 3), /^OFF \(/);
    eq(sh.validations['48,2'].values, ON_OFF);
    eq([cells(sh, 49), cells(sh, 50), cells(sh, 51), sh.cell(52, 1)], [['', '', ''], ['', '', ''], ['', '', ''], 'How it works']);
    eq([sh.validations['49,2'], sh.validations['50,2'], sh.validations['51,2']], [undefined, undefined, undefined]);
    eq([B.ev('CONTROL_HELP_ROW_'), B.switchRows_().slice(-2), B.ev('CONTROL_SWITCHES_').slice(-1)[0].key], [52, [46, 48], 'edAmie']);
    const help = B.ev('CONTROL_HELP_');
    eq(help.map((_, i) => sh.cell(53 + i, 1)), help);
    assert.ok(B.ev('CONTROL_HELP_ROWS_') >= help.length + 1, 'the rows kept for the help hold its title and every line');
    const line = help.filter(l => l.startsWith(`• ${LABEL}: `));
    eq(line.length, 1);
    assert.match(line[0], /row 48, OFF until you turn it ON; it needs Early wave & velocity check \(row 19\) ON/);
    assert.match(line[0], /never go to S-F Burson/);
    assert.ok(help.some(l => /^• Rows 11-24, 27-29, 32, 34, 36-40, 46 and 48 are switches/.test(l)));
    assert.ok(help.some(l => /^• Early wave & velocity check: row 19.*with row 48 ON, posts from the AMIE table can start a story too/.test(l)));
    // every switch's OFF text starts "OFF (" and every label has its help line (row 48's too)
    B.ev('CONTROL_SWITCHES_').forEach(s => {
      assert.match(B.switchOffText_(s), /^OFF \(/, s.key);
      assert.ok(help.some(l => l.startsWith(`• ${s.label}: `)), s.label);
    });
    // a run keeps it so: OFF, C48 the OFF text, the switch read as OFF
    t.poll();
    eq([cells(sh, 48), t.bot.readControl_(sh).switches.edAmie], [[LABEL, 'OFF', OFF_TEXT], false]);
  });

  test('new sources control (E27): a Control tab from before row 48 (row 48 blank, "How it works" at row 49, help lines from row 50) gets row 48 OFF on its next run without setup(); rows 49-51 are left blank (no old help text), the help is at row 52, and no row from 11 to 47 moves or changes (values people set, switches ON, dropdowns)', () => {
    const { t, sh } = world();
    // the tab as the build before this one left it: row 48 blank, "How it works" at row 49, its help from row 50
    const oldHelp = B.ev('CONTROL_HELP_').filter(l => !l.startsWith(`• ${LABEL}: `)).concat(['• An old help line']);
    sh.rows = sh.rows.slice(0, 47);
    sh.rows[47] = [''];
    sh.rows[48] = ['How it works'];
    oldHelp.forEach((l, i) => { sh.rows[49 + i] = [l]; });
    delete sh.validations['48,2'];
    // what people set above it: switches ON, a bar, the lookback
    sh.getRange(19, 2).setValue('ON');
    sh.getRange(46, 2).setValue('ON');
    sh.getRange(34, 2).setValue('ON');
    sh.getRange(45, 2).setValue('4');
    sh.getRange(31, 2).setValue('30 minutes');
    const above = () => sh.rows.slice(10, 47).map(r => [r[0], r[1]]);
    const before = JSON.stringify(above());
    const lists0 = lists(sh);
    t.poll();
    eq(JSON.stringify(above()), before);
    eq(lists(sh), Object.assign({}, lists0, { '48,2': ON_OFF }));
    eq(cells(sh, 48), [LABEL, 'OFF', OFF_TEXT]);
    eq([cells(sh, 49), cells(sh, 50), cells(sh, 51), sh.cell(52, 1)], [['', '', ''], ['', '', ''], ['', '', ''], 'How it works']);
    const help = B.ev('CONTROL_HELP_');
    eq(help.map((_, i) => sh.cell(53 + i, 1)), help);
    for (let r = 53 + help.length; r <= sh.rows.length; r++) eq(cells(sh, r), ['', '', ''], `row ${r}`);
    assert.ok(!sh.rows.some(r => /An old help line/.test(String(r[0]))));
    eq(sh.rows.filter(r => String(r[0]).trim() === 'How it works').length, 1);
    eq(t.bot.readControl_(sh).switches, Object.assign(B.switchesOff_(), { earlyWave: true, proactiveWatch: true, earlyWaveBq: true }));

    // a person's ON is kept through setup() and more runs; so is their OFF afterwards: the bot writes only OFF
    sh.getRange(48, 2).setValue('ON');
    t.bot.setup();
    t.poll();
    t.poll();
    eq([sh.cell(48, 2), t.bot.readControl_(sh).switches.edAmie, sh.cell(52, 1)], ['ON', true, 'How it works']);
    sh.getRange(48, 2).setValue('OFF');
    t.bot.setup();
    t.poll();
    eq([sh.cell(48, 2), sh.cell(48, 3)], ['OFF', OFF_TEXT]);
    // a label someone cleared is put back, OFF (the row reads OFF until then)
    sh.getRange(48, 1, 1, 2).setValues([['', 'ON']]);
    eq(t.bot.readControl_(sh).switches.edAmie, false);
    t.poll();
    eq(cells(sh, 48), [LABEL, 'OFF', OFF_TEXT]);
  });

  test('new sources control: column C of row 48 while ON says it is waiting while row 19 is OFF, and otherwise the ON text (115 characters) with what the last check found after it; OFF it is the OFF text whatever row 19 says; row 19 turned OFF again leaves only the waiting words (no note of an earlier check)', () => {
    const texts = sw => B.switchStatusTexts_(sw, '', {}, NOW)[B.switchRows_().indexOf(48)];
    eq([texts({ edAmie: true }), texts({ edAmie: true, earlyWave: true }), texts({ earlyWave: true }), texts({})],
      [WAITING, ON_TEXT, OFF_TEXT, OFF_TEXT]);
    eq(ON_TEXT.length, 115);
    const { t, sh } = world();
    sh.getRange(48, 2).setValue('ON');
    t.poll();
    eq(sh.cell(48, 3), WAITING);
    sh.getRange(19, 2).setValue('ON');
    t.poll();
    // this fake's table has none of the AMIE table's columns: the check's note says so after the ON text (NewSources.gs)
    eq(sh.cell(48, 3), `${ON_TEXT} · ⚠️ since 8:02 AM (just now): the AMIE table has no column "alert_source" any more, so it ` +
      'isn\'t read. The other sources go on (New sources tab) · today: 0 rows, 0 used');
    sh.getRange(19, 2).setValue('OFF');
    t.poll();
    eq(sh.cell(48, 3), WAITING);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // The seam: which new rows are ON, as Early Detection's source learns them
  // -----------------------------------------------------------------------------------------------------------------

  test('new sources control (seam): each run tells Early Detection\'s source the switches it read right after the Control tab (ewsRunSwitches_): row 48 ON is edAmie, OFF is absent; a run that never read the tab leaves every new row OFF', () => {
    const { t, sh } = world();
    eq(t.bot.ewsRunSwitches_(), {});  // nothing set yet: all OFF (fail closed)
    t.poll();
    eq(t.bot.ewsRunSwitches_(), {});
    sh.getRange(48, 2).setValue('ON');
    sh.getRange(19, 2).setValue('ON');
    t.poll();
    eq(t.bot.ewsRunSwitches_(), { earlyWave: true, edAmie: true });
    eq(t.bot.ewsNewSources_(t.bot.ewsRunSwitches_()), ['ami']);
    sh.getRange(48, 2).setValue('OFF');
    t.poll();
    eq(t.bot.ewsRunSwitches_(), { earlyWave: true });
    // the line sits right after the Control tab is read, and nowhere else in Main.gs
    const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'Main.gs'), 'utf8');
    assert.match(main, /\n    wanted = readControl_\(control\);\n    ewsRunSwitches_\(wanted\.switches\);/);
    eq((main.match(/ewsRunSwitches_\(/g) || []).length, 1);
    eq((main.match(/ewsAmieOff_\(/g) || []).length, 1);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // E1 (the part that exists after this step) and E3: nothing new happens
  // -----------------------------------------------------------------------------------------------------------------

  test('new sources control (E1): row 48 OFF and row 19 ON, six checks: no Secret Manager or Brandwatch call, no table read or dry run, nothing names the AMIE table, exactly two BigQuery jobs a check (US and us-central1) whose bodies are the ones recorded at commit 3be2e06, no New sources tab, no new property or cache item, C48 the OFF text', () => {
    const w = world();
    const { t, sh } = w;
    sh.getRange(19, 2).setValue('ON');
    sh.getRange(31, 2).setValue('30 minutes');  // the recorded checks read 30 minutes first
    // the recording's two checks: 12:00 and 12:15 UTC (the run's clock moves a minute before it starts)
    t.g.clock.now = NOW - MIN;
    t.poll();
    t.g.clock.now = NOW + 14 * MIN;
    t.poll();
    eq(jobs(w).map(c => c.payload), BASE.bodies.map(b => b.payload));
    for (let i = 0; i < 4; i++) { t.g.clock.now += 15 * MIN; t.poll(); }
    eq([jobs(w).length, jobs(w).map(c => c.lane).filter(l => l !== 'us' && l !== 'c1')], [12, []]);
    eq([newCalls(w), newState(w), t.sheet().getSheetByName('New sources')], [[], [], null]);
    const st = JSON.parse(t.g.props.get('EWS_STATE'));
    eq([['nk', 'sn'].filter(k => k in st), Object.keys(st.marks).filter(k => /ami|bwl/.test(k))], [[], []]);
    eq([cells(sh, 48), t.bot.readControl_(sh).switches.edAmie], [[LABEL, 'OFF', OFF_TEXT], false]);
  });

  test('new sources control (E3): row 48 ON with row 19 OFF reads nothing at all (no BigQuery job, no table read, no Brandwatch or Secret Manager call, no Early Detection state); with row 19 ON too, the US job is byte for byte the one with row 48 OFF and the us-central1 job only gains its list of the big posts Sonar knew; here the AMIE table\'s check finds none of its columns, so it is checked once and not read (no dry run, no AMIE job) and no trial starts', () => {
    const on = world();
    on.sh.getRange(48, 2).setValue('ON');
    for (let i = 0; i < 3; i++) { on.t.g.clock.now += 15 * MIN; on.t.poll(); }
    eq([jobs(on), newCalls(on), newState(on), on.t.g.props.get('EWS_STATE') === undefined || on.t.g.props.get('EWS_STATE') === null],
      [[], [], [], true]);
    eq(on.sh.cell(48, 3), WAITING);

    const run = row48 => {
      const w = world();
      w.sh.getRange(19, 2).setValue('ON');
      w.sh.getRange(48, 2).setValue(row48);
      for (let i = 0; i < 3; i++) { w.t.g.clock.now += 15 * MIN; w.t.poll(); }
      return w;
    };
    const off = run('OFF');
    const amie = run('ON');
    const of = (w, lane) => jobs(w).filter(c => c.lane === lane).map(c => JSON.parse(c.payload));
    eq(jobs(amie).filter(c => c.lane === 'us').map(c => c.payload), jobs(off).filter(c => c.lane === 'us').map(c => c.payload));
    // us-central1: the same body but for the 'xbig' part at the end of its SQL (only while a new row is ON)
    const big = B.ewsC1BigSql_().join('\n');
    eq(of(amie, 'c1').map(b => b.query), of(off, 'c1').map(b => `${b.query}\n${big}`));
    eq(of(amie, 'c1').map(b => Object.assign(b, { query: '' })), of(off, 'c1').map(b => Object.assign(b, { query: '' })));
    eq([jobs(amie).length, jobs(amie).filter(c => c.lane !== 'us' && c.lane !== 'c1')], [6, []]);
    // the New sources tab is made (the bot's own, its title in A1) and says why the AMIE table isn't read
    const tab = amie.t.sheet().getSheetByName('New sources');
    eq([!!tab, tab && tab.cell(1, 1), tab && /^⚠️ since .*the AMIE table has no column/.test(tab.cell(4, 2))], [true, B.ev('NSRC_TITLE_'), true]);
    // the AMIE table's check (its metadata, read once): this fake answers with other columns, so it stops for the day
    eq(newCalls(amie).map(c => [c.method, c.url.replace(/^.*\/projects\//, '')]),
      [['get', 'brand-social-central-data/datasets/social_alerts_dataset/tables/all_sundar_mentions']]);
    eq([amie.t.bot.ewsAmiStatus_().state, amie.t.bot.ewsAmiStatus_().kind], ['stopped', 'column']);
    assert.ok(amie.sh.cell(48, 3).startsWith(`${ON_TEXT} · ⚠️ since `), amie.sh.cell(48, 3));
    // the new-lane rules of EarlyWaveSource.gs run while a new row is ON (their own day record and index), but with no
    // AMIE job collected the source is never read, so its trial has no first day
    const day = JSON.parse(amie.t.g.props.get('EWS_SRC_DAY') || '{}');
    eq(Object.keys(day.on || {}), []);
    // turned OFF again: the next run forgets the new lanes' index and signatures (the day record stays)
    const onState = JSON.parse(amie.t.g.props.get('EWS_STATE'));
    eq(['nk', 'sn'].filter(k => k in onState), ['nk', 'sn']);  // the new-lane rules kept their index and signatures while ON
    const dayRecord = amie.t.g.props.get('EWS_SRC_DAY');
    amie.sh.getRange(48, 2).setValue('OFF');
    amie.t.poll();
    const st = JSON.parse(amie.t.g.props.get('EWS_STATE'));
    eq([['nk', 'sn'].filter(k => k in st), Array.from(amie.t.g.cache.keys()).filter(k => /^ews1:(nk:|sn:|carry)/.test(k)),
      amie.t.g.props.get('EWS_SRC_DAY')], [[], [], dayRecord]);
    eq(amie.sh.cell(48, 3), OFF_TEXT);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // Turning row 48 OFF: what it forgets, and what it keeps
  // -----------------------------------------------------------------------------------------------------------------

  test('new sources control (OFF): a run with row 48 OFF forgets the AMIE table\'s mark and its job left running (cancelled), and, with no new row ON, the new lanes\' carry, post-key index and own signatures; the day counts, the trial date, the leave-out lists and today\'s lanes\' marks stay; the next run writes nothing', () => {
    const w = world();
    const { t, sh } = w;
    const def = { key: 'amj', location: 'US', sw: 'edAmie', query: () => null };
    t.bot.ev('EWS_NEW_LANE_DEFS_').push(def);
    const st = { v: 1, at: NOW, marks: { sonar: NOW - 5 * MIN, spk: NOW - 6 * MIN, ami: NOW - 7 * MIN },
      jobs: { us: { id: 'job_us', location: 'US', at: NOW }, amj: { id: 'job_amj', location: 'US', at: NOW, project: 'brand-social-central-data' } },
      day: { key: '2026-10-14', embedded: 40, nl: 12 }, nk: 2, sn: 1, cl: 0, sg: 0 };
    t.g.props.set('EWS_STATE', JSON.stringify(st));
    const srcDay = JSON.stringify({ v: 1, on: { ami: '2026-10-13' }, d: { '2026-10-14': { ami: { in: 5 } } } });
    t.g.props.set('EWS_SRC_DAY', srcDay);
    ['carry', 'nk:0', 'nk:1', 'sn:0', 'xb', 'ak', 'cl:0'].forEach(k => t.g.cache.set(`ews1:${k}`, '[]'));
    t.poll();
    const after = JSON.parse(t.g.props.get('EWS_STATE'));
    eq([after.marks, Object.keys(after.jobs), after.day, 'nk' in after, 'sn' in after],
      [{ sonar: NOW - 5 * MIN, spk: NOW - 6 * MIN }, ['us'], st.day, false, false]);
    eq(t.g.props.get('EWS_SRC_DAY'), srcDay);
    eq(Array.from(t.g.cache.keys()).filter(k => /^ews1:/.test(k)).sort(), ['ews1:ak', 'ews1:cl:0', 'ews1:xb']);
    eq(w.bq.filter(c => /\/jobs\/job_amj\/cancel/.test(c.url)).map(c => c.method), ['post']);
    eq(w.bq.filter(c => /\/cancel/.test(c.url) && !/job_amj/.test(c.url)), []);
    // nothing left to forget: the next runs write nothing
    const saved = t.g.props.get('EWS_STATE');
    const writes = [];
    const set = t.g.props.set.bind(t.g.props);
    t.g.props.set = (k, v) => { if (k === 'EWS_STATE') writes.push(v); return set(k, v); };
    t.poll();
    t.poll();
    eq([writes, t.g.props.get('EWS_STATE')], [[], saved]);
    eq(sh.cell(48, 2), 'OFF');
  });

  test('new sources control (OFF): with another new source still ON, turning the AMIE table OFF forgets only its own mark and job; the shared items stay; with no Early Detection state at all it writes nothing and never throws', () => {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    const st = { v: 1, marks: { sonar: 1, ami: 2 }, jobs: {}, day: {}, nk: 1, sn: 1 };
    g.props.set('EWS_STATE', JSON.stringify(st));
    g.cache.set('ews1:carry', '[]');
    g.cache.set('ews1:nk:0', '[]');
    b.ewsAmieOff_({ edBwLive: true });
    eq(JSON.parse(g.props.get('EWS_STATE')), { v: 1, marks: { sonar: 1 }, jobs: {}, day: {}, nk: 1, sn: 1 });
    eq(Array.from(g.cache.keys()).sort(), ['ews1:carry', 'ews1:nk:0']);
    const empty = makeGoogle(NOW);
    const b2 = loadBot(empty.services, empty.clock);
    b2.ewsAmieOff_({});
    b2.ewsAmieOff_(undefined);
    eq([Array.from(empty.props.keys()), Array.from(empty.cache.keys())], [[], []]);
    empty.props.set('EWS_STATE', '{not json');
    b2.ewsAmieOff_({});
    eq(empty.props.get('EWS_STATE'), '{not json');
  });

  // -----------------------------------------------------------------------------------------------------------------
  // The New sources tab is the bot's only by its title in A1 (NewSources.gs): any other tab of that name is left alone
  // -----------------------------------------------------------------------------------------------------------------

  const TITLE = B.ev('NSRC_TITLE_');
  const FOREIGN_NOTE = '⚠️ waiting: a tab named "New sources" exists that the bot didn\'t make; rename it to let the bot make its own';
  const tablesGets = w => w.bq.filter(c => /\/tables\/all_sundar_mentions$/.test(c.url)).length;
  const checks = (w, n) => { for (let i = 0; i < n; i++) { w.t.g.clock.now += 15 * MIN; w.t.poll(); } };

  test('new sources control (Q12): a tab named "New sources" the bot didn\'t make (a person\'s, an empty one, a title one character short or long, a protected one, a hidden one) is never written, and the AMIE table waits: it is not read at all and C48 says why; once that tab is renamed the bot makes its own and reads again', () => {
    const cases = {
      'a person\'s tab': sh => sh.getRange(1, 1, 2, 2).setValues([['My notes on sources', 'kept'], ['Reddit', 'check weekly']]),
      'an empty tab': () => {},
      'a title one character short': sh => sh.getRange(1, 1).setValue(TITLE.slice(0, -1)),
      'a title one character long': sh => sh.getRange(1, 1).setValue(`${TITLE}.`),
      'a protected tab': sh => { sh.getRange(1, 1).setValue('Ours'); sh.protect().setDescription('Only us'); },
      'a hidden tab': sh => { sh.getRange(1, 2).setValue(TITLE); sh.hideSheet(); },
    };
    Object.keys(cases).forEach(what => {
      const w = world();
      const { t, sh } = w;
      const theirs = t.sheet().insertSheet('New sources');
      cases[what](theirs);
      const look = () => JSON.stringify([theirs.rows, theirs.protections.length, theirs.isSheetHidden(), theirs.validations, theirs.cleared || []]);
      const before = look();
      sh.getRange(19, 2).setValue('ON');
      sh.getRange(48, 2).setValue('ON');
      checks(w, 3);
      eq([what, look()], [what, before]);
      eq([what, t.sheet().sheets.filter(x => x.name === 'New sources').length, tablesGets(w), jobs(w).filter(c => c.lane === 'ami').length],
        [what, 1, 0, 0]);
      assert.ok(sh.cell(48, 3).startsWith(`${ON_TEXT} · ${FOREIGN_NOTE}`), `${what}: ${sh.cell(48, 3)}`);
      assert.ok(JSON.parse(t.g.props.get('EWS_STATE')).nsf > 0, what);
      // renamed: the bot makes its own tab at the next check, and the check after that reads the AMIE table again
      theirs.setName('Our sources');
      checks(w, 1);
      const mine = t.sheet().getSheetByName('New sources');
      eq([what, mine && mine.cell(1, 1), 'nsf' in JSON.parse(t.g.props.get('EWS_STATE')), theirs.name, look()], [what, TITLE, false, 'Our sources', before]);
      checks(w, 1);
      eq([what, tablesGets(w)], [what, 1]);
      assert.ok(!sh.cell(48, 3).includes('a tab named'), sh.cell(48, 3));
    });
  });

  test('new sources control (Q12): the bot\'s own New sources tab stays its own when a person hides it or protects it: it is written at each check, never made twice, never shown again or unprotected; turning row 48 OFF leaves the tab as it is (nothing more is written to it)', () => {
    const w = world();
    const { t, sh } = w;
    sh.getRange(19, 2).setValue('ON');
    sh.getRange(48, 2).setValue('ON');
    checks(w, 1);
    const tab = t.sheet().getSheetByName('New sources');
    eq([tab.cell(1, 1), tab.protections.map(p => p.warningOnly)], [TITLE, [true]]);
    tab.hideSheet();
    tab.protect().setDescription('Only the owner');
    const summary = tab.cell(2, 1);
    checks(w, 1);
    eq([t.sheet().sheets.filter(x => x.name === 'New sources').length, tab.isSheetHidden(), tab.protections.length], [1, true, 2]);
    assert.ok(tab.cell(2, 1) !== summary && /^Calls today: /.test(tab.cell(2, 1)), tab.cell(2, 1));  // written again: its time moved
    // OFF: the tab stays, as it was; the bot writes no more there
    sh.getRange(48, 2).setValue('OFF');
    const rows = JSON.stringify(tab.rows);
    checks(w, 2);
    eq([JSON.stringify(tab.rows), sh.cell(48, 3)], [rows, OFF_TEXT]);
    eq(t.sheet().sheets.map(x => x.name).filter(n => /^New sources/.test(n)), ['New sources']);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // E26: a full run with row 48 ON puts nothing new in front of Burson
  // -----------------------------------------------------------------------------------------------------------------

  const golden = require('./golden_flows')(H);
  const ZAPIER = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const AMIE_TABLE = now => ({ lastModifiedTime: String(now), timePartitioning: { type: 'DAY', field: 'ingestionTimestamp' },
    schema: { fields: [['url'], ['alert_source'], ['snippet'], ['authorHandle'], ['SocialNetwork'], ['Sentiment'], ['postTime', 'TIMESTAMP'],
      ['ingestionTimestamp', 'TIMESTAMP'], ['followers', 'INTEGER'], ['KOF'], ['product'], ['engagement']]
      .map(([name, type]) => ({ name, type: type || 'STRING', mode: 'NULLABLE' })) } });
  const STORY = 'Google Wallet keeps declining my transit card at the gate since the update this morning';
  const AMIE_POSTS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((x, i) => ({
    url: `https://www.reddit.com/r/googlewallet/comments/1wal${i}/gate/`, author: `walletrider${i}`, txt: `${STORY} ${x}` }));
  const COLS16 = [['kind'], ['lane'], ['mid'], ['url'], ['platform'], ['author'], ['audience', 'INTEGER'], ['eng', 'INTEGER'],
    ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'], ['txt'], ['topic'], ['chash'], ['sig'], ['risk'], ['brand', 'BOOLEAN']];

  /**
   * Row 48 ON (and row 19) in a world `t`: the AMIE table's checks and jobs answered (its first job has five posts of one
   * story, by five accounts), today's two jobs with no rows, and Early Detection's real producer in place of a scenario's
   * scripted one. Every other call goes to the world's own fakes.
   */
  function amieOn(t, sh) {
    Object.assign(t.bot.ev('GEN').settings, { early_wave_new_trial_days: 0 });
    let amieJobs = 0;
    const prev = t.g.services.UrlFetchApp.fetch;
    const resp = body => ({ getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(body) });
    t.g.services.UrlFetchApp.fetch = (url, params) => {
      const u = String(url);
      const method = String((params && params.method) || 'get').toLowerCase();
      if (!u.startsWith('https://bigquery.googleapis.com/')) return prev(url, params);
      if (method === 'get' && /\/tables\/all_sundar_mentions$/.test(u)) return resp(AMIE_TABLE(t.g.clock.now));
      let body = {};
      try { body = JSON.parse((params && params.payload) || '{}'); } catch (e) { body = {}; }
      const labels = body.labels || {};
      if (method !== 'post' || !/\/queries$/.test(u) || labels.purpose !== 'early-wave') return prev(url, params);
      if (body.dryRun === true) return resp({ jobComplete: true, totalBytesProcessed: '80000000' });
      const now = t.g.clock.now;
      const rows = labels.lane !== 'ami' ? [] : ++amieJobs > 1 ? [{ kind: 'amark', lane: 'ami', seen_ms: now - 2 * MIN }]
        : AMIE_POSTS.map((p, i) => ({ kind: 'post', lane: 'ami', mid: `AMI|e26p${i}`, url: p.url, platform: 'Reddit', author: p.author,
          audience: 140, posted_ms: now - (12 + i * 3) * MIN, seen_ms: now - 4 * MIN, txt: p.txt, topic: 'Google Wallet', chash: `e26c${i}`,
          sig: `e26s${i}`, risk: '', brand: true })).concat([{ kind: 'amark', lane: 'ami', audience: 5, eng: 0, posted_ms: 5, seen_ms: now - 3 * MIN }]);
      return resp({ jobComplete: true, jobReference: { projectId: 'brand-social-central-data', jobId: `e26_${labels.lane}_${now}`, location: body.location },
        schema: { fields: COLS16.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: rows.map(r => ({ f: COLS16.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })) });
    };
    t.bot.bqEarlyDetectionRows_ = (minutes, opts) => t.bot.ewsRows_(minutes, opts);
    sh.getRange(19, 2).setValue('ON');
    sh.getRange(48, 2).setValue('ON');
  }

  /** What the bot put where Burson sees it: its posts in S-F Burson (B25) and the Burson test copy, and the outbox tab. */
  function bursonSide(t, spaces) {
    const posts = [].concat(...spaces.filter(s => s && t.chat.spaces.has(s)).map(s => t.chat.botPosts(s).map(m => m.text || '')));
    const outbox = t.sheet().getSheetByName('Burson outbox');
    return { posts, outbox: outbox ? outbox.rows.slice(1).map(r => r.join(' | ')) : [] };
  }

  /** None of it holds a new-lane post's words or link, "AMIE", "Brandwatch" or the AMIE table's name. */
  function assertNothingNew(what, side) {
    const leaks = side.posts.concat(side.outbox).filter(text => /amie|brandwatch|all_sundar|social_alerts_dataset/i.test(text) ||
      text.includes(STORY.slice(0, 30)) || AMIE_POSTS.some(p => text.includes(p.url) || text.includes(p.author)));
    eq([what, leaks], [what, []]);
  }

  test('new sources control (E26): a full run with row 48 ON, in the one-space setup, beside a Mirror space and in the main flow: the AMIE table\'s story is found and reviewed where the bot works, but no outbox row, relay post or post in S-F Burson (B25) or the Burson test copy (B26) holds a new-lane post\'s words or link, "AMIE" or "Brandwatch"', () => {
    const run = (t, sh) => {
      amieOn(t, sh);
      t.chat.say(golden.spaces.REAL, H.F.MISTAKES, ZAPIER);  // Burson's own alert: the relay and the outbox have work too
      checks({ t }, 6);
    };
    const one = golden.world.oneSpaceWorld({});  // B10 alone; B25 the live Burson space, read only
    run(one.t, one.sh);
    const mir = golden.world.mirrorWorld({});    // beside a Mirror space, Testing, with the Burson test copy
    run(mir.t, mir.sh);
    const main = world();                        // the main flow: the test feed into the analysts' space, B25 set
    main.t.set('B25', golden.spaces.REAL);
    run(main.t, main.sh);
    [['one-space', one.t, golden.spaces.AC], ['mirror', mir.t, golden.spaces.MIRROR], ['main', main.t, null]].forEach(([what, t, where]) => {
      const day = JSON.parse(t.g.props.get('EWS_SRC_DAY') || '{}');
      const today = Object.keys(day.d || {}).sort().slice(-1)[0];
      eq([what, (((day.d || {})[today] || {}).ami || {}).used], [what, 5]);  // the AMIE table's five posts came in
      // beside the Mirror space the test copy does get Burson's corrected alert: the way to Burson is open, and holds nothing new
      if (what === 'mirror') assert.ok(bursonSide(t, [golden.spaces.COPY]).posts.length > 0, 'the test copy has posts');
      assertNothingNew(what, bursonSide(t, [golden.spaces.REAL, golden.spaces.COPY]));
      if (where) assert.ok(t.chat.botPosts(where).some(m => /EARLY DETECTION/.test(m.text || '') && AMIE_POSTS.some(p => (m.text || '').includes(p.url))), `${what}: the story's card is where the bot works`);
    });
  });
};
