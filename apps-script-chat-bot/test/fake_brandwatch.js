// A fake of Brandwatch's API and of the Secret Manager read of its shared token, for the tests of Brandwatch live
// (BrandwatchLive.gs). Not a switch_ file, so the test runner does not run it on its own; test files require it.
// /data/mentions really applies the filters the bot sends (queryId, pageType, sinceAdded, orderBy / orderDirection,
// page, pageSize), and can be told to ignore any one of them, to answer an HTTP error, to send the shared login's
// call-count headers in any letter case and form (or none), or to be slow on the fake clock. Every call is recorded.
// Every mention, author, link and query here is made up; the one address is on .test, to prove it is never kept.
'use strict';

const PROJECT = 1998344909;
const MIN = 60 * 1000;

/**
 * Installs the fake on a world's UrlFetchApp (`g`: makeGoogle's) and returns its controls:
 *   token          the shared token Secret Manager answers (or set `secret` to {code, message})
 *   queries        /queries/summary's list (each with a lastModifiedUsername on .test that the bot must never keep)
 *   metrics        /metrics' contentSources
 *   mentions       the mentions /data/mentions answers from (bwMention() builds one)
 *   ignore         {sinceAdded, order, page, pageType, queryId}: a filter the fake ignores
 *   fail           null, {code, message}, or a function (url, call number) -> one of those
 *   headers        the call-count headers to send: {used, limit, usedName, limitName} (names in any case), or null for none
 *   slowMs         ms each call moves the fake clock
 *   throwNext      the next call for mentions throws (as UrlFetchApp does when the host can't be reached)
 *   calls          [{host, url, method, payload, path, params}] every call
 */
