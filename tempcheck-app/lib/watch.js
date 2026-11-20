/**
 * watch.js — automatic temp checks: puts each incoming alert through the trigger rules (triggers.js) and starts or
 * refreshes a temp check when they say so. OFF until someone turns it on in the page; switching it on never acts on
 * alerts that came before.
 *
 * What it does when on, once a minute:
 *   - reads the alerts that came in since the last look (feed.js: today, the chat bot's Alert log, read-only; another
 *     feed can hand alerts straight to `incoming`);
 *   - a high-engaging alert, or the third different post alerted on one issue in a day, starts a temp check from the
 *     alert's issue name, words and link (service.startFromAlert): a draft, there to get an analyst's attention;
 *   - an alert that starts nothing has its post read again 30 and 90 minutes later (X posts: X's public embed data);
 *     a post that is climbing starts the temp check then (rising post momentum);
 *   - a new alert on an issue that already has a temp check refreshes it, hourly at most, reusing the posts it kept;
 *   - scheduled refreshes run whether or not the feed is being watched (`schedule`: every N minutes until a set time).
 *
 * It starts at most `maxStartsPerDay` temp checks a day, one at a time, and keeps a line for every alert saying what
 * it did and why (data/watch.json). A temp check that finds no posts in our tables is logged as 'empty', not as a
 * draft: nobody is pointed at it, and the issue stays open to a later try.
 */
'use strict';

const triggers = require('./triggers');
const service = require('./service');
const store = require('./store');
const own = require('./owndata');
const xposts = require('./xposts');
const feed = require('./feed');
const inchat = require('./inchat');

const FILE = 'watch.json';
const TICK_MS = 60 * 1000;
// A post that started nothing is read again this long after its alert (minutes). TEMPCHECK_READ_AGAIN_MIN="1,2" shortens
// it for a trial.
const READ_AGAIN_MIN = String(process.env.TEMPCHECK_READ_AGAIN_MIN || '30,90').split(',').map(Number).filter(v => v > 0);
const KEEP_H = 48;                      // an issue's alerts and readings are kept this long
const LOG_MAX = 300;

let timer = null;
let busy = false;

function load() {
  return Object.assign({ on: false, primed: false, settings: {}, issues: {}, seen: [], recent: [], log: [], schedules: [], day: '', starts: 0, lastTick: 0, lastError: '' },
    store.readFile(FILE, null) || {});
}

function save(st) { store.writeFile(FILE, st); }

function note(st, entry) {
  st.log.push(Object.assign({ at: Date.now() }, entry));
  if (st.log.length > LOG_MAX) st.log = st.log.slice(-LOG_MAX);
}

function today() { return new Date().toISOString().slice(0, 10); }

