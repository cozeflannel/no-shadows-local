// Step S19c of the requirements-first plan (one path with the Watch, and growth), what is built of it: under Control
// row 51 with open_requirements_first, an alert in another format (the Watch's cards, the Other alerts space) with a
// Sensitive Topic counts as collected whatever its engagements, as the alert requirements have it; with row 51 OFF or
// the setting false, as before. The rest of the step (the Watch's one-check hold for a queued pass, growth, same-story
// replies) needs step S19b's list of passes, not built. Every post here is made up.
'use strict';

module.exports = H => {
  const { test, eq, NOW, makeGoogle, loadBot } = H;

  function bot(on, settings) {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    if (settings) Object.assign(b.ev('GEN').settings, settings);
    b.ewsRunSwitches_(on ? { openEngine: true, earlyWave: true } : {});
    return b;
  }

  test('rq watch (S19c): a Sensitive Topic at 12 engagements is collected under requirements first; not with row 51 OFF or the setting false; a P0 tag, a KOF and 100+ engagements as before', () => {
    const topic = bot(true).ev('GEN.sensitive_topics')[0].name;
    const few = { n: 12, min: 0, max: null };
    const tier = { n: null, min: 0, max: 199 };
    const fields = o => Object.assign({ exposure_tag: '', kof: false, kof_lists: [], risk_tags: [] }, o);
    const on = bot(true);
    eq([on.otherCollected_(fields({ risk_tags: [topic] }), few), on.otherCollected_(fields({ risk_tags: [topic] }), tier), on.otherCollected_(fields({}), few)],
      [true, true, false]);
    const off = bot(false);
    const unset = bot(true, { open_requirements_first: false });
    eq([off.otherCollected_(fields({ risk_tags: [topic] }), few), unset.otherCollected_(fields({ risk_tags: [topic] }), few),
      off.otherCollected_(fields({ risk_tags: [topic] }), tier)], [false, false, null]);  // (a tier and no count: it can't tell)
    const p0 = on.ev("GEN.exposure_tags.find(t => t.priority === 'P0').name");
    eq([off.otherCollected_(fields({ exposure_tag: p0 }), few), off.otherCollected_(fields({ kof: true }), few), off.otherCollected_(fields({}), { n: 100, min: 0, max: null })],
      [true, true, true]);
  });
};
