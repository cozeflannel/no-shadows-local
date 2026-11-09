/**
 * TestCopy.gs — "Burson test copy", the Control tab's B26: practising the Relay (row 22, Relay.gs) as close to live as
 * it gets, with nothing ever reaching S-F Burson (the Control tab's B25). B26 names a Google-only space nobody works in.
 * While B26 passes its checks (testCopyFor_), S-F Burson is known, the bot is ON and it isn't a dry run, every run, before
 * the Mirror and the Relay, with a few seconds of its own (testCopyRun_), whether or not the Relay is ON (so the copy
 * fills before the Relay is switched on):
 *
 *   From S-F Burson into the test copy, everything, as anyone in S-F Burson sees it, in S-F Burson's own order:
 *     Zapier's alert            an exact copy, top level (Mirror.gs's test and text, and its idempotent message id)
 *     a reply in a thread       under the copy of the message it replies to: "Name (Burson): text"
 *     a message of its own      a message of its own: "Name (Burson): text"
 *     an emoji                  the same emoji on the message's copy (it shows as the bot's account), once each
 *   everyone's: "(Google)" for someone the Relay names tab marks Google, and just the name while their row isn't marked
 *   (Relay.gs relayPerson_, relayWho_); nobody waits on that tab. One that can't be copied yet holds the rest behind it
 *   (relayPass_, strict), so nothing lands out of order; one that keeps failing is given up on after RELAY_MAX_TRIES_
 *   runs, with a row saying why. Never copied: the bot's own work (Relay.gs relayBotsOwn_), another app's thread replies,
 *   edits, deletions, removed emojis; a file is named in the text. Nothing is ever written in S-F Burson: it's only read.
 *
 *   The Relay's analysts' side, with the Relay ON (Relay.gs relayToCopyOne_ / relayEmojisToCopy_): straight here, never
 *   to S-F Burson and never through the Burson outbox. An analyst's reply goes under the matching message's copy, their
 *   own message as a message of its own, their emoji on the matching copy. While B26 is set nothing the Relay has is
 *   queued for, or sent to, S-F Burson (Outbox.gs holds back relay rows someone sets to Send meanwhile).
 *
 * It starts from the moment a run sees B26 set (nothing from before then is copied); another B26, or another S-F
 * Burson space, starts afresh, and B26 cleared stops it (set again, it starts again from then). Runs that don't get to it
 * (the bot paused, a run failing) are caught up on next time, for up to a day. Every item is a row on the bot's "Test
 * copy" tab with the pair (the S-F Burson message, its copy): how replies and emojis find their copy, and how nothing is
 * copied twice. Refused (✗ in C26: nothing is copied and the Relay's analysts' side waits): a space people outside Google
 * can join, S-F Burson itself, the same space as B3, B4, B9 or B10, or a space the bot can't open. Chat.gs refuses every
 * other write to the test copy, so the bot's own work never lands there.
 */

const RTC_ROW_ = 26;
const RTC_LABEL_ = 'Burson test copy';
const RTC_BLANK_NOTE_ = 'Blank: with the Safety valve (row 29) OFF and S-F Burson set, the bot is fully LIVE (real emails; ' +
  'the Relay\'s analysts\' side waits on the Burson outbox, row 24). Paste a test copy here to stay in Testing.';
const RTC_TAB_ = 'Test copy';
const RTC_COLUMNS_ = ['when', 'what', 'who', 'user', 'text', 'status', 'burson_message', 'burson_thread', 'copy_message',
  'copy_thread', 'key'];
const RTC_READ_ROWS_ = 3000;              // the latest rows (days of copying); an older thread pair is looked up
const RTC_CURSORS_PROP_ = 'RTC_CURSORS';  // {copy, sfb, at, floor, epoch, tries}: how far the copy has got
const RTC_SUMS_CACHE_ = 'rtc_sums';       // each S-F Burson message's emojis as last seen by the copy (script cache)
const RTC_BUDGET_MS_ = 20 * 1000;         // each run: S-F Burson's messages, at most this long (as the Relay's inbound)
const RTC_EMOJI_BUDGET_MS_ = 5 * 1000;    // then the emojis
const RTC_START_MS_ = 0;                  // set (or changed): nothing from before then is copied, so no backlog floods it
const RTC_COPIED_ = 'copied';

