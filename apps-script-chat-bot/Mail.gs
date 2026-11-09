/**
 * Mail.gs — Gmail, through the Gmail REST API, in the mailbox of the account that runs the bot (for the Social Alerts:
 * the Brand Social mailbox). While testing (escalation.stand_in) the bot sends each Social Alert itself, to the stand-in
 * only; otherwise it drafts and people send (or, with the Control tab's Auto-send Social Alerts ON, it sends it itself).
 *
 *   gmailClient_().sendMessage(mime, threadId)   -> {id, threadId} (sent now; never retried, so never sent twice)
 *   gmailClient_().createDraft(mime, threadId)   -> {id, messageId, threadId}
 *   gmailClient_().draftExists(id)               -> true / false (gone = sent or deleted)
 *   gmailClient_().getDraftRaw(id)               -> {raw, threadId} | null (the message as it is now, edits included)
 *   gmailClient_().updateDraft(id, mime, threadId)
 *   gmailClient_().deleteDraft(id)               (already gone = fine)
 *   gmailClient_().getThread(id)                 -> [{id, labels, at (ms), headers: {from, sender, to, cc, 'message-id', subject},
 *                                                    snippet (Gmail's first words of the message, as plain text)}]
 *   gmailClient_().findMessages(q, max)          -> message ids for a Gmail search
 *   gmailClient_().messageSummaries(q, max)      -> [{id, from, subject, at, snippet}] (the leads' guidance emails)
 *   gmailClient_().messageText(id)               -> the message's text ('' when it's gone): the whole of a team's question
 *                                                    on a Social Alert thread, for Draft answers to questions (FollowUp.gs)
 *
 * Scopes: gmail.compose (drafts and sending) and gmail.readonly (to see in Sent that a draft was sent, its Message-ID for
 * replies on that thread, the T&S confirmation emails, the leads' guidance and the replies on a sent Social Alert's
 * thread). Transient errors (429 / 5xx) are retried, except when sending.
 */

const GMAIL_API_ = 'https://gmail.googleapis.com/gmail/v1/users/me/';

function gmailCall_(method, path, body, maxTries) {
  const params = { method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (body !== undefined) { params.contentType = 'application/json'; params.payload = JSON.stringify(body); }
  const tries = maxTries || 3;
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const resp = UrlFetchApp.fetch(GMAIL_API_ + path, params);
      const code = resp.getResponseCode();
      const text = resp.getContentText() || '';
      let parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch (e) { parsed = { raw: text }; }
      last = { code, body: parsed, text };
      if (code !== 429 && code < 500) break;
    } catch (e) {  // network error / timeout
      last = { code: 599, body: {}, text: String((e && e.message) || e) };
    }
    if (attempt < tries) Utilities.sleep(1000 * attempt);
  }
  return last;
}

function gmailError_(r, what) {
  const detail = (r.body && r.body.error && r.body.error.message) || String(r.text || '').slice(0, 300);
  const err = new Error(`Gmail ${r.code} on ${what}: ${detail}`);
  err.code = r.code;
  return err;
}

function rawToText_(raw) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(String(raw))).getDataAsString('UTF-8');
}

function textToRaw_(text) { return Utilities.base64EncodeWebSafe(String(text), Utilities.Charset.UTF_8); }

/** The guard's one address while Testing with no stand-in in the config: no email matches it, so none goes anywhere. */
const NOBODY_EMAIL_ = 'nobody@testing.invalid';

/**
 * The tester addresses in `onlyTo` (an array or string): lowercased, each once, in the order written. Pure.
 */
function onlyToList_(onlyTo) {
  const out = [];
  const add = s => (String(s || '').match(/[^\s<>",;:()]+@[^\s<>",;:()]+/g) || []).forEach(a => {
    const lc = a.toLowerCase();
    if (!out.includes(lc)) out.push(lc);
  });
  if (Array.isArray(onlyTo)) onlyTo.forEach(add);
  else add(onlyTo);
  return out;
}

/** "a", "a and b", "a, b and c". Pure. */
function testersJoin_(list) {
  const l = (list || []).filter(Boolean);
  return l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : (l[0] || '');
}

/**
 * Testing (Main.gs runMode_: the testers in B30, else escalation.stand_in): every email the bot sends or drafts must be
 * addressed only to the tester list (To, Cc and Bcc). Checked on the finished message, the last step before Gmail, so no
 * code path can email anyone else. An empty array [] locks everything (NOBODY_EMAIL_); only '' (LIVE) opens the lock.
 * Throws (nothing is sent) when it's addressed to anyone else or to no one. Pure.
 */
function onlyToGuard_(mime, onlyTo) {
  let allowed;
  if (Array.isArray(onlyTo)) {
    const list = onlyToList_(onlyTo);
    allowed = list.length ? list : [NOBODY_EMAIL_];
  } else {
    const s = String(onlyTo || '').trim();
    if (!s) return;
    const list = onlyToList_(s);
    allowed = list.length ? list : [s.toLowerCase()];
  }
  const head = String(mime || '').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const addrs = [];
  head.split(/\r?\n/).forEach(line => {
    const m = line.match(/^(to|cc|bcc)\s*:(.*)$/i);
    if (m) (m[2].match(/[^\s<>",;:()]+@[^\s<>",;:()]+/g) || []).forEach(a => addrs.push(a.toLowerCase()));
  });
  const others = Array.from(new Set(addrs.filter(a => !allowed.includes(a))));
  if (!addrs.length || others.length) {
    throw new Error(`Testing: emails go only to ${testersJoin_(allowed)}. This one was addressed to ${others.join(', ') || 'no one'}, so ` +
      'it was not sent.');
  }
}

