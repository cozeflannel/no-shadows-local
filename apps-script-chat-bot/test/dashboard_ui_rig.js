// The live dashboard's render rig (a test tool, not a test: run_tests.js only picks up switch_*.test.js files).
//
//   node apps-script-chat-bot/test/dashboard_ui_rig.js [port]        (port 8790 when left out)
//
// It loads the bot with the test fakes (test/fakes.js), runs the golden one-space world (golden_flows.js) with the
// Live dashboard (Control row 54) and Slide deliveries (row 55) switches turned ON on the Control tab, as a person would,
// and with several of the bot's real flows: Burson's alert with mistakes (corrected, its Social Alert sent), Direct
// BigQuery cards (one with no action, one whose Social Alert waits as a draft: B30 is blank), a Watch alert whose T&S
// form the bot submits (row 12 ON), a small Watch flag held to be grouped, Early Detection stories carded, one held back
// as routine noise by the fast triage, then six hours of the real Early Detection producer on posts handed to its
// BigQuery lanes (a story carded from its cache, a two-account story and a copy-paste ring still forming). Then it
// serves the page exactly as doGet builds it (the Dashboard template evaluated: include_ and viewerEmail) on
// http://127.0.0.1:<port>/, with a google.script.run shim whose every call runs the REAL function of that loaded bot,
// as the viewer, and hands back its real answer through a JSON round trip.
//
// What is not the bot's own: the fakes of Google's services (as in every test), the scripted Gemini answers (as in the
// golden flows; the slide summaries cite the first post given), a fake Google Slides deck the bot's account can edit
// (test/fake_slides.js: four slides, two layouts) and dashAccess_, stubbed to let in one made-up viewer. The bot's clock
// is the fake one of the golden world, moving on in real time from the end of the timeline; the bot's own time triggers
// (poll every minute, the delivery dispatcher every 5 minutes, ...) run as Apps Script would run them. The page's own
// clock is left alone: the device's clock reads weeks after the bot's, as a wrong device clock would, and the page must
// still say "updated 14 s ago" (it counts from the bot's clock in each answer, never from the device's).
//
// Routes: GET / (the page), POST /__rig/run (one google.script.run call), GET /__rig/info (the viewer, the deck's link,
// the bot's time), GET /__rig/problems (every call that failed, threw, or answered what google.script.run can't carry:
// a driver fails on any), GET /__rig/deck (the fake deck's slides as plain data, with each body's size in points, to
// check what a run put in it),
// GET /__rig/build?bot=<id>&url=<link> (the bot's newest build id and the web app's link, as poll() and a deployment
// would set them, with the bot's time triggers held so poll() does not put BOT_BUILD back; GET /__rig/build alone puts
// both back and lets the triggers run again).
//
// Every post and account is made up; every address ends in .test. Nothing here is part of the bot or pushed with it.
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const BOT_DIR = path.join(__dirname, '..');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const VIEWER = 'viewer@team.test';
const DECK = 'deckRigWeeklyBrandReview01';
const ZAPIER = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
const SMALL = 'https://x.com/smallvoice/status/2150000000000000041';
const NOISE = 'https://x.com/dinofan/status/2150000000000000051';
const EWS_COLS = [['kind'], ['lane'], ['mid'], ['url'], ['platform'], ['author'], ['audience', 'INTEGER'], ['eng', 'INTEGER'],
  ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'], ['txt'], ['topic'], ['chash'], ['sig'], ['risk'], ['brand', 'BOOLEAN']];

/**
 * The helpers run_tests.js gives every switch_*.test.js file (H: e2e, F, REAL, ...), made by running that file's own
 * code up to where it loads the test files, so no test is loaded or run. Throws when that line has moved.
 */
function testHelpers() {
  const file = path.join(__dirname, 'run_tests.js');
  const src = fs.readFileSync(file, 'utf8');
  const cut = src.indexOf('require(\'fs\').readdirSync(__dirname).filter(f => /^switch_');
  if (cut < 0) throw new Error('dashboard_ui_rig: run_tests.js no longer loads its switch_*.test.js files where the rig expects');
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(__dirname);
  m._compile(`${src.slice(0, cut)}\nmodule.exports = H;\n`, file);
  return m.exports;
}

/** A post on the Early Detection producer's real-time lane, seen at `at` (posted a minute before). Pure. */
function lanePost(i, at, o) {
  return Object.assign({ kind: 'post', lane: 'sonar', mid: `SONAR|M-${i}`, url: `https://x.com/user${i}/status/21600000000000${String(i).padStart(5, '0')}`,
    platform: 'twitter', author: `user${i}`, audience: 300, eng: 10 + i, posted_ms: at - MIN, seen_ms: at,
    txt: `Post ${i}`, topic: 'Other', chash: `h_${i}`, sig: `sig_${i}`, risk: '', brand: false }, o || {});
}

/** The fake deck the bot's account can edit: a title slide, the agenda, a wins slide and a closing slide; two layouts. */
function deckSpec() {
  return {
    id: DECK, name: 'Weekly brand review', access: 'edit', editors: [VIEWER],
    layouts: [
      { name: 'TITLE', background: '#0b1f3a', placeholders: [{ type: 'CENTERED_TITLE', style: { fontFamily: 'Georgia', fontSize: 44, color: '#ffffff' } },
        { type: 'SUBTITLE', style: { fontFamily: 'Georgia', fontSize: 22, color: '#c9d7f2' } }] },
      { name: 'TITLE_AND_BODY', background: '#fbf7ef', placeholders: [{ type: 'TITLE', style: { fontFamily: 'Georgia', fontSize: 30, color: '#0b1f3a' } },
        { type: 'BODY', style: { fontFamily: 'Arial', fontSize: 16, color: '#2b2b2b' } }] },
    ],
    slides: [
      { layout: 'TITLE', title: 'Weekly brand review', body: 'Brand Social' },
      { layout: 'TITLE_AND_BODY', title: 'Agenda', body: 'Pulse\nWins\nRisks' },
      { layout: 'TITLE_AND_BODY', title: 'Wins this week', body: 'The launch went well' },
      { layout: 'TITLE', title: 'Thank you' },
    ],
  };
}

/**
 * The golden one-space world with rows 54 and 55 ON, its whole timeline run (the same flows as the live dashboard's
 * tests: switch_dashboard_live.test.js), the fake deck installed, the store sheet shared with the viewer as an editor
 * and Gemini's slide summaries scripted. {t, slides, golden}.
 */
function buildWorld(H) {
  const golden = require('./golden_flows')(H);
  const w = golden.world.oneSpaceWorld();
  const { t, sh, feed, rec } = w;
  sh.getRange(54, 2).setValue('ON');  // Live dashboard
  sh.getRange(55, 2).setValue('ON');  // Slide deliveries
  sh.getRange(12, 2).setValue('ON');  // Auto-submit T&S form
  t.bot.ev(`dashAccess_ = () => ({ ok: true, email: "${VIEWER}", self: false, why: '' })`);
  // the producer's two BigQuery lanes, answered from `posts` (each post handed over once); Gemini Decisions says the
  // dinosaur story is routine noise (the fast triage holds it back)
  const posts = [];
  let served = 0;
  const prev = t.g.services.UrlFetchApp.fetch;
  const decisions = JSON.parse(fs.readFileSync(path.join(__dirname, 'decisions_fixtures.json'), 'utf8'))
    .signal_responses['ED-CLU-CLU-e9dddc0be913-202611071746'];
  const noise = JSON.parse(JSON.stringify(decisions));
  Object.assign(noise.answers.routine_noise, { value: true, noul: 0.95, confidence: 0.95, true_probability: 0.95, false_probability: 0.05 });
  Object.assign(noise.answers.severity, { score: 1, most_likely_level: 1, confidence: 0.7, probabilities: { 0: 0.1, 1: 0.7, 2: 0.1, 3: 0.05, 4: 0.05 } });
  t.g.services.UrlFetchApp.fetch = (link, params) => {
    const url = String(link);
    if (url.includes('/decisions') && /dinofan|dinosaur/.test(String((params && params.payload) || ''))) {
      return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(noise) };
    }
    if (url.startsWith('https://bigquery.googleapis.com/') && String((params && params.method) || '').toLowerCase() === 'post' && /\/queries$/.test(url)) {
      const body = JSON.parse(params.payload);
      const lane = (String(body.query || '').match(/^-- ews:(us|c1)\b/) || [])[1];
      if (lane) {
        const now = t.g.clock.now;
        const rows = lane === 'c1' ? posts.filter(p => p.seen_ms > served && p.seen_ms <= now) : [];
        if (lane === 'c1') served = now;
        const resp = { jobComplete: true, jobReference: { projectId: 'brand-social-central-data', jobId: `ews_${now}_${lane}`, location: body.location },
          schema: { fields: EWS_COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
          rows: rows.map(r => ({ f: EWS_COLS.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })) };
        return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(resp) };
      }
    }
    return prev(link, params);
  };
  // Gemini's review of the Photos story: rated high
  const ed = t.g.vertex.earlyDetection;
  t.g.vertex.earlyDetection = payload => {
    const text = payload.contents[0].parts.map(p => p.text || '').join('\n');
    if (!/Google Photos/.test(text)) return ed(payload);
    const out = ed(payload);
    return Object.assign(out, { issue_name: 'Google Photos backups wiped after a storage plan change',
      story_title: 'Photos users say backups were wiped after a storage plan change', summary: 'Small accounts say Google Photos wiped their backups.',
      early_detection_call: Object.assign({}, out.early_detection_call, { severity: 'high', reason: 'Several users describe losing years of photos' }) });
  };
  // Gemini's slide summaries (SlideDeliveries.gs): the issue in plain words, the first post given cited
  const v = t.g.vertex;
  const handle = v.handle.bind(v);
  v.handle = (url, params) => {
    const payload = JSON.parse(params.payload);
    const props = ((payload.generationConfig || {}).responseSchema || {}).properties || {};
    if (!props.segments) return handle(url, params);
    const text = payload.contents[0].parts.map(p => p.text || '').join('\n');
    const facts = JSON.parse((text.match(/<issue>\n([\s\S]*?)\n<\/issue>/) || [])[1] || '{"posts":[]}');
    const posts = Array.isArray(facts.posts) ? facts.posts.filter(p => p && p.ref) : [];
    const result = { segments: posts.length
      ? [{ text: 'Posts describe ', ref: '' }, { text: 'what happened to them', ref: posts[0].ref }, { text: ' in their own words.', ref: '' }]
      : [{ text: 'Posts describe the issue in their own words.', ref: '' }] };
    return { code: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(result) }] }, finishReason: 'STOP' }] } };
  };

  // the timeline (as switch_dashboard_live.test.js runs it)
  rec.collect('setup');
  rec.step('01 first run: the watch tabs are made', 1);
  golden.world.watchOn(t);
  sh.getRange(35, 2).setValue('Auto-correct space (B10)');
  rec.step('02 quiet run', 1);
  rec.step('03 Burson alert with mistakes', 1, () => { t.chat.say(H.REAL, H.F.MISTAKES, ZAPIER); });
  rec.step('04 Direct BigQuery finds the Pixel post', 3, () => { feed.bsip = [golden.rows.bsipRow()]; });
  rec.step('05 the Pixel card is reviewed', 1);
  rec.step('06 the watch flags the Gemini post, and a small post', 1, () => {
    feed.look = [golden.rows.hit(), golden.rows.hit({ post_url: SMALL, author: '@smallvoice', followers: 150, eng: 12,
      issue: 'Gemini app will not summarize a long PDF', topic: 'AI answers and Gemini',
      summary: 'An X user (@smallvoice, 150 followers) says the Gemini app will not summarize a long PDF.' })];
  });
  rec.step('07 the watch alert is triaged', 1, () => { feed.look = []; });
  rec.step('08 quiet run', 2);
  rec.step('09 Maps (its Social Alert waits: B30 is blank) and a story', 5, () => {
    t.set('B30', '');
    feed.bsip = [golden.rows.bsipRow(), golden.rows.mapsRow()];
    feed.stories = [golden.rows.story()];
  });
  rec.step('10 the Maps card is reviewed', 1, () => { feed.look = [golden.rows.mapsHit()]; });
  rec.step('11 quiet run', 1, () => { feed.look = []; });
  rec.step('12 the Pixel story, and a story of routine noise', 14, () => {
    feed.stories = [golden.rows.story(), golden.rows.pixelStory(), golden.rows.story({ alert_id: 'ED-CLU-clu_dino-202610141245',
      cluster_id: 'clu_dino', signal_key: 'clu_dino', headline: 'Low-tier claim cluster (5 accounts): my dinosaur game high score in Chrome',
      primary_url: NOISE, risk_groups: '', topic_product: 'Chrome', representative_posts_json: JSON.stringify([
        { platform: 'X', author_handle: 'dinofan', followers: 120, engagement_total: 4, published_at: '2026-10-14 12:40 UTC', url: NOISE,
          snippet: 'New high score on the Chrome dinosaur game while the wifi was out, 4000 points.' },
        { platform: 'X', author_handle: 'dinofan2', followers: 90, engagement_total: 2, published_at: '2026-10-14 12:41 UTC',
          url: 'https://x.com/dinofan2/status/2150000000000000052', snippet: 'Beat my dinosaur game score today, 3500.' }]) })];
  });
  rec.step('13 quiet run', 1);
  t.bot.bqEarlyDetectionRows_ = (m, op) => feed.stories.map(r => JSON.parse(JSON.stringify(r))).concat(t.bot.ewsRows_(m, op));
  const start = t.g.clock.now;
  for (let i = 1; i <= 6; i++) {
    posts.push(lanePost(i, start + 5 * MIN + i * MIN, { url: i % 2 ? `https://x.com/photos${i}/status/216000000000000000${i}`
      : `https://www.reddit.com/r/googlephotos/comments/1ph${i}/backup_wiped/`, platform: i % 2 ? 'twitter' : 'reddit', author: `photos${i}`,
    txt: `Google Photos wiped my photos from the backup after the storage plan change, years of pictures gone, support says nothing ${i}`,
    topic: 'Google Photos', risk: 'outage_broken_feature', brand: true }));
  }
  const stopAt = (Math.floor(start / HOUR) + 6) * HOUR + 20 * MIN;
  const lastHour = Math.floor(stopAt / HOUR) - 1;
  for (let i = 20; i < 22; i++) {
    posts.push(lanePost(i, (lastHour - 2) * HOUR + (10 + i) * MIN, { author: `nestuser${i}`, url: `https://x.com/nestuser${i}/status/21700000000000000${i}`,
      txt: `Nest thermostat went offline overnight and the house is freezing, the app cannot reach it at all ${i}`, topic: 'Nest' }));
  }
  for (let i = 40; i < 47; i++) {
    posts.push(lanePost(i, lastHour * HOUR + (5 + 5 * (i - 40)) * MIN, { author: `ringuser${i}`, url: `https://x.com/ringuser${i}/status/21800000000000000${i}`,
      txt: 'My phone dialer screen freezes completely right after installing the overnight update patch, cannot call anyone at all',
      topic: 'Phones', chash: 'ring_same_text', risk: 'outage_broken_feature' }));
  }
  let n = 0;
  while (t.g.clock.now + 15 * MIN <= stopAt) rec.step(`p${n++}`, 15);

  // the deck, and the store sheet shared with the viewer as an editor (who may set up deliveries)
  const slides = require('./fake_slides')();
  slides.addDeck(deckSpec());
  slides.install(t.g, t.bot);
  t.g.drive.files.set(t.g.props.get('STORE_SHEET_ID'), { editors: [VIEWER] });
  return { t, slides, golden };
}

