/**
 * BrandwatchLive.gs — Brandwatch read live for Early Detection (Control row 49, written OFF; "bwl" in code): new
 * mentions, never X, from the queries the owner ticks Read = ON on the New sources tab, handed to Early Detection as a
 * parcel that the check takes into a BigQuery job of its own (EarlyWaveSource.gs).
 *
 * One entry point, bwLiveRun_(runStart, switches), called once a run after the Watch's block. It never throws, and it
 * does nothing at all (no Secret Manager read, no Brandwatch call, no property, no cache item, no tab) unless row 49
 * (edBwLive) and Early Detection's own row (earlyWave, row 19) are ON in `switches`. It reads only when all hold: no
 * parcel waits for its job; bwLiveEveryMs_() since the last read; BWL_MIN_LEFT_MS_ of the run left; not paused or
 * stopped; this reader made fewer than bw_live_calls_per_10min calls in the last 10 minutes; at least one query ticked.
 *
 * A read (bwlRead_), as the plan's Q2 says:
 *   GET /projects/{bw_live_project_id}/data/mentions with every ticked query (at most bw_live_queries_max), posted in
 *   the last 72 hours, added since the mark `taken` less 5 minutes (Brandwatch's own overlap recipe), oldest added
 *   first, one page of bw_live_page_size (a second only under the stall rule, and only with BWL_PAGE2_LEFT_MS_ left),
 *   the sources of bwlSources_ (never twitter, never linkedin), English, reposts out, new mentions only.
 *   Two marks: `taken` (the newest `added` of a parcel whose job was collected) and `read` (the newest `added` a read
 *   returned, kept or dropped, never moved back). The parcel carries `to`; taken = to only when its job is collected
 *   (bwlParcelCollected_), so a lost parcel is read again. No repeats: within a read by query and mention id and by the
 *   post's link key, across reads by the ids of the overlap kept in BWL_STATE (and, in the check, by the new lanes'
 *   post-key index). The first read after the row goes ON reads bw_live_first_minutes back; after a pause a read never
 *   reaches back more than 2 hours, and the note says what was skipped.
 *   Every page is checked: `added` must not go down along it, and none may be more than a minute before "added since";
 *   an X mention must not be there. Any of these stops the source until its row is turned OFF and ON (the plan's Q11).
 *
 * Budgets (Q3, as the plan's owner amended it: no ceiling of mentions a day and no pacing): this reader's own calls in
 * any 10 minutes; the shared login's call count read on every answer (x-rate-limit-used, any letter case), a pause of 10
 * minutes once it reaches bw_live_pause_at_used; HTTP 429: 10 minutes; 401: tried again at the next read, hourly after
 * three in a row; any other refusal: an hour; Brandwatch down or slow to answer: the next read. BWL_DAY keeps the day's
 * calls and mentions (Eastern day), never cleared by turning the row OFF (bwLiveOff_ clears only marks, parcel, stops).
 *
 * The token is read at use (ProactiveWatch.gs pwBwToken_) and never stored, logged or written. Every text from outside
 * is scrubbed (NewSources.gs nsrcScrub_: the token out, addresses out) before it is kept, logged or shown. Only GET
 * requests go to Brandwatch: bwlGet_ is the only fetch here and it sends no method and no payload.
 */

const BWL_STATE_PROP_ = 'BWL_STATE';      // marks, parcel, ledger, pauses and stops (< EWS_PROP_MAX_CHARS_)
const BWL_DAY_PROP_ = 'BWL_DAY';          // the day's calls and mentions (Eastern day), never cleared by OFF
const BWL_PARCEL_PREFIX_ = 'ews:bwl:p:';  // the parcel's cache items, 0 to BWL_PARCEL_ITEMS_ - 1
const BWL_PARCEL_ITEMS_ = 6;
const BWL_PARCEL_ITEM_CHARS_ = 90000;
const BWL_PARCEL_TTL_S_ = 6 * 3600;
const BWL_QUERIES_KEY_ = 'bwl:queries';    // the project's queries read today (cache, 25 hours)
const BWL_TEXT_CHARS_ = 1500;             // a mention's words kept in the parcel (the hash reads 1,500 characters)
const BWL_OVERLAP_MS_ = 5 * 60 * 1000;    // each read starts this long before `taken`
const BWL_MAX_BACK_MS_ = 2 * 60 * 60 * 1000;  // after a pause a read never reaches back more than this
const BWL_HOURS_ = 72;                    // only mentions posted in the last 72 hours
const BWL_MIN_LEFT_MS_ = 60 * 1000;       // a read starts only with this much of the run left
const BWL_PAGE2_LEFT_MS_ = 45 * 1000;     // a second page only with this much left
const BWL_PAUSE_MS_ = 10 * 60 * 1000;     // the shared login busy, or HTTP 429
const BWL_HOUR_MS_ = 60 * 60 * 1000;      // a refusal, or the key refused three times in a row
const BWL_LEDGER_MS_ = 10 * 60 * 1000;    // the window of this reader's own calls
const BWL_EARLY_MS_ = 60 * 1000;          // a mention added more than this before "added since": the filter was ignored
const BWL_OV_MAX_ = 300;                  // overlap ids kept to drop repeats across reads
const BWL_STALE_MS_ = 4 * 60 * 60 * 1000; // no mention for this long is said in the note
const BWL_GAP_SHOWN_MS_ = 6 * 60 * 60 * 1000;  // a skipped stretch is said in the note this long
const BWL_ACCOUNT_DAY_ = 600000;          // what the owner's Brandwatch account allows a day (shown, never applied)
const BWL_REFUSED_RX_ = /^(?:twitter|x|linkedin.*)$/i;  // never asked for, whatever a setting says

// ---------------------------------------------------------------------------------------------------------------
// Settings and stored values
// ---------------------------------------------------------------------------------------------------------------

/** The reader's settings (burson_qa bw_live_*), each with its default when missing or not a number. Pure (reads GEN). */
function bwLiveCfg_() {
  const s = (typeof GEN !== 'undefined' && GEN && GEN.settings) || {};
  const n = (name, d, min) => {
    const v = s[name];
    const x = v === null || v === undefined || v === '' || typeof v === 'boolean' || !isFinite(Number(v)) ? d : Math.floor(Number(v));
    return Math.max(min, x);
  };
  const list = Array.isArray(s.bw_live_sources) ? s.bw_live_sources : ['reddit', 'bluesky', 'facebook', 'facebook_public',
    'instagram', 'instagram_public', 'tiktok', 'youtube', 'threads', 'tumblr', 'forum'];
  return {
    project: n('bw_live_project_id', PW_BW_PROJECT_, 1),
    sources: list.map(x => String(x || '').trim().toLowerCase()).filter(Boolean),
    queriesMax: n('bw_live_queries_max', 20, 1),
    pageSize: n('bw_live_page_size', 300, 1),
    parcelMax: n('bw_live_parcel_max', 300, 1),
    everyMinutes: n('bw_live_every_minutes', 10, 1),
    firstMinutes: n('bw_live_first_minutes', 30, 1),
    callsPer10: n('bw_live_calls_per_10min', 20, 1),
    pauseAtUsed: n('bw_live_pause_at_used', 450, 1),
    sourceTypeNew: s.bw_live_source_type_new !== false,
  };
}

