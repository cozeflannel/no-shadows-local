/**
 * ThreadNotes.gs — the one way the bot puts a note under a card that is already in the Auto-correct space (B10).
 *
 * The alert types point at each other with short notes in a card's thread ("🔭 *Also flagged by the watch …", "🔗 *Part of
 * a story:* …", "*Alert requirements:* …"). Each of them goes through acThreadNote_, so one place decides where a note
 * may go, and it posts one only when all of this holds:
 *   - it comes from the Auto-correct flow: a flow's ctx with ctx.sourceReadOnly (AutoCorrect.gs), or, from the watch
 *     (which has no flow ctx), the watch's destination with dest.choice === 'autocorrect' (WatchAlerts.gs pwAlertsDest_);
 *     either way its space is the one the Auto-correct flow last worked in (LAST_AC_SPACE);
 *   - the card is in the Auto-correct space: its thread starts with that space's id + "/threads/" and its message with
 *     that id + "/messages/". Of an Alert-log row only forward_thread and forward_message are read, never source_thread
 *     (in the one-space setup that is Burson's own thread in S-F Burson; in the Mirror space, the thread Burson's
 *     replies come into);
 *   - that space is not S-F Burson (B25), not the Burson test copy (B26) and not open to people outside Google;
 *   - the note starts with one of the fixed first words (Voice.gs THREAD_NOTE_HEADS_): the bot then knows it as its own
 *     with no message id and never answers it, and the wider guard (Outbox.gs) holds it on any way to S-F Burson;
 *   - its key hasn't been posted (once per key), the card has fewer than AC_NOTE_PER_CARD_ notes in its life and the run
 *     fewer than AC_NOTE_PER_RUN_, of all kinds together.
 * Otherwise nothing is posted and it returns false: the caller only counts and logs.
 *
 * The note is the bot's own message: in a flow it goes through postTo_ (its id starts client-bqa-, and it is in
 * ctx.recent); from the watch through chatPostMessage_ with a key and the same default id.
 *
 * The counts. What a card's thread holds is the truth; the script cache only saves reading it. One cache value keeps
 * each card's count and each key AC_NOTE_KEEP_MS_ (25 hours) after its last note, written again at every note tried
 * (the cache keeps a value 6 hours at most), with `s`: since when it has known every note. A card it has no count for
 * has no note only if its thread is younger than that and than 25 hours. How old the thread is, the card says only when
 * it is the thread's first message (acNoteThreadBorn_: an Alert-log row's created_at and source_at, or the createTime
 * of a card just posted): a row that came into an earlier card's thread (Burson's resend, an update of a story) and a
 * card that is a reply never say it. Any other card's notes are counted in its thread, once (the count is then kept): a
 * card from before the value began, one whose thread's age isn't known, one older than 25 hours. So the cap of 3 holds
 * for a thread's life with the cache value gone, too. A key posted again after the value forgot it makes no second
 * message (Chat keeps the message's id, and hands the first one back; a note of the bot's with the very same text,
 * found while the thread is counted, is taken for it) and is not counted again; under a full card, Chat is asked
 * whether that key's note is there before the note is refused. A value that isn't as the bot writes it knows nothing of
 * the cards from before now, and a value left behind by a write that failed is taken out (it may lack a note just
 * posted). The run's counts live in the run itself.
 *
 * What a note may cost. A run posts AC_NOTE_PER_RUN_ notes at most and asks Chat AC_NOTE_ASKS_PER_RUN_ times at most
 * about its cards' notes (a page of a card's thread, a look for a note by its id); a card whose thread couldn't be
 * counted in, and a key that wasn't found under a full card, are not asked about again in the same run; a thread is
 * read AC_NOTE_THREAD_PAGES_ pages far at most; and a flow with less than AC_NOTE_ASK_LEFT_MS_ of its time left asks
 * nothing (a note that needs no asking is still posted).
 */

