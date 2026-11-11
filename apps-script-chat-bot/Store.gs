/**
 * Store.gs — what the bot remembers: one row per Zapier alert and one row per Burson message it handled.
 *
 * Pure lookup logic over a backend (Sheets.gs in Apps Script, an in-memory backend in tests). Rows are plain
 * objects; the backend persists them. Nothing here calls Apps Script services.
 *
 * alerts:   alert_id, created_at, space, source_message, source_thread, record_key, author, issue_tokens,
 *           exposure_tag, status, requested, forwarded_fields, forward_message, forward_thread, burson_done, mirrored,
 *           feedback, resend_of, updated_at, source_at, and the Social Alert draft (Drafts.gs): email_status, email_input,
 *           email_draft, email_thread, email_reply_to, email_subject, email_groups, email_message_id, email_at,
 *           email_sent_at, email_sent_by, email_attempts, email_error
 *           space: "<Burson space> > <analyst space>": alert queries only see rows for the pair in use, so changing
 *                  either space on the Control tab never mixes old alerts with new ones
 *           status: ok | fix_requested (Burson was asked to fix it and resend; with "Never wait on Burson" ON, the bot
 *                   corrected it and told Burson, and doesn't wait: a resend is matched to it) | fixed | superseded
 *           forwarded_fields: the key values analysts have on the forwarded copy (to spot what a resend changed), and
 *                  link_found {how, confidence, author?} when the link is the one the bot found (Auto-find missing links)
 *           burson_done: the 👍 / fix request (or what-the-bot-changed note) in the Burson space went out (false = redo it
 *                  on the next run)
 *           source_at: when the alert reached the live Burson space (ms; the Mirror's original post), for the Speed tab
 *           seen_at: when the bot picked the alert up (ms): source_at -> seen_at is waiting to be picked up, seen_at ->
 *                    created_at is its review (post lookup, BigQuery, Gemini), created_at -> email_sent_at is sending
 *           email_status: '' (not escalated) | pending | drafted | sent | discarded (deleted in Gmail) | deleted (❌) | failed
 *           decision: why there was no Social Alert (❌ "…", or a T&S form only), for the Results tab (Speed.gs)
 *           knowledge_used: the knowledge base documents Gemini relied on ([{document, used_for}], Knowledge.gs)
 *           tns_submitted: when the bot submitted the T&S form itself (ms; "Auto-submit T&S form" switch), so no retry
 *                          or later alert on the same post submits it again
 *           bq_written: when the alert was written back to the SLRR BigQuery tables (ms; "Write back to SLRR BigQuery")
 *           outcome: what happened after the Social Alert ("Track post-alert outcomes", Outcomes.gs): T&S confirmed |
 *                    Comms replied | Product replied | Resolved, several joined by " · " (strongest first, never removed)
 *           ingested: where the alert came from when the bot posted it itself from BigQuery ("Direct BigQuery alerts"):
 *                     Sprinklr | BMIE | BSIP; '' for Burson's. The Results tab leaves those rows out (Burson didn't post them)
 *           live_message, live_thread: in the Mirror space, the live S-F Burson message (and its thread) this alert is a
 *                     copy of (Mirror.gs rememberMirrorPair_, the Relay tab), kept for good so the bot's own Burson replies
 *                     and emojis, days later, still go on the right S-F Burson message (Outbox.gs ownSfbBehind_)
 * messages: message, created_at, kind, alert_id, attempts, error
 *           kind: alert | resend | question | ack | ignored | own | own_post | raw_forward | dead | failed
 * A second flow over the same messages (the auto-correct test space reads the live Burson space) keeps its own message
 * rows with `msgPrefix` ("ac|spaces/…/messages/…"), so neither flow ever sees the other's as done. What is done once
 * per post whichever flow did it (the T&S form the bot submits) looks across both: rowsForRecord(record_key).
 */

const EMAIL_COLUMNS_ = ['email_status', 'email_input', 'email_draft', 'email_thread', 'email_reply_to', 'email_subject',
  'email_groups', 'email_message_id', 'email_at', 'email_sent_at', 'email_sent_by', 'email_attempts', 'email_error'];
