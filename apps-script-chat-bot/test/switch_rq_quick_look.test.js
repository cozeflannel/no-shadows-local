// Step S19d of the requirements-first plan (the quick look for single posts), what is built of it: the four questions
// about one post (about Google, the Exposure Tag, the Sensitive Topic, the severity) with GEN's own options and words;
// an input with no link, handle, follower count, engagement or id; the verdict at the bars 0.30 / 0.35 / 0.40 / 0.50
// through escalation_; and the run's step that asks about this run's posts the code check left to a judgment, side by
// side, within the slice, counted on the Engine tab. Nothing is queued from it yet (step S19b's list is not built).
'use strict';

module.exports = H => {
  const { test, eq, assert, NOW, makeGoogle, loadBot } = H;

  function bot(on) {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    b.ewsRunSwitches_(on ? { openEngine: true, earlyWave: true } : {});
    return { g, b };
  }

  test('rq quick look (S19d): four questions with GEN\'s options (the Exposure Tags and two more, the Sensitive Topics and "none", the severity scale), and the input carries no link, handle, follower count, engagement or id', () => {
    const { b } = bot(true);
    const q = b.decPostQuestions_();
    eq(Object.keys(q), ['about_google', 'category', 'sensitive', 'severity']);
    const tags = b.ev('GEN.exposure_tags').length;
    const topics = b.ev('GEN.sensitive_topics').length;
    eq([Object.keys(q.category.criteria).length, Object.keys(q.sensitive.criteria).length], [tags + 2, topics + 1]);
    const t0 = b.ev('GEN.sensitive_topics')[0];
    eq(q.sensitive.criteria[t0.name], String(t0.description).replace(/\s+/g, ' ').trim());
    const input = JSON.parse(b.decPostInput_({ text: 'My Pixel 10 battery swelled after the update, see https://x.com/someone/status/1 @someone',
      platform: 'X', t: NOW, author: 'someone', followers: 4000, eng: 42, id: 'SONAR|abc' }));
    eq(Object.keys(input), ['signal', 'platform', 'posted_at', 'text']);
    assert.ok(!/https?:|@someone|4000|SONAR/.test(JSON.stringify(input)), JSON.stringify(input));
    eq(b.decPostInput_({ text: 'too short here' }), '');
  });

  test('rq quick look (S19d): the verdict: under 0.20 about Google fails; a P0 share at the bar gives a P0 tag and a pass; a Sensitive Topic at the bar passes; the owned-post tag alone never passes; the bars 0.30 to 0.50 count differently', () => {
    const { b } = bot(true);
    const p0Name = b.ev("GEN.exposure_tags.find(t => t.priority === 'P0').name");
    const p2Name = b.ev("GEN.exposure_tags.find(t => t.priority === 'P2').name");
    const topic = b.ev('GEN.sensitive_topics')[0].name;
    const post = { text: 'Google Pixel 10 phones are catching fire while charging overnight, three reports this week' };
    const dec = o => Object.assign({ g: 0.9, c: p2Name, cp: 0.5, p0: 0, st: 'none', stp: 0.9, sp0: 0.05, l: 1, sc: 0.6 }, o);
    eq([b.rqDecide_(dec({ g: 0.1, c: p0Name, p0: 0.72 }), post, 0.35), b.rqDecide_(dec({ c: p0Name, p0: 0.72 }), post, 0.35), b.rqDecide_(dec({ c: p0Name, p0: 0.30 }), post, 0.35),
      b.rqDecide_(dec({ st: topic, stp: 0.64, sp0: 0.7 }), post, 0.35), b.rqDecide_(dec({}), post, 0.35)], ['fail', 'pass', 'fail', 'pass', 'fail']);
    eq([0.30, 0.35, 0.40, 0.50].map(bar => b.rqDecide_(dec({ c: p0Name, p0: 0.38 }), post, bar)), ['pass', 'pass', 'fail', 'fail']);
    eq(b.rqDecide_(dec({ c: 'Content - Negative reaction to owned social post', cp: 0.9 }), post, 0.35), 'fail');
  });

  test('rq quick look (S19d): the run\'s step asks about this run\'s posts left to a judgment side by side, counts the passes at the four bars on the Engine tab, and stops at a slow batch; a post with the same text hash costs no second call; nothing with row 51 OFF', () => {
    const fs = require('fs');
    const path = require('path');
    const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decisions_fixtures.json'), 'utf8'));
    // a recorded answer to the story questions, with a Sensitive Topic answer added: the four post questions' answers
    const postBody = b => {
      const sig = JSON.parse(JSON.stringify(Object.values(FX.signal_responses)[0]));
      const topic = b.ev('GEN.sensitive_topics')[0].name;
      sig.answers.sensitive = { type: 'choice', choice: 'none', confidence: 0.9, applicability: 1, probabilities: { none: 0.9, [topic]: 0.1 } };
      ['brand_risk', 'routine_noise', 'independent_reports'].forEach(k => delete sig.answers[k]);
      return sig;
    };
    const run = (on, slow) => {
      const { g, b } = bot(on);
      // the quick look alone, as step S19d built it: the first screen (step S19h) off gives it back byte for byte
      b.ev('GEN.settings.open_first_screen = false');
      const answer = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body), getHeaders: () => ({}) });
      const orig = g.services.UrlFetchApp.fetch;
      let calls = 0;
      b.UrlFetchApp.fetch = (url, params) => {
        if (String(url).includes('secretmanager.googleapis.com/')) return answer(200, { payload: { data: Buffer.from('test-only-decisions-key-value-99', 'utf8').toString('base64') } });
        if (String(url).includes('/decisions')) { calls++; if (slow) g.clock.now += 400; return answer(200, postBody(b)); }
        return orig(url, params);
      };
      const batches = [];
      const all = b.UrlFetchApp.fetchAll;
      b.UrlFetchApp.fetchAll = reqs => { batches.push(reqs.length); return all(reqs); };
      b.engRunStart_();
      const posts = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, text: `The Pixel update ${i % 25} broke my phone and support will not help me`, platform: 'X',
        t: NOW, chash: `c${i % 25}`, rq: 'j', risk: [], eng: i }));
      b.rqKeepJudge_(posts);
      const out = b.rqJudgeRun_({ deadline: NOW + 200 * 1000, now: () => g.clock.now });
      return { out, batches, calls };
    };
    const fast = run(true, false);
    eq([fast.calls, fast.batches], [25, [10, 15]]);  // 25 distinct texts: a batch of 10, then up to 20 (15 left)
    const slow = run(true, true);  // each call 400 ms: a batch of 10 takes 4 s, over 3 s: no more asks this run
    eq([slow.batches, slow.calls], [[10], 10]);
    eq(fast.out.asked, 25);
    const off = run(false, false);
    eq([off.calls, off.batches], [0, []]);
  });
};
