/**
 * Relay.gs — "Relay with S-F Burson", a switch on the Control tab (row 22, OFF until someone turns it on). With the
 * Mirror space set (B9, outbounds blocked), analysts work from the Mirror space only, and the bot keeps working every
 * alert there too, as before. Every run, before the bot's own pass (Main.gs), each step with a few seconds of its own:
 *
 *   From S-F Burson (the Control tab's B25, this run's: ctx.sfBurson) into the Mirror space (relayInbound_): everything,
 *   as anyone in S-F Burson sees it, in S-F Burson's own order:
 *     Zapier's alert            the Mirror's exact copy, in its place (Mirror.gs mirrorCopyAlert_: while the relay runs,
 *                               the Mirror's own pass waits); the pair (live alert, its copy) goes on the Relay tab
 *     a reply in a thread       posted under the same message in the Mirror space: "Name (Burson): text"
 *     a message of its own      posted as a message of its own: "Name (Burson): text"
 *   everyone's: "(Google)" for someone the Relay names tab marks Google, and just the name while their row isn't marked
 *   (relayWho_); nobody waits on that tab. One that can't go yet holds the rest behind it (relayPass_, strict), so
 *   nothing comes over out of order; one that keeps failing is given up on after RELAY_MAX_TRIES_ runs, with a note.
 *   From the Mirror space towards S-F Burson (relayOutbound_), only with "Post in S-F Burson" (row 24) ON too: nothing is
 *   ever written there by the relay. Each goes on the Burson outbox tab (Outbox.gs) as a Pending row, and only a person
 *   setting it to Send posts it:
 *     an analyst's reply        a reply under the same message in S-F Burson: "Name: text"
 *     an analyst's message      a message of its own, unless it starts with "internal:" (it stays in the Mirror space,
 *                               and so do the replies under it)
 *   Emojis (relayEmojis_), on messages posted since the relay started: everyone's in S-F Burson come over onto the
 *   matching Mirror-space message; the analysts' go on the outbox, for the matching S-F Burson message (sent, it shows as
 *   the bot's account; the Relay tab says who added it).
 * With Post in S-F Burson OFF the analysts' side does nothing at all: nothing is queued, and nothing written meanwhile is
 * queued later (it starts from the moment both are ON).
 *
 * With a Burson test copy in the Control tab's B26 (TestCopy.gs: a Google-only space the bot copies S-F Burson into), it
 * plays S-F Burson's part for the analysts' side: their replies, messages and emojis go straight there (relayToCopyOne_,
 * relayEmojisToCopy_), under the matching copy, with no outbox row, no Send and row 24 not needed, and nothing is queued
 * for or written to S-F Burson (even with row 24 ON). B26 set but failing its checks: the analysts' side waits (nothing
 * queued for S-F Burson either). Setting, changing or clearing B26 starts the relay afresh (from then on, saying so in
 * the Mirror space), so nothing written for one goes to the other.
 *
 * Never queued or sent: anything the bot posts or reacts, whatever account it ran as (Chat.gs notes each: botPosted_,
 * botReacted_), an analyst's 👎 and the other never_mirror emojis, and an analyst's message that would show internal
 * details (outboxGuardHits_): the bot says so in its thread instead. The person whose account the bot runs as (B8)
 * counts as an analyst for what they write and add themselves (relayAnalyst_, relayEmojisByAnalyst_). Nothing analysts
 * wrote before the relay was ON (or while it was OFF, paused, or not running: a run that failed before it, or no run for
 * RELAY_STALE_MS_) is queued: each time it starts, it starts from then (Burson's last 15 minutes come over). OFF is
 * noticed as soon as a run reads the Control tab (relaySeen_), and the switches are read again before each row is
 * queued or sent. In the Mirror space the bot treats what came from S-F Burson like Burson's own messages (it may answer
 * a question there, for the analysts), never answers the analysts (Bot.gs), and never takes an emoji that came over for
 * an analyst's action (withoutRelayedEmojis_).
 *
 * Every relayed item is a row on the bot's Relay tab (when, which way, what, who, the text, queued / sent or why not,
 * and the message on each side). The rows are also how a thread on one side is matched to the other, and how nothing
 * is relayed twice; a queued message that's sent from the outbox gets its S-F Burson message there
 * (relaySentFromOutbox_). Chat doesn't give the bot people's names (it signs in as a person, not as an app), so the
 * "Relay names" tab lists everyone the relay has seen: their name and org (Burson or Google), typed in once, are how
 * they're shown from then on. Posts from the outbox come from the bot's account (Chat can't post as someone else).
 * Edits, deletions, removed emojis and files aren't relayed (a file is named in the text).
 *
 * The relay runs only while the switch is ON, with the Mirror space on and outbounds blocked, S-F Burson known (B25 set
 * and found), the run from the bot's own account (B8) and that account known, and not a dry run (relayOn_). When B25
 * changes, it starts again, as after a gap: from then on (Burson's last 15 minutes in the new space come over), and
 * nothing queued for the old space is ever sent (Outbox.gs).
 */

const RELAY_TAB_ = 'Relay';
const RELAY_COLUMNS_ = ['when', 'direction', 'what', 'who', 'user', 'text', 'status', 'burson_message', 'burson_thread',
  'test_message', 'test_thread', 'key', 'copy_message', 'copy_thread'];  // copy_*: the Burson test copy's side (B26)
const RELAY_NAMES_TAB_ = 'Relay names';
const RELAY_NAMES_COLUMNS_ = ['user', 'name', 'org', 'first_seen', 'seen_in', 'example'];
const RELAY_READ_ROWS_ = 3000;              // the latest rows (days of relaying); an older thread pair is looked up
const RELAY_IN_PREFIX_ = 'client-zrly-';    // the bot's posts in the Mirror space of what came from S-F Burson
const RELAY_OUT_PREFIX_ = 'client-zrlo-';   // the bot's posts in S-F Burson of what analysts wrote
const RELAY_ID_RX_ = /^client-(?:bqa|zmir|zrly|zrlo|scmp|zwat|zeda)-/;  // ids only the bot's own posts carry: its work, copies, relays, campaigns, watch alerts, early detection
const RELAY_CURSORS_PROP_ = 'RELAY_CURSORS';  // {space, sfb, copy, in, out, floor, epoch, outFrom, seen, tries}: how far each way has got
const RELAY_GAP_PROP_ = 'RELAY_GAP';          // {from, to}: no run saw the relay in that time, so it started again
const RELAY_BOT_PROP_ = 'RELAY_BOT';          // {email, user}: the bot's own Chat account, for the account it runs as
const RELAY_MARKS_PROP_ = 'RELAY_NAMES_MARKED';  // set once the earlier build's guessed "Burson" orgs were cleared
const RELAY_SUMS_CACHE_ = 'relay_sums_';      // + 'in'/'out': each message's emojis as last seen (script cache)
const RELAY_ADDED_CACHE_ = 'relay_added';     // emojis the relay is putting on Mirror-space messages (until on the tab)
const RELAY_MAX_PER_RUN_ = 25;              // messages each way per run (the rest come on the next run)
const RELAY_START_MS_ = 15 * 60 * 1000;     // turned ON: Burson's last 15 minutes come over; analysts' from then on only
const RELAY_OVERLAP_MS_ = 5 * 60 * 1000;    // messages are read again this far back (never relayed twice)
const RELAY_MAX_GAP_MS_ = 24 * 3600 * 1000; // a message held back by its own failures is read again for up to a day
const RELAY_STALE_MS_ = 10 * 60 * 1000;     // no run relayed for this long (it may have been OFF): it starts again
const RELAY_COPY_WAIT_MS_ = 10 * 60 * 1000; // an analyst's reply under a message the Burson test copy doesn't have yet waits for it
const RELAY_MAX_TRIES_ = 5;                 // a message that fails 5 runs in a row is given up on, with a note
const RELAY_EMOJI_DAYS_ = 3;                // emojis are relayed on messages up to 3 days old
const RELAY_PAIR_WAIT_MS_ = 60 * 60 * 1000; // an emoji on a message with no match on the other side yet: looked at for an hour
const RELAY_MIN_LEFT_MS_ = 20 * 1000;       // with less of the run left, the rest waits for the next run
const RELAY_IN_BUDGET_MS_ = 20 * 1000;      // each run, before the bot's own pass: Burson's messages, at most this long
const RELAY_OUT_BUDGET_MS_ = 15 * 1000;     // then the analysts' messages
const RELAY_EMOJI_BUDGET_MS_ = 15 * 1000;   // then the emojis, both ways
const RELAY_MAX_CHARS_ = 3800;              // a relayed text is cut here (Chat's limit is 4,096 with the name in front)
const RELAY_LIST_FIELDS_ = 'messages(name,createTime,thread,threadReply,clientAssignedMessageId,sender,emojiReactionSummaries),nextPageToken';
const RELAY_FROM_ = 'From S-F Burson';
const RELAY_TO_ = 'To S-F Burson';
const RELAY_TO_COPY_ = 'To the Burson test copy';  // the analysts' side while B26 is set (TestCopy.gs)
const RELAY_KEPT_ = 'kept here (internal)';
const RELAY_THREAD_HELD_ = 'not sent: replies in this thread stay here';
const RELAY_QUEUED_ = 'queued on the Burson outbox';  // waits for a person to set Send there (Outbox.gs); then 'sent'
const RELAY_INTERNAL_RX_ = /^\s*(?:\[internal\]|internal\s*[:\-–—])/i;  // an analyst's message kept in the Mirror space
const RELAY_PREFIX_RX_ = /^([^\n]{1,80}) \((?:Burson|Google)\): ([\s\S]*)$/;  // "Name (Burson): text", as relayed in

/** This run's S-F Burson space id for the relay (ctx.sfBurson: Control tab B25), or '' when none is known. */
function relaySfb_(ctx) { return String((ctx && ctx.sfBurson && ctx.sfBurson.id) || ''); }

/** This run's Burson test copy space id (ctx.testCopy: Control tab B26 when it passed its checks), or ''. */
function relayCopyId_(ctx) { return String((ctx && ctx.testCopy && ctx.testCopy.id) || ''); }

/**
 * The analysts' side runs this run: straight to the Burson test copy (B26 usable), else on the Burson outbox (B26 blank,
 * Post in S-F Burson ON, and the run LIVE: Main.gs runMode_). B26 set but failing its checks, or Testing with no test
 * copy (the Safety valve ON): neither (nothing goes to S-F Burson while Testing).
 */
function relayOutOn_(ctx) {
  if (relayCopyId_(ctx)) return true;
  return !(ctx && ctx.testCopyWanted) && switchOn_(ctx, 'postBurson') && !!(ctx && ctx.live === true);
}

/** The Relay tab's direction for the analysts' side this run, and where it goes, in words. */
function relayToward_(ctx) { return relayCopyId_(ctx) ? RELAY_TO_COPY_ : RELAY_TO_; }
function relayWhere_(ctx) { return relayCopyId_(ctx) ? 'the Burson test copy' : 'S-F Burson'; }

