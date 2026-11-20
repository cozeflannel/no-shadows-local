#!/usr/bin/env node
/**
 * server.js — the temp-check test app's web server. No dependencies: `node server.js`, then open the address it prints.
 *
 * It listens on this computer only (127.0.0.1) and has no sign-in of its own: whoever starts it is who it acts as, with
 * their Google login (lib/gcp.js). So it must never be reachable from another machine: it refuses any request that
 * was not addressed to localhost, takes changes only as JSON (which a web page on another site cannot send here
 * without being asked first, and this server never says yes), and sends no cross-site permission headers.
 *
 * What it reads: Brandwatch, BigQuery, Gemini, the bot's Alert log and Control tab. What it writes: its own data folder
 * (lib/store.js); a Google Doc of a temp check in one folder of the Drive of whoever runs it (lib/docs.js); and, only
 * with the Chat sign-in and a switch on in the page (or a button pressed there), a reply in an existing thread of the
 * bot's Auto-correct space (lib/inchat.js, lib/chat.js). It starts nothing by itself unless something was switched on
 * in the page ("Automatic temp checks", lib/watch.js; "In Chat", lib/inchat.js; all off until someone turns them on)
 * or a refresh was scheduled.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const service = require('./lib/service');
const store = require('./lib/store');
const benchmark = require('./lib/benchmark');
const watch = require('./lib/watch');
const inchat = require('./lib/inchat');
const bw = require('./lib/brandwatch');
const own = require('./lib/owndata');
const gemini = require('./lib/gemini');
const bq = require('./lib/bigquery');
const { PROJECT } = require('./lib/gcp');

const PORT = Number(process.env.TEMPCHECK_PORT) || 8787;
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_BODY = 256 * 1024;
// The only frames the page may hold: a post shown by its own platform's embed address (public/visuals.js embedFor)
const FRAMES = ['https://platform.twitter.com', 'https://www.youtube-nocookie.com', 'https://www.instagram.com', 'https://www.tiktok.com',
  'https://embed.bsky.app', 'https://embed.reddit.com'];
const CSP = 'default-src \'self\'; script-src \'self\' https://cdn.jsdelivr.net; style-src \'self\' \'unsafe-inline\'; ' +
  `img-src 'self' data: https:; connect-src 'self'; frame-src ${FRAMES.join(' ')}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP });
  res.end(body);
}

function json(res, code, value) { send(res, code, JSON.stringify(value), 'application/json; charset=utf-8'); }

/** The request was addressed to this computer by name (a page elsewhere pointing a made-up name at 127.0.0.1 is refused). */
function hostOk(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      const e = new Error('Send JSON.');
      e.user = true;
      return reject(e);
    }
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); const e = new Error('That is too much to send.'); e.user = true; reject(e); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') || {}); } catch (err) { const e = new Error('That is not JSON.'); e.user = true; reject(e); }
    });
    req.on('error', reject);
  });
}

function staticFile(res, name) {
  const file = path.join(PUBLIC, name);
  if (!file.startsWith(PUBLIC + path.sep) || !TYPES[path.extname(file)]) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => (err ? send(res, 404, 'Not found') : send(res, 200, data, TYPES[path.extname(file)])));
}

