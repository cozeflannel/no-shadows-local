/**
 * ApiGuard.gs — baseline API spike and quota protection, always active with zero Control tab settings.
 *
 * Guarantees that live SLA alert triage (reading/copying Burson spaces, reviewing incoming alerts, answering thread
 * questions, and sending Social Alert drafts/emails) is never delayed or throttled, while preventing runaway API spikes:
 *   1. Rolling 10-minute and 60-minute call telemetry (`gemini` and `bigquery`) in CacheService: non-SLA background
 *      workloads (Direct BigQuery synthesis, Early wave checks, Proactive watch new looks, Watch 24h press searches, and
 *      idle periodic tab refreshes) automatically defer whenever the main SLA pass is catching up on a burst (`slaBusy`)
 *      or rolling API volume exceeds baseline high-water marks, reserving full quota and run budget for SLA alerts.
 *   2. Short Vertex AI HTTP 429 cooldown (`API_GUARD_V429_MS_`): when Vertex AI rate-limits all tries of a call, the next
 *      30 seconds skip 3x retry amplification (and multi-second retry sleeps): text calls route straight to the BigQuery
 *      ML fallback (`bqGeminiFallback_`) for faster SLA completion, and non-fallback calls make at most 1 fast probe.
 *   3. Gemini Decisions calls (`decisions`: Decisions.gs, the early-wave fast triage, Control row 38) are counted in the
 *      same minute buckets under their own kind, with their own rolling ceilings (`apiGuardAllowDecisions_`). They are
 *      background work only, so they never count against the Gemini or BigQuery ceilings above, and past their own
 *      ceilings the fast triage stops asking (each signal is then handled as it was before the fast triage).
 */

const API_GUARD_CACHE_KEY_ = 'api_guard_v1';
const API_GUARD_CACHE_SEC_ = 2 * 3600;
const API_GUARD_KEEP_MIN_ = 60;

// Rolling call ceilings above which non-SLA background tasks defer until the window cools down (live SLA never defers)
const API_GUARD_GEMINI_10M_ = 25;
const API_GUARD_GEMINI_60M_ = 90;
const API_GUARD_BQ_10M_ = 50;
const API_GUARD_BQ_60M_ = 180;

// Rolling ceilings for Gemini Decisions calls (the fast triage's own: past either, it stops asking until the window cools)
const API_GUARD_DECISIONS_10M_ = 30;  // two full checks' worth (DEC_MAX_PER_CHECK_ a check, Decisions.gs)
const API_GUARD_DECISIONS_60M_ = 90;  // as the Gemini 60-minute ceiling: one call a signal, like its one review

// Control row 51 (the open engine, OpenEngine.gs): the rolling ceilings above stay only as a runaway guard, at these
// (the open-engine plan's O3 row 20; Decisions' recorded live limit is about 285 calls a minute)
const API_GUARD_OPEN_GEMINI_10M_ = 120;
const API_GUARD_OPEN_GEMINI_60M_ = 500;
const API_GUARD_OPEN_BQ_10M_ = 150;
const API_GUARD_OPEN_BQ_60M_ = 700;
const API_GUARD_OPEN_DECISIONS_10M_ = 600;
const API_GUARD_OPEN_DECISIONS_60M_ = 2400;

// Vertex AI HTTP 429 retry-storm cooldown (ms)
const API_GUARD_V429_KEY_ = 'api_guard_v429';
const API_GUARD_V429_MS_ = 30 * 1000;

/**
 * Reads and prunes minute-bucketed call counts `{minuteEpoch: {g, b}}` from CacheService (`d`, Gemini Decisions calls,
 * only on a minute that had some). Never throws.
 */
function apiGuardReadBuckets_(nowMs) {
  const now = Number(nowMs) || Date.now();
  const curMin = Math.floor(now / 60000);
  const minKeep = curMin - API_GUARD_KEEP_MIN_ + 1;
  const out = {};
  try {
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return out;
    const raw = CacheService.getScriptCache().get(API_GUARD_CACHE_KEY_);
    const parsed = raw ? JSON.parse(raw) : null;
    const map = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    Object.keys(map).forEach(k => {
      const m = Number(k);
      const v = map[k];
      if (Number.isInteger(m) && m >= minKeep && m <= curMin + 1 && v && typeof v === 'object') {
        const g = Math.max(0, Math.floor(Number(v.g) || 0));
        const b = Math.max(0, Math.floor(Number(v.b) || 0));
        const d = Math.max(0, Math.floor(Number(v.d) || 0));
        // the first screen's own fields (RequirementsFirst.gs): kept beside the others, only on a minute that had some
        const extra = {};
        ['s', 't', 'q'].forEach(f => { const x = Math.max(0, Math.floor(Number(v[f]) || 0)); if (x) extra[f] = x; });
        if (g || b || d || Object.keys(extra).length) out[m] = Object.assign(d ? { g, b, d } : { g, b }, extra);
      }
    });
  } catch (e) {}
  return out;
}

