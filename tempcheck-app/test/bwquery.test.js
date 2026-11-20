'use strict';
// The Boolean converter: what a Brandwatch query becomes, and that the plan answers the same in memory as its rules say.
const test = require('node:test');
const assert = require('node:assert');
const q = require('../lib/bwquery');

const COLS = { text: 'text', textL: 'text_l', authorL: 'author_l', urlL: 'url_l', platform: 'platform', followers: 'followers', language: 'language' };
const post = (text, more) => Object.assign({ text, author: '@someone', url: 'https://x.com/someone/status/1', platform: 'x', followers: 10, language: 'en' }, more || {});
const hit = (query, p) => { const c = q.convert(query); assert.ok(c.ok, `${query}: ${c.error}`); return q.evaluate(c.plan, typeof p === 'string' ? post(p) : p); };
const tree = text => { const w = []; const r = q.parse(text, w); return { shown: q.show(r.tree, 400), w, r }; };

test('words match whole words, in any case, and a hashtag or handle counts as the word', () => {
  assert.ok(hit('gmail', 'Is GMAIL down?'));
  assert.ok(hit('gmail', 'ugh #gmail again'));
  assert.ok(!hit('gmail', 'gmailing all day'));
  assert.ok(!hit('down', 'downtown'));
  assert.ok(hit('#gmail', 'so #gmail is broken'));
  assert.ok(!hit('#gmail', 'so gmail is broken'));
});

test('phrases keep their order and ignore the punctuation between the words', () => {
  assert.ok(hit('"not working"', 'it is NOT   working'));
  assert.ok(hit('"not working"', 'not, working'));
  assert.ok(!hit('"not working"', 'working, not'));
});

test('wildcards: * is any run of word characters, ? is exactly one', () => {
  assert.ok(hit('outage*', 'two outages today'));
  assert.ok(hit('outage*', 'an outage'));
  assert.ok(!hit('outage*', 'outrage'));
  assert.ok(hit('colo?r', 'what colour'));
  assert.ok(!hit('colo?r', 'what color'));
  assert.ok(hit('#gmail*', 'this is #gmailfail'));
});

test('an apostrophe matches any kind or none; a hyphen matches a hyphen, a space or nothing', () => {
  assert.ok(hit('"can\'t log in"', 'I can\u2019t log in'));
  assert.ok(hit('"can\'t log in"', 'i cant log in'));
  assert.ok(hit('e-mail', 'my email'));
  assert.ok(hit('e-mail', 'my e mail'));
  assert.ok(hit('e-mail', 'my e-mail'));
});

test('{Braces} are case sensitive; the same word without them is not', () => {
  assert.ok(hit('{AI}', 'the AI did it'));
  assert.ok(!hit('{AI}', 'the ai did it'));
  assert.ok(hit('ai', 'the AI did it'));
});

test('NEAR/n: within n words, either order; NEAR/nf: in that order only', () => {
  assert.ok(hit('gmail NEAR/3 down', 'gmail is totally down'));
  assert.ok(hit('gmail NEAR/3 down', 'down again, gmail'));
  assert.ok(!hit('gmail NEAR/3 down', 'gmail is one two three four down'));
  assert.ok(hit('google NEAR/1f mail', 'google mail'));
  assert.ok(hit('google NEAR/1f mail', 'google: workspace mail'));
  assert.ok(!hit('google NEAR/1f mail', 'mail from google'));
});

test('NEAR between bracketed lists, and a NEAR inside a NEAR, as the team writes them', () => {
  const query = '((gmail OR (google NEAR/1f (email OR mail OR workspace)) OR "g mail" OR #gmail*)) NEAR/10 (down OR outage* OR "not working" OR crashed)';
  assert.ok(hit(query, 'Is Gmail down for anyone else?'));
  assert.ok(hit(query, 'My google mail has an outage again'));
  assert.ok(hit(query, 'GMAIL IS NOT WORKING'));
  assert.ok(hit(query, '#gmailfail and the site is down'));
  assert.ok(!hit(query, 'Google Workspace email keeps crashing'));  // "crashed" is not "crashing"
  assert.ok(!hit(query, 'gmail is great, I love it and I use it every day for everything I do; the bridge is down'));
  const c = q.convert(query);
  assert.deepStrictEqual(c.report.summary, { terms: 9, phrases: 2, near: 1, caseSensitive: 0, wildcards: 2 });
});

test('a case-sensitive term inside NEAR must still match as written', () => {
  const query = '({AI} OR "artificial intelligence") NEAR/5 google';
  assert.ok(hit(query, 'Google and its AI'));
  assert.ok(!hit(query, 'google and its ai'));
  assert.ok(hit(query, 'google and artificial intelligence'));
});

