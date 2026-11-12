/**
 * Outcomes.gs — "Track post-alert outcomes", a switch on the Control tab (row 21, OFF until someone turns it on). OFF, the
 * bot doesn't read anything after the Social Alert is sent, as it always has. ON, for a week after a Social Alert is sent
 * the bot reads the replies on its email thread, and watches for the T&S confirmation email, and writes what came of it
 * in the Alert log's `outcome` column (shown on the Results tab), with a short note under the alert in the analyst space:
 *   Resolved          a reply says it's resolved, fixed, mitigated, rolled back or taken down (not "will be", "not yet",
 *                     "if" or a question; "…and will keep monitoring" after it is fine)
 *   T&S confirmed     the T&S "WD Intake Request" confirmation email for the post came in (checkTnsEmails_, Drafts.gs; or
 *                     here, for an alert T&S was already marked on by hand)
 *   Comms replied     someone on a comms team (GCPA, People Comms, Exec Comms, Stop Leaks, crisis) or the standard CC list
 *                     replied
 *   Product replied   the product's own alert contacts (its PAs, gUP, execs) replied
 * A reply from anyone else (another team, someone added by hand) counts only when it says it's resolved. An alert can
 * have several ("Resolved · Comms replied", strongest first); one is never taken back. Replies are read from Gmail's
 * snippet of each message (no bodies), never the bot's own messages (Sent) or out-of-office replies (their subject, or
 * their first words). Nothing is sent and nothing is posted or reacted in the Burson space. Testing (a stand-in): a reply
 * the stand-in sends on the thread that starts with a team in brackets ("[GCPA] On it") counts as that team's
 * (FollowUp.gs followupTagOf_); live, that's off.
 * Each read also keeps what each team did on the alert's row (email_input.followup: FollowUp.gs followThrough_), for the
 * Follow-up tab, and the drafts of Draft follow-ups (row 27) and Draft answers to questions (row 28) when they're ON.
 *
 *   watchOutcome_(ctx, row)               a step of onEmailSent_ (Drafts.gs): the sent alert goes on the list for a week
 *   trackOutcomes_(ctx, report)           every run (Bot.gs): up to 5 due threads read; returns at once when OFF
 *   tnsConfirmedOutcome_(ctx, row, report) checkTnsEmails_ (Drafts.gs) found the T&S confirmation: "T&S confirmed"
 *   outcomeOf_(row, m)                    what one reply shows (pure)
 *   mergeOutcome_(text, label)            the outcome cell with one more label (pure; Speed.gs uses it for the Results tab)
 *
 * The list is ctx.memo 'outcome_watch' ([{id, at, next}], the newest 100), so a run with nothing due never opens the log
 * sheet. Each thread is read every 30 minutes the first day, then every 2 hours (with Draft follow-ups ON, also at its
 * deadline and 24 hours after the send, when those come first). The alerts sent in the last week that aren't on it are
 * added from the Alert log when the switch is turned on (the first run after 30 minutes without one, so an alert sent
 * while it was OFF is tracked too), and once a day after that (one the list missed). The `outcome` column is written
 * before the note goes out, so no outcome is ever noted twice. C21 adds up the main space's list, the auto-correct
 * space's and the Other alerts space's (script property OUTCOME_FLOWS).
 */

const OUTCOME_WATCH_DAYS_ = 7;                            // how long after its send a Social Alert's thread is read
const OUTCOME_WATCH_MS_ = OUTCOME_WATCH_DAYS_ * 24 * 3600 * 1000;
const OUTCOME_EVERY_MS_ = 30 * 60 * 1000;                 // each thread is read at most this often the first day…
const OUTCOME_LATER_EVERY_MS_ = 2 * 3600 * 1000;          // …and this often after that
const OUTCOME_PER_RUN_ = 5;                               // threads read per run, so poll() stays quick
const OUTCOME_MAX_ = 100;                                 // sent alerts on the list at most (the newest)
const OUTCOME_MEMO_MAX_ = 8000;                           // characters: a script property holds about 9 KB
const OUTCOME_SEED_EVERY_MS_ = 24 * 3600 * 1000;          // the list is topped up from the Alert log once this often…
const OUTCOME_GAP_MS_ = 30 * 60 * 1000;                   // …and on the first run after this long without one (turned back on)
const OUTCOME_LAST_EVERY_MS_ = 5 * 60 * 1000;             // how often a run notes that it ran (ctx.memo 'outcome_last')
const OUTCOME_FLOWS_PROP_ = 'OUTCOME_FLOWS';              // C21: each space's figures, {main|ac|os: {watching, day, n, at}}
const OUTCOME_FLOW_FRESH_MS_ = 3 * 3600 * 1000;           // a space that hasn't checked for this long is left out of "tracking"
const OUTCOME_LABELS_ = ['Resolved', 'T&S confirmed', 'Comms replied', 'Product replied'];  // strongest first
const OUTCOME_COMMS_CODES_ = ['gcpa', 'people_comms', 'exec_comms', 'stop_leaks', 'crisis'];  // the comms teams' groups
const OUTCOME_QUOTE_MAX_ = 160;                           // characters of a reply quoted in the note
const OUTCOME_AUTO_TEXT_MAX_ = 200;                       // a reply's first characters read for "out of office"