/**
 * Records `count` outbound API calls of `kind` ('gemini' | 'bigquery' | 'decisions'; the first screen's 'screen',
 * 'screen_split' and 'screen_posts') in the rolling minute buckets. Never throws.
 */
function apiGuardNote_(kind, count, nowMs) {
  try {
    const n = Math.max(1, Math.floor(Number(count === undefined ? 1 : count) || 1));
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return;
    const now = Number(nowMs) || Date.now();
    const curMin = Math.floor(now / 60000);
    const buckets = apiGuardReadBuckets_(now);
    const cur = buckets[curMin] || { g: 0, b: 0 };
    if (kind === 'gemini') cur.g += n;
    else if (kind === 'bigquery') cur.b += n;
    else if (kind === 'decisions') cur.d = (Number(cur.d) || 0) + n;
    else if (kind === 'screen') cur.s = (Number(cur.s) || 0) + n;
    else if (kind === 'screen_split') cur.t = (Number(cur.t) || 0) + n;
    else if (kind === 'screen_posts') cur.q = (Number(cur.q) || 0) + n;
    else return;
    buckets[curMin] = cur;
    CacheService.getScriptCache().put(API_GUARD_CACHE_KEY_, JSON.stringify(buckets), API_GUARD_CACHE_SEC_);
  } catch (e) {}
}

/** Rolling 10-minute and 60-minute call counts: `{gemini10m, gemini60m, bq10m, bq60m}`. Never throws. */
function apiGuardCounts_(nowMs) {
  const now = Number(nowMs) || Date.now();
  const curMin = Math.floor(now / 60000);
  const min10 = curMin - 9;
  const buckets = apiGuardReadBuckets_(now);
  let gemini10m = 0;
  let gemini60m = 0;
  let bq10m = 0;
  let bq60m = 0;
  Object.keys(buckets).forEach(k => {
    const m = Number(k);
    const v = buckets[k] || {};
    const g = Number(v.g) || 0;
    const b = Number(v.b) || 0;
    gemini60m += g;
    bq60m += b;
    if (m >= min10) {
      gemini10m += g;
      bq10m += b;
    }
  });
  return { gemini10m, gemini60m, bq10m, bq60m };
}

/**
 * True when non-SLA background tasks may run (`kind`: 'gemini' | 'bigquery' | 'any'). Live SLA triage never calls this
 * gate so incoming alerts and thread replies are always processed immediately under SLA. Never throws.
 */
function apiGuardAllowBackground_(kind, slaBusy, nowMs) {
  if (slaBusy) return false;
  const c = apiGuardCounts_(nowMs);
  const checkGemini = !kind || kind === 'any' || kind === 'gemini';
  const checkBq = !kind || kind === 'any' || kind === 'bigquery';
  // Control row 51 (OpenEngine.gs): the rolling ceilings stay only as a runaway guard (API_GUARD_OPEN_*_); a 429 makes
  // background work wait 10 minutes instead (openNote429_, openMayStart_). OFF: the ceilings as they were
  const open = typeof openOn_ === 'function' && openOn_();
  const g10 = open ? API_GUARD_OPEN_GEMINI_10M_ : API_GUARD_GEMINI_10M_;
  const g60 = open ? API_GUARD_OPEN_GEMINI_60M_ : API_GUARD_GEMINI_60M_;
  const b10 = open ? API_GUARD_OPEN_BQ_10M_ : API_GUARD_BQ_10M_;
  const b60 = open ? API_GUARD_OPEN_BQ_60M_ : API_GUARD_BQ_60M_;
  if (checkGemini && (c.gemini10m >= g10 || c.gemini60m >= g60)) { if (open) openWall_('guard'); return false; }
  if (checkBq && (c.bq10m >= b10 || c.bq60m >= b60)) { if (open) openWall_('guard'); return false; }
  return true;
}

/** Rolling 10-minute and 60-minute Gemini Decisions call counts: `{decisions10m, decisions60m}`. Never throws. */
function apiGuardDecisionsCounts_(nowMs) {
  const now = Number(nowMs) || Date.now();
  const min10 = Math.floor(now / 60000) - 9;
  const buckets = apiGuardReadBuckets_(now);
  let decisions10m = 0;
  let decisions60m = 0;
  Object.keys(buckets).forEach(k => {
    const d = Number((buckets[k] || {}).d) || 0;
    decisions60m += d;
    if (Number(k) >= min10) decisions10m += d;
  });
  return { decisions10m, decisions60m };
}

/**
 * True when one more Gemini Decisions call fits under its own rolling ceilings (API_GUARD_DECISIONS_10M_ / _60M_). The
 * fast triage asks this before every call; SLA triage never makes one. Never throws.
 */
function apiGuardAllowDecisions_(nowMs) {
  const c = apiGuardDecisionsCounts_(nowMs);
  const open = typeof openOn_ === 'function' && openOn_();  // row 51: the runaway guard's ceilings
  return c.decisions10m < (open ? API_GUARD_OPEN_DECISIONS_10M_ : API_GUARD_DECISIONS_10M_) &&
    c.decisions60m < (open ? API_GUARD_OPEN_DECISIONS_60M_ : API_GUARD_DECISIONS_60M_);
}

