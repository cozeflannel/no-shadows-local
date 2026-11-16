/**
 * RequirementLine.gs — every alert the bot reviews in the Auto-correct space (B10) says, in its thread, which alert
 * requirement it met or did not meet.
 *
 * No second decision is made here. Each review path already decides whether a Social Alert goes out; requirementLine_
 * only puts that decision into one line, and the line lives in the note the review already posts under the alert:
 *   - Burson's corrected copy, a Direct BigQuery card and a sheet-test card (Bot.gs handleNewAlert_): the last line of
 *     the review's own note (Voice.gs changeNoteText_; the note is that one line when there is nothing else to say).
 *     The decision is read before the note is posted, with the calls that write nothing (Drafts.gs escalationFor_ and
 *     aiVeto_ on a copy of the review, whether emails are made at all in this run, and what the caller knows already:
 *     requirementOf_). One more line follows as a note of its own (requirementFinal_, through ThreadNotes.gs
 *     acThreadNote_), "*Alert requirements, final:* …", when the Social Alert then goes another way than the line
 *     says, or when the note in the thread is an earlier attempt's and says otherwise (the note is posted once per
 *     alert: requirementNoted_).
 *   - a Watch alert's triage note (OtherAlerts.gs) and an Early Detection card's review note (EarlyDetection.gs): the
 *     line stands where those notes have their "SLRR" line (otherRequirementLine_, edRequirementLine_), and the note's
 *     head and first line say the team's rules in the line's words (requirementNoteWords_).
 * A question from the bot's own account that starts as the line does is a person's (isRequirementQuestion_).
 * Only in the Auto-correct flow (ctx.sourceReadOnly) and only while the setting requirement_line is on
 * (requirementLineOn_): in every other flow, and with the setting off, every note is what it was.
 *
 * The line's forms (each starts "*Alert requirements:*"; its first words are registered as the bot's own, Voice.gs
 * THREAD_NOTE_HEADS_, so the bot never answers it and nothing that starts so can go to S-F Burson):
 *   met for a Social Alert: P0 exposure tag (Product - Perceived bias).
 *       other reasons, in the same form: Sensitive Topic (Child Safety) · KOF author (Viral KOFs) · 2,400 engagements
 *       (2,000+ needed); a tag the rules count as another says so: P0 exposure tag (Product - Perceived bias: an
 *       account suspension that claims censorship or bias counts as it); on an ongoing issue whose author is no KOF
 *       only the engagements are named (there a tag or a topic sends nothing by itself); and while no test recipient
 *       is set: "… Its email waits for a test recipient in Control B30."
 *   met for a Social Alert (2,400 engagements), but none was sent: a repeat of QA-1001.
 *       or: the review says "…" · YouTube is the subject · emails are off in this run (a dry run) · the other flow
 *       already sent it (QA-1004) · a resend of QA-1001, whose Social Alert was already decided
 *   not met for a Social Alert (a P2 tag needs 2,000+ engagements, a KOF author or a Sensitive Topic; this post: 620
 *       engagements, no KOF author). Monitoring only.
 *       other causes: an ongoing issue, and the author isn't a KOF · excluded: …; a Sensitive Topic on the alert
 *       that the rules don't count is named: "…; its Sensitive Topic (Privacy) restates the exposure tag and does not
 *       count". In the place of "Monitoring only.": "No Social Alert; a T&S form is asked for below." when the alert
 *       gets a T&S form (REQ_TNS_ASK_, REQ_TNS_AUTO_, REQ_TNS_LATER_), and "A person checks it: …" for a Watch alert
 *       the triage leaves to a person to check.
 *   not met yet (small accounts, no KOF author, no P0 tag). Posted early because 5 accounts tell the same story.
 *       (a story or build-up card)
 *   below the Social Alert thresholds (…). A Social Alert goes out anyway on the review's call.
 * It never uses the team's own name for the requirements, never gives a listening feed's own floor (the count a feed
 * collects from) as a requirement, and keeps a reason of Gemini's to one line of REQ_REASON_MAX_ characters without
 * links.
 */

