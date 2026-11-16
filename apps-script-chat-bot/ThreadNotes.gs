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
 * has no note only if the card is younger than that and than 25 hours (an Alert-log row's created_at and source_at, or
 * the createTime of a card just posted, say how old it is). Any other card's notes are counted in its thread, once (the
 * count is then kept; the review's own note is never one of them: acNoteReviewIds_): a card from before the value
 * began, one whose age isn't given, one older than 25 hours. So the
 * cap of 3 holds for a card's life with the cache value gone, too. A key posted again after the value forgot it makes
 * no second message (Chat keeps the message's id, and hands the first one back) and is not counted again; under a full
 * card, Chat is asked whether that key's note is there before the note is refused. The run's count lives in the run
 * itself.
 */

const AC_NOTE_PER_CARD_ = 3;                 // notes under one card in its life, of all kinds together
const AC_NOTE_PER_RUN_ = 6;                  // notes a run, of all kinds together
const AC_NOTE_KEEP_MS_ = 25 * 3600 * 1000;   // a card's count and a note's key are kept this long after the last note
// {s: since when every note is known (ms), c: {hash of the card's thread: [notes, last ms]}, k: {hash of a key: ms}}
const AC_NOTE_CACHE_ = 'ac_thread_notes';
const AC_NOTE_CACHE_SEC_ = 21600;            // the longest the script cache keeps a value: 6 hours
const AC_NOTE_CARDS_MAX_ = 500;              // cards and keys kept, the newest (the value stays under 90,000 characters)
const AC_NOTE_KEYS_MAX_ = 1500;
const AC_NOTE_KEY_PREFIX_ = 'acnote:';       // before the caller's key, in the message's id
const AC_NOTE_OLD_MS_ = 60 * 1000;           // a message Chat hands back that is this much older than the call was there before
const AC_NOTE_THREAD_MAX_ = 200;             // messages of a card's thread read to count its notes (a longer thread: no note)

// This run's notes: {id: poll()'s run (Main.gs currentRunId_; '' outside poll()), flow: outside poll(), the ctx of the
// run built by hand, n}
let AC_NOTE_RUN_ = { id: null, flow: null, n: 0 };

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
 * to count them, or Chat refused it: then nothing was posted, and the caller only counts and logs. `from`, `card`: as
 * for acThreadNoteCheck_; a card that says how old it is (an Alert-log row; {thread, message, createTime} for a card
 * this run posted) saves a read of its thread. Never throws.
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
    // The notes its card has: what the counts say; a card they have nothing for has none only if it is younger than
    // they are and than 25 hours; any other card's notes are counted in its thread, once
    let had = state.c[cardHash] ? Number(state.c[cardHash][0]) || 0 : null;
    if (had === null) {
      const born = acNoteCardBorn_(card);
      if (born > state.s && born >= now - AC_NOTE_KEEP_MS_) {
        had = 0;
      } else {
        const there = acNoteThread_(check, acNoteId_(check.space, k), acNoteReviewIds_(check, card));
        if (!there || !there.card) {
          say('thread note not posted: ' + (there ? 'its card is no longer in the space'
            : 'its card\'s thread couldn\'t be read to count the notes it has'));
          return false;
        }
        had = there.notes;
        state.c[cardHash] = [had, now];
        if (there.own) {  // this very note is in the thread already (the counts had lost its key)
          state.k[keyHash] = now;
          acNoteSave_(state);
          return true;
        }
      }
    }
    if (had >= AC_NOTE_PER_CARD_) {
      // a full card: a key the counts no longer have may be one of the notes that are there (Chat knows it by its id)
      if (acNoteThere_(check.space, k)) {
        state.k[keyHash] = now;
        acNoteSave_(state);
        return true;
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

/** This run's count of notes (see AC_NOTE_RUN_): started afresh for a new run. */
function acNoteRun_(ctx) {
  const id = typeof currentRunId_ === 'function' ? String(currentRunId_() || '') : '';
  const flow = id ? null : ctx || null;
  if (AC_NOTE_RUN_.id !== id || AC_NOTE_RUN_.flow !== flow) AC_NOTE_RUN_ = { id, flow, n: 0 };
  return AC_NOTE_RUN_;
}

/** The id Chat is asked to give the note with `key` in `space` (Chat.gs chatPostMessage_ makes the same one). */
function acNoteId_(space, key) {
  return CLIENT_ID_PREFIX_ + sha256Hex_(`${space}|${AC_NOTE_KEY_PREFIX_}${key}`).slice(0, 40);
}

/**
 * The ids of the review's own note under a card (Bot.gs: posted with the key 'chg:' + the message it reviewed, which is
 * the card itself for one reviewed in place and Burson's own message, the row's source_message, for a corrected copy).
 * That note can be just its last line, "*Alert requirements:* …" (RequirementLine.gs), which starts as a note of this
 * helper does; it is the review's, not one of the notes under another alert's card, so counting a thread leaves it out.
 */
function acNoteReviewIds_(check, card) {
  return [check.message, card && card.source_message].filter(Boolean)
    .map(name => CLIENT_ID_PREFIX_ + sha256Hex_(`${check.space}|chg:${name}`).slice(0, 40));
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
 * What the thread of a card holds (`check`: acThreadNoteCheck_'s): {card: its message is there, notes: the bot's notes
 * under it (replies that start as a note does, from the bot's account when it is known; never the review's own note,
 * known by its id: `reviewIds`, acNoteReviewIds_), own: the message with id `ownId` ('' when there's none)}. null when
 * Chat can't be read, or the thread is longer than AC_NOTE_THREAD_MAX_ messages (its notes can't all be counted). Never
 * throws.
 */
function acNoteThread_(check, ownId, reviewIds) {
  try {
    const bot = (check.ctx && check.ctx.botUser) || PropertiesService.getScriptProperties().getProperty('BOT_USER') || '';
    const out = { card: false, notes: 0, own: '' };
    // (a question the person the bot runs as asks under the card, "Alert requirements: …?", is no note of the bot's:
    // RequirementLine.gs isRequirementQuestion_, while the line is on)
    const settings = (check.ctx && check.ctx.settings) || GEN.settings || {};
    const asked = text => settings.requirement_line !== false && typeof isRequirementQuestion_ === 'function' &&
      isRequirementQuestion_(text);
    let pageToken = '';
    let read = 0;
    do {
      const r = chatCall_('get', check.space + '/messages', { query: { filter: `thread.name = ${check.thread}`, pageSize: 100, pageToken } });
      if (!r || r.code >= 300) return null;
      (r.body.messages || []).forEach(raw => {
        const m = normalizeMessage_(raw);
        read++;
        if (m.name === check.message) out.card = true;
        if (!m.threadReply || m.name === check.message) return;
        if (ownId && m.clientId === ownId) out.own = m.name;
        if (m.clientId && (reviewIds || []).indexOf(m.clientId) >= 0) return;
        if (isThreadNoteText_(m.text) && (!bot || m.senderName === bot) && !asked(m.text)) out.notes++;
      });
      pageToken = r.body.nextPageToken || '';
    } while (pageToken && read < AC_NOTE_THREAD_MAX_);
    return pageToken ? null : out;
  } catch (e) {
    return null;
  }
}

/**
 * The cards' counts and the keys posted, of the last AC_NOTE_KEEP_MS_: {s, c, k}. `s`: since when the value has known
 * every note (now, when the cache has none: it knows nothing from before). Never throws.
 */
function acNoteState_(now) {
  let v = null;
  try { v = JSON.parse(CacheService.getScriptCache().get(AC_NOTE_CACHE_) || 'null'); } catch (e) { v = null; }
  const fresh = at => now - (Number(at) || 0) < AC_NOTE_KEEP_MS_;
  const map = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const known = !!v && typeof v === 'object' && !Array.isArray(v);
  const since = known ? Number(v.s) : 0;
  const out = { s: since > 0 && since <= now ? since : now, c: {}, k: {} };
  const c = map(known && v.c);
  const k = map(known && v.k);
  Object.keys(c).forEach(h => { if (Array.isArray(c[h]) && fresh(c[h][1])) out.c[h] = [Number(c[h][0]) || 0, Number(c[h][1])]; });
  Object.keys(k).forEach(h => { if (fresh(k[h])) out.k[h] = Number(k[h]); });
  return out;
}

/**
 * Writes them back (the newest AC_NOTE_CARDS_MAX_ cards and AC_NOTE_KEYS_MAX_ keys), for another 6 hours. A card's
 * count that has to go for room moves `s` up to its last note: from then on the value no longer knows every note of a
 * card that old, and such a card's notes are counted in its thread again. Never throws.
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
  } catch (e) {
    console.warn(`thread notes: couldn't keep the counts (${(e && e.message) || e}); a card's notes are counted in its thread instead`);
  }
}
