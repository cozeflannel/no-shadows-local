// Step S10 of the open-engine plan: the new sources' rules amended under Control row 51 (its O8 and A4): no trial week,
// no cap on the stories only a new source lifts, no share of the embeddings or the pool for the new lanes (and no day's
// pace for them); Brandwatch live read at every Early Detection check; the AMIE table read 5,000 rows a check from its
// mark. With row 51 OFF the new-lane rules are exactly as they are (switch_ed_new_lanes.test.js).
'use strict';

module.exports = H => {
  const { test, eq, NOW, makeGoogle, loadBot } = H;
  const MIN = 60 * 1000;

  function bot(on, settings) {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    if (settings) Object.assign(b.ev('GEN').settings, settings);
    b.ewsRunSwitches_(on ? { openEngine: true, earlyWave: true } : {});
    return b;
  }
  const keys = ['embedPerCheck', 'embedPerDay', 'poolMax', 'trialDays', 'liftedPerHour', 'liftedPerDay', 'lateMinutes', 'poolMinutes', 'carryMax'];

  test('open new sources (S10): with row 51 ON no trial, no lifted-story cap and no share of embedding or pool for the new lanes; their lateness, pool age and carry stay; with it OFF the settings rule as before', () => {
    const on = bot(true, { early_wave_new_trial_days: 7 }).ewsNewCfg_();
    eq(keys.map(k => on[k]), [Infinity, Infinity, Infinity, 0, Infinity, Infinity, 180, 120, 100]);
    const off = bot(false, { early_wave_new_trial_days: 7 }).ewsNewCfg_();
    eq(keys.map(k => off[k]), [100, 5000, 300, 7, 2, 20, 180, 120, 100]);
  });

  test('open new sources (S10): the embedding split under row 51 gives the new lanes every text the check has room for, with no day\'s pace; with it OFF their share and pace hold', () => {
    const post = (i, nl) => ({ chash: `${nl ? 'n' : 't'}${i}`, nl: !!nl, text: 'x' });
    const need = Array.from({ length: 50 }, (_, i) => post(i, false)).concat(Array.from({ length: 900 }, (_, i) => post(i, true)));
    const on = bot(true);
    // (a busy day: 20,000 texts embedded already, past the day's pace)
    const a = on.ewsEmbedSplit_(need, Infinity, 20000, 5000, NOW, on.ewsNewCfg_());
    eq([a.today, a.fresh, a.barred], [50, 900, false]);
    const off = bot(false);
    const z = off.ewsEmbedSplit_(need, 400, 0, 0, NOW, off.ewsNewCfg_());
    eq([z.today, z.fresh <= 350], [50, true]);
  });

  test('open new sources (S10): Brandwatch live is read at every Early Detection check (a minute under its interval) and the AMIE table takes 5,000 rows a check, with row 51 ON; with it OFF every 10 minutes and the setting\'s 300', () => {
    const on = bot(true);
    const off = bot(false);
    eq([on.bwLiveEveryMs_() / MIN, off.bwLiveEveryMs_() / MIN], [4, 10]);
    eq([on.ewsAmiCfg_().take, off.ewsAmiCfg_().take], [5000, 300]);
  });
};
