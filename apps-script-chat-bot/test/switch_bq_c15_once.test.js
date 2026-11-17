// C15 never lists one post both as posted and as not posted on the same day (BigQuery.gs bqUncountPosted_, called
// from noteBqDirect_ with the record keys of the posts the poll posted at that check). A post counted at an earlier
// check under "already had an alert" (a) or "on a story already alerted" (b) whose card the poll posts later (a post
// under the bar that grew into a bigger post) leaves that count, and the day's record (BQ_DIRECT_TODAY: k) forgets it.
// A post is known as counted as bqCountNotPosted_ knows it: by the day's record or by its cache key; so the tests run
// with the cache as it works, with it emptied, and with the record's list lost. Nothing here posts anything.
'use strict';

module.exports = H => {
  const { test, eq, assert, world } = H;

  const POST = 'x.com/status/2150000000000000051';
  const OTHER = 'x.com/status/2150000000000000099';
  const notPosted = (why, key) => ({ why, key, url: `https://${key}`, said: 'QA-1 (BigQuery · BSIP)' });

  test('direct BQ C15 once: a post counted as not posted and later posted leaves the "not posted" count (a and b alike), with the cache as it works, with it emptied, and with the day\'s record\'s list lost; a post never counted, an empty key and a missing list change nothing; the other posts keep their counts', () => {
    const w = world();
    const day = w.bot.dayKey_();
    const fresh = () => w.bot.bqDirectDay_(JSON.stringify({ day, n: 2 }));
    const cacheKeys = () => Array.from(w.g.cache.keys()).filter(k => /^bqnp:/.test(k)).sort();

    // with the cache as it works
    let s = fresh();
    w.bot.bqCountNotPosted_(s, [notPosted('b', POST), notPosted('b', OTHER), notPosted('a', OTHER)]);
    eq([s.a, s.b, s.k.length, cacheKeys().length], [1, 2, 3, 3]);
    w.bot.bqUncountPosted_(s, [POST]);
    eq([s.a, s.b, s.k.length, cacheKeys().length], [1, 1, 2, 2]);
    assert.ok(s.k.every(id => id !== 'b' + w.bot.hashText_(POST)));
    // posted again (it can't be, but) or never counted: nothing moves
    w.bot.bqUncountPosted_(s, [POST, 'x.com/status/1', '', null, undefined]);
    w.bot.bqUncountPosted_(s, null);
    w.bot.bqUncountPosted_(s, undefined);
    eq([s.a, s.b, s.k.length], [1, 1, 2]);
    // a post counted under both reasons leaves both
    w.bot.bqUncountPosted_(s, [OTHER]);
    eq([s.a, s.b, s.k, cacheKeys()], [0, 0, [], []]);

    // with the cache emptied: the day's record alone knows the post
    w.g.cache.clear();
    s = fresh();
    w.bot.bqCountNotPosted_(s, [notPosted('b', POST)]);
    w.g.cache.clear();
    w.bot.bqUncountPosted_(s, [POST]);
    eq([s.b, s.k], [0, []]);

    // with the record's list lost (more than its 300 counted after it): the cache key alone knows it
    w.g.cache.clear();
    s = fresh();
    w.bot.bqCountNotPosted_(s, [notPosted('a', POST)]);
    s.k = [];
    w.bot.bqUncountPosted_(s, [POST]);
    eq([s.a, cacheKeys()], [0, []]);

    // both lost: it can't be known, so nothing is taken out (and a count never goes below 0)
    w.g.cache.clear();
    s = fresh();
    w.bot.bqCountNotPosted_(s, [notPosted('b', POST)]);
    s.k = [];
    w.g.cache.clear();
    w.bot.bqUncountPosted_(s, [POST]);
    eq(s.b, 1);
    s.b = 0;
    s.k = ['b' + w.bot.hashText_(POST)];
    w.bot.bqUncountPosted_(s, [POST]);
    eq([s.b, s.n], [0, 2]);
  });

  test('direct BQ C15 once: noteBqDirect_ takes the posts of this check out of the day\'s "not posted" counts before C15 is written, and saves the record; with no posted keys (every caller of before) it counts as before', () => {
    const w = world();
    const props = w.g.services.PropertiesService.getScriptProperties();
    const counts = () => { const d = JSON.parse(w.g.props.get('BQ_DIRECT_TODAY')); return ['n', 'a', 'b'].map(k => d[k]); };
    w.bot.noteBqDirect_(props, 1, '', [notPosted('b', POST), notPosted('a', OTHER)]);
    eq(counts(), [1, 1, 1]);
    // a later check: the same two posts read again, and POST gets its card
    w.bot.noteBqDirect_(props, 1, '', [notPosted('a', OTHER)], [POST]);
    eq(counts(), [2, 1, 0]);
    // without posted keys (every caller of before): counted as before
    w.bot.noteBqDirect_(props, 0, '', [notPosted('b', OTHER)]);
    eq(counts(), [2, 1, 1]);
  });
};
