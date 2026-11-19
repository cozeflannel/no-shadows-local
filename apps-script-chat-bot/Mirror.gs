/**
 * Mirror.gs — live Zapier mirror for training the bot in a separate space.
 *
 * Copies ONLY top-level Zapier messages from the live Burson channel (S-F Burson: the space in the Control tab's B25,
 * resolved once per run) into a training space:
 *   - No human/user messages
 *   - No thread replies
 *   - No emoji reactions
 *   - Zero messages, reactions, or alerts ever sent to the live Burson channel (strictly read-only on S-F Burson)
 * That's all with "Relay with S-F Burson" OFF (Control tab row 22). ON, Relay.gs copies S-F Burson into the Mirror space
 * itself, in S-F Burson's own order: Zapier's alerts (with this file's text, id and bookkeeping: mirrorCopyAlert_) and
 * everyone's replies, messages and emojis; the Mirror's own pass then runs only in a run where the Relay doesn't copy
 * (Main.gs). The analysts' messages (never the bot's) go back as Relay.gs says.
 *
 * When a Mirror space is set (in cell B9 on the Control tab, or in MIRROR_TARGET_SPACE below):
 *   1. Every minute, new top-level Zapier posts from S-F Burson are copied into the Mirror space. While B25 is blank or
 *      can't be found, the Mirror is paused (C9 and Status say so); when B25 changes, it starts from the new space's
 *      last 15 minutes.
 *   2. The bot sits in that Mirror space to review the mirrored Zapier alerts, react 👍, request fixes in threads,
 *      and answer questions in threads ("near-real, one-sided conversation"). With "Never wait on Burson" ON (Control
 *      row 23) it processes them right away instead, and says in threads what it changed and that the alert was processed.
 *   3. Outbound messages from that Mirror space to any other Chat space are blocked (MIRROR_BLOCK_OUTBOUND = true).
 */

// Optional: paste a training space link, "spaces/...", or exact space name here, or set it in cell B9 ("Mirror space")
// on the Control tab of the bot's Google Sheet. Leave blank ('') when not mirroring.
const MIRROR_TARGET_SPACE = '';

// When true, sitting the bot in the mirrored space blocks all outbound Chat posts/reactions to any other space.
const MIRROR_BLOCK_OUTBOUND = true;

const MIRROR_ROW_ = 9;
const MIRROR_LABEL_ = 'Mirror space';
const MIRROR_HINT_ = 'Leave blank, or paste a training space link to mirror live Zapier posts there (outbounds blocked).';
const MIRROR_CLIENT_ID_PREFIX_ = 'client-zmir-';
const MIRROR_MAX_PER_RUN_ = 25;
const MIRROR_MAX_GAP_MS_ = 60 * 60 * 1000;

/**
 * Sets the Mirror space on the Control tab (cell B9) and runs one pass immediately.
 * Can be called from the Apps Script editor or via clasp.
 */
function startMirror(spaceLinkOrName) {
  if (webViewerCall_()) throw new Error('Not available from the dashboard');
  const target = String(spaceLinkOrName === undefined || spaceLinkOrName === null ? MIRROR_TARGET_SPACE : spaceLinkOrName).trim();
  if (!target) throw new Error('Pass a training space link/name to startMirror("..."), or paste it in cell B9 on the Control tab.');
  const ss = openStore_(true);
  const control = controlTab_(ss) || ensureControlTab_(ss, Session.getEffectiveUser().getEmail());
  ensureMirrorRow_(control);
  control.getRange(MIRROR_ROW_, 2).setValue(target);
  const space = resolveMirrorSpace_(target);
  poll();
  return { mirror: space.id, name: space.name, outboundBlocked: MIRROR_BLOCK_OUTBOUND };
}

/** Clears cell B9 on the Control tab so live Zapier mirroring stops. */
function stopMirror() {
  if (webViewerCall_()) throw new Error('Not available from the dashboard');
  const ss = openStore_(false);
  const control = controlTab_(ss);
  if (control) {
    ensureMirrorRow_(control);
    control.getRange(MIRROR_ROW_, 2).setValue('');
    writeMirrorNote_(control, MIRROR_HINT_);
  }
  PropertiesService.getScriptProperties().deleteProperty('LAST_MIRROR_SPACE');
  return { stopped: true };
}

