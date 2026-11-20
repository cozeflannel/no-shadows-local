/**
 * triggers.js — when an alert should lead to a temp check. Pure: no network, no clock of its own.
 *
 * The team's documents name the occasions (there is no single mention count that does it):
 *
 *   1. Rising post momentum      the alert's post is climbing, not tapering: monitoring becomes a temp check.
 *   2. A high-engaging alert     or multiple alerts appearing around the same issue.
 *   3. Scheduled coverage        temp checks on a set schedule for planned programming, or as needed (the button).
 *   4. Ongoing developments      once an issue has a temp check, a new alert on it prompts a refresh (a pulse check).
 *
 * This file turns the first, second and fourth into rules an alert can be put through (the third is a schedule kept
 * by watch.js). What it starts is a draft, there to get an analyst's attention: they use it, or do a fuller one.
 *
 * The documents give the occasions, not the numbers, so every number here is a setting with a starting value chosen
 * from what a week of real alerts looks like (noted beside each), for the team to tune:
 *   - two alerts in three already carry the "HIGH" engagement label (2,000+), so "high-engaging" can't mean that
 *     label: it means more engagement than nine in ten recent alerts;
 *   - a corrected alert is sent again minutes later for the same post, so "multiple alerts" counts different posts.
 */
'use strict';

const HOUR = 3600 * 1000;

const DEFAULTS = {
  highShare: 0.9,          // high-engaging: more engagement than this share of the recent alerts (0.9: the top tenth)...
  highMinAlerts: 100,      // ...once this many recent alerts are known; until then, highFloor engagements
  highFloor: 20000,        // (the top tenth of a week of alerts started at about 20,000)
  multiple: 3,             // multiple alerts: this many different posts alerted on one issue...
  multipleWithinH: 24,     // ...within this many hours
  momentumRise: 0.5,       // rising momentum: the post's engagement up by this share (0.5: half as much again)...
  momentumWithinH: 6,      // ...between two readings from the same source no further apart than this...
  momentumMin: 500,        // ...and at least this many engagements at the later one
  refreshEveryMin: 60,     // a refresh for an issue at most this often (the team's refresh is hourly)
  maxStartsPerDay: 20,     // temp checks started automatically in a day, at most
};

/** Settings with every number present and sane: `given` over DEFAULTS, a bad value falling back to the default. */
function settings(given) {
  const out = Object.assign({}, DEFAULTS);
  Object.keys(DEFAULTS).forEach(k => {
    const v = Number((given || {})[k]);
    if (Number.isFinite(v) && v > 0) out[k] = k === 'highShare' ? Math.min(0.999, v) : v;
  });
  return out;
}