/**
 * The relay runs this run: its switch ON, S-F Burson known (B25), the main flow in the Mirror space with outbounds
 * blocked, the bot's own account known (it's what tells the bot's posts from the analysts'), not a dry run, and nothing
 * stopping it this run.
 */
function relayOn_(ctx) {
  return switchOn_(ctx, 'relay') && !!ctx.outboundBlocked && !!ctx.botUser && !ctx.relayOff && !!relaySfb_(ctx) &&
    !!(ctx.spaces && ctx.spaces.burson && ctx.spaces.burson.id) && ctx.spaces.burson.id !== relaySfb_(ctx) &&
    !(ctx.settings && ctx.settings.dry_run);
}

/** Why the relay isn't running with its switch ON (for C22), or '' when it is. */
function relayWhyOff_(ctx) {
  if (ctx && ctx.direct) return `not relaying: ${DIRECT_B25_MODE_WHY_}`;  // Work directly in B25 (Main.gs, row 32)
  const mirror = !!(ctx.outboundBlocked && ctx.spaces && ctx.spaces.burson && ctx.spaces.burson.id &&
    ctx.spaces.burson.id !== relaySfb_(ctx));
  if (!relaySfb_(ctx)) return `not relaying: it needs the S-F Burson space (B25)${mirror ? '' : ' and the Mirror space (B9)'}`;
  if (!mirror) return 'not relaying: it needs the Mirror space (B9)';
  if (ctx.settings && ctx.settings.dry_run) return 'not relaying: a dry run';
  if (ctx.relayOff) return `not relaying: ${ctx.relayOff}`;
  if (!ctx.botUser) return 'not relaying: the bot\'s own Chat account isn\'t known yet';
  return '';
}

/**
 * Makes sure ctx.botUser is the bot's own Chat account, the one in "Runs as" (Control B8, written by setup()): looked up
 * once per account and kept. A run from anyone else (someone running poll() or startMirror() from the editor) doesn't
 * relay: its posts would show that person. When it can't be confirmed, the relay skips this run (ctx.relayOff), and
 * picks up where it was on the next one. Never throws.
 */
function relayBotUser_(ctx, runsAs) {
  const off = 'couldn\'t confirm the bot\'s own Chat account (it\'s looked up again next run)';
  try {
    const props = PropertiesService.getScriptProperties();
    const email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    const bot = String(runsAs || '').trim().toLowerCase();
    if (!bot || email !== bot) {
      ctx.relayOff = bot ? `this run is from ${email || 'another account'}, not the bot's account in "Runs as" (B8)`
        : '"Runs as" (B8) is blank: run setup() from the bot\'s account';
      return null;
    }
    let known = null;
    try { known = JSON.parse(props.getProperty(RELAY_BOT_PROP_) || 'null'); } catch (e) { known = null; }
    let user = known && email && known.email === email ? known.user : null;
    if (!user && email) {
      user = chatMyUserId_(ctx.spaces.burson.id, email);
      if (user) props.setProperty(RELAY_BOT_PROP_, JSON.stringify({ email, user }));
    }
    if (!user) {
      ctx.relayOff = off;
      return null;
    }
    if (user !== ctx.botUser) {
      props.setProperty('BOT_USER', user);
      ctx.botUser = user;
    }
    return user;
  } catch (e) {
    ctx.relayOff = off;
    ctx.log(`relay: couldn't confirm the bot's account: ${(e && e.message) || e}`);
    return null;
  }
}

/**
 * The relay isn't running this run (OFF, paused, no Mirror space…): it forgets how far it got, so when it's back it
 * starts from then, and nothing written in between goes either way. Never throws.
 */
function relayStop_() {
  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty(RELAY_CURSORS_PROP_)) return;
    props.deleteProperty(RELAY_CURSORS_PROP_);
    CacheService.getScriptCache().removeAll([RELAY_SUMS_CACHE_ + 'in', RELAY_SUMS_CACHE_ + 'out']);
  } catch (e) {
    console.error('relay: couldn\'t reset: ' + ((e && e.message) || e));
  }
}

/**
 * Every run, as soon as the Control tab is read (before anything that can fail): the relay OFF, or the bot paused, is
 * noted at once (relayStop_). ON: when no run relayed for RELAY_STALE_MS_ (the bot wasn't running, runs failed, or they
 * couldn't relay: it may have been OFF in between), it starts again from now, and says so in the Mirror space. Only a
 * run that relays counts (relayCursors_), not one that merely read the switch. Never throws.
 */
function relaySeen_(on) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (!on) {  // OFF or paused: when it's back it says it's on from then, whatever happened before
      relayStop_();
      if (props.getProperty(RELAY_GAP_PROP_)) props.deleteProperty(RELAY_GAP_PROP_);
      return;
    }
    const raw = props.getProperty(RELAY_CURSORS_PROP_);
    if (!raw) return;
    const c = JSON.parse(raw);
    const now = Date.now();
    if (now - (Number(c.seen) || 0) > RELAY_STALE_MS_) {
      relayStop_();
      props.setProperty(RELAY_GAP_PROP_, JSON.stringify({ from: Number(c.seen) || 0, to: now }));
    }
  } catch (e) {
    console.error('relay: couldn\'t note the switch: ' + ((e && e.message) || e));
  }
}

/**
 * A run failed before the relay ran (B9 cleared, a blank space, an error): the relay starts afresh next time, so nothing
 * written in the Mirror space meanwhile is ever queued, and it says in the Mirror space that it didn't run (from the
 * last run that relayed to the last one that failed). Never throws.
 */
function relayFailStop_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(RELAY_CURSORS_PROP_);
    let gap = null;
    try { gap = JSON.parse(props.getProperty(RELAY_GAP_PROP_) || 'null'); } catch (e) { gap = null; }
    if (!raw) {  // already stopped by an earlier failing run: the gap goes on
      if (gap && gap.from) props.setProperty(RELAY_GAP_PROP_, JSON.stringify({ from: gap.from, to: Date.now() }));
      return;
    }
    const c = JSON.parse(raw);
    props.setProperty(RELAY_GAP_PROP_, JSON.stringify({ from: (gap && gap.from) || Number(c.seen) || Date.now(), to: Date.now() }));
    relayStop_();
  } catch (e) {
    console.error('relay: couldn\'t reset after a failed run: ' + ((e && e.message) || e));
  }
}

/** The relay switch and the bot (B2) both still ON, read again now from the Control tab (`control`). */
function relayStillOn_(control) {
  try {
    if (!control) return true;
    if (!parseControl_(control.getRange(2, 2).getValue(), '', '').on) return false;
    return !!readSwitches_(control).relay;
  } catch (e) {
    return false;
  }
}

/**
 * For ctx.relayCanQueue: the relay switch and Bot (B2) still ON, and B26 (the Burson test copy) still `copyValue`, read
 * again from the Control tab at most every few seconds; going to the Burson outbox (B26 blank), Post in S-F Burson still
 * ON too. A row is queued, or sent to the test copy, only while it says so.
 */
function relayLiveCheck_(control, copyValue) {
  let at = 0;
  let ok = true;
  const want = String(copyValue || '').trim();
  return () => {
    if (Date.now() - at >= 5000) {
      ok = relayStillOn_(control) && (!control || readTestCopyCell_(control) === want) && (want ? true : postBursonStillOn_(control));
      at = Date.now();
    }
    return ok;
  };
}

/**
 * How far each way has got: {space, sfb (the S-F Burson space, B25), copy (the Burson test copy, B26, '' when none), in,
 * out, floor: {in, out}, epoch (when it started), outFrom (when the analysts' side last started: Post in S-F Burson
 * turned ON), seen (the last run that relayed: now), tries}. Just started, or another Mirror space, S-F Burson space or
 * test copy than before: from now (Burson's last 15 minutes); nothing older than `floor` is ever read (not even in the
 * overlap), so nothing from before it started goes (nor, after B26 changed, anything written for the other side).
 */
function relayCursors_(mirrorId, now, sfbId, copyId) {
  const props = PropertiesService.getScriptProperties();
  let c = null;
  try { c = JSON.parse(props.getProperty(RELAY_CURSORS_PROP_) || 'null'); } catch (e) { c = null; }
  if (!c || c.space !== mirrorId || String(c.sfb || '') !== String(sfbId || '') || String(c.copy || '') !== String(copyId || '')) {
    c = { space: mirrorId, sfb: sfbId || '', in: now - RELAY_START_MS_, out: now, floor: { in: now - RELAY_START_MS_, out: now },
      epoch: now, outFrom: now, seen: now, tries: {} };
    if (copyId) c.copy = copyId;
    props.setProperty(RELAY_CURSORS_PROP_, JSON.stringify(c));
    c.fresh = true;  // this run only: the relay says it's on (relayStarted_)
  }
  c.seen = now;  // a run that relays (saved with the cursors)
  c.tries = c.tries || {};
  c.floor = c.floor || { in: 0, out: 0 };
  c.outFrom = Number(c.outFrom) || Number(c.epoch) || 0;
  c.in = Math.max(Number(c.in) || 0, now - RELAY_MAX_GAP_MS_);
  c.out = Math.max(Number(c.out) || 0, now - RELAY_MAX_GAP_MS_);
  return c;
}

/** Where reading resumes one way ('in' or 'out'): a little before the cursor, never before the relay started. */
function relaySince_(c, dir) {
  return new Date(Math.max(c[dir] - RELAY_OVERLAP_MS_, Number(c.floor[dir]) || 0)).toISOString();
}

function saveRelayCursors_(c) {
  const names = Object.keys(c.tries || {});
  names.slice(0, Math.max(0, names.length - 50)).forEach(n => { delete c.tries[n]; });
  const kept = Object.assign({}, c);
  delete kept.fresh;
  PropertiesService.getScriptProperties().setProperty(RELAY_CURSORS_PROP_, JSON.stringify(kept));
}

/**
 * Says in the Mirror space, once, that the relay has just started (turned ON, back ON, or again after no run relayed for
 * a while or a run failed, or B26 set, changed or cleared): from when, where what the analysts write goes from now on,
 * and that nothing from before then was queued for S-F Burson (or sent to the Burson test copy). Never throws.
 */