const AC_NOTE_PER_CARD_ = 3;                 // notes under one card in its life, of all kinds together
const AC_NOTE_PER_RUN_ = 6;                  // notes a run, of all kinds together
const AC_NOTE_ASKS_PER_RUN_ = 12;            // what a run asks Chat about its cards' notes: thread pages and looks by id, together
const AC_NOTE_ASK_LEFT_MS_ = 20 * 1000;      // a flow with less of its time left asks Chat nothing about a note
const AC_NOTE_KEEP_MS_ = 25 * 3600 * 1000;   // a card's count and a note's key are kept this long after the last note
// {s: since when every note is known (ms), c: {hash of the card's thread: [notes, last ms]}, k: {hash of a key: ms}}
const AC_NOTE_CACHE_ = 'ac_thread_notes';
const AC_NOTE_CACHE_SEC_ = 21600;            // the longest the script cache keeps a value: 6 hours
const AC_NOTE_CARDS_MAX_ = 500;              // cards and keys kept, the newest (the value stays under 90,000 characters)
const AC_NOTE_KEYS_MAX_ = 1500;
const AC_NOTE_KEY_PREFIX_ = 'acnote:';       // before the caller's key, in the message's id
const AC_NOTE_OLD_MS_ = 60 * 1000;           // a message Chat hands back that is this much older than the call was there before
const AC_NOTE_THREAD_MAX_ = 200;             // messages of a card's thread read to count its notes (a longer thread: no note)
const AC_NOTE_THREAD_PAGES_ = 4;             // ...in this many pages at most (Chat may hand over pages shorter than asked)

// This run's notes: {id: poll()'s run (Main.gs currentRunId_; '' outside poll()), flow: outside poll(), the ctx of the
// run built by hand, n: notes posted, asks: what Chat was asked about notes, dark: {hash of a card's thread: why its
// notes couldn't be counted}, absent: {hash of a key: true when Chat had no note under it for a full card}}
let AC_NOTE_RUN_ = { id: null, flow: null, n: 0, asks: 0, dark: {}, absent: {} };
let AC_NOTE_UNKEPT_ = false;  // true from a write of the counts that failed until one goes through (acNoteSave_)

/**
 * Whether a note may go under `card`, without posting anything or counting: {ok: true, space, ctx, thread, message,
 * text} or {ok: false, why}. `from`: a flow's ctx, or the watch's destination (pwAlertsDest_'s {choice, space}); `card`:
 * an Alert-log row (its forward_thread and forward_message) or {thread, message} for a card just posted. Never throws.
 */
function acThreadNoteCheck_(from, card, text) {
  const no = why => ({ ok: false, why });
  try {
    const body = String(text === undefined || text === null ? '' : text).trim();
    if (!body) return no('there is no text');
    let space = null;
    let ctx = null;
    // the space the Auto-correct flow last worked in (AutoCorrect.gs startFromAutoCorrect_ notes it at each run's start)
    const worked = id => String(id) === String(PropertiesService.getScriptProperties().getProperty('LAST_AC_SPACE') || '');
    const NOT_WORKED = 'the Auto-correct flow hasn\'t worked in that space';
    if (from && from.spaces) {  // a flow
      if (from.sourceReadOnly !== true || from.outboundBlocked || from.direct || from.otherSpace) return no('this is not the Auto-correct flow');
      space = from.spaces.analyst || null;
      ctx = from;
      const burson = from.spaces.burson || {};
      if (space && space.id && (space.id === burson.id || isSfBurson_(from.sfBurson, space.id))) return no('the space is S-F Burson');
      if (space && space.id && !worked(space.id)) return no(NOT_WORKED);  // the flag alone is not taken for the flow
    } else if (from && typeof from.choice === 'string') {  // the watch
      if (from.choice !== 'autocorrect') return no('the watch\'s alerts don\'t go to the Auto-correct space');
      space = from.space || null;
      if (space && space.id && !worked(space.id)) return no(NOT_WORKED);
    } else {
      return no('there is no flow or watch destination');
    }
    const id = String((space && space.id) || '');
    if (!id) return no('there is no Auto-correct space');
    if (id === sfBursonId_()) return no('the space is S-F Burson');
    if (typeof testCopyId_ === 'function' && testCopyId_() && id === testCopyId_()) return no('the space is the Burson test copy');
    if (space.externalUserAllowed || outsideSpace_(id)) return no('people outside Google can join the space');
    const c = card || {};
    const thread = String((c.forward_thread !== undefined ? c.forward_thread : c.thread) || '');
    const message = String((c.forward_message !== undefined ? c.forward_message : c.message) || '');
    if (!thread) return no('the card has no thread');
    if (thread.indexOf(id + '/threads/') !== 0) return no('the card\'s thread is not in the Auto-correct space');
    if (message.indexOf(id + '/messages/') !== 0) return no('the card\'s message is not in the Auto-correct space');
    if (!isThreadNoteText_(body)) return no('the note doesn\'t start with one of the fixed first words');
    return { ok: true, space: id, ctx, thread, message, text: body };
  } catch (e) {
    return no(`the check failed: ${(e && e.message) || e}`);
  }
}

