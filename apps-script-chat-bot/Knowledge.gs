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
 * How the parts are picked when the documents don't all fit (knowledgeFor_, knowledgeForCtx_ for a run):
 *   always read in full   reviews and triage get these whole, first: the Resources tab's optional column "Always read
 *                         in full?" (Yes / No; a column people add, never written by the bot), else (no column, or the
 *                         cell blank) the Collection Requirements (the config's seeded document of that name)
 *   KOF lists             a long KOF list is never searched as passages: the author's rows are looked up exactly (every
 *                         tab; the part past KNOWLEDGE_DOC_MAX_CHARS_ is searched live in the sheet), and only those rows
 *                         (with their tab's header row) go in, or one line saying the author isn't on it
 *   passages              by their words (BM25) and, when the passages' vectors are ready, by meaning too (Vectors.gs
 *                         text-embedding-005, fused by reciprocal rank); anchors always bring the best passage on the
 *                         escalation thresholds and on the alert's exposure tag and Sensitive Topics. The vectors are kept
 *                         in a few packed script-cache items (refreshKnowledge_ keeps them warm); any failure falls back
 *                         to the words alone, and the run log says so
 *   knowledge_used        only documents Gemini was given text from count (knowledgeUsed_)
 *   a document that couldn't be read is listed as unavailable in each prompt and the run log, never dropped silently;
 *   Bot status says when a document or a Sheet's tab was cut
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
const KNOWLEDGE_REVIEW_CHARS_ = 80000;         // of the documents in each alert review (room for the always-read ~37K Collection
                                               // Requirements plus the passages and KOF rows that bear on the alert)