/** HTML escaped for a printing scriptlet (<?= ?>). Pure. */
function escHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

/**
 * Evaluates an HtmlService template's scriptlets in the bot's own global scope, as Apps Script does: <? code ?>,
 * <?= printed, escaped ?> and <?!= printed as it is ?>, with the template's fields as names in scope.
 */
function evaluateTemplate(bot, src, fields) {
  let code = 'var __out = [];\n';
  let at = 0;
  const re = /<\?(!=|=)?([\s\S]*?)\?>/g;
  let m;
  while ((m = re.exec(src))) {
    code += `__out.push(${JSON.stringify(src.slice(at, m.index))});\n`;
    if (m[1] === '!=') code += `__out.push(String(${m[2]}));\n`;
    else if (m[1] === '=') code += `__out.push(__esc(${m[2]}));\n`;
    else code += `${m[2]}\n`;
    at = re.lastIndex;
  }
  code += `__out.push(${JSON.stringify(src.slice(at))});\nreturn __out.join('');`;
  bot.__rigTemplate = { fields: fields || {}, esc: escHtml };
  return vm.runInContext(`(function (__t) { var __esc = __t.esc; with (__t.fields) { return (function () { ${code} })(); } })(__rigTemplate)`, bot);
}

/** A fake HtmlService for doGet: templates and partials read from the bot's .html files. */
function htmlService(bot) {
  const file = name => fs.readFileSync(path.join(BOT_DIR, `${name}.html`), 'utf8');
  const output = content => {
    const o = { content, title: '', metas: [], xframe: null };
    o.getContent = () => o.content;
    o.setTitle = t => { o.title = String(t); return o; };
    o.getTitle = () => o.title;
    o.addMetaTag = (name, value) => { o.metas.push([String(name), String(value)]); return o; };
    o.setXFrameOptionsMode = mode => { o.xframe = mode; return o; };
    return o;
  };
  return {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    createHtmlOutput: html => output(String(html === undefined ? '' : html)),
    createHtmlOutputFromFile: name => output(file(name)),
    createTemplateFromFile: name => {
      const src = file(name);
      const tpl = {};
      tpl.evaluate = () => {
        const fields = {};
        Object.keys(tpl).forEach(k => { if (k !== 'evaluate') fields[k] = tpl[k]; });
        return output(evaluateTemplate(bot, src, fields));
      };
      return tpl;
    },
  };
}

