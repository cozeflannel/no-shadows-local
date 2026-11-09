// Fake Apps Script services and Google APIs for the bot tests: an in-memory Chat (spaces, messages, threads,
// reactions, custom message ids, request ids), Vertex AI (scripted Gemini answers), Sheets, script properties,
// triggers, cache and lock. loadBot() runs every .gs file in one Node vm context, like Apps Script does.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CHAT_POSTS = [];  // every message any fake Chat was asked to create: {text, markupSyntax} (checked by run_tests.js)

// ------------------------------------------------------------------------------------------------------------
// Google Chat
// ------------------------------------------------------------------------------------------------------------

class FakeChat {
  constructor(clock) {
    this.clock = clock;
    this.spaces = new Map();
    this.seq = 0;
    this.botUser = 'users/bot';
    this.requestIds = new Map();
    this.fail = null;  // (method, path, query, body) => {code, body} | null, to inject errors
    this.calls = [];
  }

  addSpace(id, displayName, opts) {
    this.spaces.set(id, { name: id, displayName, spaceType: 'SPACE', externalUserAllowed: !!(opts && opts.external), messages: [] });
  }

  /** An existing DM between the bot's account and `email` (found with spaces:findDirectMessage). */
  addDm(email, id) {
    this.spaces.set(id, { name: id, displayName: email, spaceType: 'DIRECT_MESSAGE', externalUserAllowed: false, messages: [] });
    (this.dms = this.dms || new Map()).set(('users/' + email).toLowerCase(), id);
  }

  /**
   * Someone else posts (Burson, Zapier, an analyst). opts: {thread, type, sender, displayName, email, mentions, cardsV2,
   * attachment, formattedText (what Chat's formattedText says, e.g. a "<url|Click to view post>" link the text leaves out)}.
   */
  say(space, text, opts) {
    opts = opts || {};
    const sender = { name: opts.sender || 'users/burson1', type: opts.type || 'HUMAN' };
    if (opts.displayName) sender.displayName = opts.displayName;
    if (opts.email) sender.email = opts.email;
    const msg = this._add(space, {
      text, thread: opts.thread, sender, mentions: opts.mentions, cardsV2: opts.cardsV2, attachment: opts.attachment,
    });
    if (opts.formattedText) msg.formattedText = opts.formattedText;
    return msg;
  }

  /** Someone else reacts (an analyst on the forwarded copy). displayName: who they are, in the reactions list. */
  addReaction(messageName, emoji, user, displayName) {
    this.message(messageName).reactions.push({ emoji, user: user || 'users/analyst1', displayName });
  }

  /** Who reacted with what on a message: [[user, emoji]] (every user, the bot's account included). */
  reactionsOn(messageName) {
    const m = this.message(messageName);
    return m ? m.reactions.map(r => [r.user, r.emoji.replace(/\uFE0F/g, '')]) : [];
  }

  message(name) {
    const space = this.spaces.get(name.split('/messages/')[0]);
    return space && space.messages.find(m => m.name === name);
  }

  /** Messages the bot posted in a space (created through the API, whoever the sender is). */
  botPosts(space) { return this.spaces.get(space).messages.filter(m => m.viaApi); }

  /** Emojis the bot added on a message. */
  botReactions(messageName) {
    const m = this.message(messageName);
    return m ? m.reactions.filter(r => r.user === this.botUser).map(r => r.emoji.replace(/\uFE0F/g, '')) : [];
  }

  _add(spaceId, { text, thread, sender, mentions, clientId, viaApi, cardsV2, attachment }) {
    const space = this.spaces.get(spaceId);
    if (!space) throw new Error('fake chat: no space ' + spaceId);
    this.clock.now += 1000;
    const id = 'm' + (++this.seq);
    const threadOk = thread && space.messages.some(m => m.thread.name === thread);
    const msg = {
      name: `${spaceId}/messages/${id}`, text, createTime: new Date(this.clock.now).toISOString().replace('Z', '123Z'),
      sender, thread: { name: threadOk ? thread : `${spaceId}/threads/t${this.seq}` }, threadReply: !!threadOk,
      annotations: (mentions || []).map(u => ({ type: 'USER_MENTION', userMention: { user: { name: u }, type: 'MENTION' } })),
      clientAssignedMessageId: clientId || undefined, reactions: [], viaApi: !!viaApi,
    };
    if (cardsV2) msg.cardsV2 = cardsV2;
    if (attachment) msg.attachment = attachment;
    space.messages.push(msg);
    return msg;
  }