test('"two words"~n is within n words either way; three or more words fall back to all of them, and say so', () => {
  assert.ok(hit('"gemini pro"~4', 'pro tips for the new gemini'));
  assert.ok(!hit('"gemini pro"~1', 'gemini is a b c d pro'));
  const c = q.convert('"a b c"~3');
  assert.strictEqual(c.report.notes[0].status, 'approximated');
  assert.strictEqual(c.report.notes[0].effect, 'wider');
});

test('NOT after a list of ORs leaves those posts out of the whole list (how the team ends its queries)', () => {
  assert.strictEqual(tree('a OR b OR c NOT ("scroll down")').shown, '((a OR b OR c) AND NOT "scroll down")');
  assert.ok(tree('a OR b NOT c').r.hoisted);
  assert.ok(!hit('gmail OR outage NOT "scroll down"', 'gmail: scroll down for more'));
  assert.ok(hit('gmail OR outage NOT "scroll down"', 'gmail outage'));
  assert.strictEqual(tree('a AND NOT b').shown, '(a AND NOT b)');
  assert.strictEqual(tree('(a OR b NOT x) AND c').shown, '(((a OR b) AND NOT x) AND c)');
});

test('what the reader warns about: AND and OR mixed without brackets, terms side by side, lowercase operators, stray brackets', () => {
  assert.ok(tree('a AND b OR c').r.mixed);
  assert.ok(!tree('(a AND b) OR c').r.mixed);
  assert.ok(tree('google gemini').r.implicit);
  assert.match(tree('a and b').w.join(' '), /lowercase/);
  assert.match(tree('(a OR b').w.join(' '), /never closed/);
  assert.strictEqual(tree('a OR b) OR c').shown, '((a OR b) OR c)');
});

test('<<<comments>>> are ignored', () => {
  assert.strictEqual(tree('<<<Headline>>>\n(a OR b)\n<<<more>>> AND c').shown, '((a OR b) AND c)');
});

test('guid: an X post id is matched in the link; any other id anywhere in the link', () => {
  const query = 'guid:(2122773134453657666 OR 1s5dbgp)';
  assert.ok(hit(query, post('x', { url: 'https://twitter.com/u/status/2122773134453657666' })));
  assert.ok(!hit(query, post('x', { url: 'https://twitter.com/u/status/2122773134453657667' })));
  assert.ok(hit(query, post('x', { url: 'https://www.reddit.com/r/a/comments/1s5dbgp/title/', platform: 'reddit' })));
});

test('site:, url:, subreddit:, author:, hashtags:, at_mentions:, language:, authorFollowers:', () => {
  assert.ok(hit('site:twitter.com', post('x')));
  assert.ok(!hit('site:reddit.com', post('x')));
  assert.ok(hit('site:downdetector.com', post('x', { url: 'https://www.downdetector.com/status/gmail/', platform: 'web' })));
  assert.ok(!hit('site:detector.com', post('x', { url: 'https://www.downdetector.com/status/gmail/', platform: 'web' })));
  assert.ok(hit('(site:instagram.com AND url:DWZfNmVjtCW)', post('x', { url: 'https://www.instagram.com/p/DWZfNmVjtCW/', platform: 'instagram' })));
  assert.ok(hit('subreddit:(technology OR worldnews)', post('x', { url: 'https://www.reddit.com/r/technology/comments/abc/t/', platform: 'reddit' })));
  assert.ok(hit('author:Someone', post('x')));
  assert.ok(!hit('author:some', post('x')));
  assert.ok(hit('hashtags:gmail', post('so #gmail')));
  assert.ok(hit('at_mentions:google', post('hey @Google')));
  assert.ok(hit('gmail AND language:en', post('gmail')));
  assert.ok(!hit('gmail AND language:fr', post('gmail')));
  assert.ok(hit('gmail AND authorFollowers:[5 TO 50]', post('gmail')));
  assert.ok(!hit('gmail AND authorFollowers:[50 TO *]', post('gmail')));
  assert.ok(!hit('gmail AND authorFollowers:[1 TO *]', post('gmail', { followers: null })));
});

test('title: is searched in the post\'s words, and "X OR title:X" becomes X once', () => {
  const c = q.convert('(gmail NEAR/3 down) OR title:(gmail NEAR/3 down)');
  assert.strictEqual(c.plan.k, 'rx');
  assert.strictEqual(c.report.notes[0].status, 'approximated');
});