/** Gmail's snippet of a message as plain text (Gmail sends it HTML-escaped; a thread's replies, Outcomes.gs). Pure. */
function gmailSnippet_(s) {
  return String(s || '').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** opts.onlyTo (testing: the testers in B30, else escalation.stand_in): the addresses any email may go to (onlyToGuard_). */
function gmailClient_(opts) {
  const onlyTo = opts && Array.isArray(opts.onlyTo) ? opts.onlyTo.slice() : String((opts && opts.onlyTo) || '').trim();
  return {
    /** Sends a message now (on threadId when given). One attempt only: a retry could send the same alert twice. */
    sendMessage(mime, threadId) {
      onlyToGuard_(mime, onlyTo);
      const message = { raw: textToRaw_(mime) };
      if (threadId) message.threadId = threadId;
      const r = gmailCall_('post', 'messages/send', message, 1);
      if (r.code >= 300) throw gmailError_(r, 'sending an email');
      return { id: r.body.id, threadId: r.body.threadId || threadId || null };
    },
    createDraft(mime, threadId) {
      onlyToGuard_(mime, onlyTo);
      const message = { raw: textToRaw_(mime) };
      if (threadId) message.threadId = threadId;
      const r = gmailCall_('post', 'drafts', { message });
      if (r.code >= 300) throw gmailError_(r, 'creating a draft');
      return { id: r.body.id, messageId: r.body.message && r.body.message.id, threadId: r.body.message && r.body.message.threadId };
    },
    draftExists(id) {
      const r = gmailCall_('get', `drafts/${encodeURIComponent(id)}?format=minimal`);
      if (r.code === 404) return false;
      if (r.code >= 300) throw gmailError_(r, 'reading a draft');
      return true;
    },
    getDraftRaw(id) {
      const r = gmailCall_('get', `drafts/${encodeURIComponent(id)}?format=raw`);
      if (r.code === 404) return null;
      if (r.code >= 300) throw gmailError_(r, 'reading a draft');
      const m = r.body.message || {};
      return { raw: rawToText_(m.raw || ''), threadId: m.threadId || null };
    },
    updateDraft(id, mime, threadId) {
      onlyToGuard_(mime, onlyTo);
      const message = { raw: textToRaw_(mime) };
      if (threadId) message.threadId = threadId;
      const r = gmailCall_('put', `drafts/${encodeURIComponent(id)}`, { id, message });
      if (r.code >= 300) throw gmailError_(r, 'updating a draft');
      return true;
    },
    deleteDraft(id) {
      const r = gmailCall_('delete', `drafts/${encodeURIComponent(id)}`);
      if (r.code >= 300 && r.code !== 404) throw gmailError_(r, 'deleting a draft');
      return true;
    },
    getThread(id) {
      const headers = ['From', 'Sender', 'To', 'Cc', 'Message-ID', 'Subject'].map(h => 'metadataHeaders=' + encodeURIComponent(h)).join('&');
      const r = gmailCall_('get', `threads/${encodeURIComponent(id)}?format=metadata&${headers}`);
      if (r.code === 404) return [];
      if (r.code >= 300) throw gmailError_(r, 'reading a thread');
      return (r.body.messages || []).map(m => {
        const h = {};
        ((m.payload && m.payload.headers) || []).forEach(x => { h[String(x.name).toLowerCase()] = x.value; });
        return { id: m.id, labels: m.labelIds || [], at: Number(m.internalDate) || 0, headers: h,
          snippet: gmailSnippet_(m.snippet) };
      });
    },
    /** Ids of messages matching a Gmail search (e.g. the T&S "WD Intake Request" confirmation for a post link). */
    findMessages(q, max) {
      const r = gmailCall_('get', `messages?maxResults=${Math.max(1, Math.min(max || 5, 50))}&q=${encodeURIComponent(q)}`);
      if (r.code >= 300) throw gmailError_(r, 'searching Gmail');
      return (r.body.messages || []).map(m => m.id);
    },
    /** The newest messages matching a Gmail search: [{id, threadId, from (the name), subject, at (ms), snippet}]. */
    messageSummaries(q, max) {
      const unescape = s => String(s || '').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      return this.findMessages(q, max).map(id => {
        const r = gmailCall_('get', `messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
        if (r.code >= 300) return null;
        const h = {};
        ((r.body.payload && r.body.payload.headers) || []).forEach(x => { h[String(x.name).toLowerCase()] = x.value; });
        const from = String(h.from || '');
        return { id, threadId: r.body.threadId || '', from: from.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || from,
          subject: String(h.subject || ''), at: Number(r.body.internalDate) || 0, snippet: unescape(r.body.snippet).slice(0, 300) };
      }).filter(Boolean);
    },
    /** A message's whole text ('' when it's gone): a team's question on a Social Alert thread (FollowUp.gs). */
    messageText(id) {
      const r = gmailCall_('get', `messages/${encodeURIComponent(id)}?format=full`);
      if (r.code === 404) return '';
      if (r.code >= 300) throw gmailError_(r, 'reading a message');
      return gmailBodyText_(r.body.payload);
    },
  };
}

/** A message's text from its payload (format=full): its text/plain part, else its HTML part as text, else ''. Pure. */
function gmailBodyText_(payload) {
  const leaves = [];
  const walk = p => {
    if (!p || typeof p !== 'object') return;
    if (Array.isArray(p.parts) && p.parts.length) p.parts.forEach(walk);
    else leaves.push(p);
  };
  walk(payload);
  const data = p => !!(p && p.body && p.body.data);
  const plain = leaves.find(p => /^text\/plain/i.test(String(p.mimeType || '')) && data(p));
  const html = leaves.find(p => /^text\/html/i.test(String(p.mimeType || '')) && data(p));
  if (plain) return rawToText_(plain.body.data);
  return html ? htmlToText_(rawToText_(html.body.data)) : '';
}
