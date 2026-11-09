/**
 * Knowledge.gs — the bot's knowledge base: the documents listed on the Resources tab, read in full, so Gemini works each
 * alert the way an analyst does with the team's reference documents open.
 *
 * The Resources tab (Control.gs): Name · Link · What it covers · Burson can see it? (Yes / No) · Bot status (written
 * here, so people can see which documents the bot could read and when).
 *   Read:     Google Docs and Google Slides (their text), Google Sheets (a link to one tab, with #gid= in it, reads that
 *             tab only; a link to the whole spreadsheet reads every tab), text, CSV, Markdown, HTML and JSON
 *             files in Drive, and public web pages.
 *   Not read, and the Bot status says what to do instead: go/ links (paste the full link), PDFs and Word, Excel or
 *             PowerPoint files (save them as Google Docs, Sheets or Slides first), folders, pages that need a sign-in,
 *             and Chat links.
 *
 * The text is kept in the bot's own hidden tab, "Knowledge cache (bot)", so an alert never waits on Drive. The bot makes
 * that tab itself and never reads or writes a tab it didn't make (its header row is the bot's own); nobody needs to
 * rename or edit any tab for the knowledge base. Every run (poll()) looks at the
 * Resources tab: a new or changed row is read right away; every 15 minutes the bot asks Drive whether a document changed
 * and reads it again if it did; a web page is read again every 6 hours; a document it couldn't read is tried again every
 * 30 minutes. refreshKnowledge() reads them all now (run it from the editor: the first time, it asks for the Drive
 * permission).
 *
 * Who gets what (knowledgeFor_: every document in whole when they fit, else the parts that bear on the alert or question):
 *   the alert review (Review.gs assessPrompts_)       every document; Gemini names the ones it relied on (knowledge_used,
 *                                                     kept on the Alert log row). With Check outage & comms docs ON
 *                                                     (Control tab row 20), a passage with a holding statement or talking
 *                                                     points ranks higher (knowledgeQuery_), for the Social Alert email
 *   analyst answers (Voice.gs answerAnalystPrompts_)  every document
 *   answers to Burson (Voice.gs answerPrompts_)       only the documents marked Yes in "Burson can see it?"
 *
 * Docs, Slides and Drive files are read with the Drive read-only permission (appsscript.json); Sheets with the Sheets
 * permission the bot already has.
 */

const KNOWLEDGE_TAB_ = 'Knowledge cache (bot)';  // the bot's own hidden tab: never the Resources tab, never renamed by hand
const KNOWLEDGE_HEADER_ = ['Link', 'Part', 'Text (written by the Burson QA bot)'];  // how the bot knows the tab is its own
const KNOWLEDGE_STATE_PROP_ = 'KNOWLEDGE_STATE';
const KNOWLEDGE_READER_ = 2;                   // how documents are read (2: a Sheets link to one tab reads only that tab). When
                                               // this goes up, each copy made the old way is read again on the next run
