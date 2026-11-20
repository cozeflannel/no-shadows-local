/**
 * benchmark.js — the concern level: where an issue's volume ranks against the past year's Google issues.
 *
 * The team's rule (the Brand Safety Temp Check doc): compare the issue's mentions with every Google issue of the past 12
 * months at the same number of hours since each one started, and name the band it falls in:
 *
 *   HIGH             top 1-20%          Action
 *   MODERATELY HIGH  top 21-39%         Action
 *   MODERATE         bottom 41% - top 40%   Monitor
 *   MODERATELY LOW   bottom 21-40%      Monitor
 *   LOW              bottom 1-20%       No action
 *
 * The comparison needs each past issue's hourly curve. This file keeps one per [G EVENT] query (store.js,
 * data/benchmark.json): 48 hours before the query was made to 5 days after, read from Brandwatch's volume endpoint (one
 * call an issue, nothing downloaded). Brandwatch only answers for queries that are still active, and the team
 * deactivates old ones, so a curve has to be saved while its query is live: every temp check saves its issue's curve,
 * and `fill` reads the ones that are still readable. The level says how many issues it was compared with.
 *
 * This is this app's reading of the rule, not the team's own benchmark (go/bs-database). Check it against that
 * until the two have been compared.
 */
'use strict';

const bw = require('./brandwatch');
const tc = require('./tempcheck');
const store = require('./store');

const YEAR_MS = 365 * 24 * tc.HOUR;
const CURVE_HOURS = 7 * 24;   // 48 hours before the query was made, 5 days after
const MIN_ISSUES = 20;        // fewer past issues than this: no level is given
const AT_ONCE = 3;
const FULL_SHARE = 0.9;       // holding this share of the past year's issues: "the past 12 months" is true to say
const SHARE_OF_LIMIT = 0.3;   // the shared login's calls a minute this may use before it waits (other tools use it too)

let job = { running: false, done: 0, total: 0, added: 0, failed: 0, stopped: '', startedAt: 0, endedAt: 0 };

/** The hours kept for an issue whose query was made at `created`: {from, to} (ms), never past `now`. Pure. */
function curveWindow(created, now) {
  const from = tc.floorHour(created - tc.BEFORE_QUERY_MS);
  return { from, to: Math.min(tc.floorHour(now) + tc.HOUR, from + CURVE_HOURS * tc.HOUR) };
}

/**
 * A kept issue ({created, from, hours: [n per hour from `from`]}) as its running total from where it started (the
 * first hour with 100+ mentions, else when its query was made): {startAt, why, cum: [total after 1 h, after 2 h, …]}. Pure.
 */
function curve(issue) {
  const hours = (issue.hours || []).map((n, i) => ({ at: issue.from + i * tc.HOUR, n: Number(n) || 0 }));
  const st = tc.start(hours, { created: issue.created, look: issue.from });
  const cum = [];
  let sum = 0;
  hours.filter(h => h.at >= st.at).forEach(h => { sum += h.n; cum.push(sum); });
  return { startAt: st.at, why: st.why, cum };
}

/** The band for an issue above all but `top` percent of past issues (1-99): {label, side, pct, action}. Pure. */
function band(top) {
  const t = Math.max(1, Math.min(99, Math.round(top)));
  const label = t <= 20 ? 'HIGH' : t <= 39 ? 'MODERATELY HIGH' : t <= 59 ? 'MODERATE' : t <= 79 ? 'MODERATELY LOW' : 'LOW';
  const action = t <= 39 ? 'Action' : t <= 79 ? 'Monitor' : 'No action';
  return t <= 50 ? { label, side: 'top', pct: t, action } : { label, side: 'bottom', pct: 100 - t, action };
}

/**
 * The concern level of an issue with `cur.total` mentions `cur.now - cur.startAt` after it started, against `issues`
 * (the kept curves; `cur.queryId`'s own is left out): {label, side, pct, action, n, hours, since (the oldest issue
 * compared with), known (`known`: how many issues Brandwatch lists for the past year), fullYear (nearly all of those
 * are held, so "the past 12 months" is true to say)} or, with fewer than
 * MIN_ISSUES to compare with, {label: '', n, need, why}. An issue younger than `cur` is at that age is not compared
 * (its count at that age is not known yet) unless its five days are over. Pure.
 */
function level(cur, issues, known) {
  const hours = Math.max(1, Math.ceil((cur.now - cur.startAt) / tc.HOUR));
  const inYear = Number(known) || 0;
  let held = 0;
  const values = [];
  let oldest = 0;
  Object.keys(issues || {}).forEach(id => {
    const issue = issues[id];
    if (!issue || !(issue.created >= cur.now - YEAR_MS)) return;
    held++;
    if (Number(id) === Number(cur.queryId)) return;
    const c = curve(issue);
    if (!c.cum.length || (c.cum.length < hours && !issue.final)) return;
    values.push(c.cum[Math.min(hours, c.cum.length) - 1]);
    if (!oldest || issue.created < oldest) oldest = issue.created;
  });
  if (values.length < MIN_ISSUES) {
    return { label: '', n: values.length, need: MIN_ISSUES, hours,
      why: `Only ${values.length} past issue${values.length === 1 ? '' : 's'} can be compared at ${hours} hour${hours === 1 ? '' : 's'} in. ${MIN_ISSUES} are needed.` };
  }
  const below = values.filter(v => v < cur.total).length;
  const same = values.filter(v => v === cur.total).length;
  const top = 100 - ((below + same / 2) / values.length) * 100;
  const year = inYear > 0 ? Math.max(inYear, held) : 0;  // a temp check on a new query adds one before the next fill
  return Object.assign(band(top), { n: values.length, hours, since: oldest, known: year, fullYear: year > 0 && held >= year * FULL_SHARE });
}

