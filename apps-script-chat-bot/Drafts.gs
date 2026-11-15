/**
 * Drafts.gs — the Social Alert emails (V2) and the emoji work the on-shift IM used to do by hand.
 *
 * Testing (escalation.stand_in set, as now): for an escalated alert the bot sends the Social Alert itself, as it would
 * live, but only to the stand-in, with a last line naming the distros it would have gone to; then it marks the alert with
 * the emojis for those distros (📰 📦 ⚖️ …). The 🧑‍💻 escalation-protocol DM goes to the stand-in too.
 * Without a stand-in: the bot drafts the email in the mailbox of the account it runs as (Brand Social) with every team the
 * routing rules or the AI call for already on it, and marks the emojis once someone sends it.
 * Auto-send Social Alerts (Control tab row 11, OFF until someone turns it on): live (the real Burson space, no stand-in,
 * not the Mirror or auto-correct space) the bot sends that email itself instead of the draft, marks the emojis for who it
 * went to and says so under the forwarded alert. It never sends one twice: each alert is noted (ctx.memo 'auto_sent')
 * before its send, and a retry after a send that failed or may not have finished leaves a draft, with a warning (if
 * that send went out after all, the bot finds it in Sent and marks the alert sent). An alert still waiting on Burson
 * for something only they can fix (a missing link; with "Never wait on Burson" ON, an alert lacking it) stays a draft
 * too, and so does one whose link the bot found itself (Auto-find missing links): a person checks it's the right post.
 * Auto-submit T&S form (Control tab row 12, OFF until someone turns it on): when T&S should see an alert, the bot submits
 * the T&S form itself instead of posting the pre-filled link (the test copy while testing, or in the Mirror, auto-correct
 * or a test space; the real form only live, with TNS_LIVE_FORM_ID set, and never on a link the bot found itself), marks
 * ✍️, sends the urgent email when it's urgent (only to the stand-in while testing) and says so under the forwarded
 * alert. Never twice for a post (TNS_AUTO_LINKS and the Alert log, across flows); one that fails is left to a person,
 * with the link.
 * Write back to SLRR BigQuery (Control tab row 16, OFF until someone turns it on): each alert, once it's finished (its
 * Social Alert sent: onEmailSent_; ❌, T&S form only or YouTube: noEmailNeeded_; a draft deleted unsent or ❌'d; an
 * email that failed for good), goes to the SLRR BigQuery tables (BigQuery.gs bqWriteBack_; only a sent one, as TEST,
 * while testing). Nothing is posted about it.
 * No email needed (or a draft deleted unsent) -> ❌ No action taken. Analysts' legend reactions still work as an override.
 *
 *   draftPlan_(ctx, review, history)   escalated? -> the row fields for a pending email (no Gmail call yet), else null.
 *                                      KB & Guidance can start alerts (Control tab row 13, OFF by default): an alert the
 *                                      rules leave below the bar is escalated too when Gemini cites a Guidance tab row
 *                                      or a Resources document that checks out (escalationFor_; analysts see "Why:
 *                                      Escalated per …" in the draft note and on the Results tab, never in the email).
 *                                      Check outage & comms docs (Control tab row 20, OFF by default): the review's
 *                                      comms / status context goes on the email (email_input.comms_context, Email.gs)
 *   tryDraft_(ctx, row, report)        sends it to the stand-in, sends it itself (Auto-send, live), or creates the Gmail
 *                                      draft and its note (never throws)
 *   autoSendOn_(ctx)                   Auto-send Social Alerts applies to this run (switch ON, live, no stand-in)
 *   autoSubmitTns_(ctx, row, input, report)  Auto-submit T&S form: submits it (once per post) and returns the note's text
 *                                      in place of the form details; '' while OFF or when there's nothing to submit
 *   noEmailNeeded_(ctx, row, ...)      not escalated and nothing to fix -> ❌ in both spaces (T&S form details if T&S)
 *   maintainDrafts_(ctx, report)       every run: retries pending emails; draft sent -> 📦 + teams; deleted -> ❌ (an
 *                                      auto-send that went out after all, found in Sent: sent)
 *   onEmailSent_(ctx, row, report)     right after a send: what the switches do then (Watch sent alerts: Watch.gs;
 *                                      Track post-alert outcomes: Outcomes.gs)
 *   draftReactions_(ctx, fm, report)   legend emojis on a forwarded alert: groups -> added to the draft; ❌ -> deleted
 *   confirmReceipt_(ctx, row)          👍 on a correct alert the bot couldn't action yet (it waits on a person)
 *   leadershipPing_(ctx, row, ...)     🧑‍💻: the escalation-protocol DM (to the stand-in while testing)
 *
 * ctx.drafts = {on, live, mailbox, from, standIn}: on = the Control tab's "Email drafts"; live = the Burson space is the
 * real one; standIn = escalation.stand_in. ctx.gmail is Mail.gs gmailClient_() (a fake in tests). Open drafts are tracked
 * in ctx.memo 'open_drafts' (alert ids), so a quiet run doesn't open the log sheet.
 */

const DRAFT_TRIES_ = 3;
const DRAFT_WATCH_DAYS_ = 7;
const DRAFT_CHECKS_PER_RUN_ = 15;
const SENT_SKEW_MS_ = 60 * 1000;
function tnsUrgentAlias_() { return String((GEN.email && GEN.email.tns_urgent) || '').trim(); }
function tnsUrgentLabel_() { return tnsUrgentAlias_() || 'the T&S urgent alias'; }
const WORKSPACE_FORM_ID_ = '1cfq4vlKnsff3HIf0LrVE5QjgSMo4LOo-Mu5xZicDIvE';
const WORKSPACE_DEDUP_SHEET_ID_ = '1-xHPI8IUkaei1G5eNWRSa7zojmSMyF6hfxbeXhnNJb0';

function draftsOn_(ctx) { return !!(ctx.drafts && ctx.drafts.on && ctx.gmail); }

function watched_(ctx) {
  try { return JSON.parse(ctx.memo.get('open_drafts') || '[]') || []; } catch (e) { return []; }
}

function setWatched_(ctx, ids) {
  const unique = Array.from(new Set(ids));
  if (JSON.stringify(unique) !== JSON.stringify(watched_(ctx))) ctx.memo.set('open_drafts', JSON.stringify(unique));
}

function groupsOf_(row) { return String(row.email_groups || '').split(' ').filter(Boolean); }

/** The testers for this run (Control tab B30, falling back to standIn): an array of lowercase email addresses. */
function draftsTesters_(ctx) {
  const D = (ctx && ctx.drafts) || {};
  return Array.isArray(D.testers) && D.testers.length ? onlyToList_(D.testers) : onlyToList_(D.standIn);
}

/** Why T&S should get this alert ('' when it shouldn't): the routing rules first, then the AI's call. */
function tnsWhy_(input) {
  const esc = (input && input.escalation) || {};
  const ai = (input && input.ai_reasons) || {};
  if ((esc.ts_reasons || []).length) return esc.ts_reasons.join(', ');
  return Object.prototype.hasOwnProperty.call(ai, 'tns') ? (ai.tns || 'AI review') : '';
}

/**
 * Why T&S should hear about it at once, by the urgent email as well as the form ('' when it's not urgent): a P0, HIGH or
 * VIRAL KOF engagement, or child safety. Pure.
 */
function tnsUrgent_(input) {
  const f = (input && input.fields) || {};
  const esc = (input && input.escalation) || {};
  const level = String(f.engagement_level || '').toUpperCase();
  if (esc.priority === 'P0') return 'P0';
  if (['HIGH', 'VIRAL KOF'].includes(level)) return `${level} engagement`;
  return /child safety/i.test(tnsWhy_(input) || 'flagged') ? 'child safety' : '';
}

/** Formats a post URL as a Google Chat hyperlink `<url|issue_name>` (or `<url|View post>` when no issue title is set). */
function tnsLinkFor_(input, url) {
  const u = String(url || '').trim();
  if (!u) return '(blank)';
  const f = (input && input.fields) || {};
  const esc = (input && input.escalation) || {};
  const label = String(f.issue_name || esc.issue_name || '').trim() || 'View post';
  return typeof chatLink_ === 'function' ? chatLink_(u, label) : `<${u}|${label}>`;
}

/**
 * What a person needs to file the Trust & Safety form: the pre-filled link (TnsForm.gs) and what it fills in. While
 * testing it's the test copy in the tester's Drive, never the real form. (With Auto-submit T&S form ON the bot submits
 * it itself, and autoSubmitTns_ says so in place of this; these details stay for when a person has to after all.)
 */
function tnsFormText_(input) {
  const why = tnsWhy_(input) || 'flagged';
  const urgent = !!tnsUrgent_(input);
  const testing = tnsTesting_();
  const url = tnsPrefillUrl_(input);
  const v = tnsFormValues_(input);
  const lines = [
    url
      ? `T&S form needed (${why}): <${url}|Open the ${testing ? 'test copy of the ' : ''}T&S Intake Form, pre-filled>`
      : `T&S form needed (${why}). The test copy of the T&S form isn't set up yet: run setupTnsTestForm() in the bot's ` +
        'Apps Script project.',
    '- Intake Request: Marketing',
    `- Google Product: ${v.product}`,
    `- Topic Impacted: ${v.topic}`,
    `- Link: ${tnsLinkFor_(input, v.url)}`,
  ];
  if (urgent) {
    lines.push(testing
      ? `- Urgent: live, also email ${tnsUrgentLabel_()} with the link (not while testing).`
      : `- Urgent: after submitting, also email ${tnsUrgentLabel_()} with the link.`);
  }
  lines.push('Check the pre-filled details, then Submit. The bot will mark \u270d\ufe0f when the WD Intake Request confirmation email comes in.');
  return lines.join('\n');
}

/**
 * Concise single-sentence T&S summary with `<url|text>` hyperlinks for fast-moving Early Catch thread replies (so T&S is
 * folded into the single triage message instead of posting a second multi-line block). Pure-safe.
 */
function tnsCompactLine_(input, tnsNote, submitted) {
  const v = tnsFormValues_(input);
  const why = truncate_(String(tnsWhy_(input) || 'flagged').replace(/\.$/, ''), 140);
  const note = String(tnsNote || '');
  if (/^The alert was already submitted to T&S/i.test(note)) {
    return truncate_(note.replace(/\s+/g, ' ').trim(), 200);
  }
  if (submitted) {
    const subLink = (note.match(/<(https?:\/\/[^|>\s]+\|[^>]+)>/) || [])[0] || '';
    return `Submitted Marketing intake (${v.product} / ${v.topic})${subLink ? ` \u00b7 ${subLink}` : ''}.`;
  }
  const testing = tnsTesting_();
  const url = tnsPrefillUrl_(input);
  const formLink = url ? `<${url}|Open the ${testing ? 'test copy of the ' : ''}T&S Intake Form, pre-filled>` : 'T&S Intake Form needed';
  return `${why} \u2014 ${formLink} (${v.product} / ${v.topic}).`;
}

/** The Workspace form's values for a Workspace alert (not Threads), as slrr-assistant_app_script fills it, or null. */
function workspaceForm_(input) {
  const f = (input && input.fields) || input || {};
  const esc = (input && input.escalation) || {};
  const product = f.product || esc.product || '';
  const network = f.social_network || esc.platform || '';
  if (product !== 'Workspace' || String(network).toLowerCase() === 'threads') return null;
  return {
    platform: network === 'X' ? 'X (Twitter)' : String(network),
    engagement: ['HIGH', 'VIRAL KOF'].includes(String(f.engagement_level || '').toUpperCase()) ? 'High' : 'Low',
  };
}

/** Submits the Workspace form when product is Workspace (except Threads), matching slrr-assistant_app_script. Never while testing. */
function submitWorkspaceForm_(input, live) {
  const f = (input && input.fields) || input || {};
  const ws = workspaceForm_(input);
  if (!ws) return null;
  const platform = ws.platform;
  const engagement = ws.engagement;
  const testing = runTesting_();  // nothing reaches anyone else while Testing (Main.gs runMode_)
  if (!live || testing || typeof FormApp === 'undefined') {
    return `Workspace form (test space — not submitted to live form): Platform=${platform}, Engagement=${engagement}, Link=${tnsLinkFor_(input, f.post_url)}`;
  }
  try {
    const link = String(f.post_url || '').trim();
    if (link && typeof SpreadsheetApp !== 'undefined') {
      const sh = SpreadsheetApp.openById(WORKSPACE_DEDUP_SHEET_ID_).getSheetByName('Form responses 1');
      if (sh) {
        const urls = sh.getRange('C2:C').getValues().flat().filter(Boolean).map(u => String(u).trim());
        if (urls.includes(link)) return 'Workspace form: link already submitted.';
      }
    }
    const form = FormApp.openById(WORKSPACE_FORM_ID_);
    const response = form.createResponse();
    let postDate = new Date(f.post_date || '');
    if (isNaN(postDate.getTime())) postDate = new Date();
    form.getItems().forEach(item => {
      const title = item.getTitle();
      const type = item.getType();
      if (title === 'Post Date' && type === FormApp.ItemType.DATE) {
        response.withItemResponse(item.asDateItem().createResponse(postDate));
      } else if (title === 'Platform' && type === FormApp.ItemType.MULTIPLE_CHOICE) {
        response.withItemResponse(item.asMultipleChoiceItem().createResponse(platform));
      } else if (title === 'Link to Post' && type === FormApp.ItemType.TEXT) {
        response.withItemResponse(item.asTextItem().createResponse(link));
      } else if (title === 'Engagement' && type === FormApp.ItemType.MULTIPLE_CHOICE) {
        response.withItemResponse(item.asMultipleChoiceItem().createResponse(engagement));
      } else if (title === 'Summary' && (type === FormApp.ItemType.PARAGRAPH_TEXT || type === FormApp.ItemType.TEXT)) {
        const textItem = type === FormApp.ItemType.PARAGRAPH_TEXT ? item.asParagraphTextItem() : item.asTextItem();
        response.withItemResponse(textItem.createResponse(String(f.summary || '')));
      }
    });
    response.submit();
    return 'Workspace form submitted.';
  } catch (e) {
    return `Workspace form submission failed: ${(e && e.message) || e}`;
  }
}

/**
 * The escalation decision for a reviewed alert. An issue already alerted in the last 14 days counts as ongoing, and so
 * does a follow-up to (or a re-alert of) an alert that went out; `related` is the earlier alert an update replies on
 * (the follow-up's own original first, when its Social Alert was sent). With KB & Guidance can start alerts ON, an
 * alert the rules leave below the bar can be escalated on what Gemini cited (kbStarted_). The one place this is
 * decided, so the Social Alert, the ❌ and the leadership DM always agree.
 */
function escalationFor_(ctx, review, history) {
  const fu = review.followUp;
  const fuRow = (fu && fu.original && fu.original.row) || null;
  const kiRow = (review && review.knownIssueRow) || null;
  const memRel = typeof memoryRelated_ === 'function' ? memoryRelated_(review) : { post: null, story: null, ongoing: false };
  let related = (fuRow && fuRow.email_status === 'sent' && fuRow.email_thread ? fuRow : null) ||
    memRel.post ||
    relatedAlert_(review, history, ctx.now()) ||
    (kiRow && kiRow.email_status === 'sent' && kiRow.email_thread ? kiRow : null) || memRel.story || fuRow || kiRow;
  const ongoing = !!related || !!(fu && fu.original && fu.original.outcome === 'alerted') ||
    !!(review && review.knownIssue && review.knownIssue.matches) || !!memRel.ongoing;
  const baseEsc = escalation_(review.fields, { status: ongoing ? 'ONGOING' : undefined, now: ctx.now() });
  let esc = kbStarted_(ctx, review, baseEsc) || baseEsc;
  if (!esc.escalated && review && typeof SHEET_TEST_INGESTED_ === 'string' && review.ingested === SHEET_TEST_INGESTED_) {
    esc = Object.assign({}, esc, {
      escalated: true,
      action: 'EMAIL_ALERT',
      track: esc.track || 'HIGH_ENGAGEMENT',
      reasons: (esc.reasons || []).concat(['SHEET_TEST_ALERT']),
      suppression: null,
    });
  }
  const upd = typeof memoryUpdate_ === 'function' ? memoryUpdate_(review, esc) : null;
  if (upd && upd.rel && upd.rel.o === 'e' && upd.rel.th && !(related && related.email_status === 'sent' && related.email_thread)) {
    related = amRelatedRow_(upd.rel, upd.rel.nm, '');
  }
  return { related, esc };
}

/**
 * KB & Guidance can start alerts (Control tab row 13): the rules' escalation, promoted when Gemini cited a Guidance tab
 * row or a Resources document that checks out (Escalate.gs kbPromotion_), else null. Nothing at all while the switch is
 * OFF. Never throws: if the check fails, the rules' call stands.
 */
function kbStarted_(ctx, review, esc) {
  if (!switchOn_(ctx, 'kbStartAlerts') || !esc || esc.escalated) return null;
  try {
    return kbPromotion_(review, esc, ctx.now());
  } catch (e) {
    ctx.log(`the KB & Guidance check failed, so the rules' call stands: ${(e && e.message) || e}`);
    return null;
  }
}

const KB_STARTS_PROP_ = 'KB_STARTS';  // the posts KB & Guidance started a Social Alert for today: {day, keys}

/** Column C of "KB & Guidance can start alerts": "2 started today · last per Guidance: "…"" (each post once). Never throws. */
function noteKbStart_(ctx, review, basis) {
  try {
    const props = PropertiesService.getScriptProperties();
    const day = etDay_(ctx.now());
    let seen = {};
    try { seen = JSON.parse(props.getProperty(KB_STARTS_PROP_) || '{}') || {}; } catch (e) { seen = {}; }
    const keys = seen.day === day && Array.isArray(seen.keys) ? seen.keys : [];
    const key = String((review && review.recordKey) || '') || `#${keys.length + 1}`;
    if (!keys.includes(key)) keys.push(key);
    props.setProperty(KB_STARTS_PROP_, JSON.stringify({ day, keys: keys.slice(-100) }));
    noteSwitch_('kbStartAlerts', `${keys.length} started today · last per ${basis}`);
  } catch (e) {
    ctx.log(`couldn't note the KB & Guidance alert for the Control tab: ${(e && e.message) || e}`);
  }
}

/**
 * Why a Social Alert the rules call for shouldn't go out after all, or ''. First, an alert that repeats one that already
 * went out (Escalate.gs followUpSkip_: the same post again, or a follow-up with nothing new; it never raises the stakes).
 * A hard rule (the Sprinklr owned-post threshold: 30+ comments at 30%+ negativity) always applies. Gemini's confident
 * (settings.llm_min_confidence) "not warranted" applies to alerts the rules escalate on engagement alone, and to alerts
 * escalated only because the author is a KOF when one of its no-alert checks holds and the bot can back it up
 * (kofNoAlertWhy_). P0 tags, Sensitive Topics and briefed topics are always escalated, as the Collection Requirements
 * say (in the IMs' log, under 3% of those were marked ❌).
 */