/** Runs one pass of the live Zapier mirror (also called automatically every minute by poll() when B9 is set). */
function pollMirror() {
  if (webViewerCall_()) throw new Error('Not available from the dashboard');
  const ss = openStore_(false);
  if (typeof syncBrandSafetyGroups_ === 'function') syncBrandSafetyGroups_(ss);
  const control = controlTab_(ss) || ensureControlTab_(ss, Session.getEffectiveUser().getEmail());
  ensureSfBursonRow_(control);
  const wanted = readControl_(control);
  const res = mirrorZapierPosts_(control, wanted, sfBursonFor_(control, wanted));
  return res ? { mirror: res.space.id, copied: res.copied, outboundBlocked: res.outboundBlocked } : { mirror: null, copied: 0 };
}

/**
 * Resolves the Mirror space (from B9 or MIRROR_TARGET_SPACE), validates safety checks, and copies any new top-level
 * Zapier posts from S-F Burson (`sfb`: this run's, Control tab B25, sfBursonFor_) into it. Returns {space, copied,
 * outboundBlocked, copies} when active, or null when blank. While no S-F Burson is known (B25 blank or not found) it
 * doesn't run: C9 says it needs B25, and the error thrown (a problem on the Control tab) says what to fix. With
 * `opts.defer` (the Relay ON: Main.gs) it checks the space but copies nothing yet ({…, deferred: true}): the Relay copies
 * S-F Burson in its own order, alerts included, and mirrorCopyNow_ copies only in a run where the Relay didn't.
 */
function mirrorZapierPosts_(control, wanted, sfb, opts) {
  if (control) ensureMirrorRow_(control);
  const rawRef = String((wanted && wanted.mirror) || MIRROR_TARGET_SPACE || '').trim();
  const props = PropertiesService.getScriptProperties();
  if (!rawRef) {
    if (props.getProperty('LAST_MIRROR_SPACE')) props.deleteProperty('LAST_MIRROR_SPACE');
    if (control) writeMirrorNote_(control, MIRROR_HINT_);
    return null;
  }
  if (!sfb || !sfb.space || !sfb.space.id) {  // no S-F Burson known: paused (fail closed)
    if (control) writeMirrorNote_(control, sfbPausedNote_(sfb));
    const err = new Error(sfbProblemText_(sfb || { blank: true }, sfbNeeds_(wanted, null)));
    err.setupProblem = true;
    throw err;
  }
  let space;
  try {
    space = resolveMirrorSpace_(rawRef);
  } catch (e) {
    if (control) writeMirrorNote_(control, '✗ check this link');
    const err = new Error(e.message);
    err.setupProblem = true;
    throw err;
  }
  const problem = mirrorProblem_(space, sfb.space);
  if (problem) {
    if (control) writeMirrorNote_(control, '✗ see Status');
    const err = new Error(problem);
    err.setupProblem = true;
    throw err;
  }
  if (opts && opts.defer) return { space, copied: 0, outboundBlocked: MIRROR_BLOCK_OUTBOUND, copies: [], deferred: true };
  return mirrorCopyNow_(control, space, sfb);
}

/**
 * The Mirror's own pass: S-F Burson's new top-level Zapier posts copied into the Mirror space `space` (copyZapierPosts_),
 * and C9 says so. Throws when S-F Burson can't be read or a copy fails (C9 says what went wrong). Returns {space, copied,
 * outboundBlocked, copies}.
 */
function mirrorCopyNow_(control, space, sfb) {
  let copied = 0;
  const copies = [];  // {live, copy}: each alert copied this run, for the relay's pairs (Relay.gs)
  try {
    copied = copyZapierPosts_(sfb.space.id, space.id, copies);
  } catch (e) {
    console.error('mirror read/post failed: ' + ((e && e.message) || e));
    if (control) writeMirrorNote_(control, `⚠️ ${truncate_(String((e && e.message) || e), 160)}`);
    throw e;
  }
  const note = `✓ ${space.name} (Zapier-only mirror${MIRROR_BLOCK_OUTBOUND ? ' · outbounds blocked' : ''})`;
  if (control) writeMirrorNote_(control, note);
  return { space, copied, outboundBlocked: MIRROR_BLOCK_OUTBOUND, copies };
}

