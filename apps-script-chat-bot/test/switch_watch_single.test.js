// Step S13 of the open-engine plan (the Watch: a single worrying post goes out alone), what is built of it: under
// Control row 51, in the Auto-correct space, a flag the AI pre-read judged meaningful (true, not just "not judged")
// with a P1 Exposure Tag or a Sensitive Topic is an alert of its own, whatever its reach; with no pre-read, in the
// Mirror or Other alerts spaces, or with row 51 OFF, today's rules. When flags have waited 10 minutes or more for their
// pre-read for want of time, the Auto-correct flow's background steps stop at 210 s so the Watch has time to read them
// (Burson's own alerts keep their time). Brandwatch mentions' 1,000 a day goes (a look's cap stays). Every post and
// account here is made up.
'use strict';

module.exports = H => {
  const { test, eq, NOW, makeGoogle, loadBot } = H;
  const MIN = 60 * 1000;

  function bot(on) {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    b.ewsRunSwitches_(on ? { openEngine: true, earlyWave: true } : {});
    return { g, b };
  }
  const flag = (eng, o) => ({ q: { k: { k: 'key1', s: NOW - 12 * MIN } }, a: Object.assign({ eng, author: '@smallacct', network: 'X', followers: 300 }, o || {}) });
  const AC = { choice: 'autocorrect' };

  test('watch single (S13): with row 51 ON, in the Auto-correct space, a 5-engagement flag the pre-read judged meaningful with a P1 tag or a Sensitive Topic is an alert of its own; not in the Mirror or Other alerts spaces, not when the pre-read did not say meaningful (or there was none), not with row 51 OFF; a P2 tag never', () => {
    const on = bot(true).b;
    const off = bot(false).b;
    const p1 = on.ev("GEN.exposure_tags.find(t => t.priority === 'P1').name");
    const p2 = on.ev("GEN.exposure_tags.find(t => t.priority === 'P2').name");
    const topic = on.ev('GEN.sensitive_topics')[0].name;
    const pre = o => Object.assign({ meaningful: true, tag: '', topics: [] }, o);
    eq([on.pwSolo_(flag(5), pre({ tag: `${p1} (P1)` }), AC), on.pwSolo_(flag(5), pre({ topics: [topic] }), AC)],
      [`a P1 tag (${p1})`, `a Sensitive Topic (${topic})`]);
    eq([on.pwSolo_(flag(5), pre({ tag: `${p1} (P1)` }), { choice: 'mirror' }), on.pwSolo_(flag(5), pre({ tag: `${p1} (P1)` }), { choice: 'other' }),
      on.pwSolo_(flag(5), pre({ tag: `${p1} (P1)`, meaningful: null }), AC), on.pwSolo_(flag(5), null, AC),
      on.pwSolo_(flag(5), pre({ topics: [topic], meaningful: false }), AC), on.pwSolo_(flag(5), pre({ tag: `${p2} (P2)` }), AC),
      off.pwSolo_(flag(5), pre({ tag: `${p1} (P1)` }), AC), off.pwSolo_(flag(5), pre({ topics: [topic] }), AC)],
    ['', '', '', '', '', '', '', '']);
    // the listening tool's P1 tag alone (no pre-read tag) is not the pre-read's judgment: today's rules
    eq(on.pwSolo_(flag(5, { tax: { p: [], t: p1, s: [], k: false, l: '' } }), pre({}), AC), '');
    // today's reasons come first and are unchanged
    eq([on.pwSolo_(flag(150), pre({ topics: [topic] }), AC), on.pwSolo_(flag(5, { tax: { k: true } }), null, AC)], ['150 engagements', 'a KOF author']);
  });

  test('watch single (S13): flags waiting for their pre-read for want of time are noted (the oldest\'s first sight); after 10 minutes the reserve is due; a pre-read that runs clears it; with row 51 OFF nothing is noted', () => {
    const { g, b } = bot(true);
    const items = [flag(5), Object.assign(flag(7), { q: { k: { k: 'key2', s: NOW - 3 * MIN } } })];
    b.pwPreReadFor_(items, [], () => 1000, NOW, true);
    eq([Number(g.cache.get('pw_preread_wait')), b.pwPreReadReserveDue_(NOW), b.pwPreReadReserveDue_(NOW - 3 * MIN)], [NOW - 12 * MIN, true, false]);
    // a later short run keeps the first sight
    b.pwPreReadFor_([items[1]], [], () => 1000, NOW + MIN, true);
    eq(Number(g.cache.get('pw_preread_wait')), NOW - 12 * MIN);
    // time for it: the pre-read runs (Gemini answers nothing usable here) and the note goes
    b.pwPreReadFor_(items, [], () => 200 * 1000, NOW + 2 * MIN, true);
    eq([g.cache.has('pw_preread_wait'), b.pwPreReadReserveDue_(NOW + 2 * MIN)], [false, false]);
    const off = bot(false);
    off.b.pwPreReadFor_(items, [], () => 1000, NOW, true);
    eq([off.g.cache.has('pw_preread_wait'), off.b.pwPreReadReserveDue_(NOW)], [false, false]);
  });

  test('watch single (S13): in a run of the Auto-correct flow, with flags waiting 10+ minutes for their pre-read, the background steps after Burson\'s pass stop at 210 s (Burson\'s pass keeps its time); without, as before', () => {
    const golden = require('./golden_flows')(H);
    const run = waiting => {
      const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF));
      w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
      w.rec.collect('setup');
      const seen = { burson: [], bg: [] };
      const once = w.t.bot.runOnce_;
      w.t.bot.runOnce_ = function (ctx) { seen.burson.push(ctx.deadline - w.t.g.clock.now); return once.apply(null, arguments); };
      w.t.bot.rqJudgeRun_ = ctx => { seen.bg.push(ctx.deadline - w.t.g.clock.now); };
      if (waiting) w.t.g.cache.set('pw_preread_wait', String(w.t.g.clock.now - 11 * MIN));
      w.rec.step('a run', 1);
      return seen;
    };
    const wait = run(true);
    const none = run(false);
    eq([wait.bg.length > 0, wait.bg.every(ms => ms <= 210 * 1000), none.bg.every(ms => ms > 210 * 1000)], [true, true, true]);
    eq([wait.burson.length > 0, wait.burson.every(ms => ms > 210 * 1000)], [true, true]);  // Burson's pass: its full time
  });

  test('watch single (S13): Brandwatch mentions\' 1,000 a day goes with row 51 ON (a look\'s cap of 60 stays); with it OFF what is left of the day still limits the look', () => {
    const today = { src: { bwm: [1000] } };
    const on = bot(true).b;
    const off = bot(false).b;
    eq([off.pwFroms_({}, NOW, today).bwm_left, on.pwFroms_({}, NOW, today).bwm_left], [0, undefined]);
    eq(on.ev("PW_SOURCES_.find(s => s.key === 'bwm').cap"), 60);
  });
};
