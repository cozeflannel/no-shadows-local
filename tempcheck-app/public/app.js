/* The temp-check test app's page. Plain JavaScript, no framework. Chart.js (loaded by the page) draws the hourly chart. */
'use strict';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** An element: el('div', {class: 'x', onclick: fn}, 'text', child, …). Text is always set as text, never as HTML. */
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  Object.keys(attrs || {}).forEach(k => {
    const v = attrs[k];
    if (v === false || v === null || v === undefined) return;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  });
  kids.flat().forEach(kid => { if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid))); });
  return node;
}

async function api(path, body) {
  const resp = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `The app answered ${resp.status}.`);
  return data;
}

const num = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const gb = bytes => `${(Number(bytes) / 1073741824).toFixed(bytes > 107374182 ? 1 : 2)} GB`;
const when = ms => (ms ? new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const pctOf = (n, total) => (total ? `${Math.round((n * 100) / total)}%` : '');
const PLATFORMS = ['X', 'Reddit', 'Bluesky', 'Instagram', 'Facebook', 'YouTube', 'TikTok', 'Threads', 'LinkedIn'];
/** One of our tables by the name the page shows for it. */
const tableLabel = k => ((state.about && state.about.tables.find(x => x.key === k)) || {}).label || k;

const state = { mode: 'query', query: null, record: null, chart: null, about: null, tab: 'writeup', busy: false };

// ---------------------------------------------------------------------------------------------------------------
// The top strip, the benchmark card, past temp checks
// ---------------------------------------------------------------------------------------------------------------

async function loadAbout() {
  const a = state.about = await api('/api/about');
  const chips = $('#about');
  chips.replaceChildren(
    el('span', { class: 'chip' }, `Billed to ${a.project}`),
    el('span', { class: 'chip' }, `Brandwatch: ${num(a.brandwatch.calls)} calls, ${num(a.brandwatch.mentionsRead)} posts read since the app started`),
    el('span', { class: 'chip' }, `Gemini: ${a.model}`),
    el('span', { class: 'chip' }, `Kept in ${a.dataDir}`));
  if (!$('#own-tables').children.length) {
    a.tables.forEach(t => $('#own-tables').append(el('label', { class: 'row', title: t.what },
      el('input', { type: 'checkbox', name: 'own-table', value: t.key, checked: true }), t.label)));
    PLATFORMS.forEach(p => $('#f-platforms').append(el('label', { class: 'row' }, el('input', { type: 'checkbox', name: 'f-platform', value: p }), p)));
  }
  showBenchmark(a.benchmark);
}

function showBenchmark(b) {
  const box = $('#bench');
  const lines = [];
  if (!b.issues) lines.push('No past issues are kept yet, so no concern level can be given. Read them from Brandwatch below (hourly counts only, nothing is downloaded).');
  else {
    lines.push(`${num(b.issues)} past issues kept${b.known ? `, of the ${num(b.known)} Brandwatch lists for the past 12 months` : ''}, from ${new Date(b.oldest).toLocaleDateString()} to ${new Date(b.newest).toLocaleDateString()}. A level needs ${b.minIssues} to compare with.`);
    lines.push('Brandwatch only answers for queries that are still active, so older issues can only be kept while their query is live. Every temp check keeps its own.');
  }
  const j = b.job || {};
  if (j.running) lines.push(`Reading: ${j.done} of ${j.total}…`);
  else if (j.endedAt) lines.push(`Last read: ${j.added} added${j.failed ? `, ${j.failed} failed` : ''}${j.deactivated ? `; ${j.deactivated} of the past year's queries are deactivated in Brandwatch and can't be read` : ''}${j.stopped ? `. Stopped: ${j.stopped}` : '.'}`);
  box.replaceChildren(...lines.map(t => el('p', { class: 'note' }, t)));
  $('#fill').disabled = !!j.running;
  if (j.running) setTimeout(async () => showBenchmark(await api('/api/benchmark')), 2500);
}

async function loadHistory() {
  const { checks } = await api('/api/temp-checks');
  const list = $('#history');
  list.replaceChildren(...(checks.length ? checks.map(c => el('button', { type: 'button', class: 'item', onclick: () => openRecord(c.id) },
    c.title, el('span', { class: 'meta' }, `${when(c.at)} · ${num(c.total)} ${c.basis === 'own' ? 'posts (our data)' : 'mentions'}` +
      `${c.level ? ` · ${c.level}` : ''}${c.trigger === 'alert' ? ' · from an alert' : ''}${c.updateOf ? ' · update' : ''}`))) : [el('p', { class: 'note' }, 'None yet.')]));
  const reuse = $('#own-reuse');
  const had = reuse.value;
  reuse.replaceChildren(el('option', { value: '' }, 'No: search afresh'), ...checks.filter(c => c.ownPosts > 0).map(c =>
    el('option', { value: c.id }, `${c.issue} · ${num(c.ownPosts)} posts from ${when(c.ownFrom)}, gathered ${when(c.at)}`)));
  reuse.value = had;
}

// ---------------------------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  $$('.seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#mode-query').hidden = mode !== 'query';
  $('#mode-alert').hidden = mode !== 'alert';
  $('#own-on-row').hidden = mode === 'alert';
  $('#own-auto-row').hidden = mode === 'alert';
  $('#from-auto-label').textContent = mode === 'alert' ? 'The 24 hours before the alert' : 'The issue\'s start (the first hour with 100+ mentions)';
  if (mode === 'alert' && $('input[name=ownq]:checked').value === 'auto') $('input[name=ownq][value=typed]').checked = true;
  syncOwn();
}

function syncOwn() {
  const on = state.mode === 'alert' || $('#own-on').checked;
  $('#own-body').hidden = !on;
  const how = $('input[name=ownq]:checked').value;
  $('#own-boolean').hidden = how !== 'typed';
  $('#own-filters').hidden = how !== 'filters';
  $('#since').disabled = $('input[name=from]:checked').value !== 'since';
}

let searchTimer = 0;
function searchQueries() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const text = $('#q-search').value.trim();
    const list = $('#q-list');
    if (/\d{9,12}/.test(text) && /^(https?:|\d+$)/.test(text)) { list.replaceChildren(el('p', { class: 'note' }, 'A link or id: it is looked up when you run.')); state.query = { ref: text, name: text }; return; }
    try {
      const { queries } = await api(`/api/queries?q=${encodeURIComponent(text)}`);
      list.replaceChildren(...(queries.length ? queries.map(q => el('button', { type: 'button', class: 'item', onclick: () => pickQuery(q) }, q.name,
        el('span', { class: 'meta' }, `made ${when(q.created)}${q.state !== 'active' ? ` · ${q.state}: Brandwatch gives no numbers for it` : ''}`))) : [el('p', { class: 'note' }, 'No [G EVENT] query has those words.')]));
    } catch (e) { list.replaceChildren(el('p', { class: 'err' }, e.message)); }
  }, 250);
}