// ---------------------------------------------------------------------------------------------------------------
// The outcome cell: labels joined by " · ", strongest first; anything else someone typed there is kept, after them
// ---------------------------------------------------------------------------------------------------------------

/** "Resolved · Comms replied" -> ['Resolved', 'Comms replied']. Pure. */
function outcomeParts_(text) {
  return String(text || '').split('·').map(s => s.trim()).filter(Boolean);
}

/** Whether the outcome cell already has `label`. Pure. */
function hasOutcome_(text, label) {
  return outcomeParts_(text).includes(label);
}

/**
 * The outcome cell with `label` (or another cell's labels) added: every label once, strongest first, never one taken
 * away. Pure.
 */
function mergeOutcome_(text, label) {
  const parts = outcomeParts_(text);
  outcomeParts_(label).forEach(x => { if (!parts.includes(x)) parts.push(x); });
  const rank = x => { const i = OUTCOME_LABELS_.indexOf(x); return i < 0 ? OUTCOME_LABELS_.length : i; };
  return parts.map((x, i) => [x, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]).join(' · ');
}

// ---------------------------------------------------------------------------------------------------------------
// The list of sent alerts whose threads are read
// ---------------------------------------------------------------------------------------------------------------

/** The list (ctx.memo 'outcome_watch'), [] when there's none. */
function outcomeWatched_(ctx) {
  try {
    const list = JSON.parse(ctx.memo.get('outcome_watch') || '[]');
    return Array.isArray(list) ? list.filter(e => e && e.id) : [];
  } catch (e) {
    return [];
  }
}

/** Saves the list when it changed (the oldest entries go first if it's too long for a script property). */
function setOutcomeWatched_(ctx, list) {
  let keep = list.slice(-OUTCOME_MAX_);
  while (keep.length && JSON.stringify(keep).length > OUTCOME_MEMO_MAX_) keep = keep.slice(1);
  const next = JSON.stringify(keep);
  if (next !== JSON.stringify(outcomeWatched_(ctx))) ctx.memo.set('outcome_watch', next);
}

/** When an entry is read next: 30 minutes on during the first day after its send, 2 hours on after that. Pure. */
function outcomeNext_(e, now) {
  return now + (now - Number(e.at || 0) < 24 * 3600 * 1000 ? OUTCOME_EVERY_MS_ : OUTCOME_LATER_EVERY_MS_);
}

/**
 * A step of onEmailSent_ (switch ON): the sent alert goes on the list, its thread first read 30 minutes on (with Draft
 * follow-ups ON, at its reply deadline when that comes first: FollowUp.gs). Only with a thread to read.
 */
function watchOutcome_(ctx, row) {
  if (!switchOn_(ctx, 'trackOutcomes') || !row || !row.alert_id || !row.email_thread) return;
  const at = Number(row.email_sent_at) || ctx.now();
  const list = outcomeWatched_(ctx).filter(e => e.id !== row.alert_id);
  let next = ctx.now() + OUTCOME_EVERY_MS_;
  if (switchOn_(ctx, 'draftFollowUps')) {
    const due = followupDue_(at, ((row.email_input || {}).escalation || {}).priority, followupDeadlines_());
    if (due > ctx.now() && due < next) next = due;
  }
  list.push({ id: row.alert_id, at, next });
  setOutcomeWatched_(ctx, list);
}

/**
 * The alerts sent in the last week that aren't on the list go on it, due now (oldest first, the newest 100 kept): when
 * the switch was just turned on (no run with it ON in the last 30 minutes, so the ones sent while it was OFF are added
 * too), and once a day (one the list missed). Opens the log sheet only then.
 */