const KNOWLEDGE_ANSWER_CHARS_ = 40000;         // in each analyst answer
const KNOWLEDGE_BURSON_CHARS_ = 25000;         // in each answer to Burson (the documents Burson can see only)
const KNOWLEDGE_PASSAGE_CHARS_ = 1800;         // a long document is searched in passages about this long
const KNOWLEDGE_SHORT_CHARS_ = 8000;           // a document this short goes in whole even when they don't all fit
const KNOWLEDGE_SHEET_ROWS_ = 20000;           // per tab of a Google Sheet
const KNOWLEDGE_SHEET_COLS_ = 40;
const KNOWLEDGE_KOF_ROWS_MAX_ = 6;             // KOF rows given for one lookup (an author on a few lists)
const KNOWLEDGE_KOF_LIVE_CACHE_ = 'KB_KOF_LOOKUP1';  // one script-cache item: the live KOF lookups of the last hours
const KNOWLEDGE_KOF_LIVE_SEC_ = 6 * 3600;
const KNOWLEDGE_KOF_LIVE_MAX_CHARS_ = 90000;   // that item stays under the cache's 100 KB a value
const KNOWLEDGE_KOF_LIVE_MIN_LEFT_MS_ = 60 * 1000;  // no live KOF search with less than this left in the run
const KNOWLEDGE_RRF_K_ = 60;                   // reciprocal rank fusion: 1 / (60 + rank) from each ranking
const KNOWLEDGE_SEM_MIN_COS_ = 0.5;            // a passage this close in meaning to the query counts as found by meaning
const KNOWLEDGE_ANCHOR_MIN_COS_ = 0.6;         // ... and this close to an anchor (thresholds, a tag's definition)
const KNOWLEDGE_NEAR_DUP_COS_ = 0.97;          // a passage this close to one already given adds nothing
const KNOWLEDGE_ANCHORS_MAX_ = 6;              // anchors per search (the thresholds, then tags and Sensitive Topics)
const KNOWLEDGE_VEC_PREFIX_ = 'kbvec1:';       // the passages' vectors: packed script-cache items under their signature
const KNOWLEDGE_VEC_PER_ITEM_ = 80;            // vectors per item (~1,040 characters each: under the 100 KB value cap)
const KNOWLEDGE_VEC_SEC_ = 6 * 3600;           // the cache's maximum: refreshKnowledge_ embeds them again after that
const KNOWLEDGE_VEC_RETRY_MS_ = 30 * 60 * 1000;  // after a failed try (Vertex AI down), the next try waits this long
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
  if (webViewerCall_()) throw new Error('Not available from the dashboard');
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
  // "Always read in full?" (a column people may add, Control.gs readResourceRows_) counts only where it's filled in, so a
  // tab without it hashes as it always did
  const pinOf = r => (r.pin === true || r.pin === false ? r.pin : null);
  const hash = hashText_(JSON.stringify(rows.map(r => [r.name, r.url, r.covers, r.burson]
    .concat(pinOf(r) === null ? [] : [pinOf(r)]))));
  let state = {};
  try { state = JSON.parse(props.getProperty(KNOWLEDGE_STATE_PROP_) || '{}') || {}; } catch (e) { state = {}; }
  const fresh = !ss.getSheetByName(KNOWLEDGE_TAB_);
  const current = Number(state.reader || 1) === KNOWLEDGE_READER_;
  if (!o.force && !fresh && current && state.hash === hash && now < Number(state.next || 0)) {
    knowledgeVecKeep_(ss, state, null, o, props);  // the passages' vectors: a cache check (embedded again once it let them go)
    return state;
  }
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
        const um = Object.assign({}, updated.meta, { name: r.name, covers: r.covers, pin: pinOf(r) });
        const line = `knowledge base: ${r.name || r.url}: ${knowledgeStatusText_(um)}`;
        // a document the bot can't read, or reads only in part, is a warning (its Bot status says so too): never silent
        if (um.status === 'error' || um.truncated || um.cut || um.check_error) console.warn(line);
        else if (o.log) console.log(line);
      }
      entry = updated;
    } else if (need) {
      unfinished = true;
      if (!entry) entry = { meta: { url: r.url, status: 'waiting' }, text: '' };
    }
    const m = entry.meta;
    const pin = pinOf(r);
    if (m.name !== r.name || m.covers !== r.covers || m.burson !== r.burson || m.order !== i ||
      (m.pin === true || m.pin === false ? m.pin : null) !== pin) {
      const meta = Object.assign({}, m, { name: r.name, covers: r.covers, burson: r.burson, order: i, pin });
      if (pin === null) delete meta.pin;
      entry = { meta, text: entry.text };
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
  if (state.vec) result.vec = state.vec;
  knowledgeVecKeep_(ss, result, readable.map(knowledgeDocOf_), o, null);  // the passages' vectors, for the search by meaning
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
      meta: Object.assign({ url, status: 'ok', label: got.label, title: got.title || '', modified: got.modified || '',
        version: got.version || '', read_at: now, chars: text.length, truncated, reader: KNOWLEDGE_READER_ },
      got.cut ? { cut: got.cut } : {}),  // a Sheet's tabs left out or cut (readSpreadsheet_): Bot status says which
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

/**
 * "✓ Read Oct 20, 12:41 PM EDT · Google Doc · 23,410 characters", "✗ …": a row's Bot status. It also says what was left
 * out (the part past KNOWLEDGE_DOC_MAX_CHARS_, a Sheet's tabs or rows past the limits), that a cut KOF list is still
 * searched whole for an alert's author, and that a document is always read in full in reviews.
 */
function knowledgeStatusText_(meta) {
  if (!meta) return '';
  if (meta.status === 'ok') {
    const when = Utilities.formatDate(new Date(Number(meta.read_at) || Date.now()), GEN.timezone || 'America/New_York', 'MMM d, h:mm a z');
    return `✓ Read ${when} · ${meta.label || 'document'} · ${fmtInt_(meta.chars)} characters` +
      (meta.truncated ? ` (only the first ${fmtInt_(KNOWLEDGE_DOC_MAX_CHARS_)} are used)` : '') +
      knowledgeCutText_(meta.cut) +
      ((meta.truncated || meta.cut) && knowledgeIsKofDoc_(meta) ? ' · an alert\'s author is still looked up in the whole sheet' : '') +
      (knowledgePinned_(meta) ? ' · always read in full in reviews' : '') +
      (meta.check_error ? ` · ⚠️ couldn't check it for changes just now: ${meta.check_error}` : '');
  }
  if (meta.status === 'waiting') return '… Not read yet: the bot reads it on its next run.';
  const why = String(meta.why || 'couldn\'t read it.');
  return `✗ ${why.charAt(0).toUpperCase()}${why.slice(1)}`;
}

/** What a Sheet's read left out, for Bot status: " · 9 of 27 tabs not read (past the … limit): "A", … · only the first 20,000 rows of "C"", or ''. Pure. */
function knowledgeCutText_(cut) {
  if (!cut) return '';
  const names = list => {
    const shown = (list || []).slice(0, 5).map(n => `"${truncate_(n, 40)}"`).join(', ');
    return (list || []).length > 5 ? `${shown} and ${list.length - 5} more` : shown;
  };
  const parts = [];
  if ((cut.skipped || []).length) {
    parts.push(`${cut.skipped.length}${cut.tabs ? ` of ${cut.tabs}` : ''} tab${cut.skipped.length === 1 ? '' : 's'} not read ` +
      `(past the ${fmtInt_(KNOWLEDGE_DOC_MAX_CHARS_)}-character limit): ${names(cut.skipped)}`);
  }
  if ((cut.rows || []).length) parts.push(`only the first ${fmtInt_(KNOWLEDGE_SHEET_ROWS_)} rows of ${names(cut.rows)}`);
  if ((cut.cols || []).length) parts.push(`only the first ${KNOWLEDGE_SHEET_COLS_} columns of ${names(cut.cols)}`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/**
 * Is this document always read in full in reviews and triage? The Resources tab's "Always read in full?" when it's
 * filled in (doc.pin true / false), else the Collection Requirements: a document named so, or the config's seeded
 * document of that name (GEN.settings.resources) by its Google Doc id. Pure (reads GEN).
 */
function knowledgePinned_(doc) {
  if (!doc) return false;
  if (doc.pin === true || doc.pin === false) return doc.pin;
  const rx = /\bcollection requirements\b/i;
  if (rx.test(String(doc.name || ''))) return true;
  const id = resourceLink_(doc.url).id;
  return !!id && ((GEN.settings && GEN.settings.resources) || []).some(r => rx.test(String(r.name || '')) && resourceLink_(r.url).id === id);
}

/**
 * Is this document a KOF list (a Google Sheet named, or said to cover, KOFs; or the config's seeded KOF lists sheet)?
 * Its rows are looked up by the alert's author (knowledgeKofRows_), never searched as passages. Pure (reads GEN).
 */
function knowledgeIsKofDoc_(doc) {
  if (!doc) return false;
  const link = resourceLink_(doc.url);
  if (link.kind !== 'sheet' && !/^google sheet/i.test(String(doc.label || ''))) return false;
  const rx = /\bKOFs?\b|key opinion former/i;
  if (rx.test(`${doc.name || ''}\n${doc.covers || ''}`)) return true;
  return !!link.id && ((GEN.settings && GEN.settings.resources) || []).some(r => rx.test(String(r.name || '')) &&
    resourceLink_(r.url).id === link.id);
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
    return Object.assign(base, { label: sheet.label, text: sheet.text }, sheet.cut ? { cut: sheet.cut } : {});
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
  // what's left out, for Bot status (it used to be silent): tabs past the size limit, rows and columns past the per-tab limits
  const cut = { tabs: tabs.length, skipped: [], rows: [], cols: [] };
  const note = (list, name) => { if (list.length < 100) list.push(truncate_(String(name || ''), 60)); };
  tabs.forEach(tab => {
    if (total > KNOWLEDGE_DOC_MAX_CHARS_) { note(cut.skipped, tab.getName()); return; }
    const lastRow = tab.getLastRow();
    const lastCol = tab.getLastColumn();
    const rows = Math.min(lastRow, KNOWLEDGE_SHEET_ROWS_);
    const cols = Math.min(lastCol, KNOWLEDGE_SHEET_COLS_);
    if (rows < 1 || cols < 1) return;
    if (lastRow > KNOWLEDGE_SHEET_ROWS_) note(cut.rows, tab.getName());
    if (lastCol > KNOWLEDGE_SHEET_COLS_) note(cut.cols, tab.getName());
    const text = sheetToText_(tab.getName(), tab.getRange(1, 1, rows, cols).getDisplayValues());
    if (text) { parts.push(text); total += text.length + 2; }
  });
  return {
    label: gid ? `Google Sheet, tab "${tabs[0].getName()}"` : `Google Sheet (${all.length} tab${all.length === 1 ? '' : 's'})`,
    text: parts.join('\n\n'),
    cut: cut.skipped.length || cut.rows.length || cut.cols.length ? cut : null,
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
 * The knowledge base for prompts: {docs: [{name, url, covers, burson, label, text, pin?, truncated?, cut?}], unread:
 * [{name, url, why}]}: the readable documents in the Resources tab's order, and the ones it couldn't read (yet), so a
 * prompt and the run log can say they're missing ({docs: [], unread: []} without the bot's storage tab).
 */
function loadKnowledge_(ss) {
  const sh = ss.getSheetByName(KNOWLEDGE_TAB_);
  if (!isKnowledgeTab_(sh)) return { docs: [], unread: [] };
  const all = Array.from(readKnowledgeTab_(sh).values())
    .sort((a, b) => (Number(a.meta.order) || 0) - (Number(b.meta.order) || 0));
  const docs = all.filter(e => e.meta.status === 'ok' && e.text).map(knowledgeDocOf_);
  const unread = all.filter(e => !(e.meta.status === 'ok' && e.text)).map(e => Object.assign({
    name: String(e.meta.name || e.meta.title || e.meta.url), url: e.meta.url, why: knowledgeStatusText_(e.meta) },
  e.meta.pin === true || e.meta.pin === false ? { pin: e.meta.pin } : {}));
  return { docs, unread };
}

/** A stored document ({meta, text}) as the prompts read it (loadKnowledge_). Pure. */
function knowledgeDocOf_(e) {
  const m = e.meta || {};
  return Object.assign({ name: String(m.name || m.title || m.url), url: m.url, covers: String(m.covers || ''),
    burson: !!m.burson, label: String(m.label || ''), text: e.text },
  m.pin === true || m.pin === false ? { pin: m.pin } : {}, m.truncated ? { truncated: true } : {}, m.cut ? { cut: m.cut } : {});
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
 * The words an alert is about, for the search: {text, phrases (its own names), handles (its author), anchors (its
 * official exposure tag and Sensitive Topics: their definitions are always looked for, knowledgeAnchors_)}, plus comms
 * (KNOWLEDGE_COMMS_PHRASES_) only with Check outage & comms docs ON (parsed.outageComms). Pure.
 */
function knowledgeQuery_(parsed) {
  const f = (parsed && parsed.fields) || {};
  const list = v => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v])).map(x => String(x)).filter(Boolean);
  const phrases = [].concat(list(f.product), list(f.other_products), list(f.exposure_tag), list(f.risk_tags), list(f.kof_lists),
    list(f.social_network));
  const text = [f.alert_name, f.issue_name, f.summary, f.post_content, f.engagement_level, f.priority,
    parsed && parsed.post && parsed.post.text].filter(Boolean).map(String).concat(phrases).join('\n');
  const q = { text, phrases, handles: [f.author, knowledgeHandleFromUrl_(f.post_url)].filter(Boolean).map(String),
    anchors: knowledgeAnchorNames_(list(f.exposure_tag), list(f.risk_tags)) };
  if (parsed && parsed.outageComms === true) q.comms = KNOWLEDGE_COMMS_PHRASES_.slice();
  return q;
}

/** A question (about an alert, when it's asked in the alert's thread): the question's words count double. Pure. */
function knowledgeQueryFor_(question, alertRow) {
  const base = knowledgeQuery_({ fields: (alertRow && alertRow.forwarded_fields) || {} });
  const q = String(question || '');
  return { text: [q, q, base.text].join('\n'), phrases: base.phrases, handles: base.handles, anchors: base.anchors };
}

/**
 * Direct BigQuery's Step 1 (BigQuery.gs, every candidate in one Gemini call): the search words of up to 30 records
 * (BqPipeline.gs bqRecordView_: their issue names and texts, products, tags and authors), as a query object: a bare
 * string scored nothing (knowledgeScores_ reads query.text), so Step 1 only ever got each document's opening. Pure.
 */
function knowledgeQueryForRecords_(items) {
  const views = (items || []).filter(v => v && typeof v === 'object').slice(0, 30);
  const uniq = arr => Array.from(new Set(arr.map(s => String(s || '').trim()).filter(Boolean)));
  const rec = v => v.record || {};
  const products = uniq(views.map(v => rec(v).product || rec(v).Product || rec(v).brand || ''));
  const tagWords = uniq(views.map(v => String(rec(v).tags || '')).join(' | ').split(/\s*[|;,]\s*/));
  const tags = uniq(tagWords.map(t => { const hit = typeof lookupTag_ === 'function' ? lookupTag_(t) : null; return hit ? hit.name : ''; }));
  const words = views.map(v => [v.issue, v.text].filter(Boolean).join(' ')).filter(Boolean);
  return {
    text: words.concat(products, tagWords).join('\n'),
    phrases: products.concat(tags),
    handles: uniq(views.map(v => v.author).concat(views.map(v => knowledgeHandleFromUrl_(v.url)))),
    anchors: knowledgeAnchorNames_(tags, []),
  };
}

/** {tags, topics}: the official names of an alert's exposure tags and Sensitive Topics (renamed ones mapped). Pure. */
function knowledgeAnchorNames_(tags, topics) {
  const names = (list, look) => Array.from(new Set((list || []).map(n => {
    const hit = typeof look === 'function' ? look(n) : null;
    return hit ? hit.name : '';
  }).filter(Boolean)));
  return { tags: names(tags, typeof lookupTag_ === 'function' ? lookupTag_ : null),
    topics: names(topics, typeof lookupTopic_ === 'function' ? lookupTopic_ : null) };
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
 * per comms phrase it has (query.comms: Check outage & comms docs ON). A query given as plain text is searched by its
 * words (knowledgeQueryOf_). Pure.
 */
function knowledgeScores_(texts, query) {
  return knowledgeScoresOf_(texts, texts.map(t => knowledgeTokens_(t)), query);
}

/** knowledgeScores_ for passages already split into words (docs[i] = knowledgeTokens_(texts[i])), searched more than once. Pure. */
function knowledgeScoresOf_(texts, docs, query) {
  const q = knowledgeQueryOf_(query);
  const weights = new Map();
  const add = (text, w) => knowledgeTokens_(text).forEach(t => weights.set(t, Math.min(4, (weights.get(t) || 0) + w)));
  add(q.text, 1);
  (q.phrases || []).forEach(p => add(p, 1));
  const handles = (q.handles || []).map(h => String(h || '').replace(/^@+/, '').trim().toLowerCase()).filter(h => h.length >= 3);
  const phrases = (q.phrases || []).map(p => String(p || '').trim().toLowerCase()).filter(p => p.length >= 4);
  const comms = (q.comms || []).map(p => String(p || '').trim().toLowerCase()).filter(p => p.length >= 4);
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
 * A query as the search reads it ({text, phrases, handles, anchors, comms}): a plain string is its text (Direct
 * BigQuery's Step 1 once passed one, and scored nothing), anything else not an object is an empty query. Pure.
 */
function knowledgeQueryOf_(query) {
  if (typeof query === 'string') return { text: query, phrases: [], handles: [] };
  return query && typeof query === 'object' ? query : { text: '', phrases: [], handles: [] };
}

/**
 * Reciprocal rank fusion (k = KNOWLEDGE_RRF_K_) of the search by words (lex: BM25 scores; a passage counts above 0)
 * and by meaning (sem: cosine similarities, or null; a passage counts at semMin or above): each passage gets
 * 1 / (k + its rank) from each ranking it's in. Without sem the order is exactly the words' order. Pure.
 */
function knowledgeFuse_(lex, sem, semMin) {
  const out = (lex || []).map(() => 0);
  const rank = (scores, keep) => scores.map((s, j) => ({ s, j })).filter(x => keep(x.s)).sort((a, b) => b.s - a.s || a.j - b.j)
    .forEach((x, r) => { out[x.j] += 1 / (KNOWLEDGE_RRF_K_ + r + 1); });
  rank(lex || [], s => s > 0);
  if (sem) rank(sem, s => s >= semMin);
  return out;
}

/**
 * What every search also looks for, whatever the alert's words (knowledgeFor_ gives each one's best passage first): the
 * escalation thresholds, then the official definitions of the query's exposure tags and Sensitive Topics (worded as
 * Vectors.gs vecTaxonomy_ embeds them, so their packed vectors are shared). [{key, text}], at most
 * KNOWLEDGE_ANCHORS_MAX_. Pure (reads GEN).
 */
function knowledgeAnchors_(query) {
  const a = knowledgeQueryOf_(query).anchors || {};
  const out = [{ key: 'thresholds', text: knowledgeThresholdsAnchor_() }];
  const tax = knowledgeTaxonomyTexts_();
  (a.tags || []).forEach(n => {
    const t = tax.find(x => x.kind === 'exposure' && x.name === n);
    if (t) out.push({ key: `tag:${n}`, text: t.text });
  });
  (a.topics || []).forEach(n => {
    const t = tax.find(x => x.kind === 'sensitive' && x.name === n);
    if (t) out.push({ key: `topic:${n}`, text: t.text });
  });
  return out.slice(0, KNOWLEDGE_ANCHORS_MAX_);
}

/** The official taxonomy's texts as Vectors.gs embeds them (vecTaxonomy_), or built the same way without it. Pure. */
function knowledgeTaxonomyTexts_() {
  if (typeof vecTaxonomy_ === 'function') return vecTaxonomy_();
  const row = (kind, t) => ({ kind, name: t.name,
    text: `${t.name}. ${t.description || ''}${(t.aliases || []).length ? ` Also called: ${t.aliases.join('; ')}.` : ''}` });
  return (GEN.exposure_tags || []).map(t => row('exposure', t)).concat((GEN.sensitive_topics || []).map(t => row('sensitive', t)));
}

/**
 * The thresholds anchor: the words the documents use for their escalation-threshold rules (urgent alerts at any
 * engagement, high-engagement alerts at the config's bar, ongoing issues, exclusions). The bar comes from the config
 * (GEN.escalation_rules.high_engagement_threshold, "2K" as the documents write it), never typed here. Pure.
 */
function knowledgeThresholdsAnchor_() {
  const he = Number((GEN.escalation_rules || {}).high_engagement_threshold) || 0;
  const bar = he && he % 1000 === 0 ? `${he / 1000}K` : fmtInt_(he);
  return 'Priority and thresholds for alerting: exposure tags P0, P1 and P2. Urgent alerts are escalated at 0 engagement ' +
    'for recently reported issues: P0 issue topics, P0 KOFs and Sensitive Topics. High-engagement alerts are escalated at ' +
    `${bar}+ engagements for any non-sensitive issue; ongoing issues need ${bar}+ engagements or a KOF. Exclusions.`;
}

// ---------------------------------------------------------------------------------------------------------------
// KOF lists: the author's rows, looked up exactly (a long list is never searched as passages)
// ---------------------------------------------------------------------------------------------------------------

/** The query's authors as KOF lookups compare them: lowercase, no @, 3+ characters, at most 30. Pure. */
function knowledgeHandles_(query) {
  return Array.from(new Set((knowledgeQueryOf_(query).handles || []).map(h => String(h || '').replace(/^@+/, '').trim()
    .toLowerCase()).filter(h => h.length >= 3))).slice(0, 30);
}

/**
 * Does one cell name this handle (lowercase, no @)? The whole cell ("@handle" or "handle"), "@handle" as a word inside
 * it ("Jane Doe (@handle)"), or a profile link (x.com/handle, tiktok.com/@handle, bsky.app/profile/handle, …). Pure.
 */
function knowledgeKofCellHit_(cell, h) {
  const c = String(cell === null || cell === undefined ? '' : cell).trim().toLowerCase();
  if (!c || !h || c.indexOf(h) < 0) return false;
  if (c.replace(/^@+/, '') === h) return true;
  const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|[^\\p{L}\\p{N}_.@])@${esc}(?![\\p{L}\\p{N}_])`, 'u').test(c)) return true;
  return new RegExp('(?:^|[^a-z0-9])(?:twitter|x|instagram|tiktok|youtube|threads|facebook|linkedin|bsky|reddit)\\.[a-z.]+/' +
    `(?:@|in/|profile/|user/|u/|c/|channel/)?${esc}(?![\\p{L}\\p{N}_.-])`, 'u').test(c);
}

/** One row of a Sheet's text, at most this long in a prompt (a row with 40 long cells stays readable). */
const KNOWLEDGE_KOF_ROW_CHARS_ = 1500;

/**
 * The rows of a KOF list's text as kept ("[Tab: name]", its header row, then "a | b | c" rows: sheetToText_) that name
 * one of the handles in a cell (knowledgeKofCellHit_), each with its tab and header row: [{tab, header, row}], at most
 * KNOWLEDGE_KOF_ROWS_MAX_. Pure.
 */
function knowledgeKofRows_(text, handles) {
  const hs = (handles || []).filter(Boolean);
  if (!hs.length || !text) return [];
  const out = [];
  let tab = '';
  let header = '';
  let wantHeader = true;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length && out.length < KNOWLEDGE_KOF_ROWS_MAX_; i++) {
    const line = lines[i];
    const t = line.trim();
    const m = /^\[Tab: (.+)\]$/.exec(t);
    if (m) { tab = m[1]; header = ''; wantHeader = true; continue; }
    if (!t) continue;
    if (wantHeader) { header = line; wantHeader = false; continue; }
    const low = line.toLowerCase();
    if (!hs.some(h => low.indexOf(h) >= 0)) continue;
    const cells = line.split(' | ');
    if (hs.some(h => cells.some(c => knowledgeKofCellHit_(c, h)))) out.push({ tab, header, row: line });
  }
  return out;
}

/**
 * A long KOF list's part of a prompt: {rows, body (the rows under their tab and header row; '' with none), tag (its
 * line in the list of documents), brief (the run log's)}. live: what knowledgeKofLive_ found in the sheet itself when the
 * part kept didn't have the author ({rows, searched}). Pure.
 */
function knowledgeKofLookup_(doc, handles, live) {
  if (!handles.length) {
    return { rows: [], body: '', tag: '(a KOF list: looked up by the alert\'s author, and there is no author to look up)',
      brief: 'not looked up: no author' };
  }
  const kept = knowledgeKofRows_(doc.text, handles);
  const rows = kept.length ? kept : ((live && live.rows) || []).slice(0, KNOWLEDGE_KOF_ROWS_MAX_);
  const who = handles.length === 1 ? 'the author' : 'these authors';
  if (!rows.length) {
    const whole = !(doc.truncated || doc.cut) || !!(live && live.searched);
    return { rows: [], body: '',
      tag: whole ? `(a KOF list, looked up by the alert's author: ${who === 'the author' ? 'the author isn\'t' : 'none of them is'} on it)`
        : `(a KOF list, looked up by the alert's author in the first ${fmtInt_(doc.text.length)} characters only: not found there)`,
      brief: whole ? `looked up: ${who === 'the author' ? 'the author isn\'t' : 'no author is'} on it` : 'looked up: not in the part kept' };
  }
  const groups = [];
  rows.forEach(r => {
    let g = groups.find(x => x.tab === r.tab);
    if (!g) { g = { tab: r.tab, header: r.header, rows: [] }; groups.push(g); }
    g.rows.push(truncate_(r.row, KNOWLEDGE_KOF_ROW_CHARS_));
  });
  const body = groups.map(g => [g.tab ? `[Tab: ${g.tab}]` : '', g.header ? truncate_(g.header, KNOWLEDGE_KOF_ROW_CHARS_) : '']
    .filter(Boolean).concat(g.rows).join('\n')).join('\n\n');
  const n = rows.length;
  return { rows, body,
    tag: `(a KOF list, looked up by the alert's author: ${n} matching row${n === 1 ? '' : 's'} below, with ${groups.length === 1 ? 'its' : 'their'} tab's header row)`,
    brief: `looked up: ${n} row${n === 1 ? '' : 's'} for ${who}` };
}

/**
 * The author's rows in a KOF list's sheet itself, for a list cut short (KNOWLEDGE_DOC_MAX_CHARS_, or tabs past the
 * Sheet limits): Sheets' TextFinder over every tab (or only the linked tab), each hit checked as a whole cell
 * (knowledgeKofCellHit_), with its tab's header row. {rows, searched: 'the whole sheet'}, or null when it can't be searched
 * now (too little of the run left, or the sheet didn't open: logged). Kept for KNOWLEDGE_KOF_LIVE_SEC_ in one script-cache
 * item, so answers about the same alert don't search again.
 */
function knowledgeKofLive_(doc, handles, deadline, log) {
  const link = resourceLink_(doc && doc.url);
  if (link.kind !== 'sheet' || !link.id || !(handles || []).length) return null;
  const key = `${link.id}#${link.gid || ''}|${handles.slice().sort().join(',')}`;
  const memo = knowledgeKofLiveMemo_();
  if (memo.map[key]) return { rows: memo.map[key].rows || [], searched: 'the whole sheet' };
  if (deadline && Number(deadline) - Date.now() < KNOWLEDGE_KOF_LIVE_MIN_LEFT_MS_) return null;
  const rows = [];
  try {
    const ss = SpreadsheetApp.openById(link.id);
    const scopes = link.gid ? ss.getSheets().filter(t => String(t.getSheetId()) === String(link.gid)) : [ss];
    const headers = new Map();
    const cellsOf = (tab, r, cols) => {
      const vals = tab.getRange(r, 1, 1, cols).getDisplayValues()[0].map(v => String(v === null || v === undefined ? '' : v)
        .replace(/\s+/g, ' ').trim());
      while (vals.length && !vals[vals.length - 1]) vals.pop();
      return vals;
    };
    handles.forEach(h => scopes.forEach(scope => {
      if (rows.length >= KNOWLEDGE_KOF_ROWS_MAX_) return;
      let found = [];
      try { found = scope.createTextFinder(h).matchCase(false).findAll() || []; } catch (e) { found = []; }
      found.slice(0, 40).forEach(cell => {
        if (rows.length >= KNOWLEDGE_KOF_ROWS_MAX_) return;
        const tab = cell.getSheet();
        const r = cell.getRow();
        if (r <= 1) return;  // the header row names a column, not a KOF
        const cols = Math.max(1, Math.min(tab.getLastColumn(), KNOWLEDGE_SHEET_COLS_));
        const vals = cellsOf(tab, r, cols);
        if (!vals.some(c => knowledgeKofCellHit_(c, h))) return;
        const name = tab.getName();
        const line = vals.join(' | ');
        if (rows.some(x => x.tab === name && x.row === line)) return;
        if (!headers.has(name)) headers.set(name, cellsOf(tab, 1, cols).join(' | '));
        rows.push({ tab: name, header: truncate_(headers.get(name), KNOWLEDGE_KOF_ROW_CHARS_), row: truncate_(line, KNOWLEDGE_KOF_ROW_CHARS_) });
      });
    }));
  } catch (e) {
    log(`knowledge: couldn't search the KOF list "${doc.name}" for the author just now ` +
      `(${truncate_(String((e && e.message) || e), 120)}); only the part kept was searched`);
    return null;
  }
  knowledgeKofLiveRemember_(memo, key, rows);
  return { rows, searched: 'the whole sheet' };
}

/** The live KOF lookups kept in the script cache: {cache, map: {key: {rows, at}}}. Never throws. */
function knowledgeKofLiveMemo_() {
  const cache = knowledgeScriptCache_();
  let map = {};
  try { map = JSON.parse((cache && cache.get(KNOWLEDGE_KOF_LIVE_CACHE_)) || '{}') || {}; } catch (e) { map = {}; }
  return { cache, map: map && typeof map === 'object' ? map : {} };
}

/** Keeps one live KOF lookup (the oldest dropped to stay under KNOWLEDGE_KOF_LIVE_MAX_CHARS_). Never throws. */
function knowledgeKofLiveRemember_(memo, key, rows) {
  if (!memo.cache) return;
  memo.map[key] = { rows: rows.slice(0, KNOWLEDGE_KOF_ROWS_MAX_), at: Date.now() };
  const keys = Object.keys(memo.map).sort((a, b) => (Number(memo.map[a].at) || 0) - (Number(memo.map[b].at) || 0));
  let raw = JSON.stringify(memo.map);
  while (raw.length > KNOWLEDGE_KOF_LIVE_MAX_CHARS_ && keys.length > 1) {
    delete memo.map[keys.shift()];
    raw = JSON.stringify(memo.map);
  }
  try { memo.cache.put(KNOWLEDGE_KOF_LIVE_CACHE_, raw, KNOWLEDGE_KOF_LIVE_SEC_); } catch (e) { /* searched again next time */ }
}

function knowledgeScriptCache_() {
  try { return typeof CacheService !== 'undefined' && CacheService.getScriptCache ? CacheService.getScriptCache() : null; }
  catch (e) { return null; }
}

// ---------------------------------------------------------------------------------------------------------------
// The search by meaning: the passages' vectors (Vectors.gs text-embedding-005), packed in a few script-cache items
// ---------------------------------------------------------------------------------------------------------------

/**
 * The passages searched by meaning: every readable document's (KOF lists and repeated text left out), each passage
 * once, with the list's signature (the cache keys). No passages when the documents are small enough that no prompt ever
 * picks parts (KNOWLEDGE_BURSON_CHARS_, the smallest). {texts, sig}. Pure but for the digest.
 */
function knowledgeVecIndex_(docs) {
  const seenDoc = new Set();
  const seen = new Set();
  const texts = [];
  let chars = 0;
  (docs || []).forEach(d => {
    if (!d || !d.text || knowledgeIsKofDoc_(d) || seenDoc.has(d.text)) return;
    seenDoc.add(d.text);
    chars += d.text.length;
    knowledgePassages_(d.text).forEach(p => { if (!seen.has(p.text)) { seen.add(p.text); texts.push(p.text); } });
  });
  if (chars <= KNOWLEDGE_BURSON_CHARS_ || !texts.length) return { texts: [], sig: '' };
  return { texts, sig: knowledgeVecSig_(texts) };
}

/** A short signature of the embedding model and the passages (their packed cache items' key). */
function knowledgeVecSig_(texts) {
  const model = typeof VEC_MODEL_ !== 'undefined' ? VEC_MODEL_ : '';
  const task = typeof VEC_TASK_ !== 'undefined' ? VEC_TASK_ : '';
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `${model}|${task}|${(texts || []).join('\n\u0001')}`,
    Utilities.Charset.UTF_8);
  return d.map(b => ((b & 255) < 16 ? '0' : '') + (b & 255).toString(16)).join('').slice(0, 20);
}

function knowledgeVecKeys_(sig, n) {
  const keys = [];
  for (let i = 0; i < n; i += KNOWLEDGE_VEC_PER_ITEM_) keys.push(`${KNOWLEDGE_VEC_PREFIX_}${sig}:${keys.length}`);
  return keys;
}

/**
 * The passages' vectors in the script cache (embedded and packed when missing): {ok, n, why}. Vertex AI calls go
 * through Vectors.gs embedTexts_ (opts.deadline). Never throws.
 */
function knowledgeVecEnsure_(index, opts) {
  try {
    if (!index || !index.texts.length) return { ok: true, n: 0 };
    const cache = knowledgeScriptCache_();
    if (!cache) return { ok: false, why: 'there is no script cache' };
    const keys = knowledgeVecKeys_(index.sig, index.texts.length);
    let got = {};
    try { got = cache.getAll(keys) || {}; } catch (e) { got = {}; }
    if (keys.every(k => got[k])) return { ok: true, n: index.texts.length, cached: true };
    if (typeof embedTexts_ !== 'function' || typeof vecEncode_ !== 'function') return { ok: false, why: 'Vectors.gs is missing' };
    const vecs = embedTexts_(index.texts, opts || {});
    const missing = index.texts.filter((t, i) => !vecs[i] && (typeof vecText_ !== 'function' || vecText_(t))).length;
    if (missing) return { ok: false, why: `${missing} of ${index.texts.length} passages got no vector from Vertex AI` };
    const items = {};
    keys.forEach((k, j) => {
      items[k] = vecs.slice(j * KNOWLEDGE_VEC_PER_ITEM_, (j + 1) * KNOWLEDGE_VEC_PER_ITEM_).map(v => (v ? vecEncode_(v) : '')).join('\n');
    });
    cache.putAll(items, KNOWLEDGE_VEC_SEC_);
    return { ok: true, n: index.texts.length };
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) };
  }
}