async function pickQuery(q) {
  state.query = { ref: String(q.id), name: q.name };
  const box = $('#q-picked');
  box.hidden = false;
  box.replaceChildren(el('b', {}, q.name), el('div', { class: 'hint' }, `id ${q.id} · made ${when(q.created)}`));
  try {
    const full = await api(`/api/queries/${q.id}`);
    box.append(el('details', {}, el('summary', {}, `Its Boolean (${num(full.boolean.length)} characters)`), el('pre', {}, full.boolean)));
  } catch (e) { box.append(el('div', { class: 'err' }, e.message)); }
}

function filtersNow() {
  return { all: $('#f-all').value, any: $('#f-any').value, none: $('#f-none').value, authors: $('#f-authors').value,
    minFollowers: Number($('#f-followers').value) || 0, platforms: $$('input[name=f-platform]:checked').map(i => i.value) };
}

function ownNow() {
  const how = $('input[name=ownq]:checked').value;
  const out = { on: state.mode === 'alert' || $('#own-on').checked, sources: $$('input[name=own-table]:checked').map(i => i.value), reuse: $('#own-reuse').value || '' };
  if (how === 'typed') out.boolean = $('#own-boolean').value;
  if (how === 'filters') out.filters = filtersNow();
  return out;
}

function sinceNow() {
  if ($('input[name=from]:checked').value !== 'since' || !$('#since').value) return 0;
  return new Date($('#since').value).getTime() || 0;
}

function reportView(r) {
  if (!r || !r.report) return el('p', { class: 'err' }, (r && r.error) || 'Nothing to convert.');
  const s = r.report.summary;
  const parts = [`${num(s.terms)} word${s.terms === 1 ? '' : 's'}`, `${num(s.phrases)} phrase${s.phrases === 1 ? '' : 's'}`];
  if (s.near) parts.push(`${num(s.near)} NEAR condition${s.near === 1 ? '' : 's'}`);
  if (s.wildcards) parts.push(`${num(s.wildcards)} with wildcards`);
  if (s.caseSensitive) parts.push(`${num(s.caseSensitive)} case-sensitive`);
  const badge = n => el('span', { class: `badge ${n.status === 'converted' ? 'ok' : n.status === 'approximated' ? 'approx' : 'out'}` },
    n.status + (n.effect && n.effect !== 'nothing left' ? `: ${n.effect}` : ''));
  const origin = { typed: 'the query you typed', filters: 'the filters, written as a query', query: 'the Brandwatch query\'s own Boolean',
    kept: 'the query the earlier temp check used' }[r.origin] || 'the query';
  return el('div', {},
    r.error ? el('p', { class: 'err' }, r.error) : null,
    el('p', {}, `Converted by fixed rules from ${origin}: ${parts.join(', ')}.`),
    r.origin === 'filters' ? el('pre', {}, r.boolean) : null,
    r.report.notes.length ? el('ul', { class: 'notes' }, r.report.notes.map(n => el('li', {}, badge(n), ' ', el('code', {}, n.clause), el('div', { class: 'hint' }, n.note)))) : null,
    r.report.warnings.length ? el('div', {}, r.report.warnings.map(w => el('p', { class: 'warn' }, w))) : null,
    r.estimate ? el('p', { class: 'note' }, 'Searching would scan: ' + Object.keys(r.estimate).map(k => {
      const t = (state.about.tables.find(x => x.key === k) || {}).label || k;
      return r.estimate[k].skip ? `${t}: skipped (${r.estimate[k].skip})` : `${t} ${gb(r.estimate[k].bytes)}`;
    }).join(' · ') + ` (window from ${when(r.window.from)}).`) : null,
    (r.sql || []).map(x => el('details', {}, el('summary', {}, `The SQL for ${x.table}`), el('pre', {}, x.sql))));
}

async function preview() {
  const out = $('#preview-out');
  out.replaceChildren(el('p', { class: 'note' }, 'Converting…'));
  try {
    const o = ownNow();
    const r = await api('/api/convert', { query: state.mode === 'query' && state.query ? state.query.ref : '', boolean: o.boolean, filters: o.filters,
      sources: o.sources, since: sinceNow(), estimate: true });
    out.replaceChildren(reportView(r));
  } catch (e) { out.replaceChildren(el('p', { class: 'err' }, e.message)); }
}

async function draft() {
  const note = $('#a-draft-note');
  note.textContent = ' Drafting…';
  try {
    const r = await api('/api/suggest', { text: [$('#a-issue').value, $('#a-text').value].filter(Boolean).join('\n') });
    $('input[name=ownq][value=typed]').checked = true;
    $('#own-boolean').value = r.boolean;
    syncOwn();
    note.textContent = ` Drafted: everything about it that also uses one of the words. Check it below before you run; to gather everything about it, keep only the first bracket. ${r.why}`;
  } catch (e) { note.textContent = ` ${e.message}`; }
}

// ---------------------------------------------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------------------------------------------