const REQ_HEAD_ = '*Alert requirements:* ';
const REQ_HEAD_FINAL_ = '*Alert requirements, final:* ';
const REQ_REASON_MAX_ = 160;  // a reason of Gemini's on the line: one line of at most this many characters
const REQ_EARLY_CAUSE_ = 'small accounts, no KOF author, no P0 tag';  // why a story or build-up card is below the thresholds
const REQ_NO_EMAILS_ = 'emails are off in this run (a dry run)';
// What follows "not met for a Social Alert (…)." when the alert is acted on all the same: a T&S form a person is asked
// for in the alert's thread, or (Auto-submit T&S form ON, Control row 12) one the bot handles there itself; and for an
// alert that is not decided yet because it waits on Burson (its link is missing), the form that follows then
const REQ_TNS_ASK_ = 'No Social Alert; a T&S form is asked for below.';
const REQ_TNS_AUTO_ = 'No Social Alert; the T&S form is handled below.';
const REQ_TNS_LATER_ = 'No Social Alert; a T&S form follows once Burson adds what is missing.';
// What a planned Social Alert waits for while Testing has nobody to send it to (ctx.b30Blank: Drafts.gs tryDraft_)
const REQ_HOLD_B30_ = 'a test recipient in Control B30';
// The exposure tag the rules count as Product - Perceived bias when the post claims censorship or bias (Escalate.gs
// escalation_, config remap_suspension_bias)
const REQ_SUSPENSION_TAG_ = 'Product - Account deletion/suspension';
// What can start a Social Alert that the rules themselves leave alone (the reason codes the paths add to an escalation)
const REQ_STARTED_BY_ = ['KB_OR_GUIDANCE', 'SHEET_TEST_ALERT', 'STREAM_TRIAGE', 'PROACTIVE_WATCH', 'EARLY_DETECTION'];

/**
 * Whether this flow writes the line: the Auto-correct flow (the same test ThreadNotes.gs makes of a flow) with the
 * setting requirement_line on (config burson_qa; on unless it is false). Pure; never throws.
 */
function requirementLineOn_(ctx) {
  return !!ctx && ctx.sourceReadOnly === true && !ctx.outboundBlocked && !ctx.direct && !ctx.otherSpace &&
    !!ctx.settings && ctx.settings.requirement_line !== false;
}

/**
 * The line for a decision a review path made (`final`: under the head "*Alert requirements, final:*"). `d`:
 *   rules   what the rules alone say of the alert (Escalate.gs escalation_'s result; never one a review or a test
 *           forced: requirementRules_)
 *   kof     the author's KOF lists, as the alert names them (fields.kof_lists)
 *   tag     the alert's own exposure tag, as its card and its email show it: where the rules count it as another tag,
 *           the line says so (requirementTagAs_)
 *   sent    true when a Social Alert goes out for it (sent, or drafted for a person to send)
 *   hold    what its email waits for, when it can't go yet (REQ_HOLD_B30_)
 *   repeat  none goes out because it repeats an alert that went out: that alert's id, or true when it has none here
 *   review  none goes out on Gemini's call: its reason, as Gemini wrote it
 *   why     none goes out for another reason, in the bot's own words
 *   call    who sends one although the rules don't: 'review' (the default) or 'test' (a sheet-test alert)
 *   cause   why it is below the thresholds, when the path knows more than the threshold itself says (a triage that
 *           sees no brand-safety issue in the post)
 *   early   a story or build-up card: {accounts, pace (how many times the usual pace, for a pace jump; else 0)}
 *   tns     an alert that meets no requirement gets a T&S form in its thread: 'ask' (a person is asked for it), 'auto'
 *           (Auto-submit T&S form is ON: the bot handles it there) or 'later' (once Burson has added what is missing)
 *   check   an alert that meets no requirement by the rules alone, and that the triage leaves to a person to check:
 *           what is to be checked, in the bot's own words
 * Pure.
 */
function requirementLine_(d, final) {
  const x = d || {};
  const r = x.rules || {};
  const met = requirementMet_(r, x.kof, x.tag);
  // The YouTube protocol: the thresholds are met, and the email is left to the YouTube chat (Escalate.gs escalation_)
  const youtube = r.action === 'YOUTUBE_CHAT_ONLY' || r.suppression === 'youtube_no_action';
  const reached = met.length > 0 && (r.escalated === true || youtube);
  const cause = () => requirementCause_(r, x.early, x.cause);
  const hold = x.hold ? ` Its email waits for ${x.hold}.` : '';
  let said;
  if (x.sent && reached) {
    said = `met for a Social Alert: ${met.map(m => m.long).join(' · ')}.${hold}`;
  } else if (x.sent) {
    said = `below the Social Alert thresholds (${cause()}). A Social Alert goes out anyway` +
      `${x.call === 'test' ? ': a test alert from the Test alert tab always sends one' : ' on the review\'s call'}.${hold}`;
  } else if (reached) {
    const why = x.repeat ? `a repeat of ${typeof x.repeat === 'string' ? x.repeat : 'an earlier alert'}`
      : youtube ? 'YouTube is the subject'
        : x.review ? `the review says "${requirementWords_(x.review)}"`
          : requirementWords_(x.why) || 'it was not made in this run';
    said = `met for a Social Alert (${met.map(m => m.short).join(', ')}), but none was sent: ${why}${/…$/.test(why) ? '' : '.'}`;
  } else if (x.early && r.suppression === 'below_threshold' && !x.cause) {
    said = `not met yet (${REQ_EARLY_CAUSE_}). ${requirementEarly_(x.early)}`;
  } else {
    said = `not met for a Social Alert (${cause()}). ${requirementThen_(x)}`;
  }
  // (the team's own name for the requirements never stands on the line, whatever a list's or a topic's name says)
  return (final ? REQ_HEAD_FINAL_ : REQ_HEAD_) + said.replace(/\bSLRR\b/gi, 'alert requirements');
}