/** What the page shows about where it is running. No secrets: names and counts only. */
function about() {
  return { project: PROJECT, brandwatchProject: bw.BW_PROJECT, model: gemini.MODEL, tables: own.describe(), rowLimit: own.ROW_LIMIT,
    maxGbPerQuery: bq.MAX_GB, brandwatch: bw.usageNow(), benchmark: benchmark.status(), dataDir: path.relative(process.cwd(), store.DIR) || '.' };
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  if (m === 'GET' && p === '/api/about') return json(res, 200, about());
  if (m === 'GET' && p === '/api/queries') {
    return json(res, 200, { queries: await service.queries(url.searchParams.get('q') || '', url.searchParams.get('fresh') === '1') });
  }
  if (m === 'GET' && /^\/api\/queries\/\d{6,12}$/.test(p)) {
    const one = await bw.getQuery(Number(p.split('/').pop()));
    return one ? json(res, 200, one) : json(res, 404, { error: 'Brandwatch has no query by that id in this project.' });
  }
  if (m === 'GET' && p === '/api/temp-checks') return json(res, 200, { checks: store.list() });
  if (m === 'GET' && p.startsWith('/api/temp-checks/')) {
    const rec = store.read(p.split('/').pop());
    return rec ? json(res, 200, rec) : json(res, 404, { error: 'No temp check by that id.' });
  }
  if (m === 'GET' && p.startsWith('/api/jobs/')) {
    const job = service.job(p.split('/').pop());
    return job ? json(res, 200, job) : json(res, 404, { error: 'No such run (the app was restarted since).' });
  }
  if (m === 'GET' && p === '/api/benchmark') return json(res, 200, benchmark.status());
  if (m === 'GET' && p === '/api/watch') return json(res, 200, watch.status());
  if (m === 'GET' && p === '/api/chat') return json(res, 200, await inchat.overview());
  if (m === 'POST') {
    const body = await readBody(req);
    if (p === '/api/temp-checks') return json(res, 202, service.start(body));
    if (p === '/api/alerts') return json(res, 202, service.startFromAlert(body));
    if (p === '/api/convert') return json(res, 200, await service.preview(body));
    if (p === '/api/suggest') return json(res, 200, await gemini.suggestQuery(body.text));
    if (p === '/api/benchmark/fill') return json(res, 202, await benchmark.fill(body.max));
    if (p === '/api/watch') return json(res, 200, watch.configure(body));
    if (p === '/api/watch/replay') return json(res, 200, await watch.replayNewest(body.n, body.settings));
    if (p === '/api/watch/schedule') return json(res, 200, watch.schedule(body));
    if (p === '/api/watch/unschedule') return json(res, 200, watch.unschedule(body.id));
    if (p === '/api/alerts/incoming') return json(res, 202, await watch.incoming(body));
    if (p === '/api/chat/switch') { const now = await inchat.configure({ cards: body.cards, listen: body.listen }); watch.wake(); return json(res, 200, now); }
    if (p === '/api/chat/prepare') return json(res, 202, service.background(step => inchat.prepare(String(body.id || ''), step)));
    if (p === '/api/chat/post') return json(res, 200, await inchat.post(String(body.key || '')));
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  if (!hostOk(req)) return send(res, 403, 'This app answers only on this computer.');
  let url;
  try { url = new URL(req.url, `http://${HOST}:${PORT}`); } catch (e) { return send(res, 400, 'Bad address'); }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, 'Not allowed');
    if (url.pathname === '/favicon.ico') return send(res, 204, '');  // browsers ask for one; there is none
    return staticFile(res, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  }
  api(req, res, url).catch(e => {
    const busy = e && e.bw && (e.code === 429 || Number(e.code) >= 500);
    if (!(e && e.user) && !busy) console.error(bw.scrub(String((e && e.stack) || e)));
    json(res, e && e.user ? 400 : busy ? 503 : 500, { error: busy ? `Brandwatch is busy right now. Try again in a minute. (${bw.scrub(e.message)})` : bw.scrub(String((e && e.message) || e)) });
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Temp check (test app): http://localhost:${PORT}`);
    console.log(`Running as your Google login, billed to ${PROJECT}. Answers on this computer only. Ctrl+C stops it.`);
    const w = watch.resume();
    console.log(`Automatic temp checks: ${w.on ? 'ON (watching incoming alerts)' : 'off'}${w.schedules.length ? `; ${w.schedules.length} scheduled refresh(es)` : ''}. In Chat: ${w.inChat ? 'ON' : 'off'}.`);
  });
}

module.exports = { server, hostOk, PORT, CSP, FRAMES };