/**
 * Puts the note `text` under `card` in the Auto-correct space, once (`key`: what makes it the same note again), as the
 * bot's own message. True when the note is in the card's thread (posted now, or before with this key); false when it
 * may not go there (acThreadNoteCheck_), the card or the run has its share of notes, the card's thread couldn't be read
 * to count them (or the run has asked Chat its share, or has no time left to ask), or Chat refused it: then nothing was
 * posted, and the caller only counts and logs. `from`, `card`: as for acThreadNoteCheck_; a card that is the first
 * message of its thread and says how old it is (an Alert-log row; {thread, message, createTime} for a card this run
 * posted, with threadReply: true when that message is a reply in an older thread) saves a read of its thread. Never
 * throws.
 */
function acThreadNote_(from, card, text, key) {
  const say = msg => {
    try {
      if (from && typeof from.log === 'function') from.log(msg); else console.log(msg);
    } catch (e) { /* a log line never stops the run */ }
  };
  try {
    const k = String(key === undefined || key === null ? '' : key);
    const check = k ? acThreadNoteCheck_(from, card, text) : { ok: false, why: 'the note has no key' };
    if (!check.ok) {
      // outside the Auto-correct flow that is the rule, not news: nothing is logged there
      if (!/^(?:this is not the Auto-correct flow|the watch's alerts don't go)/.test(check.why)) say(`thread note not posted: ${check.why}`);
      return false;
    }
    const now = Date.now();
    const state = acNoteState_(now);
    const keyHash = hashText_(k);
    const cardHash = hashText_(check.thread);
    if (state.k[keyHash]) {
      acNoteSave_(state);
      return true;
    }
    const run = acNoteRun_(check.ctx);
    if (run.n >= AC_NOTE_PER_RUN_) {  // (before anything is read for it)
      acNoteSave_(state);
      say(`thread note not posted: this run already posted ${AC_NOTE_PER_RUN_} notes`);
      return false;
    }
    // a card whose thread this run couldn't count in is not asked about again in this run
    if (run.dark[cardHash]) {
      say(`thread note not posted: ${run.dark[cardHash]}`);
      return false;
    }
    // The notes its card has: what the counts say; a card they have nothing for has none only if its thread is younger
    // than they are and than 25 hours; any other card's notes are counted in its thread, once
    let had = state.c[cardHash] ? state.c[cardHash][0] : null;
    let counted = false;  // its thread was read for this very note
    if (had === null) {
      const born = acNoteThreadBorn_(check, card);
      if (born > state.s && born >= now - AC_NOTE_KEEP_MS_) {
        had = 0;
      } else {
        const noAsking = acNoteAskRefusal_(run, check.ctx);
        if (noAsking) {
          say(`thread note not posted: ${noAsking}`);
          return false;
        }
        const there = acNoteThread_(check, acNoteId_(check.space, k), run);
        if (!there || !there.card) {
          run.dark[cardHash] = there ? 'its card is no longer in the space'
            : 'its card\'s thread couldn\'t be read to count the notes it has';
          say(`thread note not posted: ${run.dark[cardHash]}`);
          return false;
        }
        counted = true;
        had = there.notes;
        state.c[cardHash] = [had, now];
        // this very note is in the thread already (the counts had lost its key): by its id, or a note of the bot's
        // with the same text
        if (there.own || there.same) {
          state.k[keyHash] = now;
          acNoteSave_(state);
          return true;
        }
      }
    }
    if (had >= AC_NOTE_PER_CARD_) {
      // A full card: a key the counts no longer have may be one of the notes that are there. Its thread, when it was
      // just read, has shown that it isn't; otherwise Chat is asked for the note by its id, once a run for a key
      if (!counted && !run.absent[keyHash] && !acNoteAskRefusal_(run, check.ctx)) {
        run.asks++;
        if (acNoteThere_(check.space, k)) {
          state.k[keyHash] = now;
          acNoteSave_(state);
          return true;
        }
        run.absent[keyHash] = true;
      }
      acNoteSave_(state);
      say(`thread note not posted: its card already has ${AC_NOTE_PER_CARD_} notes`);
      return false;
    }
    const msg = check.ctx
      ? postTo_(check.ctx, check.space, check.text, check.thread, AC_NOTE_KEY_PREFIX_ + k)
      : chatPostMessage_(check.space, truncate_(check.text, MAX_TEXT_), { thread: check.thread, key: AC_NOTE_KEY_PREFIX_ + k });
    if (!msg || !msg.name) {
      say('thread note not posted: Chat took no message');
      return false;
    }
    state.k[keyHash] = now;
    // Chat handed back the message this key made before (the counts had lost the key): no new note, nothing to count
    const made = Number(msg.createTime) || 0;
    if (made > 0 && made <= now - AC_NOTE_OLD_MS_) {
      acNoteSave_(state);
      return true;
    }
    if (msg.thread && msg.thread !== check.thread) say(`thread note: Chat started a new thread for it (its card's thread ${check.thread} is gone)`);
    state.c[cardHash] = [had + 1, now];
    run.n++;
    acNoteSave_(state);
    return true;
  } catch (e) {
    say(`thread note not posted: ${(e && e.message) || e}`);
    return false;
  }
}

