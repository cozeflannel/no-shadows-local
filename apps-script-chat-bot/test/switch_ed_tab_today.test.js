// The Early Detection tab keeps up with Control C19 (EarlyDetectionTab.gs): its row 3 is written again, one cell, by a run
// with time and no row to write when the day's numbers changed since (and only then), so it says what C19 says; and the
// rows of a run that ends before its last block are not lost: each row is handed to the script cache as it is noted
// (edTabHandOver_), and the next run puts them on the tab (edTabTakeOver_), none twice.
'use strict';

module.exports = H => {
  const { test, eq, assert, world, NOW } = H;
  const ends = require('./ed_endings')(H);
  const MIN = 60 * 1000;
  const TAB = 'Early Detection';
  const numbers = s => {
    const m = String(s).match(/(\d+) found\D+(\d+) cards?\D+(\d+) under another alert\D+(\d+) let go\D+(\d+) never reviewed\D+(\d+) waiting/);
    return m ? m.slice(1).map(Number) : null;
  };
  const sig = n => ({ alert_id: `ED-CLU-CLU-tdy${String(n).padStart(4, '0')}-202611150800`, signal_type: 'CLUSTER_EMERGENCE',
    unique_low_tier_authors: 5, platforms_csv: 'X, Reddit', primary_url: `https://x.com/user${n}/status/${70000 + n}`,
    headline: `Low-tier claim cluster (5 accounts): Pixel owners say the camera fails, story ${n}` });

  test('early detection tab today: over the long mixed day in the one-space setup, after every run with time the tab\'s row 3 holds the numbers C19 holds; a run whose numbers did not change makes no Sheets call for row 3', () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    const off = [];
    ends.day(w, (run, look) => {
      const tab = w.t.sheet().getSheetByName(TAB);
      if (!tab || run.busy || w.busy) return;  // a busy run has no time for the tab
      const tabN = numbers(tab.cell(3, 1));
      if (JSON.stringify(tabN) !== JSON.stringify(numbers(look.c19))) off.push([run.at, tabN, numbers(look.c19)]);
    });
    eq(off, []);
    // the same numbers again: no Sheets call for the tab
    const ss = w.t.sheet();
    const real = ss.getSheetByName.bind(ss);
    let calls = 0;
    ss.getSheetByName = name => { if (name === TAB) calls++; return real(name); };
    w.run('D2 00:51', []);
    w.run('D2 00:52', []);
    eq(calls, 0);
  });

  test('early detection tab today: a run that ends after counting endings, before its last block, leaves its rows to the next run, which writes them with its own, none twice', () => {
    const w = world();
    const ss = w.g.services.SpreadsheetApp.create('bot');
    const note = (at, row, outcome, why) => { w.g.clock.now = at; return w.bot.edNote_({ now: () => at, log: () => {} }, row, outcome, why); };
    w.bot.edNotesStart_();
    note(NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    note(NOW, sig(2), 'Not English', 'Most of its posts are not in English');
    // the run ends here (Apps Script's time limit): no last block. The next run starts and notes one of its own
    w.bot.edNotesStart_();
    note(NOW + MIN, sig(3), 'Not English', 'Most of its posts are not in English');
    eq(w.bot.maybeWriteEdTab_(ss, { now: () => NOW + MIN }, { deadline: NOW + 5 * MIN }).written, 3);
    const ids = ss.getSheetByName(TAB).rows.slice(4).map(r => String(r[9]).replace(/^'/, ''));
    eq(ids, [sig(3).alert_id, sig(2).alert_id, sig(1).alert_id]);
    // the next runs write nothing again
    w.bot.edNotesStart_();
    w.bot.maybeWriteEdTab_(ss, { now: () => NOW + 2 * MIN }, { deadline: NOW + 6 * MIN });
    eq(ss.getSheetByName(TAB).rows.length, 7);
    assert.ok(!w.g.services.CacheService.getScriptCache().get('ed_tab_run'), 'nothing is left handed over');
  });
};
