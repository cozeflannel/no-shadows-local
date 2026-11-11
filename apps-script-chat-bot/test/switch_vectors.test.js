// Vectors.gs: the bot's semantic memory. Texts become 768 numbers from Vertex AI's text-embedding-005 (us-central1,
// task SEMANTIC_SIMILARITY), kept compactly in the script cache, compared by cosine similarity: the closest official
// tags by meaning (vecTagHints_), groups of posts about the same story (vecLeaders_). Calls go out in batches, 429/5xx
// retried; a failure leaves a text without a vector and never throws.
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot } = H;

  const bot = () => {
    const g = makeGoogle();
    return { g, b: loadBot(g.services, g.clock) };
  };

  test('vectors: each distinct text goes to Vertex AI text-embedding-005 once a call (us-central1, SEMANTIC_SIMILARITY, links dropped, batches of 25); blank texts get null; the order is kept; nothing goes in the shared script cache', () => {
    const { g, b } = bot();
    const texts = Array.from({ length: 30 }, (_, i) => `post number ${i} about Gemini https://x.com/a/status/${i}`);
    const v = b.embedTexts_(texts.concat(['', texts[0]]));
    eq([v.length, v.slice(0, 30).every(x => x && x.length === 768), v[30], v[31] !== null], [32, true, null, true]);
    eq(g.vertex.embedCalls.length, 2);  // 30 distinct texts: 25 + 5
    const call = g.vertex.embedCalls[0];
    assert.match(call.url, /^https:\/\/us-central1-aiplatform\.googleapis\.com\/v1\/projects\/brand-social-central-data\/locations\/us-central1\/publishers\/google\/models\/text-embedding-005:predict$/);
    eq([call.payload.instances.length, call.payload.instances[0].task_type, call.payload.parameters.autoTruncate], [25, 'SEMANTIC_SIMILARITY', true]);
    assert.ok(!call.payload.instances.some(i => /https?:/.test(i.content)), 'links dropped');
    eq(b.vecCos_(v[0], v[31]) > 0.999, true);  // the repeat is the same vector
    eq(g.cache.size, 0);  // the script cache (about 1,000 items, shared) is left alone
    // what comes back has been through the int8 round trip, so it compares exactly like a stored copy
    eq(b.vecCos_(v[3], b.vecDecode_(b.vecEncode_(v[3]))) > 0.99999, true);
  });

  test('vectors: a fixed list (the taxonomy, the evergreen topics) is cached as a few packed items, embedded again only when the list changes', () => {
    const { g, b } = bot();
    const list = Array.from({ length: 170 }, (_, i) => `official tag number ${i} description`);
    const v1 = b.vecPacked_('t', list);
    eq([v1.length, v1.every(x => x && x.length === 768), g.vertex.embedCalls.length, g.cache.size], [170, true, 7, 3]);  // 80 a cache item
    for (const val of g.cache.values()) assert.ok(val.length < 100 * 1024, `${val.length} chars`);
    const v2 = b.vecPacked_('t', list);
    eq([g.vertex.embedCalls.length, Math.abs(b.vecCos_(v1[169], v2[169]) - 1) < 1e-9], [7, true]);  // from the cache
    b.vecPacked_('t', list.concat(['one more']));
    eq(g.vertex.embedCalls.length, 14);  // a changed list is embedded afresh
  });

  test('vectors: stored as int8 with a per-vector scale (about 1 KB), so a cached vector compares within 0.01 of the original', () => {
    const { b } = bot();
    const raw = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.37) * 0.08);
    const enc = b.vecEncode_(raw);
    assert.ok(enc.length < 1100, `${enc.length} chars`);
    const dec = b.vecDecode_(enc);
    eq(dec.length, 768);
    assert.ok(b.vecCos_(raw, dec) > 0.999, String(b.vecCos_(raw, dec)));
    eq([b.vecDecode_('nonsense'), b.vecDecode_('0.1:AAAA')], [null, null]);
  });

  test('vectors: a 429 or 5xx batch is retried; a 4xx is not; texts left without a vector are null and nothing throws', () => {
    const { g, b } = bot();
    let n = 0;
    g.vertex.embedFail = () => (++n === 1 ? { code: 429, body: 'quota' } : null);
    const v = b.embedTexts_(['alpha beta gamma', 'delta epsilon zeta']);
    eq([n, v.every(x => x && x.length === 768)], [2, true]);
    const { g: g2, b: b2 } = bot();
    g2.vertex.embedFail = () => ({ code: 400, body: 'bad request' });
    eq(b2.embedTexts_(['one two three']), [null]);
    eq(g2.vertex.embedCalls.length, 1);
    const { g: g3, b: b3 } = bot();
    g3.vertex.embedFail = () => ({ code: 503, body: 'unavailable' });
    eq(b3.embedTexts_(['four five six']), [null]);
    eq(g3.vertex.embedCalls.length, 3);  // VEC_TRIES_
  });

  test('vectors: grouping by meaning (vecLeaders_): each vector joins the most similar earlier leader at the bar, else leads its own group; nearest items are ranked by cosine', () => {
    const { b } = bot();
    const v = b.embedTexts_([
      'gemini told users to add glue to pizza sauce',
      'pixel phone battery overheating while charging',
      'gemini glue pizza sauce answer goes viral',
      'pixel battery overheating charging complaint',
      'chrome uses too much memory',
    ]);
    eq(b.vecLeaders_(v, 0.5), [0, 1, 0, 1, 4]);
    eq(b.vecLeaders_(v, 0.999), [0, 1, 2, 3, 4]);
    const near = b.vecNearest_(v[0], [{ id: 'a', v: v[4] }, { id: 'b', v: v[2] }, { id: 'c', v: null }], x => x.v, 2);
    eq(near.map(x => x.item.id), ['b', 'a']);
  });

  test('vectors: the closest official tags by meaning (vecTagHints_) come from the taxonomy\'s names and official descriptions; a line for the review lists them with their similarity', () => {
    const { b } = bot();
    const tax = b.vecTaxonomy_();
    const exposure = tax.filter(t => t.kind === 'exposure');
    const sensitive = tax.filter(t => t.kind === 'sensitive');
    eq([exposure.length, sensitive.length], [b.ev('GEN.exposure_tags.length'), b.ev('GEN.sensitive_topics.length')]);
    const scam = exposure.find(t => /^Product - Scams involving Google products$/.test(t.name));
    assert.ok(scam && scam.text.includes(b.ev(`GEN.exposure_tags.find(t => t.name === ${JSON.stringify(scam.name)}).description`)), 'official description embedded');
    const [h] = b.vecTagHints_([`${scam.text} A fake Maps listing is scamming people`]);
    eq([h.exposure.length, h.sensitive.length, h.exposure[0].name, h.exposure[0].priority], [3, 2, scam.name, 'P1']);
    assert.match(b.vecTagHintLine_(h), /^Exposure Tags: P1 Product - Scams involving Google products \(\d\.\d\d\); .+ · Sensitive Topics: .+ \(\d\.\d\d\)/);
    eq(b.vecTagHints_(['']), [null]);
    const { g: g2, b: b2 } = bot();
    b2.vecTagHints_(['first text about a Maps scam']);
    const calls = g2.vertex.embedCalls.length;
    b2.vecTagHints_(['second text about Gemini bias']);
    eq(g2.vertex.embedCalls.length, calls + 1);  // the taxonomy came from its packed cache items
    eq(b2.vecTagHintsOfVecs_([null]), [null]);
  });

  test('vectors: evergreen noise (vecEvergreen_): each text gets its closest of the 16 evergreen topics; only a strict topic at the calibrated bar (0.80) marks it noise', () => {
    const { g, b } = bot();
    const [m1, m2, m3] = b.vecEvergreen_(['Shot on Pixel #TeamPixel', 'Gemini told users to add glue to pizza sauce', '']);
    eq([m1.id, m1.strict, b.vecIsEvergreenNoise_(m1)], ['shot_on_pixel', true, true]);
    eq([b.vecIsEvergreenNoise_(m2), m3], [false, null]);
    eq(b.vecIsEvergreenNoise_({ id: 'conspiracy', strict: false, sim: 0.99 }), false);  // not a strict topic
    eq(b.vecIsEvergreenNoise_({ id: 'google_me', strict: true, sim: 0.799 }), false);   // below the bar
    eq(b.ev('VEC_EVERGREEN_.length'), 16);
    eq(b.ev('VEC_EVERGREEN_.filter(t => t.strict).map(t => t.id).sort().join()'),
      'captain_america,gmail_accounts,google_as_verb,google_me,maps_exploring,maps_jokes,shot_on_pixel,sponsored_sports');
    assert.ok(g.vertex.embedCalls.length >= 1);
    const vecs = b.embedTexts_(['Shot on Pixel #TeamPixel']);
    const n = g.vertex.embedCalls.length;
    eq(b.vecEvergreenOfVecs_(vecs)[0].id, 'shot_on_pixel');
    eq(g.vertex.embedCalls.length, n);  // scored without embedding again (the topics are cached)
  });
};