  _public(m) {
    const counts = new Map();
    m.reactions.forEach(r => counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1));
    const out = Object.assign({}, m, {
      emojiReactionSummaries: Array.from(counts, ([unicode, n]) => ({ emoji: { unicode }, reactionCount: n })),
    });
    delete out.reactions;
    delete out.viaApi;
    if (!out.annotations.length) delete out.annotations;
    return JSON.parse(JSON.stringify(out));
  }

  handle(url, params) {
    const method = String(params.method || 'get').toLowerCase();
    // Chat's attachment upload (media.upload): multipart/related, a JSON part with the filename, then the file's bytes;
    // answers the attachmentDataRef a message then carries (uploads: what came in, for the tests)
    if (url.startsWith('https://chat.googleapis.com/upload/v1/')) {
      const [path, q] = url.replace('https://chat.googleapis.com/upload/v1/', '').split('?');
      const spaceName = path.split('/').slice(0, 2).join('/');
      this.calls.push({ method, path: 'upload/' + path, query: { raw: q || '' }, body: null });
      const injected = this.fail && this.fail(method, 'upload/' + path, {}, null);
      if (injected) return injected;
      if (!this.spaces.get(spaceName)) return err(404, 'Space not found');
      const boundary = (String(params.contentType || '').match(/^multipart\/related; boundary=(\S+)$/) || [])[1];
      if (method !== 'post' || !boundary || q !== 'uploadType=multipart' || !/\/attachments:upload$/.test(path)) {
        return err(400, 'fake chat: not a multipart upload');
      }
      const raw = Buffer.from((Array.isArray(params.payload) ? params.payload : []).map(b => b & 255)).toString('latin1');
      const parts = raw.split(`--${boundary}`);
      const metaAt = (parts[1] || '').indexOf('\r\n\r\n');
      const fileAt = (parts[2] || '').indexOf('\r\n\r\n');
      if (parts.length !== 4 || parts[3] !== '--' || metaAt < 0 || fileAt < 0) return err(400, 'fake chat: bad multipart body');
      const meta = JSON.parse(parts[1].slice(metaAt + 4));
      if (!meta.filename) return err(400, 'filename is required');
      this.uploads = this.uploads || [];
      const n = this.uploads.length + 1;
      const ref = { resourceName: `${spaceName}/attachments/a${n}`, attachmentUploadToken: `upload-token-${n}` };
      this.uploads.push({ space: spaceName, filename: meta.filename, contentType: ((parts[2].slice(0, fileAt)).match(/Content-Type: (\S+)/) || [])[1] || '',
        bytes: Buffer.from(parts[2].slice(fileAt + 4, -2), 'latin1'), ref });
      return ok({ attachmentDataRef: ref });
    }
    const [pathPart, queryPart] = url.replace('https://chat.googleapis.com/v1/', '').split('?');
    const query = {};
    (queryPart || '').split('&').filter(Boolean).forEach(kv => {
      const [k, v] = kv.split('=');
      query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    const body = params.payload ? JSON.parse(params.payload) : undefined;
    this.calls.push({ method, path: pathPart, query, body });
    const injected = this.fail && this.fail(method, pathPart, query, body);
    if (injected) return injected;
    const p = pathPart.split('/');

    if (method === 'get' && pathPart === 'spaces') {
      return ok({ spaces: Array.from(this.spaces.values()).map(s => ({ name: s.name, displayName: s.displayName, spaceType: s.spaceType, externalUserAllowed: s.externalUserAllowed })) });
    }
    if (method === 'get' && pathPart === 'spaces:findDirectMessage') {
      const dm = (this.dms || new Map()).get(String(query.name || '').toLowerCase());
      return dm ? ok({ name: dm, spaceType: 'DIRECT_MESSAGE' }) : err(404, 'Direct message not found');
    }
    const space = this.spaces.get(p[0] + '/' + p[1]);
    if (!space) return err(404, 'Space not found');
    if (method === 'get' && p.length === 2) {
      return ok({ name: space.name, displayName: space.displayName, spaceType: space.spaceType, externalUserAllowed: space.externalUserAllowed });
    }
    if (method === 'get' && p[2] === 'members') return ok({ name: `${space.name}/members/1`, member: { name: this.botUser, type: 'HUMAN' } });

    if (p[2] === 'messages' && p.length === 3 && method === 'get') {
      let list = space.messages.slice();
      const f = query.filter || '';
      const m = f.match(/create_time > "([^"]+)"/);
      const before = f.match(/create_time < "([^"]+)"/);
      const t = f.match(/thread\.name = (spaces\/[^\s"]+\/threads\/[^\s"]+)/);
      if (f && !m && !t && !before) return err(400, 'Invalid filter: ' + f);
      if (m) list = list.filter(x => Date.parse(x.createTime) > Date.parse(m[1]));
      if (before) list = list.filter(x => Date.parse(x.createTime) < Date.parse(before[1]));
      if (t) list = list.filter(x => x.thread.name === t[1]);
      if (query.orderBy && query.orderBy !== 'createTime DESC') return err(400, 'Invalid orderBy: ' + query.orderBy);
      list.sort((a, b) => Date.parse(a.createTime) - Date.parse(b.createTime));
      if (query.orderBy) list.reverse();
      const size = Math.min(1000, Number(query.pageSize || 25));
      const start = Number(query.pageToken || 0);
      const page = list.slice(start, start + size);
      const res = { messages: page.map(x => this._public(x)) };
      if (start + size < list.length) res.nextPageToken = String(start + size);
      return ok(res);
    }
    if (p[2] === 'messages' && p.length === 4 && method === 'get') {
      const found = space.messages.find(x => x.clientAssignedMessageId === p[3] || x.name.endsWith('/' + p[3]));
      // a read of a message that isn't there: Chat answers a person (user auth) 403, not 404 (seen in the bot's logs)
      return found ? ok(this._public(found))
        : err(403, 'Permission denied to perform the requested action on the specified resource, or the resource doesn\'t exist.');
    }
    if (p[2] === 'messages' && p.length === 3 && method === 'post') {
      if (query.requestId && this.requestIds.has(query.requestId)) return ok(this._public(this.message(this.requestIds.get(query.requestId))));
      if (query.messageId) {
        if (!/^client-[a-z0-9-]{1,56}$/.test(query.messageId)) return err(400, 'Invalid messageId');
        if (space.messages.some(x => x.clientAssignedMessageId === query.messageId)) return err(409, 'Message already exists');
      }
      if (body.thread && query.messageReplyOption !== 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD') return err(400, 'reply option');
      // attachments: only ones uploaded first (media.upload), as Chat shows them on the message
      const attachment = [];
      for (const a of body.attachment || []) {
        const ref = (a && a.attachmentDataRef) || {};
        const up = (this.uploads || []).find(u => u.ref.attachmentUploadToken === ref.attachmentUploadToken && u.space === space.name);
        if (!up) return err(400, 'Invalid attachment: upload it to this space first');
        attachment.push({ name: `${space.name}/messages/attachments/${up.ref.resourceName.split('/').pop()}`, contentName: up.filename,
          contentType: up.contentType, source: 'UPLOADED_CONTENT', attachmentDataRef: { resourceName: up.ref.resourceName } });
      }
      CHAT_POSTS.push({ text: String(body.text || ''), markupSyntax: body.markupSyntax || '' });
      const msg = this._add(space.name, {
        text: body.text, thread: body.thread && body.thread.name, sender: { name: this.botUser, type: 'HUMAN' }, clientId: query.messageId,
        viaApi: true, attachment: attachment.length ? attachment : undefined,
      });
      if (query.requestId) this.requestIds.set(query.requestId, msg.name);
      return ok(this._public(msg));
    }
    if (p[2] === 'messages' && p[4] === 'reactions' && p.length === 5 && method === 'get') {
      const msg = this.message(p.slice(0, 4).join('/'));
      if (!msg) return err(404, 'Message not found');
      return ok({ reactions: msg.reactions.map((r, i) => ({ name: `${msg.name}/reactions/r${i + 1}`,
        user: Object.assign({ name: r.user, type: 'HUMAN' }, r.displayName ? { displayName: r.displayName } : {}),
        emoji: { unicode: r.emoji } })) });
    }
    if (p[2] === 'messages' && p[4] === 'reactions' && method === 'post') {
      const msg = this.message(p.slice(0, 4).join('/'));
      if (!msg) return err(404, 'Message not found');
      const emoji = body.emoji.unicode;
      if (msg.reactions.some(r => r.user === this.botUser && r.emoji === emoji)) return err(409, 'Reaction already exists');
      msg.reactions.push({ emoji, user: this.botUser });
      return ok({ name: `${msg.name}/reactions/r${msg.reactions.length}`, emoji: { unicode: emoji } });
    }
    return err(400, `fake chat: unsupported ${method} ${pathPart}`);
  }
}

// ------------------------------------------------------------------------------------------------------------
// Vertex AI (Gemini)
// ------------------------------------------------------------------------------------------------------------

