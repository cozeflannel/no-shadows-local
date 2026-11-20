/**
 * chat.js — the app in Google Chat, as the person running it. It can do two things and no others: read a space's new
 * messages (to hear "temp check" typed there), and post a reply in a thread that already exists. It cannot start a
 * conversation, edit or delete a message, or add anyone; which space and which thread is the caller's to check
 * (inchat.js, with `mayReply` below).
 *
 * It uses its own sign-in, kept apart from the app's main Google login, so that nothing else on this computer gains
 * the right to read or post in Chat. `signInCommand` is the one line that makes it; the file gcloud writes is read
 * from the app's own folder under the home directory (TEMPCHECK_CHAT_LOGIN names another). Without that file
 * `status` says so, and nothing is read or posted. Google can refuse gcloud's own sign-in for Chat ("This app is
 * blocked"): `signInCommand(true)` is the same line made with a sign-in client of the team's own project, whose file
 * is kept beside the login (CLIENT_FILE), never in the repository.
 *
 * The chat bot runs as a person's account too, so in a space the bot works, a reply posted here would look to the bot
 * like something that person typed, to be answered. Two things mark a reply as machine-written, the way the bot marks
 * its own: its message id starts with the bot's own prefix (`messageId`), and its words start as the bot's temp check
 * posts do (HEAD). The bot's own code was run against such a reply: it leaves it alone.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PROJECT, fromLoginFile } = require('./gcp');

const CHAT = 'https://chat.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/';
const NEEDS = { read: ['chat.messages.readonly', 'chat.messages'], post: ['chat.messages.create', 'chat.messages'] };
const HEAD = '\uD83C\uDF21\uFE0F *Temp check';        // how every reply starts (the bot knows its own temp check posts by it)
const ID_PREFIX = 'client-bqa-tc-';                    // the bot takes a message whose id starts "client-bqa-" for its own
const THREAD_RX = /^(spaces\/[A-Za-z0-9_-]+)\/threads\/[A-Za-z0-9_.-]+$/;
const TEXT_MAX = 3800;

let kept = { token: '', until: 0, about: null };

function loginFile() {
  return process.env.TEMPCHECK_CHAT_LOGIN || path.join(os.homedir(), '.config', 'tempcheck-app', 'chat', 'application_default_credentials.json');
}

const CLIENT_FILE = '$HOME/.config/tempcheck-app/chat-client.json';  // as typed in a terminal: the shell fills in the home directory

/**
 * The one line that signs the app in to Chat (run in a terminal; a browser asks which account and what it may do).
 * `ownClient`: made with the sign-in client kept in CLIENT_FILE, for when Google refuses gcloud's own.
 */
function signInCommand(ownClient) {
  const scopes = ['openid', `${SCOPE}userinfo.email`, `${SCOPE}cloud-platform`, `${SCOPE}chat.messages.readonly`, `${SCOPE}chat.messages.create`];
  return `CLOUDSDK_CONFIG="$HOME/.config/tempcheck-app/chat" gcloud auth application-default login${ownClient ? ` --client-id-file="${CLIENT_FILE}"` : ''} --scopes=${scopes.join(',')}`;
}

async function token() {
  if (kept.token && Date.now() < kept.until - 5 * 60 * 1000) return kept.token;
  const got = await fromLoginFile(loginFile());
  kept = { token: got.token, until: Date.now() + got.ms, about: null };
  return kept.token;
}

