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
        if (g || b || d) out[m] = d ? { g, b, d } : { g, b };
      }
    });
  } catch (e) {}
  return out;
}

/** Records `count` outbound API calls of `kind` ('gemini' | 'bigquery' | 'decisions') in the rolling minute buckets. Never throws. */
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
  if (checkGemini && (c.gemini10m >= API_GUARD_GEMINI_10M_ || c.gemini60m >= API_GUARD_GEMINI_60M_)) return false;
  if (checkBq && (c.bq10m >= API_GUARD_BQ_10M_ || c.bq60m >= API_GUARD_BQ_60M_)) return false;
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
  return c.decisions10m < API_GUARD_DECISIONS_10M_ && c.decisions60m < API_GUARD_DECISIONS_60M_;
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
  } catch (e) {}
}

/** Clears the Vertex AI 429 cooldown immediately once a probe succeeds. Never throws. */
function apiGuardClearVertex429_() {
  try {
    if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) return;
    CacheService.getScriptCache().remove(API_GUARD_V429_KEY_);
  } catch (e) {}
}