function aiVeto_(review, esc) {
  if (review && typeof SHEET_TEST_INGESTED_ === 'string' && review.ingested === SHEET_TEST_INGESTED_) return '';
  const repeat = followUpSkip_(review, esc) || (typeof memorySkip_ === 'function' ? memorySkip_(review, esc) : '');
  if (repeat) return repeat;
  const sa = review && review.socialAlert;
  if (!sa || sa.warranted !== false) return '';
  if (sa.source === 'rule') return sa.reason || 'it doesn\'t meet the escalation criteria';
  if (Number(sa.confidence) < (GEN.settings.llm_min_confidence || 0.9)) return '';
  if (esc && kofOnly_(esc)) {
    if (GEN.settings.kof_no_alert === false) return '';
    const why = kofNoAlertWhy_(review, esc);
    return why ? `AI review (KOF): ${why}` : '';
  }
  if (esc && (esc.priority === 'P0' || esc.track === 'URGENT')) return '';
  return `AI review: ${sa.reason || 'it doesn\'t meet the escalation criteria'}`;
}

/** Escalated only because the author is a KOF (with or without 2K+ engagements): no P0, Sensitive Topic or briefed topic. */
function kofOnly_(esc) {
  const urgent = (esc.reasons || []).filter(r => ['P0_TOPIC', 'SENSITIVE_TOPIC', 'BRIEFED_TOPIC', 'KOF'].includes(r));
  return esc.track === 'URGENT' && esc.priority !== 'P0' && urgent.length === 1 && urgent[0] === 'KOF';
}

/**
 * The no-alert checks (Review.gs no_alert_checks) that hold for a KOF alert and that the bot can back up, as one line
 * for the run log, or '' (then the alert goes out, as IMs send ~77% of KOF/INF alerts). Gemini's evidence is required:
 *   duplicate / comment_on_alerted / alerted_elsewhere   the post repeats, replies under or quotes a post whose alert
 *                                    went out (review.followUp: the bot's alerts or the SLRR alert log), tied to it by
 *                                    more than a guess (the thread, the same post, Burson's follow-up wording or issue
 *                                    name, or Gemini at least follow_up_min_confidence sure), Gemini didn't find
 *                                    anything new in it, and it doesn't raise the stakes (Escalate.gs stakesRose_)
 *   guidance                         the leads' current guidance was in front of Gemini (Guidance tab or their emails)
 *   knowledge_base / mistake / not_actionable   Gemini's own reading: a knowledge base document it was given and named
 *                                    says so (Knowledge.gs; review.knowledgeUsed keeps only those), the alert is a
 *                                    mistake, or nothing in it is actionable. Only with settings.kof_no_alert_judgment
 *                                    (off: it names a document on almost every review, 125 of 127; and on 24 KOF
 *                                    alerts from May-June it called 15 of them a mistake or not actionable, 90%+ sure,
 *                                    and the IMs had sent 8 of those 15)
 */
function kofNoAlertWhy_(review, esc) {
  const c = review && review.noAlertChecks;
  if (!c || !c.evidence) return '';
  const fu = review.followUp;
  const minTie = Number((GEN.settings || {}).follow_up_min_confidence) || 0.8;
  const tied = !!fu && (fu.corroborated === true || Number(fu.confidence) >= minTie);
  const repeatOf = tied && !!fu.original && fu.original.outcome === 'alerted' && fu.adds_new !== true && !stakesRose_(review, esc);
  const why = [];
  if (c.duplicate && repeatOf) why.push('already alerted');
  if (c.comment_on_alerted && repeatOf) why.push('a comment on an alerted post');
  if (c.alerted_elsewhere && repeatOf) why.push('already alerted another way');
  if (c.guidance && review.guidanceCount > 0) why.push('the leads\' current guidance');
  if (GEN.settings.kof_no_alert_judgment === true) {
    const kb = (review.knowledgeUsed || []).map(u => u.document).filter(Boolean);
    if (c.knowledge_base && kb.length) why.push(`the knowledge base (${kb.join(', ')})`);
    if (c.mistake) why.push('the alert is a mistake');
    if (c.not_actionable) why.push('not actionable');
  }
  return why.length ? `${why.join(', ')}: ${c.evidence}` : '';
}

/** Gemini's own no-alert call on a KOF alert that goes out anyway (mistake / not actionable), for the run log, or ''. */
function kofJudgment_(review) {
  const c = review && review.noAlertChecks;
  const sa = review && review.socialAlert;
  if (!c || !sa || sa.warranted !== false || Number(sa.confidence) < (GEN.settings.llm_min_confidence || 0.9)) return '';
  const what = [c.mistake ? 'a mistake' : '', c.not_actionable ? 'not actionable' : ''].filter(Boolean).join(', ');
  return what ? `${what}: ${c.evidence || sa.reason || ''}` : '';
}

/**
 * Escalated alert -> the row fields for a pending draft (threaded on the earlier Social Alert if one was sent). The AI's
 * team calls go straight onto the draft (email_groups) when the team has addresses for this alert: nobody has to react.
 */
function draftPlan_(ctx, review, history) {
  if (!draftsOn_(ctx)) return null;
  const { related, esc } = escalationFor_(ctx, review, history);
  if (!esc.escalated || aiVeto_(review, esc)) return null;
  if (esc.kb_basis) {  // KB & Guidance can start alerts: the rules alone wouldn't have
    ctx.log(`Social Alert started on what Gemini cited (the rules alone wouldn't): per ${esc.kb_basis}`);
    noteKbStart_(ctx, review, esc.kb_basis);
  }
  const judgment = kofOnly_(esc) ? kofJudgment_(review) : '';
  if (judgment) ctx.log(`KOF alert goes out; Gemini's own reading (not enough on its own to ❌): ${judgment}`);
  return draftRowFor_(ctx, review, esc, related);
}

/**
 * The row fields for a pending Social Alert for `review` with escalation `esc` (threaded on `related`'s email when that
 * one was sent): draftPlan_'s, and the stream triage's own Social Alert for an alert in another format (OtherAlerts.gs).
 * One name per issue (IssueNames.gs), checked once more right before the draft: an alert whose email replies on an
 * earlier alert's thread, or that its review tied to an existing issue, goes out under that issue's exact name, never
 * a second name in the same thread (review.fields take it too, so the alert's row carries it).
 */
function draftRowFor_(ctx, review, esc, related) {
  const existing = existingIssueOf_(review, related, null);
  if (existing && issueRenamed_(review.fields, existing)) {
    ctx.log(`Social Alert issue name: "${existing.name}", the existing issue's (${existing.why}${existing.ref ? `, ${existing.ref}` : ''}), ` +
      `not "${issueNameText_(review.fields.issue_name)}"`);
    Object.assign(review.fields, withExistingIssue_(review.fields, existing));
    esc = Object.assign({}, esc, { issue_name: existing.name });
  }
  // no_wait: Never wait on Burson; review.changed: the email's code follows the corrections (Email.gs)
  const input = emailInput_(review.fields, esc, switchOn_(ctx, 'noWait'), review.changed);
  input.recommended_groups = review.recommendedGroups || [];
  input.ai_reasons = review.groupReasons || {};
  if (review.screenshot) input.screenshot = review.screenshot;  // the picture of the post, shown in the email (Post.gs)
  // Check outage & comms docs (Control tab row 20): Google's status and the holding statement, at the bottom of the email
  if (review.commsContext && switchOn_(ctx, 'outageComms')) input.comms_context = commsEmailInput_(review.commsContext);
  const reply = related && related.email_status === 'sent' && related.email_thread ? related : null;
  if (reply) {
    const relTeams = Array.isArray(reply.team_emails) ? reply.team_emails
      : (reply.email_input && Array.isArray(reply.email_input.team_emails) ? reply.email_input.team_emails : []);
    if (relTeams.length) input.related_team_emails = relTeams;
    const relProd = String((reply.fields && reply.fields.product) || (((reply.email_input || {}).fields || {}).product) || '').trim();
    if (relProd) input.related_product = relProd;
  }
  const replyTo = reply ? { subject: reply.email_subject } : null;
  return {
    email_status: 'pending', email_input: input, email_attempts: 0, email_error: '',
    email_groups: aiTeamsWithAddresses_(input).join(' '),
    email_thread: reply ? reply.email_thread : '', email_reply_to: reply ? (reply.email_message_id || '') : '',
    email_subject: taggedSubject_(socialAlertSubject_(input, replyTo), ctx.flowTag, replyTo),
  };
}

/** The AI's team calls that can go on the draft: recipient teams (T&S is a form, not a team) with addresses on file. */
function aiTeamsWithAddresses_(input) {
  const esc = (input && input.escalation) || {};
  const prodNames = allProductsList_(input && input.fields, esc);
  const distros = (prodNames.length ? prodNames : [esc.product]).map(n => resolveDistro_(n).distro).filter(Boolean);
  const product = distros[0] || null;
  return ((input && input.recommended_groups) || []).filter(code => {
    const g = GEN.distribution.groups.find(x => x.action_code === code);
    if (!g) return false;
    if (groupRecipients_(g, product, esc, esc.text).length > 0) return true;
    return g.action_code === 'gup' && distros.slice(1).some(d => groupRecipients_(g, d, esc, esc.text).length > 0);
  });
}

function watchDraft_(ctx, alertId) { setWatched_(ctx, watched_(ctx).concat([alertId])); }

