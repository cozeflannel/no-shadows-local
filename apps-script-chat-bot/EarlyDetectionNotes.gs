/**
 * EarlyDetectionNotes.gs — what became of every story signal Early Detection found (Control row 19).
 *
 * A signal is a group of posts from small accounts that the bot's own producer (EarlyWaveSource.gs) hands to the
 * 15-minute check (BigQuery.gs earlyWaveCheck_): a story, an early signal, or a jump in pace. From there it waits in
 * the review queue, or it ENDS: a card, an update in an earlier card's thread, a dismissal, a hold, a repeat, never
 * reviewed, and so on (ED_OUTCOMES_: these names and no others). Every ending goes through ONE function, edNote_,
 * which
 *   - counts it in today's numbers (BigQuery.gs edCount_, in the script property EARLY_DETECTION_TODAY), so that they
 *     add up, always: found = cards + under another alert + let go + never reviewed + waiting (BigQuery.gs
 *     edDayNumbers_ hands them out);
 *   - puts one row in the run's record (edNotesOfRun_ hands the rows out; Main.gs empties them at each run's start).
 *     A row is ready to show: its story, kind, tag, reason and card are worded here, and the Early Detection tab only
 *     lays the rows out;
 *   - writes one line in the run log when the ending has none of its own.
 * It posts nothing, sends nothing to BigQuery (what Control row 46 writes is made elsewhere and stays as it is) and
 * never throws.
 *
 * Counted once. An ending that marks its signal as seen (most do) can't come twice. The few that leave it unmarked (the
 * day's limit of the old rule, the early watch's share of the day, an early signal read while row 39 is OFF, a main post
 * another alert covers) meet the same signal again at every check while the producer's buffer holds it: edNote_ is told
 * so (`once`), and the signal's key is kept with the day's counts, so it is noted the first time only, with the script
 * cache gone too. A signal noted that way and queued later on (the next day, or when what covered it has aged out) is a
 * new arrival: it is counted as found again, and the numbers still add up.
 *
 * A record row is a list, in the order of ED_NOTE_FIELDS_ (edNoteObj_ gives it its names):
 *   at         when the ending was noted (ms)
 *   id         the signal's id
 *   outcome    one of ED_OUTCOMES_, always whole
 *   why        one sentence in plain words: no decimals of the bot's own, no internal names
 *   story      the review's headline when the story was reviewed (a dismissal too), else a plain title made from the
 *              signal (EarlyDetection.gs edFallbackTitle_: "6 accounts posting “…”"), for a count on a topic "Topic:
 *              Search & Shopping, 36 accounts in an hour (1.9x the usual)"; never the producer's own label
 *   link       the main post's link ('' when it is none, or too long to keep whole)
 *   kind       Story · Early signal (3-4 accounts) · Pace jump (story) · Pace jump (topic) · Pace jump (risk words)
 *   accounts   how many accounts the signal had
 *   platforms  "X, Reddit"
 *   tag        the Exposure Tag, as a first guess: after a card the card's own tag; else the fast triage's answer
 *              ("Content - … (32% sure) · severity low"); else the signal's risk words in plain words; else "-"
 *   card       the Alert-log id of the card this is about, when there is one: the card just posted, the earlier card
 *              an update went under or a repeat tells again, the alert that covers the main post
 *   message    that card's Chat message name ('' when there is none)
 * A row's JSON is at most ED_NOTE_ROW_MAX_ characters (edNoteFit_), so 200 rows fit one 90,000-character cache value.
 */

// What can become of a signal. edNote_ takes these names and no others; today's numbers are counted by them
// (ED_OUT_GROUPS_) and the Early Detection tab shows them as they are written here.
const ED_OUT_ = {
  cardAlert: 'Card posted: Social Alert',
  cardMonitor: 'Card posted: Monitor build-up',
  cardHuman: 'Card posted: Needs a human look',
  update: 'Update added to its earlier card',
  under: 'Added under another alert\'s card',
  dismissed: 'Reviewed and dismissed',
  noise: 'Held back as noise (no review)',
  repeat: 'Seen before, nothing new',
  covered: 'Its main post already has an alert',
  notEnglish: 'Not English',
  topic: 'Topic busier than usual, not a story',
  never: 'Never reviewed',
  noCard: 'Reviewed, but its card could not be posted',
};
const ED_OUTCOMES_ = Object.keys(ED_OUT_).map(k => ED_OUT_[k]);
// Which of today's numbers each outcome counts in (Control C19: "C cards, U under another alert, L let go, N never
// reviewed"; BigQuery.gs edCount_)
const ED_OUT_GROUPS_ = {
  cards: [ED_OUT_.cardAlert, ED_OUT_.cardMonitor, ED_OUT_.cardHuman, ED_OUT_.update],
  under: [ED_OUT_.under],
  letgo: [ED_OUT_.dismissed, ED_OUT_.noise, ED_OUT_.repeat, ED_OUT_.covered, ED_OUT_.notEnglish, ED_OUT_.topic, ED_OUT_.noCard],
  never: [ED_OUT_.never],
};

