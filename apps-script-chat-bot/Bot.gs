/**
 * Bot.gs — one polling pass over the Burson space.
 *
 *   Only Zapier's own posts are alerts. A person's message (even one that looks like an alert) and any thread reply is
 *   never forwarded to the analyst space; people only get answers in their thread.
 *
 *   Zapier alert          -> review -> forward the corrected alert to the analyst space (always)
 *                            -> if anything is wrong: ⬇️ on Burson's post (legend: "Addressed on updated post below")
 *                               and a fix request in the alert's thread ("please update the alert and resend it here")
 *                            -> escalated (Collection Requirements)? the Social Alert (Drafts.gs): sent to the stand-in
 *                               while testing (then 📰 📦 + team emojis), else a draft; 🧑‍💻 when the leadership
 *                               escalation protocol covers it; not escalated -> ❌. With KB & Guidance can start alerts
 *                               ON (Control tab row 13), Gemini is also asked which Guidance row or Resources document,
 *                               if any, says this post gets a Social Alert (parsed.kbStartAlerts). With Check outage &
 *                               comms docs ON (row 20), Gemini also checks Google's status on an outage / bug / policy
 *                               post and looks for an approved holding statement (parsed.outageComms): analysts get a
 *                               "Comms / Status Context" line, the Social Alert email a block at the bottom, Burson nothing.
 *                               With Learn from IM calls ON (row 17), Gemini also sees the IMs' past calls on similar
 *                               alerts from the Learned precedents tab (parsed.imPrecedents, ctx.learned)
 *                            -> 👍 (legend: "Confirming receipt, no action yet taken") only on a correct alert that is
 *                               still waiting on a person after all that (right away when drafts are off)
 *   Burson's fixed resend -> recognized as the fix that was asked for; ⬇️ on the original. Nothing new is forwarded
 *                            (analysts already have the corrected alert), just a thread note if the resend changed something
 *                            they have, unless the priority or engagement level went up: then it's forwarded as a new alert
 *   Never wait on Burson ON (Control row 23, noWait; OFF it's all as above) -> an alert is processed right away with the
 *                            bot's own corrections (a long video's missing timestamp is Gemini's [MM:SS]); nothing waits
 *                            on Burson (a resend, a missing link or timestamp): the Social Alert, ❌ or the T&S form at
 *                            once, and in the alert's thread what was wrong, what the bot changed and that the alert was
 *                            processed, so there's no need to resend it (no ⬇️: no updated post is waited for). Burson's
 *                            resend anyway is the same alert: ⬇️ on the original, never processed twice, nothing more said,
 *                            unless the priority or engagement went up (forwarded and decided again)
 *   Reply in an alert thread -> questions and pushback are answered there; "ok, will fix" is left as it is
 *   Analyst reacts with a legend emoji on the forwarded copy -> the same emoji goes on Burson's post; group emojis
 *                            add that group to the Social Alert draft, ❌ deletes it
 *   Auto-find missing links ON (Control row 14) -> an alert without its link or author gets them from the listening
 *                            feeds first (BigQuery.gs, only when one post clearly matches): analysts see the link as the
 *                            bot's own correction, and Burson isn't asked for it. Not found (or a post the bot already
 *                            alerted): Burson is asked, as always (Never wait on Burson ON: processed without it, and
 *                            Burson is told it was missing). Burson's resend of it is still taken for its resend
 *   Direct BigQuery alerts ON (Control row 15) -> posts the bot itself put in the test feed / Mirror space from BigQuery
 *                            (BigQuery.gs pollBigQuerySources_) are reviewed like Zapier's, with their source on the
 *                            Alert log (`ingested`). They are never taken for Burson's resend, nor Burson's alert for theirs
 *   Every run             -> drafts that were sent get 📰 📦 + team emojis; retries of emails that failed (and, with Write
 *                            back to SLRR BigQuery ON, of the write-backs BigQuery refused: BigQuery.gs retryBqWriteBacks_);
 *                            with the "Watch sent alerts (24h)" switch ON, sent alerts' posts are re-checked (Watch.gs); with
 *                            "Track post-alert outcomes" ON, replies to sent alerts are read for a week (Outcomes.gs)
 *   Auto-correct test space (ctx.sourceReadOnly, AutoCorrect.gs): the live Burson space is only read. Only Zapier's
 *                            top-level alerts are handled; nothing is ever posted or reacted there. The corrected alert
 *                            goes to the test space on its own, under the bot's "Reviewed (and corrected) by the agentic
 *                            assistant" line, with Gemini's write-up as its summary and the post's own picture, and what
 *                            changed in its thread (ctx.changeNotes); its emojis go on that corrected alert; only what
 *                            Burson alone can add holds back ❌ / 👍 (Never wait on Burson ON: nothing waits on Burson
 *                            there either). A Direct BigQuery card there, posted before its review, gets the note too
 *                            (inPlaceNote_)
 *
 * Pure orchestration over an injected ctx (Main.gs buildCtx_() in Apps Script; a fake one in tests):
 *   ctx.settings, ctx.spaces {burson: {id, name}, analyst: {id, name}}, ctx.store (makeStore_),
 *   ctx.chat {list(space, sinceIso, max, newestFirst), post(space, text, {thread, key}) -> msg, react(messageName, emoji)},
 *   ctx.gemini {assess(parsed) -> llm, answer(question, alertRow, resources, knowledge) -> string, answerAnalyst(question,
 *   alertRow, ctx, knowledge) -> string}, ctx.resources (Resources tab rows), ctx.knowledge (Knowledge.gs loadKnowledge_:
 *   the Resources tab's documents, read before each review and answer), ctx.learned (Speed.gs readLearnedPrecedents_:
 *   the Learned precedents tab's rows, read only while Learn from IM calls is ON),
 *   ctx.cursor {get() -> ms|null, set(ms)}, ctx.recent {has(name), add(name, ms)} (messages handled lately, so a
 *   quiet run never opens the log sheet), ctx.memo {get(key), set(key, value)}, ctx.now() -> ms,
 *   ctx.floor (ms: never read messages older than this), ctx.deadline (ms), ctx.botUser ("users/…" or null), ctx.log(text),
 *   ctx.drafts {on, live, mailbox, from} and ctx.gmail (Mail.gs) for the Social Alert drafts, ctx.switches (Control tab
 *   rows 11-24, 27 and 28) and ctx.findLink(parsed) (BigQuery.gs bqFindMissingLink_, called only while Auto-find missing links is ON).
 *   runOnce_ sets ctx.crashGuard (crashGuard_) for the pass, and ctx.reviewHold ({first, room}: reviewHoldWhyNot_) for
 *   each message it hands on.
 * Messages come normalized from Chat.gs: {name, text, createTime, senderName, senderDisplay, senderType, thread,
 *   threadReply, clientId, mentions, reactions: [{emoji, count}]}.
 */

const CLIENT_ID_PREFIX_ = 'client-bqa-';
const MAX_TEXT_ = 4000;
const LIST_LIMIT_ = 1000;   // messages read per pass (the cursor + overlap window is normally a few minutes)
const MIRROR_DAYS_ = 3;     // analyst reactions on forwards up to this old are copied to Burson's post

function runOnce_(ctx) {
  const S = ctx.settings;
  const report = { seen: 0, handled: 0, alerts: 0, fix_requests: 0, forwarded: 0, resends: 0, answers: 0, acks: 0,
    mirrored: 0, skipped: 0, dead: 0, drafts: 0, drafts_sent: 0, drafts_updated: 0, errors: [] };
  const start = ctx.now();
  // A run that ended partway through a message (out of memory, a time limit): that try is counted first (crashGuard_)
  const guard = crashGuard_(ctx);
  ctx.crashGuard = guard;
  try {
    guard.fold(report);
  } catch (e) {
    report.errors.push(`couldn't count the try a run didn't finish: ${(e && e.message) || e}`);
  }
  const cursor = ctx.cursor.get() || (start - S.start_lookback_minutes * 60 * 1000);
  // Re-read a few minutes before the cursor (late messages), but never before the floor (bot was off / space switched).
  const since = new Date(Math.max(cursor - S.overlap_minutes * 60 * 1000, ctx.floor || 0)).toISOString();
  const msgs = ctx.chat.list(ctx.spaces.burson.id, since, LIST_LIMIT_).sort((a, b) => a.createTime - b.createTime);
  let newCursor = cursor;
  let blocked = false;  // the cursor never moves past a message that will be retried
  const room = ctx.deadline - start;  // this flow's time at its start (an alert held for the next run: reviewHoldWhyNot_)
  const bursonDeadline = ctx.sourceReadOnly && room >= 120 * 1000 ? ctx.deadline - 45 * 1000 : ctx.deadline;
  for (const m of msgs) {
    if (ctx.now() > bursonDeadline) { report.errors.push('time budget reached; the rest is handled next run'); break; }
    if (ctx.sourceReadOnly && m.threadReply) {  // the auto-correct test space only reads Zapier's top-level posts
      if (!blocked) newCursor = Math.max(newCursor, m.createTime);
      continue;
    }
    report.seen++;
    if (ctx.recent.has(m.name) || ctx.store.isDone(m.name)) {
      ctx.recent.add(m.name, m.createTime);
      if (!blocked) newCursor = Math.max(newCursor, m.createTime);
      continue;
    }
    if (report.handled >= S.max_messages_per_run) break;
    if (!runOwned_()) { ctx.deadline = ctx.now(); break; }  // another run took over (Main.gs): it does the rest, not this one
    report.handled++;
    // Its tries were used up by runs that ended partway through it (crashGuard_ counted them): given up on now, as a
    // message whose tries all failed with an error is (forwarded to analysts as received, never dropped)
    const tried = guard.on ? ctx.store.attempts(m.name) : 0;
    if (tried >= S.max_attempts) {
      guard.start(m.name, 'give_up');
      try {
        giveUp_(ctx, m, report, tried);
      } finally {
        guard.end();
      }
      guard.done(m.name);
      ctx.recent.add(m.name, m.createTime);
      if (!blocked) newCursor = Math.max(newCursor, m.createTime);
      continue;
    }
    // Whether an alert in it may wait for the next run, when this one is too short for its post's video (handleAlert_)
    ctx.reviewHold = { first: report.handled === 1, room };
    guard.start(m.name, 'handling');
    try {
      handleMessage_(ctx, m, report);
      guard.done(m.name);
      ctx.recent.add(m.name, m.createTime);
      if (!blocked) newCursor = Math.max(newCursor, m.createTime);
    } catch (e) {
      if (e && e.holdReview) {  // held for the next run, which reviews it first: not a failure, and nothing after it goes ahead
        report.handled--;
        report.held = (report.held || 0) + 1;
        ctx.log(`held ${m.name} for the next run: ${e.message}`);
        blocked = true;
        break;
      }
      const attempts = ctx.store.markFailed(m.name, (e && e.message) || e);
      ctx.log(`message ${m.name} failed (attempt ${attempts}): ${(e && e.stack) || e}`);
      let givenUp = false;
      if (attempts >= S.max_attempts) {
        guard.start(m.name, 'give_up');
        giveUp_(ctx, m, report, attempts);
        guard.done(m.name);
        givenUp = true;
      }
      if (givenUp) {
        ctx.recent.add(m.name, m.createTime);
        if (!blocked) newCursor = Math.max(newCursor, m.createTime);
      } else {
        report.errors.push(`${m.name}: ${(e && e.message) || e}`);
        blocked = true;
      }
    } finally {
      ctx.reviewHold = null;
      guard.end();
    }
  }
  ctx.cursor.set(newCursor);
  const analystMinMs = ctx.sourceReadOnly ? 20 * 1000 : 60 * 1000;
  if (!ctx.outboundBlocked && ctx.deadline - ctx.now() > analystMinMs) {
    try { pollAnalystMessages_(ctx, report); } catch (e) { report.errors.push('reading analyst messages: ' + ((e && e.message) || e)); }
  } else if (ctx.sourceReadOnly) {
    report.analyst_backlog = true;
  }
  const mirror = S.mirror_analyst_reactions && S.react && !S.dry_run && !ctx.outboundBlocked && !ctx.sourceReadOnly;
  if ((mirror || draftsOn_(ctx)) && ctx.deadline - ctx.now() > 60 * 1000) {
    try { analystReactions_(ctx, report, mirror); } catch (e) { report.errors.push('reading analyst reactions: ' + ((e && e.message) || e)); }
  }
  if (ctx.gmail && ctx.deadline - ctx.now() > 45 * 1000) {
    try { maintainDrafts_(ctx, report); } catch (e) { report.errors.push('checking Social Alert drafts: ' + ((e && e.message) || e)); }
  }
  if (ctx.gmail && ctx.deadline - ctx.now() > 30 * 1000) {
    try { checkTnsEmails_(ctx, report); } catch (e) { report.errors.push('checking for T&S confirmations: ' + ((e && e.message) || e)); }
  }
  if (switchOn_(ctx, 'writeBackBq') && ctx.deadline - ctx.now() > 30 * 1000) {  // Write back to SLRR BigQuery: its retries
    try { retryBqWriteBacks_(ctx, report); } catch (e) { ctx.log('retrying the BigQuery write-backs: ' + ((e && e.message) || e)); }
  }
  if (switchOn_(ctx, 'watchSent') && ctx.gmail && ctx.deadline - ctx.now() > 45 * 1000) {  // Control tab: Watch sent alerts
    try { watchSentAlerts_(ctx, report); } catch (e) { report.errors.push('watching sent Social Alerts: ' + ((e && e.message) || e)); }
  }
  if (switchOn_(ctx, 'trackOutcomes') && ctx.gmail && ctx.deadline - ctx.now() > 45 * 1000) {  // Control tab: Track post-alert outcomes
    try { trackOutcomes_(ctx, report); } catch (e) { report.errors.push('tracking what came of sent Social Alerts: ' + ((e && e.message) || e)); }
  }
  return report;
}

/**
 * A message whose max_attempts tries all failed: a Zapier alert is forwarded to analysts as received (forwardAsReceived_),
 * anything else is set aside; when not even that works, it's given up on and the Control tab says so. Never dropped
 * silently.
 */
