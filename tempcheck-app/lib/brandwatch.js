/**
 * brandwatch.js — reads Brandwatch, and only reads it.
 *
 * Every call is a GET (there is no way to send anything else from this file): the app never creates, edits or deletes a
 * query, dashboard or alert. It uses the team's shared Brandwatch token, the same one the chat bot reads from Secret
 * Manager (the slrr-campaigns service keeps it fresh). The token is held in memory for a few minutes, is never logged or
 * written anywhere, and is cut out of any error text.
 *
 * The counts come from Brandwatch's volume endpoints (nothing is downloaded). The only posts read are the most-engaged
 * ones behind the write-up (TOP + NEG, reposts excluded), because X's export allowance is shared by every Google team.
 *
 * An issue nobody has built a query for yet can still be counted by Brandwatch: the team keeps standing queries that
 * hold every mention of Google (`standing`), and every data call here takes a search to run inside the queries it is
 * asked about. Seen on the one sampled query of the set (not taken from Brandwatch's documentation): Brandwatch gives
 * a sampled query's counts already scaled up to the whole, so one kept mention of a 2% sample counts as about fifty.
 */
'use strict';

const { PROJECT, gfetch } = require('./gcp');
const tc = require('./tempcheck');

const API = 'https://api.brandwatch.com';
const BW_PROJECT = Number(process.env.TEMPCHECK_BW_PROJECT) || 1998344909;  // [SLRR] Private: the team's [G EVENT] queries
const SECRET = process.env.TEMPCHECK_BW_SECRET || 'slrr-campaigns-bw-token';
// The standing queries that together hold every mention of Google: the team's "[V2] MAIN G Landscape" set, one query a
// language and platform. Their "(Benchmarking)" twin is left out: it holds a 2% sample of the same mentions (so a search
// inside it counts in steps of fifty), and counting it too would count every mention twice.
const STANDING_RX = new RegExp(process.env.TEMPCHECK_BW_STANDING || '^\\[V2\\] MAIN G Landscape \\(', 'i');
const STANDING_SKIP_RX = /benchmark/i;
const SEARCH_MAX = 2500;  // characters of a search: it travels in the request's address
const TOKEN_KEEP_MS = 10 * 60 * 1000;
const LIST_KEEP_MS = 30 * 60 * 1000;

let tok = { value: '', until: 0 };
let lists = { queries: null, queriesAt: 0, dash: null, dashAt: 0 };
const usage = { calls: 0, mentionsRead: 0, limit: '', used: '', lastAt: 0 };