function installBrandwatch(g, opts) {
  const o = opts || {};
  const bw = {
    token: 'bw-shared-token-0f1e2d3c4b5a', secret: null, fail: null, throwNext: false, slowMs: 0, calls: [],
    queries: o.queries || [
      { id: 2005000001, name: 'Google Pixel complaints', contentSources: ['reddit', 'twitter'], languages: ['en'], lastModifiedUsername: 'owner.one@example.test' },
      { id: 2005000002, name: 'Gemini app issues', contentSources: ['reddit', 'bluesky'], languages: ['en'], lastModifiedUsername: 'owner.one@example.test' },
      { id: 2005000003, name: 'Competitor launches', contentSources: ['news'], languages: ['en', 'de'], lastModifiedUsername: 'owner.two@example.test' },
    ],
    metrics: o.metrics || ['reddit', 'bluesky', 'facebook_public', 'instagram_public', 'tiktok', 'youtube', 'threads', 'tumblr', 'forum', 'news', 'twitter'],
    mentions: o.mentions || [],
    ignore: {},
    headers: { used: 37, limit: '600/10m', usedName: 'x-rate-limit-used', limitName: 'x-rate-limit' },
  };
  const prev = g.services.UrlFetchApp.fetch;
  const resp = (code, body, headers) => ({ getResponseCode: () => code, getHeaders: () => headers || {},
    getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const hdr = () => {
    if (!bw.headers) return {};
    const h = {};
    if (bw.headers.used !== undefined) h[bw.headers.usedName || 'x-rate-limit-used'] = String(bw.headers.used);
    if (bw.headers.limit !== undefined) h[bw.headers.limitName || 'x-rate-limit'] = String(bw.headers.limit);
    return h;
  };
  const parse = url => {
    const q = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1) : '';
    const out = {};
    q.split('&').filter(Boolean).forEach(kv => {
      const i = kv.indexOf('=');
      const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
      (out[k] = out[k] || []).push(v);
    });
    return out;
  };
  g.services.UrlFetchApp.fetch = (link, params) => {
    const url = String(link);
    const method = String((params && params.method) || 'get').toLowerCase();
    if (!url.startsWith('https://secretmanager.googleapis.com/') && !url.startsWith('https://api.brandwatch.com/')) return prev(link, params);
    const path = url.split('?')[0].replace(/^https:\/\/[^/]+/, '');
    const call = { host: url.startsWith('https://secret') ? 'secret' : 'brandwatch', url, method, payload: params && params.payload, path, params: parse(url),
      headers: (params && params.headers) || {} };
    bw.calls.push(call);
    if (bw.slowMs) g.clock.now += bw.slowMs;
    if (call.host === 'secret') {
      if (bw.secret) return resp(bw.secret.code, { error: { code: bw.secret.code, message: bw.secret.message } });
      return resp(200, { name: 'v', payload: { data: Buffer.from(bw.token, 'utf8').toString('base64') } });
    }
    if (bw.throwNext && /\/data\/mentions$/.test(path)) { bw.throwNext = false; throw new Error('Address unavailable: https://api.brandwatch.com'); }
    const f = typeof bw.fail === 'function' ? bw.fail(url, bw.calls.filter(c => c.host === 'brandwatch').length) : bw.fail;
    if (f) return resp(f.code, { errors: [{ code: f.code, message: f.message }] }, hdr());
    if (path === `/projects/${PROJECT}/queries/summary`) {
      return resp(200, { resultsTotal: bw.queries.length, results: bw.queries }, hdr());
    }
    if (path === '/metrics') return resp(200, { contentSources: bw.metrics }, hdr());
    if (path === `/projects/${PROJECT}/data/mentions`) {
      const p = call.params;
      let list = bw.mentions.slice();
      if (!bw.ignore.queryId && p.queryId) list = list.filter(m => p.queryId.indexOf(String(m.queryId)) >= 0);
      if (!bw.ignore.pageType && p.pageType) list = list.filter(m => p.pageType.indexOf(String(m.pageType)) >= 0);
      if (!bw.ignore.sinceAdded && p.sinceAdded) { const s = Date.parse(p.sinceAdded[0]); list = list.filter(m => Date.parse(m.added) >= s); }
      if (p.startDate) { const s = Date.parse(p.startDate[0]); list = list.filter(m => Date.parse(m.date) >= s); }
      if (p.endDate) { const e = Date.parse(p.endDate[0]); list = list.filter(m => Date.parse(m.date) <= e); }
      const asc = !(p.orderDirection && p.orderDirection[0] === 'desc');
      list.sort((a, b) => (Date.parse(a.added) - Date.parse(b.added)) * (asc && !bw.ignore.order ? 1 : -1));
      const size = Number((p.pageSize || ['100'])[0]);
      const page = bw.ignore.page ? 0 : Number((p.page || ['0'])[0]);
      return resp(200, { resultsTotal: list.length, resultsPage: page, resultsPageSize: size, results: list.slice(page * size, page * size + size) }, hdr());
    }
    return resp(404, { errors: [{ code: 404, message: `fake Brandwatch: no ${path}` }] }, hdr());
  };
  return bw;
}

/**
 * A made-up mention: `n` its number, `at` when Brandwatch added it (ms), `o` overrides ({pageType, queryId, snippet,
 * date (ms), url, author, language, sentiment, contentSource}).
 */
function bwMention(n, at, o) {
  const x = o || {};
  const iso = ms => new Date(ms).toISOString().replace('Z', '+0000');
  const type = x.pageType || 'reddit';
  return {
    resourceId: `res${n}`, guid: `g${n}`, url: x.url || `https://www.reddit.com/r/pixel/comments/a${n}/post_${n}/`,
    added: iso(at), date: iso(x.date || at - 10 * MIN), pageType: type, contentSource: x.contentSource || type,
    snippet: x.snippet === undefined ? `My Pixel phone from Google keeps restarting after the update, post number ${n} here` : x.snippet,
    author: x.author || `user_${n}`, queryId: x.queryId || 2005000001, queryName: x.queryName || 'Google Pixel complaints',
    language: x.language || 'en', sentiment: x.sentiment || 'negative', redditSubscribers: 10,
  };
}

module.exports = { installBrandwatch, bwMention, PROJECT };
