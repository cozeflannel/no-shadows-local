/**
 * docs.js — a temp check as a Google Doc, so its link can be opened by anyone it is shared with, with the app closed.
 *
 * Each Doc is made in one folder of the Drive of whoever runs the app ("Temp checks (automatic drafts)", made the
 * first time). A new Doc is private to that person, like the folder: sharing the folder once is what lets others open
 * the links, and that is left to them. Nothing here changes who can see anything, and nothing is ever deleted.
 *
 * The Doc is the write-up as the app shows it, with the hourly chart as a picture (png.js: a Doc can't run the page's
 * chart), a line on top saying it was made automatically and from what, and a short "how it was made" underneath.
 */
'use strict';

const { PROJECT, accessToken, gfetch } = require('./gcp');
const store = require('./store');
const tc = require('./tempcheck');
const png = require('./png');
const own = require('./owndata');

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_NAME = 'Temp checks (automatic drafts)';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const DOC_TYPE = 'application/vnd.google-apps.document';
const FILE = 'docs.json';
const esc = tc.esc;

/** A Doc's name: "Temp check draft: <title> (11/19 10pm PT)". Pure. */
function docName(rec, title) {
  return tc.truncate(`Temp check draft: ${String(title || rec.issue || '').replace(/\s+/g, ' ').trim()} (${tc.day(rec.at)} ${tc.hourLabel(rec.at)} PT)`, 200);
}

/** Where a temp check's numbers come from, in a sentence. Pure. */
function basisLine(rec) {
  if (rec.basis === 'own') return 'It is built from our own tables only: its counts are posts, not Brandwatch mentions.';
  if (rec.query) return `Its numbers are Brandwatch's, from the query "${rec.query.name}".`;
  const n = rec.standing && rec.standing.queries ? `${tc.num(rec.standing.queries)} ` : '';
  return `Its numbers are Brandwatch's, counted in its ${n}standing Google queries with the query below, because the issue has no Brandwatch query of its own yet.`;
}

/**
 * The Doc's content as HTML (Drive turns it into a Doc). `about`: {why ('card': made for an Early Detection story
 * card; 'ask': asked for in Chat; else made in the app), threadUrl (the Chat thread it answers), drafted ({note}: the
 * query was drafted from the alert, and what checking it found)}. Everything that came
 * from a post, a query or Gemini is escaped; the write-up's own HTML is the app's (tempcheck.js, escaped there). Pure.
 */
