/**
 * service.js — one temp check, start to finish, and the short list of things the web page can ask for.
 *
 * A temp check is always a look back from now. It can be built two ways:
 *
 *   from a Brandwatch query   the numbers are Brandwatch's own (hourly volume, sentiment, sources, mention types,
 *                             engagement), read through its API with no export; the posts behind the write-up are its
 *                             most-engaged ones, X's words filled in from X's embed data or our alert rows.
 *   with no query yet         (an alert has just fired and nobody has built the query) a Boolean query stands in for
 *                             it: typed, built from the filter form, the story card's own, or drafted broad by Gemini
 *                             from the alert. Brandwatch is asked first, through its standing Google queries (every
 *                             mention of Google) searched with that Boolean: the numbers are then Brandwatch's own,
 *                             and the write-up says where they come from. When Brandwatch has nothing for it (or
 *                             can't be asked), everything comes from our own tables and the write-up says that. No
 *                             concern level either way: past issues are ranked by their own queries' counts.
 *
 * Either way our own tables are searched alongside with the same Boolean (converted by fixed rules), so the two counts
 * sit next to each other, and what was gathered is kept (store.js) so a later run can reuse it instead of searching
 * again.
 */
'use strict';

const crypto = require('crypto');
const bw = require('./brandwatch');
const tc = require('./tempcheck');
const q = require('./bwquery');
const own = require('./owndata');
const gemini = require('./gemini');
const xposts = require('./xposts');
const benchmark = require('./benchmark');
const store = require('./store');

const SINCE_MAX_MS = 31 * 24 * tc.HOUR;
const OWN_LOOK_MS = 24 * tc.HOUR;      // with no Brandwatch query: the day before the alert (or before now)
const OWN_KEEP = 3000;                 // posts kept with a temp check, for reuse

/** An error that is the asker's to fix (a bad time, no issue named): shown as it is, not as a failure. */
function userError(message) {
  const e = new Error(message);
  e.user = true;
  return e;
}

/** The Boolean query to search our tables with: what was typed, else the filter form, else the Brandwatch query's own. */
function chooseBoolean(o, query) {
  const typed = String((o && o.boolean) || '').trim();
  if (typed) return { text: typed, origin: 'typed' };
  const form = q.fromFilters(o && o.filters);
  if (form) return { text: form, origin: 'filters' };
  if (query && query.boolean) return { text: query.boolean, origin: 'query' };
  return { text: '', origin: '' };
}

/** The chart's points: the full hours (the hour still running left off), as the bot's chart draws them. */
function chartOf(d) {
  const cur = tc.floorHour(d.now);
  let pts = (d.hours || []).filter(h => h.at < cur);
  if (pts.length < 2) pts = d.hours || [];
  return { title: tc.chartTitle(d), unit: d.basis === 'own' ? 'Posts' : 'Mentions', points: pts.map(h => ({ label: tc.chartTick(h.at), n: h.n })) };
}

/**
 * What stands behind Brandwatch's count of `what` (a query's id, or several ids with a `search` inside them) from
 * `from` to `now`: {b (its breakdowns), posts (the write-up's), linkPosts (what Gemini reads), coverage (where the words
 * of its X posts came from)}. X's words are filled in from X's embed data, else our alert rows.
 */
