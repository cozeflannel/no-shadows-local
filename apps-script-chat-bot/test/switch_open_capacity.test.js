// Step S7 of the open-engine plan (ingest capacity), what is built of it: under Control row 51 an embedding call takes 80
// texts (else 25), a check embeds every post it has time for (no count of 400 a check or 20,000 a day), a lane's read
// returns up to 5,000 posts (else 1,500 real-time, 600 slow), and a check hands over up to 50 signals of a kind (else
// 8). With row 51 OFF every number is as before. Every post here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;

  function bot(on) {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    if (on) b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    return { g, b };
  }

  test('open capacity (S7): the producer\'s numbers with row 51 ON and OFF', () => {
    const names = ['rt', 'slow', 'alerts', 'embCheck', 'embDay', 'batch'];
    eq(names.map(n => bot(true).b.openEws_(n)), [5000, 5000, 50, Infinity, Infinity, 80]);
    eq(names.map(n => bot(false).b.openEws_(n)), [1500, 600, 8, 400, 20000, 25]);
  });

  test('open capacity (S7): 900 posts in one check are all embedded with row 51 ON (in calls of 80), 400 with it OFF (in calls of 25)', () => {
    const run = on => {
      const { g, b } = bot(on);
      const posts = Array.from({ length: 900 }, (_, i) => ({ id: `p${i}`, chash: `h${i}`, text: `Post ${i}: the update broke my phone again today`,
        slow: false, risk: [], t: NOW - i * 1000 }));
      const st = { day: { key: '', embedded: 0 } };
      const calls = () => g.fetches.filter(f => /:predict/.test(f.url)).length;
      const out = b.ewsEmbed_(posts, new Map(), st, NOW, NOW + 10 * 60 * 1000, null);
      return [posts.filter(p => p.vec).length, calls(), st.day.embedded, out && typeof out === 'object'];
    };
    // (the calls: one per 80 texts with row 51 ON, one per 25 OFF; a call the fake answers short is asked again once)
    const on = run(true);
    eq([on[0], on[2]], [900, 900]);
    assert.ok(on[1] >= Math.ceil(900 / 80) && on[1] <= Math.ceil(900 / 80) + 1, `${on[1]} calls`);
    const off = run(false);
    eq([off[0], off[2]], [400, 400]);
    assert.ok(off[1] >= Math.ceil(400 / 25) && off[1] <= Math.ceil(400 / 25) + 1, `${off[1]} calls`);
  });

  test('open capacity (S7): a lane\'s read asks for up to 5,000 posts with row 51 ON (1,500 and 600 with it OFF)', () => {
    const params = on => {
      const { b } = bot(on);
      const q = b.ewsLaneQuery_('us', { marks: {} }, NOW, false, 60, {});
      const ps = (q && (q.params || q.queryParameters || q.parameters)) || [];
      const list = Array.isArray(ps) ? ps : [];
      const of = name => {
        const p = list.find(x => x && x.name === name);
        return p ? Number(p.value !== undefined ? p.value : p.parameterValue && p.parameterValue.value) : null;
      };
      return [of('rt_max'), of('slow_max')];
    };
    eq([params(true), params(false)], [[5000, 5000], [1500, 600]]);
  });
  test('open capacity (S7): 20 stories that pass the bar in one check give 20 signals with row 51 ON, 8 with it OFF', () => {
    const MIN = 60 * 1000;
    const stories = Array.from({ length: 20 }, (_, n) => ({ id: `CLU-cap${n}`, s: '', n: 5, t0: NOW - 60 * MIN, ts: NOW, tp: { Pixel: 5 },
      m: Array.from({ length: 5 }, (_, i) => ({ i: `SONAR|c${n}_${i}`, a: `Forums:person${n}_${i}`, p: 'Forums',
        u: `https://forum.example.test/t/${n}/${i}`, t: NOW - 10 * MIN, s: `Pixel update ${n} broke the dialer for everyone`, d: 0.9, h: `h${n}_${i}`, b: 1 })) }));
    eq([bot(true).b.ewsPromote_(stories, [], NOW).length, bot(false).b.ewsPromote_(stories, [], NOW).length], [20, 8]);
  });
};