/** The least time between two reads (ms): bw_live_every_minutes. The one place a faster rhythm would change it. */
function bwLiveEveryMs_() {
  return bwLiveCfg_().everyMinutes * 60 * 1000;
}

/**
 * BWL_STATE: {taken, read (ms), first (ms the row was first read since ON), last (ms of the last read), lm (ms the last
 * mention was added), parcel: {to, n, parts, at, fails, q: {id: n}} | null, cl: [the times, in seconds, of this
 * reader's calls in the last 10 minutes], ov: [ids of the last read's overlap], no: 1 (the next read asks with no
 * overlap, once), split (the ticked queries are read in this many calls), u401 (refusals of the key in a row), pause:
 * {until, kind, why, since, used, limit} | null, stop: {kind, why, since, n} | null, fail: {kind, why, since} | null,
 * login: {used, limit, at} | null, qd / md (UTC days the query list and the sources were read), srcs: [the sources
 * /metrics listed], gap: {ms, at} | null, lr: {at, n, x, rep, nw, ms, calls}}. Never throws.
 */
function bwlState_(props) {
  let st = null;
  try { st = JSON.parse(props.getProperty(BWL_STATE_PROP_) || 'null'); } catch (e) { st = null; }
  if (!st || typeof st !== 'object' || Array.isArray(st)) st = {};
  st.cl = Array.isArray(st.cl) ? st.cl : [];
  st.ov = Array.isArray(st.ov) ? st.ov : [];
  return st;
}

/** Saves BWL_STATE under EWS_PROP_MAX_CHARS_ (the overlap ids go first, then the ledger's oldest). Never throws. */
function bwlSaveState_(props, st) {
  try {
    let json = JSON.stringify(st);
    while (json.length > EWS_PROP_MAX_CHARS_ && st.parcel && Array.isArray(st.parcel.ov) && st.parcel.ov.length) {
      st.parcel.ov = st.parcel.ov.slice(Math.ceil(st.parcel.ov.length / 2));
      json = JSON.stringify(st);
    }
    while (json.length > EWS_PROP_MAX_CHARS_ && st.ov.length) { st.ov = st.ov.slice(Math.ceil(st.ov.length / 2)); json = JSON.stringify(st); }
    while (json.length > EWS_PROP_MAX_CHARS_ && st.cl.length) { st.cl.shift(); json = JSON.stringify(st); }
    if (json.length <= EWS_PROP_MAX_CHARS_) props.setProperty(BWL_STATE_PROP_, json);
  } catch (e) {
    console.warn(`Brandwatch live: couldn't save its state: ${nsrcScrub_((e && e.message) || e, 200)}`);
  }
}

/** The Eastern day 'YYYY-MM-DD' of ms. */
function bwlEtDay_(ms) {
  return Utilities.formatDate(new Date(Number(ms) || Date.now()), GEN.timezone || 'America/New_York', 'yyyy-MM-dd');
}

/**
 * BWL_DAY for the Eastern day of `now`: {day, calls, mentions (every mention Brandwatch returned), used (handed over),
 * x, rep (repeats dropped), nw: {source: no words}, src: {source: mentions}, dl: [five delay buckets], q: {query id:
 * [mentions, handed over]}, lost (mentions of parcels dropped after two failed jobs), prev: {source: mentions}
 * (yesterday's, to name a source that gave none for a whole day)}. A new day starts from zero, keeping yesterday's
 * sources in `prev`. Never throws.
 */
function bwlDay_(props, now) {
  let d = null;
  try { d = JSON.parse(props.getProperty(BWL_DAY_PROP_) || 'null'); } catch (e) { d = null; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) d = {};
  const day = bwlEtDay_(now);
  if (d.day !== day) {
    const prev = d.day && d.src && typeof d.src === 'object' ? d.src : null;
    d = { day, prev: prev || {} };
  }
  ['calls', 'mentions', 'used', 'x', 'rep', 'lost'].forEach(k => { d[k] = Math.max(0, Number(d[k]) || 0); });
  ['nw', 'src', 'q', 'prev'].forEach(k => { d[k] = d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]) ? d[k] : {}; });
  d.dl = [0, 1, 2, 3, 4].map(i => Math.max(0, Number((Array.isArray(d.dl) ? d.dl : [])[i]) || 0));
  return d;
}

/** Saves BWL_DAY (the query counts trimmed to the 50 busiest when long). Never throws. */
function bwlSaveDay_(props, d) {
  try {
    let json = JSON.stringify(d);
    if (json.length > EWS_PROP_MAX_CHARS_) {
      const keep = Object.keys(d.q).sort((a, b) => (d.q[b][0] || 0) - (d.q[a][0] || 0)).slice(0, 50);
      const q = {};
      keep.forEach(k => { q[k] = d.q[k]; });
      d.q = q;
      json = JSON.stringify(d);
    }
    if (json.length <= EWS_PROP_MAX_CHARS_) props.setProperty(BWL_DAY_PROP_, json);
  } catch (e) {
    console.warn(`Brandwatch live: couldn't save the day's counts: ${nsrcScrub_((e && e.message) || e, 200)}`);
  }
}

/** The delay bucket of a mention (0-4: 15 min, 1 h, 3 h, 12 h, more), from posting to added. Pure. */
function bwlBucket_(posted, added) {
  const m = (Number(added) - Number(posted)) / 60000;
  if (!(Number(posted) > 0) || !(Number(added) > 0) || !isFinite(m)) return -1;
  return m <= 15 ? 0 : m <= 60 ? 1 : m <= 180 ? 2 : m <= 720 ? 3 : 4;
}

/** A short id of a mention, for the overlap's list: 12 hex characters. Pure. */
function bwlId_(m) {
  const k = String((m && (m.resourceId || m.guid || m.url)) || '');
  return k ? ewsKeyHash_(k).slice(0, 12) : '';
}

// ---------------------------------------------------------------------------------------------------------------
// The request (pure) and the one fetch
// ---------------------------------------------------------------------------------------------------------------

/**
 * The sources to ask for: the setting's names (`wanted`) that today's /metrics answer also lists (`listed`; when it
 * could not be read, the setting's names), never twitter, X or any linkedin source, whatever is listed. Pure.
 */