async function bwReading(what, search, from, now, step) {
  step('Reading sentiment, sources, mention types and the top posts from Brandwatch');
  const b = await bw.breakdowns(what, from, now, search);
  const all = b.top.concat(b.neg);
  const xIds = Array.from(new Set(all.filter(p => p.x && p.id).map(p => p.id))).slice(0, tc.X_MAX);
  let embed = {};
  let rows = {};
  if (xIds.length) {
    step(`Looking up the words of ${xIds.length} X posts (X's embed data, and our alert rows)`);
    [embed, rows] = await Promise.all([xposts.lookup(xIds), own.findXPosts(xIds, from, now)]);
  }
  const xPosts = Object.assign({}, rows, embed);  // X's own data wins (it has likes and replies); our rows fill the gaps
  const seen = new Set();
  const withText = all.map(p => tc.postWithText(p, xPosts)).filter(p => {
    if (!p || !p.text || seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  });
  const topOrder = new Map();
  b.top.forEach((p, i) => { if (p && p.key && !topOrder.has(p.key)) topOrder.set(p.key, i); });
  const ranked = withText.filter(p => topOrder.has(p.key)).sort((x, y) => {
    const ex = tc.postEngVal(x);
    const ey = tc.postEngVal(y);
    return ex !== ey ? ey - ex : (topOrder.get(x.key) || 0) - (topOrder.get(y.key) || 0);
  });
  const posts = ranked.slice(0, tc.WRITEUP_POSTS);
  const keys = new Set(posts.map(p => p.key));
  const linkPosts = posts.concat(withText.filter(p => !keys.has(p.key))).slice(0, tc.GEMINI_POSTS);
  const coverage = { ranked: all.length, x: xIds.length, fromEmbed: xIds.filter(id => embed[id]).length,
    inAlertRows: xIds.filter(id => rows[id]).length, fromAlertRowsOnly: xIds.filter(id => rows[id] && !embed[id]).length,
    noWords: xIds.filter(id => !rows[id] && !embed[id]).length };
  return { b, posts, linkPosts, coverage };
}

/** Brandwatch's side of a temp check on `query`: its numbers and its top posts with their words. */
async function fromBrandwatch(query, o, step) {
  const now = o.now;
  step('Reading the hourly counts from Brandwatch');
  const bwUrl = await bw.dashboardUrl(query);
  const prev = o.prev && o.prev.basis === 'brandwatch' && o.prev.query && o.prev.window ? o.prev : null;
  let look = o.since || (prev ? prev.window.from : Math.max(now - tc.LOOK_MAX_MS, (query.created || now) - tc.BEFORE_QUERY_MS));
  look = tc.floorHour(look);
  const hours = await bw.hourly(query.id, look, now);
  const start = o.since ? { at: look, why: 'since' } : prev ? { at: look, why: String(prev.window.why || 'spike') }
    : tc.start(hours, { alertAt: o.alertAt, created: query.created, look });
  const counted = hours.filter(h => h.at >= start.at);
  const total = counted.reduce((a, h) => a + h.n, 0);
  const r = await bwReading(query.id, '', start.at, now, step);
  const d = { basis: 'brandwatch', issue: o.issue, query: { id: query.id, name: query.name, created: query.created, pct: query.pct },
    bwUrl, now, start, total, hours: counted, velocity: tc.velocity(counted, start.at, now), sentiment: r.b.sentiment,
    sources: r.b.sources, mentionTypes: r.b.mentionTypes, engSources: r.b.engSources, posts: r.posts, linkPosts: r.linkPosts,
    update: prev && !o.since ? { at: Number(prev.at), tot: Number(prev.total) || 0 } : null };
  return { d, look, allHours: hours, coverage: r.coverage };
}

/**
 * Brandwatch's side of a temp check on an issue that has no query of its own yet: its standing Google queries (every
 * mention of Google, one query a language and platform) searched with `search`, the Boolean standing in for the
 * issue's query. The numbers are Brandwatch's own. Counted over the same stretch our own tables are searched over:
 * the 24 hours before the alert (or before now), a time asked for, or the stretch of the temp check this one updates.
 * Returns {d, look, allHours, coverage} as fromBrandwatch does, or {skip (why Brandwatch is not the basis), standing}
 * when there are no standing queries or none of their mentions matches.
 */
async function fromStanding(search, o, step) {
  const list = await bw.standing();
  if (!list.length) return { skip: 'Brandwatch has no active standing Google query under the name the app looks for.', standing: null };
  const now = o.now;
  const before = o.prev && !o.prev.query && o.prev.window ? o.prev : null;   // an earlier one with no query of its own
  const look = tc.floorHour(o.since || (before ? before.window.from : (o.alertAt || now) - OWN_LOOK_MS));
  step(`Asking Brandwatch for the mentions that match, in its ${list.length} standing Google queries`);
  const ids = list.map(x => x.id);
  const hours = await bw.hourly(ids, look, now, search);
  const total = hours.reduce((a, h) => a + h.n, 0);
  const standing = { queries: list.length, names: list.map(x => x.name), search, total };
  if (!total) return { skip: 'Brandwatch\'s standing Google queries hold no mention that matches this query in that stretch.', standing };
  const start = { at: look, why: o.since ? 'since' : 'look' };
  const r = await bwReading(ids, search, look, now, step);
  const same = before && before.basis === 'brandwatch' && before.standing ? before : null;  // only a Brandwatch count is compared with one
  const d = { basis: 'brandwatch', issue: o.issue, query: null, standing, bwUrl: '', now, start, total, hours,
    velocity: tc.velocity(hours, look, now), sentiment: r.b.sentiment, sources: r.b.sources, mentionTypes: r.b.mentionTypes,
    engSources: r.b.engSources, posts: r.posts, linkPosts: r.linkPosts,
    update: same && !o.since ? { at: Number(same.at), tot: Number(same.total) || 0 } : null };
  return { d, look, allHours: hours, coverage: r.coverage };
}

/**
 * Our own tables' side: the converted query, and its posts between `from` and `now`. With `o.reuse` (an earlier temp
 * check that kept posts from at least as far back) the kept posts are filtered in memory and only the time since they
 * were gathered is searched afresh.
 */
async function fromOwnData(chosen, o, from, now, step) {
  const out = { boolean: chosen.text, origin: chosen.origin, window: { from, to: now } };
  if (!chosen.text) {
    out.error = 'There is no query to search our own data with. Type one, fill in the filters, or pick a Brandwatch query.';
    return out;
  }
  const conv = q.convert(chosen.text);
  out.report = conv.report;
  if (!conv.ok) { out.error = conv.error; return out; }
  const sources = (o.sources && o.sources.length ? o.sources : Object.keys(own.SOURCES)).filter(k => own.SOURCES[k]);
  const kept = o.reuse && o.reuse.own && Array.isArray(o.reuse.own.posts) && o.reuse.own.window ? o.reuse.own : null;
  let res;
  if (kept && kept.window.from <= from && kept.window.to > from) {
    step('Filtering the posts gathered earlier, and searching our tables for what came after');
    const old = kept.posts.filter(p => p.at >= from && p.at < kept.window.to && q.evaluate(conv.plan, p));
    const fresh = await own.search(conv.plan, tc.floorHour(kept.window.to), now, sources);
    const byKey = new Map();
    old.concat(fresh.posts).forEach(p => { if (!byKey.has(p.key)) byKey.set(p.key, p); });
    const posts = Array.from(byKey.values()).sort((a, b) => (b.eng === null ? -1 : b.eng) - (a.eng === null ? -1 : a.eng));
    res = Object.assign({ tables: fresh.tables, posts, complete: fresh.complete && kept.complete !== false }, own.numbersOf(posts, from, now));
    out.reused = { id: o.reuse.id, gatheredAt: kept.window.to, kept: old.length, since: fresh.posts.length,
      note: 'Posts up to then are the ones the earlier search found. If this query is wider than that one, search afresh.' };
  } else {
    step(`Searching our own tables (${sources.map(k => own.SOURCES[k].label).join(' and ')})`);
    res = await own.search(conv.plan, from, now, sources);
  }
  return Object.assign(out, { tables: res.tables, complete: res.complete, total: res.total, hours: res.hours, byPlatform: res.byPlatform,
    engByPlatform: res.engByPlatform, sentiment: res.sentiment, spread: res.spread, posts: res.posts.slice(0, OWN_KEEP) });
}

/**
 * One temp check. `input`: {query (a Brandwatch query's name, link or id), issue (its name, when there is no query),
 * since (ms: count from here instead of the issue's start), alertAt (ms: when the alert fired), updateOf (an earlier
 * temp check's id: this one is its update), own: {on, boolean, filters, sources, reuse (an earlier temp check's id),
 * fallback (a wider query to try when the first matches nothing), drafted (what Gemini drafted, to keep)}, writeup
 * (false: no Gemini lines), standing (false: with no query, don't ask Brandwatch's standing queries), trigger
 * ('analyst' | 'alert'), alertText}. `step(text)` is told what is being done.
 * Returns the kept record, or {needs: 'query', choices, near, missing} when the query named can't be told.
 */
async function run(input, step) {
  const t0 = Date.now();
  const now = t0;
  const say = typeof step === 'function' ? step : () => {};
  const inp = input || {};
  const prev = inp.updateOf ? store.read(inp.updateOf) : null;
  if (inp.updateOf && !prev) throw userError('The temp check to update was not found.');
  let since = Number(inp.since) || 0;
  if (since && (since > now || now - since > SINCE_MAX_MS)) throw userError('"Count from" must be in the past and within the last 31 days.');
  if (since) since = tc.floorHour(since);
  const alertAt = Number(inp.alertAt) > 0 && Number(inp.alertAt) <= now ? Number(inp.alertAt) : 0;

  let query = null;
  const ref = String(inp.query || '').trim() || (prev && prev.query ? String(prev.query.id) : '');
  if (ref) {
    say('Finding the Brandwatch query');
    const found = await bw.findQuery(ref);
    if (!found.query) return { needs: 'query', ref, choices: found.choices || [], near: found.near || [], missing: found.missing || 0 };
    query = found.query;
    if (query.state && query.state !== 'active') {
      throw userError(`"${query.name}" is ${query.state} in Brandwatch, and Brandwatch only gives numbers for an active query.`);
    }
  }
  const issue = tc.truncate(String(inp.issue || '').replace(/\s+/g, ' ').trim() || (query ? tc.issueName(query.name) : (prev ? prev.issue : '')), 140);
  if (!issue) throw userError('Pick a Brandwatch query, or name the issue.');
  const ownIn = Object.assign({ on: !query }, inp.own || {});
  if (!query) ownIn.on = true;  // with no Brandwatch query, our own tables are all there is
  const reuse = ownIn.reuse ? store.read(ownIn.reuse) : null;

  // The Boolean our tables are searched with; with no Brandwatch query, it is also what Brandwatch's standing queries
  // are searched with (an update keeps the one the earlier temp check used, unless another is given)
  const before = !query && prev && !prev.query && prev.window ? prev : null;
  const chosen = chooseBoolean(ownIn, query || (before && before.own ? { boolean: before.own.boolean } : null));
  if (!query && chosen.origin === 'query') chosen.origin = 'kept';  // the earlier temp check's own query, not Brandwatch's

  let side = null;
  let standing = null;  // what came of asking Brandwatch's standing queries, when there is no query to ask
  if (query) {
    side = await fromBrandwatch(query, { now, since, alertAt, prev, issue }, say);
  } else if (chosen.text && inp.standing !== false) {
    try {
      const got = await fromStanding(chosen.text, { now, since, alertAt, prev, issue }, say);
      if (got.d) { side = got; standing = got.d.standing; }
      else standing = Object.assign({ queries: 0, search: chosen.text, total: 0 }, got.standing || {}, { skipped: got.skip });
    } catch (e) {  // Brandwatch busy, or a query it won't take as a search: our own tables still answer
      standing = { queries: 0, search: chosen.text, total: 0, skipped: `Brandwatch could not be asked: ${bw.scrub(String((e && e.message) || e))}` };
    }
  }

  let ownOut = null;
  if (ownIn.on) {
    const from = side ? side.d.start.at : since || (before ? before.window.from : tc.floorHour((alertAt || now) - OWN_LOOK_MS));
    ownOut = await fromOwnData(chosen, { sources: ownIn.sources, reuse }, from, now, say);
    // A drafted query that finds nothing: once more with its wider form (the subject alone), and the record says so
    const wider = String(ownIn.fallback || '').trim();
    if (!side && !ownOut.error && ownOut.total === 0 && wider && wider !== chosen.text) {
      say('Nothing matched the drafted query: searching for the subject alone');
      const first = ownOut;
      ownOut = await fromOwnData({ text: wider, origin: 'typed' }, { sources: ownIn.sources }, from, now, say);
      ownOut.widened = { from: first.boolean, why: 'The drafted query matched nothing, so every post about the subject was gathered instead.' };
    }
    if (ownIn.drafted) ownOut.drafted = { why: String(ownIn.drafted.why || ''), subject: String(ownIn.drafted.subject || ''), angle: String(ownIn.drafted.angle || '') };
  }

  let d;
  if (side) {
    d = side.d;
  } else {
    if (ownOut.error) throw userError(ownOut.error);
    const from = ownOut.window.from;
    const prevOwn = prev && prev.basis === 'own' ? prev : null;
    const posts = ownOut.posts.filter(p => p.text).map(own.asWriteupPost);
    d = { basis: 'own', issue, query: null, bwUrl: '', now, start: { at: from, why: since ? 'since' : 'look' }, total: ownOut.total,
      hours: ownOut.hours, velocity: tc.velocity(ownOut.hours, from, now), sentiment: ownOut.sentiment, sources: ownOut.byPlatform,
      mentionTypes: [], engSources: ownOut.engByPlatform, posts: posts.slice(0, tc.WRITEUP_POSTS), linkPosts: posts.slice(0, tc.GEMINI_POSTS),
      update: prevOwn && !since ? { at: Number(prevOwn.at), tot: Number(prevOwn.total) || 0 } : null };
  }

  if (d.total && inp.writeup !== false) {
    say(`Asking Gemini for the summary, negativity drivers and themes (${d.linkPosts.length} posts read)`);
    d.gem = await gemini.writeLines(d, d.linkPosts);
  } else {
    d.gem = { why: d.total ? 'the write-up lines were not asked for' : 'nothing was counted' };
  }

  // The concern level: only for Brandwatch's count from the issue's own start (a count from a time asked for, or a
  // count of posts in our tables, can't be ranked against past issues' mention counts)
  let level = null;
  if (side && query && d.start.why !== 'since') {
    benchmark.noteCurve(query, side.look, side.allHours, now);
    const kept = store.readBenchmark();
    level = benchmark.level({ queryId: query.id, startAt: d.start.at, now, total: d.total }, kept.issues, kept.known);
  } else {
    level = { label: '', why: !side ? 'A count of posts in our own tables is not ranked against past issues\' Brandwatch mention counts.'
      : !query ? 'A count found by searching Brandwatch\'s standing Google queries is not ranked against past issues, which are ranked by their own queries\' counts.'
        : 'A count from a time you chose is not ranked against past issues.' };
  }
  d.level = level;

  const w = tc.writeup(d);
  say('Saving');
  const rec = store.save({
    at: now, trigger: inp.trigger === 'alert' ? 'alert' : 'analyst', issue, title: w.title, basis: d.basis, query: d.query, bwUrl: d.bwUrl,
    queryBoolean: query ? query.boolean : '', alertAt, alertText: tc.truncate(String(inp.alertText || '').trim(), 3000),
    window: { from: d.start.at, to: now, why: d.start.why, look: side ? side.look : d.start.at },
    total: d.total, hours: d.hours, velocity: d.velocity, sentiment: d.sentiment, sources: d.sources, mentionTypes: d.mentionTypes,
    engSources: d.engSources, posts: d.posts, readPosts: d.linkPosts, update: d.update, gem: d.gem, level,
    coverage: side ? side.coverage : null, standing, own: ownOut, writeup: w, chart: chartOf(d), updateOf: prev ? prev.id : '',
    brandwatch: bw.usageNow(), took: Date.now() - t0,
  });
  return rec;
}

// ---------------------------------------------------------------------------------------------------------------
// Runs in the background (a temp check takes 10-40 seconds), so the page can show what is being done
// ---------------------------------------------------------------------------------------------------------------

const jobs = new Map();

function startJob(work) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, status: 'running', steps: [], startedAt: Date.now() };
  jobs.set(id, job);
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value);
  const step = text => job.steps.push({ at: Date.now(), text: String(text) });
  Promise.resolve().then(() => work(step)).then(out => {
    if (out && out.needs) Object.assign(job, { status: 'needs', needs: out });
    else Object.assign(job, { status: 'done', recordId: out.id });
  }).catch(e => {
    const busy = e && e.bw && (e.code === 429 || Number(e.code) >= 500);
    Object.assign(job, { status: 'failed', user: !!(e && e.user),
      error: busy ? `Brandwatch is busy right now (${e.message}). Try again in a minute.` : bw.scrub(String((e && e.message) || e)) });
    if (!(e && e.user) && !busy) console.error(`temp check failed: ${bw.scrub(String((e && e.stack) || e))}`);
  }).then(() => { job.endedAt = Date.now(); });
  return job;
}

