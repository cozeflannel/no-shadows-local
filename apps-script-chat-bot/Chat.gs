/**
 * Chat.gs — the Google Chat REST API, called as the user who runs the bot (no Chat app, no webhooks).
 *
 *   chatListMessages_(space, sinceIso, max, newestFirst)   messages created after sinceIso, normalized
 *                                             (oldest first unless newestFirst)
 *   chatPostMessage_(space, text, {thread, key, idPrefix})  posts (in a thread when given); `key` makes the post
 *                                             idempotent (its message id starts with idPrefix, else "client-bqa-")
 *   chatReact_(messageName, emoji)            adds an emoji reaction (already there = fine)
 *   chatListReactions_(messageName)           the reactions on a message, with who added each (Relay.gs)
 *   chatThreadRoot_(space, thread)            the message a thread hangs under (Relay.gs)
 *   chatGetSpace_(id), chatListSpaces_()      space lookups for Config.gs names and listMySpaces()
 *
 * Idempotent posts: a post with a key gets a custom message id ("client-bqa-" + hash of space + key) and a request
 * id from the same hash, so a retried run can't post the same thing twice; if the id already exists, the existing
 * message is returned. Transient errors (429 / 5xx) are retried with backoff.
 *
 * Every post says its text is in Chat's own markup (CHAT_MARKUP_): <url|link text>, *bold*, <users/…> mentions. Without
 * it the API reads the text as Markdown (the default for a project with no Chat app configured), so a <url|text> link
 * shows as the raw long link and *bold* comes out italic.
 *
 * S-F Burson (the Control tab's B25, this run: Config.gs sfBursonId_): every call that would write there is refused
 * (chatCall_), except while the Burson outbox writes a row someone set to Send (Outbox.gs). So is every write to a space
 * people outside Google can join that the run knows isn't S-F Burson (Config.gs noteOutsideSpace_), and every write to
 * the Burson test copy (B26, Config.gs testCopyId_) but the copy of S-F Burson and the Relay's analysts' side
 * (TestCopy.gs). Every message and reaction the bot makes anywhere is noted (botPosted_, botReacted_), so the relay
 * never sends the bot's own work, whatever account it ran as.
 */

const CHAT_API_ = 'https://chat.googleapis.com/v1/';
const CHAT_UPLOAD_API_ = 'https://chat.googleapis.com/upload/v1/';  // attachments (chatUploadImage_)
const CHAT_MARKUP_ = 'MARKUP_SYNTAX_CHAT';
const CLIENT_IDS_OFF_PROP_ = 'CHAT_CLIENT_IDS_OFF';
const ORDER_BY_OFF_PROP_ = 'CHAT_ORDER_BY_OFF';

function chatCall_(method, path, opts) {
  opts = opts || {};
  // S-F Burson: nothing is ever written there but a Burson outbox row someone set to Send (Outbox.gs); a space people
  // outside Google can join that isn't S-F Burson: nothing at all
  if (String(method).toLowerCase() !== 'get') {
    const refused = chatWriteRefusal_(path);
    if (refused) throw new Error(refused);
  }
  const q = opts.query || {};
  const query = Object.keys(q).filter(k => q[k] !== undefined && q[k] !== null && q[k] !== '')
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k]))).join('&');
  const params = { method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (opts.body !== undefined) { params.contentType = 'application/json'; params.payload = JSON.stringify(opts.body); }
  const tries = 3;
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const resp = UrlFetchApp.fetch(CHAT_API_ + path + (query ? '?' + query : ''), params);
      const code = resp.getResponseCode();
      const text = resp.getContentText() || '';
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
      last = { code, body, text };
      if (code !== 429 && code < 500) {
        if (String(method).toLowerCase() === 'post') noteBotWrite_(path, opts.body, last, opts.intendedId);
        return last;
      }
    } catch (e) {  // network error / timeout
      last = { code: 599, body: {}, text: String((e && e.message) || e) };
    }
    if (attempt < tries) Utilities.sleep(1000 * attempt);
  }
  return last;
}