function seedOutcomeWatch_(ctx, list, now) {
  const seeded = Number(ctx.memo.get('outcome_seeded')) || 0;
  const last = Number(ctx.memo.get('outcome_last')) || 0;  // the last run with the switch ON (trackOutcomes_)
  if (seeded && now - seeded < OUTCOME_SEED_EVERY_MS_ && last && now - last <= OUTCOME_GAP_MS_) return list;
  const have = new Set(list.map(e => e.id));
  const sentAt = a => Number(a.email_sent_at) || Number(a.email_at) || 0;
  const rows = ctx.store.alerts.filter(a => a.email_status === 'sent' && a.email_thread && a.alert_id && !have.has(a.alert_id) &&
    sentAt(a) > 0 && now - sentAt(a) <= OUTCOME_WATCH_MS_).sort((x, y) => sentAt(x) - sentAt(y));
  ctx.memo.set('outcome_seeded', String(now));  // after the log was read: a read that failed is tried again next run
  if (!rows.length) return list;
  return list.concat(rows.map(a => ({ id: a.alert_id, at: sentAt(a), next: now })))
    .sort((x, y) => Number(x.at || 0) - Number(y.at || 0)).slice(-OUTCOME_MAX_);
}

// ---------------------------------------------------------------------------------------------------------------
// Every run
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every run (switch ON): up to 5 sent alerts that are due get their email thread read (each every 30 minutes the first
 * day, then every 2 hours, for a week after its send), and any new outcome is written and noted. Returns at once when the
 * switch is OFF or nothing is due (no Gmail, no log sheet). A failure on one alert is logged; it's read again later.
 */
function trackOutcomes_(ctx, report) {
  if (!switchOn_(ctx, 'trackOutcomes') || !draftsOn_(ctx)) return;
  const now = ctx.now();
  const all = seedOutcomeWatch_(ctx, outcomeWatched_(ctx), now);
  const list = all.filter(e => now - Number(e.at || 0) <= OUTCOME_WATCH_MS_);  // a week after its send, it's done
  const due = list.filter(e => Number(e.next || 0) <= now).sort((a, b) => Number(a.next || 0) - Number(b.next || 0))
    .slice(0, OUTCOME_PER_RUN_);
  const drop = new Set();
  const threads = new Map();  // this run's reads of each thread (an update and its first alert share one)
  let checked = 0;
  due.forEach(e => {
    if (ctx.now() > ctx.deadline - 30 * 1000) return;  // the rest wait for the next run
    checked++;
    e.next = outcomeNext_(e, ctx.now());
    try {
      if (!checkOutcome_(ctx, e, report, threads)) drop.add(e.id);
    } catch (err) {
      ctx.log(`couldn't check what came of the Social Alert ${e.id}: ${(err && err.message) || err}`);
    }
  });
  setOutcomeWatched_(ctx, list.filter(e => !drop.has(e.id)));
  // This run had the switch ON (noted every 5 minutes, once the list is saved): the first run 30 minutes after the last
  // note (the switch was OFF) tops the list up from the Alert log
  if (now - (Number(ctx.memo.get('outcome_last')) || 0) >= OUTCOME_LAST_EVERY_MS_) ctx.memo.set('outcome_last', String(now));
  if (checked) noteOutcomes_(ctx, list.length - drop.size);
}

/**
 * One read of a watched alert's thread (`e`, its list entry): the replies since its send, what each shows, and the T&S
 * confirmation when T&S was marked by hand (checkTnsEmails_ no longer looks for it); then what each team did, for the
 * Follow-up tab, and the drafts of Draft follow-ups / Draft answers to questions when they're ON (FollowUp.gs
 * followThrough_). False when the alert is no longer a sent Social Alert on file (watching it is over).
 */