const KNOWLEDGE_CELL_CHARS_ = 45000;           // per cell of the storage tab (Sheets holds 50,000)
const KNOWLEDGE_DOC_MAX_CHARS_ = 1000000;      // per document (room for the ~3,000-row KOF tab): the rest is left out, and Bot status says so
const KNOWLEDGE_CHECK_MS_ = 15 * 60 * 1000;    // ask Drive whether a document changed
const KNOWLEDGE_WEB_MS_ = 6 * 3600 * 1000;     // read a web page again
const KNOWLEDGE_RETRY_MS_ = 30 * 60 * 1000;    // try a document the bot couldn't read again
const KNOWLEDGE_RUN_MS_ = 25 * 1000;           // reading time in an every-minute run (the rest waits for the next run)
const KNOWLEDGE_FULL_MS_ = 240 * 1000;         // reading time for refreshKnowledge() and setup()
const KNOWLEDGE_REVIEW_CHARS_ = 100000;        // of the documents in each alert review
const KNOWLEDGE_ANSWER_CHARS_ = 40000;         // in each analyst answer
const KNOWLEDGE_BURSON_CHARS_ = 25000;         // in each answer to Burson (the documents Burson can see only)
const KNOWLEDGE_PASSAGE_CHARS_ = 1800;         // a long document is searched in passages about this long
const KNOWLEDGE_SHORT_CHARS_ = 8000;           // a document this short goes in whole even when they don't all fit
const KNOWLEDGE_SHEET_ROWS_ = 20000;           // per tab of a Google Sheet
const KNOWLEDGE_SHEET_COLS_ = 40;
const KNOWLEDGE_DOWNLOAD_MAX_BYTES_ = 10 * 1024 * 1024;
const DRIVE_FILES_API_ = 'https://www.googleapis.com/drive/v3/files/';
const DRIVE_META_FIELDS_ = 'id,name,mimeType,modifiedTime,version,size,shortcutDetails';
const KNOWLEDGE_OFFICE_ = {
  'application/msword': ['Word', 'Google Docs'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['Word', 'Google Docs'],
  'application/vnd.ms-excel': ['Excel', 'Google Sheets'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['Excel', 'Google Sheets'],
  'application/vnd.ms-powerpoint': ['PowerPoint', 'Google Slides'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['PowerPoint', 'Google Slides'],
};

// ---------------------------------------------------------------------------------------------------------------
// Things you run
// ---------------------------------------------------------------------------------------------------------------

/**
 * Run this to read every document on the Resources tab now (the first time, Apps Script asks for the Drive
 * permission: click Allow). Logs what it found for each row; the same is in the tab's Bot status column.
 */
function refreshKnowledge() {
  const ss = openStore_(false);
  const out = refreshKnowledge_(ss, { force: true, deadline: Date.now() + KNOWLEDGE_FULL_MS_ });
  const rows = readResourceRows_(ss).filter(r => r.name || r.url).map(r => `${r.name || r.url}: ${r.status || '(not read yet)'}`);
  console.log(`${knowledgeSummaryText_(out)}\n\n${rows.join('\n') || '(no Resources tab, or no rows on it)'}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Keeping the knowledge base current
// ---------------------------------------------------------------------------------------------------------------

/**
 * Brings the knowledge base up to date with the Resources tab: every run from poll(); setup() and refreshKnowledge()
 * with opts.force (read everything again). Nothing is read when no row changed and nothing is due. A copy made by an
 * older way of reading (KNOWLEDGE_READER_) is read again on the next run. Writes each row's Bot status.
 * opts: {force, deadline (ms: no new document is started after it; the rest is read on the next run), log (each
 * document read goes in the run log: poll() asks for it)}.
 * Returns {docs, readable, failed, waiting, chars, at, next, hash, reader}. Throws only when the bot's sheet can't be read.
 * Only the bot's own storage tab is ever written: when a tab people made has its name, nothing is read or written and
 * every row's Bot status says so.
 */
function refreshKnowledge_(ss, opts) {
  const o = opts || {};
  const now = Date.now();
  const props = PropertiesService.getScriptProperties();
  const rows = readResourceRows_(ss).filter(r => r.name || r.url);
  const hash = hashText_(JSON.stringify(rows.map(r => [r.name, r.url, r.covers, r.burson])));
  let state = {};
  try { state = JSON.parse(props.getProperty(KNOWLEDGE_STATE_PROP_) || '{}') || {}; } catch (e) { state = {}; }
  const fresh = !ss.getSheetByName(KNOWLEDGE_TAB_);
  const current = Number(state.reader || 1) === KNOWLEDGE_READER_;
  if (!o.force && !fresh && current && state.hash === hash && now < Number(state.next || 0)) return state;
  const sh = knowledgeTab_(ss);
  if (!sh) {  // a tab people made has the storage tab's name: nothing is read or written until it's renamed
    const why = `✗ Not read: ${knowledgeBlockedText_()}`;
    writeResourceStatuses_(ss, rows.map(r => ({ row: r.row, text: why })));
    const blocked = { hash: '', at: now, next: now + KNOWLEDGE_RETRY_MS_, docs: rows.length, readable: 0, failed: rows.length,
      waiting: 0, chars: 0, blocked: true };
    props.setProperty(KNOWLEDGE_STATE_PROP_, JSON.stringify(blocked));
    return blocked;
  }
  const cache = readKnowledgeTab_(sh);
  const email = String(Session.getEffectiveUser().getEmail() || '');
  // Drive is asked whether its documents changed every 15 minutes, all of them in the same run
  const checkDue = now - Number(state.checked_at || 0) >= KNOWLEDGE_CHECK_MS_;
  const out = new Map();
  const statuses = [];
  let changed = fresh;
  let unfinished = false;  // out of time: the next run goes on
  rows.forEach((r, i) => {
    if (!r.url) {
      statuses.push({ row: r.row, text: '✗ No link: paste the document\'s link in column B.' });
      return;
    }
    if (out.has(r.url)) {  // the same link on two rows: read once
      statuses.push({ row: r.row, text: knowledgeStatusText_(out.get(r.url).meta) });
      return;
    }
    let entry = cache.get(r.url) || null;
    const need = knowledgeNeed_(entry && entry.meta, r.url, now, o.force, checkDue);
    if (need && (!o.deadline || Date.now() < o.deadline)) {
      const updated = knowledgeUpdate_(r.url, entry, need, now, email);
      if (updated !== entry) {
        changed = true;
        if (o.log) console.log(`knowledge base: ${r.name || r.url}: ${knowledgeStatusText_(updated.meta)}`);
      }
      entry = updated;
    } else if (need) {
      unfinished = true;
      if (!entry) entry = { meta: { url: r.url, status: 'waiting' }, text: '' };
    }
    const m = entry.meta;
    if (m.name !== r.name || m.covers !== r.covers || m.burson !== r.burson || m.order !== i) {
      entry = { meta: Object.assign({}, m, { name: r.name, covers: r.covers, burson: r.burson, order: i }), text: entry.text };
      changed = true;
    }
    out.set(r.url, entry);
    statuses.push({ row: r.row, text: knowledgeStatusText_(entry.meta) });
  });
  cache.forEach((v, url) => { if (!out.has(url)) changed = true; });  // rows taken off the tab
  if (changed) writeKnowledgeTab_(sh, out);
  writeResourceStatuses_(ss, statuses);
  const checkedAt = checkDue && !unfinished ? now : Number(state.checked_at || 0);
  let next = unfinished ? now : now + KNOWLEDGE_CHECK_MS_;
  out.forEach(e => { next = Math.min(next, knowledgeNextAt_(e.meta, now, checkedAt)); });
  const entries = Array.from(out.values());
  const readable = entries.filter(e => e.meta.status === 'ok' && e.text);
  const result = {
    hash, at: now, next: Math.max(next, now), checked_at: checkedAt,
    docs: entries.length, readable: readable.length,
    failed: entries.filter(e => e.meta.status === 'error').length,
    waiting: entries.filter(e => e.meta.status === 'waiting').length,
    chars: readable.reduce((t, e) => t + e.text.length, 0),
    reader: KNOWLEDGE_READER_,
  };
  props.setProperty(KNOWLEDGE_STATE_PROP_, JSON.stringify(result));
  return result;
}

/**
 * What a document needs now: 'read', 'check' (ask Drive whether it changed: due for every Drive document every 15
 * minutes, checkDue) or '' (nothing yet). A copy made by an older way of reading is read again. Pure.
 */
function knowledgeNeed_(meta, url, now, force, checkDue) {
  if (force || !meta || meta.url !== url || meta.status === 'waiting') return 'read';
  if (meta.status === 'ok' && Number(meta.reader || 1) !== KNOWLEDGE_READER_) return 'read';
  if (meta.status === 'error') return !meta.permanent && now - Number(meta.tried_at || 0) >= KNOWLEDGE_RETRY_MS_ ? 'read' : '';
  const kind = resourceLink_(url).kind;
  if (kind === 'web') return now - Number(meta.read_at || 0) >= KNOWLEDGE_WEB_MS_ ? 'read' : '';
  if (knowledgeDriveKind_(kind)) return checkDue ? 'check' : '';
  return '';
}

/** When a document next needs something (ms; Infinity for never, until its row changes). checkedAt: Drive's last check. Pure. */
function knowledgeNextAt_(meta, now, checkedAt) {
  if (!meta || meta.status === 'waiting') return now;
  if (meta.status === 'error') return meta.permanent ? Infinity : Number(meta.tried_at || 0) + KNOWLEDGE_RETRY_MS_;
  const kind = resourceLink_(meta.url).kind;
  if (kind === 'web') return Number(meta.read_at || 0) + KNOWLEDGE_WEB_MS_;
  if (knowledgeDriveKind_(kind)) return Number(checkedAt || 0) + KNOWLEDGE_CHECK_MS_;
  return Infinity;
}

function knowledgeDriveKind_(kind) { return ['doc', 'sheet', 'slides', 'drive'].indexOf(kind) >= 0; }

/**
 * One document read (need 'read'), or asked about first (need 'check': read again only when Drive says it changed).
 * Returns the entry {meta, text}: the same object when nothing changed. A copy read earlier stays in use while Drive or
 * the page is only briefly unavailable; a document that can no longer be opened is dropped (its status says why).
 */
function knowledgeUpdate_(url, entry, need, now, email) {
  const link = resourceLink_(url);
  const keep = why => ({ meta: Object.assign({}, entry.meta, { check_error: why || '' }), text: entry.text });
  const failed = e => ({ meta: { url, status: 'error', why: String((e && e.message) || e), permanent: !!(e && e.permanent), tried_at: now }, text: '' });
  if (need === 'check' && entry && entry.meta.status === 'ok') {
    try {
      const meta = knowledgeShortcutTarget_(driveMeta_(link.id, email), email);
      if (String(meta.modifiedTime || '') === String(entry.meta.modified || '') && String(meta.version || '') === String(entry.meta.version || '')) {
        return entry.meta.check_error ? keep('') : entry;  // unchanged: the copy it has is current
      }
    } catch (e) {
      return e && e.temporary ? keep(String(e.message)) : failed(e);
    }
  }
  try {
    const got = readResourceText_(link, url, email);
    const raw = String(got.text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n').trim();
    if (!raw) return failed(knowledgeError_(`the ${got.label} has no text the bot can read.`));
    const truncated = raw.length > KNOWLEDGE_DOC_MAX_CHARS_;
    const text = truncated ? raw.slice(0, KNOWLEDGE_DOC_MAX_CHARS_) : raw;
    return {
      meta: { url, status: 'ok', label: got.label, title: got.title || '', modified: got.modified || '', version: got.version || '',
        read_at: now, chars: text.length, truncated, reader: KNOWLEDGE_READER_ },
      text,
    };
  } catch (e) {
    if (e && e.temporary && entry && entry.meta.status === 'ok' && entry.text) return keep(String(e.message));
    return failed(e);
  }
}

/** An error whose message is shown in the Bot status. kind: 'temporary' (Drive busy) | 'permanent' (until the row changes). */
function knowledgeError_(message, kind) {
  const e = new Error(message);
  e.temporary = kind === 'temporary';
  e.permanent = kind === 'permanent';
  return e;
}

/** "✓ Read Oct 20, 12:41 PM EDT · Google Doc · 23,410 characters", "✗ …": a row's Bot status. */
function knowledgeStatusText_(meta) {
  if (!meta) return '';
  if (meta.status === 'ok') {
    const when = Utilities.formatDate(new Date(Number(meta.read_at) || Date.now()), GEN.timezone || 'America/New_York', 'MMM d, h:mm a z');
    return `✓ Read ${when} · ${meta.label || 'document'} · ${fmtInt_(meta.chars)} characters` +
      (meta.truncated ? ` (only the first ${fmtInt_(KNOWLEDGE_DOC_MAX_CHARS_)} are used)` : '') +
      (meta.check_error ? ` · ⚠️ couldn't check it for changes just now: ${meta.check_error}` : '');
  }
  if (meta.status === 'waiting') return '… Not read yet: the bot reads it on its next run.';
  const why = String(meta.why || 'couldn\'t read it.');
  return `✗ ${why.charAt(0).toUpperCase()}${why.slice(1)}`;
}

/** "Read 3 of 4 documents (52,310 characters). 1 couldn't be read: see the Bot status column on the Resources tab." */
function knowledgeSummaryText_(s) {
  const st = s || {};
  if (st.blocked) return `Nothing read: ${knowledgeBlockedText_()}`;
  if (!st.docs) return 'The Resources tab lists no documents yet.';
  return `Read ${st.readable} of ${st.docs} document${st.docs === 1 ? '' : 's'} (${fmtInt_(st.chars || 0)} characters).` +
    (st.failed ? ` ${st.failed} couldn't be read: see the Bot status column on the Resources tab.` : '') +
    (st.waiting ? ` ${st.waiting} will be read on the next run.` : '');
}

/** Why nothing is read while a tab people made has the storage tab's name (Bot status and the summaries). */
function knowledgeBlockedText_() {
  return `a tab named "${KNOWLEDGE_TAB_}" that the bot didn't make is in the way. Rename that tab, and the bot makes its own.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading one document
// ---------------------------------------------------------------------------------------------------------------

/**
 * What a Resources-tab link points to: {kind: 'doc' | 'sheet' | 'slides' | 'drive' | 'web' | 'golink' | 'chat' |
 * 'none', id, gid (a Sheet link's tab)}. Pure.
 */
function resourceLink_(url) {
  const s = String(url || '').trim();
  if (!s) return { kind: 'none' };
  if (/^(?:https?:\/\/)?(?:go|goto\.google\.com|go\.corp\.google\.com)\/\S*/i.test(s)) return { kind: 'golink' };
  if (/^https?:\/\/(?:chat\.google\.com|mail\.google\.com\/chat)\b/i.test(s)) return { kind: 'chat' };
  let m = s.match(/^https?:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/i);
  if (m) {
    const kind = { document: 'doc', spreadsheets: 'sheet', presentation: 'slides' }[m[1].toLowerCase()];
    return { kind, id: m[2], gid: (s.match(/[#?&]gid=(\d+)/) || [])[1] || '' };
  }
  m = s.match(/^https?:\/\/drive\.google\.com\/(?:file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})|open\?(?:[^#]*&)?id=([A-Za-z0-9_-]{10,}))/i);
  if (m) return { kind: 'drive', id: m[1] || m[2] };
  if (/^https?:\/\/[^\s/]+\.[^\s]*$/i.test(s)) return { kind: 'web' };
  return { kind: 'none' };
}

/** The document's text: {label, title, modified, version, text}. Throws a knowledgeError_ that says what to do. */
function readResourceText_(link, url, email) {
  if (link.kind === 'golink') {
    throw knowledgeError_('go/ links only open on Google\'s network, not for the bot: open the document and paste its full ' +
      'link from the address bar.', 'permanent');
  }
  if (link.kind === 'chat') throw knowledgeError_('a Chat link isn\'t a document: link a Doc, Sheet, Slides or web page.', 'permanent');
  if (link.kind === 'none') throw knowledgeError_('this isn\'t a link the bot can open: paste the document\'s full https:// link.', 'permanent');
  if (link.kind === 'web') return readWebPage_(url);
  return readDriveFile_(link, email);
}

/** A Drive file by its mime type (a shortcut is followed). */
function readDriveFile_(link, email) {
  const meta = knowledgeShortcutTarget_(driveMeta_(link.id, email), email);
  const base = { title: meta.name || '', modified: meta.modifiedTime || '', version: String(meta.version || '') };
  const mime = String(meta.mimeType || '');
  if (mime === 'application/vnd.google-apps.document') return Object.assign(base, { label: 'Google Doc', text: driveExport_(meta.id, email) });
  if (mime === 'application/vnd.google-apps.presentation') return Object.assign(base, { label: 'Google Slides', text: driveExport_(meta.id, email) });
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    const sheet = readSpreadsheet_(meta.id, link.gid, email);
    return Object.assign(base, { label: sheet.label, text: sheet.text });
  }
  if (mime === 'application/vnd.google-apps.folder') throw knowledgeError_('this is a folder: list each document in it on its own row.', 'permanent');
  if (mime === 'application/pdf') {
    throw knowledgeError_('the bot can\'t read PDFs: in Drive, right-click it, choose Open with > Google Docs, and link the ' +
      'Google Doc that makes.', 'permanent');
  }
  const office = KNOWLEDGE_OFFICE_[mime];
  if (office) {
    throw knowledgeError_(`the bot can't read ${office[0]} files: open it and choose File > Save as ${office[1]}, then link ` +
      'that.', 'permanent');
  }
  if (/^text\//.test(mime) || /json|xml|csv|markdown/.test(mime)) {
    if (Number(meta.size) > KNOWLEDGE_DOWNLOAD_MAX_BYTES_) throw knowledgeError_('the file is over 10 MB: link a shorter one.', 'permanent');
    const text = driveDownload_(meta.id, email);
    return Object.assign(base, mime === 'text/html' ? { label: 'web page file', text: htmlToText_(text) } : { label: 'text file', text });
  }
  throw knowledgeError_(`the bot can't read this kind of file (${mime || 'unknown type'}): save it as a Google Doc and link that.`, 'permanent');
}

/** A Drive shortcut's target (its metadata), else the file itself. */
function knowledgeShortcutTarget_(meta, email) {
  const target = meta && meta.mimeType === 'application/vnd.google-apps.shortcut' && meta.shortcutDetails && meta.shortcutDetails.targetId;
  return target ? driveMeta_(target, email) : meta;
}

function driveMetaUrl_(id) {
  return `${DRIVE_FILES_API_}${encodeURIComponent(id)}?fields=${encodeURIComponent(DRIVE_META_FIELDS_)}&supportsAllDrives=true`;
}
function driveExportUrl_(id) { return `${DRIVE_FILES_API_}${encodeURIComponent(id)}/export?mimeType=text%2Fplain`; }
function driveDownloadUrl_(id) { return `${DRIVE_FILES_API_}${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`; }

/** GET a Drive API URL as the bot's account: {code, text}. A network error is temporary. */
function driveFetch_(url) {
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  } catch (e) {
    throw knowledgeError_(`Drive didn't answer (${truncate_(String((e && e.message) || e), 120)}); the bot tries again in 30 minutes.`, 'temporary');
  }
  return { code: resp.getResponseCode(), text: resp.getContentText() || '' };
}