/**
 * Why a write to `path` (spaces/X/…) is refused, or '' when it isn't: this run's S-F Burson (Control tab B25), unless
 * the Burson outbox is writing a row someone set to Send; or a space people outside Google can join that this run knows
 * isn't S-F Burson (never written at all); or this run's Burson test copy (Control tab B26), unless the copy of S-F
 * Burson or the Relay's analysts' side is being written there (TestCopy.gs testCopyWrite_).
 */
function chatWriteRefusal_(path) {
  const space = String(path || '').split('/').slice(0, 2).join('/');
  const sfb = sfBursonId_();
  if (sfb && space === sfb && !(typeof outboxWriting_ === 'function' && outboxWriting_())) {
    return 'Refusing to write in S-F Burson: only a Burson outbox row someone set to Send is posted there.';
  }
  if (outsideSpace_(space)) {
    return `Refusing to write in ${space}: people outside Google can join it, and it isn't the S-F Burson space (Control tab B25).`;
  }
  const copy = typeof testCopyId_ === 'function' ? testCopyId_() : '';
  if (copy && space === copy && !(typeof testCopyWriting_ === 'function' && testCopyWriting_())) {
    return 'Refusing to write in the Burson test copy (Control tab B26): only the copy of S-F Burson and the analysts\' ' +
      'side the Relay sends go there.';
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------------------
// What the bot itself posted and reacted, per message, whatever account it ran as (someone running poll() from the
// editor included): the relay never sends it to S-F Burson (Relay.gs). In the script cache: the latest BOT_MARKS_MAX_
// messages of each kind, for 3 days at most (the relay looks at emojis on messages up to RELAY_EMOJI_DAYS_ old).
// ---------------------------------------------------------------------------------------------------------------

// i: the id each post was meant to have ("client-bqa-…" the bot's own work, "client-zmir-…" a Mirror copy of a live alert
// or a Direct BigQuery post, "client-zrly-…" / "client-zrlo-…" the relay's), kept whether or not Chat took custom ids
// (clientIdsOff_), so normalizeMessage_ gives a post of the bot's its id back: what a post is never depends on Chat
const BOT_MARKS_CACHE_ = { p: 'bot_posts', r: 'bot_reactions', i: 'bot_post_ids' };
const BOT_MARKS_MAX_ = 400;
const BOT_MARKS_MS_ = 3 * 24 * 3600 * 1000;
let BOT_MARKS_ = null;  // {p: {message: ms}, r: {message: {emoji: ms}}, i: {message: id}, known: {p, r, i}}, read once a run

function botMarks_() {
  if (BOT_MARKS_) return BOT_MARKS_;
  const known = {};  // which records were there to read (the script cache can drop one)
  const read = k => {
    try {
      const raw = CacheService.getScriptCache().get(BOT_MARKS_CACHE_[k]);
      known[k] = raw !== null && raw !== undefined;
      return JSON.parse(raw || 'null') || {};
    } catch (e) {
      known[k] = false;
      return {};
    }
  };
  BOT_MARKS_ = { p: read('p'), r: read('r'), i: read('i'), known };
  return BOT_MARKS_;
}

/**
 * True when the bot's record of its own posts ('p') or emojis ('r') is there (the script cache can drop it): only then
 * can a post or emoji by the account the bot runs as be told apart from the bot's own (Relay.gs).
 */
function botMarksKnown_(kind) { return !!(botMarks_().known || {})[kind]; }

/**
 * Records a message or reaction a Chat call just made (a post that worked, or a reaction already there), and for a post
 * the id it was meant to have (`intendedId`, whether or not Chat took it). Never throws.
 */
function noteBotWrite_(path, body, r, intendedId) {
  try {
    const p = String(path || '');
    if (!r || !(r.code < 300 || r.code === 409)) return;
    const now = Date.now();
    const marks = botMarks_();
    const reacted = p.match(/^(spaces\/[^/]+\/messages\/[^/]+)\/reactions$/);
    let kind;
    if (reacted) {
      const emoji = bareEmoji_(body && body.emoji && body.emoji.unicode);
      if (!emoji) return;
      kind = 'r';
      marks.r[reacted[1]] = Object.assign({}, marks.r[reacted[1]], { [emoji]: now });
    } else if (/^spaces\/[^/]+\/messages$/.test(p) && r.code < 300 && r.body && r.body.name) {
      kind = 'p';
      marks.p[String(r.body.name)] = now;
      if (intendedId) marks.i = Object.assign({}, marks.i, { [String(r.body.name)]: String(intendedId) });
    } else {
      return;
    }
    const at = v => (kind === 'p' ? Number(v) || 0 : Math.max.apply(null, Object.keys(v || {}).map(e => Number(v[e]) || 0).concat([0])));
    const map = marks[kind];
    const kept = {};
    Object.keys(map).filter(n => now - at(map[n]) < BOT_MARKS_MS_).sort((a, b) => at(map[b]) - at(map[a])).slice(0, BOT_MARKS_MAX_)
      .forEach(n => { kept[n] = map[n]; });
    marks[kind] = kept;
    const cache = CacheService.getScriptCache();
    cache.put(BOT_MARKS_CACHE_[kind], JSON.stringify(kept), 21600);
    marks.known = Object.assign({}, marks.known, { [kind]: true });
    if (kind === 'p') {  // the ids go with the posts kept
      const ids = {};
      Object.keys(marks.i || {}).filter(n => Object.prototype.hasOwnProperty.call(kept, n)).forEach(n => { ids[n] = marks.i[n]; });
      marks.i = ids;
      cache.put(BOT_MARKS_CACHE_.i, JSON.stringify(ids), 21600);
      marks.known.i = true;
    }
  } catch (e) {
    console.error('could not note the bot\'s own post or reaction: ' + ((e && e.message) || e));
  }
}

/** True when the bot posted message `name` itself (any account). */
function botPosted_(name) { return !!name && Object.prototype.hasOwnProperty.call(botMarks_().p, String(name)); }

/**
 * The id the bot meant its post `name` to have ("client-bqa-…", "client-zmir-…", …), whether or not Chat took custom
 * ids; '' for anyone else's message, or one the bot's record no longer has. Never throws.
 */
function botPostId_(name) {
  try {
    const ids = (name && botMarks_().i) || {};
    return Object.prototype.hasOwnProperty.call(ids, String(name)) ? String(ids[String(name)] || '') : '';
  } catch (e) {
    return '';
  }
}

/** The bot's post that was meant to have custom id `id` (its message name), or '' when its record has none. */
function botPostNamed_(id) {
  if (!id) return '';
  try {
    const ids = botMarks_().i || {};
    return Object.keys(ids).find(n => ids[n] === String(id)) || '';
  } catch (e) {
    return '';
  }
}

/** True when the bot put `emoji` on message `name` itself (any account). */
function botReacted_(name, emoji) {
  const mine = name && botMarks_().r[String(name)];
  return !!mine && Object.prototype.hasOwnProperty.call(mine, bareEmoji_(emoji));
}

function chatError_(r, what) {
  const detail = (r.body && r.body.error && r.body.error.message) || String(r.text || '').slice(0, 300);
  const err = new Error(`Chat API ${r.code} on ${what}: ${detail}`);
  err.code = r.code;
  return err;
}

/**
 * Messages in `space` since `sinceIso`. opts (optional): {until: ISO time (only messages before it), fields: the API's
 * field mask, for a lighter read when only some fields are needed}.
 */
function chatListMessages_(space, sinceIso, max, newestFirst, opts) {
  opts = opts || {};
  const props = PropertiesService.getScriptProperties();
  let ordered = !!newestFirst && !(Date.now() - Number(props.getProperty(ORDER_BY_OFF_PROP_) || 0) < 24 * 3600 * 1000);
  const out = [];
  let pageToken = '';
  const filter = [sinceIso ? `create_time > "${sinceIso}"` : '', opts.until ? `create_time < "${opts.until}"` : ''].filter(Boolean).join(' AND ');
  do {
    const query = { filter, pageSize: Math.min(1000, max || 100), pageToken };
    if (opts.fields) query.fields = opts.fields;
    if (ordered) query.orderBy = 'createTime DESC';
    let r = chatCall_('get', space + '/messages', { query });
    if (r.code === 400 && ordered && !pageToken) {  // ordering refused: use the default (oldest first) for a day
      props.setProperty(ORDER_BY_OFF_PROP_, String(Date.now()));
      ordered = false;
      delete query.orderBy;
      r = chatCall_('get', space + '/messages', { query });
    }
    if (r.code >= 300) throw chatError_(r, 'reading ' + space);
    (r.body.messages || []).forEach(m => out.push(normalizeMessage_(m)));
    pageToken = r.body.nextPageToken || '';
  } while (pageToken && out.length < (max || 100));
  return out.slice(0, max || 100);
}

/**
 * Uploads an image to `space` as a Chat attachment for the message the bot posts next (media.upload, user auth: the
 * chat.messages.create scope the bot already has): the attachmentDataRef to put in that message's `attachment`, or
 * throws. `img`: {name, mime, base64} (Post.gs fetchScreenshot_: an image of 3 MB at most, so its bytes are fine in the
 * script). Refused wherever the bot may not write (chatWriteRefusal_: S-F Burson, the test copy, outside spaces).
 */
function chatUploadImage_(space, img) {
  const refused = chatWriteRefusal_(space);
  if (refused) throw new Error(refused);
  if (!img || !img.base64 || !/^image\//.test(String(img.mime || ''))) throw new Error('not an image to upload');
  const utf8 = s => Utilities.base64Decode(Utilities.base64Encode(s, Utilities.Charset.UTF_8));
  const boundary = 'bqa' + sha256Hex_(space + '|' + img.name + '|' + String(img.base64).length).slice(0, 24);
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify({ filename: String(img.name || 'post.jpg') })}\r\n--${boundary}\r\nContent-Type: ${img.mime}\r\n\r\n`;
  const payload = utf8(head).concat(Utilities.base64Decode(img.base64), utf8(`\r\n--${boundary}--`));
  const resp = UrlFetchApp.fetch(`${CHAT_UPLOAD_API_}${space}/attachments:upload?uploadType=multipart`, {
    method: 'post', muteHttpExceptions: true, contentType: `multipart/related; boundary=${boundary}`, payload,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  const code = resp.getResponseCode();
  const text = resp.getContentText() || '';
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (e) { body = {}; }
  if (code >= 300 || !body.attachmentDataRef) {
    const why = (body.error && body.error.message) || truncate_(text.replace(/\s+/g, ' '), 160) || 'no attachment came back';
    throw new Error(`Chat API ${code} on uploading the post's picture to ${space}: ${why}`);
  }
  return body.attachmentDataRef;
}

function chatPostMessage_(space, text, opts) {
  opts = opts || {};
  const cleanText = typeof normalizeChatLinks_ === 'function' ? normalizeChatLinks_(text) : String(text);
  const body = { text: cleanText, markupSyntax: CHAT_MARKUP_ };
  if (opts.attachments && opts.attachments.length) body.attachment = opts.attachments;  // chatUploadImage_'s, uploaded first
  const query = {};
  if (opts.thread) {
    body.thread = { name: opts.thread };
    query.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
  }
  let clientId = '';
  // the id this post is meant to have, kept by the bot (noteBotWrite_) even when Chat takes no custom id: a keyless post
  // is still the bot's own work
  let intendedId = (opts.idPrefix || CLIENT_ID_PREFIX_) + 'nokey';
  if (opts.key) {
    const hex = sha256Hex_(space + '|' + opts.key);
    query.requestId = uuidFromHex_(hex);
    intendedId = (opts.idPrefix || CLIENT_ID_PREFIX_) + hex.slice(0, 40);
    if (!clientIdsOff_()) {
      clientId = intendedId;
      query.messageId = clientId;
    }
  }
  let r = chatCall_('post', space + '/messages', { query, body, intendedId });
  if (r.code === 409 && clientId) {  // posted on an earlier attempt: use that message
    const got = chatCall_('get', space + '/messages/' + clientId);
    if (got.code < 300) return normalizeMessage_(got.body);
    throw chatError_(got, 'reading back ' + clientId);
  }
  if (r.code === 400 && clientId && /message_?id/i.test(r.text)) {  // custom ids refused: the request id still dedupes
    PropertiesService.getScriptProperties().setProperty(CLIENT_IDS_OFF_PROP_, String(Date.now()));
    delete query.messageId;
    r = chatCall_('post', space + '/messages', { query, body, intendedId });
  }
  if (r.code >= 300) throw chatError_(r, 'posting to ' + space);
  return normalizeMessage_(r.body);
}

/** Custom message ids were refused within the last day. */
function clientIdsOff_() {
  const since = Number(PropertiesService.getScriptProperties().getProperty(CLIENT_IDS_OFF_PROP_) || 0);
  return !!since && Date.now() - since < 24 * 3600 * 1000;
}

function chatReact_(messageName, emoji) {
  const bare = String(emoji).replace(/\uFE0F/g, '');
  const variants = bare !== emoji ? [emoji, bare] : [emoji, emoji + '\uFE0F'];
  let last = null;
  for (const v of variants) {
    const r = chatCall_('post', messageName + '/reactions', { body: { emoji: { unicode: v } } });
    if (r.code < 300 || r.code === 409) return true;
    last = r;
    if (r.code !== 400) break;  // only an unrecognized emoji form is worth retrying in the other form
  }
  throw chatError_(last, `reacting ${emoji} on ${messageName}`);
}

/** The reactions on a message, with who added each: [{emoji, user ("users/…"), userDisplay}]. */
function chatListReactions_(messageName) {
  const out = [];
  let pageToken = '';
  do {
    const r = chatCall_('get', messageName + '/reactions', { query: { pageSize: 200, pageToken } });
    if (r.code >= 300) throw chatError_(r, 'reading the reactions on ' + messageName);
    (r.body.reactions || []).forEach(x => {
      const user = x.user || {};
      if (x.emoji && x.emoji.unicode) out.push({ emoji: x.emoji.unicode, user: user.name || '', userDisplay: user.displayName || '' });
    });
    pageToken = r.body.nextPageToken || '';
  } while (pageToken && out.length < 2000);
  return out;
}

/** The message a thread hangs under (its first message), normalized, or null when there's none. Throws on other errors. */
function chatThreadRoot_(space, thread) {
  if (!thread) return null;
  const r = chatCall_('get', space + '/messages', { query: { filter: `thread.name = ${thread}`, pageSize: 1 } });
  if (r.code === 404) return null;
  if (r.code >= 300) throw chatError_(r, 'reading the thread ' + thread);
  const first = (r.body.messages || [])[0];
  return first ? normalizeMessage_(first) : null;
}

/** The direct-message space with a person ("users/<email>" works with user auth), or null when there isn't one yet. */
function chatFindDm_(email) {
  const r = chatCall_('get', 'spaces:findDirectMessage', { query: { name: 'users/' + email } });
  if (r.code === 404) return null;
  if (r.code >= 300) throw chatError_(r, 'finding the DM with ' + email);
  return (r.body && r.body.name) || null;
}

function chatGetSpace_(id) {
  const r = chatCall_('get', id);
  if (r.code >= 300) throw chatError_(r, 'opening ' + id);
  return r.body;
}

function chatListSpaces_() {
  const out = [];
  let pageToken = '';
  do {
    const r = chatCall_('get', 'spaces', { query: { pageSize: 1000, pageToken } });
    if (r.code >= 300) throw chatError_(r, 'listing spaces');
    (r.body.spaces || []).forEach(s => out.push(s));
    pageToken = r.body.nextPageToken || '';
  } while (pageToken);
  return out;
}

/** The bot user's id ("users/…") from its membership in a space, or null. */
function chatMyUserId_(space, email) {
  for (const path of [`${space}/members/${email}`, `${space}/members/users/${email}`]) {
    const r = chatCall_('get', path);
    if (r.code < 300 && r.body.member && r.body.member.name) return r.body.member.name;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

/**
 * API message -> the shape Bot.gs works with. clientId: the custom id Chat has for it, else, for one of the bot's own
 * posts, the id the bot meant it to have (botPostId_): with Chat refusing custom ids (clientIdsOff_) the bot still tells
 * its own work, its Mirror copies and its relays apart from people's messages, and pairs a copy with its live alert.
 */
function normalizeMessage_(m) {
  m = m || {};
  const sender = m.sender || {};
  const mentions = (m.annotations || [])
    .filter(a => a.type === 'USER_MENTION' && a.userMention && a.userMention.user && a.userMention.user.name)
    .map(a => a.userMention.user.name);
  const links = messageLinks_(m);  // only when there are any: every other message is as before
  return Object.assign({
    name: m.name || '',
    text: m.text || m.formattedText || m.fallbackText || '',
    cardText: cardText_(m),
    createTime: parseRfc3339_(m.createTime),
    senderName: sender.name || '',
    senderDisplay: sender.displayName || '',
    senderEmail: sender.email || '',
    senderType: sender.type || '',
    thread: (m.thread && m.thread.name) || '',
    threadReply: !!m.threadReply,
    clientId: m.clientAssignedMessageId || (m.name ? botPostId_(m.name) : '') || '',
    mentions,
    reactions: (m.emojiReactionSummaries || []).filter(s => s.emoji && s.emoji.unicode)
      .map(s => ({ emoji: s.emoji.unicode, count: s.reactionCount || 0 })),
    attachments: (m.attachment || []).map(a => ({ name: a.contentName || '', type: a.contentType || '' })),
  }, links.length ? { links } : {});
}

/**
 * The links a message carries that its plain text can leave out: a hyperlink's words (a monitoring tool's "Click to view
 * post") read as the words alone in `text`, and only formattedText has its <url|words>; and rich-link chips. In order,
 * each once. Pure.
 */
function messageLinks_(m) {
  const out = [];
  const add = u => {
    const s = String(u || '').trim();
    if (/^https?:\/\/\S+$/i.test(s) && out.indexOf(s) < 0) out.push(s);
  };
  String((m && m.formattedText) || '').replace(/<(https?:\/\/[^|>\s]+)\|[^>]*>/g, (all, url) => { add(url); return all; });
  ((m && m.annotations) || []).forEach(a => { if (a && a.richLinkMetadata && a.richLinkMetadata.uri) add(a.richLinkMetadata.uri); });
  return out;
}

const CARD_TEXT_KEYS_ = ['title', 'subtitle', 'text', 'topLabel', 'bottomLabel', 'content'];

/** The text inside a message's cards (Zapier can post an alert as a card): titles, labels and paragraphs, in order. */
function cardText_(m) {
  const out = [];
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    Object.keys(node).forEach(k => {
      const v = node[k];
      if (typeof v === 'string') { if (CARD_TEXT_KEYS_.includes(k) && v.trim()) out.push(v); } else walk(v);
    });
  };
  walk(m.cardsV2 || []);
  walk(m.cards || []);
  return out.map(cardHtmlToText_).join('\n').trim();
}

/** Card text is light HTML ("<b>", "<br>", entities): back to plain text, line breaks kept. */
function cardHtmlToText_(s) {
  return String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
}

/** "2026-10-14T15:18:10.123456Z" -> epoch ms (0 when missing). */
function parseRfc3339_(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));
  return isNaN(t) ? 0 : t;
}

function sha256Hex_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function uuidFromHex_(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