function relayStarted_(ctx, c) {
  try {
    const props = PropertiesService.getScriptProperties();
    let gap = null;
    try { gap = JSON.parse(props.getProperty(RELAY_GAP_PROP_) || 'null'); } catch (e) { gap = null; }
    const at = t => new Date(t).toISOString().slice(11, 16) + ' UTC';
    const copy = !!relayCopyId_(ctx);
    let out;
    if (copy) {
      out = `what you write here goes straight to the Burson test copy (${ctx.testCopy.name || 'Control tab B26'}), with your ` +
        'name, and never to S-F Burson (start a message with "internal:" to keep it here)';
    } else if (ctx.testCopyWanted) {
      out = 'Burson\'s messages come over here, and nothing you write here goes anywhere until the Burson test copy ' +
        '(Control tab B26) is fixed: see C26';
    } else {
      out = switchOn_(ctx, 'postBurson')
        ? 'what you write here waits on the Burson outbox tab, with your name, and goes to S-F Burson only once someone ' +
          'sets it to Send there (start a message with "internal:" to keep it here)'
        : 'Burson\'s messages come over here, and nothing you write here goes to S-F Burson (Post in S-F Burson, Control ' +
          'tab row 24, is OFF)';
    }
    const done = copy ? 'sent to the Burson test copy' : 'queued for S-F Burson';
    const text = gap && gap.from
      ? `The relay with S-F Burson didn't run from ${at(gap.from)} to ${at(gap.to)}, so it started again at ` +
        `${at(c.epoch)}. Anything written here in between wasn't ${done}: post it again to send it. From now ` +
        `on, ${out}.`
      : `The relay with S-F Burson is on from ${at(c.epoch)}. From now on, ${out}. Nothing from before then ` +
        `was ${copy ? 'sent' : 'queued'}.`;
    ctx.chat.post(ctx.spaces.burson.id, text, { key: 'relay-start:' + c.epoch });
    props.deleteProperty(RELAY_GAP_PROP_);
  } catch (e) {
    ctx.log(`relay: couldn't say it started: ${(e && e.message) || e}`);
  }
}

/**
 * The Relay tab and what its latest rows say about Mirror space `mirrorId`: {table, keys (what was relayed),
 * liveToTest / testToLive (message pairs), liveThreadToTest / testThreadToLive (thread pairs), addedIn (the emojis it
 * put on Mirror-space messages), internalThreads, heldThreads, mirrorToCopy / mirrorThreadToCopy (an analyst's message
 * that went to the Burson test copy `copyId`, and its copy there), names (the Relay names tab), add(row), addName(row),
 * olderThread(column, thread): a thread pair from before the rows read, olderCopyThread(thread)}. Rows about another
 * space (B9 changed since) are left out. The tabs are made the first time the relay runs.
 */
function relayState_(ss, mirrorId, copyId) {
  const table = sheetTable_(ss, RELAY_TAB_, RELAY_COLUMNS_, 'key', RELAY_READ_ROWS_);
  const st = relayRows_(table, mirrorId, copyId);
  st.olderThread = (column, thread) => relayOlderThread_(ss.getSheetByName(RELAY_TAB_), table.header, mirrorId, column, thread);
  st.olderCopyThread = thread => relayOlderCopyThread_(ss.getSheetByName(RELAY_TAB_), table.header, copyId, thread);
  return Object.assign(st, relayNames_(ss));
}

/**
 * The Relay names tab (shared by the relay and the Burson test copy, TestCopy.gs): {names: Map user -> row, addName(row),
 * setName(row, name)}. A new row's org gets a Burson / Google dropdown. The first time this build reads the tab, the
 * "Burson" the earlier build filled in by itself for everyone it saw in S-F Burson is cleared (relayMarksOnce_).
 */
function relayNames_(ss) {
  relayMarksOnce_(ss);
  const names = sheetTable_(ss, RELAY_NAMES_TAB_, RELAY_NAMES_COLUMNS_, 'user', 2000);
  const map = new Map();
  names.load().forEach(row => { if (row.user) map.set(String(row.user), row); });
  return {
    names: map,
    addName: row => {
      const full = names.append(Object.assign({ first_seen: new Date().toISOString() }, row));
      map.set(String(row.user), full);
      relayOrgDropdown_(ss, names.header, full._row);
      return full;
    },
    setName: (row, name) => { names.update(row, { name }); },
  };
}

/**
 * Once (nobody is shown as Burson until a person marks them): the build before this one filled in "Burson" by itself as
 * the org of everyone it saw in S-F Burson, Google people included (Chat gives the bot no emails). Those rows (seen in
 * S-F Burson, org exactly "Burson") are cleared, so they show by name only until someone marks them; one log line says
 * how many. Nothing to do when the tab isn't there. Never throws.
 */
function relayMarksOnce_(ss) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(RELAY_MARKS_PROP_)) return;
    if (ss.getSheetByName(RELAY_NAMES_TAB_)) {
      const names = sheetTable_(ss, RELAY_NAMES_TAB_, RELAY_NAMES_COLUMNS_, 'user', 100000);
      let n = 0;
      names.load().forEach(row => {
        if (String(row.seen_in || '').trim() !== 'S-F Burson' || String(row.org || '').trim() !== 'Burson') return;
        names.update(row, { org: '' });
        n++;
      });
      console.log(`Relay names: cleared the "Burson" the earlier build filled in by itself on ${n} row(s); mark each person ` +
        'Burson or Google there (until then they show by name only)');
    }
    props.setProperty(RELAY_MARKS_PROP_, new Date().toISOString());
  } catch (e) {
    console.error('Relay names: couldn\'t clear the earlier build\'s marks (tried again next run): ' + ((e && e.message) || e));
  }
}

/** A Burson / Google dropdown on a Relay names row's org cell (anything else typed is kept, and reads as not marked). */
function relayOrgDropdown_(ss, header, row) {
  try {
    const col = header.indexOf('org') + 1;
    const sh = ss.getSheetByName(RELAY_NAMES_TAB_);
    if (!sh || col < 1 || !row) return;
    sh.getRange(row, col).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Burson', 'Google'], true)
      .setAllowInvalid(true).build());
  } catch (e) { /* a convenience only */ }
}

/**
 * The other side's thread for `thread`, from a Relay tab row older than the rows read each run: `column` is the side
 * it's on ('test_thread' or 'burson_thread'). Returns the other side's thread, or ''.
 */
function relayOlderThread_(sh, header, mirrorId, column, thread) {
  if (!sh || !thread || sh.getLastRow() < 2) return '';
  const col = header.indexOf(column) + 1;
  const other = header.indexOf(column === 'test_thread' ? 'burson_thread' : 'test_thread');
  const testCol = header.indexOf('test_thread');
  if (col < 1 || other < 0) return '';
  const found = sh.getRange(2, col, sh.getLastRow() - 1, 1).createTextFinder(String(thread)).matchEntireCell(true).findAll();
  for (const cell of found) {
    const row = sh.getRange(cell.getRow(), 1, 1, header.length).getValues()[0];
    if (row[other] && String(row[testCol]).indexOf(mirrorId + '/') === 0) return String(row[other]);
  }
  return '';
}

/** The Burson test copy's thread (in `copyId`) for Mirror thread `thread`, from an older Relay tab row, or ''. */
function relayOlderCopyThread_(sh, header, copyId, thread) {
  if (!sh || !copyId || !thread || sh.getLastRow() < 2) return '';
  const col = header.indexOf('test_thread') + 1;
  const copyCol = header.indexOf('copy_thread');
  if (col < 1 || copyCol < 0) return '';
  const found = sh.getRange(2, col, sh.getLastRow() - 1, 1).createTextFinder(String(thread)).matchEntireCell(true).findAll();
  for (const cell of found) {
    const row = sh.getRange(cell.getRow(), 1, 1, header.length).getValues()[0];
    if (String(row[copyCol] || '').indexOf(copyId + '/') === 0) return String(row[copyCol]);
  }
  return '';
}

/** The Relay tab's rows (see relayState_), read through `table` (sheetTable_); `copyId`: this run's test copy, or none. */
function relayRows_(table, mirrorId, copyId) {
  const st = {
    table, keys: new Set(), liveToTest: new Map(), testToLive: new Map(), liveThreadToTest: new Map(), testThreadToLive: new Map(),
    addedIn: new Map(), internalThreads: new Set(), heldThreads: new Set(), queuedThreads: new Set(), mirrorToCopy: new Map(),
    mirrorThreadToCopy: new Map(),
  };
  const ours = name => !name || String(name).indexOf(mirrorId + '/') === 0;
  const inCopy = name => !!copyId && String(name || '').indexOf(copyId + '/') === 0;
  st.note = row => {
    if (!ours(row.test_message) || !ours(row.test_thread)) return;
    if (row.key) st.keys.add(String(row.key));
    const live = String(row.burson_message || '');
    const test = String(row.test_message || '');
    if (live && test && row.what !== 'emoji') { st.liveToTest.set(live, test); st.testToLive.set(test, live); }
    const lt = String(row.burson_thread || '');
    const tt = String(row.test_thread || '');
    if (lt && tt) {  // an alert's pair wins: Burson's replies go under the alert even after one came over on its own
      if (row.what === 'alert' || !st.liveThreadToTest.has(lt)) st.liveThreadToTest.set(lt, tt);
      if (row.what === 'alert' || !st.testThreadToLive.has(tt)) st.testThreadToLive.set(tt, lt);
    }
    if (row.direction === RELAY_FROM_ && row.what === 'emoji' && test) {
      st.addedIn.set(test, (st.addedIn.get(test) || new Set()).add(bareEmoji_(row.text)));
    }
    const toward = row.direction === RELAY_TO_ || row.direction === RELAY_TO_COPY_;  // the analysts' side, either way
    if (toward && tt && row.status === RELAY_KEPT_) st.internalThreads.add(tt);
    if (toward && tt && String(row.status || '').indexOf(RELAY_THREAD_HELD_) === 0) st.heldThreads.add(tt);
    // an analyst's message of its own waiting on the Burson outbox: replies under it wait there too
    if (row.direction === RELAY_TO_ && row.what === 'message' && tt && row.status === RELAY_QUEUED_) st.queuedThreads.add(tt);
    // what went straight to the Burson test copy (B26): an analyst's message and its copy there, so replies and emojis follow
    if (row.direction === RELAY_TO_COPY_ && row.what !== 'emoji' && inCopy(row.copy_message)) {
      if (test) st.mirrorToCopy.set(test, String(row.copy_message));
      if (tt && inCopy(row.copy_thread)) st.mirrorThreadToCopy.set(tt, String(row.copy_thread));
    }
  };
  st.add = row => {
    const full = Object.assign({ when: new Date().toISOString() }, row);
    table.append(full);
    st.note(full);
  };
  table.load().forEach(st.note);
  return st;
}

/**
 * The emojis the relay put on Mirror-space messages for Burson: Map name -> Set of emojis. From the Relay tab (through
 * ctx.relayAdded: the run's relay state, or the tab read once when it's there) and the ones going on right now. For
 * analystReactions_ (Bot.gs). Null when the Relay tab couldn't be read: then the bot acts on no emoji this run, rather
 * than take Burson's for an analyst's. Never throws.
 */
function relayAddedEmojis_(ctx) {
  const out = new Map();
  if (!ctx.outboundBlocked) return out;
  const mirrorId = ctx.spaces.burson.id;
  try {
    const fromTab = ctx.relayAdded ? ctx.relayAdded() : null;
    if (fromTab) fromTab.forEach((set, name) => out.set(name, new Set(set)));
  } catch (e) {
    console.error('relay: couldn\'t read the emojis it brought over: ' + ((e && e.message) || e));
    return null;
  }
  try {
    const now = JSON.parse(CacheService.getScriptCache().get(RELAY_ADDED_CACHE_) || '{}') || {};
    Object.keys(now[mirrorId] || {}).forEach(name => {
      const set = out.get(name) || new Set();
      now[mirrorId][name].forEach(e => set.add(bareEmoji_(e)));
      out.set(name, set);
    });
  } catch (e) {
    console.error('relay: couldn\'t read the emojis going on: ' + ((e && e.message) || e));
  }
  return out;
}