/** One call to the Chat API as JSON. Throws an Error with `.status` and Google's own words for anything but a 2xx. */
async function call(method, url, body) {
  const resp = await fetch(url, { method, headers: Object.assign({ Authorization: `Bearer ${await token()}`, 'x-goog-user-project': PROJECT },
    body === undefined ? {} : { 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await resp.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = {}; }
  if (!resp.ok) {
    const why = (json && json.error && json.error.message) || text.slice(0, 300);
    const err = new Error(`Chat HTTP ${resp.status}: ${String(why).replace(/\s+/g, ' ').trim()}`);
    err.status = resp.status;
    throw err;
  }
  return json;
}

/**
 * What the Chat sign-in allows: {signedIn, canRead, canPost, me ('users/…': whose messages are "mine"; '' when it
 * can't be told), why (what is missing, in words), signIn (the command), ifRefused (the other way to sign in:
 * {signIn, clientFile, console, project})}. Never throws.
 */
async function status() {
  const out = { signedIn: false, canRead: false, canPost: false, me: '', why: '', signIn: signInCommand(),
    ifRefused: { signIn: signInCommand(true), clientFile: CLIENT_FILE, console: `https://console.cloud.google.com/auth/clients?project=${encodeURIComponent(PROJECT)}`, project: PROJECT } };
  if (!fs.existsSync(loginFile())) { out.why = 'The app has not been signed in to Chat yet.'; return out; }
  try {
    const t = await token();
    if (!kept.about) {
      const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(t)}`, { signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Google would not describe the sign-in (HTTP ${r.status})`);
      let sub = String(j.sub || '');
      if (!sub) {  // the sign-in's account, asked for by name when the first answer leaves it out
        const u = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(15000) });
        sub = u.ok ? String(((await u.json().catch(() => ({}))) || {}).sub || '') : '';
      }
      kept.about = { scopes: String(j.scope || '').split(/\s+/).filter(Boolean), sub };
    }
    const has = list => list.some(s => kept.about.scopes.indexOf(SCOPE + s) >= 0);
    out.signedIn = true;
    out.canRead = has(NEEDS.read);
    out.canPost = has(NEEDS.post);
    out.me = /^\d{5,30}$/.test(kept.about.sub) ? `users/${kept.about.sub}` : '';
    const lacks = [out.canRead ? '' : 'read messages', out.canPost ? '' : 'post messages'].filter(Boolean);
    if (lacks.length) out.why = `The Chat sign-in may not ${lacks.join(' or ')}. Sign in again with the command below.`;
  } catch (e) {
    out.why = `The Chat sign-in could not be used: ${String((e && e.message) || e).slice(0, 200)}`;
  }
  return out;
}

/** A Chat message as the app uses it: {name, text, at (ms), sender, senderType, thread, threadReply, clientId}. Pure. */
function shape(m) {
  const s = (m && m.sender) || {};
  return { name: String((m && m.name) || ''), text: String((m && m.text) || ''), at: Date.parse((m && m.createTime) || '') || 0, sender: String(s.name || ''),
    senderType: String(s.type || ''), thread: String(((m && m.thread) || {}).name || ''), threadReply: !!(m && m.threadReply), clientId: String((m && m.clientAssignedMessageId) || '') };
}

