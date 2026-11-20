/**
 * tempcheck.js — the temp check's arithmetic and wording, with no network and no clock of its own (every function is
 * pure: the same input always gives the same output).
 *
 * Ported from the chat bot's TempCheck.gs so the two give the same numbers and the same sentences: where an issue
 * starts (the first hour with 100+ mentions), the velocity since the peak, percents that add up to 100, times in PT,
 * and the team's template (title, BW source, TL;DR, Sentiment, Negativity Drivers, Themes, Mentions Volume, Mention
 * Types, Engagement Volume, Highest Engaging Posts).
 *
 * One deliberate difference from the bot: the write-up has no bracketed blanks. The bot leaves "[HIGH / MODERATE /
 * LOW] ([top / bottom XX%] …)" for the analyst to complete; here the concern level is worked out (benchmark.js) or its
 * sentence is left out, and a line Gemini could not write says "Not written" with the reason.
 */
'use strict';

const HOUR = 3600 * 1000;
const SPIKE = 100;                    // an issue counts from the first hour it reached 100+ mentions...
const BEFORE_QUERY_MS = 48 * HOUR;    // ...looked for from 48 hours before its query was made...
const LOOK_MAX_MS = 7 * 24 * HOUR;    // ...and never more than 7 days back
const TOP = 25;                       // the most-engaged posts read from Brandwatch (reposts excluded)...
const NEG = 15;                       // ...and the most-engaged negative ones
const X_MAX = 40;                     // X posts whose words are looked up
const WRITEUP_POSTS = 7;              // the template's highest-engaging posts
const POST_CHARS = 400;
const GEMINI_POST_CHARS = 500;
const GEMINI_POSTS = 25;

// Brandwatch's page types (and our own tables' platform names) as the team names the sources
const SOURCES = { twitter: 'X', x: 'X', reddit: 'Reddit', instagram: 'Instagram', instagram_public: 'Instagram',
  facebook: 'Facebook', facebook_public: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok', bluesky: 'Bluesky',
  threads: 'Threads', tumblr: 'Tumblr', news: 'News', blog: 'Blogs', forum: 'Forums', review: 'Reviews', qq: 'QQ',
  linkedin: 'LinkedIn', linkedin_brand_mentions: 'LinkedIn', telegram: 'Telegram', truthsocial: 'Truth Social' };
const POST_SOURCES = { Instagram: 'IG' };
const MENTION_TYPES = { share: 'reposts', reply: 'comments', post: 'original posts' };
const PLATFORM_DOMAINS = ['instagram.com', 'facebook.com', 'fb.com', 'x.com', 'twitter.com', 't.co', 'reddit.com',
  'youtube.com', 'youtu.be', 'tiktok.com', 'threads.net', 'threads.com', 'linkedin.com', 'bsky.app', 'tumblr.com'];
const ZONES = { PT: -8, MT: -7, CT: -6, ET: -5, UTC: 0 };
const GEVENT_RX = /^\s*\[\s*g\s*event\s*\]/i;
const MONTH_TAG_RX = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\d{2}\b\s*/i;
const STOP_WORDS = ['the', 'a', 'an', 'and', 'or', 'of', 'on', 'for', 'about', 'in', 'to', 'with', 'query', 'queries',
  'issue', 'please', 'pls', 'bw', 'brandwatch', 'g', 'event', 'temp', 'check'];

const SYSTEM = 'You write the qualitative lines of a temperature check ("temp check"): the quick snapshot Google\'s ' +
  'Brand Safety social listening team sends about an emerging issue. You get the issue\'s name, its counts, and its ' +
  'most-engaged posts (reposts excluded), each with its network, author, engagement and sentiment. Write as the team ' +
  'does: factual, neutral and specific, in plain English, about what people are saying; no advice, no speculation ' +
  'beyond the posts, and no numbers that aren\'t given. Paraphrase; quote only short phrases. Never repeat slurs, ' +
  'personal attacks or personal details. Name an account only when it is a news outlet, a public figure or a Google account.';
const SCHEMA = {
  type: 'OBJECT',
  properties: { summary: { type: 'STRING' }, negativity_drivers: { type: 'STRING' }, themes: { type: 'STRING' } },
  required: ['summary', 'negativity_drivers', 'themes'],
};

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function truncate(s, n) {
  const t = String(s === undefined || s === null ? '' : s);
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
}

/** A Brandwatch time ("2026-11-02T03:27:59.359+0000") in ms; 0 for none or one it can't read. */
function bwTime(s) {
  const v = String(s || '').trim().replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const ms = v ? Date.parse(v) : NaN;
  return isFinite(ms) && ms > 0 ? ms : 0;
}

function floorHour(ms) { return Math.floor(Number(ms) / HOUR) * HOUR; }

