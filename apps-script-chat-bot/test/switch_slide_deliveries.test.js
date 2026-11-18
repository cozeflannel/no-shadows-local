// Slide deliveries (SlideDeliveries.gs; Control row 55; SPEC section 4): the brand safety pulse slide, put into a Google
// Slides deck on each delivery's own schedule by the bot's account, from the Alert log the bot keeps.
//
// The data comes from the bot's own flows: the one-space setup of the golden flows (golden_flows.js oneSpaceRun) writes
// its Alert log (Burson's alert with mistakes, its Social Alert sent; Direct BigQuery cards; a Watch alert the bot sends
// to T&S; Early Detection story cards). Where a test needs more rows (another window, a tie), it writes them through the
// bot's own store (Sheets.gs sheetTable_), copied from those rows. Decks are a faithful fake of SlidesApp
// (test/fake_slides.js); Gemini's summaries are scripted. Row 55 is turned ON on the Control tab, as a person would.
// Every post and account is made up; every address ends in .test.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const makeSlides = require('./fake_slides');
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const DECK = 'deckWeeklyBrandReview0001';
  const DECK2 = 'deckLeadershipUpdate00002';
  const VIEWER = 'editor@team.test';
  const READER = 'reader@team.test';
  const STRANGER = 'stranger@elsewhere.test';
  const TESTER = 'tester@testing.test';  // B30 in the golden flows' setup
  const NOTIFY = ['reader.one@team.test', 'reader.two@team.test'];
  const SCOPE = 'https://www.googleapis.com/auth/presentations';
  const AIO_POST = 'https://x.com/edervolcelazz/status/2109566527900926417';
  const EMOJI = /\p{Extended_Pictographic}/u;

  /** The deck most tests deliver into: a title slide, the agenda, a wins slide and a closing slide. */
  const deckSpec = o => Object.assign({ id: DECK, name: 'Weekly brand review', access: 'edit', editors: [VIEWER], slides: [
    { layout: 'TITLE', title: 'Weekly brand review', body: 'Brand Social' },
    { layout: 'TITLE_AND_BODY', title: 'Agenda', body: 'Pulse\nWins\nRisks' },
    { layout: 'TITLE_AND_BODY', title: 'Wins this week', body: 'The launch went well' },
    { layout: 'SECTION_HEADER', title: 'Thank you' },
  ] }, o || {});

  /** Gemini's good summary: plain words, the first post cited. */
  const goodAnswer = facts => ({ segments: facts.posts.length
    ? [{ text: 'People say ', ref: '' }, { text: 'it happened to them', ref: facts.posts[0].ref }, { text: ' after an update.', ref: '' }]
    : [{ text: 'Posts describe the issue in their own words.', ref: '' }] });

  /**
   * Gemini's summaries, scripted: answer(facts, n) for the n-th summary call (facts: what the bot gave it); every other
   * Gemini call as the golden flows script it. Returns the summary calls: [{facts, prompt, system}].
   */
  function scriptSummary(t, answer) {
    const calls = [];
    const v = t.g.vertex;
    const orig = v.handle.bind(v);
    v.handle = (url, params) => {
      const payload = JSON.parse(params.payload);
      const props = ((payload.generationConfig || {}).responseSchema || {}).properties || {};
      if (!props.segments) return orig(url, params);
      const text = payload.contents[0].parts.map(p => p.text || '').join('\n');
      const facts = JSON.parse(text.match(/<issue>\n([\s\S]*?)\n<\/issue>/)[1]);
      calls.push({ facts, prompt: text, system: payload.systemInstruction.parts[0].text });
      const result = (calls.answer || goodAnswer)(facts, calls.length);
      return { code: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(result) }] }, finishReason: 'STOP' }] } };
    };
    calls.answer = answer || null;
    return calls;
  }

  /**
   * The golden one-space run, its Alert log written by the bot, with the decks (`o.decks`, else the weekly review deck),
   * the bot's sheet shared with VIEWER as an editor, row 55 ON (unless o.on is false) and Gemini's summaries scripted.
   */
  function world(o) {
    o = o || {};
    const golden = require('./golden_flows')(H);
    const { t } = golden.oneSpaceRun();
    const slides = makeSlides();
    (o.decks || [deckSpec()]).forEach(d => slides.addDeck(d));
    slides.install(t.g, t.bot);
    t.g.drive.files.set(t.g.props.get('STORE_SHEET_ID'), { editors: [VIEWER], viewers: [READER] });
    if (o.on !== false) t.control().getRange(55, 2).setValue('ON');
    const summaries = scriptSummary(t, o.answer);
    const w = {
      t, slides, summaries, b: t.bot,
      as: who => { t.g.session.active = who || ''; },
      tab: () => t.sheet().getSheetByName('Slide deliveries'),
      row: id => t.bot.slideRows_(w.tab()).find(r => r.id === id),
      pulses: deck => slides.slideIds(deck || DECK).filter(id => /^Brand safety pulse/.test(slides.textOf(id))),
      // nothing kept from an earlier build: no generated set, and no count of this viewer's fresh previews
      fresh: () => { Array.from(t.g.cache.keys()).filter(k => k.startsWith('dash1:gen:') || k.startsWith('dash1:pv:')).forEach(k => t.g.cache.delete(k)); },
    };
    return w;
  }

  /** A delivery's settings into the weekly review deck, after "Agenda" and before "Wins this week". */
  function settings(w, o) {
    const ids = w.slides.slideIds(DECK);
    return Object.assign({
      name: 'Weekly review pulse', deck: { url: `https://docs.google.com/presentation/d/${DECK}/edit`, title: 'Weekly brand review' },
      spot: { afterId: ids[1], beforeId: ids[2], afterLabel: 'Agenda', beforeLabel: 'Wins this week' },
      design: { mode: 'default', slideId: '' }, lookbackHours: 24,
      schedule: { days: [1, 2, 3, 4, 5], time: '09:00', tz: 'America/New_York', mondayCoversWeekend: false },
      countOwn: false, linkSensitive: false, slides: { pulse: true, positive: false }, mode: 'replace', notify: NOTIFY.slice(),
    }, o || {});
  }

  /** Saves a delivery as VIEWER (an editor of the bot's sheet and of the deck): its row as the web app lists it. */
  function save(w, s) {
    w.as(VIEWER);
    const r = w.b.dashSaveDelivery(s);
    assert.ok(r.ok, r.why);
    return r.delivery;
  }

  /** Runs a delivery now, as VIEWER. */
  function runNow(w, id) {
    w.as(VIEWER);
    return w.b.dashRunNow(id);
  }

  /** A preview as VIEWER, built afresh (no generated set kept from an earlier call). */
  function preview(w, s) {
    w.fresh();
    w.as(VIEWER);
    const r = w.b.dashPreview(s);
    assert.ok(r.ok, r.why);
    return r;
  }

  /**
   * Writes an Alert-log row through the bot's own store (Sheets.gs sheetTable_), a copy of row `fromId` with: id, at
   * (created_at), name (issue name), author, post (post_url and its record_key), eng (total_engagement), risk (Sensitive
   * Topics), ed (fields of the Early Detection snapshot), row (any other columns).
   */
  function addRow(w, fromId, o) {
    const table = w.b.sheetTable_(w.t.sheet(), w.b.ev('ALERT_TAB_'), w.b.ev('ALERT_COLUMNS_'), 'alert_id', 4000);
    const base = JSON.parse(JSON.stringify(table.load().find(r => r.alert_id === fromId)));
    delete base._row;
    const ff = base.forwarded_fields;
    if (o.name !== undefined) ff.issue_name = o.name;
    if (o.author) { ff.author = o.author; base.author = o.author; }
    if (o.post) { ff.post_url = o.post; base.record_key = w.b.recordKey_({ post_url: o.post }); }
    if (o.eng !== undefined) ff.total_engagement = o.eng;
    if (o.risk) ff.risk_tags = o.risk;
    if (o.ed) ff.early_detection = Object.assign({}, ff.early_detection, o.ed);
    // it reached the space when it was recorded (a copied row would otherwise keep the time the first one did)
    Object.assign(base, { alert_id: o.id, created_at: o.at, updated_at: o.at, source_at: o.at, resend_of: '' }, o.row || {});
    table.append(base);
  }

  const names = r => r.slides[0].issues.map(i => i.name);

  // ===========================================================================================================
  // The fake itself
  // ===========================================================================================================

  test('slide deliveries: the fake SlidesApp behaves as the service does: new objects from each getSlides, text ranges with the closing newline that count from their own start, new text styled like the text before it, page elements vs shapes, a view-only deck refuses every change, a missing deck throws', () => {
    const slides = makeSlides();
    slides.addDeck(deckSpec());
    slides.addDeck(deckSpec({ id: DECK2, access: 'view' }));
    const app = slides.SlidesApp;
    const p = app.openById(DECK);
    const [a, b] = [p.getSlides()[1], p.getSlides()[1]];
    assert.ok(a !== b);
    eq(a.getObjectId(), b.getObjectId());
    eq(p.getSlideById('no_such_slide'), null);
    const el = a.getPlaceholder(app.PlaceholderType.TITLE);
    eq([typeof el.getText, typeof el.asShape], ['undefined', 'function']);
    eq(typeof a.getShapes()[0].asShape, 'undefined');
    const title = el.asShape().getText();
    eq([title.asString(), title.getLength()], ['Agenda\n', 7]);
    title.setText('Plan');
    title.getRange(0, 4).getTextStyle().setBold(true);
    title.appendText(' ahead');
    eq(slides.styleAt(a.getObjectId(), 'TITLE', 5).bold, true);  // the appended words take the bold of the word before
    assert.throws(() => title.getRange(2, 20), /within the text range/);
    const sub = title.getRange(5, 10);
    eq([sub.asString(), sub.getRange(0, 5).asString()], ['ahead', 'ahead']);
    sub.getRange(0, 5).getTextStyle().setLinkUrl('https://example.test/a');
    eq(slides.linksOf(a.getObjectId()), [{ text: 'ahead', url: 'https://example.test/a', type: 'TITLE', start: 5, end: 10 }]);
    const s = p.insertSlide(4, app.PredefinedLayout.TITLE_AND_BODY);
    eq([p.getSlides().length, s.getLayout().getLayoutName()], [5, 'TITLE_AND_BODY']);
    assert.throws(() => p.insertSlide(9, app.PredefinedLayout.TITLE_AND_BODY), /out of range/);
    assert.throws(() => p.insertSlide(0, app.PredefinedLayout.BIG_NUMBER), /Could not find a layout/);
    s.remove();
    assert.throws(() => s.getObjectId(), /deleted/);
    const v = app.openById(DECK2);
    eq(v.getSlides().length, 4);
    assert.throws(() => v.insertSlide(0, app.PredefinedLayout.TITLE_AND_BODY), /permission/);
    assert.throws(() => v.getSlides()[1].getPlaceholder('TITLE').asShape().getText().setText('x'), /permission/);
    eq(slides.deck(DECK2).writes, 0);
    assert.throws(() => app.openById('deckThatIsNotThere0000001'), /Requested entity was not found/);
  });

  // ===========================================================================================================
  // What a run builds (SPEC 4.3)
  // ===========================================================================================================

  test('slide deliveries: the top three come from the Alert log rows the bot wrote: Burson\'s alerts always count, its own finds only with countOwn; ties go to more accounts, then more engagement, then the latest alert', () => {
    const w = world();
    const now = w.t.g.clock.now;
    // Burson's alert only (the bot's own Direct cards, Watch alert and story cards are left out)
    eq(names(preview(w, settings(w))), ['Criticism against AI Overviews']);
    // with the bot's own finds: one alert and one account each, so the most engagement first (29,425; 2,400; 800)
    const own = preview(w, settings(w, { countOwn: true }));
    eq(names(own), ['Criticism against AI Overviews', 'Maps routing onto a closed bridge', 'Pixel 10 battery swelling after update']);
    eq(own.slides[0].issues.map(i => i.foundByApp), [false, true, true]);
    // the same alerts, accounts and engagement: the latest alert first
    addRow(w, 'QA-1001', { id: 'QA-2001', at: now - 20 * MIN, name: 'Issue Alpha in Search', author: 'alpha_one', post: 'https://x.com/alpha_one/status/2160000000000000001' });
    addRow(w, 'QA-1001', { id: 'QA-2002', at: now - 10 * MIN, name: 'Issue Beta in Search', author: 'beta_one', post: 'https://x.com/beta_one/status/2160000000000000002' });
    eq(names(preview(w, settings(w))), ['Issue Beta in Search', 'Issue Alpha in Search', 'Criticism against AI Overviews']);
    // more alerts first
    addRow(w, 'QA-1001', { id: 'QA-2003', at: now - 30 * MIN, name: 'Issue Alpha in Search', author: 'alpha_two', post: 'https://x.com/alpha_two/status/2160000000000000003' });
    eq(names(preview(w, settings(w))), ['Issue Alpha in Search', 'Issue Beta in Search', 'Criticism against AI Overviews']);
    // more accounts before more engagement: a story card whose posts (kept while row 54 is ON) come from four accounts
    addRow(w, 'QA-1004', { id: 'QA-2004', at: now - 5 * MIN, name: 'Issue Gamma in Chrome', post: 'https://x.com/gamma_a/status/2160000000000000004',
      ed: { posts: ['gamma_a', 'gamma_b', 'gamma_c', 'gamma_d'].map((a, i) => ({ u: `https://x.com/${a}/status/21600000000000001${i}`, a: `X:${a}`, p: 'X', t: now - HOUR })) } });
    eq(names(preview(w, settings(w, { countOwn: true }))), ['Issue Alpha in Search', 'Issue Gamma in Chrome', 'Issue Beta in Search']);
    // a resend of a row already counted, a superseded row and the same Burson alert recorded by a second flow count once
    addRow(w, 'QA-1001', { id: 'QA-2005', at: now - 4 * MIN, name: 'Issue Beta in Search', author: 'beta_one', post: 'https://x.com/beta_one/status/2160000000000000002',
      row: { space: 'spaces/AAQAmirrorgf1 > (isolated)' } });
    addRow(w, 'QA-1001', { id: 'QA-2006', at: now - 3 * MIN, name: 'Issue Beta in Search', author: 'beta_two', post: 'https://x.com/beta_two/status/2160000000000000006',
      row: { resend_of: 'QA-2002' } });
    addRow(w, 'QA-1001', { id: 'QA-2007', at: now - 2 * MIN, name: 'Issue Beta in Search', author: 'beta_three', post: 'https://x.com/beta_three/status/2160000000000000007',
      row: { status: 'superseded' } });
    const beta = preview(w, settings(w)).slides[0].issues.find(i => i.name === 'Issue Beta in Search');
    assert.match(beta.numbers, /^1 alert · 1 account ·/);
  });

  test('slide deliveries: each issue\'s numbers and the change from the window before, never estimated; an issue with no Burson alert is "Found by the app"', () => {
    const w = world();
    const now = w.t.g.clock.now;
    // the bot's record starts inside the window before: its change is not known
    const first = preview(w, settings(w, { countOwn: true }));
    eq(first.slides[0].issues[0].numbers, '1 alert · 1 account · 1 platform (X) · 29,425 engagements · change from the window before not known (it is not fully kept)');
    assert.match(first.window.label, /^Oct 13, 8:\d\d AM to Oct 14, 8:\d\d AM ET \(the bot's Alert log starts within this window\)$/);
    // an older row (the record reaches back three days), and two alerts on the same issue in the window before
    addRow(w, 'QA-1002', { id: 'QA-2101', at: now - 3 * DAY, name: 'Older issue', author: 'older_one', post: 'https://x.com/older_one/status/2160000000000000101' });
    addRow(w, 'QA-1001', { id: 'QA-2102', at: now - 30 * HOUR, author: 'earlier_a', post: 'https://x.com/earlier_a/status/2160000000000000102', eng: 100 });
    addRow(w, 'QA-1001', { id: 'QA-2103', at: now - 40 * HOUR, author: 'earlier_b', post: 'https://x.com/earlier_b/status/2160000000000000103', eng: 200 });
    const r = preview(w, settings(w, { countOwn: true }));
    const by = Object.fromEntries(r.slides[0].issues.map(i => [i.name, i]));
    eq(by['Criticism against AI Overviews'].numbers, '1 alert · 1 account · 1 platform (X) · 29,425 engagements · down from 2 in the window before');
    eq(by['Maps routing onto a closed bridge'].numbers, '1 alert · 1 account · 1 platform (X) · 2,400 engagements · new (none in the window before)');
    eq([by['Criticism against AI Overviews'].foundByApp, by['Maps routing onto a closed bridge'].foundByApp], [false, true]);
    assert.ok(!/Alert log starts/.test(r.window.label));
    // a story card: its platforms as the card keeps them; no engagement kept -> "not counted"
    const story = preview(w, settings(w, { countOwn: true, lookbackHours: 1 }));
    assert.ok(story.ok);
    const b = w.b;
    const facts = b.slideRowFacts_(b.slideAlertRows_(w.t.sheet(), 0).rows.find(x => x.alert_id === 'QA-1004'));
    // its four posts, each once (its main post is also among its post keys: the same post, by its key)
    eq([facts.platforms, facts.posts.length, facts.kind], [['x', 'reddit'], 4, 'own']);
    const noEng = { rows: [Object.assign({}, facts, { engagement: null })] };
    eq(b.slideNumbers_(noEng, 3).text, '1 alert · 1 account · 2 platforms (X, Reddit) · engagement not counted · down from 3 in the window before');
    // the status line from what the rows keep: Burson's alert was handled in the Auto-correct space, whose Social Alerts
    // go only to the testers (it is always Testing), so the slide never says the teams were emailed
    eq(by['Criticism against AI Overviews'].status, 'Done: 1 Social Alert sent to the testers only (Testing) · With: nobody yet · Readers: nothing to do');
    eq(b.slideStatusLine_({ rows: [
      Object.assign({}, facts, { sent: true, sentMode: 'live', groups: ['gcpa', 'gup'], tnsDone: true, draft: false, fixAsked: false, question: true }),
      Object.assign({}, facts, { sent: false, groups: [], tnsDone: false, draft: false, fixAsked: true, question: false }),
    ] }), 'Done: 1 Social Alert sent to gcpa and gup, 1 T&S form submitted, 1 fix asked of Burson · With: Burson · Readers: a reply is asked for on the alert email');
    eq(b.slideStatusLine_({ rows: [Object.assign({}, facts, { sent: false, groups: [], tnsDone: false, draft: true, fixAsked: false, question: false })] }),
      'Done: monitored, no alert sent · With: the IM on shift · Readers: nothing to do');
  });

  test('slide deliveries: the summary: a reply citing a post the data does not hold is refused and asked again with the reason, a reply with a web address is refused, and the links land on the cited words', () => {
    const w = world({ answer: (facts, n) => (n === 1 ? { segments: [{ text: 'Owners say ', ref: '' }, { text: 'this', ref: 'P9' }] }
      : n === 2 ? { segments: [{ text: `See ${AIO_POST} for more`, ref: 'P1' }] } : goodAnswer(facts)) });
    const d = save(w, settings(w));
    const r = runNow(w, d.id);
    assert.ok(r.ok, r.why);
    eq(w.summaries.length, 3);
    assert.match(w.summaries[1].prompt, /Your last answer could not be used: it cited P9, which is not among the posts given \(only P1 may be cited\)/);
    assert.match(w.summaries[2].prompt, /Your last answer could not be used: its text held a web address/);
    assert.ok(!/https?:|www\./.test(JSON.stringify(w.summaries[0].facts)));  // Gemini is given refs, never links
    eq(w.summaries[0].facts.posts, [{ ref: 'P1', platform: 'X', author: 'edervolcelazz', summary: w.summaries[0].facts.posts[0].summary }]);
    const [pulse] = w.pulses();
    const links = w.slides.linksOf(pulse);
    eq(links.map(l => [l.text, l.url, l.type]), [['it happened to them', AIO_POST, 'BODY']]);
    const body = w.slides.deck(DECK).slides.find(s => s.id === pulse).shapes.find(x => x.placeholderType === 'BODY').text;
    eq(body.slice(links[0].start, links[0].end), 'it happened to them');
    assert.ok(body.includes('People say it happened to them after an update.'));
    eq(r.link, `https://docs.google.com/presentation/d/${DECK}/edit#slide=id.${pulse}`);
  });

  test('slide deliveries: three unusable replies fail the run: nothing is delivered, the deck is untouched, nobody is emailed, and the run says why', () => {
    const w = world({ answer: () => ({ segments: [{ text: 'Owners say this', ref: 'P7' }] }) });
    const d = save(w, settings(w));
    const before = w.slides.snapshot(DECK);
    const sent = w.t.g.gmail.sentMessages().length;
    const r = runNow(w, d.id);
    eq(r.ok, false);
    eq(w.summaries.length, 3);
    assert.match(r.why, /^The summary of "Criticism against AI Overviews" could not be written, so nothing was delivered: Gemini's answer could not be used in 3 tries \(the last: it cited P7, which is not among the posts given/);
    eq(w.slides.snapshot(DECK), before);
    eq(w.slides.deck(DECK).writes, 0);
    eq(w.t.g.gmail.sentMessages().length, sent);
    const last = w.row(d.id).last_run;
    eq([last.ok, last.error], [false, r.why]);
    eq(r.delivery.lastRun.error, r.why);
    // more problems Gemini's answer is held to: too long, an emoji, a number not in the facts, an address, no ref at all
    const b = w.b;
    const facts = JSON.stringify({ numbers: { alerts: 2, engagement: 12400 } });
    eq(b.slideSummaryProblem_({ segments: [{ text: 'x'.repeat(241), ref: 'P1' }] }, ['P1'], facts), 'it was 241 characters long, more than 240');
    eq(b.slideSummaryProblem_({ segments: [{ text: 'Owners are upset \u{1F525}', ref: 'P1' }] }, ['P1'], facts), 'it held an emoji');
    eq(b.slideSummaryProblem_({ segments: [{ text: 'Seen by 90,000 people', ref: 'P1' }] }, ['P1'], facts), 'it wrote 90000, which is not among the facts');
    eq(b.slideSummaryProblem_({ segments: [{ text: '12,400 engagements on 2 alerts', ref: 'P1' }] }, ['P1'], facts), '');
    eq(b.slideSummaryProblem_({ segments: [{ text: 'Write to owner@team.test', ref: 'P1' }] }, ['P1'], facts), 'it held something kept inside Google (owner@team.test)');
    eq(b.slideSummaryProblem_({ segments: [{ text: 'Owners are upset.', ref: '' }] }, ['P1'], facts), 'it cited no post, though posts with refs were given');
    eq(b.slideSummaryProblem_({ segments: [{ text: 'Owners are upset.', ref: '' }] }, [], facts), '');
  });

  test('slide deliveries: with "link sensitive posts" OFF, posts tied to a T&S submission or a Sensitive Topic go to Gemini without a ref and are never linked; ON, they are cited and linked', () => {
    const w = world();
    const now = w.t.g.clock.now;
    // the Watch alert the bot sent to T&S, twice on its issue; a Burson alert with a Sensitive Topic, twice on its issue
    addRow(w, 'QA-1003', { id: 'QA-2201', at: now - 15 * MIN, author: '@courtwatch', post: 'https://x.com/courtwatch/status/2160000000000000201', eng: 300 });
    addRow(w, 'QA-1001', { id: 'QA-2202', at: now - 14 * MIN, name: 'Search shows graphic results', author: 'graphic_a', post: 'https://x.com/graphic_a/status/2160000000000000202', eng: 100, risk: ['Violence & Gore'] });
    addRow(w, 'QA-1001', { id: 'QA-2203', at: now - 13 * MIN, name: 'Search shows graphic results', author: 'graphic_b', post: 'https://x.com/graphic_b/status/2160000000000000203', eng: 100, risk: ['Violence & Gore'] });
    const s = settings(w, { countOwn: true });
    const off = preview(w, s);
    eq(names(off), ['Gemini answer invents a court ruling', 'Search shows graphic results', 'Criticism against AI Overviews']);
    const byName = calls => Object.fromEntries(calls.map(c => [c.facts.issue, c.facts]));
    let facts = byName(w.summaries);
    eq([facts['Gemini answer invents a court ruling'].posts, facts['Gemini answer invents a court ruling'].context_posts.length], [[], 2]);
    eq([facts['Search shows graphic results'].posts, facts['Search shows graphic results'].context_posts.length], [[], 2]);
    eq(facts['Criticism against AI Overviews'].posts.length, 1);
    eq(off.slides[0].issues.map(i => i.summary.filter(p => p.url).length), [0, 0, 1]);
    // delivered: only the post that may be linked is a link on the slide
    const d = save(w, s);
    assert.ok(runNow(w, d.id).ok);
    eq(w.slides.linksOf(w.pulses()[0]).map(l => l.url), [AIO_POST]);
    // ON: every post can be cited
    w.summaries.length = 0;
    const on = preview(w, settings(w, { countOwn: true, linkSensitive: true }));
    facts = byName(w.summaries);
    eq([facts['Gemini answer invents a court ruling'].posts.length, facts['Search shows graphic results'].posts.length], [2, 2]);
    eq(on.slides[0].issues.map(i => i.summary.filter(p => p.url).length), [1, 1, 1]);
    eq(on.slides[0].issues[1].summary.find(p => p.url).url, 'https://x.com/graphic_a/status/2160000000000000202');
  });

  test('slide deliveries: no alerts in the window: the slide says so and is still delivered, with no Gemini call', () => {
    const w = world();
    const d = save(w, settings(w, { lookbackHours: 1 }));
    w.t.g.clock.now += 3 * HOUR;
    const r = runNow(w, d.id);
    assert.ok(r.ok, r.why);
    eq(w.summaries.length, 0);
    const [pulse] = w.pulses();
    assert.match(w.slides.textOf(pulse), /^Brand safety pulse\n\nOct 14, 10:\d\d AM to Oct 14, 11:\d\d AM ET\nNo alerts in this window$/);
  });

  test('slide deliveries: the positive pulse slide is shown as unavailable with its reason, and never made', () => {
    const w = world();
    const s = settings(w, { slides: { pulse: true, positive: true } });
    const p = preview(w, s);
    eq(p.slides.map(x => [x.kind, !!x.unavailable]), [['pulse', false], ['positive', true]]);
    assert.match(p.slides[1].why, /^The positive pulse slide is not available: where its posts would come from is not known yet/);
    const d = save(w, s);
    assert.ok(runNow(w, d.id).ok);
    eq(w.pulses().length, 1);
    eq(w.slides.slideIds(DECK).length, 5);
    assert.match(w.row(d.id).last_run.note, /the positive pulse slide is not available yet/);
    w.as(VIEWER);
    assert.match(w.b.dashDeliveries().positive.why, /never made from another source/);
    eq(w.b.dashDeliveries().servedAt, w.t.g.clock.now);
  });

  // ===========================================================================================================
  // Writing to the deck (SPEC 4.4)
  // ===========================================================================================================

  test('slide deliveries: the spot: right after the picked slide; when it is gone, right before the other; when both are gone, nothing is delivered and the run says why', () => {
    const w = world();
    const [title, agenda, wins, thanks] = w.slides.slideIds(DECK);
    const d = save(w, settings(w, { mode: 'add' }));
    assert.ok(runNow(w, d.id).ok);
    const first = w.pulses()[0];
    eq(w.slides.slideIds(DECK), [title, agenda, first, wins, thanks]);
    w.slides.personRemoves(DECK, agenda);
    assert.ok(runNow(w, d.id).ok);
    const second = w.pulses().find(id => id !== first);
    eq(w.slides.slideIds(DECK), [title, first, second, wins, thanks]);
    w.slides.personRemoves(DECK, wins);
    const before = w.slides.snapshot(DECK);
    const r = runNow(w, d.id);
    eq(r.ok, false);
    eq(r.why, 'The spot picked in the deck (after "Agenda", before "Wins this week") is gone: the slides around it are no longer in the deck, so nothing was put in it. Pick the spot again in the web app.');
    eq(w.slides.snapshot(DECK), before);
    eq(w.row(d.id).last_run.error, r.why);
  });

  test('slide deliveries: replace mode puts the new slide where a person moved the delivery\'s own slide, takes out only that one, and no other slide changes', () => {
    const w = world();
    const d = save(w, settings(w));
    assert.ok(runNow(w, d.id).ok);
    const [old] = w.pulses();
    eq(w.slides.slideIds(DECK).indexOf(old), 2);
    eq(w.row(d.id).placed, [old]);
    w.slides.move(DECK, old, 4);  // a person drags it to the end
    const others = () => w.slides.snapshot(DECK).filter(s => !w.pulses().includes(s.id));
    const before = others();
    w.t.g.clock.now += DAY;
    assert.ok(runNow(w, d.id).ok);
    const [now] = w.pulses();
    assert.notStrictEqual(now, old);
    eq(w.slides.slideIds(DECK).length, 5);
    eq(w.slides.slideIds(DECK).indexOf(now), 4);
    eq(others(), before);
    eq(w.row(d.id).placed, [now]);
    // a person deletes it: the next run goes back to the spot
    w.slides.personRemoves(DECK, now);
    w.t.g.clock.now += DAY;
    assert.ok(runNow(w, d.id).ok);
    eq(w.slides.slideIds(DECK).indexOf(w.pulses()[0]), 2);
    eq(others(), before);
    // a slide a person made of the delivery's own (its title changed) is never taken out
    const mine = w.pulses()[0];
    w.slides.deck(DECK).slides.find(s => s.id === mine).shapes[0].text = 'Our own notes';
    w.t.g.clock.now += DAY;
    assert.ok(runNow(w, d.id).ok);
    assert.ok(w.slides.slideIds(DECK).includes(mine));
    eq(w.pulses().length, 1);
  });

  test('slide deliveries: add mode adds a new dated slide at the spot each run, the newest first, and no other slide changes', () => {
    const w = world();
    const d = save(w, settings(w, { mode: 'add' }));
    const before = w.slides.snapshot(DECK);
    assert.ok(runNow(w, d.id).ok);
    w.t.g.clock.now += DAY;
    assert.ok(runNow(w, d.id).ok);
    const ids = w.slides.slideIds(DECK);
    const pulses = w.pulses();
    eq(pulses.map(id => w.slides.textOf(id).split('\n')[0]), ['Brand safety pulse · Oct 15', 'Brand safety pulse · Oct 14']);
    eq(pulses.map(id => ids.indexOf(id)), [2, 3]);
    eq(w.slides.snapshot(DECK).filter(s => !pulses.includes(s.id)), before);
  });

  test('slide deliveries: a deck the bot\'s account can only view, or can\'t open: nothing is delivered, and the reason names what to share and with whom (the address only in the answer, never on the tab)', () => {
    const w = world({ decks: [deckSpec({ access: 'view' })] });
    const d = save(w, settings(w));
    const before = w.slides.snapshot(DECK);
    const r = runNow(w, d.id);
    eq(r.ok, false);
    eq(r.why, 'The bot\'s account can only view "Weekly brand review", so nothing was put in it: share "Weekly brand review" with the bot\'s account (bot@runner.test) as an editor (Share, then Editor).');
    eq(w.slides.snapshot(DECK), before);
    eq(w.slides.deck(DECK).writes, 0);
    eq(w.summaries.length, 0);  // the deck is looked at first: no Gemini call for a deck that can't take the slide
    const kept = w.row(d.id).last_run.error;
    assert.match(kept, /can only view "Weekly brand review".*with the bot's account as an editor/);
    assert.ok(!JSON.stringify(w.tab().rows).includes('bot@runner.test'));  // the bot's address is never kept on the tab
    // the deck check says the same before anything is saved
    w.as(VIEWER);
    const check = w.b.dashDeckCheck(`https://docs.google.com/presentation/d/${DECK}/edit`);
    eq([check.ok, check.canEdit, check.botAccount, check.slides.length], [true, false, 'bot@runner.test', 4]);
    // no access at all
    const deck = w.slides.deck(DECK);
    deck.access = 'none';
    w.slides.share(w.t.g, deck);
    const r2 = runNow(w, d.id);
    eq(r2.why, 'The bot\'s account can\'t open the deck, so nothing was put in it: share the deck with the bot\'s account (bot@runner.test) as an editor (Share, then Editor), or check the link.');
    eq(w.b.dashDeckCheck(DECK).ok, false);
    eq([w.slides.deck(DECK).writes, w.summaries.length], [0, 0]);
    // a deck in a shared drive: DriveApp lists none of its members, Drive's own API says the bot's account may edit it
    const w2 = world({ decks: [deckSpec({ sharedDrive: true, editors: [VIEWER] })] });
    const d2 = save(w2, settings(w2));
    const r3 = runNow(w2, d2.id);
    assert.ok(r3.ok, r3.why);
    eq(w2.pulses().length, 1);
    const shared = w2.slides.deck(DECK);
    shared.access = 'view';
    w2.slides.share(w2.t.g, shared);
    w2.t.g.clock.now += DAY;
    assert.match(runNow(w2, d2.id).why, /^The bot's account can only view "Weekly brand review"/);
  });

  test('slide deliveries: copy design uses the picked slide\'s layout, its title and body text styles and its background; default uses the deck\'s own title-and-body layout; the picked slide is not changed', () => {
    const layouts = makeSlides().DEFAULT_LAYOUTS.concat([{ name: 'PULSE_DARK', background: '#202124',
      placeholders: [{ type: 'TITLE', style: { fontSize: 30, color: '#ffffff' } }, { type: 'BODY', style: { fontSize: 16, color: '#dddddd' } }] }]);
    const spec = deckSpec({ layouts });
    spec.slides.splice(3, 0, { layout: 'PULSE_DARK', title: 'Risks', body: 'Nothing new', background: '#174ea6',
      titleStyle: { fontFamily: 'Google Sans', fontSize: 34, color: '#e8f0fe' }, bodyStyle: { fontFamily: 'Roboto', fontSize: 13, color: '#c4c7c5' } });
    const w = world({ decks: [spec] });
    const picked = w.slides.slideIds(DECK)[3];
    const s = settings(w, { design: { mode: 'copy', slideId: picked } });
    const p = preview(w, s);
    const { box, ...design } = p.design;
    eq(design, { bg: '#174ea6', font: 'Roboto', titleColor: '#e8f0fe', bodyColor: '#c4c7c5', titleSize: 34, bodySize: 13, from: 'the picked slide' });
    // the picked slide's boxes, read from the deck (the preview draws the text in them)
    eq([box.pageW, box.pageH, box.from, box.body, box.title], [720, 405, 'deck', { x: 31.1, y: 90.8, w: 657.9, h: 269.1 }, { x: 31.1, y: 22.3, w: 657.9, h: 62.6 }]);
    const pickedBefore = w.slides.snapshot(DECK).find(x => x.id === picked);
    const d = save(w, s);
    assert.ok(runNow(w, d.id).ok);
    const [pulse] = w.pulses();
    const made = w.slides.snapshot(DECK).find(x => x.id === pulse);
    eq([made.layout, made.background], ['PULSE_DARK', '#174ea6']);
    const title = w.slides.styleAt(pulse, 'TITLE', 0);
    eq([title.fontFamily, title.fontSize, title.color], ['Google Sans', 34, '#e8f0fe']);
    const body = w.slides.styleAt(pulse, 'BODY', 0);
    eq([body.fontFamily, body.fontSize, body.color, body.bold], ['Roboto', 13, '#c4c7c5', false]);
    eq(w.slides.snapshot(DECK).find(x => x.id === picked), pickedBefore);
    // default: the deck's title-and-body layout, its own styles
    const w2 = world();
    const d2 = save(w2, settings(w2));
    assert.ok(runNow(w2, d2.id).ok);
    const [pulse2] = w2.pulses();
    eq(w2.slides.snapshot(DECK).find(x => x.id === pulse2).layout, 'TITLE_AND_BODY');
    const t2 = w2.slides.styleAt(pulse2, 'TITLE', 0);
    eq([t2.fontFamily, t2.fontSize, t2.color], ['Arial', 28, '#000000']);
    // the slide's words: the title, the window, each issue's name in bold, its numbers, its summary and its status; no emoji
    const text = w2.slides.textOf(pulse2);
    assert.match(text, /^Brand safety pulse\n\nOct 13, 8:\d\d AM to Oct 14, 8:\d\d AM ET \(the bot's Alert log starts within this window\)\nCriticism against AI Overviews\n1 alert · 1 account/);
    assert.match(text, /\nPeople say it happened to them after an update\.\nDone: 1 Social Alert sent to the testers only \(Testing\) · With: nobody yet · Readers: nothing to do$/);
    assert.ok(!EMOJI.test(text));
    const nameAt = text.split('\n\n')[1].indexOf('Criticism against AI Overviews');
    eq(w2.slides.styleAt(pulse2, 'BODY', nameAt).bold, true);
  });

  test('slide deliveries: the text stays on one slide: set smaller on the placed slide only when it would run past its box, the preview shows the same size and the same words, and the run says so', () => {
    // a deck whose title-and-body box is short: three issues at its own 18 points run past it
    const layouts = makeSlides().DEFAULT_LAYOUTS.map(l => (l.name !== 'TITLE_AND_BODY' ? l : Object.assign({}, l, {
      placeholders: [{ type: 'TITLE', style: { fontSize: 28 } }, { type: 'BODY', style: { fontSize: 18 }, box: { x: 31.1, y: 90.8, w: 657.9, h: 200 } }] })));
    const w = world({ decks: [deckSpec({ layouts })] });
    const s = settings(w, { countOwn: true });
    const p = preview(w, s);
    const sl = p.slides[0];
    eq([sl.issues.length, sl.fit.deckPt, sl.box.body.h, sl.box.from], [3, 18, 200, 'deck']);
    assert.ok(sl.fit.bodyPt < 18 && sl.fit.bodyPt >= 9, JSON.stringify(sl.fit));
    eq(sl.fit.note, `the text is set at ${sl.fit.bodyPt} pt (the deck's body text is 18 pt) so it fits on the slide`);
    // the size is the largest that fits the box by the rule (and the words are the slide's own: title, body, bold, links)
    const tall = pt => w.b.slideLines_(sl.model.body, 657.9, pt) * 1.3 * pt + 2 * 7.2;
    assert.ok(tall(sl.fit.bodyPt) <= 200 && tall(sl.fit.bodyPt + 1) > 200, `${tall(sl.fit.bodyPt)} ${tall(sl.fit.bodyPt + 1)}`);
    eq(sl.model.title, 'Brand safety pulse');
    assert.ok(sl.model.links.length >= 1 && sl.model.links.every(([a, z, url]) => z > a && /^https:\/\//.test(url) && !/https?:|www\./.test(sl.model.body.slice(a, z))));
    const agendaBefore = w.slides.snapshot(DECK)[1];
    const d = save(w, s);
    const r = runNow(w, d.id);
    assert.ok(r.ok, r.why);
    const [pulse] = w.pulses();
    const text = w.slides.textOf(pulse).split('\n\n')[1];
    eq(text, sl.model.body);
    eq([w.slides.styleAt(pulse, 'BODY', 0).fontSize, w.slides.styleAt(pulse, 'BODY', text.length - 1).fontSize], [sl.fit.bodyPt, sl.fit.bodyPt]);
    eq(w.slides.styleAt(pulse, 'TITLE', 0).fontSize, 28);
    assert.ok(w.row(d.id).last_run.note.includes(sl.fit.note), JSON.stringify(w.row(d.id).last_run));
    // no other slide is changed
    eq(w.slides.snapshot(DECK)[1], agendaBefore);
    // text that fits keeps the deck's own size, and nothing is said
    const w2 = world();
    const p2 = preview(w2, settings(w2));
    eq([p2.slides[0].fit.bodyPt, p2.slides[0].fit.deckPt, p2.slides[0].fit.note], [18, 18, '']);
    const d2 = save(w2, settings(w2));
    assert.ok(runNow(w2, d2.id).ok);
    const [pulse2] = w2.pulses();
    eq(w2.slides.styleAt(pulse2, 'BODY', 0).fontSize, 18);
    assert.ok(!/fits on the slide/.test(w2.row(d2.id).last_run.note || ''));
    // the rule itself: short text keeps its size; a box too small for any size gets the smallest
    eq(w.b.slideFitSize_('One line', { w: 657.9, h: 269.1 }, 18), 18);
    eq(w.b.slideFitSize_('word '.repeat(2000), { w: 657.9, h: 269.1 }, 18), 9);
  });

  // ===========================================================================================================
  // The schedule (SPEC 4.5)
  // ===========================================================================================================

  test('slide deliveries: the next run is worked out in the delivery\'s own time zone, across a change of the clocks', () => {
    const { b } = world({ on: false });
    const at = (days, time, tz) => ({ days, time, tz, mondayCoversWeekend: false });
    const daily = [0, 1, 2, 3, 4, 5, 6];
    // New York: 9:00 on Saturday Oct 31 is 13:00 UTC (EDT); 9:00 on Sunday Nov 1 is 14:00 UTC (EST)
    eq(b.slideNextRun_(at(daily, '09:00', 'America/New_York'), Date.UTC(2026, 9, 31, 12, 0)), Date.UTC(2026, 9, 31, 13, 0));
    eq(b.slideNextRun_(at(daily, '09:00', 'America/New_York'), Date.UTC(2026, 9, 31, 13, 30)), Date.UTC(2026, 10, 1, 14, 0));
    eq(b.slideNextRun_(at(daily, '09:00', 'America/New_York'), Date.UTC(2026, 10, 1, 14, 0)), Date.UTC(2026, 10, 2, 14, 0));
    // 1:30 comes twice on Nov 1: the first; 2:30 never comes on Mar 8: the first moment after the jump (3:30 EDT)
    eq(b.slideNextRun_(at(daily, '01:30', 'America/New_York'), Date.UTC(2026, 9, 31, 12, 0)), Date.UTC(2026, 10, 1, 5, 30));
    eq(b.slideNextRun_(at(daily, '02:30', 'America/New_York'), Date.UTC(2026, 2, 7, 12, 0)), Date.UTC(2026, 2, 8, 7, 30));
    // London on Oct 25 (BST to GMT); weekdays only: Friday's run, then Monday's
    eq(b.slideNextRun_(at(daily, '09:00', 'Europe/London'), Date.UTC(2026, 9, 24, 9, 0)), Date.UTC(2026, 9, 25, 9, 0));
    eq(b.slideNextRun_(at([1, 2, 3, 4, 5], '09:00', 'America/New_York'), Date.UTC(2026, 10, 13, 15, 0)), Date.UTC(2026, 10, 16, 14, 0));
    eq(b.slideRuns_(at([1, 2, 3, 4, 5], '09:00', 'America/New_York'), Date.UTC(2026, 9, 29, 0, 0), Date.UTC(2026, 10, 4, 0, 0)),
      [Date.UTC(2026, 9, 29, 13, 0), Date.UTC(2026, 9, 30, 13, 0), Date.UTC(2026, 10, 2, 14, 0), Date.UTC(2026, 10, 3, 14, 0)]);
    eq(b.slideWindowLabel_(Date.UTC(2026, 9, 31, 13, 0), Date.UTC(2026, 10, 1, 14, 0), 'America/New_York'), 'Oct 31, 9:00 AM to Nov 1, 9:00 AM ET');
  });

  test('slide deliveries: the coverage check names gaps and overlaps in plain sentences, Match closes them, and Monday covers the weekend from Friday\'s run', () => {
    const w = world({ on: false });
    const b = w.b;
    const now = Date.UTC(2026, 10, 16, 15, 0);  // Monday Nov 16, 10:00 ET (no change of the clocks in the next 14 days)
    const sched = (days, time, mon) => ({ days, time, tz: 'America/New_York', mondayCoversWeekend: !!mon });
    const weekdays = [1, 2, 3, 4, 5];
    // weekdays at 9 with a 24-hour lookback: the weekend is never covered
    const gap = b.slideCoverage_({ schedule: sched(weekdays, '09:00'), lookbackHours: 24 }, now);
    eq([gap.ok, gap.gapText, gap.overlapText], [false, ['Friday 9:00 AM to Sunday 9:00 AM is never on a slide (48 hours each week, all of Saturday).'], []]);
    eq([gap.match.lookbackHours, gap.match.mondayCoversWeekend], [24, true]);
    eq(gap.match.text, 'Match: each slide covers the 24 hours since the one before, and Monday\'s covers the weekend from the last run before it.');
    // Match applied: no gap, no overlap
    const matched = b.slideCoverage_({ schedule: sched(weekdays, '09:00', true), lookbackHours: 24 }, now);
    eq([matched.ok, matched.gapText, matched.overlapText], [true, [], []]);
    // Monday's window starts at Friday's run
    const monday = Date.UTC(2026, 10, 23, 14, 0);
    const win = b.slideWindow_({ schedule: sched(weekdays, '09:00', true), lookbackHours: 24 }, monday);
    eq([win.start, win.end, win.prevStart], [Date.UTC(2026, 10, 20, 14, 0), monday, Date.UTC(2026, 10, 17, 14, 0)]);
    eq(b.slideWindow_({ schedule: sched(weekdays, '09:00', true), lookbackHours: 24 }, Date.UTC(2026, 10, 24, 14, 0)).start, Date.UTC(2026, 10, 23, 14, 0));
    // overlaps: every slide the same; or only some
    eq(b.slideCoverage_({ schedule: sched([0, 1, 2, 3, 4, 5, 6], '09:00'), lookbackHours: 36 }, now).overlapText, ['Each slide repeats 12 hours of the one before.']);
    eq(b.slideCoverage_({ schedule: sched(weekdays, '09:00'), lookbackHours: 72 }, now).overlapText,
      ['The Tuesday, Wednesday, Thursday and Friday slides repeat 48 hours of the one before.']);
    // a gap within the day, every day
    eq(b.slideCoverage_({ schedule: sched([0, 1, 2, 3, 4, 5, 6], '09:00'), lookbackHours: 12 }, now).gapText,
      ['From 9:00 AM to 9:00 PM every day is never on a slide (12 hours each time).']);
    // through the web app (a viewer of the bot's sheet may check a schedule)
    w.as(READER);
    const api = b.dashScheduleCheck({ lookbackHours: 24, schedule: sched(weekdays, '09:00') });
    eq([api.ok, api.coverage.ok, api.coverage.gaps.length, api.matched, api.match.lookbackHours], [true, false, 1, false, 24]);
    eq(api.next.length, 5);
    assert.match(api.next[0].label, /^(Monday|Tuesday|Wednesday|Thursday|Friday), [A-Z][a-z]{2} \d{1,2}, 9:00 AM ET$/);
    const bad = b.dashScheduleCheck({ lookbackHours: 0, schedule: { days: [], time: '25:00', tz: 'Mars/Olympus' } });
    eq(bad.errors, ['Pick at least one day for the slide to be delivered.', 'Give the time as hours and minutes, for example 09:00.',
      'Pick the time zone from the list (for example America/New_York).', 'The lookback must be a whole number of hours from 1 hour to 30 days (720 hours).']);
  });

  // ===========================================================================================================
  // The dispatcher, shared generation, telling people (SPEC 4.3-4.5)
  // ===========================================================================================================

  test('slide deliveries: two deliveries due together with the same settings share one generated set (one set of Gemini calls); one with other settings gets its own; each run moves its next run on', () => {
    const w = world({ decks: [deckSpec(), deckSpec({ id: DECK2, name: 'Leadership update' })] });
    const every = { days: [0, 1, 2, 3, 4, 5, 6], time: '08:00', tz: 'America/New_York', mondayCoversWeekend: false };
    const ids2 = w.slides.slideIds(DECK2);
    const a = save(w, settings(w, { schedule: every, lookbackHours: 48 }));
    const b = save(w, settings(w, { name: 'Leadership pulse', schedule: every, lookbackHours: 48,
      deck: { url: `https://docs.google.com/presentation/d/${DECK2}/edit`, title: 'Leadership update' },
      spot: { afterId: ids2[0], beforeId: ids2[1], afterLabel: 'Leadership update', beforeLabel: 'Agenda' } }));
    const c = save(w, settings(w, { name: 'With own finds', schedule: every, lookbackHours: 48, countOwn: true, mode: 'add' }));
    const due = Date.UTC(2026, 9, 15, 12, 0);  // 8:00 ET on Oct 15: the next run of all three
    eq([a, b, c].map(d => w.row(d.id).next_run), [due, due, due]);
    w.t.g.clock.now = due + 3 * MIN;
    w.as('');  // the time trigger
    // the script cache keeps nothing this time (as when it is full): the set is shared within the run itself
    const svc = w.t.g.services.CacheService;
    const real = svc.getScriptCache;
    svc.getScriptCache = () => Object.assign({}, real(), { put: (k, v) => { if (!String(k).startsWith('dash1:gen:')) real().put(k, v); } });
    const r = w.b.dashDeliverDue();
    svc.getScriptCache = real;
    eq(r.ran.map(x => [x.id, x.ok]), [[a.id, true], [b.id, true], [c.id, true]]);
    eq(w.summaries.length, 1 + 3);  // one set for a and b (one issue), one for c (three issues)
    eq([w.pulses(DECK).length, w.pulses(DECK2).length], [2, 1]);
    const textA = w.slides.textOf(w.row(a.id).placed[0]);
    eq(w.slides.textOf(w.row(b.id).placed[0]), textA);
    assert.match(textA, /^Brand safety pulse\n\nOct 13, 8:00 AM to Oct 15, 8:00 AM ET/);  // the window ends at the scheduled time
    eq([a, b, c].map(d => w.row(d.id).next_run), [due + DAY, due + DAY, due + DAY]);
    eq(w.t.g.props.get('SLIDE_RUN_CLAIM'), undefined);  // the claim let go
    // and kept 30 minutes in the script cache (dash1:gen:): the same window and options are built once
    const s = w.b.slideSettingsCheck_(w.row(a.id).settings).settings;
    const win = w.b.slideWindow_(s, due + HOUR);
    const calls = w.summaries.length;
    const one = w.b.slideGenFor_(w.t.sheet(), s, win, null, {});
    const two = w.b.slideGenFor_(w.t.sheet(), s, win, null, {});
    eq([one.ok, !!one.shared, two.ok, !!two.shared, w.summaries.length], [true, false, true, true, calls + 1]);
    eq(two.issues, one.issues);
    assert.ok(Array.from(w.t.g.cache.keys()).some(k => k.startsWith('dash1:gen:')));
    // nothing due: nothing runs
    eq(w.b.dashDeliverDue().ran, []);
  });

  test('slide deliveries: the person told is held to the Testing rule: while Testing only the testers in B30, nobody when B30 is blank; LIVE the delivery\'s own list', () => {
    const w = world();
    const d = save(w, settings(w));
    const already = w.t.g.gmail.sentMessages().length;  // the golden run's own emails
    const sent = () => w.t.g.gmail.sentMessages().slice(already);
    assert.match(w.t.control().cell(29, 3), /Testing/);
    assert.ok(runNow(w, d.id).ok);
    eq(sent().length, 1);
    const [mail] = sent();
    eq([mail.to, mail.cc, mail.subject], [[TESTER], [], 'Brand safety pulse delivered: Weekly brand review']);
    assert.match(mail.text, new RegExp(`is in "Weekly brand review":\\n${`https://docs.google.com/presentation/d/${DECK}/edit#slide=id.`}`));
    assert.match(mail.text, /Testing: this went only to the testers in Control!B30; the delivery's own list was not emailed\./);
    assert.ok(!EMOJI.test(mail.subject + mail.text + mail.html));
    eq(w.row(d.id).last_run.notified, 'emailed 1');
    // B30 blank: nobody
    w.t.control().getRange(30, 2).setValue('');
    w.t.g.clock.now += DAY;
    assert.ok(runNow(w, d.id).ok);
    eq(sent().length, 1);
    eq(w.row(d.id).last_run.notified, 'not emailed: Testing, and Control!B30 (Testing: send to) is blank');
    // the Safety valve ON is Testing whatever the bot's last run said
    w.t.control().getRange(29, 3).setValue('OFF · LIVE: alerts go to the real teams');
    w.t.control().getRange(29, 2).setValue('ON');
    w.t.g.clock.now += DAY;
    assert.ok(runNow(w, d.id).ok);
    eq(sent().length, 1);
    // LIVE (the bot's last run said so, the Safety valve OFF, no Burson test copy): the delivery's own list
    w.t.control().getRange(29, 2).setValue('OFF');
    w.t.g.clock.now += DAY;
    assert.ok(runNow(w, d.id).ok);
    eq(sent().length, 2);
    eq(sent()[1].to, NOTIFY);
    assert.ok(!/Testing/.test(sent()[1].text));
  });

  test('slide deliveries: dashDeliverDue refuses a dashboard viewer\'s call; with row 55 OFF, or the Slides approval missing, or another run going on, it does nothing (no deck, no Gemini, no email)', () => {
    const w = world();
    const d = save(w, settings(w));
    w.as(VIEWER);
    assert.throws(() => w.b.dashDeliverDue(), /Not available from the dashboard/);
    w.t.g.clock.now = w.row(d.id).next_run + MIN;
    const mails = w.t.g.gmail.sentMessages().length;
    const quiet = () => {
      eq([w.slides.deck(DECK).writes, w.summaries.length, w.t.g.gmail.sentMessages().length, w.row(d.id).last_run], [0, 0, mails, null]);
    };
    w.as('');
    w.t.control().getRange(55, 2).setValue('OFF');
    eq(w.b.dashDeliverDue(), { done: false, why: 'row 55 is OFF', ran: [] });
    eq(w.t.g.props.has('SLIDE_RUN_CLAIM'), false);
    quiet();
    w.t.control().getRange(55, 2).setValue('ON');
    w.t.g.script.notGranted = [SCOPE];
    eq(w.b.dashDeliverDue().why, 'the Slides approval is missing');
    quiet();
    w.t.g.script.notGranted = [];
    w.t.g.props.set('SLIDE_RUN_CLAIM', JSON.stringify({ id: 'other-run', at: w.t.g.clock.now - MIN }));
    eq(w.b.dashDeliverDue().why, 'another delivery run is going on');
    quiet();
    // the other run's claim is older than 6 minutes: it ended without letting go, and this run goes ahead
    w.t.g.props.set('SLIDE_RUN_CLAIM', JSON.stringify({ id: 'other-run', at: w.t.g.clock.now - 7 * MIN }));
    eq(w.b.dashDeliverDue().ran.map(x => x.ok), [true]);
    eq(w.pulses().length, 1);
    // preview and run now say why while row 55 is OFF; saving still works (it waits)
    w.t.control().getRange(55, 2).setValue('OFF');
    w.as(VIEWER);
    assert.match(w.b.dashRunNow(d.id).why, /^Slide deliveries is OFF on the Control tab \(row 55\)/);
    assert.match(w.b.dashPreview(settings(w)).why, /^Slide deliveries is OFF/);
    const saved = w.b.dashSaveDelivery(settings(w, { name: 'Waiting pulse' }));
    eq([saved.ok, /wait/.test(saved.waits)], [true, true]);
  });

  test('slide deliveries: a paused delivery is not run; resumed, it runs at its next scheduled time', () => {
    const w = world();
    const d = save(w, settings(w));
    w.as(VIEWER);
    const p = w.b.dashSetDeliveryStatus(d.id, 'paused');
    eq([p.ok, p.delivery.status, p.delivery.nextRunLabel, w.row(d.id).next_run], [true, 'paused', 'Paused', 0]);
    w.t.g.clock.now += 2 * DAY;
    w.as('');
    eq(w.b.dashDeliverDue().ran, []);
    w.as(VIEWER);
    const r = w.b.dashSetDeliveryStatus(d.id, 'active');
    eq(r.delivery.status, 'active');
    assert.ok(w.row(d.id).next_run > w.t.g.clock.now);
    eq(w.b.dashSetDeliveryStatus(d.id, 'gone').why, 'A delivery is either active or paused.');
  });

  // ===========================================================================================================
  // The store, the settings and the access gate (SPEC 4.1, 4.2, 4.6)
  // ===========================================================================================================

  test('slide deliveries: deliveries live on the bot\'s own tab (its mark in A1, the column names in row 3); a person\'s tab of that name is never read or written, and the web app says so', () => {
    const w = world();
    const d = save(w, settings(w));
    const tab = w.tab();
    eq(tab.rows[0][0], w.b.ev('SLIDE_TITLE_'));
    eq(tab.rows[2], w.b.ev('SLIDE_HEADER_'));
    const row = w.row(d.id);
    eq([row.id, row.name, row.deck_id, row.status, row.updated_by, row.settings.notify], ['SD-1', 'Weekly review pulse', DECK, 'active', VIEWER, NOTIFY]);
    assert.ok(tab.rows.every(r => r.every(v => String(v).length <= 45000)));
    eq(tab.protections[0].warningOnly, true);
    // a change keeps the row (and what it placed)
    const again = save(w, settings(w, { id: d.id, name: 'Weekly review pulse (renamed)' }));
    eq([again.id, tab.rows.length, w.row(d.id).name], ['SD-1', 4, 'Weekly review pulse (renamed)']);
    // a person's tab of that name
    const w2 = world();
    const theirs = w2.t.sheet().insertSheet('Slide deliveries');
    theirs.appendRow(['Our slide plan']);
    theirs.appendRow(['Week 1', 'Pulse']);
    const kept = JSON.stringify(theirs.rows);
    w2.as(VIEWER);
    const r = w2.b.dashSaveDelivery(settings(w2));
    eq(r.ok, false);
    assert.match(r.why, /^A tab named "Slide deliveries" that the bot did not make is in the bot's sheet/);
    const list = w2.b.dashDeliveries();
    eq([list.ok, list.tab.ok, list.deliveries], [true, false, []]);
    assert.match(list.tab.why, /rename that tab/);
    w2.as('');
    w2.t.g.clock.now += 2 * DAY;
    eq(w2.b.dashDeliverDue().ran, []);
    eq(JSON.stringify(theirs.rows), kept);
  });

  test('slide deliveries: settings are checked with plain messages, and options left out are OFF', () => {
    const w = world();
    const b = w.b;
    const empty = b.slideSettingsCheck_({});
    eq(empty.errors, ['Give the delivery a name.', 'Paste the link of the Google Slides deck (from its address bar).',
      'Pick where in the deck the slide goes (between two slides).', 'Pick the design: copy a slide of the deck, or the deck\'s own title-and-body layout.',
      'Pick at least one day for the slide to be delivered.', 'Give the time as hours and minutes, for example 09:00.',
      'Pick the time zone from the list (for example America/New_York).', 'The lookback must be a whole number of hours from 1 hour to 30 days (720 hours).',
      'Turn on the brand safety pulse slide: it is what a delivery puts in the deck.', 'Pick whether each run replaces the delivery\'s slide or adds a new dated one.']);
    const s = settings(w);
    delete s.countOwn;
    delete s.linkSensitive;
    const ok = b.slideSettingsCheck_(s);
    eq([ok.ok, ok.settings.countOwn, ok.settings.linkSensitive, ok.settings.deck.id], [true, false, false, DECK]);
    eq(b.slideSettingsCheck_(settings(w, { slides: { pulse: false, positive: true } })).errors,
      ['Nothing would be delivered: the positive pulse slide is not available yet, so turn on the brand safety pulse slide.']);
    eq(b.slideSettingsCheck_(settings(w, { notify: ['someone', 'reader.one@team.test'] })).errors, ['These are not email addresses: someone.']);
    eq(b.slideSettingsCheck_(settings(w, { design: { mode: 'copy', slideId: '' } })).errors, ['Pick the slide whose design to copy.']);
    eq(b.slideSettingsCheck_(settings(w, { lookbackHours: 721 })).errors, ['The lookback must be a whole number of hours from 1 hour to 30 days (720 hours).']);
    // only an editor of the bot's sheet may save, run or pause; and only into a deck they can open themselves (the bot's
    // account does the writing: a viewer of the deck may set one up)
    w.as(READER);
    const reader = b.dashSaveDelivery(settings(w));
    eq(reader.ok, false);
    assert.match(reader.why, /^Setting up, running and pausing deliveries is for the people who can edit the bot's sheet/);
    eq(w.tab(), null);
    w.slides.deck(DECK).editors = [];
    w.slides.share(w.t.g, w.slides.deck(DECK));
    w.as(VIEWER);
    assert.match(b.dashSaveDelivery(settings(w)).why, /^You can't open this deck yourself \(it is not shared with you by name/);
    eq(w.tab(), null);
    w.slides.deck(DECK).viewers = [VIEWER];
    w.slides.share(w.t.g, w.slides.deck(DECK));
    const saved = b.dashSaveDelivery(settings(w));
    assert.ok(saved.ok, saved.why);
  });

  test('slide deliveries: every dash* function of the deliveries starts with the access gate: a viewer the bot\'s sheet is not shared with gets nothing but why', () => {
    const w = world();
    const d = save(w, settings(w));
    w.as(STRANGER);
    const b = w.b;
    const answers = [b.dashDeliveries(), b.dashDeckCheck(DECK), b.dashScheduleCheck(settings(w)), b.dashPreview(settings(w)),
      b.dashSaveDelivery(settings(w)), b.dashRunNow(d.id), b.dashSetDeliveryStatus(d.id, 'paused')];
    answers.forEach(a => {
      eq([a.ok, a.denied], [false, true]);
      assert.match(a.why, new RegExp(`the sheet is not shared with ${STRANGER}`));
    });
    eq([w.slides.deck(DECK).writes, w.summaries.length, w.row(d.id).status], [0, 0, 'active']);
    // the list, as an editor sees it
    w.as(VIEWER);
    const list = b.dashDeliveries();
    eq([list.ok, list.on, list.scopeOk, list.botAccount, list.mayChange], [true, true, true, 'bot@runner.test', true]);
    const [item] = list.deliveries;
    eq([item.where, item.schedule, item.lookback, item.lastRun], ['After "Agenda"', 'Weekdays at 9:00 AM (America/New_York)', '24 hours', null]);
    assert.match(item.nextRunLabel, /^Oct 14, 9:00 AM ET$/);
  });

  // ===========================================================================================================
  // The review's fixes (each test fails without its fix)
  // ===========================================================================================================

  /** An Alert-log row as slideAlertRows_ hands it on (decoded), for the pure counting tests. */
  const logRow = o => Object.assign({ alert_id: 'QA-1', created_at: 0, source_at: 0, space: 'spaces/AAQAfeed > spaces/AAQAanalyst', record_key: '',
    author: '@someone', status: 'ok', forwarded_fields: {}, resend_of: '', email_status: '', email_input: {}, email_groups: '', email_subject: '',
    email_at: '', email_sent_at: '', decision: '', tns_submitted: '', ingested: '' }, o);
  const T0 = Date.UTC(2026, 10, 17, 14, 0);
  const LIVE_SINCE = { since: T0 - DAY, changes: [[T0 - DAY, 1]] };  // the bot was LIVE all along (its kept mode record)
  const one = (rows, modes, countOwn, from, to) => {
    const c = H.B.slideCount_(H.B.slideAlerts_(rows, !!countOwn, modes || null), from === undefined ? T0 - DAY : from, to === undefined ? T0 + DAY : to);
    return { c, issues: Array.from(c.issues.values()) };
  };

  test('slide deliveries: a resend and the alert it resends are one alert, and what either did counts: the superseded original\'s Social Alert and T&S form are on the status line, and with "link sensitive" OFF its post is never cited (SD-1)', () => {
    const post = 'https://x.com/someone/status/2160000000000000999';
    const ff = { issue_name: 'Search shows graphic results', post_url: post, author: '@someone', social_network: 'X', total_engagement: 5000 };
    const rows = [
      logRow({ alert_id: 'QA-10', created_at: T0, source_at: T0 - MIN, record_key: 'x.com/status/2160000000000000999', status: 'superseded', forwarded_fields: ff,
        email_status: 'sent', email_sent_at: T0 + MIN, email_groups: 'gcpa gup tns', tns_submitted: T0 + MIN }),
      logRow({ alert_id: 'QA-11', created_at: T0 + HOUR, source_at: T0 + HOUR - MIN, record_key: 'x.com/status/2160000000000000999', status: 'fixed', forwarded_fields: ff, resend_of: 'QA-10' }),
    ];
    const { issues } = one(rows, LIVE_SINCE);
    eq([issues.length, issues[0].rows.length, issues[0].rows[0].ids], [1, 1, ['QA-10', 'QA-11']]);
    eq(H.B.slideStatusLine_(issues[0]), 'Done: 1 Social Alert sent to gcpa and gup, 1 T&S form submitted · With: the teams emailed · Readers: nothing to do');
    const posts = H.B.slidePosts_(issues[0], false);
    eq([posts.citable.length, posts.context.length], [0, 1]);
    // the second flow's row of the same post (the Mirror space's, fix asked), recorded before the Auto-correct space's
    // row that sent the Social Alert and the T&S form: one alert, and the send is not dropped
    const two = [
      logRow({ alert_id: 'QA-100', created_at: T0, source_at: T0 - MIN, record_key: 'x.com/status/2160000000000000999', status: 'fix_requested', forwarded_fields: ff }),
      logRow({ alert_id: 'QA-101', created_at: T0 + MIN, source_at: T0 - MIN, space: 'spaces/AAQAfeed > spaces/AAQAac (auto-correct)', record_key: 'x.com/status/2160000000000000999',
        status: 'fixed', forwarded_fields: ff, email_status: 'sent', email_sent_at: T0 + 2 * MIN, email_groups: 'gcpa tns', tns_submitted: T0 + 2 * MIN,
        email_subject: '[Auto-correct test] SOCIAL ALERT: Search' }),
    ];
    const r2 = one(two, LIVE_SINCE);
    eq(r2.issues[0].rows.map(a => a.ids), [['QA-100', 'QA-101']]);
    eq(H.B.slideStatusLine_(r2.issues[0]),
      'Done: 1 Social Alert sent to the testers only (Testing), 1 T&S form submitted, 1 fix asked of Burson · With: Burson · Readers: nothing to do');
    eq(H.B.slidePosts_(r2.issues[0], false).citable, []);
  });

  test('slide deliveries: a Social Alert sent while the bot was Testing went only to the testers, and the slide says so; LIVE, the teams; before the bot recorded its mode, "not recorded"; each run records the mode while row 55 is ON, only when it changes (SD-2)', () => {
    const ff = { issue_name: 'Maps routing onto a closed bridge', post_url: 'https://x.com/maps/status/2160000000000000501', author: '@maps', social_network: 'X' };
    const sent = logRow({ alert_id: 'QA-20', created_at: T0, source_at: T0, record_key: 'x.com/status/2160000000000000501', forwarded_fields: ff,
      email_status: 'sent', email_sent_at: T0 + MIN, email_groups: 'gcpa' });
    const line = modes => H.B.slideStatusLine_(one([sent], modes).issues[0]);
    eq(line(LIVE_SINCE), 'Done: 1 Social Alert sent to gcpa · With: the teams emailed · Readers: nothing to do');
    eq(line({ since: T0 - DAY, changes: [[T0 - DAY, 1], [T0 - HOUR, 0]] }), 'Done: 1 Social Alert sent to the testers only (Testing) · With: nobody yet · Readers: nothing to do');
    eq(line(null), 'Done: 1 Social Alert sent (to the teams or only to the testers: not recorded) · With: not known · Readers: nothing to do');
    eq(line({ since: T0 + HOUR, changes: [[T0 + HOUR, 1]] }), 'Done: 1 Social Alert sent (to the teams or only to the testers: not recorded) · With: not known · Readers: nothing to do');
    // the Auto-correct space's send (always Testing), whatever the record says
    eq(H.B.slideStatusLine_(one([Object.assign({}, sent, { space: 'spaces/AAQAfeed > spaces/AAQAac (auto-correct)' })], LIVE_SINCE).issues[0]),
      'Done: 1 Social Alert sent to the testers only (Testing) · With: nobody yet · Readers: nothing to do');
    // the record: kept by each run while row 55 is ON (Testing here), written only when the mode changes
    const w = world();
    const props = w.t.g.props;
    props.delete('SLIDE_MODE_LOG');
    w.t.poll();
    const log = JSON.parse(props.get('SLIDE_MODE_LOG'));
    eq([log.since, log.changes], [w.t.g.clock.now, [[w.t.g.clock.now, 0]]]);
    w.t.poll();
    eq(JSON.parse(props.get('SLIDE_MODE_LOG')).changes.length, 1);
    eq(w.b.slideModeNote_(true, w.t.g.clock.now + MIN), 'kept');
    eq(w.b.slideModeAt_(w.b.slideModeLog_(), w.t.g.clock.now + 2 * MIN), 'live');
    // row 55 OFF: nothing recorded
    w.t.control().getRange(55, 2).setValue('OFF');
    props.delete('SLIDE_MODE_LOG');
    w.t.poll();
    eq(props.get('SLIDE_MODE_LOG'), undefined);
  });

  test('slide deliveries: alerts are counted once: Burson\'s alert with no link that both test spaces recorded, the bot\'s own find on a post Burson alerted (engagement not doubled), and an alert whose two rows fall either side of a window\'s end, on one slide only (SD-3)', () => {
    const ff = { issue_name: 'Gemini app will not open', author: '@nolink', social_network: 'X', total_engagement: 3000 };
    const a = logRow({ alert_id: 'QA-30', created_at: T0, source_at: T0 - MIN, forwarded_fields: ff });
    const b = logRow({ alert_id: 'QA-31', created_at: T0 + MIN, source_at: T0 - MIN, space: 'spaces/AAQAfeed > spaces/AAQAac (auto-correct)', forwarded_fields: ff });
    const r = one([a, b]);
    eq(H.B.slideNumbers_(r.issues[0], null).text.split(' · ').slice(0, 4), ['1 alert', '1 account', '1 platform (X)', '3,000 engagements']);
    // the bot's own Watch alert on the post Burson alerted: one alert, 700 engagements (not 1,400)
    const post = { issue_name: 'Pixel camera fails', post_url: 'https://x.com/cam/status/2160000000000000601', author: '@cam', social_network: 'X', total_engagement: 700 };
    const watch = logRow({ alert_id: 'QA-32', created_at: T0, source_at: T0, record_key: 'x.com/status/2160000000000000601', forwarded_fields: post, ingested: 'Watch alert' });
    const burson = logRow({ alert_id: 'QA-33', created_at: T0 + 10 * MIN, source_at: T0 + 9 * MIN, record_key: 'x.com/status/2160000000000000601', forwarded_fields: post });
    const own = one([watch, burson], null, true);
    eq([own.issues.length, own.issues[0].rows.length, own.issues[0].burson], [1, 1, true]);
    eq(H.B.slideNumbers_(own.issues[0], null).text.split(' · ')[3], '700 engagements');
    // the two flows' rows of one alert either side of 9:00: on the slide that ends at 9:00 only
    const nine = T0;
    const m = logRow({ alert_id: 'QA-34', created_at: nine - 2 * MIN, source_at: nine - 3 * MIN, record_key: 'x.com/status/2160000000000000701',
      forwarded_fields: { issue_name: 'Chrome closes tabs', post_url: 'https://x.com/tabs/status/2160000000000000701', author: '@tabs' } });
    const ac = Object.assign({}, m, { alert_id: 'QA-35', created_at: nine + 2 * MIN, space: 'spaces/AAQAfeed > spaces/AAQAac (auto-correct)' });
    eq([one([m, ac], null, false, nine - DAY, nine).issues.length, one([m, ac], null, false, nine, nine + DAY).issues.length], [1, 0]);
  });

  test('slide deliveries: alerts with no issue name are never left out: a window with only such alerts says how many (never "No alerts in this window"), and beside named issues they are counted on their own line (SD-4)', () => {
    const named = logRow({ alert_id: 'QA-40', created_at: T0, source_at: T0, record_key: 'x.com/status/2160000000000000801',
      forwarded_fields: { issue_name: 'Search shows graphic results', post_url: 'https://x.com/g/status/2160000000000000801', author: '@g' } });
    const unnamed = logRow({ alert_id: 'QA-41', created_at: T0, source_at: T0, record_key: 'x.com/status/2160000000000000802',
      forwarded_fields: { issue_name: '', post_url: 'https://x.com/u/status/2160000000000000802', author: '@u' }, email_status: 'sent', email_sent_at: T0 });
    const unnamed2 = Object.assign({}, unnamed, { alert_id: 'QA-42', record_key: 'x.com/status/2160000000000000803', email_status: '',
      forwarded_fields: { issue_name: '', post_url: 'https://x.com/u2/status/2160000000000000803', author: '@u2' } });
    eq([one([unnamed, unnamed2]).c.unnamed, one([unnamed, unnamed2]).c.unnamedSent, one([unnamed, unnamed2]).issues.length], [2, 1, 0]);
    const w = world();
    const s = w.b.slideSettingsCheck_(settings(w)).settings;
    const win = { start: T0 - DAY, end: T0 + HOUR, prevStart: T0 - 2 * DAY, prevEnd: T0 - DAY };
    const only = w.b.slideModel_({ window: win, none: false, issues: [], unnamed: 2, unnamedSent: 1, note: '' }, s);
    assert.ok(!/No alerts in this window/.test(only.body), only.body);
    assert.match(only.body, /\n2 alerts without an issue name \(1 with a Social Alert sent\)$/);
    eq(w.b.slideModel_({ window: win, none: true, issues: [], unnamed: 0, note: '' }, s).body.split('\n').pop(), 'No alerts in this window');
    // beside a named issue, in a real preview (the bot's Alert log, one alert written with no issue name)
    addRow(w, 'QA-1001', { id: 'QA-2401', at: w.t.g.clock.now - 5 * MIN, name: '', author: 'nameless', post: 'https://x.com/nameless/status/2160000000000000804',
      row: { email_input: {}, email_status: '' } });
    const p = preview(w, settings(w));
    eq([p.slides[0].unnamed, p.slides[0].unnamedLine], [1, '1 alert without an issue name']);
    eq(p.slides[0].model.body.split('\n').pop(), 'Also 1 alert without an issue name');
  });

  test('slide deliveries: the preview\'s design and boxes are what the run writes to: the layout the new slide is put on, not a restyled slide of the deck; copy mode, the picked slide\'s styles in its layout\'s boxes (SD-5)', () => {
    // the deck's first title-and-body slide (Agenda) restyled by hand: the pulse slide lands on the layout, not on it
    const spec = deckSpec();
    Object.assign(spec.slides[1], { titleStyle: { fontSize: 20 }, bodyStyle: { fontFamily: 'Roboto', fontSize: 12, color: '#1a73e8' } });
    const w = world({ decks: [spec] });
    const p = preview(w, settings(w));
    const d = save(w, settings(w));
    assert.ok(runNow(w, d.id).ok);
    const [pulse] = w.pulses();
    const body = w.slides.styleAt(pulse, 'BODY', 0);
    const title = w.slides.styleAt(pulse, 'TITLE', 0);
    eq([p.design.font, p.design.bodySize, p.design.bodyColor, p.design.titleSize], [body.fontFamily, body.fontSize, body.color, title.fontSize]);
    eq([p.design.font, p.design.bodySize, p.design.bodyColor, p.design.titleSize, p.design.from], ['Arial', 18, '#000000', 28, 'the deck\'s title-and-body layout']);
    // copy mode: a picked slide whose body box a person made smaller: the run's slide gets its layout's box, so does the preview
    const w2 = world();
    const picked = w2.slides.slideIds(DECK)[2];
    w2.slides.deck(DECK).slides[2].shapes.find(x => x.placeholderType === 'BODY').box = { x: 31.1, y: 90.8, w: 657.9, h: 140 };
    const s2 = settings(w2, { countOwn: true, design: { mode: 'copy', slideId: picked } });
    const p2 = preview(w2, s2);
    eq(p2.design.box.body.h, 269.1);
    const d2 = save(w2, s2);
    assert.ok(runNow(w2, d2.id).ok);
    const [pulse2] = w2.pulses();
    const landed = w2.slides.deck(DECK).slides.find(x => x.id === pulse2).shapes.find(x => x.placeholderType === 'BODY');
    eq([landed.box.h, landed.styles[0].fontSize], [p2.design.box.body.h, p2.slides[0].fit.bodyPt]);
  });

  test('slide deliveries: a copied design on a layout with no title box is refused (at save, and at a run, which puts nothing in the deck), and the deck check marks such slides, so replace mode never piles up slides it can\'t find again (SD-7)', () => {
    const spec = deckSpec();
    spec.slides.splice(2, 0, { layout: 'BLANK' });
    const w = world({ decks: [spec] });
    const ids = w.slides.slideIds(DECK);
    w.as(VIEWER);
    const check = w.b.dashDeckCheck(DECK);
    eq(check.slides.map(x => [x.layoutName, x.titled]), [['TITLE', true], ['TITLE_AND_BODY', true], ['BLANK', false], ['TITLE_AND_BODY', true], ['SECTION_HEADER', true]]);
    const blank = settings(w, { design: { mode: 'copy', slideId: ids[2] } });
    const refused = w.b.dashSaveDelivery(blank);
    eq([refused.ok, refused.why], [false, w.b.ev('SLIDE_NO_TITLE_WHY_')]);
    // a delivery saved before (its picked slide since put on a layout with no title box): each run refuses, the deck is untouched
    const d = save(w, settings(w, { design: { mode: 'copy', slideId: ids[1] } }));
    const row = w.row(d.id);
    w.b.slideWrite_(w.tab(), d.id, { settings: Object.assign({}, row.settings, { design: { mode: 'copy', slideId: ids[2] } }) });
    const before = w.slides.snapshot(DECK);
    for (let i = 0; i < 3; i++) {
      w.t.g.clock.now += DAY;
      const r = runNow(w, d.id);
      eq(r.ok, false);
      assert.match(r.why, /on a layout with no title box/);
    }
    eq(w.slides.snapshot(DECK), before);
  });

  test('slide deliveries: posts known only by their key get links that open: X\'s own form for an X post, a key that is a full permalink as it is; any other key is described, never cited (SD-8)', () => {
    const b = H.B;
    eq(b.slideKeyLink_('x.com/status/2160000000000000801'), 'https://x.com/i/status/2160000000000000801');
    eq(b.slideKeyLink_('reddit.com/r/pixel/comments/1ph2/battery'), 'https://reddit.com/r/pixel/comments/1ph2/battery');
    eq(b.slideKeyLink_('youtube.com/watch?v=abcdef123'), 'https://youtube.com/watch?v=abcdef123');
    eq([b.slideKeyLink_('example.com/some/page'), b.slideKeyLink_('facebook.com/permalink.php'), b.slideKeyLink_('')], ['', '', '']);
    const card = logRow({ alert_id: 'QA-50', created_at: T0, ingested: b.ev('ED_ALERT_INGESTED_'), record_key: 'x.com/status/2160000000000000801',
      forwarded_fields: { issue_name: 'Pixel battery swelling', post_url: 'https://x.com/a/status/2160000000000000801', early_detection: {
        post_keys: ['x.com/status/2160000000000000801', 'x.com/status/2160000000000000802', 'example.com/thread/9'] } } });
    const issue = one([card], null, true).issues[0];
    const posts = b.slidePosts_(issue, true);
    eq(posts.citable.map(p => p.url), ['https://x.com/a/status/2160000000000000801', 'https://x.com/i/status/2160000000000000802']);
    eq(posts.context.length, 1);
  });

  test('slide deliveries: the person setting up a delivery needs to be able to open the deck, not edit it (the bot\'s account writes to it); a shared drive\'s member is seen through Drive\'s own permission list (SD-9)', () => {
    const w = world({ decks: [deckSpec({ sharedDrive: true, editors: [] })] });
    w.as(VIEWER);
    assert.match(w.b.dashSaveDelivery(settings(w)).why, /^You can't open this deck yourself/);
    const perms = `https://www.googleapis.com/drive/v3/files/${DECK}/permissions?supportsAllDrives=true&pageSize=100&fields=${encodeURIComponent('permissions(type,role,emailAddress,domain)')}`;
    w.t.g.pages.set(perms, { code: 200, body: JSON.stringify({ permissions: [{ type: 'user', role: 'reader', emailAddress: VIEWER }] }) });
    const check = w.b.dashDeckCheck(DECK);
    eq([check.ok, check.youCanView, check.youCanEdit, check.slides.length], [true, true, false, 4]);
    const saved = w.b.dashSaveDelivery(settings(w));
    assert.ok(saved.ok, saved.why);
  });

  test('slide deliveries: the deck check shows a deck\'s title and slides only to someone who may set up deliveries and can open the deck: a reader of the bot\'s sheet, or an editor the deck is not shared with, gets why and nothing of the deck (SEC-1)', () => {
    const secret = { id: DECK2, name: 'Board only: 2027 plan', editors: ['owner@board.test'], slides: [
      { layout: 'TITLE_AND_BODY', title: 'Confidential: layoffs in Q1', body: 'Teams A and B are cut by 30 percent' }] };
    const w = world({ decks: [deckSpec(), secret] });
    const link = `https://docs.google.com/presentation/d/${DECK2}/edit`;
    const leaks = r => /Board only|Confidential|layoffs|30 percent/.test(JSON.stringify(r));
    w.as(READER);
    const reader = w.b.dashDeckCheck(link);
    eq([reader.ok, leaks(reader)], [false, false]);
    assert.match(reader.why, /^Setting up, running and pausing deliveries is for the people who can edit the bot's sheet/);
    w.as(VIEWER);
    const editor = w.b.dashDeckCheck(link);
    eq([editor.ok, leaks(editor), editor.slides], [false, false, []]);
    assert.match(editor.why, /^You can't open this deck yourself/);
    // the preview reads the deck's design: the same rule
    w.fresh();
    eq(w.b.dashPreview(settings(w, { deck: { url: link } })).why, editor.why);
    // shared with them (Viewer is enough): its slides, to pick the spot
    w.slides.deck(DECK2).viewers = [VIEWER];
    w.slides.share(w.t.g, w.slides.deck(DECK2));
    const shared = w.b.dashDeckCheck(link);
    eq([shared.ok, shared.deck.title, shared.slides.map(x => x.title)], [true, 'Board only: 2027 plan', ['Confidential: layoffs in Q1']]);
  });

  test('slide deliveries: a preview is for the people who may set up deliveries, and a few built afresh per viewer every 10 minutes: a reader makes no Gemini call, and past the limit the viewer is told when to try again (one already built shows again at once) (SEC-2)', () => {
    const w = world();
    w.fresh();
    w.as(READER);
    const reader = w.b.dashPreview(settings(w, { lookbackHours: 25 }));
    eq([reader.ok, w.summaries.length], [false, 0]);
    assert.match(reader.why, /^Setting up, running and pausing deliveries is for the people who can edit the bot's sheet/);
    w.as(VIEWER);
    const max = w.b.ev('SLIDE_PREVIEW_MAX_');
    for (let h = 25; h < 25 + max; h++) assert.ok(w.b.dashPreview(settings(w, { lookbackHours: h })).ok, String(h));
    const calls = w.summaries.length;
    const over = w.b.dashPreview(settings(w, { lookbackHours: 25 + max }));
    eq([over.ok, w.summaries.length], [false, calls]);
    assert.match(over.why, new RegExp(`^You have built ${max} new previews in the last 10 minutes .*: try again at \\d{1,2}:\\d\\d (AM|PM) ET\\. A preview you already built shows again at once\\.$`));
    assert.ok(w.b.dashPreview(settings(w, { lookbackHours: 25 })).ok);  // built already: no Gemini call, no count
    eq(w.summaries.length, calls);
    w.t.g.clock.now += 10 * MIN;
    Array.from(w.t.g.cache.keys()).filter(k => k.startsWith('dash1:pv:')).forEach(k => w.t.g.cache.delete(k));  // the cache's 10 minutes are up
    assert.ok(w.b.dashPreview(settings(w, { lookbackHours: 25 + max })).ok);
  });

  test('slide deliveries: when the times between runs differ (two days a week, the weekend only, a clock change), "Match" makes each slide cover the time since the run before, which leaves no gap and no overlap (SD-10)', () => {
    const w = world();
    const b = w.b;
    const now = Date.UTC(2026, 9, 26, 12, 0);  // a Monday; the clocks go back on Sunday Nov 1
    const sched = (days, extra) => Object.assign({ days, time: '09:00', tz: 'America/New_York', mondayCoversWeekend: false }, extra || {});
    [[2, 5], [0, 6], [0, 1, 2, 3, 4, 5, 6]].forEach(days => {
      const cov = b.slideCoverage_({ schedule: sched(days), lookbackHours: 24 }, now);
      eq([cov.ok, cov.match.sincePrevious], [false, true], JSON.stringify(days));
      assert.match(cov.match.text, /each slide covers the time since the scheduled run before it/);
      const fixed = b.slideCoverage_({ schedule: sched(days, { sincePrevious: true }), lookbackHours: cov.match.lookbackHours }, now);
      eq([fixed.ok, fixed.gapText, fixed.overlapText], [true, [], []], JSON.stringify(days));
    });
    // Friday's slide covers the time since Tuesday's run
    const friday = Date.UTC(2026, 9, 30, 13, 0);
    const win = b.slideWindow_({ schedule: sched([2, 5], { sincePrevious: true }), lookbackHours: 72 }, friday);
    eq([win.start, win.end], [Date.UTC(2026, 9, 27, 13, 0), friday]);
    // a weekday schedule with no clock change in the next 14 days keeps its Match (24 hours, Monday covers the weekend)
    const weekdays = b.slideCoverage_({ schedule: sched([1, 2, 3, 4, 5]), lookbackHours: 24 }, Date.UTC(2026, 10, 9, 12, 0));
    eq([weekdays.match.lookbackHours, weekdays.match.mondayCoversWeekend, weekdays.match.sincePrevious], [24, true, false]);
    // the web app's check says when the settings match
    w.as(VIEWER);
    const ck = b.dashScheduleCheck({ schedule: sched([2, 5], { sincePrevious: true }), lookbackHours: 72 });
    eq([ck.ok, ck.matched, ck.coverage.ok], [true, true, true]);
    assert.match(b.slideScheduleText_(sched([2, 5], { sincePrevious: true })), /each covering the time since the run before$/);
  });

  test('slide deliveries: when Gemini gives no answer (busy, a 503), a scheduled run waits and tries again (its next run is not moved, nothing is recorded as failed), and says so in its own words (SD-11)', () => {
    const w = world();
    const d = save(w, settings(w, { schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '08:00', tz: 'America/New_York', mondayCoversWeekend: false } }));
    const due = w.row(d.id).next_run;
    const v = w.t.g.vertex;
    const orig = v.handle;
    let down = true;
    v.handle = (url, params) => {
      const props = ((JSON.parse(params.payload).generationConfig || {}).responseSchema || {}).properties || {};
      if (down && props.segments) return { code: 503, body: { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } } };
      return orig(url, params);
    };
    w.t.g.clock.now = due + 3 * MIN;
    w.as('');
    const r = w.b.dashDeliverDue();
    eq(r.ran.map(x => x.ok), [false]);
    assert.match(r.ran[0].why, /^Gemini gave no answer for the summary of "Criticism against AI Overviews" just now .*: the delivery tries again in a few minutes\.$/);
    eq([w.row(d.id).next_run, w.row(d.id).last_run, w.pulses().length], [due, null, 0]);
    down = false;
    w.t.g.clock.now += 5 * MIN;
    eq(w.b.dashDeliverDue().ran.map(x => x.ok), [true]);
    eq(w.pulses().length, 1);
  });

  test('slide deliveries: the summary checks refuse a bare host name, Markdown marks and a ref written out, and a ref\'s digits are not a number of the facts (SD-12); a partly kept engagement says on how many alerts it was counted (SD-13); segments starting with a curly quote or an accented letter are spaced (SD-14)', () => {
    const b = H.B;
    const facts = JSON.stringify({ numbers: { alerts: 2, accounts: 2 }, posts: [{ ref: 'P1' }] });
    ['posts on x.com show swelling', 'a thread on reddit.com shows swelling', 'see support.google.com for the fix'].forEach(t =>
      eq(b.slideSummaryProblem_({ segments: [{ text: t, ref: 'P1' }] }, ['P1'], facts), 'its text held a web address (links are added from the refs, never written)', t));
    ['**phones swelled**', '[phones swelled](P1)', 'owners say *phones swelled* now'].forEach(t =>
      eq(b.slideSummaryProblem_({ segments: [{ text: t, ref: 'P1' }] }, ['P1'], facts), 'its text held Markdown marks (write plain sentences)', t));
    eq(b.slideSummaryProblem_({ segments: [{ text: 'phones swelled (P1)', ref: 'P1' }] }, ['P1'], facts), 'its text wrote a ref out (a ref goes in a segment\'s ref, never in its words)');
    eq(b.slideSummaryProblem_({ segments: [{ text: '1 owner says it swelled', ref: 'P1' }] }, ['P1'], facts), 'it wrote 1, which is not among the facts');
    eq(b.slideSummaryProblem_({ segments: [{ text: '2 owners say it swelled.', ref: 'P1' }] }, ['P1'], facts), '');
    eq(b.slideSummaryProblem_({ segments: [{ text: 'Owners of the Pixel 10 say it swelled.', ref: 'P1' }] }, ['P1'], JSON.stringify({ numbers: { alerts: 10 } })), '');
    // SD-13
    const rows = [1200, null, null].map((e, i) => ({ authors: [`a${i}`], platforms: ['x'], engagement: e }));
    eq(b.slideNumbers_({ rows }, 1).text, '3 alerts · 3 accounts · 1 platform (X) · 1,200 engagements (counted on 1 of 3 alerts) · up from 1 in the window before');
    eq(b.slideSummaryFacts_({ name: 'x', burson: true }, b.slideNumbers_({ rows }, 1), { citable: [], context: [] }).numbers.engagement_counted_on, '1 of 3 alerts');
    eq(b.slideNumbers_({ rows: rows.slice(0, 1) }, 1).text.split(' · ')[3], '1,200 engagements');
    // SD-14
    eq(b.slideSummaryJoin_([{ text: 'Owners say', ref: '' }, { text: '“it swelled”', ref: 'P1' }, { text: 'Él lo dice', ref: '' }]).text,
      'Owners say “it swelled” Él lo dice');
  });

  test('slide deliveries: in replace mode, a spot changed in the web app moves the delivery\'s slide there at the next run (the old one comes out); the list shows where it now goes (SD-15)', () => {
    const w = world();
    const d = save(w, settings(w));
    assert.ok(runNow(w, d.id).ok);
    const ids = w.slides.slideIds(DECK);
    const titleOf = id => w.slides.textOf(id).split('\n\n')[0];
    eq(ids.map(titleOf), ['Weekly brand review', 'Agenda', 'Brand safety pulse', 'Wins this week', 'Thank you']);
    const moved = save(w, Object.assign(settings(w), { id: d.id, spot: { afterId: ids[3], beforeId: ids[4], afterLabel: 'Wins this week', beforeLabel: 'Thank you' } }));
    eq(moved.where, 'After "Wins this week"');
    w.t.g.clock.now += DAY;
    assert.ok(runNow(w, d.id).ok);
    eq(w.slides.slideIds(DECK).map(titleOf), ['Weekly brand review', 'Agenda', 'Wins this week', 'Brand safety pulse', 'Thank you']);
    // and the next run replaces it where it now stands (wherever someone moves it)
    w.slides.move(DECK, w.pulses()[0], 0);
    w.t.g.clock.now += DAY;
    assert.ok(runNow(w, d.id).ok);
    eq(w.slides.slideIds(DECK).map(titleOf)[0], 'Brand safety pulse');
  });

  test('slide deliveries: with the bot paused (Control B2 OFF) nothing is delivered: the time trigger, Run now and Preview all say why; no slide, no Gemini call, no email; C55 says so while it is paused, and the list too (F2)', () => {
    const w = world();
    const d = save(w, settings(w, { schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '08:00', tz: 'America/New_York', mondayCoversWeekend: false } }));
    const sent = w.t.g.gmail.sentMessages().length;
    w.t.control().getRange(2, 2).setValue('OFF');
    w.as('');  // the bot's own run
    w.t.poll();
    eq(w.t.control().cell(55, 3), w.b.ev('SLIDE_PAUSED_ON_TEXT_'));
    w.t.g.clock.now = w.row(d.id).next_run + 3 * MIN;
    w.as('');
    eq(w.b.dashDeliverDue(), { done: false, why: w.b.ev('SLIDE_PAUSED_WHY_'), ran: [] });
    w.fresh();
    w.as(VIEWER);
    eq([runNow(w, d.id).why, w.b.dashPreview(settings(w)).why], [w.b.ev('SLIDE_PAUSED_WHY_'), w.b.ev('SLIDE_PAUSED_WHY_')]);
    const list = w.b.dashDeliveries();
    eq([list.paused, list.pausedWhy], [true, w.b.ev('SLIDE_PAUSED_WHY_')]);
    eq([w.pulses().length, w.summaries.length, w.t.g.gmail.sentMessages().length - sent], [0, 0, 0]);
    // ON again: delivered at the next pass, and C55 says it delivers
    w.t.control().getRange(2, 2).setValue('ON');
    w.as('');
    w.t.poll();
    assert.match(w.t.control().cell(55, 3), /^✓ ON: delivers/);
    w.as('');
    eq(w.b.dashDeliverDue().ran.map(x => x.ok), [true]);
  });
};
