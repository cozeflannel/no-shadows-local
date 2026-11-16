/**
 * RequirementLine.gs — every alert the bot reviews in the Auto-correct space (B10) says, in its thread, which alert
 * requirement it met or did not meet.
 *
 * No second decision is made here. Each review path already decides whether a Social Alert goes out; requirementLine_
 * only puts that decision into one line, and the line lives in the note the review already posts under the alert:
 *   - Burson's corrected copy, a Direct BigQuery card and a sheet-test card (Bot.gs handleNewAlert_): the last line of
 *     the review's own note (Voice.gs changeNoteText_; the note is that one line when there is nothing else to say).
 *     The decision is read before the note is posted, with the calls that write nothing (Drafts.gs escalationFor_ and
 *     aiVeto_ on a copy of the review, and whether emails are made at all in this run: requirementOf_). When the
 *     Social Alert then goes another way than the line says, one more line follows as a note of its own
 *     (requirementFinal_, through ThreadNotes.gs acThreadNote_): "*Alert requirements, final:* …".
 *   - a Watch alert's triage note (OtherAlerts.gs) and an Early Detection card's review note (EarlyDetection.gs): the
 *     line stands where those notes have their "SLRR" line (otherRequirementLine_, edRequirementLine_).
 * Only in the Auto-correct flow (ctx.sourceReadOnly) and only while the setting requirement_line is on
 * (requirementLineOn_): in every other flow, and with the setting off, every note is what it was.
 *
 * The line's forms (each starts "*Alert requirements:*"; its first words are registered as the bot's own, Voice.gs
 * THREAD_NOTE_HEADS_, so the bot never answers it and nothing that starts so can go to S-F Burson):
 *   met for a Social Alert: P0 exposure tag (Product - Perceived bias).
 *       other reasons, in the same form: Sensitive Topic (Child Safety) · KOF author (Viral KOFs) · 2,400 engagements
 *       (2,000+ needed)
 *   met for a Social Alert (2,400 engagements), but none was sent: a repeat of QA-1001.
 *       or: the review says "…" · YouTube is the subject · emails are off in this run (a dry run)
 *   not met for a Social Alert (a P2 tag needs 2,000+ engagements, a KOF author or a Sensitive Topic; this post: 620
 *       engagements, no KOF author). Monitoring only.
 *       other causes: an ongoing issue, and the author isn't a KOF · excluded: …
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
 *   sent    true when a Social Alert goes out for it (sent, or drafted for a person to send)
 *   repeat  none goes out because it repeats an alert that went out: that alert's id, or true when it has none here
 *   review  none goes out on Gemini's call: its reason, as Gemini wrote it
 *   why     none goes out for another reason, in the bot's own words
 *   call    who sends one although the rules don't: 'review' (the default) or 'test' (a sheet-test alert)
 *   cause   why it is below the thresholds, when the path knows more than the threshold itself says (a triage that
 *           sees no brand-safety issue in the post)
 *   early   a story or build-up card: {accounts, pace (how many times the usual pace, for a pace jump; else 0)}
 * Pure.
 */
function requirementLine_(d, final) {
  const x = d || {};
  const r = x.rules || {};
  const met = requirementMet_(r, x.kof);
  // The YouTube protocol: the thresholds are met, and the email is left to the YouTube chat (Escalate.gs escalation_)
  const youtube = r.action === 'YOUTUBE_CHAT_ONLY' || r.suppression === 'youtube_no_action';
  const reached = met.length > 0 && (r.escalated === true || youtube);
  const cause = () => requirementCause_(r, x.early, x.cause);
  let said;
  if (x.sent && reached) {
    said = `met for a Social Alert: ${met.map(m => m.long).join(' · ')}.`;
  } else if (x.sent) {
    said = `below the Social Alert thresholds (${cause()}). A Social Alert goes out anyway` +
      `${x.call === 'test' ? ': a test alert from the Test alert tab always sends one' : ' on the review\'s call'}.`;
  } else if (reached) {
    const why = x.repeat ? `a repeat of ${typeof x.repeat === 'string' ? x.repeat : 'an earlier alert'}`
      : youtube ? 'YouTube is the subject'
        : x.review ? `the review says "${requirementWords_(x.review)}"`
          : requirementWords_(x.why) || 'it was not made in this run';
    said = `met for a Social Alert (${met.map(m => m.short).join(', ')}), but none was sent: ${why}${/…$/.test(why) ? '' : '.'}`;
  } else if (x.early && r.suppression === 'below_threshold' && !x.cause) {
    said = `not met yet (${REQ_EARLY_CAUSE_}). ${requirementEarly_(x.early)}`;
  } else {
    said = `not met for a Social Alert (${cause()}). Monitoring only.`;
  }
  // (the team's own name for the requirements never stands on the line, whatever a list's or a topic's name says)
  return (final ? REQ_HEAD_FINAL_ : REQ_HEAD_) + said.replace(/\bSLRR\b/g, 'alert requirements');
}