/** All open Gmail draft IDs tracked on `row` (multi-team `team_emails` drafts + `row.email_draft`). Pure. */
function rowDraftIds_(row) {
  const out = [];
  const add = id => {
    const s = String(id || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  const tms = row && row.email_input && Array.isArray(row.email_input.team_emails) ? row.email_input.team_emails : [];
  tms.forEach(te => { if (te && te.status === 'drafted' && te.draft) add(te.draft); });
  String((row && row.email_draft) || '').split(/[\s,]+/).forEach(add);
  return out;
}

/** All sent per-team thread descriptors on `row` (`[{key, product, distro, thread, message_id, subject}]`). Pure. */
function rowSentThreads_(row) {
  const tms = row && row.email_input && Array.isArray(row.email_input.team_emails) ? row.email_input.team_emails : [];
  const sent = tms.filter(te => te && te.status === 'sent' && te.thread).map(te => ({
    key: String(te.key || ''),
    product: String(te.product || ''),
    distro: String(te.distro || ''),
    thread: String(te.thread),
    message_id: String(te.message_id || ''),
    subject: String(te.subject || ''),
  }));
  if (sent.length) return sent;
  return row && row.email_thread ? [{
    key: '', product: '', distro: '', thread: String(row.email_thread),
    message_id: String(row.email_message_id || ''), subject: String(row.email_subject || ''),
  }] : [];
}

/** Deduplicated Gmail thread IDs across all sent Social Alerts on `row`. Pure. */
function rowSentThreadIds_(row) {
  return Array.from(new Set(rowSentThreads_(row).map(x => x.thread).filter(Boolean)));
}

/** True when any Social Alert draft or send for `row` has already gone out or been created. */
function rowAlreadyOut_(ctx, row) {
  if (!row) return false;
  if (rowDraftIds_(row).length > 0) return true;
  if (standInSent_(ctx, row.alert_id) && standInSent_(ctx, row.alert_id).sent) return true;
  const tms = row.email_input && Array.isArray(row.email_input.team_emails) ? row.email_input.team_emails : [];
  if (tms.some(te => te && (te.status === 'sent' || te.draft))) return true;
  const prefix = String(row.alert_id || '') + '#';
  if (prefix.length > 1) {
    if (ctx && ctx.standInSends && Object.keys(ctx.standInSends).some(k => k.indexOf(prefix) === 0 && ctx.standInSends[k].sent)) return true;
    try {
      if (standInSendLog_(ctx).some(e => e && e.sent && String(e.id || '').indexOf(prefix) === 0)) return true;
      if (autoSendLog_(ctx).some(e => e && e.sent && String(e.id || '').indexOf(prefix) === 0)) return true;
    } catch (e) {}
  }
  return false;
}

/**
 * A Social Alert just went out (the stand-in's copy, a person sending the draft, or Auto-send): what the switches do
 * after a send (Write back to SLRR BigQuery: the alert goes in alert_sends; Watch sent alerts: its post is re-checked for
 * a day; Track post-alert outcomes: its thread's replies are read for a week). Each step does nothing unless its switch
 * is ON, and none of them can stop the run or the send. Never throws.
 */
function onEmailSent_(ctx, row, report) {
  const steps = [  // [name, fn(ctx, row, report)]: the switches that act on a sent Social Alert add theirs here
    ['Alert memory', amEmailSent_],
    ['the write-back to SLRR BigQuery', bqWriteBackSent_],  // Write back to SLRR BigQuery (BigQuery.gs)
    ['Watch sent alerts', watchSentAlert_],  // Watch.gs: on the watch list for a day
    ['Track post-alert outcomes', watchOutcome_],  // Outcomes.gs: its email thread's replies read for a week
  ];
  steps.forEach(([name, fn]) => {
    try {
      fn(ctx, row, report);
    } catch (e) {
      ctx.log(`after the Social Alert for ${row.alert_id} was sent, ${name} failed: ${(e && e.message) || e}`);
    }
  });
}

/**
 * The picture of the post for the email (Post.gs fetchScreenshot_), or null: then the email goes without it. Never
 * Burson's screenshot of a sign-in prompt, even on a row queued before the bot stopped using those (savedScreenshot_).
 */
function emailScreenshot_(input) {
  const shot = typeof savedScreenshot_ === 'function' ? savedScreenshot_(input) : input && input.screenshot;
  return shot && typeof fetchScreenshot_ === 'function' ? fetchScreenshot_(shot) : null;
}

/**
 * The Social Alert for a pending row. Testing (a stand-in): sent now, to the stand-in only, and the alert gets its emojis.
 * Live with Auto-send Social Alerts ON: sent now to its distros (autoSend_). Otherwise (or when that can't send it): the
 * Gmail draft and its note under the forwarded alert. A failure is retried on the next runs. Never throws.
 * An alert naming 2+ products (e.g. "Product: Gemini Model, Devs Products") still gets one Social Alert email, with every
 * product team's alert POCs in Cc (Escalate.gs productEmailTargets_: always one target).
 */
function tryDraft_(ctx, row, report) {
  const D = ctx.drafts;
  let tnsNote = '';
  if (!runOwned_()) return;  // another run took over: the row stays pending for it, no try counted
  const alreadyOut = rowAlreadyOut_(ctx, row);
  if (!alreadyOut && typeof amSendGate_ === 'function' && !amSendGate_(ctx, row, report)) return;
  try {
    tnsNote = autoSubmitTns_(ctx, row, row.email_input || {}, report);  // '' while Auto-submit T&S form is OFF
    const input = row.email_input || {};
    if (!input.escalation) throw new Error('missing escalation input');
    const targets = productEmailTargets_(input, groupsOf_(row), row);
    if (!D.live && switchOn_(ctx, 'bsgTestEmails')) {
      sendViaBsgTestEmails_(ctx, row, input, targets, report, tnsNote);
      return;
    }
    const plan = targets[0].plan;
    if (draftsTesters_(ctx).length) {
      sendToStandIn_(ctx, row, input, plan, report, tnsNote);
      return;
    }
    if (ctx.b30Blank) {
      const why = 'Testing: enter an email address in Control!B30 (Testing: send to) to receive test emails';
      ctx.store.updateAlert(row, { email_status: 'pending', email_error: why });
      ctx.log(`Social Alert for ${row.alert_id} waiting on Control!B30`);
      return;
    }
    const email = socialAlertEmail_(input, plan, {
      test: !D.live, mailbox: D.mailbox, sendId: row.alert_id, tag: ctx.flowTag || '',
      reply: row.email_thread ? { subject: row.email_subject } : null, screenshot: emailScreenshot_(input),
    });
    const mime = buildMime_({ from: D.from, to: email.to, cc: email.cc, bcc: email.bcc, subject: email.subject, text: email.text,
      html: email.html, inline: email.inline, inReplyTo: row.email_reply_to || '', references: row.email_reply_to || '' });
    if (!runOwned_()) return;
    // An earlier try made the draft and stopped before the row said drafted: that draft, brought up to date (never a
    // second one, and no auto-send while a person has it). Gone from Gmail: maintainDrafts_ works out sent or deleted.
    const kept = row.email_draft ? reusedDraft_(ctx, row, mime) : null;
    if (kept && kept.gone) return;
    if (!kept && typeof amClaimSend_ === 'function') amClaimSend_(ctx, row);
    const auto = !kept && autoSendOn_(ctx) ? autoSend_(ctx, row, input, plan, email, mime, report, tnsNote) : null;
    if (auto && (auto.sent || auto.later)) return;  // it went out (or goes out on the next run): no draft
    const draft = kept || ctx.gmail.createDraft(mime, row.email_thread || null);
    // Auto-send: a send that may have gone out anyway is noted on the row, so maintainDrafts_ looks for it in Sent
    const tried = auto && auto.tried ? { email_input: Object.assign({}, input, { auto_send_try: auto.tried }) } : {};
    saveDraft_(ctx, row, draft, tried, !kept);  // at once: throws (the new draft deleted) when the row won't take it
    report.drafts++;
    const step = (what, fn) => {  // the draft is made and on the row: nothing below may send the row back to pending
      try { fn(); } catch (e) { ctx.log(`after making the Social Alert draft for ${row.alert_id}, ${what} failed: ${(e && e.message) || e}`); }
    };
    let wsNote = null;
    step('the Workspace form', () => { wsNote = submitWorkspaceForm_(input, D.live); });
    const o = auto && auto.warn ? { warn: auto.warn } : null;
    step('the note', () => postDraftNote_(ctx, row, draftNoteText_(D, email, plan, !!row.email_reply_to, input, wsNote, ctx,
      tnsNote ? Object.assign({ tnsNote }, o) : o), 'draft:' + row.alert_id));
    step('watching for the T&S confirmation', () => { if (tnsWhy_(input)) watchTns_(ctx, row.alert_id); });
  } catch (e) {
    const attempts = Number(row.email_attempts || 0) + 1;
    const message = String((e && e.message) || e);
    const final = attempts >= DRAFT_TRIES_;
    const what = (switchOn_(ctx, 'bsgTestEmails') || draftsTesters_(ctx).length) ? 'send' : 'draft';
    ctx.store.updateAlert(row, { email_status: final ? 'failed' : 'pending', email_attempts: attempts, email_error: truncate_(message, 300) });
    ctx.log(`Social Alert ${what} for ${row.alert_id} failed (attempt ${attempts}): ${message}`);
    if (final) {
      if (!rowAlreadyOut_(ctx, row) && row.email_status !== 'sent' && typeof amReleaseSend_ === 'function') amReleaseSend_(ctx, row);
      report.errors.push(`couldn't ${what} the Social Alert for ${row.alert_id} after ${attempts} tries: ${message}`);
      bqWriteBack_(ctx, row, 'failed', report);  // Write back to SLRR BigQuery (nothing while it's OFF)
      if (tnsNote) {  // Auto-submit T&S form: what it did for T&S (or the link) still goes under the alert
        postDraftNote_(ctx, row, tnsNote, 'tns:' + row.alert_id);
        try {
          watchTns_(ctx, row.alert_id);
        } catch (err) {
          ctx.log(`couldn't watch ${row.alert_id} for the T&S confirmation: ${(err && err.message) || err}`);
        }
      }
    }
  }
}

/**
 * Group test emails mode (`Control!B37 = ON`): sends ONE single Social Alert email per escalated alert, placing the
 * first matched product's Column C test email in `To:` and any additional matched products' Column C test emails in `Cc:`.
 * Any listed product without a Column C test email is logged as skipped; if no listed product has a Column C test email,
 * no email is sent and the row is marked `skipped_no_test_email`.
 */
function sendViaBsgTestEmails_(ctx, row, input, targets, report, tnsNote) {
  const D = ctx.drafts;
  const id = row.alert_id;
  const extraGroups = groupsOf_(row);
  const screenshot = emailScreenshot_(input);
  const t = targets[0];
  const step = (failed, fn) => {
    try { fn(); } catch (e) { ctx.log(`${failed}: ${(e && e.message) || e}`); }
  };

  const before = standInSent_(ctx, id);
  if (before && before.sent) return;
  if (before) {
    const why = 'an earlier try may have sent the Social Alert to the test email (check Sent in Gmail), so it wasn\'t sent again';
    ctx.store.updateAlert(row, { email_status: 'failed', email_error: why });
    ctx.log(`the Social Alert for ${id}: ${why}`);
    (report.notices = report.notices || []).push(`The Social Alert for ${id}: ${why}.`);
    return;
  }

  const testPlan = bsgTestPlanForTarget_(t, extraGroups);
  const skippedNoTestEmail = testPlan.skippedGroups || [];
  const matchedGroups = testPlan.matchedGroups || [];
  skippedNoTestEmail.forEach(gName => {
    ctx.log(`Social Alert for ${id} (${gName}): no test email set for ${gName} in Brand safety groups`);
  });

  if (!testPlan.to.length && !(testPlan.cc && testPlan.cc.length)) {
    const missNames = skippedNoTestEmail.join(', ') || testPlan.groupName || t.productLabel || 'this group';
    const why = `no test email set in Brand safety groups for ${missNames}`;
    ctx.log(`Social Alert for ${id}: no email sent — ${why}`);
    ctx.store.updateAlert(row, {
      email_status: 'skipped_no_test_email', email_error: why, email_at: ctx.now(),
      email_input: Object.assign({}, input, {
        bsg_test_delivery: { to: [], cc: [], matched_groups: [], skipped_groups: skippedNoTestEmail },
      }),
    });
    step('noting Group test emails skip on Control tab', () => {
      noteSwitch_('bsgTestEmails', `last skipped ${id} (${missNames}: no test email set)`);
    });
    const noteLines = [`Social Alert not sent (Group test emails ON): ${why}.`];
    if (tnsWhy_(input)) {
      noteLines.push(tnsNote || tnsFormText_(input));
      step(`couldn't watch ${id} for the T&S confirmation`, () => watchTns_(ctx, id));
    }
    step(`couldn't post the skipped-test-email note for ${id}`, () => postDraftNote_(ctx, row, noteLines.join('\n'), 'bsgskip:' + id));
    return;
  }

  const email = socialAlertEmail_(t.input, t.plan, {
    standIn: testPlan.to, standInCc: testPlan.cc, sendId: id,
    footer: wouldHaveGoneTo_(t.plan, t.input), tag: ctx.flowTag || '',
    reply: t.replySubject ? { subject: t.replySubject } : null, screenshot,
  });
  const mime = buildMime_({
    from: D.from, to: email.to, cc: email.cc, bcc: [], subject: email.subject, text: email.text, html: email.html,
    inline: email.inline, inReplyTo: t.replyTo || '', references: t.replyTo || '',
  });
  if (!runOwned_()) return;
  noteStandInSend_(ctx, { id, at: ctx.now() });
  if (!rowAlreadyOut_(ctx, row) && typeof amClaimSend_ === 'function') amClaimSend_(ctx, row);
  let sent;
  try {
    sent = ctx.gmail.sendMessage(mime, t.replyThread || null);
  } catch (e) {
    // As in sendToStandIn_: only a send Gmail refused outright is forgotten (the next try sends it); after a timeout or a
    // 5xx it may have gone out, so the note stands and it's never sent again (the row ends failed, saying to check Sent)
    if (sendRefused_(e)) {
      forgetStandInSend_(ctx, id);
      if (!rowAlreadyOut_(ctx, row) && typeof amReleaseSend_ === 'function') amReleaseSend_(ctx, row);
    }
    throw e;
  }
  const at = ctx.now();
  const thread = (sent && sent.threadId) || t.replyThread || '';
  const entry = { id, at, thread, msg: (sent && sent.id) || '', sent: true };
  (ctx.standInSends = ctx.standInSends || {})[id] = entry;
  const rcptLabel = email.to && email.to.length
    ? `To: ${email.to.join(', ')}${email.cc && email.cc.length ? `, Cc: ${email.cc.join(', ')}` : ''}`
    : `Cc: ${(email.cc || []).join(', ')}`;
  try {
    noteStandInSend_(ctx, entry);
  } catch (e) {
    ctx.log(`couldn't note that the Social Alert for ${id} went to ${rcptLabel}: ${(e && e.message) || e}`);
  }
  let messageId = '';
  try {
    const m = thread && sent && sent.id ? ctx.gmail.getThread(thread).find(x => x.id === sent.id) : null;
    messageId = (m && m.headers && m.headers['message-id']) || '';
  } catch (e) {
    ctx.log(`couldn't read the Message-ID of the Social Alert for ${id}: ${(e && e.message) || e}`);
  }
  ctx.log(`Social Alert for ${id} (${matchedGroups.join(', ') || t.productLabel}): sent to test email ${rcptLabel} from Brand safety groups`);
  report.drafts_sent++;

  const errParts = [];
  if (skippedNoTestEmail.length) errParts.push(`skipped (no test email in Brand safety groups): ${skippedNoTestEmail.join(', ')}`);
  step(`couldn't mark the Social Alert for ${id} sent`, () => {
    const was = row.email_status;
    try {
      ctx.store.updateAlert(row, {
        email_status: 'sent', email_draft: '', email_thread: thread, email_message_id: messageId,
        email_subject: email.subject || row.email_subject || '', email_to: email.to.concat(email.cc || []).join(', '),
        email_at: at, email_sent_at: at, email_sent_by: D.mailbox || '', email_error: errParts.join(' · '),
        email_input: Object.assign({}, input, {
          bsg_test_delivery: {
            to: email.to.slice(),
            cc: (email.cc || []).slice(),
            matched_groups: matchedGroups,
            skipped_groups: skippedNoTestEmail,
          },
        }),
      });
    } catch (e) {
      row.email_status = was;
      throw e;
    }
  });
  step('noting Group test emails send on Control tab', () => {
    const sentNames = matchedGroups.join(', ') || t.productLabel;
    const skipTail = skippedNoTestEmail.length ? ` · skipped ${skippedNoTestEmail.join(', ')} (no test email)` : '';
    noteSwitch_('bsgTestEmails', `last sent ${id} (${sentNames})${skipTail}`);
  });
  step(`couldn't mark the emojis for ${id}`,
    () => { report.mirrored += markEmojis_(ctx, row, escalationEmojisForRow_(row, null, false)).length; });
  step(`after the Social Alert for ${id} was sent, the after-send steps failed`, () => onEmailSent_(ctx, row, report));

  const noteLines = [];
  if (matchedGroups.length > 1 || skippedNoTestEmail.length) {
    let head = `Social Alert sent (Group test emails): ${matchedGroups.join(', ')}.`;
    if (skippedNoTestEmail.length) {
      head += ` Skipped (no test email set in Brand safety groups): ${skippedNoTestEmail.join(', ')}.`;
    }
    noteLines.push(head);
  }
  if (input.escalation && input.escalation.kb_basis) {
    noteLines.push(`${noteLines.length ? '- ' : ''}Why: ${escalationWhyText_(input.escalation)}`);
  }
  if (tnsWhy_(input)) {
    noteLines.push(tnsNote || tnsFormText_(input));
    step(`couldn't watch ${id} for the T&S confirmation`, () => watchTns_(ctx, id));
  }
  if (noteLines.length) {
    step(`couldn't post the note for ${id}`, () => postDraftNote_(ctx, row, noteLines.join('\n'), 'bsgsend:' + id));
  }
}

/**
 * Right after Gmail made the Social Alert draft (or tryDraft_ brought an earlier one up to date): the row says drafted,
 * with the draft's id, before anything else happens, so no retry makes a second one. When the row can't take it: a
 * draft made just now (`made`) is deleted, so none is left that the row doesn't know about, and this throws (the row
 * stays pending, and the next try makes it again); one that can't be deleted stays named on the row in memory (the
 * failed try writes the row back with it), so the next try brings it up to date instead of making another.
 */
function saveDraft_(ctx, row, draft, extra, made) {
  try {
    ctx.store.updateAlert(row, Object.assign({ email_status: 'drafted', email_draft: draft.id,
      email_thread: draft.threadId || row.email_thread || '', email_at: ctx.now(), email_error: '' }, extra));
  } catch (e) {
    if (made) {
      try {
        ctx.gmail.deleteDraft(draft.id);
        if (row.email_draft === draft.id) row.email_draft = '';
      } catch (err) {
        Object.assign(row, { email_draft: draft.id, email_thread: draft.threadId || row.email_thread || '',
          email_at: Number(row.email_at) || ctx.now() });
        ctx.log(`couldn't delete the Social Alert draft for ${row.alert_id} that the row didn't take (the next try reuses ` +
          `it): ${(err && err.message) || err}`);
      }
    }
    throw e;
  }
}

/**
 * A pending row that already names a draft (an earlier try made it and stopped before the row said drafted): that
 * draft brought up to date with `mime`, {id, threadId}; or {gone: true} when it's no longer in Gmail (a person sent or
 * deleted it): the row says drafted again, and maintainDrafts_ works out which, as for any draft. Throws when Gmail
 * can't be read or written (the row stays pending and is tried again, still without a second draft).
 */
function reusedDraft_(ctx, row, mime) {
  const current = ctx.gmail.getDraftRaw(row.email_draft);
  if (!current) {
    ctx.store.updateAlert(row, { email_status: 'drafted', email_error: '',
      email_at: Number(row.email_at) || Number(row.created_at) || ctx.now() });
    ctx.log(`the Social Alert draft an earlier try made for ${row.alert_id} is gone from Gmail: checking whether it was sent`);
    return { gone: true };
  }
  const threadId = current.threadId || row.email_thread || '';
  ctx.gmail.updateDraft(row.email_draft, mime, threadId || null);
  ctx.log(`the Social Alert draft an earlier try made for ${row.alert_id} is brought up to date (no second draft)`);
  return { id: row.email_draft, threadId };
}

/**
 * Testing: the Social Alert goes out now, as it would live, but only to the testers, with a last line naming the distros
 * it would have gone to. The alert then gets the emojis for those distros, as if they had it. T&S: the person filing the
 * form gets its details, and ✍️ goes on once the confirmation email arrives; or, with Auto-submit T&S form ON, `tnsNote`
 * (autoSubmitTns_: the bot submitted the test copy itself) in their place. A Social Alert that KB & Guidance can start
 * alerts started gets a note under the alert saying why ("Why: Escalated per …"), as a draft note would.
 * Never twice: the send is noted (ctx.memo 'stand_in_sent') before Gmail is asked and again once it's out, and nothing
 * after the send can fail the try (afterStandInSend_). A retry of one that went out marks the row sent without sending
 * it; one whose earlier send Gmail refused outright (sendRefused_) is sent (nothing went out); one whose earlier try
 * stopped mid-send, or ended in a timeout or a 5xx from Gmail (it may have gone out), isn't sent again (the row ends
 * failed, saying to check Sent). Not sent once another run took over (Main.gs runOwned_).
 */
function sendToStandIn_(ctx, row, input, plan, report, tnsNote) {
  const D = ctx.drafts;
  const id = row.alert_id;
  const before = standInSent_(ctx, id);
  if (before && before.sent) {  // it went out on an earlier try, but the row didn't keep that
    ctx.log(`the Social Alert for ${id} already went to the testers; marking it sent, not sending it again`);
    afterStandInSend_(ctx, row, input, report, tnsNote, { id: before.msg || '', threadId: before.thread || '' },
      Number(before.at) || ctx.now());
    return;
  }
  if (before) {  // an earlier try stopped mid-send: whether it went can't be told, so it's never sent again
    const why = 'an earlier try may have sent it to the testers (check Sent in Gmail), so it wasn\'t sent again';
    ctx.store.updateAlert(row, { email_status: 'failed', email_error: why });
    ctx.log(`the Social Alert for ${id}: ${why}`);
    (report.notices = report.notices || []).push(`The Social Alert for ${id}: ${why}.`);
    return;
  }
  const email = socialAlertEmail_(input, plan, {
    standIn: draftsTesters_(ctx), sendId: id, footer: wouldHaveGoneTo_(plan, input), tag: ctx.flowTag || '',
    reply: row.email_thread ? { subject: row.email_subject } : null, screenshot: emailScreenshot_(input),
  });
  const mime = buildMime_({ from: D.from, to: email.to, cc: [], bcc: [], subject: email.subject, text: email.text, html: email.html,
    inline: email.inline, inReplyTo: row.email_reply_to || '', references: row.email_reply_to || '' });
  if (!runOwned_()) return;  // another run took over (Main.gs): it sends this one
  noteStandInSend_(ctx, { id, at: ctx.now() });  // first: when it can't be noted, this throws and nothing is sent
  if (typeof amClaimSend_ === 'function') amClaimSend_(ctx, row);
  let sent;
  try {
    sent = ctx.gmail.sendMessage(mime, row.email_thread || null);
  } catch (e) {
    // Gmail refused it outright (sendRefused_), so nothing went out: the next try sends it. A timeout or a 5xx may have
    // gone out anyway: the note stands, so it's never sent again (the next try ends the row failed, saying to check Sent)
    if (sendRefused_(e)) {
      forgetStandInSend_(ctx, id);
      if (typeof amReleaseSend_ === 'function') amReleaseSend_(ctx, row);
    }
    throw e;
  }
  const at = ctx.now();
  const entry = { id, at, thread: (sent && sent.threadId) || row.email_thread || '', msg: (sent && sent.id) || '', sent: true };
  (ctx.standInSends = ctx.standInSends || {})[id] = entry;  // this run knows it went, even if the note below fails
  try {
    noteStandInSend_(ctx, entry);
  } catch (e) {
    ctx.log(`couldn't note that the Social Alert for ${id} went to the testers: ${(e && e.message) || e}`);
  }
  afterStandInSend_(ctx, row, input, report, tnsNote, sent || {}, at);
}

/**
 * After the testers' copy of the Social Alert went out (`sent` {id, threadId} at `at` ms), or a retry found it went:
 * the row marked sent (one that can't be stays pending, as the sheet has it, so the next try marks it, without
 * sending), the emojis for the distros it would have gone to, what the switches do after a send, the note saying why
 * when KB & Guidance can start alerts started it, and the T&S form details (or Auto-submit T&S form's note) with the
 * watch for the confirmation. Each step on its own: none can undo the send or make it go again. Never throws.
 */
function afterStandInSend_(ctx, row, input, report, tnsNote, sent, at) {
  const D = ctx.drafts;
  const id = row.alert_id;
  const step = (failed, fn) => {
    try { fn(); } catch (e) { ctx.log(`${failed}: ${(e && e.message) || e}`); }
  };
  const thread = sent.threadId || row.email_thread || '';
  let messageId = '';  // for replies on this thread when the issue comes up again
  step(`couldn't read the Message-ID of the Social Alert for ${id}`, () => {
    const m = thread && sent.id ? ctx.gmail.getThread(thread).find(x => x.id === sent.id) : null;
    messageId = (m && m.headers['message-id']) || '';
  });
  step(`couldn't mark the Social Alert for ${id} sent (the next try marks it, without sending it again)`, () => {
    const was = row.email_status;
    try {
      ctx.store.updateAlert(row, { email_status: 'sent', email_draft: '', email_thread: thread, email_message_id: messageId,
        email_at: at, email_sent_at: at, email_sent_by: D.mailbox || '', email_error: '' });
    } catch (e) {
      row.email_status = was;  // pending, as the sheet still has it: maintainDrafts_ keeps it for that next try
      throw e;
    }
  });
  report.drafts_sent++;
  step(`couldn't mark the emojis for the Social Alert for ${id}`,
    () => { report.mirrored += markEmojis_(ctx, row, escalationEmojisForRow_(row, null, false)).length; });
  step(`after the Social Alert for ${id} was sent, the after-send steps failed`, () => onEmailSent_(ctx, row, report));
  if (input.escalation && input.escalation.kb_basis) {  // KB & Guidance can start alerts: there's no draft note to say why
    step(`couldn't post why the Social Alert for ${id} went out`, () => postDraftNote_(ctx, row,
      `Social Alert sent (to the testers while testing).\n- Why: ${escalationWhyText_(input.escalation)}`, 'kb:' + id));
  }
  if (tnsWhy_(input)) {
    step(`couldn't post the T&S form details for ${id}`,
      () => postDraftNote_(ctx, row, tnsNote || tnsFormText_(input), 'tns:' + id));
    step(`couldn't watch ${id} for the T&S confirmation`, () => watchTns_(ctx, id));
  }
}

const STAND_IN_SENT_ = 'stand_in_sent';  // ctx.memo: the Social Alerts sent to the stand-in, [{id, at, thread, msg, sent}]

/**
 * ctx.memo 'stand_in_sent': the stand-in sends, oldest first ({id, at} just before the send, then {id, at, thread, msg,
 * sent: true} once it went out). A damaged note reads as none; one that can't be read throws (nothing is sent then).
 */
function standInSendLog_(ctx) {
  const raw = ctx.memo.get(STAND_IN_SENT_);
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter(e => e && e.id) : [];
  } catch (e) {
    return [];
  }
}

/** The stand-in send of alert `id` as this run knows it (ctx.standInSends) or as noted (ctx.memo), or null. */
function standInSent_(ctx, id) {
  return (ctx.standInSends && ctx.standInSends[id]) || standInSendLog_(ctx).find(e => e.id === id) || null;
}

/** Notes `entry` for its alert (in place of an earlier one), keeping AUTO_SEND_KEEP_ for 2 days at most. Throws when it can't. */
function noteStandInSend_(ctx, entry) {
  const now = ctx.now();
  const keep = standInSendLog_(ctx).filter(e => e.id !== entry.id && now - Number(e.at || 0) <= AUTO_SEND_KEEP_MS_);
  ctx.memo.set(STAND_IN_SENT_, JSON.stringify(keep.concat([entry]).slice(-AUTO_SEND_KEEP_)));
}

/** Gmail refused the stand-in send: its note is dropped, so the next try sends it. Never throws. */
function forgetStandInSend_(ctx, id) {
  try {
    const list = standInSendLog_(ctx);
    if (list.some(e => e.id === id)) ctx.memo.set(STAND_IN_SENT_, JSON.stringify(list.filter(e => e.id !== id)));
  } catch (e) {
    ctx.log(`couldn't drop the note of the refused send of the Social Alert for ${id} (so it isn't sent again): ` +
      `${(e && e.message) || e}`);
  }
}

/**
 * Whether a failed send was refused outright, so nothing went out: Gmail answered with an error below 500 (Mail.gs
 * gmailError_: e.code), or the testers-only guard stopped it before Gmail was asked (Mail.gs onlyToGuard_). Not a timeout
 * or network error (code 599) nor a 5xx: Gmail may have taken the email, so it may have gone out (as autoSend_ takes any
 * failed send). Anything else (no code, not the guard's error) can't be told, so it isn't a refusal either. Pure.
 */
function sendRefused_(e) {
  const code = Number(e && e.code);
  if (code > 0) return code < 500;
  return /^Testing: emails go only to .* so it was not sent\.$/.test(String((e && e.message) || ''));
}

/**
 * Testing: the email's last line, naming every distro it would have gone to, e.g. "Would have gone to: To: Search alert
 * POCs, gUP (social customer support); Cc: Civics, GCPA, standard CC list". Teams with no address on file are named too.
 */
function wouldHaveGoneTo_(plan, input) {
  const to = [];
  const cc = [];
  const ccProds = new Set(Array.isArray(plan.ccProductGroups) ? plan.ccProductGroups : []);
  const groupNamed = name => GEN.distribution.groups.find(g => g.name === name);
  plan.groups.forEach(name => {
    const g = groupNamed(name);
    if (!g) {
      const label = (plan.reasons[name] === 'product alert POCs' || plan.reasons[name] === 'additional product alert POCs (CC)')
        ? `${name} alert POCs`
        : name;
      (ccProds.has(name) ? cc : to).push(label);
    } else {
      const toEligible = (g.action_code === 'gup' && !ccProds.size) || plan.reasons[name] === 'selected group POCs';
      ((!ccProds.has(name) && toEligible) ? to : cc).push(name);
    }
  });
  missingTeams_(plan, input).forEach(name => {
    const g = groupNamed(name);
    (g && g.action_code === 'gup' && !ccProds.size ? to : cc).push(name);
  });
  if (!to.length && !ccProds.size && (GEN.email.default_to || []).length) to.push('default To list');
  if ((GEN.email.default_cc || []).length) cc.push('standard CC list');
  const parts = [];
  if (to.length) parts.push(`To: ${to.join(', ')}`);
  if (cc.length) parts.push(`Cc: ${cc.join(', ')}`);
  const ws = workspaceForm_(input);
  if (ws) parts.push(`Workspace form (Platform: ${ws.platform}, Engagement: ${ws.engagement})`);
  return `Would have gone to: ${parts.join('; ') || 'no distro on file'}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Auto-send Social Alerts (Control tab row 11, OFF until someone turns it on). Live only: the real Burson space, no
// stand-in anywhere, not the Mirror or auto-correct space. The bot sends the email it would have drafted, to the same
// people, then works it as when a person sends the draft: 📦 + the team emojis for who it went to, a note under the
// forwarded alert, the Workspace form, the T&S form details, and what the other switches do after a send. While testing
// nothing changes: the stand-in already gets every Social Alert sent (sendToStandIn_).
// Never twice: ctx.memo 'auto_sent' notes the alert before its send and again once it's out. A retry (a run that stopped
// after the send, a sheet write that didn't stick) then marks the row sent without sending; a send that failed, or may
// not have finished, is never tried again: that alert gets the Gmail draft, with a warning to check Sent first, and the
// try on the row (email_input.auto_send_try). If the send went out after all, maintainDrafts_ finds it in Sent, marks
// the alert sent and removes the draft (autoSentFound_). An alert that still waits on Burson for something only they
// can fix (a missing link, a tag not on the list) is a draft too: the bot doesn't send an email it knows is incomplete
// (Never wait on Burson ON: an alert lacking it; a person fixes it).
// ---------------------------------------------------------------------------------------------------------------

const AUTO_SEND_KEEP_ = 60;                          // alerts kept in ctx.memo 'auto_sent' (one property: ~9 KB at most)
const AUTO_SEND_KEEP_MS_ = 2 * 24 * 3600 * 1000;    // and for 2 days: a pending email is never retried after 1 day
const AUTO_SEND_FIND_MS_ = 30 * 60 * 1000;         // a draft left after a send that may have gone out: its send is looked
                                                    // for in Sent every run for 30 min (and once more if it's deleted)
const AUTO_SEND_WENT_MS_ = 10 * 60 * 1000;         // the bot's send is in Sent within 10 min of its try, or it's not it
const AUTO_SEND_CHECK_SENT_ = 'check Sent in Gmail before sending this draft. If it went, don\'t send it again: the bot ' +
  'finds it there, marks the alert sent and removes this draft.';  // the end of the draft note's warning

/** Auto-send Social Alerts applies to this run: the switch is ON and the run is LIVE (Main.gs runMode_), no testers. */
function autoSendOn_(ctx) {
  const D = (ctx && ctx.drafts) || {};
  const testing = runTesting_() || draftsTesters_(ctx).length > 0 || !!String(D.standIn || '').trim();
  return switchOn_(ctx, 'autoSend') && !!D.live && !testing && !ctx.sourceReadOnly;
}

/** ctx.memo 'auto_sent': the alerts the bot tried to send itself, [{id, at, thread, msg, sent}] (oldest first). */
function autoSendLog_(ctx) {
  try {
    const list = JSON.parse(ctx.memo.get('auto_sent') || '[]');
    return Array.isArray(list) ? list.filter(e => e && e.id) : [];
  } catch (e) {
    return [];
  }
}

/** Saves `entry` for its alert (in place of an earlier one), dropping old entries. Throws when it can't be saved. */
function noteAutoSend_(ctx, entry) {
  const now = ctx.now();
  const keep = autoSendLog_(ctx).filter(e => e.id !== entry.id && now - Number(e.at || 0) <= AUTO_SEND_KEEP_MS_);
  ctx.memo.set('auto_sent', JSON.stringify(keep.concat([entry]).slice(-AUTO_SEND_KEEP_)));
}

/** "Oct 14, 8:00 AM EDT": a time for the Control tab's column C ('' if it can't be written). Never throws. */
function autoSendWhen_(ms) {
  try { return Utilities.formatDate(new Date(ms), GEN.timezone || 'America/New_York', 'MMM d, h:mm a z'); } catch (e) { return ''; }
}

/**
 * Auto-send: the live Social Alert goes out now (`email` / `mime`, as built for the draft) instead of a draft. Returns
 * {sent: true} when it went out (now, or on an earlier try the row doesn't show); {later: true} when the run is out of
 * time (it stays pending, so the next run sends it); {warn} when it's a draft after all, `warn` saying why for the draft
 * note: the product has no alert contacts to send it to, the alert still waits on Burson for something only they can
 * fix (a missing link, a tag not on the list; Never wait on Burson ON: it lacks it), its link is one the bot found
 * itself (Auto-find missing links), or the
 * send failed or may not have finished (this time or before: then
 * also {tried: ms}, when it was tried, so maintainDrafts_ can look for it in Sent). `tnsNote`: Auto-submit T&S form's
 * text for the note ('' while it's OFF). Never throws.
 */
function autoSend_(ctx, row, input, plan, email, mime, report, tnsNote) {
  const id = row.alert_id;
  const before = autoSendLog_(ctx).find(e => e.id === id);
  if (before && before.sent) {  // it went out on an earlier try, but the row didn't keep that
    ctx.log(`the Social Alert for ${id} already went out (auto-send); marking it sent, not sending it again`);
    afterAutoSend_(ctx, row, input, plan, email, report, { id: before.msg || '', threadId: before.thread || '' },
      Number(before.at) || ctx.now(), tnsNote);
    return { sent: true };
  }
  if (before) {  // tried before, and it failed or didn't finish: never sent again, a person checks and sends it
    return { warn: '⚠️ The bot already tried to send this Social Alert itself (Auto-send Social Alerts) and can\'t tell ' +
      `whether it went out: ${AUTO_SEND_CHECK_SENT_}`, tried: Number(before.at) || ctx.now() };
  }
  const hasMultiCc = (plan.ccProductGroups || []).length > 0 && (email.cc || []).length > 0;
  if ((!email.to.length || !plan.to.length) && !hasMultiCc) {
    noteSwitch_('autoSend', `${id} has no alert contacts on file, so it's a draft (${autoSendWhen_(ctx.now())})`);
    return { warn: '⚠️ Not sent automatically: the To line would be empty (no alert contacts on file for this product). ' +
      'Add the recipients in Gmail, then send it.' };
  }
  // What the bot asked Burson to fix and only Burson can (a missing link, a tag not on the list): the email would go
  // out without it or wrong, so a person sends it. The fixes the bot made itself are already in the email. (Never wait
  // on Burson ON: what Burson's alert got wrong that only Burson knows; nothing waits on Burson, a person checks it.)
  const waitingOn = (Array.isArray(row.requested) ? row.requested : []).filter(x => x && x.problem);
  if (waitingOn.length) {
    const noWait = switchOn_(ctx, 'noWait');
    const fields = waitingOn.map(x => burLabel_(x.field)).join(', ');
    noteSwitch_('autoSend', `${id} ${noWait ? 'lacks what only Burson knows' : 'is waiting on Burson'} (${fields}), so it's a ` +
      `draft (${autoSendWhen_(ctx.now())})`);
    const what = truncate_(waitingOn.map(x => `${burLabel_(x.field)} (${x.problem})`).join(', '), 300);
    if (!noWait) return { warn: `⚠️ Not sent automatically: the bot asked Burson to fix ${what}. Fix it in Gmail, then send it.` };
    return { warn: `⚠️ Not sent automatically: Burson's alert has a problem the bot can't fix itself: ${what}. Fix it in ` +
      'Gmail, then send it.' };
  }
  // A link the bot found in the listening feeds (Auto-find missing links), not Burson's: a person checks it's the right
  // post before the email goes to the distros
  if (linkFoundRow_(row)) {
    const sure = Math.round((Number(row.forwarded_fields.link_found.confidence) || 0) * 100);
    noteSwitch_('autoSend', `${id}'s link was found by the bot, so it's a draft (${autoSendWhen_(ctx.now())})`);
    return { warn: `⚠️ Not sent automatically: Burson's alert had no link, and the bot found this one in the listening ` +
      `feeds (${sure}% sure). Check it's the right post, then send it.` };
  }
  if (ctx.now() > ctx.deadline) {  // a send is never started past the run's time budget
    ctx.log(`the Social Alert for ${id} goes out on the next run (auto-send): this run is out of time`);
    return { later: true };
  }
  const tried = ctx.now();
  try {
    noteAutoSend_(ctx, { id, at: tried });  // first, so a retry never sends it again whatever happens next
  } catch (e) {
    const why = String((e && e.message) || e);
    ctx.log(`couldn't note the auto-send of the Social Alert for ${id}, so it's a draft instead: ${why}`);
    return { warn: `⚠️ Not sent automatically: the bot couldn't note the send first (${truncate_(why, 160)}), and a retry ` +
      'could then send it twice. Review and send it.' };
  }
  let sent;
  try {
    sent = ctx.gmail.sendMessage(mime, row.email_thread || null);
  } catch (e) {
    const why = String((e && e.message) || e);
    ctx.log(`auto-send of the Social Alert for ${id} failed, so it's a draft instead: ${why}`);
    noteSwitch_('autoSend', `the send for ${id} failed at ${autoSendWhen_(ctx.now())}: it's a draft for a person`);
    return { warn: `⚠️ The bot tried to send this Social Alert itself (Auto-send Social Alerts) and Gmail said: ` +
      `${truncate_(why, 200)}. It may have gone out anyway: ${AUTO_SEND_CHECK_SENT_}`, tried };
  }
  const at = ctx.now();
  try {
    noteAutoSend_(ctx, { id, at, thread: (sent && sent.threadId) || row.email_thread || '', msg: (sent && sent.id) || '',
      sent: true });
  } catch (e) {  // the first note stands: a retry makes a draft with a warning instead of sending again
    ctx.log(`couldn't note that the Social Alert for ${id} was sent: ${(e && e.message) || e}`);
  }
  report.auto_sent = (report.auto_sent || 0) + 1;
  afterAutoSend_(ctx, row, input, plan, email, report, sent || {}, at, tnsNote);
  try {
    const today = etDay_(at);
    const n = autoSendLog_(ctx).filter(e => e.sent && etDay_(Number(e.at)) === today).length;
    noteSwitch_('autoSend', `${Math.max(n, 1)} sent today · last ${id} at ${autoSendWhen_(at)}`);
  } catch (e) { /* the Control tab's note only */ }
  return { sent: true };
}