/** The passages' vectors from the script cache: Map(passage text -> vector), or null when they're not all there. Never throws. */
function knowledgeVecRead_(index) {
  try {
    if (!index || !index.texts.length || typeof vecDecode_ !== 'function') return null;
    const cache = knowledgeScriptCache_();
    if (!cache) return null;
    const keys = knowledgeVecKeys_(index.sig, index.texts.length);
    const got = cache.getAll(keys) || {};
    if (!keys.every(k => got[k])) return null;
    const vecs = [];
    keys.forEach(k => String(got[k]).split('\n').forEach(s => vecs.push(s ? vecDecode_(s) : null)));
    if (vecs.length !== index.texts.length) return null;
    const m = new Map();
    index.texts.forEach((t, i) => { if (vecs[i]) m.set(t, vecs[i]); });
    return m.size ? m : null;
  } catch (e) {
    return null;
  }
}

/**
 * Keeps the passages' vectors warm for the reviews (refreshKnowledge_, every run): with `docs` (the documents just
 * brought up to date) their index is checked and embedded when the cache doesn't have it; without (nothing changed) only
 * a cache check, the documents read from the storage tab only once the cache let the vectors go. A failed try waits
 * KNOWLEDGE_VEC_RETRY_MS_ (logged as a warning: reviews pick passages by their words meanwhile). Writes state.vec
 * ({sig, n, ok, at | tried_at}); saves the state itself (props) when called without docs. Never throws.
 */