/**
 * The thresholds an alert meets, by the reason codes of the rules' result `r` (Escalate.gs escalation_), each as the
 * line words it: [{long: "P0 exposure tag (Product - Perceived bias)", short: "P0 exposure tag"}]; [] when it meets
 * none. `kof`: the author's KOF lists. Pure.
 */
function requirementMet_(r, kof) {
  const has = code => (r.reasons || []).indexOf(code) >= 0;
  const named = (what, names) => ({ long: names.length ? `${what} (${names.join(', ')})` : what, short: what });
  const topics = (r.sensitive_topics || []).map(String);
  const out = [];
  // "P0" with no exposure tag behind it is the alert's own banner, said as that
  if (has('P0_TOPIC')) out.push(r.exposure_tag ? named('P0 exposure tag', [String(r.exposure_tag)]) : named('P0 priority', []));
  if (has('SENSITIVE_TOPIC')) out.push(named('Sensitive Topic', topics.filter(t => !/^Launches: /.test(t))));
  if (has('BRIEFED_TOPIC')) out.push(named('briefed topic', topics.filter(t => /^Launches: /.test(t)).map(t => t.replace(/^Launches: /, ''))));
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

/** "620 engagements" / "1 engagement" / "no engagement count" (the alert gave none). Pure. */
function requirementCount_(n) {
  return Number.isInteger(n) ? `${fmtInt_(n)} engagement${n === 1 ? '' : 's'}` : 'no engagement count';
}

/**
 * Why the rules send no Social Alert for it (`r`: escalation_'s result), for the line's brackets: an ongoing issue or
 * an exclusion in the words the Watch triage already uses for them (OtherAlerts.gs otherNoEscWhy_), else the threshold
 * its exposure tag's priority needs and what the post has. `early`: a story or build-up card, which is below the
 * thresholds for being small accounts; `own`: the path's own words for it (requirementLine_'s `cause`). Pure.
 */
function requirementCause_(r, early, own) {
  const s = String(r.suppression || '');
  if (s && s !== 'below_threshold') return otherNoEscWhy_(r, '', '');
  if (own) return String(own);
  if (early) return REQ_EARLY_CAUSE_;
  return `${r.priority ? `a ${r.priority} tag` : 'a post with no confirmed exposure tag'} needs ` +
    `${fmtInt_(GEN.escalation_rules.high_engagement_threshold)}+ engagements, a KOF author or a Sensitive Topic; this post: ` +
    `${requirementCount_(r.engagement_total)}, no KOF author`;
}

/** Why a story or build-up card is in the space although it is below the thresholds (`e`: {accounts, pace}). Pure. */
function requirementEarly_(e) {
  const n = Number(e && e.accounts) || 0;
  const who = n ? `${fmtInt_(n)} account${n === 1 ? '' : 's'}` : 'several accounts';
  const pace = Number(e && e.pace) || 0;
  if (pace > 0) return `Posted early because ${who} posted about it at ${pace.toFixed(1)}x the usual pace.`;
  return `Posted early because ${who} ${n === 1 ? 'tells' : 'tell'} the same story.`;
}

/**
 * A reason as the line carries it: one line, no link (a Markdown or Chat link keeps its words only, so nothing in it is
 * posted as a hyperlink), no trailing period, at most REQ_REASON_MAX_ characters; the team's own name for the
 * requirements is said as "alert requirements". Pure.
 */
function requirementWords_(text) {
  const s = String(text === undefined || text === null ? '' : text)
    .replace(/\[([^\[\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, '$1')
    .replace(/<[^<>|\s]+\|([^<>]*)>/g, '$1').replace(/[<>]/g, ' ')
    .replace(/\bSLRR\b/g, 'alert requirements')
    .replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  return truncate_(s, REQ_REASON_MAX_);
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
 * null where the line is off (requirementLineOn_), and when it can't be worked out (the note then goes without it).
 * Never throws.
 */
function requirementOf_(ctx, review, history) {
  if (!requirementLineOn_(ctx) || !review || !review.fields) return null;
  try {
    const copy = Object.assign({}, review, { fields: Object.assign({}, review.fields),
      memory: review.memory ? Object.assign({}, review.memory) : review.memory });
    const esc = escalationFor_(ctx, copy, history).esc;
    const d = requirementDecision_(ctx, copy, esc, aiVeto_(copy, esc));
    return { d, line: requirementLine_(d) };
  } catch (e) {
    ctx.log(`the alert requirements line was left out: ${(e && e.message) || e}`);
    return null;
  }
}

/**
 * A reviewed alert's decision as requirementLine_ reads it: `esc` (Drafts.gs escalationFor_'s) and `veto` (aiVeto_'s:
 * why no Social Alert goes out although the rules call for one, or ''). It asks what Drafts.gs draftPlan_ asks, in its
 * order: no Social Alert is made while emails are off (a dry run), for an alert that isn't escalated, or for one with
 * a veto. Pure but for the clock.
 */
function requirementDecision_(ctx, review, esc, veto) {
  const due = esc.escalated === true && !veto;
  const d = { rules: requirementRules_(esc, review.fields, ctx.now()), kof: (review.fields || {}).kof_lists,
    sent: due && draftsOn_(ctx), call: (esc.reasons || []).indexOf('SHEET_TEST_ALERT') >= 0 ? 'test' : 'review' };
  if (due && !d.sent) d.why = REQ_NO_EMAILS_;
  if (!veto) return d;
  const repeat = followUpSkip_(review, esc) || (typeof memorySkip_ === 'function' ? memorySkip_(review, esc) : '');
  return Object.assign(d, repeat ? { repeat: requirementRepeat_(repeat) } : requirementVeto_(veto));
}

/**
 * The earlier alert a repeat names: its id, as the reason functions put it in their text ("the same post was already
 * alerted (QA-1001)", "folded into QA-1001 …"), or true when the text has none (an alert known only from the team's
 * own alert log). Pure.
 */
function requirementRepeat_(why) {
  return (String(why || '').match(/\bQA-\d+\b/) || [true])[0];
}

/** A veto of aiVeto_'s that is no repeat, as requirementLine_ reads it: Gemini's own call ({review}), else a rule's ({why}). Pure. */
function requirementVeto_(veto) {
  const ai = String(veto || '').match(/^AI review(?: \(KOF\))?: ([\s\S]*)$/);
  return ai ? { review: ai[1] } : { why: String(veto || '') };
}

/**
 * After the Social Alert was planned (Drafts.gs draftPlan_; `draft`: its row fields, or null for none): when that is
 * not what the line in the review's note says (`req`: requirementOf_'s), one more line goes under the alert, as a
 * note of its own (ThreadNotes.gs acThreadNote_: once, only in the Auto-correct space): "*Alert requirements, final:*
 * …". `card`: the alert's message in that space ({name, thread, createTime}); `source`: the message the review's note
 * is keyed on (Burson's own for a corrected copy, the card itself for one reviewed in place); `why`: why none was made
 * although the rules call for one, when the caller knows. Nothing when they agree, or the line is off. Never throws.
 */
function requirementFinal_(ctx, req, card, source, draft, why) {
  if (!req || !req.d || !card || !card.name) return;
  try {
    if (!!draft === !!req.d.sent) return;
    let d;
    if (draft) {  // one was made after all: worded from its own escalation
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
 * the alert's own facts (d.fields holds the one or the other); never an escalation the triage, the watch or a Guidance
 * row started (requirementRules_). A triage that sees no brand-safety issue in the post says so, and a card that is a
 * build-up of small posts says why it was posted early. Never throws.
 */
function otherRequirementLine_(ctx, d, other) {
  if (!requirementLineOn_(ctx) || !d || !d.tri) return '';
  try {
    const sure = d.slrr && d.slrr.sure ? d.slrr : null;
    const view = d.tri.slrr;
    const x = { rules: requirementRules_(sure ? sure.esc : d.esc, d.fields, ctx.now()), kof: (d.fields || {}).kof_lists,
      sent: d.action === 'escalate' && !!d.draft };
    if (!x.sent) Object.assign(x, otherRequirementStop_(d, sure));
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
 * its view), as requirementLine_ reads it ({repeat} | {review} | {why}): a repeat, a count or a tag a person has to
 * check, Gemini's call against it, a post the triage leaves to a person for its size, a triage that would escalate it
 * but isn't sure enough, else the triage's own reason (Gemini's, said as the review's; or the bot's own words). Never
 * the decision's own text where that names the team's rules. Pure.
 */
function otherRequirementStop_(d, sure) {
  const own = String(d.why || '');
  if (d.action === 'escalate') return { why: REQ_NO_EMAILS_ };
  if (d.basis === 'repeat') return { repeat: requirementRepeat_(own) };
  if (d.basis === 'slrr_check') {
    return { why: sure ? 'its engagement count isn\'t known, so a person checks it' : 'its exposure tag isn\'t confirmed, so a person checks it' };
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
 * (edMergedFields_), which is no exposure tag, so it is left out. Never throws.
 */
function edRequirementLine_(ctx, d) {
  if (!requirementLineOn_(ctx) || !d || !d.rev) return '';
  try {
    const f = d.fields || {};
    const ed = d.ed || {};
    const rules = escalation_(f.exposure_tag ? f : Object.assign({}, f, { priority: '' }),
      d.esc ? { status: d.esc.status, now: ctx.now() } : { now: ctx.now() });
    const x = { rules, kof: f.kof_lists, sent: d.disposition === 'escalate' && !!d.draft,
      early: { accounts: Number(ed.distinctAuthors) || 0, pace: ed.signalType === 'VELOCITY_SPIKE' ? Number(ed.velocityRatio) || 0 : 0 } };
    if (!x.sent) Object.assign(x, edRequirementStop_(d));
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
  if (d.basis === 'repeat') return { repeat: requirementRepeat_(own) };
  if (d.basis === 'low_confidence') {
    return { why: `the review is only ${Math.round((Number(d.rev.confidence) || 0) * 100)}% sure, so a person decides` };
  }
  if (d.basis === 'non_english') return { why: 'the story isn\'t in English' };
  if (d.disposition === 'monitor') return { why: 'the review calls it a build-up to monitor' };
  return d.rev.reason && own === String(d.rev.reason) ? { review: own } : { why: own };
}