/** C9 in a run where the Relay copied S-F Burson into the Mirror space `space` (alerts and everyone's messages, in order). */
function mirrorRelayNote_(space) {
  return `✓ ${space.name} (S-F Burson copied here in its own order by the Relay${MIRROR_BLOCK_OUTBOUND ? ' · outbounds blocked' : ''})`;
}

/** Resolves a space link, id, or exact name for the Mirror space (cached for an hour). */
function resolveMirrorSpace_(value) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'mirror_space:' + hashText_(String(value));
  const hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);
  const ref = parseSpaceRef_(value, 'The mirror training space');
  try {
    let id = ref.id;
    if (!id) {
      const props = PropertiesService.getScriptProperties();
      const prop = 'SPACE_ID:' + ref.name;
      id = props.getProperty(prop) || findSpaceByName_(ref.name, 'mirror training space');
      props.setProperty(prop, id);
    }
    const s = chatGetSpace_(id);
    const out = { id: s.name, name: s.displayName || s.name, externalUserAllowed: !!s.externalUserAllowed };
    cache.put(cacheKey, JSON.stringify(out), 3600);
    return out;
  } catch (e) {
    throw new Error(/^No space named|spaces are named/.test(e.message) ? e.message
      : `Can't open the mirror training space (${ref.id || ref.name}). Check the link, and that ${Session.getEffectiveUser().getEmail()} ` +
        'is a member of that space.');
  }
}

/**
 * Safety checks on the Mirror space: can never be the S-F Burson space (`sfb`: this run's, Control tab B25) and can never
 * allow external users.
 */
function mirrorProblem_(space, sfb) {
  if (!space) return '';
  if (isSfBurson_(sfb, space.id)) {
    return 'The mirror training space can\'t be the live Burson alerts space. Paste a separate training space.';
  }
  if (space.externalUserAllowed) {
    return `The mirror training space "${space.name || space.id}" allows people outside Google, so Burson could see it. ` +
      'Use a space that only Google people can join.';
  }
  return '';
}

/** Refuses to copy anywhere but the Mirror space: never S-F Burson, nor a space people outside Google can join. */
function mirrorTargetCheck_(sourceSpaceId, targetSpaceId) {
  if (!sourceSpaceId || !targetSpaceId || targetSpaceId === sourceSpaceId || targetSpaceId === sfBursonId_() ||
      outsideSpace_(targetSpaceId)) {
    throw new Error('Refusing to mirror into the live Burson space.');
  }
}

/**
 * How far the Mirror's copying into `targetSpaceId` has got: {floor, cursor, cursorKey}. A new Mirror space, a new source
 * (S-F Burson, B25, changed) or no cursor yet starts afresh, from its last 15 minutes.
 */
function mirrorState_(sourceSpaceId, targetSpaceId, now) {
  const props = PropertiesService.getScriptProperties();
  const lookbackMs = ((GEN.settings && GEN.settings.start_lookback_minutes) || 15) * 60 * 1000;
  const cursorKey = 'MIRROR_CURSOR:' + targetSpaceId;
  const floorKey = 'MIRROR_FLOOR:' + targetSpaceId;
  let floor = Number(props.getProperty(floorKey)) || 0;
  let cursor = Number(props.getProperty(cursorKey)) || 0;
  // S-F Burson (B25) changed since the last copy: start afresh, from its last 15 minutes. None noted yet (the build
  // before B25 left this Mirror copying): its cursor carries on, as on that build, and the source is noted from now on
  const lastSource = props.getProperty('LAST_MIRROR_SOURCE');
  const newSource = !!lastSource && lastSource !== sourceSpaceId;
  if (props.getProperty('LAST_MIRROR_SPACE') !== targetSpaceId || !cursor || lastSource !== sourceSpaceId) {
    floor = Math.max(floor, now - lookbackMs);
    cursor = newSource ? floor : Math.max(cursor, floor);  // after a change, the old cursor was in the other space
    props.setProperty(floorKey, String(floor));
    props.setProperty(cursorKey, String(cursor));
    props.setProperty('LAST_MIRROR_SPACE', targetSpaceId);
    props.setProperty('LAST_MIRROR_SOURCE', sourceSpaceId);
  }
  return { floor, cursor, cursorKey };
}

