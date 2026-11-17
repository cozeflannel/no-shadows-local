/**
 * Vectors.gs — the bot's semantic memory: Vertex AI text embeddings and cosine similarity, in Apps Script.
 *
 * Each text the bot compares by meaning (a post, an alert's story, an Exposure Tag's or Sensitive Topic's official
 * description, a Resources passage) becomes 768 numbers from Vertex AI's text-embedding-005 model (VEC_MODEL_ in
 * VEC_LOCATION_, task VEC_TASK_: one vector per text, reused for every comparison). Texts that mean the same thing sit
 * close together (cosine similarity near 1) even when their words differ; unrelated texts sit far apart. The bot uses
 * this to label a post with the closest official tags (vecTagHints_), to group posts about the same story
 * (vecLeaders_), to recognize evergreen noise (vecEvergreen_) and a story it already alerted (AlertMemory.gs).
 *
 * Calls go out in parallel batches (VEC_BATCH_ texts each), retried on 429/5xx (VEC_TRIES_ tries); a text Vertex AI
 * gives no vector for stays null and callers fall back to their word checks. Nothing here throws.
 * Storage: a vector is kept compactly (vecEncode_: its largest magnitude, then int8 values, about 1 KB of text), and
 * every vector returned has been through that round trip, so a stored vector compares exactly like a fresh one.
 * embedTexts_ itself caches nothing: the script cache holds only about 1,000 items, shared with every other feature,
 * so per-text items would push those out. Fixed lists (the taxonomy, the evergreen topics) are cached as a few packed
 * items (vecPacked_); features that keep vectors longer store them themselves (vecEncode_ / vecDecode_).
 */

const VEC_MODEL_ = 'text-embedding-005';
const VEC_LOCATION_ = 'us-central1';
const VEC_TASK_ = 'SEMANTIC_SIMILARITY';
const VEC_DIMS_ = 768;
const VEC_BATCH_ = 25;               // texts per :predict call (the model takes 250 texts and 20,000 tokens a call)
const VEC_MAX_CHARS_ = 2000;         // of each text (about 500 tokens; the model truncates the rest too)
const VEC_PACK_PREFIX_ = 'vecpack1:';
const VEC_PACK_PER_ITEM_ = 80;       // packed vectors per cache item (~1,040 chars each: under the 100 KB value cap)
const VEC_PACK_SEC_ = 6 * 3600;      // a packed list stays cached this long (the cache's maximum)
const VEC_TRIES_ = 3;
const VEC_MIN_LEFT_MS_ = 15 * 1000;  // no new call starts with less than this left before opts.deadline

/** The Vertex AI endpoint the vectors come from. */
function vecUrl_() {
  return `https://${VEC_LOCATION_}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${VEC_LOCATION_}` +
    `/publishers/google/models/${VEC_MODEL_}:predict`;
}

/** The text as the model gets it: links dropped, spaces collapsed, at most VEC_MAX_CHARS_ characters. Pure. */
function vecText_(s) {
  return String(s == null ? '' : s).replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, VEC_MAX_CHARS_);
}

/** Bytes (signed or not) as lowercase hex. Pure. */
function vecHex_(bytes) {
  return (bytes || []).map(b => ((b & 255) < 16 ? '0' : '') + (b & 255).toString(16)).join('');
}

/** A short signature of the model, task and texts (a packed list's cache key). */
function vecSig_(texts) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    `${VEC_MODEL_}|${VEC_TASK_}|${(texts || []).join('\n')}`, Utilities.Charset.UTF_8);
  return vecHex_(d).slice(0, 20);
}

/** A vector as about 1 KB of text: its largest magnitude, ':', then its values as int8 (base64). Pure. */
function vecEncode_(v) {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(Number(v[i]) || 0));
  const scale = max || 1;
  const bytes = new Array(v.length);
  for (let i = 0; i < v.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round((Number(v[i]) || 0) / scale * 127)));
  return `${scale.toPrecision(7)}:${Utilities.base64Encode(bytes)}`;
}

/** The vector vecEncode_ wrote (null for anything else). Pure. */
function vecDecode_(s) {
  const m = /^([0-9.eE+-]+):([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) return null;
  const scale = Number(m[1]);
  let bytes;
  try { bytes = Utilities.base64Decode(m[2]); } catch (e) { return null; }
  if (!(scale > 0) || !bytes || bytes.length !== VEC_DIMS_) return null;
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] > 127 ? bytes[i] - 256 : bytes[i]) / 127 * scale;
  return out;
}

