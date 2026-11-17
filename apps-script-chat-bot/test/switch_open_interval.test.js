// Step S6 of the open-engine plan: under Control row 51 Early Detection checks every open_check_minutes (5), paced by the
// record of run time (OpenEngine.gs openCheckMs_: every 10 minutes from 0.60 of the day's budget, every 15 from 0.70);
// the producer's own interval is a minute under it and Gemini Decisions' pause follows it. No per-check number changes.
// With row 51 OFF the checks are every 15 minutes, as before.
'use strict';

module.exports = H => {
  const { test, eq } = H;
  const golden = require('./golden_flows')(H);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  /** The one-space setup; runs every `every` minutes for `minutes`; the minutes (from the first) when a check ran. */
  function checks(off, o) {
    const x = o || {};
    const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true }));
    if (!off) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
    w.rec.collect('setup');
    if (x.f) {
      const hour = Math.floor(w.t.g.clock.now / HOUR) * HOUR;
      w.t.g.props.set('RUN_LEDGER', JSON.stringify({ v: 1, h: [[hour, x.f * 4.5 * 3600, 0, 1, 0]], p: [], a: { d: w.t.bot.openEtDay_(w.t.g.clock.now), w: 1 } }));
    }
    const at = [];
    let start = 0;
    let last = '';
    for (let i = 0; i * (x.every || 1) <= (x.minutes || 20); i++) {
      w.rec.step('a run', x.every || 1);
      if (!start) start = w.t.g.clock.now;
      const now = w.t.g.props.get('EARLY_DETECTION_AT') || '';
      if (now !== last) at.push(Math.round((Number(now) - start) / MIN));
      last = now;
    }
    return at;
  }

  test('open interval (S6): with row 51 ON a check every 5 minutes; with it OFF every 15, as before', () => {
    eq(checks(false), [0, 5, 10, 15, 20]);
    eq(checks(true), [0, 15]);
  });

  test('open interval (S6): runs exactly 5 minutes apart never skip a check (the producer\'s own interval is a minute under it)', () => {
    eq(checks(false, { every: 5, minutes: 30 }), [0, 5, 10, 15, 20, 25, 30]);
  });

  test('open interval (S6): the record of run time paces the checks: at 0.65 of the day\'s budget every 10 minutes, at 0.75 every 15; the setting open_check_minutes sets the pace below them', () => {
    eq(checks(false, { f: 0.65, minutes: 30 }), [0, 10, 20, 30]);
    eq(checks(false, { f: 0.75, minutes: 30 }), [0, 15, 30]);
    const w = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
    const b = w.t.bot;
    b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    eq([b.openCheckMs_() / MIN, b.openProducerMs_() / MIN], [5, 4]);
    b.ev('GEN.settings.open_check_minutes = 7');
    eq(b.openCheckMs_() / MIN, 7);
    b.ewsRunSwitches_({});
    eq([b.openCheckMs_() / MIN, b.openProducerMs_() / MIN], [15, 10]);
  });
  test('open interval (S6): after a failed Gemini Decisions call no call is made for one check\'s interval: 5 minutes under row 51, 15 with it OFF', () => {
    const { makeGoogle, loadBot, NOW } = H;
    const pauseOf = on => {
      const g = makeGoogle(NOW);
      const b = loadBot(g.services, g.clock);
      if (on) b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
      const answer = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body), getHeaders: () => ({}) });
      const orig = g.services.UrlFetchApp.fetch;
      b.UrlFetchApp.fetch = (url, params) => (String(url).includes('secretmanager.googleapis.com/')
        ? answer(200, { payload: { data: Buffer.from('test-only-decisions-key-value-99', 'utf8').toString('base64') } })
        : String(url).includes('/decisions') ? answer(500, { error: { message: 'backend error' } }) : orig(url, params));
      const res = b.decisionsAsk_('Customer audio cuts out on the left earcup.', { q: { type: 'noul', text: 'Is it about Google?' } },
        b.decSession_(() => 90 * 1000, false));
      const st = b.decState_(b.PropertiesService.getScriptProperties(), NOW);
      return [res.ok, Math.round((st.until - NOW) / MIN)];
    };
    eq([pauseOf(true), pauseOf(false)], [[false, 5], [false, 15]]);
  });
};
