/**
 * Watchdog.gs — catches a background step that keeps getting the bot's run stopped (stuck on a call, or looping until
 * Apps Script's 6-minute limit), so one bad step can't stall every run and keep firing the same calls.
 *
 * Each background step (after the alerts: the Early detection check and review, Temp checks, Proactive watch, the
 * Results / Follow-up / Analysis refreshes, Signals) runs through bgStep_(name, fn): its name goes in the script cache
 * before it starts and comes out when it ends, error or not. A run that Apps Script stops partway never takes it out,
 * so the next run (wdStartRun_, at the start of poll()) knows which step it was in and counts it. WD_DEATHS_ of them
 * within WD_WINDOW_MS_ and the step is paused for WD_PAUSE_MS_, when the Signals tab's "Pause a background step that
 * keeps getting stuck" is ON (OFF, as it starts: only reported there and in the log). The alerts themselves (the main
 * flow, the auto-correct and Other alerts spaces) are never wrapped, so never paused.
 * Runaway API calls are also held back by ApiGuard.gs (background work defers while Gemini or BigQuery calls run high),
 * by the per-item try limits (messages, write-backs, relays, drafts, the watch's windows and its 4-minute job cancel),
 * and on Cloud Run by slrr-signals' own guards (circuit breakers with backoff, budgets, dead letters).
 */

const WD_RUNNING_KEY_ = 'wd_running';        // CacheService: the background step in progress {name, at}
const WD_STATE_PROP_ = 'WD_STATE';           // {deaths: {step: [ms...]}, paused: {step: until ms}, last: {name, at, n, paused}}
const WD_DEATHS_ = 3;                        // runs stopped in the same step...
const WD_WINDOW_MS_ = 60 * 60 * 1000;        // ...within an hour...
const WD_PAUSE_MS_ = 30 * 60 * 1000;         // ...pause it this long (when the switch is ON)
let WD_RUN_STATE_ = null;                    // this run's copy of WD_STATE (read once a run)

function wdState_() {
  if (WD_RUN_STATE_) return WD_RUN_STATE_;
  try {
    const s = JSON.parse(PropertiesService.getScriptProperties().getProperty(WD_STATE_PROP_) || '{}') || {};
    WD_RUN_STATE_ = { deaths: s.deaths || {}, paused: s.paused || {}, last: s.last || null };
  } catch (e) {
    WD_RUN_STATE_ = { deaths: {}, paused: {}, last: null };
  }
  return WD_RUN_STATE_;
}

/**
 * The state after a run stopped in step `name` at `now`: its stops within the last hour (the newest 10), and, when
 * `pausing`, a pause once there are WD_DEATHS_; pauses that ended are dropped. Pure.
 */
function wdAfterDeath_(st, name, now, pausing) {
  const deaths = Object.assign({}, st && st.deaths);
  const list = (deaths[name] || []).filter(t => now - Number(t) < WD_WINDOW_MS_).concat([now]).slice(-10);
  deaths[name] = list;
  const paused = Object.assign({}, st && st.paused);
  Object.keys(paused).forEach(k => { if (Number(paused[k]) <= now) delete paused[k]; });
  if (pausing && list.length >= WD_DEATHS_) paused[name] = now + WD_PAUSE_MS_;
  return { deaths, paused, last: { name, at: now, n: list.length, paused: !!paused[name] } };
}

/** Whether step `name` is paused now (and pausing is ON). Pure. */
function wdIsPaused_(st, name, now, pausing) {
  return !!pausing && !!st && !!st.paused && Number(st.paused[name]) > now;
}

/**
 * At the start of a run: a step the last run never finished counts against that step (and may pause it). Returns the
 * stop it recorded ({name, at, n, paused}) or null. Never throws.
 */
function wdStartRun_() {
  WD_RUN_STATE_ = null;
  try {
    const cache = CacheService.getScriptCache();
    const raw = cache.get(WD_RUNNING_KEY_);
    if (!raw) return null;
    cache.remove(WD_RUNNING_KEY_);
    const running = JSON.parse(raw) || {};
    if (!running.name) return null;
    const pausing = typeof sigFlags_ === 'function' && !!sigFlags_().watchdog;
    const st = wdAfterDeath_(wdState_(), String(running.name), Date.now(), pausing);
    WD_RUN_STATE_ = st;
    PropertiesService.getScriptProperties().setProperty(WD_STATE_PROP_, JSON.stringify(st));
    console.warn(`watchdog: the last run stopped during "${running.name}" (${st.last.n} in the last hour)` +
      (st.last.paused ? `: paused for ${WD_PAUSE_MS_ / 60000} minutes` : ''));
    return st.last;
  } catch (e) {
    console.warn('watchdog: ' + ((e && e.message) || e));
    return null;
  }
}

/** Runs background step `name` (fn) unless it's paused, marked as running while it runs. fn()'s result (paused: undefined). */
function bgStep_(name, fn) {
  let cache = null;
  try {
    const pausing = typeof sigFlags_ === 'function' && !!sigFlags_().watchdog;
    const st = wdState_();
    if (wdIsPaused_(st, name, Date.now(), pausing)) {
      console.log(`watchdog: "${name}" is paused until ${pwTime_(Number(st.paused[name]))} ET (it kept getting runs stopped)`);
      return undefined;
    }
    cache = CacheService.getScriptCache();
    cache.put(WD_RUNNING_KEY_, JSON.stringify({ name, at: Date.now() }), 6 * 3600);
  } catch (e) {
    cache = null;  // the watchdog never stops a step from running
  }
  try {
    return fn();
  } finally {
    try { if (cache) cache.remove(WD_RUNNING_KEY_); } catch (e) { /* best effort */ }
  }
}

/** The Signals tab's watchdog row: ON or OFF, what's paused, the last stop. Pure but for the clock. */
function wdStatusText_(pausing) {
  const st = wdState_();
  const now = Date.now();
  const paused = Object.keys(st.paused || {}).filter(k => Number(st.paused[k]) > now);
  const head = pausing
    ? `✓ ON: a background step that stops ${WD_DEATHS_} runs within an hour is paused ${WD_PAUSE_MS_ / 60000} min (alerts never are)`
    : 'OFF: a step that keeps stopping runs is only reported here (alerts are never paused either way)';
  const now_ = paused.length ? ` · paused now: ${paused.map(k => `${k} until ${pwTime_(Number(st.paused[k]))} ET`).join(', ')}` : '';
  const last = st.last ? ` · last stop: "${st.last.name}" at ${pwTime_(Number(st.last.at))} ET (${st.last.n} in that hour)` : '';
  return head + now_ + last;
}
