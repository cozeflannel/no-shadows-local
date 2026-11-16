/**
 * ThreadNotes.gs — the one way the bot puts a note under a card that is already in the Auto-correct space (B10).
 *
 * The alert types point at each other with short notes in a card's thread ("🔭 *Also flagged by the watch …", "🔗 *Part of
 * a story:* …", "*Alert requirements:* …"). Each of them goes through acThreadNote_, so one place decides where a note
 * may go, and it posts one only when all of this holds:
 *   - it comes from the Auto-correct flow: a flow's ctx with ctx.sourceReadOnly (AutoCorrect.gs), or, from the watch
 *     (which has no flow ctx), the watch's destination with dest.choice === 'autocorrect' (WatchAlerts.gs pwAlertsDest_)
 *     whose space is the one the Auto-correct flow last worked in (LAST_AC_SPACE);
 *   - the card is in the Auto-correct space: its thread starts with that space's id + "/threads/" and its message with
 *     that id + "/messages/". Of an Alert-log row only forward_thread and forward_message are read, never source_thread
 *     (in the one-space setup that is Burson's own thread in S-F Burson; in the Mirror space, the thread Burson's
 *     replies come into);
 *   - that space is not S-F Burson (B25), not the Burson test copy (B26) and not open to people outside Google;
 *   - the note starts with one of the fixed first words (Voice.gs THREAD_NOTE_HEADS_): the bot then knows it as its own
 *     with no message id and never answers it, and the wider guard (Outbox.gs) holds it on any way to S-F Burson;
 *   - its key hasn't been posted (once per key), the card has fewer than AC_NOTE_PER_CARD_ notes and the run fewer than
 *     AC_NOTE_PER_RUN_, of all kinds together.
 * Otherwise nothing is posted and it returns false: the caller only counts and logs.
 *
 * The note is the bot's own message: in a flow it goes through postTo_ (its id starts client-bqa-, and it is in
 * ctx.recent); from the watch through chatPostMessage_ with a key and the same default id.
 *
 * The counts: the cards' and the keys' are one script-cache value, each kept AC_NOTE_KEEP_MS_ (25 hours) after its last
 * note. The script cache keeps a value 6 hours at most, so the value is written again at every note tried; after 6 hours
 * with none tried it is gone, and the counts start again (Chat still refuses a second message with the same key). The
 * run's count lives in the run itself.
 */

const AC_NOTE_PER_CARD_ = 3;                 // notes under one card, of all kinds together
const AC_NOTE_PER_RUN_ = 6;                  // notes a run, of all kinds together
const AC_NOTE_KEEP_MS_ = 25 * 3600 * 1000;   // a card's count and a note's key are kept this long after the last note
const AC_NOTE_CACHE_ = 'ac_thread_notes';    // {c: {hash of the card's thread: [notes, last ms]}, k: {hash of a key: ms}}
const AC_NOTE_CACHE_SEC_ = 21600;            // the longest the script cache keeps a value: 6 hours
const AC_NOTE_CARDS_MAX_ = 500;              // cards and keys kept, the newest (the value stays under 90,000 characters)
const AC_NOTE_KEYS_MAX_ = 1500;
const AC_NOTE_KEY_PREFIX_ = 'acnote:';       // before the caller's key, in the message's id

// This run's notes: {id: poll()'s run (Main.gs currentRunId_; '' outside poll()), flow: outside poll(), the ctx of the
// run built by hand, n}
let AC_NOTE_RUN_ = { id: null, flow: null, n: 0 };

/**
 * Whether a note may go under `card`, without posting anything or counting: {ok: true, space, ctx, thread, text} or
 * {ok: false, why}. `from`: a flow's ctx, or the watch's destination (pwAlertsDest_'s {choice, space}); `card`: an
 * Alert-log row (its forward_thread and forward_message) or {thread, message} for a card just posted. Never throws.
 */
