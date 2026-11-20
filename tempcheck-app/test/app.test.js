'use strict';
// The temp check's arithmetic and wording, the concern level, the own-data numbers, the store and the server's door.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TEMPCHECK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tempcheck-test-'));  // never the real data folder
const tc = require('../lib/tempcheck');
const benchmark = require('../lib/benchmark');
const own = require('../lib/owndata');
const q = require('../lib/bwquery');
const store = require('../lib/store');
const service = require('../lib/service');
const xposts = require('../lib/xposts');
const gemini = require('../lib/gemini');
const bq = require('../lib/bigquery');
const bw = require('../lib/brandwatch');
const png = require('../lib/png');
const zlib = require('zlib');

const H = tc.HOUR;
const T0 = Date.UTC(2026, 10, 17, 16);  // 8am PT on 11/17/2026 (standard time)
const hours = counts => counts.map((n, i) => ({ at: T0 + i * H, n }));

// --- the numbers ------------------------------------------------------------------------------------------------

test('an issue starts at the first hour with 100+ mentions; else at the alert; else when the query was made', () => {
  const hs = hours([3, 40, 141, 900, 20]);
  assert.deepStrictEqual(tc.start(hs, { look: T0, created: T0 + 3 * H }), { at: T0 + 2 * H, why: 'spike' });
  const quiet = hours([3, 40, 60]);
  assert.deepStrictEqual(tc.start(quiet, { look: T0, alertAt: T0 + H + 5 * 60000, created: T0 + 2 * H }), { at: T0 + H, why: 'alert' });
  assert.deepStrictEqual(tc.start(quiet, { look: T0, created: T0 + 2 * H + 1 }), { at: T0 + 2 * H, why: 'query' });
  assert.deepStrictEqual(tc.start(quiet, { look: T0, created: T0 - H }), { at: T0, why: 'look' });
});

test('velocity: the last full hour against the peak; the hour still running is left out', () => {
  const hs = hours([100, 800, 400, 200, 999]);
  const v = tc.velocity(hs, T0, T0 + 4 * H + 60000);
  assert.strictEqual(v.peak.n, 800);
  assert.strictEqual(v.last.n, 200);
  assert.strictEqual(v.pct, -75);
  assert.strictEqual(tc.velocity(hours([796, 1]), T0, T0 + 2 * H).pct, -99);  // never -100 while anything came in
  assert.strictEqual(tc.velocity(hs, T0, T0 + 60000), null);
  assert.strictEqual(tc.templateVelocity(v, T0 + 4 * H), 'Velocity is -75% since the peak at 9am PT today.');
  assert.strictEqual(tc.templateVelocity(tc.velocity(hours([1, 5]), T0, T0 + 2 * H), T0 + 2 * H), 'Velocity is at its peak (5 mentions/hr).');
});

test('percents always add up to 100, and a few is "<1%", never "0%"', () => {
  [[1, 1, 1], [19657, 384, 177, 496], [5, 0, 0], [1, 999]].forEach(counts => assert.strictEqual(tc.pcts(counts).reduce((a, b) => a + b, 0), 100));
  assert.deepStrictEqual(tc.pcts([0, 0]), [0, 0]);
  assert.strictEqual(tc.pct(0, 3), '<1%');
  assert.strictEqual(tc.num(20714), '20,714');
  assert.deepStrictEqual([944, 18368, 1137140].map(tc.compact), ['944', '18.4K', '1.1M']);
});

test('times are written in PT, through daylight time', () => {
  assert.strictEqual(tc.clock(T0), '8am');
  assert.strictEqual(tc.clock(Date.UTC(2026, 6, 1, 16, 5)), '9:05am');   // July: PDT
  assert.strictEqual(tc.day(Date.UTC(2026, 10, 18, 7)), '11/17');        // 11pm PT the day before
  assert.strictEqual(tc.chartTick(T0), '(11/17) 8AM');
  assert.strictEqual(tc.fromLocal(2026, 11, 17, 8, 0, 'PT'), T0);
  assert.strictEqual(tc.fromLocal(2026, 7, 1, 9, 5, 'PT'), Date.UTC(2026, 6, 1, 16, 5));
});

test('Brandwatch\'s answers become plain numbers, named as the team names them', () => {
  const body = { results: [{ values: [{ id: '2026-11-17T16:00:00.000+0000', value: 141 }, { id: '2026-11-17T18:00:00.000+0000', value: 7 }] }] };
  assert.deepStrictEqual(tc.hourly(body, T0, T0 + 3 * H).map(h => h.n), [141, 0, 7]);
  const src = { results: [{ values: [{ id: 'twitter', value: 5 }, { id: 'instagram', value: 2 }, { id: 'instagram_public', value: 4 }, { id: 'qq', value: 0 }] }] };
  assert.deepStrictEqual(tc.sourceCounts(src), [{ label: 'Instagram', n: 6 }, { label: 'X', n: 5 }]);
  const types = { results: [{ values: [{ id: 'share', value: 9 }, { id: 'reply', value: 3 }, { id: 'post', value: 1 }, { id: 'other', value: 4 }] }] };
  assert.deepStrictEqual(tc.mentionTypeCounts(types).map(t => t.label), ['reposts', 'comments', 'original posts']);
});

