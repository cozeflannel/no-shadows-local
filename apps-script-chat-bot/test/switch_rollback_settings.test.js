// Rollback settings (config/default_config.yaml burson_qa -> triage_agent/config.py BursonQAConfig -> Generated.gs
// GEN.settings): each guards one new behaviour of the bot, default on, so it can be turned off by a config change, a
// rebuild and a clasp push, with no revert. A true/false one is read as `settings.<name> !== false`; a number at 0 keeps
// the rule the bot had before.
'use strict';

module.exports = H => {
  const { test, eq, B } = H;
  const golden = require('./golden_flows')(H);

  test('rollback settings: GEN.settings carries the seven settings, each with its default (Early Detection first, 6 ordinary reviews an hour and 150 a day, a topic\'s pace jump from 3 times its usual count, the Early Detection tab, the notes under another alert\'s card, the Alert requirements line), and the golden scenarios\' "every new setting off" turns off exactly these', () => {
    const S = B.ev('GEN').settings;
    const defaults = {
      early_detection_first: true,
      early_wave_reviews_per_hour: 6,
      early_wave_reviews_per_day: 150,
      early_wave_topic_min_ratio: 3,
      early_detection_tab: true,
      cross_alert_notes: true,
      requirement_line: true,
    };
    eq(Object.fromEntries(Object.keys(defaults).map(k => [k, S[k]])), defaults);
    // off, each keeps what the bot did before: false, or 0 for the hourly rule and the topic ratio (the day's 150 is
    // only read while the hourly rule is on)
    eq(golden.SETTINGS_OFF, { early_detection_first: false, early_wave_reviews_per_hour: 0, early_wave_reviews_per_day: 150,
      early_wave_topic_min_ratio: 0, early_detection_tab: false, cross_alert_notes: false, requirement_line: false });
    eq(Object.keys(golden.SETTINGS_OFF).sort(), Object.keys(defaults).sort());
  });
};