/**
 * Reads recent messages from `sourceSpaceId` (S-F Burson, Control tab B25) and copies ONLY top-level Zapier messages
 * into `targetSpaceId`. Never posts or reacts in `sourceSpaceId`. `copiesOut` (optional) gets {live, copy} for each copy.
 * A new source (B25 changed) starts afresh, from its last 15 minutes, as a new Mirror space does.
 */
function copyZapierPosts_(sourceSpaceId, targetSpaceId, copiesOut) {
  mirrorTargetCheck_(sourceSpaceId, targetSpaceId);
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const overlapMs = ((GEN.settings && GEN.settings.overlap_minutes) || 5) * 60 * 1000;
  const { floor, cursor, cursorKey } = mirrorState_(sourceSpaceId, targetSpaceId, now);

  const sinceMs = Math.max(cursor - overlapMs, floor, now - MIRROR_MAX_GAP_MS_);
  const sinceIso = new Date(sinceMs).toISOString();
  const done = recentCache_('mirror:' + targetSpaceId);
  const botUser = props.getProperty('BOT_USER') || null;
  const msgs = chatListMessages_(sourceSpaceId, sinceIso, LIST_LIMIT_).sort((a, b) => a.createTime - b.createTime);

  let newCursor = cursor;
  let copied = 0;
  try {
    for (const m of msgs) {
      if (m.createTime < floor) continue;
      if (done.has(m.name)) {
        newCursor = Math.max(newCursor, m.createTime);
        continue;
      }
      if (!isZapierMirrorCandidate_(m, botUser)) {
        done.add(m.name, m.createTime);
        newCursor = Math.max(newCursor, m.createTime);
        continue;
      }
      const text = zapierMirrorText_(m);
      if (!text) {
        done.add(m.name, m.createTime);
        newCursor = Math.max(newCursor, m.createTime);
        continue;
      }
      if (copied >= MIRROR_MAX_PER_RUN_) break;
      const copy = mirrorPostMessage_(targetSpaceId, text, m.name, m);
      rememberMirrorSource_(copy && copy.name, m.createTime);
      if (copiesOut && copy) copiesOut.push({ live: m, copy });
      copied++;
      done.add(m.name, m.createTime);
      newCursor = Math.max(newCursor, m.createTime);
    }
  } finally {
    if (newCursor > cursor) props.setProperty(cursorKey, String(newCursor));
    done.save();
  }
  return copied;
}

/**
 * One live Zapier alert `m` (S-F Burson, `sourceSpaceId`) copied into the Mirror space `targetSpaceId` exactly as the
 * Mirror's own pass copies it (its text, its client-zmir- id, the live post's time for the Speed tab), for the Relay
 * (Relay.gs relayAlertIn_), which copies S-F Burson in its own order while it runs, alerts included. The Mirror's
 * bookkeeping (its list and cursor) is kept as if its own pass had copied it, so it carries on from there when the Relay
 * stops. Returns the copy (the one already there, when it is), or null when there's nothing to copy.
 */
function mirrorCopyAlert_(sourceSpaceId, targetSpaceId, m) {
  mirrorTargetCheck_(sourceSpaceId, targetSpaceId);
  const text = zapierMirrorText_(m);
  if (!text) return null;
  const { cursor, cursorKey } = mirrorState_(sourceSpaceId, targetSpaceId, Date.now());
  const copy = mirrorPostMessage_(targetSpaceId, text, m.name, m);
  rememberMirrorSource_(copy && copy.name, m.createTime);
  const done = recentCache_('mirror:' + targetSpaceId);
  done.add(m.name, m.createTime);
  done.save();
  if (m.createTime > cursor) PropertiesService.getScriptProperties().setProperty(cursorKey, String(m.createTime));
  return copy;
}