/** An issue's name as the key its alerts share: case, quotes and punctuation aside. */
function issueKey(name) {
  return String(name || '').toLowerCase().replace(/["“”'‘’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The engagement an alert needs to count as high-engaging: the `highShare` point of `recent` (the engagement counts
 * of the recent alerts), or `highFloor` while fewer than `highMinAlerts` are known.
 */
function highBar(recent, s) {
  const known = (recent || []).map(Number).filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (known.length < s.highMinAlerts) return s.highFloor;
  return Math.max(1, known[Math.min(known.length - 1, Math.floor(known.length * s.highShare))]);
}

/**
 * Is a post climbing? `readings`: [{at, eng, src}] of one post, oldest first. Two readings from the same source
 * (an alert's own count is never set against X's own count: they count different things), within `momentumWithinH`,
 * the later one up by `momentumRise` or more and at `momentumMin` or more: {from, to, hours, src}. Else null.
 */
function rising(readings, s) {
  const list = (readings || []).filter(r => r && Number.isFinite(Number(r.eng)) && r.at).sort((a, b) => a.at - b.at);
  for (let j = list.length - 1; j > 0; j--) {
    for (let i = j - 1; i >= 0; i--) {
      const a = list[i];
      const b = list[j];
      if (a.src !== b.src || b.at - a.at > s.momentumWithinH * HOUR || b.at - a.at < 5 * 60000) continue;
      if (Number(b.eng) >= s.momentumMin && Number(a.eng) > 0 && Number(b.eng) >= Number(a.eng) * (1 + s.momentumRise)) {
        return { from: Number(a.eng), to: Number(b.eng), hours: (b.at - a.at) / HOUR, src: b.src };
      }
    }
  }
  return null;
}

const n = v => Math.round(Number(v) || 0).toLocaleString('en-US');

/**
 * What an alert leads to: {action: 'start' | 'refresh' | 'none', rule: 'high' | 'multiple' | 'momentum' | 'refresh' | '',
 * reasons: [a sentence each]}.
 *   alert  {id, at, eng (its engagement count), post (the post's key: one post, one key)}
 *   issue  what is known of its issue before this alert: {alerts: [{id, at, eng, post}], checkId, checkAt, readings:
 *          {[post]: [{at, eng, src}]}}
 *   ctx    {s (settings), bar (highBar now)}
 * An issue that already has a temp check is refreshed (rule 4), no more often than `refreshEveryMin`. One that has
 * none gets one when the alert is high-engaging, when it is the `multiple`th different post alerted on the issue
 * within `multipleWithinH`, or when its post is climbing. Otherwise it is monitored, and the reason says how far off.
 */
function decide(alert, issue, ctx) {
  const s = ctx.s;
  const is = issue || { alerts: [] };
  const at = Number(alert.at) || 0;
  if (is.checkId) {
    const since = at - (Number(is.checkAt) || 0);
    if (since >= s.refreshEveryMin * 60000) return { action: 'refresh', rule: 'refresh', reasons: ['A new alert on an issue that already has a temp check: it is refreshed.'] };
    return { action: 'none', rule: '', reasons: [`The issue's temp check was made ${Math.max(0, Math.round(since / 60000))} minutes ago; it is refreshed at most every ${s.refreshEveryMin}.`] };
  }
  const reasons = [];
  let rule = '';
  const eng = Number(alert.eng) || 0;
  if (eng >= ctx.bar) {
    rule = 'high';
    reasons.push(`A high-engaging alert: ${n(eng)} engagements, at or above ${n(ctx.bar)} (more than ${Math.round(s.highShare * 100)}% of recent alerts).`);
  }
  const posts = new Set(is.alerts.filter(a => at - a.at <= s.multipleWithinH * HOUR && a.at <= at).map(a => a.post || a.id));
  posts.add(alert.post || alert.id);
  if (posts.size >= s.multiple) {
    rule = rule || 'multiple';
    reasons.push(`Multiple alerts on this issue: ${posts.size} different posts in the last ${s.multipleWithinH} hours.`);
  }
  const up = rising(((is.readings || {})[alert.post] || []).concat([{ at, eng, src: 'alert' }]), s);
  if (up) {
    rule = rule || 'momentum';
    reasons.push(`Rising post momentum: the post went from ${n(up.from)} to ${n(up.to)} engagements in ${up.hours < 1 ? `${Math.round(up.hours * 60)} minutes` : `${up.hours.toFixed(1)} hours`}.`);
  }
  if (rule) return { action: 'start', rule, reasons };
  return { action: 'none', rule: '', reasons: [`Monitoring: ${n(eng)} engagements (the bar is ${n(ctx.bar)}), ${posts.size} of ${s.multiple} posts on this issue in ${s.multipleWithinH} hours, no rise seen.`] };
}

/**
 * The rules run over `alerts` ([{id, at, issue, eng, post}], any order) as if each had just come in, starting from
 * nothing known: [{alert, action, rule, reasons}], oldest first. Nothing is started: a 'start' only marks its issue as
 * having a temp check from then on, so later alerts on it read as refreshes. `recent` seeds the high-engaging bar
 * (the alerts before these); each alert then joins it. For trying settings on real alerts at no cost.
 */
function replay(alerts, given, recent) {
  const s = settings(given);
  const issues = {};
  const window = (recent || []).slice(-500);
  const dayStarts = {};
  return (alerts || []).slice().sort((a, b) => a.at - b.at).map(alert => {
    const key = issueKey(alert.issue);
    const is = issues[key] || (issues[key] = { alerts: [] });
    const d = decide(alert, is, { s, bar: highBar(window, s) });
    const day = new Date(alert.at).toISOString().slice(0, 10);
    if (d.action === 'start' && (dayStarts[day] || 0) >= s.maxStartsPerDay) {
      d.action = 'held';
      d.reasons.push(`Not started: ${s.maxStartsPerDay} temp checks were already started automatically that day.`);
    }
    if (d.action === 'start') { is.checkId = 'replay'; is.checkAt = alert.at; dayStarts[day] = (dayStarts[day] || 0) + 1; }
    if (d.action === 'refresh') is.checkAt = alert.at;
    is.alerts.push({ id: alert.id, at: alert.at, eng: alert.eng, post: alert.post });
    window.push(Number(alert.eng) || 0);
    if (window.length > 500) window.shift();
    return { alert, action: d.action, rule: d.rule, reasons: d.reasons };
  });
}

module.exports = { DEFAULTS, HOUR, settings, issueKey, highBar, rising, decide, replay };
