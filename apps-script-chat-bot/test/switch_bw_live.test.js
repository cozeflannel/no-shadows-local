// Brandwatch read live for Early Detection (BrandwatchLive.gs, the plan's step 2a): the reader alone, through its entry
// point bwLiveRun_, against the fake of test/fake_brandwatch.js. Row 49 does not exist yet (step 2b adds it), so the
// tests hand the run's switches in directly. Every mention, author, link and query is made up.
'use strict';

const { installBrandwatch, bwMention } = require('./fake_brandwatch.js');

module.exports = H => {
  const { test, eq, assert, e2e } = H;
  const MIN = 60 * 1000;
  const ON = { edBwLive: true, earlyWave: true };
  const ADDRESS = 'owner.one@example.test';

  /** A world after setup() with the fake installed; `w.run()` is one run's call (the clock moves to `at` first). */
  function world(o) {
    const t = e2e();
    t.bot.setup();
    const bw = installBrandwatch(t.g, o);
    const w = { t, bw, bot: t.bot };
    w.now = () => t.g.clock.now;
    w.run = (sw, at) => {
      if (at) t.g.clock.now = at;
      return t.bot.bwLiveRun_(t.g.clock.now, sw || ON);
    };
    w.tab = () => t.sheet().getSheetByName('New sources');
    w.state = () => JSON.parse(t.g.props.get('BWL_STATE') || 'null');
    w.day = () => JSON.parse(t.g.props.get('BWL_DAY') || 'null');
    w.mentionCalls = () => bw.calls.filter(c => c.path === '/projects/1998344909/data/mentions');
    // ticks Read = ON for the queries with these ids (the rows the bot wrote), as the owner would
    w.tick = ids => {
      const sh = w.tab();
      for (let r = 9; r <= sh.getLastRow(); r++) {
        const id = String(sh.cell(r, 8) || '').replace(/^'/, '');
        if (ids.map(String).indexOf(id) >= 0) sh.getRange(r, 1).setValue('ON');
      }
    };
    w.ready = ids => { w.run(); w.tick(ids || [2005000001]); };
    return w;
  }
  const at = ms => new Date(ms);
  const seq = (n, from, step, o) => Array.from({ length: n }, (_, i) => bwMention(i + 1, from + i * step, o));

  // -----------------------------------------------------------------------------------------------------------------
  // Off, ticks, the request
  // -----------------------------------------------------------------------------------------------------------------

  test('bw live: with row 49 OFF (or row 19 OFF) a run of bwLiveRun_ reads and writes nothing: no Secret Manager read, no Brandwatch call, no property, no cache item, no tab', () => {
    const w = world();
    const props = Array.from(w.t.g.props.keys()).sort();
    const cache = Array.from(w.t.g.cache.keys()).sort();
    [{}, { edBwLive: true }, { earlyWave: true }, { edBwLive: 'true', earlyWave: true }, null].forEach(sw => eq(w.t.bot.bwLiveRun_(w.now(), sw).why, 'off'));
    eq(w.bw.calls, []);
    eq([Array.from(w.t.g.props.keys()).sort(), Array.from(w.t.g.cache.keys()).sort(), !!w.tab()], [props, cache, false]);
  });

  test('bw live: the first run lists the project\'s queries on the New sources tab, all Read = OFF with an ON / OFF list, and reads nothing until one is ticked; a tick is kept across runs and OFF / ON; the 21st ticked query is left out and said', () => {
    const queries = Array.from({ length: 23 }, (_, i) => ({ id: 2005100000 + i, name: i === 0 ? 'Google Pixel complaints' : `Query ${i}`, contentSources: ['reddit'], languages: ['en'], lastModifiedUsername: ADDRESS }));
    const w = world({ queries });
    const r = w.run();
    eq([r.read, r.why], [false, 'no query ticked']);
    eq(w.mentionCalls().length, 0);
    const sh = w.tab();
    eq([sh.cell(7, 1), sh.cell(8, 1), sh.cell(8, 8), sh.cell(9, 1), sh.cell(9, 2), sh.cell(9, 5), String(sh.cell(9, 8)).replace(/^'/, '')],
      [w.t.bot.ev('NSRC_QUERY_TITLE_'), 'Read', 'Query id', 'OFF', 'Google Pixel complaints', 'yes', '2005100000']);
    eq(sh.validations['9,1'] && sh.validations['9,1'].values, ['ON', 'OFF']);
    eq(w.t.bot.bwlNote_({ st: w.state(), now: w.now() }), 'waiting: tick Read = ON for at least one query on the New sources tab');
    w.tick(queries.map(q => q.id));
    w.bw.mentions = seq(3, w.now() - 10 * MIN, MIN, { queryId: 2005100000 });
    w.run(null, w.now() + 11 * MIN);
    const call = w.mentionCalls()[0];
    eq(call.params.queryId.length, 20);
    eq(call.params.queryId, queries.slice(0, 20).map(q => String(q.id)));
    eq(w.state().tk, { n: 20, of: 23 });
    assert.match(w.t.bot.bwlNote_({ st: w.state(), day: w.day(), now: w.now() }), /20 of 23 ticked queries read \(at most 20\)/);
    // ticks survive a rewrite of the tab and turning the row OFF and ON
    w.t.bot.bwLiveOff_();
    w.run(null, w.now() + 11 * MIN);
    eq(sh.cell(9, 1), 'ON');
    eq(w.mentionCalls().length, 2);
  });

  test('bw live: the request has every parameter of the plan (queries repeated, posted in 72 hours, added since, oldest added first, one page, each source, English, reposts out, new mentions only), GET with the token in a header, never twitter or linkedin', () => {
    const w = world();
    const url = w.t.bot.bwlRequestUrl_({ project: 1998344909, queries: [1, 2], start: Date.UTC(2026, 10, 14), end: Date.UTC(2026, 10, 17, 0, 5),
      since: Date.UTC(2026, 10, 16, 23, 55), pageSize: 300, page: 0, sources: ['reddit', 'twitter', 'X', 'linkedin_company', 'bluesky'], sourceTypeNew: true });
    eq(url, 'https://api.brandwatch.com/projects/1998344909/data/mentions?queryId=1&queryId=2&startDate=2026-11-14T00%3A00%3A00.000Z' +
      '&endDate=2026-11-17T00%3A05%3A00.000Z&sinceAdded=2026-11-16T23%3A55%3A00.000Z&orderBy=added&orderDirection=asc&pageSize=300&page=0' +
      '&pageType=reddit&pageType=bluesky&language=en&xthreadEntryType=share&sourceType=new');
    eq(w.t.bot.bwlSources_(['reddit', 'twitter', 'x', 'linkedin', 'linkedin_page', 'instagram_public', 'forum'], ['reddit', 'instagram_public', 'twitter', 'linkedin']),
      ['reddit', 'instagram_public']);
    eq(w.t.bot.bwlSources_(['reddit', 'twitter', 'bluesky'], null), ['reddit', 'bluesky']);
    w.ready();
    w.bw.mentions = seq(2, w.now() - 5 * MIN, MIN);
    w.run(null, w.now() + 11 * MIN);
    const bwCalls = w.bw.calls.filter(c => c.host === 'brandwatch');
    assert.ok(bwCalls.length >= 3);
    bwCalls.forEach(c => { eq([c.method, c.payload], ['get', undefined]); eq(c.headers.Authorization, 'bearer bw-shared-token-0f1e2d3c4b5a'); });
    const p = w.mentionCalls()[0].params;
    eq(p.pageType, ['reddit', 'bluesky', 'facebook_public', 'instagram_public', 'tiktok', 'youtube', 'threads', 'tumblr', 'forum']);
    eq([p.orderBy, p.orderDirection, p.language, p.xthreadEntryType, p.sourceType, p.pageSize], [['added'], ['asc'], ['en'], ['share'], ['new'], ['300']]);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // E17, E18: marks, overlap, the parcel
  // -----------------------------------------------------------------------------------------------------------------

  test('bw live (E17): three reads with overlapping answers hand each mention over once; the first read reaches 30 minutes back; each later read asks from `taken` less 5 minutes', () => {
    const w = world();
    w.ready();
    const t0 = w.now();
    w.bw.mentions = seq(40, t0 - 40 * MIN, MIN);
    const handed = [];
    const take = () => { const p = w.t.bot.bwlParcelTake_(); if (p) { p.rows.forEach(r => handed.push(r.mid)); w.t.bot.bwlParcelCollected_(undefined, w.now()); } };
    w.run(null, t0 + 11 * MIN); take();
    eq(Date.parse(w.mentionCalls()[0].params.sinceAdded[0]), t0 + 11 * MIN - 30 * MIN);
    w.bw.mentions = w.bw.mentions.concat(seq(5, t0 + 12 * MIN, MIN).map((m, i) => Object.assign(m, { resourceId: `late${i}`, url: `https://www.reddit.com/r/x/comments/late${i}/` })));
    w.run(null, t0 + 22 * MIN); take();
    const taken = w.state().taken;
    w.run(null, t0 + 33 * MIN); take();
    eq(Date.parse(w.mentionCalls()[2].params.sinceAdded[0]), taken - 5 * MIN);
    eq(handed.length, new Set(handed).size);
    eq(new Set(handed).size, 19 + 5);
  });

  test('bw live (E17, stall): 1,250 mentions added in the 5 minutes before the mark: the stall rule asks page 1, then once with no overlap, and the mark moves forward within two reads', () => {
    const w = world();
    w.ready();
    const t0 = w.now();
    const crowd = seq(1250, t0 - 5 * MIN, 240);
    w.bw.mentions = crowd;
    w.t.g.props.set('BWL_STATE', JSON.stringify({ taken: t0, read: t0, cl: [], ov: [] }));
    w.bw.mentions = crowd.concat(seq(3, t0 + 2 * MIN, MIN).map((m, i) => Object.assign(m, { resourceId: `new${i}`, url: `https://www.reddit.com/r/x/comments/new${i}/` })));
    w.run(null, t0 + 11 * MIN);
    eq(w.mentionCalls().map(c => c.params.page[0]), ['0', '1']);
    eq(w.state().no, 1);
    w.t.bot.bwlParcelCollected_(undefined, w.now());  // (the repeats it handed over are dropped by the check's post-key index)
    w.run(null, t0 + 22 * MIN);
    const third = w.mentionCalls()[2];
    eq(Date.parse(third.params.sinceAdded[0]), t0);
    const p = w.t.bot.bwlParcelTake_();
    assert.ok(p && p.rows.some(r => /new/.test(r.url)), 'the new mentions are handed over');
    w.t.bot.bwlParcelCollected_(undefined, w.now());
    assert.ok(w.state().taken > t0);
  });

  test('bw live (E18): taken moves only when the parcel\'s job is collected; a second read waits while a parcel waits; a parcel whose cache items are gone is read again from Brandwatch; a job failing twice drops the parcel, moves the mark past it and says how many were lost', () => {
    const w = world();
    w.ready();
    const t0 = w.now();
    w.bw.mentions = seq(6, t0 - 6 * MIN, MIN);
    w.run(null, t0 + 11 * MIN);
    const st = w.state();
    eq([st.taken, st.parcel.n, st.parcel.parts, st.read], [t0 + 11 * MIN - 30 * MIN, 6, 1, Date.parse(w.bw.mentions[5].added)]);
    eq(w.run(null, t0 + 22 * MIN).why, 'a parcel waits for its job');
    eq(w.mentionCalls().length, 1);
    // the cache item is gone before the check takes it: forgotten, and the next read asks for the same mentions again
    w.t.g.cache.delete('ews:bwl:p:0');
    eq(w.t.bot.bwlParcelTake_(), null);
    eq(w.state().parcel, null);
    w.run(null, t0 + 33 * MIN);
    eq(w.state().parcel.n, 6);
    // collected: taken = the parcel's `to`
    eq(w.t.bot.bwlParcelTake_().rows.length, 6);
    w.t.bot.bwlParcelCollected_(undefined, w.now());
    eq([w.state().taken, w.state().parcel, w.day().used], [Date.parse(w.bw.mentions[5].added), null, 6]);
    eq(w.t.g.cache.has('ews:bwl:p:0'), false);
    // a job failing twice
    w.bw.mentions = w.bw.mentions.concat(seq(4, t0 + 40 * MIN, MIN).map((m, i) => Object.assign(m, { resourceId: `f${i}`, url: `https://www.reddit.com/r/x/comments/f${i}/` })));
    w.run(null, t0 + 50 * MIN);
    eq(w.t.bot.bwlParcelFailed_(undefined, 'HTTP 500: backend error', w.now()), 'retry');
    eq(w.state().parcel.fails, 1);
    eq(w.t.bot.bwlParcelFailed_(undefined, 'HTTP 500: backend error', w.now()), 'dropped');
    eq([w.state().parcel, w.state().taken, w.day().lost], [null, Date.parse(w.bw.mentions[9].added), 4]);
    assert.match(w.t.bot.bwlNote_({ st: w.state(), day: w.day(), now: w.now() }), /^⚠️ 4 Brandwatch mentions were lost at .*: their BigQuery job failed twice/);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // E19: what stops the source
  // -----------------------------------------------------------------------------------------------------------------

  test('bw live (E19): Brandwatch ignoring "added since" or the order stops the source with the plan\'s words and moves no mark; one X mention stops it and the marks move past it; nothing more is read until the row is turned OFF and ON', () => {
    const cases = [
      ['since', w => { w.bw.ignore.sinceAdded = true; w.bw.mentions = seq(3, w.now() - 6 * 60 * MIN, MIN).concat(seq(2, w.now() - 2 * MIN, MIN)); },
        /^⚠️ stopped: Brandwatch ignored "added since" \(it sent older mentions\)\. Nothing more is read until this row is turned OFF and ON again(?: · .*)?$/],
      ['order', w => { w.bw.ignore.order = true; w.bw.mentions = seq(4, w.now() - 8 * MIN, MIN); },
        /^⚠️ stopped: Brandwatch ignored the order asked for/],
      ['x', w => { w.bw.ignore.pageType = true; w.bw.mentions = seq(3, w.now() - 8 * MIN, MIN).concat([bwMention(9, w.now() - 2 * MIN, { pageType: 'twitter' })]); },
        /^⚠️ stopped: Brandwatch sent 1 X post although the bot asked for none\. Nothing more is read until this row is turned OFF and ON again(?: · .*)?$/],
    ];
    cases.forEach(([kind, make, words]) => {
      const w = world();
      w.ready();
      w.t.g.clock.now += 11 * MIN;
      make(w);
      w.run();
      const st = w.state();
      eq(st.stop.kind, kind);
      const note = w.t.bot.bwlNote_({ st, day: w.day(), now: w.now() });
      assert.match(note, words);
      assert.ok(note.length <= 200);
      if (kind === 'x') {
        eq(st.read, Date.parse(w.bw.mentions[3].added));
        eq(w.t.bot.bwlParcelTake_().rows.length, 3, 'the other mentions are handed over');
        w.t.bot.bwlParcelCollected_(undefined, w.now());
        eq(w.state().taken, st.read);
      } else {
        eq([st.taken, st.parcel], [w.now() - 30 * MIN, undefined]);
      }
      const n = w.mentionCalls().length;
      w.run(null, w.now() + 60 * MIN);
      eq(w.mentionCalls().length, n);
      w.t.bot.bwLiveOff_();
      w.bw.ignore = {};
      w.run(null, w.now() + 11 * MIN);
      eq(w.mentionCalls().length, n + 1);
    });
  });

  // -----------------------------------------------------------------------------------------------------------------
  // E20, E21, E22: refusals, the shared login, the ledger
  // -----------------------------------------------------------------------------------------------------------------

  test('bw live (E20): 401 (hourly after three in a row), 403 with an address in its words (no address kept or shown), 429 (10 minutes), 500, a thrown fetch and a slow answer: the note\'s words, no mark moved, and the next read as the plan says', () => {
    const run = (setup, check) => {
      const w = world();
      w.ready();
      w.bw.mentions = seq(3, w.now() - 5 * MIN, MIN);
      w.t.g.clock.now += 11 * MIN;
      setup(w);
      w.run();
      eq(w.state().parcel, undefined);
      assert.ok(!(w.state().taken > w.now() - 30 * MIN), 'no mark moved');
      check(w, w.state(), w.t.bot.bwlNote_({ st: w.state(), day: w.day(), now: w.now() }));
      return w;
    };
    run(w => { w.bw.fail = { code: 401, message: 'Invalid token' }; }, (w, st, note) => {
      eq([st.u401, st.pause], [1, undefined]);
      assert.match(note, /^⚠️ since .*: Brandwatch refuses the shared key \(HTTP 401: Invalid token\)\. It tries again at the next read(?: · .*)?$/);
      w.run(null, w.now() + 11 * MIN);
      w.run(null, w.now() + 11 * MIN);
      eq([w.state().u401, w.state().pause.kind, w.state().pause.until - w.now()], [3, 'key', 60 * MIN]);
      assert.match(w.t.bot.bwlNote_({ st: w.state(), now: w.now() }), /^⚠️ since .*: Brandwatch refuses the shared key\. The service that renews it may be down\. It tries again every hour(?: · .*)?$/);
      const n = w.mentionCalls().length;
      w.run(null, w.now() + 30 * MIN);
      eq(w.mentionCalls().length, n);
    });
    run(w => { w.bw.fail = { code: 403, message: `Forbidden for ${ADDRESS}: no access to project 1998344909` }; }, (w, st, note) => {
      eq(st.pause.kind, 'refused');
      assert.match(note, /^⚠️ since .*: Brandwatch refused the read \(HTTP 403: Forbidden for \[address\]: no access to project 1998344909\)\. It tries again in an hour(?: · .*)?$/);
      const everything = JSON.stringify(Array.from(w.t.g.props.values())) + JSON.stringify(Array.from(w.t.g.cache.values())) + JSON.stringify(w.t.g.logs);
      eq(everything.indexOf(ADDRESS), -1);
      eq(everything.indexOf('owner.one'), -1);
    });
    run(w => { w.bw.fail = { code: 429, message: 'Too many requests' }; }, (w, st, note) => {
      eq([st.pause.kind, st.pause.until - w.now()], ['429', 10 * MIN]);
      assert.match(note, /^⏸ until .*: Brandwatch said too many calls on the shared login \(other tools share it\)\. It reads on from where it stopped(?: · .*)?$/);
    });
    run(w => { w.bw.fail = { code: 500, message: 'backend error' }; }, (w, st, note) => {
      eq([st.fail.kind, st.pause], ['down', undefined]);
      assert.match(note, /^⚠️ since .*: Brandwatch could not answer \(HTTP 500: backend error\)\. It tries again at the next read(?: · .*)?$/);
      w.bw.fail = null;
      w.run(null, w.now() + 11 * MIN);
      eq([w.state().fail, w.state().parcel.n], [undefined, 3]);
    });
    run(w => { w.bw.throwNext = true; }, (w, st, note) => {
      assert.match(note, /^⚠️ since .*: Brandwatch could not be reached \(Address unavailable: https:\/\/api\.brandwatch\.com\)\. It tries again at the next read(?: · .*)?$/);
    });
    // a 10-second answer near the end of the run: no second page with less than 45 seconds left
    const w = world();
    w.ready();
    const t0 = w.now();
    w.t.g.props.set('BWL_STATE', JSON.stringify({ taken: t0, read: t0, cl: [], ov: [] }));
    w.bw.mentions = seq(300, t0 - 5 * MIN, 600);
    w.bw.slowMs = 10 * 1000;
    w.t.g.clock.now = t0 + 11 * MIN;
    w.t.bot.bwLiveRun_(w.now() - 4 * MIN + 10 * 1000, ON);
    eq(w.mentionCalls().map(c => c.params.page[0]), ['0']);
    w.t.bot.bwlParcelCollected_(undefined, w.now());
    w.t.g.clock.now += 11 * MIN;
    eq(w.t.bot.bwLiveRun_(w.now() - 4 * MIN - 10 * 1000, ON).why, 'too little of the run left');
  });

  test('bw live (E21): the shared login\'s count read in any letter case and either form: 460 of 600 pauses 10 minutes ("⏸ until …: … 460 of its 600 calls …"), a bare "600" too; with no header the tab says "unknown"', () => {
    [['X-Rate-Limit-Used', 'X-Rate-Limit', '600/10m'], ['x-rate-limit-used', 'x-rate-limit', '600'], ['X-RATE-LIMIT-USED', 'X-RATE-LIMIT', '600/10m']].forEach(([u, l, v]) => {
      const w = world();
      w.ready();
      w.bw.headers = { used: 460, limit: v, usedName: u, limitName: l };
      w.bw.mentions = seq(2, w.now() - 4 * MIN, MIN);
      w.run(null, w.now() + 11 * MIN);
      const st = w.state();
      eq([st.pause.kind, st.pause.used, st.pause.limit, st.pause.until - w.now()], ['login', 460, 600, 10 * MIN]);
      assert.match(w.t.bot.bwlNote_({ st, day: w.day(), now: w.now() }),
        /^⏸ until .*: Brandwatch's shared login has used 460 of its 600 calls in 10 minutes \(other tools share it\)\. It reads on from where it stopped(?: · .*)?$/);
      eq(w.run(null, w.now() + 5 * MIN).why, 'paused');
    });
    const w = world();
    w.bw.headers = null;
    w.ready();
    w.bw.mentions = seq(2, w.now() - 4 * MIN, MIN);
    w.run(null, w.now() + 11 * MIN);
    eq(w.state().login, null);
    assert.match(String(w.tab().cell(5, 9)), /shared login: unknown/);
  });

  test('bw live (E22): at most 20 of its own calls in any 10 minutes; no pacing and no day\'s ceiling: after 40,000 mentions in a day it still reads, and the note counts them with no "of 30,000"', () => {
    const w = world();
    w.ready();
    const st = w.state();
    st.cl = Array.from({ length: 20 }, (_, i) => Math.floor((w.now() - i * 20 * 1000) / 1000));
    w.t.g.props.set('BWL_STATE', JSON.stringify(st));
    w.bw.mentions = seq(2, w.now() - 4 * MIN, MIN);
    eq(w.t.bot.bwLiveRun_(w.now(), ON).why, 'too soon');
    w.t.g.clock.now += 10 * 1000;
    const s2 = w.state(); s2.last = 0; w.t.g.props.set('BWL_STATE', JSON.stringify(s2));
    eq(w.t.bot.bwLiveRun_(w.now(), ON).why, 'its own calls in 10 minutes');
    w.t.g.props.set('BWL_DAY', JSON.stringify({ day: w.t.bot.bwlEtDay_(w.now()), mentions: 40000, calls: 150, used: 9000 }));
    w.t.g.clock.now += 11 * MIN;
    eq(w.run().read, true);
    eq(w.day().mentions, 40002);
    const note = w.t.bot.bwlNote_({ st: w.state(), day: w.day(), now: w.now() });
    assert.match(note, /today: 40,002 mentions/);
    assert.doesNotMatch(note, /30,000|ceiling/);
    eq(typeof w.t.bot.ev('typeof GEN.settings.bw_live_mentions_per_day'), 'string');
    eq(w.t.bot.ev('typeof GEN.settings.bw_live_mentions_per_day'), 'undefined');
  });

  // -----------------------------------------------------------------------------------------------------------------
  // E23 and the day's counts
  // -----------------------------------------------------------------------------------------------------------------

  test('bw live (E23): the token is in no property, cache item, cell or log line; every Brandwatch call is a GET; no query owner\'s name is kept anywhere', () => {
    const w = world();
    w.ready([2005000001, 2005000002]);
    w.bw.mentions = seq(5, w.now() - 6 * MIN, MIN, { snippet: 'Google Gemini told me to email owner.one@example.test about my refund, weird' });
    w.run(null, w.now() + 11 * MIN);
    w.bw.fail = { code: 403, message: 'token bw-shared-token-0f1e2d3c4b5a refused' };
    w.t.bot.bwlParcelCollected_(undefined, w.now());
    w.run(null, w.now() + 11 * MIN);
    const sh = w.tab();
    const cells = [];
    for (let r = 1; r <= sh.getLastRow(); r++) for (let c = 1; c <= 10; c++) cells.push(String(sh.cell(r, c)));
    const everything = JSON.stringify(Array.from(w.t.g.props.values())) + JSON.stringify(Array.from(w.t.g.cache.values())) +
      JSON.stringify(w.t.g.logs) + cells.join('|');
    eq(everything.indexOf('bw-shared-token-0f1e2d3c4b5a'), -1);
    eq(everything.indexOf('owner.one'), -1);
    eq(everything.indexOf('lastModifiedUsername'), -1);
    w.bw.calls.filter(c => c.host === 'brandwatch').forEach(c => eq([c.method, c.payload], ['get', undefined]));
  });

  test('bw live: the day\'s counts (BWL_DAY, the Eastern day) survive bwLiveOff_(), which clears the marks, the parcel, the stops and the pauses; a new day starts from zero and keeps yesterday\'s sources to name one that gave nothing', () => {
    const w = world();
    w.ready();
    w.bw.mentions = seq(4, w.now() - 5 * MIN, MIN);
    w.run(null, w.now() + 11 * MIN);
    const before = w.day();
    eq([before.mentions, before.src.reddit, before.calls > 0], [4, 4, true]);
    w.t.bot.bwLiveOff_();
    eq([w.state(), w.t.g.cache.has('ews:bwl:p:0'), w.day()], [null, false, before]);
    w.t.g.clock.now += 26 * 60 * MIN;
    w.bw.mentions = seq(2, w.now() - 4 * MIN, MIN);
    w.run();
    eq([w.day().mentions, w.day().prev.reddit], [2, 4]);
    assert.match(String(w.tab().cell(5, 2)), /no mentions yesterday from Bluesky, Facebook, Instagram, TikTok, YouTube, Threads, Tumblr, forum$/);
  });

  test('bw live: after a pause a read reaches back at most 2 hours and the note says what was not read; no mention for 4 hours is said; most of one source without words is said; each note fits 200 characters with the warning first', () => {
    const w = world();
    w.ready();
    const t0 = w.now();
    w.t.g.props.set('BWL_STATE', JSON.stringify({ taken: t0 - 5 * 60 * MIN - 10 * MIN, read: t0 - 5 * 60 * MIN, cl: [], ov: [], last: t0 - 5 * 60 * MIN, lm: t0 - 5 * 60 * MIN }));
    w.bw.mentions = seq(3, t0 - 30 * MIN, MIN);
    w.run(null, t0 + MIN);
    eq(Date.parse(w.mentionCalls()[0].params.sinceAdded[0]), t0 + MIN - 120 * MIN);
    const note = w.t.bot.bwlNote_({ st: w.state(), day: w.day(), now: w.now() });
    assert.match(note, /^⚠️ 3 h 16 min were not read after a pause \(after 2 hours it starts from the last 2 hours\) · read .*: 3 new · today: 3 mentions/);
    const quiet = Object.assign(w.state(), { gap: null, lm: w.now() - 5 * 60 * MIN });
    assert.match(w.t.bot.bwlNote_({ st: quiet, day: w.day(), now: w.now() }), /^⚠️ no Brandwatch mentions for 5 h\. Check the queries ticked Read = ON on the New sources tab/);
    const day = Object.assign(w.day(), { src: { reddit: 30 }, nw: { reddit: 20 } });
    assert.match(w.t.bot.bwlNote_({ st: Object.assign(quiet, { lm: w.now() }), day, now: w.now() }), /^⚠️ most Reddit mentions came without their words today, so they can't be used/);
    // the longest of every warning still fits, its counts never cut a number
    const long = { st: { last: w.now(), lr: { at: w.now(), n: 999 }, fail: { kind: 'refused', why: 'x'.repeat(400), since: w.now() - 3 * 60 * MIN },
      pause: { kind: 'refused', until: w.now() + MIN, since: w.now() - 3 * 60 * MIN } }, day: Object.assign(w.day(), { mentions: 999999 }), now: w.now() };
    const n = w.t.bot.bwlNote_(long);
    assert.ok(n.length <= 200 && /^⚠️ since .*It tries again in an hour(?: · .*)?$/.test(n), n);
  });

  test('bw live: stored values stay inside their limits in their worst case: BWL_STATE with 300 overlap ids and a full ledger, BWL_DAY with 80 queries and every source, a parcel in at most 6 cache items of 90,000 characters (250 mentions with 1,500 characters of words fit; when 300 don\'t, the read hands over fewer and the rest come with the next read)', () => {
    const w = world();
    const B = w.t.bot;
    const st = { taken: 1794000000000, read: 1794000000000, first: 1794000000000, last: 1794000000000, lm: 1794000000000,
      parcel: { to: 1794000000000, n: 300, parts: 6, at: 1794000000000, fails: 1, q: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`20051000${i}`, 15])) },
      cl: Array.from({ length: 20 }, (_, i) => 1794000000 + i), ov: Array.from({ length: 300 }, (_, i) => `abcdef${String(i).padStart(6, '0')}`),
      no: 1, split: 20, u401: 2, pause: { until: 1794000000000, kind: 'refused', since: 1794000000000, used: 600, limit: 600 },
      stop: null, fail: { kind: 'refused', why: 'x'.repeat(160), since: 1794000000000 }, login: { used: 600, limit: 600, at: 1794000000000 },
      qd: '2026-11-17', md: '2026-11-17', srcs: Array.from({ length: 80 }, (_, i) => `source_name_${i}`.padEnd(40, 'x')),
      gap: { ms: 99999999, at: 1794000000000 }, lr: { at: 1794000000000, n: 600, x: 600, rep: 600, nw: 600, ms: 99999, calls: 20, kept: 300 },
      tk: { n: 20, of: 999 }, dropped: { n: 300, at: 1794000000000, why: 'x'.repeat(120) }, nsf: 1794000000000 };
    w.t.g.props.set('BWL_STATE', JSON.stringify(st));
    B.bwlSaveState_(B.PropertiesService.getScriptProperties(), B.bwlState_(B.PropertiesService.getScriptProperties()));
    assert.ok(w.t.g.props.get('BWL_STATE').length <= 8800, `BWL_STATE ${w.t.g.props.get('BWL_STATE').length}`);
    const day = { day: '2026-11-17', calls: 99999, mentions: 9999999, used: 9999999, x: 99999, rep: 999999, lost: 99999,
      nw: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`source_name_${i}`.padEnd(40, 'x'), 99999])),
      src: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`source_name_${i}`.padEnd(40, 'x'), 99999])),
      prev: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`source_name_${i}`.padEnd(40, 'x'), 99999])),
      dl: [99999, 99999, 99999, 99999, 99999], q: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`${2005100000 + i}`, [99999, 99999]])) };
    B.bwlSaveDay_(B.PropertiesService.getScriptProperties(), day);
    assert.ok((w.t.g.props.get('BWL_DAY') || '').length > 0 && w.t.g.props.get('BWL_DAY').length <= 8800, `BWL_DAY ${(w.t.g.props.get('BWL_DAY') || '').length}`);
    const rows = Array.from({ length: 250 }, (_, i) => B.bwlRow_(bwMention(i, 1794000000000 + i, { snippet: `Google "quoted" \\ ${'é'.repeat(10)} ` + 'w'.repeat(1600), url: `https://www.reddit.com/r/pixel/comments/a${i}/the_title_of_this_post_as_reddit_writes_it/` })));
    rows.forEach(r => assert.ok(r.raw.length <= 1500));
    const parts = B.bwlParcelSave_(rows);
    assert.ok(parts > 0 && parts <= 6, `parts ${parts}`);
    for (let i = 0; i < parts; i++) assert.ok(w.t.g.cache.get(`ews:bwl:p:${i}`).length <= 90000);
    // links as long as a row keeps (500 characters): 300 don't fit 6 items, so the read hands over fewer, `to` is the last
    // one handed over, and the next read starts from there (nothing lost)
    eq(B.bwlParcelSave_(Array.from({ length: 300 }, (_, i) => Object.assign({}, rows[i % 250], { url: 'u'.repeat(500) }))), -1);
    const v = world();
    v.ready();
    const t0 = v.now();
    v.bw.mentions = Array.from({ length: 300 }, (_, i) => bwMention(i, t0 - 15 * MIN + i * 1000, { snippet: 'Google ' + 'w'.repeat(1600),
      url: `https://www.reddit.com/r/pixel/comments/${'z'.repeat(470)}${String(i).padStart(4, '0')}/` }));
    v.run(null, t0 + 11 * MIN);
    const pc = v.state().parcel;
    assert.ok(pc.n < 300 && pc.n > 200 && pc.parts <= 6, JSON.stringify(pc));
    eq(pc.to, Date.parse(v.bw.mentions[pc.n - 1].added));
    v.t.bot.bwlParcelCollected_(undefined, v.now());
    v.run(null, v.now() + 11 * MIN);
    eq(Date.parse(v.mentionCalls()[1].params.sinceAdded[0]), pc.to - 5 * MIN);
  });
};
