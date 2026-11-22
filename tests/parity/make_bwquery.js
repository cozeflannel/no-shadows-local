/**
 * Writes tests/parity/bwquery.json: what the temp check app's own converter (tempcheck-app/lib/bwquery.js) makes of the
 * queries, posts and filter forms below. For each query: how it is read (written back, with the reader's warnings),
 * the plan and the report, the SQL condition and its parameters, the plan for each kind of table, and whether each
 * post matches (one character a post, 1 for a match). tests/test_bwquery_parity.py asks the Console's converter (triage_agent/bwquery.py) the same and
 * expects the same answers. Run again after the app's converter changes:
 *
 *   node tests/parity/make_bwquery.js
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const q = require('../../tempcheck-app/lib/bwquery');
const own = require('../../tempcheck-app/lib/owndata');

const sha = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const COLS = { text: 'text', textL: 'text_l', authorL: 'author_l', urlL: 'url_l', platform: 'platform', followers: 'followers', language: 'language' };

// The app's own tests' queries, then one or more for every rule the converter has.
const QUERIES = [
  'gmail', '#gmail', '"not working"', 'outage*', 'colo?r', '#gmail*', '"can\'t log in"', 'e-mail', '{AI}', 'ai',
  'gmail NEAR/3 down', 'google NEAR/1f mail',
  '((gmail OR (google NEAR/1f (email OR mail OR workspace)) OR "g mail" OR #gmail*)) NEAR/10 (down OR outage* OR "not working" OR crashed)',
  '({AI} OR "artificial intelligence") NEAR/5 google',
  '"gemini pro"~4', '"gemini pro"~1', '"a b c"~3',
  'a OR b OR c NOT ("scroll down")', 'a OR b NOT c', 'gmail OR outage NOT "scroll down"', 'a AND NOT b', '(a OR b NOT x) AND c',
  'a AND b OR c', '(a AND b) OR c', 'google gemini', 'a and b', '(a OR b', 'a OR b) OR c',
  '<<<Headline>>>\n(a OR b)\n<<<more>>> AND c',
  'guid:(2122773134453657666 OR 1s5dbgp)',
  'site:twitter.com', 'site:reddit.com', 'site:downdetector.com', 'site:detector.com', '(site:instagram.com AND url:DWZfNmVjtCW)',
  'subreddit:(technology OR worldnews)', 'author:Someone', 'author:some', 'hashtags:gmail', 'at_mentions:google',
  'gmail AND language:en', 'gmail AND language:fr', 'gmail AND authorFollowers:[5 TO 50]', 'gmail AND authorFollowers:[50 TO *]',
  'gmail AND authorFollowers:[1 TO *]',
  '(gmail NEAR/3 down) OR title:(gmail NEAR/3 down)',
  'gmail OR engagingWithGuid:(1 OR 2) OR (site:instagram.com AND engagementType:COMMENT) AND country:usa',
  'gmail AND stie:reddit.com', 'engagingWith:google OR parentPostId:abc', 'NOT spam', '',
  'Pele: legend', 'title: "big story"', '"https://example.test/a"',
  '"\'); DROP TABLE x; --" OR author:"a\' OR 1=1" OR guid:2122773134453657666 OR site:reddit.com',
  'gmail AND (site:reddit.com OR site:twitter.com) AND language:en AND authorFollowers:[10 TO 20] NOT {AI}',
  'a* OR "b c"~2 OR {D e} OR x NEAR/4 (y OR "z w") OR url:"a.b/c?d=1" OR links:e.f OR #g OR $h OR c++ OR "it\'s" OR e-mail',
  // queries the Console's own tests use
  'gmail AND "locked out" AND {Gmail} AND outag* AND (down NEAR/3 again) AND title:(broken) AND country:us',
  'gmail AND (outage OR country:us)',
  '("calendar invite" OR gmail) AND (scam* OR phishing) NOT site:reddit.com <<<note>>> engagingWith:google',
  'google NEAR/3 outage AND {Gemini} AND author:(sundarpichai OR @google) AND authorFollowers:[1000 TO *]',
  'gmail AND (outage OR down)', '(gmail OR "google mail") NEAR/10 (down OR outage*) NOT giveaway', 'gmail AND authorFollowers:[1000 TO *]',
  'language:en', 'gmail AND outage', '   ',
  // operators with a value
  'raw:"Gmail."', 'raw:(C++ OR "A.I.")', 'raw:(a AND NOT b)', 'title:', 'author:', 'title:gmail down', 'title:(a OR {B}) AND raw:c',
  'authorFollowers:[abc]', 'authorFollowers:[* TO 500]', 'authorFollowers:[* TO *]', 'authorFollowers:1000', 'authorFollowers: [10 TO 20]',
  'authorFollowers:[10 to 20]', 'authorFollowers:[10 TO 20', 'gmail [10 TO 20]', 'title:[1 TO 2]',
  'site:x.com/google', 'site:https://www.youtube.com/', 'site:(twitter.com OR reddit.com OR example.org)', 'site:"blog.example.org/path/"',
  'site:(x.com NOT reddit.com)', 'site:threads.com OR site:tumblr.com OR site:bsky.app',
  'url:"https://www.example.com/a/b/"', 'url:(a* OR b)', 'url:www.example.com', 'links:https://example.com/x', 'link:example.com',
  'subreddit:r/Technology', 'subreddit:/r/gmail', 'author:(@Google OR sundar*) NOT author:spam?', 'author:"some one"', 'author:@',
  'hashtags:(#gmail OR outage*)', 'at_mentions:@google', 'hashtags:"two words"', 'language:(EN OR Fr)', 'language:en OR gmail',
  'guid:123', 'guid:"123456789012345"', 'guid:(1234567890123456 OR 12345678901234567890 OR 123456789012345678901)', 'guid:(a* OR "b c")',
  // operators our tables cannot answer, and ones nobody knows
  'engagingWith:(a OR b) AND gmail', 'gmail AND NOT country:us', 'NOT (gmail OR country:us)', 'gmail OR NOT country:us', 'brandIds:123 OR gmail',
  'threadEntryType:reply AND gmail', 'foo:bar', 'foo: bar', 'foo:(a OR b)', 'foo:"a b"', 'country: usa', 'country:', 'gmail AND foo:bar',
  'http://example.com/x', 'https://example.com', 'https: a', 'HTTP:x', 'a:b', 'ab:', 'ab: cd',
  'constructor: gmail', 'gmail OR constructor:x', '__proto__:x AND gmail', 'Constructor:(a OR b) AND gmail', 'toString: gmail',
  // NOT, and brackets that do not pair up
  'NOT (a OR b) AND c', 'NOT NOT a', 'a NOT b NOT c', 'a OR (b NOT c)', '(a NOT b) OR c', 'NOT a OR b', 'a AND (NOT b OR c)', 'a NOT b OR c',
  'a OR b NOT c OR d', '(a OR b) NOT (c OR d) NOT e', 'a AND b NOT c', 'NOT a NOT b', 'a NOT', 'NOT',
  'a OR', 'AND a', 'a AND AND b', 'a OR OR b', 'OR', 'AND', 'a ) b', ') a', 'a ) OR b', 'a ) AND b ) c', '((a)', '()', '(())  a', '(a) (b)',
  ')(', 'a (b OR c) d',
  // NEAR
  'a NEAR/3', 'NEAR/3 a', 'a NEAR/3 NOT b', 'a NEAR/99 b', 'a NEAR/5 (b AND c)', 'a NEAR/5 (b NOT c)', 'a NEAR/2 "b c"~3', 'a NEAR/2 site:x.com',
  '(a NEAR/2 b) NEAR/4f (c OR "d e")', '{Gemini Pro} NEAR/3 {AI}', 'x NEAR/3 y*', 'a NEAR/3 b NEAR/5 c', 'a NEAR/0 b', 'a NEAR/3F b',
  'a NEAR/1234 b', 'a NEAR/ b', 'near/3', 'a near/3 b', 'a NEAR/3 (b OR (c NEAR/2f d))', '"a b" NEAR/2 "c d"', 'a NEAR/3 {B}',
  // phrases, braces, quotes
  '{Gemini Pro}', '{single}', '{}', '""', '"   "', '"one"', '"unclosed phrase', '{unclosed', '"a b"~1000', '"a b"~ 3', '"a b" ~3', '"a b"~3x',
  '"a, b; c."', '"a* b?"', '"*"~2', '"a b c d"~2 OR x', '{A b}~3', '“smart quotes” AND „low”', '"it\'s a \'test\'"',
  // words: punctuation, wildcards, other alphabets
  'gmail, down; now!', 'what? really*', "don't", 'don’t', 'rock‐n‐roll', 'e–mail', 'C++', '$GOOG', 'A.I.', 'node.js',
  '@google', '#Gmail', '50%', 'a_b', 'naïve', 'МОСКВА', '東京', 'i̇stanbul OR İSTANBUL',
  'a b', 'gmail*down', '*', '?', '* OR a', 'a?b*c', 'not gmail', 'Not gmail', 'a.b.c', '-', '--a', 'a-', "'", 'a|b', 'a\\b', '[a]', 'a^b$',
  '😀', 'café AND 😀*',
  // comments, and the same condition written twice
  '<<<only a comment>>>', '<<<unclosed comment a OR b', 'a <<<c>>> b', 'a OR a OR A', '(a OR b) OR (b OR c)', 'a AND (a AND b)',
  'site:twitter.com OR site:x.com OR guid:2122773134453657666 OR guid:2122773134453657667', '(guid:1234567890123456 OR a) OR guid:1234567890123456',
  'gmail AND site:twitter.com AND site:x.com', 'links:e.f OR e.f',
];

// Long queries, written by a recipe the test repeats: `left` is "stem0 OR stem1 OR …" (n words); with `near`, a second
// list is set within that many words of it. Only the size and a fingerprint of their answers are kept.
const words = (stem, n) => Array.from({ length: n }, (_, i) => stem + i).join(' OR ');
const LONG = [
  { name: 'a NEAR too long to check word distances', left: ['alpha', 900], near: 5, right: ['beta', 900] },
  { name: 'a query over 60,000 characters', left: ['word', 9000] },
  { name: 'two hundred words in one OR', left: ['term', 200] },
];
const written = r => (r.near ? `(${words(...r.left)}) NEAR/${r.near} (${words(...r.right)})` : words(...r.left));

const post = (text, more) => Object.assign({ text, author: '@someone', url: 'https://x.com/someone/status/1', platform: 'x', followers: 10, language: 'en' }, more || {});
const POSTS = [
  'Is GMAIL down?', 'ugh #gmail again', 'gmailing all day', 'downtown', 'so #gmail is broken', 'so gmail is broken', 'it is NOT   working',
  'not, working', 'working, not', 'two outages today', 'an outage', 'outrage', 'what colour', 'what color', 'this is #gmailfail',
  'I can’t log in', 'i cant log in', 'my email', 'my e mail', 'my e-mail', 'the AI did it', 'the ai did it', 'gmail is totally down',
  'down again, gmail', 'gmail is one two three four down', 'google mail', 'google: workspace mail', 'mail from google',
  'Is Gmail down for anyone else?', 'My google mail has an outage again', 'GMAIL IS NOT WORKING', '#gmailfail and the site is down',
  'Google Workspace email keeps crashing', 'gmail is great, I love it and I use it every day for everything I do; the bridge is down',
  'Google and its AI', 'google and its ai', 'google and artificial intelligence', 'pro tips for the new gemini', 'gemini is a b c d pro',
  'gmail: scroll down for more', 'gmail outage', 'pele the legend', 'a big story', 'see https://example.test/a now', 'so #gmail', 'hey @Google',
  'gmail', 'x', '', 'a b c', 'c b a', 'a x y b', 'b a', 'C++ and A.I. on node.js', "don't stop", 'dont stop', 'rock n roll and rock-n-roll and rocknroll',
  '$GOOG to the moon', 'naïve МОСКВА 東京', 'İSTANBUL', 'Gmail.', 'gmail giveaway',
  'google mail is down', 'calendar invite scam from gmail', 'gmail locked out Gmail outages down once again broken', 'a\nb', 'a  b',
  'trailing newline gmail\n', 'Gemini Pro and AI', 'gemini pro and ai', 'e.f is a link', 'two words here #two words', 'smart quotes and low',
  'it’s a ‘test’', 'a, b; c.', '50% off', 'a_b', '😀 café 😀party', 'what really', 'one', 'now gmail down',
].map(t => post(t)).concat([
  post('x', { url: 'https://twitter.com/u/status/2122773134453657666' }),
  post('x', { url: 'https://twitter.com/u/status/2122773134453657667' }),
  post('x', { url: 'https://twitter.com/u/status/1234567890123456' }),
  post('x', { url: 'https://www.reddit.com/r/a/comments/1s5dbgp/title/', platform: 'reddit' }),
  post('x', { url: 'https://www.downdetector.com/status/gmail/', platform: 'web' }),
  post('x', { url: 'https://www.instagram.com/p/DWZfNmVjtCW/', platform: 'instagram' }),
  post('x', { url: 'https://www.reddit.com/r/technology/comments/abc/t/', platform: 'reddit' }),
  post('x', { url: 'https://www.reddit.com/r/Technology', platform: 'reddit' }),
  post('gmail', { followers: null }), post('gmail', { followers: 1000 }), post('gmail', { followers: 500 }), post('gmail', { followers: 0 }),
  post('gmail', { language: 'fr' }), post('gmail', { language: '' }), post('gmail', { language: 'EN' }),
  post('x', { author: '@Google' }), post('x', { author: 'sundarpichai' }), post('x', { author: 'Some One' }), post('x', { author: '' }),
  post('x', { author: 'spammy' }), post('x', { author: '@' }),
  post('gmail', { platform: 'X' }), post('x', { platform: 'youtube', url: 'https://www.youtube.com/watch?v=abc' }),
  post('x', { url: 'https://x.com/google/status/5' }), post('x', { url: 'https://blog.example.org/path/post', platform: 'web' }),
  post('x', { url: 'https://www.example.com/a/b', platform: 'web' }), post('x', { url: 'http://example.com/x', platform: 'web' }),
  post('x', { url: '' }), post('a.b/c?d=1 e.f', { url: 'https://a.b/c?d=1', platform: 'web' }),
  { text: null, author: null, url: null, platform: null, followers: null, language: null },
]);

// The columns each of the app's tables has, then a few a table could have.
const HAS = Object.keys(own.SOURCES).map(key => Array.from(own.SOURCES[key].has)).concat([['text'], ['url'], [],
  ['text', 'author', 'url', 'platform', 'followers', 'language']]);

const FILTERS = [
  {}, null,
  { all: 'gmail', any: 'down, outage, not working', none: 'giveaway', platforms: ['X', 'Reddit'], authors: '@google', minFollowers: 1000 },
  { any: 'gmail, google mail', none: 'giveaway' }, { all: 'a' }, { all: 'a, b c' }, { all: ['x', 'y z'] }, { any: 'one' }, { none: 'only none' },
  { none: 'a, b' }, { platforms: ['x'] }, { platforms: ['X', 'unknown', 'tumblr', 'Bluesky'] }, { platforms: 'x, reddit' },
  { authors: '@a, b\nc' }, { minFollowers: '250.6' }, { minFollowers: 2.5 }, { minFollowers: 0 }, { minFollowers: 'abc' }, { minFollowers: -5 },
  { all: 'say "hi" now' }, { all: ' , ,' }, { all: 'gmail', none: 'x y, z' }, { any: 'a,b', all: 'c,d', none: 'e' },
  { all: 'gmail', platforms: ['youtube', 'tiktok', 'threads', 'linkedin', 'instagram', 'facebook'] },
];

/** Everything the converter says about one query. */
function answers(text) {
  const warnings = [];
  const read = q.parse(String(text || ''), warnings);
  const out = { query: text, shown: q.show(read.tree, 400), implicit: read.implicit, mixed: read.mixed, hoisted: read.hoisted, readWarnings: warnings };
  const conv = q.convert(text);
  Object.assign(out, { ok: conv.ok, error: conv.error || '', plan: conv.plan, report: conv.report });
  if (!conv.ok) return out;
  const sql = q.toSql(conv.plan, COLS, { t_from: 0, t_to: 0, lim: 0 });
  delete sql.params.t_from; delete sql.params.t_to; delete sql.params.lim;
  out.sql = sql.sql;
  out.params = sql.params;
  out.sqlAloneSha = sha(q.toSql(conv.plan, COLS).sql);  // with no parameters there already: the names start at q0
  out.fields = Array.from(q.fieldsOf(conv.plan));
  const whole = JSON.stringify(conv.plan);
  out.pruned = HAS.map(has => {  // the plan a table with these columns is asked: 'same' when nothing had to go
    const cut = q.prune(conv.plan, new Set(has));
    return { removed: cut.removed, plan: JSON.stringify(cut.plan) === whole ? 'same' : cut.plan };
  });
  out.matches = POSTS.map(p => (q.evaluate(conv.plan, p) ? '1' : '0')).join('');
  return out;
}

