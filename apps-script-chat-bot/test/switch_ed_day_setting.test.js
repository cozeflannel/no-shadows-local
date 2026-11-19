// The setting early_wave_reviews_per_day (config/default_config.yaml burson_qa): at 0 it keeps the old rule of the
// review queue, as the config's rollback note says ("false, or 0 for a number, keeps what the bot did before"), exactly
// as early_wave_reviews_per_hour at 0 does. It is never a day without story reviews.
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;
  const golden = require('./golden_flows')(H);

  test('early detection day setting: early_wave_reviews_per_day at 0 is the old rule (edAllowance_ gives null, as with the hourly setting at 0), and the one-space scenario with it posts what it posts with early_wave_reviews_per_hour at 0, its story cards included', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const ctx = settings => ({ sourceReadOnly: true, settings });
    eq(bot.edAllowance_(ctx({ early_wave_reviews_per_hour: 6, early_wave_reviews_per_day: 0 }), {}, NOW), null);
    eq(bot.edAllowance_(ctx({ early_wave_reviews_per_hour: 0, early_wave_reviews_per_day: 150 }), {}, NOW), null);
    const on = bot.edAllowance_(ctx({ early_wave_reviews_per_hour: 6, early_wave_reviews_per_day: 1 }), {}, NOW);
    eq([on.perHour, on.perDay], [6, 1]);
    const dayOff = golden.oneSpace({ early_wave_reviews_per_day: 0 });
    const hourOff = golden.oneSpace({ early_wave_reviews_per_hour: 0 });
    eq(golden.differences(dayOff, hourOff), []);
    // the story cards are there (a day of 0 reviews would have none)
    assert.ok(dayOff.chat.some(m => /Early Detection/.test(m.text)), 'the one-space scenario posts its story cards');
  });
};