function knowledgeVecKeep_(ss, state, docs, o, props) {
  try {
    const prev = state.vec || null;
    const now = Date.now();
    const waiting = v => v && v.ok === false && now - Number(v.tried_at || 0) < KNOWLEDGE_VEC_RETRY_MS_;
    let list = docs;
    if (!list) {
      if (prev && (!prev.sig || waiting(prev) || knowledgeVecCached_(prev.sig, prev.n))) return;
      list = loadKnowledge_(ss).docs;
    }
    const index = knowledgeVecIndex_(list);
    let next;
    if (!index.texts.length) next = { sig: '', n: 0, ok: true, at: now };
    else if (prev && prev.sig === index.sig && waiting(prev)) next = prev;
    else {
      const got = knowledgeVecEnsure_(index, { deadline: o && o.deadline });
      next = got.ok ? { sig: index.sig, n: index.texts.length, ok: true, at: prev && prev.sig === index.sig && got.cached ? prev.at : now }
        : { sig: index.sig, n: index.texts.length, ok: false, tried_at: now };
      if (!got.ok) {
        console.warn(`knowledge base: the search by meaning isn't ready (${got.why}); reviews pick passages by their words alone ` +
          'until the next try in 30 minutes');
      } else if (!got.cached) {
        knowledgeAnchorVecs_(knowledgeAnchors_({ anchors: { tags: [], topics: [] } }), o && o.deadline);  // the thresholds anchor too
      }
    }
    const changed = JSON.stringify(prev) !== JSON.stringify(next);
    state.vec = next;
    if (!docs && changed && props) props.setProperty(KNOWLEDGE_STATE_PROP_, JSON.stringify(state));
  } catch (e) {
    console.warn(`knowledge base: couldn't keep the passages' vectors: ${(e && e.message) || e}`);
  }
}