/**
 * After the bot sent the Social Alert itself (`sent` {id, threadId} at `at` ms): the row marked sent (with the thread,
 * so the Results tab never takes it for the IMs' email), the emojis for who it went to, the note under the forwarded
 * alert, the Workspace form, the T&S watch, and what the other switches do after a send. Each step on its own: none can
 * undo the send or make it go again. Never throws.
 */
function afterAutoSend_(ctx, row, input, plan, email, report, sent, at, tnsNote) {
  const D = ctx.drafts;
  const id = row.alert_id;
  const step = (what, fn) => {
    try { fn(); } catch (e) { ctx.log(`after auto-sending the Social Alert for ${id}, ${what} failed: ${(e && e.message) || e}`); }
  };
  const thread = sent.threadId || row.email_thread || '';
  let messageId = '';  // for replies on this thread when the issue comes up again
  step('reading its Message-ID', () => {
    const msgs = thread ? ctx.gmail.getThread(thread) : [];
    const m = sent.id ? msgs.find(x => x.id === sent.id) : sentMessage_(msgs, { email_at: at, email_reply_to: row.email_reply_to });
    messageId = (m && m.headers['message-id']) || '';
  });
  step('marking it sent', () => ctx.store.updateAlert(row, { email_status: 'sent', email_draft: '', email_thread: thread,
    email_message_id: messageId, email_at: at, email_sent_at: at, email_sent_by: 'bot', email_error: '' }));
  report.drafts_sent++;
  step('the emojis', () => {  // who the bot itself addressed (Gmail doesn't return Bcc)
    const got = { headers: { from: D.from, to: email.to.join(', '), cc: email.cc.concat(email.bcc || []).join(', ') } };
    report.mirrored += markEmojis_(ctx, row, escalationEmojisForRow_(row, got, true)).length;
  });
  let wsNote = null;
  step('the Workspace form', () => { wsNote = submitWorkspaceForm_(input, D.live); });
  step('the note', () => postDraftNote_(ctx, row, draftNoteText_(D, email, plan, !!row.email_reply_to, input, wsNote, ctx,
    tnsNote ? { sent: true, tnsNote } : { sent: true }), 'sent:' + id));
  step('watching for the T&S confirmation', () => { if (tnsWhy_(input)) watchTns_(ctx, id); });
  step('the after-send switches', () => onEmailSent_(ctx, row, report));
}

// ---------------------------------------------------------------------------------------------------------------
// Auto-submit T&S form (Control tab row 12, OFF until someone turns it on). When T&S should see an alert, the bot
// submits the T&S Intake Form itself, with the answers the pre-filled link has (TnsForm.gs submitTnsForm_), instead of
// leaving the link for a person, then marks ✍️ as for a confirmed submission and says so under the alert:
//   testing (a stand-in in the YAML or the run, or the Mirror / auto-correct / a test space): the test copy in the
//     tester's Drive, never the real form. An urgent alert's email goes only to the stand-in.
//   live (the real Burson space, no stand-in anywhere): the real form, once its editor id is in the script property
//     TNS_LIVE_FORM_ID (the link's 1FAIpQL… id can't be opened); until then the link, as with the switch OFF. An urgent
//     alert (P0, HIGH / VIRAL KOF engagement, child safety) also gets the email to trustsafety-urgent@.
// Never twice for a post: one decision per post and form, noted before the form is touched, in the script property
// TNS_AUTO_LINKS (every flow reads it: the main and auto-correct flows see the same live posts) and on the row
// (email_input.tns_auto, and tns_submitted once it went in; the Alert log is read across flows too). A post already
// submitted (by another alert, or the other flow), or that a person already reported (✍️), isn't submitted again; the
// bot's own ✍️ stands only for the form it submitted (email_input.tns_by), so a post that only reached the test copy
// still gets the real form once live. One whose submit failed, or may not have finished, is never tried again: its note
// has the link, for a person. The urgent email only goes with the bot's own submit: an alert that's urgent on a post
// T&S already has without it gets a line asking a person to send it. Turned OFF after a submit, a retried email's note
// still says the form went in.
// ---------------------------------------------------------------------------------------------------------------

const TNS_AUTO_PROP_ = 'TNS_AUTO_LINKS';            // {"<form>|<post>": {at, id, s, w, u, ue, t}}: each post's decision
const TNS_AUTO_KEEP_ = 50;                          // posts kept there; the Alert log has the older ones
const TNS_AUTO_KEEP_MS_ = 30 * 24 * 3600 * 1000;    // and for 30 days
const TNS_AUTO_MAX_CHARS_ = 8000;                   // and never more than this (a script property holds 9 KB at most)
const TNS_AUTO_LATE_MS_ = 60 * 1000;                // a submit is never started over a minute past the run's time budget
const TNS_LIVE_FORM_PROP_ = 'TNS_LIVE_FORM_ID';     // the real form's editor id (from its …/forms/d/<id>/edit link)

/** The form Auto-submit T&S form uses in this run: 'test' (the test copy) unless the run is LIVE (Main.gs runMode_). */
function tnsAutoForm_(ctx) {
  const D = (ctx && ctx.drafts) || {};
  const testing = tnsTesting_() || draftsTesters_(ctx).length > 0 || !!String(D.standIn || '').trim() || !D.live || !!ctx.sourceReadOnly;
  return testing ? 'test' : 'live';
}

/** TNS_AUTO_LINKS: each post's decision, {"<form>|<post>": {at, id, s, …}} (a damaged property reads as none). Never throws. */
function tnsAutoLog_() {
  try {
    const log = JSON.parse(PropertiesService.getScriptProperties().getProperty(TNS_AUTO_PROP_) || '{}');
    return log && typeof log === 'object' && !Array.isArray(log) ? log : {};
  } catch (e) {
    return {};
  }
}

/**
 * Saves a post's decision in TNS_AUTO_LINKS, dropping the oldest past 30 days, TNS_AUTO_KEEP_ posts or
 * TNS_AUTO_MAX_CHARS_ (the newest is always kept). The link to the bot's submission (r) stays on the alert's row only,
 * so the property keeps as many posts. Throws when it can't.
 */
function noteTnsAuto_(key, entry, now) {
  const log = tnsAutoLog_();
  log[key] = Object.assign({}, entry);
  delete log[key].r;
  let keys = Object.keys(log).filter(k => log[k] && (k === key || now - Number(log[k].at || 0) <= TNS_AUTO_KEEP_MS_))
    .sort((a, b) => (a === key) - (b === key) || Number(log[a].at) - Number(log[b].at)).slice(-TNS_AUTO_KEEP_);
  const json = () => JSON.stringify(keys.reduce((out, k) => { out[k] = log[k]; return out; }, {}));
  let text = json();
  while (text.length > TNS_AUTO_MAX_CHARS_ && keys.length > 1) {
    keys = keys.slice(1);
    text = json();
  }
  PropertiesService.getScriptProperties().setProperty(TNS_AUTO_PROP_, text);
}