function giveUp_(ctx, m, report, attempts) {
  try {
    forwardAsReceived_(ctx, m, report, 'couldn\'t review this alert automatically');
  } catch (e2) {  // not even the as-received forward works: stop retrying this one and say so
    ctx.store.markDone(m.name, 'dead');
    report.dead++;
    report.errors.push(`gave up on a message after ${attempts} tries: ${(e2 && e2.message) || e2}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A message that crashes the run
// ---------------------------------------------------------------------------------------------------------------
//
// Apps Script ends a run outright when it runs out of memory ("Out of memory error."), hits its time limit or has an
// internal error: no catch or finally runs, so the message it was on would be tried again, the same way, by every run
// after it (Oct 24-26: one Bluesky video's review crashed 119 runs in a row, and nothing behind it was reviewed). So a
// run in poll() (Main.gs currentRunId_) notes in ctx.memo which message it's on ('handling': {msg, run, stage, media,
// at}; stage: handling | review | give_up) and clears the note once the message is done or failed the ordinary way. A
// note another run left is a run that ended partway through that message. The next run:
//   - counts it as a failed try on the Message log (Store.gs markFailed), as an error is: after max_attempts tries the
//     alert is forwarded to analysts as received (giveUp_), never dropped;
//   - when it ended in the alert's review, gives that alert's next review less to work with, one step each time
//     ('review_held': {message: {media, crashes, at}}): the post's own media (its video, audio or photos), then a still
//     of the post (Burson's screenshot, a frame of the video), then the alert text alone (Gemini.gs assess, opts.media).
//     The forwarded alert says what Gemini didn't get (Review.gs mediaHeldNote_), so analysts check that themselves;
//   - when it ended while giving up on the message, stops trying it and says so on the Control tab (as when the
//     as-received forward fails).
// Only in poll(): the editor and hand-built runs (the tests' world()) keep no notes. Each flow (the main one, the
// auto-correct space's) has its own notes, as it has its own memo.
// ---------------------------------------------------------------------------------------------------------------

const HANDLING_MEMO_ = 'handling';
const REVIEW_HELD_MEMO_ = 'review_held';
const REVIEW_MEDIA_STEPS_ = ['full', 'still', 'none'];  // what a review may attach: all of it, a still, none of it
const REVIEW_HELD_KEEP_MS_ = 3 * 24 * 3600 * 1000;  // a held review this old is forgotten (its alert is long done)
const REVIEW_HELD_MAX_ = 20;
const RUN_ENDED_WHY_ = 'Apps Script stopped it (out of memory, a time limit or an internal error)';

/** What a review had, in words, for the run log. Pure. */
function reviewMediaWords_(media) {
  return { full: 'the post\'s own media', still: 'a still of the post', none: 'the alert text only' }[media] || String(media || '');
}

/** This run's notes (see above): {on, fold(report), held(name), start(name, stage), review(name, media), reviewed(name), end(), done(name)}. */
function crashGuard_(ctx) {
  const run = typeof currentRunId_ === 'function' ? currentRunId_() : '';
  const on = !!run && !!ctx.memo;
  const read = k => { try { return JSON.parse(ctx.memo.get(k) || 'null'); } catch (e) { return null; } };
  const drop = k => (typeof ctx.memo.delete === 'function' ? ctx.memo.delete(k) : ctx.memo.set(k, ''));
  let held = null;  // review_held, read once a run
  const heldAll = () => {
    if (!held) {
      const h = read(REVIEW_HELD_MEMO_);
      held = h && typeof h === 'object' && !Array.isArray(h) ? h : {};
    }
    return held;
  };
  const saveHeld = () => {
    const now = ctx.now();
    const keep = Object.keys(heldAll()).map(k => [k, held[k]])
      .filter(([, v]) => v && now - Number(v.at || 0) < REVIEW_HELD_KEEP_MS_)
      .sort((a, b) => Number(b[1].at) - Number(a[1].at)).slice(0, REVIEW_HELD_MAX_);
    held = {};
    keep.forEach(([k, v]) => { held[k] = v; });
    if (keep.length) ctx.memo.set(REVIEW_HELD_MEMO_, JSON.stringify(held));
    else drop(REVIEW_HELD_MEMO_);
  };
  const note = (msg, stage, media) => ctx.memo.set(HANDLING_MEMO_,
    JSON.stringify(Object.assign({ msg, run, stage }, media ? { media } : {}, { at: ctx.now() })));
  return {
    on,
    /** Counts the try a run that ended partway through a message left its note on (see above): {msg, tries} or null. */
    fold(report) {
      if (!on) return null;
      const left = read(HANDLING_MEMO_);
      if (!left || !left.msg || left.run === run) return null;
      if (ctx.store.isDone(left.msg)) {  // it ended after the message was done
        drop(HANDLING_MEMO_);
        return null;
      }
      if (left.stage === 'give_up') {  // not even forwarding it as received got through: it isn't tried again
        ctx.store.markDone(left.msg, 'dead');
        drop(HANDLING_MEMO_);
        report.dead++;
        report.errors.push(`gave up on a message: a run ended partway through forwarding it as received (${RUN_ENDED_WHY_})`);
        return { msg: left.msg, tries: ctx.store.attempts(left.msg) };
      }
      const inReview = left.stage === 'review';
      const where = inReview ? ` in its review (with ${reviewMediaWords_(left.media)})` : '';
      let next = '';
      if (inReview) {  // first, so that even if the Message log can't be written, its next review gets less
        const all = heldAll();
        const was = all[left.msg] || {};
        next = REVIEW_MEDIA_STEPS_[Math.min(Math.max(REVIEW_MEDIA_STEPS_.indexOf(left.media), 0) + 1, REVIEW_MEDIA_STEPS_.length - 1)];
        all[left.msg] = { media: next, crashes: (Number(was.crashes) || 0) + 1, at: ctx.now() };
        saveHeld();
      }
      const tries = ctx.store.markFailed(left.msg, `a run ended partway through this message${where}: ${RUN_ENDED_WHY_}`);
      drop(HANDLING_MEMO_);
      const max = Number(ctx.settings.max_attempts) || 0;
      ctx.log(`a run ended partway through ${left.msg}${where}: ${RUN_ENDED_WHY_}. Counted as try ${tries} of ${max}` +
        (tries >= max ? '; it\'s forwarded as received now' : next ? `; its next review gets ${reviewMediaWords_(next)}` : ''));
      return { msg: left.msg, tries };
    },
    /** How an earlier review of this message crashed the run: {media: 'still' | 'none', crashes}, or null (all its media). */
    held(name) {
      if (!on) return null;
      const h = heldAll()[name];
      return h && REVIEW_MEDIA_STEPS_.indexOf(h.media) > 0 ? h : null;
    },
    start(name, stage) { if (on) note(name, stage || 'handling'); },
    review(name, media) { if (on) note(name, 'review', media); },
    reviewed(name) { if (on) note(name, 'handling'); },
    end() { if (on) drop(HANDLING_MEMO_); },
    /** The message is done (handled, or given up on): its held review is forgotten. */
    done(name) {
      if (on && heldAll()[name]) {
        delete held[name];
        saveHeld();
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// An alert held for the next run
// ---------------------------------------------------------------------------------------------------------------
//
// A review gets the post's video or audio only with GEMINI_MEDIA_MIN_LEFT_MS_ of the run left (Gemini.gs assess): a clip
// can make it run long, and a call can't be stopped once it has started. Pictures (photos, a frame, a cover, Burson's
// screenshot) go whatever time is left, as the alert text does: a review with them takes no longer (Oct 21-24: with
// photos, median 37 s and p95 80 s; from the text alone, median 46 s and p95 133 s). Until Oct 26 a run short of that
// time left the post's media out altogether, and nobody was told: 89 reviews in Oct 21-24, 63 of them of posts with no
// video or audio at all (photos, or a screenshot at most), 19 of video posts.
// When a run is too short for an alert's clip, the alert waits for the next run (assess throws an error marked
// holdReview; runOnce_ stops there: alerts are worked in order, and nothing is counted as a failure), which reviews it
// first, with all of it: about one run later (4-5 minutes while alerts are coming in). Only where that helps and can't
// pile up:
//   - never the first message a run handles: every run moves on;
//   - only in a pass that had the time for a clip when it started (GEMINI_MEDIA_MIN_LEFT_MS_ + REVIEW_HOLD_PREP_MS_):
//     the auto-correct space runs in what the main flow leaves, so while the main flow is busy it never does;
//   - at most once per alert, and only while it's fresh (under REVIEW_HOLD_MAX_AGE_MS_ since it reached the live Burson
//     space): a backlog is never slowed down by holds.
// Otherwise Gemini gets a still of the post (Media.gs stillMedia_), and the forwarded alert says what Gemini didn't get
// and why (Review.gs mediaMissedNote_). A held alert keeps the time the bot first picked it up as its seen_at, so the
// Speed tab counts the wait as part of its review.
// ---------------------------------------------------------------------------------------------------------------

const REVIEW_HOLD_MAX_AGE_MS_ = 10 * 60 * 1000;  // an alert this long in the live Burson space isn't held (a backlog)
const REVIEW_HOLD_PREP_MS_ = 30 * 1000;          // the post lookup, the listening feeds and the knowledge base before it
const REVIEW_WAITS_MEMO_ = 'review_waits';       // {message: {seen, at}}: alerts held for the next run
const REVIEW_WAITS_KEEP_MS_ = 24 * 3600 * 1000;
const REVIEW_WAITS_MAX_ = 20;

/**
 * Why this alert can't wait for the next run ('' when it can; see above). ctx.reviewHold: runOnce_'s note for the
 * message ({first, room}); `waited`: it was held once already (reviewWaits_).
 */
function reviewHoldWhyNot_(ctx, m, waited) {
  const h = ctx.reviewHold;
  if (!h) return 'only the polling pass holds alerts';
  if (h.first) return 'it\'s the first message this run handled (every run reviews at least one)';
  const need = GEMINI_MEDIA_MIN_LEFT_MS_ + REVIEW_HOLD_PREP_MS_;
  if (!(h.room >= need)) return `this pass had ${secondsLeft_(h.room)} s when it started, under the ${need / 1000} s a video review needs`;
  if (waited) return 'it was held once already';
  const age = ctx.now() - sourceAt_(m);
  if (!(age < REVIEW_HOLD_MAX_AGE_MS_)) return `it reached the Burson space ${Math.round(age / 60000)} minutes ago (a backlog isn't held up)`;
  return '';
}

/**
 * The alerts this flow held for the next run (its own memo): {get(name) -> {seen, at} | null, add(name, seen),
 * drop(name)}. Kept a day at most. Writing it never throws (a hold isn't turned into a failure by it).
 */
function reviewWaits_(ctx) {
  const memo = ctx.memo || null;
  const read = () => {
    try {
      const v = JSON.parse((memo && memo.get(REVIEW_WAITS_MEMO_)) || 'null');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
      return {};
    }
  };
  const save = all => {
    try {
      const now = ctx.now();
      const keep = Object.keys(all).filter(k => all[k] && now - Number(all[k].at || 0) < REVIEW_WAITS_KEEP_MS_)
        .sort((a, b) => Number(all[b].at) - Number(all[a].at)).slice(0, REVIEW_WAITS_MAX_);
      if (keep.length) {
        const out = {};
        keep.forEach(k => { out[k] = all[k]; });
        memo.set(REVIEW_WAITS_MEMO_, JSON.stringify(out));
      } else if (typeof memo.delete === 'function') {
        memo.delete(REVIEW_WAITS_MEMO_);
      } else {
        memo.set(REVIEW_WAITS_MEMO_, '');
      }
    } catch (e) {
      ctx.log(`couldn't note the alerts held for the next run: ${(e && e.message) || e}`);
    }
  };
  return {
    get(name) { return memo ? read()[name] || null : null; },
    add(name, seen) {
      if (!memo) return;
      const all = read();
      if (!all[name]) all[name] = { seen: Number(seen) || ctx.now(), at: ctx.now() };
      save(all);
    },
    drop(name) {
      if (!memo) return;
      const all = read();
      if (!all[name]) return;
      delete all[name];
      save(all);
    },
  };
}

function handleMessage_(ctx, m, report) {
  if (isOwnMessage_(ctx, m)) { ctx.store.markDone(m.name, 'own'); report.skipped++; return; }
  if (m.threadReply && ctx.spaces.burson.id === campaignAlertsSpace_(ctx)) {
    if (isCampaignOwnedThread_(ctx, ctx.spaces.burson.id, m.thread)) {
      ctx.store.markDone(m.name, 'campaign_owned');
      report.skipped++;
      return;
    }
    if (isCampaignHandoffRequest_(ctx, ctx.spaces.burson.id, m)) {
      handOffThreadToCampaigns_(ctx, ctx.spaces.burson.id, m);
      ctx.store.markDone(m.name, 'campaign_handoff');
      report.skipped++;
      return;
    }
  }
  // Relay with S-F Burson (Control row 22, Relay.gs): what came from Burson is Burson's (answered here, for the analysts;
  // never relayed back); an analyst's message is the relay's to send, never answered as if it were Burson's
  const relayed = relayedFrom_(ctx, m);
  if (relayed) {
    // an alert a person pasted (in Burson's format; at the top level, in another format too: OtherAlerts.gs): as in the
    // live space, never answered
    if (detectAlert_(relayed.text, parseAlert_(relayed.text), relayed.who) ||
        (!m.threadReply && otherAlertOf_(relayed.text, relayed.who, m.links))) {
      ctx.store.markDone(m.name, 'ignored');
      report.skipped++;
      return;
    }
    handleHuman_(ctx, Object.assign({}, m, { text: relayed.text, senderDisplay: relayed.who, mentions: relayed.mentions || [],
      relayed: true }), report);
    return;
  }
  // A temp check request (Control row 36, TempCheck.gs): an analyst's "temp check …" in a Google-only space the bot works,
  // queued for after this run's alerts and answered in its thread; never relayed to S-F Burson (Relay.gs relayAnalyst_
  // says it isn't an analyst's message for Burson) nor answered as a question
  const tempAsk = tempCheckRequestOf_(ctx, m);
  if (tempAsk) {
    tempCheckQueue_(ctx, m, tempAsk);
    ctx.store.markDone(m.name, 'temp_check');
    return;
  }
  if (relayOn_(ctx) && relayAnalyst_(ctx, m)) { ctx.store.markDone(m.name, 'analyst'); report.skipped++; return; }
  const src = bursonSource_(ctx, m);
  // The auto-correct test space only reads the Burson space: people's messages there are never handled or answered
  if (ctx.sourceReadOnly && (!src.zapier || m.threadReply)) { report.skipped++; return; }
  const msg = src.text === m.text && src.sender === m.senderDisplay ? m : Object.assign({}, m, { text: src.text, senderDisplay: src.sender });
  // A watch alert (WatchAlerts.gs, Control row 35): the bot's own post of a Proactive watch flag in a one-space flow (the
  // Mirror space, or the Other alerts space B33), worked like an alert in another format with the watch's call
  // (OtherAlerts.gs otherDecide_: ❌ when it repeats an alert already sent, else its Social Alert). Never a person's copy.
  if (!m.threadReply && otherAlertsHere_(ctx)) {
    const watched = pwAlertOf_(ctx, m);
    if (watched) {
      report.alerts++;
      try {
        handleOtherAlert_(ctx, msg, watched, report);
      } catch (e) {
        if (e && e.holdReview) report.alerts--;  // held for the next run (runOnce_): counted when it's reviewed
        throw e;
      }
      return;
    }
  }
  // An early-detection alert (BigQuery.gs earlyWaveCheck_ -> EarlyDetection.gs handleEarlyDetection_, Control row 19):
  // open-world low-tier semantic cluster or velocity build-up, reviewed with its own discovery schema, emoji marks, and
  // human-gated Social Alert / Temp Check / T&S drafting.
  if (!m.threadReply && !ctx.sourceReadOnly && typeof edAlertOf_ === 'function') {
    const earlyDet = edAlertOf_(ctx, m);
    if (earlyDet) {
      report.alerts++;
      try {
        handleEarlyDetection_(ctx, msg, earlyDet, report);
      } catch (e) {
        if (e && e.holdReview) report.alerts--;
        throw e;
      }
      return;
    }
  }
  // An alert in another format than Burson's (OtherAlerts.gs: a campaign, Brandwatch or Chrome alert…), in a one-space
  // flow (the Mirror space, the Other alerts space B33, or B25 while the bot works directly in it: Control row 32): an
  // app's or tool's top-level post, or, working directly in a space (B33, or B25 with row 32), anyone's. Burson's own
  // alerts never come here (otherAlertOf_ leaves them to the review)
  if (!m.threadReply && otherAlertsHere_(ctx) && (src.zapier || ctx.direct) && !src.copied) {
    const other = otherAlertOf_(src.text, src.sender, m.links);
    if (other) {
      report.alerts++;
      try {
        handleOtherAlert_(ctx, msg, other, report);
      } catch (e) {
        if (e && e.holdReview) report.alerts--;  // held for the next run (runOnce_): counted when it's reviewed
        throw e;
      }
      return;
    }
  }
  // Working directly in a space (B33, or B25 with row 32): an alert in Burson's format anyone posted there is worked as Zapier's
  const anyonesAlert = !!ctx.direct && !m.threadReply && !src.copied && m.senderType !== 'BOT';
  if ((src.zapier || anyonesAlert) && !m.threadReply) {  // only Zapier's own posts reach the analysts
    const parsed = parseAlert_(src.text);
    if (detectAlert_(src.text, parsed, src.sender)) {
      report.alerts++;
      try {
        handleAlert_(ctx, msg, parsed, report);
      } catch (e) {
        if (e && e.holdReview) report.alerts--;  // held for the next run (runOnce_): counted when it's reviewed
        throw e;
      }
      return;
    }
    if (m.senderType === 'BOT' || src.copied) {  // a Zapier post the bot can't read still reaches analysts (unless empty)
      if (src.text.trim()) forwardAsReceived_(ctx, m, report, 'couldn\'t read this message\'s format');
      else { ctx.store.markDone(m.name, 'ignored'); report.skipped++; }
      return;
    }
  }
  // Never forwarded: reposted chatter, app posts in threads, and alerts a person posted (in a thread or not; at the top
  // level, in another format too: OtherAlerts.gs), which are never answered as if they were questions either
  if (src.copied || m.senderType === 'BOT' || detectAlert_(src.text, parseAlert_(src.text), src.sender) ||
      (!m.threadReply && otherAlertOf_(src.text, src.sender, m.links))) {
    ctx.store.markDone(m.name, 'ignored');
    report.skipped++;
    return;
  }
  handleHuman_(ctx, msg, report);
}

// The tool that fills the test space reposts each message as "Logged from Source (Row N)\nUser: …\nMessage: …".
const COPIED_ROW_RX_ = /^\s*Logged from Source \(Row \d+\)[ \t]*\r?\n[ \t]*User:[ \t]*([^\r\n]*)\r?\n[ \t]*Message:[ \t]*([\s\S]*)$/i;
const ZAPIER_CREDIT_RX_ = /^[ \t]*Zap sent by @[^\r\n]*(\r?\n)?/gim;

/**
 * Who really posted a Burson-space message, and its text: {zapier, copied, sender, text}. Only Zapier's posts are alerts.
 *   - A repost by the tool that fills the test space is judged by its "User:" line and read without that header.
 *   - Any app's post (or a post copied by Mirror.gs with client-zmir-) counts as Zapier's.
 *   - In a test space, an alert pasted from the bot's own account stands in for a Zapier post (never in S-F Burson,
 *     ctx.sfBurson: the Control tab's B25, nor in any space people outside Google can join).
 * Zapier's "Zap sent by @…" credit line is dropped. When the text isn't an alert but the message's card is (or the text
 * is empty), the card is read instead: Zapier can post an alert as a card.
 */
function bursonSource_(ctx, m) {
  const copied = String(m.text || '').match(COPIED_ROW_RX_);
  const mirrored = !!m.clientId && String(m.clientId).indexOf(MIRROR_CLIENT_ID_PREFIX_) === 0;
  const sender = copied ? copied[1].trim() : String(m.senderDisplay || '');
  let zapier;
  if (copied) zapier = /\bzapier\b/i.test(sender);
  else if (mirrored || m.senderType === 'BOT') zapier = true;
  else zapier = !!ctx.botUser && m.senderName === ctx.botUser && !isSfBurson_(ctx.sfBurson, ctx.spaces.burson.id) &&
    !ctx.spaces.burson.externalUserAllowed;
  const clean = s => (/^[ \t]*Zap sent by @/im.test(String(s || '')) ? String(s).replace(ZAPIER_CREDIT_RX_, '').trim() : String(s || ''));
  let text = clean(copied ? copied[2].trim() : m.text);
  if (zapier && !copied && m.cardText) {
    const card = clean(m.cardText).trim();
    const isAlert = t => !!t.trim() && detectAlert_(t, parseAlert_(t), sender);
    if (card && (!text.trim() || (!isAlert(text) && isAlert(card)))) text = card;
  }
  return { zapier, copied: !!copied || mirrored, sender, text };
}

/**
 * The bot's own posts. Its id says so (also an analyst's message it relayed to S-F Burson): Chat's custom id or, with
 * Chat refusing custom ids, the id the bot meant it to have (Chat.gs normalizeMessage_ fills it in). Without one (the
 * bot's record of its posts dropped), a post by the bot's account is its own when only the bot writes that text
 * (Voice.gs isBotFormattedText_), or when this flow's Message log has it as the bot's (own_post: every answer and every
 * Burson-space post, kept for good: postTo_). So the bot never takes its own answer for a person's question.
 */
function isOwnMessage_(ctx, m) {
  if (!m) return false;
  if (m.clientId) {
    return String(m.clientId).indexOf(CLIENT_ID_PREFIX_) === 0 ||
      String(m.clientId).indexOf(RELAY_OUT_PREFIX_) === 0 ||
      String(m.clientId).indexOf(CAMPAIGN_CLIENT_PREFIX_) === 0;
  }
  if (!ctx.botUser || m.senderName !== ctx.botUser) return false;
  // (the Auto-correct flow with the line on: a question from the bot's account that starts as the line on the alert
  // requirements does is the person's the bot runs as: RequirementLine.gs isRequirementQuestion_)
  const asked = typeof requirementLineOn_ === 'function' && requirementLineOn_(ctx) &&
    typeof isRequirementQuestion_ === 'function' && isRequirementQuestion_(m.text);
  if (!asked && (typeof isBotFormattedText_ === 'function' ? isBotFormattedText_(m.text) : String(m.text || '').trim().indexOf(GEN.prefix) === 0)) {
    return true;
  }
  try {
    return !!(ctx.store && ctx.store.isOwnPost(m.name));
  } catch (e) {
    return false;
  }
}

// The loop backstop (selfAnswerOk_): a message from the bot's own account gets at most this many answers per thread in
// SELF_ANSWER_WINDOW_MS_. The person the bot runs as asks a few at most; the bot answering itself would ask one a minute.
const SELF_ANSWER_MAX_ = 3;
const SELF_ANSWER_WINDOW_MS_ = 15 * 60 * 1000;

/**
 * Whether the bot may answer message `m` (true for anyone but the bot's own account). For the bot's account (the person
 * it runs as, who can also ask), at most SELF_ANSWER_MAX_ answers per thread in SELF_ANSWER_WINDOW_MS_ (ctx.memo
 * 'self_answers'), counted here when it may: even if nothing else told the bot's posts apart, it can never keep
 * answering itself. Never throws (a memo that can't be read allows the answer and starts the count afresh).
 */
function selfAnswerOk_(ctx, m) {
  if (!ctx || !m || m.relayed || !ctx.botUser || m.senderName !== ctx.botUser || !ctx.memo) return true;
  const now = ctx.now();
  let log = {};
  try { log = JSON.parse(ctx.memo.get('self_answers') || '{}') || {}; } catch (e) { log = {}; }
  const key = hashText_(String(m.thread || m.name));
  const kept = {};
  Object.keys(log).forEach(k => {
    const times = (Array.isArray(log[k]) ? log[k] : []).map(Number).filter(t => now - t < SELF_ANSWER_WINDOW_MS_);
    if (times.length) kept[k] = times;
  });
  const times = kept[key] || [];
  if (times.length >= SELF_ANSWER_MAX_) {
    ctx.log(`loop guard: not answering ${m.name}: the bot's account already got ${times.length} answers in this thread ` +
      `in the last ${Math.round(SELF_ANSWER_WINDOW_MS_ / 60000)} minutes`);
    return false;
  }
  kept[key] = times.concat([now]);
  try { ctx.memo.set('self_answers', JSON.stringify(kept)); } catch (e) { /* counted again next time */ }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------------------------------------------

function handleAlert_(ctx, m, parsed, report) {
  const S = ctx.settings;
  const now = ctx.now();
  parsed.seen_at = now;  // when the bot picked the alert up (the Speed tab: waiting vs reviewing vs sending)
  const existing = ctx.store.alertBySource(m.name);
  if (existing) { finishAlert_(ctx, m, existing, report); return; }  // recorded on an earlier, interrupted attempt
  // Auto-find missing links (Control row 14): a missing link or author from the listening feeds, before anything uses them
  if (switchOn_(ctx, 'autoFindLinks')) findMissingLink_(ctx, parsed, report);
  // Direct BigQuery alerts (Control row 15) and Sheet test alerts (SheetTestAlert.gs): posted by the bot into the test space
  const ingested = bqIngestedSource_(ctx, m) || (typeof sheetTestSource_ === 'function' ? sheetTestSource_(ctx, m) : '');
  const isSheetTest = Boolean(ingested && typeof SHEET_TEST_INGESTED_ === 'string' && ingested === SHEET_TEST_INGESTED_);
  if (ingested) parsed.ingested = ingested;
  const key = recordKey_(parsed.fields);
  const tokens = issueTokens_(parsed.fields.issue_name || parsed.fields.alert_name);
  // ...so it's never a resend of Burson's, and Burson's alert never a resend of it (nobody asked Burson to fix that one)
  const asked = ingested ? null
    : ctx.store.findPendingFix(key, tokens, now - S.pending_fix_hours * 3600 * 1000, parsed.fields.author, switchOn_(ctx, 'noWait'));
  const pending = asked && !asked.ingested ? asked : null;
  // Auto-find missing links (Control row 14): Burson's resend, still without the link, of an alert whose link the bot
  // found keeps that link (Burson was never asked for it)
  if (pending && switchOn_(ctx, 'autoFindLinks')) keepFoundLink_(ctx, parsed, pending);
  // The post itself (Post.gs): its own words, the thread it's in, what it quotes, and its video / photos for Gemini
  if (!isSheetTest && parsed.post === undefined && S.post_lookup !== false && typeof ctx.post === 'function') {
    try { parsed.post = ctx.post(parsed.fields.post_url) || null; } catch (e) { parsed.post = null; }
    if (parsed.post) ctx.log(`post: ${postBrief_(parsed.post)}`);
  }
  if (!isSheetTest && !parsed.bq && typeof ctx.bq === 'function') {
    try { parsed.bq = ctx.bq(parsed); } catch (e) { parsed.bq = null; }
    // the post as the listening feeds captured it (BigQuery.gs feedTextPrompt_), for posts the bot can't open itself
    const feed = typeof feedBrief_ === 'function' ? feedBrief_(parsed.bq) : '';
    if (feed) ctx.log(`feed text: ${feed}`);
  }
  // "Already reported" history: every forwarded alert except the one this message resends.
  const history = ctx.store.recentForwarded(now - GEN.novelty_days * DAY_MS_)
    // (where stories go first, a story's card that sent no Social Alert is no earlier alert for the Direct BigQuery
    // card of its own main post: BigQuery.gs bqStoryOnOwnPost_; everywhere else it leaves every row in)
    .filter(h => !bqStoryOnOwnPost_(ctx, isSheetTest ? '' : ingested, key, h, now))
    .filter(h => !pending || h.forward_message !== pending.forward_message);
  // Earlier alerts this one may repeat or follow up on (same post, same author, or a post it replies under or quotes):
  // Gemini sees them too
  if (!isSheetTest && S.follow_ups !== false) parsed.earlier = earlierAlerts_(parsed.fields, history, parsed.bq, now, parsed.post);
  // (a Direct BigQuery card whose post a story card that went out as a Social Alert links: that story's alert is an
  // earlier alert on this post, in the Auto-correct flow with cross_alert_notes on: EarlyDetectionCross.gs)
  if (!isSheetTest && S.follow_ups !== false && bqDirectSource_(ingested)) {
    parsed.earlier = edWithSharedPost_(ctx, parsed.earlier, key, history, now);
  }
  // The issues already alerted in the last 14 days most like this one (IssueNames.gs): Gemini says whether the alert is
  // one of them, so it keeps that issue's name instead of starting a second name for it
  if (!isSheetTest && S.follow_ups !== false) parsed.knownIssues = knownIssuesFor_(ctx, parsed, history, now);
  // The SLRR leads' current guidance on what to escalate (the Guidance tab and their recent emails)
  try { parsed.guidance = ctx.guidance || []; } catch (e) { parsed.guidance = []; }
  // KB & Guidance can start alerts (Control tab row 13): Gemini cites the row or document that says to alert, if any
  if (switchOn_(ctx, 'kbStartAlerts')) parsed.kbStartAlerts = true;
  // Check outage & comms docs (Control tab row 20): Gemini checks Google's status on an outage / bug / policy post and
  // looks for an approved holding statement (the knowledge base search looks for them too)
  if (switchOn_(ctx, 'outageComms')) parsed.outageComms = true;
  // Never wait on Burson (Control tab row 23): a long video's missing timestamp is the bot's own correction (Review.gs)
  if (switchOn_(ctx, 'noWait')) parsed.noWait = true;
  // The Auto-correct space (AutoCorrect.gs): the review call also writes the alert's summary paragraph (Review.gs
  // writeupPrompt_), unless settings.autocorrect_writeup is false. A sheet-test card gets no Gemini review
  if (ctx.changeNotes && !isSheetTest && S.autocorrect_writeup !== false) parsed.writeup = true;
  // The knowledge base (Knowledge.gs): the Resources tab's documents, the parts that bear on this alert
  try {
    parsed.knowledge = knowledgeForCtx_(ctx, knowledgeQuery_(parsed), { budget: KNOWLEDGE_REVIEW_CHARS_, pin: true });
  } catch (e) {
    parsed.knowledge = null;
    ctx.log('knowledge base unavailable for this review: ' + ((e && e.message) || e));
  }
  if (parsed.knowledge && parsed.knowledge.docs.length) ctx.log(`knowledge: ${knowledgeBrief_(parsed.knowledge)}`);
  // Learn from IM calls (Control tab row 17): the IMs' past calls on alerts like this one (the Learned precedents tab)
  if (switchOn_(ctx, 'learnIm')) imPrecedentsFor_(ctx, parsed);
  if (!isSheetTest && typeof vecTagHints_ === 'function' && typeof vecTagHintLine_ === 'function') {
    try {
      const hText = [parsed.fields.issue_name || parsed.fields.alert_name || '', parsed.fields.summary || '',
        (parsed.post && parsed.post.text) || parsed.fields.post_content || ''].filter(Boolean).join(' — ').slice(0, 1200);
      const hint = hText ? (vecTagHints_([hText], { deadline: ctx.deadline }) || [])[0] : null;
      if (hint) parsed.tagHintLine = vecTagHintLine_(hint);
    } catch (e) {}
  }
  const memoryStory = !isSheetTest && typeof amNoveltyFor_ === 'function' ? amNoveltyFor_(ctx, parsed.fields) : null;
  // Gemini's review, with the crash guard and the hold for the next run (guardedAssess_)
  const { llm, llmError, held } = isSheetTest ? { llm: null, llmError: '', held: null } : guardedAssess_(ctx, m, parsed, now);
  // autoCorrect: the agentic assistant decides in the Auto-correct space (Review.gs, autocorrect_min_confidence)
  const review = reviewAlert_(parsed, { llm, llmError, now, settings: S, history, mediaHeld: held, memoryStory,
    autoCorrect: !!ctx.changeNotes });
  if (isSheetTest) {
    review.ingested = SHEET_TEST_INGESTED_;
    if (typeof applySheetTestReviewOverrides_ === 'function') applySheetTestReviewOverrides_(parsed, review);
  }
  review.memory = !isSheetTest && typeof amFactsFor_ === 'function' ? amFactsFor_(ctx, review.fields, { live: amLiveOf_(ctx, m) }) : null;
  if (review.knowledgeUsed.length) {
    ctx.log(`knowledge used: ${review.knowledgeUsed.map(u => u.document + (u.used_for ? ` (${u.used_for})` : '')).join('; ')}`);
  }
  const cited = review.socialAlert && review.socialAlert.per;  // only while KB & Guidance can start alerts is ON
  if (cited) {
    ctx.log(cited.basis ? `Gemini cites ${cited.basis} for a Social Alert (quote checked)`
      : `Gemini's citation for a Social Alert doesn't check out, so it can't start one: ${cited.why}`);
  }
  if (review.commsContext) noteOutageComms_(ctx, review);  // only while Check outage & comms docs is ON
  review.screenshot = screenshotFor_(parsed);  // the picture of the post for the Social Alert email
  if (parsed.extra && parsed.extra.screenshot_url && !bursonScreenshotUrl_(parsed)) {
    ctx.log('Burson\'s screenshot not used: the platform shows a sign-in prompt to anyone not signed in' +
      (review.screenshot ? ` (the email shows "${review.screenshot.label}" instead)` : ''));
  }
  if (review.followUp) {
    const fu = review.followUp;
    const o = fu.original;
    ctx.log(`follow-up check: ${o.alert_id || o.url || 'an earlier alert'} (${o.source}, ${o.outcome || 'outcome unknown'}) by ` +
      `${fu.by}${fu.adds_new === false ? ', nothing new' : fu.adds_new ? ', adds something new' : ''}` +
      `${fu.confidence !== null ? ` (${fu.confidence})` : ''}${fu.reason ? `: ${fu.reason}` : ''}`);
  }
  if (pending) handleResend_(ctx, m, parsed, review, pending, report, history);
  else handleNewAlert_(ctx, m, parsed, review, report, history);
}

/**
 * Gemini's review of an alert (`parsed`: Burson's, or one in another format, OtherAlerts.gs), as {llm, llmError, held}.
 * A review that crashed the run before (crashGuard_) gets less of the post's media this time (held: what it gets, and
 * how many crashes); a run too short for the post's video or audio holds the alert for the next run (reviewHoldWhyNot_),
 * once at most, by throwing an error marked holdReview (runOnce_). Any other failure comes back as llmError.
 */
function guardedAssess_(ctx, m, parsed, now) {
  // A review that crashed the run before (crashGuard_): this one gets less of the post's media than that one had, and
  // analysts are told what Gemini didn't get. The note says the run is in the review until Gemini is done.
  const guard = ctx.crashGuard || null;
  const held = guard ? guard.held(m.name) : null;
  const media = held ? held.media : 'full';
  if (held) {
    ctx.log(`reviewing ${m.name} with ${reviewMediaWords_(media)}: its review crashed the run ` +
      `${held.crashes > 1 ? `${held.crashes} times` : 'once'} before`);
  }
  // A run too short for the post's video or audio can hold the alert for the next run (reviewHoldWhyNot_), once at most;
  // a held alert keeps the time the bot first picked it up (the Speed tab counts the wait as part of its review)
  const waits = reviewWaits_(ctx);
  const waited = waits.get(m.name);
  if (waited) parsed.seen_at = Number(waited.seen) || parsed.seen_at;
  const holdWhyNot = reviewHoldWhyNot_(ctx, m, waited);
  let llm = null;
  let llmError = null;
  if (guard) guard.review(m.name, media);
  try {
    llm = ctx.gemini.assess(parsed, { deadline: ctx.deadline, media, hold: !holdWhyNot });
  } catch (e) {
    if (e && e.holdReview) {  // runOnce_ stops the pass here; the next run reviews it first
      waits.add(m.name, parsed.seen_at);
      throw e;
    }
    llmError = String((e && e.message) || e);
    ctx.log('Gemini review failed: ' + llmError);
  }
  if (guard) guard.reviewed(m.name);
  if (waited) {
    waits.drop(m.name);
    ctx.log(`reviewed ${m.name} ${Math.max(1, Math.round((now - Number(waited.at || now)) / 60000))} min after it was held for this run`);
  }
  if (llm && llm._missed && llm._missed.why === 'time') ctx.log(`${m.name} wasn't held for the next run: ${holdWhyNot}`);
  return { llm, llmError, held };
}

/**
 * Learn from IM calls (Control tab row 17): parsed.imPrecedents, the Learned precedents tab's rows (ctx.learned) about
 * this alert's product or exposure tag, for Gemini's review (Review.gs learnedPrecedentsFor_), and which in the run log.
 * [] when the tab can't be read. Never throws.
 */
function imPrecedentsFor_(ctx, parsed) {
  try {
    parsed.imPrecedents = learnedPrecedentsFor_(ctx.learned || [], parsed.fields, LEARNED_PER_REVIEW_);
  } catch (e) {
    parsed.imPrecedents = [];
    ctx.log('Learned precedents unavailable for this review: ' + ((e && e.message) || e));
    return;
  }
  if (parsed.imPrecedents.length) {
    ctx.log(`past IM calls shown to Gemini: ${parsed.imPrecedents.map(r => `${r.product || r.exposure_tag || '?'} (the IMs: ` +
      `${r.im_call || '?'})`).join('; ')}`);
  }
}

const OUTAGE_COMMS_PROP_ = 'OUTAGE_COMMS';  // the posts that got a comms / status context today: {day, keys}

/**
 * Check outage & comms docs (Control tab row 20): the review's comms / status context in the run log (and why a
 * statement Gemini offered was left out), and column C: "2 today · last: outage · confirmed by Google (…) · holding
 * statement found" (each post counted once). Never throws.
 */
function noteOutageComms_(ctx, review) {
  try {
    const c = review.commsContext;
    ctx.log(`comms / status context: ${commsLine_(c)}`);
    if (c.dropped) ctx.log(`the holding statement Gemini gave was left out: ${c.dropped}`);
    const props = PropertiesService.getScriptProperties();
    const day = etDay_(ctx.now());
    let seen = {};
    try { seen = JSON.parse(props.getProperty(OUTAGE_COMMS_PROP_) || '{}') || {}; } catch (e) { seen = {}; }
    const keys = seen.day === day && Array.isArray(seen.keys) ? seen.keys : [];
    const key = String(review.recordKey || '') || `#${keys.length + 1}`;
    if (!keys.includes(key)) keys.push(key);
    props.setProperty(OUTAGE_COMMS_PROP_, JSON.stringify({ day, keys: keys.slice(-100) }));
    const status = c.outage_confirmed === true ? 'confirmed by Google' : c.outage_confirmed === false ? 'not confirmed by Google'
      : c.unclear === true ? 'status unclear' : c.searched === true ? 'status searched, no web sources' : 'status not checked';
    const what = [commsKindName_(c.kind), status + (c.status_source ? ` (${c.status_source})` : '')].filter(Boolean).join(' · ');
    const found = c.holding_statement ? ' · holding statement found' : '';
    noteSwitch_('outageComms', `${keys.length} today · last: ${what}${found}`);
  } catch (e) {
    ctx.log(`couldn't note the comms / status context for the Control tab: ${(e && e.message) || e}`);
  }
}

const LINK_FINDS_PROP_ = 'LINK_FINDS_TODAY';  // Auto-find missing links: today's lookups and finds, for the Control tab

/**
 * Auto-find missing links (Control row 14; the caller checks the switch): an alert that came without its link or its
 * author gets them from the listening feeds (ctx.findLink: BigQuery.gs bqFindMissingLink_), before anything else looks
 * at it, so the record key, the post lookup, the enrichment and Gemini all have the post, and Burson isn't asked for it.
 * Only blank fields are filled. parsed.found keeps what was found for reviewAlert_: a correction analysts see, never
 * asked of Burson. Nothing found, a post the bot already alerted (in the last novelty_days), short of time
 * (BQ_LINK_MIN_LEFT_MS_) or BQ_LINK_MAX_PER_RUN_ lookups already made this run: nothing changes, and Burson is asked as
 * with the switch OFF (Never wait on Burson ON: the alert is processed without it). A missing link that isn't filled
 * leaves why on parsed.linkLookup, for the Auto-correct space's note (Voice.gs notFixedLine_): 'none' (the feeds had no
 * sure match), 'alerted' (their match is a post already alerted), 'time' or 'cap' (not searched this run), 'failed'
 * (the lookup failed, or there's none to make). Never throws.
 */
function findMissingLink_(ctx, parsed, report) {
  const f = (parsed && parsed.fields) || {};
  const needUrl = isBlank_(f.post_url);
  const why = outcome => { if (needUrl && parsed) parsed.linkLookup = outcome; };
  try {
    const needAuthor = isBlank_(f.author);
    if (!needUrl && !needAuthor) return;
    if (typeof ctx.findLink !== 'function') { why('failed'); return; }
    const what = needUrl ? (needAuthor ? 'link and author' : 'link') : 'author';
    const without = switchOn_(ctx, 'noWait') ? 'the alert is processed without it' : 'Burson is asked as usual';
    const capped = (report.link_lookups || 0) >= BQ_LINK_MAX_PER_RUN_;
    if (capped || ctx.deadline - ctx.now() < BQ_LINK_MIN_LEFT_MS_) {
      ctx.log(`auto-find missing links: ${capped ? `already ${BQ_LINK_MAX_PER_RUN_} lookups` : 'no time left'} this run, so the ` +
        `missing ${what} isn't looked up; ${without}`);
      why(capped ? 'cap' : 'time');
      return;
    }
    report.link_lookups = (report.link_lookups || 0) + 1;
    const ident = JSON.stringify([issueNameOf_(f) || '', normHandle_(f.author), f.social_network || '', f.post_url || '']);
    let hit = null;
    let failed = false;
    try {
      hit = ctx.findLink(parsed);
    } catch (e) {
      failed = true;
      ctx.log('auto-find missing links failed: ' + ((e && e.message) || e));
    }
    const found = {};
    if (hit && needUrl && hit.post_url && domainOf_(hit.post_url)) found.post_url = { old: '', new: String(hit.post_url).trim() };
    if (hit && needAuthor && hit.author && String(hit.author).trim()) found.author = { old: '', new: String(hit.author).trim() };
    // A post the bot already alerted isn't taken: the alert would be dropped as a repeat of it, while it may well be the
    // same author's newer post that the feeds don't have yet. Burson is asked, as with the switch OFF
    const k = found.post_url ? recordKey_({ post_url: found.post_url.new }) : null;
    const alerted = k ? ctx.store.recentForwarded(ctx.now() - GEN.novelty_days * DAY_MS_)
      .find(h => h.record_key === k && earlierOutcome_(h, ctx.now()) === 'alerted') : null;
    if (alerted) {
      ctx.log(`auto-find missing links: ${found.post_url.new} was already alerted (${alerted.alert_id}), so it isn't taken for ` +
        'this alert');
      delete found.post_url;
      delete found.author;  // it came with that post
    }
    noteLinkFind_(ident, !!(found.post_url || found.author));
    if (!found.post_url) why(failed ? 'failed' : alerted ? 'alerted' : 'none');
    if (!found.post_url && !found.author) {
      if (!alerted) ctx.log(`auto-find missing links: no sure match for the missing ${what}; ${without}`);
      return;
    }
    found.confidence = Math.max(0, Math.min(1, Number(hit.confidence) || 0));
    found.how = String(hit.how || '');
    parsed.found = found;
    if (found.post_url) f.post_url = found.post_url.new;
    if (found.author) f.author = found.author.new;
    report.links_found = (report.links_found || 0) + 1;
    ctx.log(`auto-find missing links: found ${[found.post_url && found.post_url.new, found.author && found.author.new]
      .filter(Boolean).join(' by ')} (${found.how || 'feeds'}, ${Math.round(found.confidence * 100)}% sure)`);
  } catch (e) {
    ctx.log('auto-find missing links failed: ' + ((e && e.message) || e));
    if (isBlank_(f.post_url)) why('failed');  // still missing (a find fills it)
  }
}

/**
 * Counts an Auto-find missing links lookup for today (`ident`: the alert, so the same alert seen by two flows or tried
 * twice counts once) and puts "found N of M today" in the switch's column C. Never throws.
 */
function noteLinkFind_(ident, found) {
  try {
    const props = PropertiesService.getScriptProperties();
    const day = dayKey_();
    let s = null;
    try { s = JSON.parse(props.getProperty(LINK_FINDS_PROP_) || 'null'); } catch (e) { s = null; }
    if (!s || s.day !== day || !Array.isArray(s.tried) || !Array.isArray(s.found)) s = { day, tried: [], found: [] };
    const k = hashText_(String(ident));
    if (s.tried.indexOf(k) < 0) s.tried = s.tried.concat([k]).slice(-150);
    if (found && s.found.indexOf(k) < 0) s.found = s.found.concat([k]).slice(-150);
    props.setProperty(LINK_FINDS_PROP_, JSON.stringify(s));
    noteSwitch_('autoFindLinks', `found ${s.found.length} of ${s.tried.length} today · last look ${nowLabel_()}`);
  } catch (e) {
    console.error('could not count an auto-find missing links lookup: ' + ((e && e.message) || e));
  }
}

/**
 * Auto-find missing links: what an alert row keeps in forwarded_fields when its link is the one the bot found:
 * {link_found: {how, confidence, author?}}. Burson's resend of it is then still matched to it (Store.gs findPendingFix),
 * as with the switch OFF, and keeps that link (keepFoundLink_). {} when the link is Burson's. Pure.
 */
function foundLinkMark_(parsed) {
  const found = parsed && parsed.found;
  if (!found || !found.post_url) return {};
  const mark = { how: String(found.how || ''), confidence: Number(found.confidence) || 0 };
  if (found.author) mark.author = String(found.author.new || '');
  return { link_found: mark };
}

/**
 * Auto-find missing links (Control row 14; the caller checks the switch): Burson's resend of an alert whose link the bot
 * found (foundLinkMark_) and that Burson was asked to fix something else on, itself still without a link, gets that
 * same link (and the author found with it, when it has none) as parsed.found, whatever its own lookup gave: Burson was
 * never asked for it. When nothing was asked, a link-less alert matched to it may as well be a new post: Burson is
 * asked for its link, as with the switch OFF. Never throws.
 */
function keepFoundLink_(ctx, parsed, pending) {
  try {
    const prior = pending.forwarded_fields || {};
    const mark = prior.link_found;
    const f = parsed.fields || {};
    if (!mark || pending.status !== 'fix_requested' || isBlank_(prior.post_url) || !isBlank_(f.post_url)) return;
    const m = typeof mark === 'object' ? mark : {};
    const found = Object.assign({}, parsed.found || {}, { post_url: { old: '', new: String(prior.post_url).trim() },
      confidence: Math.max(0, Math.min(1, Number(m.confidence) || 0)), how: String(m.how || '') });
    if (!found.author && m.author && isBlank_(f.author)) found.author = { old: '', new: String(m.author) };
    parsed.found = found;
    f.post_url = found.post_url.new;
    if (found.author) f.author = found.author.new;
    ctx.log(`auto-find missing links: the link found for ${pending.alert_id} is kept for Burson's resend of it: ${f.post_url}`);
  } catch (e) {
    ctx.log('auto-find missing links failed: ' + ((e && e.message) || e));
  }
}

/**
 * The forwarded alert with the link the bot found (Auto-find missing links: parsed.found) on a "[Link]: …" line, when
 * Burson's alert had no such line to rewrite: before the reminder at the bottom, else before [Code], else at the end.
 * `text` as it is when nothing was found or the link is already in it. Pure.
 */
function withFoundLink_(text, found) {
  const url = found && found.post_url && found.post_url.new;
  if (!url || String(text).indexOf(url) >= 0) return text;
  const lines = String(text).split('\n');
  const line = `[Link]: ${url}`;
  const index = labelIndex_();
  let at = lines.findIndex(l => RX_FOOTER_.test(cleanLine_(l).trim().replace(RX_MD_, '').trim()));
  if (at < 0) {
    at = lines.findIndex(l => { const hit = splitLabel_(cleanLine_(l), index); return !!hit && hit.spec.name === 'code'; });
  }
  if (at < 0) return `${String(text).replace(/\s+$/, '')}\n\n${line}`;
  const blankBefore = at > 0 && !lines[at - 1].trim();
  if (blankBefore && at > 1 && !lines[at - 2].trim()) lines.splice(at - 1, 1, line, '');  // where Burson's line was taken out
  else if (blankBefore) lines.splice(at, 0, line, '');
  else lines.splice(at, 0, line);
  return lines.join('\n');
}

/**
 * The auto-correct space's corrected alert with the write-up (Review.gs writeupOf_: `writeup.text`) as its summary
 * paragraph when Burson's alert had none for rebuildAlert_ to replace (summary is no required field): its own paragraph
 * in Burson's place for one, below the "SOCIAL ALERT" line and above the [Link] line, the first footer or the [Code]
 * line, whichever comes first (else at the end), where parseAlert_ reads it back as the summary. `text` as it is
 * without a write-up or when it's in it already. Pure.
 */
function withWriteup_(text, writeup) {
  const s = String((writeup && writeup.text) || '').trim();
  if (!s || String(text).indexOf(s) >= 0) return text;
  const lines = String(text).split('\n');
  const index = labelIndex_();
  const bare = l => cleanLine_(l).trim().replace(RX_MD_, '').trim();
  const head = lines.findIndex(l => RX_HEADER_.test(bare(l)));
  const at = lines.findIndex((l, i) => i > head && (RX_FOOTER_.test(bare(l)) ||
    (h => !!h && (h.spec.name === 'post_url' || h.spec.name === 'code'))(splitLabel_(cleanLine_(l), index))));
  if (at < 0) return `${String(text).replace(/\s+$/, '')}\n\n${s}`;
  lines.splice(at, 0, ...(at === 0 || !lines[at - 1].trim() ? [] : ['']), s, '');
  return lines.join('\n');
}

/**
 * The corrected alert with the video timestamp the bot added (Review.gs rule 12: where Google comes up in the video) on a
 * "[Timestamp]: …" line, when Burson's alert had no such line to rewrite: before [Link], else before the reminder at the
 * bottom, else before [Code], else at the end. `text` as it is when the bot didn't add one or it's already there. Pure.
 */
function withTimestamp_(text, fields, changed) {
  const stamp = String((fields && fields.video_timestamp) || '').trim();
  if (!stamp || !(changed || []).includes('video_timestamp') || String(text).indexOf(stamp) >= 0) return text;
  const lines = String(text).split('\n');
  const index = labelIndex_();
  const labelled = name => l => { const hit = splitLabel_(cleanLine_(l), index); return !!hit && hit.spec.name === name; };
  if (lines.some(labelled('video_timestamp'))) return text;
  const line = `[Timestamp]: ${stamp}`;
  const link = lines.findIndex(labelled('post_url'));
  if (link >= 0) {
    lines.splice(link, 0, line);
    return lines.join('\n');
  }
  let at = lines.findIndex(l => RX_FOOTER_.test(cleanLine_(l).trim().replace(RX_MD_, '').trim()));
  if (at < 0) at = lines.findIndex(labelled('code'));
  if (at < 0) return `${String(text).replace(/\s+$/, '')}\n${line}`;
  if (at > 0 && !lines[at - 1].trim()) lines.splice(at - 1, 0, line);  // above the blank line before the reminder
  else lines.splice(at, 0, line);
  return lines.join('\n');
}

/** "X @ICannot_Enough · a reply · video 3:13": what the post lookup found, for the run log. */
function postBrief_(p) {
  const bits = [`${p.platform} @${String(p.author || '?').replace(/^@+/, '')}`];
  if (p.reply_to) bits.push(`a reply (thread: ${(p.thread_ids || []).join(', ') || p.reply_to.id})`);
  if (p.quoted) bits.push(`quotes ${p.quoted.url || p.quoted.id}`);
  if (p.video) bits.push(`video${p.video.duration_s ? ' ' + clock_(p.video.duration_s) : ''}`);
  if ((p.photos || []).length) bits.push(`${p.photos.length} photo${p.photos.length === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/** When the alert reached the live Burson space (ms): the original Zapier post for a Mirror copy, else its own time. */
function sourceAt_(m) {
  return (typeof mirrorSourceAt_ === 'function' && mirrorSourceAt_(m && m.name)) || Number(m && m.createTime) || 0;
}

/**
 * In the Mirror space (outbounds blocked), the live S-F Burson message an alert copy `m` is, for its Alert-log row
 * (live_message, live_thread: kept for good, so Outbox.gs ownSfbBehind_ and the relay find it days later): the Relay
 * tab's pair when the relay brought it over, else the pair Mirror.gs kept when it copied it (Mirror.gs mirrorPairOf_).
 * {} when there's none (a Direct BigQuery post, any other space). Never throws.
 */
function livePairFields_(ctx, m) {
  try {
    if (!ctx || !ctx.outboundBlocked || !m || !m.name) return {};
    const sfbId = String((ctx.sfBurson && ctx.sfBurson.id) || '');
    const rs = ctx.relayState;
    let name = rs && rs.testToLive ? String(rs.testToLive.get(m.name) || '') : '';
    let thread = name && rs.testThreadToLive && m.thread ? String(rs.testThreadToLive.get(m.thread) || '') : '';
    if (!name) {
      const kept = typeof mirrorPairOf_ === 'function' ? mirrorPairOf_(m.name) : null;
      if (kept) {
        name = String(kept.name || '');
        thread = String(kept.thread || '');
      }
    }
    if (!name || (sfbId && name.indexOf(sfbId + '/') !== 0)) return {};
    return { live_message: name, live_thread: thread };
  } catch (e) {
    return {};
  }
}

function handleNewAlert_(ctx, m, parsed, review, report, history) {
  const S = ctx.settings;
  const requested = requestedItems_(review);

  // 1. Analysts: the corrected alert in Burson's own format (+ what was corrected). When outbounds are blocked (Mirror
  //    training space), the mirrored post in this space serves as the alert post so all thread notes and emoji reactions
  //    work in-place without forwarding to any other space.
  const inPlace = Boolean(ctx.outboundBlocked || (ctx.sourceReadOnly && parsed && parsed.ingested && m.name &&
    ctx.spaces && ctx.spaces.analyst && String(m.name).indexOf(ctx.spaces.analyst.id + '/messages/') === 0));
  // The auto-correct space (settings.requirement_line): which alert requirement the alert meets, worked out before the
  // review's note is posted, for that note's last line (RequirementLine.gs requirementOf_; null in every other flow).
  // waits: the alert is not decided in this run while it waits on what Burson alone can add (step 3 below)
  const req = requirementOf_(ctx, review, history, { waits: !switchOn_(ctx, 'noWait') && requested.some(x => x.problem) });
  const fwd = inPlace ? { name: m.name, thread: m.thread || '' } : forwardAlert_(ctx, m, parsed, review, '', req);
  if (fwd && !inPlace) report.forwarded++;
  // A Direct BigQuery or sheet-test card in the auto-correct space was posted before its review, and the bot never edits
  // a message: what the review changed, and the write-up the email uses, go in the card's thread (inPlaceNote_)
  if (inPlace && ctx.changeNotes) inPlaceNote_(ctx, m, review, parsed, req);
  // C10's "corrected" in the auto-correct space: the changes as the space shows them (reviewedLine_, or the in-place
  // note: only those the email uses), counted here, before the Social Alert draft can take an existing issue's name
  const corrected = !!ctx.sourceReadOnly && noteChanges_(review, inPlace).length > 0;
  const alertId = ctx.store.nextAlertId();
  const draft = draftPlan_(ctx, review, history);  // escalated: a Social Alert draft is due (made after Burson's side)
  const row = ctx.store.addAlert(Object.assign({
    alert_id: alertId, source_message: m.name, source_thread: m.thread || '', record_key: review.recordKey || '',
    author: review.fields.author || '', issue_tokens: review.issueTokens, exposure_tag: review.fields.exposure_tag || '',
    status: requested.length && !S.dry_run ? 'fix_requested' : 'ok', requested,
    forwarded_fields: Object.assign(snapshotFields_(review.fields), foundLinkMark_(parsed)),  // the mark: Auto-find missing links
    forward_message: (fwd && fwd.name) || '', forward_thread: (fwd && fwd.thread) || '', burson_done: false,
    source_at: sourceAt_(m), seen_at: parsed.seen_at || '', knowledge_used: review.knowledgeUsed || [],
  }, parsed.ingested ? { ingested: parsed.ingested } : {}, livePairFields_(ctx, m), draft || {}));  // ingested: Direct BigQuery alerts (row 15)
  if (draft) watchDraft_(ctx, alertId);
  bqDirectReviewed_(row, !!draft);  // C15: a Direct BigQuery card's review ended in a Social Alert, or in none
  // ...and when the Social Alert then goes another way than that line says, one more line under the alert
  requirementFinal_(ctx, req, inPlace ? m : fwd, m.name, draft, '');

  if (switchOn_(ctx, 'noWait')) {
    // Never wait on Burson ON (Control row 23):
    // 2. The alert is processed now, with the bot's own corrections: nothing waits on Burson (a resend, a missing link or
    //    timestamp). The Social Alert (sent to the stand-in while testing, else a Gmail draft) and the leadership DM (🧑‍💻)
    //    when the escalation protocol covers it; else the T&S form, the YouTube ping or ❌ No action taken, as the IM would
    //    mark it. An alert that none of that actioned (it waits on a person, e.g. a draft to send) gets 👍.
    if (draft) {
      tryDraft_(ctx, row, report);
      leadershipPing_(ctx, row, review, history, report);
    } else {
      noEmailNeeded_(ctx, row, review, history, report);
    }
    confirmReceipt_(ctx, row);
    // 3. Burson: when something was wrong, what it was and what the bot changed, in the alert's thread, and that the alert
    //    was processed (no resend needed); 👍 (receipt) right away here only when people take the action from here (drafts
    //    off). The auto-correct test space never acts in the Burson space: its corrected alert is the alert.
    if (ctx.sourceReadOnly) {
      if (corrected) report.corrected = (report.corrected || 0) + 1;  // as the space shows it
    } else if (sendAlertActions_(ctx, m, requested, fwd, !draftsOn_(ctx))) report.fix_requests++;
    ctx.store.updateAlert(row, { burson_done: true });
    ctx.store.markDone(m.name, 'alert', alertId);
    if (row && typeof SHEET_TEST_INGESTED_ === 'string' && row.ingested === SHEET_TEST_INGESTED_ &&
        typeof onSheetTestAlertWorked_ === 'function') {
      onSheetTestAlertWorked_(ctx, m, row);
    }
    return;
  }

  // 2. Burson: ⬇️ and the change request in the alert's thread when something is wrong; 👍 (receipt) right away here
  //    only when people take the action from here (drafts off). The auto-correct test space never acts in the Burson
  //    space: the bot made the fixes itself, and its corrected alert is the alert.
  if (ctx.sourceReadOnly) {
    if (corrected) report.corrected = (report.corrected || 0) + 1;  // as the space shows it
  } else if (sendAlertActions_(ctx, m, requested, fwd, !draftsOn_(ctx))) report.fix_requests++;
  ctx.store.updateAlert(row, { burson_done: true });

  // 3. The Social Alert (sent to the stand-in while testing, else a Gmail draft) and the leadership DM (🧑‍💻) when the
  //    escalation protocol covers it. No email needed and nothing left for Burson to fix -> ❌ No action taken, as the IM
  //    would mark it. A correct alert that none of that actioned (it waits on a person) gets 👍. In the auto-correct
  //    test space only what Burson alone can add (e.g. a missing link) is still waited on.
  const waiting = ctx.sourceReadOnly ? requested.filter(x => x.problem) : requested;
  if (draft) {
    tryDraft_(ctx, row, report);
    leadershipPing_(ctx, row, review, history, report);
  } else if (!waiting.length) {
    noEmailNeeded_(ctx, row, review, history, report);
  }
  if (!waiting.length) confirmReceipt_(ctx, row);
  ctx.store.markDone(m.name, 'alert', alertId);
  if (row && typeof SHEET_TEST_INGESTED_ === 'string' && row.ingested === SHEET_TEST_INGESTED_ &&
      typeof onSheetTestAlertWorked_ === 'function') {
    onSheetTestAlertWorked_(ctx, m, row);
  }
}

/**
 * The corrected alert, in Burson's own format, posted to the analyst space with what was corrected underneath. The
 * auto-correct test space (ctx.changeNotes): the corrected alert on its own, in Burson's layout under the bot's own first
 * line ("✅ *Reviewed and corrected by the agentic assistant* · Original alert", the link to Burson's message: Voice.gs
 * reviewedLine_), with the write-up in the summary's place (Review.gs writtenFields_; withWriteup_ when Burson's alert
 * has no summary paragraph) and the post's own picture under it when the run has time (correctedAlertPicture_), then a
 * note in its thread listing what the agentic assistant changed (changeNoteText_; none when there's nothing to say).
 * With Never wait on Burson ON, a video timestamp the bot added goes on its own "[Timestamp]" line (withTimestamp_).
 * `req` (the auto-correct space only: RequirementLine.gs requirementOf_, or null): its line, which alert requirement the
 * alert meets, is that note's last line, and the whole note when there's nothing else to say.
 */
function forwardAlert_(ctx, m, parsed, review, extraNote, req) {
  const noWait = switchOn_(ctx, 'noWait');
  const shown = ctx.changeNotes ? writtenFields_(review) : { fields: review.fields, changed: review.changed };
  const remade = rebuildAlert_(m.text, parsed, shown.fields, shown.changed);
  const rebuilt = withFoundLink_(ctx.changeNotes ? withWriteup_(remade, review.writeup) : remade, parsed.found);
  const stamped = noWait ? withTimestamp_(rebuilt, review.fields, review.changed) : rebuilt;
  const body = parsed && parsed.ingested && typeof withBqBadge_ === 'function'
    ? withBqBadge_(stamped, parsed.ingested)
    : stamped;
  if (ctx.changeNotes) {
    const text = `${reviewedLine_(review, m.name)}\n${body}`;
    const pic = correctedAlertPicture_(ctx, parsed);
    let fwd = null;
    if (pic.length) {
      try {
        fwd = postTo_(ctx, ctx.spaces.analyst.id, text, null, 'fwd:' + m.name, null, false, pic);
      } catch (e) {  // the same key: an alert Chat did take is read back, never posted twice
        ctx.log(`Chat refused the corrected alert with the post's picture, so it goes as text: ` +
          `${truncate_(String((e && e.message) || e), 200)}`);
      }
    }
    if (!fwd) fwd = postTo_(ctx, ctx.spaces.analyst.id, text, null, 'fwd:' + m.name);
    logLeftAsIs_(ctx, review);
    const note = requirementFit_([extraNote || '', changeNoteText_(review, { findLinks: switchOn_(ctx, 'autoFindLinks'),
      linkLookup: parsed && parsed.linkLookup, requirement: req && req.line })].filter(Boolean).join('\n'), req && req.line);
    if (note && fwd && fwd.name) {
      try {
        // (the note Chat hands back: at a second attempt at the alert it is the first attempt's, requirementNoted_)
        requirementNoted_(req, postTo_(ctx, ctx.spaces.analyst.id, note, fwd.thread || null, 'chg:' + m.name));
      } catch (e) {  // the alert is out; a missing note isn't worth posting it twice
        ctx.log(`couldn't post what changed under ${fwd.name}: ${(e && e.message) || e}`);
      }
    }
    return fwd;
  }
  const footer = [ctx.settings.corrections_footer ? forwardFooter_(review, noWait) : '', extraNote || ''].filter(Boolean).join('\n');
  return postTo_(ctx, ctx.spaces.analyst.id, joinText_(body, footer), null, 'fwd:' + m.name);
}

// The corrected alert in the auto-correct space gets the post's own picture (correctedAlertPicture_) only with this much
// of the run left, as a Direct BigQuery card does (BigQuery.gs BQ_DIRECT_PIC_LEFT_MS_)
const AC_PIC_LEFT_MS_ = 60 * 1000;

/**
 * The auto-correct space: the post's own picture for its corrected alert (Post.gs alertPicture_ on the post the review
 * looked up, parsed.post: its photo, its video's frame, thumbnail or cover, what a quoted post or link card shows; never
 * the picture its page shows link previews, and never a generated one), uploaded to that space only (Chat.gs
 * chatUploadImage_ refuses S-F Burson, the test copy and outside spaces). The message's `attachment` list: [] when
 * there's none, the run has less than AC_PIC_LEFT_MS_ left, or the upload fails (the alert goes as text). Never throws.
 */
function correctedAlertPicture_(ctx, parsed) {
  try {
    if (!ctx.changeNotes || !parsed || !parsed.post || typeof alertPicture_ !== 'function' ||
        typeof chatUploadImage_ !== 'function') return [];
    if (!(Number(ctx.deadline) - ctx.now() >= AC_PIC_LEFT_MS_)) return [];
    const pic = alertPicture_(String((parsed.fields && parsed.fields.post_url) || ''), parsed.post, false);
    return pic && pic.img ? [{ attachmentDataRef: chatUploadImage_(ctx.spaces.analyst.id, pic.img) }] : [];
  } catch (e) {
    ctx.log(`the corrected alert goes without the post's picture: ${truncate_(String((e && e.message) || e), 200)}`);
    return [];
  }
}

/**
 * The auto-correct space: what Gemini suggested and the agentic assistant left as Burson wrote it (under
 * autocorrect_min_confidence: review.unsure), in the run log only; the space is told nothing about it.
 */
function logLeftAsIs_(ctx, review) {
  const left = (review.unsure || []).filter(u => u && u.field);
  if (!left.length) return;
  ctx.log('left as Burson wrote it (Gemini wasn\'t sure enough): ' + left.map(u => `${burLabel_(u.field)}` +
    (u.proposed !== null && u.proposed !== undefined ? ` (maybe ${truncate_(fmtValue_(u.proposed), 60)})` : '') +
    (u.confidence ? `, ${Math.round(u.confidence * 100)}% sure` : '') +
    (u.finding ? `: ${truncate_(u.finding, 160)}` : '')).join('; '));
}

/**
 * A Direct BigQuery or sheet-test card in the auto-correct space (handleNewAlert_ in place): it was posted before its
 * review and is never edited, so the thread note under it says what the review changed and the summary the email uses
 * (changeNoteText_ with inPlace: "The agentic assistant reviewed this alert. The card above was posted before the
 * review; the email uses these corrections:"), and last, which alert requirement the alert meets (`req`:
 * RequirementLine.gs requirementOf_, or null with settings.requirement_line off). Nothing when there's nothing to say;
 * a note that fails is only logged.
 */
function inPlaceNote_(ctx, m, review, parsed, req) {
  logLeftAsIs_(ctx, review);
  const note = requirementFit_(changeNoteText_(review, { inPlace: true, findLinks: switchOn_(ctx, 'autoFindLinks'),
    linkLookup: parsed && parsed.linkLookup, requirement: req && req.line }), req && req.line);
  if (!note) return;
  try {
    // (the note Chat hands back: at a second attempt at the card it is the first attempt's, requirementNoted_)
    requirementNoted_(req, postTo_(ctx, ctx.spaces.analyst.id, note, m.thread || null, 'chg:' + m.name));
  } catch (e) {
    ctx.log(`couldn't post what changed under ${m.name}: ${(e && e.message) || e}`);
  }
}

/**
 * An alert recorded on an earlier attempt that didn't finish: complete the Burson side; never forward it twice. Its
 * decision (❌, the T&S form, the YouTube ping) isn't made here: it needs the review, which a retry doesn't have. An
 * alert that attempt left without one (undecidedRow_) is said so, in the run log and the run's errors, not passed over.
 */
function finishAlert_(ctx, m, row, report) {
  if (row.resend_of) {
    const original = ctx.store.alertById(row.resend_of);
    if (original && original.status !== 'superseded' && resendOpen_(original, switchOn_(ctx, 'noWait'))) {
      ctx.store.updateAlert(original, { status: 'superseded' });
    }
    // The run stopped before Burson's side of the resend: only a resend handled with Never wait on Burson ON leaves it
    // for later (OFF, Burson's side goes out before the resend's row is written)
    if (!isTrue_(row.burson_done)) {
      const fwd = row.forward_message ? { name: row.forward_message, thread: row.forward_thread } : null;
      sendResendActions_(ctx, m, original, row.status === 'fix_requested' ? (row.requested || []) : [], fwd);
      ctx.store.updateAlert(row, { burson_done: true });
    }
  } else if (!isTrue_(row.burson_done)) {
    const fwd = row.forward_message ? { name: row.forward_message, thread: row.forward_thread } : null;
    if (sendAlertActions_(ctx, m, row.requested || [], fwd, !draftsOn_(ctx))) report.fix_requests++;
    ctx.store.updateAlert(row, { burson_done: true });
  }
  if (row.email_status === 'pending') watchDraft_(ctx, row.alert_id);  // maintainDrafts_ makes the draft
  if (undecidedRow_(ctx, row)) {
    const why = `${row.alert_id} has no decision: a run recorded it and stopped before deciding it (❌, the T&S form or ` +
      'the YouTube ping), and a retry can\'t decide it. A person needs to look at it.';
    console.warn(why);
    (report.errors = report.errors || []).push(why);
  }
  ctx.store.markDone(m.name, row.resend_of ? 'resend' : 'alert', row.alert_id);
}

/**
 * finishAlert_: whether `row`, recorded by an attempt that didn't finish, should have had its decision by now and has
 * none (Drafts.gs noEmailNeeded_ never got to write it). All of:
 *   - a new alert's row, not a resend's (a resend can keep its original's decision or email: handleResend_,
 *     handleResendNoWait_), and not one Burson's resend has replaced (superseded: the resend is decided instead);
 *   - nothing on it says it was processed (Drafts.gs processedRow_): no decision, no Social Alert (a pending one is made
 *     by maintainDrafts_), and no 👍 or action emoji (those come after the decision);
 *   - decisions are made at all: drafts and reactions are on (noEmailNeeded_ does nothing otherwise, e.g. in a dry run);
 *   - it wasn't waiting on Burson: Never wait on Burson ON, or nothing was asked of Burson (in the auto-correct space:
 *     nothing only Burson can add). An alert waiting for Burson's resend rightly has no decision yet.
 */
function undecidedRow_(ctx, row) {
  if (!row || row.resend_of || row.status === 'superseded' || processedRow_(ctx, row)) return false;
  if (!draftsOn_(ctx) || !(ctx.settings && ctx.settings.react)) return false;
  if (switchOn_(ctx, 'noWait')) return true;
  const requested = Array.isArray(row.requested) ? row.requested : [];
  return (ctx.sourceReadOnly ? requested.filter(x => x && x.problem) : requested).length === 0;
}

/**
 * The alert's status emoji, plus the change request in its thread when something is wrong. Returns true if changes were
 * asked. ⬇️ ("addressed on updated post below") when corrections are requested: they're in the thread below, and in
 * the updated post once Burson resends, as IMs mark it. 👍 ("confirming receipt, no action yet taken") only when ackNow.
 * Never wait on Burson ON: Burson's side of an alert the bot has processed instead: when something was wrong, a reply in
 * its thread saying what and what the bot changed, and that the alert was processed, so there's no need to resend it
 * (processedText_; true when Burson was told about changes). No ⬇️ then: no updated post is waited for.
 */
function sendAlertActions_(ctx, m, requested, fwd, ackNow) {
  if (ctx.sourceReadOnly) return false;  // the auto-correct test space never posts or reacts in the Burson space
  const out = bursonOut_(ctx, fwd, 'alert:' + m.name);
  const needsFix = (requested || []).length > 0;
  if (switchOn_(ctx, 'noWait')) {
    if (ctx.settings.react && ackNow) out.react(m.name, legendEmoji_('ack'), 'message');
    if (needsFix) out.post(processedText_(splitRequested_(requested), guardFor_(ctx)), m.thread, 'done:' + m.name, shownValues_(requested));
  } else {
    if (ctx.settings.react) {
      if (needsFix) out.react(m.name, legendEmoji_('superseded'), 'message');
      else if (ackNow) out.react(m.name, legendEmoji_('ack'), 'message');
    }
    if (needsFix) out.post(fixRequestText_(splitRequested_(requested), guardFor_(ctx), false), m.thread, 'fix:' + m.name, shownValues_(requested));
  }
  out.flush();
  return needsFix;
}

/**
 * Burson resent an alert the bot asked them to fix. The fix is already with the analysts: leave it there. (Never wait on
 * Burson ON: handleResendNoWait_.)
 */
function handleResend_(ctx, m, parsed, review, pending, report, history) {
  if (switchOn_(ctx, 'noWait')) {
    handleResendNoWait_(ctx, m, parsed, review, pending, report, history);
    return;
  }
  const S = ctx.settings;
  report.resends++;
  const asked = new Map((pending.requested || []).map(x => [x.field, x]));
  // Don't move the goalposts: a value changed to what was asked is accepted, and so is any rewording of a text the
  // bot asked about (no rounds of phrasing edits); rule problems are always re-asked, and Gemini's suggestions only
  // for fields that were already asked about.
  const fixes = review.fixes.filter(x => {
    const prev = asked.get(x.field);
    if (prev && !prev.problem && sameValue_(x.old, prev.new)) return false;
    if (prev && !prev.problem && LONG_TEXT_FIELDS_.includes(x.field) && !sameValue_(x.old, prev.old)) return false;
    return x.source === 'rule' || !!prev;
  });
  const missing = review.missing;
  const stillNeeds = fixes.length + missing.length > 0;
  const requested = stillNeeds ? requestedItems_({ fixes, missing }) : [];
  const fwd = pending.forward_message ? { name: pending.forward_message, thread: pending.forward_thread } : null;

  // 2. Analysts already have the corrected alert. If the priority or engagement level went up, the resend goes to
  //    them as a new alert; otherwise they only get a thread note about values that changed (e.g. the link).
  const forwarded = pending.forwarded_fields || {};
  const raised = raisedBy_(forwarded, review.fields);
  let fresh = null;
  const hadEmail = !!(pending.email_status || (pending.forward_message && ctx.store.emailRowByForward(pending.forward_message)));
  // (the auto-correct space: which alert requirement the resend meets, for its note's last line; RequirementLine.gs.
  // An alert that had its Social Alert keeps it, so the resend gets none: the line says so at once)
  const req = raised.length ? requirementOf_(ctx, review, history, { waits: missing.length > 0,
    decided: hadEmail ? `a resend of ${pending.alert_id}, whose Social Alert was already decided` : '' }) : null;
  if (raised.length) {
    if (ctx.outboundBlocked) {
      fresh = { name: m.name, thread: m.thread || '' };
    } else {
      fresh = forwardAlert_(ctx, m, parsed, review, `QA: updated alert (${raised.join(', ')})`, req);
      report.forwarded++;
    }
  } else if (!ctx.outboundBlocked) {
    const note = fwd ? updateNote_(forwarded, review, !!ctx.changeNotes) : null;
    if (note) postTo_(ctx, ctx.spaces.analyst.id, note, fwd.thread, 'upd:' + m.name);
  }

  // 3. The resend becomes the live post for this alert. Forwarded as a new alert that is now escalated, it gets the
  //    Social Alert draft the original didn't have (an original that has one keeps it).
  const alertId = ctx.store.nextAlertId();
  const draft = fresh && !hadEmail ? draftPlan_(ctx, review, history) : null;
  requirementFinal_(ctx, req, fresh, m.name, draft, '');

  // 1. Burson: ⬇️ on the original ("addressed on updated post below"); on the resend ⬇️ again if it still needs changes
  //    (they're in its thread), else 👍 right away only when people take the action from here (drafts off)
  sendResendActions_(ctx, m, pending, requested, fresh || fwd);

  // Auto-find missing links: the found link stays marked until Burson's own link takes its place
  const values = fresh ? snapshotFields_(review.fields) : Object.assign({}, forwarded, snapshotFields_(review.fields));
  delete values.link_found;
  const row = ctx.store.addAlert(Object.assign({
    alert_id: alertId, source_message: m.name, source_thread: m.thread || '',
    record_key: review.recordKey || pending.record_key || '', author: review.fields.author || pending.author || '',
    issue_tokens: review.issueTokens, exposure_tag: review.fields.exposure_tag || pending.exposure_tag || '',
    status: stillNeeds && !S.dry_run ? 'fix_requested' : 'fixed', requested,
    forwarded_fields: Object.assign(values, foundLinkMark_(parsed)),
    forward_message: fresh ? fresh.name : (pending.forward_message || ''),
    forward_thread: fresh ? fresh.thread : (pending.forward_thread || ''), burson_done: true, resend_of: pending.alert_id,
    source_at: sourceAt_(m), seen_at: parsed.seen_at || '', knowledge_used: review.knowledgeUsed || [],
  }, livePairFields_(ctx, m), draft || {}));
  ctx.store.updateAlert(pending, { status: 'superseded' });
  const waiting = ctx.sourceReadOnly ? missing.length > 0 : stillNeeds;  // auto-correct space: only what Burson alone can add
  if (draft) {
    watchDraft_(ctx, alertId);
    tryDraft_(ctx, row, report);
    leadershipPing_(ctx, row, review, history, report);
  } else if (!waiting && !hadEmail) {
    noEmailNeeded_(ctx, row, review, history, report);
  }
  if (!waiting) {  // 👍 only if nothing has actioned this alert yet (the original's Social Alert counts)
    confirmReceipt_(ctx, row, [pending, pending.forward_message ? ctx.store.emailRowByForward(pending.forward_message) : null]);
  }
  ctx.store.markDone(m.name, 'resend', alertId);
}

/**
 * Never wait on Burson ON (Control row 23): Burson resent an alert the bot corrected (it told Burson what it changed).
 * The bot processed the original when it came in, as it doesn't wait on Burson, so the resend isn't processed a second
 * time: analysts already have the corrected alert (a thread note when the resend changed something they have), and the
 * original gets ⬇️ ("addressed on updated post below": the resend is that post); Burson was already told the alert was
 * processed. A resend that raised the priority or engagement level goes to analysts as a new alert, and is decided again
 * (the Social Alert the original didn't have). An original never processed (handled while the switch was OFF) is
 * processed now, on its resend.
 */
function handleResendNoWait_(ctx, m, parsed, review, pending, report, history) {
  const S = ctx.settings;
  report.resends++;
  const done = processedRow_(ctx, pending);
  const fwd = pending.forward_message ? { name: pending.forward_message, thread: pending.forward_thread } : null;
  const forwarded = pending.forwarded_fields || {};
  const raised = raisedBy_(forwarded, review.fields);
  // What Burson is told about the resend: nothing more once the alert was processed, unless the resend raised the stakes
  // (it's decided again) or the alert was never processed. Then what's still wrong, without moving the goalposts: a value
  // changed to what was told is accepted, and so is any rewording of a text the bot told about (no rounds of phrasing
  // edits); rule problems are always told, and Gemini's suggestions only for fields told about before.
  const tell = !done || raised.length > 0;
  const asked = new Map((pending.requested || []).map(x => [x.field, x]));
  const fixes = !tell ? [] : review.fixes.filter(x => {
    const prev = asked.get(x.field);
    if (prev && !prev.problem && sameValue_(x.old, prev.new)) return false;
    if (prev && !prev.problem && LONG_TEXT_FIELDS_.includes(x.field) && !sameValue_(x.old, prev.old)) return false;
    return x.source === 'rule' || !!prev;
  });
  const missing = !tell ? [] : review.missing;
  const told = fixes.length + missing.length ? requestedItems_({ fixes, missing }) : [];

  // 1. Analysts already have the corrected alert. If the priority or engagement level went up, the resend goes to
  //    them as a new alert; otherwise they only get a thread note about values that changed (e.g. the link).
  let fresh = null;
  const hadEmail = !!(pending.email_status || (pending.forward_message && ctx.store.emailRowByForward(pending.forward_message)));
  // (the auto-correct space: which alert requirement the resend meets, for its note's last line; RequirementLine.gs.
  // An alert that had its Social Alert keeps it, so the resend gets none: the line says so at once)
  const req = raised.length ? requirementOf_(ctx, review, history,
    { decided: hadEmail ? `a resend of ${pending.alert_id}, whose Social Alert was already decided` : '' }) : null;
  if (raised.length) {
    if (ctx.outboundBlocked) {
      fresh = { name: m.name, thread: m.thread || '' };
    } else {
      fresh = forwardAlert_(ctx, m, parsed, review, `QA: updated alert (${raised.join(', ')})`, req);
      report.forwarded++;
    }
  } else if (!ctx.outboundBlocked) {
    const note = fwd ? updateNote_(forwarded, review, !!ctx.changeNotes) : null;
    if (note) postTo_(ctx, ctx.spaces.analyst.id, note, fwd.thread, 'upd:' + m.name);
  }

  // 2. The resend becomes the live post for this alert. Forwarded as a new alert that is now escalated, it gets the
  //    Social Alert draft the original didn't have (an original that has one keeps it); forwarded and not escalated, or
  //    an original never processed, it's decided now. Otherwise nothing is done twice: the resend keeps the alert's
  //    decision and what Burson was told (for answers in its thread), and stays open for Burson's next resend.
  const alertId = ctx.store.nextAlertId();
  const draft = fresh && !hadEmail ? draftPlan_(ctx, review, history) : null;
  requirementFinal_(ctx, req, fresh, m.name, draft, '');
  const decide = !draft && !hadEmail && (fresh || !done);
  // Auto-find missing links: the found link stays marked until Burson's own link takes its place
  const values = fresh ? snapshotFields_(review.fields) : Object.assign({}, forwarded, snapshotFields_(review.fields));
  delete values.link_found;
  const row = ctx.store.addAlert(Object.assign({
    alert_id: alertId, source_message: m.name, source_thread: m.thread || '',
    record_key: review.recordKey || pending.record_key || '', author: review.fields.author || pending.author || '',
    issue_tokens: review.issueTokens, exposure_tag: review.fields.exposure_tag || pending.exposure_tag || '',
    status: told.length && !S.dry_run ? 'fix_requested' : 'fixed', requested: told.length ? told : (pending.requested || []),
    forwarded_fields: Object.assign(values, foundLinkMark_(parsed)),
    forward_message: fresh ? fresh.name : (pending.forward_message || ''),
    forward_thread: fresh ? fresh.thread : (pending.forward_thread || ''), burson_done: false, resend_of: pending.alert_id,
    source_at: sourceAt_(m), seen_at: parsed.seen_at || '', knowledge_used: review.knowledgeUsed || [],
  }, livePairFields_(ctx, m), draft || {}, done && !fresh ? { decision: chainDecision_(ctx, pending) } : {}));
  ctx.store.updateAlert(pending, { status: 'superseded' });
  if (draft) {
    watchDraft_(ctx, alertId);
    tryDraft_(ctx, row, report);
    leadershipPing_(ctx, row, review, history, report);
  } else if (decide) {
    noEmailNeeded_(ctx, row, review, history, report);
  }
  // 👍 only if nothing has actioned this alert yet (the original's decision or Social Alert counts); an alert already
  // processed has its emojis already, unless the resend was decided again
  if (!done || fresh) {
    confirmReceipt_(ctx, row, [pending, pending.forward_message ? ctx.store.emailRowByForward(pending.forward_message) : null]);
  }

  // 3. Burson: ⬇️ on the original, and what the bot changed when it told anything (sendResendActions_)
  sendResendActions_(ctx, m, pending, told, fresh || fwd);
  ctx.store.updateAlert(row, { burson_done: true });
  ctx.store.markDone(m.name, 'resend', alertId);
}

/**
 * Burson's side of a resend (handleResend_, handleResendNoWait_, and the retry in finishAlert_): ⬇️ on the alert it
 * resends (`original`). Never wait on Burson OFF: ⬇️ on the resend too when it still needs changes (`told`, asked in its
 * thread), else 👍 right away only when people take the action from here (drafts off). ON: 👍 right away only when
 * people take the action from here, and in its thread what the bot changed and that it's processed, when it told Burson
 * anything (`told`); nothing more otherwise (the original's thread already says the alert was processed). The
 * auto-correct test space never acts in the Burson space.
 */
function sendResendActions_(ctx, m, original, told, fwd) {
  if (ctx.sourceReadOnly) return;
  const out = bursonOut_(ctx, fwd, 'resend:' + m.name);
  const items = told || [];
  if (!switchOn_(ctx, 'noWait')) {
    if (ctx.settings.react) {
      if (items.length) out.react(m.name, legendEmoji_('superseded'), 'message');
      else if (!draftsOn_(ctx)) out.react(m.name, legendEmoji_('ack'), 'message');
      if (original) out.react(original.source_message, legendEmoji_('superseded'), 'original');
    }
    if (items.length) out.post(fixRequestText_(splitRequested_(items), guardFor_(ctx), true), m.thread, 'fix:' + m.name, shownValues_(items));
    out.flush();
    return;
  }
  if (ctx.settings.react) {
    if (!draftsOn_(ctx)) out.react(m.name, legendEmoji_('ack'), 'message');
    if (original) out.react(original.source_message, legendEmoji_('superseded'), 'original');
  }
  if (items.length) {
    out.post(processedText_(splitRequested_(items), guardFor_(ctx)), m.thread, 'done:' + m.name, shownValues_(items));
  }
  out.flush();
}

/** "priority is now P0, was P1", "engagement is now HIGH, was LOW": what went up between the forwarded values and the resend. */
function raisedBy_(before, after) {
  const out = [];
  const pr = p => ({ P2: 1, P1: 2, P0: 3 })[String(p || '').toUpperCase()] || 0;
  const lv = l => ['VERY LOW', 'LOW', 'MODERATE', 'HIGH', String(GEN.viral_kof_label).toUpperCase()].indexOf(String(l || '').toUpperCase()) + 1;
  if (pr(before.priority) && pr(after.priority) > pr(before.priority)) out.push(`priority is now ${after.priority}, was ${before.priority}`);
  if (lv(before.engagement_level) && lv(after.engagement_level) > lv(before.engagement_level)) {
    out.push(`engagement is now ${after.engagement_level}, was ${before.engagement_level}`);
  }
  return out;
}

/**
 * A Zapier post the bot couldn't read or review still reaches the analysts, as received (and gets its 👍). Never a
 * person's message or a thread reply.
 */
function forwardAsReceived_(ctx, m, report, why) {
  const row = ctx.store.alertBySource(m.name);
  if (row && (row.forward_message || ctx.outboundBlocked)) {  // analysts already have it; only the Burson side didn't finish
    ctx.log(`giving up on the Burson-space actions for ${m.name}; analysts already have the alert`);
    ctx.store.markDone(m.name, row.resend_of ? 'resend' : 'alert', row.alert_id);
    return;
  }
  const src = bursonSource_(ctx, m);
  // an alert in another format the bot couldn't triage (OtherAlerts.gs): reaches a person the same way
  const other = !m.threadReply && otherAlertsHere_(ctx) && (src.zapier || !!ctx.direct) && !src.copied &&
    !!otherAlertOf_(src.text, src.sender, m.links);
  const forward = other || (src.zapier && !m.threadReply && !!src.text.trim() &&
    (m.senderType === 'BOT' || src.copied || detectAlert_(src.text, parseAlert_(src.text), src.sender)));
  if (forward) {
    let copy = null;
    if (!ctx.outboundBlocked) {
      copy = postTo_(ctx, ctx.spaces.analyst.id, joinText_(src.text, `QA: ${why}, so it was forwarded as received.`), null, 'raw:' + m.name);
      report.forwarded++;
    }
    const target = ctx.sourceReadOnly ? (copy && copy.name) : m.name;  // the auto-correct test space: on its own copy
    if (target && ctx.settings.react && !ctx.settings.dry_run) {
      try {
        ctx.chat.react(target, legendEmoji_('ack'));
        if (ctx.outboundBlocked) forwardOwnBurson_(ctx, { type: 'react', name: target, emoji: legendEmoji_('ack') });
      } catch (e) {
        ctx.log(`couldn't react on ${target}: ${(e && e.message) || e}`);
      }
    }
  }
  ctx.store.markDone(m.name, forward ? 'raw_forward' : 'ignored');
}

// ---------------------------------------------------------------------------------------------------------------
// People in the Burson space & the Analyst space
// ---------------------------------------------------------------------------------------------------------------

/** Merges the email/draft state from the original alert row onto a resend row so answers have the full picture. */
function mergedAlertRow_(ctx, row) {
  if (!row) return null;
  if (row.email_status || !row.forward_message) return row;
  const emailRow = ctx.store.emailRowByForward(row.forward_message);
  if (!emailRow) return row;
  return Object.assign({}, emailRow, row, {
    email_status: emailRow.email_status, email_input: emailRow.email_input, email_draft: emailRow.email_draft,
    email_thread: emailRow.email_thread, email_subject: emailRow.email_subject, email_groups: emailRow.email_groups,
  });
}

function handleHuman_(ctx, m, report) {
  const rawAlert = m.threadReply ? ctx.store.alertByThread(m.thread) : null;
  // voiceRow_: with Never wait on Burson ON (Control row 23), the answers say what the bot changed (Voice.gs)
  const alert = voiceRow_(mergedAlertRow_(ctx, rawAlert), switchOn_(ctx, 'noWait'));
  const mentions = m.mentions || [];
  const mentioned = !!ctx.botUser && mentions.indexOf(ctx.botUser) >= 0;
  if (mentions.length && !mentioned) {  // addressed to someone else
    ctx.store.markDone(m.name, 'ignored', alert ? alert.alert_id : '');
    return;
  }
  const talking = !!alert && (alert.requested || []).length > 0;  // the bot asked for fixes in this thread
  const ack = isShortAck_(m.text);
  const questionOrTopic = mentioned || isQuestion_(m.text) || (!!alert && !ack && mentionsAlertField_(m.text));
  if (!alert && !questionOrTopic) {
    ctx.store.markDone(m.name, 'ignored', '');
    return;
  }
  const fwd = alert && alert.forward_message ? { name: alert.forward_message, thread: alert.forward_thread } : null;
  const out = bursonOut_(ctx, fwd, 'human:' + m.name);
  if (questionOrTopic && !selfAnswerOk_(ctx, m)) {  // the loop backstop: never the bot answering itself over and over
    ctx.store.markDone(m.name, 'ignored', alert ? alert.alert_id : '');
    return;
  }
  if (questionOrTopic && ctx.direct) {  // working directly in a space (B33, or B25 with row 32): only Google people are there
    directAnswer_(ctx, m, rawAlert, report);
    return;
  }
  if (questionOrTopic) {
    const guard = guardFor_(ctx);
    const resources = usableResources_(ctx.resources, guard);
    let answer = '';
    // The documents Burson can see (marked Yes on the Resources tab, and nothing internal): the parts that bear on this
    let knowledge = null;
    try {
      knowledge = knowledgeForCtx_(ctx, knowledgeQueryFor_(m.text, alert),
        { budget: KNOWLEDGE_BURSON_CHARS_, onlyUrls: new Set(resources.map(r => r.url)) });
    } catch (e) {
      ctx.log('knowledge base unavailable for this answer: ' + ((e && e.message) || e));
    }
    try { answer = ctx.gemini.answer(m.text, alert, resources, knowledge, { deadline: ctx.deadline }); } catch (e) { ctx.log('Gemini answer failed: ' + ((e && e.message) || e)); }
    const safe = safeAnswer_(answer, alert, guard, resources);
    if (safe.blocked.length) ctx.log(`answer held back (it mentioned ${safe.blocked.join(', ')}); sent the fixed answer instead`);
    out.context(`Burson asked: "${truncate_(m.text, 300)}"`);
    out.post(safe.text, m.thread, 'ans:' + m.name,
      resources.map(r => r.url).concat(safe.blocked.length ? shownValues_((alert && alert.requested) || []) : []));
    out.flush();
    report.answers++;
    if (typeof recordAnalysisQa_ === 'function') {
      recordAnalysisQa_(ctx, {
        message: m.name, thread: m.thread || '', at: m.createTime || ctx.now(),
        space: ctx.outboundBlocked ? 'Mirror space' : 'Burson space',
        who: m.senderDisplay || 'Burson', question: m.text || '', bot_answer: safe.text || '',
        alert_id: alert ? alert.alert_id : '', blocked: safe.blocked || [],
        docs_used: (knowledge && knowledge.docs) || [],
      });
    }
    ctx.store.markDone(m.name, 'question', alert ? alert.alert_id : '');
  } else if (talking && ack) {  // "ok, will fix": nothing to say or mark (👍 in the legend is for alerts)
    report.acks++;
    ctx.store.markDone(m.name, 'ack', alert.alert_id);
  } else {
    ctx.store.markDone(m.name, 'ignored', alert ? alert.alert_id : '');
  }
}

/**
 * Working directly in B25 (Control row 32, ctx.direct), or in the Other alerts space (B33, ctx.otherSpace): a question
 * there gets the answer analysts get in their own space (Voice.gs answerAnalystPrompts_: the whole knowledge base, the
 * web, the alert's escalation, and the triage of an alert in another format, OtherAlerts.gs), posted right in its thread.
 * Only Google people can join that space, so the Burson guard doesn't apply there (postTo_ skipGuard); the answer is kept
 * as the bot's own ('anaans:').
 */
function directAnswer_(ctx, m, rawAlert, report) {
  const alert = mergedAlertRow_(ctx, rawAlert);
  let knowledge = null;  // every document on the Resources tab: the parts that bear on this question
  try {
    knowledge = knowledgeForCtx_(ctx, knowledgeQueryFor_(m.text, alert), { budget: KNOWLEDGE_ANSWER_CHARS_ });
  } catch (e) {
    ctx.log('knowledge base unavailable for this answer: ' + ((e && e.message) || e));
  }
  let raw = '';
  try {
    raw = ctx.gemini.answerAnalyst ? ctx.gemini.answerAnalyst(m.text, alert, ctx, knowledge) : ctx.gemini.answer(m.text, alert, []);
  } catch (e) {
    ctx.log('Gemini analyst answer failed: ' + ((e && e.message) || e));
  }
  const clean = chatMarkupText_(String(raw || '')).trim().replace(new RegExp('^' + GEN.prefix + '\\s*'), '');
  const text = clean ? truncate_(clean, 1500) : fallbackAnalystAnswer_(alert, ctx);
  postTo_(ctx, ctx.spaces.burson.id, text, m.thread || null, 'anaans:' + m.name, null, true);
  report.answers++;
  if (typeof recordAnalysisQa_ === 'function') {
    recordAnalysisQa_(ctx, {
      message: m.name, thread: m.thread || '', at: m.createTime || ctx.now(),
      space: ctx.otherSpace ? 'Other alerts space' : 'B25 space',
      who: m.senderDisplay || 'Google analyst', question: m.text || '', bot_answer: text || '',
      alert_id: alert ? alert.alert_id : '', docs_used: (knowledge && knowledge.docs) || [],
    });
  }
  ctx.store.markDone(m.name, 'question', alert ? alert.alert_id : '');
}

function detectImSignin_(text) {
  return /\b(taking over|signing in|on[- ]?call|on[- ]?shift|im here|i'm on|covering|here for the next)\b/i.test(String(text || ''));
}

/** Polls the analyst clean-data space for questions in alert threads (or @mentions) and passive IM shift sign-ins. */
function pollAnalystMessages_(ctx, report) {
  const S = ctx.settings;
  const start = ctx.now();
  const saved = Number((ctx.memo && ctx.memo.get('analyst_cursor')) || 0);
  const cursor = saved || (start - S.start_lookback_minutes * 60 * 1000);
  const since = new Date(Math.max(cursor - S.overlap_minutes * 60 * 1000, ctx.floor || 0)).toISOString();
  const msgs = ctx.chat.list(ctx.spaces.analyst.id, since, LIST_LIMIT_).sort((a, b) => a.createTime - b.createTime);
  const room = ctx.deadline - start;
  let newCursor = cursor;
  let blocked = false;
  const advance = m => { if (!blocked) newCursor = Math.max(newCursor, m.createTime); };
  const isPendingB10Alert = m => {
    if (!ctx.sourceReadOnly || !m || m.threadReply) return false;
    if (ctx.recent.has(m.name) || ctx.store.isDone(m.name)) return false;
    if (typeof pwAlertOf_ === 'function' && pwAlertOf_(ctx, m)) return true;
    const ing = (typeof bqIngestedSource_ === 'function' && bqIngestedSource_(ctx, m)) ||
      (typeof sheetTestSource_ === 'function' && sheetTestSource_(ctx, m));
    if (ing) {
      const p = parseAlert_(m.text);
      return Boolean(detectAlert_(m.text, p, 'Zapier'));
    }
    return false;
  };
  // Pick up any newly posted Sheet test alert from B10 right away (without moving analyst_cursor past older cards)
  if (ctx.sourceReadOnly && typeof sheetTestSource_ === 'function') {
    for (const stMsg of msgs) {
      if (ctx.now() > ctx.deadline) break;
      if (!stMsg || stMsg.threadReply || !sheetTestSource_(ctx, stMsg)) continue;
      if (ctx.recent.has(stMsg.name) || ctx.store.isDone(stMsg.name)) continue;
      const parsedSt = parseAlert_(stMsg.text);
      if (!detectAlert_(stMsg.text, parsedSt, 'Zapier')) continue;
      report.handled++;
      report.alerts++;
      try {
        handleAlert_(ctx, stMsg, parsedSt, report);
        ctx.recent.add(stMsg.name, stMsg.createTime);
      } catch (e) {
        report.errors.push(`${stMsg.name}: ${(e && e.message) || e}`);
        report.analyst_backlog = true;
      }
    }
  }
  for (let idx = 0; idx < msgs.length; idx++) {
    const m = msgs[idx];
    if (ctx.now() > ctx.deadline) {
      if (msgs.slice(idx).some(isPendingB10Alert)) {
        report.analyst_backlog = true;
        if (!(report.errors || []).some(e => /^time budget/.test(String(e))) ) {
          report.errors.push('time budget reached; the rest is handled next run');
        }
      }
      break;
    }
    // Auto-correct space (B10): triage the bot's own Watch alerts (B35 = Auto-correct space (B10)) right in B10
    if (ctx.sourceReadOnly && !m.threadReply && typeof pwAlertOf_ === 'function') {
      const watched = pwAlertOf_(ctx, m);
      if (watched) {
        if (ctx.recent.has(m.name) || ctx.store.isDone(m.name)) {
          ctx.recent.add(m.name, m.createTime);
          advance(m);
          continue;
        }
        if (report.handled >= S.max_messages_per_run) { report.analyst_backlog = true; blocked = true; break; }
        report.handled++;
        report.alerts++;
        ctx.reviewHold = { first: report.handled === 1, room };
        try {
          handleOtherAlert_(ctx, m, watched, report);
          ctx.recent.add(m.name, m.createTime);
          advance(m);
        } catch (e) {
          if (e && e.holdReview) {
            report.handled--;
            report.alerts--;
            report.held = (report.held || 0) + 1;
            report.analyst_backlog = true;
            ctx.log(`held ${m.name} for the next run: ${e.message}`);
            blocked = true;
            break;
          }
          report.errors.push(`${m.name}: ${(e && e.message) || e}`);
          report.analyst_backlog = true;
          blocked = true;
        } finally {
          ctx.reviewHold = null;
        }
        continue;
      }
    }
    // Auto-correct space (B10) standalone Direct-BQ and Sheet-test cards
    if (ctx.sourceReadOnly && !m.threadReply &&
        (typeof bqIngestedSource_ === 'function' || typeof sheetTestSource_ === 'function')) {
      const bqSrc = (typeof bqIngestedSource_ === 'function' && bqIngestedSource_(ctx, m)) ||
        (typeof sheetTestSource_ === 'function' && sheetTestSource_(ctx, m));
      if (bqSrc) {
        if (ctx.recent.has(m.name) || ctx.store.isDone(m.name)) {
          ctx.recent.add(m.name, m.createTime);
          advance(m);
          continue;
        }
        const parsedBq = parseAlert_(m.text);
        if (detectAlert_(m.text, parsedBq, 'Zapier')) {
          if (report.handled >= S.max_messages_per_run) { report.analyst_backlog = true; blocked = true; break; }
          report.handled++;
          report.alerts++;
          ctx.reviewHold = { first: report.handled === 1, room };
          try {
            handleAlert_(ctx, m, parsedBq, report);
            ctx.recent.add(m.name, m.createTime);
            advance(m);
          } catch (e) {
            if (e && e.holdReview) {
              report.handled--;
              report.alerts--;
              report.held = (report.held || 0) + 1;
              report.analyst_backlog = true;
              ctx.log(`held ${m.name} for the next run: ${e.message}`);
              blocked = true;
              break;
            }
            report.errors.push(`${m.name}: ${(e && e.message) || e}`);
            report.analyst_backlog = true;
            blocked = true;
          } finally {
            ctx.reviewHold = null;
          }
          continue;
        }
      }
    }
    if (ctx.recent.has(m.name) || isOwnMessage_(ctx, m) || COPIED_ROW_RX_.test(String(m.text || ''))) {  // incl. old test-feed reposts
      ctx.recent.add(m.name, m.createTime);
      advance(m);
      continue;
    }
    if (m.threadReply && ctx.spaces.analyst.id === campaignAlertsSpace_(ctx)) {
      if (isCampaignOwnedThread_(ctx, ctx.spaces.analyst.id, m.thread)) {
        ctx.recent.add(m.name, m.createTime);
        advance(m);
        continue;
      }
      if (isCampaignHandoffRequest_(ctx, ctx.spaces.analyst.id, m)) {
        handOffThreadToCampaigns_(ctx, ctx.spaces.analyst.id, m);
        ctx.store.markDone(m.name, 'campaign_handoff');
        ctx.recent.add(m.name, m.createTime);
        advance(m);
        continue;
      }
    }
    if (m.senderType !== 'BOT' && m.senderName && (m.senderName !== ctx.botUser || detectImSignin_(m.text))) {
      if (ctx.memo) ctx.memo.set('im_user', m.senderName);
    }
    const mentions = m.mentions || [];
    const mentioned = !!ctx.botUser && mentions.indexOf(ctx.botUser) >= 0;
    if (m.senderType === 'BOT' || (mentions.length && !mentioned)) {
      ctx.recent.add(m.name, m.createTime);
      advance(m);
      continue;
    }
    const ack = isShortAck_(m.text);
    const wantsAnswer = mentioned || (!ack && isQuestion_(m.text)) ||
      (m.threadReply && !ack && (mentionsAnalystAction_(m.text) || mentionsAlertField_(m.text)));
    if (!wantsAnswer) {
      ctx.recent.add(m.name, m.createTime);
      advance(m);
      continue;
    }
    if (ctx.store.isDone(m.name)) {
      ctx.recent.add(m.name, m.createTime);
      advance(m);
      continue;
    }
    if (!selfAnswerOk_(ctx, m)) {  // the loop backstop: never the bot answering itself over and over
      ctx.store.markDone(m.name, 'ignored', '');
      ctx.recent.add(m.name, m.createTime);
      advance(m);
      continue;
    }
    const rawAlert = m.threadReply ? ctx.store.alertByForwardThread(m.thread) : null;
    const alert = mergedAlertRow_(ctx, rawAlert);
    let raw = '';
    let knowledge = null;  // every document on the Resources tab: the parts that bear on this question
    try {
      knowledge = knowledgeForCtx_(ctx, knowledgeQueryFor_(m.text, alert), { budget: KNOWLEDGE_ANSWER_CHARS_ });
    } catch (e) {
      ctx.log('knowledge base unavailable for this answer: ' + ((e && e.message) || e));
    }
    try {
      raw = ctx.gemini.answerAnalyst ? ctx.gemini.answerAnalyst(m.text, alert, ctx, knowledge) : ctx.gemini.answer(m.text, alert, []);
    } catch (e) {
      ctx.log('Gemini analyst answer failed: ' + ((e && e.message) || e));
    }
    const clean = chatMarkupText_(String(raw || '')).trim().replace(new RegExp('^' + GEN.prefix + '\\s*'), '');
    const text = clean
      ? truncate_(clean, 1500)
      : fallbackAnalystAnswer_(alert, ctx);
    postTo_(ctx, ctx.spaces.analyst.id, text, m.thread || null, 'anaans:' + m.name);  // kept as the bot's own (postTo_)
    report.answers++;
    if (typeof recordAnalysisQa_ === 'function') {
      recordAnalysisQa_(ctx, {
        message: m.name, thread: m.thread || '', at: m.createTime || ctx.now(),
        space: 'Analyst space', who: m.senderDisplay || 'Google analyst',
        question: m.text || '', bot_answer: text || '',
        alert_id: alert ? alert.alert_id : '',
        docs_used: (knowledge && knowledge.docs) || [],
      });
    }
    ctx.store.markDone(m.name, 'question', alert ? alert.alert_id : '');
    ctx.recent.add(m.name, m.createTime);
    advance(m);
  }
  if (ctx.memo && newCursor !== saved) ctx.memo.set('analyst_cursor', String(newCursor));
}

// ---------------------------------------------------------------------------------------------------------------
// Analyst reactions on forwarded alerts: the same emoji on Burson's post (legend), and the Social Alert draft
// ---------------------------------------------------------------------------------------------------------------

function analystReactions_(ctx, report, mirror) {
  const never = new Set(ctx.settings.never_mirror || []);
  const since = new Date(ctx.now() - MIRROR_DAYS_ * DAY_MS_).toISOString();
  const reacted = ctx.chat.list(ctx.spaces.analyst.id, since, LIST_LIMIT_, true).filter(fm => fm.reactions && fm.reactions.length);
  // with the counts: an analyst adding an emoji someone already added (Burson's, brought over by the relay) counts too
  const fingerprint = hashText_(reacted.map(fm => fm.name + ':' + fm.reactions.map(r => r.emoji + r.count).sort().join(',')).sort().join('|'));
  if (ctx.memo.get('mirror_fp') === fingerprint) return;  // no reaction changed since the last pass
  let failed = false;
  const relayed = relayAddedEmojis_(ctx);  // Relay.gs: Burson's emojis brought over are never the analysts' actions
  if (!relayed) return;  // the Relay tab couldn't be read: nothing acted on this run (tried again next run)
  reacted.forEach(fm0 => {
    const fm = withoutRelayedEmojis_(relayed, fm0);
    if (draftsOn_(ctx) && !draftReactions_(ctx, fm, report)) failed = true;
    if (!mirror) return;
    const row = ctx.store.alertByForward(fm.name);
    if (!row || !row.source_message) return;
    const mirrored = String(row.mirrored || '').split(' ').filter(Boolean);
    const patch = {};
    fm.reactions.forEach(r => {
      const entry = legendByEmoji_(r.emoji);
      if (!entry) return;
      if (never.has(entry.code)) {  // e.g. 👎 "the bot got this wrong": recorded for tuning, never shown to Burson
        if (entry.kind === 'feedback' && row.feedback !== entry.code) patch.feedback = entry.code;
        return;
      }
      if (mirrored.some(e => legendByEmoji_(e) === entry)) return;
      try {
        ctx.chat.react(row.source_message, entry.emoji);
        mirrored.push(entry.emoji);
        patch.mirrored = mirrored.join(' ');
        report.mirrored++;
      } catch (e) {
        failed = true;
        ctx.log(`couldn't copy ${entry.emoji} to ${row.source_message}: ${(e && e.message) || e}`);
      }
    });
    if (Object.keys(patch).length) ctx.store.updateAlert(row, patch);
  });
  if (!failed) ctx.memo.set('mirror_fp', fingerprint);
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/**
 * Burson-space actions for one message. Live: executed in order (a reaction that fails is logged and skipped; a post
 * that fails throws, so the message is retried). Dry run: nothing touches the Burson space; one note describing the
 * actions goes under the forwarded copy in the analyst space. In the Mirror space each one, once done there, also goes
 * where S-F Burson would get it with Post in S-F Burson (row 24) ON (Outbox.gs forwardOwnBurson_).
 */
function bursonOut_(ctx, fwd, key) {
  const actions = [];
  return {
    react(name, emoji, target) { if (name && emoji) actions.push({ type: 'react', name, emoji, target }); },
    post(text, thread, postKey, allow) { actions.push({ type: 'post', text, thread, key: postKey, allow }); },
    context(text) { actions.push({ type: 'context', text }); },
    flush() {
      if (ctx.sourceReadOnly) return;  // the auto-correct test space: nothing is ever posted or reacted in the Burson space
      if (ctx.settings.dry_run) {
        const note = dryRunNote_(actions.filter(a => a.type !== 'context'));
        const context = actions.filter(a => a.type === 'context').map(a => a.text).join('\n');
        if (note) postTo_(ctx, ctx.spaces.analyst.id, (context ? context + '\n' : '') + note, fwd && fwd.thread, 'dry:' + key);
        return;
      }
      actions.forEach(a => {
        if (a.type === 'react') {
          try {
            ctx.chat.react(a.name, a.emoji);
            if (ctx.outboundBlocked) forwardOwnBurson_(ctx, a);
          } catch (e) {
            ctx.log(`couldn't react ${a.emoji} on ${a.name}: ${(e && e.message) || e}`);
          }
        }
        if (a.type === 'post') {
          const text = bursonSafeText_(ctx, a.text, a.allow);
          postTo_(ctx, ctx.spaces.burson.id, text, a.thread, a.key, a.allow, true);
          if (ctx.outboundBlocked) forwardOwnBurson_(ctx, { type: 'post', text, thread: a.thread, key: a.key });
        }
      });
    },
  };
}

/**
 * Posts a message. In the Burson space it gets a last check first: anything that would leak is replaced by a
 * generic request (`allow` = values from Burson's own alert shown in the text). Every Burson-space post and every
 * answer (`key` 'ans:' / 'anaans:', in any space) goes in this flow's Message log as the bot's own (own_post), kept for
 * good: whatever else is lost, the bot never takes it for a person's message (isOwnMessage_). `attachments`
 * (optional): Chat.gs chatUploadImage_'s, uploaded to that space first (forwardAlert_'s picture of the post).
 */
function postTo_(ctx, space, text, thread, key, allow, skipGuard, attachments) {
  const burson = space === ctx.spaces.burson.id;
  const body = burson && !skipGuard ? bursonSafeText_(ctx, text, allow) : truncate_(text, MAX_TEXT_);
  const opts = { thread: thread || null, key };
  if (attachments && attachments.length && !burson) opts.attachments = attachments;
  const msg = ctx.chat.post(space, body, opts);
  if (msg && msg.name) {
    if (burson || /^(?:ans|anaans):/.test(String(key || ''))) ctx.store.recordOwnPost(msg.name);
    ctx.recent.add(msg.name, msg.createTime || ctx.now());
  }
  return msg;
}

/** Text for the Burson space, after the last check: anything that would leak is replaced by a generic request. */
function bursonSafeText_(ctx, text, allow) {
  const body = truncate_(text, MAX_TEXT_);
  const hits = guardHits_(body, Object.assign({}, guardFor_(ctx), { allow: allow || [] }));
  if (!hits.length) return body;
  ctx.log(`held back a Burson-space message that mentioned ${hits.join(', ')}; posted a generic request instead`);
  return safeGenericText_(switchOn_(ctx, 'noWait'));
}

function guardFor_(ctx) {
  const a = ctx.spaces.analyst || {};
  return { terms: [a.name, String(a.id || '').replace(/^spaces\//, '')].filter(t => t && String(t).length > 3) };
}

function splitRequested_(items) {
  return { fixes: items.filter(x => !x.problem), missing: items.filter(x => x.problem) };
}

function legendEmoji_(code) { const e = legendByCode_(code); return e ? e.emoji : null; }

function joinText_(body, footer) { return footer ? `${body}\n\n${footer}` : String(body); }

function isTrue_(v) { return v === true || String(v).toLowerCase() === 'true'; }

/** Short FNV-1a fingerprint (pure JS, so it runs in tests too). */
function hashText_(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16) + ':' + s.length;
}