/** For ctx.relayAdded when the relay isn't running this run: the Relay tab's emoji rows, read once, only if it's there. */
function relayAddedLoader_(ss, mirrorId) {
  let added = null;
  return () => {
    if (!added) {
      added = ss.getSheetByName(RELAY_TAB_)
        ? relayRows_(sheetTable_(ss, RELAY_TAB_, RELAY_COLUMNS_, 'key', RELAY_READ_ROWS_), mirrorId).addedIn : new Map();
    }
    return added;
  };
}

/** Notes an emoji the relay is about to put on a Mirror-space message, until its Relay tab row is written. */
function relayNoteAdded_(mirrorId, test, emoji) {
  const cache = CacheService.getScriptCache();
  let map = {};
  try { map = JSON.parse(cache.get(RELAY_ADDED_CACHE_) || '{}') || {}; } catch (e) { map = {}; }
  const mine = map[mirrorId] || {};
  mine[test] = (mine[test] || []).concat([bareEmoji_(emoji)]);
  const names = Object.keys(mine);
  names.slice(0, Math.max(0, names.length - 200)).forEach(n => { delete mine[n]; });
  cache.put(RELAY_ADDED_CACHE_, JSON.stringify({ [mirrorId]: mine }), 21600);
}

/**
 * A Mirror-space message's emojis without the ones the relay put there for Burson (an emoji only Burson added): the
 * bot acts on what analysts add (Drafts.gs draftReactions_), never on Burson's. `added`: relayAddedEmojis_.
 */
function withoutRelayedEmojis_(added, fm) {
  const mine = added && added.get(fm.name);
  if (!mine || !mine.size) return fm;
  const reactions = (fm.reactions || []).map(r => (mine.has(bareEmoji_(r.emoji)) ? Object.assign({}, r, { count: r.count - 1 }) : r))
    .filter(r => r.count > 0);
  return Object.assign({}, fm, { reactions });
}

function bareEmoji_(emoji) { return String(emoji || '').replace(/️/g, ''); }

/** Remembers what came from S-F Burson in a message the relay posted in the Mirror space (for Bot.gs). Never throws. */
function rememberRelayed_(name, info) {
  if (!name) return;
  try { CacheService.getScriptCache().put('zrly:' + name, JSON.stringify(info), 21600); } catch (e) { /* the id prefix still says */ }
}

/**
 * What came from S-F Burson in a Mirror-space message the relay posted: {who, text, mentions}, or null when it isn't
 * one. Known by its message id, else (custom ids refused) by the cache, else by its "Name (Burson): " line. Pure but for
 * the cache.
 */
function relayedFrom_(ctx, m) {
  if (!m || !ctx.botUser || m.senderName !== ctx.botUser) return null;
  const id = String(m.clientId || '');
  if (id && id.indexOf(RELAY_IN_PREFIX_) !== 0) return null;  // another of the bot's posts: its own, an alert's copy
  let info = null;
  try { info = JSON.parse(CacheService.getScriptCache().get('zrly:' + m.name) || 'null'); } catch (e) { info = null; }
  if (info) return info;
  const text = String(m.text || '');
  const isBotMsg = typeof isBotFormattedText_ === 'function' ? isBotFormattedText_(text) : text.trim().indexOf(GEN.prefix) === 0;
  const parts = isBotMsg ? null : text.match(RELAY_PREFIX_RX_);
  if (!id && !(parts && relayOn_(ctx))) return null;
  return parts ? { who: parts[1], text: parts[2], mentions: [] } : { who: 'Burson', text, mentions: [] };
}

/**
 * Who wrote a message (or added an emoji), for how it shows once copied over (relayWho_): {name, org ('Burson',
 * 'Google', or '' while they aren't marked), mark ('burson' | 'google' | '')}. Chat doesn't give the bot people's names,
 * so they come from the Relay names tab (typed in once); someone new gets a row there, with their name when Chat does
 * give it, and their org left blank for a person to mark Burson or Google: nobody is shown as Burson until their row says
 * so (Google when Chat gives an @google.com address; an analyst in the Mirror space is Google, as before). `side`:
 * 'burson' (S-F Burson) or 'mirror' (an analyst).
 */
function relayPerson_(rs, m, side) {
  const user = String((m && m.senderName) || '');
  const display = String((m && m.senderDisplay) || '').trim();
  const fromGoogle = /@google\.com$/i.test(String((m && m.senderEmail) || ''));
  let row = user ? rs.names.get(user) : null;
  try {
    if (user && !row) {
      row = rs.addName({ user, name: display, org: side === 'burson' && !fromGoogle ? '' : 'Google',
        seen_in: side === 'burson' ? 'S-F Burson' : 'the Mirror space', example: truncate_(String((m && m.text) || '(an emoji)'), 80) });
    } else if (row && !String(row.name || '').trim() && display) {
      rs.setName(row, display);
    }
  } catch (e) {
    console.error('relay: couldn\'t note a name: ' + ((e && e.message) || e));
  }
  const name = String((row && row.name) || '').trim() || display || (side === 'burson' ? 'Someone' : 'Google team');
  const mark = fromGoogle ? 'google' : relayMark_(row && row.org);
  return { name: truncate_(name, 60), org: mark === 'burson' ? 'Burson' : mark === 'google' ? 'Google' : '', mark };
}

/**
 * What a Relay names row's org says: 'google' (anything with Google in it), 'burson' (Burson, and only that), or ''
 * (blank, or anything else: not marked yet, so never shown as Burson). Pure.
 */
function relayMark_(org) {
  const v = String(org === undefined || org === null ? '' : org).trim();
  if (/google/i.test(v)) return 'google';
  return /^burson$/i.test(v) ? 'burson' : '';
}

/** How someone (relayPerson_) shows on what's copied over: "Name (Burson)", "Name (Google)", or the name alone. Pure. */
function relayWho_(p) { return p.org ? `${p.name} (${p.org})` : p.name; }

/**
 * True for a message the bot made itself, whatever account it ran as: one it noted posting (Chat.gs botPosted_), one
 * with one of its ids (its own posts, copies and relays), or its own formatted note under the account it runs as. Anything else in S-F
 * Burson is a person's (the person whose account the bot runs as included) or an app's.
 */
function relayBotsOwn_(ctx, m) {
  if (botPosted_(m.name) || (m.clientId && RELAY_ID_RX_.test(String(m.clientId)))) return true;
  return !!(ctx && ctx.botUser) && m.senderName === ctx.botUser &&
    ((typeof isBotFormattedText_ === 'function' ? isBotFormattedText_(m.text) : String(m.text || '').trim().indexOf(GEN.prefix) === 0) ||
      (!m.threadReply && typeof pwAlertParse_ === 'function' && !!pwAlertParse_(m.text)) ||
      (!m.threadReply && typeof edAlertPosted_ === 'function' && edAlertPosted_(m.name)));  // watch & early-detection alerts
}

/**
 * The message's text, with any files it carries named (they aren't relayed), cut at RELAY_MAX_CHARS_. `where`: the
 * side the rest is on, named only in the Mirror space (never in what goes to S-F Burson).
 */
function relayBody_(m, where) {
  let text = String((m && m.text) || '').trim();
  if (text.length > RELAY_MAX_CHARS_) text = `${text.slice(0, RELAY_MAX_CHARS_)}… [cut short${where ? `: the rest is in ${where}` : ''}]`;
  const files = ((m && m.attachments) || []).map(a => a.name).filter(Boolean);
  const kind = files.length === 1 ? 'a file' : files.length + ' files';
  const note = files.length ? `[${kind}: ${files.join(', ')}${where ? `, open in ${where}` : ', not attached here'}]` : '';
  return [text, note].filter(Boolean).join(text ? '\n' : '');
}

/**
 * Posts in the Mirror space what came from S-F Burson (never in S-F Burson itself), with the relay's own message id so
 * the bot tells it from Zapier's alerts and from analysts. Idempotent on `key`.
 */
function relayPostIn_(mirrorId, text, thread, key) {
  if (!mirrorId || mirrorId === sfBursonId_() || outsideSpace_(mirrorId)) throw new Error(`Refusing to relay into ${mirrorId}.`);
  const msg = chatPostMessage_(mirrorId, text, { thread: thread || null, key, idPrefix: RELAY_IN_PREFIX_ });
  rememberBotUser_(msg);
  return msg;
}

/**
 * An analyst's message or emoji for S-F Burson: a Pending row on the Burson outbox (Outbox.gs), never a write there.
 * Only while the relay runs (relayOn_) and Post in S-F Burson is ON, both still ON on the Control tab (ctx.relayCanQueue),
 * and never while the Burson test copy (B26) is set: then nothing is queued for S-F Burson at all. `write`: see
 * outboxItem_ (Outbox.gs). Returns the outbox's answer, or null when it's not to be queued now (the caller leaves it
 * for the next run, which starts afresh if a switch went OFF). Throws when the outbox couldn't take it.
 */
function relayQueue_(ctx, write) {
  if (!relayOn_(ctx) || !switchOn_(ctx, 'postBurson') || !ctx.outbox || ctx.testCopyWanted || relayCopyId_(ctx)) return null;
  if (ctx.live !== true) return null;  // Testing (Main.gs runMode_): nothing is queued for S-F Burson
  if (ctx.relayCanQueue && !ctx.relayCanQueue()) return null;
  const res = ctx.outbox.add(write);
  if (res && res.queued) return res;
  if (res && res.withheld) return null;
  throw new Error(`couldn't be queued on the Burson outbox: ${(res && res.why) || 'unknown'}`);
}

/**
 * A relay row the outbox just sent (Outbox.gs sendBursonOutbox_): its Relay tab row says sent, with the S-F Burson
 * message, so Burson's replies under it come back under the analyst's message, and replies and emojis on it find it.
 * `key`: the row's key (key.relay: {m, tm, tt, who, user, what, rk}); `posted`: the message (null for an emoji).
 */
function relaySentFromOutbox_(ss, key, posted, emoji) {
  const r = key.relay || {};
  const table = sheetTable_(ss, RELAY_TAB_, RELAY_COLUMNS_, 'key', RELAY_READ_ROWS_);
  const patch = posted ? { status: 'sent', burson_message: posted.name, burson_thread: posted.thread } : { status: 'sent' };
  const row = r.rk ? table.load().find(x => String(x.key) === String(r.rk)) : null;
  if (row) {
    table.update(row, patch);
    return;
  }
  table.append(Object.assign({ when: new Date().toISOString(), direction: RELAY_TO_, what: r.what || (posted ? 'message' : 'emoji'),
    who: r.who || '', user: r.user || '', text: posted ? '' : emoji, test_message: r.tm || '', test_thread: posted ? r.tt || '' : '',
    key: 'sent:' + (r.rk || key.k) }, posted ? patch : { status: 'sent', burson_message: key.message }));
}