class FakeVertex {
  constructor() {
    this.assess = () => ({ checks: [] });          // (payload) => ASSESS_SCHEMA_ object
    this.answer = () => 'Happy to help with that.'; // (payload) => answer text
    // (payload) => the Results tab's summary text (Speed.gs); the facts are in payload.contents[0].parts[0].text
    this.synopsis = () => 'The bot reviewed the alerts Burson posted. It compared its Social Alert calls with the IMs\' calls.';
    // (payload) => Draft answers to questions (FollowUp.gs): {can_answer, confidence, answer, missing}
    this.teamAnswer = () => ({ can_answer: false, confidence: 0.2, answer: '', missing: 'Who first posted it.' });
    // (payload) => the 3-step BigQuery evaluation (BigQuery.gs evaluateBqDualTrack_ / BQ_ALERT_BATCH_SCHEMA_):
    // {solo_alerts, group_waves, discarded_ids}; the records are in payload.contents[0].parts[0].text (<records>[…]</records>).
    // null: answered like any other schema ({ok: true}), which the bot reads as no answer (the rules alone decide)
    this.bqRecords = null;
    // (payload) => the triage of an alert in another format (OtherAlerts.gs otherTriageSchema_: {summary, issue_name,
    // stream_call, slrr, …}); null: answered like any other schema ({ok: true}), which the bot reads as no call (a flag)
    this.triage = null;
    // (payload) => the open-world review of an Early Detection signal (EarlyDetection.gs edReviewSchema_:
    // {summary, issue_name, emerging_narrative, early_detection_call, temp_check_draft, slrr, …})
    this.earlyDetection = null;
    // (payload) => the temp check's lines (TempCheck.gs TC_SCHEMA_: {summary, negativity_drivers, themes}); null: answered
    // like any other schema ({ok: true}), which the bot reads as no answer (the write-up goes out without them)
    this.tempCheck = null;
    this.fail = null;                               // (payload) => {code, body} | null
    // (payload) => the web searches behind the answer (groundingMetadata: {webSearchQueries, groundingChunks}) | null
    this.grounding = null;
    this.calls = [];
  }

  handle(url, params) {
    const payload = JSON.parse(params.payload);
    this.calls.push({ url, payload });
    const injected = this.fail && this.fail(payload);
    if (injected) return injected;
    const props = (payload.generationConfig.responseSchema || {}).properties || {};
    let result;
    if (props.checks) result = this.assess(payload);
    else if (props.early_detection_call && typeof this.earlyDetection === 'function') result = this.earlyDetection(payload);  // EarlyDetection.gs
    else if (props.stream_call && typeof this.triage === 'function') result = this.triage(payload);  // OtherAlerts.gs
    else if (props.negativity_drivers && typeof this.tempCheck === 'function') result = this.tempCheck(payload);  // TempCheck.gs
    else if (props.can_answer) result = this.teamAnswer(payload);
    else if (props.answer) result = { answer: this.answer(payload) };
    else if (props.synopsis) result = { synopsis: this.synopsis(payload) };
    else if (props.group_waves && typeof this.bqRecords === 'function') result = this.bqRecords(payload);
    else result = { ok: true };
    const candidate = { content: { role: 'model', parts: [{ text: JSON.stringify(result) }] }, finishReason: 'STOP' };
    const grounding = typeof this.grounding === 'function' ? this.grounding(payload) : null;
    if (grounding) candidate.groundingMetadata = grounding;
    return ok({ candidates: [candidate] });
  }
}

// ------------------------------------------------------------------------------------------------------------
// Sheets
// ------------------------------------------------------------------------------------------------------------

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; this.protections = []; this.validations = {}; this.links = {}; }
  /** As in Sheets, two tabs can't have the same name. */
  setName(n) {
    if (this.parent && this.parent.sheets.some(s => s !== this && s.name === n)) {
      throw new Error(`A sheet with the name "${n}" already exists. Please enter another name.`);
    }
    this.name = n;
    return this;
  }
  getName() { return this.name; }
  getSheetId() { return this.sheetId === undefined ? 0 : this.sheetId; }
  hideSheet() { this.hiddenSheet = true; return this; }
  isSheetHidden() { return !!this.hiddenSheet; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((w, r) => Math.max(w, r.length), 0); }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  setFrozenColumns(n) { this.frozenCols = n; return this; }
  setColumnWidth() { return this; }
  setRowHeight(r, h) { (this.heights = this.heights || {})[r] = h; return this; }
  autoResizeRows() { return this; }
  clearContents() { this.rows = []; return this; }
  clearFormats() { this.formatsCleared = (this.formatsCleared || 0) + 1; return this; }
  hideColumns(c, n) { this.hidden = (this.hidden || []).concat(Array.from({ length: n || 1 }, (_, i) => c + i)); return this; }
  showColumns(c, n) { this.hidden = (this.hidden || []).filter(x => x < c || x >= c + (n || 1)); return this; }
  protect() {
    const p = { warningOnly: false, unprotected: [], setDescription() { return p; }, setWarningOnly(v) { p.warningOnly = v; return p; },
      setUnprotectedRanges(ranges) { p.unprotected = ranges.slice(); return p; } };
    this.protections.push(p);
    return p;
  }
  appendRow(values) { this.rows.push(values.map(store)); return this; }
  /** Test helper: the value at row r, column c (1-based). */
  cell(r, c) { const row = this.rows[r - 1] || []; return row[c - 1] === undefined ? '' : row[c - 1]; }
  getRange(r, c, nr, nc) {
    const sheet = this;
    nr = nr || 1; nc = nc || 1;
    const range = {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sheet.rows[r - 1 + i] || [];
          const vals = [];
          for (let j = 0; j < nc; j++) vals.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
          out.push(vals);
        }
        return out;
      },
      /** Rich text: the cell's text plus a link set with sheet.links['row,col'] (like a link chip). */
      getRichTextValues() {
        return range.getValues().map((vals, i) => vals.map((v, j) => {
          const url = sheet.links[`${r + i},${c + j}`] || null;
          return { getText: () => String(v), getLinkUrl: () => url };
        }));
      },
      getValue() { return range.getValues()[0][0]; },
      /** As Sheets shows them: text (a number or date shown as its digits here). */
      getDisplayValues() { return range.getValues().map(vals => vals.map(v => (v === null || v === undefined ? '' : String(v)))); },
      getDisplayValue() { return range.getDisplayValues()[0][0]; },
      setValues(values) {
        values.forEach((vals, i) => {
          const idx = r - 1 + i;
          while (sheet.rows.length <= idx) sheet.rows.push([]);
          vals.forEach((v, j) => { sheet.rows[idx][c - 1 + j] = store(v); });
        });
        return range;
      },
      setValue(v) { return range.setValues([[v]]); },
      /** Empties the range's cells (formats stay); trailing rows left empty are dropped, as getLastRow counts content. */
      clearContent() {
        for (let i = 0; i < nr; i++) {
          const row = sheet.rows[r - 1 + i];
          if (row) for (let j = 0; j < nc; j++) if (c - 1 + j < row.length) row[c - 1 + j] = '';
        }
        while (sheet.rows.length && !(sheet.rows[sheet.rows.length - 1] || []).some(v => v !== '' && v !== undefined && v !== null)) sheet.rows.pop();
        (sheet.cleared = sheet.cleared || []).push(`${r},${c},${nr},${nc}`);
        return range;
      },
      getDataValidation() { return sheet.validations[`${r},${c}`] || null; },
      setDataValidation(rule) { sheet.validations[`${r},${c}`] = rule; return range; },
      setFontWeight() { return range; },
      setFontSize() { return range; },
      setBackground() { return range; },
      // The Results tab's formatting (Speed.gs): merges are recorded as "row,col,rows,cols"; the rest change nothing here
      merge() { sheet.merges = (sheet.merges || []).concat([`${r},${c},${nr},${nc}`]); return range; },
      breakApart() {
        sheet.merges = (sheet.merges || []).filter(m => { const [mr, mc] = m.split(',').map(Number); return mr < r || mr >= r + nr || mc < c || mc >= c + nc; });
        return range;
      },
      setWrap() { return range; },
      setVerticalAlignment() { return range; },
      setHorizontalAlignment() { return range; },
      setFontColor() { return range; },
      setFontStyle() { return range; },
      setNumberFormat() { return range; },
      createTextFinder(text) {
        let whole = false;
        const finder = {
          matchEntireCell(v) { whole = v; return finder; },
          findNext() { return finder.findAll()[0] || null; },
          findAll() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const v = String(sheet.cell(r + i, c));
              if (whole ? v === String(text) : v.includes(String(text))) out.push({ getRow: () => r + i });
            }
            return out;
          },
        };
        return finder;
      },
    };
    return range;
  }
}