function acThreadNoteCheck_(from, card, text) {
  const no = why => ({ ok: false, why });
  try {
    const body = String(text === undefined || text === null ? '' : text).trim();
    if (!body) return no('there is no text');
    let space = null;
    let ctx = null;
    if (from && from.spaces) {  // a flow
      if (from.sourceReadOnly !== true || from.outboundBlocked || from.direct || from.otherSpace) return no('this is not the Auto-correct flow');
      space = from.spaces.analyst || null;
      ctx = from;
      const burson = from.spaces.burson || {};
      if (space && space.id && (space.id === burson.id || isSfBurson_(from.sfBurson, space.id))) return no('the space is S-F Burson');
    } else if (from && typeof from.choice === 'string') {  // the watch
      if (from.choice !== 'autocorrect') return no('the watch\'s alerts don\'t go to the Auto-correct space');
      space = from.space || null;
      const last = PropertiesService.getScriptProperties().getProperty('LAST_AC_SPACE');
      if (space && space.id && String(space.id) !== String(last || '')) return no('the Auto-correct flow hasn\'t worked in that space');
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
    return { ok: true, space: id, ctx, thread, text: body };
  } catch (e) {
    return no(`the check failed: ${(e && e.message) || e}`);
  }
}

/**
 * Puts the note `text` under `card` in the Auto-correct space, once (`key`: what makes it the same note again), as the
 * bot's own message. True when the note is in the card's thread (posted now, or before with this key); false when it
 * may not go there (acThreadNoteCheck_), the card or the run has its share of notes, or Chat refused it: then nothing was
 * posted, and the caller only counts and logs. `from`, `card`: as for acThreadNoteCheck_. Never throws.
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
    const had = state.c[cardHash] ? Number(state.c[cardHash][0]) || 0 : 0;
    if (had >= AC_NOTE_PER_CARD_ || run.n >= AC_NOTE_PER_RUN_) {
      acNoteSave_(state);
      say('thread note not posted: ' + (had >= AC_NOTE_PER_CARD_ ? `its card already has ${AC_NOTE_PER_CARD_} notes`
        : `this run already posted ${AC_NOTE_PER_RUN_} notes`));
      return false;
    }
    const msg = check.ctx
      ? postTo_(check.ctx, check.space, check.text, check.thread, AC_NOTE_KEY_PREFIX_ + k)
      : chatPostMessage_(check.space, truncate_(check.text, MAX_TEXT_), { thread: check.thread, key: AC_NOTE_KEY_PREFIX_ + k });
    if (!msg || !msg.name) {
      say('thread note not posted: Chat took no message');
      return false;
    }
    if (msg.thread && msg.thread !== check.thread) say(`thread note: Chat started a new thread for it (its card's thread ${check.thread} is gone)`);
    state.k[keyHash] = now;
    state.c[cardHash] = [had + 1, now];
    run.n++;
    acNoteSave_(state);
    return true;
  } catch (e) {
    say(`thread note not posted: ${(e && e.message) || e}`);
    return false;
  }
}

/** This run's count of notes (see AC_NOTE_RUN_): started afresh for a new run. */
function acNoteRun_(ctx) {
  const id = typeof currentRunId_ === 'function' ? String(currentRunId_() || '') : '';
  const flow = id ? null : ctx || null;
  if (AC_NOTE_RUN_.id !== id || AC_NOTE_RUN_.flow !== flow) AC_NOTE_RUN_ = { id, flow, n: 0 };
  return AC_NOTE_RUN_;
}

/** The cards' counts and the keys posted, of the last AC_NOTE_KEEP_MS_: {c, k} (empty when the cache has none). Never throws. */
function acNoteState_(now) {
  let s = null;
  try { s = JSON.parse(CacheService.getScriptCache().get(AC_NOTE_CACHE_) || 'null'); } catch (e) { s = null; }
  const fresh = at => now - (Number(at) || 0) < AC_NOTE_KEEP_MS_;
  const out = { c: {}, k: {} };
  const map = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const c = map(s && s.c);
  const k = map(s && s.k);
  Object.keys(c).forEach(h => { if (Array.isArray(c[h]) && fresh(c[h][1])) out.c[h] = [Number(c[h][0]) || 0, Number(c[h][1])]; });
  Object.keys(k).forEach(h => { if (fresh(k[h])) out.k[h] = Number(k[h]); });
  return out;
}

/** Writes them back (the newest AC_NOTE_CARDS_MAX_ cards and AC_NOTE_KEYS_MAX_ keys), for another 6 hours. Never throws. */
function acNoteSave_(state) {
  try {
    const newest = (obj, at, max) => {
      const keep = {};
      Object.keys(obj).sort((a, b) => at(obj[b]) - at(obj[a])).slice(0, max).forEach(h => { keep[h] = obj[h]; });
      return keep;
    };
    const value = { c: newest(state.c, v => v[1], AC_NOTE_CARDS_MAX_), k: newest(state.k, v => v, AC_NOTE_KEYS_MAX_) };
    CacheService.getScriptCache().put(AC_NOTE_CACHE_, JSON.stringify(value), AC_NOTE_CACHE_SEC_);
  } catch (e) {
    console.warn(`thread notes: couldn't keep the counts (${(e && e.message) || e}), so a card may get more than ${AC_NOTE_PER_CARD_}`);
  }
}
