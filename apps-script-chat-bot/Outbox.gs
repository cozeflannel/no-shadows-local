/**
 * Outbox.gs — "Post in S-F Burson" (Control tab row 24) and the Burson outbox tab: the only way anything reaches S-F
 * Burson (the space in the Control tab's B25, this run's: Config.gs sfBurson_), from any flow.
 *
 * Nothing the bot does writes in S-F Burson directly. Every post, thread reply or reaction the bot (guardedChat_,
 * Main.gs: the main flow when the Burson space is S-F Burson) or the relay (Relay.gs) wants to put there goes through
 * bursonOutbox_(…).add():
 *   Post in S-F Burson OFF   nothing is written and nothing is queued. The flow goes on as if it was done (no error, so
 *                            no retry and no failed message), and the run log says how many were withheld.
 *   ON                       one row on the bot's Burson outbox tab, Pending: Queued (ET) · Kind (post / reply /
 *                            reaction) · Where (a link to the thread or message) · Text or emoji · From (bot, or relay:
 *                            the analyst's name) · Status · Note · a hidden key (with the S-F Burson space it's for).
 *                            Still nothing is written.
 * A person reads each row and sets its Status to Send (after editing the text, if they like) or Skip. Each run
 * (sendBursonOutbox_, from poll()) writes the rows set to Send, each once, top to bottom:
 *   - only while Bot (B2) and Post in S-F Burson are ON, read again from the Control tab right before each write: OFF
 *     stops it at once, and puts the rows still at Send back to Pending (set Send again once it's back ON);
 *   - only while S-F Burson is known (B25 set and found): blank or not found, the rows wait and nothing new is queued;
 *     a row queued for another S-F Burson space (B25 changed since) is Blocked, never sent;
 *   - only from the bot's own account ("Runs as", B8): run by anyone else, the rows wait; never in a dry run;
 *   - what's in the Text cell is checked first with a wider guard than the bot's own (outboxGuardHits_): a hit makes the
 *     row Blocked, with the reason, and nothing is sent;
 *   - then Sent (with a link to the message) or Failed (with the reason). A Failed or Blocked row is never tried again
 *     unless someone sets it to Send again; a Sent one is never sent twice (its key says it went);
 *   - never while the bot is in Testing (Main.gs runMode_: the Safety valve ON, or a Burson test copy in B26): a row set
 *     to Send goes back to Pending, saying so; both are read again right before each row.
 * Turning the switch ON never sends a row by itself: only a row someone set to Send goes.
 *
 * Chat.gs (chatCall_) refuses every other write in S-F Burson: only while sendBursonOutbox_ writes a row can anything go
 * there. The tab is the bot's own (its header row says so: isOutboxTab_); a tab with that name that the bot didn't make
 * is never read or written. It's protected with a warning, so people are asked before they edit it.
 *
 * A space people outside Google can join that isn't S-F Burson is never written at all (guardedChat_, Main.gs): what the
 * bot would write there is held back, like Post in S-F Burson OFF, and counted here for the run log (outboxHeldBack_).
 */

const OUTBOX_TAB_ = 'Burson outbox';
const OUTBOX_HEADER_ = ['Queued (ET)', 'Kind', 'Where', 'Text or emoji', 'From', 'Status', 'Note',
  'Key (written by the Burson QA bot)'];  // the last column is hidden; the header row is how the bot knows the tab is its own
const OUTBOX_WHERE_COL_ = 3;
const OUTBOX_TEXT_COL_ = 4;
const OUTBOX_STATUS_COL_ = 6;
const OUTBOX_KEY_COL_ = 8;
const OUTBOX_CHOICES_ = ['Pending', 'Send', 'Skip'];  // the bot sets Sent, Blocked or Failed
const OUTBOX_READ_ROWS_ = 2000;     // the latest rows, read each run that has something to send or queue
const OUTBOX_MAX_PER_RUN_ = 20;     // rows written per run (the rest go on the next one)
const OUTBOX_SEND_MS_ = 20 * 1000;  // ...and at most this long
const OUTBOX_MAX_CHARS_ = 4000;     // Chat's limit is 4,096
const CHAT_ROOM_URL_ = 'https://chat.google.com/room/';
// C24 while no S-F Burson is known (Control tab B25 blank or not found): nothing is sent, and nothing new is queued
const OUTBOX_NO_SFB_ = 'not sending or queuing: the S-F Burson space (B25) is blank or can\'t be found';

let OUTBOX_RUN_ = null;        // this run: {withheld: {post, reply, reaction}, queued: {…}, held: {…}, refused, keys}
let OUTBOX_WRITING_ = false;   // true only while sendBursonOutbox_ writes a row (Chat.gs refuses S-F Burson otherwise)

/** A new run: nothing withheld, queued or held back yet. */
function outboxRunStart_() {
  OUTBOX_RUN_ = { withheld: { post: 0, reply: 0, reaction: 0 }, queued: { post: 0, reply: 0, reaction: 0 },
    held: { post: 0, reply: 0, reaction: 0 }, refused: 0, keys: null };
  return OUTBOX_RUN_;
}

function outboxRun_() { return OUTBOX_RUN_ || outboxRunStart_(); }

/** True only while the outbox writes a row someone set to Send (Chat.gs chatCall_). */
function outboxWriting_() { return OUTBOX_WRITING_ === true; }

/**
 * The run's way to S-F Burson (buildCtx_, Main.gs): add(write) queues it on the Burson outbox tab only while Post in
 * S-F Burson is ON and the run is LIVE (Main.gs runMode_); otherwise it's withheld. `switches`: the run's switches (a
 * function); `sfbId`: this run's S-F Burson (Control tab B25; '' when none is known: nothing is queued); `live`: a
 * function, true while the run is LIVE (left out: Testing). Never throws, never writes in S-F Burson.
 */