function checkOutcome_(ctx, e, report, threads) {
  const row = ctx.store.alertById(e.id);
  if (!row || row.email_status !== 'sent' || !row.email_thread) return false;
  const since = Number(row.email_sent_at) || Number(row.email_at) || Number(e.at) || 0;
  const threadIds = typeof rowSentThreadIds_ === 'function' ? rowSentThreadIds_(row) : [row.email_thread].filter(Boolean);
  let msgs = [];
  const seenMsgIds = new Set();
  threadIds.forEach(tid => {
    let tMsgs = threads.get(tid);
    if (!tMsgs) {
      tMsgs = ctx.gmail.getThread(tid) || [];
      threads.set(tid, tMsgs);
    }
    (tMsgs || []).forEach(m => {
      const mid = (m && m.id) || JSON.stringify(m);
      if (!seenMsgIds.has(mid)) {
        seenMsgIds.add(mid);
        msgs.push(m);
      }
    });
  });
  const found = [];  // [{label, m}]: the first reply that shows each
  outcomeReplies_(ctx, msgs, since, row).forEach(m => outcomeOf_(row, m).forEach(label => {
    if (!found.some(f => f.label === label)) found.push({ label, m });
  }));
  if (tnsWhy_(row.email_input || {}) && !hasOutcome_(row.outcome, 'T&S confirmed') && !tnsWatched_(ctx).includes(row.alert_id) &&
      typeof ctx.gmail.findMessages === 'function') {
    const link = tnsLinkOf_(row);
    if (link && ctx.gmail.findMessages(`subject:"WD Intake Request" newer_than:${OUTCOME_WATCH_DAYS_}d "${link}"`, 1).length) {
      found.push({ label: 'T&S confirmed', m: null });
    }
  }
  recordOutcomes_(ctx, row, found, report);
  followThrough_(ctx, row, e, msgs, since, report);
  return true;
}

/** The bot's own mailbox addresses (the mailbox, Brand Social's, the From it sends with), lowercased. */
function outcomeOwnAddresses_(ctx) {
  const D = (ctx && ctx.drafts) || {};
  return new Set([D.mailbox, GEN.email && GEN.email.from_email].concat(String(D.from || '').match(ADDRESS_RX_) || [])
    .filter(Boolean).map(a => String(a).toLowerCase()));
}

/**
 * The replies on a thread since the Social Alert went out, oldest first: not the bot's mailbox's own messages (Sent,
 * drafts, or from its address) and not out-of-office or bounce messages. Testing (a stand-in, and the alert's `row`): a
 * "[Team] …" message from the stand-in counts, as that team's (FollowUp.gs followupTagOf_: the reply gets `tag`).
 */
function outcomeReplies_(ctx, msgs, since, row) {
  const own = outcomeOwnAddresses_(ctx);
  const testers = new Set(watchTesters_(ctx));
  const teams = row && testers.size ? followupTeams_(row) : null;
  const out = [];
  (msgs || []).forEach(m => {
    const labels = m.labels || [];
    if (labels.includes('DRAFT') || !(Number(m.at) > since)) return;
    const tag = teams ? followupTagOf_(ctx, m, row, teams) : null;
    if (tag) { out.push(Object.assign({}, m, { tag })); return; }
    if (labels.includes('SENT')) return;
    const from = outcomeAddresses_(m);
    if (!from.length || from.some(a => own.has(a) || testers.has(a) || /^(?:mailer-daemon|postmaster|no-?reply)@/i.test(a))) return;
    if (!outcomeAutoReply_(m)) out.push(m);
  });
  return out.sort((a, b) => Number(a.at) - Number(b.at));
}

/** The reply's sender addresses (From and Sender), lowercased. Pure. */
function outcomeAddresses_(m) {
  const h = (m && m.headers) || {};
  return Array.from(new Set([h.from, h.sender].reduce((all, v) => all.concat(String(v || '').match(ADDRESS_RX_) || []), [])
    .map(a => a.toLowerCase())));
}

const OUTCOME_AUTO_SUBJECT_RX_ = new RegExp('^(?:automatic reply|auto[- ]?reply|autoreply|out of (?:the )?office|ooo\\b|' +
  'undeliverable|delivery status notification)', 'i');
// An out-of-office reply says so first: its opening sentence (the one after a greeting or thanks, when it opens with
// one: "Thanks for your note. I am out of the office …"). A real reply that mentions leave later ("Resolved. I'm on leave
// from tomorrow") still counts; so does "I was out of office yesterday"
const OUTCOME_AUTO_TEXT_RX_ = new RegExp('^(?:(?:i am|i[\'’]m|i will be|i[\'’]ll be)\\s+(?:currently\\s+)?|currently\\s+)' +
  '(?:out of (?:the )?office|ooo\\b|on (?:vacation|leave|pto|holiday)|away\\b)|\\b(?:out of (?:the )?office|ooo) ' +
  '(?:until|till|through|from)\\b|\\blimited access to (?:e-?mail|my inbox)\\b|\\b(?:automatic reply|auto[- ]?reply)\\b', 'i');