/** The bot's public functions (what google.script.run reaches): top-level functions whose names do not end in _. */
function publicFunctions() {
  const names = new Set();
  fs.readdirSync(BOT_DIR).filter(f => f.endsWith('.gs')).forEach(f => {
    const src = fs.readFileSync(path.join(BOT_DIR, f), 'utf8');
    let m;
    const re = /^function\s+([A-Za-z$][\w$]*)\s*\(/gm;
    while ((m = re.exec(src))) if (!m[1].endsWith('_')) names.add(m[1]);
  });
  return Array.from(names).sort();
}

/**
 * Where a value holds something google.script.run can't carry back to the page (a Date, a function, a value of another
 * kind): its path, else ''. Apps Script answers such a call with null. Pure.
 */
function illegalAt(v, at) {
  const where = at || 'the answer';
  if (v === null || v === undefined) return '';
  const kind = Object.prototype.toString.call(v);
  if (typeof v === 'function') return `${where} (a function)`;
  if (kind === '[object Date]') return `${where} (a Date)`;
  if (typeof v !== 'object') return '';
  if (kind !== '[object Object]' && kind !== '[object Array]') return `${where} (${kind})`;
  for (const k of Object.keys(v)) {
    const bad = illegalAt(v[k], `${where}.${k}`);
    if (bad) return bad;
  }
  return '';
}

/** The script put ahead of the page: google.script.run calling the rig (the page's clock is left alone). */
function shimScript(fns) {
  return `<script>
/* dashboard_ui_rig: not part of the page. google.script.run calls the bot's real functions in the rig (POST /__rig/run). */
(function () {
  var FNS = ${JSON.stringify(fns)};
  function Runner(ok, fail, user) { this.__ok = ok || null; this.__fail = fail || null; this.__user = user; }
  Runner.prototype.withSuccessHandler = function (f) { return new Runner(f, this.__fail, this.__user); };
  Runner.prototype.withFailureHandler = function (f) { return new Runner(this.__ok, f, this.__user); };
  Runner.prototype.withUserObject = function (u) { return new Runner(this.__ok, this.__fail, u); };
  FNS.forEach(function (fn) {
    Runner.prototype[fn] = function () {
      var self = this;
      var args = Array.prototype.slice.call(arguments);
      fetch('/__rig/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fn: fn, args: args }) })
        .then(function (r) { if (!r.ok) throw new Error('the rig answered ' + r.status); return r.json(); })
        .then(function (x) {
          if (x.error) {
            var e = new Error(x.error.message);
            e.name = x.error.name || 'ScriptError';
            if (self.__fail) self.__fail(e, self.__user); else console.error('Uncaught ' + e.name + ': ' + e.message);
          } else if (self.__ok) self.__ok(x.value, self.__user);
        })
        .catch(function (e) {
          console.error('dashboard_ui_rig: the call ' + fn + ' could not reach the rig: ' + e.message);
          if (self.__fail) self.__fail(new Error('NetworkError: Connection failure due to HTTP 0'), self.__user);
        });
    };
  });
  window.google = { script: { run: new Runner(null, null) } };
})();
</script>`;
}

/** Reads a request's body as JSON ({} when there is none). */
function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', c => { s += c; });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/** Starts the rig: builds the world, then serves the page and the shim until stopped. Resolves {server, port, world}. */
function main(port) {
  const H = testHelpers();
  const built = Date.now();
  const world = buildWorld(H);
  const { t, slides } = world;
  const g = t.g;
  const bot = t.bot;
  bot.HtmlService = htmlService(bot);
  const fns = publicFunctions();
  const problems = [];
  const build = { saved: null };

  // the bot's clock moves on in real time from here (Chat and Gmail still move it on a second per message)
  const realStart = Date.now();
  let base = g.clock.now;
  Object.defineProperty(g.clock, 'now', { configurable: true, enumerable: true,
    get: () => base + (Date.now() - realStart),
    set: value => { base += Number(value) - (base + (Date.now() - realStart)); } });

  /** Runs fn as `who` (the viewer for a page call, '' for a trigger run). */
  const as = (who, fn) => {
    const before = g.session.active;
    g.session.active = who;
    try { return fn(); } finally { g.session.active = before; }
  };

  // the bot's time triggers, run as Apps Script runs them: each every so many minutes of the bot's clock
  let minute = 0;
  let held = false;
  const tick = () => {
    if (held) return;
    minute++;
    g.triggers.filter(tr => tr.minutes && !tr.source).slice().forEach(tr => {
      if (minute % tr.minutes) return;
      if (typeof bot[tr.handler] !== 'function') { problems.push({ at: g.clock.now, fn: tr.handler, what: 'a time trigger names a function the bot does not have' }); return; }
      try { as('', () => bot[tr.handler]()); } catch (e) {
        console.log(`rig: the time trigger ${tr.handler} failed: ${e && e.message}`);
      }
    });
  };
  const timer = setInterval(tick, MIN);

  const page = () => as(VIEWER, () => {
    const out = bot.doGet({ parameter: {}, parameters: {}, queryString: '' });
    let html = out.getContent();
    const metas = (out.metas || []).map(([n, c]) => `<meta name="${escHtml(n)}" content="${escHtml(c)}">`).join('');
    const head = html.search(/<head[^>]*>/i);
    if (head < 0) throw new Error('dashboard_ui_rig: the page has no <head>');
    const at = head + html.slice(head).indexOf('>') + 1;
    html = `${html.slice(0, at)}\n${metas}${shimScript(fns)}${html.slice(at)}`;
    if (out.title) html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escHtml(out.title)}</title>`);
    if (/<\?/.test(html)) throw new Error('dashboard_ui_rig: a scriptlet was left in the page');
    return html;
  });

  const send = (res, code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const json = (res, code, v) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(v));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      try { send(res, 200, 'text/html; charset=utf-8', page()); } catch (e) {
        problems.push({ at: g.clock.now, fn: 'doGet', what: String(e && e.stack || e) });
        send(res, 500, 'text/plain; charset=utf-8', String(e && e.stack || e));
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && url.pathname === '/__rig/info') {
      json(res, 200, { viewer: VIEWER, deckUrl: `https://docs.google.com/presentation/d/${DECK}/edit`, deckId: DECK, now: g.clock.now,
        botAccount: g.session.effective, triggers: g.triggers.map(tr => ({ handler: tr.handler, minutes: tr.minutes || null })) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__rig/problems') { json(res, 200, problems); return; }
    if (req.method === 'GET' && url.pathname === '/__rig/build') {
      const props = g.props;
      if (!build.saved) build.saved = { bot: props.get('BOT_BUILD'), url: g.script.url };
      const bot = url.searchParams.get('bot');
      if (bot !== null) {
        held = true;
        props.set('BOT_BUILD', bot);
        g.script.url = url.searchParams.get('url') || '';
      } else {
        held = false;
        if (build.saved.bot === undefined || build.saved.bot === null) props.delete('BOT_BUILD'); else props.set('BOT_BUILD', build.saved.bot);
        g.script.url = build.saved.url;
        build.saved = null;
      }
      json(res, 200, { bot: props.get('BOT_BUILD') || '', url: g.script.url, held });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__rig/deck') {
      json(res, 200, { slides: slides.snapshot(DECK).map(s => ({ id: s.id, layout: s.layout, text: slides.textOf(s.id), links: slides.linksOf(s.id),
        bodyPt: (slides.styleAt(s.id, 'BODY', 0) || {}).fontSize || null })) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__rig/run') {
      bodyOf(req).then(body => {
        const fn = String(body.fn || '');
        const args = JSON.parse(JSON.stringify(Array.isArray(body.args) ? body.args : []));
        if (!fns.includes(fn) || typeof bot[fn] !== 'function') {
          problems.push({ at: g.clock.now, fn, what: 'the page called a function the bot does not have' });
          json(res, 200, { error: { name: 'ScriptError', message: `Script function not found: ${fn}` } });
          return;
        }
        let value;
        try {
          value = as(VIEWER, () => bot[fn].apply(null, args));
        } catch (e) {
          problems.push({ at: g.clock.now, fn, args, what: `threw: ${e && e.message}` });
          json(res, 200, { error: { name: (e && e.name) || 'Error', message: String((e && e.message) || e) } });
          return;
        }
        const bad = illegalAt(value);
        if (bad) {
          problems.push({ at: g.clock.now, fn, args, what: `answered what google.script.run can't carry: ${bad} (the page gets null)` });
          value = null;
        }
        if (value && typeof value === 'object' && value.ok === false && !value.off && !value.denied) {
          console.log(`rig: ${fn} answered ok: false: ${String(value.why || '').slice(0, 200)}`);
        }
        json(res, 200, { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
      }).catch(e => {
        problems.push({ at: g.clock.now, fn: '(request)', what: String(e && e.message) });
        json(res, 400, { error: { name: 'Error', message: String(e && e.message) } });
      });
      return;
    }
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
  });
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`dashboard_ui_rig: the world was built in ${((Date.now() - built) / 1000).toFixed(1)} s; the bot's clock reads ${new Date(g.clock.now).toISOString()}`);
      console.log(`dashboard_ui_rig: serving the live dashboard as ${VIEWER} on http://127.0.0.1:${port}/ (Ctrl+C to stop)`);
      console.log(`dashboard_ui_rig: the deck to paste: https://docs.google.com/presentation/d/${DECK}/edit`);
      resolve({ server, port, world, problems, stop: () => { clearInterval(timer); server.close(); } });
    });
  });
}

if (require.main === module) {
  main(Number(process.argv[2]) || 8790).catch(e => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = { main, evaluateTemplate, publicFunctions, illegalAt };