/** This run's counts for the notes (see AC_NOTE_RUN_): started afresh for a new run. */
function acNoteRun_(ctx) {
  const id = typeof currentRunId_ === 'function' ? String(currentRunId_() || '') : '';
  const flow = id ? null : ctx || null;
  if (AC_NOTE_RUN_.id !== id || AC_NOTE_RUN_.flow !== flow) AC_NOTE_RUN_ = { id, flow, n: 0, asks: 0, dark: {}, absent: {} };
  return AC_NOTE_RUN_;
}

/**
 * Why Chat may not be asked about a note now ('' when it may): the run has asked its AC_NOTE_ASKS_PER_RUN_ times, or the
 * flow (`ctx`, null for the watch) has less than AC_NOTE_ASK_LEFT_MS_ of its time left. Never throws.
 */
function acNoteAskRefusal_(run, ctx) {
  if (run.asks >= AC_NOTE_ASKS_PER_RUN_) return `this run already asked Chat ${AC_NOTE_ASKS_PER_RUN_} times about its cards' notes`;
  try {
    if (ctx && Number(ctx.deadline) > 0) {
      const now = typeof ctx.now === 'function' ? ctx.now() : Date.now();
      if (Number(ctx.deadline) - now < AC_NOTE_ASK_LEFT_MS_) return 'the run has too little time left to count its card\'s notes';
    }
  } catch (e) { /* no time limit to go by */ }
  return '';
}

/** The id Chat is asked to give the note with `key` in `space` (Chat.gs chatPostMessage_ makes the same one). */
function acNoteId_(space, key) {
  return CLIENT_ID_PREFIX_ + sha256Hex_(`${space}|${AC_NOTE_KEY_PREFIX_}${key}`).slice(0, 40);
}

/** True when the note with `key` is in `space` already: Chat has a message under the id that note was given. Never throws. */
function acNoteThere_(space, key) {
  try {
    const r = chatCall_('get', `${space}/messages/${acNoteId_(space, key)}`);
    return !!r && r.code < 300 && !!(r.body && r.body.name);
  } catch (e) {
    return false;
  }
}

/**
 * When a card came to be, in ms: the earliest of an Alert-log row's created_at and source_at (a card can be a run older
 * than its row), or the createTime of a card just posted; 0 when it doesn't say. Pure.
 */
function acNoteCardBorn_(card) {
  const c = card || {};
  const times = [c.created_at, c.source_at, c.createTime].map(Number).filter(t => isFinite(t) && t > 0);
  return times.length ? Math.min.apply(null, times) : 0;
}

