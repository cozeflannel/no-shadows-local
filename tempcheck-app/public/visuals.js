/*
 * visuals.js — the page's charts, its post cards and the overlay a post opens in. Plain JavaScript, no framework.
 *
 * Chart.js (loaded by the page) draws the charts. When it did not load, a chart's place says so, and the tables on
 * the same tab still carry every number. The overlay shows a post without leaving the app: what we hold of it and,
 * when its platform offers a frame for it, the post itself. That frame's address is only ever built here from the
 * post's own id on a short list of platforms; a link is never framed as it came.
 *
 * The functions marked Pure touch nothing on the page; test/visuals.test.js runs them in Node. The rest use the
 * page's own helpers (el, num, when, tableLabel: app.js), which are there by the time anything here is called.
 */
'use strict';

const VIZ = { charts: [], view: null };
const VIZ_COLORS = { brandwatch: '#4285f4', brandwatchSoft: '#c6dafc', peak: '#174ea6', ours: '#f29900', oursSoft: '#fde3b0',
  negative: '#d93025', neutral: '#9aa0a6', positive: '#188038', other: '#80868b' };
const PLATFORM_COLORS = { X: '#111111', Reddit: '#ff4500', Bluesky: '#1185fe', Instagram: '#c13584', Facebook: '#1877f2', YouTube: '#ff0000',
  TikTok: '#00a3a3', Threads: '#3c4043', LinkedIn: '#0a66c2', News: '#5f6368', Blogs: '#8e6bbf', Forums: '#7a5c3e', Tumblr: '#35465c',
  Reviews: '#b06000' };
const TYPE_COLORS = { 'original posts': '#4285f4', reposts: '#9aa0a6', comments: '#f29900' };

// ---------------------------------------------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------------------------------------------

/**
 * The frame a post can be shown in inside the app: {site, src, height | ratio}, or null when its platform offers none
 * (or the link isn't one of the shapes known here). `src` is put together from the post's id alone, on the platform's
 * own embed address: X, YouTube, Instagram, TikTok, Bluesky (links that carry the account's id) and Reddit. Pure.
 */