async function token(force) {
  if (!force && tok.value && Date.now() < tok.until) return tok.value;
  const res = await gfetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET}/versions/latest:access`);
  const value = Buffer.from(String((res.payload || {}).data || ''), 'base64').toString('utf8').trim();
  if (!value) throw new Error('the shared Brandwatch token in Secret Manager is empty');
  tok = { value, until: Date.now() + TOKEN_KEEP_MS };
  return value;
}

function scrub(s) { return tok.value ? String(s).split(tok.value).join('[token]') : String(s); }

function why(text) {
  let out = String(text || '').slice(0, 200);
  try {
    const j = JSON.parse(text) || {};
    const e = j.error || (Array.isArray(j.errors) ? j.errors[0] : null);
    out = j.error_description || (e && (e.message || (typeof e === 'string' ? e : ''))) || j.message || out;
  } catch (e) { /* not JSON */ }
  return String(out).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * One GET of `path` (starting "/projects/…"), as JSON. A refused token is read afresh once. Throws an Error with `.code`
 * (the HTTP status), `.bw = true` and, for a 429, `.retryAfter` (seconds): Brandwatch being busy is not a bug.
 */
async function get(path) {
  if (!/^\/projects\/\d+\//.test(String(path))) throw new Error('not a Brandwatch project path');
  const once = async force => fetch(API + path, {
    method: 'GET',
    headers: { Authorization: 'bearer ' + await token(force), Accept: 'application/json' },
    signal: AbortSignal.timeout(45000),
  });
  let resp;
  try {
    resp = await once(false);
    if (resp.status === 401) resp = await once(true);
  } catch (e) {
    const err = new Error(`Brandwatch could not be reached: ${scrub((e && e.message) || e)}`);
    err.code = 599;
    err.bw = true;
    throw err;
  }
  usage.calls++;
  usage.lastAt = Date.now();
  usage.limit = resp.headers.get('x-rate-limit') || usage.limit;
  usage.used = resp.headers.get('x-rate-limit-used') || usage.used;
  const text = await resp.text();
  if (resp.status !== 200) {
    const hint = resp.status === 401 ? ' (the shared token was refused)' : resp.status === 429 ? ' (too many calls for now)' : '';
    const err = new Error(scrub(`Brandwatch HTTP ${resp.status}${hint}: ${why(text)}`));
    err.code = resp.status;
    err.bw = true;
    if (resp.status === 429) err.retryAfter = Number(resp.headers.get('retry-after')) || 60;
    throw err;
  }
  try { return JSON.parse(text || '{}') || {}; } catch (e) { return {}; }
}

function shape(q) {
  return { id: Number(q.id), name: String(q.name), created: tc.bwTime(q.creationDate), state: String(q.state || ''),
    pct: q.percentComplete === undefined || q.percentComplete === null ? null : Number(q.percentComplete) };
}

/**
 * The project's queries, [{id, name, created (ms), state ('active' | 'deactivated' | 'draft'), pct}], kept for 30 minutes
 * unless `fresh`. One call (~1 MB). Brandwatch answers data calls only for an active query.
 */
async function listQueries(fresh) {
  if (!fresh && lists.queries && Date.now() - lists.queriesAt < LIST_KEEP_MS) return lists.queries;
  const body = await get(`/projects/${BW_PROJECT}/queries/summary`);
  lists.queries = ((body && body.results) || []).filter(q => q && q.id && q.name).map(shape);
  lists.queriesAt = Date.now();
  return lists.queries;
}

/** One query with its Boolean: {id, name, created, pct, boolean, languages}, or null when the project has none by that id. */
async function getQuery(id) {
  try {
    const q = await get(`/projects/${BW_PROJECT}/queries/${Number(id)}`);
    if (!q || !q.id || !q.name) return null;
    return Object.assign(shape(q), { boolean: String(q.booleanQuery || ''), languages: Array.isArray(q.languages) ? q.languages : [] });
  } catch (e) {
    if (e && (e.code === 404 || e.code === 400 || e.code === 403)) return null;
    throw e;
  }
}

/**
 * The query `ref` names (its name, link or id): {query} with its Boolean, or {choices} / {near} / {missing} as
 * tempcheck.matchQuery gives them. A name is matched in the kept list first, then afresh.
 */
async function findQuery(ref) {
  const id = tc.queryId(ref);
  if (id) {
    const q = await getQuery(id);
    return q ? { query: q } : { choices: [], near: [], missing: id };
  }
  let got = tc.matchQuery(ref, await listQueries(false));
  if (!got.query) got = tc.matchQuery(ref, await listQueries(true));
  if (!got.query) return got;
  return { query: (await getQuery(got.query.id)) || got.query };
}

/** The Brandwatch link for `query`: its dashboard in the project when one points at it, else the project's queries list. */
async function dashboardUrl(query) {
  const fallback = `https://app.brandwatch.com/project/${BW_PROJECT}/queries`;
  const qid = Number(query && query.id) || 0;
  if (!qid) return fallback;
  try {
    const stale = !lists.dash || Date.now() - lists.dashAt > LIST_KEEP_MS ||
      (!lists.dash[qid] && query.created && Date.now() - query.created < LIST_KEEP_MS);
    if (stale) {
      const body = await get(`/projects/${BW_PROJECT}/dashboards/summary`);
      const pairs = (Array.isArray(body) ? body : ((body && body.results) || []))
        .map(d => [Number(d && d.settings && d.settings.queryId) || 0, Number(d && d.id) || 0]).filter(p => p[0] && p[1])
        .sort((a, b) => b[1] - a[1]);  // the newest dashboard wins when several point at one query
      const map = {};
      pairs.forEach(([q, d]) => { if (!map[q]) map[q] = d; });
      lists.dash = map;
      lists.dashAt = Date.now();
    }
  } catch (e) {
    if (e && e.bw && (e.code === 429 || Number(e.code) >= 500)) throw e;
    return fallback;
  }
  const dash = lists.dash && lists.dash[qid];
  return dash ? `https://app.brandwatch.com/project/${BW_PROJECT}/dashboards/${dash}` : fallback;
}