/** The messages of `space` ("spaces/X") made after `sinceMs`, oldest first (600 at most). Read only. */
async function list(space, sinceMs) {
  if (!/^spaces\/[A-Za-z0-9_-]+$/.test(String(space))) throw new Error('not a Chat space');
  const filter = `createTime > "${new Date(Number(sinceMs) || 0).toISOString()}"`;
  const out = [];
  let page = '';
  for (let n = 0; n < 3; n++) {
    const got = await call('GET', `${CHAT}/${space}/messages?pageSize=200&filter=${encodeURIComponent(filter)}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    (got.messages || []).forEach(m => out.push(shape(m)));
    page = got.nextPageToken || '';
    if (!page) break;
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The id a reply is given, from what it answers (`key`): the same key always gives the same id, so Chat itself refuses a second copy. Pure. */
function messageId(key) {
  return ID_PREFIX + crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
}

/**
 * Posts `o.text` as a reply in thread `o.thread`, once for `o.key`: {name, sender, already (it was there from an
 * earlier try)}. It never starts a new conversation: when the thread is gone, Chat refuses and this throws.
 */
async function reply(o) {
  const m = THREAD_RX.exec(String((o && o.thread) || ''));
  if (!m) throw new Error('not a Chat thread');
  const text = String((o && o.text) || '');
  if (text.indexOf(HEAD) !== 0) throw new Error('a reply must start as a temp check post does');
  const id = messageId(o.key);
  const body = { text: text.slice(0, TEXT_MAX), thread: { name: o.thread } };
  const base = `${CHAT}/${m[1]}/messages?messageReplyOption=REPLY_MESSAGE_OR_FAIL`;
  const sent = msg => ({ name: String(msg.name || ''), sender: String((msg.sender || {}).name || ''), already: false });
  try {
    return sent(await call('POST', `${base}&messageId=${encodeURIComponent(id)}`, body));
  } catch (e) {
    if (e.status === 409) {  // posted on an earlier try: that message stands
      const there = await call('GET', `${CHAT}/${m[1]}/messages/${id}`).catch(() => ({ name: `${m[1]}/messages/${id}` }));
      return { name: String(there.name || ''), sender: String((there.sender || {}).name || ''), already: true };
    }
    // Chat can refuse an id of one's own choosing: the reply still goes, known for a temp check post by its first words
    if (e.status === 400 && /message.?id/i.test(e.message)) return sent(await call('POST', base, body));
    throw e;
  }
}

/**
 * Why the app may not reply in `thread`, or '' when it may. `control`: feed.controlFromRows's. It replies in one space
 * only: the bot's Auto-correct space as the bot's Control tab names it and the bot itself confirmed it, and never in
 * a space the Control tab gives to S-F Burson. Pure.
 */
function mayReply(control, thread) {
  const m = THREAD_RX.exec(String(thread || ''));
  if (!m) return 'That is not a Chat thread.';
  const c = control || {};
  if (!c.autocorrect) return 'The bot\'s Control tab names no Auto-correct space, so there is nowhere the app may reply.';
  if (!c.checked) return 'The bot has not confirmed its Auto-correct space (no tick beside it on the Control tab), so the app does not post there.';
  if ((c.never || []).indexOf(m[1]) >= 0 || (c.never || []).indexOf(c.autocorrect) >= 0) return 'That space is S-F Burson\'s on the bot\'s Control tab. The app never posts there.';
  if (m[1] !== c.autocorrect) return 'That thread is not in the bot\'s Auto-correct space, the only space the app replies in.';
  return '';
}

/**
 * A message's words as a request for a temp check: null when it isn't one, else {bare: true} ("temp check" alone),
 * {boolean} (a query to search with: it has quotes, brackets or AND / OR / NOT / NEAR in it) or {ref} (a Brandwatch
 * query's name, link or id). "temp check", "temperature check", "temp-check" and "tempcheck", any case, with "on",
 * "for", "of", "about" or a colon after it. "temp checks are due at 3" is none. Pure.
 */
function ask(text) {
  const t = String(text === undefined || text === null ? '' : text).replace(/\u00a0/g, ' ').trim();
  if (!t || t.length > 1200) return null;
  const m = /^(?:temp(?:erature)?[\s-]*check|tempcheck)(?![a-z])([\s\S]*)$/i.exec(t);
  if (!m) return null;
  const rest = m[1].replace(/^[\s:,.\-–—]+/, '').replace(/^(?:on|for|of|about)\s+/i, '').replace(/[\s.!]+$/, '').trim();
  if (!rest) return { bare: true };
  if (/["“”()]|\b(?:AND|OR|NOT)\b|\bNEAR\/\d/.test(rest)) return { boolean: rest.replace(/[“”]/g, '"') };
  return { ref: rest.replace(/^['‘’]+|['‘’]+$/g, '') };
}

module.exports = { HEAD, ID_PREFIX, CLIENT_FILE, signInCommand, status, list, reply, shape, messageId, mayReply, ask, loginFile };
