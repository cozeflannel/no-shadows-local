// The live dashboard's page (DashboardJs.html in Dashboard.html), run in a small fake browser page (test/fake_dom.js)
// with its google.script.run calls answered by the REAL dash* functions of a bot loaded with the test fakes, as the
// viewer: the golden one-space world (golden_flows.js oneSpaceRun), the bot's sheet shared with an editor and a reader,
// rows 54 and 55 ON on the Control tab as a person would set them, and a fake Google Slides deck (test/fake_slides.js).
// What a person sees and can press: who may set up deliveries, the Now strip when what it shows is old or a refresh
// failed, the next step of an answer that finds nothing, the account the web app runs as, a paused bot, the slides
// whose look can't be copied, and "Match" for a schedule whose runs are not evenly spaced. Every address ends in .test.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const makeSlides = require('./fake_slides');
  const { loadPage } = require('./fake_dom');
  const MIN = 60 * 1000;
  const DECK = 'deckWeeklyBrandReview0001';
  const EDITOR = 'editor@team.test';
  const READER = 'reader@team.test';
  const LINK = `https://docs.google.com/presentation/d/${DECK}/edit`;

  /** The golden one-space world with rows 54 and 55 ON, the sheet shared with EDITOR (edit) and READER (view), and a deck. */
  function world(o) {
    const golden = require('./golden_flows')(H);
    const { t } = golden.oneSpaceRun();
    const slides = makeSlides();
    slides.addDeck(Object.assign({ id: DECK, name: 'Weekly brand review', access: 'edit', editors: [EDITOR], slides: [
      { layout: 'TITLE', title: 'Weekly brand review', body: 'Brand Social' },
      { layout: 'TITLE_AND_BODY', title: 'Agenda', body: 'Pulse' },
      { layout: 'BLANK' },
      { layout: 'TITLE_AND_BODY', title: 'Wins this week', body: 'The launch went well' },
    ] }, (o && o.deck) || {}));
    slides.install(t.g, t.bot);
    t.g.drive.files.set(t.g.props.get('STORE_SHEET_ID'), { editors: [EDITOR], viewers: [READER] });
    t.control().getRange(54, 2).setValue('ON');
    t.control().getRange(55, 2).setValue('ON');
    return { t, slides };
  }

  /** The page as `who` sees it: each google.script.run call runs the bot's own function as them (o.run overrides). */
  function open(w, who, o) {
    const opts = o || {};
    const real = (fn, args) => {
      w.t.g.session.active = who;
      try { return w.t.bot[fn].apply(null, args); } finally { w.t.g.session.active = ''; }
    };
    const page = loadPage({ viewer: who, hold: opts.hold, run: (fn, args) => (opts.run ? opts.run(fn, args, real) : real(fn, args)) });
    page.flush();
    return page;
  }

  const slidesArea = page => { page.click(page.one('#area-tab-slides')); };
  const saved = (w, s) => {
    w.t.g.session.active = EDITOR;
    try {
      const ids = w.slides.slideIds(DECK);
      const r = w.t.bot.dashSaveDelivery(Object.assign({ name: 'Weekly review pulse', deck: { url: LINK },
        spot: { afterId: ids[1], beforeId: ids[2], afterLabel: 'Agenda', beforeLabel: '' }, design: { mode: 'default', slideId: '' }, lookbackHours: 24,
        schedule: { days: [1, 2, 3, 4, 5], time: '09:00', tz: 'America/New_York', mondayCoversWeekend: false },
        countOwn: false, linkSensitive: false, slides: { pulse: true, positive: false }, mode: 'replace', notify: [] }, s || {}));
      assert.ok(r.ok, r.why);
      return r.delivery;
    } finally {
      w.t.g.session.active = '';
    }
  };

  test('dashboard page: the fake page draws the Live area from the bot\'s real snapshot (the harness itself works)', () => {
    const w = world();
    const page = open(w, EDITOR);
    eq(page.calls.map(c => c.fn), ['dashSnapshot']);
    assert.ok(page.one('#now'), page.text(page.one('#live-root')));
    assert.ok(page.text(page.one('#now-headline')).length > 10);
  });

  test('dashboard page: a reader of the bot\'s sheet sees the deliveries but no New, Edit, Run now, Pause or Preview (and so can\'t open the editor or check a deck); an editor of the sheet has them all (SEC-1, SEC-2)', () => {
    const w = world();
    saved(w);
    const reader = open(w, READER);
    slidesArea(reader);
    assert.ok(reader.byText('h3', /Weekly review pulse/).length === 1, reader.text(reader.one('#slides-root')));
    eq([reader.one('[data-fk="deliv:new"]'), reader.all('[data-fk^="run:"]').length, reader.all('[data-fk^="edit:"]').length,
      reader.all('[data-fk^="pause:"]').length, reader.one('[data-fk="ed:preview"]')], [null, 0, 0, 0, null]);
    assert.ok(reader.byText('.banner-text', /setting one up, running it now or pausing it is for the people who can edit the bot's sheet/).length);
    eq(reader.calls.filter(c => c.fn === 'dashDeckCheck' || c.fn === 'dashPreview').length, 0);
    const editor = open(w, EDITOR);
    slidesArea(editor);
    eq([!!editor.one('[data-fk="deliv:new"]'), editor.all('[data-fk^="run:"]').length, editor.all('[data-fk^="edit:"]').length], [true, 1, 1]);
    editor.click(editor.one('[data-fk="deliv:new"]'));
    assert.ok(editor.one('[data-fk="ed:preview"]'));
  });

  test('dashboard page: the Now strip is never calm on old data: a refresh that fails, a call that never answers, or a snapshot that is old all show "can\'t be sure", how old it is and Refresh first, never the cached headline (H6)', () => {
    const w = world();
    const strip = page => ({ level: page.text(page.one('.now-level')), headline: page.text(page.one('#now-headline')), start: page.text(page.one('.now-start-label')),
      button: page.text(page.one('.now-start button')) });
    // the refresh fails (the bot answers with an error)
    let fail = false;
    const p1 = open(w, EDITOR, { run: (fn, args, real) => { if (fail && fn === 'dashSnapshot') throw new Error('Service unavailable'); return real(fn, args); } });
    const calm = strip(p1).headline;
    fail = true;
    p1.tick(61 * 1000);
    const s1 = strip(p1);
    eq([s1.level, s1.start, s1.button], ['Seriousness: Can\'t be sure', 'Do this first', 'Refresh']);
    assert.match(s1.headline, /^Can't be sure: what this page shows is from (?:\d+ s|1 min) ago, and the last refresh did not work \(the bot could not be reached \(Service unavailable\)\)\.$/);
    assert.ok(s1.headline !== calm && !/Nothing needs a person\. Start here/.test(p1.text(p1.one('#now'))));
    // and it says how old as the minutes go by, with Refresh first; a refresh that works puts the bot's own words back
    p1.tick(5 * MIN);
    assert.match(strip(p1).headline, /^Can't be sure: what this page shows is from [5-7] min ago/);
    fail = false;
    p1.click(p1.one('.now-start button'));
    eq(strip(p1).headline, calm);
    // a call that never answers: given up on after 90 seconds, then the same
    let hold = false;
    const p2 = open(w, EDITOR, { hold: fn => hold && fn === 'dashSnapshot' });
    hold = true;
    p2.tick(61 * 1000);
    assert.ok(!/^Can't be sure: what this page shows/.test(strip(p2).headline), 'still waiting: not yet given up');
    p2.tick(91 * 1000);
    assert.match(strip(p2).headline, /^Can't be sure: what this page shows is from .*, and the last refresh did not work \(the bot could not be reached \(the bot did not answer within 90 seconds\)\)\.$/);
    // an answer whose snapshot was built long before it was sent (asOf): stale at once
    const p3 = open(w, EDITOR, { run: (fn, args, real) => { const r = real(fn, args); if (fn === 'dashSnapshot' && r.ok) r.asOf = r.servedAt - 6 * MIN; return r; } });
    assert.match(strip(p3).headline, /^Can't be sure: what this page shows is from 6 min ago, and no newer answer has come from the bot\.$/);
  });

  test('dashboard page: an answer that finds nothing shows its own next step, not "try again": an alert that is not among the rows read, a post nothing mentions (H11)', () => {
    const w = world();
    const page = open(w, EDITOR, { run: (fn, args, real) => real(fn, fn === 'dashDetail' ? ['alert', 'QA-9999'] : args) });
    const card = page.all('.first-grid button, .then-list button').find(b => /Open the alert/.test(page.text(b)));
    assert.ok(card, page.text(page.one('#live-root')));
    page.click(card);
    const drawer = page.text(page.one('#drawer'));
    assert.match(drawer, /What to do: Find QA-9999 on the Alert log tab of the bot's sheet \(search the alert_id column\)\./);
    assert.ok(!/Press Try again in a minute/.test(drawer), drawer);
    // why didn't a post get an alert: nothing kept about it, and what to do then
    page.click(page.one('[data-fk="q:why-not"]'));
    page.click(page.byText('#answer button', /Look up a post/)[0]);
    page.type(page.one('#whynot-url'), 'https://x.com/nobody/status/7');
    page.submit(page.one('#dialog form'));
    assert.match(page.text(page.one('#dialog')), /What to do: If this post should have had an alert, post its link in the analyst space or send it to the IM on shift\./);
  });

  test('dashboard page: a web app deployed from another account than the bot\'s (Control B8) says so at the top, on Live and on Slide deliveries (F1); with the bot paused (B2 OFF) Run now and Preview are off and say why (F2)', () => {
    const w = world();
    saved(w);
    w.t.control().getRange(8, 2).setValue('someone.else@runner.test');
    const page = open(w, EDITOR);
    // the bot's own words, once (never the same sentence twice in a row: R8)
    const banner = page.text(page.one('#banners'));
    assert.match(banner, /^This web app runs as a different Google account than the bot \(Control B8, "Runs as"\): it was deployed from another account\./);
    eq(banner.split('This web app runs as a different Google account').length - 1, 1);
    slidesArea(page);
    assert.ok(page.byText('#slides-root .banner-text', /deployed from another account/).length === 1);
    w.t.control().getRange(8, 2).setValue('bot@runner.test');
    w.t.control().getRange(2, 2).setValue('OFF');
    const paused = open(w, EDITOR);
    slidesArea(paused);
    const run = paused.one('[data-fk^="run:"]');
    eq(run.disabled, true);
    assert.match(paused.text(paused.one('.deliv-actions')), /Run now is off: The bot is paused \(Control B2, Bot, is OFF\)/);
  });

  test('dashboard page: the design picker marks the slides whose look can\'t be copied (a layout with no title box) and does not let them be picked (SD-7); "Match" for a schedule whose runs are not evenly spaced makes each slide cover the time since the run before (SD-10)', () => {
    const w = world();
    const page = open(w, EDITOR);
    slidesArea(page);
    page.click(page.one('[data-fk="deliv:new"]'));
    page.type(page.one('[data-fk="ed:deck"]'), LINK);
    page.submit(page.one('[data-fk="ed:deck"]').closest('form'));
    page.type(page.one('[data-fk="design:copy"]'), true);
    const options = page.one('[data-fk="design:slide"]').querySelectorAll('option');
    eq(options.map(op => [page.text(op), op.disabled]), [['Pick a slide', false], ['1. Weekly brand review', false], ['2. Agenda', false],
      ['3. Untitled slide (its layout has no title box, so its look can\'t be copied)', true], ['4. Wins this week', false]]);
    // Tuesday and Friday at 9:00: Match offers "since the run before"
    page.click(page.one('[data-fk="day:1"]'));
    page.click(page.one('[data-fk="day:3"]'));
    page.click(page.one('[data-fk="day:4"]'));
    page.tick(1000);
    const match = page.one('[data-fk="ed:match"]');
    assert.ok(match, page.text(page.one('#coverage')));
    eq(page.text(match), 'Match: cover the time since the run before on each slide');
    page.click(match);
    page.tick(1000);
    const last = page.calls.filter(c => c.fn === 'dashScheduleCheck').pop();
    eq([last.args[0].schedule.days, last.args[0].schedule.sincePrevious], [[2, 5], true]);
    assert.match(page.text(page.one('#coverage')), /Every hour is on exactly one slide/);
    eq([page.one('[data-fk="ed:match"]'), page.one('[data-fk="ed:since"]').checked], [null, true]);
  });

  // ----- second review (R4, L9, L10, L11, X9) -----------------------------------------------------------------------

  test('dashboard page: sharing that can\'t be checked just now (Drive did not answer) is never drawn as access taken away: the page keeps what it shows and says it can\'t be sure (R4)', () => {
    const w = world();
    const page = open(w, EDITOR);
    assert.ok(page.one('#now'));
    // the 10-minute sharing answer runs out and Drive fails on the next check
    Array.from(w.t.g.cache.keys()).filter(k => k.startsWith('dash1:acl:')).forEach(k => w.t.g.cache.delete(k));
    w.t.g.drive.files.get(w.t.g.props.get('STORE_SHEET_ID')).fail = 'Service unavailable';
    w.t.g.session.active = EDITOR;
    const r = w.t.bot.dashSnapshot({ refresh: true });
    w.t.g.session.active = '';
    eq([r.ok, r.denied], [false, undefined]);
    assert.match(r.why, /^The dashboard could not check who the bot's sheet is shared with just now/);
    page.tick(61 * 1000);
    assert.ok(page.one('#now'), page.text(page.one('#live-root')));
    assert.match(page.text(page.one('#now-headline')), /^Can't be sure: what this page shows is from .*, and the last refresh did not work \(The dashboard could not check/);
    assert.ok(!/You can't see this yet/.test(page.text(page.one('#live-root'))));
    // a definite "not shared" is still a refusal
    w.t.g.drive.files.get(w.t.g.props.get('STORE_SHEET_ID')).fail = '';
    w.t.g.drive.files.set(w.t.g.props.get('STORE_SHEET_ID'), { editors: [], viewers: [] });
    Array.from(w.t.g.cache.keys()).filter(k => k.startsWith('dash1:acl:')).forEach(k => w.t.g.cache.delete(k));
    w.t.g.session.active = EDITOR;
    eq(w.t.bot.dashSnapshot({ refresh: true }).denied, true);
    w.t.g.session.active = '';
  });

  test('dashboard page: on an old page the common answers are never shown as current: each says "can\'t be sure", how old, then what it said (L9)', () => {
    const w = world();
    let fail = false;
    const page = open(w, EDITOR, { run: (fn, args, real) => { if (fail && fn === 'dashSnapshot') throw new Error('Service unavailable'); return real(fn, args); } });
    page.click(page.one('[data-fk="q:needs-me"]'));
    const fresh = page.text(page.one('#answer .answer-a'));
    assert.ok(!/^Can't be sure/.test(fresh), fresh);
    fail = true;
    page.tick(61 * 1000);
    page.tick(60 * MIN);
    const old = page.text(page.one('#answer .answer-a'));
    assert.match(old, /^Can't be sure: this answer is from (?:1 h|6\d min) ago, and the last refresh did not work \(the bot could not be reached \(Service unavailable\)\)\. It said then: /);
    assert.ok(old.endsWith(fresh), old);
    page.click(page.one('[data-fk="q:keeping-up"]'));
    assert.match(page.text(page.one('#answer .answer-a')), /^Can't be sure: this answer is from /);
  });

  test('dashboard page: after the device slept, the page counts the time asleep: the data is "can\'t be sure" and the page asks the bot again at once (L10)', () => {
    const w = world();
    let hold = false;
    const page = open(w, EDITOR, { hold: fn => hold && fn === 'dashSnapshot' });
    const before = page.calls.filter(c => c.fn === 'dashSnapshot').length;
    // an hour asleep: the page clock (performance.now) stood still, the device's clock did not; the bot does not answer yet
    hold = true;
    page.sleep(60 * MIN);
    page.tick(5 * 1000);
    eq(page.calls.filter(c => c.fn === 'dashSnapshot').length, before + 1);
    assert.match(page.text(page.one('#now-headline')), /^Can't be sure: what this page shows is from (?:1 h|60 min) ago, and no newer answer has come from the bot\.$/);
    assert.match(page.text(page.one('#fresh')), /^Updated (?:1 h|60 min) ago/);
  });

  test('dashboard page: with Early Detection (row 19) OFF the Pressure view says stories are not followed, never that none is rising (L11)', () => {
    const w = world();
    w.t.control().getRange(19, 2).setValue('OFF');
    const page = open(w, EDITOR);
    page.click(page.all('[role="tab"]').find(t => /Pressure/.test(page.text(t))));
    const txt = page.text(page.one('#live-root'));
    assert.match(txt, /Stories growing fastest\s*Stories are not followed \(Early Detection, row 19, is OFF\), so none is shown here\./);
    assert.ok(!/No story is rising or surging right now/.test(txt));
    // ON: as before (a snapshot built anew, not the one kept 45 seconds)
    w.t.control().getRange(19, 2).setValue('ON');
    Array.from(w.t.g.cache.keys()).filter(k => k.startsWith('dash1:snap')).forEach(k => w.t.g.cache.delete(k));
    const on = open(w, EDITOR);
    on.click(on.all('[role="tab"]').find(t => /Pressure/.test(on.text(t))));
    const onTxt = on.text(on.one('#live-root'));
    assert.ok(!/Stories are not followed/.test(onTxt), (onTxt.match(/.{200}Stories are not followed.{100}/) || [''])[0]);
  });

  test('dashboard page: New delivery and the editor are drawn only when the bot\'s answer says this viewer may set deliveries up: never while the list loads or after it failed (X9)', () => {
    const w = world();
    let hold = true;
    const loading = open(w, READER, { hold: fn => hold && fn === 'dashDeliveries' });
    slidesArea(loading);
    eq(loading.one('[data-fk="deliv:new"]'), null);
    hold = false;
    const failing = open(w, READER, { run: (fn, args, real) => (fn === 'dashDeliveries' ? { ok: false, why: 'The bot\'s sheet could not be read just now.' } : real(fn, args)) });
    slidesArea(failing);
    eq(failing.one('[data-fk="deliv:new"]'), null);
    // the same failure for an editor: no New either (the answer did not say)
    const edFail = open(w, EDITOR, { run: (fn, args, real) => (fn === 'dashDeliveries' ? { ok: false, why: 'The bot\'s sheet could not be read just now.' } : real(fn, args)) });
    slidesArea(edFail);
    eq(edFail.one('[data-fk="deliv:new"]'), null);
    const ed = open(w, EDITOR);
    slidesArea(ed);
    assert.ok(ed.one('[data-fk="deliv:new"]'));
  });

  test('dashboard page: a schedule covering the time since the run before that already leaves no gap and no overlap is not offered "Match" back to a lookback (S9); a copied design on a layout with no title box can be picked when each run adds a slide (S11)', () => {
    const w = world();
    const page = open(w, EDITOR);
    slidesArea(page);
    page.click(page.one('[data-fk="deliv:new"]'));
    page.type(page.one('[data-fk="ed:deck"]'), LINK);
    page.submit(page.one('[data-fk="ed:deck"]').closest('form'));
    // every day at 9:00 (no clock change in the next 14 days), each slide covering the time since the run before
    [0, 6].forEach(d => page.click(page.one(`[data-fk="day:${d}"]`)));
    page.tick(1000);
    page.type(page.one('[data-fk="ed:since"]'), true);
    page.tick(1000);
    const last = page.calls.filter(c => c.fn === 'dashScheduleCheck').pop();
    eq([last.args[0].schedule.days, last.args[0].schedule.sincePrevious], [[0, 1, 2, 3, 4, 5, 6], true]);
    assert.match(page.text(page.one('#coverage')), /Every hour is on exactly one slide/);
    eq(page.one('[data-fk="ed:match"]'), null);
    // S11: add mode lets the title-less slide's look be copied; replace mode does not
    page.type(page.one('[data-fk="design:copy"]'), true);
    const third = () => page.one('[data-fk="design:slide"]').querySelectorAll('option')[3];
    eq(third().disabled, true);
    page.type(page.one('[data-fk="mode:add"]'), true);
    eq([third().disabled, page.text(third())], [false, '3. Untitled slide']);
  });

  test('dashboard page: a delivery whose scheduled run waits for Gemini shows "Waiting", since when and until when, not a next run already past (S6)', () => {
    const w = world();
    const d = saved(w, { schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '08:00', tz: 'America/New_York', mondayCoversWeekend: false } });
    const v = w.t.g.vertex;
    const orig = v.handle;
    v.handle = (url, params) => {
      const props = ((JSON.parse(params.payload).generationConfig || {}).responseSchema || {}).properties || {};
      if (props.segments) return { code: 503, body: { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } } };
      return orig(url, params);
    };
    const row = w.t.bot.slideRows_(w.t.sheet().getSheetByName('Slide deliveries')).find(r => r.id === d.id);
    w.t.g.clock.now = row.next_run + 3 * MIN;
    w.t.g.session.active = '';
    eq(w.t.bot.dashDeliverDue().ran.map(x => x.ok), [false]);
    const page = open(w, EDITOR);
    slidesArea(page);
    const card = page.text(page.one('.deliv'));
    assert.match(card, /Next run\s*Waiting\s*\w{3} \d+, 8:00 AM.*Waiting for Gemini since .*: it tries again every few minutes until \w{3} \d+, 10:00 AM ET\./);
  });
};
