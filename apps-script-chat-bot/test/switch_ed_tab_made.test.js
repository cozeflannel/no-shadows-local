// Control C19 never points at an Early Detection tab that isn't there (EarlyDetectionTab.gs maybeMakeEdTab_,
// edTabPointed_): poll() makes the tab once, with its header rows and "Today: nothing yet.", at the start of the first run
// with Early Detection (row 19) ON and the setting early_detection_tab on, before any flow writes C19, and remembers that
// it did (ED_TAB_MADE), so later quiet runs make no Sheets call for it. A tab of that name a person made is left as it
// is: Status says it is in the way, and C19 has no pointer.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const ends = require('./ed_endings')(H);
  const TAB = 'Early Detection';
  const TITLE = 'Early Detection: every story it found and what happened to each (written by the Burson QA bot)';
  const POINTER = 'the Early Detection tab lists each one';
  const c19 = w => String(w.sh.cell(19, 3) || '');
  /** Counts the store's look-ups of the tab by name from now on. */
  const spy = w => {
    const ss = w.t.sheet();
    const real = ss.getSheetByName.bind(ss);
    const seen = { n: 0 };
    ss.getSheetByName = name => { if (name === TAB) seen.n++; return real(name); };
    return seen;
  };

  test('early detection tab made: on a first day with nothing found, the first run with row 19 ON makes the tab (its title, "Today: nothing yet.", its column names) before C19 is written, and C19 points at it; later quiet runs make no Sheets call for it; with row 19 OFF, or the setting off, no tab is made and C19 has no pointer', () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    assert.ok(!w.t.sheet().getSheetByName(TAB), 'no tab before the first run');
    const look = w.run('08:01', []);
    const tab = w.t.sheet().getSheetByName(TAB);
    assert.ok(tab, 'the tab is made at the first run');
    eq([tab.cell(1, 1), tab.cell(3, 1), tab.rows[3][0], tab.rows.length], [TITLE, 'Today: nothing yet.', 'When (ET)', 4]);
    assert.match(look.c19, /today: 0 found, 0 cards, 0 under another alert, 0 let go, 0 never reviewed, 0 waiting · the Early Detection tab lists each one$/);
    eq(w.t.g.props.get('ED_TAB_MADE'), 'true');
    const calls = spy(w);
    w.run('08:16', []);
    w.run('08:17', []);
    eq(calls.n, 0);
    assert.ok(c19(w).endsWith(POINTER), c19(w));

    // row 19 OFF: no tab
    const off = ends.world({ flow: 'one-space', row46: false });
    off.sh.getRange(19, 2).setValue('OFF');
    off.run('08:01', []);
    eq([!!off.t.sheet().getSheetByName(TAB), off.t.g.props.has('ED_TAB_MADE')], [false, false]);
    // the setting off: no tab, no pointer
    const unset = ends.world({ flow: 'one-space', row46: false, settings: Object.assign({}, ends.OLD_RULE, { early_detection_tab: false }) });
    unset.run('08:01', []);
    eq(!!unset.t.sheet().getSheetByName(TAB), false);
    assert.ok(!c19(unset).includes(POINTER), c19(unset));
  });

  test('early detection tab made: a tab named "Early Detection" that a person made is left as it is (not read past its first rows, cleared or written), Status says it is in the way, and C19 has no pointer to it; once it is renamed the bot makes its own and C19 points at that', () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    const theirs = w.t.sheet().insertSheet(TAB);
    theirs.getRange(1, 1, 2, 2).setValues([['Our notes', 'x'], ['a', 'b']]);
    const before = JSON.stringify(theirs.rows);
    w.run('08:01', []);
    w.run('08:16', []);
    eq(JSON.stringify(theirs.rows), before);
    assert.ok(!c19(w).includes(POINTER), c19(w));
    assert.match(String(w.sh.cell(5, 2)), /The Early Detection tab isn't being updated: a tab named "Early Detection" that the bot didn't make is in the way/);
    eq(w.t.g.props.has('ED_TAB_MADE'), false);
    // renamed: the next run sees the name is free; the run after makes the bot's own tab, and the next check points at it
    theirs.setName('Our early detection notes');
    w.run('08:17', []);
    w.run('08:18', []);
    const mine = w.t.sheet().getSheetByName(TAB);
    eq(mine && mine.cell(1, 1), TITLE);
    w.run('08:31', []);
    assert.ok(c19(w).endsWith(POINTER), c19(w));
    eq(JSON.stringify(theirs.rows), before);
  });
};
