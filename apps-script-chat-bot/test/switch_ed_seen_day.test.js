// Early Detection's seen map under the Auto-correct flow's allowance (BigQuery.gs earlyWaveSeen_): the signals' own ids
// are kept apart (EARLY_DETECTION_SEEN_IDS) and the story keys in two properties (EARLY_DETECTION_SEEN, then
// EARLY_DETECTION_SEEN_2), each at most 8,800 characters, so the story keys of a whole day at 150 queued stay known and a
// story dismissed in the morning is still a repeat at night. Under the old rule the map is one property, as it was.
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;
  const ends = require('./ed_endings')(H);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const SEEN = ['EARLY_DETECTION_SEEN', 'EARLY_DETECTION_SEEN_2', 'EARLY_DETECTION_SEEN_IDS'];

  /** A day of checks every 15 minutes: 150 signals queued (their id and story keys marked), 6 more ids an hour. */
  const day = (bot, p, idMs) => {
    const start = NOW - 24 * HOUR + MIN;
    let n = 0;
    for (let c = 0; c < 96; c++) {
      const at = start + c * 15 * MIN;
      const seen = bot.earlyWaveSeen_(p, at, idMs);
      const queue = c < 54 ? 2 : 1;  // 54 checks of 2 and 42 of 1: 150 a day
      for (let i = 0; i < queue; i++) {
        const sig = ends.signal(2000 + n++, { au: 7 });
        bot.edRowKeys_(sig).forEach(k => seen.add(k, at, k.indexOf('id:') === 0 ? 0 : 7));
      }
      for (let i = 0; i < 2; i++) seen.add(`id:ED-REFUSED-${c}-${i}`, at);
      seen.save();
    }
    return n;
  };

  test('early detection seen map: under the allowance a day of 150 queued signals keeps every story key (the first, of 23 hours ago, too), with the ids kept apart and each of the three properties at most 8,800 characters; under the old rule it is the one property, cut to 200 entries, as before', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const p = g.services.PropertiesService.getScriptProperties();
    eq(day(bot, p, bot.ev('EW_SEEN_ID_MS_')), 150);
    SEEN.forEach(k => assert.ok(String(g.props.get(k) || '').length <= 8800, `${k}: ${String(g.props.get(k) || '').length}`));
    assert.ok(g.props.get('EARLY_DETECTION_SEEN_2'), 'the older story keys are in the second property');
    const seen = bot.earlyWaveSeen_(p, NOW, bot.ev('EW_SEEN_ID_MS_'));
    const storyKeys = n => bot.edRowKeys_(ends.signal(n, { au: 7 })).slice(1);
    // the first story of the day (23 hours 59 minutes ago) and the last are known, with their accounts
    eq([seen.authors(storyKeys(2000)), seen.authors(storyKeys(2149))], [7, 7]);
    // an id of 3 hours ago is known; one of 4 hours ago has gone (the producer keeps a signal 3 hours)
    eq([seen.has('id:ED-REFUSED-84-0'), seen.has('id:ED-REFUSED-79-0')], [true, false]);
    const ids = JSON.parse(g.props.get('EARLY_DETECTION_SEEN_IDS'));
    assert.ok(Object.values(ids).every(v => typeof v === 'number'), 'the ids property holds only ids');

    // a dropped signal's story taken out from outside a check (edSeenForget_ with no map of its own) keeps the layout
    eq(bot.edSeenForget_(p, ends.signal(2149, { au: 7 }), NOW), true);
    assert.ok(g.props.get('EARLY_DETECTION_SEEN_2') && g.props.get('EARLY_DETECTION_SEEN_IDS'), 'still three properties');
    eq(bot.earlyWaveSeen_(p, NOW).authors(storyKeys(2000)), 7);

    // the old rule: one property, as it always was (the other two are taken out)
    const g2 = makeGoogle(NOW);
    const bot2 = loadBot(g2.services, g2.clock);
    const p2 = g2.services.PropertiesService.getScriptProperties();
    day(bot2, p2, 0);
    eq([Object.keys(JSON.parse(g2.props.get('EARLY_DETECTION_SEEN'))).length, g2.props.has('EARLY_DETECTION_SEEN_2'),
      g2.props.has('EARLY_DETECTION_SEEN_IDS')], [200, false, false]);
    eq(bot2.earlyWaveSeen_(p2, NOW, 0).authors(storyKeys(2000)), null);  // a short memory, as before
    bot.earlyWaveSeen_(p, NOW, 0).save();
    eq([g.props.has('EARLY_DETECTION_SEEN_2'), g.props.has('EARLY_DETECTION_SEEN_IDS')], [false, false]);
  });
};
