// Fixes after the review of the allowance lane (P2b, P2e, P4a):
// - Gemini Decisions' daily cap of 300 holds only under the Auto-correct flow's allowance; every other flow, and the
//   setting early_wave_reviews_per_hour at 0, keep the cap of 150 they had before (Decisions.gs decSession_'s perDay,
//   FastTriage.gs ftStart_, BigQuery.gs earlyWaveCheck_).
// - The note under another alert's card ("Part of a story") counts the accounts once (EarlyDetectionCross.gs
//   edCrossNoteText_).
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;
  const ends = require('./ed_endings')(H);

  const props = w => w.t.g.services.PropertiesService.getScriptProperties();
  const ordinary = (n, at) => ends.signal(n, { at, words: `Pixel owners say app ${n} is slow DECLOW, story ${n}` });

  /** A world whose Decisions calls are counted, with today's calls set to `asked` before the run. */
  const counted = (o, asked) => {
    const w = ends.world(Object.assign({ flow: 'one-space', row46: false }, o));
    w.calls = 0;
    const fetch = w.t.g.services.UrlFetchApp.fetch;
    w.t.g.services.UrlFetchApp.fetch = (link, params) => {
      if (String(link).includes('/decisions')) w.calls++;
      return fetch(link, params);
    };
    w.setAsked = n => {
      const st = w.t.bot.decState_(props(w), w.t.g.clock.now);
      st.asked = n;
      w.t.bot.decSaveState_(props(w), st);
    };
    if (asked !== undefined) w.setAsked(asked);
    return w;
  };

  test('early detection allowance fix: Gemini Decisions may make 300 calls a day only under the Auto-correct flow\'s allowance; the old rule (setting 0) and the Mirror flow stop at 150 as before', () => {
    // a session's cap: 150 unless a positive number is given
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    eq([bot.decSession_(() => 1, false).perDay, bot.decSession_(() => 1, false, 0).perDay,
      bot.decSession_(() => 1, false, 'x').perDay, bot.decSession_(() => 1, false, 300).perDay], [150, 150, 150, 300]);
    eq([bot.ev('DEC_MAX_PER_DAY_'), bot.ev('DEC_MAX_PER_DAY_ALLOWANCE_')], [150, 300]);

    // under the allowance (the default settings): at 150 calls today the check still asks
    const on = counted({ settings: {} }, 150);
    on.run('09:01', [ordinary(1, '09:01')]);
    eq(on.calls, 1);
    const st = on.t.bot.decState_(props(on), on.t.g.clock.now);
    eq([st.asked, st.cap], [151, 300]);
    // at 300 it stops, and C38's words name the cap in force
    on.setAsked(300);
    on.run('09:16', [ordinary(2, '09:16')]);
    eq(on.calls, 1);
    assert.match(on.t.bot.decStatusText_(props(on), on.t.g.clock.now), /^300 asked today · daily cap of 300 reached, more tomorrow$/);

    // the old rule (early_wave_reviews_per_hour 0): no call past 150, as at the base; nothing new is stored
    const old = counted({ settings: ends.OLD_RULE }, 149);
    old.run('09:01', [ordinary(1, '09:01'), ordinary(2, '09:01')]);
    eq(old.calls, 1);
    eq(Object.keys(JSON.parse(props(old).getProperty('DECISIONS_STATE'))).sort(), ['asked', 'day', 'failed', 'refused', 'until', 'why']);
    assert.match(old.t.bot.decStatusText_(props(old), old.t.g.clock.now), /^150 asked today · daily cap of 150 reached, more tomorrow$/);

    // the Mirror flow with the default settings: the same
    const mirror = counted({ flow: 'mirror', settings: {} }, 149);
    mirror.run('09:01', [ordinary(1, '09:01'), ordinary(2, '09:01')]);
    eq(mirror.calls, 1);
    assert.ok(!('cap' in mirror.t.bot.decState_(props(mirror), mirror.t.g.clock.now)));

    // a day that began under the allowance and turns to the old rule: the next call stops at 150 and the stored cap goes
    const mixed = counted({ settings: {} }, 100);
    mixed.run('09:01', [ordinary(1, '09:01')]);
    eq(mixed.t.bot.decState_(props(mixed), mixed.t.g.clock.now).cap, 300);
    Object.assign(mixed.t.bot.ev('GEN').settings, ends.OLD_RULE);
    mixed.run('09:16', [ordinary(2, '09:16')]);
    eq([mixed.calls, 'cap' in mixed.t.bot.decState_(props(mixed), mixed.t.g.clock.now)], [2, false]);

    // a new day forgets the cap with the counts
    const next = JSON.parse(props(on).getProperty('DECISIONS_STATE'));
    next.day = '2000-01-01';
    props(on).setProperty('DECISIONS_STATE', JSON.stringify(next));
    eq(on.t.bot.decState_(props(on), on.t.g.clock.now), { day: on.t.bot.dayKey_(), asked: 0, failed: 0, refused: 0, until: 0, why: '' });
  });

  test('early detection allowance fix: the note under another alert\'s card counts the story\'s accounts once', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const sig = ends.signal(7, { words: 'Pixel owners say the update drains the battery' });
    const text = bot.edCrossNoteText_(sig);
    const n = Number(sig.unique_low_tier_authors);
    assert.ok(text.startsWith(`🔗 *Part of a story:* ${n} small accounts on `), text);
    eq((text.match(/\baccounts\b/g) || []).length, 1, text);
    assert.match(text, / now tell it: “[^“”]*Pixel owners say the update drains the battery[^“”]*”/);
    // no count: the note says "Small accounts" once, and the title keeps only its quoted words
    const none = Object.assign({}, sig, { unique_low_tier_authors: 0 });
    const plain = bot.edCrossNoteText_(none);
    assert.ok(plain.startsWith('🔗 *Part of a story:* Small accounts '), plain);
    eq((plain.match(/accounts/gi) || []).length, 1, plain);
    // words that are not the plain title's count stay as they are
    eq(bot.edCrossNoteText_({ headline: '', posts: [] }).endsWith('now tell it: A story whose details are gone'), true);
  });
};