const OUTCOME_GREETING_RX_ = /^(?:hi|hello|hey|dear\s+[^,.!?]*|good (?:morning|afternoon|evening)|thanks?|thank you)\b[^.!?]*[.!?]?$/i;
const OUTCOME_GREETING_LEAD_RX_ = /^(?:hi|hello|hey|dear\s+[^,.!?]*|good (?:morning|afternoon|evening))[\s,!.:-]+/i;

/** An out-of-office or automatic reply (its subject, or how its own words open). Pure. */
function outcomeAutoReply_(m) {
  const subject = String(((m && m.headers) || {}).subject || '');
  const sentences = outcomeOwnText_(m && m.snippet).slice(0, OUTCOME_AUTO_TEXT_MAX_).split(/(?<=[.!?])\s+/).filter(Boolean);
  const lead = sentences.length > 1 && OUTCOME_GREETING_RX_.test(sentences[0]) ? sentences[1] : (sentences[0] || '');
  return OUTCOME_AUTO_SUBJECT_RX_.test(subject) || OUTCOME_AUTO_TEXT_RX_.test(lead.replace(OUTCOME_GREETING_LEAD_RX_, ''));
}

/**
 * A reply's own words: its snippet without the quoted email under it ("On … wrote:", from the last "On" before
 * "wrote:", so a reply that says "On it" or "we're on this" keeps its words). Pure.
 */
function outcomeOwnText_(snippet) {
  return String(snippet || '').split(/\bOn\s(?:(?!\bOn\s)[\s\S]){0,200}?\bwrote:|-{2,}\s*(?:Original|Forwarded) Message|\bFrom:\s/i)[0]
    .replace(/\s+/g, ' ').trim();
}

const OUTCOME_RESOLVED_RX_ = new RegExp([
  '\\b(?:resolved|fixed|mitigated|patched)\\b',
  '\\brolled (?:it |this |that |the (?:change|update|feature|launch) )?back\\b',
  '\\broll ?back (?:is |was |has been )?(?:done|complete|completed|live|out)\\b',
  '\\b(?:taken|took) (?:it |this |that |them |the (?:post|tweet|video|content|ad|page) )?down\\b',
  '\\b(?:post|tweet|video|content|comment|account|ad|page|it|this|that)\\s+(?:has been |have been |was |is |got |been )?' +
    '(?:now )?(?:removed|deleted|suspended)\\b',
  '\\b(?:removed|deleted) (?:the|this|that) (?:post|tweet|video|content|comment|ad|page)\\b',
].join('|'), 'i');
// A sentence that isn't saying it's done: a negation, the future, a condition or a wish
const OUTCOME_NOT_YET_RX_ = new RegExp('\\b(?:not|no|never|yet|still|will|going to|plan(?:s|ning)? to|working on|once|when|if|' +
  'until|unless|should|need(?:s|ed)? to|hope|whether|asap|soon)\\b|n[\'’]t\\b|[\'’]ll\\b', 'i');
// What comes next, said after it's done ("…and will keep monitoring", "…, no further action needed"): left out of the
// sentence before it's read, so its "will" or "no" doesn't hide the "resolved"
const OUTCOME_FOLLOW_UP_RX_ = new RegExp('(?:\\b(?:we|i|they)\\s*(?:[\'’]ll|will)|\\bwill)\\s+(?:keep|continue)\\s+' +
  '(?:monitoring|to monitor|watching|to watch|an eye on (?:it|this|that|things))\\b|' +
  '\\bno (?:further|more|other) actions? (?:is |are )?(?:needed|required|necessary)\\b', 'gi');

/** Whether a reply's own words say it's resolved: a sentence that says so, not a question, a "not yet" or a "will". Pure. */
function outcomeResolved_(text) {
  return (String(text || '').match(/[^.!?\n]+[.!?]*/g) || []).some(s => {
    const t = s.replace(OUTCOME_FOLLOW_UP_RX_, ' ');
    return OUTCOME_RESOLVED_RX_.test(t) && !OUTCOME_NOT_YET_RX_.test(t) && !/\?\s*$/.test(s);
  });
}