/** True when Brandwatch's own count of this minute's calls is past SHARE_OF_LIMIT of the login's limit ("1000/1m"). Pure. */
function nearLimit(usage) {
  const limit = Number((/^(\d+)/.exec(String((usage && usage.limit) || '')) || [])[1]) || 0;
  const used = Number((usage && usage.used) || 0);
  return limit > 0 && used > limit * SHARE_OF_LIMIT;
}

/** Keeps `query`'s curve when `hours` ([{at, n}] from `look`) is the standard window for it (a temp check on a new query reads exactly that). */
function noteCurve(query, look, hours, now) {
  if (!query || !query.id || !query.created || !tc.GEVENT_RX.test(String(query.name || ''))) return false;
  const w = curveWindow(query.created, now);
  if (look !== w.from || !hours || !hours.length) return false;
  const b = store.readBenchmark();
  const kept = hours.filter(h => h.at < w.to);
  b.issues[query.id] = { id: query.id, name: query.name, created: query.created, from: w.from, hours: kept.map(h => h.n),
    fetchedAt: now, final: w.from + CURVE_HOURS * tc.HOUR <= now };
  b.updatedAt = now;
  store.writeBenchmark(b);
  return true;
}

/** What is kept: {issues, final, oldest, newest, updatedAt, job}. */
function status() {
  const b = store.readBenchmark();
  const all = Object.keys(b.issues).map(id => b.issues[id]).filter(Boolean);
  const created = all.map(i => i.created).filter(Boolean).sort((a, c) => a - c);
  return { issues: all.length, final: all.filter(i => i.final).length, oldest: created[0] || 0, newest: created[created.length - 1] || 0,
    known: Number(b.known) || 0, updatedAt: b.updatedAt || 0, minIssues: MIN_ISSUES, job: Object.assign({}, job) };
}

/**
 * Reads from Brandwatch the curve of every [G EVENT] query of the past 12 months that is still active and not kept yet
 * (or kept before its five days were over), newest first, `max` at most, AT_ONCE at a time. Stops when Brandwatch says it
 * is busy (429) rather than use up the shared login's calls. Starts the work and returns at once: see status().job.
 */
async function fill(max) {
  if (job.running) return status();
  const now = Date.now();
  const list = (await bw.listQueries(true)).filter(q => tc.GEVENT_RX.test(q.name) && q.created >= now - YEAR_MS);
  const b = store.readBenchmark();
  b.known = list.length;  // every [G EVENT] query of the past year, readable or not: what a level's "N of M" is out of
  const todo = list.filter(q => q.state === 'active' && !(b.issues[q.id] && b.issues[q.id].final))
    .sort((a, c) => c.id - a.id).slice(0, Math.max(1, Math.min(400, Number(max) || 400)));
  job = { running: true, done: 0, total: todo.length, added: 0, failed: 0, stopped: '', startedAt: now, endedAt: 0,
    deactivated: list.filter(q => q.state !== 'active' && !b.issues[q.id]).length };
  let next = 0;
  const worker = async () => {
    while (next < todo.length && !job.stopped) {
      if (nearLimit(bw.usageNow())) { await new Promise(r => setTimeout(r, 20000)); continue; }  // leave room for the bot
      const q = todo[next++];
      const w = curveWindow(q.created, now);
      try {
        const hours = await bw.hourly(q.id, w.from, w.to);
        b.issues[q.id] = { id: q.id, name: q.name, created: q.created, from: w.from, hours: hours.map(h => h.n), fetchedAt: now,
          final: w.from + CURVE_HOURS * tc.HOUR <= now };
        job.added++;
      } catch (e) {
        if (e && e.bw && (e.code === 429 || e.code === 401)) job.stopped = e.message;
        else job.failed++;
      }
      job.done++;
      if (job.done % 15 === 0) { b.updatedAt = Date.now(); store.writeBenchmark(b); }
    }
  };
  Promise.all(Array.from({ length: AT_ONCE }, worker)).catch(e => { job.stopped = String((e && e.message) || e); }).then(() => {
    b.updatedAt = Date.now();
    store.writeBenchmark(b);
    job.running = false;
    job.endedAt = Date.now();
  });
  return status();
}

module.exports = { MIN_ISSUES, CURVE_HOURS, curveWindow, curve, band, level, nearLimit, noteCurve, status, fill };