/** Cosine similarity of two vectors (0 when either is missing or empty). Pure. */
function vecCos_(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function vecCache_() {
  try { return typeof CacheService !== 'undefined' && CacheService.getScriptCache ? CacheService.getScriptCache() : null; }
  catch (e) { return null; }
}

/**
 * Vectors for `texts`, in the same order: null where a text is blank or Vertex AI gave none. Each distinct text goes to
 * Vertex AI once per call; nothing is cached (see the header). opts.deadline (ms since epoch): no call starts within
 * VEC_MIN_LEFT_MS_ of it. Never throws.
 */
function embedTexts_(texts, opts) {
  const o = opts || {};
  const list = (texts || []).map(vecText_);
  const out = list.map(() => null);
  const unique = Array.from(new Set(list.filter(Boolean)));
  if (!unique.length) return out;
  const fresh = vecFetch_(unique.map((text, i) => ({ key: String(i), text })), o);
  const byText = {};
  unique.forEach((t, i) => { if (fresh[String(i)]) byText[t] = vecDecode_(vecEncode_(fresh[String(i)])); });
  list.forEach((t, i) => { if (t && byText[t]) out[i] = byText[t]; });
  return out;
}

/**
 * Vectors for a fixed list of texts (the taxonomy, the evergreen topics), kept in the script cache as a few packed
 * items (VEC_PACK_PER_ITEM_ vectors each) under `name` and the list's signature: a changed list is embedded afresh.
 * Same contract as embedTexts_. Never throws.
 */
function vecPacked_(name, texts, opts) {
  const list = (texts || []).map(vecText_);
  if (!list.length) return [];
  const sig = vecSig_(list);
  const keys = [];
  for (let i = 0; i < list.length; i += VEC_PACK_PER_ITEM_) keys.push(`${VEC_PACK_PREFIX_}${name}:${sig}:${keys.length}`);
  const cache = vecCache_();
  if (cache) {
    let got = {};
    try { got = cache.getAll(keys) || {}; } catch (e) { got = {}; }
    if (keys.every(k => got[k])) {
      const vecs = [];
      keys.forEach(k => String(got[k]).split('\n').forEach(s => vecs.push(s ? vecDecode_(s) : null)));
      if (vecs.length === list.length && vecs.every((v, i) => v || !list[i])) return vecs;
    }
  }
  const vecs = embedTexts_(list, opts);
  if (cache && vecs.every((v, i) => v || !list[i])) {
    const items = {};
    keys.forEach((k, j) => {
      items[k] = vecs.slice(j * VEC_PACK_PER_ITEM_, (j + 1) * VEC_PACK_PER_ITEM_).map(v => (v ? vecEncode_(v) : '')).join('\n');
    });
    try { cache.putAll(items, VEC_PACK_SEC_); } catch (e) { /* embedded again next time */ }
  }
  return vecs;
}

/**
 * Vertex AI vectors for [{key, text}] as {key: number[]} (texts it gave none for are left out), in parallel batches of
 * VEC_BATCH_, the batches that got a 429/5xx or no answer retried (VEC_TRIES_ tries). Never throws.
 */
function vecFetch_(items, o) {
  const result = {};
  let pending = items.slice();
  for (let attempt = 1; attempt <= VEC_TRIES_ && pending.length; attempt++) {
    if (o && o.deadline && Date.now() > Number(o.deadline) - VEC_MIN_LEFT_MS_) break;
    const batches = [];
    const per = typeof openEws_ === 'function' ? openEws_('batch') : VEC_BATCH_;  // row 51: 80 (step S7)
    for (let i = 0; i < pending.length; i += per) batches.push(pending.slice(i, i + per));
    let token = '';
    try { token = ScriptApp.getOAuthToken(); } catch (e) { console.warn(`Vertex AI embeddings: no OAuth token: ${e}`); return result; }
    const requests = batches.map(b => ({
      url: vecUrl_(), method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        instances: b.map(x => ({ content: x.text, task_type: VEC_TASK_ })),
        parameters: { autoTruncate: true },
      }),
    }));
    let responses = [];
    try { responses = UrlFetchApp.fetchAll(requests) || []; } catch (e) {
      console.warn(`Vertex AI embeddings: ${(e && e.message) || e}`);
      responses = [];
    }
    const retry = [];
    batches.forEach((b, bi) => {
      const r = responses[bi];
      let code = 599;
      let text = '';
      try { code = r ? r.getResponseCode() : 599; text = r ? String(r.getContentText() || '') : ''; } catch (e) { code = 599; }
      if (code === 200) {
        let preds = [];
        try { preds = JSON.parse(text).predictions || []; } catch (e) { preds = []; }
        b.forEach((x, j) => {
          const vals = preds[j] && preds[j].embeddings && preds[j].embeddings.values;
          if (Array.isArray(vals) && vals.length === VEC_DIMS_) result[x.key] = vals;
        });
      } else if (code === 429 || code >= 500) {
        retry.push(...b);
      } else {
        console.warn(`Vertex AI embeddings ${code}: ${text.slice(0, 200)}`);
      }
    });
    pending = retry;
    if (pending.length && attempt < VEC_TRIES_) Utilities.sleep(1500 * attempt);
  }
  if (pending.length) console.warn(`Vertex AI embeddings: ${pending.length} text(s) got no vector this run`);
  return result;
}