/** Are the packed vectors of this signature (n passages) all in the script cache? Never throws. */
function knowledgeVecCached_(sig, n) {
  try {
    const cache = knowledgeScriptCache_();
    if (!cache || !sig || !(Number(n) > 0)) return false;
    const keys = knowledgeVecKeys_(sig, Number(n));
    const got = cache.getAll(keys) || {};
    return keys.every(k => got[k]);
  } catch (e) {
    return false;
  }
}

/**
 * The anchors' vectors, aligned with `anchors` (knowledgeAnchors_): the thresholds line and the official taxonomy, both
 * fixed lists packed in the script cache by Vectors.gs vecPacked_ (the taxonomy's shared with vecTagHints_). null where
 * there's none. Never throws.
 */
function knowledgeAnchorVecs_(anchors, deadline) {
  const list = anchors || [];
  if (typeof vecPacked_ !== 'function') return list.map(() => null);
  let th = null;
  let tax = [];
  let taxVecs = [];
  try { th = vecPacked_('kbanchor', [knowledgeThresholdsAnchor_()], { deadline })[0] || null; } catch (e) { th = null; }
  if (list.some(a => a.key !== 'thresholds')) {
    tax = knowledgeTaxonomyTexts_();
    try { taxVecs = vecPacked_('tax', tax.map(t => t.text), { deadline }) || []; } catch (e) { taxVecs = []; }
  }
  return list.map(a => {
    if (a.key === 'thresholds') return th;
    const i = tax.findIndex(t => t.text === a.text);
    return i >= 0 ? taxVecs[i] || null : null;
  });
}