/** A Drive API error as something a person can act on. */
function driveError_(code, text, email) {
  let message = '';
  try { message = String(((JSON.parse(text) || {}).error || {}).message || ''); } catch (e) { message = ''; }
  if (code === 404) {
    return knowledgeError_(`the bot's account (${email || 'the account in "Runs as"'}) can't open it: share it with that account ` +
      '(Viewer is enough), or check the link.');
  }
  if (code === 401 || (code === 403 && /scope|insufficient authentication|not been granted|ACCESS_TOKEN_SCOPE/i.test(text))) {
    return knowledgeError_('the bot doesn\'t have the Drive permission yet: open the bot\'s Apps Script project, run ' +
      'refreshKnowledge, and click Allow.');
  }
  if (code === 429 || code >= 500) return knowledgeError_(`Drive is busy (${code}); the bot tries again in 30 minutes.`, 'temporary');
  return knowledgeError_(`Drive refused it (${code}${message ? ': ' + truncate_(message, 160) : ''}).`);
}

function driveMeta_(id, email) {
  const r = driveFetch_(driveMetaUrl_(id));
  if (r.code !== 200) throw driveError_(r.code, r.text, email);
  try {
    return JSON.parse(r.text);
  } catch (e) {
    throw knowledgeError_('Drive sent back something the bot couldn\'t read; it tries again in 30 minutes.', 'temporary');
  }
}