/** C26 while the test copy works. */
function testCopyOkNote_(name) {
  return `✓ ${name} · copying S-F Burson here; the Relay sends the analysts' side here, never to S-F Burson`;
}

/**
 * Row 26: Burson test copy. A tab from before it (help text was here, or the blank row above "How it works") gets it on
 * its next run, without setup(): blank unless a person pasted a space in B26 (kept, like B25). Rows 1-25 never move;
 * "How it works" moves to row 30 (below the switches in rows 27-28, Control.gs).
 */
function ensureTestCopyRow_(sh) {
  if (!sh) return;
  if (String(sh.getRange(RTC_ROW_, 1).getValue() || '').trim() === RTC_LABEL_) return;
  const b = sh.getRange(RTC_ROW_, 2).getValue();  // blank on every older tab: its help text used column A only
  const value = String(b === undefined || b === null ? '' : b).trim();
  sh.getRange(RTC_ROW_, 1, 1, 3).setValues([[RTC_LABEL_, value, value ? '' : RTC_BLANK_NOTE_]]);
  sh.getRange(RTC_ROW_, 1).setFontWeight('bold');
  sh.getRange(RTC_ROW_, 2).setBackground('#fff8e1');
  writeControlHelp_(sh);
}

/** C26: what the bot made of B26 (written only when it changes). */
function writeTestCopyNote_(sh, note) {
  if (!sh) return;
  const cell = sh.getRange(RTC_ROW_, 3);
  if (String(cell.getValue() || '') !== String(note || '')) cell.setValue(note || '');
}

/** B26 as the Control tab has it now ('' on a tab without the row, or when it can't be read). */
function readTestCopyCell_(sh) {
  try {
    if (!sh) return '';
    const r = sh.getRange(RTC_ROW_, 1, 1, 2).getValues()[0];
    const v = String(r[1] === undefined || r[1] === null ? '' : r[1]).trim();
    return String(r[0] || '').trim() === RTC_LABEL_ ? v : '';
  } catch (e) {
    return '';
  }
}

/**
 * This run's Burson test copy: B26 (`wanted.testCopy`), resolved like the other space cells (a link, spaces/ID, the bare
 * ID or the exact name; cached for an hour unless `fresh`) and checked, with `sfb` this run's S-F Burson (Main.gs
 * sfBursonFor_). {space: {id, name, externalUserAllowed} or null, blank, error, note}. Sets it for Chat.gs (Config.gs
 * setTestCopy_) and, with `control`, writes C26. Never throws: anything wrong means no test copy this run (nothing is
 * copied, and the Relay's analysts' side waits while B26 is set).
 */
function testCopyFor_(control, wanted, sfb, fresh) {
  const value = String((wanted && wanted.testCopy) || '').trim();
  let out;
  if (!value) {
    out = { space: null, blank: true, error: '', note: RTC_BLANK_NOTE_ };
  } else if (!sfb || !sfb.space || !sfb.space.id) {  // no S-F Burson known: paused (fail closed), as the Mirror is
    out = { space: null, blank: false, error: 'it needs the S-F Burson space (B25)', note: sfbPausedNote_(sfb) };
  } else {
    try {
      const space = resolveTestCopy_(value, fresh);
      const problem = testCopyProblem_(space, wanted, sfb.space);
      const dry = GEN.settings && GEN.settings.dry_run ? ' · a dry run: nothing is copied or sent here' : '';
      out = problem ? { space: null, blank: false, error: problem, note: '✗ ' + problem }
        : { space, blank: false, error: '', note: testCopyOkNote_(space.name) + dry };
    } catch (e) {
      const error = String((e && e.message) || e).trim();
      out = { space: null, blank: false, error, note: '✗ ' + error };
    }
  }
  setTestCopy_(out.space);
  if (control) {
    try {
      writeTestCopyNote_(control, out.note);
    } catch (e) {
      console.error('could not write C26 (Burson test copy): ' + ((e && e.message) || e));
    }
  }
  return out;
}