const ALERT_COLUMNS_ = ['alert_id', 'created_at', 'space', 'source_message', 'source_thread', 'record_key', 'author',
  'issue_tokens', 'exposure_tag', 'status', 'requested', 'forwarded_fields', 'forward_message', 'forward_thread',
  'burson_done', 'mirrored', 'feedback', 'resend_of', 'updated_at'].concat(EMAIL_COLUMNS_,
  ['source_at', 'seen_at', 'decision', 'knowledge_used', 'tns_submitted', 'bq_written', 'outcome', 'ingested',
    'live_message', 'live_thread']);
const MESSAGE_COLUMNS_ = ['message', 'created_at', 'kind', 'alert_id', 'attempts', 'error'];
const JSON_COLUMNS_ = ['issue_tokens', 'requested', 'forwarded_fields', 'email_input', 'knowledge_used'];
const OBJECT_COLUMNS_ = ['forwarded_fields', 'email_input'];  // JSON columns that hold an object (the rest hold lists)
const RESEND_MIN_SIMILARITY_ = 0.8;  // issue-name similarity for matching a resend when the original had no link

/**
 * An alert row Burson's resend can answer: one Burson was asked to fix (fix_requested), or one whose link the bot found
 * itself. With "Never wait on Burson" ON (noWait: Control row 23), also the latest resend of an alert (a resend Burson
 * sends again is the same alert, never a new one); OFF, a fixed resend is done, as it always was.
 */
function resendOpen_(a, noWait) {
  if (!a) return false;
  if (a.status === 'fix_requested' || (['ok', 'fixed'].includes(a.status) && linkFoundRow_(a))) return true;
  return !!noWait && a.status === 'fixed' && !!a.resend_of;
}

/**
 * `observer` (optional: Main.gs buildCtx_ passes AlertMemory.gs amStoreObserver_): {loaded(rows), added(row)}, told of
 * every Alert-log row this store reads (every space's) and adds, so the shared alert memory sees what every flow
 * handled. Its failures never reach the store.
 */
