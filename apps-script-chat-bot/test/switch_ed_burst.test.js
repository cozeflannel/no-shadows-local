// Early Detection in a burst, under the Auto-correct flow's allowance (BigQuery.gs earlyWaveCheck_'s queueByAllowance,
// edAgesOut_): a story turned away by the check's 5 or an hourly limit is not finished. It is left unmarked, gets no
// ending and is not counted; the producer hands it over again at the next check, where the serious ones go first. It
// ends ("Never reviewed", with the limit that held it) only when it would leave the window a check reads (about an
// hour), and then it has its row on the Early Detection tab. The day's numbers add up after every run.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const ends = require('./ed_endings')(H);
  const props = w => w.t.g.services.PropertiesService.getScriptProperties();
  const recsOf = w => w.t.bot.edNotesOfRun_().map(r => w.t.bot.edNoteObj_(r));
  const storyOf = id => String(id).replace(/^ED-CLU-clu_ends0*(\d+)-.*$/, '$1');
  const serious = n => ends.signal(n, { at: '09:31', words: `Pixel owners say app ${n} leaks their photos, story ${n}` });
  const ordinary = n => ends.signal(n, { at: '09:31', words: `Pixel owners say app ${n} is slow DECLOW, story ${n}` });
  const tabRows = w => {
    const tab = w.t.sheet().getSheetByName('Early Detection');
    return tab ? tab.rows.slice(4).map(r => [String(r[9]).replace(/^'/, ''), String(r[1]).replace(/^'/, ''), String(r[3]).replace(/^'/, '')]) : [];
  };

  test('early detection burst: 25 different stories in one check, 10 of them serious: every serious one is queued over the next checks while the hour has room (5 a check), none ends "Never reviewed" while the hour has room, the sum holds after every run, and the ones that would leave the window a check reads end then, each with its row on the tab', () => {
    const w = ends.world({ flow: 'one-space', row46: false, settings: {} });
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(serious).concat(Array.from({ length: 15 }, (_, i) => ordinary(11 + i)));
    const counted = new Set();
    const queuedAt = {};
    const all = [];
    const step = (time, feed) => {
      const look = w.run(time, feed);
      const recs = recsOf(w);
      recs.forEach(r => { counted.add(r.id); all.push([time, storyOf(r.id), r.outcome, r.why]); });
      w.t.bot.edQueueList_(props(w)).forEach(e => {
        counted.add(e.id);
        if (!queuedAt[storyOf(e.id)]) queuedAt[storyOf(e.id)] = time;
      });
      recs.filter(r => /^Card posted|^Reviewed/.test(r.outcome)).forEach(r => { if (!queuedAt[storyOf(r.id)]) queuedAt[storyOf(r.id)] = time; });
      const n = w.t.bot.edDayNumbers_(props(w));
      eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `the run at ${time}: ${JSON.stringify(n)}`);
      eq(n.found, counted.size, `the run at ${time}: found ${n.found}, signals counted ${counted.size}`);
      assert.ok(!look.logs.map(String).some(l => /did not add up/.test(l)), `the run at ${time}`);
      return Object.assign(look, { recs, n });
    };
    step('09:01', []);
    // each check hands the 25 over again (they stay in the producer's window for an hour); the runs between review
    for (const [check, reviews] of [['09:31', ['09:32', '09:33', '09:34']], ['09:46', ['09:47', '09:48', '09:49']],
      ['10:01', ['10:02', '10:03', '10:04']], ['10:16', ['10:17', '10:18', '10:19', '10:20', '10:21']]]) {
      const look = step(check, rows);
      if (check !== '10:16') eq(look.recs.filter(r => r.outcome === 'Never reviewed'), [], `${check}: nothing ends while the hour has room`);
      reviews.forEach(t => step(t));
    }
    // the serious ones: five at each of the first two checks (the hour's 10), before any ordinary one
    eq([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => queuedAt[String(n)]), ['09:31', '09:31', '09:31', '09:31', '09:31',
      '09:46', '09:46', '09:46', '09:46', '09:46']);
    // the new hour: five ordinary ones, then a sixth; the other nine would be out of the next check's window, so they
    // end at 10:16 for the hour's 6 ordinary reviews
    const ord = Array.from({ length: 15 }, (_, i) => String(11 + i));
    eq(ord.filter(n => queuedAt[n] === '10:01').length, 5);
    eq(ord.filter(n => queuedAt[n] === '10:16').length, 1);
    const never = all.filter(r => r[2] === 'Never reviewed');
    eq(never.map(r => [r[0], r[3]]), Array.from({ length: 9 }, () => ['10:16', 'This hour\'s 6 reviews for ordinary stories were used.']));
    eq(new Set(never.map(r => r[1])).size, 9);
    // each of them has its row on the tab, once; every ending is there
    const tab = tabRows(w);
    never.forEach(r => eq(tab.filter(x => storyOf(x[0]) === r[1] && x[1] === 'Never reviewed').length, 1, `story ${r[1]}`));
    eq(tab.length, all.length);
    eq(w.t.bot.edDayNumbers_(props(w)), { found: 25, cards: 16, under: 0, letgo: 0, never: 9, waiting: 0 });
  });
};
