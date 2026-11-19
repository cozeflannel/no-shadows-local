// Step S3 of the open-engine plan: the "Engine" tab (EngineTab.gs). Under Control row 51 one row for each Early
// Detection check (what it read, judged and could not do) and a row for each day, newest first, 7 days kept, every
// cell short; a tab named "Engine" that the bot did not make is never written. With row 51 OFF nothing of it runs.
'use strict';

module.exports = H => {
  const { test, eq, assert, world, NOW } = H;
  const golden = require('./golden_flows')(H);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const TITLE = 'Engine: one row per Early Detection check, what it read, judged and could not do (written by the Burson QA bot)';

  /** A bot on fake services with a sheet; row 51 ON (with row 19) unless `off`. */
  function bot(off) {
    const w = world();
    if (!off) w.bot.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    w.ss = w.g.services.SpreadsheetApp.create('bot');
    w.acc = () => JSON.parse(w.g.props.get('ENGINE_ACC') || 'null');
    w.tab = () => w.ss.getSheetByName('Engine');
    w.head = () => w.tab().rows[2];
    w.data = () => w.tab().rows.slice(3).map(r => Object.fromEntries(w.head().map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
    /** One run at `at`: its record starts, `body` runs, and its end writes the tab (time left unless `busy`). */
    w.run = (at, body, o) => {
      w.g.clock.now = at;
      w.bot.openRunStart_(at);
      w.bot.engRunStart_();
      if (body) body(w.bot);
      w.bot.openDaySave_();
      const out = w.bot.maybeWriteEngineTab_(w.ss, null, { deadline: (o && o.deadline) || at + 4 * MIN });
      w.bot.openRunEnd_();
      return out;
    };
    return w;
  }

  test('engine tab: with row 51 OFF a run counts nothing, writes no tab and keeps nothing', () => {
    const w = bot(true);
    const out = w.run(NOW, b => { b.engAdd_('reviews', 3); b.engCheck_({ queued: 2 }); });
    eq([out, w.tab(), w.acc()], [{ written: 0, waiting: 0, blocked: false }, null, null]);
  });

  test('engine tab: under row 51 a run with a check writes one row (newest first, under the title, what\'s listed and the column names); the numbers of the runs between two checks go in the next check\'s row; every cell is short', () => {
    const w = bot();
    w.run(NOW, b => { b.engCheck_({ queued: 2, repeats: 1, triaged: 1 }); b.engAdd_('reviews', 1); });
    const tab = w.tab();
    eq([tab.cell(1, 1), tab.rows[2], tab.frozenRows, w.bot.isEngineTab_(tab)], [TITLE, w.bot.ev('ENG_HEAD_'), 3, true]);
    assert.ok(String(tab.cell(2, 1)).startsWith('One row for each Early Detection check while the open engine (Control row 51) is ON'));
    eq(w.data().length, 1);
    const first = w.data()[0];
    eq([first.Row, first.Queued, first.Signals, first['Quick held'], first.Reviews, first.Runs, first['Gap (min)']], ['check', 2, 4, 1, 1, 1, '']);
    // two runs with no check: their reviews and Direct cards wait for the next check's row
    w.run(NOW + MIN, b => { b.engAdd_('reviews', 2); b.engAdd_('direct', 1); });
    w.run(NOW + 2 * MIN, b => { b.engAdd_('reviews', 1); });
    eq([w.data().length, w.acc().cur.n.reviews, w.acc().cur.n.runs], [1, 3, 2]);
    w.run(NOW + 15 * MIN, b => { b.engCheck_({ queued: 0 }); b.engAdd_('watch', 1); });
    const second = w.data()[0];
    eq([w.data().length, second.Reviews, second['Direct cards'], second['Watch cards'], second.Runs, second['Gap (min)']], [2, 3, 1, 1, 3, 15]);
    eq(w.acc().cur, { n: {}, t: {} });
    // every column, every cell short (a number or at most 100 characters and its apostrophe)
    w.data().forEach(r => {
      eq(Object.keys(r).length, w.bot.ev('ENG_COLS_').length);
      Object.values(r).forEach(v => assert.ok(typeof v === 'number' || String(v).length <= 101, String(v)));
    });
    // the run-time record's columns: the day's run time against its budget, the step, the stop's counts
    assert.ok(/ of /.test(String(second['Run time (24 h)'])), second['Run time (24 h)']);
    eq([second.Step, second['Stop counts']], ['0', 'reviews 0 · quick 0 · Watch checks 0 · GB 0']);
  });

  test('engine tab: the first check of a new Eastern day writes the day before\'s row first (its sums and a line), and rows of days older than 7 are deleted', () => {
    const w = bot();
    const day0 = w.bot.openEtDay_(NOW);
    w.run(NOW, b => { b.engCheck_({ queued: 1 }); b.engAdd_('reviews', 2); });
    w.run(NOW + 15 * MIN, b => { b.engCheck_({ queued: 2 }); b.engAdd_('reviews', 1); });
    w.run(NOW + DAY, b => { b.engCheck_({ queued: 0 }); });
    const rows = w.data();
    eq(rows.map(r => r.Row), ['check', `day ${day0}`, 'check', 'check']);
    eq([rows[1].Queued, rows[1].Reviews, rows[1].Runs], [3, 3, 2]);
    assert.ok(String(rows[1].Note).startsWith('checks 2 · posts read 0 · stories 0 · signals 3 · reviews 3'), rows[1].Note);
    // 8 days later: the first day's block (its day row and the checks under it) goes
    for (let d = 2; d <= 9; d++) w.run(NOW + d * DAY, b => { b.engCheck_({ queued: 0 }); });
    const left = w.data().map(r => r.Row);
    assert.ok(!left.includes(`day ${day0}`), left.join(' | '));
    eq(left.filter(r => r === `day ${w.bot.openEtDay_(NOW + 2 * DAY)}`).length, 1);
  });

  test('engine tab: a tab named "Engine" that a person made is never written or cleared; C51 says it is in the way; once it is renamed the bot makes its own', () => {
    const w = bot();
    const theirs = w.ss.insertSheet('Engine');
    theirs.getRange(1, 1).setValue('My engine notes');
    theirs.getRange(2, 1).setValue('keep me');
    const out = w.run(NOW, b => b.engCheck_({ queued: 1 }));
    eq([out.blocked, out.written, out.waiting, theirs.cell(1, 1), theirs.cell(2, 1), theirs.getLastRow()], [true, 0, 1, 'My engine notes', 'keep me', 2]);
    assert.ok(/a tab named "Engine" that the bot did not make is in the way/.test(w.bot.openC51Text_(NOW)), w.bot.openC51Text_(NOW));
    theirs.setName('My engine');
    const again = w.run(NOW + 15 * MIN, b => b.engCheck_({ queued: 0 }));
    eq([again.written, w.data().length, theirs.cell(2, 1)], [2, 2, 'keep me']);
    assert.ok(!/in the way/.test(w.bot.openC51Text_(NOW + 15 * MIN)));
  });

  test('engine tab: a run with too little time or still catching up writes nothing (its row waits, at most 12, the rest counted in a "not recorded" row); ENGINE_ACC stays under 8,800 characters in the worst case', () => {
    const w = bot();
    for (let i = 0; i < 20; i++) {
      const out = w.run(NOW + i * 15 * MIN, b => {
        b.engCheck_({ queued: 99999 });
        b.ev("ENG_COLS_.forEach(([k, , kind]) => { if (kind === 'n') engAdd_(k, 999999.9); else if (k !== 'at' && k !== 'row') engSet_(k, 'x'.repeat(300)); })");
      }, { deadline: NOW + i * 15 * MIN + 5000 });
      eq(out.written, 0);
    }
    const raw = w.g.props.get('ENGINE_ACC');
    assert.ok(raw.length <= 8800, `${raw.length}`);
    const acc = JSON.parse(raw);
    assert.ok(acc.pending.length <= 12 && acc.plost >= 8, JSON.stringify([acc.pending.length, acc.plost]));
    w.run(NOW + 21 * 15 * MIN, null);
    const rows = w.data();
    eq(rows[rows.length - 1].Row, 'not recorded');
    assert.ok(/^\d+ rows could not be kept \(the runs were full\)$/.test(String(rows[rows.length - 1].Note)), rows[rows.length - 1].Note);
    rows.forEach(r => Object.values(r).forEach(v => assert.ok(typeof v === 'number' || String(v).length <= 101)));
    // small rows, 20 runs with no time: 12 wait, 8 are counted
    const v = bot();
    for (let i = 0; i < 20; i++) v.run(NOW + i * 15 * MIN, b => b.engCheck_({ queued: 1 }), { deadline: NOW + i * 15 * MIN + 5000 });
    eq([v.acc().pending.length, v.acc().plost], [12, 8]);
  });

  test('engine tab: in a run of the one-space setup with row 51 ON, each Early Detection check is one row with what it read and what came of it; with row 51 OFF there is no Engine tab', () => {
    const run = off => {
      const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true }));
      if (!off) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
      w.rec.collect('setup');
      w.rec.step('the first run', 1);
      w.rec.step('a check', 5);
      w.rec.step('the story is found', 15, () => { w.feed.stories = [golden.rows.story({})]; });
      [1, 1, 15].forEach(m => w.rec.step('after', m));
      const tab = w.t.sheet().getSheetByName('Engine');
      return { tab, checks: Number(w.t.g.props.get('EARLY_DETECTION_AT')) };
    };
    eq(run(true).tab, null);
    const { tab } = run(false);
    const head = tab.rows[2];
    const rows = tab.rows.slice(3).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
    assert.ok(rows.length >= 2, JSON.stringify(rows.map(r => r.Row)));
    rows.forEach(r => eq(r.Row, 'check'));
    eq(rows.reduce((s, r) => s + (Number(r.Reviews) || 0), 0), 1);   // the story's one review
    assert.ok(rows.some(r => Number(r.Queued) === 1), JSON.stringify(rows.map(r => r.Queued)));
    assert.ok(rows.every(r => Number(r.Runs) >= 1));
  });
};