const iso = ms => encodeURIComponent(new Date(ms).toISOString());

/** The standing Google queries that are active, oldest first: [{id, name}]. From the kept list of queries unless `fresh`. */
async function standing(fresh) {
  return (await listQueries(!!fresh)).filter(q => q.state === 'active' && STANDING_RX.test(q.name) && !STANDING_SKIP_RX.test(q.name))
    .sort((a, b) => a.id - b.id).map(q => ({ id: q.id, name: q.name }));
}

/**
 * The part of a data call that says which mentions are meant: query `what` (an id, or a list of ids: their mentions
 * together) and, with `search`, only the ones that match it (Brandwatch's own query language). Pure.
 */
function scope(what, search) {
  const ids = (Array.isArray(what) ? what : [what]).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Error('no Brandwatch query to ask about');
  const s = String(search || '').trim();
  if (s.length > SEARCH_MAX) {
    const e = new Error(`the query is ${s.length} characters, too long to send to Brandwatch as a search (${SEARCH_MAX} at most)`);
    e.user = true;
    throw e;
  }
  return ids.map(n => `queryId=${n}`).join('&') + (s ? `&search=${encodeURIComponent(s)}` : '');
}

/**
 * Mentions by hour from `from` to `to` (ms): [{at, n}], of query `what` (an id, or a list: counted together), only the
 * ones matching `search` when given. One call; nothing is downloaded.
 */
async function hourly(what, from, to, search) {
  const body = await get(`/projects/${BW_PROJECT}/data/volume/queries/hours?${scope(what, search)}&startDate=${iso(from)}&endDate=${iso(to)}`);
  return tc.hourly(body, from, to);
}

/**
 * Everything else a temp check needs for the window, in one round of six calls: {sentiment, sources, mentionTypes,
 * engSources, top, neg}. `top` / `neg` are the most-engaged posts (TOP) and the most-engaged negative ones (NEG),
 * reposts excluded; X's come without their words. `what` and `search` as `hourly` takes them.
 */
async function breakdowns(what, from, to, search) {
  const base = `/projects/${BW_PROJECT}/data`;
  const win = `${scope(what, search)}&startDate=${iso(from)}&endDate=${iso(to)}`;
  const posts = `${base}/mentions?${win}&orderBy=engagementScore&orderDirection=desc&xthreadEntryType=share`;
  const got = await Promise.all([
    get(`${base}/volume/queries/sentiment?${win}`),
    get(`${base}/volume/queries/pageTypes?${win}`),
    get(`${base}/volume/queries/threadEntryTypes?${win}`),
    get(`${base}/engagementScore/queries/pageTypes?${win}`),
    get(`${posts}&pageSize=${tc.TOP}`),
    get(`${posts}&pageSize=${tc.NEG}&sentiment=negative`),
  ]);
  usage.mentionsRead += [got[4], got[5]].reduce((n, b) => n + ((b && Array.isArray(b.results)) ? b.results.length : 0), 0);
  return { sentiment: tc.values(got[0]), sources: tc.sourceCounts(got[1]), mentionTypes: tc.mentionTypeCounts(got[2]),
    engSources: tc.sourceCounts(got[3]), top: tc.mentions(got[4]), neg: tc.mentions(got[5]) };
}

/** What this run of the app has asked of Brandwatch: {calls, mentionsRead, limit, used, lastAt}. No secrets. */
function usageNow() { return Object.assign({}, usage); }

module.exports = { BW_PROJECT, SEARCH_MAX, get, listQueries, getQuery, findQuery, dashboardUrl, standing, scope, hourly, breakdowns, usageNow, scrub };
