// Step S11 of the open-engine plan (quick looks for every candidate; 2 accounts; the raise and hold rules), what is built
// of it: under Control row 51 the quick looks have no count a check or a day (the day's quick-look ceiling, ApiGuard's
// runaway ceilings and the run's time bound them); a check's candidates are asked side by side, one fetchAll a batch
// (decisionsAskMany_: any question set and input shape); a 429 on one call pauses nothing, more than half failing
// pauses as one failure does today; a blank B45 reads 2 accounts; a story is raised early on about Google and brand risk
// at the watch bar and medium-or-worse severity at the confidence bar, or a P0 share of 0.35; a signal whose most
// probable severity is none at open_hold_none_at (0.80) is held back. With row 51 OFF everything is as before.
'use strict';

module.exports = H => {
  const { test, eq, NOW, makeGoogle, loadBot } = H;
  const fs = require('fs');
  const path = require('path');
  const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decisions_fixtures.json'), 'utf8'));
  const Q = FX.probe.doc_multi.request.questions;

  /** A bot whose Decisions calls answer as `reply(i)` says (i: the call's number); counts the fetchAll batches. */
  function bot(on, reply) {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    if (on) b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    const answer = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body), getHeaders: () => ({}) });
    const orig = g.services.UrlFetchApp.fetch;
    let n = 0;
    b.UrlFetchApp.fetch = (url, params) => {
      if (String(url).includes('secretmanager.googleapis.com/')) {
        return answer(200, { payload: { data: Buffer.from('test-only-decisions-key-value-99', 'utf8').toString('base64') } });
      }
      if (String(url).includes('/decisions')) {
        const r = (reply || (() => [200, FX.probe.doc_multi.response.body]))(n++);
        return answer(r[0], r[1]);
      }
      return orig(url, params);
    };
    const batches = [];
    const all = b.UrlFetchApp.fetchAll;
    b.UrlFetchApp.fetchAll = reqs => { batches.push(reqs.length); return all(reqs); };
    return { g, b, batches, calls: () => n };
  }
  const items = n => Array.from({ length: n }, (_, i) => ({ input: `Customer audio cuts out on the left earcup, case ${i}.`, questions: Q }));
  const state = w => w.b.decState_(w.b.PropertiesService.getScriptProperties(), NOW);

  test('open quick looks (S11): 20 asks in one fetchAll; a 429 on one of them leaves the other 19 answered and pauses nothing; more than half failing pauses every call for one check\'s interval', () => {
    const w = bot(true, i => (i === 7 ? [429, { error: { code: 429, message: 'Resource exhausted' } }] : [200, FX.probe.doc_multi.response.body]));
    const res = w.b.decisionsAskMany_(items(20), w.b.decSession_(() => 200 * 1000, false));
    eq([w.batches, res.filter(r => r.ok).length, res[7].ok, state(w).until > NOW], [[20], 19, false, false]);
    const v = bot(true, i => (i < 11 ? [503, { error: { message: 'backend' } }] : [200, FX.probe.doc_multi.response.body]));
    v.b.decisionsAskMany_(items(20), v.b.decSession_(() => 200 * 1000, false));
    eq(Math.round((state(v).until - NOW) / 60000), 5);
    // paused: the next batch asks nothing
    const again = v.b.decisionsAskMany_(items(3), v.b.decSession_(() => 200 * 1000, false));
    eq([again.every(r => r.skipped), v.calls()], [true, 20]);
  });

  test('open quick looks (S11): no count of 15 a check or 150 a day with row 51 ON; with it OFF the counts hold', () => {
    const on = bot(true).b;
    const off = bot(false).b;
    const s = b => Object.assign(b.decSession_(() => 200 * 1000, false), { asked: 15 });
    eq([on.decSkipWhy_(s(on), { until: 0, asked: 500 }, NOW), off.decSkipWhy_(s(off), { until: 0, asked: 0 }, NOW)], ['', '15 calls this check']);
  });

  test('open quick looks (S11): a blank B45 reads 2 accounts with row 51 ON (3 with it OFF); a value someone chose is kept', () => {
    const spec = b => b.ev("FT_BAR_SPECS_.find(s => s.key === 'accounts')");
    const on = bot(true).b;
    const off = bot(false).b;
    eq([on.ftBarFrom_(spec(on), '').value, off.ftBarFrom_(spec(off), '').value, on.ftBarFrom_(spec(on), 4).value], [2, 3, 4]);
  });

  test('open quick looks (S11): the raise rule (about Google and brand risk at the watch bar, medium or worse at the confidence bar; or a P0 share of 0.35) and the wider hold-back (severity none at 0.80), with row 51 ON; the old bars with it OFF', () => {
    const on = bot(true).b;
    const off = bot(false).b;
    // the most serious recorded story (critical, 0.80 sure, independent reports 0.13): raised now, held out before
    const critical = { g: 0.95, r: 0.9, i: 0.13, n: 0.05, sc: 0.8, l: 4, sp: [0, 0.05, 0.05, 0.1, 0.8], p0: 0.2 };
    const p0 = { g: 0.4, r: 0.3, i: 0.1, n: 0.2, sc: 0.5, l: 1, sp: [0.2, 0.5, 0.2, 0.05, 0.05], p0: 0.6 };
    const low = Object.assign({}, p0, { p0: 0.1 });
    eq([on.ewsWatchRaise_(critical), on.ewsWatchRaise_(p0), on.ewsWatchRaise_(low)], [true, true, false]);
    eq([off.ewsWatchRaise_(critical), off.ewsWatchRaise_(p0)], [false, false]);
    const none = { g: 0.6, r: 0.2, i: 0.1, n: 0.3, sc: 0.88, l: 0, sp: [0.88, 0.1, 0.02, 0, 0], p0: 0 };
    const facts = { risk_groups: '', tag_raised: false };  // (a row that says its risk facts: one without is never held)
    eq([on.ftHoldWhy_(facts, none), off.ftHoldWhy_(facts, none)], ['most likely nothing (severity none 0.88)', '']);
    eq(on.ftHoldWhy_({ risk_groups: 'privacy_data_leak', tag_raised: false }, none), '');  // a P0 risk group is never held
  });

  test('open quick looks (S11): a check\'s candidates are asked side by side (one fetchAll), and the loops then read their answers back without asking again; with row 51 OFF one call at a time', () => {
    const rows = n => Array.from({ length: n }, (_, i) => ({ alert_id: `ED-CLU-q${i}`, headline: `Pixel phones freeze after the update ${i}`,
      unique_low_tier_authors: 5, representative_posts_json: '[]', topic_product: 'Pixel', signal_type: 'CLUSTER_EMERGENCE' }));
    const sig = Object.values(FX.signal_responses)[0];  // a recorded answer to the six questions about a signal
    const reply = () => [200, sig];
    // (the third answer fails: the loop does not ask it again in this check)
    const w = bot(true, i => (i === 2 ? [503, { error: { message: 'backend' } }] : reply()));
    const ft = { session: w.b.decSession_(() => 200 * 1000, false), rank: true, hold: true, bars: {}, now: () => NOW, log: () => {}, asked: 0, missed: {}, held: 0,
      watch: { asked: 0, raised: 0 }, verdicts: [] };
    const list = rows(4);
    w.b.ftAskAll_(ft, list);
    const after = w.calls();
    list.forEach(r => w.b.ftAsk_(ft, r));
    eq([w.batches, after, w.calls(), ft.asked], [[4], 4, 4, 3]);
    const off = bot(false, reply);
    off.b.ftAskAll_(Object.assign({}, ft, { batched: undefined }), list);
    eq(off.batches, []);
  });
  test('open quick looks (S11): in a run, the check\'s candidates go to Gemini Decisions in one batch with row 51 ON; one call each with it OFF', () => {
    const golden = require('./golden_flows')(H);
    const run = on => {
      const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF,
        { early_detection_first: true, early_wave_reviews_per_hour: 6, early_wave_reviews_per_day: 150 }));
      if (on) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
      const batches = [];
      const all = w.t.g.services.UrlFetchApp.fetchAll;
      w.t.g.services.UrlFetchApp.fetchAll = reqs => {
        const n = (reqs || []).filter(r => /\/decisions/.test(String(r.url || r))).length;
        if (n) batches.push(n);
        return all(reqs);
      };
      w.rec.collect('setup');
      w.rec.step('the first run', 1);
      const base = golden.rows.story({});
      const stories = [1, 2, 3].map(n => Object.assign({}, base, { alert_id: `ED-CLU-clu_qb${n}-202610141200`, cluster_id: `clu_qb${n}`,
        signal_key: `clu_qb${n}`, primary_url: `https://x.com/qb${n}/status/2180000000000000${n}`, risk_groups: '', tag_raised: false,
        representative_posts_json: JSON.stringify([{ url: `https://x.com/qb${n}/status/2180000000000000${n}`, snippet: `Story ${n} about Chrome tabs`, author_handle: `qb${n}` }]) }));
      w.rec.step('the stories', 15, () => { w.feed.stories = stories; });
      return batches;
    };
    eq(run(true).some(n => n >= 3), true);
    eq(run(false), []);
  });
};