const ED_NOTE_FIELDS_ = ['at', 'id', 'outcome', 'why', 'story', 'link', 'kind', 'accounts', 'platforms', 'tag', 'card', 'message'];
const ED_NOTE_ROW_MAX_ = 448;      // a row's JSON: 200 rows, with the commas and brackets around them, stay under 90,000
const ED_NOTE_WHY_MAX_ = 180;      // a row's reason and title before the row is made to fit
const ED_NOTE_STORY_MAX_ = 100;
const ED_NOTE_LINK_MAX_ = 150;     // a longer link is left out: a link is kept whole or not at all
const ED_NOTES_RUN_MAX_ = 200;     // rows kept for one run (the newest)
let ED_NOTES_RUN_ = [];            // this run's record rows, in the order they were noted

// The producer's risk-word groups (EarlyWaveSource.gs EWS_RISK_GROUPS_) in plain words
const ED_RISK_WORDS_ = {
  privacy_data_leak: 'Privacy or data leak',
  safety_csam_selfharm: 'Child safety or self-harm',
  security_scam_malware: 'Scam, phishing or malware',
  outage_broken_feature: 'Outage or broken feature',
  ai_hallucination_bias: 'AI answer wrong or biased',
  legal_antitrust_layoffs: 'Legal, antitrust or layoffs',
};

/** A new run: its record starts empty (Main.gs poll(), beside outboxRunStart_). */
function edNotesStart_() {
  ED_NOTES_RUN_ = [];
}

/** The rows this run recorded so far (copies, oldest first): what became of each signal that ended in it. */
function edNotesOfRun_() {
  return ED_NOTES_RUN_.map(r => r.slice());
}

/** A record row with its names: {at, id, outcome, why, story, link, kind, accounts, platforms, tag, card, message}. Pure. */
function edNoteObj_(row) {
  const out = {};
  ED_NOTE_FIELDS_.forEach((name, i) => { out[name] = Array.isArray(row) ? row[i] : undefined; });
  return out;
}

/** Which of today's numbers `outcome` counts in: 'cards', 'under', 'letgo' or 'never'; '' when it is not an outcome. Pure. */
function edOutcomeGroup_(outcome) {
  return Object.keys(ED_OUT_GROUPS_).find(g => ED_OUT_GROUPS_[g].indexOf(outcome) >= 0) || '';
}

/**
 * Why a signal was never reviewed, in the words the record shows, for the causes today's rules have: 'day' (the old
 * rule's daily limit), 'watchDay' (the early watch's share of the day), 'watchOff' (rows 38 and 39), 'full' and
 * 'pushed' (the review queue), 'stale' (it waited too long), 'failed' (its review didn't finish, twice), 'lost' (its
 * stored row was gone), 'long' (its row was too big to store). '' for any other. Pure.
 */
function edNeverWhy_(cause) {
  const hours = Math.round(ED_QUEUE_MAX_AGE_MS_ / 3600000);
  const why = {
    day: `today's limit of ${EW_MAX_PER_DAY_} was reached`,
    watchDay: `today's ${EW_WATCH_QUEUE_PER_DAY_} early signals were used`,
    watchOff: 'early signals are switched OFF (row 39)',
    full: 'the review queue was full',
    pushed: 'pushed out of the full queue by higher-ranked stories',
    stale: `waited ${hours} hours while the bot worked on alerts`,
    failed: 'its review failed twice',
    lost: 'its saved details were gone when its turn came',
    long: 'its details were too long to keep for a review',
  };
  return why[cause] || '';
}