/** Sheets keeps a leading-apostrophe value as plain text without the apostrophe. */
function store(v) { return typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v; }

class FakeSpreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = [new FakeSheet('Sheet1')]; this.sheets[0].parent = this; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n, index) {
    if (this.getSheetByName(n)) throw new Error(`A sheet with the name "${n}" already exists. Please enter another name.`);
    const s = new FakeSheet(n);
    s.parent = this;
    if (index === undefined) this.sheets.push(s); else this.sheets.splice(index, 0, s);
    return s;
  }
}

// ------------------------------------------------------------------------------------------------------------
// Gmail
// ------------------------------------------------------------------------------------------------------------

/** The leaf parts of a MIME body ({head, body} with base64 decoded; images keep their base64), at any depth. */
function mimeParts(head, body) {
  const bMatch = String(head || '').match(/boundary="([^"]+)"/i);
  if (!bMatch) return [];
  const out = [];
  body.split('--' + bMatch[1]).slice(1, -1).forEach(chunk => {
    const c = chunk.replace(/^\r\n/, '');
    const pSep = c.indexOf('\r\n\r\n');
    if (pSep < 0) return;
    const pHead = c.slice(0, pSep);
    const pBody = c.slice(pSep + 4).replace(/\r\n$/, '');
    if (/Content-Type:\s*multipart\//i.test(pHead)) { out.push(...mimeParts(pHead, pBody)); return; }
    const b64 = /Content-Transfer-Encoding:\s*base64/i.test(pHead);
    const isText = /Content-Type:\s*text\//i.test(pHead);
    out.push({ head: pHead, body: b64 && isText ? Buffer.from(pBody.replace(/\s+/g, ''), 'base64').toString('utf8') : pBody });
  });
  return out;
}