/**
 * When the thread of `card` began, in ms, as far as it can be told without reading it; 0 when it can't (the card's
 * notes are then counted in its thread). A card's own age (acNoteCardBorn_) is its thread's only when the card is the
 * thread's first message. It is not taken for that when
 *   - it is handed over as a reply (threadReply: true), or Chat's own names say another message came first: Chat names
 *     a thread's first message "<thread id>.<thread id>", so a message "<x>.<y>" of any other form is a reply (a name
 *     without a dot says nothing);
 *   - its Alert-log row came into an earlier card's thread: Burson's resend keeps the first card's thread and message
 *     and has its own, later times (Bot.gs handleResend_: resend_of); an update of a story is posted in the story's
 *     thread (EarlyDetection.gs edSnap_: forwarded_fields.early_detection.update_of).
 * And when the flow's Alert log (`check`.ctx.store) has other rows in the same thread, the earliest of them all says
 * how old the thread is (0 if one of them doesn't say when). `check`: acThreadNoteCheck_'s. Never throws.
 */
function acNoteThreadBorn_(check, card) {
  try {
    const c = card || {};
    if (c.threadReply === true || c.resend_of) return 0;
    const fields = c.forwarded_fields && typeof c.forwarded_fields === 'object' ? c.forwarded_fields : {};
    if (fields.early_detection && fields.early_detection.update_of) return 0;
    const threadId = check.thread.slice(check.space.length + '/threads/'.length);
    const messageId = check.message.slice(check.space.length + '/messages/'.length);
    if (messageId.indexOf('.') >= 0 && messageId !== `${threadId}.${threadId}`) return 0;
    let born = acNoteCardBorn_(c);
    const rows = check.ctx && check.ctx.store && Array.isArray(check.ctx.store.alerts) ? check.ctx.store.alerts : [];
    for (let i = 0; born > 0 && i < rows.length; i++) {
      if (!rows[i] || String(rows[i].forward_thread || '') !== check.thread) continue;
      const at = acNoteCardBorn_(rows[i]);
      born = at > 0 ? Math.min(born, at) : 0;
    }
    return born;
  } catch (e) {
    return 0;
  }
}

/**
 * A note's text without Chat's marks, to tell a note read back from the one to post (Chat can hand a message back with
 * its bold marks or without them, and a <link|words> as its words). Pure.
 */