/** The bot's T&S form decision on a row ({at, form, s, …}; a row with only tns_submitted: sent), or null. Pure. */
function tnsAutoOfRow_(row) {
  const a = row && row.email_input && row.email_input.tns_auto;
  if (a && a.s) return a;
  return row && Number(row.tns_submitted) > 0 ? { at: Number(row.tns_submitted), s: 'sent' } : null;
}

/**
 * Notes the decision on the row: email_input.tns_auto ({at, form, s: trying | sent | failed | skip, w: why, u: the urgent
 * email, ue: its error, t: its thread, r: the link to the bot's submission}), and tns_submitted (ms) once it went in.
 * Throws when it can't.
 */
function markTnsAuto_(ctx, row, form, entry) {
  const mark = { at: entry.at, form, s: entry.s };
  ['w', 'u', 'ue', 't', 'r'].forEach(k => { if (entry[k]) mark[k] = entry[k]; });
  const patch = { email_input: Object.assign({}, row.email_input || {}, { tns_auto: mark }) };
  if (entry.s === 'sent' && !(Number(row.tns_submitted) > 0)) patch.tns_submitted = ctx.now();
  ctx.store.updateAlert(row, patch);
}

/**
 * What the bot already decided for this post and form, {entry, own} (own: for this very alert), or null: TNS_AUTO_LINKS
 * first, then the Alert log (this row, then any flow's rows for the post). A form that went in ('sent', which the row
 * gets first) always wins over a decision still noted as not sent (the property's last write may have failed).
 */
function tnsAutoDecided_(ctx, row, post, key, form) {
  const logged = tnsAutoLog_()[key];
  if (logged && logged.s === 'sent') return { entry: logged, own: logged.id === row.alert_id };
  const mine = tnsAutoOfRow_(row);
  if (mine && mine.s === 'sent') return { entry: Object.assign({ id: row.alert_id }, mine), own: true };
  const rows = typeof ctx.store.rowsForRecord === 'function' ? ctx.store.rowsForRecord(post)
    : ctx.store.alerts.filter(r => r.record_key === post);
  const others = rows.filter(r => r !== row && r.alert_id !== row.alert_id)
    .map(r => ({ id: r.alert_id, a: tnsAutoOfRow_(r) })).filter(x => x.a && (!x.a.form || x.a.form === form))
    .sort((x, y) => Number(x.a.at || 0) - Number(y.a.at || 0));
  const sent = others.find(x => x.a.s === 'sent');
  if (sent) return { entry: Object.assign({ id: sent.id }, sent.a), own: false };
  if (logged && logged.s) return { entry: logged, own: logged.id === row.alert_id };
  if (mine) return { entry: Object.assign({ id: row.alert_id }, mine), own: true };
  return others[0] ? { entry: Object.assign({ id: others[0].id }, others[0].a), own: false } : null;
}

/**
 * The form the bot's own ✍️ on a row stands for ('test' or 'live': the form it submitted for the post), or '' for a
 * person's ✍️ (or the confirmation email's), which stands for every form. Pure.
 */
function tnsMarkedFor_(r) {
  const input = (r && r.email_input) || {};
  const a = input.tns_auto;
  return String(input.tns_by || (a && a.s === 'sent' && a.form) || '');
}

/**
 * An alert of this flow on the post (this one first) that T&S already has for this form (✍️), or null: a person's ✍️
 * counts for every form, the bot's only for the form it submitted (the test copy never stands for the real form).
 */
function tnsReportedBy_(ctx, row, post, form) {
  const counts = r => groupsOf_(r).includes('tns') && ['', form].includes(tnsMarkedFor_(r));
  if (counts(row)) return row;
  return ctx.store.alerts.find(r => r !== row && r.record_key === post && counts(r)) || null;
}

/**
 * Auto-submit T&S form, for an alert T&S should see (`input`: its email input). Returns the text that takes the place of
 * the T&S form details (tnsFormText_) in the note under the alert: what the bot submitted; that the post was already
 * submitted (by another alert or the other flow) or reported by a person; or those details after all, under a line
 * saying why a person has to submit it (the submit failed, may not have finished, or the run was out of time). '' (the
 * note is as with the switch OFF) when the switch is OFF, T&S shouldn't see it, there's no link, there's no form to
 * submit to (live without TNS_LIVE_FORM_ID), or, live, the link is one the bot found itself (Auto-find missing links:
 * a person checks it's the right post first). Never throws, and never submits a post twice.
 */
function autoSubmitTns_(ctx, row, input, report) {
  if (!switchOn_(ctx, 'autoTns')) {  // OFF, but turned off after it submitted the form for this alert: still say so
    const mark = tnsAutoOfRow_(row);
    return mark && mark.s === 'sent'
      ? tnsAutoTextSafe_(ctx, input, Object.assign({ id: row.alert_id }, mark), true, mark.form || tnsAutoForm_(ctx)) : '';
  }
  const id = (row && row.alert_id) || '';
  let form = 'test';
  let entry = null;  // this alert's decision, once there is one
  const text = (e, own) => tnsAutoTextSafe_(ctx, input, e, own, form);
  try {
    const why = tnsWhy_(input);
    const v = why ? tnsFormValues_(input) : null;
    const post = (v && v.url && normalizeUrl_(v.url)) || '';
    if (!post || !id) return '';  // no link, no form: the link is a required question
    form = tnsAutoForm_(ctx);
    if (form === 'live' && linkFoundRow_(row)) {  // the bot found the link (Auto-find missing links): a person checks it
      noteSwitch_('autoTns', `${id}'s link was found by the bot, so a person checks it and submits the form`);
      return '';
    }
    const key = `${form}|${post}`;
    // Urgent now, on a post T&S already has with no urgent email (not urgent then, or a person reported it): the bot
    // only sends it with its own submit, so a person is asked to
    const urgent = tnsUrgent_(input);
    const urgentLine = !urgent ? '' : `\n- Urgent (${urgent}): the bot didn't send the urgent email for this post. ` +
      (form === 'test' ? `Live, a person would email ${tnsUrgentLabel_()} with the link (not while testing).`
        : `If nobody has, please email ${tnsUrgentLabel_()} with the link: ${tnsLinkFor_(input, v.url)}`);
    const done = tnsAutoDecided_(ctx, row, post, key, form);
    if (done) {
      const sentBefore = !done.own && done.entry.s === 'sent';
      if (sentBefore) tnsAutoRecord_(ctx, row, form);  // T&S has it: ✍️ on this alert too
      // this alert's own submission: its link is kept on its row (the noted decision leaves it out to stay small)
      const mine = done.own && !done.entry.r && (tnsAutoOfRow_(row) || {}).r;
      return text(mine ? Object.assign({}, done.entry, { r: mine }) : done.entry, done.own) +
        (sentBefore && !['sent', 'nobody'].includes(done.entry.u) ? urgentLine : '');
    }
    const reported = tnsReportedBy_(ctx, row, post, form);
    if (reported) {
      if (reported !== row) tnsAutoRecord_(ctx, row, tnsMarkedFor_(reported));
      const who = reported === row ? 'it\'s' : `${reported.alert_id} is`;
      return `T&S already has this post (${who} marked ✍️), so the bot didn't submit the form again.${urgentLine}`;
    }
    const decide = (s, w) => {  // noted on both, so whatever happens next this post isn't submitted again
      entry = { at: ctx.now(), id, s };
      if (w) entry.w = w;
      let noted = 0;
      const save = (what, fn) => {
        try { fn(); noted++; } catch (e) { ctx.log(`couldn't ${what} the T&S form for ${id}: ${(e && e.message) || e}`); }
      };
      save('note', () => noteTnsAuto_(key, entry, ctx.now()));
      save('mark the row for', () => markTnsAuto_(ctx, row, form, entry));
      return noted;
    };
    if (ctx.now() > Number(ctx.deadline) + TNS_AUTO_LATE_MS_) {
      ctx.log(`the T&S form for ${id} is left to a person: this run is out of time`);
      noteSwitch_('autoTns', `${id} came past the run's time budget at ${autoSendWhen_(ctx.now())}: its note has the link`);
      decide('skip', 'late');
      return text(entry, true);
    }
    let formId = '';
    if (form === 'test') {
      const copy = tnsTestForm_();
      formId = (copy && copy.id) || '';
      if (!formId) {
        noteSwitch_('autoTns', 'the test copy of the form isn\'t set up (run setupTnsTestForm()): posting the link instead');
        decide('skip', 'no test copy');
        return '';
      }
    } else {
      formId = String(PropertiesService.getScriptProperties().getProperty(TNS_LIVE_FORM_PROP_) || '').trim();
      if (!formId) {
        noteSwitch_('autoTns', `live form id not set (script property ${TNS_LIVE_FORM_PROP_}): posting the link instead`);
        decide('skip', 'no live form id');
        return '';
      }
    }
    if (!decide('trying')) {
      return 'Not submitted automatically: the bot couldn\'t note it first, and a retry could then submit it twice. ' +
        `Please submit it with the link below.\n${tnsFormText_(input)}`;
    }
    let link = '';  // the bot's submission on the form's Responses tab (for the note)
    try {
      link = submitTnsForm_(formId, Object.assign({}, v, { issue: v.issue || `${why}: ${v.url}` })) || '';
    } catch (e) {
      const err = truncate_(String((e && e.message) || e), 120);
      ctx.log(`couldn't submit the T&S form for ${id} (${form === 'live' ? 'the real form' : 'the test copy'}): ${err}`);
      noteSwitch_('autoTns', `couldn't submit the form for ${id} at ${autoSendWhen_(ctx.now())}: its note has the link`);
      decide('failed', err);  // or 'trying' stands: never tried again either way
      return text(entry, true);
    }
    return afterTnsSubmit_(ctx, row, input, report, form, key, Object.assign({}, entry, { s: 'sent' }, link ? { r: link } : {}));
  } catch (e) {  // before the submit (the log, the sheet, the test copy): the note as with the switch OFF, or the decision
    ctx.log(`Auto-submit T&S form left ${id} to a person: ${(e && e.message) || e}`);
    return entry ? text(entry, true) : '';
  }
}

/**
 * After the bot submitted the T&S form for `row`: the row marked first (tns_submitted), the post noted, ✍️ (as for a
 * confirmed submission), the urgent email when it's urgent (once: it's only ever tried right here), the Control tab's
 * count. Each step on its own: none can undo the submit or make it go again. Returns the note's text. Never throws.
 */
function afterTnsSubmit_(ctx, row, input, report, form, key, entry) {
  const id = row.alert_id;
  const step = (what, fn) => {
    try { fn(); } catch (e) { ctx.log(`after submitting the T&S form for ${id}, ${what} failed: ${(e && e.message) || e}`); }
  };
  step('marking it on the row', () => markTnsAuto_(ctx, row, form, entry));
  step('noting it', () => noteTnsAuto_(key, entry, ctx.now()));
  if (report) report.tns_auto = (report.tns_auto || 0) + 1;
  step('✍️', () => tnsAutoRecord_(ctx, row, form));
  let urgent = '';
  step('the urgent email', () => {
    urgent = tnsUrgent_(input);
    if (!urgent) return;
    entry.u = 'failed';  // until Gmail says it went
    const res = sendTnsUrgent_(ctx, input, form, urgent);
    entry.u = res.u;
    if (res.t) entry.t = res.t;
    if (res.ue) entry.ue = truncate_(res.ue, 100);
    if (res.u === 'sent' && report) report.tns_urgent = (report.tns_urgent || 0) + 1;
    if (res.u === 'failed') ctx.log(`couldn't send the urgent T&S email for ${id}: ${res.ue}`);
  });
  if (urgent) {  // each on its own, the row first: a later alert on the post reads either to know it went
    step('marking the urgent email on the row', () => markTnsAuto_(ctx, row, form, entry));
    step('noting the urgent email', () => noteTnsAuto_(key, entry, ctx.now()));
  }
  step('the Control tab', () => {
    const today = etDay_(ctx.now());
    const log = tnsAutoLog_();
    const n = Object.keys(log).filter(k => log[k].s === 'sent' && etDay_(Number(log[k].at)) === today).length;
    noteSwitch_('autoTns', `${Math.max(n, 1)} submitted today · last ${id}${form === 'test' ? ' (test copy)' : ''} at ` +
      autoSendWhen_(ctx.now()));
  });
  return tnsAutoTextSafe_(ctx, input, entry, true, form);
}

/**
 * T&S has the post: ✍️ recorded on the row and marked on the alert (once), as for the confirmation email. `form`: the
 * form the bot submitted for the post (email_input.tns_by: this ✍️ stands only for that form); none for a person's ✍️.
 * Never throws.
 */
function tnsAutoRecord_(ctx, row, form) {
  try {
    if (form && !groupsOf_(row).includes('tns')) {
      ctx.store.updateAlert(row, { email_input: Object.assign({}, row.email_input || {}, { tns_by: form }) });
    }
    if (recordTns_(ctx, row)) markAlert_(ctx, row, 'tns');
  } catch (e) {
    ctx.log(`couldn't mark ✍️ on ${row.alert_id}: ${(e && e.message) || e}`);
  }
}

/**
 * The urgent email for a post whose T&S form the bot just submitted: to the testers while testing (with a line naming who
 * it would have gone to), to trustsafety-urgent@ only live. {u: 'sent' | 'failed' | 'nobody' (a test space with no
 * testers), t: its Gmail thread (the Results tab never takes it for the IMs' email: it has the post's link), ue: Gmail's
 * error}. Never throws.
 */
function sendTnsUrgent_(ctx, input, form, urgent) {
  const D = ctx.drafts || {};
  const urgentTo = tnsUrgentAlias_();
  let to;
  if (form === 'live') {
    to = urgentTo ? [urgentTo] : [];
  } else if (switchOn_(ctx, 'bsgTestEmails')) {
    to = typeof bsgCleanTestEmails_ === 'function' ? bsgCleanTestEmails_([GEN && GEN.email && GEN.email.test_tns_urgent]) : [];
    if (!to.length && ctx && typeof ctx.log === 'function') {
      ctx.log('urgent T&S email not sent: no test email set for T&S Urgent in Brand safety groups');
    }
  } else {
    to = watchTesters_(ctx);
  }
  if (!to.length) return { u: 'nobody' };
  try {
    const m = tnsUrgentEmail_(input, urgent, form === 'test', ctx.flowTag || '');
    const sent = ctx.gmail.sendMessage(buildMime_({ from: D.from, to, subject: m.subject, text: m.text,
      html: htmlEsc_(m.text).replace(/\n/g, '<br>') }), null);
    return { u: 'sent', t: (sent && sent.threadId) || '' };
  } catch (e) {
    return { u: 'failed', ue: String((e && e.message) || e) };
  }
}

/** The urgent email to T&S for a submitted form: {subject, text}, as an IM would write it. Pure but for the form's values. */
function tnsUrgentEmail_(input, urgent, testing, tag) {
  const f = (input && input.fields) || {};
  const esc = (input && input.escalation) || {};
  const v = tnsFormValues_(input);
  const subject = taggedSubject_(`URGENT T&S: ${f.product || esc.product || 'Google'} | ${f.issue_name || esc.issue_name ||
    'Alert'} | ${f.social_network || esc.platform || '-'}`, tag, null);
  const text = [
    `Urgent (${urgent}): we just submitted the T&S Intake Form (Marketing) for this post.`, '',
    `Link: ${v.url}`,
    `Why T&S: ${tnsWhy_(input) || 'flagged'}`,
    `Google Product: ${v.product} \u00b7 Topic Impacted: ${v.topic}`,
    `What's the Issue? ${v.issue || '-'}`,
  ].concat(v.notes ? [v.notes] : [],
    testing ? ['', `Testing: this went only to the testers. Live it goes to ${tnsUrgentLabel_()}.`] : []);
  return { subject, text: text.join('\n') };
}

/** tnsAutoText_, or (should even that fail) a short line that still says what happened. Never throws. */
function tnsAutoTextSafe_(ctx, input, entry, own, form) {
  try {
    return tnsAutoText_(ctx, input, entry, own, form);
  } catch (e) {
    ctx.log(`couldn't write the T&S note: ${(e && e.message) || e}`);
    if (entry && entry.s === 'sent') {
      return own ? 'The alert has been submitted to T&S for review.' : `The alert was already submitted to T&S for review (${entry.id}).`;
    }
    return 'The T&S form wasn\'t submitted automatically: please submit it with the T&S form link.';
  }
}

/**
 * The note's text for a post's decision `entry` ({at, id, s, w, u, ue}; own: this alert's), in place of tnsFormText_:
 * submitted, already submitted by another alert, or the form details under a line saying why
 * a person has to submit it after all. '' (the usual details) for a post with no form to submit to.
 */
function tnsAutoText_(ctx, input, entry, own, form) {
  const testing = form === 'test';
  if (entry.s === 'sent' && !own) {
    return `The alert was already submitted to T&S for review${testing ? ' (test copy)' : ''}: ${entry.id}, ` +
      `${autoSendWhen_(Number(entry.at))}. Not submitted again.`;
  }
  if (entry.s === 'sent') {
    const v = tnsFormValues_(input);
    const urgent = tnsUrgent_(input);
    const why = tnsWhy_(input) || 'flagged';
    const fullSentence = why.length > 50 ||
      /\s(?:is|are|was|were|has|have|shows?|provides?|incorporates?|alleges?|contains?|features?|depicts?|displays?)\b/i.test(why);
    const headLine = fullSentence
      ? `The alert has been submitted to T&S for review (${why.charAt(0).toLowerCase() + why.slice(1).replace(/\.$/, '')}).`
      : `The alert regarding ${why} has been submitted to T&S for review.`;
    const lines = [
      headLine,
      '- Intake Request: Marketing',
      `- Google Product: ${v.product}`,
      `- Topic Impacted: ${v.topic}`,
      `- Link: ${tnsLinkFor_(input, v.url)}`,
    ];
    // what was submitted, on the form's Responses tab (its owner and editors can open it)
    if (entry.r) lines.push(`- Submission: ${chatLink_(entry.r, `View the submission${testing ? ' (test copy)' : ''}`)}`);
    if (urgent && entry.u === 'failed') {
      lines.push(`- Urgent (${urgent}): the bot couldn't send the urgent email${entry.ue ? ` (${entry.ue})` : ''}: ` +
        (testing ? `live, a person would email ${tnsUrgentLabel_()} with the link (not while testing).`
          : `please email ${tnsUrgentLabel_()} with the link.`));
    }
    return lines.join('\n');
  }
  if (entry.s === 'skip' && entry.w !== 'late') return '';
  let head;
  if (!own) {
    head = `The bot didn't submit the T&S form for this post with ${entry.id} (${entry.s === 'skip'
      ? 'that run was out of time' : 'it couldn\'t confirm it went in'}): if nobody has submitted it, please submit it ` +
      'with the link below.';
  } else if (entry.s === 'skip') {
    head = 'Not submitted automatically: the run was out of time. Please submit it with the link below.';
  } else if (entry.s === 'failed') {
    head = `The bot couldn't submit the T&S form itself (${entry.w || 'an error'}): please submit it with the link below.`;
  } else {
    head = 'The bot tried to submit the T&S form itself and can\'t tell whether it went in: if you\'re not sure, please ' +
      'submit it with the link below.';
  }
  return `${head}\n${tnsFormText_(input)}`;
}

function baseAlertId_(row) { return (row && (row.resend_of || row.alert_id)) || ''; }