function decodeMime(rawB64Url) {
  const mime = Buffer.from(String(rawB64Url || ''), 'base64url').toString('utf8');
  const sep = mime.indexOf('\r\n\r\n');
  const head = sep >= 0 ? mime.slice(0, sep) : mime;
  const body = sep >= 0 ? mime.slice(sep + 4) : '';
  const headers = {};
  head.replace(/\r\n[ \t]+/g, ' ').split('\r\n').forEach(line => {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  const addrList = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  const parts = mimeParts(`Content-Type: ${headers['content-type'] || ''}`, body);
  const textPart = parts.find(p => /text\/plain/i.test(p.head));
  const htmlPart = parts.find(p => /text\/html/i.test(p.head));
  const inline = parts.filter(p => /Content-ID:/i.test(p.head)).map(p => ({
    cid: (p.head.match(/Content-ID:\s*<([^>]+)>/i) || [])[1] || '',
    mime: (p.head.match(/Content-Type:\s*([^;\r\n]+)/i) || [])[1] || '',
    base64: p.body.replace(/\s+/g, ''),
  }));
  const decodeWords = s => String(s || '')
    .replace(/\?=\s+=\?UTF-8\?B\?/gi, '')
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
  return {
    mime,
    headers,
    from: decodeWords(headers.from || ''),
    to: addrList(headers.to),
    cc: addrList(headers.cc),
    bcc: addrList(headers.bcc),
    subject: decodeWords(headers.subject || ''),
    inReplyTo: headers['in-reply-to'] || '',
    references: headers.references || '',
    text: textPart ? textPart.body : body,
    html: htmlPart ? htmlPart.body : '',
    inline,
  };
}

class FakeGmail {
  constructor(clock) {
    this.clock = clock;
    this.seq = 0;
    this.drafts = new Map();   // draftId -> { id, threadId, messageId, raw }
    this.threads = new Map();  // threadId -> [{ id, threadId, labelIds, internalDate, payload: { headers } }]
    this.fail = null;          // (method, path, query, body) => {code, body} | null
    this.calls = [];
  }

  draft(id) {
    const d = this.drafts.get(id);
    if (!d) return null;
    return Object.assign({ id: d.id, threadId: d.threadId, raw: d.raw }, decodeMime(d.raw));
  }

  allDrafts() {
    return Array.from(this.drafts.keys()).map(id => this.draft(id));
  }

  /** Every message the bot sent itself (messages.send), decoded, oldest first. */
  sentMessages() {
    return (this.sent || []).slice();
  }

  /** Simulates an analyst sending a draft from Gmail. opts.drop: addresses they took off the draft before sending. */
  send(draftId, byEmail, rfcMessageId, opts) {
    const d = this.drafts.get(draftId);
    if (!d) throw new Error('fake gmail: no draft ' + draftId);
    this.clock.now += 1000;
    const parsed = decodeMime(d.raw);
    const msgId = rfcMessageId || `<sent-${d.id}@mail.test>`;
    const drop = new Set(((opts && opts.drop) || []).map(e => String(e).toLowerCase()));
    const kept = list => (list || []).filter(e => !drop.has(String(e).toLowerCase())).join(', ');
    this.drafts.delete(draftId);
    const list = this.threads.get(d.threadId) || [];
    list.push({
      id: d.messageId,
      threadId: d.threadId,
      labelIds: ['SENT'],
      internalDate: String(this.clock.now),
      payload: {
        headers: [
          { name: 'Message-ID', value: msgId },
          { name: 'From', value: parsed.from || 'Brand Social <sender@alerts.test>' },
          { name: 'Sender', value: byEmail || 'analyst@runner.test' },
          { name: 'To', value: kept(parsed.to) },
          { name: 'Cc', value: [kept(parsed.cc)].concat((opts && opts.addCc) || []).filter(Boolean).join(', ') },
        ],
      },
    });
    this.threads.set(d.threadId, list);
    return msgId;
  }

  /** Simulates someone deleting a draft directly in Gmail. */
  discard(draftId) {
    this.drafts.delete(draftId);
  }

  /**
   * Someone's reply arriving on a thread (e.g. a team answering a Social Alert). o: {from, sender, to, subject, body,
   * labels (default INBOX), at}. Its snippet is the body's first 200 characters, HTML-escaped as Gmail sends it; the
   * whole body is read with messages.get format=full.
   */
  reply(threadId, o) {
    o = o || {};
    this.clock.now += 1000;
    const id = 'rp' + (this.replySeq = (this.replySeq || 0) + 1);
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const headers = [{ name: 'Message-ID', value: `<${id}@mail.test>` }, { name: 'From', value: o.from || 'Someone <someone@alerts.test>' },
      { name: 'To', value: o.to || 'sender@alerts.test' }, { name: 'Subject', value: o.subject || 'Re: SOCIAL ALERT' }];
    if (o.sender) headers.push({ name: 'Sender', value: o.sender });
    const list = this.threads.get(threadId) || [];
    list.push({ id, threadId, labelIds: o.labels || ['INBOX'], internalDate: String(o.at || this.clock.now),
      snippet: esc(String(o.body || '').slice(0, 200)), payload: { headers }, body: String(o.body || '') });
    this.threads.set(threadId, list);
    return id;
  }

  /** An email arriving in the mailbox (e.g. the T&S "WD Intake Request" confirmation, or a lead's guidance email). */
  receive(subject, body, from) {
    const id = 'in' + (++this.seq);
    (this.inbox = this.inbox || []).push({ id, subject: String(subject || ''), body: String(body || ''),
      from: String(from || 'Someone <someone@alerts.test>'), at: this.clock.now });
    return id;
  }

  /** Gmail search, simplified: every subject:"…" must be in the subject, every other "…" in the subject or body, and
   *  from:(a OR b) must match the sender's address. */
  _matches(msg, q) {
    const subjects = Array.from(String(q).matchAll(/subject:"([^"]+)"/gi)).map(m => m[1].toLowerCase());
    const phrases = Array.from(String(q).replace(/subject:"[^"]+"/gi, '').matchAll(/"([^"]+)"/g)).map(m => m[1].toLowerCase());
    const fromList = (String(q).match(/from:\(([^)]*)\)/i) || [])[1];
    const senders = fromList ? fromList.split(/\s+OR\s+/i).map(s => s.trim().toLowerCase()).filter(Boolean) : null;
    const subject = msg.subject.toLowerCase();
    const all = `${subject}\n${msg.body.toLowerCase()}`;
    return subjects.every(s => subject.includes(s)) && phrases.every(p => all.includes(p)) &&
      (!senders || senders.some(s => String(msg.from || '').toLowerCase().includes(s)));
  }

  /** Every SENT message on a thread (the bot's sends and the drafts people sent), for an in:sent search. */
  _sentList() {
    const out = [];
    this.threads.forEach(list => list.filter(m => (m.labelIds || []).includes('SENT')).forEach(m => {
      const headers = (m.payload && m.payload.headers) || [];
      const h = name => (headers.find(x => String(x.name).toLowerCase() === name) || {}).value || '';
      out.push({ id: m.id, threadId: m.threadId, at: Number(m.internalDate) || 0, subject: h('subject'), body: '', from: h('from'),
        headers });
    }));
    return out;
  }

  handle(url, params) {
    const method = String(params.method || 'get').toLowerCase();
    const [pathPart, queryPart] = url.replace('https://gmail.googleapis.com/gmail/v1/users/me/', '').split('?');
    const query = {};
    (queryPart || '').split('&').filter(Boolean).forEach(kv => {
      const [k, v] = kv.split('=');
      query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    const body = params.payload ? JSON.parse(params.payload) : undefined;
    this.calls.push({ method, path: pathPart, query, body });
    const injected = this.fail && this.fail(method, pathPart, query, body);
    if (injected) return injected;
    const p = pathPart.split('/');

    if (p[0] === 'drafts' && p.length === 1 && method === 'post') {
      const n = ++this.seq;
      const id = 'd' + n;
      const msg = (body && body.message) || {};
      const threadId = msg.threadId || ('th' + n);
      const messageId = 'gm' + n;
      this.drafts.set(id, { id, threadId, messageId, raw: msg.raw || '' });
      if (!this.threads.has(threadId)) this.threads.set(threadId, []);
      return ok({ id, message: { id: messageId, threadId } });
    }
    if (p[0] === 'drafts' && p.length === 2 && method === 'get') {
      const d = this.drafts.get(p[1]);
      if (!d) return err(404, 'Draft not found');
      const msg = { id: d.messageId, threadId: d.threadId };
      if (query.format === 'raw') msg.raw = d.raw;
      return ok({ id: d.id, message: msg });
    }
    if (p[0] === 'drafts' && p.length === 2 && method === 'put') {
      const d = this.drafts.get(p[1]);
      if (!d) return err(404, 'Draft not found');
      const msg = (body && body.message) || {};
      if (msg.raw) d.raw = msg.raw;
      if (msg.threadId) d.threadId = msg.threadId;
      return ok({ id: d.id, message: { id: d.messageId, threadId: d.threadId } });
    }
    if (p[0] === 'drafts' && p.length === 2 && method === 'delete') {
      if (!this.drafts.has(p[1])) return err(404, 'Draft not found');
      this.drafts.delete(p[1]);
      return ok({});
    }
    if (p[0] === 'threads' && p.length === 2 && method === 'get') {
      if (!this.threads.has(p[1])) return err(404, 'Thread not found');
      return ok({ id: p[1], messages: this.threads.get(p[1]) });
    }
    if (p[0] === 'messages' && p[1] === 'send' && method === 'post') {  // the bot sending (testing: to the stand-in)
      const n = ++this.seq;
      const threadId = (body && body.threadId) || ('th' + n);
      const id = 'gm' + n;
      const parsed = decodeMime((body && body.raw) || '');
      const list = this.threads.get(threadId) || [];
      list.push({
        id, threadId, labelIds: ['SENT'], internalDate: String(this.clock.now),
        payload: { headers: [
          { name: 'Message-ID', value: `<sent-${id}@mail.test>` }, { name: 'From', value: parsed.from || '' },
          { name: 'To', value: (parsed.to || []).join(', ') }, { name: 'Cc', value: (parsed.cc || []).join(', ') },
          { name: 'Subject', value: parsed.subject || '' },
        ] },
      });
      this.threads.set(threadId, list);
      (this.sent = this.sent || []).push(Object.assign({ id, threadId, messageId: `<sent-${id}@mail.test>` }, parsed));
      return ok({ id, threadId, labelIds: ['SENT'] });
    }
    if (p[0] === 'messages' && p.length === 1 && method === 'get' && /\bin:sent\b/i.test(query.q || '')) {  // Sent, newest first
      const after = Number((String(query.q).match(/\bafter:(\d+)\b/) || [])[1] || 0) * 1000;
      const before = Number((String(query.q).match(/\bbefore:(\d+)\b/) || [])[1] || 0) * 1000 || Infinity;
      const hits = this._sentList().filter(m => m.at >= after && m.at < before && this._matches(m, query.q))
        .sort((a, b) => b.at - a.at).slice(0, Number(query.maxResults) || 5);
      return ok(hits.length ? { messages: hits.map(m => ({ id: m.id, threadId: m.threadId })) } : {});
    }
    if (p[0] === 'messages' && p.length === 1 && method === 'get') {
      const hits = (this.inbox || []).filter(m => this._matches(m, query.q || '')).slice(0, Number(query.maxResults) || 5);
      return ok(hits.length ? { messages: hits.map(m => ({ id: m.id })) } : {});
    }
    if (p[0] === 'messages' && p.length === 2 && method === 'get' && query.format === 'full') {  // a message's whole text
      let found = null;
      this.threads.forEach(list => { found = found || list.find(m => m.id === p[1]) || null; });
      if (!found) return err(404, 'Message not found');
      return ok({ id: found.id, threadId: found.threadId, internalDate: found.internalDate, snippet: found.snippet || '',
        payload: { mimeType: 'text/plain', headers: (found.payload && found.payload.headers) || [],
          body: { data: Buffer.from(String(found.body || ''), 'utf8').toString('base64url') } } });
    }
    if (p[0] === 'messages' && p.length === 2 && method === 'get' && !(this.inbox || []).some(x => x.id === p[1])) {
      const s = this._sentList().find(x => x.id === p[1]);  // a sent message (on a thread)
      if (!s) return err(404, 'Message not found');
      return ok({ id: s.id, threadId: s.threadId, internalDate: String(s.at), snippet: '', payload: { headers: s.headers } });
    }
    if (p[0] === 'messages' && p.length === 2 && method === 'get') {
      const m = (this.inbox || []).find(x => x.id === p[1]);
      if (!m) return err(404, 'Message not found');
      return ok({ id: m.id, internalDate: String(m.at || 0), snippet: m.body.slice(0, 200).replace(/'/g, '&#39;'),
        payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] } });
    }
    return err(400, `fake gmail: unsupported ${method} ${pathPart}`);
  }
}

// ------------------------------------------------------------------------------------------------------------
// Apps Script services
// ------------------------------------------------------------------------------------------------------------

function ok(body) { return { code: 200, body }; }
function err(code, message) { return { code, body: { error: { code, message } } }; }

/**
 * A Blob as HTTPResponse.getBlob() gives one: its bytes stay a Buffer (a real Blob keeps them outside the script, which
 * is why the bot passes it on as it is). getBytes() is the script-side copy the bot avoids for big files.
 */
function fakeBlob(buf, type) {
  let contentType = type || 'application/octet-stream';
  return {
    isFakeBlob: true,
    bytes: buf,
    getContentType: () => contentType,
    setContentType(t) { contentType = String(t); return this; },
    getBytes: () => Array.from(buf),
    getDataAsString: () => buf.toString('utf8'),
  };
}

/** Utilities.formatDate for the two patterns the bot uses. */
function formatDate(date, tz, pattern) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric',
    minute: '2-digit', hour12: true, timeZoneName: 'short' }).formatToParts(date).forEach(p => { parts[p.type] = p.value; });
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  if (pattern === 'yyyy-MM-dd') return iso;
  if (pattern === 'yyyy-MM-dd HH:mm') {
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    return `${iso} ${hm}`;
  }
  if (pattern === 'MMM d, h:mm a z') return `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
  if (pattern === 'MMM d, h:mm a') return `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  if (pattern === 'h:mm a') return `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  throw new Error('fake formatDate: unsupported pattern ' + pattern);
}

function makeUtilities() {
  return {
    sleep: () => {},
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
    formatDate: (date, tz, pattern) => formatDate(date, tz, pattern),
    base64Encode: s => (Array.isArray(s) ? Buffer.from(s.map(b => b & 255)) : Buffer.from(String(s), 'utf8')).toString('base64'),
    base64Decode: s => Array.from(Buffer.from(String(s), 'base64')),
    base64EncodeWebSafe: s => Buffer.from(String(s), 'utf8').toString('base64url'),
    base64DecodeWebSafe: s => Array.from(Buffer.from(String(s), 'base64url')),
    newBlob: bytes => ({
      getDataAsString: () => Buffer.from(Uint8Array.from(bytes)).toString('utf8'),
    }),
  };
}

/**
 * A form made with FormApp (the T&S test copy): items, and pre-filled links like Google's (`?usp=pp_url&entry.N=…`, +
 * for spaces). A choice question refuses an answer that isn't one of its choices, as FormApp does. submit() records the
 * answers in `responses` ({title: value}); `failSubmit` (a message) makes it throw instead.
 */
const ITEM_TYPES = { list: 'LIST', choice: 'MULTIPLE_CHOICE', text: 'TEXT', paragraph: 'PARAGRAPH_TEXT' };

class FakeForm {
  constructor(id, title) {
    Object.assign(this, { id, title, description: '', items: [], requireLogin: false, published: false, accepting: true, seq: 0,
      responses: [], failSubmit: null });
  }
  getId() { return this.id; }
  getTitle() { return this.title; }
  getEditUrl() { return `https://docs.google.com/forms/d/${this.id}/edit`; }
  getPublishedUrl() { return `https://docs.google.com/forms/d/e/pub-${this.id}/viewform`; }
  setDescription(d) { this.description = d; return this; }
  setRequireLogin(b) { this.requireLogin = !!b; return this; }
  setPublished(b) { this.published = !!b; return this; }
  setAcceptingResponses(b) { this.accepting = !!b; return this; }
  getItems() { return this.items.slice(); }
  deleteItem(item) { this.items = this.items.filter(x => x !== item); }
  addListItem() { return this._item('list'); }
  addMultipleChoiceItem() { return this._item('choice'); }
  addTextItem() { return this._item('text'); }
  addParagraphTextItem() { return this._item('paragraph'); }
  _item(type) {
    const item = {
      type, title: '', choices: null, required: false, entry: `entry.${880000 + (++this.seq) * 7}`,
      setTitle(t) { this.title = t; return this; },
      getTitle() { return this.title; },
      setChoiceValues(c) { this.choices = c.slice(); return this; },
      setRequired(r) { this.required = !!r; return this; },
      getType() { return ITEM_TYPES[this.type]; },
      asListItem() { return this._as('list'); },
      asMultipleChoiceItem() { return this._as('choice'); },
      asTextItem() { return this._as('text'); },
      asParagraphTextItem() { return this._as('paragraph'); },
      _as(t) { if (this.type !== t) throw new Error(`Item can't be cast to ${ITEM_TYPES[t]}`); return this; },
      createResponse(v) {
        if (this.choices && !this.choices.includes(v)) throw new Error(`Invalid response submitted to item: ${v}`);
        return { item: this, value: String(v) };
      },
    };
    this.items.push(item);
    return item;
  }
  createResponse() {
    const form = this;
    const answers = [];
    return {
      withItemResponse(r) { answers.push(r); return this; },
      toPrefilledUrl: () => `${form.getPublishedUrl()}?usp=pp_url&` +
        answers.map(a => `${a.item.entry}=${encodeURIComponent(a.value).replace(/%20/g, '+')}`).join('&'),
      submit() {
        if (form.failSubmit) throw new Error(form.failSubmit);
        const missing = form.items.filter(it => it.required && !answers.some(a => a.item === it));
        if (missing.length) throw new Error(`Required questions unanswered: ${missing.map(it => it.title).join(', ')}`);
        const got = {};
        answers.forEach(a => { got[a.item.title] = a.value; });
        form.responses.push(got);
        return { getId: () => `resp${form.responses.length}` };
      },
    };
  }
}