/**
 * The S-F Burson thread (in `sfbId`: this run's, Control tab B25) for a queued reply whose Mirror thread (relay.pt)
 * started with an analyst's message that was itself queued: '' until that message has been sent from the outbox.
 */
function relayLiveThreadOf_(ss, relay, sfbId) {
  if (!relay || !relay.pt || !relay.m || !ss.getSheetByName(RELAY_TAB_)) return '';
  const table = sheetTable_(ss, RELAY_TAB_, RELAY_COLUMNS_, 'key', RELAY_READ_ROWS_);
  const st = relayRows_(table, relay.m);
  const live = st.testThreadToLive.get(String(relay.pt)) ||
    relayOlderThread_(ss.getSheetByName(RELAY_TAB_), table.header, relay.m, 'test_thread', String(relay.pt));
  return live && sfbId && String(live).indexOf(sfbId + '/threads/') === 0 ? String(live) : '';
}

/**
 * Runs `one` over `msgs` (oldest first) from cursor c[dir] until `until` or the per-run cap. one(m) returns '' (nothing
 * to do), 'later' (next run: the cursor stays before it) or what it did. A message that throws is tried again next run
 * (the cursor stays before it and this pass stops there); after RELAY_MAX_TRIES_ runs, gaveUp(m, error) says so and the
 * relay moves on (or it returns 'later': tried again next run). `strict` (S-F Burson copied in its own order:
 * relayInbound_, TestCopy.gs): a message that isn't done yet ('later') stops the pass there too, so nothing after it goes
 * before it. Returns {done: {what: count}, error, stuck (the message whose failure stopped the pass, or null)}.
 */
function relayPass_(ctx, c, dir, msgs, until, one, gaveUp, strict) {
  const done = {};
  let n = 0;
  let hold = Infinity;
  let last = c[dir];
  let error = '';
  let stuck = null;
  for (const m of msgs) {
    if (ctx.now() > until || n >= RELAY_MAX_PER_RUN_) { hold = Math.min(hold, m.createTime); break; }
    let r = '';
    try {
      r = one(m);
      delete c.tries[m.name];
    } catch (e) {
      error = String((e && e.message) || e);
      const tries = (c.tries[m.name] || 0) + 1;
      if (tries < RELAY_MAX_TRIES_) {
        c.tries[m.name] = tries;
        hold = Math.min(hold, m.createTime);
        stuck = m;
        ctx.log(`relay: ${m.name} didn't go (try ${tries} of ${RELAY_MAX_TRIES_}): ${error}`);
        break;
      }
      delete c.tries[m.name];
      r = gaveUp(m, error);
      if (r === 'later' && strict) stuck = m;
    }
    if (r === 'later') {
      hold = Math.min(hold, m.createTime);
      if (strict) break;
    } else if (r) {
      done[r] = (done[r] || 0) + 1;
      n++;
    }
    last = Math.max(last, m.createTime);
  }
  c[dir] = hold < Infinity ? Math.max(c[dir], Math.min(last, hold - 1)) : last;
  return { done, error, stuck };
}

/** Pairs a live Zapier alert with its Mirror-space copy on the Relay tab (once). */
function relayPair_(rs, live, copy, status) {
  const key = 'alert:' + live.name;
  if (!copy || !copy.name || rs.keys.has(key)) return;
  rs.add({ direction: RELAY_FROM_, what: 'alert', who: 'Zapier', text: truncate_(String(copy.text || live.text || '').split('\n')[0], 120),
    status, burson_message: live.name, burson_thread: live.thread, test_message: copy.name, test_thread: copy.thread, key });
}

// ---------------------------------------------------------------------------------------------------------------
// From S-F Burson into the Mirror space
// ---------------------------------------------------------------------------------------------------------------

/**
 * One inbound pass (before the bot reads the Mirror space, until `until`): S-F Burson's new messages come into the Mirror
 * space in S-F Burson's own order (relayInOne_): Zapier's alerts (the Mirror's exact copies: Main.gs puts the Mirror's
 * own copying off while the relay runs) and everyone's replies and messages. One that can't go yet holds the rest behind
 * it (relayPass_, strict). Alerts the Mirror copied this run (`copies`, when it did) are paired on the Relay tab first.
 * Returns {in, alerts, failed, error, alertError (an alert that didn't go holds the rest: Main.gs fails the run then, as
 * when the Mirror's own copying fails)}.
 */
function relayInbound_(ctx, rs, copies, until) {
  const mirrorId = ctx.spaces.burson.id;
  (copies || []).forEach(cp => relayPair_(rs, cp.live, cp.copy, 'copied'));
  const c = relayCursors_(mirrorId, ctx.now(), relaySfb_(ctx), relayCopyId_(ctx));
  if (c.fresh) relayStarted_(ctx, c);
  rs.floorIn = Number(c.floor.in) || 0;
  const msgs = chatListMessages_(relaySfb_(ctx), relaySince_(c, 'in'), LIST_LIMIT_).sort((a, b) => a.createTime - b.createTime);
  let res = { done: {}, error: '', stuck: null };
  try {
    res = relayPass_(ctx, c, 'in', msgs, until, m => relayInOne_(ctx, rs, mirrorId, m), (m, error) => relayInFailed_(ctx, rs, m, error), true);
  } finally {
    saveRelayCursors_(c);
  }
  const alertError = res.stuck && !res.stuck.threadReply && isZapierMirrorCandidate_(res.stuck, ctx.botUser) ? res.error : '';
  return { in: res.done.in || 0, alerts: res.done.alert || 0, failed: res.done.failed || 0, error: res.error, alertError };
}

/**
 * Brings one S-F Burson message into the Mirror space: Zapier's alert as the Mirror's exact copy (relayAlertIn_),
 * anyone's reply or message as "Name (Burson): text" ("Name (Google): text", or the name alone while the Relay names tab
 * doesn't say: relayWho_). Never the bot's own work (relayBotsOwn_), nor another app's reply. Returns 'alert', 'in' or ''
 * (nothing to bring, or brought already).
 */
function relayInOne_(ctx, rs, mirrorId, m) {
  if (!m || !m.name || relayBotsOwn_(ctx, m)) return '';  // the bot's: from the outbox, its own
  if (!m.threadReply && isZapierMirrorCandidate_(m, ctx.botUser)) return relayAlertIn_(ctx, rs, mirrorId, m);
  if (m.senderType === 'BOT') return '';  // another app's reply
  const key = 'in:' + m.name;
  if (rs.keys.has(key)) return '';
  const body = relayBody_(m, 'S-F Burson');
  if (!body) return '';
  const what = m.threadReply ? 'reply' : 'message';
  const p = relayPerson_(rs, m, 'burson');  // their name (and org) from the Relay names tab: someone new gets a row there
  const who = relayWho_(p);
  const thread = m.threadReply ? relayTestThreadFor_(ctx, rs, mirrorId, m) : null;
  const lead = m.threadReply && !thread ? `${who}, replying in a thread the Mirror space doesn't have: ` : `${who}: `;
  const posted = relayPostIn_(mirrorId, lead + body, thread, 'rel-in:' + m.name);
  rememberRelayed_(posted.name, { who: p.name, text: body, mentions: m.mentions || [] });
  rs.add({ direction: RELAY_FROM_, what, who, user: m.senderName, text: body, status: 'sent', burson_message: m.name,
    burson_thread: m.thread, test_message: posted.name, test_thread: posted.thread, key });
  ctx.log(`relay: ${who}'s ${what} came over from S-F Burson`);
  return 'in';
}

/**
 * Zapier's alert, into the Mirror space in its place among S-F Burson's messages: the Mirror's own exact copy (Mirror.gs
 * mirrorCopyAlert_: the same text, id and bookkeeping, so the bot works it as before), paired on the Relay tab. 'alert',
 * or '' when it's there and paired already (or there's nothing to copy).
 */
function relayAlertIn_(ctx, rs, mirrorId, m) {
  if (rs.keys.has('alert:' + m.name)) return '';
  const copy = mirrorCopyAlert_(relaySfb_(ctx), mirrorId, m);
  if (!copy) return '';
  relayPair_(rs, m, copy, 'copied');
  ctx.log(`relay: an alert copied in its place (${m.name})`);
  return 'alert';
}

/**
 * The Mirror-space thread for an S-F Burson reply `m`: from the Relay tab; else the thread's first message: Zapier's
 * alert (its copy, found by the copy's own id; the relay copies the alerts in order, so one with no copy here is from
 * before it started) or someone's message since the relay started (brought over now, so its replies follow it). Null
 * when there's none (the reply then comes over as a message of its own, saying so).
 */
function relayTestThreadFor_(ctx, rs, mirrorId, m) {
  if (rs.liveThreadToTest.has(m.thread)) return rs.liveThreadToTest.get(m.thread);
  const older = rs.olderThread ? rs.olderThread('burson_thread', m.thread) : '';
  if (older) return older;
  const root = chatThreadRoot_(relaySfb_(ctx), m.thread);
  // none, or the thread's first message is gone (deleted: Chat lists a reply first)
  if (!root || root.threadReply || root.name === m.name) return null;
  if (rs.liveToTest.has(root.name)) return rs.liveThreadToTest.get(root.thread) || null;
  if (root.senderType === 'BOT' || isZapierMirrorCandidate_(root, ctx.botUser)) {
    const copy = mirrorCopyOf_(mirrorId, root.name);
    if (!copy) return null;
    relayPair_(rs, root, copy, 'paired');
    return copy.thread;
  }
  // someone's message since the relay started: brought over now, so its replies follow it
  if (root.createTime >= (rs.floorIn || 0) && relayInOne_(ctx, rs, mirrorId, root) === 'in') {
    return rs.liveThreadToTest.get(root.thread) || null;
  }
  return null;
}

/**
 * A message from S-F Burson that kept failing: a row, and a note in the Mirror space. Returns 'failed'. Zapier's alert is
 * tried again every run instead ('later': what came after it waits behind it), as the Mirror's own pass tries it, for as
 * long as that pass would still read it (MIRROR_MAX_GAP_MS_); only then is it given up on, with its row and note.
 */
function relayInFailed_(ctx, rs, m, error) {
  const why = truncate_(error, 160);
  const alert = !m.threadReply && isZapierMirrorCandidate_(m, ctx.botUser);
  if (alert && ctx.now() - m.createTime < MIRROR_MAX_GAP_MS_) return 'later';
  rs.add({ direction: RELAY_FROM_, what: alert ? 'alert' : m.threadReply ? 'reply' : 'message', who: alert ? 'Zapier' : '',
    user: m.senderName, text: alert ? truncate_(zapierMirrorText_(m).split('\n')[0], 120) : relayBody_(m, 'S-F Burson'),
    status: `not brought over: ${why}`, burson_message: m.name, burson_thread: m.thread, key: (alert ? 'alert:' : 'in:') + m.name });
  try {
    ctx.chat.post(ctx.spaces.burson.id, `${alert ? 'An alert' : 'A message'} from S-F Burson couldn't be brought ` +
      `over (${why}). It's still in S-F Burson, and on the Relay tab.`, { key: 'relay-failed:' + m.name });
  } catch (e) {
    ctx.log(`relay: couldn't say ${m.name} didn't come over: ${(e && e.message) || e}`);
  }
  return 'failed';
}