test('an answer about several queries is read as one: their counts add up', () => {
  const hoursOf = { results: [{ id: 11, values: [{ id: '2026-11-17T16:00:00.000+0000', value: 3 }] },
    { id: 22, values: [{ id: '2026-11-17T16:00:00.000+0000', value: 4 }, { id: '2026-11-17T17:00:00.000+0000', value: 1 }] }] };
  assert.deepStrictEqual(tc.hourly(hoursOf, T0, T0 + 2 * H).map(h => h.n), [7, 1]);
  const sent = { results: [{ values: [{ id: 'negative', value: 2 }, { id: 'neutral', value: 5 }] }, { values: [{ id: 'negative', value: 1 }] }, { values: [] }] };
  assert.deepStrictEqual(tc.values(sent), { negative: 3, neutral: 5 });
  const src = { results: [{ values: [{ id: 'twitter', value: 5 }] }, { values: [{ id: 'twitter', value: 2 }, { id: 'news', value: 9 }] }] };
  assert.deepStrictEqual(tc.sourceCounts(src), [{ label: 'News', n: 9 }, { label: 'X', n: 7 }]);
});

test('Brandwatch is asked about one query or several, with a search inside them when there is one', () => {
  assert.strictEqual(bw.scope(2004194405), 'queryId=2004194405');
  assert.strictEqual(bw.scope([11, 22], ' "two months" AND gemini '), 'queryId=11&queryId=22&search=%22two%20months%22%20AND%20gemini');
  assert.throws(() => bw.scope([]), /no Brandwatch query to ask about/);
  assert.throws(() => bw.scope([0, 'x']), /no Brandwatch query to ask about/);
  assert.throws(() => bw.scope(1, 'a'.repeat(bw.SEARCH_MAX + 1)), /too long to send to Brandwatch as a search/);
});