/** A Google Doc's or Slides' text (Drive's plain-text export). */
function driveExport_(id, email) {
  const r = driveFetch_(driveExportUrl_(id));
  if (r.code !== 200) throw driveError_(r.code, r.text, email);
  return r.text;
}

function driveDownload_(id, email) {
  const r = driveFetch_(driveDownloadUrl_(id));
  if (r.code !== 200) throw driveError_(r.code, r.text, email);
  return r.text;
}

/**
 * A Google Sheet as text: {label, text}. A link to one tab (it has #gid=…, as when it's copied from the address bar while
 * that tab is open) reads only that tab, as for the KOF spreadsheet's "[SLRR Global INFs]" tab; a link to the whole spreadsheet
 * (no #gid=, as from Share > Copy link) reads every tab. A link to a tab that's no longer there says so.
 */
function readSpreadsheet_(id, gid, email) {
  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    throw knowledgeError_(`the bot's account (${email || 'the account in "Runs as"'}) can't open it: share it with that account ` +
      `(Viewer is enough), or check the link (${truncate_(String((e && e.message) || e), 100)}).`);
  }
  const all = ss.getSheets();
  const tabs = gid ? all.filter(t => String(t.getSheetId()) === String(gid)) : all;
  if (!tabs.length) {
    throw knowledgeError_('the tab this link points to isn\'t in the spreadsheet anymore: open the tab you want and paste its ' +
      'link from the address bar, or link the whole spreadsheet (Share > Copy link) to read every tab.');
  }
  const parts = [];
  let total = 0;
  tabs.forEach(tab => {
    if (total > KNOWLEDGE_DOC_MAX_CHARS_) return;
    const rows = Math.min(tab.getLastRow(), KNOWLEDGE_SHEET_ROWS_);
    const cols = Math.min(tab.getLastColumn(), KNOWLEDGE_SHEET_COLS_);
    if (rows < 1 || cols < 1) return;
    const text = sheetToText_(tab.getName(), tab.getRange(1, 1, rows, cols).getDisplayValues());
    if (text) { parts.push(text); total += text.length + 2; }
  });
  return {
    label: gid ? `Google Sheet, tab "${tabs[0].getName()}"` : `Google Sheet (${all.length} tab${all.length === 1 ? '' : 's'})`,
    text: parts.join('\n\n'),
  };
}