function makeGoogle(startMs) {
  const clock = { now: startMs || Date.UTC(2026, 9, 14, 12, 0) };
  const chat = new FakeChat(clock);
  const vertex = new FakeVertex();
  const gmail = new FakeGmail(clock);
  const props = new Map();
  const cache = new Map();
  const triggers = [];
  const spreadsheets = new Map();
  const pages = new Map();
  const fetches = [];
  const logs = [];
  const forms = new Map();  // FormApp forms by id; forms.fail = 'message' makes FormApp.create throw
  forms.calls = [];         // every FormApp.create / openById: [method, title or id]
  const charts = { built: [], fail: null };  // Charts.newLineChart().build() specs; charts.fail throws

  const services = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    UrlFetchApp: {
      fetch(url, params) {
        const payload = params && params.payload;
        // what the body was: a Blob (getBlob(): its bytes never in the script), bytes (an array), or text
        const payloadKind = payload === undefined ? '' : payload && payload.isFakeBlob ? 'blob' : Array.isArray(payload) ? 'bytes' : typeof payload;
        fetches.push({ url, method: String((params && params.method) || 'get').toLowerCase(), headers: (params && params.headers) || {},
          payloadKind, contentType: (params && params.contentType) || '' });
        const page = pages.get(url);
        // Cloud Storage: an upload answers with the object's resource, its size (a string, as the JSON API gives it) the
        // body's; a delete answers 200 too
        const storage = () => {
          if (!/\/upload\/storage\/v1\//.test(url)) return ok({ kind: 'storage#object' });
          const size = payload && payload.isFakeBlob ? payload.bytes.length : Array.isArray(payload) ? payload.length
            : Buffer.byteLength(String(payload || ''), 'utf8');
          const name = decodeURIComponent((url.match(/[?&]name=([^&]+)/) || [])[1] || '');
          return ok({ kind: 'storage#object', name, size: String(size), contentType: (params && params.contentType) || '' });
        };
        const r = url.startsWith('https://chat.googleapis.com/') ? chat.handle(url, params || {})
          : url.startsWith('https://gmail.googleapis.com/') ? gmail.handle(url, params || {})
          : url.includes('aiplatform.googleapis.com/') ? vertex.handle(url, params || {})
          : url.startsWith('https://storage.googleapis.com/') ? storage()  // Cloud Storage upload / delete
          : page && typeof page === 'object' ? { code: page.code || 200, body: page.bytes || page.body || '', headers: page.headers || {} }
          : page !== undefined ? { code: 200, body: page, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          : err(404, 'unknown host ' + url);
        const bin = Buffer.isBuffer(r.body);
        const text = bin ? r.body.toString('latin1') : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        const headers = r.headers || {};
        return {
          getResponseCode: () => r.code, getContentText: () => text, getHeaders: () => headers,
          getContent: () => Array.from(bin ? r.body : Buffer.from(text, 'utf8')),
          getBlob: () => fakeBlob(bin ? r.body : Buffer.from(text, 'utf8'), String(headers['Content-Type'] || headers['content-type'] || '')),
        };
      },
      // the requests one by one through fetch (a test that replaces fetch answers these too), in order
      fetchAll(requests) {
        return (requests || []).map(r => services.UrlFetchApp.fetch(typeof r === 'string' ? r : r.url, typeof r === 'string' ? {} : r));
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty(k, v) { props.set(k, String(v)); return this; },
        deleteProperty(k) { props.delete(k); return this; },
        getKeys: () => Array.from(props.keys()),
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, String(v)),
        getAll: keys => Object.fromEntries((keys || []).filter(k => cache.has(k)).map(k => [k, cache.get(k)])),
        putAll: values => Object.entries(values || {}).forEach(([k, v]) => cache.set(k, String(v))),
        remove: k => cache.delete(k),
        removeAll: keys => (keys || []).forEach(k => cache.delete(k)),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'bot@runner.test' }) },
    ScriptApp: {
      getOAuthToken: () => 'TOKEN',
      getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t.handler, getTriggerSourceId: () => t.source || null, _t: t })),
      deleteTrigger: t => { const i = triggers.indexOf(t._t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: handler => ({
        timeBased: () => ({ everyMinutes: n => ({ create: () => triggers.push({ handler, minutes: n }) }) }),
        forForm: form => ({ onFormSubmit: () => ({ create: () => triggers.push({ handler, source: form.getId(), event: 'formSubmit' }) }) }),
      }),
    },
    FormApp: {
      ItemType: { LIST: 'LIST', MULTIPLE_CHOICE: 'MULTIPLE_CHOICE', TEXT: 'TEXT', PARAGRAPH_TEXT: 'PARAGRAPH_TEXT',
        DATE: 'DATE' },
      create(title) {
        forms.calls.push(['create', title]);
        if (forms.fail) throw new Error(forms.fail);
        const f = new FakeForm('form' + (forms.size + 1), title);
        forms.set(f.id, f);
        return f;
      },
      openById(id) {
        forms.calls.push(['openById', id]);
        if (!forms.has(id)) throw new Error('No item with the given ID could be found.');
        return forms.get(id);
      },
    },
    Charts: {
      ColumnType: { STRING: 'STRING', NUMBER: 'NUMBER', DATE: 'DATE' },
      Position: { NONE: 'NONE', BOTTOM: 'BOTTOM', TOP: 'TOP', RIGHT: 'RIGHT' },
      newTextStyle() {
        const st = {};
        return {
          setColor(c) { st.color = String(c); return this; },
          setFontSize(n) { st.fontSize = Number(n); return this; },
          setBold(b) { st.bold = !!b; return this; },
          setFontName(f) { st.fontName = String(f); return this; },
          build() { return Object.assign({}, st); },
        };
      },
      newDataTable() {
        const cols = [];
        const rows = [];
        return {
          addColumn(type, label) { cols.push({ type, label }); return this; },
          addRow(r) { rows.push(Array.isArray(r) ? r.slice() : []); return this; },
          build() { return { cols: cols.slice(), rows: rows.slice() }; },
        };
      },
      newLineChart() {
        const spec = { options: {} };
        return {
          setDataTable(t) { spec.dataTable = t; return this; },
          setDimensions(w, h) { spec.width = Number(w); spec.height = Number(h); return this; },
          setTitle(t) { spec.title = String(t); return this; },
          setTitleTextStyle(s) { spec.titleTextStyle = s; return this; },
          setLegendPosition(p) { spec.legendPosition = p; return this; },
          setColors(c) { spec.colors = Array.isArray(c) ? c.slice() : []; return this; },
          setBackgroundColor(c) { spec.backgroundColor = String(c); return this; },
          setOption(k, v) { spec.options[String(k)] = v; return this; },
          build() {
            if (charts.fail) throw new Error(charts.fail);
            const built = Object.assign({}, spec, { options: Object.assign({}, spec.options) });
            charts.built.push(built);
            const buf = Buffer.from(`PNG:${built.width}x${built.height}:${built.title || ''}`, 'utf8');
            return {
              getAs: mime => fakeBlob(buf, mime || 'image/png'),
              getBlob: () => fakeBlob(buf, 'image/png'),
            };
          },
        };
      },
    },
    Utilities: makeUtilities(),
    SpreadsheetApp: {
      create(name) { const ss = new FakeSpreadsheet('sheet' + (spreadsheets.size + 1), name); spreadsheets.set(ss.id, ss); return ss; },
      openById(id) { if (!spreadsheets.has(id)) throw new Error('not found'); return spreadsheets.get(id); },
      newDataValidation() {
        const rule = {
          values: null,
          allowInvalid: false,
          requireValueInList(v) { rule.values = v; return rule; },
          setAllowInvalid(v) { rule.allowInvalid = !!v; return rule; },
          getAllowInvalid() { return !!rule.allowInvalid; },
          getCriteriaValues() { return [rule.values]; },
          build() { return rule; },
        };
        return rule;
      },
    },
  };
  return { clock, chat, vertex, gmail, props, cache, triggers, spreadsheets, pages, fetches, logs, forms, charts, services };
}