/**
 * What one reply on a sent Social Alert shows: [] or e.g. ['Resolved', 'Product replied']. Resolved: its own words say
 * so (from anyone). Product replied: from the product's own alert contacts (PAs, gUP, execs, the engagement add-ons).
 * Comms replied: from a comms team's address or the standard CC list (when it isn't the product's). A testing "[Team] …"
 * reply (m.tag, FollowUp.gs followupTagOf_) counts as its team's: the product's lists and gUP are Product, the comms
 * teams and the standard CC list Comms. Pure.
 */
function outcomeOf_(row, m) {
  const out = [];
  if (m && m.tag) {
    if (outcomeResolved_(m.tag.text)) out.push('Resolved');
    if (m.tag.kind === 'product') out.push('Product replied');
    else if (m.tag.kind === 'comms') out.push('Comms replied');
    return out;
  }
  if (outcomeResolved_(outcomeOwnText_(m && m.snippet))) out.push('Resolved');
  const from = outcomeAddresses_(m);
  const input = (row && row.email_input) || {};
  const product = resolveDistro_((input.escalation || {}).product || (input.fields || {}).product || '').distro;
  const pocs = product ? [].concat(product.pa || [], product.gup || [], product.execs || [],
    ...(product.conditional || []).map(c => c.recipients || [])) : [];
  const comms = GEN.distribution.groups.filter(g => OUTCOME_COMMS_CODES_.includes(g.action_code))
    .reduce((all, g) => all.concat(g.recipients || []), []).concat(GEN.email.default_cc || []);
  const has = list => list.some(a => from.includes(String(a).toLowerCase()));
  if (has(pocs)) out.push('Product replied');
  else if (has(comms)) out.push('Comms replied');
  return out;
}

/**
 * New outcomes for a row ([{label, m}]): the `outcome` column first (if that write fails, nothing is noted: it's tried
 * again on the next read), then one note under the alert in the analyst space per reply (key outcome:<id>:<labels>).
 * The T&S confirmation's time goes on the row with it (email_input.followup.tns_at), for the Follow-up tab.
 */
function recordOutcomes_(ctx, row, found, report) {
  const before = String(row.outcome || '');
  const fresh = (found || []).filter((f, i, all) => f && f.label && !hasOutcome_(before, f.label) &&
    all.findIndex(x => x && x.label === f.label) === i);
  if (!fresh.length) return 0;
  const next = fresh.reduce((s, f) => mergeOutcome_(s, f.label), before);
  const patch = { outcome: next };
  const input = row.email_input;
  if (input && typeof input === 'object' && fresh.some(f => f.label === 'T&S confirmed')) {
    patch.email_input = Object.assign({}, input, { followup: Object.assign({}, input.followup || {}, { tns_at: ctx.now() }) });
  }
  ctx.store.updateAlert(row, patch);
  report.outcomes = (report.outcomes || 0) + fresh.length;
  const byReply = [];  // one note per reply (a reply can show two), T&S on its own
  fresh.forEach(f => {
    const same = byReply.find(b => b.m && b.m === f.m);
    if (same) same.labels.push(f.label);
    else byReply.push({ m: f.m, labels: [f.label] });
  });
  byReply.forEach(b => postDraftNote_(ctx, row, outcomeNoteText_(b.labels, b.m),
    `outcome:${row.alert_id}:${outcomeParts_(mergeOutcome_('', b.labels.join(' · '))).join('+')}`));
  countOutcomes_(ctx, fresh.length);
  return fresh.length;
}

/** Who sent a reply, as a person reads it: the name in its From (or Sender), else the address, else "someone". Pure. */
function outcomeWho_(m) {
  const raw = String(((m && m.headers) || {}).from || ((m && m.headers) || {}).sender || '');
  const addr = (raw.match(ADDRESS_RX_) || [''])[0];
  const name = raw.replace(/\s*<[^>]*>\s*$/, '').replace(/^"+|"+$/g, '').replace(/[<>]/g, '').trim();
  return name && name.toLowerCase() !== addr.toLowerCase() ? name : (addr || 'someone');
}

/**
 * The note under the alert: "🤖 Outcome: Comms replied (Jane Doe, on the Social Alert's email thread): "…"", or for the T&S
 * confirmation "🤖 Outcome: T&S confirmed (the WD Intake Request confirmation email came in)". A testing "[Team] …" reply
 * names its team. No < or > from the reply (they'd be Chat links or mentions). Pure.
 */