function xId(url) { return (/(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/i.exec(String(url || '')) || [])[1] || ''; }

/** One reading of a post's engagement from X's own public data (likes + replies), or null: for X posts only. */
async function readPost(url) {
  const id = xId(url);
  if (!id) return null;
  const got = (await xposts.lookup([id]))[id];
  return got ? { at: Date.now(), eng: (Number(got.likes) || 0) + (Number(got.replies) || 0), src: 'x' } : null;
}

function waitFor(job) {
  return new Promise(resolve => {
    const look = () => (job.status === 'running' ? setTimeout(look, 500) : resolve(job));
    look();
  });
}

/** Starts the issue's temp check from `alert` and waits for it; the issue remembers it. Counts against the day's cap. */
async function startCheck(st, is, alert, rule, reasons) {
  const s = triggers.settings(st.settings);
  if (st.day !== today()) { st.day = today(); st.starts = 0; }
  if (st.starts >= s.maxStartsPerDay) {
    note(st, { alert: alert.id, issue: is.name, action: 'held', rule, reasons: reasons.concat([`Not started: ${s.maxStartsPerDay} temp checks were already started automatically today.`]) });
    return;
  }
  if (is.emptyAt && Date.now() - is.emptyAt < s.refreshEveryMin * 60000) {
    note(st, { alert: alert.id, issue: is.name, action: 'none', rule, reasons: reasons.concat([`Not tried again yet: the last try found no posts in our tables ${Math.round((Date.now() - is.emptyAt) / 60000)} minutes ago.`]) });
    return;
  }
  st.starts++;
  const job = await waitFor(service.startFromAlert({ issue: is.name, text: alert.text, url: alert.url, alertAt: alert.at }));
  const rec = job.status === 'done' ? store.read(job.recordId) : null;
  if (rec && !(rec.total > 0)) {  // nothing in our tables: no draft to point anyone at, and the issue stays open to a later try
    is.emptyAt = Date.now();
    note(st, { alert: alert.id, issue: is.name, action: 'empty', rule, record: job.recordId,
      reasons: reasons.concat(['The rules said to start one, but our own tables held no posts for it, so there is no draft. It is tried again on a later alert for this issue.']) });
    return;
  }
  if (rec) { is.checkId = job.recordId; is.checkAt = Date.now(); is.startedBy = rule; delete is.watch; delete is.emptyAt; }
  note(st, { alert: alert.id, issue: is.name, action: rec ? 'start' : 'failed', rule, reasons, record: job.recordId || '', error: job.error || '' });
}

/** Refreshes the issue's temp check (an update, reusing the posts it kept) and waits for it. */
async function refreshCheck(st, is, why, alertId) {
  const job = await waitFor(service.start({ updateOf: is.checkId, own: { on: true, reuse: is.checkId } }));
  if (job.status === 'done') { is.checkId = job.recordId; is.checkAt = Date.now(); }
  note(st, { alert: alertId || '', issue: is.name, action: job.status === 'done' ? 'refresh' : 'failed', rule: 'refresh', reasons: [why], record: job.recordId || '', error: job.error || '' });
}

/**
 * One alert ({id, at, issue, eng, url, text}) through the rules, acting on what they say. Returns the decision.
 * `dry`: decide and record nothing.
 */
async function ingest(st, alert, dry) {
  const s = triggers.settings(st.settings);
  const key = triggers.issueKey(alert.issue);
  const is = st.issues[key] || (st.issues[key] = { name: alert.issue, alerts: [], readings: {} });
  const post = own.postKey(alert.url) || String(alert.id);
  const mine = { id: String(alert.id), at: Number(alert.at) || Date.now(), eng: Number(alert.eng) || 0, post };
  const d = triggers.decide(mine, is, { s, bar: triggers.highBar(st.recent, s) });
  if (dry) return d;
  const cut = mine.at - KEEP_H * triggers.HOUR;
  is.alerts = is.alerts.filter(a => a.at >= cut).concat([mine]);
  is.readings[post] = (is.readings[post] || []).filter(r => r.at >= cut).concat([{ at: mine.at, eng: mine.eng, src: 'alert' }]);
  st.recent = st.recent.concat([mine.eng]).slice(-500);
  st.seen = st.seen.concat([mine.id]).slice(-3000);
  if (d.action === 'start') {
    await startCheck(st, is, alert, d.rule, d.reasons);
  } else if (d.action === 'refresh') {
    await refreshCheck(st, is, d.reasons[0], mine.id);
  } else {
    if (!is.checkId) {  // nothing started: its post is read again later, to see whether it is climbing
      is.watch = is.watch || {};
      const first = await readPost(alert.url).catch(() => null);
      if (first) is.readings[post].push(first);
      is.watch[post] = { url: alert.url, text: alert.text, id: mine.id, at: mine.at, due: READ_AGAIN_MIN.map(m => mine.at + m * 60000), readable: !!first };
    }
    note(st, { alert: mine.id, issue: is.name, action: 'none', rule: '', reasons: d.reasons });
  }
  return d;
}

/** The posts due a second look: read again, and a climbing one starts its issue's temp check. */
async function readAgain(st) {
  const now = Date.now();
  const s = triggers.settings(st.settings);
  for (const key of Object.keys(st.issues)) {
    const is = st.issues[key];
    if (is.checkId || !is.watch) continue;
    for (const post of Object.keys(is.watch)) {
      const w = is.watch[post];
      if (!w.readable || !w.due.length || w.due[0] > now) { if (!w.due.length || now - w.at > KEEP_H * triggers.HOUR) delete is.watch[post]; continue; }
      w.due.shift();
      const r = await readPost(w.url).catch(() => null);
      if (!r) continue;
      is.readings[post] = (is.readings[post] || []).concat([r]);
      const up = triggers.rising(is.readings[post], s);
      if (up) {
        const mins = Math.round(up.hours * 60);
        await startCheck(st, is, { id: w.id, at: w.at, url: w.url, text: w.text }, 'momentum',
          [`Rising post momentum: the post went from ${up.from.toLocaleString('en-US')} to ${up.to.toLocaleString('en-US')} likes and replies in ${mins} minutes.`]);
        break;
      }
    }
  }
}

/** The scheduled refreshes that are due. A schedule past its end is dropped. */
async function runSchedules(st) {
  const now = Date.now();
  st.schedules = st.schedules.filter(sc => sc.until > now);
  for (const sc of st.schedules) {
    if (now - (sc.lastAt || 0) < sc.everyMin * 60000) continue;
    const is = { name: sc.issue, checkId: sc.checkId };
    await refreshCheck(st, is, `Scheduled: every ${sc.everyMin} minutes until ${new Date(sc.until).toLocaleString()}.`, '');
    sc.checkId = is.checkId;
    sc.lastAt = now;
    const known = st.issues[triggers.issueKey(sc.issue)];
    if (known && known.checkId) { known.checkId = is.checkId; known.checkAt = now; }
  }
}

/** One look: the alerts new since the last one (when watching), the posts due a second reading, the schedules. */
async function tick() {
  if (busy) return;
  busy = true;
  const st = load();
  try {
    if (st.on) {
      const alerts = await feed.newest(80);
      if (!st.primed) {  // just switched on: what is already there is noted, never acted on
        st.seen = st.seen.concat(alerts.map(a => String(a.id))).slice(-3000);
        st.recent = st.recent.concat(alerts.map(a => Number(a.eng) || 0)).slice(-500);
        st.primed = true;
      } else {
        const seen = new Set(st.seen);
        const theirs = inchat.cardsOn();  // story cards get their own temp check (inchat.js): not a second one from the rules
        for (const a of alerts.filter(x => !seen.has(String(x.id))).sort((x, y) => x.at - y.at)) {
          if (theirs && a.story) st.seen = st.seen.concat([String(a.id)]).slice(-3000);
          else await ingest(st, a);
          save(st);
        }
      }
    }
    await readAgain(st);     // posts due a second look, whichever feed their alert came from
    await runSchedules(st);
    st.lastError = '';
  } catch (e) {
    st.lastError = String((e && e.message) || e).slice(0, 300);
  }
  st.lastTick = Date.now();
  save(st);
  await inchat.tick().catch(() => {});  // new story cards and typed requests (it keeps its own record of what failed)
  busy = false;
  ensureTimer(st);
}

/** Posts still due a second look (their issue has no temp check yet). */
function postsDue(st) {
  return Object.keys(st.issues).reduce((n, k) => {
    const is = st.issues[k];
    return n + (is.checkId || !is.watch ? 0 : Object.keys(is.watch).filter(p => is.watch[p].readable && is.watch[p].due.length).length);
  }, 0);
}

function ensureTimer(st) {
  const need = st.on || st.schedules.length > 0 || postsDue(st) > 0 || inchat.active();
  if (need && !timer) timer = setInterval(() => { tick().catch(() => { busy = false; }); }, TICK_MS);
  if (!need && timer) { clearInterval(timer); timer = null; }
}

/** What the page shows: on or off, the settings, the bar now, today's count, what is being watched, the latest lines. */
function status() {
  const st = load();
  const s = triggers.settings(st.settings);
  const issues = Object.keys(st.issues).map(k => st.issues[k]);
  return { on: !!st.on, feed: feed.describe(), settings: s, defaults: triggers.DEFAULTS, bar: triggers.highBar(st.recent, s), recentAlerts: st.recent.length,
    startsToday: st.day === today() ? st.starts : 0, issuesWithCheck: issues.filter(i => i.checkId).length,
    postsWatched: postsDue(st),
    schedules: st.schedules, lastTick: st.lastTick, lastError: st.lastError, running: !!timer, log: st.log.slice(-60).reverse() };
}

/** Switches watching on or off and sets the rules' numbers: {on, settings}. Switching on never acts on earlier alerts. */
function configure(o) {
  const st = load();
  if (o && o.settings && typeof o.settings === 'object') {
    const clean = {};
    Object.keys(triggers.DEFAULTS).forEach(k => { const v = Number(o.settings[k]); if (Number.isFinite(v) && v > 0) clean[k] = v; });
    st.settings = clean;
  }
  if (o && typeof o.on === 'boolean' && o.on !== st.on) {
    st.on = o.on;
    st.primed = false;
    note(st, { action: o.on ? 'switched on' : 'switched off', issue: '', reasons: [o.on ? 'Watching incoming alerts from now on. Alerts already there are not acted on.' : 'No longer watching incoming alerts. Scheduled refreshes still run.'] });
  }
  save(st);
  ensureTimer(st);
  if (st.on) setTimeout(() => { tick().catch(() => { busy = false; }); }, 50);
  return status();
}

/**
 * An alert handed over by a feed ({id, issue, at, eng, url, text}): put through the rules now, in the background.
 * Returns what the rules say. For the alert web app's own feed; it works whether or not the Alert log is being watched.
 */
async function incoming(alert) {
  const a = alert || {};
  if (!String(a.issue || '').trim()) throw service.userError('The alert needs its issue name.');
  const st = load();
  const one = { id: String(a.id || `in-${Date.now()}`), issue: String(a.issue).trim(), at: Number(a.at) || Date.now(), eng: Number(a.eng) || 0, url: String(a.url || ''), text: String(a.text || '') };
  if (st.seen.indexOf(one.id) >= 0) return { action: 'none', rule: '', reasons: ['This alert was already taken in.'] };
  const d = await ingest(st, one, true);
  (async () => {
    while (busy) await new Promise(r => setTimeout(r, 300));
    busy = true;
    try { const now = load(); await ingest(now, one); save(now); ensureTimer(now); } finally { busy = false; }
  })().catch(() => { busy = false; });
  return d;
}

/** The rules tried on the newest `n` alerts of the feed with `settings`, starting nothing: a summary and each decision. */
async function replayNewest(n, settings) {
  const alerts = (await feed.newest(Math.max(20, Math.min(1000, Number(n) || 500)))).map(a => Object.assign({}, a, { post: own.postKey(a.url) || String(a.id) }));
  const out = triggers.replay(alerts, settings);
  if (!out.length) return { alerts: 0, days: 0, started: 0, refreshed: 0, monitored: 0, held: 0, byRule: {}, settings: triggers.settings(settings), decisions: [] };
  const days = Math.max(1 / 24, (out[out.length - 1].alert.at - out[0].alert.at) / (24 * triggers.HOUR));
  const count = f => out.filter(f).length;
  return { alerts: out.length, days, issues: new Set(out.map(o => triggers.issueKey(o.alert.issue))).size, settings: triggers.settings(settings),
    started: count(o => o.action === 'start'), refreshed: count(o => o.action === 'refresh'), monitored: count(o => o.action === 'none'), held: count(o => o.action === 'held'),
    byRule: { high: count(o => o.action === 'start' && o.rule === 'high'), multiple: count(o => o.action === 'start' && o.rule === 'multiple'), momentum: count(o => o.action === 'start' && o.rule === 'momentum') },
    note: 'Rising post momentum needs a post read again over time, so it never shows in a replay of past alerts.',
    decisions: out.filter(o => o.action !== 'none').slice(-120).reverse().map(o => ({ at: o.alert.at, id: o.alert.id, issue: o.alert.issue, eng: o.alert.eng,
      url: o.alert.url, text: String(o.alert.text || '').slice(0, 600), action: o.action, rule: o.rule, reasons: o.reasons })) };
}

/** Keeps a temp check refreshed: {recordId, everyMin (60), hours (24)}. Runs whether or not alerts are being watched. */
function schedule(o) {
  const rec = store.read(o && o.recordId);
  if (!rec) throw service.userError('The temp check to keep refreshed was not found.');
  const everyMin = Math.max(15, Math.min(720, Number(o.everyMin) || 60));
  const hours = Math.max(1, Math.min(96, Number(o.hours) || 24));
  const st = load();
  st.schedules = st.schedules.filter(sc => triggers.issueKey(sc.issue) !== triggers.issueKey(rec.issue));
  st.schedules.push({ id: `s${Date.now()}`, issue: rec.issue, checkId: rec.id, everyMin, until: Date.now() + hours * triggers.HOUR, lastAt: Date.now() });
  note(st, { action: 'scheduled', issue: rec.issue, reasons: [`Refreshed every ${everyMin} minutes for ${hours} hours.`], record: rec.id });
  save(st);
  ensureTimer(st);
  return status();
}

function unschedule(id) {
  const st = load();
  st.schedules = st.schedules.filter(sc => sc.id !== String(id));
  save(st);
  ensureTimer(st);
  return status();
}

/** On start-up: pick up where it was left (watching, schedules, the in-Chat switches). */
function resume() {
  const st = load();
  ensureTimer(st);
  return { on: !!st.on, schedules: st.schedules, inChat: inchat.active() };
}

/** After a switch elsewhere changed what the timer is needed for: starts or stops it, and looks once right away. */
function wake() {
  ensureTimer(load());
  if (timer) setTimeout(() => { tick().catch(() => { busy = false; }); }, 50);
}

module.exports = { status, configure, incoming, replayNewest, schedule, unschedule, resume, wake, tick };
