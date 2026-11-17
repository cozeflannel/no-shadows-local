// Step S18 of the open-engine plan ("Why not this post?", WhyNot.gs): under Control row 51 a person who writes "why not
// <link>" in the Auto-correct space gets an answer in its thread from what the bot holds about the post, read-only: the
// alert memory, the Watch detections tab, Early Detection's stories and pool; or that it holds nothing. Through the leak
// guard; never in S-F Burson or the Burson test copy; with row 51 OFF, as before. Every post and account is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, NOW, makeGoogle, loadBot } = H;
  const MIN = 60 * 1000;
  const POST = 'https://x.com/smallacct/status/1980000000000000777';

  function bot() {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    return { g, b };
  }
  const facts = o => Object.assign({ memory: null, watch: null, story: null, pool: null }, o);

  test('why not (S18): the question is "why not <link>" (a Chat link\'s markup allowed); anything else is not one', () => {
    const { b } = bot();
    eq([b.whyNotLink_(`why not ${POST}`), b.whyNotLink_(`Why not: <${POST}|the post>?`), b.whyNotLink_(`why not ${POST} and also this`),
      b.whyNotLink_('why not ask Burson about it'), b.whyNotLink_(`look at ${POST}`)], [POST, POST, '', '', '']);
  });

  test('why not (S18): the answer from each store: an alert or a card already out, a Watch flag and what came of it, the story it joined, the pool it waits in, nothing held; each at most 200 characters and clear of the leak guard', () => {
    const { b } = bot();
    const texts = [
      b.whyNotText_(facts({ memory: { outcome: 'emailed', alert_id: 'QA-41', at: NOW - 60 * MIN } })),
      b.whyNotText_(facts({ memory: { outcome: 'claimed', claim: 'Direct BigQuery' } })),
      b.whyNotText_(facts({ watch: { a: 'b' } })),
      b.whyNotText_(facts({ watch: { a: 'o' } })),
      b.whyNotText_(facts({ story: { lab: 'Pixel 10 battery drains overnight', accounts: 3, at: NOW - 20 * MIN, source: 'Sonar' } })),
      b.whyNotText_(facts({ pool: { at: NOW - 5 * MIN, source: 'Tubular' } })),
      b.whyNotText_(facts({})),
    ];
    eq(texts[0], `Why not: a Social Alert already went out for it at ${b.whyNotAt_(NOW - 60 * MIN)}.`);
    eq(texts[2], 'Why not: the Watch flagged it; it waits for 3 accounts on its story before one alert goes out.');
    eq(texts[4], `Why not: read ${b.whyNotAt_(NOW - 20 * MIN)} from Sonar; it joined the story "Pixel 10 battery drains overnight" (3 accounts so far).`);
    eq(texts[5], `Why not: read ${b.whyNotAt_(NOW - 5 * MIN)} from Tubular; it waits for other posts on the same story (none yet).`);
    texts.forEach(t => {
      assert.ok(t.startsWith('Why not: ') && t.length <= 200, `${t.length}: ${t}`);
      eq(b.outboxGuardHits_(t), []);
      eq(b.isBotFormattedText_(t), true);  // the bot's own words: never answered as a person's
    });
    console.log(`    (longest answer: ${Math.max(...texts.map(t => t.length))} characters)`);
  });

  test('why not (S18): what is held is found by the post\'s key whatever the link\'s form: the story it joined and the pool in Early Detection\'s cache, the Watch detections tab (the bot\'s own only), the alert memory', () => {
    const { g, b } = bot();
    g.props.set('EWS_STATE', JSON.stringify({ cl: 1, pool: [[NOW - 10 * MIN, 1]] }));
    g.cache.set('ews1:cl:0', JSON.stringify([{ id: 'c1', s: 'x', n: 3, lab: 'Pixel 10 battery drains overnight',
      m: ['a', 'b', 'c'].map((who, i) => ({ i: `SONAR|${who}`, a: `X:${who}`, u: i ? `https://x.com/${who}/status/1${i}` : `${POST}?s=20`, t: NOW - 30 * MIN, j: NOW - 20 * MIN })) }]));
    g.cache.set(`ews1:pv:${NOW - 10 * MIN}:0`, JSON.stringify([{ i: 'TUB|v1', u: 'https://www.youtube.com/watch?v=pooled1', v: 'AAAA', g: NOW - 5 * MIN }]));
    eq(b.whyNotFacts_({}, `https://www.x.com/smallacct/status/1980000000000000777/`).story, { lab: 'Pixel 10 battery drains overnight', accounts: 3, at: NOW - 20 * MIN, source: 'Sonar' });
    eq(b.whyNotFacts_({}, 'https://www.youtube.com/watch?v=pooled1').pool, { at: NOW - 5 * MIN, source: 'Tubular' });
    // the Watch detections tab: the bot's own (its title in A1) is read; a person's tab of that name is not
    const ss = g.services.SpreadsheetApp.create('bot');
    const own = ss.insertSheet('Watch detections');
    own.getRange(1, 1).setValue(b.ev('PW_DET_TITLE_'));
    const row = Array(19).fill('');
    row[5] = POST;
    row[18] = JSON.stringify({ k: b.recordKey_({ post_url: POST }), a: 'b' });
    own.getRange(14, 1, 1, 19).setValues([row]);
    eq(b.whyNotFacts_({ ss }, POST).watch.a, 'b');
    own.getRange(1, 1).setValue('My own notes');
    eq(b.whyNotFacts_({ ss }, POST).watch, null);
    // the alert memory: what it says of the post
    b.alertMemory_ = () => ({ seenPost: u => (u === POST ? { outcome: 'emailed', alert_id: 'QA-7' } : null) });
    eq(b.whyNotFacts_({}, POST).memory, { outcome: 'emailed', alert_id: 'QA-7' });
  });

  test('why not (S18): in a run of the one-space setup with row 51 ON, a person\'s "why not <link>" in the Auto-correct space gets the answer in its thread, from what is held (nothing here), with no Gemini call for it; nothing reaches S-F Burson; with row 51 OFF no such answer', () => {
    const golden = require('./golden_flows')(H);
    const run = on => {
      const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true }));
      if (on) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
      w.rec.collect('setup');
      w.rec.step('the first run', 1);
      const AC = golden.spaces.AC;
      let asked = null;
      const before = w.t.g.vertex.calls.length;
      let sheet = null;
      const answer = w.t.bot.whyNotAnswer_;
      w.t.bot.whyNotAnswer_ = function (ctx) { sheet = !!(ctx && ctx.ss); return answer.apply(null, arguments); };
      w.rec.step('the question', 1, () => { asked = w.t.chat.say(AC, `why not ${POST}`, { sender: 'users/owner1', displayName: 'Sam Owner' }); });
      const replies = w.t.chat.botPosts(AC).filter(p => p.thread && p.thread.name === asked.thread.name && p.name !== asked.name);
      const toBurson = w.t.chat.calls.filter(c => c.method !== 'get' && String(c.path).indexOf(golden.spaces.REAL) === 0);
      return { replies: replies.map(p => p.text), vertex: w.t.g.vertex.calls.length - before, burson: toBurson.length, sheet };
    };
    const on = run(true);
    eq(on.replies.length, 1);
    assert.ok(/^Why not: nothing is held here on this post/.test(on.replies[0]), on.replies[0]);
    eq([on.vertex, on.burson, on.sheet], [0, 0, true]);  // (the run's sheet is there for the Watch detections tab)
    const off = run(false);
    eq(off.replies.some(t => /^Why not:/.test(t)), false);
  });

  test('why not (S18): the leak guard: a story whose words name something kept internal is answered without them', () => {
    const { b } = bot();
    const posted = [];
    const ctx = { spaces: { analyst: { id: 'spaces/AAQAautocorrect9' } }, store: { markDone: () => {} }, log: () => {} };
    b.whyNotFacts_ = () => ({ memory: null, watch: null, pool: null, story: { lab: 'SLRR relay test via Zapier', accounts: 2, at: NOW, source: 'Sonar' } });
    b.postTo_ = (c, space, text) => posted.push([space, text]);
    b.whyNotAnswer_(ctx, { name: 'spaces/AAQAautocorrect9/messages/m1', thread: 'spaces/AAQAautocorrect9/threads/t1' }, POST, { answers: 0 });
    eq(posted.length, 1);
    eq([posted[0][0], /SLRR|Zapier|relay/.test(posted[0][1]), /joined a story \(2 accounts so far\)/.test(posted[0][1])], ['spaces/AAQAautocorrect9', false, true]);
  });
};