const queries = QUERIES.map(answers);
const long = LONG.map(recipe => {
  const a = answers(written(recipe));
  return { recipe, ok: a.ok, error: a.error, summary: a.report.summary, notes: a.report.notes, warnings: a.report.warnings,
    planKind: a.plan ? a.plan.k : null, planKids: a.plan && a.plan.kids ? a.plan.kids.length : 0,
    sqlLength: a.sql ? a.sql.length : 0, sqlSha: a.sql ? sha(a.sql) : '', paramsSha: a.params ? sha(JSON.stringify(a.params)) : '',
    matches: a.matches || '' };
});
const filters = FILTERS.map(f => ({ filters: f, query: q.fromFilters(f) }));

// One query to a line, so a change in the app's converter shows as the lines it changed.
const head = { madeBy: 'tests/parity/make_bwquery.js', cols: COLS, has: HAS, sitePlatform: q.SITE_PLATFORM, platformSite: q.PLATFORM_SITE };
const lines = arr => '[\n' + arr.map(x => JSON.stringify(x)).join(',\n') + '\n]';
fs.writeFileSync(path.join(__dirname, 'bwquery.json'), '{\n' + Object.keys(head).map(k => `${JSON.stringify(k)}: ${JSON.stringify(head[k])}`).join(',\n') +
  `,\n"posts": ${lines(POSTS)},\n"filters": ${lines(filters)},\n"long": ${lines(long)},\n"queries": ${lines(queries)}\n}\n`);
console.log(`wrote ${queries.length} queries (${queries.filter(x => x.ok).length} converted), ${long.length} long ones, ${POSTS.length} posts, ${filters.length} filter forms`);