async function run(extra) {
  if (state.busy) return;
  const box = $('#progress');
  let body;
  let path = '/api/temp-checks';
  if (extra && extra.updateOf) {
    body = extra;
  } else if (state.mode === 'query') {
    if (!state.query) { box.replaceChildren(el('p', { class: 'err' }, 'Pick a Brandwatch query first.')); return; }
    body = { query: state.query.ref, since: sinceNow(), own: ownNow(), writeup: $('#writeup').checked };
  } else {
    const o = ownNow();
    const alertAt = $('#a-at').value ? new Date($('#a-at').value).getTime() : Date.now();
    const has = (o.boolean && o.boolean.trim()) || (o.filters && Object.values(o.filters).some(v => (Array.isArray(v) ? v.length : v)));
    if (has) body = { issue: $('#a-issue').value, alertAt, since: sinceNow(), trigger: 'alert', own: o, writeup: $('#writeup').checked };
    else { path = '/api/alerts'; body = { issue: $('#a-issue').value, text: $('#a-text').value, alertAt, sources: o.sources }; }
  }
  state.busy = true;
  $('#run').disabled = true;
  box.replaceChildren(el('div', { class: 'step now' }, 'Starting…'));
  try {
    let job = await api(path, body);
    const t0 = Date.now();
    while (job.status === 'running') {
      await new Promise(r => setTimeout(r, 700));
      job = await api(`/api/jobs/${job.id}`);
      box.replaceChildren(...job.steps.map((s, i) => el('div', { class: `step${i === job.steps.length - 1 && job.status === 'running' ? ' now' : ''}` },
        `${((s.at - job.startedAt) / 1000).toFixed(0)} s  ${s.text}`)), el('div', { class: 'hint' }, `${((Date.now() - t0) / 1000).toFixed(0)} s so far`));
    }
    if (job.status === 'done') {
      box.append(el('div', { class: 'step' }, `Done in ${((job.endedAt - job.startedAt) / 1000).toFixed(0)} s.`));
      await openRecord(job.recordId);
      loadHistory();
      loadAbout();
    } else if (job.status === 'needs') {
      const n = job.needs;
      const picks = (n.choices || []).concat(n.near || []);
      box.replaceChildren(el('p', { class: 'err' }, n.missing ? `Brandwatch has no query ${n.missing} in this project.` : picks.length ? 'More than one query fits, or none exactly. Pick one:' : 'No Brandwatch query matches that.'),
        ...picks.map(q => el('button', { type: 'button', class: 'link', onclick: () => { pickQuery(q); box.replaceChildren(); } }, q.name)));
    } else {
      box.replaceChildren(el('p', { class: 'err' }, job.error || 'It failed.'));
    }
  } catch (e) {
    box.replaceChildren(el('p', { class: 'err' }, e.message));
  } finally {
    state.busy = false;
    $('#run').disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Showing one
// ---------------------------------------------------------------------------------------------------------------

async function openRecord(id) {
  try {
    state.record = await api(`/api/temp-checks/${id}`);
    renderRecord();
  } catch (e) { $('#result').replaceChildren(el('p', { class: 'err' }, e.message)); }
}

function drawChart(rec, canvas) {
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  if (!window.Chart) return false;
  const pts = rec.chart.points;
  const step = pts.length <= 8 ? 1 : pts.length <= 18 ? 3 : pts.length <= 42 ? 6 : pts.length <= 84 ? 12 : 24;
  state.chart = new window.Chart(canvas, {
    type: 'line',
    data: { labels: pts.map(p => p.label), datasets: [{ label: rec.chart.unit, data: pts.map(p => p.n), borderColor: '#4285f4', backgroundColor: '#4285f4', borderWidth: 3, pointRadius: 0, tension: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, title: { display: true, text: rec.chart.title, color: '#000', font: { size: 15, weight: 'bold' } } },
      scales: { x: { ticks: { color: '#000', font: { size: 11 }, maxRotation: 0, autoSkip: false, callback(v, i) { return i % step === 0 ? this.getLabelForValue(v) : ''; } }, grid: { color: '#ccc' } },
        y: { beginAtZero: true, ticks: { color: '#000', font: { size: 12 }, precision: 0 }, grid: { color: '#ccc' } } },
    },
    plugins: [{ id: 'white', beforeDraw(c) { const g = c.ctx; g.save(); g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.restore(); } }],
  });
  return true;
}

function levelLine(rec) {
  const l = rec.level || {};
  if (l.label) {
    return el('p', {}, el('b', {}, `Concern level: ${l.label}`), ` · ${l.action} · ${l.side} ${l.pct}% of ${num(l.n)} past issues` +
      `${l.known && !l.fullYear ? ` (Brandwatch lists ${num(l.known)} for the past 12 months; the rest are deactivated and can't be read)` : ''}, each compared at ${l.hours} hours in. ` +
      'This is the app\'s own ranking: check it against the team\'s benchmark until the two have been compared.');
  }
  return el('p', { class: 'warn' }, `No concern level in this write-up: ${l.why || 'there is nothing to rank it against yet.'}`);
}

function writeupTab(rec) {
  const box = el('div', { class: 'writeup', id: 'writeup-body' });
  const mark = '<!--tc-chart-->';
  box.innerHTML = rec.writeup.html.replace(mark, '<div class="chartbox"><canvas id="tc-chart"></canvas></div>');  // built and escaped by the server (lib/tempcheck.js)
  const lines = [levelLine(rec)];
  if (rec.gem && rec.gem.why) lines.push(el('p', { class: 'warn' }, `Gemini's lines were not written: ${rec.gem.why}.`));
  const st = rec.standing;
  if (st && !st.skipped && rec.basis === 'brandwatch') {
    lines.push(el('p', { class: 'note' }, `This issue has no Brandwatch query of its own yet. The counts are Brandwatch's own, from its ${num(st.queries)} standing Google queries searched with the query shown on the "Our data" tab. They count only mentions those queries already hold (ones that name Google or one of its products), so a query built for the issue can count differently.`));
  }
  if (rec.basis === 'own') {
    lines.push(el('p', { class: 'warn' }, `This one is built from our own tables only${st && st.skipped ? `: ${st.skipped}` : ' (no Brandwatch query).'} Its counts are posts, not Brandwatch mentions.`));
  }
  if (!rec.total) lines.push(el('p', { class: 'warn' }, 'Nothing was counted. Try a wider query (fewer words that must all be there), a longer window under "Count from", or look at how the query converted on the "Our data" tab.'));
  if (rec.own && rec.own.widened) lines.push(el('p', { class: 'warn' }, rec.own.widened.why));
  if (rec.query && rec.query.pct !== null && rec.query.pct < 100) lines.push(el('p', { class: 'warn' }, `Brandwatch is still filling this query (${Math.round(rec.query.pct)}% done), so the counts will grow.`));
  const bar = el('div', { class: 'bar' },
    el('button', { type: 'button', onclick: copyWriteup }, 'Copy write-up'),
    el('button', { type: 'button', onclick: downloadChart }, 'Download chart'),
    el('button', { type: 'button', onclick: () => run({ updateOf: rec.id, own: { on: !!rec.own, boolean: rec.own && rec.own.origin !== 'query' ? rec.own.boolean : '', reuse: rec.own && rec.own.posts ? rec.id : '' } }) }, 'Refresh (send as an update)'),
    el('button', { type: 'button', title: 'A refresh every hour for the next 24 hours, whether or not alerts are being watched', onclick: () => keepRefreshed(rec) }, 'Keep refreshed for a day'),
    el('span', { class: 'grow' }), el('span', { class: 'hint', id: 'copy-note' }, `${when(rec.at)} · took ${(rec.took / 1000).toFixed(0)} s`));
  const wrap = el('div', {}, bar, ...lines, box);
  setTimeout(() => {
    const canvas = $('#tc-chart');
    if (canvas && !drawChart(rec, canvas)) canvas.parentNode.replaceWith(el('p', { class: 'warn' }, 'The chart library did not load (no connection to its CDN). The hourly counts are under Numbers.'));
  }, 0);
  return wrap;
}

async function copyWriteup() {
  const note = $('#copy-note');
  try {
    const clone = $('#writeup-body').cloneNode(true);
    const canvas = $('#tc-chart');
    const holder = $('.chartbox', clone);
    if (holder && canvas) holder.replaceWith(el('p', {}, el('img', { src: canvas.toDataURL('image/png'), width: '680', alt: state.record.chart.title })));
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([clone.innerHTML], { type: 'text/html' }), 'text/plain': new Blob([state.record.writeup.text], { type: 'text/plain' }) })]);
    note.textContent = 'Copied, chart included. Paste it into an email or a doc.';
  } catch (e) { note.textContent = `Could not copy (${e.message}). Select the write-up and copy it by hand.`; }
}