function makeStore_(backend, nowFn, partition, msgPrefix, observer) {
  const now = nowFn || (() => Date.now());
  const all = backend.loadAlerts();
  const tell = (what, arg) => {
    if (observer && typeof observer[what] === 'function') {
      try { observer[what](arg); } catch (e) { /* the memory's own problem: the store goes on */ }
    }
  };
  tell('loaded', all);
  const alerts = all.filter(a => !partition || a.space === partition);
  const messages = backend.loadMessages().slice();
  const byMessage = new Map(messages.map(r => [r.message, r]));
  const key = name => (msgPrefix || '') + name;  // this flow's own message rows

  const latest = rows => rows.reduce((best, r) => (!best || Number(r.created_at) >= Number(best.created_at) ? r : best), null);
  const sameAuthor = (a, b) => String(a || '').replace(/^[@\s]+/, '').toLowerCase() === String(b || '').replace(/^[@\s]+/, '').toLowerCase();

  return {
    alerts, messages,

    isDone(name) { const r = byMessage.get(key(name)); return !!r && r.kind !== 'failed'; },
    isOwnPost(name) { const r = byMessage.get(key(name)); return !!r && r.kind === 'own_post'; },

    markDone(name, kind, alertId) {
      const r = byMessage.get(key(name));
      if (r) {
        backend.updateMessage(r, { kind, alert_id: alertId || r.alert_id || '', error: kind === 'dead' ? r.error : '' });
      } else {
        const row = backend.appendMessage({ message: key(name), created_at: now(), kind, alert_id: alertId || '', attempts: 0, error: '' });
        messages.push(row);
        byMessage.set(key(name), row);
      }
    },

    markFailed(name, error) {
      const r = byMessage.get(key(name));
      const attempts = (r ? Number(r.attempts || 0) : 0) + 1;
      if (r) backend.updateMessage(r, { kind: 'failed', attempts, error: String(error).slice(0, 500) });
      else {
        const row = backend.appendMessage({ message: key(name), created_at: now(), kind: 'failed', alert_id: '', attempts, error: String(error).slice(0, 500) });
        messages.push(row);
        byMessage.set(key(name), row);
      }
      return attempts;
    },

    /** How many tries at this message failed so far: an error, or a run that ended partway through it (Bot.gs crashGuard_). */
    attempts(name) { const r = byMessage.get(key(name)); return r ? Number(r.attempts || 0) : 0; },

    recordOwnPost(name) { if (name && !byMessage.has(key(name))) this.markDone(name, 'own_post'); },

    addAlert(obj) {
      const row = backend.appendAlert(Object.assign(
        { created_at: now(), updated_at: now(), space: partition || '', mirrored: '', feedback: '', resend_of: '' }, obj));
      alerts.push(row);
      tell('added', row);
      return row;
    },

    updateAlert(row, patch) { backend.updateAlert(row, Object.assign({}, patch, { updated_at: now() })); },

    nextAlertId() { return backend.nextId(); },

    alertBySource(messageName) { return alerts.find(a => a.source_message === messageName) || null; },

    alertById(alertId) { return alerts.find(a => a.alert_id === alertId) || null; },

    /**
     * The alert a new one resends, within the window (resendOpen_; noWait: "Never wait on Burson" is ON): the same post
     * (same link), or, when the original was missing its link, a near-identical issue name from the same author (when
     * both authors are known). An alert whose link the bot found (Auto-find missing links: linkFoundRow_) counts as one
     * missing its link, as with the switch OFF: still open when nothing else was asked, so Burson's resend is never
     * taken for a new alert.
     */
    findPendingFix(recordKey, issueTokens, sinceMs, author, noWait) {
      // never an alert the bot took from BigQuery itself (Direct BigQuery alerts): Burson has no fix of its own to send
      const open = alerts.filter(a => resendOpen_(a, noWait) && !a.ingested && Number(a.created_at) >= sinceMs);
      if (recordKey) {
        const byKey = open.filter(a => a.record_key === recordKey);
        if (byKey.length) return latest(byKey);
      }
      const similar = open.filter(a => (!a.record_key || linkFoundRow_(a)) && (issueTokens || []).length &&
        jaccard_(issueTokens, a.issue_tokens || []) >= RESEND_MIN_SIMILARITY_ && (!author || !a.author || sameAuthor(author, a.author)));
      return latest(similar);
    },

    /**
     * Forwarded alerts since `sinceMs` (14-day novelty history, and what a follow-up may follow up on). Resends aren't
     * separate alerts: the original row keeps the email; the values and emojis come from the latest (live) row.
     */
    recentForwarded(sinceMs) {
      const liveOf = new Map();  // forward_message -> its latest row (a resend replaces the original as the live post)
      alerts.forEach(x => {
        const cur = x.forward_message && liveOf.get(x.forward_message);
        if (x.forward_message && (!cur || Number(x.created_at) >= Number(cur.created_at))) liveOf.set(x.forward_message, x);
      });
      return alerts.filter(a => a.forward_message && !a.resend_of && Number(a.created_at) >= sinceMs)
        .map(a => {
          const live = liveOf.get(a.forward_message) || a;
          return { alert_id: a.alert_id, author: live.author || a.author || '', exposure_tag: a.exposure_tag,
            issue_tokens: a.issue_tokens || [], record_key: a.record_key, created_at: Number(a.created_at),
            forward_message: a.forward_message, fields: live.forwarded_fields || a.forwarded_fields || {},
            mirrored: live.mirrored || a.mirrored || '', email_status: a.email_status || '', email_thread: a.email_thread || '',
            email_message_id: a.email_message_id || '', email_subject: a.email_subject || '',
            team_emails: Array.isArray((a.email_input || {}).team_emails) ? a.email_input.team_emails : undefined,
            ingested: a.ingested || '', decision: live.decision || a.decision || '',
            tns_submitted: Number(live.tns_submitted || a.tns_submitted) || 0 };
        });
    },

    /**
     * Forwarded alerts since `sinceMs` across all non-autocorrect spaces (read-only cross-space memory for the Other alerts
     * space, B33, so it sees what the Burson / Mirror space already alerted without ever replying onto another space's
     * Gmail thread: cross-space rows carry no email_thread / email_message_id / email_subject).
     */
    recentForwardedAcrossSpaces(sinceMs) {
      const acSuffix = typeof AC_PARTITION_SUFFIX_ === 'string' ? AC_PARTITION_SUFFIX_ : ' (auto-correct)';
      const allowAc = !!(partition && String(partition).endsWith(acSuffix));
      const seenRows = new Set(all);
      const pool = all.concat(alerts.filter(a => !seenRows.has(a)))
        .filter(a => allowAc || !String(a.space || '').endsWith(acSuffix));
      const liveKey = x => `${x.space || ''}\n${x.forward_message || ''}`;
      const liveOf = new Map();
      pool.forEach(x => {
        if (!x.forward_message) return;
        const k = liveKey(x);
        const cur = liveOf.get(k);
        if (!cur || Number(x.created_at) >= Number(cur.created_at)) liveOf.set(k, x);
      });
      return pool.filter(a => a.forward_message && !a.resend_of && Number(a.created_at) >= sinceMs)
        .sort((a, b) => ((b.space === partition) - (a.space === partition)) || (Number(b.created_at) - Number(a.created_at)))
        .map(a => {
          const live = liveOf.get(liveKey(a)) || a;
          const cross = !!(partition && a.space !== partition);
          return { alert_id: a.alert_id, author: live.author || a.author || '', exposure_tag: a.exposure_tag,
            issue_tokens: a.issue_tokens || [], record_key: a.record_key, created_at: Number(a.created_at),
            forward_message: cross ? '' : a.forward_message, fields: live.forwarded_fields || a.forwarded_fields || {},
            mirrored: live.mirrored || a.mirrored || '', email_status: a.email_status || '',
            email_thread: cross ? '' : (a.email_thread || ''),
            email_message_id: cross ? '' : (a.email_message_id || ''),
            email_subject: cross ? '' : (a.email_subject || ''),
            team_emails: !cross && Array.isArray((a.email_input || {}).team_emails) ? a.email_input.team_emails : undefined,
            ingested: a.ingested || '', decision: live.decision || a.decision || '',
            tns_submitted: Number(live.tns_submitted || a.tns_submitted) || 0,
            cross_space: cross, space: a.space || '' };
        });
    },

    alertByThread(thread) { return thread ? latest(alerts.filter(a => a.source_thread === thread)) : null; },

    /** The latest Burson post for a forwarded copy (a resend replaces the original as the live post). */
    alertByForward(forwardName) { return latest(alerts.filter(a => a.forward_message === forwardName)); },

    /** The alert row for a thread in the analyst space (replies under a forwarded alert). */
    alertByForwardThread(thread) { return thread ? latest(alerts.filter(a => a.forward_thread === thread)) : null; },

    /** The row holding a forwarded alert's Social Alert draft (the original alert, even after Burson resends it). */
    emailRowByForward(forwardName) {
      return latest(alerts.filter(a => a.forward_message === forwardName && a.email_status));
    },

    /**
     * Every row for a post (record_key) in any space pair, this flow's new rows included: what is done once per post,
     * whichever flow did it (the Mirror / main flow and the auto-correct flow see the same live posts).
     */
    rowsForRecord(recordKey) {
      if (!recordKey) return [];
      const seen = new Set(all);
      return all.concat(alerts.filter(a => !seen.has(a))).filter(a => a.record_key === recordKey);
    },
  };
}

/**
 * The alert row's link is the one the bot found (Auto-find missing links, Bot.gs foundLinkMark_): Burson's alert had
 * none. Only rows made while that switch was ON have the mark. Pure.
 */
function linkFoundRow_(row) {
  return !!(row && row.forwarded_fields && row.forwarded_fields.link_found);
}

/** In-memory backend (tests). */
function memoryBackend_() {
  let seq = 1000;
  return {
    alerts: [], messages: [],
    loadAlerts() { return this.alerts; },
    loadMessages() { return this.messages; },
    appendAlert(obj) { const row = Object.assign({}, obj); this.alerts.push(row); return row; },
    appendMessage(obj) { const row = Object.assign({}, obj); this.messages.push(row); return row; },
    updateAlert(row, patch) { Object.assign(row, patch); },
    updateMessage(row, patch) { Object.assign(row, patch); },
    nextId() { seq += 1; return 'QA-' + seq; },
  };
}