function bwlSources_(wanted, listed) {
  const ok = s => !BWL_REFUSED_RX_.test(s);
  const want = (Array.isArray(wanted) ? wanted : []).map(x => String(x || '').trim().toLowerCase()).filter(x => x && ok(x));
  if (!Array.isArray(listed) || !listed.length) return Array.from(new Set(want));
  const have = new Set(listed.map(x => String(x || '').trim().toLowerCase()));
  return Array.from(new Set(want.filter(x => have.has(x))));
}

/**
 * The URL of one call of a read: {project, queries: [ids], start, end, since (ms), pageSize, page, sources: [names],
 * sourceTypeNew}. Every parameter of the plan's Q2: the queries repeated, posted between start and end, added since,
 * oldest added first, one page, each source repeated (never twitter or linkedin: refused here too), English, reposts
 * out, new mentions only. Pure.
 */
function bwlRequestUrl_(o) {
  const x = o || {};
  const enc = v => encodeURIComponent(String(v));
  const iso = ms => new Date(Number(ms)).toISOString();
  const parts = [];
  (x.queries || []).forEach(id => parts.push(`queryId=${enc(id)}`));
  parts.push(`startDate=${enc(iso(x.start))}`, `endDate=${enc(iso(x.end))}`, `sinceAdded=${enc(iso(x.since))}`,
    'orderBy=added', 'orderDirection=asc', `pageSize=${enc(x.pageSize)}`, `page=${enc(x.page || 0)}`);
  (x.sources || []).filter(s => !BWL_REFUSED_RX_.test(String(s))).forEach(s => parts.push(`pageType=${enc(s)}`));
  parts.push('language=en', 'xthreadEntryType=share');
  if (x.sourceTypeNew !== false) parts.push('sourceType=new');
  return `${PW_BW_API_}/projects/${enc(x.project)}/data/mentions?${parts.join('&')}`;
}

/**
 * The shared login's call count on an answer: {used, limit} (the header's names in any letter case; "600/10m" or bare
 * digits), or null when the answer had no such header. Pure.
 */
function bwlLogin_(resp) {
  let h = {};
  try { h = (resp && typeof resp.getHeaders === 'function' && resp.getHeaders()) || {}; } catch (e) { h = {}; }
  const get = name => { const k = Object.keys(h).find(x => String(x).toLowerCase() === name); return k === undefined ? null : h[k]; };
  const usedRaw = get('x-rate-limit-used');
  const limitRaw = get('x-rate-limit');
  const used = usedRaw === null ? NaN : Number(String(usedRaw).trim());
  const m = String(limitRaw === null ? '' : limitRaw).trim().match(/^(\d+)(?:\s*\/\s*\d+\s*m?)?$/i);
  if (!isFinite(used)) return null;
  return { used: Math.max(0, Math.round(used)), limit: m ? Number(m[1]) : 0 };
}

/**
 * The one fetch of this file: a GET (no method, no payload) with the token, counted in the reader's ledger and the
 * day's calls. Returns the answer; throws only what UrlFetchApp throws.
 */
function bwlGet_(url, token, st, day, now) {
  st.cl.push(Math.floor(now / 1000));
  day.calls += 1;
  return UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { Authorization: 'bearer ' + token, Accept: 'application/json' } });
}

/** This reader's calls in the 10 minutes before `now`, the ledger trimmed to them. Pure (but for `st`). */
function bwlCallsLately_(st, now) {
  const from = Math.floor((now - BWL_LEDGER_MS_) / 1000);
  st.cl = st.cl.filter(t => Number(t) > from);
  return st.cl.length;
}

// ---------------------------------------------------------------------------------------------------------------
// The queries and the sources (once a UTC day each)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The project's queries: [{id, name, contentSources, languages}] (only those four fields are kept: never a user's name),
 * read from /queries/summary once a UTC day and kept in the script cache; the list kept today when one is there, else
 * the call. {list, err}. Never throws.
 */
function bwlQueries_(token, st, day, now, cfg) {
  const utc = ewsUtcDay_(now);
  const cache = CacheService.getScriptCache();
  let kept = null;
  try { kept = JSON.parse(cache.get(BWL_QUERIES_KEY_) || 'null'); } catch (e) { kept = null; }
  if (st.qd === utc && Array.isArray(kept)) return { list: kept, err: '' };
  try {
    const resp = bwlGet_(`${PW_BW_API_}/projects/${encodeURIComponent(cfg.project)}/queries/summary`, token, st, day, now);
    bwlNoteLogin_(st, resp, now);
    const code = resp.getResponseCode();
    if (code !== 200) return { list: Array.isArray(kept) ? kept : [], err: `HTTP ${code}: ${nsrcScrub_(pwHttpWhy_(resp), 120, token)}`, code };
    let res = null;
    try { res = JSON.parse(resp.getContentText() || '{}'); } catch (e) { res = null; }
    const raw = Array.isArray(res) ? res : res && Array.isArray(res.results) ? res.results : null;
    if (!raw) return { list: Array.isArray(kept) ? kept : [], err: 'the list of queries could not be read' };
    const list = raw.filter(q => q && q.id !== undefined && q.id !== null).map(q => ({
      id: String(q.id), name: nsrcScrub_(q.name, 200, token),
      contentSources: (Array.isArray(q.contentSources) ? q.contentSources : []).map(s => nsrcScrub_(s, 40)).slice(0, 20),
      languages: (Array.isArray(q.languages) ? q.languages : []).map(s => nsrcScrub_(s, 10)).slice(0, 10),
    }));
    try { cache.put(BWL_QUERIES_KEY_, JSON.stringify(list).slice(0, 95000), 25 * 3600); } catch (e) { /* read again tomorrow */ }
    st.qd = utc;
    return { list, err: '' };
  } catch (e) {
    return { list: Array.isArray(kept) ? kept : [], err: nsrcScrub_((e && e.message) || e, 160, token) };
  }
}

/** The sources this account has (GET /metrics, contentSources), once a UTC day; st.srcs. Never throws. */
function bwlMetrics_(token, st, day, now) {
  const utc = ewsUtcDay_(now);
  if (st.md === utc && Array.isArray(st.srcs)) return st.srcs;
  try {
    const resp = bwlGet_(`${PW_BW_API_}/metrics`, token, st, day, now);
    bwlNoteLogin_(st, resp, now);
    if (resp.getResponseCode() !== 200) return Array.isArray(st.srcs) ? st.srcs : [];
    let res = null;
    try { res = JSON.parse(resp.getContentText() || '{}'); } catch (e) { res = null; }
    const raw = res && Array.isArray(res.contentSources) ? res.contentSources : Array.isArray(res) ? res : [];
    st.srcs = raw.map(x => String((x && typeof x === 'object' ? x.name || x.id : x) || '').trim().toLowerCase())
      .filter(Boolean).slice(0, 80).map(x => x.slice(0, 40));
    st.md = utc;
    return st.srcs;
  } catch (e) {
    return Array.isArray(st.srcs) ? st.srcs : [];
  }
}