/** Starts a temp check (run) in the background: the job, to ask about with `job`. */
function start(input) { return startJob(step => run(input, step)); }

/** Starts `work(step)` in the background (it returns {id: a temp check's id, or ''}): the job, to ask about with `job`. */
function background(work) { return startJob(work); }

/**
 * Starts a temp check the moment an alert fires, before anyone has built a Brandwatch query: `a` is {issue, text (the
 * alert post's words), url, alertAt, boolean (a query to use; when there is none, Gemini drafts a broad one from the
 * issue and the post)}. It gathers from our own tables and keeps what it finds, for the analyst's own run to reuse.
 * A drafted query is "(subject) AND (words about it)"; when that matches nothing, the subject alone is searched.
 */
function startFromAlert(a) {
  const al = a || {};
  return startJob(async step => {
    const issue = String(al.issue || '').trim();
    if (!issue) throw userError('Name the issue the alert is about.');
    let boolean = String(al.boolean || '').trim();
    let drafted = null;
    if (!boolean) {
      step('Drafting a broad query from the alert (Gemini)');
      drafted = await gemini.suggestQuery([issue, al.text, al.url].filter(Boolean).join('\n'));
      boolean = drafted.boolean;
    }
    return run({ issue, alertAt: Number(al.alertAt) || Date.now(), alertText: [al.text, al.url].filter(Boolean).join('\n'), trigger: 'alert',
      own: { on: true, boolean, sources: al.sources, drafted, fallback: drafted ? drafted.wide : '' } }, step);
  });
}