/**
 * Notes what became of signal `row` (a row the producer handed over, or a queued one; edEntryRow_ when only its queue
 * entry is left): the ONE place an ending is counted and recorded. `outcome`: one of ED_OUTCOMES_; any other name is
 * refused (an error in the log, nothing counted or recorded). `why`: the reason, in plain words (made one sentence).
 * `extra`:
 *   waited   true when the signal was in the review queue: it was counted as found when it was queued
 *   once     true for an ending that leaves the signal unmarked, so that the next check reads it again: it is noted
 *            the first time only (a signal with no id of its own, which can't be marked, is always noted that way)
 *   logged   true when the run log already has a line for this ending; without it one line is written here
 *   title    the review's headline, when the signal was reviewed
 *   tag      the card's own Exposure Tag, after a card
 *   dec      the fast triage's answers about the signal, when the caller has them (else the ones kept are used)
 *   card     {id, message}: the Alert-log id and Chat message name of the card this ending is about
 * Returns the record row, or null when nothing was noted (not an outcome; a `once` signal noted before). Never throws.
 */
function edNote_(ctx, row, outcome, why, extra) {
  try {
    const x = extra || {};
    const group = edOutcomeGroup_(outcome);
    if (!group) {
      console.error(`early detection: "${outcome}" is not one of the outcomes, so nothing was noted`);
      return null;
    }
    const r = row && typeof row === 'object' ? row : {};
    const id = String(r.alert_id || '').trim();
    const once = x.once || (!id && !x.waited) ? id || edRowKeys_(r)[0] || 'a signal without an id' : '';
    if (!edCount_(PropertiesService.getScriptProperties(), group, !!x.waited, once)) return null;
    const rec = edNoteRow_(r, outcome, why, x, ctx && typeof ctx.now === 'function' ? ctx.now() : Date.now());
    ED_NOTES_RUN_.push(rec);
    if (ED_NOTES_RUN_.length > ED_NOTES_RUN_MAX_) ED_NOTES_RUN_ = ED_NOTES_RUN_.slice(-ED_NOTES_RUN_MAX_);
    if (!x.logged && ctx && typeof ctx.log === 'function') {
      const told = edNoteObj_(rec);
      ctx.log(`early detection: ${outcome} \u00b7 "${told.story}" \u00b7 ${told.why}`);
    }
    return rec.slice();
  } catch (e) {
    console.error('early detection: could not note what became of a signal: ' + ((e && e.message) || e));
    return null;
  }
}

/**
 * Notes what a queued signal's turn ended in, right after it left the queue (EarlyDetection.gs edDrainQueue_). `row`:
 * its stored row (null when it was gone: never reviewed); `res`: what edReviewAndPost_ returned: a card (which kind the
 * call says; an update goes on record with the earlier card it went under and what is new), a review that found the
 * posts not English or the issue already alerted, a dismissal, or a card Chat gave no message for. Never throws.
 */
function edNoteReviewed_(ctx, entry, row, res) {
  if (!row || !res) return edNote_(ctx, row || edEntryRow_(entry), ED_OUT_.never, edNeverWhy_('lost'), { waited: true });
  const call = res.call || {};
  const x = { waited: true, logged: true, title: call.title || '' };
  if (res.card && res.updated) {
    const was = res.earlier || {};
    return edNote_(ctx, row, ED_OUT_.update, was.news || call.reason,
      Object.assign(x, { tag: call.tag, card: { id: was.id, message: was.message } }));
  }
  if (res.card) {
    const outcome = call.disposition === 'escalate' ? ED_OUT_.cardAlert
      : call.basis === 'failed' ? ED_OUT_.cardHuman : ED_OUT_.cardMonitor;
    return edNote_(ctx, row, outcome, call.reason || call.why,
      Object.assign(x, { tag: call.tag, card: { id: res.logged, message: res.card.name } }));
  }
  if (res.held && call.basis === 'non_english') {
    const lang = (/^non-English signal \(([^)]+)\)/.exec(String(res.held)) || [])[1] || '';
    return edNote_(ctx, row, ED_OUT_.notEnglish, `The posts are not in English${lang ? ` (${lang})` : ''}`, x);
  }
  if (res.held) return edNote_(ctx, row, ED_OUT_.repeat, res.held, x);
  if (res.dismissed) {
    const topic = call.basis === 'evergreen' ? (/"([^"]+)"/.exec(String(res.dismissed)) || [])[1] || '' : '';
    return edNote_(ctx, row, ED_OUT_.dismissed,
      call.basis === 'evergreen' ? `Its topic is always around in the listening data${topic ? ` ("${topic}")` : ''}`
        : call.reason || res.dismissed, x);
  }
  return edNote_(ctx, row, ED_OUT_.noCard, 'Chat gave no message back for the card', Object.assign(x, { logged: false }));
}

