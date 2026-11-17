// Under the Auto-correct flow's allowance, every signal queued is counted against the hour and the day at once
// (BigQuery.gs edAllowSaveQueued_), not only at the end of the check: a check stopped part-way (Apps Script's time limit)
// still counts what it queued, so the next check cannot pass the hour's or the day's limits.
'use strict';

module.exports = H => {
  const { test, eq } = H;
  const ends = require('./ed_endings')(H);
  const ordinary = (n, at) => ends.signal(n, { at, words: `Pixel owners say app ${n} is slow DECLOW, story ${n}` });

  test('early detection check stopped: a check that stops before its end has counted the 3 ordinary signals it queued against the day and the hour; the next check in that hour queues only 3 more of its 5 (the hour\'s 6 ordinary ones)', () => {
    const w = ends.world({ flow: 'one-space', row46: false, settings: {} });
    w.busy = true;  // no review: the queue holds what was queued
    w.t.bot.__stop = false;
    // the check's end (its note of the day's counts and C19) never comes while __stop is set
    w.t.bot.ev('noteEarlyWave_ = (f => function () { if (__stop) return; return f.apply(this, arguments); })(noteEarlyWave_)');
    w.t.bot.__stop = true;
    let look = w.run('09:01', [1, 2, 3].map(n => ordinary(n, '09:01')));
    w.t.bot.__stop = false;
    eq([look.waiting, look.day.queued, look.day.hr], [3, 3, ['2026-10-14 09', 3, 3]]);
    look = w.run('09:16', [4, 5, 6, 7, 8].map(n => ordinary(n, '09:16')));
    eq([look.waiting, look.day.queued, look.day.hr], [6, 6, ['2026-10-14 09', 6, 6]]);
    const n = w.t.bot.edDayNumbers_(w.t.g.services.PropertiesService.getScriptProperties());
    eq(n, { found: 6, cards: 0, under: 0, letgo: 0, never: 0, waiting: 6 });
  });
};