/**
 * The copy in `mirrorId` (the Mirror space, or the Burson test copy) of live Zapier alert `liveName`, or null when
 * there's none: the pair Mirror.gs kept when it copied it (rememberMirrorPair_), else the copy with the id Mirror.gs gave
 * it (the bot's own record of that id, Chat.gs botPostNamed_, whether or not Chat took custom ids; else Chat's custom
 * id). Chat answers a read of a message that isn't there with 403 ("permission denied … or the resource doesn't exist")
 * as well as 404: both mean no copy (a space the bot can't reach fails when it posts there).
 */
function mirrorCopyOf_(mirrorId, liveName) {
  const read = path => {
    const r = chatCall_('get', path);
    if (r.code === 404 || r.code === 403) return null;
    if (r.code >= 300) throw chatError_(r, 'reading the copy of ' + liveName);
    return normalizeMessage_(r.body);
  };
  let kept = null;
  try { kept = JSON.parse(CacheService.getScriptCache().get(mirrorCopyKey_(mirrorId, liveName)) || 'null'); } catch (e) { kept = null; }
  if (kept && kept.name && String(kept.name).indexOf(mirrorId + '/') === 0) {
    const got = read(kept.name);  // still there: a copy someone deleted is none
    if (got) return got;
  }
  const id = MIRROR_CLIENT_ID_PREFIX_ + sha256Hex_(mirrorId + '|zmir:' + liveName).slice(0, 40);
  const named = botPostNamed_(id);
  if (named && named.indexOf(mirrorId + '/') === 0) {
    const got = read(named);
    if (got) return got;
  }
  if (clientIdsOff_()) return null;  // Chat took no custom ids: there's none to read it by
  return read(mirrorId + '/messages/' + id);
}

/**
 * The live Zapier alert behind a Mirror-space copy (`copy`: normalized), or null: the pair Mirror.gs kept when it copied
 * it (rememberMirrorPair_: 'zmlive:' for 6 hours, also when there's none: a Direct BigQuery post); else, from the copy's
 * id (Chat's, or the bot's own record of it: Chat.gs normalizeMessage_), a hash of the live alert's name (Mirror.gs
 * mirrorPostMessage_): the live messages (in S-F Burson `sfbId`: this run's, Control tab B25) from the 6 hours before it
 * are hashed and compared, and the answer is kept the same way. One from another S-F Burson space (B25 changed since)
 * is none.
 */
function liveForCopy_(mirrorId, copy, sfbId) {
  if (!sfbId || !copy || !copy.name) return null;
  const inSfb = live => (live && String(live.name || '').indexOf(sfbId + '/') === 0 ? live : null);
  const cache = CacheService.getScriptCache();
  const cacheKey = 'zmlive:' + copy.name;
  const hit = cache.get(cacheKey);
  if (hit) return hit === '-' ? null : inSfb(JSON.parse(hit));
  const id = String(copy.clientId || '');
  if (id.indexOf(MIRROR_CLIENT_ID_PREFIX_) !== 0) return null;
  const want = id.slice(MIRROR_CLIENT_ID_PREFIX_.length);
  const at = Number(copy.createTime) || Date.now();
  const msgs = chatListMessages_(sfbId, new Date(at - 6 * 3600 * 1000).toISOString(), LIST_LIMIT_, false,
    { until: new Date(at + 60 * 1000).toISOString() });
  const found = msgs.find(m => !m.threadReply && sha256Hex_(mirrorId + '|zmir:' + m.name).slice(0, 40) === want);
  const live = found ? { name: found.name, thread: found.thread, text: truncate_(String(found.text || ''), 200) } : null;
  cache.put(cacheKey, live ? JSON.stringify(live) : '-', 21600);
  return live;
}

/**
 * The live S-F Burson message behind Mirror-space message `copy` (normalized; `mirrorId`: the Mirror space): this flow's
 * Alert log first, which keeps the pair for good once the bot took the alert (live_message, live_thread: Bot.gs
 * handleAlert_), so an emoji or a reply days later still finds it; else liveForCopy_. {name, thread} or null; only one in
 * this run's S-F Burson (`sfbId`).
 */
function liveBehindCopy_(ctx, mirrorId, copy, sfbId) {
  if (!sfbId || !copy || !copy.name) return null;
  const row = alertRowForCopy_(ctx, copy.name, false);
  if (row && String(row.live_message || '').indexOf(sfbId + '/') === 0) {
    return { name: String(row.live_message), thread: String(row.live_thread || '') };
  }
  return liveForCopy_(mirrorId, copy, sfbId);
}

/**
 * This flow's Alert-log row for a Mirror-space message (or, `isThread`, its thread) that holds the live pair
 * (live_message), or null. Never throws (an Alert log that can't be read is no row).
 */