/** B26 (link, id or exact name) -> {id, name, externalUserAllowed}, or an error that says what to fix. */
function resolveTestCopy_(value, fresh) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'rtc_space:' + hashText_(String(value));
  if (!fresh) {
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }
  const ref = parseSpaceRef_(value, 'The Burson test copy');
  let id = ref.id;
  if (!id) {
    const props = PropertiesService.getScriptProperties();
    const prop = 'SPACE_ID:' + ref.name;
    id = (!fresh && props.getProperty(prop)) || findSpaceByName_(ref.name, 'Burson test copy');
    props.setProperty(prop, id);
  }
  let s;
  try {
    s = chatGetSpace_(id);
  } catch (e) {
    throw new Error(`Can't open ${id}. Check the link, and that ${Session.getEffectiveUser().getEmail()} is a member of that space.`);
  }
  const out = { id: s.name, name: s.displayName || s.name, externalUserAllowed: !!s.externalUserAllowed };
  cache.put(cacheKey, JSON.stringify(out), 3600);
  return out;
}

/**
 * Safety checks on the test copy ('' when it's fine): never S-F Burson (`sfb`: B25) or a space people outside Google
 * can join, and never a space the bot already uses (B3, B4, B9, B10), so the copy and the analysts' side land nowhere
 * anyone works and nowhere the bot reads.
 */
function testCopyProblem_(space, wanted, sfb) {
  if (!space) return '';
  if (isSfBurson_(sfb, space.id)) return 'The Burson test copy can\'t be S-F Burson itself (B25). Paste a separate Google-only space.';
  if (space.externalUserAllowed) {
    return `"${space.name || space.id}" allows people outside Google, so Burson could see it. Use a space only Google people can join.`;
  }
  const cells = [[wanted && wanted.burson, 'the Burson space (B3)'], [wanted && wanted.analyst, 'the analyst space (B4)'],
    [(wanted && wanted.mirror) || MIRROR_TARGET_SPACE, 'the Mirror space (B9)'], [wanted && wanted.autocorrect, 'the Auto-correct space (B10)']];
  const same = cells.find(([v]) => sameSpaceRef_(v, space));
  return same ? `The Burson test copy must be a space of its own, not ${same[1]}. Paste a separate Google-only space.` : '';
}

/**
 * True when a Control-tab cell (a link, id or exact name) names `space` ({id, name}): by id, or by its exact name, as
 * the bot finds a space by name (findSpaceByName_). Pure.
 */