function bursonOutbox_(ss, switches, sfbId, live) {
  return {
    on() {
      try {
        const sw = switches && switches();
        return !!(sw && sw.postBurson === true) && !!(live && live() === true);
      } catch (e) {
        return false;
      }
    },
    add(write) { return this.on() ? outboxQueue_(ss, write, sfbId) : outboxWithheld_(write); },
  };
}

/** Post in S-F Burson is OFF: nothing is written or queued; counted for the run log. */
function outboxWithheld_(write) {
  const run = outboxRun_();
  const kind = outboxKind_(write);
  run.withheld[kind] = (run.withheld[kind] || 0) + 1;
  return { withheld: true };
}

/**
 * A space people outside Google can join that isn't S-F Burson (guardedChat_, Main.gs): nothing is written or queued,
 * as with Post in S-F Burson OFF; counted for the run log.
 */
function outboxHeldBack_(write) {
  const run = outboxRun_();
  const kind = outboxKind_(write);
  run.held = run.held || { post: 0, reply: 0, reaction: 0 };
  run.held[kind] = (run.held[kind] || 0) + 1;
  return { held: true };
}

function outboxKind_(w) { return w && w.kind === 'reaction' ? 'reaction' : w && (w.thread || (w.relay && w.relay.pt)) ? 'reply' : 'post'; }

/**
 * A write as a row (pure but for the time): {kind, k (what makes it the same write again), cell (Text or emoji), from,
 * key (the hidden key, with s: the S-F Burson space it's for)}, or null when it isn't a write in S-F Burson `sfbId`
 * (this run's, Control tab B25; '' when none is known: never). The key of the bot's own answer to Burson's question
 * also keeps tx, the fingerprint of its text (outboxTextPrint_), when that text opens as a thread note does: at Send
 * only that very text is checked as the answer it is (outboxAnswerAsQueued_). Every other row's key is as it always
 * was. write: {kind: 'post' | 'reply' | 'reaction', text,
 * thread, message, emoji, key (the post's own key: Chat's message id comes from it), prefix (that id's prefix), from
 * ('bot' or 'relay: Name'), relay ({m: Mirror space, tm, tt: the analyst's message and thread, who, user, what, rk: its
 * Relay tab key, pt: the Mirror thread whose first message is still on the outbox})}.
 */
function outboxItem_(w, sfbId) {
  if (!w || !sfbId) return null;
  const kind = outboxKind_(w);
  const thread = String(w.thread || '');
  if (kind === 'reaction') {
    const message = String(w.message || '');
    if (message.indexOf(sfbId + '/messages/') !== 0 || !w.emoji) return null;
    const k = 'r|' + message + '|' + bareEmoji_(w.emoji) + (w.relay ? '|relay' : '');
    return { kind, k, cell: String(w.emoji), from: String(w.from || 'bot'),
      key: outboxClean_({ v: 1, k, kind, s: sfbId, message, emoji: String(w.emoji), relay: w.relay || undefined }) };
  }
  if (thread && thread.indexOf(sfbId + '/threads/') !== 0) return null;
  const text = truncate_(String(w.text || ''), OUTBOX_MAX_CHARS_);
  if (!text.trim()) return null;
  const k = 'p|' + (w.key ? String(w.key) : hashText_(thread + '|' + text));
  const tx = !w.relay && outboxOwnAnswerKey_(w.key) && outboxNoteHits_(text).length ? outboxTextPrint_(text) : '';
  return { kind, k, cell: text, from: String(w.from || 'bot'),
    key: outboxClean_({ v: 1, k, kind, s: sfbId, thread, ck: String(w.key || ''), p: String(w.prefix || ''), tx, relay: w.relay || undefined }) };
}

function outboxClean_(o) { Object.keys(o).forEach(k => { if (o[k] === undefined || o[k] === '') delete o[k]; }); return o; }

/** Queues a write as a Pending row (once: the same write again is left as it is), for S-F Burson `sfbId`. Never throws. */
function outboxQueue_(ss, write, sfbId) {
  const run = outboxRun_();
  try {
    const item = outboxItem_(write, sfbId);
    if (!item) {
      run.refused++;
      console.error('Burson outbox: not queued (not a write in S-F Burson): ' + truncate_(JSON.stringify(write || {}), 300));
      return { queued: false, why: 'not a write in S-F Burson' };
    }
    const sh = outboxTab_(ss, true);
    if (!sh) {
      run.refused++;
      const why = `a tab named "${OUTBOX_TAB_}" that the bot didn't make is in the way: rename it, and the bot makes its own`;
      console.error('Burson outbox: not queued: ' + why);
      noteSwitch_('postBurson', '⚠️ ' + why);
      return { queued: false, why };
    }
    const keys = outboxKeys_(sh);
    if (keys.has(item.k)) return { queued: true, again: true };
    sh.appendRow([outboxTime_(Date.now()), item.kind, outboxWhere_(item.key), outboxCell_(item.cell), outboxCell_(item.from),
      'Pending', '', JSON.stringify(item.key)]);
    const row = sh.getLastRow();
    sh.getRange(row, OUTBOX_STATUS_COL_).setDataValidation(outboxRule_(OUTBOX_CHOICES_));
    keys.add(item.k);
    run.queued[item.kind] = (run.queued[item.kind] || 0) + 1;
    return { queued: true, row };
  } catch (e) {
    run.refused++;
    console.error('Burson outbox: couldn\'t queue a write: ' + ((e && e.stack) || e));
    return { queued: false, why: String((e && e.message) || e) };
  }
}

/** Is this the outbox tab the bot made? Its header row is the bot's own (a tab people made never matches). */
function isOutboxTab_(sh) {
  if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < OUTBOX_HEADER_.length) return false;
  return JSON.stringify(sh.getRange(1, 1, 1, OUTBOX_HEADER_.length).getValues()[0].map(v => String(v).trim())) ===
    JSON.stringify(OUTBOX_HEADER_);
}

/**
 * The bot's Burson outbox tab, made (protected with a warning, the key column hidden) when missing and `create`. null
 * when there's none, or when a tab with its name exists that the bot didn't make: that tab is never read or written.
 */
