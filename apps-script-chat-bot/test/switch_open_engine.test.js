// Step S2 of the open-engine plan: Control row 51 (key openEngine, OpenEngine.gs): the one safety stop a day (2,000
// background reviews, with its derived ceilings), the guards (ApiGuard's runaway ceilings, the wait after a 429, the web
// search protection for background work), and C51. With row 51 OFF the bot is as it was. Burson's alerts are never
// counted and never stopped. The record of run time and outside calls is in switch_run_ledger.test.js, the yield to
// Burson in switch_yield_burson.test.js. Every post, account and address here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, e2e, makeGoogle, loadBot, NOW } = H;
  const golden = require('./golden_flows')(H);
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const hourOf = ms => Math.floor(ms / HOUR) * HOUR;
  const OFF_TEXT = 'OFF (Early Detection, the Watch and Direct BigQuery keep today\'s limits)';
  const ON_TEXT = '✓ ON: one safety stop a day, and the day\'s run time and outside calls guarded so Burson\'s alerts keep their share';

  /** A bot on fake services at NOW, row 51 ON (with row 19) unless `off`. */
  function bot(o) {
    const x = o || {};
    const g = makeGoogle(x.at || NOW);
    const b = loadBot(g.services, g.clock);
    // a test that rewrites the record mid-run: the run's copy (read once a run) is dropped, as a new run would read it
    const setProp = g.props.set.bind(g.props);
    g.props.set = (k, v) => { const r = setProp(k, v); if (k === 'RUN_LEDGER') b.ev('if (OE_RUN_) OE_RUN_.L = null'); return r; };
    if (!x.off) b.ewsRunSwitches_({ openEngine: true, earlyWave: true });
    if (x.settings) Object.entries(x.settings).forEach(([k, v]) => b.ev(`GEN.settings.${k} = ${JSON.stringify(v)}`));
    b.openRunStart_(g.clock.now);
    const day = () => JSON.parse(g.props.get('OPEN_DAY') || 'null');
    return { g, b, day };
  }

  // -----------------------------------------------------------------------------------------------------------------
  // The stop
  // -----------------------------------------------------------------------------------------------------------------

  test('open engine: the day\'s safety stop of 2,000 background reviews holds the 2,001st: no review, Watch card or Direct card starts until midnight ET, quick looks go on to their own ceiling, and the stop is saved with its time', () => {
    const w = bot();
    w.b.openCountReview_(1999);
    eq([w.b.openMayStart_('review', null, {}).ok, w.b.openMayStart_('card', null, { serious: true }).ok, w.b.openStopReached_()], [true, true, false]);
    w.b.openCountReview_(1);
    eq(w.b.openMayStart_('review', null, { serious: true }), { ok: false, why: 'today\'s safety stop was reached (2,000 background reviews)', wall: '' });
    eq([w.b.openMayStart_('card', null, {}).ok, w.b.openMayStart_('batch', null, {}).ok, w.b.openMayStart_('quick', null, {}).ok, w.b.openStopReached_()], [false, false, true, true]);
    w.b.openDaySave_();
    // (h: the last background start the stop held, step S3's reason for a signal that waited out its hours)
    eq(w.day(), { d: w.b.openEtDay_(NOW), rev: 2000, ql: 0, wc: 0, gb: 0, w: {}, stop: { k: 'rev', at: NOW }, h: { k: 'stop', at: NOW } });
    // the next Eastern day starts from zero
    w.g.clock.now = NOW + 24 * HOUR;
    w.b.openRunStart_(w.g.clock.now);
    eq([w.b.openMayStart_('review', null, {}).ok, w.b.openStopReached_(), w.b.openDay_(w.g.clock.now).rev], [true, false, 0]);
    // the derived ceilings: 10x quick looks (only quick looks stop, until midnight), 100x Watch post checks, 1.5 GB x
    const q = bot();
    q.b.openCount_('ql', 19999);
    eq(q.b.openMayStart_('quick', null, {}).ok, true);
    q.b.openCount_('ql', 1);
    eq([q.b.openMayStart_('quick', null, {}).why, q.b.openMayStart_('review', null, {}).ok], ['today\'s safety stop was reached (20,000 quick looks)', false]);
    const c = bot();
    c.b.openCount_('wc', 200000);
    eq([c.b.openMayStart_('review', null, {}).why, c.b.openMayStart_('quick', null, {}).ok], ['today\'s safety stop was reached (200,000 Watch post checks)', true]);
    const gb = bot();
    gb.b.openCount_('gb', 2999.5);
    eq(gb.b.openStopReached_(), false);
    gb.b.openCount_('gb', 0.5);
    eq(gb.b.openMayStart_('card', null, {}).why, 'today\'s safety stop was reached (3,000 GB of background BigQuery reads)');
    // a setting moves all of them
    const s = bot({ settings: { open_daily_stop: 10 } });
    s.b.openCount_('ql', 99);
    s.b.openCountReview_(9);
    eq([s.b.openMayStart_('quick', null, {}).ok, s.b.openMayStart_('review', null, {}).ok], [true, true]);
    s.b.openCountReview_(1);
    eq(s.b.openMayStart_('review', null, {}).why, 'today\'s safety stop was reached (10 background reviews)');
  });

  test('open engine: with row 51 OFF nothing is counted, nothing is stopped and no day is kept, whatever is asked', () => {
    const w = bot({ off: true });
    w.b.openCountReview_(5000);
    w.b.openCount_('ql', 50000);
    w.b.openWall_('pace');
    w.b.openNote429_(NOW);
    w.b.openDaySave_();
    eq([w.b.openMayStart_('review', null, {}).ok, w.b.openMayStart_('quick', null, {}).ok, w.b.openStopReached_(), w.day(), w.g.cache.get('oe_bg429')],
      [true, true, false, null, undefined]);
  });

  /**
   * The one-space setup with a story to review; row 51 ON (with row 19, which this setup has ON) unless `off`; `day`:
   * (the Eastern day of the story's check, its time) -> OPEN_DAY, set just before the story is found.
   */
  function storyWorld(day, off) {
    const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true }));
    if (!off) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
    w.rec.collect('setup');
    w.rec.step('the first run', 1);
    w.rec.step('a check', 5);
    w.rec.step('a check', 5);
    const reviews = () => w.t.g.vertex.calls.filter(c => /early detection|Early Catch/i.test(JSON.stringify(c.payload.systemInstruction || ''))).length;
    const before = reviews();
    w.rec.step('the story is found', 5, () => {
      w.feed.stories = [golden.rows.story({})];
      const at = w.t.g.clock.now + MIN;  // the run's time (the step moves the clock on before it runs)
      if (day) w.t.g.props.set('OPEN_DAY', JSON.stringify(day(w.t.bot.openEtDay_(at), at)));
    });
    [1, 1, 5].forEach(m => w.rec.step('after', m));
    const sh = w.t.sheet().getSheetByName('Control');
    return { w, reviews: reviews() - before, c19: String(sh.cell(19, 3)), c51: String(sh.cell(51, 3)), day: JSON.parse(w.t.g.props.get('OPEN_DAY') || 'null'),
      cards: w.rec.out().chat.filter(m => !m.reply && m.text.indexOf('🚨 *EARLY DETECTION*') === 0).length };
  }

  test('open engine: in a run, the story review that would be the 2,001st background review of the Eastern day waits (C51 says the stop first, C19 ends "safety stop reached"); the next Eastern day it is reviewed; with row 51 OFF it is reviewed as before', () => {
    const asBefore = storyWorld(null, true);
    assert.ok(asBefore.reviews >= 1 && asBefore.cards === 1, JSON.stringify([asBefore.reviews, asBefore.cards]));
    const stopped = storyWorld((d, at) => ({ d, rev: 2000, ql: 0, wc: 0, gb: 0, w: {}, stop: { k: 'rev', at } }));
    eq([stopped.reviews, stopped.cards], [0, 0]);
    assert.ok(new RegExp(`^${ON_TEXT.replace(/[.?*+()]/g, '\\$&')} · ⛔ safety stop at \\d+:\\d\\d [AP]M: 2,000 background reviews today\\. Burson's alerts go on; stories, Watch and Direct cards wait until midnight ET\\. No big event\\? Tell the engineer`).test(stopped.c51), stopped.c51);
    assert.ok(stopped.c19.endsWith(' · safety stop reached'), stopped.c19);
    // the stop's day is over: yesterday's count does not hold today's review
    const nextDay = storyWorld((d, at) => ({ d: '2026-01-01', rev: 2000, ql: 0, wc: 0, gb: 0, w: {}, stop: { k: 'rev', at: at - 24 * HOUR } }));
    eq([nextDay.reviews, nextDay.cards], [asBefore.reviews, 1]);
    eq(nextDay.day.rev, asBefore.reviews);  // and its reviews are counted toward today's stop
    assert.ok(!/⛔|safety stop reached/.test(nextDay.c19 + nextDay.c51), `${nextDay.c19} // ${nextDay.c51}`);
    // row 51 ON with nothing near a wall: the same review, the same card as with it OFF
    const open = storyWorld(null);
    eq([open.reviews, open.cards], [asBefore.reviews, 1]);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // C51
  // -----------------------------------------------------------------------------------------------------------------

  test('open engine: C51 is at most 200 characters in every state, the warning first; the parts a later step adds and the walls hit are dropped before anything is cut', () => {
    const states = [];
    const at = (name, setup) => {
      const w = bot({ settings: { open_fetch_day: 100000 } });
      w.g.props.set('RUN_LEDGER', JSON.stringify({ v: 1, h: [[hourOf(NOW), 3600, 1234, 60, 61]], p: [], a: { d: w.b.openEtDay_(NOW), w: 1 } }));
      if (setup) setup(w);
      const note = w.b.openC51Text_(w.g.clock.now);
      states.push([name, note.length, note]);
      assert.ok(note.length <= 200 && note.length > 0, `${name}: ${note.length}: ${note}`);
      return note;
    };
    const B = 4.5 * 3600;
    const ledger = (w, f, calls) => w.g.props.set('RUN_LEDGER', JSON.stringify({ v: 1, h: [[hourOf(NOW), Math.round(f * B), calls || 0, 1, 0]], p: [], a: { d: w.b.openEtDay_(NOW), w: 1 } }));
    eq(at('a quiet day'), 'today: 0 of 2,000 reviews · run time 1 h 00 of 4 h 30 (24 h) · calls 1,234 of 100,000');
    const stopRev = at('the stop', w => { w.b.openCountReview_(2000); });
    eq(stopRev.split(' · ')[0], '⛔ safety stop at 8:00 AM: 2,000 background reviews today. Burson\'s alerts go on; stories, Watch and Direct cards wait until midnight ET. No big event? Tell the engineer');
    eq(at('the quick-look ceiling', w => { w.b.openCount_('ql', 20000); }).split(' · ')[0],
      '⛔ safety stop at 8:00 AM: 20,000 quick looks today. Burson\'s alerts go on; stories wait for 5 accounts until midnight ET. No big event? Tell the engineer');
    at('Watch post checks', w => { w.b.openCount_('wc', 200000); });
    at('BigQuery reads', w => { w.b.openCount_('gb', 3000); });
    eq(at('ahead of pace', w => ledger(w, 0.85)).split(' · ')[0], '⏸ run time ahead of pace (3 h 50 of 4 h 30 in 24 h): only serious stories reviewed. Burson\'s alerts go on');
    eq(at('nearly used', w => ledger(w, 0.93)).split(' · ')[0], '⏸ run time nearly used (4 h 11 of 4 h 30 in 24 h): no background reviews. Burson\'s alerts go on');
    eq(at('calls ahead of pace', w => ledger(w, 0.1, 70000)).split(' · ')[0], '⏸ outside calls ahead of pace (70,000 of 100,000 in 24 h): no quick looks. Burson\'s alerts go on');
    eq(at('calls nearly used', w => ledger(w, 0.1, 95000)).split(' · ')[0], '⏸ outside calls nearly used (95,000 of 100,000 in 24 h): no background work. Burson\'s alerts go on');
    // every wall hit, many times, and a later step's long part: the warning stays whole and first
    const crowded = at('the stop, every wall, a later step\'s part', w => {
      w.b.openCountReview_(2000);
      ['gemini', 'short', 'burson', 'guard', 'pace', 'bq', 'bw', 'storage', 'carried'].forEach(k => { for (let i = 0; i < 12345; i++) w.b.openWall_(k); });
      w.b.openC51Add_(() => 'a later step\'s part '.repeat(8));
    });
    // (a part that does not fit is left out whole: nothing is cut mid-way)
    eq(crowded, '⛔ safety stop at 8:00 AM: 2,000 background reviews today. Burson\'s alerts go on; stories, Watch and Direct cards wait until midnight ET. No big event? Tell the engineer · today: 2,000 of 2,000 reviews');
    const walls = at('walls hit', w => {
      w.b.openWall_('gemini');
      w.b.openWall_('gemini');  // the same run: once
      w.b.openWall_('burson');
      w.b.openDaySave_();  // the run's end
      w.b.openRunStart_(NOW + MIN);  // the next run
      w.b.openWall_('gemini');
    });
    assert.ok(walls.endsWith(' · walls hit: Gemini busy 2×, Burson first 1×'), walls);
    const part = at('a part', w => { w.b.openC51Add_((u, d) => `${d.rev} queued`); w.b.openC51Add_(() => { throw new Error('a broken part'); }); });
    assert.ok(part.endsWith(' · 0 queued'), part);
    // (column C is the ON text, " · " and this note: the note is what noteSwitch_ cuts at 200, as every switch's)
    console.log(states.map(([name, n, note]) => `      C51 (${name}, ${n}): ${note}`).join('\n'));
  });

  test('open engine: C51 while row 51 is OFF: the OFF text, then, once the record holds a minute of run time, the day\'s run time and Burson\'s pick-up p90; the whole stays within 200 characters', () => {
    const w = bot({ off: true });
    eq(w.b.openOffNote_(NOW), '');  // no record yet
    w.g.props.set('RUN_LEDGER', JSON.stringify({ v: 1, h: [[hourOf(NOW), 59, 10, 1, 1]], p: [] }));
    eq(w.b.openOffNote_(NOW), '');  // under a minute
    w.g.props.set('RUN_LEDGER', JSON.stringify({ v: 1, h: [[hourOf(NOW), 4800, 10, 80, 80]], p: [] }));
    eq(w.b.openOffNote_(NOW), 'run time today: 1 h 20 of 45 min (last 24 h)');
    w.g.props.set('RUN_LEDGER', JSON.stringify({ v: 1, h: [[hourOf(NOW), 99999999, 10, 80, 80]], p: Array.from({ length: 60 }, () => 86399), pd: w.b.openEtDay_(NOW) }));
    const note = w.b.openOffNote_(NOW);
    eq(note, 'run time today: 27777 h 47 of 45 min (last 24 h) · Burson pick-up 86399 s (p90)');
    const line = `${OFF_TEXT} · ${note}`;
    assert.ok(line.length <= 200, `${line.length}: ${line}`);
    console.log(`      C51 (OFF, with the record, ${line.length}): ${line}`);
  });

  test('open engine: through poll(), C51 is the OFF text after setup() and the ON text with its note once row 51 and row 19 are ON; with row 19 OFF it says it waits', () => {
    const t = e2e();
    t.bot.setup();
    const sh = t.control();
    eq([sh.cell(51, 1), sh.cell(51, 2), sh.cell(51, 3)], ['Open engine: judgment in place of caps', 'OFF', OFF_TEXT]);
    t.poll();
    eq([sh.cell(51, 2), sh.cell(51, 3)], ['OFF', OFF_TEXT]);
    sh.getRange(51, 2).setValue('ON');
    t.poll();
    eq(sh.cell(51, 3), '✓ ON, but waiting: it needs Early wave & velocity check (row 19) ON');
    eq(t.g.props.get('OPEN_DAY'), undefined);  // waiting: nothing of it runs
    t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { earlyWave: true }))(readSwitches_)');
    t.poll();
    assert.ok(String(sh.cell(51, 3)).startsWith(`${ON_TEXT} · today: 0 of 2,000 reviews · run time `), sh.cell(51, 3));
    assert.ok(String(sh.cell(51, 3)).length <= 200);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // The guards
  // -----------------------------------------------------------------------------------------------------------------

  test('open engine: ApiGuard under row 51 keeps its rolling ceilings only as a runaway guard (Gemini 120 / 500, BigQuery 150 / 700, Decisions 600 / 2,400), and a refusal there is a wall on C51; with row 51 OFF the ceilings are today\'s (25 / 90, 50 / 180, 30 / 90)', () => {
    const fill = (w, kind, n) => { for (let i = 0; i < n; i++) w.b.apiGuardNote_(kind, 1, NOW); };
    const pair = (kind, under, over, ask) => {
      const on = bot();
      const off = bot({ off: true });
      fill(on, kind, under);
      fill(off, kind, under);
      const a = [ask(on), ask(off)];
      fill(on, kind, over - under);
      return a.concat([ask(on)]);
    };
    eq(pair('gemini', 25, 120, w => w.b.apiGuardAllowBackground_('gemini', false, NOW)), [true, false, false]);
    eq(pair('bigquery', 50, 150, w => w.b.apiGuardAllowBackground_('bigquery', false, NOW)), [true, false, false]);
    eq(pair('decisions', 30, 600, w => w.b.apiGuardAllowDecisions_(NOW)), [true, false, false]);
    const w = bot();
    fill(w, 'gemini', 120);
    w.b.apiGuardAllowBackground_('gemini', false, NOW);
    eq(w.b.openDay_(NOW).w, { guard: 1 });
    // Burson's own reviews never ask ApiGuard (SLA triage): slaBusy still defers background work first, row 51 or not
    eq([bot().b.apiGuardAllowBackground_('any', true, NOW), bot({ off: true }).b.apiGuardAllowBackground_('any', true, NOW)], [false, false]);
  });

  test('open engine: a Vertex AI 429 under row 51 makes background work wait 10 minutes (a "Gemini busy" wall on C51); Burson\'s pass is not asked; with row 51 OFF only today\'s 30-second cooldown is kept', () => {
    const w = bot();
    w.b.apiGuardNoteVertex429_(NOW);
    eq([w.b.openMayStart_('review', null, { serious: true }).why, w.b.openDay_(NOW).w], ['Gemini said "too busy" in the last 10 minutes', { gemini: 1 }]);
    w.g.clock.now = NOW + 10 * MIN + SEC;
    eq(w.b.openMayStart_('review', null, {}).ok, true);
    const off = bot({ off: true });
    off.b.apiGuardNoteVertex429_(NOW);
    eq([off.g.cache.get('oe_bg429'), typeof off.g.cache.get('api_guard_v429')], [undefined, 'string']);
  });

  test('open engine: a background review refused the web search turns it off for background work only (Burson\'s reviews keep it); with row 51 OFF a refusal turns it off for every review, as before', () => {
    const w = bot();
    w.b.ev('OE_BG_ = true');
    w.b.groundingRefused_('enterprise', 'not allowed for this project');
    eq([w.g.cache.has('grounding_off_bg:enterprise'), w.g.cache.has('grounding_off:enterprise'), w.b.webGroundingMode_()], [true, false, '']);
    w.b.ev('OE_BG_ = false');
    eq(w.b.webGroundingMode_(), 'enterprise');  // Burson's reviews
    const off = bot({ off: true });
    off.b.ev('OE_BG_ = true');
    off.b.groundingRefused_('enterprise', 'not allowed for this project');
    off.b.ev('OE_BG_ = false');
    eq([off.g.cache.has('grounding_off:enterprise'), off.b.webGroundingMode_()], [true, '']);
    // a refusal met by Burson's own review (not background) under row 51: off for everyone, as before
    const sla = bot();
    sla.b.groundingRefused_('enterprise', 'not allowed');
    eq([sla.g.cache.has('grounding_off:enterprise'), sla.b.webGroundingMode_()], [true, '']);
  });

  test('open engine: the Other alerts space\'s triage is a background review: counted under row 51, and past the day\'s stop it is left for a person with the reason, with no Gemini call; with row 51 OFF it is triaged as before', () => {
    const MID = 'spaces/AAQAmidterm1';
    const POST = 'https://x.com/CorrDove/status/1980000000000000001';
    const body = link => ['🚨 *X Alert: 2026 Midterm Elections / Civics - Negative* 🚨', '', '*Author:* @CorrDove', '*Followers:* 1.7K',
      '*Engagement:* Very Low (0-199)', '*Sentiment:* Negative', '*Text:* _"You blame Google but you\'re being busted in it."_', '', link, ''].join('\n');
    const run = (on, day) => {
      const t = e2e();
      t.chat.addSpace(MID, 'Midterms 2026');
      t.bot.setup();
      t.set('B30', 'tester@testing.test');
      t.set('B25', 'https://chat.google.com/room/AAQAaa_0I9g');
      t.control().getRange(29, 2).setValue('ON');
      t.control().getRange(33, 2).setValue('https://chat.google.com/app/chat/AAQAmidterm1');
      t.poll();
      if (on) t.bot.ev('openOn_ = () => true');
      if (day) t.g.props.set('OPEN_DAY', JSON.stringify(day(t.bot.openEtDay_(t.g.clock.now + MIN), t.g.clock.now)));
      const alert = t.chat.say(MID, body('Click to view post'), { formattedText: body(`<${POST}|Click to view post>`), sender: 'users/bot', displayName: 'Lucas Hammonds' });
      t.poll();
      const triages = t.g.vertex.calls.filter(c => ((c.payload.generationConfig.responseSchema || {}).properties || {}).stream_call).length;
      const notes = t.chat.botPosts(MID).filter(p => p.thread.name === alert.thread.name && p.name !== alert.name).map(p => p.text);
      return { triages, notes, day: JSON.parse(t.g.props.get('OPEN_DAY') || 'null') };
    };
    const off = run(false);
    eq([off.triages, off.notes.length, off.day], [1, 1, null]);
    const counted = run(true);
    eq([counted.triages, counted.notes.length, counted.day.rev], [1, 1, 1]);
    const stopped = run(true, (d, at) => ({ d, rev: 2000, ql: 0, wc: 0, gb: 0, w: {}, stop: { k: 'rev', at } }));
    eq([stopped.triages, stopped.notes.length, stopped.day.rev], [0, 1, 2000]);
    assert.ok(/today's safety stop was reached: no Gemini triage until midnight ET/.test(stopped.notes[0]), stopped.notes[0]);
  });

  test('open engine: past the day\'s stop the Watch\'s flag gets no pre-read and no card (it waits, C35 says why); the next Eastern day it is posted; with row 51 OFF it is posted as before', () => {
    const watchRun = day => {
      const w = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
      if (day !== undefined) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
      w.rec.collect('setup');
      w.rec.step('01 first run', 1);
      golden.world.watchOn(w.t);
      w.sh.getRange(35, 2).setValue('Auto-correct space (B10)');
      w.rec.step('02 quiet run', 1);
      w.rec.step('06 the watch flags the post', 1, () => {
        w.feed.look = [golden.rows.hit()];
        const at = w.t.g.clock.now + MIN;
        if (day) w.t.g.props.set('OPEN_DAY', JSON.stringify(day(w.t.bot.openEtDay_(at), at)));
      });
      w.rec.step('07 the flag is triaged', 1, () => { w.feed.look = []; });
      const cards = w.rec.out().chat.filter(m => !m.reply && m.text.includes(golden.posts.GEMINI)).length;
      return { cards, c35: String(w.sh.cell(35, 3)) };
    };
    const asBefore = watchRun(undefined);
    eq(asBefore.cards, 1);
    const stopped = watchRun((d, at) => ({ d, rev: 2000, ql: 0, wc: 0, gb: 0, w: {}, stop: { k: 'rev', at } }));
    eq(stopped.cards, 0);
    assert.ok(/today's safety stop was reached \(2,000 background reviews\)/.test(stopped.c35), stopped.c35);
    eq(watchRun((d, at) => ({ d: '2026-01-01', rev: 2000, ql: 0, wc: 0, gb: 0, w: {}, stop: { k: 'rev', at } })).cards, 1);
    eq(watchRun(null).cards, 1);  // row 51 ON, nothing near a wall
  });

  test('open engine: a quick look (Gemini Decisions) sent under row 51 is one toward the day\'s quick-look ceiling; with row 51 OFF nothing is counted', () => {
    const fs = require('fs');
    const path = require('path');
    const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decisions_fixtures.json'), 'utf8'));
    const ask = off => {
      const w = bot({ off });
      const orig = w.g.services.UrlFetchApp.fetch;
      const answer = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body), getHeaders: () => ({}) });
      w.b.UrlFetchApp.fetch = (url, params) => (String(url).includes('secretmanager.googleapis.com/')
        ? answer(200, { payload: { data: Buffer.from('test-only-decisions-key-value-99', 'utf8').toString('base64') } })
        : String(url).includes('/decisions') ? answer(200, FX.probe.doc_multi.response.body) : orig(url, params));
      const res = w.b.decisionsAsk_('Customer audio cuts out on the left earcup.', FX.probe.doc_multi.request.questions, w.b.decSession_(() => 90 * SEC, false));
      w.b.openDaySave_();
      return [res.ok, w.day() && w.day().ql];
    };
    eq(ask(false), [true, 1]);
    eq(ask(true), [true, null]);
  });

  test('open engine: the Direct BigQuery poll under row 51 starts no check (no card) past the day\'s stop and says why on C15; with row 51 OFF the same world checks as before', () => {
    const w = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
    w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
    w.t.g.props.set('OPEN_DAY', JSON.stringify({ d: new Date(NOW - 4 * HOUR).toISOString().slice(0, 10), rev: 2000, ql: 0, wc: 0, gb: 0, w: {}, stop: { k: 'rev', at: NOW } }));
    w.rec.collect('setup');
    w.rec.step('the first run', 1, () => { w.feed.bsip = [golden.rows.mapsRow()]; });
    w.rec.step('a check', 5);
    const sh = w.t.sheet().getSheetByName('Control');
    const cards = w.rec.out().chat.filter(m => !m.reply && /\*\[BigQuery · BSIP\]\*/.test(m.text)).length;
    eq(cards, 0);
    assert.ok(/not checked: today's safety stop was reached \(2,000 background reviews\)/.test(String(sh.cell(15, 3))), sh.cell(15, 3));
    const v = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
    v.rec.collect('setup');
    v.rec.step('the first run', 1, () => { v.feed.bsip = [golden.rows.mapsRow()]; });
    v.rec.step('a check', 5);
    eq(v.rec.out().chat.filter(m => !m.reply && /\*\[BigQuery · BSIP\]\*/.test(m.text)).length, 1);
  });
};