function outcomeNoteText_(labels, m) {
  const what = mergeOutcome_('', (labels || []).join(' · '));
  if (!m) return `Outcome: ${what}\n- Source: WD Intake Request confirmation email received.`;
  if (m.tag) {
    const said = truncate_(String(m.tag.text || '').replace(/[<>]/g, ''), OUTCOME_QUOTE_MAX_);
    return `Outcome: ${what}\n- From: ${m.tag.name} (testing reply on the Social Alert's email thread)` +
      `${said ? `\n- Message: "${said}"` : ''}`;
  }
  const who = outcomeWho_(m);
  const quote = truncate_(outcomeOwnText_(m.snippet).replace(/[<>]/g, ''), OUTCOME_QUOTE_MAX_);
  return `Outcome: ${what}\n- From: ${who} (on the Social Alert's email thread)${quote ? `\n- Message: "${quote}"` : ''}`;
}

/**
 * checkTnsEmails_ (Drafts.gs) found the T&S confirmation email for this alert (switch ON): "T&S confirmed", with its
 * note. Does nothing when the switch is OFF. Never throws.
 */
function tnsConfirmedOutcome_(ctx, row, report) {
  if (!switchOn_(ctx, 'trackOutcomes') || !row) return;
  try {
    recordOutcomes_(ctx, row, [{ label: 'T&S confirmed', m: null }], report);
  } catch (e) {
    ctx.log(`couldn't record the T&S confirmation as ${row.alert_id}'s outcome: ${(e && e.message) || e}`);
  }
}

/** Today's count of new outcomes (ctx.memo 'outcome_day'), for the Control tab. Never throws. */
function countOutcomes_(ctx, n) {
  try {
    const day = Utilities.formatDate(new Date(ctx.now()), GEN.timezone, 'yyyy-MM-dd');
    const t = JSON.parse(ctx.memo.get('outcome_day') || 'null');
    ctx.memo.set('outcome_day', JSON.stringify({ day, n: (t && t.day === day ? Number(t.n) || 0 : 0) + n }));
  } catch (e) { /* only the count on the Control tab */ }
}

/**
 * Column C of the switch: how many sent alerts are tracked, the last check, and today's outcomes, for the main space,
 * the auto-correct space and the Other alerts space together (each has its own list; script property OUTCOME_FLOWS keeps
 * each one's figures under its own key). A space that hasn't checked for 3 hours is left out of "tracking"; its outcomes
 * today stay. Never throws.
 */
function noteOutcomes_(ctx, watching) {
  try {
    const at = ctx.now();
    const now = new Date(at);
    const day = Utilities.formatDate(now, GEN.timezone, 'yyyy-MM-dd');
    let n = 0;
    try {
      const t = JSON.parse(ctx.memo.get('outcome_day') || 'null');
      n = t && t.day === day ? Number(t.n) || 0 : 0;
    } catch (e) {
      n = 0;
    }
    const props = PropertiesService.getScriptProperties();
    let flows = {};
    try { flows = JSON.parse(props.getProperty(OUTCOME_FLOWS_PROP_) || '{}') || {}; } catch (e) { flows = {}; }
    if (typeof flows !== 'object' || Array.isArray(flows)) flows = {};
    flows[ctx.sourceReadOnly ? 'ac' : ctx.otherSpace ? 'os' : 'main'] = { watching, day, n, at };
    props.setProperty(OUTCOME_FLOWS_PROP_, JSON.stringify(flows));
    const all = Object.keys(flows).map(k => flows[k] || {});
    const tracked = all.filter(f => at - Number(f.at || 0) < OUTCOME_FLOW_FRESH_MS_)
      .reduce((sum, f) => sum + (Number(f.watching) || 0), 0);
    const today = all.filter(f => f.day === day).reduce((sum, f) => sum + (Number(f.n) || 0), 0);
    const blocked = props.getProperty(FOLLOWUP_BLOCKED_PROP_) === 'true' ? ` · ${FOLLOWUP_BLOCKED_NOTE_}` : '';
    noteSwitch_('trackOutcomes', `tracking ${tracked} sent alert${tracked === 1 ? '' : 's'} · last check ` +
      `${Utilities.formatDate(now, GEN.timezone, 'MMM d, h:mm a z')} · ${today} outcome${today === 1 ? '' : 's'} today${blocked}`);
  } catch (e) {
    console.error('could not note what Track post-alert outcomes did: ' + ((e && e.message) || e));
  }
}