/** True only for top-level Zapier/app posts (never human messages, never thread replies, never our own bot posts). */
function isZapierMirrorCandidate_(m, botUser) {
  if (!m || m.threadReply) return false;
  if (m.clientId && /^client-(?:bqa|zrlo)-/.test(String(m.clientId))) return false;  // the bot's own, an analyst's it relayed
  if (!m.clientId && botUser && m.senderName === botUser &&
    (typeof isBotFormattedText_ === 'function' ? isBotFormattedText_(m.text) : String(m.text || '').trim().indexOf(GEN.prefix) === 0)) return false;
  return m.senderType === 'BOT' || /\bzapier\b/i.test(String(m.senderDisplay || ''));
}

/** Clean Zapier alert text to mirror (strips "Zap sent by @..." credit line; falls back to card text when needed). */
function zapierMirrorText_(m) {
  if (!m) return '';
  const clean = s => (/^[ \t]*Zap sent by @/im.test(String(s || '')) ? String(s).replace(ZAPIER_CREDIT_RX_, '').trim() : String(s || '').trim());
  const sender = String(m.senderDisplay || '');
  let text = clean(m.text);
  if (m.cardText) {
    const card = clean(m.cardText);
    const isAlert = t => !!t && detectAlert_(t, parseAlert_(t), sender);
    if (card && (!text || (!isAlert(text) && isAlert(card)))) text = card;
  }
  return truncate_(text, MAX_TEXT_);
}

/**
 * When the original Zapier post reached the live Burson space, kept for its copy (6 hours: the bot reviews a copy within
 * a minute or two). The bot's alert row records it (source_at), so the Speed tab times the bot from the same moment
 * the IMs saw the alert.
 */
function rememberMirrorSource_(copyName, at) {
  if (!copyName || !at) return;
  try { CacheService.getScriptCache().put('zmsrc:' + copyName, String(at), 21600); } catch (e) {}
}

/** The live post's time (ms) for a mirrored copy's message name, or 0. */
function mirrorSourceAt_(name) {
  if (!name) return 0;
  try { return Number(CacheService.getScriptCache().get('zmsrc:' + name)) || 0; } catch (e) { return 0; }
}

/**
 * Posts a mirrored Zapier message as a top-level message in `targetSpaceId` with a `client-zmir-` idempotency key.
 * Uses `client-zmir-` (not `client-bqa-`) so the bot treats the mirrored post in `targetSpaceId` as an incoming
 * Zapier alert rather than one of its own replies. The id is kept by the bot whether or not Chat takes custom ids
 * (Chat.gs botPostId_), and so is which live message the copy is (`live`: the live message, {name, thread}; else
 * `sourceMessageName` when that's a message: rememberMirrorPair_), so the copy is paired with it either way.
 * `attachments` (optional; only a Direct BigQuery card's picture, BigQuery.gs bqPostCard_): Chat.gs chatUploadImage_'s,
 * uploaded to `targetSpaceId` first. The Mirror's and the Relay's copies never carry any.
 */