function acNotePlain_(text) {
  return String(text === undefined || text === null ? '' : text).replace(/<[^<>|\s]+\|([^<>]*)>/g, '$1')
    .replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * What the thread of a card holds (`check`: acThreadNoteCheck_'s): {card: its message is there, notes: the bot's notes
 * under it (replies that start as a note does, from the bot's account when it is known), own: the message with id
 * `ownId` ('' when there's none), same: one of those notes with the very text of `check` ('' when there's none)}. null
 * when Chat can't be read, the thread is longer than AC_NOTE_THREAD_MAX_ messages or AC_NOTE_THREAD_PAGES_ pages (its
 * notes can't all be counted), or the run (`run`: acNoteRun_'s; each page counts as one thing asked) has asked Chat
 * its share. Never throws.
 */
function acNoteThread_(check, ownId, run) {
  try {
    const bot = (check.ctx && check.ctx.botUser) || PropertiesService.getScriptProperties().getProperty('BOT_USER') || '';
    const mine = acNotePlain_(truncate_(check.text, MAX_TEXT_));
    const out = { card: false, notes: 0, own: '', same: '' };
    let pageToken = '';
    let read = 0;
    let pages = 0;
    do {
      if (run && run.asks >= AC_NOTE_ASKS_PER_RUN_) return null;
      if (run) run.asks++;
      pages++;
      const r = chatCall_('get', check.space + '/messages', { query: { filter: `thread.name = ${check.thread}`, pageSize: 100, pageToken } });
      if (!r || r.code >= 300) return null;
      (r.body.messages || []).forEach(raw => {
        const m = normalizeMessage_(raw);
        read++;
        if (m.name === check.message) out.card = true;
        if (!m.threadReply || m.name === check.message) return;
        if (ownId && m.clientId === ownId) out.own = m.name;
        if (isThreadNoteText_(m.text) && (!bot || m.senderName === bot)) {
          out.notes++;
          if (!out.same && acNotePlain_(m.text) === mine) out.same = m.name;
        }
      });
      pageToken = r.body.nextPageToken || '';
    } while (pageToken && read < AC_NOTE_THREAD_MAX_ && pages < AC_NOTE_THREAD_PAGES_);
    return pageToken ? null : out;
  } catch (e) {
    return null;
  }
}

/**
 * The cards' counts and the keys posted, of the last AC_NOTE_KEEP_MS_: {s, c, k}. `s`: since when the value has known
 * every note (now, when the cache has none: it knows nothing from before). A value that isn't as the bot writes it is
 * not taken at its word: only its sound entries are kept (a card's count is a whole number of 0 or more with the time
 * of its last note, a key has the time it was posted), and `s` is now, so every card it has no count for is counted
 * in its thread. Never throws.
 */
function acNoteState_(now) {
  const out = { s: now, c: {}, k: {} };
  if (AC_NOTE_UNKEPT_) return out;  // a write failed in this run: what the cache holds may lack a note (acNoteSave_)
  let v = null;
  try { v = JSON.parse(CacheService.getScriptCache().get(AC_NOTE_CACHE_) || 'null'); } catch (e) { v = null; }
  const map = x => !!x && typeof x === 'object' && !Array.isArray(x);
  if (!map(v)) return out;
  const whole = n => typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n;
  const time = t => whole(t) && t > 0 && t <= now + AC_NOTE_OLD_MS_;  // (two runs' clocks can differ a little)
  const fresh = at => now - at < AC_NOTE_KEEP_MS_;
  let sound = time(v.s) && map(v.c) && map(v.k);
  Object.keys(map(v.c) ? v.c : {}).forEach(h => {
    const e = v.c[h];
    if (!Array.isArray(e) || !whole(e[0]) || !time(e[1])) sound = false;
    else if (fresh(e[1])) out.c[h] = [e[0], e[1]];
  });
  Object.keys(map(v.k) ? v.k : {}).forEach(h => {
    if (!time(v.k[h])) sound = false;
    else if (fresh(v.k[h])) out.k[h] = v.k[h];
  });
  if (sound) out.s = v.s;
  return out;
}

/**
 * Writes them back (the newest AC_NOTE_CARDS_MAX_ cards and AC_NOTE_KEYS_MAX_ keys), for another 6 hours. A card's
 * count that has to go for room moves `s` up to its last note: from then on the value no longer knows every note of a
 * card that old, and such a card's notes are counted in its thread again. A write that fails leaves an older value in
 * the cache that may lack a note just posted: it is taken out, and not read again in this run (AC_NOTE_UNKEPT_) until a
 * write goes through, so every card's notes are counted in its thread meanwhile. True when written. Never throws.
 */
function acNoteSave_(state) {
  try {
    const newest = (obj, at, max) => Object.keys(obj).sort((a, b) => at(obj[b]) - at(obj[a])).slice(0, max);
    const cards = newest(state.c, v => v[1], Object.keys(state.c).length);
    const gone = cards.slice(AC_NOTE_CARDS_MAX_);
    const since = Math.max.apply(null, [Number(state.s) || 0].concat(gone.map(h => Number(state.c[h][1]) || 0)));
    const value = { s: since, c: {}, k: {} };
    cards.slice(0, AC_NOTE_CARDS_MAX_).forEach(h => { value.c[h] = state.c[h]; });
    newest(state.k, v => v, AC_NOTE_KEYS_MAX_).forEach(h => { value.k[h] = state.k[h]; });
    CacheService.getScriptCache().put(AC_NOTE_CACHE_, JSON.stringify(value), AC_NOTE_CACHE_SEC_);
    AC_NOTE_UNKEPT_ = false;
    return true;
  } catch (e) {
    AC_NOTE_UNKEPT_ = true;
    try { CacheService.getScriptCache().remove(AC_NOTE_CACHE_); } catch (err) { /* not read again in this run */ }
    console.warn(`thread notes: couldn't keep the counts (${(e && e.message) || e}); a card's notes are counted in its thread instead`);
    return false;
  }
}