// One run's searches share the passages' index and vectors (by knowledge base object: ctx.knowledge is read once a run)
const KNOWLEDGE_RUN_MEMO_ = typeof WeakMap === 'function' ? new WeakMap() : null;

/** The knowledge base's passage index and stored vectors, once per knowledge base object (a run). */
function knowledgeRunMemo_(kb) {
  if (!kb || typeof kb !== 'object') return { index: null, stored: undefined };
  let m = KNOWLEDGE_RUN_MEMO_ && KNOWLEDGE_RUN_MEMO_.get(kb);
  if (!m) {
    m = { index: knowledgeVecIndex_(kb.docs), stored: undefined };
    if (KNOWLEDGE_RUN_MEMO_) KNOWLEDGE_RUN_MEMO_.set(kb, m);
  }
  if (m.stored === undefined) m.stored = knowledgeVecRead_(m.index);
  return m;
}

/**
 * The search by meaning for one query: {vec: {of (passage text -> vector), query, anchors}} for knowledgeFor_, or {why}
 * when it can't run (the passages' vectors aren't in the cache yet, Vertex AI gave the query none). Never throws.
 */
function knowledgeSemantic_(kb, q, deadline) {
  try {
    if (typeof embedTexts_ !== 'function' || typeof vecCos_ !== 'function') return { why: 'Vectors.gs is missing' };
    const memo = knowledgeRunMemo_(kb);
    if (!memo.index || !memo.index.texts.length) return { why: '' };
    if (!memo.stored) {
      return { why: 'the passages\' vectors aren\'t in the cache yet (the next run embeds them), so passages were picked by ' +
        'their words alone' };
    }
    const qv = embedTexts_([String(q.text || '')], { deadline })[0];
    if (!qv) return { why: 'Vertex AI gave no vector for this search, so passages were picked by their words alone' };
    const stored = memo.stored;
    return { vec: { of: t => stored.get(t) || null, query: qv, anchors: knowledgeAnchorVecs_(knowledgeAnchors_(q), deadline) } };
  } catch (e) {
    return { why: `the search by meaning failed (${truncate_(String((e && e.message) || e), 120)}), so passages were picked by their words alone` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The documents for one prompt
// ---------------------------------------------------------------------------------------------------------------

/**
 * The documents for one alert or question, as the body of a prompt section. Every document in whole when they all fit
 * opts.budget characters (a document repeating an earlier one's text is listed, not repeated). Otherwise, in this
 * order: the documents always read in full (knowledgePinned_; only with opts.pin, which defaults to on for review-sized
 * budgets), the short ones in whole, the author's rows of a long KOF list (looked up exactly, never passages:
 * knowledgeKofLookup_), then the passages of the long ones that bear most on `query`: each anchor's best passage first
 * (the escalation thresholds, the query's exposure tags and Sensitive Topics: knowledgeAnchors_), then by the words
 * (BM25) fused with meaning when opts.vec has the passages' vectors (reciprocal rank, knowledgeFuse_), then each long
 * document's opening with the room left. Every document is listed with what it covers, and the ones that couldn't be
 * read (kb.unread) are named, so Gemini knows what the knowledge base holds and what's missing.
 * opts: {budget, onlyUrls (a Set: only these documents; Burson's answers), pin, vec ({of, query, anchors}: knowledgeSemantic_),
 * kof ({url: {rows, searched}}: knowledgeKofLive_)}. A plain-text query is read as its words (knowledgeQueryOf_).
 * Returns {text ('' with no documents), docs: [{name, url, whole, chars, same?, lookup?}], mode? ('hybrid' | 'lexical':
 * how passages were picked, when they were)}. Pure.
 */
function knowledgeFor_(kb, query, opts) {
  const o = opts || {};
  const q = knowledgeQueryOf_(query);
  const budget = Math.max(1000, Number(o.budget) || KNOWLEDGE_REVIEW_CHARS_);
  const pin = o.pin !== undefined ? !!o.pin : budget >= KNOWLEDGE_REVIEW_CHARS_;
  const docs = ((kb && kb.docs) || []).filter(d => d && d.text && (!o.onlyUrls || o.onlyUrls.has(d.url)));
  if (!docs.length) return { text: '', docs: [] };
  const sel = docs.map((d, i) => ({ d, n: i + 1, whole: false, passages: [], same: null, lookup: null }));
  const firstOf = new Map();  // two rows reading the same text (two tabs of one Google Doc): given once
  sel.forEach(s => { const f = firstOf.get(s.d.text); if (f) s.same = f; else firstOf.set(s.d.text, s); });
  const own = sel.filter(s => !s.same);
  let mode = '';
  if (own.reduce((t, s) => t + s.d.text.length, 0) <= budget) {
    own.forEach(s => { s.whole = true; });
  } else {
    let left = budget;
    if (pin) {
      own.forEach(s => {  // always read in full (reviews and triage), in the Resources tab's order, while they fit
        if (!knowledgePinned_(s.d)) return;
        const len = s.d.text.length;
        if (len <= left) { s.whole = true; left -= len; } else s.pinCut = true;
      });
    }
    let shortRoom = Math.floor(left * 0.4);
    own.filter(s => !s.whole).sort((a, b) => a.d.text.length - b.d.text.length).forEach(s => {
      const len = s.d.text.length;
      if (len <= KNOWLEDGE_SHORT_CHARS_ && len <= shortRoom) { s.whole = true; shortRoom -= len; left -= len; }
    });
    const handles = knowledgeHandles_(q);
    own.filter(s => !s.whole && knowledgeIsKofDoc_(s.d)).forEach(s => {  // a long KOF list: the author's rows only
      s.lookup = knowledgeKofLookup_(s.d, handles, o.kof && o.kof[s.d.url]);
      const cost = s.lookup.body ? s.lookup.body.length + 60 : 0;
      if (cost > left) {
        s.lookup = Object.assign({}, s.lookup, { rows: [], body: '', tag: '(a KOF list: no room left for the author\'s rows)',
          brief: 'looked up: no room left' });
      } else left -= cost;
    });
    const longDocs = own.filter(s => !s.whole && !s.lookup);
    if (longDocs.length) mode = knowledgePickPassages_(longDocs, q, left, o.vec);
  }
  const unread = o.onlyUrls ? [] : ((kb && kb.unread) || []).filter(u => u && u.name);
  const listed = sel.map(s => `[${s.n}] ${s.d.name}${s.d.covers ? `: ${truncate_(s.d.covers, 300)}` : ''} ` + (
    s.same ? `(the same text as [${s.same.n}], not repeated)`
      : s.whole ? '(the whole document below)'
        : s.lookup ? s.lookup.tag
          : s.passages.length ? (s.pinCut ? '(always read in full, but longer than this prompt holds: the parts that bear on this, below)'
            : '(the parts that bear on this, below)')
            : '(nothing in it bears on this)'));
  if (unread.length) {
    listed.push(`Not available right now (couldn't be read, so not below): ${unread.map(u => truncate_(u.name, 120)).join('; ')}`);
  }
  const bodies = [];
  sel.forEach(s => {
    if (s.same) return;
    if (s.whole) { bodies.push(`=== [${s.n}] ${s.d.name} ===\n${s.d.text}`); return; }
    if (s.lookup) { if (s.lookup.body) bodies.push(`=== [${s.n}] ${s.d.name} (the author's rows) ===\n${s.lookup.body}`); return; }
    if (!s.passages.length) return;
    let prev = -2;
    const parts = s.passages.slice().sort((a, b) => a.k - b.k).map(x => {
      const lead = x.k === prev + 1 ? '' : `${prev >= 0 ? '…\n' : ''}${x.p.heading && x.p.text.indexOf(x.p.heading) !== 0
        ? `(under "${truncate_(x.p.heading, 90)}")\n` : ''}`;
      prev = x.k;
      return lead + x.p.text;
    });
    bodies.push(`=== [${s.n}] ${s.d.name} (parts) ===\n${parts.join('\n')}`);
  });
  return Object.assign({
    text: `${listed.join('\n')}${bodies.length ? '\n\n' + bodies.join('\n\n') : ''}`,
    docs: sel.map(s => Object.assign({ name: s.d.name, url: s.d.url, whole: s.whole,
      chars: s.whole ? s.d.text.length : s.lookup ? s.lookup.body.length : s.passages.reduce((t, x) => t + x.p.text.length, 0) },
    s.same ? { same: s.same.d.name } : {}, s.lookup ? { lookup: s.lookup.brief } : {})),
  }, mode ? { mode } : {});
}

/**
 * Picks the passages of the long documents (knowledgeFor_), into each one's s.passages, within `room` characters:
 * each anchor's best passage first, then by the words fused with meaning (when vec has the passages' vectors), then each
 * document's opening with the room left; at most 12 a document when there are several; a passage repeated in two
 * documents, or (by meaning) nearly the same as one already given, once. Returns 'hybrid' or 'lexical'. Pure.
 */
function knowledgePickPassages_(longDocs, q, room, vec) {
  let left = room;
  const maxPerDoc = longDocs.length > 1 ? 12 : Infinity;
  const pool = [];
  const seen = new Set();
  longDocs.forEach(s => knowledgePassages_(s.d.text).forEach((p, k) => {
    if (seen.has(p.text)) return;
    seen.add(p.text);
    pool.push({ s, k, p, j: pool.length });
  }));
  if (!pool.length) return '';
  const texts = pool.map(x => x.p.text);
  const tokens = texts.map(t => knowledgeTokens_(t));
  const pv = vec && vec.query && typeof vec.of === 'function' ? pool.map(x => vec.of(x.p.text) || null) : null;
  const hybrid = !!(pv && pv.some(Boolean));
  const taken = [];
  const take = x => {
    const cost = x.p.text.length + 60;
    if (cost > left || x.s.passages.length >= maxPerDoc || x.s.passages.indexOf(x) >= 0) return false;
    if (hybrid && pv[x.j] && taken.some(t => pv[t.j] && vecCos_(pv[x.j], pv[t.j]) >= KNOWLEDGE_NEAR_DUP_COS_)) return false;
    x.s.passages.push(x);
    taken.push(x);
    left -= cost;
    return true;
  };
  knowledgeAnchors_(q).forEach((a, i) => {  // the thresholds, the tags' and topics' definitions: each one's best passage
    const lex = knowledgeScoresOf_(texts, tokens, { text: a.text, phrases: [], handles: [] });
    const av = hybrid && vec.anchors ? vec.anchors[i] : null;
    const fused = knowledgeFuse_(lex, av ? pv.map(v => (v ? vecCos_(av, v) : 0)) : null, KNOWLEDGE_ANCHOR_MIN_COS_);
    let best = -1;
    fused.forEach((f, j) => { if (f > 0 && (best < 0 || f > fused[best])) best = j; });
    if (best >= 0) take(pool[best]);
  });
  const lex = knowledgeScoresOf_(texts, tokens, q);
  const fused = knowledgeFuse_(lex, hybrid ? pv.map(v => (v ? vecCos_(vec.query, v) : 0)) : null, KNOWLEDGE_SEM_MIN_COS_);
  pool.map((x, j) => ({ x, j, score: fused[j] })).sort((a, b) => b.score - a.score || a.j - b.j)
    .forEach(r => { if (r.score > 0) take(r.x); });
  for (let k = 0; k < 1 && left > 200; k++) {  // the room left: at most each long document's single opening passage
    const round = pool.filter(x => x.k === k);
    if (!round.length) break;
    round.forEach(take);
  }
  return hybrid ? 'hybrid' : 'lexical';
}

/**
 * knowledgeFor_ for a run's review, triage or answer (ctx.knowledge, ctx.deadline, ctx.log), with what only a run can
 * add when the documents don't all fit: the search by meaning (the passages' vectors from the script cache, kept warm by
 * refreshKnowledge_, and one embedding call for the query) and, for one alert's author, the live search of a KOF list
 * cut short (knowledgeKofLive_). Whatever fails falls back (the words alone; the part kept), and the run log says so.
 * Reviews and triage (opts.pin on) also log the documents that couldn't be read and an always-read one that didn't fit:
 * never dropped silently. opts as knowledgeFor_'s, plus logAs (the brief goes in the run log as "knowledge (logAs): …").
 * Never throws for the vectors or the KOF sheet.
 */
function knowledgeForCtx_(ctx, query, opts) {
  const kb = (ctx && ctx.knowledge) || { docs: [] };
  const q = knowledgeQueryOf_(query);
  const o = Object.assign({}, opts || {});
  const log = t => {
    try { if (ctx && typeof ctx.log === 'function') ctx.log(t); else console.log(t); } catch (e) { /* the log never stops a review */ }
  };
  const deadline = Number((ctx && ctx.deadline) || 0) || 0;
  const budget = Math.max(1000, Number(o.budget) || KNOWLEDGE_REVIEW_CHARS_);
  const pin = o.pin !== undefined ? !!o.pin : budget >= KNOWLEDGE_REVIEW_CHARS_;
  const docs = (kb.docs || []).filter(d => d && d.text && (!o.onlyUrls || o.onlyUrls.has(d.url)));
  const over = Array.from(new Set(docs.map(d => d.text))).reduce((t, s) => t + s.length, 0) > budget;
  if (over) {
    const handles = knowledgeHandles_(q);
    if (handles.length && handles.length <= 2) {  // one alert's author (and the handle in its link), never a batch
      docs.filter(d => knowledgeIsKofDoc_(d) && (d.truncated || d.cut) && d.text.length > KNOWLEDGE_SHORT_CHARS_).forEach(d => {
        if (knowledgeKofRows_(d.text, handles).length) return;  // in the part kept
        const live = knowledgeKofLive_(d, handles, deadline, log);
        if (live) (o.kof = o.kof || {})[d.url] = live;
      });
    }
    const searched = docs.some(d => !knowledgeIsKofDoc_(d) && d.text.length > KNOWLEDGE_SHORT_CHARS_ && !(pin && knowledgePinned_(d)));
    if (searched && !o.vec) {
      const sem = knowledgeSemantic_(kb, q, deadline);
      if (sem.vec) o.vec = sem.vec;
      else if (sem.why) log(`knowledge (lexical fallback): ${sem.why}`);
    }
  }
  const k = knowledgeFor_(kb, q, o);
  if (o.logAs && k.docs.length) log(`knowledge (${o.logAs}): ${knowledgeBrief_(k)}`);
  if (pin) {
    const unread = o.onlyUrls ? [] : (kb.unread || []);
    if (unread.length) {
      log(`knowledge: not available right now, so this goes without ${unread.length === 1 ? 'it' : 'them'}: ` +
        unread.map(u => `${u.name}${knowledgePinned_(u) ? ' (always read in full)' : ''}: ${truncate_(String(u.why || ''), 160)}`).join('; '));
    }
    docs.filter(d => knowledgePinned_(d)).forEach(d => {
      const got = k.docs.find(x => x.url === d.url);
      if (got && !got.whole && !got.same) {
        log(`knowledge: "${d.name}" is always read in full, but at ${fmtInt_(d.text.length)} characters it's longer than ` +
          `this prompt holds (${fmtInt_(budget)}): only the parts that bear on this went in`);
      }
    });
  }
  return k;
}

/**
 * "SLRR Collection Requirements (whole) · KOF lists (looked up: 1 row for the author) · Playbook (3,410 characters)":
 * what a prompt got, for the run log. Pure.
 */
function knowledgeBrief_(k) {
  return ((k && k.docs) || []).map(d => `${d.name} (${d.same ? `same text as ${d.same}` : d.whole ? 'whole'
    : d.lookup ? d.lookup : d.chars ? `${fmtInt_(d.chars)} characters` : 'nothing relevant'})`)
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
    'names (exposure tags, products, Sensitive Topics, teams) still come from the lists above. A KOF list shows only the ' +
    'rows that name this alert\'s author (or says the author isn\'t on it): a row there means the author is on that list; ' +
    'otherwise the alert\'s own KOF field stands. In `knowledge_used`, list each document you relied on, by its name as ' +
    'listed above, and what you used it for in a few words: only documents with text below count, never one listed as ' +
    'having nothing that bears on this or as not available.';
}

/**
 * Gemini's knowledge_used, kept to documents it was given text from (whole, its parts or a KOF list's rows: a document
 * listed with nothing that bears on the alert doesn't count, and one repeating an earlier document's text counts as that
 * one): [{document, used_for}]. Pure.
 */
function knowledgeUsed_(llm, k) {
  const docs = (k && k.docs) || [];
  const gave = d => !!d && (d.whole === true || Number(d.chars) > 0);
  const out = [];
  ((llm && Array.isArray(llm.knowledge_used)) ? llm.knowledge_used : []).forEach(u => {
    const said = String((u && (u.document || u.name)) || '').trim();
    const n = (said.match(/^\[(\d+)\]/) || [])[1];
    const bare = said.replace(/^\[\d+\]\s*/, '').toLowerCase();
    let doc = docs.find(d => d.name.toLowerCase() === bare) || (n ? docs[Number(n) - 1] : null);
    if (doc && doc.same) doc = docs.find(d => d.name === doc.same && !d.same) || null;
    if (!gave(doc) || out.some(x => x.document === doc.name)) return;
    out.push({ document: doc.name, used_for: truncate_(String((u && u.used_for) || '').trim(), 160) });
  });
  return out;
}