function mirrorPostMessage_(targetSpaceId, text, sourceMessageName, live, attachments) {
  if (!targetSpaceId || targetSpaceId === sfBursonId_() || outsideSpace_(targetSpaceId)) {
    throw new Error(`Refusing to post mirrored message into ${targetSpaceId}.`);
  }
  const hex = sha256Hex_(targetSpaceId + '|zmir:' + sourceMessageName);
  const query = { requestId: uuidFromHex_(hex) };
  const intendedId = MIRROR_CLIENT_ID_PREFIX_ + hex.slice(0, 40);
  let clientId = '';
  if (!clientIdsOff_()) {
    clientId = intendedId;
    query.messageId = clientId;
  }
  const body = { text: String(text), markupSyntax: CHAT_MARKUP_ };  // read as in the live space (Chat.gs)
  if (attachments && attachments.length) body.attachment = attachments;
  const done = msg => {
    rememberBotUser_(msg);
    rememberMirrorPair_(targetSpaceId, live || { name: sourceMessageName }, msg);
    return msg;
  };
  let r = chatCall_('post', targetSpaceId + '/messages', { query, body, intendedId });
  if (r.code === 409 && clientId) {
    const got = chatCall_('get', targetSpaceId + '/messages/' + clientId);
    if (got.code < 300) return done(normalizeMessage_(got.body));
    throw chatError_(got, 'reading back ' + clientId);
  }
  if (r.code === 400 && clientId && /message_?id/i.test(r.text)) {
    PropertiesService.getScriptProperties().setProperty(CLIENT_IDS_OFF_PROP_, String(Date.now()));
    delete query.messageId;
    r = chatCall_('post', targetSpaceId + '/messages', { query, body, intendedId });
  }
  if (r.code >= 300) throw chatError_(r, 'mirroring to ' + targetSpaceId);
  return done(normalizeMessage_(r.body));
}

/**
 * Which live message a copy in `targetSpaceId` is (`live`: {name, thread, text}; only a message, never a Direct BigQuery
 * post's key), both ways, for 6 hours (the script cache): liveForCopy_ and mirrorCopyOf_ (Relay.gs) read it before
 * anything else, so a copy is paired with its live alert whether or not Chat took custom ids. The Alert log keeps the
 * pair for good once the bot takes the alert (Bot.gs handleAlert_: live_message, live_thread). Never throws.
 */
function rememberMirrorPair_(targetSpaceId, live, copy) {
  try {
    const liveName = String((live && live.name) || '');
    if (!targetSpaceId || !copy || !copy.name || !/^spaces\/[^/]+\/messages\//.test(liveName)) return;
    const cache = CacheService.getScriptCache();
    cache.put('zmlive:' + copy.name, JSON.stringify({ name: liveName, thread: String((live && live.thread) || ''),
      text: truncate_(String((live && live.text) || ''), 200) }), 21600);
    cache.put(mirrorCopyKey_(targetSpaceId, liveName), JSON.stringify({ name: copy.name, thread: copy.thread || '',
      createTime: copy.createTime || 0 }), 21600);
  } catch (e) {
    console.warn('could not remember which live alert a copy is: ' + ((e && e.message) || e));
  }
}

/** The script-cache key for the copy of live message `liveName` in `targetSpaceId` (rememberMirrorPair_). Pure. */
function mirrorCopyKey_(targetSpaceId, liveName) {
  return 'zmcopy:' + hashText_(String(targetSpaceId) + '|' + String(liveName));
}

/** The live message a copy is ({name, thread, text}), as rememberMirrorPair_ kept it, or null. Never throws. */
function mirrorPairOf_(copyName) {
  if (!copyName) return null;
  try {
    const hit = CacheService.getScriptCache().get('zmlive:' + copyName);
    const v = hit && hit !== '-' ? JSON.parse(hit) : null;
    return v && v.name ? v : null;
  } catch (e) {
    return null;
  }
}

/** Ensures Row 9 ("Mirror space") exists on the Control tab without shifting Row 10 ("How it works"). */
function ensureMirrorRow_(sh) {
  if (!sh) return;
  if (String(sh.getRange(MIRROR_ROW_, 1).getValue() || '').trim() === MIRROR_LABEL_) return;
  const currentB9 = String(sh.getRange(MIRROR_ROW_, 2).getValue() || '').trim();
  const currentC9 = String(sh.getRange(MIRROR_ROW_, 3).getValue() || '').trim();
  sh.getRange(MIRROR_ROW_, 1, 1, 3).setValues([[MIRROR_LABEL_, currentB9, currentC9 || MIRROR_HINT_]]);
  sh.getRange(MIRROR_ROW_, 1).setFontWeight('bold');
  sh.getRange(MIRROR_ROW_, 2).setBackground('#fff8e1');
}

function writeMirrorNote_(sh, note) {
  if (!sh) return;
  const cell = sh.getRange(MIRROR_ROW_, 3);
  if (String(cell.getValue() || '') !== String(note || '')) cell.setValue(note || '');
}