function outboxTab_(ss, create) {
  let sh = ss.getSheetByName(OUTBOX_TAB_);
  if (sh) return isOutboxTab_(sh) ? sh : null;
  if (!create) return null;
  sh = ss.insertSheet(OUTBOX_TAB_);
  sh.getRange(1, 1, 1, OUTBOX_HEADER_.length).setValues([OUTBOX_HEADER_]);
  try { sh.getRange(1, 1, 1, OUTBOX_HEADER_.length).setFontWeight('bold'); } catch (e) {}
  try { sh.setFrozenRows(1); } catch (e) {}
  try {
    sh.protect().setDescription('Written by the Burson QA bot: set Status to Send or Skip (edit Text or emoji first if you like)')
      .setWarningOnly(true);
  } catch (e) {}
  try { sh.hideColumns(OUTBOX_KEY_COL_); } catch (e) {}
  try { [130, 80, 320, 520, 170, 90, 380].forEach((w, i) => sh.setColumnWidth(i + 1, w)); } catch (e) {}
  return sh;
}

/** The writes already on the tab (their k), read once a run. */
function outboxKeys_(sh) {
  const run = outboxRun_();
  if (run.keys) return run.keys;
  const keys = new Set();
  const last = sh.getLastRow();
  if (last >= 2) {
    const first = Math.max(2, last - OUTBOX_READ_ROWS_ + 1);
    sh.getRange(first, OUTBOX_KEY_COL_, last - first + 1, 1).getValues().forEach(r => {
      const key = outboxKeyOf_(r[0]);
      if (key && key.k) keys.add(String(key.k));
    });
  }
  run.keys = keys;
  return keys;
}

function outboxKeyOf_(cell) {
  try { const key = JSON.parse(String(cell || '')); return key && typeof key === 'object' ? key : null; } catch (e) { return null; }
}

function outboxRule_(values) { return SpreadsheetApp.newDataValidation().requireValueInList(values, true).build(); }

/** A cell the bot writes: never read as a formula. */
function outboxCell_(s) { const v = String(s === undefined || s === null ? '' : s); return /^[=+\-@]/.test(v) ? '\'' + v : v; }

function outboxTime_(ms) { return Utilities.formatDate(new Date(ms), GEN.timezone || 'America/New_York', 'yyyy-MM-dd HH:mm'); }

