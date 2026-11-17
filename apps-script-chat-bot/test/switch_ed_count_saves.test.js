// Early Detection's day counts when a save of them fails (BigQuery.gs edCount_): the save is tried again, and a count
// that still could not be saved is kept for the run and saved with the next note of Control C19 (noteEarlyWave_), so
// C19 shows the true ending (a card stays a card); found is made to add up only when a count was lost for good.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const ends = require('./ed_endings')(H);

  /** Makes the next `times` saves of the day's counts made inside edCount_ fail. */
  const failCounts = (w, times) => {
    const ps = w.t.g.services.PropertiesService;
    const real = ps.getScriptProperties;
    let armed = times;
    ps.getScriptProperties = () => {
      const p = real();
      const set = p.setProperty.bind(p);
      p.setProperty = (k, v) => {
        if (armed > 0 && k === 'EARLY_DETECTION_TODAY' && /edCount_/.test(String(new Error().stack))) {
          armed--;
          throw new Error('scripted: Service invoked too many times');
        }
        return set(k, v);
      };
      return p;
    };
  };

  test('early detection count saves: both saves of a card\'s ending fail while the card is posted: C19 and the day\'s numbers still show the card (1 found, 1 card), nothing is "made to add up", and the next run keeps it', () => {
    const play = times => {
      const w = ends.world({ flow: 'one-space', row46: false });
      w.busy = true;
      w.run('09:16', [ends.signal(330, { at: '09:16' })]);
      w.busy = false;
      failCounts(w, times);
      const look = w.run('09:17', null);
      const next = w.run('09:18', null);
      return { w, look, next, n: w.t.bot.edDayNumbers_(w.t.g.services.PropertiesService.getScriptProperties()) };
    };
    for (const times of [1, 2]) {
      const r = play(times);
      eq(r.look.cards.length, 1, `${times}: the card was posted`);
      eq(r.n, { found: 1, cards: 1, under: 0, letgo: 0, never: 0, waiting: 0 }, `${times} failed saves`);
      assert.match(r.look.c19, /today: 1 found, 1 card, 0 under another alert, 0 let go, 0 never reviewed, 0 waiting/);
      assert.match(r.next.c19, /today: 1 found, 1 card, 0 under another alert/);
      assert.ok(!r.look.logs.concat(r.next.logs).map(String).some(l => /did not add up/.test(l)), `${times}: nothing was made to add up`);
      eq(JSON.parse(r.w.t.g.props.get('EARLY_DETECTION_TODAY')).cards, 1);
    }
  });
};