test('what our tables cannot answer is left out, with which way that leans', () => {
  const c = q.convert('gmail OR engagingWithGuid:(1 OR 2) OR (site:instagram.com AND engagementType:COMMENT) AND country:usa');
  const by = Object.fromEntries(c.report.notes.map(n => [n.clause.split(':')[0], n]));
  assert.strictEqual(by.engagingWithGuid.status, 'left out');
  assert.strictEqual(by.engagingWithGuid.effect, 'narrower');   // out of an OR
  assert.strictEqual(by.engagementType.effect, 'wider');        // out of an AND
  assert.strictEqual(by.country.effect, 'wider');
  assert.ok(c.ok);
  const typo = q.convert('gmail AND stie:reddit.com');
  assert.match(typo.report.notes[0].note, /not an operator this app knows/);
  const nothing = q.convert('engagingWith:google OR parentPostId:abc');
  assert.ok(!nothing.ok);
  assert.match(nothing.error, /Nothing in this query can be searched/);
});

test('a query that only says what to leave out is refused (it would match every post)', () => {
  const c = q.convert('NOT spam');
  assert.ok(!c.ok);
  assert.match(c.error, /every post/);
  assert.ok(!q.convert('').ok);
});

test('a word with a colon that is not an operator is read as a word; a known operator may have a space after its colon', () => {
  assert.ok(hit('Pele: legend', 'pele the legend'));
  assert.ok(hit('title: "big story"', 'a big story'));
  assert.ok(hit('"https://example.test/a"', 'see https://example.test/a now'));
});

test('SQL: every value is a named parameter, never text in the SQL', () => {
  const nasty = '"\'); DROP TABLE x; --" OR author:"a\' OR 1=1" OR guid:2122773134453657666 OR site:reddit.com';
  const c = q.convert(nasty);
  const s = q.toSql(c.plan, COLS, { lim: 5 });
  assert.ok(!/DROP|1=1|2122773134453657666|reddit/.test(s.sql), s.sql);
  assert.match(s.sql, /^\(IFNULL\(/);
  assert.ok(Object.keys(s.params).every(k => k === 'lim' || /^q\d+$/.test(k)));
  assert.ok((s.sql.match(/@q\d+/g) || []).every(name => name.slice(1) in s.params));
  assert.strictEqual(s.params.lim, 5);
});

test('SQL: the same value is one parameter, and each kind of condition has its form', () => {
  const s = q.toSql(q.convert('gmail AND (site:reddit.com OR site:twitter.com) AND language:en AND authorFollowers:[10 TO 20] NOT {AI}').plan, COLS);
  assert.match(s.sql, /REGEXP_CONTAINS\(text_l, @q0\)/);
  assert.match(s.sql, /platform IN UNNEST\(@q\d\)/);
  assert.match(s.sql, /language = @q\d/);
  assert.match(s.sql, /followers >= @q\d AND followers <= @q\d/);
  assert.match(s.sql, /NOT IFNULL\(REGEXP_CONTAINS\(text, @q\d\), FALSE\)/);  // case sensitive: the text as written
  assert.deepStrictEqual(Object.values(s.params).find(Array.isArray), ['reddit', 'x']);
});

test('every pattern the converter writes is one JavaScript accepts (BigQuery is checked live, not here)', () => {
  const c = q.convert('a* OR "b c"~2 OR {D e} OR x NEAR/4 (y OR "z w") OR url:"a.b/c?d=1" OR links:e.f OR #g OR $h OR c++ OR "it\'s" OR e-mail');
  const walk = n => (n.kids ? n.kids.forEach(walk) : n.kid ? walk(n.kid) : n.rx && new RegExp(n.rx, 'u'));
  assert.doesNotThrow(() => walk(c.plan));
});

test('prune: a table without a column drops the conditions on it, and says which', () => {
  const c = q.convert('gmail AND language:en');
  const p = q.prune(c.plan, new Set(['text', 'author', 'url', 'platform', 'followers']));
  assert.deepStrictEqual(p.removed, ['language']);
  assert.strictEqual(p.plan.k, 'rx');
  assert.deepStrictEqual(q.prune(c.plan, new Set(['text', 'language'])).removed, []);
});

test('the filter form writes a query the converter reads back', () => {
  const text = q.fromFilters({ all: 'gmail', any: 'down, outage, not working', none: 'giveaway', platforms: ['X', 'Reddit'], authors: '@google', minFollowers: 1000 });
  assert.strictEqual(text, 'gmail AND (down OR outage OR "not working") AND site:(twitter.com OR reddit.com) AND author:google AND authorFollowers:[1000 TO *] NOT giveaway');
  assert.ok(q.convert(text).ok);
  assert.strictEqual(q.fromFilters({}), '');
  assert.ok(hit(q.fromFilters({ any: 'gmail, google mail', none: 'giveaway' }), 'google mail is down'));
  assert.ok(!hit(q.fromFilters({ any: 'gmail, google mail', none: 'giveaway' }), 'gmail giveaway'));
});