function job(id) { return jobs.get(String(id)) || null; }

/**
 * What a query would become, without running a temp check: {boolean, origin, ok, error, report} and, with
 * `o.estimate`, {estimate: {[table]: {bytes} | {skip}}} (what searching each table would scan: free to ask).
 */
async function preview(o) {
  const inp = o || {};
  let query = null;
  if (inp.query) {
    const found = await bw.findQuery(String(inp.query));
    query = found.query || null;
  }
  const chosen = chooseBoolean(inp, query);
  if (!chosen.text) return { boolean: '', origin: '', ok: false, error: 'There is no query to convert yet.', report: null };
  const conv = q.convert(chosen.text);
  const out = { boolean: chosen.text, origin: chosen.origin, ok: conv.ok, error: conv.error || '', report: conv.report };
  if (conv.ok && inp.estimate) {
    const now = Date.now();
    const since = Number(inp.since) || 0;
    const from = tc.floorHour(since && since < now ? since : query ? Math.max(now - tc.LOOK_MAX_MS, (query.created || now) - tc.BEFORE_QUERY_MS) : now - OWN_LOOK_MS);
    out.window = { from, to: now };
    const est = await own.preview(conv.plan, from, now, inp.sources);
    out.estimate = {};
    Object.keys(est).forEach(k => { out.estimate[k] = est[k].skip ? { skip: est[k].skip } : { bytes: est[k].bytes, removed: est[k].removed }; });
    out.sql = Object.keys(est).filter(k => est[k].sql).map(k => ({ table: own.SOURCES[k].label, sql: est[k].sql }));
  }
  return out;
}

/** The newest [G EVENT] queries whose name has every word of `text` (all of the newest when it is empty), 40 at most. */
async function queries(text, fresh) {
  const ws = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  const list = (await bw.listQueries(!!fresh)).filter(x => tc.GEVENT_RX.test(x.name));
  return list.filter(x => { const n = x.name.toLowerCase(); return ws.every(w => n.indexOf(w) >= 0); })
    .sort((a, b) => b.id - a.id).slice(0, 40);
}

module.exports = { run, start, background, startFromAlert, job, preview, queries, chooseBoolean, chartOf, userError };