/**
 * What the line says after "not met for a Social Alert (…).": "Monitoring only.", unless the alert is acted on all the
 * same: a Watch alert the triage leaves to a person to check (`x.check`: what is to be checked), or a T&S form in the
 * alert's thread (`x.tns`). Pure.
 */
function requirementThen_(x) {
  if (x.check) return `A person checks it: ${x.check}.`;
  if (x.tns) return x.tns === 'auto' ? REQ_TNS_AUTO_ : x.tns === 'later' ? REQ_TNS_LATER_ : REQ_TNS_ASK_;
  return 'Monitoring only.';
}

/**
 * The thresholds an alert meets, by the reason codes of the rules' result `r` (Escalate.gs escalation_), each as the
 * line words it: [{long: "P0 exposure tag (Product - Perceived bias)", short: "P0 exposure tag"}]; [] when it meets
 * none. `kof`: the author's KOF lists; `own`: the alert's own exposure tag (a P0 tag the rules count it as says so,
 * in both forms: requirementTagAs_). Pure.
 */
function requirementMet_(r, kof, own) {
  const has = code => (r.reasons || []).indexOf(code) >= 0;
  const named = (what, names) => ({ long: names.length ? `${what} (${names.join(', ')})` : what, short: what });
  const topics = (r.sensitive_topics || []).map(String);
  const out = [];
  // On an ongoing issue whose author is no KOF, a P0 tag, a Sensitive Topic or a briefed topic sends no Social Alert by
  // itself (Escalate.gs escalation_: ongoing_urgent_requires_kof): only 2,000+ engagements do, and the rules then put
  // the alert on the engagement track. The engagements are then the one requirement it meets.
  const countOnly = r.track === 'HIGH_ENGAGEMENT' && r.status === 'ONGOING' && r.is_kof === false;
  if (has('P0_TOPIC') && !countOnly) {
    const tag = r.exposure_tag ? String(r.exposure_tag) : '';
    const as = tag ? requirementTagAs_(tag, own) : '';
    // "P0" with no exposure tag behind it is the alert's own banner, said as that
    if (!tag) out.push(named('P0 priority', []));
    else if (as) out.push({ long: `P0 exposure tag (${tag}: ${as})`, short: `P0 exposure tag (${tag}: ${as})` });
    else out.push(named('P0 exposure tag', [tag]));
  }
  if (has('SENSITIVE_TOPIC') && !countOnly) out.push(named('Sensitive Topic', topics.filter(t => !/^Launches: /.test(t))));
  if (has('BRIEFED_TOPIC') && !countOnly) {
    out.push(named('briefed topic', topics.filter(t => /^Launches: /.test(t)).map(t => t.replace(/^Launches: /, ''))));
  }
  // the lists as the alert names them, without their own brackets: "Viral KOFs (KOFs)" -> "Viral KOFs"
  if (has('KOF')) out.push(named('KOF author', asList_(kof).map(n => String(n).replace(/\s*\([^()]*\)\s*$/, '').trim()).filter(Boolean)));
  if (has('HIGH_ENGAGEMENT')) {
    const n = requirementCount_(r.engagement_total);
    out.push({ long: `${n} (${fmtInt_(GEN.escalation_rules.high_engagement_threshold)}+ needed)`, short: n });
  }
  // an escalation with a reason this list doesn't know still says why, in the words the Alert log uses for it
  if (!out.length && r.escalated === true) out.push({ long: escalationWhyText_(r), short: 'the escalation rules' });
  return out;
}

/**
 * Why the rules count an alert under the exposure tag `tag` when its own tag, `own` (what its card and its email
 * show), is another one, for the line's brackets; '' when `tag` is the alert's own, or `own` isn't given. Today that is
 * one rule (Escalate.gs escalation_): an account suspension that claims censorship or bias counts as Product -
 * Perceived bias. Pure.
 */
function requirementTagAs_(tag, own) {
  if (!own) return '';
  const mine = String((lookupTag_(own) || {}).name || own);
  if (mine === String(tag)) return '';
  return mine === REQ_SUSPENSION_TAG_ ? 'an account suspension that claims censorship or bias counts as it'
    : `the alert's tag, ${mine}, counts as it`;
}