function downloadChart() {
  const canvas = $('#tc-chart');
  if (!canvas) return;
  const a = el('a', { href: canvas.toDataURL('image/png'), download: 'temp-check-volume.png' });
  document.body.append(a);
  a.click();
  a.remove();
}

const kv = rows => el('table', { class: 'kv' }, el('tbody', {}, rows.filter(Boolean).map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', { class: 'n' }, v)))));
const ranked = (list, total) => (list || []).map(x => `${x.label} ${num(x.n)}${total ? ` (${pctOf(x.n, total)})` : ''}`).join(' · ') || 'none';

function numbersTab(rec) {
  const why = { spike: 'the first hour with 100+ mentions', alert: 'when the alert fired', query: 'when the query was made', look: rec.basis === 'own' || rec.standing ? 'the 24 hours before the alert' : 'as far back as it looks', since: 'the time you chose' }[rec.window.why] || rec.window.why;
  const v = rec.velocity;
  const s = rec.sentiment || {};
  const sTotal = (s.positive || 0) + (s.neutral || 0) + (s.negative || 0);
  const unit = rec.basis === 'own' ? 'posts' : 'mentions';
  const table = kv([
    ['Counted', `${when(rec.window.from)} to ${when(rec.window.to)} (from ${why})`],
    [`Total ${unit}`, num(rec.total)],
    rec.update ? ['Since the last update', `${num(Math.max(0, rec.total - rec.update.tot))} new (it had ${num(rec.update.tot)} at ${when(rec.update.at)})`] : null,
    ['Peak hour', v ? `${num(v.peak.n)} at ${when(v.peak.at)}` : 'too early to tell'],
    ['Last full hour', v ? `${num(v.last.n)} (${v.pct}% against the peak)` : ''],
    ['Sentiment', sTotal ? `negative ${num(s.negative)} (${pctOf(s.negative, sTotal)}) · neutral ${num(s.neutral)} (${pctOf(s.neutral, sTotal)}) · positive ${num(s.positive)} (${pctOf(s.positive, sTotal)})` : 'not scored'],
    ['By source', ranked(rec.sources, rec.total)],
    ['Mention types', (rec.mentionTypes || []).length ? ranked(rec.mentionTypes, rec.total) : 'not in our own tables'],
    ['Engagement by source', ranked(rec.engSources)],
    rec.coverage ? ['Words of X posts', `${rec.coverage.x} X posts among Brandwatch's ${rec.coverage.ranked} top posts: ${rec.coverage.fromEmbed} from X's embed data, ${rec.coverage.inAlertRows} were in our alert rows, ${rec.coverage.noWords} with no words anywhere`] : null,
    rec.brandwatch ? ['Brandwatch use', `${num(rec.brandwatch.calls)} calls and ${num(rec.brandwatch.mentionsRead)} posts read since the app started (its limit: ${rec.brandwatch.limit || 'not said'})`] : null,
  ]);
  const byHour = el('details', {}, el('summary', {}, 'Each hour\'s count'),
    el('pre', {}, rec.hours.map(h => `${new Date(h.at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric' })}\t${h.n}`).join('\n')));
  if (!rec.total) return el('div', {}, table, byHour);
  const src = topWithOther(rec.sources, 8);
  const eng = topWithOther(rec.engSources, 8);
  return el('div', {},
    statTiles([
      { label: `Total ${unit}`, value: num(rec.total), sub: `${when(rec.window.from)} to ${when(rec.window.to)}`, cls: rec.basis === 'own' ? 'ours' : 'bw' },
      { label: 'Peak hour', value: v ? num(v.peak.n) : 'too early', sub: v ? when(v.peak.at) : 'the first full hour isn\'t over' },
      { label: 'Last full hour', value: v ? num(v.last.n) : 'too early', sub: v ? `${v.pct > 0 ? '+' : ''}${v.pct}% against the peak` : '' },
      { label: 'Negative', value: sTotal ? pctOf(s.negative, sTotal) : 'not scored', sub: sTotal ? `${num(s.negative)} of the ${num(sTotal)} scored` : '' },
      rec.update ? { label: 'Since the last update', value: `+${num(Math.max(0, rec.total - rec.update.tot))}`, sub: `it had ${num(rec.update.tot)} at ${when(rec.update.at)}` } : null,
    ]),
    hoursChart(rec, rec.hours, unit, rec.basis === 'own' ? 'ours' : 'brandwatch'),
    el('div', { class: 'vizgrid' },
      sTotal ? ringChart('Sentiment', [{ label: 'Negative', n: s.negative || 0, color: VIZ_COLORS.negative }, { label: 'Neutral', n: s.neutral || 0, color: VIZ_COLORS.neutral },
        { label: 'Positive', n: s.positive || 0, color: VIZ_COLORS.positive }]) : null,
      (rec.mentionTypes || []).length ? ringChart('Mention types', rec.mentionTypes.map(t => ({ label: t.label[0].toUpperCase() + t.label.slice(1), n: t.n, color: TYPE_COLORS[t.label] || VIZ_COLORS.other }))) : null),
    el('div', { class: 'vizgrid' },
      src.length ? barsChart(`${unit[0].toUpperCase()}${unit.slice(1)} by source`, src.map(x => ({ label: x.label, n: x.n, color: PLATFORM_COLORS[x.label] || VIZ_COLORS.other })), { unit }) : null,
      eng.length ? barsChart('Engagement by source', eng.map(x => ({ label: x.label, n: x.n, color: PLATFORM_COLORS[x.label] || VIZ_COLORS.other })), { unit: 'engagements', sub: 'Likes, comments and shares on the posts counted.' }) : null),
    el('h3', {}, 'The same numbers as a table'), table, byHour);
}

function ownTab(rec) {
  const o = rec.own;
  if (!o) return el('p', { class: 'note' }, 'Our own tables were not searched for this one.');
  if (o.error) return el('div', {}, el('p', { class: 'err' }, o.error), reportView(o));
  const types = {};
  (rec.mentionTypes || []).forEach(t => { types[t.label] = t.n; });
  const order = state.about.tables.map(t => t.key);
  const keys = Object.keys(o.tables || {}).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const tables = keys.map(k => [tableLabel(k), o.tables[k].skip ? `skipped: ${o.tables[k].skip}`
    : `${num(o.tables[k].matched)} matched${o.tables[k].read < o.tables[k].matched ? `, ${num(o.tables[k].read)} read` : ''}, ${gb(o.tables[k].bytes)} scanned` +
      `${o.tables[k].newest ? `, its newest from ${when(o.tables[k].newest)}` : ''}`]);
  const sp = o.spread || { counted: 0, reposts: 0, replies: 0 };
  const bw = rec.basis === 'brandwatch';
  const shades = ['#f29900', '#f6b04d', '#e37400', '#fbd08a', '#b06000'];
  const perTable = barsChart('What each of our tables found', keys.map((k, n) => ({ label: o.tables[k].skip ? `${tableLabel(k)} (skipped)` : tableLabel(k), n: o.tables[k].skip ? 0 : o.tables[k].matched, color: shades[n % shades.length] })),
    { unit: 'matched', sub: 'Before a post that is in two tables is counted once.' });
  const ownSources = topWithOther(o.byPlatform, 9);
  return el('div', {},
    statTiles([
      bw ? { label: rec.standing ? 'Brandwatch counted, in its standing Google queries' : 'Brandwatch counted', value: num(rec.total), sub: 'mentions', cls: 'bw' } : null,
      { label: 'Our own tables hold', value: num(o.total), sub: o.complete ? 'posts and comments, each counted once' : 'posts and comments (one that is in two tables is counted in each)', cls: 'ours' },
      bw && rec.total ? { label: 'Our posts for every 100 Brandwatch mentions', value: ((o.total * 100) / rec.total).toFixed(o.total * 100 < rec.total * 10 ? 1 : 0), sub: 'not a share: the two are different sets' } : null,
      bw && types['original posts'] ? { label: 'Our posts for every 100 of Brandwatch\'s original posts', value: ((o.total * 100) / types['original posts']).toFixed(o.total * 100 < types['original posts'] * 10 ? 1 : 0), sub: 'the fairer comparison: our tables hold no reposts' } : null,
    ]),
    bw && rec.total && o.total ? compareHoursChart(rec) : o.total ? hoursChart(rec, o.hours, 'posts in our tables', 'ours') : null,
    el('div', { class: 'vizgrid' },
      bw && rec.total ? barsChart('The two counts, piece by piece', [
        { label: 'Brandwatch: original posts', n: types['original posts'] || 0, color: VIZ_COLORS.brandwatch },
        { label: 'Brandwatch: comments and replies', n: types.comments || 0, color: '#7baaf7' },
        { label: 'Brandwatch: reposts', n: types.reposts || 0, color: VIZ_COLORS.brandwatchSoft },
        { label: 'Our tables: posts and comments', n: o.total, color: VIZ_COLORS.ours }], { unit: 'count', sub: 'Our tables hold posts, not reposts, so set the orange bar beside the first blue one.' }) : null,
      perTable),
    bw && rec.total && o.total ? shareChart(rec) : ownSources.length && !bw ? barsChart('Our posts by source', ownSources.map(x => ({ label: x.label, n: x.n, color: PLATFORM_COLORS[x.label] || VIZ_COLORS.other })), { unit: 'posts' }) : null,
    el('h3', {}, 'The same numbers as a table'),
    kv((bw ? [['Brandwatch: mentions', num(rec.total)], ['Brandwatch: original posts', num(types['original posts'] || 0)], ['Brandwatch: comments and replies', num(types.comments || 0)],
      ['Brandwatch: reposts', num(types.reposts || 0)]] : []).concat([['Our tables: posts and comments', num(o.total)]], tables, [['Our posts by source', ranked(o.byPlatform, o.total)],
      ['What those posts\' own counters say', sp.counted ? `${num(sp.reposts)} reposts and ${num(sp.replies)} replies, on the ${num(sp.counted)} posts that came with counters` : 'no counters came with them']])),
    bw ? el('p', { class: 'note' }, 'Our tables hold posts, not the reposts of and replies to them, so set our count beside Brandwatch\'s original posts, not its total. The two are not the same set of posts: each side has some the other lacks. The counters line is the platforms\' own totals for the posts we hold (every repost of them, whether or not it matches the query). It is not Brandwatch\'s repost or comment count and should not be set against it.') : null,
    o.reused ? el('p', { class: 'note' }, `Reused ${num(o.reused.kept)} posts gathered at ${when(o.reused.gatheredAt)}; searched afresh only for what came after (${num(o.reused.since)} found). ${o.reused.note}`) : null,
    o.drafted ? el('p', { class: 'note' }, `The query was drafted from the alert: Gemini named what it is about and the words people use about it, and the app joined them. ${o.drafted.why}`) : null,
    o.widened ? el('p', { class: 'warn' }, `${o.widened.why} The drafted query was: ${o.widened.from}`) : null,
    el('h3', {}, 'How the query was converted'), reportView(o),
    el('details', {}, el('summary', {}, 'The query that was searched'), el('pre', {}, o.boolean)),
    el('h3', {}, `Posts found (the ${Math.min(60, o.posts.length)} with the most engagement of ${num(o.posts.length)} kept)`),
    el('p', { class: 'note' }, 'Open a card to read the post without leaving the app. The bar on each card is its engagement against the most-engaged one here.'),
    postGrid(o.posts.slice(0, 60)));
}

function postsTab(rec) {
  return el('div', {}, el('p', { class: 'note' }, `The ${rec.readPosts.length} posts Gemini read, in order. A link in the write-up's Negativity Drivers or Themes points at one of these. Open a card to read the post without leaving the app.`),
    postGrid(rec.readPosts));
}

function renderRecord() {
  const rec = state.record;
  vizClear();  // the charts of whatever was shown before
  const tabs = [['writeup', 'Write-up'], ['numbers', 'Numbers'], ['own', 'Our data next to Brandwatch'], ['posts', 'Posts read']];
  if (!tabs.some(t => t[0] === state.tab)) state.tab = 'writeup';
  const body = { writeup: writeupTab, numbers: numbersTab, own: ownTab, posts: postsTab }[state.tab](rec);
  $('#result').replaceChildren(
    el('div', { class: 'tabs' }, tabs.map(([k, label]) => el('button', { type: 'button', class: k === state.tab ? 'on' : '', onclick: () => { state.tab = k; renderRecord(); } }, label))),
    body);
}

// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// Automatic temp checks: the switch, the rules' numbers, a free trial of them on past alerts, and what it did
// ---------------------------------------------------------------------------------------------------------------

const RULE_FIELDS = [
  ['highShare', 'High-engaging alert: more engagement than this share of recent alerts (0.9 is the top tenth)', 0.01],
  ['highFloor', '…and until 100 recent alerts are known, at least this many engagements', 100],
  ['multiple', 'Multiple alerts: this many different posts alerted on one issue', 1],
  ['multipleWithinH', '…within this many hours', 1],
  ['momentumRise', 'Rising momentum: the post\'s engagement up by this share (0.5 is half as much again)', 0.05],
  ['momentumWithinH', '…between two readings no more than this many hours apart', 1],
  ['momentumMin', '…and at least this many engagements at the later reading', 50],
  ['refreshEveryMin', 'An issue that has a temp check: refreshed by a new alert at most every this many minutes', 5],
  ['maxStartsPerDay', 'Temp checks started automatically in a day, at most', 1],
];
const RULE_NAMES = { high: 'high-engaging alert', multiple: 'multiple alerts', momentum: 'rising momentum', refresh: 'refresh' };

function settingsNow() {
  const out = {};
  RULE_FIELDS.forEach(([k]) => { out[k] = Number($(`#ws-${k}`).value); });
  return out;
}

function showWatch(w) {
  state.watch = w;
  const lines = [];
  lines.push(el('p', {}, el('b', {}, w.on ? 'ON' : 'OFF'), w.on ? `: watching incoming alerts (${w.feed.what}). ` : ': nothing starts by itself. ',
    w.on ? `Started today: ${w.startsToday} of ${w.settings.maxStartsPerDay}. Issues with a temp check: ${w.issuesWithCheck}. Posts being read again for momentum: ${w.postsWatched}.` : ''));
  lines.push(el('p', { class: 'note' }, `A high-engaging alert right now means ${num(w.bar)} engagements or more` + (w.recentAlerts ? ` (from the last ${num(w.recentAlerts)} alerts seen).` : ' (until it has seen enough alerts).')));
  if (w.lastError) lines.push(el('p', { class: 'err' }, `The last look failed: ${w.lastError}`));
  (w.schedules || []).forEach(sc => lines.push(el('p', { class: 'note' }, `Scheduled: ${sc.issue}, every ${sc.everyMin} minutes until ${when(sc.until)}. `,
    el('button', { type: 'button', class: 'link', onclick: async () => showWatch(await api('/api/watch/unschedule', { id: sc.id })) }, 'Stop'))));
  $('#watch-state').replaceChildren(...lines);
  $('#watch-toggle').textContent = w.on ? 'Turn off' : 'Turn on: start temp checks from incoming alerts';
  if (!$('#watch-settings').children.length) {
    RULE_FIELDS.forEach(([k, label, step]) => $('#watch-settings').append(el('label', { for: `ws-${k}` }, label), el('input', { id: `ws-${k}`, type: 'number', min: '0', step: String(step), value: String(w.settings[k]) })));
  }
  $('#watch-log').replaceChildren(...(w.log.length ? w.log.map(l => el('div', { class: 'post' },
    el('span', { class: `badge ${l.action === 'start' || l.action === 'refresh' ? 'ok' : l.action === 'failed' || l.action === 'held' || l.action === 'empty' ? 'out' : ''}` },
      (l.action === 'empty' ? 'no posts found' : l.action) + (l.rule && RULE_NAMES[l.rule] && l.action === 'start' ? `: ${RULE_NAMES[l.rule]}` : '')), ' ',
    el('span', { class: 'hint' }, when(l.at)), ' ', l.record ? el('button', { type: 'button', class: 'link', onclick: () => openRecord(l.record) }, l.issue) : el('b', {}, l.issue || ''),
    el('div', { class: 'hint' }, (l.reasons || []).join(' ') + (l.error ? ` ${l.error}` : '')))) : [el('p', { class: 'note' }, 'Nothing yet.')]));
}

async function loadWatch() { showWatch(await api('/api/watch')); }

async function toggleWatch() {
  const w = state.watch;
  if (!w.on && !window.confirm(`Turn on automatic temp checks?\n\nFrom now on the app starts a temp check by itself when an incoming alert meets the rules: up to ${w.settings.maxStartsPerDay} a day, each one a BigQuery search of about 1 GB and two Gemini calls, under your Google login. Alerts already there are not acted on. It runs only while this app is running.`)) return;
  showWatch(await api('/api/watch', { on: !w.on }));
}

// One timer for the page: while something automatic is active, the card and the list of temp checks keep up
setInterval(() => { if (state.watch && (state.watch.on || (state.watch.schedules || []).length)) loadWatch().then(loadHistory).catch(() => {}); }, 30000);
setInterval(() => { if (state.chat && (state.chat.cards || state.chat.listen) && !state.chatBusy) loadChat().then(loadHistory).catch(() => {}); }, 30000);

async function tryRules() {
  const out = $('#watch-try-out');
  out.replaceChildren(el('p', { class: 'note' }, 'Trying the rules on the newest 500 alerts…'));
  try {
    const r = await api('/api/watch/replay', { n: 500, settings: settingsNow() });
    const perDay = v => `${num(v)} (${(v / r.days).toFixed(1)} a day)`;
    out.replaceChildren(
      el('p', {}, el('b', {}, `With these numbers, over the newest ${num(r.alerts)} alerts (${r.days.toFixed(1)} days, ${num(r.issues)} issues):`)),
      kv([['Temp checks started', perDay(r.started)], ['…by a high-engaging alert', num(r.byRule.high)], ['…by multiple alerts on one issue', num(r.byRule.multiple)],
        ['Refreshes of an existing one', perDay(r.refreshed)], ['Left to monitoring', perDay(r.monitored)], r.held ? ['Held back by the daily cap', num(r.held)] : null]),
      el('p', { class: 'note' }, `${r.note} Nothing was started: this only shows what the rules would have done.`),
      el('details', {}, el('summary', {}, 'Each one it would have started or refreshed'), el('div', {}, r.decisions.map(d => el('div', { class: 'post' },
        el('span', { class: 'badge ok' }, d.action + (d.action === 'start' ? `: ${RULE_NAMES[d.rule]}` : '')), ' ', el('span', { class: 'hint' }, when(d.at)), ' ', el('b', {}, d.issue),
        el('div', { class: 'hint' }, d.reasons.join(' ')))))));
  } catch (e) { out.replaceChildren(el('p', { class: 'err' }, e.message)); }
}

async function keepRefreshed(rec) {
  try {
    showWatch(await api('/api/watch/schedule', { recordId: rec.id, everyMin: 60, hours: 24 }));
    $('#copy-note').textContent = 'It will be refreshed every hour for the next 24 hours (while the app is running). Stop it under Automatic temp checks.';
  } catch (e) { $('#copy-note').textContent = e.message; }
}

$('#watch-toggle').addEventListener('click', () => toggleWatch().catch(e => $('#watch-state').replaceChildren(el('p', { class: 'err' }, e.message))));
$('#watch-try').addEventListener('click', tryRules);
$('#watch-save').addEventListener('click', async () => { try { showWatch(await api('/api/watch', { settings: settingsNow() })); } catch (e) { $('#watch-try-out').replaceChildren(el('p', { class: 'err' }, e.message)); } });

$$('.seg button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#q-search').addEventListener('input', searchQueries);
$$('input[name=ownq], input[name=from], #own-on').forEach(i => i.addEventListener('change', syncOwn));
$('#preview').addEventListener('click', preview);
$('#a-draft').addEventListener('click', draft);
$('#run').addEventListener('click', () => run());
$('#fill').addEventListener('click', async () => {
  try { showBenchmark(await api('/api/benchmark/fill', {})); } catch (e) { $('#bench').replaceChildren(el('p', { class: 'err' }, e.message)); }
});
// ---------------------------------------------------------------------------------------------------------------
// In Chat: a Doc and a reply for each story card, and "temp check" typed in the space (lib/inchat.js)
// ---------------------------------------------------------------------------------------------------------------

const googleLink = u => (/^https:\/\/(?:docs|drive|chat)\.google\.com\//.test(String(u || '')) ? String(u) : '');
const outLink = (u, text) => (googleLink(u) ? el('a', { href: googleLink(u), target: '_blank', rel: 'noopener' }, text) : null);

async function loadChat() {
  try { showChat(await api('/api/chat')); } catch (e) { $('#chat-state').replaceChildren(el('p', { class: 'err' }, e.message)); }
}

async function switchChat(what, on) {
  const ask = {
    cards: 'Turn on story cards?\n\nFrom now on, each new Early Detection story card gets a temp check from its own query, saved as a Google Doc in your Drive, and the Doc\'s link is posted as a reply in the card\'s thread, as you. Cards already there are left alone. It works only while this app is running.',
    listen: 'Turn on typed requests?\n\nFrom now on, when you type "temp check" in the bot\'s Auto-correct space, the app answers in that thread, as you. Messages already there are left alone. It works only while this app is running.',
  }[what];
  if (on && !window.confirm(ask)) return;
  try { await api('/api/chat/switch', { [what]: on }); await loadChat(); } catch (e) { $('#chat-state').prepend(el('p', { class: 'err' }, e.message)); }
}

/** The other way to sign in, for when Google refuses the first line ("This app is blocked"). */
function refusedHelp(r) {
  if (!r || !r.signIn) return null;
  const consoleLink = /^https:\/\/console\.cloud\.google\.com\//.test(String(r.console || '')) ? el('a', { href: r.console, target: '_blank', rel: 'noopener' }, 'the project\'s sign-in clients') : 'the project\'s sign-in clients';
  return el('details', {}, el('summary', {}, 'If Google says "This app is blocked"'),
    el('p', { class: 'hint' }, 'Google does not always let its own command-line sign-in ask for Chat. The same sign-in then works through a client of the team\'s own project:'),
    el('ol', { class: 'notes' },
      el('li', {}, 'Open ', consoleLink, ` (project ${r.project}), create a client of the type "Desktop app", and download its JSON file.`),
      el('li', {}, 'Save that file as ', el('code', {}, r.clientFile), '. It is a key: keep it there, outside the repository.'),
      el('li', {}, 'Run this line instead, then press "Check again":', el('pre', {}, r.signIn))));
}

function showChat(c) {
  state.chat = c;
  const ready = c.chat.signedIn && c.chat.canRead && c.chat.canPost && c.where.ok;
  const lines = [el('p', { class: 'note' }, 'The app can answer in the bot\'s Auto-correct space as you: a temp check saved as a Google Doc, and its link as a reply in the thread. Nothing is posted until you switch one of these on or press "Post this reply" on a card below.')];
  if (c.chat.signedIn && c.chat.canRead && c.chat.canPost) lines.push(el('p', {}, el('span', { class: 'badge ok' }, 'signed in to Chat'), ' It can read the space and reply as you.'));
  else {
    lines.push(el('div', { class: 'picked' }, el('b', {}, c.chat.signedIn ? 'The Chat sign-in is missing a permission.' : 'Not signed in to Chat yet.'),
      el('div', { class: 'hint' }, `${c.chat.why} Run this line once in a terminal, choose your account in the browser it opens, then press "Check again". It is a sign-in of its own: your other Google logins on this computer stay as they are.`),
      el('pre', {}, c.chat.signIn), el('button', { type: 'button', onclick: loadChat }, 'Check again'), refusedHelp(c.chat.ifRefused)));
  }
  if (!c.where.ok && c.where.why) lines.push(el('p', { class: 'err' }, c.where.why));
  if (c.problem) lines.push(el('p', { class: 'err' }, c.problem));
  if (c.lastError) lines.push(el('p', { class: 'err' }, `The last look failed: ${c.lastError}`));
  const row = (what, on, label, text) => el('div', { class: 'swrow' }, el('span', { class: `onoff${on ? ' on' : ''}` }, on ? 'ON' : 'OFF'),
    el('div', { class: 'grow' }, el('b', {}, label), el('div', { class: 'hint' }, text)),
    el('button', { type: 'button', disabled: !on && !ready, title: !on && !ready ? 'Sign in to Chat first' : '', onclick: () => switchChat(what, !on) }, on ? 'Turn off' : 'Turn on'));
  lines.push(row('cards', c.cards, 'Story cards', 'Each new Early Detection story card gets a temp check from its own query, a Google Doc, and the Doc\'s link as a reply in its thread.'));
  lines.push(row('listen', c.listen, 'Typed requests', 'When you type "temp check" in the space, the app answers in that thread.'));
  lines.push(el('details', {}, el('summary', {}, 'What to type'),
    el('ul', { class: 'notes' },
      el('li', {}, el('code', {}, 'temp check'), el('div', { class: 'hint' }, 'In a story card\'s thread: counted with the card\'s own query. In an alert\'s thread: with a query the app drafts from the alert and then checks against the posts it found; the reply names the query and says how well it fits. Typed again there: an update of the last one.')),
      el('li', {}, el('code', {}, 'temp check [G EVENT] NOV26 Alleged Gmail Outage'), el('div', { class: 'hint' }, 'A Brandwatch query by its name, its link or its id: Brandwatch\'s own numbers for it, with the concern level.')),
      el('li', {}, el('code', {}, 'temp check "google calendar" AND (scam OR phish*)'), el('div', { class: 'hint' }, 'A Boolean: counted in Brandwatch\'s standing Google queries and in our own tables.'))),
    el('p', { class: 'note' }, 'Only your own messages are heard. The bot reads the same space: it leaves "temp check" and a query alone, but if your words include ones it takes for a question about the alert (issue, status, email, help and the like), it may answer in the thread as well.')));
  lines.push(el('p', { class: 'note' }, `Replies posted today: ${num(c.postedToday)} of at most ${num(c.maxPerDay)}. `, 'The Docs are kept in one folder of your Drive',
    googleLink(c.folderUrl) ? [' (', outLink(c.folderUrl, 'open it'), ')'] : '', '. They are private to you until you share that folder: share it once with the people who should be able to open the links.'));
  $('#chat-state').replaceChildren(...lines);

  $('#chat-stories').replaceChildren(...(c.stories.length ? c.stories.map(storyView) : [el('p', { class: 'note' }, c.problem ? 'The bot\'s story cards could not be read.' : 'The bot has posted no story card lately.')]));
  $('#chat-log').replaceChildren(...(c.log.length ? c.log.map(l => el('div', { class: 'post' },
    el('span', { class: `badge ${l.state === 'replied' || l.state === 'ready' || l.state === 'switched on' ? 'ok' : l.state === 'failed' ? 'out' : l.state === 'left alone' ? 'approx' : ''}` }, l.state || 'note'), ' ',
    el('span', { class: 'hint' }, when(l.at)), ' ', el('b', {}, l.title || ''), ' ', outLink(l.docUrl, 'Doc'), ' ', outLink(l.thread, 'thread'),
    el('div', { class: 'hint' }, l.what || ''))) : [el('p', { class: 'note' }, 'Nothing yet.')]));
}

function storyView(s) {
  const box = el('div', { class: 'story' }, el('div', { class: 't' }, s.title, s.update ? el('span', { class: 'badge' }, 'update') : null),
    el('div', { class: 'hint' }, when(s.at), ' · ', outLink(s.thread, 'its thread in Chat')));
  const counted = s.total === null ? '' : `${num(s.total)} ${s.basis === 'own' ? 'posts in our tables' : 'mentions in Brandwatch'}`;
  if (s.state === 'replied') box.append(el('div', {}, el('span', { class: 'badge ok' }, 'replied'), ` ${when(s.repliedAt)} · ${counted} · `, outLink(s.docUrl, 'open the Doc')));
  else if (s.state === 'ready') {
    const c = state.chat || {};
    const can = !!(c.chat && c.chat.canPost && c.where && c.where.ok);
    [el('div', {}, el('span', { class: 'badge approx' }, 'made, not posted'), ` ${counted} · `, outLink(s.docUrl, 'open the Doc'), ' · ', el('button', { type: 'button', class: 'link', onclick: () => openRecord(s.checkId) }, 'show it here')),
      s.why ? el('div', { class: 'warn' }, s.why) : null, el('div', { class: 'hint' }, 'The reply, word for word:'), el('pre', {}, s.text),
      el('button', { type: 'button', disabled: !can, title: can ? '' : 'Sign in to Chat first', onclick: () => postStory(s) }, 'Post this reply as me'),
      can ? null : el('div', { class: 'hint' }, 'Posting needs the Chat sign-in above.')].filter(Boolean).forEach(n => box.append(n));
  } else {
    if (s.state) box.append(el('div', {}, el('span', { class: `badge ${s.state === 'failed' ? 'out' : ''}` }, s.state === 'empty' ? 'nothing matched' : s.state), ' ', el('span', { class: 'hint' }, s.why)));
    if (!s.hasQuery) box.append(el('div', { class: 'hint' }, 'This card came without a draft query, so there is nothing to count with.'));
    else box.append(el('button', { type: 'button', onclick: ev => makeStory(s, ev.target) }, s.state ? 'Try again' : 'Make its temp check'));
  }
  return box;
}

async function makeStory(s, button) {
  if (state.chatBusy) return;
  state.chatBusy = true;
  const note = el('div', { class: 'hint' }, 'Starting…');
  button.disabled = true;
  button.after(note);
  try {
    let job = await api('/api/chat/prepare', { id: s.id });
    while (job.status === 'running') {
      await new Promise(r => setTimeout(r, 800));
      job = await api(`/api/jobs/${job.id}`);
      note.textContent = job.steps.length ? job.steps[job.steps.length - 1].text + '…' : 'Starting…';
    }
    if (job.status === 'failed') throw new Error(job.error || 'It failed.');
    if (job.recordId) openRecord(job.recordId);
    loadHistory();
  } catch (e) {
    note.className = 'err';
    note.textContent = e.message;
    state.chatBusy = false;
    button.disabled = false;
    return;
  }
  state.chatBusy = false;
  await loadChat();
}

async function postStory(s) {
  if (!window.confirm(`Post this as a reply in the card's thread, as you?\n\n${s.text}`)) return;
  try { await api('/api/chat/post', { key: `card:${s.id}` }); } catch (e) { window.alert(e.message); }
  await loadChat();
}

setMode('query');
loadAbout().then(loadHistory).then(searchQueries).then(loadWatch).then(loadChat).catch(e => $('#result').replaceChildren(el('p', { class: 'err' }, e.message)));