test('an issue with no query of its own, counted in Brandwatch\'s standing queries, says where its count comes from', () => {
  const w = tc.writeup(sample({ query: null, bwUrl: '', standing: { queries: 27 }, level: { label: '', why: 'not ranked' } }));
  assert.strictEqual(w.text.split('\n')[1], 'BW source: Brandwatch\'s standing Google queries, searched for this issue (it has no query of its own yet)');
  assert.ok(w.text.includes('There have been 8,397 total mentions regarding Alleged Gmail Outage. Velocity is'));
  assert.ok(w.text.includes('Mention Types: Mentions are primarily reposts (68%)'));
  assert.ok(!w.html.includes('app.brandwatch.com'));
  assert.match(tc.writeup(sample({ query: null, bwUrl: '', standing: { queries: 27 }, total: 0 })).text, /BW source: Brandwatch's standing Google queries/);
});

test('an X mention comes without words; they are filled from X\'s embed data, else our alert rows', () => {
  const [p] = tc.mentions({ results: [{ pageType: 'twitter', guid: '123456789', snippet: 'hidden', engagementScore: 4, sentiment: 'negative' }] });
  assert.deepStrictEqual([p.x, p.id, p.text, p.url, p.negative], [true, '123456789', '', '', true]);
  assert.strictEqual(tc.postWithText(p, {}), null);
  const embed = tc.postWithText(p, { 123456789: { author: 'who', text: 'the words', url: 'https://x.com/who/status/123456789', likes: 10, replies: 2, from: 'X embed data' } });
  assert.deepStrictEqual([embed.text, embed.author, tc.postEngVal(embed)], ['the words', 'who', 12]);
  const rows = tc.postWithText(p, { 123456789: { author: '@who', text: 'the words', url: 'u', from: 'alert rows' } });
  assert.strictEqual(tc.postEngVal(rows), 4);  // no likes known: Brandwatch's own engagement number
  assert.strictEqual(tc.mentionAuthor({ author: 'instagram.com', domain: 'instagram.com', url: 'https://www.instagram.com/bbcnews/p/abc/' }), 'bbcnews');
});

test('finding the query: its id from a link, its name with or without [G EVENT] and the month tag', () => {
  assert.strictEqual(tc.queryId('https://app.brandwatch.com/project/1998344909/queries/2004194405'), 2004194405);
  assert.strictEqual(tc.queryId('2004194405'), 2004194405);
  assert.strictEqual(tc.queryId('gmail outage'), 0);
  const list = [{ id: 1, name: '[G EVENT] NOV26 Alleged Gmail Outage' }, { id: 2, name: '[G EVENT] OCT26 Gmail Phishing' }, { id: 3, name: 'Gmail always-on' }];
  assert.strictEqual(tc.matchQuery('alleged gmail outage', list).query.id, 1);
  assert.strictEqual(tc.matchQuery('gmail', list).choices.length, 2);
  assert.strictEqual(tc.issueName(' [G EVENT] NOV26 "NBC & NYT article on school ban"'), 'NBC & NYT article on school ban');
});

// --- the write-up -----------------------------------------------------------------------------------------------

function sample(over) {
  const hs = hours([141, 5439, 2000, 800, 14, 3]);
  const now = T0 + 5 * H + 20 * 60000;
  return Object.assign({
    basis: 'brandwatch', issue: 'Alleged Gmail Outage', query: { id: 1, name: '[G EVENT] NOV26 Alleged Gmail Outage' }, bwUrl: 'https://app.brandwatch.com/project/1/queries',
    now, start: { at: T0, why: 'spike' }, total: 8397, hours: hs, velocity: tc.velocity(hs, T0, now),
    // sources arrive most first (tc.sourceCounts and owndata's ranked both sort them)
    sentiment: { positive: 9, neutral: 73, negative: 18 }, sources: [{ label: 'X', n: 95 }, { label: 'News', n: 2 }, { label: 'Blogs', n: 2 }, { label: 'Reddit', n: 1 }],
    mentionTypes: [{ label: 'reposts', n: 68 }, { label: 'comments', n: 26 }, { label: 'original posts', n: 6 }], engSources: [{ label: 'X', n: 94 }, { label: 'Instagram', n: 6 }],
    posts: [{ key: 'a', x: true, source: 'X', author: 'someone', text: 'Is <b>Gmail</b> down? <script>alert(1)</script>', url: 'https://x.com/someone/status/9', likes: 1200, replies: 50 },
      { key: 'b', x: false, source: 'Instagram', author: '', text: 'no author here', url: 'javascript:alert(1)', eng: 9400 }],
    gem: { summary: 'People are asking whether Gmail is down.', drivers: 'Users criticized [the outage](#1) and [a bad link](#2).', themes: 'Jokes.' },
    level: { label: 'HIGH', side: 'top', pct: 10, action: 'Action', n: 147, known: 313, since: Date.UTC(2025, 11, 19), fullYear: false },
  }, over || {});
}

test('the write-up follows the team\'s template, section by section', () => {
  const w = tc.writeup(sample());
  const lines = w.text.split('\n');
  assert.strictEqual(lines[0], '(11/17) Alleged Gmail Outage (1pm PT)');
  assert.strictEqual(lines[1], 'BW source: Link <https://app.brandwatch.com/project/1/queries>');
  assert.strictEqual(lines[3], 'TL;DR: There have been 8,397 total mentions regarding Alleged Gmail Outage. Volume is currently HIGH (top 10% of 147 of the ' +
    'past 12 months\' 313 Google issues). Velocity is -99% since the peak at 9am PT today. People are asking whether Gmail is down.');
  assert.ok(w.text.includes('Sentiment: 73% neutral, 18% negative, and 9% positive.'));
  assert.ok(w.text.includes('Mentions Volume: Mentions are highest on X (95%), followed by News (2%) and Blogs (2%), (other sources: 1%).'));
  assert.ok(w.text.includes('Mention Types: Mentions are primarily reposts (68%), followed by comments (26%), with original posts accounting for 6% of all mentions.'));
  assert.ok(w.text.includes('Engagement Volume: Engagement (likes, comments, shares) is highest on X (94%), followed by Instagram (6%).'));
  assert.ok(w.text.includes('  • someone on X: "Is <b>Gmail</b> down? <script>alert(1)</script>" (1.3K Engagements) <https://x.com/someone/status/9>'));
  assert.ok(w.text.includes('  • Post on IG: "no author here" (9.4K Engagements)'));
  assert.strictEqual(w.subject, 'Temp Check: Alleged Gmail Outage');
  assert.ok(w.html.includes(tc.CHART_MARK));
});

test('the write-up never carries a blank to fill in: no bracketed template text, whatever is missing', () => {
  const blanks = /\[HIGH|XX%|\[top \/ bottom|\[example|\[Highlight|\[Author on|\[Post Text\]/;
  const cases = [sample(), sample({ level: { label: '', why: 'too few' } }), sample({ level: null }), sample({ gem: { why: 'Gemini: busy' } }),
    sample({ gem: null }), sample({ posts: [] }), sample({ total: 0, posts: [], gem: null, level: null, velocity: null }),
    sample({ total: 0, basis: 'own', query: null, bwUrl: '', posts: [], gem: null, level: null, velocity: null }),
    sample({ basis: 'own', query: null, bwUrl: '', mentionTypes: [], level: null })];
  cases.forEach(d => { const w = tc.writeup(d); assert.ok(!blanks.test(w.text), w.text); assert.ok(!blanks.test(w.html)); });
  const noLevel = tc.writeup(sample({ level: { label: '', why: 'too few' } })).text;
  assert.ok(noLevel.includes('regarding Alleged Gmail Outage. Velocity is'));  // the sentence is left out, not left blank
  const noGem = tc.writeup(sample({ gem: { why: 'Gemini: busy' } })).text;
  assert.ok(noGem.includes('Negativity Drivers: Not written (Gemini: busy).'));
  assert.ok(tc.writeup(sample({ posts: [] })).text.includes('Highest Engaging Posts:\n  • None with words to show.'));
});

test('a temp check that counted nothing says so in a sentence, not as a template of zeros', () => {
  const own = tc.writeup(sample({ total: 0, basis: 'own', query: null, bwUrl: '', posts: [], gem: null, level: null, velocity: null, hours: [] }));
  assert.strictEqual(own.text, '(11/17) Alleged Gmail Outage (1pm PT)\nBW source: our own data (no Brandwatch query yet)\n\n' +
    'TL;DR: No posts in our own data matched regarding Alleged Gmail Outage between 8am PT and 1:20pm PT.');
  assert.ok(!/Velocity|Sentiment|0 posts\/hr/.test(own.text + own.html));
  assert.ok(!own.html.includes(tc.CHART_MARK));
  assert.match(tc.writeup(sample({ total: 0 })).text, /TL;DR: Brandwatch counted no mentions regarding Alleged Gmail Outage between/);
});

test('a drafted query is put together by fixed rules from the two lists Gemini names', () => {
  const d = gemini.draftFrom({ subject: '"Google Maps" OR GoogleMaps OR #GoogleMaps OR (gmaps) OR googlemaps', angle: 'trust* OR distrust* OR "lied to me" OR wrong* AND scam* OR NEAR/3 OR trust*', why: ' why ' });
  assert.strictEqual(d.wide, '("Google Maps" OR GoogleMaps OR #GoogleMaps OR gmaps)');   // the same name once (in any case), brackets dropped
  assert.strictEqual(d.boolean, '("Google Maps" OR GoogleMaps OR #GoogleMaps OR gmaps) AND (trust* OR distrust* OR "lied to me" OR wrong* OR scam*)');
  assert.strictEqual(d.why, 'why');
  assert.ok(q.convert(d.boolean).ok && q.convert(d.wide).ok);
  assert.strictEqual(gemini.draftFrom({ subject: 'Gmail', angle: '' }).boolean, '(Gmail)');
  assert.throws(() => gemini.draftFrom({ subject: ' ', angle: 'down' }), /named nothing to search for/);
});

test('the concern level says "the past 12 months" only when nearly all of the year\'s issues were there to rank against', () => {
  const base = { label: 'HIGH', side: 'top', pct: 10, n: 147, since: Date.UTC(2026, 6, 4) };
  assert.strictEqual(tc.levelSentence(Object.assign({ known: 313, fullYear: false }, base)).text,
    'Volume is currently HIGH (top 10% of 147 of the past 12 months\' 313 Google issues).');
  assert.strictEqual(tc.levelSentence(Object.assign({ known: 150, fullYear: true }, base)).text,
    'Volume is currently HIGH (top 10% of Google issues in the past 12 months).');
  assert.strictEqual(tc.levelSentence(Object.assign({ known: 0, fullYear: false }, base)).text,
    'Volume is currently HIGH (top 10% of 147 past Google issues).');  // the year's count not known: no claim about the period
  assert.deepStrictEqual(tc.levelSentence({ label: '', why: 'x' }), { text: '', html: '' });
  assert.match(tc.levelSentence(Object.assign({ known: 313 }, base, { label: 'LOW', side: 'bottom', pct: 12 })).html, /<b>LOW<\/b> \(bottom 12% of/);
});

test('the write-up\'s HTML escapes what posts and Gemini say, and links only to http(s)', () => {
  const w = tc.writeup(sample());
  assert.ok(!w.html.includes('<script>'));
  assert.ok(w.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!w.html.includes('javascript:'));
  assert.ok(w.html.includes('<a href="https://x.com/someone/status/9" target="_blank" rel="noopener" style="color:#1155cc">the outage</a>'));
  assert.ok(w.html.includes('and a bad link.'));  // the phrase stays; its unsafe link does not
  const evil = tc.richText('[x](#1) <img src=x onerror=1>', [{ url: 'https://ok.test/"onmouseover="1' }]);
  assert.ok(!/<img|"onmouseover="1"/.test(evil.html));
});

test('a temp check built from our own tables says so, and gives no mention types it doesn\'t have', () => {
  const w = tc.writeup(sample({ basis: 'own', query: null, bwUrl: '', mentionTypes: [], level: null }));
  assert.ok(w.text.includes('BW source: our own data (no Brandwatch query yet)'));
  assert.ok(w.text.includes('There have been 8,397 matching posts in our own data regarding'));
  assert.ok(w.text.includes('Mentions Volume: Posts are highest on X'));
  assert.ok(w.text.includes('Mention Types: not available from our own data (it holds original posts, not reposts or replies).'));
});

test('an update leads with what is new since the last one', () => {
  const d = sample({ update: { at: T0 + H, tot: 5580 } });
  assert.ok(tc.lead(d).text.startsWith('Since the last update at 9am PT, there have been 2,817 new mentions (8,397 total mentions) regarding'));
  assert.ok(tc.lead(sample({ start: { at: T0, why: 'since' } })).text.startsWith('Since 8am PT there have been 8,397 total mentions'));
  assert.ok(tc.prompt(d, d.posts).includes('1. [X] someone (1.2K likes, 50 replies): Is <b>Gmail</b> down?'));
});

// --- the concern level ------------------------------------------------------------------------------------------

function issue(id, totalPerHour, o) {
  const created = (o && o.created) || T0 - 60 * 24 * H - id * H;
  const from = tc.floorHour(created - tc.BEFORE_QUERY_MS);
  return { id, name: `[G EVENT] Issue ${id}`, created, from, final: !(o && o.live), hours: Array.from({ length: (o && o.len) || 168 }, (_, i) => (i >= 48 ? totalPerHour : 0)) };
}
const issuesOf = list => Object.fromEntries(list.map(i => [i.id, i]));

test('the five bands sit where the team\'s table puts them', () => {
  const label = t => benchmark.band(t).label;
  assert.deepStrictEqual([1, 20, 21, 39, 40, 59, 60, 79, 80, 99].map(label),
    ['HIGH', 'HIGH', 'MODERATELY HIGH', 'MODERATELY HIGH', 'MODERATE', 'MODERATE', 'MODERATELY LOW', 'MODERATELY LOW', 'LOW', 'LOW']);
  assert.deepStrictEqual(benchmark.band(12), { label: 'HIGH', side: 'top', pct: 12, action: 'Action' });
  assert.deepStrictEqual(benchmark.band(85), { label: 'LOW', side: 'bottom', pct: 15, action: 'No action' });
  assert.deepStrictEqual(benchmark.band(55), { label: 'MODERATE', side: 'bottom', pct: 45, action: 'Monitor' });
});

test('an issue is ranked against past issues at the same hours since each one started', () => {
  const all = issuesOf(Array.from({ length: 40 }, (_, i) => issue(i + 1, (i + 1) * 10)));  // after 5 hours: 50, 100, … 2,000
  const now = T0 + 5 * H;
  const l = benchmark.level({ queryId: 999, startAt: T0, now, total: 1810 }, all, 40);
  assert.deepStrictEqual([l.label, l.side, l.pct, l.n, l.hours, l.fullYear], ['HIGH', 'top', 10, 40, 5, true]);
  assert.strictEqual(benchmark.level({ queryId: 999, startAt: T0, now, total: 40 }, all, 40).label, 'LOW');
  assert.strictEqual(benchmark.level({ queryId: 999, startAt: T0, now, total: 1000 }, all, 40).label, 'MODERATE');
  assert.strictEqual(benchmark.level({ queryId: 999, startAt: T0, now, total: 1810 }, all, 313).fullYear, false);  // 40 of the year's 313
  assert.strictEqual(benchmark.level({ queryId: 40, startAt: T0, now, total: 1810 }, all, 40).n, 39);            // never against itself
});

test('with fewer than 20 past issues to compare with, no level is given, and it says why', () => {
  const l = benchmark.level({ queryId: 999, startAt: T0, now: T0 + 5 * H, total: 500 }, issuesOf(Array.from({ length: 19 }, (_, i) => issue(i + 1, 10))), 19);
  assert.strictEqual(l.label, '');
  assert.match(l.why, /Only 19 past issues can be compared at 5 hours in\. 20 are needed\./);
});

test('an issue younger than the one being ranked is not compared, unless its five days are over; one older than a year never is', () => {
  const base = Array.from({ length: 25 }, (_, i) => issue(i + 1, 10));
  const now = T0 + 30 * H;
  const young = issue(100, 10, { len: 58, live: true });      // only 10 hours since it started
  const old = issue(101, 10, { created: T0 - 400 * 24 * H });
  assert.strictEqual(benchmark.level({ queryId: 999, startAt: T0, now, total: 5 }, issuesOf(base.concat([young, old])), 0).n, 25);
  const done = issue(102, 10, { len: 58 });                   // short, but finished: its last count stands
  assert.strictEqual(benchmark.level({ queryId: 999, startAt: T0, now, total: 5 }, issuesOf(base.concat([done])), 0).n, 26);
});

test('a past issue counts from its first 100+ hour, or from when its query was made when it never had one', () => {
  const spiky = { created: T0 + 50 * H, from: T0, final: true, hours: [0, 5, 150, 20] };
  assert.deepStrictEqual(benchmark.curve(spiky), { startAt: T0 + 2 * H, why: 'spike', cum: [150, 170] });
  const quiet = { created: T0 + 2 * H + 5, from: T0, final: true, hours: [9, 9, 4, 3] };
  assert.deepStrictEqual(benchmark.curve(quiet), { startAt: T0 + 2 * H, why: 'query', cum: [4, 7] });
  assert.deepStrictEqual(benchmark.curveWindow(T0 + 48 * H, T0 + 1000 * H), { from: T0, to: T0 + 168 * H });
});

test('filling the benchmark waits once 30% of the shared Brandwatch login\'s calls a minute are used', () => {
  assert.strictEqual(benchmark.nearLimit({ limit: '1000/1m', used: '301' }), true);
  assert.strictEqual(benchmark.nearLimit({ limit: '1000/1m', used: '300' }), false);
  assert.strictEqual(benchmark.nearLimit({ limit: '', used: '999' }), false);
});

// --- our own tables ---------------------------------------------------------------------------------------------

test('a post is one post across both tables: an X post by its id, anything else by its link', () => {
  assert.strictEqual(own.postKey('https://twitter.com/A/status/123?s=20'), 'x:123');
  assert.strictEqual(own.postKey('https://x.com/a/status/123'), 'x:123');
  assert.strictEqual(own.postKey('https://www.Reddit.com/r/x/comments/abc/t/?utm=1'), 'reddit.com/r/x/comments/abc/t');
});

test('the search of each table: only SELECT, only named parameters, the window on the partition and on the post\'s time', () => {
  const c = q.convert('gmail NEAR/3 "\'; DROP TABLE x" AND language:en');
  const from = T0;
  const to = T0 + 5 * H;
  const sonar = own.sqlFor('sonar', c.plan, from, to);
  const alerts = own.sqlFor('alerts', c.plan, from, to);
  [sonar, alerts].forEach(s => {
    assert.doesNotThrow(() => bq.assertSelect(s.posts));
    assert.doesNotThrow(() => bq.assertSelect(s.counts));
    assert.ok(!/DROP|gmail/.test(s.posts));
    assert.match(s.posts, /posted >= @t_from AND posted < @t_to/);
    assert.match(s.posts, /LIMIT @lim$/);
    assert.ok(s.params.t_from instanceof Date && s.params.t_to.getTime() === to);
  });
  assert.match(sonar.posts, /received_at >= @t_from AND received_at < TIMESTAMP_ADD\(@t_to, INTERVAL 24 HOUR\)/);
  assert.match(sonar.posts, /language = @q\d/);
  assert.deepStrictEqual([sonar.removed, alerts.removed], [[], ['language']]);  // the alert rows have no language column
  assert.ok(!/language = /.test(alerts.posts.split('hits AS')[1]));
  assert.match(own.sqlFor('alerts', q.convert('language:en').plan, from, to).skip, /Nothing in the query can be asked/);
  assert.match(own.sqlFor('alerts', q.convert('language:en NOT spam').plan, from, to).skip, /would match every post/);
  assert.throws(() => bq.assertSelect('DELETE FROM x'), /only a single SELECT/);
  assert.throws(() => bq.assertSelect('SELECT 1; DROP TABLE x'), /only a single SELECT/);
});

test('every table of posts the bot reads is searched: each a single SELECT, held to the window on its own partition', () => {
  assert.deepStrictEqual(Object.keys(own.SOURCES), ['alerts', 'sonar', 'brandwatch', 'sprinklr', 'tubular']);
  assert.deepStrictEqual(Object.keys(own.SOURCES).slice().sort(), own.ORDER.slice().sort());
  const c = q.convert('gmail NEAR/3 outage AND language:en');
  const from = T0;
  const to = T0 + 5 * H;
  const made = Object.fromEntries(['brandwatch', 'sprinklr', 'tubular'].map(k => [k, own.sqlFor(k, c.plan, from, to)]));
  Object.keys(made).forEach(k => {
    const s = made[k];
    assert.doesNotThrow(() => bq.assertSelect(s.posts), k);
    assert.doesNotThrow(() => bq.assertSelect(s.counts), k);
    assert.ok(!/gmail|outage/.test(s.posts), k);  // the query's words travel as parameters, never in the SQL
    assert.match(s.posts, /posted >= @t_from AND posted < @t_to/);
    assert.match(s.posts, /PARTITION BY one ORDER BY seen DESC\) = 1/);  // a row listed twice is one row
  });
  assert.match(made.brandwatch.posts, /report_date BETWEEN DATE_SUB\(DATE\(@t_from\), INTERVAL 1 DAY\) AND DATE_ADD\(DATE\(@t_to\), INTERVAL 1 DAY\)/);
  assert.match(made.sprinklr.posts, /comment_timestamp >= @t_from AND comment_timestamp < TIMESTAMP_ADD\(@t_to, INTERVAL 24 HOUR\)/);
  assert.match(made.sprinklr.posts, /IFNULL\(is_brand_post, ''\) != 'Brand'/);  // Google's own posts and replies are not what people say
  assert.match(made.tubular.posts, /snapshot_date BETWEEN DATE\(@t_from\) AND DATE_ADD\(DATE\(@t_to\), INTERVAL 3 DAY\)/);
  assert.deepStrictEqual([made.brandwatch.removed, made.sprinklr.removed, made.tubular.removed], [[], ['language'], ['language']]);
  assert.deepStrictEqual([made.brandwatch.location, made.sprinklr.location, made.tubular.location], ['US', 'US', 'us-central1']);
  const big = q.convert(q.fromFilters({ any: 'gmail', minFollowers: 1000 }));
  assert.deepStrictEqual(own.sqlFor('brandwatch', big.plan, from, to).removed, ['followers']);  // its rows carry no follower count
  assert.deepStrictEqual(own.sqlFor('sprinklr', big.plan, from, to).removed, []);
});

test('a comment is itself by its own id; a post by its link, whichever table it came from', () => {
  const under = 'https://x.com/Google/status/9';
  assert.deepStrictEqual(['c1', 'c2'].map(one => own.rowKey({ src: 'sprinklr', one, url: under, at: 1, text: 'words' })), ['sprinklr:c1', 'sprinklr:c2']);  // two comments under one post stay two
  assert.strictEqual(own.rowKey({ src: 'brandwatch', one: 'm1', url: 'https://twitter.com/a/status/9?s=1', at: 1, text: '' }),
    own.rowKey({ src: 'sonar', one: 'p1', url: 'https://x.com/a/status/9', at: 2, text: '' }));  // one post, found in two tables
  assert.strictEqual(own.rowKey({ src: 'tubular', one: '', url: '', at: 5, text: 'a title' }), 'tubular:5:a title');
});

test('the hourly chart as a picture: a real PNG of the size it says, and none when there is no line to draw', () => {
  const c = png.lineChart([{ label: '(11/17) 8AM', n: 3 }, { label: '(11/17) 9AM', n: 141 }, { label: '(11/17) 10AM', n: 20 }]);
  assert.deepStrictEqual(Array.from(c.png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepStrictEqual([c.png.readUInt32BE(16), c.png.readUInt32BE(20), c.width, c.height], [1360, 560, 680, 280]);
  assert.strictEqual(c.png.readUInt32BE(29), png.crc32(c.png.subarray(12, 29)));  // the header's checksum
  const len = c.png.readUInt32BE(33);
  assert.strictEqual(c.png.subarray(37, 41).toString('ascii'), 'IDAT');
  const raw = zlib.inflateSync(c.png.subarray(41, 41 + len));
  assert.strictEqual(raw.length, 560 * (1 + 1360 * 3));  // every row of every pixel is there
  let blue = 0;
  for (let i = 0; i + 2 < raw.length; i++) if (raw[i] === 66 && raw[i + 1] === 133 && raw[i + 2] === 244) blue++;
  assert.ok(blue > 2000, `the line is drawn (${blue} blue pixels)`);
  assert.strictEqual(png.lineChart([{ label: 'a', n: 1 }]), null);
  assert.strictEqual(png.lineChart([]), null);
  assert.deepStrictEqual([png.axis(4), png.axis(5439), png.axis(0)], [{ step: 1, top: 4 }, { step: 2000, top: 6000 }, { step: 1, top: 1 }]);
  assert.throws(() => png.encode(2, 2, Buffer.alloc(5)), /do not agree/);
});

test('the numbers of the posts found: by hour, by source, sentiment, and what their own counters say', () => {
  const posts = [
    { at: T0 + 10, source: 'X', eng: 100, sentiment: 'negative', shares: 40, replies: 5 },
    { at: T0 + 20, source: 'X', eng: null, sentiment: 'neutral', shares: null, replies: null },
    { at: T0 + 2 * H, source: 'Reddit', eng: 7, sentiment: '', shares: 2, replies: 1 },
  ];
  const n = own.numbersOf(posts, T0, T0 + 3 * H);
  assert.strictEqual(n.total, 3);
  assert.deepStrictEqual(n.hours.map(h => h.n), [2, 0, 1]);
  assert.deepStrictEqual(n.byPlatform, [{ label: 'X', n: 2 }, { label: 'Reddit', n: 1 }]);
  assert.deepStrictEqual(n.sentiment, { positive: 0, neutral: 1, negative: 1 });
  assert.deepStrictEqual(n.spread, { counted: 2, reposts: 42, replies: 6 });
  const w = own.asWriteupPost({ src: 'sonar', platform: 'x', source: 'X', author: '@a', text: 't', url: 'https://x.com/a/status/55', eng: 3, sentiment: 'negative' });
  assert.deepStrictEqual([w.x, w.id, w.author, w.negative, w.textFrom], [true, '55', 'a', true, 'Sonar']);
});

// --- kept, served, asked ----------------------------------------------------------------------------------------

test('a temp check is kept and read back; an id that is not one is never read', () => {
  const rec = store.save({ at: T0, trigger: 'analyst', issue: 'X', title: 't', basis: 'own', query: null, total: 3, window: { from: T0, to: T0 + H, why: 'look' },
    own: { posts: [{ text: 'a' }], window: { from: T0, to: T0 + H } } });
  assert.match(rec.id, store.ID_RX);
  assert.strictEqual(store.read(rec.id).issue, 'X');
  assert.deepStrictEqual(store.list().map(c => [c.id, c.ownPosts]), [[rec.id, 1]]);
  ['../index', '..%2Findex', 'tc_1', '', null, `${rec.id}/../x`].forEach(bad => assert.strictEqual(store.read(bad), null));
  assert.throws(() => store.save({ id: '../../evil', at: T0 }), /not a temp check id/);
  assert.ok(store.DIR.startsWith(os.tmpdir()) || store.DIR.includes('tempcheck-test-'));
});

test('the query our tables are searched with: what was typed, else the filters, else the Brandwatch query\'s own', () => {
  const query = { boolean: 'from brandwatch' };
  assert.deepStrictEqual(service.chooseBoolean({ boolean: ' typed ', filters: { any: 'a' } }, query), { text: 'typed', origin: 'typed' });
  assert.deepStrictEqual(service.chooseBoolean({ filters: { any: 'a, b' } }, query), { text: '(a OR b)', origin: 'filters' });
  assert.deepStrictEqual(service.chooseBoolean({}, query), { text: 'from brandwatch', origin: 'query' });
  assert.deepStrictEqual(service.chooseBoolean({}, null), { text: '', origin: '' });
  const d = sample();
  assert.deepStrictEqual(service.chartOf(d).points.map(p => p.n), [141, 5439, 2000, 800, 14]);  // the hour still running is left off
  assert.strictEqual(service.chartOf(d).title, '(11/17) Alleged Gmail Outage 1pm PT');
});

test('the server answers only requests addressed to this computer', () => {
  const { hostOk, PORT } = require('../server');
  assert.ok(hostOk({ headers: { host: `localhost:${PORT}` } }));
  assert.ok(hostOk({ headers: { host: `127.0.0.1:${PORT}` } }));
  ['evil.test', `evil.test:${PORT}`, `localhost.evil.test:${PORT}`, 'localhost', ''].forEach(h => assert.ok(!hostOk({ headers: { host: h } }), h));
});

test('X\'s embed data and Gemini\'s answer are read as the bot reads them', () => {
  assert.strictEqual(xposts.fromEmbed({ id_str: '9', text: 'a &amp; b', user: { screen_name: 'who' }, favorite_count: 3, conversation_count: 1 }).text, 'a & b');
  assert.strictEqual(xposts.fromEmbed({}), null);
  assert.match(xposts.embedToken('2122773134453657666'), /^[a-z0-9]+$/);
  const body = { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'thinking' }, { text: '```json\n{"a": 1}\n```' }] } }] };
  assert.deepStrictEqual(gemini.parseJson(body), { a: 1 });
  assert.throws(() => gemini.parseJson({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }), /cut off/);
  assert.throws(() => gemini.parseJson({ promptFeedback: { blockReason: 'SAFETY' } }), /blocked: SAFETY/);
});