function liveAlertRow_(ctx, row) {
  if (!row) return null;
  return (row.forward_message && ctx.store.alertByForward(row.forward_message)) || row;
}

function postDraftNote_(ctx, row, text, key) {
  if (!row.forward_message) return;
  try {
    postTo_(ctx, ctx.spaces.analyst.id, text, row.forward_thread || null, key, null, !isSfBurson_(ctx.sfBurson, ctx.spaces.analyst.id));
  } catch (e) {
    ctx.log(`couldn't post the draft note for ${row.alert_id}: ${(e && e.message) || e}`);
  }
}

/**
 * The post that carries the alert's legend emojis besides the analyst copy: Burson's post, or in the auto-correct test
 * space (the Burson space is only read) the corrected alert itself. Its emojis are kept in the row's `mirrored`.
 */
function alertPost_(ctx, live) {
  return String((ctx && ctx.sourceReadOnly ? live.forward_message : live.source_message) || '');
}

/** Puts a legend emoji on the alert in both spaces (the analyst copy and Burson's live post), once. True if added. */
function markAlert_(ctx, row, code) {
  const S = ctx.settings || {};
  const x = legendEmoji_(code);
  if (!x || !S.react || S.dry_run) return false;
  const live = liveAlertRow_(ctx, row) || row;
  const post = alertPost_(ctx, live);
  Array.from(new Set([row.forward_message, post].filter(Boolean))).forEach(name => {
    try {
      ctx.chat.react(name, x);
      if (name === post && ctx.outboundBlocked) forwardOwnBurson_(ctx, { type: 'react', name, emoji: x });  // row 24 (Outbox.gs)
    } catch (e) {
      ctx.log(`couldn't react ${x} on ${name}: ${(e && e.message) || e}`);
    }
  });
  const mirrored = String(live.mirrored || '').split(' ').filter(Boolean);  // so the analyst-space copy isn't copied again
  if (!mirrored.some(e => legendByEmoji_(e) === legendByEmoji_(x))) ctx.store.updateAlert(live, { mirrored: mirrored.concat([x]).join(' ') });
  return true;
}

/** ❌ "No action taken": the IM's mark when no Social Alert goes out. */
function markNoAction_(ctx, row) { return markAlert_(ctx, row, 'no_action'); }

/**
 * Legend emojis on the alert in both spaces (the analyst copy and Burson's live post), recorded on the live row so they
 * aren't copied again. Returns the emojis that were new on Burson's post.
 */
function markEmojis_(ctx, row, emojis) {
  const S = ctx.settings || {};
  if (!S.react || S.dry_run || !(emojis || []).length) return [];
  const live = liveAlertRow_(ctx, row) || row;
  const mirrored = String(live.mirrored || '').split(' ').filter(Boolean);
  const added = [];
  emojis.forEach(x => {
    const entry = legendByEmoji_(x);
    const onLive = !!entry && mirrored.some(e => legendByEmoji_(e) === entry);
    const post = alertPost_(ctx, live);
    const targets = Array.from(new Set([row.forward_message, onLive ? '' : post].filter(Boolean)));
    targets.forEach(name => {
      try {
        ctx.chat.react(name, x);
        if (name === post && ctx.outboundBlocked) forwardOwnBurson_(ctx, { type: 'react', name, emoji: x });  // row 24 (Outbox.gs)
      } catch (e) {
        ctx.log(`couldn't react ${x} on ${name}: ${(e && e.message) || e}`);
      }
    });
    if (!onLive && post) { mirrored.push(x); added.push(x); }
  });
  if (added.length) ctx.store.updateAlert(live, { mirrored: mirrored.join(' ') });
  return added;
}

/**
 * A reviewed alert with nothing left for Burson to fix that doesn't warrant a Social Alert (the rules, or the AI's
 * confident call): ❌ No action taken, as the IM marks it (the reason goes to the run log). With "Never wait on Burson"
 * ON, every such alert is decided right away with the bot's own corrections (it doesn't wait on Burson's resend).
 * When T&S should still see it,
 * that's an action: the person filing the form gets its details, and the bot marks ✍️ once it's submitted (with
 * Auto-submit T&S form ON, the bot submits it itself: autoSubmitTns_). A repeat of an alert that already went out (the
 * same post, or the author's follow-up with nothing new) is just ❌: the earlier alert covered T&S and everyone else.
 * Only while drafts are on.
 */
function noEmailNeeded_(ctx, row, review, history, report) {
  if (!draftsOn_(ctx) || !(ctx.settings && ctx.settings.react)) return;
  const { esc } = escalationFor_(ctx, review, history);
  const repeat = followUpSkip_(review, esc) || (typeof memoryRepeat_ === 'function' ? memoryRepeat_(review, esc) : '');
  const veto = aiVeto_(review, esc);
  const decide = text => { try { ctx.store.updateAlert(row, { decision: truncate_(text, 300) }); } catch (e) { /* a log column only */ } };
  if (!repeat && esc.action === 'YOUTUBE_CHAT_ONLY') {
    decide('YouTube: left for a person (the YouTube Social chat ping)');
    bqWriteBack_(ctx, row, 'decided', report);  // Write back to SLRR BigQuery (nothing while it's OFF)
  }
  if (!repeat && ((esc.escalated && !veto) || esc.action === 'YOUTUBE_CHAT_ONLY')) return;  // the YouTube chat ping is a person's job
  const input = Object.assign(emailInput_(review.fields, esc, switchOn_(ctx, 'noWait'), review.changed), { ai_reasons: review.groupReasons || {} });
  if (review.screenshot) input.screenshot = review.screenshot;
  if (!repeat && tnsWhy_(input)) {
    const tnsNote = autoSubmitTns_(ctx, row, input, report);  // '' while Auto-submit T&S form is OFF
    const submitted = !!tnsNote && Number(row.tns_submitted) > 0;  // the bot submitted it for this alert
    decide(`T&S form only (${tnsWhy_(input)})${submitted ? ' · auto-submitted' : ''}`);
    postDraftNote_(ctx, row, tnsNote || tnsFormText_(input), 'noaction:' + row.alert_id);
    watchTns_(ctx, row.alert_id);
    bqWriteBack_(ctx, row, 'decided', report);  // Write back to SLRR BigQuery (nothing while it's OFF)
    return;
  }
  decide(`❌ ${repeat || veto || noEmailWhy_(esc)}`);
  if (markNoAction_(ctx, row)) ctx.log(`${row.alert_id}: ❌ no Social Alert needed (${veto || noEmailWhy_(esc)})`);
  const mv = review && review.memory && review.memory.verdict;
  if (mv && mv.skip && typeof amHeldTrace_ === 'function') {
    amHeldTrace_(ctx, row, mv);
    if (mv.fold && typeof amHeldNoteText_ === 'function') postDraftNote_(ctx, row, amHeldNoteText_(mv), 'amheld:' + row.alert_id);
  }
  bqWriteBack_(ctx, row, 'decided', report);
}

function noEmailWhy_(esc) {
  const s = String(esc.suppression || '');
  if (s === 'ongoing_no_kof') return 'ongoing issue, no KOF author and under 2K engagements';
  if (s === 'youtube_no_action') return 'YouTube is the subject';
  if (/^EXCLUDED_/.test(s)) return 'excluded: ' + s.replace(/^EXCLUDED_/, '').toLowerCase().replace(/_/g, ' ');
  return `${esc.priority || 'no priority'}, ${fmtInt_(esc.engagement_total || 0)} engagements: below the escalation criteria`;
}

// Trust & Safety: a person submits the form (unless Auto-submit T&S form is ON: autoSubmitTns_), and the bot marks ✍️
// itself once the WD Intake Request email shows up.
const TNS_WATCH_DAYS_ = 3;
const TNS_CHECKS_PER_RUN_ = 10;

function tnsWatched_(ctx) { try { return JSON.parse(ctx.memo.get('tns_watch') || '[]') || []; } catch (e) { return []; } }

function watchTns_(ctx, alertId) {
  const ids = tnsWatched_(ctx);
  if (!ids.includes(alertId)) ctx.memo.set('tns_watch', JSON.stringify(ids.concat([alertId])));
}