function docHtml(rec, about) {
  const a = about || {};
  const made = a.why === 'card' ? 'for an Early Detection story card' : a.why === 'ask' ? 'when it was asked for in Chat' : 'in the temp check app';
  const chart = rec.total > 0 ? png.lineChart((rec.chart && rec.chart.points) || []) : null;
  const picture = chart ? `<p style="margin:0 0 14px"><b>${esc((rec.chart && rec.chart.title) || '')}</b><br>` +
    `<img src="data:image/png;base64,${chart.png.toString('base64')}" width="${chart.width}" height="${chart.height}" alt="${esc(`${rec.chart.unit} by hour`)}"></p>` : '';
  const body = String((rec.writeup && rec.writeup.html) || '').replace(tc.CHART_MARK, picture);
  const o = rec.own || null;
  const tables = o && o.tables ? Object.keys(own.SOURCES).filter(k => o.tables[k]).map(k => `${own.SOURCES[k].label} ${o.tables[k].skip ? 'not searched' : tc.num(o.tables[k].matched)}`) : [];
  const st = rec.standing || null;
  const li = (k, v) => `<li style="margin:0 0 4px"><b>${esc(k)}</b> ${v}</li>`;
  const how = [
    li('Counted:', esc(`from ${tc.when(rec.window.from, rec.at)} to ${tc.when(rec.window.to, rec.at)}.`)),
    li('Brandwatch:', esc(rec.query ? `the query "${rec.query.name}".` : st && !st.skipped ? `${tc.num(st.total)} mentions in its ${tc.num(st.queries)} standing Google queries, searched with the query below.`
      : st && st.skipped ? `not the source of these numbers. ${st.skipped}` : 'not asked.')),
    o && o.boolean ? li('The query:', `<span style="font-family:Consolas,monospace;font-size:9pt">${esc(tc.truncate(o.boolean, 1500))}</span>`) : '',
    a.drafted ? li('Where the query came from:', esc(`Gemini drafted it from the alert; nobody chose it. ${String(a.drafted.note || '')}`)) : '',
    o && !o.error ? li('Our own tables:', esc(`${tc.num(o.total)} posts and comments (${tables.join(', ')}). They are a second look beside Brandwatch's count, not part of it.`)) : '',
    li('Concern level:', esc(rec.level && rec.level.label ? `${rec.level.label} (the app's own ranking: check it against the team's benchmark).` : `none. ${(rec.level && rec.level.why) || ''}`)),
    li('Words:', esc(`Gemini wrote the summary, negativity drivers and themes from the ${tc.num((rec.readPosts || []).length)} most-engaged posts. Every number was counted, not written.`)),
  ].join('');
  return '<html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#202124">' +
    `<p style="margin:0 0 14px;color:#5f6368;font-size:9pt">A first look made automatically ${esc(made)} at ${esc(tc.when(rec.at, rec.at))} on ${esc(tc.day(rec.at))}. ` +
    `${esc(basisLine(rec))} It is a draft for an analyst to check, not a finished temp check.` +
    (a.threadUrl && /^https:\/\/chat\.google\.com\//.test(a.threadUrl) ? ` <a href="${esc(a.threadUrl)}">The thread in Chat</a>.` : '') + '</p>' +
    body + '<h3 style="font-size:12pt;margin:18px 0 6px">How it was made</h3>' + `<ul style="margin:0;padding-left:24px;font-size:10pt">${how}</ul>` + '</body></html>';
}

async function folderOk(id) {
  try {
    const f = await gfetch(`${DRIVE}/${encodeURIComponent(id)}?fields=id,trashed,mimeType`);
    return f && f.id && !f.trashed && f.mimeType === FOLDER_TYPE;
  } catch (e) {
    if (e && (e.status === 404 || e.status === 403)) return false;
    throw e;
  }
}

/**
 * The folder the Docs go in: {id, url}. The one remembered when it is still there; else the one this app made before
 * (found by the mark the app left on it, not by its name); else a new one. Never touches a folder it did not make.
 */
async function folder() {
  const kept = store.readFile(FILE, null) || {};
  if (kept.folder && await folderOk(kept.folder)) return { id: kept.folder, url: `https://drive.google.com/drive/folders/${kept.folder}` };
  const q = `mimeType = '${FOLDER_TYPE}' and trashed = false and appProperties has { key='tempcheckApp' and value='drafts' }`;
  const found = await gfetch(`${DRIVE}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id)')}&pageSize=5&spaces=drive`);
  let id = ((found.files || [])[0] || {}).id || '';
  if (!id) {
    const made = await gfetch(`${DRIVE}?fields=id`, { method: 'POST', body: { name: FOLDER_NAME, mimeType: FOLDER_TYPE, appProperties: { tempcheckApp: 'drafts' } } });
    id = made.id;
  }
  if (!id) throw new Error('Drive gave no folder to keep the Docs in');
  store.writeFile(FILE, Object.assign({}, kept, { folder: id }));
  return { id, url: `https://drive.google.com/drive/folders/${id}` };
}

/** Temp check `rec` as a new Google Doc in the folder: {id, url, name, folderUrl}. `about` as docHtml takes it, with `title`. */
async function create(rec, about) {
  const a = about || {};
  const dir = await folder();
  const name = docName(rec, a.title);
  const html = docHtml(rec, a);
  const edge = `tc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const meta = JSON.stringify({ name, mimeType: DOC_TYPE, parents: [dir.id], appProperties: { tempcheckApp: 'draft', tempCheck: String(rec.id || '') } });
  const body = `--${edge}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${edge}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${edge}--`;
  const resp = await fetch(`${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent('id,name,webViewLink')}`, {
    method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'x-goog-user-project': PROJECT, 'Content-Type': `multipart/related; boundary=${edge}` },
    body, signal: AbortSignal.timeout(60000) });
  const text = await resp.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = {}; }
  if (!resp.ok || !json.id) {
    const why = (json.error && json.error.message) || text.slice(0, 300);
    const err = new Error(`Drive would not make the Doc (HTTP ${resp.status}): ${String(why).replace(/\s+/g, ' ').trim()}`);
    err.status = resp.status;
    throw err;
  }
  return { id: json.id, name: json.name || name, url: json.webViewLink || `https://docs.google.com/document/d/${json.id}/edit`, folderUrl: dir.url };
}

/** What Drive made of a Doc, as plain text (to check a Doc after making it). Read only. */
async function textOf(id) {
  const resp = await fetch(`${DRIVE}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent('text/plain')}`,
    { headers: { Authorization: `Bearer ${await accessToken()}`, 'x-goog-user-project': PROJECT }, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`Drive would not give the Doc's text (HTTP ${resp.status})`);
  return resp.text();
}

module.exports = { FOLDER_NAME, docName, basisLine, docHtml, folder, create, textOf };