function alertRowForCopy_(ctx, name, isThread) {
  try {
    if (!ctx || !name || !ctx.store) return null;
    const rows = (ctx.store.alerts || []).filter(a => a && a.live_message && (isThread ? a.source_thread === name : a.source_message === name));
    return rows.length ? rows[rows.length - 1] : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// From the Mirror space towards S-F Burson: rows on the Burson outbox (Outbox.gs), never a write there; or, with a
// Burson test copy (B26), straight to that test copy instead (TestCopy.gs), still never to S-F Burson
// ---------------------------------------------------------------------------------------------------------------

/**
 * One outbound pass (until `until`): the analysts' new replies and messages go on the Burson outbox, or straight to the
 * Burson test copy while B26 is usable, only ones written before `before` (when this run read the switches as ON:
 * anything later waits for the next run's read). With the analysts' side off (Post in S-F Burson OFF with B26 blank, or
 * B26 set but failing its checks) nothing is read, queued or sent, and the analysts' side starts again from now (nothing
 * written meanwhile ever goes). Returns {queued, sent (to the test copy), held, error} ({…, off: true} while it's off).
 */
function relayOutbound_(ctx, rs, until, before) {
  const mirrorId = ctx.spaces.burson.id;
  const c = relayCursors_(mirrorId, ctx.now(), relaySfb_(ctx), relayCopyId_(ctx));
  if (!relayOutOn_(ctx)) {
    const now = ctx.now();
    c.out = now;
    c.floor.out = now;
    c.outFrom = now;
    saveRelayCursors_(c);
    return { queued: 0, sent: 0, held: 0, off: true, error: '' };
  }
  if (relayCopyId_(ctx) && !rs.copy) throw new Error('the Test copy tab couldn\'t be read (tried again next run)');
  const msgs = chatListMessages_(mirrorId, relaySince_(c, 'out'), LIST_LIMIT_, false, { until: new Date(before).toISOString() })
    .sort((a, b) => a.createTime - b.createTime);
  let res = { done: {}, error: '' };
  try {
    res = relayPass_(ctx, c, 'out', msgs, until, m => relayOutOne_(ctx, rs, m),
      (m, error) => relayHold_(ctx, rs, m, `it couldn't be ${relayCopyId_(ctx) ? 'sent' : 'queued'} (${truncate_(error, 120)}). Post it again to try again.`));
  } finally {
    saveRelayCursors_(c);
  }
  return { queued: res.done.queued || 0, sent: res.done.sent || 0, held: res.done.held || 0, error: res.error };
}

/**
 * True when a Mirror-space message is an analyst's: a person writing, not the bot. Never a message the bot posted
 * (Chat.gs botPosted_: whatever account it ran as), nor one with one of the bot's ids or its own formatted note, so the bot's work never
 * goes out. The person whose account the bot runs as (B8) counts too, for what they type themselves: never an alert they
 * paste there for the bot to review (as Zapier's), and nothing from that account while Chat refuses the bot's own ids
 * (Chat.gs clientIdsOff_: its posts couldn't be told apart then). Never a temp check request (TempCheck.gs, while Temp
 * checks, row 36, is ON): that's for the bot, answered in the Mirror space's thread.
 */
function relayAnalyst_(ctx, m) {
  if (!m || m.senderType !== 'HUMAN' || !m.senderName || m.clientId) return false;
  if (String(m.text || '').trim().indexOf(GEN.prefix) === 0 || botPosted_(m.name)) return false;
  if (typeof tempCheckRequestOf_ === 'function' && tempCheckRequestOf_(ctx, m)) return false;
  if (ctx && ctx.botUser && m.senderName === ctx.botUser) {
    if (clientIdsOff_()) return false;
    if (typeof isBotFormattedText_ === 'function' && isBotFormattedText_(m.text)) return false;
    const text = String(m.text || '').trim();
    if (!m.threadReply && text && detectAlert_(text, parseAlert_(text), String(m.senderDisplay || ''))) return false;
    if (!m.threadReply && typeof pwAlertParse_ === 'function' && pwAlertParse_(text)) return false;  // a watch alert
    if (!m.threadReply && typeof edAlertPosted_ === 'function' && edAlertPosted_(m.name)) return false;  // an early-detection alert
  }
  return true;
}

/**
 * An analyst message that isn't sent: a row (it's never tried again), and the reason in its thread. `once`: one note per
 * thread (replies in a thread S-F Burson, or the Burson test copy, doesn't have). Returns 'held'.
 */
function relayHold_(ctx, rs, m, why, once) {
  const noted = once && rs.heldThreads.has(m.thread);
  rs.add({ direction: relayToward_(ctx), what: m.threadReply ? 'reply' : 'message', who: '', user: m.senderName, text: relayBody_(m, ''),
    status: once ? RELAY_THREAD_HELD_ : `not sent: ${why}`, test_message: m.name, test_thread: m.thread, key: 'out:' + m.name });
  if (noted) return 'held';
  try {
    ctx.chat.post(ctx.spaces.burson.id, `Not sent to ${relayWhere_(ctx)}: ${why}`,
      { thread: m.thread, key: once ? 'relay-held-thread:' + m.thread : 'relay-held:' + m.name });
  } catch (e) {
    ctx.log(`relay: couldn't say why ${m.name} wasn't sent: ${(e && e.message) || e}`);
  }
  return 'held';
}

/**
 * Queues one analyst message for S-F Burson on the Burson outbox (or, with a Burson test copy, sends it straight there:
 * relayToCopyOne_): 'queued' / 'sent', 'held' (it would show internal details, or its thread isn't one from S-F Burson:
 * the bot says so in its thread), 'later' (a switch went OFF: not now), or '' (not an analyst's, kept internal, done).
 */
function relayOutOne_(ctx, rs, m) {
  if (!relayAnalyst_(ctx, m)) return '';
  const key = 'out:' + m.name;
  if (rs.keys.has(key)) return '';
  if (m.threadReply && rs.internalThreads.has(m.thread)) return '';  // a reply under an analyst's "internal:" message
  if (m.threadReply && ctx.spaces.burson.id === campaignAlertsSpace_(ctx)) {
    if (isCampaignOwnedThread_(ctx, ctx.spaces.burson.id, m.thread)) return '';
    if (isCampaignHandoffRequest_(ctx, ctx.spaces.burson.id, m)) {
      handOffThreadToCampaigns_(ctx, ctx.spaces.burson.id, m);
      rs.add({ direction: relayToward_(ctx), what: 'reply', who: '', user: m.senderName, text: '', status: RELAY_KEPT_,
        test_message: m.name, test_thread: m.thread, key });
      return '';
    }
  }
  if (RELAY_INTERNAL_RX_.test(String(m.text || ''))) {
    if (!m.threadReply) {  // its replies stay here too
      rs.add({ direction: relayToward_(ctx), what: 'message', who: '', user: m.senderName, text: '', status: RELAY_KEPT_,
        test_message: m.name, test_thread: m.thread, key });
    }
    return '';
  }
  const body = relayBody_(m, '');  // what goes to S-F Burson (or the test copy) never names the Mirror space
  if (!body) return '';
  const p = relayPerson_(rs, m, 'mirror');
  const text = `${p.name}: ${body}`;
  const hits = outboxGuardHits_(text, rs.guard || guardFor_(ctx));
  if (hits.length) {
    return relayHold_(ctx, rs, m, `it mentions "${truncate_(hits[0], 60)}". Post it again without that, or start it with ` +
      '"internal:" to keep it here.');
  }
  if (relayCopyId_(ctx)) return relayToCopyOne_(ctx, rs, m, p, text, body, key);
  let liveThread = null;
  let pending = '';  // its thread's first message is an analyst's still on the outbox: the S-F Burson thread comes once that's sent
  if (m.threadReply) {
    // only a thread in this run's S-F Burson (B25): one paired with another S-F Burson space before B25 changed isn't
    const inSfb = t => (t && String(t).indexOf(relaySfb_(ctx) + '/threads/') === 0 ? t : null);
    liveThread = inSfb(rs.testThreadToLive.get(m.thread)) || inSfb(rs.olderThread ? rs.olderThread('test_thread', m.thread) : '') ||
      (rs.queuedThreads.has(m.thread) ? null : inSfb(relayLiveThreadFor_(ctx, rs, m)));
    if (!liveThread && rs.queuedThreads.has(m.thread)) pending = m.thread;
    if (!liveThread && !pending) {
      return relayHold_(ctx, rs, m, 'replies in this thread stay here: it isn\'t one from S-F Burson. Post a message of its ' +
        'own to send something.', true);
    }
  }
  const what = m.threadReply ? 'reply' : 'message';
  const queued = relayQueue_(ctx, {
    kind: m.threadReply ? 'reply' : 'post', text, thread: liveThread || '', key: 'rel-out:' + m.name, prefix: RELAY_OUT_PREFIX_,
    from: `relay: ${p.name}`, relay: { m: ctx.spaces.burson.id, tm: m.name, tt: m.thread, who: p.name, user: m.senderName, what, rk: key,
      pt: pending || undefined },
  });
  if (!queued) return 'later';
  rs.add({ direction: RELAY_TO_, what, who: p.name, user: m.senderName, text: body, status: RELAY_QUEUED_,
    test_message: m.name, test_thread: m.thread, key });
  ctx.log(`relay: ${p.name}'s ${what} is on the Burson outbox (it goes to S-F Burson once someone sets it to Send)`);
  return 'queued';
}

/**
 * With a Burson test copy (B26): one analyst message straight there, as "Name: text", where S-F Burson would get it: a
 * reply under the copy of the message it replies to, a message of its own as a message of its own. No outbox row, no
 * Send. A reply whose S-F Burson message isn't in the test copy (yet: it started later, or the copy is behind) waits a
 * little (RELAY_COPY_WAIT_MS_), then stays in the Mirror space with one note per thread. 'sent', 'held' or 'later'.
 */
function relayToCopyOne_(ctx, rs, m, p, text, body, key) {
  const what = m.threadReply ? 'reply' : 'message';
  let thread = null;
  if (m.threadReply) {
    const found = relayCopyThread_(ctx, rs, m);
    if (!found.thread) {
      if (found.live && ctx.now() - m.createTime < RELAY_COPY_WAIT_MS_) return 'later';  // its message may still be copied
      return relayHold_(ctx, rs, m, found.live
        ? 'replies in this thread stay here: the Burson test copy doesn\'t have its first message (it\'s from before the ' +
          'test copy started). Post a message of its own to send something.'
        : 'replies in this thread stay here: it isn\'t one from S-F Burson. Post a message of its own to send something.', true);
    }
    thread = found.thread;
  }
  if (ctx.relayCanQueue && !ctx.relayCanQueue()) return 'later';  // the relay, the bot or B26 changed during this run
  const posted = testCopyPost_(relayCopyId_(ctx), text, thread, 'rel-out:' + m.name, RELAY_OUT_PREFIX_);
  rs.add({ direction: RELAY_TO_COPY_, what, who: p.name, user: m.senderName, text: body, status: 'sent', test_message: m.name,
    test_thread: m.thread, copy_message: posted.name, copy_thread: posted.thread, key });
  ctx.log(`relay: ${p.name}'s ${what} went straight to the Burson test copy`);
  return 'sent';
}

/**
 * Where a reply in Mirror thread m.thread goes in the Burson test copy: {thread: the test copy's thread ('' when there's
 * none), live: the S-F Burson thread behind it ('' when the Mirror thread isn't one from S-F Burson)}. An analyst's own
 * message that went to the test copy is found on the Relay tab; else the S-F Burson thread (as for the outbox), then its
 * copy on the Test copy tab (rs.copy: TestCopy.gs testCopyState_).
 */
function relayCopyThread_(ctx, rs, m) {
  const own = rs.mirrorThreadToCopy.get(m.thread) || (rs.olderCopyThread ? rs.olderCopyThread(m.thread) : '');
  if (own) return { thread: own, live: '' };
  const inSfb = t => (t && String(t).indexOf(relaySfb_(ctx) + '/threads/') === 0 ? String(t) : '');
  const live = inSfb(rs.testThreadToLive.get(m.thread)) || inSfb(rs.olderThread ? rs.olderThread('test_thread', m.thread) : '') ||
    inSfb(relayLiveThreadFor_(ctx, rs, m));
  if (!live) return { thread: '', live: '' };
  return { thread: rs.copy.liveThreadToCopy.get(live) || rs.copy.olderThread(live) || '', live };
}

/**
 * What an analyst's message names that Burson must not see, beyond the bot's own guard (guardHits_): the test space
 * by any name, or a space's id. ['mirror space', …].
 */
function relayGuardHits_(text) {
  const hits = [];
  [/\b(?:mirror|test|testing|training|pilot)\s+(?:space|chat|room|channel)s?\b/i, /\bspaces\/[A-Za-z0-9_-]{6,}/].forEach(re => {
    const m = String(text || '').match(re);
    if (m) hits.push(m[0]);
  });
  return hits;
}

/**
 * The bot's guard for what goes to S-F Burson (guardFor_), plus the analyst space (B4), the Mirror space (B9), the
 * auto-correct space (B10), the Burson test copy (B26) and the Other alerts space (B33): in the Mirror space the bot's
 * own guard only knows the Mirror space.
 */
function relayGuard_(ctx, wanted) {
  const guard = guardFor_(ctx);
  const props = PropertiesService.getScriptProperties();
  const terms = [props.getProperty('LAST_ANALYST_NAME'), String(props.getProperty('LAST_ANALYST_SPACE') || '').replace(/^spaces\//, ''),
    props.getProperty('LAST_OS_NAME')];
  [wanted && wanted.analyst, wanted && wanted.mirror, wanted && wanted.autocorrect, wanted && wanted.testCopy,
    wanted && wanted.otherSpace].forEach(v => {
    if (!v) return;
    const ref = parseSpaceRef_(v, '');
    terms.push(ref.id ? ref.id.replace(/^spaces\//, '') : ref.name);
  });
  return Object.assign({}, guard, { terms: (guard.terms || []).concat(terms.filter(t => t && String(t).length > 3)) });
}

/** The S-F Burson thread for a reply under a Mirror-space alert copy the Relay tab hasn't paired yet, or null. */
function relayLiveThreadFor_(ctx, rs, m) {
  const mirrorId = ctx.spaces.burson.id;
  const row = alertRowForCopy_(ctx, m.thread, true);  // the Alert log's pair, kept for good (no read of the thread)
  if (row && row.live_thread && String(row.live_message || '').indexOf(relaySfb_(ctx) + '/') === 0) {
    relayPair_(rs, { name: String(row.live_message), thread: String(row.live_thread) },
      { name: row.source_message, thread: row.source_thread }, 'paired');
    return String(row.live_thread);
  }
  const root = chatThreadRoot_(mirrorId, m.thread);
  if (!root) return null;
  const live = liveBehindCopy_(ctx, mirrorId, root, relaySfb_(ctx));
  if (!live) return null;
  relayPair_(rs, live, root, 'paired');
  return live.thread || null;
}

// ---------------------------------------------------------------------------------------------------------------
// Emojis, both ways
// ---------------------------------------------------------------------------------------------------------------

/**
 * Both emoji passes (until `until`): everyone's emojis in S-F Burson onto the Mirror space, then (with the analysts'
 * side on: relayOutOn_) the analysts' onto the Burson outbox, or straight onto the Burson test copy. Only on messages
 * posted since the relay started (an older message's emojis may be from before then; for the analysts', since their side
 * last started), and only a message whose emojis changed since the last pass, for the emojis that went up. Returns {in,
 * out, error}.
 */
function relayEmojis_(ctx, rs, until) {
  const c = relayCursors_(ctx.spaces.burson.id, ctx.now(), relaySfb_(ctx), relayCopyId_(ctx));
  const res = relayEmojiPass_(ctx, rs, 'in', until, c);
  const out = { in: res.n, out: 0, error: res.error };
  if (ctx.now() < until && relayOutOn_(ctx)) {
    const res2 = relayEmojiPass_(ctx, rs, 'out', until, c);
    out.out = res2.n;
    out.error = out.error || res2.error;
  }
  return out;
}

/** One message's emojis, as Chat sums them: "😀=2|👍=1". */
function emojiSum_(m) {
  return (m.reactions || []).map(r => `${bareEmoji_(r.emoji)}=${r.count}`).sort().join('|');
}

/** The emojis whose count went up from summary `before` to `after` (emojiSum_): a Set. */
function emojisUp_(before, after) {
  const counts = s => new Map(String(s || '').split('|').filter(Boolean).map(x => {
    const i = x.lastIndexOf('=');
    return [x.slice(0, i), Number(x.slice(i + 1)) || 0];
  }));
  const was = counts(before);
  const up = new Set();
  counts(after).forEach((n, e) => { if (n > (was.get(e) || 0)) up.add(e); });
  return up;
}

/**
 * One emoji pass ('in': S-F Burson's messages, 'out': the Mirror space's), on messages since the relay started
 * (c.epoch; 'out': since its side last started, c.outFrom). A message whose other side isn't there yet is looked at again
 * next pass; one that keeps failing is given up on after RELAY_MAX_TRIES_ passes, with a row. The emojis of the account
 * the bot runs as (B8) count as an analyst's ('out') only when they're new since the last pass and the bot's own emojis
 * are known (Chat.gs botMarksKnown_): never on a pass that starts over, when every emoji looks new. Returns {n: emojis
 * relayed, queued or sent, error}.
 */
function relayEmojiPass_(ctx, rs, dir, until, c) {
  const mirrorId = ctx.spaces.burson.id;
  const epoch = dir === 'out' ? Math.max(Number(c.epoch) || 0, Number(c.outFrom) || 0) : Number(c.epoch) || 0;
  const space = dir === 'in' ? relaySfb_(ctx) : mirrorId;
  const since = new Date(Math.max(ctx.now() - RELAY_EMOJI_DAYS_ * DAY_MS_, epoch)).toISOString();
  const msgs = chatListMessages_(space, since, LIST_LIMIT_, true, { fields: RELAY_LIST_FIELDS_ })
    .filter(m => (m.reactions || []).length && m.createTime >= epoch);
  const cache = CacheService.getScriptCache();
  let saved = null;
  try { saved = JSON.parse(cache.get(RELAY_SUMS_CACHE_ + dir) || 'null'); } catch (e) { saved = null; }
  const fresh = !saved || saved.space !== mirrorId || saved.epoch !== epoch;
  if (fresh) saved = { sums: {}, tries: {} };  // keys keep it once
  const own = !fresh && botMarksKnown_('r');
  const sums = saved.sums || {};
  const tries = saved.tries || {};
  let n = 0;
  let error = '';
  for (const m of msgs) {
    const sum = emojiSum_(m);
    if (sums[m.name] === sum) continue;
    if (ctx.now() > until) break;
    const up = emojisUp_(sums[m.name], sum);
    try {
      const done = up.size ? (dir === 'in' ? relayEmojisIn_(ctx, rs, m, up) : relayEmojisOut_(ctx, rs, m, up, own)) : 0;
      if (done === null && ctx.now() - m.createTime < RELAY_PAIR_WAIT_MS_) continue;  // no match yet: next pass
      n += done || 0;
      sums[m.name] = sum;
      delete tries[m.name];
    } catch (e) {
      error = String((e && e.message) || e);
      tries[m.name] = (tries[m.name] || 0) + 1;
      ctx.log(`relay: the emojis on ${m.name} didn't go (try ${tries[m.name]} of ${RELAY_MAX_TRIES_}): ${error}`);
      if (tries[m.name] >= RELAY_MAX_TRIES_) {
        rs.add({ direction: dir === 'in' ? RELAY_FROM_ : relayToward_(ctx), what: 'emoji', who: '', text: Array.from(up).join(' '),
          status: `not sent: ${truncate_(error, 160)}`, [dir === 'in' ? 'burson_message' : 'test_message']: m.name,
          key: `emoji-failed:${m.name}|${sum}` });
        sums[m.name] = sum;
        delete tries[m.name];
      }
    }
  }
  const keep = { space: mirrorId, epoch, sums: {}, tries: {} };
  msgs.forEach(m => {
    if (sums[m.name] !== undefined) keep.sums[m.name] = sums[m.name];
    if (tries[m.name]) keep.tries[m.name] = tries[m.name];
  });
  try {
    cache.put(RELAY_SUMS_CACHE_ + dir, JSON.stringify(keep), 21600);
  } catch (e) {
    console.error('relay: couldn\'t keep the emoji notes: ' + ((e && e.message) || e));
  }
  return { n, error };
}

/**
 * New emojis (`up`) on S-F Burson message `m`: the same emoji on its Mirror-space match, for each one added, whoever
 * added it (as anyone in S-F Burson sees it), never one the bot itself added. Returns how many went, or null when it has
 * no match yet.
 */
function relayEmojisIn_(ctx, rs, m, up) {
  const mirrorId = ctx.spaces.burson.id;
  let test = rs.liveToTest.get(m.name);
  if (!test && !m.threadReply && (m.senderType === 'BOT' || isZapierMirrorCandidate_(m, ctx.botUser))) {
    const copy = mirrorCopyOf_(mirrorId, m.name);  // an alert copied before the relay was on
    if (copy) {
      relayPair_(rs, m, copy, 'paired');
      test = copy.name;
    }
  }
  if (!test) return null;
  let n = 0;
  chatListReactions_(m.name).filter(r => r.user && up.has(bareEmoji_(r.emoji)) && !botReacted_(m.name, r.emoji))
    .forEach(r => {
      const key = `in-emoji:${m.name}|${r.user}|${bareEmoji_(r.emoji)}`;
      if (rs.keys.has(key)) return;
      const p = relayPerson_(rs, { senderName: r.user, senderDisplay: r.userDisplay }, 'burson');
      relayNoteAdded_(mirrorId, test, r.emoji);  // first: the bot never takes it for an analyst's
      ctx.chat.react(test, r.emoji);  // the Mirror space only (guardedChat_)
      rs.add({ direction: RELAY_FROM_, what: 'emoji', who: relayWho_(p), user: r.user, text: r.emoji, status: 'sent',
        burson_message: m.name, test_message: test, key });
      n++;
    });
  return n;
}

/**
 * The analysts' new emojis (`up`) on Mirror-space message `m`: the same emoji, for its S-F Burson match, on the Burson
 * outbox (with a Burson test copy: straight onto the match's copy there, relayEmojisToCopy_). Never one the bot itself
 * added (Chat.gs botReacted_: whatever account it ran as), nor a never_mirror one; the account the bot runs as only with
 * `own` (relayEmojiPass_). Returns how many were queued (or sent), or null when it has no match yet (or a switch just went
 * OFF: looked at again later).
 */
function relayEmojisOut_(ctx, rs, m, up, own) {
  if (relayCopyId_(ctx)) return relayEmojisToCopy_(ctx, rs, m, up, own);
  let live = rs.testToLive.get(m.name);
  if (live && String(live).indexOf(relaySfb_(ctx) + '/messages/') !== 0) live = null;  // paired before B25 changed
  if (!live) {  // an alert copied before the relay paired it
    const found = liveBehindCopy_(ctx, ctx.spaces.burson.id, m, relaySfb_(ctx));
    if (found) {
      relayPair_(rs, found, m, 'paired');
      live = found.name;
    }
  }
  if (!live) return null;
  const byEmoji = relayEmojisByAnalyst_(ctx, m, up, own);
  let n = 0;
  let later = false;
  byEmoji.forEach((x, e) => {
    const key = `out-emoji:${m.name}|${e}`;
    if (later || rs.keys.has(key)) return;
    const who = x.users.map(r => relayPerson_(rs, { senderName: r.user, senderDisplay: r.userDisplay }, 'mirror').name).join(', ');
    const queued = relayQueue_(ctx, { kind: 'reaction', message: live, emoji: x.emoji, from: `relay: ${who}`,
      relay: { m: ctx.spaces.burson.id, tm: m.name, who, user: x.users.map(r => r.user).join(' '), what: 'emoji', rk: key } });
    if (!queued) { later = true; return; }
    rs.add({ direction: RELAY_TO_, what: 'emoji', who, user: x.users.map(r => r.user).join(' '), text: x.emoji, status: RELAY_QUEUED_,
      burson_message: live, test_message: m.name, key });
    n++;
  });
  return later ? null : n;
}

/**
 * The analysts' new emojis (`up`) on Mirror-space message `m`, by emoji: Map bare emoji -> {emoji, users}. Never 👎, never
 * one the bot added itself (Chat.gs botReacted_); one by the account the bot runs as (B8) only with `own` (its own emojis
 * can be told apart this pass: relayEmojiPass_).
 */
function relayEmojisByAnalyst_(ctx, m, up, own) {
  const never = new Set(ctx.settings.never_mirror || []);
  const byEmoji = new Map();
  chatListReactions_(m.name).filter(r => r.user && up.has(bareEmoji_(r.emoji)) && !botReacted_(m.name, r.emoji) &&
    (own || r.user !== ctx.botUser))
    .forEach(r => {
      const entry = legendByEmoji_(r.emoji);
      if (entry && never.has(entry.code)) return;  // e.g. 👎 "the bot got this wrong": never shown to Burson
      const e = bareEmoji_(r.emoji);
      if (!byEmoji.has(e)) byEmoji.set(e, { emoji: r.emoji, users: [] });
      byEmoji.get(e).users.push(r);
    });
  return byEmoji;
}

/**
 * With a Burson test copy (B26): the analysts' new emojis on Mirror-space message `m` go straight onto the matching
 * message there (the copy of its S-F Burson message, or the copy of an analyst's own message), once each, shown as the
 * bot's account; the account the bot runs as only with `own` (relayEmojiPass_). No outbox. Returns how many went, or
 * null when the match isn't in the test copy (yet), or the relay, the bot or B26 changed during this run.
 */
function relayEmojisToCopy_(ctx, rs, m, up, own) {
  if (!rs.copy) return null;  // the Test copy tab couldn't be read this run: looked at again next pass
  let target = rs.mirrorToCopy.get(m.name) || '';  // an analyst's own message that went to the test copy
  if (!target) {
    let live = rs.testToLive.get(m.name);
    if (live && String(live).indexOf(relaySfb_(ctx) + '/messages/') !== 0) live = null;  // paired before B25 changed
    if (!live) {  // an alert copied before the relay paired it
      const found = liveBehindCopy_(ctx, ctx.spaces.burson.id, m, relaySfb_(ctx));
      if (found) {
        relayPair_(rs, found, m, 'paired');
        live = found.name;
      }
    }
    target = live ? rs.copy.liveToCopy.get(live) || '' : '';
  }
  if (!target) return null;
  const byEmoji = relayEmojisByAnalyst_(ctx, m, up, own);
  let n = 0;
  let later = false;
  byEmoji.forEach((x, e) => {
    const key = `out-emoji:${m.name}|${e}`;
    if (later || rs.keys.has(key)) return;
    if (ctx.relayCanQueue && !ctx.relayCanQueue()) { later = true; return; }
    const who = x.users.map(r => relayPerson_(rs, { senderName: r.user, senderDisplay: r.userDisplay }, 'mirror').name).join(', ');
    testCopyReact_(relayCopyId_(ctx), target, x.emoji);
    rs.add({ direction: RELAY_TO_COPY_, what: 'emoji', who, user: x.users.map(r => r.user).join(' '), text: x.emoji, status: 'sent',
      test_message: m.name, copy_message: target, key });
    n++;
  });
  return later ? null : n;
}