/** A link to a message in S-F Burson ("spaces/S/messages/T.M" -> …/room/S/T/M; the space when the id doesn't say). Pure. */
function outboxMessageLink_(name) {
  const [space, id] = String(name || '').split('/messages/');
  const room = CHAT_ROOM_URL_ + String(space || '').replace(/^spaces\//, '');
  if (!id) return room;
  const dot = id.indexOf('.');
  return dot > 0 ? `${room}/${id.slice(0, dot)}/${id.slice(dot + 1)}` : `${room} (message ${id})`;
}

/** Where a row's write goes, for the Where column: the thread, the message, or the space (a new message). Pure. */
function outboxWhere_(key) {
  const room = CHAT_ROOM_URL_ + outboxKeySpace_(key).replace(/^spaces\//, '');
  if (key.kind === 'reaction') return outboxMessageLink_(key.message);
  if (key.thread) return `${room}/${String(key.thread).split('/threads/')[1] || ''}`;
  if (key.relay && key.relay.pt) return 'the thread of its first message, once that row is sent';
  return room;
}

/** The S-F Burson space a row's key was queued for: its s, else its message's or thread's space ('' if it doesn't say). */
function outboxKeySpace_(key) {
  const k = key || {};
  if (k.s) return String(k.s);
  const m = String(k.message || k.thread || '').match(/^(spaces\/[^/]+)\/(?:messages|threads)\//);
  return m ? m[1] : '';
}

/** The space a Where cell links to ("https://chat.google.com/room/S…" -> "spaces/S"), or '': rows from before keys had s. */
function outboxWhereSpace_(cell) {
  const m = String(cell || '').match(/chat\.google\.com\/room\/([A-Za-z0-9_-]+)/);
  return m ? 'spaces/' + m[1] : '';
}

/** Post in S-F Burson and Bot (B2) both still ON, read again now from the Control tab. False when it can't be read. */
function postBursonStillOn_(control) {
  try {
    if (!control) return false;
    if (!parseControl_(control.getRange(2, 2).getValue(), '', '').on) return false;
    return !!readSwitches_(control).postBurson;
  } catch (e) {
    return false;
  }
}

/** The Safety valve (row 29) is ON, read again now from the Control tab. True when it can't be read (fail closed). */
function safetyValveStillOn_(control) {
  try {
    if (!control) return true;
    const rows = switchRows_();
    const i = CONTROL_SWITCHES_.findIndex(s => s.key === 'safetyValve');
    const cells = control.getRange(rows[i], 1, 1, 2).getValues()[0];
    return !!parseSwitches_(CONTROL_SWITCHES_.map((s, j) => (j === i ? cells : []))).safetyValve;
  } catch (e) {
    return true;
  }
}

/** Why this run can't write in S-F Burson as the bot ('' when it can): it runs as someone else than "Runs as" (B8). */
function outboxNotTheBot_(control) {
  const email = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  const bot = String(control.getRange(8, 2).getValue() || '').trim().toLowerCase();
  if (!bot) return '"Runs as" (B8) is blank: run setup() from the bot\'s account';
  if (email !== bot) return `this run is from ${email || 'another account'}, not the bot's account in "Runs as" (B8)`;
  return '';
}

// ---------------------------------------------------------------------------------------------------------------
// The wider guard: what goes to S-F Burson from the outbox, whoever wrote it
// ---------------------------------------------------------------------------------------------------------------

/**
 * Beyond the bot's own guard (GUARD_PATTERNS_, unchanged): the internal setup, the tools and the people behind it. The
 * bot by the names people give it here ("the bot", "our bot", "my bot", "QA bot", "triage bot"), never the bare word:
 * analysts' messages go through this too, and a robot, a chatbot, bots or "a bot account" in a post are theirs to say.
 */
const OUTBOX_GUARD_PATTERNS_ = [
  /\bauto[\s-]*correct\w*/i, /\bwrite-?backs?\b/i, /\bwritten\s+back\b/i, /\bslrr\b/i, /\bmirror(?:s|ed|ing)?\b/i,
  /\brelay(?:s|ed|ing)?\b/i, /\b(?:the|our|my)\s+bot\b/i, /\b(?:qa|q&a|triage)[\s-]*bot\b/i,
  /\bautomat(?:ion|ions|ed|ically)\b/i, /\bauto[\s-]*(?:sent|submitted)\b/i,
  /\bzapier\b/i, /\bstand-?ins?\b/i, /\boutbox(?:es)?\b/i, /\b(?:control|relay|results)\s+tab\b/i, /\banalyst\s+space\b/i,
];

/**
 * The notes the bot puts under a card in the Auto-correct space (ThreadNotes.gs; their first words are Voice.gs
 * THREAD_NOTE_HEADS_) are never for Burson: a text or a line that starts with one (after an emoji and one of Chat's
 * marks, bold, italic or struck through, or not), and the words as a note has them anywhere in a text (someone quoting
 * the note, in whatever mark: the colon may stand inside the mark or after it). Only in those forms: "the alert
 * requirements" in a sentence, or a story someone is "part of", is theirs to say. Before and after the words stands
 * anything but a letter or a digit (not \b: an italic mark is a word character to it, so "_Part of a story:_" would
 * pass). A note with new first words gets its pattern here, in the shape of the "Part of a story" one.
 *
 * They hold a text on every way to S-F Burson but one: the bot's own answer to a question of Burson's (its "ans:" post,
 * outboxOwnAnswerKey_). Gemini writes that answer from a context whose rules stand under "[Alert requirements]" (Voice.gs
 * answerPrompts_), so an answer may well open with those words, and it is no note: a note is posted only by
 * ThreadNotes.gs acThreadNote_, in the Auto-correct space, whose flow passes nothing on to S-F Burson. Held for these
 * words, an answer would reach Burson as the fixed answer in its place (ownAnswerFallback_), which it never did before
 * the notes existed. An analyst's message and every other reply of the bot's are held as the patterns say, and so is
 * the answer's own outbox row once someone has edited its text (outboxAnswerAsQueued_).
 */
const OUTBOX_NOTE_PATTERNS_ = [
  /(?<![A-Za-z0-9])flagged by the watch(?![A-Za-z0-9])/i,
  /(?<=(?:^|\n)[ \t]*(?:[^\x00-\x7F]{1,8}[ \t]+)?[*_~]?)Part of a story(?![A-Za-z0-9])|(?<![A-Za-z0-9])Part of a story[*_~]?:/,
  /(?<=(?:^|\n)[ \t]*(?:[^\x00-\x7F]{1,8}[ \t]+)?[*_~]?)Alert requirements(?![A-Za-z0-9])|(?<![A-Za-z0-9])Alert requirements(?:, final)?[*_~]?:/,
  /(?<![A-Za-z0-9])Same story: \d[\d,]* more posts?(?![A-Za-z0-9])/,  // the watch's reply only in its own shape: "Same story:" is analysts' wording too
];

/**
 * What `text` names that Burson must not see: the bot's own guard (guardHits_, with `guard`.terms: the spaces' names
 * and ids), the relay's (relayGuardHits_: a test space, a space's id), OUTBOX_GUARD_PATTERNS_ and the thread notes'
 * first words (OUTBOX_NOTE_PATTERNS_). `ownAnswer` true (only for the bot's own answer to Burson's question:
 * outboxOwnAnswerKey_): without the thread notes' first words, so that answer is checked as it always was. Product,
 * exposure tag and Sensitive Topic names are set aside first. Pure.
 */
function outboxGuardHits_(text, guard, ownAnswer) {
  const hits = guardHits_(text, guard).concat(relayGuardHits_(text));
  const t = String(text || '').replace(taxonomyRx_(), ' ');
  OUTBOX_GUARD_PATTERNS_.forEach(re => {
    const m = t.match(re);
    if (m) hits.push(m[0]);
  });
  return ownAnswer === true ? hits : hits.concat(outboxNoteHits_(text));
}

/**
 * What `text` holds of the thread notes' first words (OUTBOX_NOTE_PATTERNS_), the product, exposure tag and Sensitive
 * Topic names set aside first: the part of outboxGuardHits_ that the bot's own answer to Burson is let off. Pure.
 */
function outboxNoteHits_(text) {
  const t = String(text || '').replace(taxonomyRx_(), ' ');
  const hits = [];
  OUTBOX_NOTE_PATTERNS_.forEach(re => {
    const m = t.match(re);
    if (m) hits.push(m[0]);
  });
  return hits;
}

/**
 * True for the key of the bot's own answer to a question of Burson's (Bot.gs handleHuman_ posts it with "ans:" + the
 * question's message): as bursonOut_ hands it over ("ans:…"), and as a Burson outbox row keeps it ("ans:…" when the main
 * flow queued it, "own:ans:…" when it came from the Mirror space: forwardOwnBurson_). Never an analyst's answer
 * ("anaans:…") nor anything the Relay queued. Pure.
 */
function outboxOwnAnswerKey_(key) {
  return /^(?:own:)?ans:/.test(String(key === undefined || key === null ? '' : key));
}

/**
 * The fingerprint of a text as a Burson outbox row holds it, the same for the text the bot queues (outboxItem_) and for
 * the Text cell read back at Send: without the apostrophe outboxCell_ puts before a first character Sheets would read
 * as a formula, with one kind of line end, and trimmed (the cell is sent trimmed). Pure.
 */
function outboxTextPrint_(text) {
  const t = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n').replace(/^'/, '').trim();
  return sha256Hex_(t).slice(0, 16);
}

/**
 * At Send: true only for the row of the bot's own answer to a question of Burson's (outboxOwnAnswerKey_; never a row the
 * Relay queued) whose Text cell still holds the very text the bot queued (`key`.tx: its fingerprint, kept by
 * outboxItem_ when that text opens as a thread note does). Only then is the row checked as that answer always was,
 * without the thread notes' first words (outboxGuardHits_'s ownAnswer). An answer someone edited since, an answer that
 * never needed it and one queued before the fingerprint was kept are checked as every other row is: a note typed or
 * pasted into an answer's row doesn't go to S-F Burson. Pure.
 */
function outboxAnswerAsQueued_(key, cell) {
  const k = key || {};
  return !k.relay && outboxOwnAnswerKey_(k.ck) && !!k.tx && k.tx === outboxTextPrint_(cell);
}

/**
 * The names and ids of the Google-only spaces (analyst, Mirror, auto-correct, Burson test copy, Other alerts space), for
 * outboxGuardHits_.
 */
function outboxGuard_(wanted) {
  const props = PropertiesService.getScriptProperties();
  const terms = [props.getProperty('LAST_ANALYST_NAME'), String(props.getProperty('LAST_ANALYST_SPACE') || '').replace(/^spaces\//, ''),
    props.getProperty('LAST_OS_NAME')];
  [wanted && wanted.analyst, wanted && wanted.mirror, wanted && wanted.autocorrect, wanted && wanted.testCopy,
    wanted && wanted.otherSpace].forEach(v => {
    if (!v) return;
    try {
      const ref = parseSpaceRef_(v, '');
      terms.push(ref.id ? ref.id.replace(/^spaces\//, '') : ref.name);
    } catch (e) { /* a blank cell */ }
  });
  return { terms: terms.filter(t => t && String(t).length > 3) };
}

/** '' when `emoji` can go on a message in S-F Burson, else why not. */
function outboxEmojiProblem_(emoji) {
  const e = String(emoji || '').trim();
  if (!e || e.length > 16 || /[A-Za-z0-9\s]/.test(e)) return 'it isn\'t a single emoji';
  const entry = legendByEmoji_(e);
  const never = new Set((GEN.settings && GEN.settings.never_mirror) || []);
  if (entry && never.has(entry.code)) return `${e} is never shown to Burson`;
  return '';
}

// ---------------------------------------------------------------------------------------------------------------
// Post in S-F Burson (row 24) from the Mirror space: the bot's own Burson replies and emojis
// ---------------------------------------------------------------------------------------------------------------

/**
 * In the Mirror space (B9, outbounds blocked) the bot works each alert as if in S-F Burson (Bot.gs bursonOut_: asking
 * Burson to fix and resend, answering Burson, the legend emojis). With Post in S-F Burson (row 24) ON, each one, once
 * done there, goes where S-F Burson would get it, on the S-F Burson message behind the Mirror one (ownSfbBehind_):
 *   Testing (Main.gs runMode_) with a Burson test copy (B26 usable): straight into the test copy, on (or under) that
 *     message's copy there (the Test copy tab's pairs, ctx.copyState); never S-F Burson;
 *   LIVE: on the Burson outbox for S-F Burson (bursonOutbox_), waiting for a person to set Send, like the analysts'.
 * Nothing goes for anything else: row 24 OFF, Testing with no test copy (the Safety valve ON with B26 blank), the
 * auto-correct space, a dry run, a Mirror message with nothing in S-F Burson behind it (or no copy of it in the test copy
 * yet), a reply that would show internal details (outboxGuardHits_), or an emoji never shown to Burson. One exception:
 * the bot's answer to Burson's question that would show internal details goes as the fixed answer instead
 * (ownAnswerFallback_), so Burson gets an answer rather than none; the Mirror space keeps the answer as it was. Never the
 * bot's notes for analysts, outcome or watch notes, or early-wave warnings: only what bursonOut_ does. `a`: {type: 'react',
 * name, emoji} or {type: 'post', text, thread, key}. Never throws (a failure is logged). 'copy', 'queued' or ''.
 */
function forwardOwnBurson_(ctx, a) {
  const what = a && a.type === 'react' ? `its ${a.emoji}` : 'its reply';
  try {
    if (!ctx || !a || !ctx.outboundBlocked || ctx.sourceReadOnly || (ctx.settings && ctx.settings.dry_run)) return '';
    if (!switchOn_(ctx, 'postBurson') || !(ctx.sfBurson && ctx.sfBurson.id)) return '';
    const live = ctx.live === true;
    const copyId = live ? '' : String((ctx.testCopy && ctx.testCopy.id) || '');
    if (!live && !copyId) return '';  // Testing with no test copy: nothing goes to any Burson space
    const react = a.type === 'react';
    if (react ? outboxEmojiProblem_(a.emoji) : !String(a.text || '').trim()) return '';
    let text = react ? '' : a.text;  // what goes: the reply as it is, or the fixed answer in its place (below)
    if (!react) {
      const guard = ctx.ownGuard || guardFor_(ctx);
      // its answer to Burson's question is checked as it always was: never held for a thread note's first words
      const hits = outboxGuardHits_(text, guard, outboxOwnAnswerKey_(a.key));
      if (hits.length) {
        const fixed = ownAnswerFallback_(ctx, a, guard);
        if (!fixed) {
          ctx.log(`Post in S-F Burson: the bot's reply stays in the Mirror space: it mentions "${truncate_(hits[0], 60)}"`);
          return '';
        }
        ctx.log(`Post in S-F Burson: the bot's answer mentions "${truncate_(hits[0], 60)}", so the fixed answer goes in its place`);
        text = fixed;
      }
    }
    const target = react ? ownSfbBehind_(ctx, a.name, false) : (a.thread ? ownSfbBehind_(ctx, a.thread, true) : '');
    if (!target && (react || a.thread)) return '';  // nothing in S-F Burson behind it (a Direct BigQuery alert, an older one)
    if (live) {
      if (!ctx.outbox) return '';
      const res = ctx.outbox.add(react ? { kind: 'reaction', message: target, emoji: a.emoji, from: 'bot' }
        : { kind: target ? 'reply' : 'post', text, thread: target, key: a.key ? 'own:' + a.key : '', from: 'bot' });
      return res && res.queued ? 'queued' : '';
    }
    const st = ctx.copyState;
    if (!st) return '';
    if (react) {
      const onCopy = st.liveToCopy.get(target);
      if (!onCopy) return '';
      testCopyReact_(copyId, onCopy, a.emoji);
    } else {
      const thread = target ? (st.liveThreadToCopy.get(target) || (st.olderThread ? st.olderThread(target) : '')) : '';
      if (target && !thread) return '';
      testCopyPost_(copyId, text, thread || null, 'own:' + (a.key || hashText_(String(a.text))), '');
    }
    ctx.log(`Post in S-F Burson: ${what} went straight to the Burson test copy (Testing)`);
    return 'copy';
  } catch (e) {
    console.error(`Post in S-F Burson: couldn't pass on ${what} from the Mirror space: ${(e && e.message) || e}`);
    return '';
  }
}

/**
 * For the bot's answer to Burson's question (bursonOut_'s "ans:" post, Bot.gs handleHuman_) that the wider guard
 * (outboxGuardHits_, with `guard`) holds back on its way to S-F Burson: the fixed answer in its place (Voice.gs
 * fallbackAnswer_: what the alert needed and its status, as when Gemini's answer fails the bot's own guard), so Burson
 * gets an answer rather than none. It lists only the resources whose name and link the wider guard lets through. ''
 * when `a` isn't an answer, or when the fixed answer would be held back too: nothing goes then, as before.
 */
function ownAnswerFallback_(ctx, a, guard) {
  if (!/^ans:/.test(String((a && a.key) || ''))) return '';
  const own = guardFor_(ctx);
  const row = a.thread ? ctx.store.alertByThread(a.thread) : null;
  const alert = voiceRow_(mergedAlertRow_(ctx, row), switchOn_(ctx, 'noWait'));
  const resources = usableResources_(ctx.resources, own).filter(r => !outboxGuardHits_(resourcesLine_([r]), guard, true).length);
  const text = fallbackAnswer_(alert, own, resources);
  return outboxGuardHits_(text, guard, true).length ? '' : text;
}

/**
 * The S-F Burson message (or, `isThread`, thread) behind a Mirror-space message or thread, in this run's S-F Burson
 * (B25), or '': the Relay tab's pairs when the Relay ran this run (ctx.relayState); else the Alert log's pair for the
 * alert (live_message, live_thread: kept for good once the bot took it); else the pair Mirror.gs kept when it copied the
 * alert, or the copy's id (Relay.gs liveBehindCopy_, liveForCopy_). None of it depends on Chat taking custom ids.
 */
function ownSfbBehind_(ctx, name, isThread) {
  const sfbId = String((ctx.sfBurson && ctx.sfBurson.id) || '');
  const mirrorId = ctx.spaces.burson.id;
  const inSfb = v => (v && String(v).indexOf(sfbId + '/') === 0 ? String(v) : '');
  const rs = ctx.relayState;
  if (rs) {
    const paired = isThread ? (rs.testThreadToLive.get(name) || (rs.olderThread ? rs.olderThread('test_thread', name) : ''))
      : rs.testToLive.get(name);
    if (inSfb(paired)) return inSfb(paired);
  }
  const row = alertRowForCopy_(ctx, name, isThread);
  if (row && inSfb(row.live_message)) {
    const got = inSfb(isThread ? row.live_thread : row.live_message);
    if (got) return got;
  }
  const root = isThread ? chatThreadRoot_(mirrorId, name) : ownMirrorMessage_(name);
  const sfbMsg = root ? liveBehindCopy_(ctx, mirrorId, root, sfbId) : null;
  return sfbMsg ? inSfb(isThread ? sfbMsg.thread : sfbMsg.name) : '';
}

/** A Mirror-space message, read (normalized), or null when it isn't there. */
function ownMirrorMessage_(name) {
  const r = chatCall_('get', String(name));
  if (r.code === 404 || r.code === 403) return null;
  if (r.code >= 300) throw chatError_(r, 'reading ' + name);
  return normalizeMessage_(r.body);
}

// ---------------------------------------------------------------------------------------------------------------
// Sending: the rows someone set to Send
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every run (poll(), with Bot ON): writes the Burson outbox rows set to Send, each once (see the top of this file), only
 * while the run is LIVE (`mode`: Main.gs runMode_). `control`: the Control tab; `wanted`: what it says (readControl_);
 * `sfb`: this run's S-F Burson (Control tab B25: {id, …}, or null when none is known: then nothing is sent and the rows
 * wait, C24 says why). Testing (the Safety valve ON, or B26 set): nothing is sent; a row set to Send goes back to
 * Pending, saying why. The Safety valve and B26 are read again right before each row. Returns {sent, blocked, failed,
 * reset, held, left} or null when there's no tab. Its own failures are logged, never thrown.
 */
function sendBursonOutbox_(ss, control, wanted, sfb, mode) {
  const known = !!(sfb && sfb.id);
  const sh = outboxTab_(ss, false);
  if (!sh || sh.getLastRow() < 2) {
    if (!known && postBursonStillOn_(control)) noteSwitch_('postBurson', OUTBOX_NO_SFB_);
    return null;
  }
  const last = sh.getLastRow();
  const first = Math.max(2, last - OUTBOX_READ_ROWS_ + 1);
  const all = sh.getRange(first, 1, last - first + 1, OUTBOX_HEADER_.length).getValues().map((v, i) => ({ row: first + i, v }));
  const pending = all.filter(x => /^pending$/i.test(String(x.v[OUTBOX_STATUS_COL_ - 1] || '').trim())).length;
  const rows = all.filter(x => /^send$/i.test(String(x.v[OUTBOX_STATUS_COL_ - 1] || '').trim()));
  const out = { sent: 0, blocked: 0, failed: 0, reset: 0, left: 0 };  // + held: rows held back while Testing
  const toPending = list => list.forEach(x => {
    if (outboxSet_(sh, x, 'Pending', 'not sent: Post in S-F Burson (Control tab row 24) was OFF. Set Send again to send it.')) out.reset++;
  });
  const testingNote = why => `not sent: the bot is in Testing (${why}), so nothing goes to S-F Burson. Set Send again ` +
    'once it\'s LIVE.';
  if (!rows.length) {
    if (postBursonStillOn_(control)) noteSwitch_('postBurson', `${pending} waiting on the Burson outbox tab${known ? '' : ' · ' + OUTBOX_NO_SFB_}`);
    return out;
  }
  if (!postBursonStillOn_(control)) {
    toPending(rows);
    console.log(`Burson outbox: Post in S-F Burson is OFF, so ${out.reset} row(s) set to Send went back to Pending`);
    return out;
  }
  if (!known) {  // no S-F Burson known (B25 blank or not found): the rows set to Send wait, and say why
    noteSwitch_('postBurson', `${pending} waiting on the Burson outbox tab, ${rows.length} set to Send · ${OUTBOX_NO_SFB_}`);
    console.log(`Burson outbox: ${rows.length} row(s) set to Send wait: the S-F Burson space (B25) is blank or can't be found`);
    return out;
  }
  if (!(mode && mode.live === true)) {  // Testing: nothing goes to S-F Burson
    const why = (mode && mode.why) || 'not LIVE';
    rows.forEach(x => { if (outboxSet_(sh, x, 'Pending', testingNote(why))) out.held = (out.held || 0) + 1; });
    noteSwitch_('postBurson', `${pending + (out.held || 0)} waiting on the Burson outbox tab · Testing (${why}): nothing is sent`);
    console.log(`Burson outbox: Testing (${why}), so ${out.held || 0} row(s) set to Send went back to Pending`);
    return out;
  }
  if (GEN.settings && GEN.settings.dry_run) {
    console.log(`Burson outbox: a dry run, so the ${rows.length} row(s) set to Send wait`);
    return out;
  }
  const notBot = outboxNotTheBot_(control);
  if (notBot) {
    noteSwitch_('postBurson', `not sending: ${notBot}`);
    console.log(`Burson outbox: ${rows.length} row(s) set to Send wait: ${notBot}`);
    return out;
  }
  const guard = outboxGuard_(wanted);
  const start = Date.now();
  for (let i = 0; i < rows.length; i++) {
    if (out.sent + out.blocked + out.failed >= OUTBOX_MAX_PER_RUN_ || Date.now() - start > OUTBOX_SEND_MS_) {
      out.left = rows.length - i;
      break;
    }
    if (!postBursonStillOn_(control)) {  // turned OFF while sending: nothing more goes
      toPending(rows.slice(i));
      break;
    }
    try {
      // Testing again since the run started (the Safety valve turned ON, or B26 filled in): this row and the rest wait
      const testingNow = safetyValveStillOn_(control) ? 'the Safety valve is ON'
        : readTestCopyCell_(control) ? 'the Burson test copy, B26, is set' : '';
      if (testingNow) {
        rows.slice(i).forEach(x => { if (outboxSet_(sh, x, 'Pending', testingNote(testingNow))) out.held = (out.held || 0) + 1; });
        break;
      }
      outboxSendOne_(ss, sh, rows[i], guard, out, sfb);
    } catch (e) {
      console.error('Burson outbox: ' + ((e && e.stack) || e));
    }
  }
  const done = out.sent + out.blocked + out.failed;
  const held = out.held || 0;
  if (done || out.reset || held) console.log(`Burson outbox: ${JSON.stringify(out)}`);
  noteSwitch_('postBurson', `${Math.max(0, pending + held)} waiting on the Burson outbox tab` +
    (out.sent ? ` · sent ${out.sent} at ${outboxTime_(Date.now()).slice(11)} ET` : '') +
    (held ? ' · the rest wait: the bot went back to Testing' : ''));
  return out;
}

/**
 * Writes one row set to Send to S-F Burson `sfb` (this run's, Control tab B25), or marks it Blocked / Failed / Sent. A
 * row queued for another S-F Burson space (B25 changed since) is Blocked, never sent. Throws only on a sheet error.
 */
function outboxSendOne_(ss, sh, x, guard, out, sfb) {
  const key = outboxKeyOf_(x.v[OUTBOX_KEY_COL_ - 1]);
  const fail = why => { if (outboxSet_(sh, x, 'Failed', `not sent: ${why}`)) out.failed++; };
  const block = why => { if (outboxSet_(sh, x, 'Blocked', `not sent: ${why}`)) out.blocked++; };
  if (!key || !key.kind || !key.k) return fail('this row has no key from the bot, so it can\'t tell where it goes');
  if (key.sent) {  // it already went (someone set it to Send again): never twice
    outboxSet_(sh, x, 'Sent', `already sent ${key.at ? outboxTime_(key.at) + ' ET' : ''}: ${outboxMessageLink_(key.link || key.sent)}`);
    return;
  }
  // The S-F Burson space it was queued for: its key's (older rows: their message, thread or Where link). Another one than
  // this run's is never sent; one that doesn't say isn't either (but for a reply whose thread is looked up below)
  const queuedFor = outboxKeySpace_(key) || outboxWhereSpace_(x.v[OUTBOX_WHERE_COL_ - 1]);
  if (queuedFor && queuedFor !== sfb.id) return block('it was queued for a different S-F Burson space (B25 has changed since)');
  if (!queuedFor && !(key.relay && key.relay.pt)) return block('it doesn\'t say which S-F Burson space it was queued for');
  const cell = String(x.v[OUTBOX_TEXT_COL_ - 1] === undefined || x.v[OUTBOX_TEXT_COL_ - 1] === null ? '' : x.v[OUTBOX_TEXT_COL_ - 1]).trim();
  let posted = null;
  if (key.kind === 'reaction') {
    if (String(key.message || '').indexOf(sfb.id + '/messages/') !== 0) return fail('its message isn\'t one in S-F Burson');
    const problem = outboxEmojiProblem_(cell);
    if (problem) return block(problem);
  } else {
    if (key.thread && String(key.thread).indexOf(sfb.id + '/threads/') !== 0) return fail('its thread isn\'t one in S-F Burson');
    if (!cell) return block('the text is empty');
    // the bot's own answer to Burson's question, while its text is the one the bot queued: checked as it always was
    const hits = outboxGuardHits_(cell, guard, outboxAnswerAsQueued_(key, cell));
    if (hits.length) return block(`it mentions "${truncate_(hits[0], 60)}". Edit the text, then set Send again.`);
  }
  let thread = key.thread || '';
  if (key.kind === 'reply' && !thread && key.relay && key.relay.pt) {
    thread = relayLiveThreadOf_(ss, key.relay, sfb.id);
    if (!thread) return fail('the first message of its thread hasn\'t gone to S-F Burson yet: send that row first, then set this one to Send again');
  }
  OUTBOX_WRITING_ = true;
  try {
    if (key.kind === 'reaction') {
      chatReact_(key.message, cell);
    } else {
      posted = chatPostMessage_(sfb.id, truncate_(cell, OUTBOX_MAX_CHARS_),
        { thread: thread || null, key: key.ck || key.k, idPrefix: key.p || undefined });
    }
  } catch (e) {
    return fail(truncate_(String((e && e.message) || e), 200));
  } finally {
    OUTBOX_WRITING_ = false;
  }
  const at = Date.now();
  const link = posted ? outboxMessageLink_(posted.name) : outboxMessageLink_(key.message);
  const sent = Object.assign({}, key, { sent: posted ? posted.name : `${key.message}|${cell}`, link: posted ? posted.name : key.message, at });
  if (outboxSet_(sh, x, 'Sent', `sent ${outboxTime_(at)} ET: ${link}`, sent)) out.sent++;
  if (posted && !key.relay) outboxOwnPost_(ss, posted.name);
  if (key.relay) {
    try { relaySentFromOutbox_(ss, key, posted, cell); } catch (e) { console.error('Burson outbox: couldn\'t note it on the Relay tab: ' + e); }
  }
}

/**
 * Sets a row's Status and Note (and its key, once Sent), with the Status choices that fit: Pending / Send / Skip;
 * Failed or Blocked / Send / Skip; Sent alone. The row is found by its key if it moved; a row someone deleted is left
 * alone. True if written.
 */
function outboxSet_(sh, x, status, note, key) {
  const want = String(x.v[OUTBOX_KEY_COL_ - 1] || '');
  let row = x.row;
  if (String(sh.getRange(row, OUTBOX_KEY_COL_).getValue() || '') !== want) {
    if (!want) return false;
    const found = sh.getRange(2, OUTBOX_KEY_COL_, Math.max(1, sh.getLastRow() - 1), 1).createTextFinder(want).matchEntireCell(true).findNext();
    if (!found) return false;
    row = found.getRow();
  }
  sh.getRange(row, OUTBOX_STATUS_COL_, 1, 2).setValues([[status, outboxCell_(truncate_(note, 500))]]);
  if (key) sh.getRange(row, OUTBOX_KEY_COL_).setValue(JSON.stringify(key));
  const choices = status === 'Sent' ? ['Sent'] : status === 'Pending' ? OUTBOX_CHOICES_ : [status, 'Send', 'Skip'];
  sh.getRange(row, OUTBOX_STATUS_COL_).setDataValidation(outboxRule_(choices));
  x.row = row;
  if (key) x.v[OUTBOX_KEY_COL_ - 1] = JSON.stringify(key);
  return true;
}

/** The bot's own post, sent from the outbox: the main flow never takes it for Burson's (Store.gs own_post). */
function outboxOwnPost_(ss, name) {
  try {
    sheetBackend_(ss).appendMessage({ message: name, created_at: Date.now(), kind: 'own_post', alert_id: '', attempts: 0, error: '' });
  } catch (e) {
    console.error('Burson outbox: couldn\'t note the bot\'s own post: ' + ((e && e.message) || e));
  }
}

/**
 * The run's counts in the run log: what was withheld (Post in S-F Burson OFF), what was queued, and what was held back
 * from a space people outside Google can join that isn't S-F Burson (outboxHeldBack_).
 */
function outboxRunEnd_() {
  const run = OUTBOX_RUN_;
  if (!run) return null;
  const say = counts => ['post', 'reply', 'reaction'].filter(k => counts[k])
    .map(k => `${counts[k]} ${k === 'reply' ? (counts[k] === 1 ? 'reply' : 'replies') : k + (counts[k] === 1 ? '' : 's')}`).join(', ');
  const withheld = say(run.withheld);
  const queued = say(run.queued);
  const held = say(run.held || {});
  if (withheld) console.log(`S-F Burson: withheld this run (Post in S-F Burson is OFF, so nothing was posted or queued): ${withheld}`);
  if (queued) console.log(`S-F Burson: queued this run on the Burson outbox tab (each waits for Send): ${queued}`);
  if (held) {
    console.log('A space people outside Google can join that isn\'t S-F Burson (B25): held back this run (nothing was ' +
      `posted or queued there): ${held}`);
  }
  if (run.refused) console.log(`S-F Burson: ${run.refused} write(s) couldn't be queued (see the errors above); nothing was posted`);
  return { withheld: run.withheld, queued: run.queued, held: run.held, refused: run.refused };
}