/** One tab as text: "[Tab: KOFs]" then one line per row, cells joined with " | " (empty rows left out). Pure. */
function sheetToText_(name, values) {
  const rows = (values || []).map(r => (r || []).map(v => String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim()))
    .map(r => { while (r.length && !r[r.length - 1]) r.pop(); return r; })
    .filter(r => r.some(Boolean));
  return rows.length ? `[Tab: ${name}]\n${rows.map(r => r.join(' | ')).join('\n')}` : '';
}

/** A public web page's text: {label, title, text}. A page behind a sign-in can't be read. */
function readWebPage_(url) {
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    throw knowledgeError_(`the page didn't load (${truncate_(String((e && e.message) || e), 120)}); the bot tries again in 30 minutes.`, 'temporary');
  }
  const code = resp.getResponseCode();
  if (code === 401 || code === 403) {
    throw knowledgeError_(`the page needs a sign-in (${code}), so the bot can't open it: save what it says as a Google Doc and link that.`);
  }
  if (code === 404 || code === 410) throw knowledgeError_(`the page wasn't found (${code}): check the link.`);
  if (code === 429 || code >= 500) throw knowledgeError_(`the page didn't load (${code}); the bot tries again in 30 minutes.`, 'temporary');
  if (code >= 300) throw knowledgeError_(`the page didn't load (${code}).`);
  const headers = resp.getHeaders() || {};
  const type = String(headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
  const body = resp.getContentText() || '';
  if (/accounts\.google\.com\/(?:ServiceLogin|v3\/signin|signin|AccountChooser)|login\.corp\.google\.com/i.test(body)) {
    throw knowledgeError_('the page needs a sign-in, so the bot can\'t open it: save what it says as a Google Doc and link that.');
  }
  const html = /html|xml/.test(type) || (!type && /^\s*</.test(body));
  if (!html && type && !/^text\/|json|csv/.test(type)) {
    throw knowledgeError_(`the bot can't read this kind of page (${type.split(';')[0]}).`, 'permanent');
  }
  const title = html ? decodeEntities_(((body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').trim()) : '';
  return { label: 'web page', title, text: html ? htmlToText_(body) : body };
}

/** A web page's readable text: no scripts, styles or tags; paragraphs, list items and table rows on their own lines. Pure. */
function htmlToText_(html) {
  const s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n\n')
    .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|ul|ol|table|tr|h[1-6]|blockquote|pre|dd|dt|figcaption)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities_(s).split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').replace(/^\s*\|\s*/, '').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** HTML entities (&amp; &#39; &#x2014; …) as their characters. Pure. */
function decodeEntities_(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’',
    lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™' };
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = named[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The bot's storage tab: each document's text, kept between runs
// ---------------------------------------------------------------------------------------------------------------

/** Is this the storage tab the bot made? Its header row is the bot's own (a tab people made never matches). */
function isKnowledgeTab_(sh) {
  if (!sh || sh.getLastRow() < 1) return false;
  return JSON.stringify(sh.getRange(1, 1, 1, KNOWLEDGE_HEADER_.length).getValues()[0].map(v => String(v).trim())) ===
    JSON.stringify(KNOWLEDGE_HEADER_);
}

/**
 * The bot's hidden storage tab (made, protected with a warning, when missing). Rows: Link · Part (0 = about it) · Text.
 * null when a tab with its name exists that the bot didn't make: that tab is never read or written.
 */
function knowledgeTab_(ss) {
  let sh = ss.getSheetByName(KNOWLEDGE_TAB_);
  if (sh) return isKnowledgeTab_(sh) ? sh : null;
  sh = ss.insertSheet(KNOWLEDGE_TAB_);
  sh.getRange(1, 1, 1, KNOWLEDGE_HEADER_.length).setValues([KNOWLEDGE_HEADER_]);
  try { sh.protect().setDescription('Written by the Burson QA bot: the text of the Resources tab\'s documents').setWarningOnly(true); } catch (e) {}
  try { sh.hideSheet(); } catch (e) {}
  return sh;
}

/** The storage tab's documents by link: Map(url -> {meta, text}). */
function readKnowledgeTab_(sh) {
  const found = new Map();
  const last = sh.getLastRow();
  if (last < 2) return found;
  sh.getRange(2, 1, last - 1, 3).getValues().forEach(r => {
    const url = String(r[0] || '').trim();
    const part = Number(r[1]);
    if (!url || !isFinite(part) || part < 0) return;
    if (!found.has(url)) found.set(url, { meta: null, parts: [] });
    const e = found.get(url);
    if (part === 0) {
      try { e.meta = JSON.parse(String(r[2] || '')); } catch (err) { e.meta = null; }
    } else {
      e.parts[part - 1] = String(r[2] === null || r[2] === undefined ? '' : r[2]);
    }
  });
  const out = new Map();
  found.forEach((e, url) => { if (e.meta && e.meta.url === url) out.set(url, { meta: e.meta, text: e.parts.join('') }); });
  return out;
}

/**
 * Rewrites the storage tab with `entries` (Map url -> {meta, text}). Every text cell starts with ' (never a formula).
 * Refuses (throws, nothing cleared) unless the tab is the one the bot made.
 */
function writeKnowledgeTab_(sh, entries) {
  if (!isKnowledgeTab_(sh)) throw new Error(`"${sh && sh.getName()}" isn't the bot's storage tab: left as it is`);
  const values = [KNOWLEDGE_HEADER_.slice()];
  entries.forEach((e, url) => {
    values.push([url, 0, '\'' + JSON.stringify(e.meta)]);
    knowledgeCells_(e.text || '').forEach((part, i) => values.push([url, i + 1, '\'' + part]));
  });
  sh.clearContents();
  sh.getRange(1, 1, values.length, 3).setValues(values);
}

/** A text in pieces that fit a cell, never splitting a character that takes two code units (an emoji). Pure. */
function knowledgeCells_(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + KNOWLEDGE_CELL_CHARS_);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * The knowledge base for prompts: {docs: [{name, url, covers, burson, label, text}]}, the readable documents in the
 * Resources tab's order ({docs: []} without the bot's storage tab).
 */
function loadKnowledge_(ss) {
  const sh = ss.getSheetByName(KNOWLEDGE_TAB_);
  if (!isKnowledgeTab_(sh)) return { docs: [] };
  const docs = Array.from(readKnowledgeTab_(sh).values()).filter(e => e.meta.status === 'ok' && e.text)
    .sort((a, b) => (Number(a.meta.order) || 0) - (Number(b.meta.order) || 0))
    .map(e => ({ name: String(e.meta.name || e.meta.title || e.meta.url), url: e.meta.url, covers: String(e.meta.covers || ''),
      burson: !!e.meta.burson, label: String(e.meta.label || ''), text: e.text }));
  return { docs };
}

// ---------------------------------------------------------------------------------------------------------------
// Picking what Gemini reads for one alert or question
// ---------------------------------------------------------------------------------------------------------------

const KNOWLEDGE_STOP_ = new Set(('a an and are as at be but by can could did do does for from had has have he her his how i if in ' +
  'into is it its just me more most my no not of on or our out over she should so some than that the their them then there ' +
  'these they this those to too very was we were what when where which who why will with would you your about after all also ' +
  'any been being both each few here only own same such through under until up while').split(' '));

/** Lowercase words of a text, without common words. Pure. */
function knowledgeTokens_(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu) || [])
    .map(t => t.replace(/['’]s$/, '').replace(/['’]/g, '').replace(/-+$/, ''))
    .filter(t => t.length > 1 && !KNOWLEDGE_STOP_.has(t));
}

// Check outage & comms docs (Control tab row 20, only while it's ON: parsed.outageComms): a passage with one of these
// phrases, word for word, ranks higher (knowledgeScores_), so a holding statement or talking points reach Gemini. Every
// other passage scores as with the switch OFF: the alert's own words still pick what Gemini reads.
const KNOWLEDGE_COMMS_PHRASES_ = ['holding statement', 'reactive statement', 'talking points', 'known issue', 'status update'];

/**
 * The words an alert is about, for the search: {text, phrases (its own names), handles (its author)}, plus comms
 * (KNOWLEDGE_COMMS_PHRASES_) only with Check outage & comms docs ON (parsed.outageComms). Pure.
 */
function knowledgeQuery_(parsed) {
  const f = (parsed && parsed.fields) || {};
  const list = v => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v])).map(x => String(x)).filter(Boolean);
  const phrases = [].concat(list(f.product), list(f.other_products), list(f.exposure_tag), list(f.risk_tags), list(f.kof_lists),
    list(f.social_network));
  const text = [f.alert_name, f.issue_name, f.summary, f.post_content, f.engagement_level, f.priority,
    parsed && parsed.post && parsed.post.text].filter(Boolean).map(String).concat(phrases).join('\n');
  const q = { text, phrases, handles: [f.author, knowledgeHandleFromUrl_(f.post_url)].filter(Boolean).map(String) };
  if (parsed && parsed.outageComms === true) q.comms = KNOWLEDGE_COMMS_PHRASES_.slice();
  return q;
}