// ---------------------------------------------------------------------------------------------------------------
// Which Brandwatch query
// ---------------------------------------------------------------------------------------------------------------

/** A Brandwatch query id in `ref`: a link's (…/queries/2004162030, ?queryId=…) or a bare 9-12 digit number; else 0. */
function queryId(ref) {
  const s = String(ref || '');
  const m = s.match(/(?:queries\/(?:edit\/)?|queries=|queryId=)(\d{6,12})(?!\d)/i) || s.match(/^\s*(\d{9,12})\s*$/);
  return m ? Number(m[1]) : 0;
}

function norm(s) { return String(s || '').toLowerCase().replace(/[“”"'‘’`]/g, '').replace(/\s+/g, ' ').trim(); }

/** A query name without "[G EVENT]" and the month tag ("OCT26"). */
function core(s) { return norm(s).replace(/^\[\s*g\s*event\s*\]\s*/, '').replace(MONTH_TAG_RX, ''); }

function words(s) {
  return norm(s).replace(/[^a-z0-9$#@&]+/g, ' ').split(' ').filter(w => w && STOP_WORDS.indexOf(w) < 0);
}

/** The issue's name for the write-up: the query's without "[G EVENT]", the month tag and wrapping quotes. */
function issueName(name) {
  const s = String(name || '').trim().replace(/^\[\s*G\s*EVENT\s*\]\s*/i, '').replace(MONTH_TAG_RX, '').trim()
    .replace(/^["“]+(.*?)["”]+$/, '$1').trim();
  return s || String(name || '').trim();
}

/**
 * The query `ref` names in `list` ([{id, name, created}]): {query} for the same name, or the one [G EVENT] query whose
 * name has every word of `ref`; {choices} (newest first, 5 at most) when several do; {choices: [], near} when none does.
 */
function matchQuery(ref, list) {
  const qs = (list || []).filter(q => q && q.id && q.name);
  const newest = (a, b) => Number(b.id) - Number(a.id);
  const want = norm(ref);
  const wantCore = core(ref);
  const exact = qs.filter(q => norm(q.name) === want || (wantCore && core(q.name) === wantCore));
  if (exact.length) return { query: exact.sort(newest)[0] };
  const ws = words(wantCore);
  if (!ws.length) return { choices: [], near: [] };
  const wordsOf = q => new Set(words(q.name));
  const hasAll = q => { const w = wordsOf(q); return ws.every(x => w.has(x)); };
  let hits = qs.filter(q => GEVENT_RX.test(q.name) && hasAll(q));
  if (!hits.length) hits = qs.filter(hasAll);
  if (hits.length === 1) return { query: hits[0] };
  if (hits.length > 1) return { choices: hits.sort(newest).slice(0, 5) };
  const score = q => { const w = wordsOf(q); return ws.filter(x => w.has(x)).length; };
  const near = qs.filter(q => GEVENT_RX.test(q.name) && score(q) > 0).sort((a, b) => score(b) - score(a) || newest(a, b)).slice(0, 5);
  return { choices: [], near };
}

// ---------------------------------------------------------------------------------------------------------------
// Brandwatch's answers as plain numbers
// ---------------------------------------------------------------------------------------------------------------

// (an answer about several queries has one result a query: their values are read together, so the counts below add up)
function valuesOf(body) { return ((body && body.results) || []).reduce((all, r) => all.concat((r && r.values) || []), []); }

/** Brandwatch's hourly volume -> [{at (ms), n}], one per hour from `from` to `to` (an hour with nothing: 0). */
function hourly(body, from, to) {
  const by = new Map();
  valuesOf(body).forEach(v => {
    const at = bwTime(v && v.id);
    if (at) by.set(at, (by.get(at) || 0) + (Number(v.value) || 0));
  });
  const out = [];
  for (let at = floorHour(from); at < to; at += HOUR) out.push({ at, n: by.get(at) || 0 });
  return out;
}

/** A volume answer's counts by its values' ids ({positive: 185, …}). */
function values(body) {
  const out = {};
  valuesOf(body).forEach(v => {
    if (v && v.id !== undefined) out[String(v.id)] = (out[String(v.id)] || 0) + (Number(v.value) || 0);
  });
  return out;
}

/** The page types' counts as the team names the sources ([{label, n}], most first, none with 0). */
function sourceCounts(body) {
  const by = {};
  valuesOf(body).forEach(v => {
    const n = Number(v && v.value) || 0;
    if (!n) return;
    const label = SOURCES[String(v.id)] || String(v.name || v.id);
    by[label] = (by[label] || 0) + n;
  });
  return Object.keys(by).map(label => ({ label, n: by[label] })).sort((a, b) => b.n - a.n);
}

/** Brandwatch's threadEntryTypes volume -> [{label, n}] ("reposts", "comments", "original posts"), most first. */
function mentionTypeCounts(body) {
  const by = {};
  valuesOf(body).forEach(v => {
    const n = Number(v && v.value) || 0;
    const label = MENTION_TYPES[String(v && v.id)];
    if (!n || !label) return;
    by[label] = (by[label] || 0) + n;
  });
  return Object.keys(by).map(label => ({ label, n: by[label] })).sort((a, b) => b.n - a.n);
}

/** Cleans an author handle or display name, rejecting bare platform domains ("instagram.com") and "unknown". */
function cleanHandle(raw, domain, unified) {
  const s = String(raw || '').trim().replace(/^@+/, '').trim();
  if (!s) return '';
  const low = s.toLowerCase().replace(/^www\./, '');
  if (low === 'unknown' || PLATFORM_DOMAINS.indexOf(low) >= 0) return '';
  if (domain && low === String(domain).trim().toLowerCase().replace(/^www\./, '')) return '';
  if (unified && low === String(unified).trim().toLowerCase().replace(/^www\./, '')) return '';
  return s;
}

/** A post's author from Brandwatch's mention fields or its link, never the platform's own domain. */
function mentionAuthor(m) {
  const fields = [m && m.author, m && m.fullname, m && m.threadAuthor];
  for (let i = 0; i < fields.length; i++) {
    const hit = cleanHandle(fields[i], m && m.domain, m && m.unifiedSourceName);
    if (hit) return hit;
  }
  const u = String((m && (m.url || m.originalUrl)) || '');
  const ig = u.match(/^https?:\/\/(?:www\.|m\.)?instagram\.com\/([A-Za-z0-9_.]+)\/(?:p|reels?|tv)\//i);
  if (ig && !/^(?:p|reels?|tv|stories|explore)$/i.test(ig[1])) return ig[1];
  const bsky = u.match(/^https?:\/\/(?:www\.)?bsky\.app\/profile\/([^/?#]+)/i);
  if (bsky && !/^did:/i.test(bsky[1])) return decodeURIComponent(bsky[1]);
  const atHandle = u.match(/^https?:\/\/(?:www\.)?(?:tiktok\.com|threads\.(?:net|com)|youtube\.com)\/@([^/?#]+)/i);
  if (atHandle) return decodeURIComponent(atHandle[1]);
  return '';
}

/** Engagement for ranking the top posts (X: likes + replies when known; else the engagement number; -1 when unknown). */
function postEngVal(p) {
  if (!p) return -1;
  if (p.x && (p.likes !== undefined || p.replies !== undefined)) return (Number(p.likes) || 0) + (Number(p.replies) || 0);
  return p.eng === null || p.eng === undefined ? -1 : Number(p.eng) || 0;
}

/**
 * A Brandwatch mentions answer as posts: [{key, x (an X post: Brandwatch gives it without its words), id (X's post id),
 * source, author, text, url, eng, negative, at (ms: when it was posted, 0 when Brandwatch doesn't say)}], in
 * Brandwatch's order (the most engagement first).
 */
function mentions(body) {
  return ((body && body.results) || []).filter(Boolean).map(m => {
    const x = String(m.pageType || '') === 'twitter';
    const id = x ? String(m.guid || '').replace(/\D/g, '') : '';
    const title = String(m.title || '').trim();
    const snippet = String(m.snippet || m.fullText || '').trim();
    const text = title && snippet && snippet.indexOf(title) !== 0 ? `${title}: ${snippet}` : (title || snippet);
    const url = x ? '' : String(m.url || m.originalUrl || '');
    return {
      key: String(m.guid || url || m.resourceId || ''), x, id,
      source: SOURCES[String(m.pageType)] || String(m.pageTypeName || m.pageType || 'Web'),
      author: mentionAuthor(m), text: x ? '' : text, url,
      eng: m.engagementScore === null || m.engagementScore === undefined ? null : Number(m.engagementScore) || 0,
      negative: String(m.sentiment || '') === 'negative', at: bwTime(m.date) || 0,
    };
  });
}

/**
 * A post with its words. An X post's come from `xPosts` ({id: {author, text, url, likes, replies, from}}): X's public
 * embed data, or our own alert rows when X won't serve it. Null for a post with no words.
 */
function postWithText(p, xPosts) {
  if (!p) return null;
  if (!p.x) return p.text ? p : null;
  const post = (xPosts || {})[p.id];
  if (!post || !post.text) return null;
  const out = Object.assign({}, p, { author: cleanHandle(post.author) || p.author, text: post.text, url: post.url || '', textFrom: post.from || '' });
  if (post.likes !== undefined && post.likes !== null) {
    out.likes = Number(post.likes) || 0;
    out.replies = Number(post.replies) || 0;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------------------------------------------

/**
 * Where the count starts: the first hour (from `o.look`) with 100+ mentions ('spike'); else when the alert came in
 * ('alert', `o.alertAt`, when it's after `o.look`); else when the query was made ('query'); else `o.look` ('look').
 */
function start(hours, o) {
  const spike = (hours || []).find(h => h.n >= SPIKE);
  if (spike) return { at: spike.at, why: 'spike' };
  if (o.alertAt && o.alertAt >= o.look) return { at: floorHour(o.alertAt), why: 'alert' };
  if (o.created && o.created >= o.look) return { at: floorHour(o.created), why: 'query' };
  return { at: o.look, why: 'look' };
}

/**
 * The full hours from `from` (before `now`'s hour): the peak (the first of the most), the last, and the change from the
 * peak to the last (%, rounded; -100 only for a last hour with none). null before the first full hour.
 */
function velocity(hours, from, now) {
  const cur = floorHour(now);
  const full = (hours || []).filter(h => h.at >= from && h.at < cur);
  if (!full.length) return null;
  const peak = full.reduce((a, b) => (b.n > a.n ? b : a));
  const last = full[full.length - 1];
  const pct = peak.n ? Math.round(((last.n - peak.n) / peak.n) * 100) : 0;
  return { peak, last, pct: pct <= -100 && last.n > 0 ? -99 : pct };
}

/** Whole percents of `counts` that add up to 100 (largest remainders; all 0 for none). */
function pcts(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map(n => (n * 100) / total);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
    if (left > 0) { out[i]++; left--; }
  });
  return out;
}

/** "37%", or "<1%" for a few. */
function pct(p, n) { return !p && n > 0 ? '<1%' : `${p}%`; }

/** 6030 -> "6,030". */
function num(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** 18368 -> "18.4K", 1137140 -> "1.1M", 944 -> "944". */
function compact(n) {
  const v = Number(n) || 0;
  const cut = (x, unit) => `${(Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (v >= 1e6 || Math.round(v / 100) >= 10000) return cut(v / 1e6, 'M');
  if (v >= 1e3) return cut(v / 1e3, 'K');
  return String(Math.round(v));
}

// ---------------------------------------------------------------------------------------------------------------
// Times: PT for the write-up, as the team writes them
// ---------------------------------------------------------------------------------------------------------------

/** The UTC offset (minutes) of `zone` at `ms`: US daylight time from the 2nd Sunday of March to the 1st Sunday of November, 2am local. */
function offsetMin(ms, zone) {
  if (zone === 'UTC') return 0;
  const base = (ZONES[zone] === undefined ? ZONES.PT : ZONES[zone]) * 60;
  const y = new Date(ms + base * 60000).getUTCFullYear();
  const sunday = (month, nth) => 1 + ((7 - new Date(Date.UTC(y, month, 1)).getUTCDay()) % 7) + 7 * (nth - 1);
  const from = Date.UTC(y, 2, sunday(2, 2), 2) - base * 60000;
  const to = Date.UTC(y, 10, sunday(10, 1), 2) - (base + 60) * 60000;
  return ms >= from && ms < to ? base + 60 : base;
}

/** `ms` in `zone`: {y, mo, d, h, mi}. */
function local(ms, zone) {
  const d = new Date(ms + offsetMin(ms, zone) * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** A wall-clock time in `zone` as ms. */
function fromLocal(y, mo, d, h, mi, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const at = guess - offsetMin(guess, zone) * 60000;
  return guess - offsetMin(at, zone) * 60000;
}

/** "10am" / "6:05am" (PT). */
function clock(ms) {
  const l = local(ms, 'PT');
  return `${l.h % 12 || 12}${l.mi ? ':' + String(l.mi).padStart(2, '0') : ''}${l.h < 12 ? 'am' : 'pm'}`;
}

/** "11/2" (PT). */
function day(ms) {
  const l = local(ms, 'PT');
  return `${l.mo}/${l.d}`;
}

/** "10am PT" on `now`'s day (PT), else "10am PT on 10/28". */
function when(ms, now) { return `${clock(ms)} PT${day(ms) === day(now) ? '' : ' on ' + day(ms)}`; }

/** "2am" (PT, the hour). */
function hourLabel(ms) {
  const l = local(ms, 'PT');
  return `${l.h % 12 || 12}${l.h < 12 ? 'am' : 'pm'}`;
}

/** An hour's label on the volume chart: "(10/20) 6AM" (PT). */
function chartTick(ms) {
  const l = local(ms, 'PT');
  return `(${l.mo}/${l.d}) ${l.h % 12 || 12}${l.h < 12 ? 'AM' : 'PM'}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------------------------------------------

/** A post's engagement in words: X's likes and replies when known, else its engagements. */
function engText(p) {
  const n = (v, one, many) => `${compact(v)} ${Number(v) === 1 ? one : many}`;
  if (p.x && p.likes !== undefined) return `${n(p.likes, 'like', 'likes')}, ${n(p.replies, 'reply', 'replies')}`;
  return p.eng === null || p.eng === undefined ? 'no engagement data' : n(p.eng, 'engagement', 'engagements');
}

/** Velocity with its numbers, for Gemini. */
function velocityText(v, now) {
  if (!v) return 'Velocity: too early to tell (its first full hour isn\'t over).';
  if (v.last.n >= v.peak.n) return `Velocity is at its peak (${num(v.last.n)} mentions in the last full hour, ${clock(v.last.at)} PT).`;
  return `Velocity is ${v.pct}% since the peak at ${when(v.peak.at, now)} (${num(v.peak.n)} mentions that hour; ` +
    `${num(v.last.n)} in the last full hour).`;
}

/** "58% neutral, 38% negative, and 4% positive." (the most first). */
function sentimentText(s) {
  const keys = ['negative', 'neutral', 'positive'];
  const counts = keys.map(k => Number((s || {})[k]) || 0);
  if (!counts.some(Boolean)) return 'not scored yet.';
  const ps = pcts(counts);
  const parts = keys.map((k, i) => ({ k, n: counts[i], p: ps[i] })).sort((a, b) => b.n - a.n).map(x => `${pct(x.p, x.n)} ${x.k}`);
  return `${parts[0]}, ${parts[1]}, and ${parts[2]}.`;
}

/** "<lead> X (84%), followed by Bluesky (7%) and Reddit (5%), (other sources: 4%)." */
function rankedSourcesText(lead, sources) {
  const list = (sources || []).filter(x => x && x.n > 0);
  if (!list.length) return 'none yet.';
  if (list.length === 1) return `${lead} ${list[0].label} (100%).`;
  if (list.length === 2) {
    const ps = pcts([list[0].n, list[1].n]);
    return `${lead} ${list[0].label} (${pct(ps[0], list[0].n)}), followed by ${list[1].label} (${pct(ps[1], list[1].n)}).`;
  }
  const rest = list.slice(3).reduce((a, x) => a + x.n, 0);
  const ps = pcts(rest > 0 ? [list[0].n, list[1].n, list[2].n, rest] : [list[0].n, list[1].n, list[2].n]);
  const top3 = `${lead} ${list[0].label} (${pct(ps[0], list[0].n)}), followed by ${list[1].label} ` +
    `(${pct(ps[1], list[1].n)}) and ${list[2].label} (${pct(ps[2], list[2].n)})`;
  return rest > 0 ? `${top3}, (other sources: ${pct(ps[3], rest)}).` : `${top3}.`;
}

function mentionsVolumeText(sources) { return rankedSourcesText('Mentions are highest on', sources); }

function engagementVolumeText(sources) { return rankedSourcesText('Engagement (likes, comments, shares) is highest on', sources); }

/** "Mentions are primarily reposts (58%), followed by comments (28%), with original posts accounting for 14% of all mentions." */
function mentionTypesText(types) {
  const list = (types || []).filter(x => x && x.n > 0).slice(0, 3);
  if (!list.length) return 'none yet.';
  if (list.length === 1) return `Mentions are primarily ${list[0].label} (100%).`;
  const ps = pcts(list.map(x => x.n));
  if (list.length === 2) {
    return `Mentions are primarily ${list[0].label} (${pct(ps[0], list[0].n)}), with ${list[1].label} accounting for ` +
      `${pct(ps[1], list[1].n)} of all mentions.`;
  }
  return `Mentions are primarily ${list[0].label} (${pct(ps[0], list[0].n)}), followed by ${list[1].label} ` +
    `(${pct(ps[1], list[1].n)}), with ${list[2].label} accounting for ${pct(ps[2], list[2].n)} of all mentions.`;
}

/** The template's title: "(11/2) 2020 Election Query Results (2am PT)". */
function title(d) { return `(${day(d.now)}) ${d.issue} (${hourLabel(d.now)} PT)`; }

/** The hourly chart's title: "(10/21) Cloud Service Outage 9am PT". */
function chartTitle(d) { return `(${day(d.now)}) ${d.issue} ${hourLabel(d.now)} PT`; }

/** "Velocity is -76% since the peak at 12pm PT today." / "… on 10/28." / "Velocity is at its peak (520 mentions/hr)." */
function templateVelocity(v, now) {
  if (!v) return 'Velocity is at its peak (its first full hour isn\'t over yet).';
  if (v.last.n >= v.peak.n) return `Velocity is at its peak (${num(v.last.n)} mentions/hr).`;
  const d = day(v.peak.at) === day(now) ? 'today' : `on ${day(v.peak.at)}`;
  return `Velocity is ${v.pct}% since the peak at ${clock(v.peak.at)} PT ${d}.`;
}

/**
 * The TL;DR's first sentence as {text, html} (the counts bold in html). `d.basis` 'own' counts posts in our own data
 * instead of Brandwatch's mentions, and says so.
 */
function lead(d) {
  const issue = d.issue;
  const unit = d.basis === 'own' ? 'matching posts in our own data' : 'total mentions';
  const both = (parts) => ({ text: parts.map(p => p.t).join(''), html: parts.map(p => (p.b ? `<b>${esc(p.t)}</b>` : esc(p.t))).join('') });
  if (d.update) {
    const on = day(d.update.at) === day(d.now) ? '' : ` on ${day(d.update.at)}`;
    const total = d.total >= 10000 ? compact(d.total) : num(d.total);
    return both([{ t: `Since the last update at ${hourLabel(d.update.at)} PT${on}, there have been ` },
      { t: `${num(Math.max(0, d.total - d.update.tot))} new ${d.basis === 'own' ? 'posts' : 'mentions'}`, b: true }, { t: ' (' },
      { t: `${total} ${unit}`, b: true }, { t: `) regarding ${issue}.` }]);
  }
  if (d.start && d.start.why === 'since') {
    return both([{ t: `Since ${when(d.start.at, d.now)} there have been ` }, { t: `${num(d.total)} ${unit}`, b: true },
      { t: ` regarding ${issue}.` }]);
  }
  return both([{ t: 'There have been ' }, { t: `${num(d.total)} ${unit}`, b: true }, { t: ` regarding ${issue}.` }]);
}

/**
 * The concern level's sentence as {text, html}, from `level` ({label, side, pct, n, known, since, fullYear}:
 * benchmark.js). "Volume is currently HIGH (top 12% of Google issues in the past 12 months)." only when nearly all of
 * the year's issues were there to rank against (`fullYear`). Otherwise it says what it was ranked against and never
 * claims a year it doesn't have: "top 12% of 147 of the past 12 months' 313 Google issues", or, when the year's count
 * isn't known, just "top 12% of 147 past Google issues". With no level, both are '': the sentence is left out (the
 * app says why next to the write-up), not filled with a blank to complete.
 */
function levelSentence(level) {
  if (!level || !level.label) return { text: '', html: '' };
  const span = level.fullYear ? 'Google issues in the past 12 months'
    : level.known > 0 ? `${num(level.n)} of the past 12 months' ${num(level.known)} Google issues` : `${num(level.n)} past Google issues`;
  const rank = `${level.side} ${level.pct}% of ${span}`;
  return { text: `Volume is currently ${level.label} (${rank}).`, html: `Volume is currently <b>${esc(level.label)}</b> (${esc(rank)}).` };
}

/**
 * The write-up's "BW source" as {html, text}: the link to the issue's query in Brandwatch; for an issue with no query of
 * its own that Brandwatch still counted (`d.standing`), the standing Google queries it was counted in; else our own data.
 */
function sourceLine(d) {
  if (d.bwUrl) return { text: `Link <${d.bwUrl}>`, html: `<a href="${esc(d.bwUrl)}" target="_blank" rel="noopener" style="color:#1155cc"><b>Link</b></a>` };
  const text = d.standing ? 'Brandwatch\'s standing Google queries, searched for this issue (it has no query of its own yet)'
    : 'our own data (no Brandwatch query yet)';
  return { text, html: esc(text) };
}

/** A highest-engaging post as the template writes it (author on source, its words in quotes, its engagements): {html, text}. */
function writeupPost(p) {
  const src = POST_SOURCES[p.source] || p.source;
  const who = cleanHandle(p.author);
  const source = who ? `${who} on ${src}` : `Post on ${src}`;
  const n = postEngVal(p);
  const eng = n < 0 ? 'Engagements not available' : `${compact(n)} Engagements`;
  const body = truncate(String(p.text).replace(/\s+/g, ' ').trim(), POST_CHARS);
  const label = p.url && /^https?:\/\//i.test(p.url)
    ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" style="color:#202124;font-weight:bold;text-decoration:underline">${esc(source)}</a>`
    : `<b>${esc(source)}</b>`;
  return { html: `${label}: "${esc(body)}" (${eng})`, text: `${source}: "${body}" (${eng})${p.url ? ` <${p.url}>` : ''}` };
}

/**
 * Gemini's prose with grounded `[phrase](#N)` post references as {html, text}: `phrase` links to `posts[N - 1].url` in
 * html when that is an http(s) link (else it stays plain), and the marker is dropped in text.
 */
function richText(raw, posts) {
  const s = String(raw || '');
  if (!s) return { html: '', text: '' };
  const rx = /\[([^\[\]\r\n]{1,80})\]\(#(?:post-?)?(\d+)\)/gi;
  let html = '';
  let text = '';
  let last = 0;
  let m;
  while ((m = rx.exec(s)) !== null) {
    const before = s.slice(last, m.index);
    html += esc(before);
    text += before;
    const item = Array.isArray(posts) ? posts[Number(m[2]) - 1] : null;
    const url = item && /^https?:\/\/\S+$/i.test(String(item.url || '')) ? String(item.url) : '';
    html += url ? `<a href="${esc(url)}" target="_blank" rel="noopener" style="color:#1155cc">${esc(m[1])}</a>` : esc(m[1]);
    text += m[1];
    last = m.index + m[0].length;
  }
  html += esc(s.slice(last));
  text += s.slice(last);
  return { html, text };
}

/** What Gemini is asked: the issue, its numbers, and the numbered posts (for grounded [phrase](#N) links). */
function prompt(d, posts) {
  const s = d.sentiment || {};
  const sent = ['negative', 'neutral', 'positive'];
  const ps = pcts(sent.map(k => Number(s[k]) || 0));
  const srcPcts = pcts((d.sources || []).map(x => x.n));
  const unit = d.basis === 'own' ? 'matching posts in our own data (reposts and replies are not in it)' : 'mentions';
  const lines = [
    `Issue: ${d.issue}${d.query ? ` (Brandwatch query "${d.query.name}")` : ''}`,
    `Counted from ${when(d.start.at, d.now)} to ${when(d.now, d.now)}: ${num(d.total)} ${unit}` +
      (ps.some(Boolean) ? '; sentiment ' + sent.map((k, i) => `${ps[i]}% ${k}`).join(', ') : '') + '; sources ' +
      ((d.sources || []).slice(0, 5).map((x, i) => `${x.label} ${srcPcts[i]}%`).join(', ') || 'none') + '.',
    velocityText(d.velocity, d.now),
  ];
  if (d.update) lines.push(`This is an update: the last one was at ${when(d.update.at, d.now)}, with ${num(d.update.tot)} then.`);
  lines.push('', 'Posts (the most engagement first; "negative" is the sentiment score they came with):');
  posts.forEach((p, i) => {
    lines.push(`${i + 1}. [${p.source}] ${p.author || 'unknown'} (${engText(p)}${p.negative ? ', negative' : ''}): ` +
      truncate(String(p.text).replace(/\s+/g, ' '), GEMINI_POST_CHARS));
  });
  lines.push('', 'Return JSON:',
    '- summary: one or two sentences (at most 60 words) on where the conversation is now: what most posts say and where it is heading. ' +
      'No numbers: the write-up already gives the counts, the peak and the velocity.',
    '- negativity_drivers: two to three sentences (at most 85 words) on what drives the negative posts; "No clear negativity ' +
      'drivers in the posts read." when there are none.',
    '- themes: two to three sentences (at most 85 words) on the other themes (questions, technical discussion, jokes, defenses ' +
      'of Google, official responses, press coverage).',
    '- Inline post links: when attributing a specific reaction, claim, or outlet/public-figure post in negativity_drivers or themes ' +
      '(and optionally summary) to one of the numbered posts above, weave 1 to 3 short inline references using [short phrase](#N) ' +
      `where N is the post's number above (1..${posts.length}), e.g. "users criticized [the incident response](#3)" or ` +
      `"[SkyNews](#2) reported the outage". Never invent URLs or cite numbers outside 1..${posts.length}.`);
  return lines.join('\n');
}

const CHART_MARK = '<!--tc-chart-->';

/**
 * The write-up of a temp check that counted nothing: the title, the source and one sentence saying so. Not the
 * template filled with zeros ("Velocity is at its peak (0 posts/hr)"): there is nothing to report on.
 */
function emptyWriteup(d) {
  const own = d.basis === 'own';
  const what = own ? 'No posts in our own data matched' : 'Brandwatch counted no mentions';
  const line = `${what} regarding ${d.issue} between ${when(d.start.at, d.now)} and ${when(d.now, d.now)}.`;
  const src = sourceLine(d);
  const srcText = src.text;
  const srcHtml = src.html;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">' +
    `<p style="margin:0 0 14px"><b>${esc(title(d))}</b><br><b>BW source:</b> ${srcHtml}</p><p style="margin:0 0 14px"><b>TL;DR:</b> ${esc(line)}</p></div>`;
  return { title: title(d), subject: `Temp Check: ${d.issue}`, html, text: [title(d), `BW source: ${srcText}`, '', `TL;DR: ${line}`].join('\n') };
}

/**
 * The temp check in the team's template: {title, subject, html, text}. `html` carries CHART_MARK where the hourly chart
 * goes (the page draws it there). `d`: {issue, query, bwUrl, now, start, total, hours, velocity, sentiment, sources,
 * mentionTypes, engSources, posts, linkPosts, update, gem, level, basis}.
 */
function writeup(d) {
  if (!(Number(d.total) > 0)) return emptyWriteup(d);
  const g = d.gem || {};
  const linkPosts = d.linkPosts || d.posts || [];
  const own = d.basis === 'own';
  const summary = g.summary ? richText(g.summary, linkPosts) : { html: '', text: '' };
  const first = lead(d);
  const level = levelSentence(d.level);
  const vel = templateVelocity(d.velocity, d.now).replace(/mentions\/hr/, own ? 'posts/hr' : 'mentions/hr');
  const tldrText = [first.text, level.text, vel, summary.text].filter(Boolean).join(' ');
  const tldrHtml = [first.html, level.html, esc(vel), summary.html].filter(Boolean).join(' ');
  // A line Gemini did not write says so plainly, with the reason: nothing is left as a blank to fill in
  const unwritten = `Not written (${g.why || 'Gemini gave no answer'}).`;
  const drivers = g.drivers ? richText(g.drivers, linkPosts) : { html: esc(unwritten), text: unwritten };
  const themes = g.themes ? richText(g.themes, linkPosts) : { html: esc(unwritten), text: unwritten };
  const posts = (d.posts || []).slice(0, WRITEUP_POSTS).map(writeupPost);
  if (!posts.length) posts.push({ html: 'None with words to show.', text: 'None with words to show.' });
  const sentiment = sentimentText(d.sentiment);
  const mentionsVol = mentionsVolumeText(d.sources).replace(/^Mentions are/, own ? 'Posts are' : 'Mentions are');
  const types = own && !(d.mentionTypes || []).length
    ? 'not available from our own data (it holds original posts, not reposts or replies).' : mentionTypesText(d.mentionTypes);
  const engVol = engagementVolumeText(d.engSources);
  const src = sourceLine(d);
  const srcHtml = src.html;
  const srcText = src.text;
  const p = (body, lastOne) => `<p style="margin:0 0 ${lastOne ? 4 : 14}px">${body}</p>`;
  const ul = items => `<ul style="margin:0 0 14px 0;padding-left:28px">${items.map(i => `<li style="margin:0 0 4px">${i}</li>`).join('')}</ul>`;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">' +
    p(`<b>${esc(title(d))}</b><br><b>BW source:</b> ${srcHtml}`) +
    p(`<b>TL;DR:</b> ${tldrHtml}`) +
    (Number(d.total) > 0 ? CHART_MARK : '') +
    p(`<b>Sentiment:</b> ${esc(sentiment)}`) +
    p(`<b>Negativity Drivers:</b> ${drivers.html}`) +
    p(`<b>Themes:</b> ${themes.html}`) +
    p(`<b>Mentions Volume:</b> ${esc(mentionsVol)}`) +
    p(`<b>Mention Types:</b> ${esc(types)}`) +
    p(`<b>Engagement Volume:</b> ${esc(engVol)}`) +
    p('<b>Highest Engaging Posts:</b>', true) +
    ul(posts.map(x => x.html)) +
    '</div>';
  const text = [
    title(d), `BW source: ${srcText}`, '', `TL;DR: ${tldrText}`, '', `Sentiment: ${sentiment}`, '',
    `Negativity Drivers: ${drivers.text}`, '', `Themes: ${themes.text}`, '', `Mentions Volume: ${mentionsVol}`, '',
    `Mention Types: ${types}`, '', `Engagement Volume: ${engVol}`, '', 'Highest Engaging Posts:',
  ].concat(posts.map(x => `  • ${x.text}`)).join('\n');
  return { title: title(d), subject: `Temp Check: ${d.issue}`, html, text };
}

module.exports = {
  HOUR, SPIKE, BEFORE_QUERY_MS, LOOK_MAX_MS, TOP, NEG, X_MAX, WRITEUP_POSTS, GEMINI_POSTS, SOURCES, GEVENT_RX,
  SYSTEM, SCHEMA, CHART_MARK,
  esc, truncate, bwTime, floorHour, queryId, issueName, matchQuery, hourly, values, sourceCounts, mentionTypeCounts,
  cleanHandle, mentionAuthor, postEngVal, mentions, postWithText, start, velocity, pcts, pct, num, compact, offsetMin,
  local, fromLocal, clock, day, when, hourLabel, chartTick, engText, velocityText, sentimentText, rankedSourcesText,
  mentionsVolumeText, engagementVolumeText, mentionTypesText, title, chartTitle, templateVelocity, lead, levelSentence,
  writeupPost, richText, prompt, writeup, sourceLine,
};