/** Keeps what an answer said about the shared login (st.login) and pauses at bw_live_pause_at_used. Pure (but for `st`). */
function bwlNoteLogin_(st, resp, now) {
  const l = bwlLogin_(resp);
  if (!l) { st.login = null; return; }
  st.login = { used: l.used, limit: l.limit, at: now };
  if (l.used >= bwLiveCfg_().pauseAtUsed && !(st.pause && st.pause.until > now)) {
    st.pause = { until: now + BWL_PAUSE_MS_, kind: 'login', used: l.used, limit: l.limit, since: now };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A read
// ---------------------------------------------------------------------------------------------------------------

/** A mention's source name as Brandwatch gives it, lowercased ("reddit", "instagram_public"); '' for none. Pure. */
function bwlSourceOf_(m) {
  return String((m && (m.pageType || m.contentSource)) || '').trim().toLowerCase();
}

/** True for an X mention (whatever was asked for). Pure. */
function bwlIsX_(m) {
  const s = bwlSourceOf_(m);
  const c = String((m && m.contentSource) || '').trim().toLowerCase();
  return /^(?:twitter|x)$/.test(s) || /^(?:twitter|x)$/.test(c);
}

/**
 * A mention as a parcel row (the struct the Brandwatch job reads as @bwl): {mid ('BWL|' + 24 hex characters), url,
 * platform, author, audience (-1 unknown), eng (-1 unknown), posted_ms, seen_ms (added), raw (its words, at most
 * BWL_TEXT_CHARS_), topic (its query's name), lang, sentiment, qid}. Link, network, author, followers, engagements and
 * times as the Watch reads them (ProactiveWatch.gs pwBwRow_, called, not copied). Pure.
 */
function bwlRow_(m) {
  const r = pwBwRow_(m, null);
  const one = v => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
  const raw = one(m.snippet || m.fullText || m.title);
  const src = bwlSourceOf_(m);
  const platform = /^facebook/.test(src) ? 'facebook' : /^instagram/.test(src) ? 'instagram' : pwPlatform_(src) || r.n;
  const id = one(m.resourceId || m.guid || m.url);
  return {
    mid: `BWL|${ewsKeyHash_(id) + ewsKeyHash_(id.split('').reverse().join('')).slice(0, 8)}`,
    url: r.u, platform, author: nsrcScrub_(r.a, 120), audience: r.f, eng: r.e,
    posted_ms: r.p || 0, seen_ms: r.s || 0, raw: nsrcScrub_(raw, BWL_TEXT_CHARS_),
    topic: nsrcScrub_(one(m.queryName), 120) || 'Brandwatch', lang: one(m.language).toLowerCase().slice(0, 10),
    sentiment: one(m.sentiment).toLowerCase().slice(0, 12), qid: one(m.queryId).slice(0, 20),
  };
}

/**
 * One read (the plan's Q2), with the token, the queries to read (ids, in row order), the sources and the settings.
 * Calls Brandwatch, checks every page, keeps what can be handed over, writes the parcel and moves the marks as Q2 says.
 * Returns {ok, n (mentions returned), kept, x, rep, nw, calls, ms, stop, fail, pause}. `left()`: ms of the run left.
 * Never throws (a thrown fetch is a failure of this read).
 */
function bwlRead_(token, queries, sources, cfg, st, day, now, left) {
  const t0 = Date.now();
  const out = { ok: false, n: 0, kept: 0, x: 0, rep: 0, nw: 0, calls: 0, ms: 0 };
  const first = !(Number(st.taken) > 0);
  let since = first ? now - cfg.firstMinutes * 60 * 1000 : Number(st.taken) - (st.no ? 0 : BWL_OVERLAP_MS_);
  // the first read after ON: what came before it is not wanted, so `taken` starts where it starts (a parcel of the first
  // read that is lost is then read again from there)
  if (first) st.taken = since;
  const noOverlap = !!st.no;
  delete st.no;
  if (since < now - BWL_MAX_BACK_MS_) {
    st.gap = { ms: now - BWL_MAX_BACK_MS_ - since, at: now };
    since = now - BWL_MAX_BACK_MS_;
  }
  const split = Math.max(1, Math.min(queries.length, Number(st.split) || 1));
  const per = Math.ceil(queries.length / split);
  const groups = [];
  for (let i = 0; i < queries.length; i += per) groups.push(queries.slice(i, i + per));
  const seenIds = new Set(st.ov);
  const within = new Set();
  const kept = [];
  const returned = [];  // [added, id] of every mention returned but X: the next read's overlap ids come from these
  let newest = Number(st.read) || 0;
  const callsBefore = day.calls;
  const fail = (kind, why, extra) => {
    st.fail = Object.assign({ kind, why: nsrcScrub_(why, 160, token), since: (st.fail && st.fail.kind === kind && st.fail.since) || now }, extra || {});
    out.fail = st.fail;
  };
  for (let g = 0; g < groups.length; g++) {
    let page = 0;
    for (;;) {
      if (page > 0 && left() < BWL_PAGE2_LEFT_MS_) break;
      if (bwlCallsLately_(st, now) >= cfg.callsPer10) break;
      const url = bwlRequestUrl_({ project: cfg.project, queries: groups[g], start: now - BWL_HOURS_ * 3600 * 1000,
        end: now + 5 * 60 * 1000, since, pageSize: cfg.pageSize, page, sources, sourceTypeNew: cfg.sourceTypeNew });
      let resp = null;
      try {
        resp = bwlGet_(url, token, st, day, now);
      } catch (e) {
        fail('down', `Brandwatch could not be reached (${(e && e.message) || e})`);
        out.calls = day.calls - callsBefore;
        out.ms = Date.now() - t0;
        return out;
      }
      bwlNoteLogin_(st, resp, now);
      const code = resp.getResponseCode();
      if (code !== 200) {
        const why = nsrcScrub_(pwHttpWhy_(resp), 120, token);
        if (code === 401) {
          st.u401 = (Number(st.u401) || 0) + 1;
          if (st.u401 >= 3) st.pause = { until: now + BWL_HOUR_MS_, kind: 'key', since: (st.pause && st.pause.kind === 'key' && st.pause.since) || (st.fail && st.fail.kind === 'key' && st.fail.since) || now };
          fail('key', `Brandwatch refuses the shared key (HTTP 401: ${why})`, { n: st.u401 });
        } else if (code === 429) {
          st.pause = { until: now + BWL_PAUSE_MS_, kind: '429', since: now };
          fail('429', 'Brandwatch said too many calls on the shared login');
        } else if (code === 400 && /quer/i.test(why) && groups[g].length > 1) {
          st.split = Math.min(queries.length, split * 2);
          fail('split', `Brandwatch refused the list of queries (HTTP 400: ${why}); the next read asks for them in ${st.split} calls`);
        } else if (code >= 400 && code < 500) {
          st.pause = { until: now + BWL_HOUR_MS_, kind: 'refused', since: (st.pause && st.pause.kind === 'refused' && st.pause.since) || now };
          fail('refused', `Brandwatch refused the read (HTTP ${code}: ${why})`);
        } else {
          fail('down', `Brandwatch could not answer (HTTP ${code}: ${why})`);
        }
        out.calls = day.calls - callsBefore;
        out.ms = Date.now() - t0;
        return out;
      }
      st.u401 = 0;
      let results = null;
      try { results = (JSON.parse(resp.getContentText() || '{}') || {}).results; } catch (e) { results = null; }
      if (!Array.isArray(results)) {
        fail('down', 'Brandwatch\'s answer had no list of mentions');
        out.calls = day.calls - callsBefore;
        out.ms = Date.now() - t0;
        return out;
      }
      // the checks on every page: added never goes down, none long before "added since"
      let prev = 0;
      let early = false;
      let order = false;
      const xs = [];
      results.forEach(m => {
        const at = pwBwTime_(m && m.added);
        if (at && at < since - BWL_EARLY_MS_) early = true;
        if (at && prev && at < prev) order = true;
        if (at) prev = at;
        if (bwlIsX_(m)) xs.push(m);
      });
      if (early || order) {
        st.stop = early
          ? { kind: 'since', why: 'Brandwatch ignored "added since" (it sent older mentions)', since: now }
          : { kind: 'order', why: 'Brandwatch ignored the order asked for (it sent newer mentions before older ones)', since: now };
        out.stop = st.stop;
        out.calls = day.calls - callsBefore;
        out.ms = Date.now() - t0;
        return out;
      }
      out.n += results.length;
      day.mentions += results.length;
      let fresh = 0;
      results.forEach(m => {
        const at = pwBwTime_(m && m.added);
        if (at > newest) newest = at;
        const src = bwlSourceOf_(m) || 'unknown';
        day.src[src] = (Number(day.src[src]) || 0) + 1;
        const qid = String((m && m.queryId) || '');
        if (qid) { day.q[qid] = Array.isArray(day.q[qid]) ? day.q[qid] : [0, 0]; day.q[qid][0] += 1; }
        if (at > Number(st.taken || 0)) fresh += 1;
        if (bwlIsX_(m)) { out.x += 1; day.x += 1; return; }
        const id = bwlId_(m);
        if (id) returned.push([at, id]);
        const link = typeof amPostKey_ === 'function' ? amPostKey_(String(m.url || m.originalUrl || '')) : '';
        const k1 = `${qid}|${String(m.resourceId || m.guid || '')}`;
        const k2 = link ? `l|${link}` : '';
        if ((id && seenIds.has(id)) || within.has(k1) || (k2 && within.has(k2))) { out.rep += 1; day.rep += 1; return; }
        within.add(k1);
        if (k2) within.add(k2);
        const row = bwlRow_(m);
        if (!row.raw) { out.nw += 1; day.nw[src] = (Number(day.nw[src]) || 0) + 1; return; }
        const b = bwlBucket_(row.posted_ms, row.seen_ms);
        if (b >= 0) day.dl[b] += 1;
        kept.push({ row, at, id, qid });
      });
      if (xs.length) {
        st.stop = { kind: 'x', why: `Brandwatch sent ${xs.length} X post${xs.length === 1 ? '' : 's'} although the bot asked for none`, since: now, n: xs.length };
        out.stop = st.stop;
        break;
      }
      // the stall rule: a full page with nothing added after `taken` (only repeats of the overlap)
      const full = results.length >= cfg.pageSize;
      if (full && !first && fresh === 0) {
        if (page === 0) { page = 1; continue; }
        if (!noOverlap) {
          st.no = 1;
          console.log('bw live read: overlap skipped once: too many mentions in 5 minutes');
        }
      }
      break;
    }
    if (out.stop) break;
  }
  out.calls = day.calls - callsBefore;
  delete st.fail;
  // the parcel: at most bw_live_parcel_max, the oldest added first; `to` the newest added handed over (or read)
  kept.sort((a, b) => a.at - b.at);
  let take = kept.slice(0, cfg.parcelMax);
  let to = take.length < kept.length ? take[take.length - 1].at : newest;
  let parts = take.length ? bwlParcelSave_(take.map(k => k.row)) : 0;
  while (take.length && parts < 0) {
    take = take.slice(0, Math.floor(take.length * 0.9));
    to = take.length ? take[take.length - 1].at : Number(st.taken) || 0;
    parts = take.length ? bwlParcelSave_(take.map(k => k.row)) : 0;
  }
  st.read = Math.max(Number(st.read) || 0, newest);
  if (out.n) st.lm = Math.max(Number(st.lm) || 0, newest);
  // the overlap's ids, so the next read drops them (the newest BWL_OV_MAX_)
  // (they replace the last ones only once this read's mentions are handed over: a lost parcel is read again whole)
  const ovFrom = to - BWL_OVERLAP_MS_;
  const ov = Array.from(new Set(returned.filter(r => r[0] >= ovFrom && r[0] <= to).sort((a, b) => a[0] - b[0]).map(r => r[1])))
    .slice(-BWL_OV_MAX_);
  if (take.length) {
    const q = {};
    take.forEach(k => { if (k.qid) q[k.qid] = (q[k.qid] || 0) + 1; });
    st.parcel = { to, n: take.length, parts, at: now, fails: 0, q, ov };
  } else {
    if (to > (Number(st.taken) || 0)) st.taken = to;  // nothing to hand over: the mark moves now
    if (out.n) st.ov = ov;
  }
  out.kept = take.length;
  out.ok = true;
  out.ms = Date.now() - t0;
  st.last = now;
  if (!st.first) st.first = now;
  st.lr = { at: now, n: out.n, x: out.x, rep: out.rep, nw: out.nw, ms: out.ms, calls: out.calls, kept: out.kept };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The parcel (the three functions Early Detection's job uses)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Writes the parcel's rows to the cache in items of at most BWL_PARCEL_ITEM_CHARS_; the number of items, or -1 when
 * they would need more than BWL_PARCEL_ITEMS_ (the caller hands over fewer). Never throws (a failed put: -1).
 */
function bwlParcelSave_(rows) {
  try {
    const items = [];
    let cur = [];
    let size = 2;
    rows.forEach(r => {
      const s = JSON.stringify(r);
      if (cur.length && size + s.length + 1 > BWL_PARCEL_ITEM_CHARS_) { items.push(cur); cur = []; size = 2; }
      cur.push(r);
      size += s.length + 1;
    });
    if (cur.length) items.push(cur);
    if (items.length > BWL_PARCEL_ITEMS_) return -1;
    const map = {};
    items.forEach((list, i) => { map[`${BWL_PARCEL_PREFIX_}${i}`] = JSON.stringify(list); });
    CacheService.getScriptCache().putAll(map, BWL_PARCEL_TTL_S_);
    return items.length;
  } catch (e) {
    return -1;
  }
}

/**
 * The parcel waiting for a job: {rows, to, n} (rows: bwlRow_'s), or null when none waits. A parcel whose cache items
 * are gone is forgotten (the mark `taken` did not move, so the next read asks Brandwatch for it again). Never throws.
 */
function bwlParcelTake_(props) {
  try {
    const p = props || PropertiesService.getScriptProperties();
    const st = bwlState_(p);
    const pc = st.parcel;
    if (!pc || !(pc.parts > 0)) return null;
    const keys = [];
    for (let i = 0; i < pc.parts; i++) keys.push(`${BWL_PARCEL_PREFIX_}${i}`);
    const got = CacheService.getScriptCache().getAll(keys) || {};
    const rows = [];
    for (let i = 0; i < keys.length; i++) {
      if (!got[keys[i]]) {
        console.warn(`Brandwatch live: the parcel of ${pc.n} mentions was lost from the cache; they are read again`);
        st.parcel = null;
        bwlSaveState_(p, st);
        return null;
      }
      JSON.parse(got[keys[i]]).forEach(r => rows.push(r));
    }
    return { rows, to: pc.to, n: pc.n };
  } catch (e) {
    return null;
  }
}

/** The parcel's job was collected: `taken` moves to its `to`, its items go, the day counts what it handed over. Never throws. */
function bwlParcelCollected_(props, now) {
  try {
    const p = props || PropertiesService.getScriptProperties();
    const st = bwlState_(p);
    const pc = st.parcel;
    if (!pc) return false;
    st.taken = Math.max(Number(st.taken) || 0, Number(pc.to) || 0);
    if (Array.isArray(pc.ov)) st.ov = pc.ov;
    st.parcel = null;
    const day = bwlDay_(p, now || Date.now());
    day.used += Number(pc.n) || 0;
    Object.keys(pc.q || {}).forEach(id => { day.q[id] = Array.isArray(day.q[id]) ? day.q[id] : [0, 0]; day.q[id][1] += pc.q[id]; });
    bwlParcelDrop_(pc.parts);
    bwlSaveState_(p, st);
    bwlSaveDay_(p, day);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * The parcel's job failed: tried again with the next check; after its second failure the parcel is dropped, the mark
 * moves past it, and the mentions lost are counted (BWL_DAY.lost) and said. Returns 'retry' | 'dropped' | ''. Never throws.
 */
function bwlParcelFailed_(props, why, now) {
  try {
    const p = props || PropertiesService.getScriptProperties();
    const st = bwlState_(p);
    const pc = st.parcel;
    if (!pc) return '';
    pc.fails = (Number(pc.fails) || 0) + 1;
    if (pc.fails < 2) { bwlSaveState_(p, st); return 'retry'; }
    const day = bwlDay_(p, now || Date.now());
    day.lost += Number(pc.n) || 0;
    st.taken = Math.max(Number(st.taken) || 0, Number(pc.to) || 0);
    if (Array.isArray(pc.ov)) st.ov = pc.ov;
    st.parcel = null;
    st.dropped = { n: Number(pc.n) || 0, at: now || Date.now(), why: nsrcScrub_(why, 120) };
    bwlParcelDrop_(pc.parts);
    console.warn(`Brandwatch live: ${pc.n} mentions were lost: their BigQuery job failed twice (${nsrcScrub_(why, 160)})`);
    bwlSaveState_(p, st);
    bwlSaveDay_(p, day);
    return 'dropped';
  } catch (e) {
    return '';
  }
}

/** Removes the parcel's cache items. Never throws. */
function bwlParcelDrop_(parts) {
  try {
    const keys = [];
    for (let i = 0; i < Math.max(Number(parts) || 0, BWL_PARCEL_ITEMS_); i++) keys.push(`${BWL_PARCEL_PREFIX_}${i}`);
    CacheService.getScriptCache().removeAll(keys);
  } catch (e) { /* they expire */ }
}

/**
 * Row 49 OFF: its marks, parcel, overlap ids, stops, pauses and failures go, so ON again starts from the last
 * bw_live_first_minutes; the day's counts (BWL_DAY) and the ticks on the tab stay. Writes only when there is something
 * to clear. Never throws.
 */
function bwLiveOff_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(BWL_STATE_PROP_);
    if (!raw) return;
    const st = bwlState_(props);
    if (st.parcel) bwlParcelDrop_(st.parcel.parts);
    props.deleteProperty(BWL_STATE_PROP_);
  } catch (e) { /* the next ON starts from what is left */ }
}

// ---------------------------------------------------------------------------------------------------------------
// The run's entry point
// ---------------------------------------------------------------------------------------------------------------

/**
 * Why no read starts now ('' when one may): a parcel waits for its job, the last read was less than bwLiveEveryMs_()
 * ago, the run has less than BWL_MIN_LEFT_MS_ left, a pause or a stop, or this reader's calls in 10 minutes. Pure (but
 * for `st`'s ledger).
 */
function bwlWhyNot_(st, now, runStart, cfg) {
  if (st.stop) return 'stopped';
  if (st.pause && Number(st.pause.until) > now) return 'paused';
  if (st.parcel) return 'a parcel waits for its job';
  if (Number(st.last) > 0 && now - Number(st.last) < bwLiveEveryMs_()) return 'too soon';
  const hard = typeof RUN_HARD_STOP_MS_ === 'number' ? RUN_HARD_STOP_MS_ : 5 * 60 * 1000;
  if (Number(runStart) > 0 && Number(runStart) + hard - now < BWL_MIN_LEFT_MS_) return 'too little of the run left';
  if (bwlCallsLately_(st, now) >= cfg.callsPer10) return 'its own calls in 10 minutes';
  return '';
}

/**
 * The run's one call (Main.gs, after the Watch's block): reads Brandwatch when it may, hands the mentions over as a
 * parcel, and lists the project's queries on the New sources tab, keeping the owner's ticks. Does nothing at all unless
 * row 49 (edBwLive) and row 19 (earlyWave) are ON in `switches`. Returns what it did: {read, why, out}. Never throws.
 */
function bwLiveRun_(runStart, switches) {
  try {
    const sw = switches && typeof switches === 'object' ? switches : {};
    if (sw.edBwLive !== true || sw.earlyWave !== true) return { read: false, why: 'off' };
    const now = Date.now();
    const cfg = bwLiveCfg_();
    const props = PropertiesService.getScriptProperties();
    const st = bwlState_(props);
    if (st.pause && Number(st.pause.until) <= now) st.pause = null;
    const why = bwlWhyNot_(st, now, runStart, cfg);
    if (why) {
      if (why !== 'too soon' && why !== 'a parcel waits for its job') bwlSaveState_(props, st);
      return { read: false, why };
    }
    const day = bwlDay_(props, now);
    let token = '';
    try {
      token = pwBwToken_();
    } catch (e) {
      st.fail = { kind: 'secret', why: `the bot can't read the shared Brandwatch key (${nsrcScrub_((e && e.message) || e, 120)})`, since: (st.fail && st.fail.kind === 'secret' && st.fail.since) || now };
      st.last = now;
      bwlSaveState_(props, st);
      return { read: false, why: 'key' };
    }
    const q = bwlQueries_(token, st, day, now, cfg);
    const tab = nsrcBwlTicks_(q.list);
    if (tab.foreign) {
      st.nsf = st.nsf || now;
      st.last = now;
      bwlSaveState_(props, st);
      bwlSaveDay_(props, day);
      return { read: false, why: 'foreign tab' };
    }
    delete st.nsf;
    const ticked = tab.ticked;
    st.tk = { n: Math.min(ticked.length, cfg.queriesMax), of: ticked.length };
    let out = null;
    if (!ticked.length) {
      st.last = now;
    } else {
      const sources = bwlSources_(cfg.sources, bwlMetrics_(token, st, day, now));
      const left = () => (Number(runStart) > 0 ? Number(runStart) + (typeof RUN_HARD_STOP_MS_ === 'number' ? RUN_HARD_STOP_MS_ : 300000) - Date.now() : Infinity);
      out = bwlRead_(token, ticked.slice(0, cfg.queriesMax), sources, cfg, st, day, now, left);
      st.last = now;
      console.log(bwlReadLog_(out, st, day));
    }
    bwlSaveState_(props, st);
    bwlSaveDay_(props, day);
    nsrcBwlQueryRows_(q.list, day, now);
    return { read: !!out, why: ticked.length ? '' : 'no query ticked', out };
  } catch (e) {
    console.warn(`Brandwatch live: ${nsrcScrub_((e && e.message) || e, 200)}`);
    return { read: false, why: 'error' };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The words: row 49's note (Control C49), the tab's row, the log lines
// ---------------------------------------------------------------------------------------------------------------

/** The line a read leaves in the log. Pure. */
function bwlReadLog_(out, st, day) {
  const o = out || {};
  const login = st.login ? `login ${st.login.used}/${st.login.limit || '?'}` : 'login unknown';
  if (o.stop) return `bw live read: stopped: ${o.stop.why}`;
  if (o.fail) return `bw live read: ${o.fail.why}`;
  return `bw live read: ${o.n || 0} mentions, ${o.calls || 0} call${o.calls === 1 ? '' : 's'}, ${login}, ` +
    `today ${nsrcNum_(day.mentions)} mentions (this reader)`;
}

/**
 * The line a check leaves when it collected the Brandwatch job (step 2b writes it): "early wave source bwl: 1 call, 300
 * mentions (0 X, 41 repeats, 37 no words), parcel to 10:14:03Z, login 37/600, 2.1 s". `lr`: BWL_STATE.lr. Pure.
 */
function bwlCheckLog_(lr, to, login) {
  const r = lr || {};
  const at = Number(to) > 0 ? new Date(Number(to)).toISOString().slice(11, 19) + 'Z' : 'none';
  return `early wave source bwl: ${r.calls || 0} call${r.calls === 1 ? '' : 's'}, ${r.n || 0} mentions (${r.x || 0} X, ` +
    `${r.rep || 0} repeats, ${r.nw || 0} no words), parcel to ${at}, ` +
    `${login ? `login ${login.used}/${login.limit || '?'}` : 'login unknown'}, ${((Number(r.ms) || 0) / 1000).toFixed(1)} s`;
}

/** A source's name as people read it ("Reddit", "Instagram"). Pure. */
function bwlSourceWords_(s) {
  const names = { reddit: 'Reddit', bluesky: 'Bluesky', facebook: 'Facebook', facebook_public: 'Facebook', instagram: 'Instagram',
    instagram_public: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', threads: 'Threads', tumblr: 'Tumblr', forum: 'forum' };
  return names[String(s || '').toLowerCase()] || String(s || '');
}

/**
 * The one warning of row 49, or '' (the plan's Q11 table, amended: no day's ceiling): a person's tab in the way, a stop
 * (X sent, "added since" or the order ignored), the key refused, the shared login busy, a 429, a refusal, Brandwatch
 * down, a parcel lost, a skipped stretch, no mentions for 4 hours, most of one source without words. Each starts with
 * "⚠️" or "⏸", says since when or until when, and fits NSRC_NOTE_CHARS_ (a reason is shortened, never the rest).
 * `o`: {st, day, now, foreign}. Pure (but for the time zone).
 */
function bwlWarning_(o) {
  const x = o || {};
  const st = x.st || {};
  const day = x.day || {};
  const now = Number(x.now) || Date.now();
  if (x.foreign || st.nsf) return `⚠️ waiting: a tab named "${NSRC_TAB_}" exists that the bot didn't make; rename it to let the bot make its own`;
  const fit = make => {
    const full = make();
    return full.length <= NSRC_NOTE_CHARS_ ? full : truncate_(full, NSRC_NOTE_CHARS_);
  };
  const reason = (w, room) => truncate_(String(w || '').replace(/[.\s]+$/, ''), room);
  if (st.stop) {
    const what = st.stop.kind === 'x' ? st.stop.why : st.stop.why;
    return fit(() => `⚠️ stopped: ${what}. Nothing more is read until this row is turned OFF and ON again`);
  }
  const since = t => `since ${nsrcWhen_(t, now)} (${nsrcFor_(now - t)})`;
  const until = t => `until ${nsrcWhen_(t, now)}`;
  if (st.pause && Number(st.pause.until) > now) {
    const p = st.pause;
    if (p.kind === 'login') {
      return fit(() => `⏸ ${until(p.until)}: Brandwatch's shared login has used ${nsrcNum_(p.used)} of its ${nsrcNum_(p.limit || 600)} ` +
        'calls in 10 minutes (other tools share it). It reads on from where it stopped');
    }
    if (p.kind === '429') {
      return fit(() => `⏸ ${until(p.until)}: Brandwatch said too many calls on the shared login (other tools share it). It reads on from where it stopped`);
    }
    if (p.kind === 'key') {
      return fit(() => `⚠️ ${since(p.since)}: Brandwatch refuses the shared key. The service that renews it may be down. It tries again every hour`);
    }
    if (p.kind === 'refused') {
      const why = st.fail && st.fail.why ? st.fail.why : 'Brandwatch refused the read';
      const head = `⚠️ ${since(p.since)}: `;
      const tail = '. It tries again in an hour';
      return head + reason(why, NSRC_NOTE_CHARS_ - head.length - tail.length) + tail;
    }
  }
  if (st.fail) {
    const f = st.fail;
    const head = `⚠️ ${since(f.since)}: `;
    const tail = f.kind === 'key' ? '. It tries again at the next read' : '. It tries again at the next read';
    return head + reason(f.why, NSRC_NOTE_CHARS_ - head.length - tail.length) + tail;
  }
  if (st.dropped && now - Number(st.dropped.at) < BWL_GAP_SHOWN_MS_) {
    return fit(() => `⚠️ ${nsrcNum_(st.dropped.n)} Brandwatch mentions were lost at ${nsrcWhen_(st.dropped.at, now)}: their BigQuery job failed twice. It reads on`);
  }
  if (st.gap && now - Number(st.gap.at) < BWL_GAP_SHOWN_MS_) {
    const h = Math.floor(st.gap.ms / 3600000);
    const m = Math.round((st.gap.ms % 3600000) / 60000);
    const span = h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
    return `⚠️ ${span} were not read after a pause (after 2 hours it starts from the last 2 hours)`;
  }
  if (Number(st.last) > 0 && Number(st.lm) > 0 && now - Number(st.lm) >= BWL_STALE_MS_) {
    const hours = Math.floor((now - Number(st.lm)) / 3600000);
    return `⚠️ no Brandwatch mentions for ${hours} h. Check the queries ticked Read = ON on the ${NSRC_TAB_} tab`;
  }
  const worst = Object.keys(day.nw || {}).find(s => (Number(day.src[s]) || 0) >= 10 && Number(day.nw[s]) * 2 > Number(day.src[s]));
  if (worst) return `⚠️ most ${bwlSourceWords_(worst)} mentions came without their words today, so they can't be used`;
  return '';
}

/**
 * Column C of row 49 (after its ON text; step 2b writes it): the warning first and whole, then, while they fit, the last
 * read and today's counts ("read 10:15 AM: 84 new · today: 2,310 mentions, 640 used, 22 in stories (6 started) ·
 * usually 15 min after posting · New sources tab"). `o`: {st, day, now, foreign, stories: {st, sb} (EWS_SRC_DAY's for
 * 'bwl')}. Never longer than NSRC_NOTE_CHARS_. Pure (but for the time zone).
 */
function bwlNote_(o) {
  const x = o || {};
  const st = x.st || {};
  const day = x.day || bwlDay_({ getProperty: () => null }, x.now);
  const now = Number(x.now) || Date.now();
  const warning = bwlWarning_(x);
  const lr = st.lr || {};
  const tk = st.tk || {};
  if (!warning && !(Number(st.last) > 0)) return 'waiting for its first read';
  if (!warning && Number(tk.of) === 0) return `waiting: tick Read = ON for at least one query on the ${NSRC_TAB_} tab`;
  const read = Number(lr.at) > 0 ? `read ${nsrcWhen_(lr.at, now)}: ${nsrcNum_(lr.n)} new` : '';
  const s = x.stories || {};
  const counts = `today: ${nsrcNum_(day.mentions)} mentions, ${nsrcNum_(day.used)} used` +
    (Number(s.st) > 0 ? `, ${nsrcNum_(s.st)} in stories (${nsrcNum_(s.sb)} started)` : '');
  const short = `today: ${nsrcNum_(day.mentions)} mentions`;
  const most = nsrcMedianBucket_(day.dl);
  const usual = most >= 0 ? `usually ${['within 15 min', '15-60 min', '1-3 h', '3-12 h', 'over 12 h'][most]} after posting` : '';
  const capped = Number(tk.of) > Number(tk.n) ? `${nsrcNum_(tk.n)} of ${nsrcNum_(tk.of)} ticked queries read (at most ${nsrcNum_(tk.n)})` : '';
  const parts = warning ? [warning, read, counts, short] : [read, counts, short, capped, usual, `${NSRC_TAB_} tab`];
  let note = '';
  let haveCounts = false;
  parts.filter(Boolean).forEach((p, i) => {
    if (p === short && haveCounts) return;
    const next = note ? `${note} · ${p}` : p;
    if (next.length > NSRC_NOTE_CHARS_ && i > 0) return;
    note = next;
    if (p === counts) haveCounts = true;
  });
  return truncate_(note, NSRC_NOTE_CHARS_);
}

/**
 * Brandwatch live's row on the New sources tab (NSRC_HEADER_). `o`: {st, day, now, foreign, stories}. Pure (but for
 * the time zone).
 */
function nsrcBwlRow_(o) {
  const x = o || {};
  const st = x.st || {};
  const day = x.day || {};
  const now = Number(x.now) || Date.now();
  const warning = bwlWarning_(x);
  const lr = st.lr || {};
  const s = x.stories || {};
  const delay = nsrcMedianBucket_(day.dl);
  const quiet = Object.keys(day.prev || {}).length || Number(st.first) < now - 24 * 3600 * 1000
    ? bwlSourcesQuiet_(day) : [];
  const status = warning || (Number(lr.at) > 0 ? `✓ live: ${nsrcNum_(lr.kept)} new at the last read` : 'waiting for its first read') +
    (quiet.length ? ` · no mentions yesterday from ${quiet.join(', ')}` : '');
  const login = st.login ? `${nsrcNum_(st.login.used)} of ${nsrcNum_(st.login.limit || 600)}` : 'unknown';
  return [
    NSRC_SOURCE_NAMES_.bwl,
    status,
    nsrcWhen_(lr.at, now) || '—',
    `${nsrcNum_(day.mentions)} mentions / ${nsrcNum_(day.used)} / — / —`,
    delay >= 0 ? `most ${NSRC_DELAY_WORDS_[delay]} (${day.dl.map(nsrcNum_).join(' / ')})` : 'none today',
    'none today',
    `${nsrcNum_(Object.keys(day.nw || {}).reduce((n, k) => n + (Number(day.nw[k]) || 0), 0))} / ${nsrcNum_(day.x)} / —`,
    `${nsrcNum_(s.st)} / ${nsrcNum_(s.sb)} / ${nsrcNum_(s.lf)} (${nsrcNum_(s.lfs)} / ${nsrcNum_(s.lfn)})`,
    `${nsrcNum_(day.calls)} / ${nsrcNum_(day.mentions)} of ${nsrcNum_(BWL_ACCOUNT_DAY_)} (the account's allowance) / — · shared login: ${login}`,
    '—',
  ];
}

/** The sources asked for that gave no mention yesterday, in people's words. Pure. */
function bwlSourcesQuiet_(day) {
  const prev = (day && day.prev) || {};
  const asked = bwlSources_(bwLiveCfg_().sources, null);
  const seen = new Set(Object.keys(prev).filter(k => Number(prev[k]) > 0).map(k => bwlSourceWords_(k)));
  if (!Object.keys(prev).length) return [];
  return Array.from(new Set(asked.map(bwlSourceWords_))).filter(n => !seen.has(n));
}