/** A question (about an alert, when it's asked in the alert's thread): the question's words count double. Pure. */
function knowledgeQueryFor_(question, alertRow) {
  const base = knowledgeQuery_({ fields: (alertRow && alertRow.forwarded_fields) || {} });
  const q = String(question || '');
  return { text: [q, q, base.text].join('\n'), phrases: base.phrases, handles: base.handles };
}

/** The account in a post's link (x.com/<handle>/status/…, tiktok.com/@<handle>, …), or ''. Pure. */
function knowledgeHandleFromUrl_(url) {
  const s = String(url || '');
  const m = s.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]{2,15})\/status/i) || s.match(/tiktok\.com\/@([\w.]{2,30})/i) ||
    s.match(/youtube\.com\/@([\w.-]{2,30})/i) || s.match(/instagram\.com\/([\w.]{2,30})\/(?:p|reels?)\//i) ||
    s.match(/bsky\.app\/profile\/([\w.-]{2,60})/i) || s.match(/threads\.(?:net|com)\/@([\w.]{2,30})/i);
  return m ? m[1] : '';
}

/** A long document in passages of about KNOWLEDGE_PASSAGE_CHARS_, each with the heading it falls under. Pure. */
function knowledgePassages_(text) {
  const max = KNOWLEDGE_PASSAGE_CHARS_;
  const lines = [];
  String(text || '').split('\n').forEach(l => {
    for (let i = 0; i < Math.max(1, l.length); i += max) lines.push(l.slice(i, i + max));
  });
  const out = [];
  let buf = [];
  let size = 0;
  let heading = '';
  let under = '';
  let blank = true;
  lines.forEach(line => {
    const t = line.trim();
    if (size + line.length + 1 > max && buf.length) {
      if (buf.some(l => l.trim())) out.push({ heading: under, text: buf.join('\n').trim() });
      buf = [];
      size = 0;
    }
    if (!buf.length) under = heading;
    buf.push(line);
    size += line.length + 1;
    if (/^\[Tab: .+\]$/.test(t) || (blank && t.length >= 3 && t.length <= 90 && !/[.!?,;:]$/.test(t) && t.indexOf(' | ') < 0 &&
      t.split(/\s+/).length <= 12 && /\p{L}/u.test(t))) heading = t;
    blank = !t;
  });
  if (buf.some(l => l.trim())) out.push({ heading: under, text: buf.join('\n').trim() });
  return out;
}