/** What is known of a queued signal whose stored row is gone, shaped as a row: from its queue entry ({id, pri, au, sig}). Pure. */
function edEntryRow_(entry) {
  const e = entry || {};
  const id = String(e.id || '');
  const grain = e.sig === 'v' ? (id.match(/^ED-VEL-(CLUSTER|PRIORITY_TOPIC|RISK_TERM_GROUP)-/) || [])[1] || 'CLUSTER' : '';
  return {
    alert_id: id,
    signal_type: e.sig === 'v' ? 'VELOCITY_SPIKE' : e.sig === 'w' ? EWS_WATCH_SIGNAL_ : 'CLUSTER_EMERGENCE',
    velocity_grain: grain,
    unique_low_tier_authors: ewCount_(e.au),
    priority_hint: String(e.pri || ''),
  };
}

/** The record row of one ending (ED_NOTE_FIELDS_), every value cleaned and capped, made to fit (edNoteFit_). */
function edNoteRow_(row, outcome, why, extra, now) {
  const r = row || {};
  const x = extra || {};
  const one = (v, n) => truncate_(String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(), n);
  const bare = (v, n) => one(String(v === undefined || v === null ? '' : v).replace(/["\\]/g, ''), n);
  const card = x.card && typeof x.card === 'object' ? x.card : {};
  const link = String(r.primary_url || '').trim();
  const message = String(card.message || '').trim();
  return edNoteFit_([
    Math.round(Number(now) || Date.now()),
    bare(r.alert_id, 80),
    outcome,
    one(edNoteSentence_(why), ED_NOTE_WHY_MAX_),
    one(edNoteStory_(r, x.title), ED_NOTE_STORY_MAX_),
    /^https?:\/\/[^\s"\\<>|]+$/i.test(link) && link.length <= ED_NOTE_LINK_MAX_ ? link : '',
    edNoteKind_(r),
    Math.min(999999, Math.max(0, ewCount_(r.unique_low_tier_authors))),
    bare(r.platforms_csv || (Array.isArray(r.platforms) ? r.platforms.join(', ') : ''), 40),
    one(edNoteTag_(r, x.dec, x.tag), 90),
    bare(card.id, 12),
    /^spaces\/[^\s"\\]+$/.test(message) && message.length <= 100 ? message : '',
  ]);
}

/**
 * A record row cut to ED_NOTE_ROW_MAX_ characters of JSON. Most rows fit as they are. One that doesn't gives up, in this
 * order and each only as far as needed: the end of its why (80 characters stay), the end of its title (50), its tag,
 * the main post's link, the card's message name, then more of the why (30) and of the title (20). The outcome, the
 * signal's id, the kind, the accounts, the platforms and the card's id always stay whole. Pure.
 */
function edNoteFit_(row) {
  const r = row.slice();
  const over = () => JSON.stringify(r).length - ED_NOTE_ROW_MAX_;
  const cut = (name, least) => {
    const i = ED_NOTE_FIELDS_.indexOf(name);
    while (over() > 0 && r[i].length > least) r[i] = truncate_(r[i], Math.max(least, r[i].length - over()));
  };
  const drop = (name, to) => { if (over() > 0) r[ED_NOTE_FIELDS_.indexOf(name)] = to; };
  cut('why', 80);
  cut('story', 50);
  drop('tag', '-');
  drop('link', '');
  drop('message', '');
  cut('why', 30);
  cut('story', 20);
  return r;
}

/** A reason as one sentence: on one line, its first letter a capital, a full stop at its end. Pure. */
function edNoteSentence_(text) {
  const s = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cap = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?\u2026]$/.test(cap) ? cap : `${cap}.`;
}

/** A signal's kind, as the record names it. Pure. */
function edNoteKind_(row) {
  const r = row || {};
  const sig = String(r.signal_type || 'CLUSTER_EMERGENCE').trim().toUpperCase();
  const grain = String(r.velocity_grain || '').trim().toUpperCase();
  if (sig === EWS_WATCH_SIGNAL_) return 'Early signal (3-4 accounts)';
  if (sig !== 'VELOCITY_SPIKE') return 'Story';
  return grain === 'PRIORITY_TOPIC' ? 'Pace jump (topic)' : grain === 'RISK_TERM_GROUP' ? 'Pace jump (risk words)' : 'Pace jump (story)';
}

/**
 * A signal's title for the record: the review's headline (`title`) when it was reviewed; for a count on a topic that
 * wasn't, "Topic: Search & Shopping, 36 accounts in an hour (1.9x the usual)"; else the plain title a card without a
 * review gets (EarlyDetection.gs edFallbackTitle_), made from what the posts say. The producer's own label ("Low-tier
 * claim cluster …", "Early story (3 accounts): …", a risk group's key) never shows. Pure.
 */
function edNoteStory_(row, title) {
  const r = row || {};
  const told = String(title || '').replace(/\s+/g, ' ').trim();
  if (told) return told;
  const sig = String(r.signal_type || 'CLUSTER_EMERGENCE').trim().toUpperCase();
  const grain = String(r.velocity_grain || '').trim().toUpperCase();
  const n = ewCount_(r.unique_low_tier_authors);
  if (sig === 'VELOCITY_SPIKE' && grain === 'PRIORITY_TOPIC') {
    const ratio = Number(r.velocity_ratio) || 0;
    return `Topic: ${ewText_(r.signal_key || r.topic_product || 'not named')}, ${fmtInt_(n)} account${n === 1 ? '' : 's'} in an hour` +
      `${ratio > 0 ? ` (${ratio.toFixed(1)}x the usual)` : ''}`;
  }
  const posts = edRepPosts_(Array.isArray(r.posts) ? r.posts : r.representative_posts_json);
  // a pace jump's label names its grain, and a risk group by its key: its title is made from its first post's words
  const label = sig === 'VELOCITY_SPIKE' ? '' : String(r.headline || '').replace(/^Early story\s*\([^)]*\):?\s*/i, '');
  if (!label.trim() && !posts.some(p => p.snippet)) return 'A story whose details are gone';
  return edFallbackTitle_({ headline: label, distinctAuthors: n }, posts);
}

/**
 * The Exposure Tag for the record, as a first guess: `cardTag` after a card (the card's own); else the fast triage's
 * answer about the signal (`dec`, the answers the signal carries, or the ones kept from an earlier check: FastTriage.gs
 * ftRecall_): its category with how sure it is and the severity; else the signal's risk words in plain words; else "-".
 * Never the producer's P0 / P1 / P2 hint. Never throws.
 */
function edNoteTag_(row, dec, cardTag) {
  if (cardTag) return String(cardTag);
  const r = row || {};
  let d = dec && typeof dec === 'object' ? dec : r.dec && typeof r.dec === 'object' ? r.dec : null;
  if (!d) { try { d = ftRecall_(r.alert_id); } catch (e) { d = null; } }
  if (d && d.c) {
    const what = d.c === DEC_NO_CATEGORY_ ? 'None: not a brand-safety issue' : d.c === DEC_OTHER_RISK_ ? 'A risk no Exposure Tag names' : d.c;
    return `${what} (${Math.round((Number(d.cp) || 0) * 100)}% sure) \u00b7 severity ${ED_SEVERITIES_[d.l] || 'not known'}`;
  }
  const risks = edRiskWords_(r);
  return risks ? `Risk words: ${risks}` : '-';
}

/** A signal's risk-word groups in plain words ("Privacy or data leak; Outage or broken feature"), or ''. Pure. */
function edRiskWords_(row) {
  const r = row || {};
  const keys = String(r.risk_groups || '').split(',').map(s => s.trim()).filter(Boolean);
  if (String(r.velocity_grain || '').trim().toUpperCase() === 'RISK_TERM_GROUP' && r.signal_key) keys.unshift(String(r.signal_key).trim());
  const out = [];
  keys.forEach(k => { if (ED_RISK_WORDS_[k] && out.indexOf(ED_RISK_WORDS_[k]) < 0) out.push(ED_RISK_WORDS_[k]); });
  return out.join('; ');
}

/**
 * The tag a card shows, for the record (the review's call `d`, EarlyDetection.gs edDecide_): the Exposure Tag the review
 * confirmed, or the one it named without being sure enough ("… (unconfirmed, 62% sure)"); '' when its card names none.
 * Without the priority: the card's can come from the producer's hint. Pure.
 */
function edCardTag_(d) {
  if (!d || !d.rev) return '';
  const f = d.fields || {};
  const s = d.rev.slrr;
  if (f.exposure_tag) return String(f.exposure_tag);
  return s && s.is && s.tag ? `${s.tag} (unconfirmed, ${Math.round((Number(s.confidence) || 0) * 100)}% sure)` : '';
}

/**
 * Why the fast triage held a signal back, without decimals: "Looks like routine chatter (93% likely), severity low (60%
 * sure)", or "Looks unrelated to Google (94% likely), …" (`why`: FastTriage.gs ftHoldWhy_'s reason; `dec`: the
 * answers). Pure.
 */
function edNoiseWhy_(dec, why) {
  const d = dec || {};
  const pct = v => Math.round((Number(v) || 0) * 100);
  const severity = `severity ${ED_SEVERITIES_[d.l] || 'low'} (${pct(d.sc)}% sure)`;
  return /^not about Google/i.test(String(why || ''))
    ? `Looks unrelated to Google (${pct(1 - (Number(d.g) || 0))}% likely), ${severity}`
    : `Looks like routine chatter (${pct(d.n)}% likely), ${severity}`;
}

/**
 * Why a signal is a repeat with nothing new (the same-story dedup's `verdict`: EarlyDetection.gs edStoryVerdict_): "Its
 * card of 8:16 AM ET had 6 accounts; 8 now, nothing new", "Its card is already in the space", or, for a story that was
 * queued and has no card, "First seen 10:51 AM ET with 5 accounts; 8 now, nothing new" (`first`: the seen map's entry
 * for its story, earlyWaveSeen_ first()). Pure but for the time zone.
 */
function edRepeatWhy_(row, verdict, first, now) {
  const r = row || {};
  const au = ewCount_(r.unique_low_tier_authors);
  const accounts = n => `${fmtInt_(n)} account${n === 1 ? '' : 's'}`;
  const prior = verdict && verdict.prior;
  if (prior && prior.latest) {
    if (r.alert_id && prior.latest.ed === String(r.alert_id)) return 'Its card is already in the space';
    const when = edCardTime_(prior.latest.at, now);
    return `Its card${when ? ` of ${when}` : ''} had ${accounts(Number(prior.au) || 0)}; ${fmtInt_(au)} now, nothing new`;
  }
  if (first && first.at) {
    const when = edCardTime_(first.at, now);
    return isFinite(first.au) ? `First seen ${when} with ${accounts(first.au)}; ${fmtInt_(au)} now, nothing new`
      : `First seen ${when}; nothing new since`;
  }
  return 'Seen in the last 24 hours, nothing new';
}

/** The earlier card a repeat tells again, for the record's card: {id, message}, or null when its story has no card. Pure. */
function edPriorCard_(verdict) {
  const L = verdict && verdict.prior && verdict.prior.latest;
  return L ? { id: L.row || '', message: L.msg || '' } : null;
}

/** Another alert's Alert-log row as the record's card: {id, message (where it is in the space the analysts read)}. Pure. */
function edAlertCard_(alert) {
  const a = alert || {};
  return { id: a.alert_id || '', message: a.forward_message || a.source_message || '' };
}

/**
 * Another alert in words, from its Alert-log row: "QA-1001 (BigQuery · BSIP, 8:08 AM ET)". Its path is what its
 * `ingested` column says: a Direct BigQuery card with its source, a Burson alert (blank), else the column's own words
 * (Watch alert, Other alert, Sheet test alert). Pure but for the time zone.
 */
function edAlertWords_(alert, now) {
  const a = alert || {};
  const ing = String(a.ingested || '').trim();
  const direct = Object.keys(BQ_SOURCE_LABELS_).some(k => BQ_SOURCE_LABELS_[k] === ing);
  const path = !ing ? 'Burson alert' : direct ? `BigQuery \u00b7 ${ing}` : ing;
  return `${a.alert_id || 'An alert'} (${[path, edCardTime_(a.created_at, now)].filter(Boolean).join(', ')})`;
}