/** "620 engagements" / "1 engagement" / "no engagement count" (the alert gave none). Pure. */
function requirementCount_(n) {
  return Number.isInteger(n) ? `${fmtInt_(n)} engagement${n === 1 ? '' : 's'}` : 'no engagement count';
}

/**
 * Why the rules send no Social Alert for it (`r`: escalation_'s result), for the line's brackets: an ongoing issue or
 * an exclusion in the words the Watch triage already uses for them (OtherAlerts.gs otherNoEscWhy_), else the threshold
 * its exposure tag's priority needs and what the post has, with the Sensitive Topics on the alert that the rules don't
 * count (requirementTopicsLeft_). `early`: a story or build-up card, which is below the thresholds for being small
 * accounts; `own`: the path's own words for it (requirementLine_'s `cause`). Pure.
 */
function requirementCause_(r, early, own) {
  const s = String(r.suppression || '');
  if (s && s !== 'below_threshold') return otherNoEscWhy_(r, '', '');
  if (own) return String(own);
  if (early) return REQ_EARLY_CAUSE_;
  return `${r.priority ? `a ${r.priority} tag` : 'a post with no confirmed exposure tag'} needs ` +
    `${fmtInt_(GEN.escalation_rules.high_engagement_threshold)}+ engagements, a KOF author or a Sensitive Topic; this post: ` +
    `${requirementCount_(r.engagement_total)}, no KOF author${requirementTopicsLeft_(r)}`;
}

/**
 * The Sensitive Topics that are on the alert and that the rules don't count (`r`: escalation_'s result: its
 * risk_topics that are not among its sensitive_topics), as the end of the threshold's cause, so the line never reads as
 * if the alert's own topic were missing: "; its Sensitive Topic (Privacy) restates the exposure tag and does not count"
 * (config redundant_pairs), "; its Sensitive Topic (Politics) does not count outside the US". '' when every topic on
 * the alert counts. Pure.
 */
function requirementTopicsLeft_(r) {
  const counted = (r.sensitive_topics || []).map(String);
  const left = (r.risk_topics || []).map(String).filter(t => counted.indexOf(t) < 0);
  // (escalation_ leaves a topic out for one of two reasons: Politics outside the US, or one that restates the tag)
  const abroad = left.filter(t => t === 'Politics' && !isRedundantTopic_(r.exposure_tag, t));
  const restated = left.filter(t => abroad.indexOf(t) < 0);
  const its = topics => `; its Sensitive Topic${topics.length === 1 ? '' : 's'} (${topics.join(', ')})`;
  return (restated.length ? `${its(restated)} ${restated.length === 1 ? 'restates' : 'restate'} the exposure tag and ` +
    `${restated.length === 1 ? 'does' : 'do'} not count` : '') + (abroad.length ? `${its(abroad)} does not count outside the US` : '');
}

/**
 * Why a story or build-up card is in the space although it is below the thresholds (`e`: {accounts, pace}): a pace
 * jump by its pace in whole numbers ("at about 3 times the usual pace"; under twice the usual, "faster than the usual
 * pace"), any other card by how many accounts tell the story. Pure.
 */
function requirementEarly_(e) {
  const n = Number(e && e.accounts) || 0;
  const who = n ? `${fmtInt_(n)} account${n === 1 ? '' : 's'}` : 'several accounts';
  const pace = Number(e && e.pace) || 0;
  const times = Math.round(pace);
  if (times >= 2) return `Posted early because ${who} posted about it at about ${fmtInt_(times)} times the usual pace.`;
  if (pace > 1) return `Posted early because ${who} posted about it faster than the usual pace.`;
  return `Posted early because ${who} ${n === 1 ? 'tells' : 'tell'} the same story.`;
}

/**
 * A reason as the line carries it: one line, no link (a Markdown or Chat link keeps its words only, so nothing in it is
 * posted as a hyperlink; an internal short link, "go/…", is left out with the word that leads to it), no trailing
 * period, at most REQ_REASON_MAX_ characters; the team's own name for the requirements, in capitals or not, is said as
 * "alert requirements". Pure.
 */