/** The post's link the way Gmail can search for it (no scheme, www or query string). */
function tnsLinkOf_(row) {
  const url = String(((row.email_input || {}).fields || {}).post_url || (row.forwarded_fields || {}).post_url || '').trim();
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** T&S was submitted (an analyst's ✍️ or the confirmation email): noted on the row, and the draft's T&S row becomes Yes. */
function recordTns_(ctx, row) {
  const have = groupsOf_(row);
  if (have.includes('tns')) return false;
  const groups = have.concat(['tns']).join(' ');
  const input = Object.assign({}, row.email_input || {}, { tns_submitted: true });  // ✍️ = "Reported to Trust & Safety"
  ctx.store.updateAlert(row, row.email_input ? { email_groups: groups, email_input: input } : { email_groups: groups });
  if (row.email_status === 'drafted' && !markTnsSubmitted_(ctx, row, input)) {
    postDraftNote_(ctx, row, 'T&S is in. Please change *T&S* to *Yes* in the draft before sending ' +
      '(it was edited in Gmail, so it was left alone).', 'tnsfield:' + row.alert_id);
  }
  return true;
}

/**
 * Every run: an alert waiting on T&S gets ✍️ in both spaces as soon as the WD Intake Request email for its link arrives
 * (and, with "Track post-alert outcomes" ON, "T&S confirmed" as its outcome). At most TNS_CHECKS_PER_RUN_ alerts a run:
 * the ones checked and still waiting go to the end of the list, behind those this run didn't get to, so each gets its turn.
 */
function checkTnsEmails_(ctx, report) {
  const ids = tnsWatched_(ctx);
  if (!ids.length || !ctx.gmail || typeof ctx.gmail.findMessages !== 'function') return;
  const later = [];  // not checked this run (past TNS_CHECKS_PER_RUN_): first in line next run
  const keep = [];   // checked and still waiting: behind those
  ids.forEach((id, i) => {
    if (i >= TNS_CHECKS_PER_RUN_) { later.push(id); return; }
    const row = ctx.store.alertById(id);
    if (!row || groupsOf_(row).includes('tns') || ctx.now() - Number(row.created_at || 0) > TNS_WATCH_DAYS_ * DAY_MS_) return;
    const link = tnsLinkOf_(row);
    if (!link) return;
    try {
      const found = ctx.gmail.findMessages(`subject:"WD Intake Request" newer_than:${TNS_WATCH_DAYS_}d "${link}"`, 1);
      if (found.length && recordTns_(ctx, row)) {
        markAlert_(ctx, row, 'tns');
        report.tns_marked = (report.tns_marked || 0) + 1;
        tnsConfirmedOutcome_(ctx, row, report);  // Track post-alert outcomes (Outcomes.gs): "T&S confirmed"; nothing when OFF
        return;
      }
    } catch (e) {
      ctx.log(`couldn't check for the T&S confirmation for ${id}: ${(e && e.message) || e}`);
    }
    keep.push(id);
  });
  const next = later.concat(keep);
  if (JSON.stringify(next) !== JSON.stringify(ids)) ctx.memo.set('tns_watch', JSON.stringify(next));
}

function imMention_(ctx) {
  const imUser = ctx && ctx.memo && ctx.memo.get('im_user');
  if (imUser && /^users\//.test(imUser)) return `<${imUser}>`;
  if (ctx && ctx.botUser && /^users\//.test(ctx.botUser)) return `<${ctx.botUser}>`;
  return '@Incident Manager';
}

function escalationWhyBullets_(esc) {
  if (!esc) return ['• Meets escalation criteria'];
  const bullets = [];
  const reasons = esc.reasons || [];
  if (reasons.includes('KB_OR_GUIDANCE')) {  // KB & Guidance can start alerts (Control tab row 13)
    bullets.push(`• Escalated per ${esc.kb_basis || 'the Guidance tab or a Resources document'}`);
  }
  if (reasons.includes('STREAM_TRIAGE')) {  // an alert in another format, escalated on its stream's triage (OtherAlerts.gs)
    bullets.push(`• Stream triage: ${esc.triage_basis || 'the triage of an alert in another format'}`);
  }
  if (reasons.includes('PROACTIVE_WATCH')) {  // a watch alert (WatchAlerts.gs): the watch's yes at its bar
    bullets.push(`• Proactive watch: ${esc.triage_basis || 'a watch flagged it at its bar'}`);
  }
  if (reasons.includes('EARLY_DETECTION')) {  // an early-detection cluster or velocity alert (BigQuery.gs / EarlyDetection.gs)
    bullets.push(`• Early detection: ${esc.triage_basis || 'low-tier semantic cluster or velocity spike'}`);
  }
  if (reasons.includes('P0_TOPIC') || esc.priority === 'P0') {
    bullets.push(`• P0 criteria (${esc.exposure_tag || 'P0 tag'})`);
  }
  if (reasons.includes('KOF') || esc.is_kof) {
    bullets.push('• Viral KOF author');
  }
  if (reasons.includes('HIGH_ENGAGEMENT') && esc.engagement_total) {
    bullets.push(`• High engagement (${fmtInt_(esc.engagement_total)}${esc.platform ? ' on ' + esc.platform : ''})`);
  }
  if (reasons.includes('SENSITIVE_TOPIC') && (esc.sensitive_topics || []).length) {
    bullets.push(`• Sensitive topic (${esc.sensitive_topics.join(', ')})`);
  }
  if (reasons.includes('BRIEFED_TOPIC')) {
    bullets.push('• Briefed launch/topic');
  }
  if (!bullets.length) {
    bullets.push(`• ${esc.priority || 'Escalated'}${esc.exposure_tag ? ' (' + esc.exposure_tag + ')' : ''}`);
  }
  return bullets;
}

/** "P0 criteria (Product - Perceived bias) · High engagement (29,425 on X)": why an alert is escalated, on one line. */
function escalationWhyText_(esc) {
  return escalationWhyBullets_(esc).map(b => b.replace(/^•\s*/, '')).join(' · ');
}

/** Teams that should be on the email but have no address on file (from the rules or the AI's call). */
function missingTeams_(plan, input) {
  const ai = (input && input.ai_reasons) || {};
  const names = plan.missing.slice();
  GEN.distribution.groups.forEach(g => {
    if (Object.prototype.hasOwnProperty.call(ai, g.action_code) && !plan.groups.includes(g.name) && !names.includes(g.name)) names.push(g.name);
  });
  return names;
}

/**
 * The one note under the alert when a draft is saved (no stand-in): where it is, why, who's on it, and the T&S form
 * details when T&S should see it. The bot marks every emoji itself, so there's no emoji list or legend.
 * o (optional, Auto-send Social Alerts): {sent: true} when the bot sent it itself instead (the note says so in place of
 * the draft line); {warn} a line under the first, saying why it's a draft after all; {tnsNote} (Auto-submit T&S form)
 * in place of the T&S form details. Without o, the note is as it was.
 */
function draftNoteText_(D, email, plan, reply, input, wsNote, ctx, o) {
  const esc = (input && input.escalation) || {};
  const productGroups = plan.groups.filter(g => plan.reasons[g] === 'product alert POCs');
  const productName = productGroups.length ? productGroups.join(', ') : allProductsText_(input && input.fields, esc, 'this product');
  const ccGroups = plan.groups
    .filter(g => plan.reasons[g] !== 'product alert POCs')
    .map(g => plan.reasons[g] === 'additional product alert POCs (CC)' ? `${g} alert POCs` : g);
  const toCount = D.live ? email.to.length : plan.to.length;
  const ccCount = D.live ? email.cc.length : plan.cc.length;
  const multiCcOnly = !toCount && Array.isArray(plan.ccProductGroups) && plan.ccProductGroups.length > 0;
  const kind = reply ? 'Social Alert update draft (replying to the earlier email)' : 'Social Alert draft';
  const toLine = toCount
    ? `- To: ${productName} alert POCs (${toCount})`
    : (multiCcOnly
      ? `- To: none (multi-product alert — all product teams in CC)`
      : `- To: empty (${productName} has no alert contacts on file)`);
  const lines = [
    o && o.sent
      ? `Social Alert sent${reply ? ' (as an update on the earlier email)' : ''}: the bot sent it itself ` +
        '(Auto-send Social Alerts is ON).'
      : `${imMention_(ctx)} ${kind} is in Gmail Drafts: review and send it, or delete it to skip.`,
    `- Why: ${escalationWhyText_(esc)}`,
    toLine,
    `- Cc: ${ccGroups.length ? ccGroups.join(', ') + ' + ' : ''}standard CC (${ccCount})` + (D.live ? '' : ' (test draft, only to you)'),
  ];
  if (o && o.warn) lines.splice(1, 0, `- ${String(o.warn).replace(/^\u26a0\ufe0f\s*/, '')}`);
  if (plan.notes.length) lines.push(`- Note: ${plan.notes.join('; ')}`);
  if (tnsWhy_(input)) lines.push((o && o.tnsNote) || tnsFormText_(input));
  if (wsNote) lines.push(`- ${wsNote}`);
  return lines.join('\n');
}

/**
 * The legend emojis for a sent Social Alert, in the order the IM marks them (checked against the SLRR alert log):
 * 📰 GCPA first (on ~95% of Social Alerts, except YouTube), 📦 when the product's own alert POCs got it (Brand has none,
 * so a Brand alert gets 📰 without 📦), then every team on the email in legend order, and ✍️ once T&S is submitted.
 * Testing (sent to the stand-in, live = false): every distro the email would have gone to, including teams with no
 * address on file yet (GCPA, GSOC), since the stand-in got it in their place. A real sent email (live = true) decides by
 * its recipients: a team someone took off gets no emoji, a team that isn't on it (or has no address) gets none either.
 */
function escalationEmojisForRow_(row, sent, live) {
  const codes = [];
  const add = code => { if (code && !codes.includes(code)) codes.push(code); };
  const input = (row && row.email_input) || {};
  const extraGroups = groupsOf_(row);
  const esc = input.escalation;
  const got = live ? sentRecipients_(sent) : null;  // the stand-in's copy can't say who it was for: the plan does
  const teams = [];
  let paOn = false;
  if (esc) {
    const prodNames = allProductsList_(input.fields, esc);
    const distros = (prodNames.length ? prodNames : [esc.product]).map(n => resolveDistro_(n).distro).filter(Boolean);
    const product = distros[0] || null;
    const emailsOf = g => {
      const list = groupRecipients_(g, product, esc, esc.text);
      if (g.action_code === 'gup' && distros.length > 1) {
        distros.slice(1).forEach(d => addUnique_(list, groupRecipients_(g, d, esc, esc.text)));
      }
      return list.map(e => String(e).toLowerCase());
    };
    const groupOf = name => GEN.distribution.groups.find(x => x.name === name || x.action_code === name);
    const plan = planRecipients_(esc, esc.text, extraGroups.filter(g => g !== 'tns'));
    const pa = [];
    distros.forEach(d => (d.pa || []).forEach(e => { if (e) pa.push(String(e).toLowerCase()); }));
    paOn = pa.length > 0 && (!got || pa.some(e => got.has(e)));
    (plan.groups || []).forEach(gName => {
      const g = groupOf(gName);
      if (g && g.action_code && (!got || emailsOf(g).some(e => got.has(e)))) teams.push(g.action_code);
    });
    if (!got) {  // teams the rules or the AI call for that have no address on file: the stand-in got it for them
      (plan.missing || []).forEach(gName => { const g = groupOf(gName); if (g && g.action_code) teams.push(g.action_code); });
      Object.keys(input.ai_reasons || {}).forEach(code => {
        const g = GEN.distribution.groups.find(x => x.action_code === code);
        if (g && !emailsOf(g).length) teams.push(code);
      });
    }
    if (got) {  // teams someone added by hand in Gmail (addresses that aren't the product's or the standard CC)
      const baseList = [].concat(GEN.email.default_cc || [], GEN.email.default_to || []);
      distros.forEach(d => baseList.push.apply(baseList, [].concat(d.pa || [], d.execs || [],
        ...(d.conditional || []).map(c => c.recipients || []))));
      const base = new Set(baseList.map(e => String(e).toLowerCase()));
      GEN.distribution.groups.forEach(g => {
        if (g.action_code && emailsOf(g).some(e => !base.has(e) && got.has(e))) teams.push(g.action_code);
      });
      // ➕ "Reported to team not listed above": someone added addresses that belong to no team, product or region on file
      const known = new Set(Array.from(base).concat(plan.to, plan.cc, [GEN.email.from_email, senderOf_(sent)])
        .filter(Boolean).map(e => String(e).toLowerCase()));
      GEN.distribution.products.forEach(p => [].concat(p.pa || [], p.gup || [], p.execs || [],
        ...(p.conditional || []).map(c => c.recipients || [])).forEach(e => known.add(String(e).toLowerCase())));
      GEN.distribution.groups.forEach(g => (g.recipients || []).forEach(e => known.add(String(e).toLowerCase())));
      (GEN.distribution.regional_leads || []).forEach(r => [].concat(r.recipients || [], r.reputational_risk_recipients || [])
        .forEach(e => known.add(String(e).toLowerCase())));
      (typeof GEN_CHANNEL_OWNERS !== 'undefined' ? GEN_CHANNEL_OWNERS : []).forEach(co => (co.owners || [])
        .forEach(e => known.add(String(e).toLowerCase())));
      if (Array.from(got).some(e => !known.has(e))) teams.push('other_team');
    }
    if (!got) {  // a team added to it that has no address on file: the stand-in got it for them
      extraGroups.forEach(code => {
        const g = GEN.distribution.groups.find(x => x.action_code === code);
        if (code !== 'tns' && (!g || !emailsOf(g).length)) teams.push(code);
      });
    }
  } else {
    extraGroups.forEach(code => { if (code !== 'tns') teams.push(code); });
  }
  const order = GEN.legend.map(a => a.code);
  if (teams.includes('gcpa')) add('gcpa');
  if (paOn) add('pa');
  teams.filter(c => c !== 'tns').sort((a, b) => order.indexOf(a) - order.indexOf(b)).forEach(add);
  if (!codes.length) add('pa');  // the email went to someone: 📦 at least
  if (extraGroups.includes('tns')) add('tns');
  return codes.map(legendEmoji_).filter(Boolean);
}

/** Everyone a sent message went to (To + Cc, lowercased), or null when Gmail didn't return those headers. */
function sentRecipients_(sent) {
  const h = (sent && sent.headers) || {};
  if (h.to === undefined && h.cc === undefined) return null;
  const out = new Set();
  [h.to, h.cc].forEach(v => (String(v || '').match(ADDRESS_RX_) || []).forEach(e => out.add(e.toLowerCase())));
  return out;
}

/** The message that sent the draft: SENT, newer than the draft, and not the email it replied to. */
function sentMessage_(thread, row) {
  const since = Number(row.email_at || 0) - SENT_SKEW_MS_;
  const sent = thread.filter(m => m.labels.includes('SENT') && m.at >= since &&
    (!row.email_reply_to || m.headers['message-id'] !== row.email_reply_to));
  return sent.sort((a, b) => b.at - a.at)[0] || null;
}

function senderOf_(m) {
  const raw = m.headers.sender || m.headers.from || '';
  const match = raw.match(ADDRESS_RX_);
  return match ? match[0] : raw;
}

/**
 * Auto-send: when the bot tried to send this alert's Social Alert itself and couldn't tell whether it went
 * (email_input.auto_send_try, ms), else 0. Pure.
 */
function autoSendTry_(row) { return Number(((row && row.email_input) || {}).auto_send_try) || 0; }

/**
 * Auto-send: the bot's own send of this alert, found in Sent (Gmail said the send failed, but it went out anyway): the
 * SENT message ({id, threadId, labels, at, headers}), or null. Only a message with the alert's subject, sent around
 * the bot's try (AUTO_SEND_WENT_MS_), that isn't another alert's send or the email it replied to. Throws when Gmail
 * can't be read.
 */
function autoSentFound_(ctx, row) {
  const at = autoSendTry_(row);
  const subject = String(row.email_subject || '').replace(/"/g, ' ').trim();
  if (!at || !subject || typeof ctx.gmail.messageSummaries !== 'function') return null;
  const since = at - SENT_SKEW_MS_;
  const until = at + AUTO_SEND_WENT_MS_;
  const others = new Set(autoSendLog_(ctx).filter(e => e.id !== row.alert_id && e.msg).map(e => String(e.msg)));
  const q = `in:sent subject:"${subject}" after:${Math.floor(since / 1000)} before:${Math.ceil(until / 1000)}`;
  const hits = (ctx.gmail.messageSummaries(q, 5) || []).filter(h => h && h.threadId && !others.has(String(h.id)))
    .sort((a, b) => a.at - b.at);
  for (const hit of hits) {
    const m = ctx.gmail.getThread(hit.threadId).find(x => x.id === hit.id);
    if (m && m.labels.includes('SENT') && m.at >= since && m.at <= until &&
      (!row.email_reply_to || m.headers['message-id'] !== row.email_reply_to)) {
      return Object.assign({ threadId: hit.threadId }, m);
    }
  }
  return null;
}

/**
 * Auto-send: the bot's send went out after all (`sent`, from autoSentFound_). As for a sent draft: the row marked sent,
 * by the bot, on the thread it went to (so the Results tab never takes it for the IMs' email), the emojis for who it
 * went to and what the other switches do after a send; and a note under the forwarded alert (`removed`: the bot
 * deleted the draft that was left). Throws when the row can't be marked (the caller tries again on the next run).
 */
function markAutoSentFound_(ctx, row, sent, report, removed) {
  ctx.store.updateAlert(row, { email_status: 'sent', email_thread: sent.threadId,
    email_message_id: sent.headers['message-id'] || '', email_sent_at: sent.at, email_sent_by: 'bot', email_error: '' });
  ctx.log(`the Social Alert for ${row.alert_id} went out after all (auto-send): found in Sent, marked sent`);
  report.drafts_sent++;
  report.mirrored += markEmojis_(ctx, row, escalationEmojisForRow_(row, sent, !!(ctx.drafts && ctx.drafts.live))).length;
  onEmailSent_(ctx, row, report);
  postDraftNote_(ctx, row, `Social Alert sent after all: the bot's own send went out in spite of Gmail's error ` +
    `(it's in Sent)${removed ? ', so the bot marked the alert sent and removed the draft. Don\'t send it again.' : '.'}`,
  'found:' + row.alert_id);
  noteSwitch_('autoSend', `${row.alert_id} went out after all (found in Sent at ${autoSendWhen_(ctx.now())})`);
}

/**
 * A Social Alert still pending a day after its alert was recorded: maintainDrafts_ doesn't try it any more, so its row
 * says what became of it instead of staying pending (which read as alerted for 14 days, Escalate.gs earlierOutcome_: a
 * new alert on the same post was ❌'d as a repeat of an email that never went out):
 *   - no try made an email or a draft: failed, saying no email was made within 24 hours (with the last try's problem);
 *     the run's report gets an error, its send is let go in the alert memory, and it goes to the SLRR tables, as an email
 *     that failed for good does (nothing while Write back to SLRR BigQuery is OFF);
 *   - the bot's own send was noted as gone (ctx.memo 'stand_in_sent' / 'auto_sent') and only the row never said so: sent,
 *     on that send's thread (it did go out: it must never read as not alerted);
 *   - an earlier try made a draft the row names: drafted, and the draft is checked as any other;
 *   - a send was noted but not as gone (it may have gone out): failed, saying to check Sent, with an error in the report.
 * Returns true to keep the alert on the watch list: its draft, or a row that couldn't be marked (tried again on the next
 * run). Never throws.
 */
function expirePendingEmail_(ctx, row, report) {
  const id = row.alert_id;
  try {
    const standIn = standInSent_(ctx, id);
    const auto = autoSendLog_(ctx).find(e => e.id === id) || null;
    const went = (standIn && standIn.sent && standIn) || (auto && auto.sent && auto) || null;
    if (went) {
      const at = Number(went.at) || ctx.now();
      ctx.store.updateAlert(row, { email_status: 'sent', email_draft: '', email_thread: went.thread || row.email_thread || '',
        email_at: at, email_sent_at: at, email_sent_by: went === auto ? 'bot' : ((ctx.drafts && ctx.drafts.mailbox) || ''),
        email_error: '' });
      ctx.log(`the Social Alert for ${id} went out on an earlier try and its row never said so: marked sent (a day on)`);
      return false;
    }
    if (rowDraftIds_(row).length) {
      ctx.store.updateAlert(row, { email_status: 'drafted', email_error: '',
        email_at: Number(row.email_at) || Number(row.created_at) || ctx.now() });
      ctx.log(`the Social Alert for ${id} has a draft an earlier try made and its row never said so: marked drafted (a day on)`);
      return true;
    }
    const maybe = !!standIn || !!auto || rowAlreadyOut_(ctx, row);
    const last = String(row.email_error || '').trim();
    const why = maybe
      ? 'no Social Alert email is known to have gone out within 24 hours, but an earlier try may have sent it (check Sent in ' +
        'Gmail), so it isn\'t tried again'
      : `no Social Alert email was made within 24 hours${last ? ` (last problem: ${last})` : ''}`;
    ctx.store.updateAlert(row, { email_status: 'failed', email_error: truncate_(why, 300) });
    ctx.log(`the Social Alert for ${id}: ${why}`);
    (report.errors = report.errors || []).push(maybe ? `the Social Alert for ${id}: ${why}`
      : `no Social Alert email was made for ${id} within 24 hours, so it's marked failed and isn't tried again` +
        (last ? `: ${truncate_(last, 200)}` : ''));
    if (!maybe) {
      if (typeof amReleaseSend_ === 'function') amReleaseSend_(ctx, row);
      bqWriteBack_(ctx, row, 'failed', report);  // Write back to SLRR BigQuery (nothing while it's OFF)
    }
    return false;
  } catch (e) {
    ctx.log(`couldn't close the Social Alert for ${id}, still pending after a day (tried again next run): ${(e && e.message) || e}`);
    return true;
  }
}

/**
 * Every run: pending emails are (re)tried; drafts are checked: sent -> the emojis in both spaces; deleted -> ❌. A draft
 * left after an auto-send that may have gone out: the bot's own send is looked for in Sent (autoSentFound_), so it's
 * marked sent (and the draft removed) rather than ❌. A pending email is tried for a day; after that its row says what
 * became of it (expirePendingEmail_). At most DRAFT_CHECKS_PER_RUN_ alerts a run: the ones checked and still open go to
 * the end of the list, behind those this run didn't get to, so each gets its turn.
 */
function maintainDrafts_(ctx, report) {
  const ids = watched_(ctx);
  if (!ids.length) return;
  const later = [];  // not checked this run (past DRAFT_CHECKS_PER_RUN_, or the run is out of time): first in line next run
  const keep = [];   // checked and still open: behind those
  ids.forEach((id, i) => {
    if (i >= DRAFT_CHECKS_PER_RUN_ || ctx.now() > ctx.deadline - 30 * 1000) { later.push(id); return; }
    const row = ctx.store.alertById(id);
    if (!row) return;  // the Control tab now points at other spaces: stop watching
    if (row.email_status === 'pending') {
      if (!draftsOn_(ctx)) return;  // turned off
      if (ctx.now() - Number(row.created_at || 0) > DAY_MS_) {  // too old now: not tried again, and its row says so
        if (expirePendingEmail_(ctx, row, report)) keep.push(id);
        return;
      }
      tryDraft_(ctx, row, report);
      if (row.email_status === 'pending' || row.email_status === 'drafted') keep.push(id);
      return;
    }
    if (row.email_status !== 'drafted' || ctx.now() - Number(row.email_at || 0) > DRAFT_WATCH_DAYS_ * DAY_MS_) return;
    try {
      const tms = row.email_input && Array.isArray(row.email_input.team_emails) ? row.email_input.team_emails : null;
      if (tms && tms.length > 1) {
        if (maintainMultiDraftRow_(ctx, row, tms, report)) keep.push(id);
        return;
      }
      if (ctx.gmail.draftExists(row.email_draft)) {
        // Auto-send: the bot's own send, which Gmail said failed, may be in Sent after all: the draft is then removed
        const lookInSent = autoSendTry_(row) && ctx.now() - Number(row.email_at || 0) <= AUTO_SEND_FIND_MS_;
        const found = lookInSent ? autoSentFound_(ctx, row) : null;
        if (!found) { keep.push(id); return; }
        ctx.gmail.deleteDraft(row.email_draft);  // so nobody sends it a second time
        markAutoSentFound_(ctx, row, found, report, true);
        return;
      }
      const sent = row.email_thread ? sentMessage_(ctx.gmail.getThread(row.email_thread), row) : null;
      const found = !sent && autoSendTry_(row) ? autoSentFound_(ctx, row) : null;  // Auto-send: did the bot's own send go?
      if (sent) {
        ctx.store.updateAlert(row, { email_status: 'sent', email_message_id: sent.headers['message-id'] || '', email_sent_at: sent.at,
          email_sent_by: senderOf_(sent) });
        report.drafts_sent++;
        report.mirrored += markEmojis_(ctx, row, escalationEmojisForRow_(row, sent, !!(ctx.drafts && ctx.drafts.live))).length;
        onEmailSent_(ctx, row, report);
      } else if (found) {  // a person saw the bot's send in Sent and deleted the draft: it went out, so it's sent
        markAutoSentFound_(ctx, row, found, report, false);
      } else {  // deleted in Gmail without being sent: no email went out, so ❌ No action taken (as the IM would mark it)
        ctx.store.updateAlert(row, { email_status: 'discarded' });
        if (typeof amReleaseSend_ === 'function') amReleaseSend_(ctx, row);
        markNoAction_(ctx, row);
        bqWriteBack_(ctx, row, 'discarded', report);  // Write back to SLRR BigQuery (nothing while it's OFF)
      }
    } catch (e) {
      keep.push(id);
      ctx.log(`couldn't check the Social Alert draft for ${id}: ${(e && e.message) || e}`);
    }
  });
  setWatched_(ctx, later.concat(keep));
}

/**
 * Checks every open per-team Gmail draft on a multi-product row (`tms`): returns true while at least one draft is still
 * open in Gmail; finalizes the row as `sent` (when >=1 team draft was sent) or `discarded` (when all were deleted) once
 * no open drafts remain.
 */
function maintainMultiDraftRow_(ctx, row, tms, report) {
  const nextTeams = tms.map(te => Object.assign({}, te));
  let changed = false;
  nextTeams.forEach(te => {
    if (te.status !== 'drafted') return;
    const subRow = {
      alert_id: `${row.alert_id}#${te.slug || te.key}`,
      email_at: Number(te.at) || Number(row.email_at) || 0,
      email_subject: te.subject || row.email_subject || '',
      email_reply_to: te.reply_to || '',
      email_input: te.auto_send_try ? { auto_send_try: te.auto_send_try } : {},
    };
    if (te.draft && ctx.gmail.draftExists(te.draft)) {
      const lookInSent = te.auto_send_try && ctx.now() - subRow.email_at <= AUTO_SEND_FIND_MS_;
      const found = lookInSent ? autoSentFound_(ctx, subRow) : null;
      if (!found) return;
      ctx.gmail.deleteDraft(te.draft);
      Object.assign(te, {
        status: 'sent', draft: '', thread: found.threadId || te.thread || '',
        message_id: (found.headers && found.headers['message-id']) || '',
        sent_at: found.at, sent_by: 'bot',
        recipients: Array.from(sentRecipients_(found) || []),
      });
      report.drafts_sent++;
      changed = true;
      return;
    }
    const sent = te.thread ? sentMessage_(ctx.gmail.getThread(te.thread), subRow) : null;
    const found = !sent && te.auto_send_try ? autoSentFound_(ctx, subRow) : null;
    const hit = sent || found;
    if (hit) {
      Object.assign(te, {
        status: 'sent', draft: '', thread: hit.threadId || te.thread || '',
        message_id: (hit.headers && hit.headers['message-id']) || '',
        sent_at: hit.at, sent_by: found ? 'bot' : senderOf_(hit),
        recipients: Array.from(sentRecipients_(hit) || []),
      });
      report.drafts_sent++;
      changed = true;
    } else {
      Object.assign(te, { status: 'discarded', draft: '' });
      changed = true;
    }
  });

  const openDrafts = nextTeams.filter(te => te.status === 'drafted' && te.draft);
  const nextInput = Object.assign({}, row.email_input || {}, { team_emails: nextTeams });
  if (openDrafts.length) {
    if (changed) {
      ctx.store.updateAlert(row, {
        email_draft: openDrafts.map(d => d.draft).join(' '),
        email_thread: openDrafts[0].thread || row.email_thread || '',
        email_input: nextInput,
      });
    }
    return true;
  }

  const sentTeams = nextTeams.filter(te => te.status === 'sent');
  if (sentTeams.length) {
    const first = sentTeams[0];
    const lastAt = sentTeams[sentTeams.length - 1].sent_at || ctx.now();
    ctx.store.updateAlert(row, {
      email_status: 'sent', email_draft: '',
      email_thread: first.thread || row.email_thread || '',
      email_message_id: first.message_id || '',
      email_subject: first.subject || row.email_subject || '',
      email_sent_at: lastAt, email_sent_by: first.sent_by || '',
      email_input: nextInput,
    });
    const allRecips = [];
    sentTeams.forEach(s => (s.recipients || []).forEach(a => { if (a) allRecips.push(a); }));
    const live = !!(ctx.drafts && ctx.drafts.live);
    const got = live && allRecips.length ? { headers: { to: allRecips.join(', '), cc: '' } } : null;
    report.mirrored += markEmojis_(ctx, row, escalationEmojisForRow_(row, got, live && !!got)).length;
    onEmailSent_(ctx, row, report);
  } else {
    ctx.store.updateAlert(row, { email_status: 'discarded', email_draft: '', email_input: nextInput });
    if (typeof amReleaseSend_ === 'function') amReleaseSend_(ctx, row);
    markNoAction_(ctx, row);
    bqWriteBack_(ctx, row, 'discarded', report);
  }
  return false;
}

/**
 * ✍️ on an alert whose Social Alert is still a draft: the draft's T&S row becomes "Yes". A test draft is rebuilt; a
 * live one only gets that row changed. Returns false when the live draft can't be changed safely (edited in Gmail).
 */
function markTnsSubmitted_(ctx, row, input) {
  try {
    const tms = input && Array.isArray(input.team_emails) ? input.team_emails : null;
    if (tms && tms.length > 1) {
      const targets = productEmailTargets_(input, groupsOf_(row).filter(g => g !== 'tns'), row);
      const screenshot = !ctx.drafts.live ? emailScreenshot_(input) : null;
      let allOk = true;
      tms.forEach(te => {
        if (!te || te.status !== 'drafted' || !te.draft) return;
        const current = ctx.gmail.getDraftRaw(te.draft);
        if (!current) return;
        let raw = null;
        if (ctx.drafts.live) {
          raw = setTnsInMime_(current.raw, 'Yes');
        } else {
          const t = targets.find(x => x.key === te.key);
          if (t) {
            const email = socialAlertEmail_(t.input, t.plan, { test: true, mailbox: ctx.drafts.mailbox,
              sendId: `${row.alert_id}#${t.slug}`, reply: t.replySubject ? { subject: t.replySubject } : null,
              screenshot, tag: ctx.flowTag || '' });
            raw = buildMime_({ from: ctx.drafts.from, to: email.to, cc: [], subject: email.subject, text: email.text,
              html: email.html, inline: email.inline, inReplyTo: t.replyTo || '', references: t.replyTo || '' });
          }
        }
        if (!raw) { allOk = false; return; }
        ctx.gmail.updateDraft(te.draft, raw, current.threadId);
      });
      return allOk;
    }
    const current = ctx.gmail.getDraftRaw(row.email_draft);
    if (!current) return true;  // gone: maintainDrafts_ works out whether it was sent
    let raw = null;
    if (ctx.drafts.live) {
      raw = setTnsInMime_(current.raw, 'Yes');
    } else {
      const plan = planRecipients_(input.escalation, input.escalation.text, groupsOf_(row).filter(g => g !== 'tns'));
      const email = socialAlertEmail_(input, plan, { test: true, mailbox: ctx.drafts.mailbox, sendId: row.alert_id,
        reply: row.email_reply_to ? { subject: row.email_subject } : null, screenshot: emailScreenshot_(input), tag: ctx.flowTag || '' });
      raw = buildMime_({ from: ctx.drafts.from, to: email.to, cc: [], subject: email.subject, text: email.text, html: email.html,
        inline: email.inline, inReplyTo: row.email_reply_to || '', references: row.email_reply_to || '' });
    }
    if (!raw) return false;
    ctx.gmail.updateDraft(row.email_draft, raw, current.threadId);
    return true;
  } catch (e) {
    ctx.log(`couldn't set T&S to Yes on the Social Alert draft for ${row.alert_id}: ${(e && e.message) || e}`);
    return false;
  }
}

/**
 * Analyst legend emojis on a forwarded alert, as overrides: ✍️ records T&S as submitted (draft or not). While the Social
 * Alert is still a draft, ❌ deletes it and a group emoji (📰 💬 💼 …) adds that group's addresses. Live drafts only get
 * their To / Cc (or T&S row) changed, so edits made in Gmail stay; a test draft is rebuilt. False if Gmail failed.
 */
function draftReactions_(ctx, fm, report) {
  const entries = fm.reactions.map(r => legendByEmoji_(r.emoji)).filter(Boolean);
  const row = ctx.store.emailRowByForward(fm.name);
  if (entries.some(e => e.code === 'tns')) {
    const target = row || ctx.store.alertByForward(fm.name);
    if (target) recordTns_(ctx, target);
  }
  if (!row || row.email_status !== 'drafted') return true;
  try {
    const input = row.email_input || {};
    const tms = Array.isArray(input.team_emails) && input.team_emails.length > 1 ? input.team_emails : null;
    if (entries.some(e => e.kind === 'close')) {
      rowDraftIds_(row).forEach(did => ctx.gmail.deleteDraft(did));
      const patch = { email_status: 'deleted', email_draft: '' };
      if (tms) {
        patch.email_input = Object.assign({}, input, {
          team_emails: tms.map(te => te && te.status === 'drafted' ? Object.assign({}, te, { status: 'deleted', draft: '' }) : te),
        });
      }
      ctx.store.updateAlert(row, patch);
      if (typeof amReleaseSend_ === 'function') amReleaseSend_(ctx, row);
      setWatched_(ctx, watched_(ctx).filter(id => id !== row.alert_id));
      bqWriteBack_(ctx, row, 'deleted', report);  // Write back to SLRR BigQuery (nothing while it's OFF)
      return true;
    }
    const have = groupsOf_(row);
    const adding = entries.filter(e => e.kind === 'add_group' && e.group && !have.includes(e.group));
    if (!adding.length) return true;
    const groups = have.concat(adding.map(e => e.group));
    if (tms) {
      const targets = productEmailTargets_(input, groups.filter(g => g !== 'tns'), row);
      const screenshot = !ctx.drafts.live ? emailScreenshot_(input) : null;
      let updatedAny = false;
      tms.forEach(te => {
        if (!te || te.status !== 'drafted' || !te.draft) return;
        const current = ctx.gmail.getDraftRaw(te.draft);
        if (!current) return;
        const t = targets.find(x => x.key === te.key);
        if (!t) return;
        if (ctx.drafts.live) {
          const res = addRecipientsToMime_(current.raw, t.plan.to, t.plan.cc);
          if (res.added.length) {
            ctx.gmail.updateDraft(te.draft, res.raw, current.threadId);
            updatedAny = true;
          }
        } else {
          const email = socialAlertEmail_(t.input, t.plan, { test: true, mailbox: ctx.drafts.mailbox,
            sendId: `${row.alert_id}#${t.slug}`, reply: t.replySubject ? { subject: t.replySubject } : null,
            screenshot, tag: ctx.flowTag || '' });
          ctx.gmail.updateDraft(te.draft, buildMime_({ from: ctx.drafts.from, to: email.to, cc: [], subject: email.subject,
            text: email.text, html: email.html, inline: email.inline, inReplyTo: t.replyTo || '', references: t.replyTo || '' }),
            current.threadId);
          updatedAny = true;
        }
      });
      ctx.store.updateAlert(row, { email_groups: groups.join(' ') });
      if (updatedAny) report.drafts_updated++;
      return true;
    }
    const plan = planRecipients_(input.escalation, input.escalation.text, groups.filter(g => g !== 'tns'));
    const current = ctx.gmail.getDraftRaw(row.email_draft);
    if (!current) return true;  // gone: maintainDrafts_ works out whether it was sent
    if (ctx.drafts.live) {
      const res = addRecipientsToMime_(current.raw, plan.to, plan.cc);
      if (res.added.length) ctx.gmail.updateDraft(row.email_draft, res.raw, current.threadId);
    } else {
      const email = socialAlertEmail_(input, plan, { test: true, mailbox: ctx.drafts.mailbox, sendId: row.alert_id,
        reply: row.email_reply_to ? { subject: row.email_subject } : null, screenshot: emailScreenshot_(input), tag: ctx.flowTag || '' });
      ctx.gmail.updateDraft(row.email_draft, buildMime_({ from: ctx.drafts.from, to: email.to, cc: [], subject: email.subject,
        text: email.text, html: email.html, inline: email.inline, inReplyTo: row.email_reply_to || '', references: row.email_reply_to || '' }),
        current.threadId);
    }
    ctx.store.updateAlert(row, { email_groups: groups.join(' ') });
    report.drafts_updated++;
    return true;
  } catch (e) {
    ctx.log(`couldn't update the Social Alert draft for ${row.alert_id}: ${(e && e.message) || e}`);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 👍 "Confirming receipt, no action yet taken" (the guide's legend). A correct alert the bot actions in the same pass
// (the Social Alert sent, ❌) gets only those emojis, as on the IMs' posts. One it can't action yet, because it waits
// on a person (a draft to send, the T&S form, a YouTube chat ping) or on a retry, gets 👍 right away. Alerts with
// corrections get ⬇️ instead (Bot.gs). With "Never wait on Burson" ON, an alert with the bot's own corrections is
// actioned like a correct one, and nothing waits on Burson.
// ---------------------------------------------------------------------------------------------------------------

const ACTION_CODES_ = new Set(['tns', 'gcpa', 'pa', 'gup', 'crisis', 'people_comms', 'stop_leaks', 'exec_comms', 'gsoc', 'lss',
  'other_team', 'regional_leads', 'civics', 'channel_owner', 'influencer_team', 'no_action', 'escalated_jon']);

/**
 * True when the bot already processed alert `row` or an alert it resends (resend_of, back to the first): decided it (❌,
 * the T&S form, the YouTube ping), made its Social Alert (or the forward's draft row has one), or marked it with 👍 or an
 * action emoji. With "Never wait on Burson" ON, Burson's resend of such an alert isn't processed again (Bot.gs
 * handleResendNoWait_).
 */
function processedRow_(ctx, row) {
  for (let r = row, n = 0; r && n < 20; r = r.resend_of ? ctx.store.alertById(r.resend_of) : null, n++) {
    if (String(r.decision || '').trim() || r.email_status) return true;
    if (r.forward_message && ctx.store.emailRowByForward(r.forward_message)) return true;
    const marked = String(r.mirrored || '').split(' ').filter(Boolean).some(e => {
      const entry = legendByEmoji_(e);
      return !!entry && (entry.code === 'ack' || ACTION_CODES_.has(entry.code));
    });
    if (marked) return true;
  }
  return false;
}

/** The latest decision on alert `row` or an alert it resends (resend_of), or ''. */
function chainDecision_(ctx, row) {
  for (let r = row, n = 0; r && n < 20; r = r.resend_of ? ctx.store.alertById(r.resend_of) : null, n++) {
    if (String(r.decision || '').trim()) return String(r.decision).trim();
  }
  return '';
}

/** 👍 on Burson's post when nothing on it (or on `also`, e.g. the alert a resend replaces) says it was actioned. */
function confirmReceipt_(ctx, row, also) {
  const S = ctx.settings || {};
  if (!draftsOn_(ctx) || !S.react || S.dry_run) return false;
  const live = liveAlertRow_(ctx, row) || row;
  const post = alertPost_(ctx, live);  // Burson's post; in the auto-correct test space, the corrected alert
  if (!post) return false;
  const marked = [live, row].concat(also || []).filter(Boolean)
    .reduce((all, r) => all.concat(String(r.mirrored || '').split(' ').filter(Boolean)), []);
  if (marked.some(e => { const entry = legendByEmoji_(e); return entry && (entry.code === 'ack' || ACTION_CODES_.has(entry.code)); })) {
    return false;
  }
  try {
    ctx.chat.react(post, legendEmoji_('ack'));
    if (ctx.outboundBlocked) forwardOwnBurson_(ctx, { type: 'react', name: post, emoji: legendEmoji_('ack') });  // row 24
  } catch (e) {
    ctx.log(`couldn't confirm receipt on ${post}: ${(e && e.message) || e}`);
    return false;
  }
  const mirrored = String(live.mirrored || '').split(' ').filter(Boolean);
  ctx.store.updateAlert(live, { mirrored: mirrored.concat([legendEmoji_('ack')]).join(' ') });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// 🧑‍💻 "Escalated to Jon": the guide's [Internal] SLRR P0 + Sensitive Topics + Product Failure Escalation Protocol. A NEW
// alert with a P0 tag or a Sensitive Topic that is a product failure / Google mistake also goes to the team leads, once
// per issue every 14 days ("if a topic has already been pinged to Kelsey/Angie/Jon, no need to ping again").
// Testing (a stand-in): the DM goes to the stand-in instead, with a last line naming the leads it would have gone to.
// Real distros: a DM to each lead (real Burson space only). 🧑‍💻 goes on once a DM went out. Nothing is posted in a space.
// ---------------------------------------------------------------------------------------------------------------

function leadPings_(ctx) { try { return JSON.parse(ctx.memo.get('lead_pings') || '[]') || []; } catch (e) { return []; } }

const LEAD_PINGS_KEEP_ = 40;          // issues kept in ctx.memo 'lead_pings' (one property: ~9 KB at most; each has its issue words)
const LEAD_PINGS_MAX_CHARS_ = 8000;   // and never more than this

/**
 * ctx.memo 'lead_pings' with `entry` added to `pings` (oldest first): the newest LEAD_PINGS_KEEP_, then the oldest dropped
 * until it fits LEAD_PINGS_MAX_CHARS_ (the new one is always kept), as 'auto_sent' and 'stand_in_sent' are capped. Pure.
 */
function leadPingsText_(pings, entry) {
  let keep = (pings || []).concat([entry]).slice(-LEAD_PINGS_KEEP_);
  let text = JSON.stringify(keep);
  while (text.length > LEAD_PINGS_MAX_CHARS_ && keep.length > 1) {
    keep = keep.slice(1);
    text = JSON.stringify(keep);
  }
  return text;
}

function leadershipText_(f, esc) {
  const L = GEN.leadership || {};
  const why = [];
  if (esc.priority === 'P0') why.push('P0');
  if ((esc.sensitive_topics || []).length) why.push('Sensitive: ' + esc.sensitive_topics.join(', '));
  const title = f.issue_name || esc.issue_name || 'View post';
  const postLink = f.post_url
    ? (typeof chatLink_ === 'function' ? chatLink_(f.post_url, title) : f.post_url)
    : '';
  const docLink = L.doc_url
    ? (typeof chatLink_ === 'function' ? chatLink_(L.doc_url, 'Escalation Protocol') : L.doc_url)
    : '';
  return [
    '*Escalation protocol* (P0 + Sensitive Topics + Product Failure)',
    `- Product: ${allProductsText_(f, esc, '-')}`,
    `- Issue: ${f.issue_name || esc.issue_name || '-'}`,
    `- Platform & Engagement: ${f.social_network || esc.platform || '-'} (${fmtInt_(esc.engagement_total || 0)} engagements)`,
    `- Exposure Tag: ${esc.exposure_tag || '-'}`,
    `- Why: NEW issue${why.length ? ' (' + why.join(', ') + ')' : ''}`,
    postLink ? `- View Post: ${postLink}` : '',
    docLink ? `- Protocol: ${docLink}` : '',
  ].filter(Boolean).join('\n');
}

/** Formats recipient addresses with display names from the roster when known. */
function peopleNames_(emails) {
  const people = GEN.people || {};
  return (emails || []).map(e => { const name = people[String(e).toLowerCase()]; return name ? `${name} (${e})` : e; }).join(', ');
}

/**
 * A newly escalated alert the protocol covers: the DM, then 🧑‍💻. LIVE (Main.gs runMode_): a Chat DM to each lead.
 * Testing: to the testers only; by Chat DM where the bot has a direct message with that tester, and to the remaining
 * testers in one email (leadershipEmail_). Never throws.
 */
function leadershipPing_(ctx, row, review, history, report) {
  try {
    const L = GEN.leadership || {};
    const leads = L.recipients || [];
    if (!draftsOn_(ctx) || !L.enabled || !leads.length) return;
    const { esc } = escalationFor_(ctx, review, history);
    if (!esc.leadership || aiVeto_(review, esc)) return;
    const windowMs = (L.dedupe_days || 14) * DAY_MS_;
    const pings = leadPings_(ctx).filter(p => ctx.now() - Number(p.at || 0) <= windowMs);
    const tokens = review.issueTokens || [];
    const tag = String(esc.exposure_tag || '').toLowerCase();
    const already = pings.some(p => p.id === row.alert_id ||
      (tokens.length ? jaccard_(tokens, p.tokens || []) >= GEN.novelty_min_jaccard : (p.tag === tag && p.product === esc.product)));
    if (already) return;
    const testers = draftsTesters_(ctx);
    const live = !!(ctx.drafts && ctx.drafts.live);  // buildCtx_: from runMode_ (guardedChat_.dm checks it again)
    const targets = testers.length ? testers : (live ? leads : []);
    if (!targets.length) return;  // Testing with no testers: nobody to message
    const text = (ctx.flowTag ? `[${ctx.flowTag}] ` : '') + leadershipText_(review.fields, esc) +
      (testers.length ? `\n\nWould have gone to: ${peopleNames_(leads)}` : '');
    const sent = [];
    const failed = [];
    const needEmail = [];
    targets.forEach(email => {
      let why = 'no direct message with that account';
      try {
        if (typeof ctx.chat.dm === 'function' && ctx.chat.dm(email, text, `lead:${row.alert_id}:${email}`)) {
          sent.push(email);
          return;
        }
      } catch (e) {
        why = String((e && e.message) || e);
      }
      if (testers.length) {
        needEmail.push({ email, why });
      } else {
        failed.push(`${email} (${why})`);
      }
    });
    if (needEmail.length) {
      const emails = needEmail.map(x => x.email);
      try {
        if (leadershipEmail_(ctx, review.fields, esc, text, emails)) {
          emails.forEach(e => sent.push(e));
          ctx.log(`escalation protocol for ${row.alert_id}: emailed to the testers (${emails.join(', ')}): Chat can't DM them (${needEmail.map(x => x.why).join('; ')})`);
        } else {
          needEmail.forEach(x => failed.push(`${x.email} (${x.why})`));
        }
      } catch (e) {
        const err = String((e && e.message) || e);
        needEmail.forEach(x => failed.push(`${x.email} (${x.why}; by email: ${err})`));
      }
    }
    if (!sent.length) {
      const why = `Couldn't send the escalation-protocol DM for ${row.alert_id} to ${failed.join(', ')}, so it has no 🧑‍💻.`;
      ctx.log(why);
      (report.notices = report.notices || []).push(why);
      return;
    }
    ctx.memo.set('lead_pings', leadPingsText_(pings, { id: row.alert_id, tokens, tag, product: esc.product, at: ctx.now() }));
    markAlert_(ctx, row, 'escalated_jon');
    report.leadership = (report.leadership || 0) + 1;
  } catch (e) {
    ctx.log(`escalation protocol check failed for ${row && row.alert_id}: ${(e && e.message) || e}`);
  }
}

/**
 * Testing: the escalation-protocol message by email to the testers Chat couldn't DM (Gmail refuses anyone else).
 * True if it went.
 */
function leadershipEmail_(ctx, f, esc, text, recipients) {
  const D = ctx.drafts || {};
  const to = onlyToList_(recipients !== undefined ? recipients : (D.testers && D.testers.length ? D.testers : D.standIn));
  if (!to.length || !ctx.gmail || typeof ctx.gmail.sendMessage !== 'function' || (ctx.settings && ctx.settings.dry_run)) return false;
  const what = [(f && f.product) || esc.product, (f && f.issue_name) || esc.issue_name].filter(Boolean).join(' | ');
  const subject = `${ctx.flowTag ? `[${ctx.flowTag}] ` : ''}[Testing] Escalation protocol${what ? `: ${truncate_(what, 120)}` : ''}`;
  const self = to.length === 1 && to[0] === String(D.mailbox || '').trim().toLowerCase();
  const reason = self ? `${to[0]} (the account the bot runs as)` : `${testersJoin_(to)} (no direct message with the bot's account)`;
  const body = `${text}\n\nTesting: this would have been a Chat DM to each lead. Chat can't DM ${reason}, so it came by email.`;
  ctx.gmail.sendMessage(buildMime_({ from: D.from, to, subject, text: body,
    html: `<div style="font-family: Arial, sans-serif; font-size: 14px;">${htmlEsc_(body).replace(/\n/g, '<br>')}</div>` }));
  return true;
}