function sameSpaceRef_(value, space) {
  if (!space || !String(value === undefined || value === null ? '' : value).trim()) return false;
  let ref;
  try { ref = parseSpaceRef_(value, ''); } catch (e) { return false; }
  if (ref.id) return ref.id === space.id;
  return String(ref.name || '').trim().toLowerCase() === String(space.name || '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------
// Writing in the test copy: only these, only in this run's test copy, never in S-F Burson (Chat.gs refuses the rest)
// ---------------------------------------------------------------------------------------------------------------

/** Runs `fn` (a write in `copyId`) as the test copy's own: only in this run's test copy (B26), never in S-F Burson. */
function testCopyWrite_(copyId, fn) {
  if (!copyId || copyId !== testCopyId_() || copyId === sfBursonId_() || outsideSpace_(copyId)) {
    throw new Error(`Refusing to write in ${copyId || 'a blank space'}: it isn't this run's Burson test copy (B26).`);
  }
  const was = TEST_COPY_WRITING_;
  TEST_COPY_WRITING_ = true;
  try {
    return fn();
  } finally {
    TEST_COPY_WRITING_ = was;
  }
}

/** Posts in the test copy (in `thread` when given), idempotent on `key` (its message id starts with `prefix`). */
function testCopyPost_(copyId, text, thread, key, prefix) {
  return testCopyWrite_(copyId, () => {
    const msg = chatPostMessage_(copyId, text, { thread: thread || null, key, idPrefix: prefix });
    rememberBotUser_(msg);
    return msg;
  });
}

/** Puts `emoji` on a message in the test copy (already there: fine). */
function testCopyReact_(copyId, messageName, emoji) {
  if (String(messageName || '').indexOf(copyId + '/messages/') !== 0) throw new Error(`Refusing to react on ${messageName}: it isn't in the Burson test copy.`);
  return testCopyWrite_(copyId, () => chatReact_(messageName, emoji));
}

// ---------------------------------------------------------------------------------------------------------------
// The copy: S-F Burson into the test copy
// ---------------------------------------------------------------------------------------------------------------

/**
 * How far the copy has got: {copy (B26's space), sfb (B25's), at, floor, epoch (when it started), tries}. Just set, or
 * another test copy or S-F Burson than before: from now (RTC_START_MS_: nothing from before then); nothing older than
 * `floor` is ever read. A run that didn't get to it catches up, for up to a day (RELAY_MAX_GAP_MS_).
 */
function testCopyCursors_(copyId, sfbId, now) {
  const props = PropertiesService.getScriptProperties();
  let c = null;
  try { c = JSON.parse(props.getProperty(RTC_CURSORS_PROP_) || 'null'); } catch (e) { c = null; }
  if (!c || c.copy !== copyId || c.sfb !== sfbId) {
    c = { copy: copyId, sfb: sfbId, at: now - RTC_START_MS_, floor: now - RTC_START_MS_, epoch: now, tries: {} };
    props.setProperty(RTC_CURSORS_PROP_, JSON.stringify(c));
    c.fresh = true;
  }
  c.tries = c.tries || {};
  c.floor = Number(c.floor) || 0;
  c.at = Math.max(Number(c.at) || 0, now - RELAY_MAX_GAP_MS_, c.floor);
  return c;
}

/** Where reading resumes: a little before the cursor, never before the copy started. */
function testCopySince_(c) { return new Date(Math.max(c.at - RELAY_OVERLAP_MS_, Number(c.floor) || 0)).toISOString(); }

function saveTestCopyCursors_(c) {
  const names = Object.keys(c.tries || {});
  names.slice(0, Math.max(0, names.length - 50)).forEach(n => { delete c.tries[n]; });
  const kept = Object.assign({}, c);
  delete kept.fresh;
  PropertiesService.getScriptProperties().setProperty(RTC_CURSORS_PROP_, JSON.stringify(kept));
}

/** B26 blank or not usable (or no S-F Burson known): the copy forgets how far it got, so set again it starts afresh. */
function testCopyStop_() {
  try {
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty(RTC_CURSORS_PROP_)) return;
    props.deleteProperty(RTC_CURSORS_PROP_);
    CacheService.getScriptCache().remove(RTC_SUMS_CACHE_);
  } catch (e) {
    console.error('Burson test copy: couldn\'t reset: ' + ((e && e.message) || e));
  }
}

/**
 * The Test copy tab and what its latest rows say about test copy `copyId`: {table, keys (what was copied or settled),
 * liveToCopy / liveThreadToCopy (S-F Burson message and thread -> its copy), add(row), olderThread(thread), key(k): a
 * row key for this test copy, names (the Relay names tab, Relay.gs)}. Pairs into another test copy (B26 changed since)
 * are left out.
 */
function testCopyState_(ss, copyId, sfbId) {
  const table = sheetTable_(ss, RTC_TAB_, RTC_COLUMNS_, 'key', RTC_READ_ROWS_);
  const st = { table, copyId, sfbId, keys: new Set(), liveToCopy: new Map(), liveThreadToCopy: new Map(),
    key: k => `${copyId}|${k}` };
  const mine = name => String(name || '').indexOf(copyId + '/') === 0;
  st.note = row => {
    if (row.key) st.keys.add(String(row.key));
    const live = String(row.burson_message || '');
    const copy = String(row.copy_message || '');
    if (live && mine(copy) && row.what !== 'emoji') st.liveToCopy.set(live, copy);
    const lt = String(row.burson_thread || '');
    const ct = String(row.copy_thread || '');
    // an alert's pair wins: replies go under the alert's copy
    if (lt && mine(ct) && (row.what === 'alert' || !st.liveThreadToCopy.has(lt))) st.liveThreadToCopy.set(lt, ct);
  };
  st.add = row => {
    const full = Object.assign({ when: new Date().toISOString() }, row);
    table.append(full);
    st.note(full);
    return full;
  };
  table.load().forEach(st.note);
  st.olderThread = thread => testCopyOlderThread_(ss.getSheetByName(RTC_TAB_), table.header, copyId, thread);
  Object.assign(st, relayNames_(ss));  // the Relay names tab: people's names and orgs (Relay.gs)
  return st;
}

/** The test copy's thread for S-F Burson thread `thread`, from a Test copy tab row older than the rows read, or ''. */
function testCopyOlderThread_(sh, header, copyId, thread) {
  if (!sh || !thread || sh.getLastRow() < 2) return '';
  const col = header.indexOf('burson_thread') + 1;
  const copyCol = header.indexOf('copy_thread');
  if (col < 1 || copyCol < 0) return '';
  const found = sh.getRange(2, col, sh.getLastRow() - 1, 1).createTextFinder(String(thread)).matchEntireCell(true).findAll();
  for (const cell of found) {
    const row = sh.getRange(cell.getRow(), 1, 1, header.length).getValues()[0];
    if (String(row[copyCol] || '').indexOf(copyId + '/') === 0) return String(row[copyCol]);
  }
  return '';
}

/**
 * One run of the copy (poll(): B26 usable, S-F Burson known, the bot ON, not a dry run): S-F Burson's new messages into
 * the test copy in S-F Burson's own order (strict: one that can't be copied yet holds the rest behind it), then the
 * emojis, each with its own few seconds. Never throws: a failure is logged, shown in C26 and tried again next run.
 * Returns {state (testCopyState_, for the Relay's analysts' side; null when the tab couldn't be read), copied, failed,
 * emojis, error}.
 */
function testCopyRun_(ss, control, rtc, sfb) {
  const t0 = Date.now();
  const tc = { copy: rtc.space, sfb: sfb.id, botUser: PropertiesService.getScriptProperties().getProperty('BOT_USER') || null,
    now: () => Date.now(), log: text => console.log(text) };
  const out = { state: null, copied: 0, failed: 0, emojis: 0, error: '' };
  try {
    const st = testCopyState_(ss, tc.copy.id, tc.sfb);
    out.state = st;
    const c = testCopyCursors_(tc.copy.id, tc.sfb, tc.now());
    st.floor = c.floor;
    let res = { done: {}, error: '' };
    try {
      const msgs = chatListMessages_(tc.sfb, testCopySince_(c), LIST_LIMIT_).sort((a, b) => a.createTime - b.createTime);
      res = relayPass_(tc, c, 'at', msgs, t0 + RTC_BUDGET_MS_, m => testCopyOne_(tc, st, m), (m, error) => testCopyFailed_(tc, st, m, error), true);
    } finally {
      saveTestCopyCursors_(c);
    }
    Object.assign(out, { copied: res.done.copied || 0, failed: res.done.failed || 0, error: res.error });
    if (tc.now() < t0 + RTC_BUDGET_MS_ + RTC_EMOJI_BUDGET_MS_) {
      const emojis = testCopyEmojis_(tc, st, t0 + RTC_BUDGET_MS_ + RTC_EMOJI_BUDGET_MS_);
      out.emojis = emojis.n;
      out.error = out.error || emojis.error;
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
    console.error('Burson test copy: ' + ((e && e.stack) || e));
  }
  if (out.copied || out.failed || out.emojis) {
    console.log(`Burson test copy: ${JSON.stringify({ copied: out.copied, failed: out.failed, emojis: out.emojis })}`);
  }
  if (control) {
    try {
      writeTestCopyNote_(control, testCopyOkNote_(rtc.space.name) +
        (out.error ? ` · ⚠️ ${truncate_(out.error, 120)} (tried again every run)` : ''));
    } catch (e) {
      console.error('could not write C26 (Burson test copy): ' + ((e && e.message) || e));
    }
  }
  return out;
}

/**
 * Copies one S-F Burson message into the test copy: Zapier's alert as an exact copy, anyone's reply or message as "Name
 * (Burson): text" ("Name (Google): text", or the name alone while the Relay names tab doesn't say: Relay.gs relayWho_).
 * Returns 'copied' or '' (the bot's own work, another app's reply, already done, nothing to copy).
 */
function testCopyOne_(tc, st, m) {
  if (!m || !m.name || relayBotsOwn_(tc, m)) return '';  // the bot's own (Relay.gs)
  const key = st.key('msg:' + m.name);
  if (st.keys.has(key)) return '';
  if (!m.threadReply && isZapierMirrorCandidate_(m, tc.botUser)) {  // Zapier's alert: an exact copy, top level
    const text = zapierMirrorText_(m);
    if (!text) return '';
    const copy = testCopyWrite_(tc.copy.id, () => mirrorPostMessage_(tc.copy.id, text, m.name, m));
    testCopyPair_(st, m, copy, RTC_COPIED_);
    tc.log(`Burson test copy: an alert copied (${m.name})`);
    return 'copied';
  }
  if (m.senderType === 'BOT') return '';  // another app's reply: only Zapier's alerts and people's messages are copied
  const body = relayBody_(m, 'S-F Burson');
  if (!body) return '';
  const what = m.threadReply ? 'reply' : 'message';
  const p = relayPerson_(st, m, 'burson');  // their name (and org) from the Relay names tab: someone new gets a row there
  const who = relayWho_(p);
  const thread = m.threadReply ? testCopyThreadFor_(tc, st, m) : null;
  const lead = m.threadReply && !thread ? `${who}, replying in a thread the test copy doesn't have: ` : `${who}: `;
  const posted = testCopyPost_(tc.copy.id, lead + body, thread, 'rtc-in:' + m.name, RELAY_IN_PREFIX_);
  st.add({ what, who, user: m.senderName, text: body, status: RTC_COPIED_, burson_message: m.name,
    burson_thread: m.thread, copy_message: posted.name, copy_thread: posted.thread, key });
  tc.log(`Burson test copy: ${who}'s ${what} copied`);
  return 'copied';
}

/** Records an alert and its copy in the test copy (once). */
function testCopyPair_(st, live, copy, status) {
  const key = st.key('msg:' + live.name);
  if (!copy || !copy.name || st.keys.has(key)) return;
  st.add({ what: 'alert', who: 'Zapier', text: truncate_(String(copy.text || live.text || '').split('\n')[0], 120), status,
    burson_message: live.name, burson_thread: live.thread, copy_message: copy.name, copy_thread: copy.thread, key });
}

/**
 * The test copy's thread for an S-F Burson reply `m`: from the Test copy tab; else the thread's first message: an alert
 * (its copy, found by the copy's own id) or a message since the copy started (copied now, so its replies follow it).
 * Null when there's none (the reply comes over on its own, saying so).
 */
function testCopyThreadFor_(tc, st, m) {
  if (st.liveThreadToCopy.has(m.thread)) return st.liveThreadToCopy.get(m.thread);
  const older = st.olderThread(m.thread);
  if (older) return older;
  const root = chatThreadRoot_(tc.sfb, m.thread);
  // none, or the thread's first message is gone (deleted: Chat lists a reply first)
  if (!root || root.threadReply || root.name === m.name) return null;
  if (st.liveToCopy.has(root.name)) return st.liveThreadToCopy.get(root.thread) || null;
  if (isZapierMirrorCandidate_(root, tc.botUser)) {
    const copy = mirrorCopyOf_(tc.copy.id, root.name);  // copied already, the tab not knowing it
    if (copy) {
      testCopyPair_(st, root, copy, 'paired');
      return copy.thread;
    }
  }
  if (root.createTime >= (st.floor || 0) && testCopyOne_(tc, st, root) === 'copied') {
    return st.liveThreadToCopy.get(root.thread) || null;
  }
  return null;
}

/** A message that kept failing: a row says why (nobody works in the test copy, so nothing is posted). Returns 'failed'. */
function testCopyFailed_(tc, st, m, error) {
  const alert = !m.threadReply && isZapierMirrorCandidate_(m, tc.botUser);
  st.add({ what: alert ? 'alert' : m.threadReply ? 'reply' : 'message', who: alert ? 'Zapier' : '', user: m.senderName,
    text: alert ? truncate_(zapierMirrorText_(m).split('\n')[0], 120) : relayBody_(m, 'S-F Burson'),
    status: `not copied: ${truncate_(error, 160)}`, burson_message: m.name, burson_thread: m.thread, key: st.key('msg:' + m.name) });
  return 'failed';
}

/**
 * The emojis: on S-F Burson messages since the copy started (nothing from before then), each message whose emojis
 * changed since the last pass, for the emojis that went up: everyone's go on the message's copy, as in S-F Burson.
 * Returns {n: emojis copied, error}.
 */
function testCopyEmojis_(tc, st, until) {
  const floor = Number(st.floor) || 0;
  const since = new Date(Math.max(tc.now() - RELAY_EMOJI_DAYS_ * DAY_MS_, floor)).toISOString();
  const msgs = chatListMessages_(tc.sfb, since, LIST_LIMIT_, true, { fields: RELAY_LIST_FIELDS_ })
    .filter(m => (m.reactions || []).length && m.createTime >= floor);
  const cache = CacheService.getScriptCache();
  let saved = null;
  try { saved = JSON.parse(cache.get(RTC_SUMS_CACHE_) || 'null'); } catch (e) { saved = null; }
  if (!saved || saved.copy !== tc.copy.id || saved.floor !== floor) saved = { sums: {}, tries: {} };  // keys keep it once
  const sums = saved.sums || {};
  const tries = saved.tries || {};
  let n = 0;
  let error = '';
  for (const m of msgs) {
    const sum = emojiSum_(m);
    if (sums[m.name] === sum) continue;
    if (tc.now() > until) break;
    const up = emojisUp_(sums[m.name], sum);
    try {
      const done = up.size ? testCopyEmojisOne_(tc, st, m, up) : 0;
      if (done === null && tc.now() - m.createTime < RELAY_PAIR_WAIT_MS_) continue;  // not copied yet: next pass
      n += done || 0;
      sums[m.name] = sum;
      delete tries[m.name];
    } catch (e) {
      error = String((e && e.message) || e);
      tries[m.name] = (tries[m.name] || 0) + 1;
      tc.log(`Burson test copy: the emojis on ${m.name} didn't go (try ${tries[m.name]} of ${RELAY_MAX_TRIES_}): ${error}`);
      if (tries[m.name] >= RELAY_MAX_TRIES_) {
        st.add({ what: 'emoji', who: '', text: Array.from(up).join(' '), status: `not copied: ${truncate_(error, 160)}`,
          burson_message: m.name, key: st.key(`emoji-failed:${m.name}|${sum}`) });
        sums[m.name] = sum;
        delete tries[m.name];
      }
    }
  }
  const keep = { copy: tc.copy.id, floor, sums: {}, tries: {} };
  msgs.forEach(m => {
    if (sums[m.name] !== undefined) keep.sums[m.name] = sums[m.name];
    if (tries[m.name]) keep.tries[m.name] = tries[m.name];
  });
  try {
    cache.put(RTC_SUMS_CACHE_, JSON.stringify(keep), 21600);
  } catch (e) {
    console.error('Burson test copy: couldn\'t keep the emoji notes: ' + ((e && e.message) || e));
  }
  return { n, error };
}

/**
 * The new emojis (`up`) on S-F Burson message `m`: each one goes on the message's copy, once, whoever added it; never
 * one the bot itself added. Returns how many went, or null when the message has no copy (yet).
 */
function testCopyEmojisOne_(tc, st, m, up) {
  let copy = st.liveToCopy.get(m.name);
  if (!copy && isZapierMirrorCandidate_(m, tc.botUser)) {
    const found = mirrorCopyOf_(tc.copy.id, m.name);  // copied already, the tab not knowing it
    if (found) {
      testCopyPair_(st, m, found, 'paired');
      copy = found.name;
    }
  }
  if (!copy) return null;
  let n = 0;
  chatListReactions_(m.name).filter(r => r.user && up.has(bareEmoji_(r.emoji)) && !botReacted_(m.name, r.emoji))
    .forEach(r => {
      const key = st.key(`emoji:${m.name}|${r.user}|${bareEmoji_(r.emoji)}`);
      if (st.keys.has(key)) return;
      const p = relayPerson_(st, { senderName: r.user, senderDisplay: r.userDisplay }, 'burson');
      testCopyReact_(tc.copy.id, copy, r.emoji);
      st.add({ what: 'emoji', who: relayWho_(p), user: r.user, text: r.emoji, status: RTC_COPIED_, burson_message: m.name,
        copy_message: copy, key });
      n++;
    });
  return n;
}