function requirementWords_(text) {
  const s = String(text === undefined || text === null ? '' : text)
    .replace(/\[([^\[\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, '$1')
    .replace(/<[^<>|\s]+\|([^<>]*)>/g, '$1').replace(/[<>]/g, ' ')
    .replace(/(?:\b(?:see|per|via|at|in|on|from)\s+)?(?<![\w\/.-])go\/(?!no-?go\b)[^\s,;:()]+/gi, ' ').replace(/\(\s*\)/g, ' ')
    .replace(/\bSLRR\b/gi, 'alert requirements')
    .replace(/\s+/g, ' ').replace(/([.,;:]) (?=[.,;:])/g, '').trim().replace(/^[.,;:\s]+/, '').replace(/[.,;:\s]+$/, '');
  return truncate_(s, REQ_REASON_MAX_);
}

/**
 * Whether `text` is a question that only starts as the line does ("Alert requirements: why was this one not met?"), for
 * Bot.gs isOwnMessage_: in the Auto-correct flow such a message from the bot's own account is a question of the person
 * the bot runs as, and is answered. Every line the bot writes under this head is one line that ends with a full stop
 * or "…" (requirementLine_; a reason of Gemini's in it is quoted and followed by the stop), so one line that ends with
 * a question mark is never the bot's. Pure.
 */
function isRequirementQuestion_(text) {
  const t = String(text === undefined || text === null ? '' : text).trim();
  if (!t || t.indexOf('\n') >= 0 || !/\?$/.test(t)) return false;
  return /^Alert requirements(?![A-Za-z0-9])/.test(t.replace(/^(?:[^\x00-\x7F]{1,8}[ \t]+)?\*?/, ''));
}

/**
 * A Watch alert's triage note and an Early Detection card's review note where the line stands in them (the Auto-correct
 * flow, the setting on): their head and their first line in the line's words, so the note doesn't name the team's rules
 * one line above a line that never does ("it may be an SLRR alert (…) that the SLRR rules would escalate" -> "it may be
 * a Social Alert case (…) that the alert rules would escalate"; "the SLRR alert log" -> "the team's alert log"). Only
 * the head and the first line go through it: the bullets under them hold form links, which are never rewritten. Pure.
 */
function requirementNoteWords_(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\bSLRR alert log\b/gi, 'team\'s alert log')
    .replace(/\ban SLRR alert\b/gi, 'a Social Alert case')
    .replace(/\bthe SLRR rules\b/gi, 'the alert rules')
    .replace(/\bSLRR(?:'s)?\b/gi, 'alert requirements');
}

/**
 * What the rules alone say of an alert whose escalation is `esc`: `esc` itself, unless something else started its
 * Social Alert (REQ_STARTED_BY_: a Guidance row or document, a sheet test, a triage, a watch, an Early Detection
 * review) or there is none: then Escalate.gs escalation_ on `fields`, with that escalation's issue status. Pure.
 */
function requirementRules_(esc, fields, now) {
  if (esc && !(esc.reasons || []).some(code => REQ_STARTED_BY_.indexOf(code) >= 0)) return esc;
  return escalation_(fields || {}, esc ? { status: esc.status, now } : { now });
}

// ---------------------------------------------------------------------------------------------------------------
// Burson's corrected copy, a Direct BigQuery card, a sheet-test card (Bot.gs)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Before the review's note is posted (Bot.gs handleNewAlert_ and the resend handlers): the decision the alert's Social
 * Alert will follow, as {d (requirementLine_'s), line}. Read with the calls that write nothing (Drafts.gs
 * escalationFor_ and aiVeto_, and whether emails are made at all: draftsOn_), on a copy of the review (its fields and
 * its alert-memory facts copied, so nothing this reads is left on the review the Social Alert is then planned from).
 * `opts`: what the caller knows before its note is posted. {decided: why no Social Alert is made for this alert whatever
 * the review says (Burson's resend of an alert whose Social Alert was already decided), in the bot's own words;
 * waits: true when the alert is not decided in this run because it still waits on Burson (a T&S form it is to get is
 * asked for when Burson has resent it, and the line says that)}. null where the line is off (requirementLineOn_), and
 * when it can't be worked out (the note then goes without it). Never throws.
 */
function requirementOf_(ctx, review, history, opts) {
  if (!requirementLineOn_(ctx) || !review || !review.fields) return null;
  try {
    const copy = Object.assign({}, review, { fields: Object.assign({}, review.fields),
      memory: review.memory ? Object.assign({}, review.memory) : review.memory });
    const esc = escalationFor_(ctx, copy, history).esc;
    const d = requirementDecision_(ctx, copy, esc, aiVeto_(copy, esc), opts);
    return { d, line: requirementLine_(d) };
  } catch (e) {
    ctx.log(`the alert requirements line was left out: ${(e && e.message) || e}`);
    return null;
  }
}

/**
 * A reviewed alert's decision as requirementLine_ reads it: `esc` (Drafts.gs escalationFor_'s) and `veto` (aiVeto_'s:
 * why no Social Alert goes out although the rules call for one, or ''); `opts`: requirementOf_'s. It asks what the
 * handlers and Drafts.gs draftPlan_ ask, in their order: no Social Alert is made for an alert whose Social Alert was
 * already decided (opts.decided), while emails are off (a dry run), for an alert that isn't escalated, or for one with
 * a veto; one that is made waits while Testing has nobody to send it to (ctx.b30Blank). An alert that gets none can
 * get a T&S form (requirementTns_). Pure but for the clock (`review` is requirementOf_'s copy: the reason functions
 * keep their verdict on its alert-memory facts).
 */
function requirementDecision_(ctx, review, esc, veto, opts) {
  const o = opts || {};
  const f = review.fields || {};
  const due = esc.escalated === true && !veto && !o.decided;
  const d = { rules: requirementRules_(esc, f, ctx.now()), kof: f.kof_lists, tag: f.exposure_tag,
    sent: due && draftsOn_(ctx), call: (esc.reasons || []).indexOf('SHEET_TEST_ALERT') >= 0 ? 'test' : 'review' };
  if (d.sent && ctx.b30Blank) d.hold = REQ_HOLD_B30_;
  if (o.decided) return Object.assign(d, { why: String(o.decided) });
  if (due && !d.sent) d.why = REQ_NO_EMAILS_;
  const tns = requirementTns_(ctx, review, esc, veto, o);
  if (tns) d.tns = tns;
  if (!veto) return d;
  const repeat = followUpSkip_(review, esc) || (typeof memorySkip_ === 'function' ? memorySkip_(review, esc) : '');
  return Object.assign(d, repeat ? requirementRepeatWhy_(repeat, review.memory && review.memory.verdict) : requirementVeto_(veto));
}

/**
 * Whether an alert that gets no Social Alert gets a T&S form in its thread, as Drafts.gs noEmailNeeded_ decides it (the
 * same tests, on the same escalation; nothing is submitted or written here): '' for none; 'ask' when a person is asked
 * for it in this run; 'auto' with Auto-submit T&S form ON (Control row 12: the bot handles it in the thread); 'later'
 * while the alert still waits on Burson (opts.waits: it is decided, and its form asked for, when Burson has resent it).
 * None for a repeat of an alert that went out (the same post, or a follow-up with nothing new), or while no emails are
 * made. Pure but for requirementOf_'s copy.
 */
function requirementTns_(ctx, review, esc, veto, opts) {
  if (!draftsOn_(ctx) || !(ctx.settings && ctx.settings.react)) return '';
  if ((esc.escalated === true && !veto) || esc.action === 'YOUTUBE_CHAT_ONLY') return '';
  if (followUpSkip_(review, esc) || (typeof memoryRepeat_ === 'function' ? memoryRepeat_(review, esc) : '')) return '';
  const input = Object.assign(emailInput_(review.fields || {}, esc, switchOn_(ctx, 'noWait'), review.changed),
    { ai_reasons: review.groupReasons || {} });
  if (!tnsWhy_(input)) return '';
  if (opts && opts.waits) return 'later';
  return switchOn_(ctx, 'autoTns') ? 'auto' : 'ask';
}

/**
 * The earlier alert a repeat names: its id, as the reason functions put it in their text ("the same post was already
 * alerted (QA-1001)", "folded into QA-1001 …"), or true when the text has none (an alert known only from the team's
 * own alert log). Pure.
 */
function requirementRepeat_(why) {
  return (String(why || '').match(/\bQA-\d+\b/) || [true])[0];
}

/**
 * A repeat as requirementLine_ reads it. `why`: the reason functions' own text; `verdict`: the alert memory's verdict
 * for the alert (AlertMemory.gs amVerdict_), when that text is its. {repeat: the earlier alert's id, or true}; but the
 * same Burson alert the other flow already sent the Social Alert for (the memory's 'live' verdict, beside a Mirror
 * space) is no alert of this space to be a repeat of: {why: "the other flow already sent it (QA-1004)"}. Pure.
 */
function requirementRepeatWhy_(why, verdict) {
  const v = verdict && verdict.skip && String(verdict.skip) === String(why || '') ? verdict : null;
  if (v && v.kind === 'live') return { why: `the other flow already sent it${v.ref ? ` (${v.ref})` : ''}` };
  return { repeat: requirementRepeat_(why) };
}

/** A veto of aiVeto_'s that is no repeat, as requirementLine_ reads it: Gemini's own call ({review}), else a rule's ({why}). Pure. */
function requirementVeto_(veto) {
  const ai = String(veto || '').match(/^AI review(?: \(KOF\))?: ([\s\S]*)$/);
  return ai ? { review: ai[1] } : { why: String(veto || '') };
}

/**
 * After the review's note was posted (Bot.gs forwardAlert_, inPlaceNote_; `msg`: what Chat handed back for it). The
 * note is posted once per alert (its key): at a second attempt at an alert (the first one stopped before the alert was
 * recorded), Chat hands back the first attempt's note, whose last line is the first attempt's. When that note does not
 * end with this attempt's line (`req`: requirementOf_'s), req.stale is set, and requirementFinal_ then says under the
 * alert what this attempt decided. Only the letters and digits are compared, so a note Chat hands back with other
 * marks, spacing or punctuation than it was sent with is not taken for another line. Never throws.
 */
function requirementNoted_(req, msg) {
  try {
    if (!req || !req.line || !msg || !msg.text) return;
    const plain = s => String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim();
    if (!plain(msg.text).endsWith(plain(req.line))) req.stale = true;
  } catch (e) { /* the line stands as it was posted */ }
}

/**
 * After the Social Alert was planned (Drafts.gs draftPlan_; `draft`: its row fields, or null for none): one more line
 * goes under the alert, as a note of its own (ThreadNotes.gs acThreadNote_: once, only in the Auto-correct space),
 * "*Alert requirements, final:* …", when what was planned is not what the line in the review's note says (`req`:
 * requirementOf_'s), or when the note in the thread is an earlier attempt's and says otherwise (req.stale:
 * requirementNoted_; the line then is this attempt's own). `card`: the alert's message in that space ({name, thread,
 * createTime}); `source`: the message the review's note is keyed on (Burson's own for a corrected copy, the card
 * itself for one reviewed in place); `why`: why none was made although the rules call for one, when the caller knows.
 * Nothing when the note in the thread says what was done, or the line is off. Never throws.
 */
function requirementFinal_(ctx, req, card, source, draft, why) {
  if (!req || !req.d || !card || !card.name) return;
  try {
    const agree = !!draft === !!req.d.sent;
    if (agree && !req.stale) return;
    let d;
    if (agree) {  // this attempt's decision stands; the note in the thread is an earlier attempt's
      d = req.d;
    } else if (draft) {  // one was made after all: worded from its own escalation
      const input = draft.email_input || {};
      d = requirementDecision_(ctx, { fields: input.fields || {} }, Object.assign({}, input.escalation || {}, { escalated: true }), '');
    } else {  // none was made after all (the line said one goes out, so it names no reason of its own)
      d = Object.assign({}, req.d, { sent: false, why: why || '' });
    }
    acThreadNote_(ctx, { thread: card.thread || '', message: card.name, createTime: card.createTime, source_message: source },
      requirementLine_(d, true), 'reqfinal:' + source);
  } catch (e) {
    ctx.log(`the final alert requirements line was left out: ${(e && e.message) || e}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A Watch alert's triage note, an Early Detection card's review note
// ---------------------------------------------------------------------------------------------------------------

/**
 * The line for a Watch alert's triage (`d`: OtherAlerts.gs otherDecide_'s decision; `other`: the alert as read from
 * its card), in the place of the triage note's "SLRR" line; '' where the line is off, or there was no triage. What the
 * rules alone say is what the triage decided on: Gemini's view of the exposure tag when it is sure of it (d.slrr), else
 * the alert's own facts (d.fields holds the one or the other); and for an alert the triage leaves to a person to check
 * (basis slrr_check), the view it was flagged on, sure of it or not, so the line never says such an alert is only
 * monitored. Never an escalation the triage, the watch or a Guidance row started (requirementRules_). A triage that
 * sees no brand-safety issue in the post says so, a card that is a build-up of small posts says why it was posted
 * early, and an alert that gets a T&S form (d.tnsActive: otherNoEmail_ ran before the note) says that. Never throws.
 */
function otherRequirementLine_(ctx, d, other) {
  if (!requirementLineOn_(ctx) || !d || !d.tri) return '';
  try {
    const sure = d.slrr && d.slrr.sure ? d.slrr : null;
    const view = d.tri.slrr;
    const seen = sure || (d.basis === 'slrr_check' ? d.slrr : null);
    const x = { rules: requirementRules_(seen ? seen.esc : d.esc, d.fields, ctx.now()), kof: (d.fields || {}).kof_lists,
      tag: seen && !sure && view && view.tag ? view.tag : (d.fields || {}).exposure_tag,
      sent: d.action === 'escalate' && !!d.draft };
    if (x.sent && ctx.b30Blank) x.hold = REQ_HOLD_B30_;
    if (!x.sent) Object.assign(x, otherRequirementStop_(d, sure));
    if (d.tnsActive) x.tns = switchOn_(ctx, 'autoTns') ? 'auto' : 'ask';
    if (view && !view.is) {
      x.cause = `the review sees no Google brand-safety issue in it${view.why ? `: ${requirementWords_(view.why)}` : ''}`;
    }
    const build = ((other && other.unknown) || []).find(u => u && u.label === 'build_up');  // "4 small posts from 3 accounts …"
    const accounts = String((build && build.value) || '').match(/from ([\d,]+) accounts?\b/);
    if (accounts) x.early = { accounts: Number(accounts[1].replace(/,/g, '')) || 0, pace: 0 };
    return requirementLine_(x);
  } catch (e) {
    ctx.log(`the alert requirements line was left out of the triage note: ${(e && e.message) || e}`);
    return '';
  }
}

/**
 * Why a Watch alert's triage sends no Social Alert (`d`: otherDecide_'s decision; `sure`: d.slrr when Gemini is sure of
 * its view), as requirementLine_ reads it ({repeat} | {review} | {why}; with {check} for an alert a person has to
 * check): a repeat, a count or a tag a person has to check, Gemini's call against it, a post the triage leaves to a
 * person for its size, a triage that would escalate it but isn't sure enough, else the triage's own reason (Gemini's,
 * said as the review's; or the bot's own words). Never the decision's own text where that names the team's rules. Pure.
 */
function otherRequirementStop_(d, sure) {
  const own = String(d.why || '');
  if (d.action === 'escalate') return { why: REQ_NO_EMAILS_ };
  if (d.basis === 'repeat') return requirementRepeatWhy_(own, d.review && d.review.memory && d.review.memory.verdict);
  if (d.basis === 'slrr_check') {
    const what = sure ? 'its engagement count isn\'t known' : 'its exposure tag isn\'t confirmed';
    return { why: `${what}, so a person checks it`, check: what };
  }
  if (sure && sure.veto) return requirementVeto_(sure.veto);
  if (sure && sure.esc.escalated && sure.collected === false) return { why: 'the triage leaves a post this small to a person' };
  if (d.action === 'flag' && d.tri.action === 'escalate') {
    return { why: `the review is only ${Math.round((Number(d.tri.confidence) || 0) * 100)}% sure, so a person decides` };
  }
  return d.tri.reason && own === String(d.tri.reason) ? { review: own } : { why: own };
}

/**
 * The line for an Early Detection card's review (`d`: EarlyDetection.gs edDecide_'s decision), in the place of the
 * review note's "SLRR" line; '' where the line is off, or the review failed. What the rules alone say of the story is
 * escalation_ on its reviewed fields; with no exposure tag confirmed, its priority there is only the producer's hint
 * (edMergedFields_), which is no exposure tag, so it is left out. A story that gets a T&S form (d.tnsActive: edNoEmail_
 * ran before the note) says that where the line would say it is only monitored. Never throws.
 */
function edRequirementLine_(ctx, d) {
  if (!requirementLineOn_(ctx) || !d || !d.rev) return '';
  try {
    const f = d.fields || {};
    const ed = d.ed || {};
    const rules = escalation_(f.exposure_tag ? f : Object.assign({}, f, { priority: '' }),
      d.esc ? { status: d.esc.status, now: ctx.now() } : { now: ctx.now() });
    const x = { rules, kof: f.kof_lists, tag: f.exposure_tag, sent: d.disposition === 'escalate' && !!d.draft,
      early: { accounts: Number(ed.distinctAuthors) || 0, pace: ed.signalType === 'VELOCITY_SPIKE' ? Number(ed.velocityRatio) || 0 : 0 } };
    if (x.sent && ctx.b30Blank) x.hold = REQ_HOLD_B30_;
    if (!x.sent) Object.assign(x, edRequirementStop_(d));
    if (d.tnsActive) x.tns = switchOn_(ctx, 'autoTns') ? 'auto' : 'ask';
    return requirementLine_(x);
  } catch (e) {
    ctx.log(`the alert requirements line was left out of the review note: ${(e && e.message) || e}`);
    return '';
  }
}

/**
 * Why an Early Detection review sends no Social Alert (`d`: edDecide_'s decision, with its review d.rev), as
 * requirementLine_ reads it ({repeat} | {review} | {why}): a repeat, a review not sure enough to escalate, a story
 * that isn't in English, a build-up the review only monitors, else why it was dismissed (Gemini's reason, said as the
 * review's; or the bot's own words, as for a pattern of evergreen noise). Pure.
 */
function edRequirementStop_(d) {
  const own = String(d.why || '');
  if (d.disposition === 'escalate') return { why: REQ_NO_EMAILS_ };
  if (d.basis === 'repeat') return requirementRepeatWhy_(own, d.review && d.review.memory && d.review.memory.verdict);
  if (d.basis === 'low_confidence') {
    return { why: `the review is only ${Math.round((Number(d.rev.confidence) || 0) * 100)}% sure, so a person decides` };
  }
  if (d.basis === 'non_english') return { why: 'the story isn\'t in English' };
  if (d.disposition === 'monitor') return { why: 'the review calls it a build-up to monitor' };
  return d.rev.reason && own === String(d.rev.reason) ? { review: own } : { why: own };
}