/**
 * The `k` items closest in meaning to `vec` ([{item, sim}], most similar first), of `items` whose vector `vecOf(item)`
 * gives (items without one are skipped). Pure.
 */
function vecNearest_(vec, items, vecOf, k) {
  if (!vec) return [];
  const scored = [];
  (items || []).forEach(item => {
    const v = vecOf(item);
    if (v) scored.push({ item, sim: vecCos_(vec, v) });
  });
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, Math.max(0, k || 0) || scored.length);
}

/**
 * Groups by meaning: for each vector in order, the index of the earlier leader it is most similar to at `minSim` or
 * above, else its own index (it leads a new group). Put the most important item first: it leads its group. A missing
 * vector leads a group of its own. Pure.
 */
function vecLeaders_(vecs, minSim) {
  const leaders = [];
  return (vecs || []).map((v, i) => {
    if (v) {
      let best = -1;
      let bestSim = -1;
      leaders.forEach(li => {
        const s = vecCos_(v, vecs[li]);
        if (s >= minSim && s > bestSim) { best = li; bestSim = s; }
      });
      if (best >= 0) return best;
    }
    leaders.push(i);
    return i;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The official taxonomy by meaning
// ---------------------------------------------------------------------------------------------------------------

/**
 * The official taxonomy (config: exposure_tags and sensitive_topics) as the texts its vectors come from:
 * [{kind: 'exposure' | 'sensitive', name, priority, text}], each tag's name, its official description and its other
 * names. Pure (reads GEN).
 */
function vecTaxonomy_() {
  const row = (kind, t) => ({
    kind, name: t.name, priority: kind === 'exposure' ? String(t.priority || '') : 'Sensitive Topic',
    text: `${t.name}. ${t.description || ''}${(t.aliases || []).length ? ` Also called: ${t.aliases.join('; ')}.` : ''}`,
  });
  return (GEN.exposure_tags || []).map(t => row('exposure', t))
    .concat((GEN.sensitive_topics || []).map(t => row('sensitive', t)));
}

const VEC_TAG_HINTS_ = { exposure: 3, sensitive: 2 };

/**
 * For each vector, the official tags closest to it in meaning: {exposure: [{name, priority, sim}] (VEC_TAG_HINTS_
 * .exposure of them), sensitive: [{name, sim}] (VEC_TAG_HINTS_.sensitive)}, null for a missing vector. A hint for the
 * review, never a decision: the review reads the official descriptions and decides. Never throws.
 */
function vecTagHintsOfVecs_(vecs, opts) {
  const tax = vecTaxonomy_();
  const tagVecs = vecPacked_('tax', tax.map(t => t.text), opts);
  const tags = tax.map((t, i) => Object.assign({ vec: tagVecs[i] }, t));
  const exposure = tags.filter(t => t.kind === 'exposure');
  const sensitive = tags.filter(t => t.kind === 'sensitive');
  const round = s => Math.round(s * 1000) / 1000;
  return (vecs || []).map(v => (v ? {
    exposure: vecNearest_(v, exposure, t => t.vec, VEC_TAG_HINTS_.exposure)
      .map(x => ({ name: x.item.name, priority: x.item.priority, sim: round(x.sim) })),
    sensitive: vecNearest_(v, sensitive, t => t.vec, VEC_TAG_HINTS_.sensitive)
      .map(x => ({ name: x.item.name, sim: round(x.sim) })),
  } : null));
}

/** vecTagHintsOfVecs_ for texts (embedded first). Never throws. */
function vecTagHints_(texts, opts) {
  return vecTagHintsOfVecs_(embedTexts_(texts || [], opts), opts);
}

/** One line for a prompt: a text's closest official tags by meaning, e.g. "P1 Product - Policy Update (0.71); …". Pure. */
function vecTagHintLine_(hint) {
  if (!hint) return '';
  const e = (hint.exposure || []).map(x => `${x.priority} ${x.name} (${x.sim.toFixed(2)})`).join('; ');
  const s = (hint.sensitive || []).map(x => `${x.name} (${x.sim.toFixed(2)})`).join('; ');
  return [e && `Exposure Tags: ${e}`, s && `Sensitive Topics: ${s}`].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------------------------------------------
// Evergreen noise: the chatter the SLRR playbook never alerts (e.g. "just Google it", "Shot on Pixel" with no
// commentary, sponsored sports posts). The 16 topics and their examples are the ones DSD.evergreen_vectors held (read
// 2026-11-11); the bot now embeds them itself. Only the 8 strict topics ever mark a post as noise.
// The bar was calibrated on real texts (600 Sprinklr comments and DSD story-selection snippets, Nov 11) plus labeled
// examples: true noise scored 0.72-0.90 against its topic, real issues 0.51-0.76 (a risky post that names Captain
// America: 0.762), real junk at most 0.786. At 0.80 no real issue in the samples is marked noise; noise below the bar
// simply goes to the normal review.
// ---------------------------------------------------------------------------------------------------------------

const VEC_EVERGREEN_ = [
  { id: 'captain_america', label: 'Captain America meme variations', example: 'Captain America meme about Google', strict: true },
  { id: 'conspiracy', label: 'Conspiracy / collusion allegations', example: 'Google collusion or conspiracy theories', strict: false },
  { id: 'degoogle', label: 'DeGoogling / leaving Google', example: 'I am trying to degoogle and remove all Google tools from my life', strict: false },
  { id: 'employee_moves', label: 'Employees starting or leaving Google', example: 'New employee joining Google or leaving the company', strict: false },
  { id: 'gmail_accounts', label: 'Many Gmail accounts jokes', example: 'Jokes about having too many Gmail accounts', strict: true },
  { id: 'google_as_verb', label: 'Google used as a verb / without using Google', example: 'Without using Google name something or Google it', strict: true },
  { id: 'google_me', label: 'Google Me / Google it', example: 'Just Google me or Google it', strict: true },
  { id: 'green_blue_text', label: 'Green text vs blue text debate', example: 'Green text vs blue text iMessage debate', strict: false },
  { id: 'grok_vs_google', label: 'Grok vs Google', example: 'Grok vs Google which is better', strict: false },
  { id: 'hacked_banned', label: 'Hacked or banned accounts', example: 'My Google account was hacked or banned', strict: false },
  { id: 'internet_quality', label: 'Internet quality / Google making internet worse', example: 'Google is making the internet worse internet quality is declining', strict: false },
  { id: 'maps_exploring', label: 'Exploring random / ugly places on Maps', example: 'Exploring random places on Google Maps until I find something ugly', strict: true },
  { id: 'maps_jokes', label: 'Maps jokes / life without Maps', example: 'Jokes about life without Google Maps', strict: true },
  { id: 'product_quality_drop', label: 'Perceived drop in product quality', example: 'Google product quality has dropped recently', strict: false },
  { id: 'shot_on_pixel', label: 'Shot on Pixel with no commentary', example: 'Shot on Pixel #TeamPixel', strict: true },
  { id: 'sponsored_sports', label: 'Sponsored sports posts', example: 'Sponsored post from NBA McLaren Arsenal Manchester United', strict: true },
];
const VEC_EVERGREEN_MIN_SIM_ = 0.80;

/**
 * For each vector, its closest evergreen topic: {id, label, strict, sim} (null for a missing vector). Embeds only the
 * 16 topics (packed in the cache). Never throws.
 */
function vecEvergreenOfVecs_(vecs, opts) {
  const ex = vecPacked_('evergreen', VEC_EVERGREEN_.map(t => `${t.label}: ${t.example}`), opts);
  const topics = VEC_EVERGREEN_.map((t, i) => Object.assign({ vec: ex[i] }, t));
  return (vecs || []).map(v => {
    const [best] = v ? vecNearest_(v, topics, t => t.vec, 1) : [];
    return best ? { id: best.item.id, label: best.item.label, strict: best.item.strict, sim: Math.round(best.sim * 1000) / 1000 } : null;
  });
}

/** vecEvergreenOfVecs_ for texts (embedded first). Never throws. */
function vecEvergreen_(texts, opts) {
  return vecEvergreenOfVecs_(embedTexts_(texts || [], opts), opts);
}

/** True when a match from vecEvergreen_ is evergreen noise: a strict topic at VEC_EVERGREEN_MIN_SIM_ or above. Pure. */
function vecIsEvergreenNoise_(match) {
  return !!(match && match.strict && match.sim >= VEC_EVERGREEN_MIN_SIM_);
}