function embedFor(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u) || u.length > 2000 || /[\s<>"'`]/.test(u)) return null;
  let m = /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]{1,30}\/status(?:es)?\/(\d{5,25})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: 'X', src: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}&dnt=true&theme=light`, height: 560 };
  m = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/)([A-Za-z0-9_-]{11})(?:[&/?#]|$)/i.exec(u) ||
    /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: 'YouTube', src: `https://www.youtube-nocookie.com/embed/${m[1]}`, ratio: 16 / 9 };
  m = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9_.]{1,40}\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,24})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: 'Instagram', src: `https://www.instagram.com/${/^reel/i.test(m[1]) ? 'reel' : m[1].toLowerCase()}/${m[2]}/embed/`, height: 640 };
  m = /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[A-Za-z0-9_.-]{1,40}\/video\/(\d{8,25})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: 'TikTok', src: `https://www.tiktok.com/embed/v2/${m[1]}`, height: 740 };
  m = /^https?:\/\/bsky\.app\/profile\/(did:plc:[a-z0-9]{10,40})\/post\/([a-z0-9]{8,20})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: 'Bluesky', src: `https://embed.bsky.app/embed/${m[1].toLowerCase()}/app.bsky.feed.post/${m[2]}`, height: 520 };
  m = /^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([A-Za-z0-9_]{2,30})\/comments\/([a-z0-9]{4,12})(?:[/?#]|$)/i.exec(u);
  if (m) return { site: 'Reddit', src: `https://embed.reddit.com/r/${m[1]}/comments/${m[2]}/?embed=true&theme=light`, height: 560 };
  return null;
}

const sumN = list => (list || []).reduce((a, x) => a + (Number(x && x.n) || 0), 0);

/** The `max` biggest of `list` ([{label, n}]) and everything after them as one "Other": [{label, n}]. Pure. */
function topWithOther(list, max) {
  const rows = (list || []).filter(x => x && Number(x.n) > 0).slice().sort((a, b) => b.n - a.n);
  const top = rows.slice(0, max);
  const rest = sumN(rows.slice(max));
  return rest ? top.concat([{ label: 'Other', n: rest }]) : top;
}

/**
 * Two counts' sources side by side, each as a share of its own total: [{label, an, bn, a (%), b (%)}], the sources
 * either side leans on most first, `max` of them and the rest as "Other". Pure.
 */
function shareRows(a, b, max) {
  const ta = sumN(a);
  const tb = sumN(b);
  const by = new Map();
  (a || []).forEach(x => by.set(x.label, { label: x.label, an: Number(x.n) || 0, bn: 0 }));
  (b || []).forEach(x => { const r = by.get(x.label) || { label: x.label, an: 0, bn: 0 }; r.bn = Number(x.n) || 0; by.set(x.label, r); });
  const share = r => Object.assign(r, { a: ta ? (r.an * 100) / ta : 0, b: tb ? (r.bn * 100) / tb : 0 });
  const rows = Array.from(by.values()).map(share).sort((x, y) => Math.max(y.a, y.b) - Math.max(x.a, x.b));
  const rest = rows.slice(max);
  const top = rows.slice(0, max);
  if (rest.length) top.push(share({ label: 'Other', an: rest.reduce((n, r) => n + r.an, 0), bn: rest.reduce((n, r) => n + r.bn, 0) }));
  return top;
}

/**
 * Several hourly lists ([{at, n}]) on one row of hours: {at: [every hour any of them has, in order], series: [one
 * list of counts per input, null where that list has no such hour]}. Pure.
 */
function alignHours(lists) {
  const at = Array.from(new Set([].concat(...(lists || []).map(l => (l || []).map(h => Number(h.at)))))).sort((x, y) => x - y);
  return { at, series: (lists || []).map(l => {
    const by = new Map((l || []).map(h => [Number(h.at), Number(h.n) || 0]));
    return at.map(t => (by.has(t) ? by.get(t) : null));
  }) };
}

/** A post's engagement as {n (null when not known), text}: X's own likes and replies when we have them. Pure. */
function engagementOf(p) {
  const f = (v, one, many) => { const n = Math.round(Number(v) || 0); return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`; };
  if (p && p.likes !== undefined && p.likes !== null) {
    return { n: (Number(p.likes) || 0) + (Number(p.replies) || 0), text: `${f(p.likes, 'like', 'likes')} · ${f(p.replies, 'reply', 'replies')}` };
  }
  if (!p || p.eng === null || p.eng === undefined) return { n: null, text: 'engagement not known' };
  return { n: Number(p.eng) || 0, text: f(p.eng, 'engagement', 'engagements') };
}

// ---------------------------------------------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------------------------------------------

/** Takes down every chart drawn so far (before the page shows something else). */
function vizClear() {
  VIZ.charts.splice(0).forEach(c => { try { c.destroy(); } catch (e) { /* already gone */ } });
}

const hourTick = at => new Date(at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric' });
const stillMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * A chart in its frame: the element to put on the page. `title` heads it, `o.sub` explains it, `o.says` is what a
 * screen reader hears in place of the picture, `o.height` its height. Drawn once the element is on the page.
 */
function vizChart(title, config, o) {
  const opts = o || {};
  const canvas = el('canvas', { role: 'img', 'aria-label': opts.says || title });
  const holder = el('div', { class: 'viz' }, el('div', { class: 'viz-title' }, title), opts.sub ? el('div', { class: 'hint' }, opts.sub) : null,
    el('div', { class: 'viz-canvas', style: `height:${Number(opts.height) || 240}px` }, canvas));
  requestAnimationFrame(() => {
    if (!canvas.isConnected) return;
    if (!window.Chart) {
      canvas.parentNode.replaceWith(el('p', { class: 'warn' }, 'The chart library did not load (no connection to its CDN). The numbers are in the table on this tab.'));
      return;
    }
    const cfg = Object.assign({}, config);
    cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: stillMotion() ? false : { duration: 350 } }, config.options || {});
    VIZ.charts.push(new window.Chart(canvas, cfg));
  });
  return holder;
}

/** A row of big numbers: [{label, value, sub, cls}]. */
function statTiles(list) {
  return el('div', { class: 'tiles' }, list.filter(Boolean).map(t => el('div', { class: `tile${t.cls ? ` ${t.cls}` : ''}` },
    el('div', { class: 'k' }, t.label), el('div', { class: 'v' }, t.value), t.sub ? el('div', { class: 's' }, t.sub) : null)));
}

/** Bars lying down, one per row ([{label, n, color}]), the longest first as given. */
function barsChart(title, rows, o) {
  const opts = o || {};
  const list = rows.filter(Boolean);
  return vizChart(title, { type: 'bar',
    data: { labels: list.map(r => r.label), datasets: [{ label: opts.unit || 'Count', data: list.map(r => r.n), backgroundColor: list.map(r => r.color || VIZ_COLORS.brandwatch), borderRadius: 4, maxBarThickness: 26 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eef0f3' } }, y: { grid: { display: false }, ticks: { color: '#202124' } } } } },
  Object.assign({ height: Math.max(120, list.length * 34 + 48), says: `${title}: ${list.map(r => `${r.label} ${num(r.n)}`).join(', ')}.` }, opts));
}

/** A ring of parts ([{label, n, color}]); each part's share is written beside its name. */
function ringChart(title, parts, o) {
  const list = parts.filter(p => p && Number(p.n) > 0);
  const total = sumN(list);
  const pct = n => (total ? `${Math.max(n > 0 ? 1 : 0, Math.round((n * 100) / total))}%` : '');
  return vizChart(title, { type: 'doughnut',
    data: { labels: list.map(p => `${p.label}: ${pct(p.n)} (${num(p.n)})`), datasets: [{ data: list.map(p => p.n), backgroundColor: list.map(p => p.color), borderColor: '#fff', borderWidth: 2 }] },
    options: { cutout: '60%', plugins: { legend: { position: 'right', labels: { boxWidth: 12, color: '#202124' } }, tooltip: { callbacks: { label: c => ` ${c.label}` } } } } },
  Object.assign({ height: 200, says: `${title}: ${list.map(p => `${p.label} ${pct(p.n)}`).join(', ')}.` }, o || {}));
}

/** The count hour by hour: the peak hour darkest, the hour still running pale. `color`: 'ours' for our own tables' posts. */
function hoursChart(rec, hours, unit, color) {
  const hrs = hours || [];
  const cur = Math.floor(Number(rec.window.to) / 3600000) * 3600000;
  const main = color === 'ours' ? VIZ_COLORS.ours : VIZ_COLORS.brandwatch;
  const pale = color === 'ours' ? VIZ_COLORS.oursSoft : VIZ_COLORS.brandwatchSoft;
  const full = hrs.filter(h => h.at < cur);  // the hour still running can't be the peak yet
  const peak = full.reduce((a, b) => (!a || b.n > a.n ? b : a), null);
  const peakAt = peak && peak.n > 0 ? peak.at : -1;
  return vizChart(`${unit[0].toUpperCase()}${unit.slice(1)} by hour`, { type: 'bar',
    data: { labels: hrs.map(h => hourTick(h.at)), datasets: [{ label: unit, data: hrs.map(h => h.n), borderRadius: 3, categoryPercentage: 0.92, barPercentage: 0.96,
      backgroundColor: hrs.map(h => (h.at === peakAt ? (color === 'ours' ? '#b06000' : VIZ_COLORS.peak) : h.at >= cur ? pale : main)) }] },
    options: { plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 9 } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eef0f3' } } } } },
  { height: 250, sub: 'The darkest bar is the peak hour. The pale bar is the hour still running.',
    says: `${unit} by hour, ${hrs.length} hours${peakAt > 0 ? `; the peak was ${num(peak.n)} at ${when(peak.at)}` : ''}.` });
}

/** Brandwatch's mentions (bars, left scale) and our tables' posts (line, right scale), hour by hour. */
function compareHoursChart(rec) {
  const a = alignHours([rec.hours, rec.own.hours]);
  return vizChart('Hour by hour: Brandwatch\'s mentions and the posts in our tables', { type: 'bar',
    data: { labels: a.at.map(hourTick), datasets: [
      { type: 'line', label: 'Posts in our tables (right scale)', data: a.series[1], borderColor: VIZ_COLORS.ours, backgroundColor: VIZ_COLORS.ours, yAxisID: 'y1', borderWidth: 3, pointRadius: 0, tension: 0.25, spanGaps: true, order: 1 },
      { type: 'bar', label: 'Brandwatch mentions (left scale)', data: a.series[0], backgroundColor: VIZ_COLORS.brandwatch, yAxisID: 'y', borderRadius: 3, order: 2 }] },
    options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, color: '#202124' } } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 9 } },
        y: { beginAtZero: true, position: 'left', ticks: { precision: 0 }, grid: { color: '#eef0f3' }, title: { display: true, text: 'Brandwatch mentions' } },
        y1: { beginAtZero: true, position: 'right', ticks: { precision: 0 }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Posts in our tables' } } } } },
  { height: 290, sub: 'Two scales: read the bars on the left and the line on the right. A line that rises and falls with the bars means our tables follow the conversation; a flat line under tall bars means they miss it.',
    says: `Brandwatch's mentions and our tables' posts by hour, ${a.at.length} hours.` });
}

/** Each count's sources as a share of that count, side by side. */
function shareChart(rec) {
  const rows = shareRows(rec.sources, rec.own.byPlatform, 9);
  return vizChart('Where each count comes from, as a share of that count', { type: 'bar',
    data: { labels: rows.map(r => r.label), datasets: [
      { label: `Brandwatch (${num(rec.total)} mentions)`, data: rows.map(r => Math.round(r.a * 10) / 10), backgroundColor: VIZ_COLORS.brandwatch, borderRadius: 4, maxBarThickness: 14 },
      { label: `Our tables (${num(rec.own.total)} posts)`, data: rows.map(r => Math.round(r.b * 10) / 10), backgroundColor: VIZ_COLORS.ours, borderRadius: 4, maxBarThickness: 14 }] },
    options: { indexAxis: 'y', plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, color: '#202124' } },
      tooltip: { callbacks: { label: c => ` ${c.dataset.label.split(' (')[0]}: ${c.parsed.x}% (${num(c.datasetIndex === 0 ? rows[c.dataIndex].an : rows[c.dataIndex].bn)})` } } },
    scales: { x: { beginAtZero: true, ticks: { callback: v => `${v}%` }, grid: { color: '#eef0f3' } }, y: { grid: { display: false }, ticks: { color: '#202124' } } } } },
  { height: Math.max(200, rows.length * 38 + 70), sub: 'A source with a long blue bar and a short orange one is where our tables are thin.',
    says: `Sources as shares: ${rows.map(r => `${r.label} Brandwatch ${Math.round(r.a)}%, ours ${Math.round(r.b)}%`).join('; ')}.` });
}

// ---------------------------------------------------------------------------------------------------------------
// Posts: the cards, and the overlay one opens in
// ---------------------------------------------------------------------------------------------------------------

function platformChip(source) {
  return el('span', { class: 'pchip' }, el('span', { class: 'dot', style: `background:${PLATFORM_COLORS[source] || VIZ_COLORS.other}` }), source || 'Web');
}

function sentimentOf(p) { return p.negative || p.sentiment === 'negative' ? 'negative' : p.sentiment === 'positive' ? 'positive' : p.sentiment === 'neutral' ? 'neutral' : ''; }

function sourceNote(p) {
  if (p.src) return tableLabel(p.src) + ((p.also || []).length ? ` + ${p.also.map(tableLabel).join(', ')}` : '');
  return p.textFrom ? `words: ${p.textFrom}` : '';
}

/** The posts as cards; a card opens its post in the overlay, where the arrows step through the same list. */
function postGrid(posts) {
  const list = (posts || []).filter(Boolean);
  if (!list.length) return el('p', { class: 'note' }, 'None.');
  const most = Math.max.apply(null, [1].concat(list.map(p => engagementOf(p).n || 0)));
  return el('div', { class: 'pgrid' }, list.map((p, i) => {
    const e = engagementOf(p);
    const mood = sentimentOf(p);
    const from = sourceNote(p);
    return el('button', { type: 'button', class: 'pcard', 'aria-label': `Open the post by ${p.author || 'an unknown author'} on ${p.source || 'the web'}`, onclick: () => openPost(list, i) },
      el('span', { class: 'phead' }, platformChip(p.source), el('span', { class: 'who' }, p.author || 'unknown'), el('span', { class: 'grow' }), p.at ? el('span', { class: 'hint' }, when(p.at)) : null),
      el('span', { class: 'ptxt' }, p.text || 'No words came with this post.'),
      el('span', { class: 'meter', 'aria-hidden': 'true' }, el('span', { style: `width:${e.n ? Math.max(2, Math.round((e.n * 100) / most)) : 0}%` })),
      el('span', { class: 'pfoot' }, el('span', {}, e.text), mood && mood !== 'neutral' ? el('span', { class: `badge ${mood === 'negative' ? 'out' : 'ok'}` }, mood) : null,
        from ? el('span', { class: 'badge' }, from) : null, el('span', { class: 'grow' }), el('span', { class: 'open' }, 'Open ›')));
  }));
}

function overlay() {
  let o = document.getElementById('post-overlay');
  if (o) return o;
  o = el('div', { id: 'post-overlay', class: 'overlay', hidden: true },
    el('div', { class: 'frost', onclick: closePost }),
    el('div', { class: 'glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'post-title' },
      el('div', { class: 'ghead' }, el('div', { id: 'post-title', class: 'gtitle' }), el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'gbtn', id: 'post-prev', 'aria-label': 'The post before', title: 'The post before (left arrow)', onclick: () => stepPost(-1) }, '‹'),
        el('span', { id: 'post-pos', class: 'gpos' }),
        el('button', { type: 'button', class: 'gbtn', id: 'post-next', 'aria-label': 'The next post', title: 'The next post (right arrow)', onclick: () => stepPost(1) }, '›'),
        el('button', { type: 'button', class: 'gbtn', id: 'post-close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: closePost }, '✕')),
      el('div', { class: 'gbody', id: 'post-body' })));
  document.body.append(o);
  document.addEventListener('keydown', overlayKey);
  window.addEventListener('message', frameMessage);
  return o;
}

/**
 * X's frame says how tall its post is, and the frame is made that tall (else a short post sits in a tall white box).
 * Only a message from X's embed address, sent by the very frame the overlay is showing, is listened to.
 */
function frameMessage(ev) {
  if (ev.origin !== 'https://platform.twitter.com' || !VIZ.view) return;
  const frame = document.querySelector('#post-body .gembed iframe');
  if (!frame || ev.source !== frame.contentWindow) return;
  const said = ev.data && typeof ev.data === 'object' ? ev.data['twttr.embed'] : null;
  const tall = said && said.method === 'twttr.private.resize' && Array.isArray(said.params) && said.params[0] ? Number(said.params[0].height) : 0;
  if (tall > 0) frame.style.height = `${Math.max(200, Math.min(1600, Math.round(tall)))}px`;
}

function overlayKey(ev) {
  if (!VIZ.view) return;
  if (ev.key === 'Escape') { ev.preventDefault(); closePost(); return; }
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    if (/^(?:INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '')) return;
    ev.preventDefault();
    stepPost(ev.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (ev.key === 'Tab') {  // the Tab key stays inside the overlay while it is open
    const panel = document.querySelector('#post-overlay .glass');
    const stops = Array.from(panel.querySelectorAll('button:not([disabled]), a[href], iframe')).filter(n => n.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    else if (!panel.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
  }
}

/** Opens post `i` of `list` over the app. */
function openPost(list, i) {
  const o = overlay();
  VIZ.view = { list, i, opener: VIZ.view ? VIZ.view.opener : document.activeElement };
  showPost();
  o.hidden = false;
  document.body.classList.add('overlay-open');
  document.getElementById('post-close').focus();
}

function stepPost(by) {
  const v = VIZ.view;
  if (!v) return;
  const next = v.i + by;
  if (next < 0 || next >= v.list.length) return;
  v.i = next;
  showPost();
}

function closePost() {
  const v = VIZ.view;
  const o = document.getElementById('post-overlay');
  if (!o || !v) return;
  o.hidden = true;
  document.getElementById('post-body').replaceChildren();  // a video in a frame stops with it
  document.body.classList.remove('overlay-open');
  VIZ.view = null;
  if (v.opener && v.opener.isConnected && typeof v.opener.focus === 'function') v.opener.focus();
}

function showPost() {
  const v = VIZ.view;
  const p = v.list[v.i];
  const e = engagementOf(p);
  const mood = sentimentOf(p);
  const link = p.url && /^https?:\/\//i.test(p.url) ? p.url : '';
  const frame = embedFor(link);
  const site = (frame && frame.site) || p.source || 'the site';
  document.getElementById('post-title').replaceChildren(...[platformChip(p.source), el('span', { class: 'who' }, p.author || 'unknown'),
    p.at ? el('span', { class: 'gwhen' }, when(p.at)) : null].filter(Boolean));
  document.getElementById('post-pos').textContent = `${v.i + 1} of ${v.list.length}`;
  document.getElementById('post-prev').disabled = v.i === 0;
  document.getElementById('post-next').disabled = v.i === v.list.length - 1;
  const stat = (k, val) => (val === null || val === undefined || val === '' ? null : el('div', { class: 'gstat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, val)));
  const stats = [
    p.likes !== undefined && p.likes !== null ? stat('Likes', num(p.likes)) : stat('Engagements', e.n === null ? 'not known' : num(e.n)),
    p.likes !== undefined && p.likes !== null ? stat('Replies', num(p.replies)) : p.replies !== undefined && p.replies !== null ? stat('Replies', num(p.replies)) : null,
    p.shares !== undefined && p.shares !== null ? stat('Reposts', num(p.shares)) : null,
    p.followers !== undefined && p.followers !== null ? stat('Followers', num(p.followers)) : null,
    stat('Sentiment', mood || 'not scored'),
    p.at ? stat('Posted', when(p.at)) : null,
    stat('Found in', sourceNote(p) || 'Brandwatch\'s top posts'),
    p.language ? stat('Language', p.language) : null,
  ];
  const copied = el('span', { class: 'hint', role: 'status' });
  const left = el('div', { class: 'gcol' },
    el('div', { class: 'gcard' }, el('div', { class: 'glabel' }, 'What we hold of it'), el('div', { class: 'gtext' }, p.text || 'No words came with this post.')),
    el('div', { class: 'gstats' }, stats),
    el('div', { class: 'gactions' },
      link ? el('a', { class: 'gbtn primary', href: link, target: '_blank', rel: 'noopener noreferrer' }, `Open on ${site} ↗`) : el('span', { class: 'hint' }, 'No link came with this post.'),
      link ? el('button', { type: 'button', class: 'gbtn', onclick: async () => {
        try { await navigator.clipboard.writeText(link); copied.textContent = 'Link copied.'; } catch (err) { copied.textContent = 'Could not copy the link.'; }
      } }, 'Copy link') : null, copied));
  const right = frame ? el('div', { class: 'gcol' },
    el('div', { class: 'gembed' }, el('iframe', { src: frame.src, title: `The post, shown by ${frame.site}`, loading: 'lazy', referrerpolicy: 'no-referrer',
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation', allow: 'encrypted-media; picture-in-picture; fullscreen',
      style: frame.ratio ? `aspect-ratio:${frame.ratio}` : `height:${frame.height}px` })),
    el('div', { class: 'hint gnote' }, `The post itself, shown by ${frame.site} in its own frame. If it stays blank, it was removed or ${frame.site} won't show it here.`)) : null;
  const body = document.getElementById('post-body');
  body.className = `gbody${right ? '' : ' single'}`;
  body.replaceChildren(left, right || el('div', { class: 'hint gnote' }, link ? `${site} offers no frame the app can show this post in. "Open on ${site}" opens it in a new tab.` : ''));
  body.scrollTop = 0;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { embedFor, topWithOther, shareRows, alignHours, engagementOf };