function seedSyntheticDistribution(sandbox) {
  const gen = vm.runInContext('GEN', sandbox);
  Object.assign(gen.people, {
    'lead1@alerts.test': 'Kelsey Lange',
    'lead2@alerts.test': 'Jon Silver',
  });
  const channels = vm.runInContext('GEN_CHANNEL_OWNERS', sandbox);
  channels.push(
    { account_url: 'https://x.com/madebygoogle', handle: '@MadebyGoogle', owners: ['madebygoogle-owner@alerts.test'],
      region: 'Global', account_name: 'Made By Google', platform: 'X', team_brand: 'Marketing (Home & Mobile)' },
    { account_url: 'https://www.instagram.com/madebygoogle', handle: '@MadebyGoogle', owners: ['madebygoogle-owner@alerts.test'],
      region: 'Global', account_name: 'Made By Google', platform: 'Instagram', team_brand: 'Marketing (Home & Mobile)' },
    { account_url: 'https://www.youtube.com/channel/UCIG1k8umaCIIrujZPzZPIMA', handle: '@madebygoogle', owners: ['madebygoogle-owner@alerts.test'],
      region: 'Global', account_name: 'Made by Google', platform: 'YouTube', team_brand: 'Marketing (Home & Mobile)' }
  );
  const gupProducts = {
    'AI Overviews': ['ai-overviews-gup@alerts.test'],
    'Android (Android OS & Google TV)': ['android-gup@alerts.test'],
    'Assistant/Home': ['assistant-home-gup@alerts.test'],
    Fitbit: ['fitbit-gup@alerts.test'],
    'Gemini App': ['gemini-app-gup@alerts.test'],
    'Nano Banana': ['nano-banana-gup@alerts.test'],
    'Google Health': ['google-health-gup@alerts.test'],
    Pixel: ['pixel-gup@alerts.test'],
    Veo: ['veo-gup@alerts.test'],
    Workspace: ['workspace-gup@alerts.test'],
  };
  (gen.distribution.products || []).forEach(p => {
    if (gupProducts[p.name]) p.gup = gupProducts[p.name].slice();
    if (p.name === 'AI Overviews') {
      p.conditional = [{ label: 'High-engaging posts (2K+)', min_engagement: 2000, recipients: ['ai-overviews-high@alerts.test'] }];
    } else if (p.name === 'Search' || p.name === 'Search Images' || p.name === 'Search Knowledge Panel') {
      p.conditional = [{ label: 'Alerts with 50K+ engagements', min_engagement: 50000, recipients: ['search-50k@alerts.test'] }];
    }
    if (p.name === 'Gemini App') {
      p.execs = ['gemini-app-execs@alerts.test'];
      p.execs_rule = 'suggest';
    }
  });
  (gen.distribution.regional_leads || []).forEach(rl => {
    if (rl.region === 'Asia Pacific') rl.reputational_risk_recipients = ['apac-leads@alerts.test', 'apac-risk@alerts.test'];
    if (rl.region === 'Japan') rl.reputational_risk_recipients = ['japan-leads@alerts.test', 'apac-risk@alerts.test'];
  });
  const syntheticRows = [
    ['Brand Social Sender', ['sender@alerts.test']],
    ['T&S Urgent', ['tns-urgent@alerts.test']],
    ['Default CC', ['default-cc@alerts.test']],
    ['Leadership', ['lead1@alerts.test', 'lead2@alerts.test']],
    ['Civics', ['civics@alerts.test']],
    ['Executive Comms', ['exec-comms@alerts.test']],
    ['Stop Leaks', ['stop-leaks@alerts.test']],
    ['People Comms', ['people-comms@alerts.test']],
    ['LSS / Exec Security', ['lss@alerts.test']],
    ['Influencer Team', ['influencer-team@alerts.test']],
    ['France', ['france-leads@alerts.test']],
    ['EMEA', ['emea-leads@alerts.test']],
    ['Asia Pacific', ['apac-leads@alerts.test']],
    ['Japan', ['japan-leads@alerts.test']],
    ['United Kingdom', ['uk-leads@alerts.test']],
    ['Germany', ['germany-leads@alerts.test']],
  ];
  (gen.distribution.products || []).forEach(p => {
    if (p.deprecated || !p.group_name) return;
    const slug = String(p.group_name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const emails = p.group_name === 'Ads / Merchant Center'
      ? [`${slug}@alerts.test`, 'default-cc@alerts.test']
      : p.group_name === 'Search'
        ? ['search@alerts.test'].concat(Array.from({ length: 9 }, (_, i) => `search-${i + 2}@alerts.test`))
        : [`${slug}@alerts.test`];
    syntheticRows.push([p.group_name, emails]);
  });
  sandbox.applyBrandSafetyGroups_(syntheticRows);
  if (vm.runInContext('typeof TNS_URGENT_EMAIL_', sandbox) === 'undefined') {
    Object.defineProperty(sandbox, 'TNS_URGENT_EMAIL_', { configurable: true, get: () => sandbox.tnsUrgentLabel_() });
  }
}

/** Runs every .gs file in one vm context (Apps Script's shared global scope). Date.now() follows `clock` when given. */
function loadBot(services, clock, opts) {
  const sandbox = Object.assign({ Utilities: makeUtilities(), console: { log() {}, error() {}, warn() {} } }, services || {});
  vm.createContext(sandbox);
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.gs')).sort();
  const code = files.map(f => `// ---- ${f}\n${fs.readFileSync(path.join(ROOT, f), 'utf8')}`).join('\n;\n');
  vm.runInContext(code, sandbox, { filename: 'apps-script-chat-bot.js' });
  if (!(opts && opts.noSyntheticSeed)) seedSyntheticDistribution(sandbox);
  if (clock) {
    sandbox.__clock = clock;
    vm.runInContext('Date.now = () => __clock.now;', sandbox);
  }
  sandbox.ev = expr => vm.runInContext(expr, sandbox);
  return sandbox;
}

module.exports = { FakeChat, FakeVertex, FakeGmail, FakeSheet, FakeSpreadsheet, decodeMime, makeGoogle, loadBot, CHAT_POSTS };