/**
 * How much each passage bears on the query: BM25 over the query's words (an alert's own names count extra), plus a large
 * bonus when the passage names the author (a KOF list's row), a small one per exact name (the product, the tag) and one
 * per comms phrase it has (query.comms: Check outage & comms docs ON). Pure.
 */
function knowledgeScores_(texts, query) {
  const q = query || {};
  const weights = new Map();
  const add = (text, w) => knowledgeTokens_(text).forEach(t => weights.set(t, Math.min(4, (weights.get(t) || 0) + w)));
  add(q.text, 1);
  (q.phrases || []).forEach(p => add(p, 1));
  const handles = (q.handles || []).map(h => String(h || '').replace(/^@+/, '').trim().toLowerCase()).filter(h => h.length >= 3);
  const phrases = (q.phrases || []).map(p => String(p || '').trim().toLowerCase()).filter(p => p.length >= 4);
  const comms = (q.comms || []).map(p => String(p || '').trim().toLowerCase()).filter(p => p.length >= 4);
  const docs = texts.map(t => knowledgeTokens_(t));
  const n = docs.length;
  const avg = (docs.reduce((s, d) => s + d.length, 0) / Math.max(1, n)) || 1;
  const df = new Map();
  docs.forEach(d => new Set(d).forEach(t => { if (weights.has(t)) df.set(t, (df.get(t) || 0) + 1); }));
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const handleRx = handles.map(h => new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${esc(h)}(?![\\p{L}\\p{N}_])`, 'u'));
  return texts.map((text, i) => {
    const tf = new Map();
    docs[i].forEach(t => { if (weights.has(t)) tf.set(t, (tf.get(t) || 0) + 1); });
    let s = 0;
    tf.forEach((f, t) => {
      const d = df.get(t);
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      s += weights.get(t) * idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / avg));
    });
    const low = String(text || '').toLowerCase();
    handleRx.forEach(rx => { if (rx.test(low)) s += 10; });
    phrases.forEach(p => { if (low.indexOf(p) >= 0) s += 2; });
    if (comms.length) {
      const flat = low.replace(/\s+/g, ' ');
      comms.forEach(p => { if (flat.indexOf(p) >= 0) s += 3; });
    }
    return s;
  });
}

/**
 * The documents for one alert or question, as the body of a prompt section: every document in whole when they fit
 * opts.budget characters; otherwise the short ones in whole and the passages of the long ones that bear most on
 * `query` (then each long document's opening, with the room left), in each document's own order. Every document is
 * listed, with what it covers, so Gemini knows what the knowledge base holds. opts: {budget, onlyUrls (a Set: only
 * these documents)}. Returns {text ('' with no documents), docs: [{name, url, whole, chars}]}. Pure.
 */
function knowledgeFor_(kb, query, opts) {
  const o = opts || {};
  const budget = Math.max(1000, Number(o.budget) || KNOWLEDGE_REVIEW_CHARS_);
  const docs = ((kb && kb.docs) || []).filter(d => d && d.text && (!o.onlyUrls || o.onlyUrls.has(d.url)));
  if (!docs.length) return { text: '', docs: [] };
  const sel = docs.map(d => ({ d, whole: false, passages: [] }));
  if (docs.reduce((t, d) => t + d.text.length, 0) <= budget) {
    sel.forEach(s => { s.whole = true; });
  } else {
    let left = budget;
    let shortRoom = Math.floor(budget * 0.4);
    sel.slice().sort((a, b) => a.d.text.length - b.d.text.length).forEach(s => {
      const len = s.d.text.length;
      if (len <= KNOWLEDGE_SHORT_CHARS_ && len <= shortRoom) { s.whole = true; shortRoom -= len; left -= len; }
    });
    const pool = [];
    sel.filter(s => !s.whole).forEach(s => knowledgePassages_(s.d.text).forEach((p, k) => pool.push({ s, k, p })));
    const scores = knowledgeScores_(pool.map(x => x.p.text), query);
    const take = x => {
      const cost = x.p.text.length + 60;
      if (cost > left || x.s.passages.indexOf(x) >= 0) return false;
      x.s.passages.push(x);
      left -= cost;
      return true;
    };
    pool.map((x, j) => ({ x, j, score: scores[j] })).sort((a, b) => b.score - a.score || a.j - b.j)
      .forEach(r => { if (r.score > 0) take(r.x); });
    for (let k = 0; left > 200; k++) {  // the room left: each long document's opening, in turn
      const round = pool.filter(x => x.k === k);
      if (!round.length) break;
      round.forEach(take);
    }
  }
  const listed = sel.map((s, i) => `[${i + 1}] ${s.d.name}${s.d.covers ? `: ${truncate_(s.d.covers, 300)}` : ''} ` +
    (s.whole ? '(the whole document below)' : s.passages.length ? '(the parts that bear on this, below)' : '(nothing in it bears on this)'));
  const bodies = [];
  sel.forEach((s, i) => {
    if (s.whole) { bodies.push(`=== [${i + 1}] ${s.d.name} ===\n${s.d.text}`); return; }
    if (!s.passages.length) return;
    let prev = -2;
    const parts = s.passages.slice().sort((a, b) => a.k - b.k).map(x => {
      const lead = x.k === prev + 1 ? '' : `${prev >= 0 ? '…\n' : ''}${x.p.heading && x.p.text.indexOf(x.p.heading) !== 0
        ? `(under "${truncate_(x.p.heading, 90)}")\n` : ''}`;
      prev = x.k;
      return lead + x.p.text;
    });
    bodies.push(`=== [${i + 1}] ${s.d.name} (parts) ===\n${parts.join('\n')}`);
  });
  return {
    text: `${listed.join('\n')}${bodies.length ? '\n\n' + bodies.join('\n\n') : ''}`,
    docs: sel.map(s => ({ name: s.d.name, url: s.d.url, whole: s.whole,
      chars: s.whole ? s.d.text.length : s.passages.reduce((t, x) => t + x.p.text.length, 0) })),
  };
}

/** "SLRR Collection Requirements (whole) · KOF lists (3,410 characters)": what a prompt got, for the run log. Pure. */
function knowledgeBrief_(k) {
  return ((k && k.docs) || []).map(d => `${d.name} (${d.whole ? 'whole' : d.chars ? `${fmtInt_(d.chars)} characters` : 'nothing relevant'})`)
    .join(' · ');
}

/**
 * The knowledge base's section of the alert review's instructions (Review.gs assessPrompts_), or '' without documents.
 * The documents are the reference for every call; the leads' current guidance still overrides them while it applies.
 */
function knowledgePrompt_(k) {
  if (!k || !k.text) return '';
  return '\n\nKNOWLEDGE BASE: the team\'s reference documents (the Resources tab of the bot\'s sheet). Read them the way an ' +
    'experienced analyst uses the team\'s handbook to work an alert:\n' + k.text + '\n\n' +
    'USING THE KNOWLEDGE BASE: work this alert the way these documents say. Use them for every check (exposure tag, product, ' +
    'Sensitive Topics, KOF, issue name, summary), for whether it warrants a Social Alert and the no-alert checks, for which ' +
    'teams get it, and for what Trust & Safety should see. Where a document and the playbook above disagree, follow the ' +
    'document. The CURRENT GUIDANCE FROM THE SLRR LEADS (below, when there is any) overrides both while it applies. Exact ' +
    'names (exposure tags, products, Sensitive Topics, teams) still come from the lists above. In `knowledge_used`, list ' +
    'each document you relied on, by its name as listed above, and what you used it for in a few words.';
}

/** Gemini's knowledge_used, kept to documents it was given: [{document, used_for}]. Pure. */
function knowledgeUsed_(llm, k) {
  const docs = (k && k.docs) || [];
  const out = [];
  ((llm && Array.isArray(llm.knowledge_used)) ? llm.knowledge_used : []).forEach(u => {
    const said = String((u && (u.document || u.name)) || '').trim();
    const n = (said.match(/^\[(\d+)\]/) || [])[1];
    const bare = said.replace(/^\[\d+\]\s*/, '').toLowerCase();
    const doc = docs.find(d => d.name.toLowerCase() === bare) || (n ? docs[Number(n) - 1] : null);
    if (!doc || out.some(x => x.document === doc.name)) return;
    out.push({ document: doc.name, used_for: truncate_(String((u && u.used_for) || '').trim(), 160) });
  });
  return out;
}