// The first screen (RequirementsFirst.gs, step S19h): its calls are counted apart (`s`), never as `gemini`, so they never
// stop Early Detection, the Direct poll, the Watch pre-read or anything apiGuardAllowBackground_ gates. Its ceilings
// come from the carry's size (RQ_CARRY_MAX_ posts a check, RQ_SCREEN_MAX_POSTS_ a call): a call and its two halves,
// two checks in 10 minutes and twelve in 60, with one partial call a round, two rounds a run
const API_GUARD_V429_LOG_KEY_ = 'api_guard_v429_log';
const API_GUARD_V429_LOG_MAX_ = 20;

/** The screen's rolling ceilings: {m10: 300, m60: 1,800}. Never throws. */
function apiGuardScreenCeilings_() {
  try {
    const calls = Math.ceil(RQ_CARRY_MAX_ / RQ_SCREEN_MAX_POSTS_);
    return { m10: 3 * (2 * calls + 20), m60: 3 * (12 * calls + 120) };
  } catch (e) {
    return { m10: 300, m60: 1800 };
  }
}

/** The first screen's rolling counts: {screen10m, screen60m, split60m, posts60m}. Never throws. */
function apiGuardScreenCounts_(nowMs) {
  const now = Number(nowMs) || Date.now();
  const min10 = Math.floor(now / 60000) - 9;
  const buckets = apiGuardReadBuckets_(now);
  const out = { screen10m: 0, screen60m: 0, split60m: 0, posts60m: 0 };
  Object.keys(buckets).forEach(k => {
    const v = buckets[k] || {};
    out.screen60m += Number(v.s) || 0;
    out.split60m += Number(v.t) || 0;
    out.posts60m += Number(v.q) || 0;
    if (Number(k) >= min10) out.screen10m += Number(v.s) || 0;
  });
  return out;
}

/** True when `n` more screen calls fit under the screen's own rolling ceilings. Never throws. */
function apiGuardAllowScreen_(n, nowMs) {
  const c = apiGuardScreenCounts_(nowMs);
  const max = apiGuardScreenCeilings_();
  const k = Math.max(0, Number(n) || 0);
  return c.screen10m + k <= max.m10 && c.screen60m + k <= max.m60;
}

/**
 * A Vertex AI 429 met by any try of geminiGenerate_ (Burson's reviews, the Watch pre-read, ...): its time joins a short
 * list (the last 20, 2 hours) the first screen reads, only while the screen marked itself on in the last 10 minutes (the
 * cache flag rq_screen_on); else nothing is written. The cooldown above is untouched. Never throws.
 */
function apiGuardNoteVertex429Try_(nowMs) {
  try {
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return;
    const cache = CacheService.getScriptCache();
    if (!cache.get('rq_screen_on')) return;
    const list = apiGuardVertex429Log_().concat([Number(nowMs) || Date.now()]).slice(-API_GUARD_V429_LOG_MAX_);
    cache.put(API_GUARD_V429_LOG_KEY_, JSON.stringify(list), API_GUARD_CACHE_SEC_);
  } catch (e) {}
}

/** The times of the Vertex AI 429s geminiGenerate_ met lately (apiGuardNoteVertex429Try_), oldest first. Never throws. */
function apiGuardVertex429Log_() {
  try {
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return [];
    const list = JSON.parse(CacheService.getScriptCache().get(API_GUARD_V429_LOG_KEY_) || '[]');
    return Array.isArray(list) ? list.map(Number).filter(x => x > 0) : [];
  } catch (e) {
    return [];
  }
}

/** True while Vertex AI is inside its brief post-429 retry-storm cooldown window. Never throws. */
function apiGuardVertex429Active_(nowMs) {
  try {
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return false;
    const until = Number(CacheService.getScriptCache().get(API_GUARD_V429_KEY_)) || 0;
    const now = Number(nowMs) || Date.now();
    return until > now;
  } catch (e) {
    return false;
  }
}

/** Marks Vertex AI as rate-limited (HTTP 429) for `API_GUARD_V429_MS_` to stop 3x retry amplification. Never throws. */
function apiGuardNoteVertex429_(nowMs) {
  try {
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return;
    const now = Number(nowMs) || Date.now();
    const sec = Math.max(10, Math.ceil(API_GUARD_V429_MS_ / 1000) + 5);
    CacheService.getScriptCache().put(API_GUARD_V429_KEY_, String(now + API_GUARD_V429_MS_), sec);
    if (typeof openNote429_ === 'function') openNote429_(now);  // row 51: background work waits 10 minutes
  } catch (e) {}
}

/** Clears the Vertex AI 429 cooldown immediately once a probe succeeds. Never throws. */
function apiGuardClearVertex429_() {
  try {
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return;
    CacheService.getScriptCache().remove(API_GUARD_V429_KEY_);
  } catch (e) {}
}
