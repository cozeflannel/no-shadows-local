// The requirement line (RequirementLine.gs): every alert the bot reviews in the Auto-correct space (B10) says, in its
// thread, which alert requirement it met or did not meet, in the words of the decision the bot already made. For
// Burson's corrected copy, a Direct BigQuery card and a sheet-test card it is the last line of the review's own note
// (the whole note when there is nothing else to say); under a Watch alert and an Early Detection card it stands where
// their notes have the "SLRR" line. No line on any card, no second decision. Only in the Auto-correct flow and only with
// the setting requirement_line on: everywhere else, and with the setting off, every note is what it was.
// The line agrees with the alert it stands under and with what the bot then does: it names a Sensitive Topic the rules
// don't count and a tag they count as another, says when a T&S form or a person takes the alert up, what a planned
// email waits for, and, when an alert is tried a second time and decided otherwise, what was done in the end.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, NOW, REAL, TEST_FEED, TRIAGED, MAPS_LOW, leakDenied } = H;
  const golden = require('./golden_flows')(H);
  const { AC, MIRROR } = golden.spaces;
  const ZAPIER = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const MIN = 60 * 1000;
  const TESTER = 'tester@testing.test';
  const HEAD = '*Alert requirements:* ';
  const FINAL = '*Alert requirements, final:* ';
  const CHANGES = 'The agentic assistant reviewed this alert and made these changes:';
  const IN_PLACE = 'The agentic assistant reviewed this alert. The card above was posted before the review; the email uses ' +
    'these corrections:';
  const GUARD = { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] };
  const BELOW = (tag, n) => `a ${tag} tag needs 2,000+ engagements, a KOF author or a Sensitive Topic; this post: ${n} engagements, no KOF author`;
  const EARLY = 'small accounts, no KOF author, no P0 tag';
  const ANYWAY = 'A Social Alert goes out anyway on the review\'s call.';
  // What stands in the place of "Monitoring only." when an alert that meets no requirement gets a T&S form
  const TNS_ASKED = 'No Social Alert; a T&S form is asked for below.';
  const TNS_HANDLED = 'No Social Alert; the T&S form is handled below.';
  const TNS_LATER = 'No Social Alert; a T&S form follows once Burson adds what is missing.';
  const B30_WAIT = 'Its email waits for a test recipient in Control B30.';
  const SUSPENSION_TAG = 'Product - Account deletion/suspension';
  const PRIVACY_TAG = 'Product - Privacy & security concerns';
  const COUNTS_AS_BIAS = 'P0 exposure tag (Product - Perceived bias: an account suspension that claims censorship or bias counts as it)';

  // Correct alerts of Burson's, below and above the engagement bar (P2 tag, no Sensitive Topic, no KOF author)
  const LOW_OK = MAPS_LOW.split('Product - Memes & humorous content').join('Product - Meme about Google products');  // 300 engagements
  const MAPS_OK = F.MAPS.split('Product - Memes & humorous content').join('Product - Meme about Google products');   // 4,200 engagements
  /** A correct alert of Burson's in its short layout (as F.MAPS), about a made-up X post: {banner, tag, product, n, level, topic, author, id, name, summary}. */
  const bursonAlert = o => [
    `THIS ALERT MEETS ${o.banner} CRITERIA`,
    'SOCIAL ALERT:',
    '[Time/Date Post Went Live]: October 12, 2026, 4:05 AM',
    `[Exposure Tag]: ${o.tag}`,
    `[Product]: ${o.product}`,
    '[Other Google Products]: None',
    `[Engagement]: ${o.level || (o.n >= 2000 ? 'HIGH' : 'LOW')} (${o.n} engagements)`,
    `[Sensitive Topic]: ${o.topic || 'None'}`,
    '[KOF]: No',
    o.summary,
    `[Link]: https://x.com/${o.author}/status/${o.id}`,
    `[Name]: ${o.name} / New / not previously reported over the past 14 days`,
    `[Code]: ${o.tag},${o.n},@${o.author},${o.topic || 'None'},${o.product},New / not previously reported over the past 14 days`,
  ].join('\n');
  // Privacy as the Sensitive Topic of an alert whose exposure tag is the privacy tag: the topic restates the tag, so the
  // rules don't count it (config redundant_pairs)
  const PRIVACY = bursonAlert({ banner: 'P1', tag: PRIVACY_TAG, product: 'Chrome', n: 300, topic: 'Privacy', author: 'incognito_iris',
    id: '2150000000000000411', name: 'Chrome Incognito History Kept Claim',
    summary: 'An X user (@incognito_iris; 1900 followers) said Chrome kept a list of the sites they opened in Incognito mode.' });
  // An account suspension that claims censorship: the rules count it as Product - Perceived bias (P0); the alert keeps its tag
  const SUSPENDED = bursonAlert({ banner: 'P2', tag: SUSPENSION_TAG, product: 'Gmail', n: 300, author: 'banned_ben',
    id: '2150000000000000412', name: 'Gmail Account Suspension Censorship Claim',
    summary: 'An X user (@banned_ben; 2400 followers) said Google suspended their Gmail account to censor what they write about the company.' });
  // A wrong answer of the Gemini app, below the thresholds: no Social Alert, and a T&S form (Gemini hallucination)
  const geminiWrong = (n, level) => bursonAlert({ banner: 'P1', tag: 'Product - Factual inaccuracies (not dangerous/offensive)', product: 'Gemini App', n, level,
    author: 'date_checker', id: '2150000000000000413', name: 'Gemini Wrong Treaty Date',
    summary: 'An X user (@date_checker; 5200 followers) shared a Gemini app chat in which Gemini said a treaty was signed in 1998 rather than 1898.' });
  const GEMINI_WRONG = geminiWrong(300, 'LOW');
  /** F.P0_OK as another post on the same issue, with `n` engagements. */
  const p0Post = (id, n) => F.P0_OK.split('2109952063492993159').join(id).replace('| X | 1 Engagements', `| X | ${n} Engagements`)
    .replace('VERY LOW (1 engagements)', `${n >= 2000 ? 'HIGH' : 'LOW'} (${n} engagements)`).replace('Product - Perceived bias,1,', `Product - Perceived bias,${n},`);

  // =============================================================================================================
  // The world: the owner's one-space setup (golden_flows.js)
  // =============================================================================================================

  /**
   * The one-space setup three runs in ({t, sh, feed, rec}): its tabs made, the watch ON with its alerts going to the
   * Auto-correct space. `overrides`: settings; `before(w)`: what is set on the sheet before the first run.
   */
  const oneSpace = (overrides, before) => {
    const w = golden.world.oneSpaceWorld(overrides);
    if (before) before(w);
    w.rec.collect('setup');
    w.rec.step('first run', 1);
    golden.world.watchOn(w.t);
    w.sh.getRange(35, 2).setValue('Auto-correct space (B10)');
    w.rec.step('quiet run', 1);
    return w;
  };
  const tops = t => t.chat.botPosts(AC).filter(m => !m.threadReply);
  const under = (t, top) => t.chat.spaces.get(AC).messages.filter(m => m.threadReply && m.thread.name === top.thread.name);
  const alertRows = t => t.bot.sheetBackend_(t.sheet()).loadAlerts();
  const socialAlerts = t => t.g.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
  /** What the bot did with the alert whose card is `top`: its notes, its Alert-log row, its marks, the Social Alerts sent so far. */
  const look = (t, top) => {
    const row = alertRows(t).find(r => r.forward_message === top.name);
    return { t, top, notes: under(t, top).map(m => m.text), row, marks: t.chat.botReactions(top.name), mails: socialAlerts(t) };
  };
  /** The requirement line in a card's thread, as it stands there: [the line (its bullet taken off), the notes that have one]. */
  const lineOf = r => {
    const lines = [];
    r.notes.forEach(n => n.split('\n').forEach(l => { if (/^(?:• )?\*Alert requirements/.test(l)) lines.push(l.replace(/^• /, '')); }));
    return lines;
  };
  /**
   * The line equals what the bot then did: with `sent`, one more Social Alert went to the tester only, the row says sent
   * and the card has the sent mark; without, no email, no draft, and the row has no email. Never a "final" line, and
   * nothing of the line in any email.
   */
  const did = (r, sent, mailsBefore) => {
    eq([r.mails.length - (mailsBefore || 0), r.row.email_status || '', r.marks.includes('📦'), r.t.g.gmail.allDrafts().length],
      [sent ? 1 : 0, sent ? 'sent' : '', !!sent, 0], JSON.stringify([r.notes, r.row.decision]));
    if (sent) eq(r.mails[r.mails.length - 1].to, [TESTER]);
    assert.ok(!r.notes.some(n => n.indexOf(FINAL) >= 0), 'no "final" line: the Social Alert went as the line says');
    assert.ok(!/Alert requirements/.test(JSON.stringify(r.t.g.gmail.sentMessages().map(m => [m.subject, m.text, m.html]))), 'never in an email');
  };
  /** Runs `fn(ctx)` in the Auto-correct flow's next run of the world `w`, after the flow's own work; what `fn` returned. */
  const inFlow = (w, fn) => {
    if (!w.inFlowHook) {
      w.inFlowHook = true;
      w.t.bot.__inFlow = null;
      w.t.bot.ev('runOnce_ = (orig => function (ctx) { const r = orig(ctx); if (__inFlow && ctx.sourceReadOnly === true) __inFlow(ctx); return r; })(runOnce_)');
    }
    let got;
    w.t.bot.__inFlow = ctx => { got = fn(ctx); };
    w.rec.step('a run', 1);
    w.t.bot.__inFlow = null;
    return got;
  };

  // =============================================================================================================
  // The builder
  // =============================================================================================================

  const P0_TAG = 'Product - Perceived bias';
  const P1_TAG = 'Product - Factual inaccuracies (not dangerous/offensive)';
  const P2_TAG = 'Product - Other/general criticism';
  /** What the rules alone say of an alert with these fields (Escalate.gs escalation_). */
  const rules = (fields, opts) => B.escalation_(Object.assign({ product: 'Search', social_network: 'X',
    issue_name: 'Search shows a wrong answer', summary: 'An X user says Search showed a wrong answer.' }, fields),
  Object.assign({ now: NOW }, opts || {}));
  const line = (d, final) => B.requirementLine_(d, final);

  test('requirement line: the builder words a decision in fixed forms, each starting "*Alert requirements:*". Met for a Social Alert: a P0 exposure tag, a Sensitive Topic, a KOF author with the lists (their own brackets taken out), the engagements against the 2,000 bar, and several at once. Met, but none was sent: a repeat by the earlier alert\'s id, the review\'s reason, YouTube as the subject. Not met: the threshold the tag\'s priority needs and what the post has, an ongoing issue whose author is no KOF, an exclusion', () => {
    const p0 = rules({ exposure_tag: P0_TAG, total_engagement: 3 });
    const topic = rules({ exposure_tag: P2_TAG, risk_tags: ['Child Safety'], total_engagement: 12 });
    const kofFields = { exposure_tag: P2_TAG, kof: true, kof_lists: ['Viral KOFs (KOFs)', 'CAM Tech/AI (INFs)'], total_engagement: 11 };
    const high = rules({ exposure_tag: P2_TAG, total_engagement: 2400 });
    const both = rules({ exposure_tag: P0_TAG, total_engagement: 29425 });
    const low = rules({ exposure_tag: P2_TAG, total_engagement: 620 });
    eq([p0.escalated, topic.escalated, high.escalated, both.escalated, low.escalated, low.suppression], [true, true, true, true, false, 'below_threshold']);
    // met, and the Social Alert goes out
    eq([line({ rules: p0, sent: true }), line({ rules: topic, sent: true }), line({ rules: rules(kofFields), kof: kofFields.kof_lists, sent: true }),
      line({ rules: rules(kofFields), sent: true }), line({ rules: high, sent: true }), line({ rules: both, sent: true })], [
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`,
      `${HEAD}met for a Social Alert: Sensitive Topic (Child Safety).`,
      `${HEAD}met for a Social Alert: KOF author (Viral KOFs, CAM Tech/AI).`,
      `${HEAD}met for a Social Alert: KOF author.`,  // (a KOF with no list named)
      `${HEAD}met for a Social Alert: 2,400 engagements (2,000+ needed).`,
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias) · 29,425 engagements (2,000+ needed).`,
    ]);
    // met, but none was sent
    const youtube = rules({ product: 'YouTube', exposure_tag: P2_TAG, total_engagement: 2400, issue_name: 'YouTube removes a creator video',
      summary: 'A creator says YouTube removed a video.' });
    const youtubeLow = rules({ product: 'YouTube', exposure_tag: 'Product - Dangerous results (e.g. medical/legal)', total_engagement: 40,
      issue_name: 'YouTube shows a dangerous video', summary: 'A user says YouTube showed a dangerous video.' });
    eq([youtube.escalated, youtube.action, youtubeLow.escalated, youtubeLow.suppression], [false, 'YOUTUBE_CHAT_ONLY', false, 'youtube_no_action']);
    eq([line({ rules: high, sent: false, repeat: 'QA-1001' }), line({ rules: high, sent: false, repeat: true }),
      line({ rules: both, sent: false, review: 'It is a parody account with no real claim.' }),
      line({ rules: high, sent: false, why: 'Sprinklr shows 12 comments at 10% negativity (below the 30 comments and 30% negativity threshold for owned social posts)' }),
      line({ rules: youtube, sent: false }), line({ rules: youtubeLow, sent: false }), line({ rules: youtube, sent: false, repeat: 'QA-1007' })], [
      `${HEAD}met for a Social Alert (2,400 engagements), but none was sent: a repeat of QA-1001.`,
      `${HEAD}met for a Social Alert (2,400 engagements), but none was sent: a repeat of an earlier alert.`,
      `${HEAD}met for a Social Alert (P0 exposure tag, 29,425 engagements), but none was sent: the review says "It is a parody account with no real claim".`,
      `${HEAD}met for a Social Alert (2,400 engagements), but none was sent: Sprinklr shows 12 comments at 10% negativity (below the 30 comments and 30% negativity threshold for owned social posts).`,
      `${HEAD}met for a Social Alert (2,400 engagements), but none was sent: YouTube is the subject.`,
      `${HEAD}met for a Social Alert (P0 exposure tag), but none was sent: YouTube is the subject.`,
      `${HEAD}met for a Social Alert (2,400 engagements), but none was sent: a repeat of QA-1007.`,  // (a repeat comes first, as in the Alert log)
    ]);
    // not met
    const ongoing = rules({ exposure_tag: P0_TAG, total_engagement: 3 }, { status: 'ONGOING' });
    const excluded = rules({ exposure_tag: P2_TAG, total_engagement: 4200, summary: 'A Reddit user told a commenter to just google it.' });
    eq([ongoing.suppression, excluded.suppression], ['ongoing_no_kof', 'EXCLUDED_GOOGLE_AS_VERB']);
    eq([line({ rules: low, sent: false }), line({ rules: rules({ exposure_tag: P1_TAG, total_engagement: 1 }), sent: false }),
      line({ rules: rules({ exposure_tag: P2_TAG }), sent: false }), line({ rules: rules({ total_engagement: 40 }), sent: false }),
      line({ rules: ongoing, sent: false }), line({ rules: excluded, sent: false }),
      line({ rules: low, sent: false, repeat: 'QA-1001' })], [
      `${HEAD}not met for a Social Alert (${BELOW('P2', '620')}). Monitoring only.`,
      `${HEAD}not met for a Social Alert (a P1 tag needs 2,000+ engagements, a KOF author or a Sensitive Topic; this post: 1 engagement, no KOF author). Monitoring only.`,
      `${HEAD}not met for a Social Alert (a P2 tag needs 2,000+ engagements, a KOF author or a Sensitive Topic; this post: no engagement count, no KOF author). Monitoring only.`,
      `${HEAD}not met for a Social Alert (a post with no confirmed exposure tag needs 2,000+ engagements, a KOF author or a Sensitive Topic; this post: 40 engagements, no KOF author). Monitoring only.`,
      `${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). Monitoring only.`,
      `${HEAD}not met for a Social Alert (excluded: google as verb). Monitoring only.`,
      `${HEAD}not met for a Social Alert (${BELOW('P2', '620')}). Monitoring only.`,  // (a repeat of an alert that met none either)
    ]);
    // the ongoing and exclusion words are the reason functions' own (OtherAlerts.gs otherNoEscWhy_), which are not edited
    eq([B.otherNoEscWhy_(ongoing, '', ''), B.otherNoEscWhy_(excluded, '', ''), B.noEmailWhy_(low), B.escalationWhyText_(both)],
      ['an ongoing issue, and the author isn\'t a KOF', 'excluded: google as verb', 'P2, 620 engagements: below the escalation criteria',
        'P0 criteria (Product - Perceived bias) · High engagement (29,425 on X)']);
  });

  test('requirement line: the builder says what the rules count, where that is not what the alert shows. A Sensitive Topic on the alert that the rules leave out is named with the reason (Privacy on a privacy tag restates the exposure tag; Politics does not count outside the US), so "needs … a Sensitive Topic" never reads as if the alert had none; an account suspension that claims censorship is said to count as the P0 tag Product - Perceived bias (the alert keeps its own tag); and on an ongoing issue whose author is no KOF, where a P0 tag or a Sensitive Topic sends no Social Alert by itself, 2,000+ engagements are the one requirement met', () => {
    // Sensitive Topics the rules leave out (Escalate.gs escalation_: risk_topics that are not in sensitive_topics)
    const privacy = rules({ exposure_tag: PRIVACY_TAG, product: 'Chrome', risk_tags: ['Privacy'], total_engagement: 300 });
    const two = rules({ exposure_tag: PRIVACY_TAG, product: 'Chrome', risk_tags: ['Privacy', 'Malicious & Unwanted Software'], total_engagement: 300 });
    const abroad = rules({ exposure_tag: P2_TAG, risk_tags: ['Politics'], location: 'France', total_engagement: 300 });
    const mixed = rules({ exposure_tag: PRIVACY_TAG, risk_tags: ['Privacy', 'Politics'], location: 'France', total_engagement: 300 });
    const home = rules({ exposure_tag: P2_TAG, risk_tags: ['Politics'], location: 'US', total_engagement: 300 });
    const election = rules({ exposure_tag: P2_TAG, risk_tags: ['Politics'], location: 'France', total_engagement: 300,
      summary: 'An X user says Search hides the election results.' });
    const counted = rules({ exposure_tag: PRIVACY_TAG, risk_tags: ['Privacy', 'Child Safety'], total_engagement: 300 });
    eq([privacy.escalated, privacy.sensitive_topics, privacy.risk_topics, two.risk_topics, abroad.escalated, abroad.risk_topics, mixed.escalated,
      home.escalated, election.escalated, counted.sensitive_topics],
    [false, [], ['Privacy'], ['Privacy', 'Malicious & Unwanted Software'], false, ['Politics'], false, true, true, ['Child Safety']]);
    const RESTATES = '; its Sensitive Topic (Privacy) restates the exposure tag and does not count';
    const ABROAD = '; its Sensitive Topic (Politics) does not count outside the US';
    eq([line({ rules: privacy, sent: false }), line({ rules: two, sent: false }), line({ rules: abroad, sent: false }), line({ rules: mixed, sent: false }),
      line({ rules: privacy, sent: true }), line({ rules: home, sent: true }), line({ rules: election, sent: true }), line({ rules: counted, sent: true })], [
      `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}${RESTATES}). Monitoring only.`,
      `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}; its Sensitive Topics (Privacy, Malicious & Unwanted Software) restate the exposure ` +
        'tag and do not count). Monitoring only.',
      `${HEAD}not met for a Social Alert (${BELOW('P2', '300')}${ABROAD}). Monitoring only.`,
      `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}${RESTATES}${ABROAD}). Monitoring only.`,
      `${HEAD}below the Social Alert thresholds (${BELOW('P1', '300')}${RESTATES}). ${ANYWAY}`,
      // a topic that counts is the requirement met, in the US or with an election in the post; one left out beside it is not named
      `${HEAD}met for a Social Alert: Sensitive Topic (Politics).`,
      `${HEAD}met for a Social Alert: Sensitive Topic (Politics).`,
      `${HEAD}met for a Social Alert: Sensitive Topic (Child Safety).`,
    ]);
    // an alert with no topic, or whose topics all count, says nothing more; the story's own cause and the triage's stand as they were
    eq([B.requirementTopicsLeft_(rules({ exposure_tag: P2_TAG, total_engagement: 300 })), B.requirementTopicsLeft_(counted).length > 0,
      B.requirementTopicsLeft_(home), B.requirementTopicsLeft_({}),
      line({ rules: privacy, sent: false, early: { accounts: 5, pace: 0 } }), line({ rules: privacy, sent: false, cause: 'the review sees no Google brand-safety issue in it' })],
    ['', true, '', '', `${HEAD}not met yet (${EARLY}). Posted early because 5 accounts tell the same story.`,
      `${HEAD}not met for a Social Alert (the review sees no Google brand-safety issue in it). Monitoring only.`]);

    // An account suspension that claims censorship or bias: the rules count it as Product - Perceived bias, a P0 tag
    // (config remap_suspension_bias). Given the alert's own tag, the line says so, in the long form and the short one
    const banned = rules({ exposure_tag: SUSPENSION_TAG, product: 'Gmail', total_engagement: 300, issue_name: 'Gmail account suspension censorship claim',
      summary: 'An X user says Google suspended their Gmail account to censor them.' });
    const plainBan = rules({ exposure_tag: SUSPENSION_TAG, product: 'Gmail', total_engagement: 300, issue_name: 'Gmail account suspended',
      summary: 'An X user says their Gmail account was suspended for no reason.' });
    const p0 = rules({ exposure_tag: P0_TAG, total_engagement: 3 });
    eq([banned.exposure_tag, banned.priority, banned.escalated, plainBan.exposure_tag, plainBan.escalated], [P0_TAG, 'P0', true, SUSPENSION_TAG, false]);
    eq([line({ rules: banned, tag: SUSPENSION_TAG, sent: true }), line({ rules: banned, tag: SUSPENSION_TAG, sent: false, repeat: 'QA-1001' }),
      line({ rules: Object.assign({}, banned, { engagement_total: 2500, reasons: ['P0_TOPIC', 'HIGH_ENGAGEMENT'] }), tag: SUSPENSION_TAG, sent: true }),
      // the alert's own tag, in any spelling, has nothing to explain; nor has a line that isn't given the alert's tag
      line({ rules: p0, tag: P0_TAG, sent: true }), line({ rules: p0, tag: 'product - perceived bias', sent: true }), line({ rules: banned, sent: true }),
      line({ rules: banned, tag: 'A tag of another kind', sent: true }), line({ rules: plainBan, tag: SUSPENSION_TAG, sent: false })], [
      `${HEAD}met for a Social Alert: ${COUNTS_AS_BIAS}.`,
      `${HEAD}met for a Social Alert (${COUNTS_AS_BIAS}), but none was sent: a repeat of QA-1001.`,
      `${HEAD}met for a Social Alert: ${COUNTS_AS_BIAS} · 2,500 engagements (2,000+ needed).`,
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`,
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`,
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`,
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias: the alert's tag, A tag of another kind, counts as it).`,
      `${HEAD}not met for a Social Alert (${BELOW('P2', '300')}). Monitoring only.`,
    ]);
    eq([B.requirementTagAs_(P0_TAG, SUSPENSION_TAG), B.requirementTagAs_(P0_TAG, P0_TAG), B.requirementTagAs_(P0_TAG, ''), B.requirementTagAs_(P0_TAG, undefined)],
      ['an account suspension that claims censorship or bias counts as it', '', '', '']);

    // An ongoing issue whose author is no KOF: a P0 tag, a Sensitive Topic or a briefed topic sends nothing by itself
    // (the post before it on the issue said "an ongoing issue, and the author isn't a KOF"), so with 2,000+ engagements
    // those are the one requirement met. A KOF author on an ongoing issue counts, and so does the tag beside it; so do
    // both on a new issue
    const ongoingHigh = rules({ exposure_tag: P0_TAG, total_engagement: 2500 }, { status: 'ONGOING' });
    const ongoingTopic = rules({ exposure_tag: P2_TAG, risk_tags: ['Child Safety'], total_engagement: 2500 }, { status: 'ONGOING' });
    const ongoingKof = rules({ exposure_tag: P0_TAG, kof: true, kof_lists: ['Viral KOFs (KOFs)'], total_engagement: 2500 }, { status: 'ONGOING' });
    const ongoingLow = rules({ exposure_tag: P0_TAG, total_engagement: 300 }, { status: 'ONGOING' });
    const fresh = rules({ exposure_tag: P0_TAG, total_engagement: 2500 });
    eq([ongoingHigh.track, ongoingHigh.reasons, ongoingHigh.is_kof, ongoingTopic.track, ongoingTopic.reasons, ongoingKof.track, ongoingLow.suppression, fresh.track],
      ['HIGH_ENGAGEMENT', ['P0_TOPIC', 'HIGH_ENGAGEMENT'], false, 'HIGH_ENGAGEMENT', ['SENSITIVE_TOPIC', 'HIGH_ENGAGEMENT'], 'URGENT', 'ongoing_no_kof', 'URGENT']);
    eq([line({ rules: ongoingHigh, sent: true }), line({ rules: ongoingTopic, sent: true }), line({ rules: ongoingHigh, sent: false, repeat: 'QA-1001' }),
      line({ rules: ongoingKof, kof: ['Viral KOFs (KOFs)'], sent: true }), line({ rules: ongoingLow, sent: false }), line({ rules: fresh, sent: true })], [
      `${HEAD}met for a Social Alert: 2,500 engagements (2,000+ needed).`,
      `${HEAD}met for a Social Alert: 2,500 engagements (2,000+ needed).`,
      `${HEAD}met for a Social Alert (2,500 engagements), but none was sent: a repeat of QA-1001.`,
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias) · KOF author (Viral KOFs) · 2,500 engagements (2,000+ needed).`,
      `${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). Monitoring only.`,
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias) · 2,500 engagements (2,000+ needed).`,
    ]);
  });

  test('requirement line: the "not met" form says what happens with the alert instead of "Monitoring only." when it is acted on all the same: a T&S form in its thread ("No Social Alert; a T&S form is asked for below."; with Auto-submit T&S form ON, "…; the T&S form is handled below."; while the alert waits on Burson, "…; a T&S form follows once Burson adds what is missing."), or a person who checks it ("A person checks it: …"); the other forms say what happens already and stay as they are. A Social Alert that is planned while Testing has nobody to send it to says what its email waits for', () => {
    const low = rules({ exposure_tag: P2_TAG, total_engagement: 620 });
    const high = rules({ exposure_tag: P2_TAG, total_engagement: 2400 });
    const p0 = rules({ exposure_tag: P0_TAG, total_engagement: 3 });
    const ongoing = rules({ exposure_tag: P0_TAG, total_engagement: 3 }, { status: 'ONGOING' });
    eq([line({ rules: low, sent: false, tns: 'ask' }), line({ rules: low, sent: false, tns: 'auto' }), line({ rules: low, sent: false, tns: 'later' }),
      line({ rules: ongoing, sent: false, tns: 'ask' }),
      line({ rules: low, sent: false, check: 'its exposure tag isn\'t confirmed' }),
      // (a person who checks it comes first: whether a Social Alert goes out is that person's call)
      line({ rules: low, sent: false, check: 'its engagement count isn\'t known', tns: 'ask' }),
      line({ rules: low, sent: false, cause: 'the review sees no Google brand-safety issue in it', tns: 'ask' })], [
      `${HEAD}not met for a Social Alert (${BELOW('P2', '620')}). ${TNS_ASKED}`,
      `${HEAD}not met for a Social Alert (${BELOW('P2', '620')}). ${TNS_HANDLED}`,
      `${HEAD}not met for a Social Alert (${BELOW('P2', '620')}). ${TNS_LATER}`,
      `${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). ${TNS_ASKED}`,
      `${HEAD}not met for a Social Alert (${BELOW('P2', '620')}). A person checks it: its exposure tag isn't confirmed.`,
      `${HEAD}not met for a Social Alert (${BELOW('P2', '620')}). A person checks it: its engagement count isn't known.`,
      `${HEAD}not met for a Social Alert (the review sees no Google brand-safety issue in it). ${TNS_ASKED}`,
    ]);
    // every other form is what it is without them
    [{ rules: high, sent: false, repeat: 'QA-1001' }, { rules: high, sent: false, review: 'A meme' }, { rules: high, sent: true }, { rules: low, sent: true },
      { rules: low, sent: false, early: { accounts: 5, pace: 0 } }].forEach(d => {
      eq([line(Object.assign({ tns: 'ask' }, d)), line(Object.assign({ tns: 'auto', check: 'its exposure tag isn\'t confirmed' }, d))], [line(d), line(d)], JSON.stringify(d));
    });
    // "Monitoring only." stands only where nothing else is done with the alert
    const all = [line({ rules: low, sent: false }), line({ rules: low, sent: false, tns: 'ask' }), line({ rules: low, sent: false, tns: 'auto' }),
      line({ rules: low, sent: false, tns: 'later' }), line({ rules: low, sent: false, check: 'its exposure tag isn\'t confirmed' })];
    eq(all.map(l => /Monitoring only\.$/.test(l)), [true, false, false, false, false]);
    eq([B.requirementThen_({}), B.requirementThen_({ tns: 'ask' }), B.requirementThen_({ tns: 'auto' }), B.requirementThen_({ tns: 'later' }),
      B.requirementThen_({ tns: true })], ['Monitoring only.', TNS_ASKED, TNS_HANDLED, TNS_LATER, TNS_ASKED]);
    // a planned Social Alert that can't go yet: both forms that say one goes out; never a form that says none does
    const HOLD = 'a test recipient in Control B30';
    eq([line({ rules: p0, sent: true, hold: HOLD }), line({ rules: low, sent: true, hold: HOLD }), line({ rules: low, sent: true, call: 'test', hold: HOLD }),
      line({ rules: high, sent: false, repeat: true, hold: HOLD }), line({ rules: low, sent: false, hold: HOLD }), B.ev('REQ_HOLD_B30_')], [
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias). ${B30_WAIT}`,
      `${HEAD}below the Social Alert thresholds (${BELOW('P2', '620')}). ${ANYWAY} ${B30_WAIT}`,
      `${HEAD}below the Social Alert thresholds (${BELOW('P2', '620')}). A Social Alert goes out anyway: a test alert from the Test alert tab always sends one. ${B30_WAIT}`,
      `${HEAD}met for a Social Alert (2,400 engagements), but none was sent: a repeat of an earlier alert.`,
      `${HEAD}not met for a Social Alert (${BELOW('P2', '620')}). Monitoring only.`,
      HOLD,
    ]);
  });

  test('requirement line: a story or build-up card says it is posted early ("not met yet (small accounts, no KOF author, no P0 tag). Posted early because 5 accounts tell the same story."; a pace jump by its pace in whole numbers, "at about 3 times the usual pace", never with decimals); a Social Alert the rules don\'t call for says who sends it ("below the Social Alert thresholds (…). A Social Alert goes out anyway on the review\'s call.", or as a test from the Test alert tab); the same forms stand under "*Alert requirements, final:*"; a reason of Gemini\'s is one line of 160 characters without links (an internal "go/…" link is left out); and the line never says "SLRR", in capitals or not, nor gives a feed\'s floor as a requirement', () => {
    const low = rules({ exposure_tag: P2_TAG, total_engagement: 44 });
    const high = rules({ exposure_tag: P2_TAG, total_engagement: 2400 });
    eq([line({ rules: low, sent: false, early: { accounts: 5, pace: 0 } }), line({ rules: low, sent: false, early: { accounts: 36, pace: 3.2 } }),
      line({ rules: low, sent: false, early: { accounts: 0, pace: 0 } }), line({ rules: low, sent: false, early: { accounts: 1, pace: 0 } })], [
      `${HEAD}not met yet (${EARLY}). Posted early because 5 accounts tell the same story.`,
      `${HEAD}not met yet (${EARLY}). Posted early because 36 accounts posted about it at about 3 times the usual pace.`,
      `${HEAD}not met yet (${EARLY}). Posted early because several accounts tell the same story.`,
      `${HEAD}not met yet (${EARLY}). Posted early because 1 account tells the same story.`,
    ]);
    // the pace is said in whole numbers: 12 (never "12.0x"), 1.96 as 2, 15.55 as 16; a pace under twice the usual has no
    // number; one that is no jump at all (or isn't known) says how many accounts tell the story
    const pace = (accounts, times) => B.requirementEarly_({ accounts, pace: times });
    eq([pace(36, 12), pace(6, 3.24), pace(6, 1.96), pace(1200, 15.55), pace(6, 1.5), pace(6, 1.49), pace(6, 1.2), pace(1, 4), pace(0, 2.6),
      pace(6, 1), pace(6, 0.5), pace(6, 0), pace(6, NaN), pace(6, undefined)], [
      'Posted early because 36 accounts posted about it at about 12 times the usual pace.',
      'Posted early because 6 accounts posted about it at about 3 times the usual pace.',
      'Posted early because 6 accounts posted about it at about 2 times the usual pace.',
      'Posted early because 1,200 accounts posted about it at about 16 times the usual pace.',
      'Posted early because 6 accounts posted about it at about 2 times the usual pace.',
      'Posted early because 6 accounts posted about it faster than the usual pace.',
      'Posted early because 6 accounts posted about it faster than the usual pace.',
      'Posted early because 1 account posted about it at about 4 times the usual pace.',
      'Posted early because several accounts posted about it at about 3 times the usual pace.',
      'Posted early because 6 accounts tell the same story.',
      'Posted early because 6 accounts tell the same story.',
      'Posted early because 6 accounts tell the same story.',
      'Posted early because 6 accounts tell the same story.',
      'Posted early because 6 accounts tell the same story.',
    ]);
    [[36, 12], [6, 3.24], [6, 1.96], [1200, 15.55], [6, 1.2], [6, 0.5], [9, 2.449], [9, 99.5]].forEach(([accounts, times]) => {
      const said = pace(accounts, times).replace(/(\d),(\d{3})/g, '$1$2');  // ("1,200 accounts" has a thousands mark, no decimals)
      assert.ok(!/\d\.\d|\dx\b/.test(said), said);
    });
    // a story on an ongoing issue is no "not yet": the rules' own cause stands
    eq(line({ rules: rules({ exposure_tag: P0_TAG, total_engagement: 44 }, { status: 'ONGOING' }), sent: false, early: { accounts: 5, pace: 0 } }),
      `${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). Monitoring only.`);
    const mid = rules({ exposure_tag: P2_TAG, total_engagement: 620 });
    eq([line({ rules: mid, sent: true }), line({ rules: mid, sent: true, call: 'test' }), line({ rules: low, sent: true, early: { accounts: 5, pace: 0 } }),
      line({ rules: mid, sent: false, cause: 'the review sees no Google brand-safety issue in it' })], [
      `${HEAD}below the Social Alert thresholds (${BELOW('P2', '620')}). ${ANYWAY}`,
      `${HEAD}below the Social Alert thresholds (${BELOW('P2', '620')}). A Social Alert goes out anyway: a test alert from the Test alert tab always sends one.`,
      `${HEAD}below the Social Alert thresholds (${EARLY}). ${ANYWAY}`,
      `${HEAD}not met for a Social Alert (the review sees no Google brand-safety issue in it). Monitoring only.`,
    ]);
    // "final": the same forms under their own head
    eq([line({ rules: high, sent: false, why: 'emails are off in this run (a dry run)' }, true), line({ rules: high, sent: true }, true)], [
      `${FINAL}met for a Social Alert (2,400 engagements), but none was sent: emails are off in this run (a dry run).`,
      `${FINAL}met for a Social Alert: 2,400 engagements (2,000+ needed).`,
    ]);
    // Gemini's reason: one line, no Markdown or Chat link (its words stay), nobody mentioned, at most 160 characters
    const reason = 'A routine complaint\nwith no new claim;  see [the thread](https://x.com/a/status/1) and <https://example.com/x|this page>, ' +
      'cc <users/all>. The SLRR rules say so.';
    eq(B.requirementWords_(reason), 'A routine complaint with no new claim; see the thread and this page, cc users/all . The alert requirements rules say so');
    const long = line({ rules: high, sent: false, review: `${'This is a long reason. '.repeat(20)}[more](https://example.com)` });
    const said = long.slice(long.indexOf('"') + 1, long.lastIndexOf('"'));
    eq([said.length, /\n/.test(long), /\]\(|https?:/.test(long), long.endsWith('…".')], [160, false, false, true]);
    // an internal short link ("go/…") is left out with the word that leads to it, never rewritten into other words; the
    // team's own name goes in small letters too; a web address that only has "/go/" in it is no such link
    eq(['not an slrr alert, see go/SLRR-Database', 'Below the bar per SLRR (go/slrr).', 'Per go/slrr-rules, it is routine. See go/x.',
      'It is fine. See go/x. Nothing new', 'A go/no-go call for comms', 'See https://example.com/go/page for the post',
      'An Slrr repeat of Monday\'s alert (go/SLRR-log).', 'see go/x'].map(B.requirementWords_), [
      'not an alert requirements alert',
      'Below the bar per alert requirements',
      'it is routine',
      'It is fine. Nothing new',
      'A go/no-go call for comms',
      'See https://example.com/go/page for the post',
      'An alert requirements repeat of Monday\'s alert',
      '',
    ]);
    // never "SLRR": not from Gemini's reason, the bot's own words, a KOF list's name or a cause, in capitals or not
    const kof = { exposure_tag: P2_TAG, kof: true, kof_lists: ['SLRR KOFs (KOFs)'], total_engagement: 11 };
    const kofLower = { exposure_tag: P2_TAG, kof: true, kof_lists: ['slrr kofs (KOFs)'], total_engagement: 11 };
    const lines = [line({ rules: high, sent: false, review: 'Below SLRR thresholds, an SLRR repeat' }), line({ rules: high, sent: false, why: 'the SLRR rules would escalate it' }),
      line({ rules: rules(kof), kof: kof.kof_lists, sent: true }), line({ rules: mid, sent: false, cause: 'not an SLRR issue' }),
      line({ rules: high, sent: false, review: 'not an slrr alert, see go/SLRR-Database' }), line({ rules: rules(kofLower), kof: kofLower.kof_lists, sent: true }),
      line({ rules: mid, sent: false, cause: 'not a Slrr issue' })];
    lines.forEach(l => assert.ok(!/slrr|\bgo\//i.test(l) && /alert requirements/.test(l), l));
    // never the 500 the BigQuery feed collects from, nor the 100 the Watch triage counts as collected, as a requirement
    const every = [line({ rules: mid, sent: false }), line({ rules: mid, sent: true }), line({ rules: high, sent: true }), line({ rules: high, sent: false, repeat: true }),
      line({ rules: low, sent: false, early: { accounts: 5, pace: 0 } })];
    every.forEach(l => assert.ok(!/\b500\b|\b100\b/.test(l), l));
    // every form is one line that starts with the registered first words: the bot's own (never answered), held on any
    // way to S-F Burson, and denied by the leak audit; as a bullet in a triage note too
    lines.concat(every, [long, line({ rules: high, sent: true }, true)]).forEach(l => {
      assert.ok(l.indexOf(HEAD) === 0 || l.indexOf(FINAL) === 0, l);
      eq([/\n/.test(l), B.isThreadNoteText_(l), B.isBotFormattedText_(l), B.outboxGuardHits_(l, GUARD).length > 0, leakDenied(l),
        B.outboxGuardHits_(`🤖 *Triage: 👍 Worth a look*\nA summary.\n• ${l}`, GUARD).length > 0, leakDenied(`🤖 *Triage*\n• ${l}`)],
      [false, true, true, true, true, true, true], l);
    });
    // each form of the line (never the "final" one, which is a note of its own) is known as the review note's last line,
    // with Chat's bold marks or without, so a note that is the write-up's sources and that line is the bot's own too
    lines.concat(every, [long]).forEach(l => {
      eq([B.isRequirementLine_(l), B.isRequirementLine_(l.replace(/\*/g, '')), B.isBotFormattedText_(`Sources: Le Monde, Reuters\n${l}`),
        B.isBotFormattedText_(`Sources: Le Monde, Reuters\n${l.replace(/\*/g, '')}`)], [true, true, true, true], l);
    });
    eq([line({ rules: high, sent: true }, true), '*Alert requirements:* yes they are', 'Alert requirements: all met.', 'Alert requirements are met',
      '*Alert requirements:* met', ''].map(B.isRequirementLine_), [false, false, false, false, false, false]);
  });

  test('requirement line: what the rules alone say is never a result a review or a test forced (a Guidance row, a sheet test, a triage, a watch, an Early Detection review: the rules are asked again, with the same issue status); a repeat is named by the id in the reason\'s own text; Gemini\'s veto by its reason, a rule\'s by its words', () => {
    const fields = { product: 'Search', social_network: 'X', exposure_tag: P2_TAG, total_engagement: 300, issue_name: 'An issue', summary: 'A summary.' };
    const base = B.escalation_(fields, { now: NOW });
    eq([base.escalated, B.requirementRules_(base, fields, NOW) === base], [false, true]);  // the rules' own result is taken as it is
    ['KB_OR_GUIDANCE', 'SHEET_TEST_ALERT', 'STREAM_TRIAGE', 'PROACTIVE_WATCH', 'EARLY_DETECTION'].forEach(code => {
      const forced = Object.assign({}, base, { escalated: true, track: 'URGENT', action: 'EMAIL_ALERT', suppression: null, reasons: base.reasons.concat([code]) });
      const back = B.requirementRules_(forced, fields, NOW);
      eq([back.escalated, back.suppression, back.status], [false, 'below_threshold', base.status], code);
    });
    // ...with the escalation's own issue status: an ongoing issue stays one
    const p0 = Object.assign({}, fields, { exposure_tag: P0_TAG });
    const ongoing = B.escalation_(p0, { status: 'ONGOING', now: NOW });
    const forcedOngoing = Object.assign({}, ongoing, { escalated: true, suppression: null, reasons: ongoing.reasons.concat(['EARLY_DETECTION']) });
    eq([B.requirementRules_(forcedOngoing, p0, NOW).suppression, B.requirementRules_(null, p0, NOW).escalated], ['ongoing_no_kof', true]);
    eq(['the same post was already alerted (QA-1001)', 'a reply in the thread of QA-1044, which was already alerted: nothing new',
      'folded into QA-1007 (the same story: "Maps outage")', 'Social Alert sent by the other flow (QA-12)',
      'already alerted as a known issue (QA-1003, "Chrome tabs"): nothing new',
      'the same post was already alerted (https://x.com/a/status/1, SLRR alert log)', ''].map(B.requirementRepeat_),
    ['QA-1001', 'QA-1044', 'QA-1007', 'QA-12', 'QA-1003', true, true]);
    eq([B.requirementVeto_('AI review: A meme with no claim'), B.requirementVeto_('AI review (KOF): already alerted: the same clip'),
      B.requirementVeto_('non-English post (pt) excluded under the English-language collection rule')],
    [{ review: 'A meme with no claim' }, { review: 'already alerted: the same clip' },
      { why: 'non-English post (pt) excluded under the English-language collection rule' }]);
    // A repeat is named by the earlier alert's id. But the same Burson alert that the other flow already sent the Social
    // Alert for (the alert memory's "live" verdict, beside a Mirror space) is no alert of this space: the line says who
    // sent it, never "a repeat of" an alert that has no card here. Only the memory's own verdict for that very text counts
    const live = { skip: 'Social Alert sent by the other flow (QA-1004)', kind: 'live', ref: 'QA-1004' };
    const post = { skip: 'the same post was already emailed (QA-1001)', kind: 'post', ref: 'QA-1001' };
    const fold = { skip: 'folded into QA-1007 (the same story: "Maps outage")', kind: 'story', ref: 'QA-1007', fold: true };
    eq([B.requirementRepeatWhy_(live.skip, live), B.requirementRepeatWhy_(post.skip, post), B.requirementRepeatWhy_(fold.skip, fold),
      B.requirementRepeatWhy_('the same post was already alerted (QA-1002)', live), B.requirementRepeatWhy_(live.skip, null),
      B.requirementRepeatWhy_(live.skip, { skip: '', update: {} }), B.requirementRepeatWhy_('Social Alert sent by the other flow', { skip: 'Social Alert sent by the other flow', kind: 'live' }),
      B.requirementRepeatWhy_('', undefined)], [
      { why: 'the other flow already sent it (QA-1004)' }, { repeat: 'QA-1001' }, { repeat: 'QA-1007' },
      { repeat: 'QA-1002' }, { repeat: 'QA-1004' }, { repeat: 'QA-1004' }, { why: 'the other flow already sent it' }, { repeat: true }]);
    const high = B.escalation_(Object.assign({}, fields, { total_engagement: 2400 }), { now: NOW });
    eq([B.requirementLine_(Object.assign({ rules: high, sent: false }, B.requirementRepeatWhy_(live.skip, live))),
      B.requirementLine_(Object.assign({ rules: high, sent: false }, B.requirementRepeatWhy_(post.skip, post)))], [
      `${HEAD}met for a Social Alert (2,400 engagements), but none was sent: the other flow already sent it (QA-1004).`,
      `${HEAD}met for a Social Alert (2,400 engagements), but none was sent: a repeat of QA-1001.`]);
  });

  // =============================================================================================================
  // Burson's corrected copy
  // =============================================================================================================

  /** Burson's alerts `texts` through the one-space setup, a run each: what the bot did with the last one (look). */
  const burson = (texts, script, before) => {
    const w = oneSpace(null, before);
    if (script) script(w.t);
    const mails = [];
    texts.forEach((text, i) => {
      mails.push(socialAlerts(w.t).length);
      w.rec.step(`alert ${i + 1}`, i ? 3 : 1, () => { w.t.chat.say(REAL, text, ZAPIER); });
    });
    w.rec.step('quiet run', 1);
    const r = look(w.t, tops(w.t).slice(-1)[0]);
    r.before = mails[mails.length - 1];
    eq(w.t.chat.botPosts(REAL), []);  // the live Burson space is only read
    return r;
  };

  test('requirement line: Burson\'s alert, corrected in the Auto-correct space and escalated by a P0 exposure tag, a Sensitive Topic, a KOF author or its engagements: the review\'s note is that one line (nothing else was changed), naming the requirement it met, and the Social Alert goes to the tester', () => {
    const p0 = burson([F.P0_OK]);
    eq(p0.notes, [`${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`]);
    did(p0, true);
    assert.ok(p0.top.text.indexOf('✅ *Reviewed by the agentic assistant*\n') === 0 && !/Alert requirements/.test(p0.top.text), 'no line on the alert itself');
    const topic = burson([LOW_OK.replace('[Sensitive Topic]: None', '[Sensitive Topic]: Child Safety')]);
    eq([topic.notes[0], /^T&S form needed \(child safety\)/.test(topic.notes[1]), topic.notes.length],
      [`${HEAD}met for a Social Alert: Sensitive Topic (Child Safety).`, true, 2]);
    did(topic, true);
    const kof = burson([F.WAYMO_KOF]);
    eq(kof.notes, [`${HEAD}met for a Social Alert: KOF author (Viral KOFs).`]);
    did(kof, true);
    const high = burson([MAPS_OK]);
    eq(high.notes, [`${HEAD}met for a Social Alert: 4,200 engagements (2,000+ needed).`]);
    did(high, true);
  });

  test('requirement line: Burson\'s alert with mistakes: the line is the last line of the note that lists what the agentic assistant changed, and the Social Alert goes out as it says (the alert is on an ongoing issue and its author is no KOF, so its 29,425 engagements are the requirement it meets, not its P0 tag)', () => {
    const r = burson([F.MISTAKES]);
    eq(r.notes, [`${CHANGES}\n- Product: Gems to Gemini App\n- Social Network: Instagram to X\n- Priority banner: P2 to P0\n- Engagement: LOW to HIGH\n` +
      `${HEAD}met for a Social Alert: 29,425 engagements (2,000+ needed).`]);
    did(r, true);
    assert.ok(/\[Name\]: Criticism against AI Overviews \/ Ongoing Issue\n/.test(r.top.text), r.top.text);
  });

  test('requirement line: the line agrees with the alert it stands under. A Sensitive Topic the alert shows and the rules don\'t count (Privacy on a privacy tag) is named as not counting, and no Social Alert goes out; an account suspension that claims censorship is said to count as the P0 tag Product - Perceived bias, while the alert and its email keep the tag Burson gave it, and the Social Alert goes out; on an ongoing issue whose author is no KOF, a second post below the bar is not met ("an ongoing issue, and the author isn\'t a KOF") and one with 2,500 engagements is met by its engagements alone, sent as an update on the first email', () => {
    const privacy = burson([PRIVACY]);
    assert.ok(/\n\[Exposure Tag\]: Product - Privacy & security concerns\n/.test(privacy.top.text) && /\n\[Sensitive Topic\]: Privacy\n/.test(privacy.top.text), privacy.top.text);
    eq([privacy.notes, privacy.row.decision, privacy.marks],
      [[`${HEAD}not met for a Social Alert (${BELOW('P1', '300')}; its Sensitive Topic (Privacy) restates the exposure tag and does not count). Monitoring only.`],
        '❌ P1, 300 engagements: below the escalation criteria', ['❌']]);
    did(privacy, false);
    const banned = burson([SUSPENDED]);
    assert.ok(/^✅ \*Reviewed by the agentic assistant\*\nTHIS ALERT MEETS P2 CRITERIA\n/.test(banned.top.text) &&
      banned.top.text.indexOf(`\n[Exposure Tag]: ${SUSPENSION_TAG}\n`) > 0, banned.top.text);
    eq(banned.notes, [`${HEAD}met for a Social Alert: ${COUNTS_AS_BIAS}.`]);
    did(banned, true);
    const mail = banned.mails[banned.mails.length - 1];
    eq([mail.text.indexOf(`\nExposure Tag: ${SUSPENSION_TAG}\n`) > 0, /Perceived bias/.test(mail.text), banned.row.exposure_tag], [true, false, SUSPENSION_TAG]);
    // an ongoing issue: the first post went out for its P0 tag; the next two are from other accounts' posts on it
    const w = oneSpace();
    const posts = [F.P0_OK, p0Post('2109952063492990001', 300), p0Post('2109952063492990002', 2500)];
    posts.forEach((text, i) => w.rec.step(`alert ${i + 1}`, i ? 3 : 1, () => { w.t.chat.say(REAL, text, ZAPIER); }));
    w.rec.step('quiet run', 1);
    const [first, second, third] = tops(w.t).map(top => look(w.t, top));
    eq([lineOf(first), lineOf(second), lineOf(third)], [
      [`${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`],
      [`${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). Monitoring only.`],
      [`${HEAD}met for a Social Alert: 2,500 engagements (2,000+ needed).`],
    ]);
    eq([first.row.email_status, second.row.email_status || '', third.row.email_status, second.marks, third.mails.map(m => /^Re: /.test(m.subject))],
      ['sent', '', 'sent', ['❌'], [false, true]]);
    [second, third].forEach(r => assert.ok(/🚨THIS ALERT MEETS P0 CRITERIA🚨/.test(r.top.text) && /\/ Ongoing Issue\n/.test(r.top.text), r.top.text));
  });

  test('requirement line: an alert of Burson\'s that meets no requirement and gets a T&S form (a wrong answer of the Gemini app, 300 engagements) says so where it would say "Monitoring only.": "No Social Alert; a T&S form is asked for below.", and the form\'s note follows in the thread; with Auto-submit T&S form ON (row 12) the bot handles the form itself and the line says "…; the T&S form is handled below."; while the alert still waits on Burson for its link, no form is asked for yet and the line says "…; a T&S form follows once Burson adds what is missing.", which it does when Burson resends the alert with its link; with Never wait on Burson ON the alert without a link is decided at once, form and line; in a dry run no form is asked for, and the line says "Monitoring only."', () => {
    const NOT_MET = `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}). `;
    const asked = burson([GEMINI_WRONG]);
    eq([asked.notes[0], /^T&S form needed \(Gemini hallucination\): /.test(asked.notes[1]), asked.notes.length, asked.row.decision, asked.marks],
      [NOT_MET + TNS_ASKED, true, 2, 'T&S form only (Gemini hallucination)', ['👍']]);
    did(asked, false);
    const handled = burson([GEMINI_WRONG], null, w => { w.sh.getRange(12, 2).setValue('ON'); });
    eq([handled.notes[0], /^The alert regarding Gemini hallucination has been submitted to T&S for review\.\n/.test(handled.notes[1]), handled.notes.length,
      handled.row.decision, handled.marks], [NOT_MET + TNS_HANDLED, true, 2, 'T&S form only (Gemini hallucination) · auto-submitted', ['✍']]);
    did(handled, false);
    // the alert has no link: only Burson can add it, so nothing is decided yet, and no form is asked for; the line says
    // the form follows, and it does, under the same alert, when Burson resends it with the link
    const NO_LINK = GEMINI_WRONG.replace('[Link]: https://x.com/date_checker/status/2150000000000000413\n', '');
    const later = oneSpace();
    later.rec.step('a Burson alert without its link', 1, () => { later.t.chat.say(REAL, NO_LINK, ZAPIER); });
    later.rec.step('quiet run', 1);
    const waiting = look(later.t, tops(later.t)[0]);
    eq([lineOf(waiting), waiting.notes.filter(n => /T&S form needed|T&S Intake Form/.test(n)), waiting.row.decision || '', waiting.marks],
      [[NOT_MET + TNS_LATER], [], '', []]);
    did(waiting, false);
    later.rec.step('Burson resends it with the link', 2, () => { later.t.chat.say(REAL, GEMINI_WRONG, ZAPIER); });
    later.rec.step('quiet run', 1);
    const resent = look(later.t, tops(later.t)[0]);
    eq([tops(later.t).length, lineOf(resent), resent.notes.filter(n => /^T&S form needed \(Gemini hallucination\): /.test(n)).length,
      alertRows(later.t).map(row => [row.alert_id, row.decision || '', row.resend_of || ''])],
    [1, [NOT_MET + TNS_LATER], 1, [['QA-1001', '', ''], ['QA-1002', 'T&S form only (Gemini hallucination)', 'QA-1001']]]);
    // ...and a resend with a higher engagement level that still has no link is posted as a new corrected alert, which
    // waits as the first one did and says the same (1,500 engagements now: still no requirement met)
    const still = oneSpace();
    const noLink = text => text.replace('[Link]: https://x.com/date_checker/status/2150000000000000413\n', '');
    still.rec.step('a Burson alert without its link', 1, () => { still.t.chat.say(REAL, NO_LINK, ZAPIER); });
    still.rec.step('Burson resends it, raised, still without the link', 2, () => { still.t.chat.say(REAL, noLink(geminiWrong(1500, 'MODERATE')), ZAPIER); });
    still.rec.step('quiet run', 1);
    const raisedNoLink = look(still.t, tops(still.t)[1]);
    eq([tops(still.t).length, raisedNoLink.notes[0].split('\n')[0], lineOf(raisedNoLink), still.t.chat.spaces.get(AC).messages.filter(m => /T&S form needed/.test(m.text)).length,
      alertRows(still.t).map(row => [row.alert_id, row.status, row.decision || '', row.resend_of || ''])],
    [2, 'QA: updated alert (engagement is now MODERATE, was LOW)', [`${HEAD}not met for a Social Alert (${BELOW('P1', '1,500')}). ${TNS_LATER}`], 0,
      [['QA-1001', 'superseded', '', ''], ['QA-1002', 'fix_requested', '', 'QA-1001']]]);
    // ...with Never wait on Burson ON (row 23) it is decided at once, without the link: the form is asked for, and the line says so
    const atOnce = burson([NO_LINK], null, w => { w.sh.getRange(23, 2).setValue('ON'); });
    eq([lineOf(atOnce), atOnce.notes.filter(n => /^T&S form needed/.test(n)).length, atOnce.row.decision], [[NOT_MET + TNS_ASKED], 1, 'T&S form only (Gemini hallucination)']);
    // a dry run: no email is made and no form is asked for
    const dry = oneSpace({ dry_run: true });
    dry.rec.step('a Burson alert', 1, () => { dry.t.chat.say(REAL, GEMINI_WRONG, ZAPIER); });
    dry.rec.step('quiet run', 1);
    const dryRun = look(dry.t, tops(dry.t)[0]);
    eq([dryRun.notes, dryRun.row.decision || ''], [[NOT_MET + 'Monitoring only.'], '']);
    // a repeat of an alert that went out gets no form of its own (the first alert covered T&S): the same post, alerted
    // with 2,500 engagements and sent, comes again with 300. No requirement met, the cross, and "Monitoring only."
    const repeat = burson([geminiWrong(2500, 'HIGH'), GEMINI_WRONG]);
    eq([lineOf(repeat), repeat.notes.filter(n => /T&S/.test(n)), repeat.row.decision, repeat.marks, repeat.mails.length],
      [[NOT_MET + 'Monitoring only.'], [], '❌ the same post was already alerted (QA-1001)', ['❌'], 1]);
    did(repeat, false, repeat.before);
  });

  test('requirement line: with nobody to send a test email to (Control B30 blank, Group test emails OFF) an alert that meets a requirement says its email waits: "met for a Social Alert: P0 exposure tag (…). Its email waits for a test recipient in Control B30."; no email goes, the Alert log has the Social Alert pending with the reason, and no "final" line is needed', () => {
    const r = burson([F.P0_OK], null, w => { w.t.set('B30', ''); });
    eq([r.notes, r.mails.length, r.row.email_status, r.row.email_error, r.t.g.gmail.allDrafts().length],
      [[`${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias). ${B30_WAIT}`], 0, 'pending',
        'Testing: enter an email address in Control!B30 (Testing: send to) to receive test emails', 0]);
    assert.ok(r.t.g.logs.some(l => l === 'Social Alert for QA-1001 waiting on Control!B30'), 'the run log says what it waits on');
    // an alert that meets none says nothing about B30: no email is planned for it
    const low = burson([LOW_OK], null, w => { w.t.set('B30', ''); });
    eq(low.notes, [`${HEAD}not met for a Social Alert (${BELOW('P2', '300')}). Monitoring only.`]);
  });

  test('requirement line: Burson\'s alert below the thresholds, excluded, or on an ongoing issue whose author is no KOF: the line says "not met" with that cause, no Social Alert goes out, and the Alert log has the cross', () => {
    const low = burson([LOW_OK]);
    eq([low.notes, low.row.decision, low.marks], [[`${HEAD}not met for a Social Alert (${BELOW('P2', '300')}). Monitoring only.`],
      '❌ P2, 300 engagements: below the escalation criteria', ['❌']]);
    did(low, false);
    const excluded = burson([MAPS_OK.replace('[Product]: Maps', '[Product]: Search').replace(',Maps,', ',Search,')
      .replace('posted a humorous screenshot of Street View capturing a dog chasing the Google Maps car.',
        'told a commenter to just google it instead of asking, with a screenshot of the search box.')]);
    eq([excluded.notes, excluded.row.decision, excluded.marks], [[`${HEAD}not met for a Social Alert (excluded: google as verb). Monitoring only.`],
      '❌ excluded: google as verb', ['❌']]);
    did(excluded, false);
    // the same issue as an alert that went out, from another post: an ongoing issue, and the author is no KOF
    const ongoing = burson([F.P0_OK, F.P0_OK.split('2109952063492993159').join('2109952063492990000')]);
    eq([ongoing.notes[0], /^❌ /.test(ongoing.row.decision), ongoing.marks],
      [`${CHANGES}\n- Issue status: New / not previously reported over the past 14 days to Ongoing Issue\n` +
        `${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). Monitoring only.`, true, ['❌']]);
    did(ongoing, false, ongoing.before);
    eq(ongoing.mails.length, 1);  // the first alert's
  });

  test('requirement line: Burson\'s alert that meets the thresholds and gets no Social Alert: vetoed by the review (its reason, in one line), or a repeat of an alert that went out (by that alert\'s id); the line says so, nothing is sent, and the Alert log has the same reason', () => {
    const vetoed = burson([MAPS_OK], t => {
      t.g.vertex.assess = () => ({ checks: [], social_alert: { warranted: false, confidence: 0.95, reason: 'A meme with no claim about the product' } });
    });
    eq([vetoed.notes, vetoed.row.decision, vetoed.marks],
      [[`${HEAD}met for a Social Alert (4,200 engagements), but none was sent: the review says "A meme with no claim about the product".`],
        '❌ AI review: A meme with no claim about the product', ['❌']]);
    did(vetoed, false);
    const repeat = burson([MAPS_OK, MAPS_OK]);
    eq([repeat.notes, repeat.row.decision, repeat.marks],
      [[`${CHANGES}\n- Issue status: New / not previously reported over the past 14 days to Ongoing Issue\n` +
        `${HEAD}met for a Social Alert (4,200 engagements), but none was sent: a repeat of QA-1001.`],
      '❌ the same post was already alerted (QA-1001)', ['❌']]);
    did(repeat, false, repeat.before);
    eq([repeat.mails.length, alertRows(repeat.t).map(row => [row.alert_id, row.email_status || ''])], [1, [['QA-1001', 'sent'], ['QA-1002', '']]]);
  });

  test('requirement line: a Social Alert below the thresholds, sent on the review\'s call (KB & Guidance can start alerts, row 13: Gemini cites a Guidance row that checks out): the line says it is below the thresholds and goes out anyway, and it does', () => {
    const ROW = 'Escalate every Street View post that shows a dog or another animal chasing the Google Maps car, whatever the engagement';
    const QUOTE = 'Escalate every Street View post that shows a dog or another animal chasing the Google Maps car';
    const cite = t => {
      t.g.vertex.assess = () => ({ checks: [], social_alert: { warranted: true, confidence: 0.95, reason: 'Street View posts like this get a Social Alert',
        signal_class: 'legitimate_nerve', per: { source: 'guidance', guidance_n: 1, document: null, quote: QUOTE } } });
    };
    const guidance = w => {
      w.sh.getRange(13, 2).setValue('ON');
      w.t.sheet().getSheetByName('Guidance').getRange(2, 1, 1, 4).setValues([[ROW, 'Maps', '', 'owner']]);
    };
    const r = burson([LOW_OK], cite, guidance);
    eq(r.notes[0], `${HEAD}below the Social Alert thresholds (${BELOW('P2', '300')}). ${ANYWAY}`);
    did(r, true);
    assert.ok(r.t.g.logs.some(l => /^Social Alert started on what Gemini cited \(the rules alone wouldn't\)/.test(l)), 'row 13 started it');
    // with row 13 OFF the same alert and the same citation: not met, and nothing is sent
    const off = burson([LOW_OK], cite);
    eq(off.notes, [`${HEAD}not met for a Social Alert (${BELOW('P2', '300')}). Monitoring only.`]);
    did(off, false);
  });

  test('requirement line: an alert that takes an existing issue\'s name when its Social Alert is planned (another post on an issue already alerted, now past 10,000 engagements): the line, written before, still equals what the bot does: the Social Alert goes out, as an update on the earlier email, under the existing issue\'s name', () => {
    const second = MAPS_OK.split('1abcde/street_view_dog').join('1zzzzz/street_view_dog_again').split('4200').join('12500')
      .split('Google Maps Street View Dog Meme').join('Google Maps Street View Dog Meme Goes Viral')
      .split('u/map_enthusiast').join('u/other_mapper');
    const r = burson([MAPS_OK, second]);
    eq(r.notes, [`${CHANGES}\n- Issue status: New / not previously reported over the past 14 days to Ongoing Issue\n` +
      '- Issue name: Google Maps Street View Dog Meme Goes Viral to Google Maps Street View Dog Meme\n' +
      `${HEAD}met for a Social Alert: 12,500 engagements (2,000+ needed).`]);
    did(r, true, r.before);
    eq(r.mails.map(m => m.subject), [
      '[Auto-correct test] 🟥SOCIAL ALERT🟥: Maps | Google Maps Street View Dog Meme | Reddit | 4200 Engagements',
      'Re: [Auto-correct test] 🟥SOCIAL ALERT🟥: Maps | Google Maps Street View Dog Meme | Reddit | 4200 Engagements']);
  });

  // =============================================================================================================
  // Direct BigQuery cards and sheet-test cards, reviewed in place
  // =============================================================================================================

  test('requirement line: a Direct BigQuery card, posted before its review, gets the line as the last line of the in-place note: not met (800 engagements, a P2 tag: the cross, no email) and met (a P0 exposure tag and 2,400 engagements: the Social Alert to the tester); the card itself has no such line, and a card whose review has nothing else to say gets the line alone', () => {
    const w = oneSpace();
    w.rec.step('Direct BigQuery finds the Pixel post', 4, () => { w.feed.bsip = [golden.rows.bsipRow()]; });
    w.rec.step('the Pixel card is reviewed', 1);
    const pixel = look(w.t, tops(w.t)[0]);
    eq([pixel.notes, pixel.row.ingested, pixel.row.decision, pixel.marks], [[`${IN_PLACE}\n- Summary: X user @pixelcritic (3,200 followers) says their Pixel ` +
      '10 battery swelled up after the latest update and that the back cover is lifting. The post does not say which update.\n' +
      `${HEAD}not met for a Social Alert (${BELOW('P2', '800')}). Monitoring only.`], 'BSIP', '❌ P2, 800 engagements: below the escalation criteria', ['❌']]);
    did(pixel, false);
    w.rec.step('Direct BigQuery finds the Maps post', 6, () => { w.feed.bsip = [golden.rows.bsipRow(), golden.rows.mapsRow()]; });
    w.rec.step('the Maps card is reviewed', 1);
    const maps = look(w.t, tops(w.t)[1]);
    eq(maps.notes, [`${IN_PLACE}\n- Summary: X user @roadwatcher (41,000 followers) says Google Maps keeps sending drivers onto a closed bridge ` +
      'and calls the routing biased toward toll roads. The post does not name the bridge.\n' +
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias) · 2,400 engagements (2,000+ needed).`]);
    did(maps, true);
    tops(w.t).forEach(card => assert.ok(/^THIS ALERT MEETS P\d CRITERIA/.test(card.text) && !/Alert requirements/.test(card.text), card.text));
    // a review with nothing else to say (no write-up, no correction): the note is that one line
    const quiet = oneSpace();
    quiet.t.g.vertex.assess = () => ({ checks: [] });
    quiet.rec.step('Direct BigQuery finds the Pixel post', 4, () => { quiet.feed.bsip = [golden.rows.bsipRow()]; });
    quiet.rec.step('the Pixel card is reviewed', 1);
    const alone = look(quiet.t, tops(quiet.t)[0]);
    eq(alone.notes, [`${HEAD}not met for a Social Alert (${BELOW('P2', '800')}). Monitoring only.`]);
    did(alone, false);
  });

  /** A sheet-test card as the Test alert tab posts it (SheetTestAlert.gs), with `tag` and `engagements`. */
  const sheetTest = (tag, engagements) => [
    `🟧SOCIAL ALERT🟧: Gemini App | Test Multi-Product Social Alert | X | ${engagements} Engagements`,
    '[Name]: Test Multi-Product Social Alert / New / not previously reported over the past 14 days',
    `[Engagement]: ${engagements >= 2000 ? 'HIGH' : 'LOW'} (${engagements} engagements)`,
    '[Product]: Gemini App',
    '[Social Network]: X',
    `[Exposure Tag]: ${tag}`,
    '[Sensitive Topic]: None',
    '[KOF]: No',
    '',
    'Synthetic test alert posted into the test Chat space to verify Chat pickup and Social Alert email routing.',
    '',
    '[Link]: https://x.com/test_routing_account/status/9917000000000001',
    '',
    '[Time/Date Post Went Live]: 2026-10-14 08:00 ET',
    '',
    `[Code]: ${tag},${engagements},test_routing_account,None,Gemini App,New / not previously reported over the past 14 days`,
  ].join('\n');

  test('requirement line: a sheet-test card, reviewed in place: with values that meet the thresholds the line names them; with values below them it says so, and that a test alert from the Test alert tab always sends one; either way the Social Alert goes to the tester', () => {
    const run = (tag, engagements) => {
      const w = oneSpace();
      w.rec.step('the test card', 1, () => {
        const msg = w.t.bot.mirrorPostMessage_(AC, sheetTest(tag, engagements), 'sheettest:1');
        w.t.bot.rememberSheetTestMessage_(msg.name, golden.world.names.AC, ['Gemini App']);
      });
      w.rec.step('quiet run', 1);
      return look(w.t, tops(w.t)[0]);
    };
    const met = run('Product - Scams involving Google products', 2500);
    eq([met.notes[0], met.row.ingested, /^🧪 \*Test Alert Delivery/.test(met.notes[1])],
      [`${HEAD}met for a Social Alert: 2,500 engagements (2,000+ needed).`, 'Sheet test alert', true]);
    did(met, true);
    const below = run(P2_TAG, 300);
    eq(below.notes[0], `${HEAD}below the Social Alert thresholds (${BELOW('P2', '300')}). A Social Alert goes out anyway: a test alert from the ` +
      'Test alert tab always sends one.');
    did(below, true);
  });

  // =============================================================================================================
  // A Watch alert's triage note
  // =============================================================================================================

  /** A watch flag (`hit`) through the one-space setup, its triage scripted by `tri(base answer)`: what the bot did (look). */
  const watch = (hit, tri) => {
    const w = oneSpace();
    const base = w.t.g.vertex.triage;
    if (tri) w.t.g.vertex.triage = payload => tri(base(payload));
    w.rec.step('the watch flags a post', 1, () => { w.feed.look = [golden.rows.hit(hit || {})]; });
    w.rec.step('the Watch alert is triaged', 1, () => { w.feed.look = []; });
    w.rec.step('quiet run', 1);
    const r = look(w.t, tops(w.t)[0]);
    assert.ok(/^🔭 \*WATCH\* · /.test(r.top.text) && !/Alert requirements/.test(r.top.text), 'no line on the card');
    // the line stands in the "SLRR" line's place: no bullet names the team's rules (the triage's own reason, in the
    // note's first line, is the Alert log's too and stays as the triage worded it)
    assert.ok(/^🤖 \*Triage: /.test(r.notes[0]) && !/\n• [^\n]*SLRR/.test(r.notes[0]), r.notes[0]);
    return r;
  };
  const patch = (key, value) => tri => Object.assign(tri, { [key]: Object.assign({}, tri[key], value) });

  test('requirement line: a Watch alert\'s triage note carries the line where it had its "SLRR" line. Below the thresholds: not met, a thumbs-up for a person, no email, and the T&S form the note asks for is named where the line would say "Monitoring only."; the triage escalating it (80% sure): below the thresholds, a Social Alert on the review\'s call, sent; a Sensitive Topic the triage is sure of, or 5,000 engagements: met, sent; 5,000 engagements with the review against it: met, but none sent; no brand-safety issue in the triage\'s view: not met, with that reason', () => {
    const below = watch();
    eq(lineOf(below), [`${HEAD}not met for a Social Alert (${BELOW('P1', '520')}). ${TNS_ASKED}`]);
    did(below, false);
    eq([below.row.ingested, below.marks, below.row.decision], ['Watch alert', ['👍'], '👍 + T&S (Gemini hallucination)']);
    // (the form is the next bullet of the same note)
    const bullets = below.notes[0].split('\n').filter(l => /^• /.test(l));
    eq([bullets.length, bullets[0].indexOf(`• ${HEAD}`), /^• \*T&S:\* Gemini hallucination — <https:\/\/docs\.google\.com\/forms\//.test(bullets[1])], [3, 0, true]);
    const called = watch(null, patch('stream_call', { action: 'escalate', confidence: 0.8 }));
    eq(lineOf(called), [`${HEAD}below the Social Alert thresholds (${BELOW('P1', '520')}). ${ANYWAY}`]);
    did(called, true);
    const topic = watch(null, patch('slrr', { sensitive_topics: ['Child Safety'], warranted: true }));
    eq(lineOf(topic), [`${HEAD}met for a Social Alert: Sensitive Topic (Child Safety).`]);
    did(topic, true);
    const high = watch({ eng: 5000 });
    eq(lineOf(high), [`${HEAD}met for a Social Alert: 5,000 engagements (2,000+ needed).`]);
    did(high, true);
    const vetoed = watch({ eng: 5000 }, patch('slrr', { warranted: false, warranted_confidence: 0.95, why: 'Routine grumbling' }));
    eq(lineOf(vetoed), [`${HEAD}met for a Social Alert (5,000 engagements), but none was sent: the review says "Routine grumbling".`]);
    did(vetoed, false);
    const other = watch(null, tri => Object.assign(tri, { slrr: { is_slrr: false, confidence: 0.9, why: 'About a court ruling, Google only in passing' } }));
    eq(lineOf(other), [`${HEAD}not met for a Social Alert (the review sees no Google brand-safety issue in it: About a court ruling, Google only ` +
      'in passing). Monitoring only.']);
    did(other, false);
  });

  test('requirement line: a Watch alert the triage leaves to a person to check is never said to be only monitored. A view of the exposure tag Gemini is 60% sure of, on which the rules would escalate (a P0 tag, 520 engagements): "met for a Social Alert (P0 exposure tag), but none was sent: its exposure tag isn\'t confirmed, so a person checks it", as the note\'s first line says, a thumbs-up, no email; the same with 5,000 engagements. A Sensitive Topic the triage names and the rules don\'t count is named (Politics outside the US; Privacy on a privacy tag); a triage with no action that still files a T&S form says the form is asked for; and with Control B30 blank an escalated Watch alert says its email waits', () => {
    const unsure = watch(null, patch('slrr', { confidence: 0.6, exposure_tag: P0_TAG }));
    eq(lineOf(unsure), [`${HEAD}met for a Social Alert (P0 exposure tag), but none was sent: its exposure tag isn't confirmed, so a person checks it.`]);
    did(unsure, false);
    // the note's first line says the same of it (the triage's own reason, which the Alert log keeps in its own words),
    // in the line's words: the note never names the team's rules one line above the line that never does
    assert.ok(/ — it may be a Social Alert case \(Product - Perceived bias, 60% sure\) that the alert rules would escalate \(P0 criteria \(Product - Perceived bias\)\)\. /
      .test(unsure.notes[0].split('\n')[1]), unsure.notes[0]);
    assert.ok(!/SLRR/i.test(unsure.notes[0]), unsure.notes[0]);
    eq(/^it may be an SLRR alert \(Product - Perceived bias, 60% sure\)/.test(unsure.row.forwarded_fields.triage.why), true);
    eq([unsure.marks, /Monitoring only/.test(unsure.notes[0])], [['👍'], false]);
    const unsureHigh = watch({ eng: 5000 }, patch('slrr', { confidence: 0.6 }));
    eq(lineOf(unsureHigh), [`${HEAD}met for a Social Alert (5,000 engagements), but none was sent: its exposure tag isn't confirmed, so a person checks it.`]);
    did(unsureHigh, false);
    // Sensitive Topics on the triage's view that the rules leave out
    const abroad = watch(null, patch('slrr', { sensitive_topics: ['Politics'], location: 'France' }));
    eq(lineOf(abroad), [`${HEAD}not met for a Social Alert (${BELOW('P1', '520')}; its Sensitive Topic (Politics) does not count outside the US). ${TNS_ASKED}`]);
    did(abroad, false);
    const home = watch(null, patch('slrr', { sensitive_topics: ['Politics'], location: 'US' }));
    eq(lineOf(home), [`${HEAD}met for a Social Alert: Sensitive Topic (Politics).`]);
    did(home, true);
    const restated = watch(null, patch('slrr', { exposure_tag: PRIVACY_TAG, sensitive_topics: ['Privacy'] }));
    eq(lineOf(restated), [`${HEAD}not met for a Social Alert (${BELOW('P1', '520')}; its Sensitive Topic (Privacy) restates the exposure tag and does not count). Monitoring only.`]);
    did(restated, false);
    // no action, and a T&S form all the same: the head says "T&S intake only", and so does the line
    const noAction = watch(null, patch('stream_call', { action: 'no_action', confidence: 0.9, reason: 'A joke, no claim' }));
    eq([lineOf(noAction), noAction.notes[0].split('\n')[0], noAction.row.decision],
      [[`${HEAD}not met for a Social Alert (${BELOW('P1', '520')}). ${TNS_ASKED}`], '🤖 *Triage: ✍️ T&S intake only* · medium', 'T&S form only (Gemini hallucination)']);
    // Auto-submit T&S form ON (row 12): the bot files the form, and the line says it is handled below
    const filed = (() => {
      const w = oneSpace(null, x => { x.sh.getRange(12, 2).setValue('ON'); });
      w.rec.step('the watch flags a post', 1, () => { w.feed.look = [golden.rows.hit({})]; });
      w.rec.step('the Watch alert is triaged', 1, () => { w.feed.look = []; });
      w.rec.step('quiet run', 1);
      return look(w.t, tops(w.t)[0]);
    })();
    eq([lineOf(filed), /\n• \*T&S:\* Submitted Marketing intake \(Gemini \/ Information Quality\)/.test(filed.notes[0]), filed.row.decision],
      [[`${HEAD}not met for a Social Alert (${BELOW('P1', '520')}). ${TNS_HANDLED}`], true, '👍 + T&S (Gemini hallucination) · auto-submitted']);
    // Control B30 blank: the escalated alert's Social Alert is planned and waits
    const held = (() => {
      const w = oneSpace(null, x => { x.t.set('B30', ''); });
      w.rec.step('the watch flags a post', 1, () => { w.feed.look = [golden.rows.hit({ eng: 5000 })]; });
      w.rec.step('the Watch alert is triaged', 1, () => { w.feed.look = []; });
      w.rec.step('quiet run', 1);
      return look(w.t, tops(w.t)[0]);
    })();
    eq([lineOf(held), held.row.email_status, held.mails.length], [[`${HEAD}met for a Social Alert: 5,000 engagements (2,000+ needed). ${B30_WAIT}`], 'pending', 0]);
  });

  /** A flow's ctx as the note builders read it: the Auto-correct flow, with the setting as given. */
  const acCtx = settings => ({ sourceReadOnly: true, settings: Object.assign({ requirement_line: true }, settings || {}), now: () => NOW, log: () => {} });

  test('requirement line: the Watch triage\'s other endings, on the decision as the triage hands it over: a repeat (by the earlier alert\'s id), a count nobody knows or a tag Gemini isn\'t sure of (a person checks), a post the triage leaves to a person for its size, a build-up of small posts ("posted early"), and a Social Alert that can\'t be made in a dry run; the triage\'s own text is never copied where it names the team\'s rules', () => {
    const fields = { product: 'Gemini App', social_network: 'X', exposure_tag: P1_TAG, risk_tags: ['Child Safety'], total_engagement: 40,
      issue_name: 'Gemini answer invents a court ruling', summary: 'An X user says Gemini invented a court ruling.' };
    const esc = B.escalation_(fields, { now: NOW });
    const tri = { reason: 'A made-up legal citation', slrr: { is: true, confidence: 0.9, tag: P1_TAG, why: '' } };
    const d = patchD => Object.assign({ tri, fields, slrr: { sure: true, esc, veto: '', collected: true }, action: 'flag', basis: 'stream',
      why: 'A made-up legal citation', esc: null, draft: null }, patchD);
    const said = (patchD, other) => B.otherRequirementLine_(acCtx(), d(patchD), other || { unknown: [] });
    const MET = `${HEAD}met for a Social Alert (Sensitive Topic), but none was sent: `;
    eq(esc.escalated, true);
    eq([said({ action: 'no_action', basis: 'repeat', why: 'the same post was already alerted (QA-1004)' }),
      said({ action: 'no_action', basis: 'repeat', why: 'already alerted as a known issue ("Gemini court ruling"): nothing materially new' }),
      said({ basis: 'slrr_check', slrr: { sure: true, esc, veto: '', collected: null },
        why: 'the SLRR rules would escalate it (Sensitive topic (Child Safety)) if it has 100+ engagements: check its count' }),
      said({ slrr: { sure: true, esc, veto: '', collected: false } }),
      said({ slrr: { sure: true, esc, veto: 'AI review: Routine grumbling', collected: true } }),
      // the triage would escalate it but is only 70% sure: the bot's own words, never quoted as Gemini's
      said({ tri: Object.assign({}, tri, { action: 'escalate', confidence: 0.7 }), slrr: null, fields: Object.assign({}, fields, { exposure_tag: '' }),
        why: 'A made-up legal citation (70% sure, so a person decides)' }),
      // the triage's own reason for a flag is Gemini's, and quoted as the review's; the bot's own stand-in for none isn't
      said({ tri: Object.assign({}, tri, { action: 'flag', confidence: 0.9 }), slrr: null, fields: Object.assign({}, fields, { exposure_tag: '' }) }),
      said({ tri: Object.assign({}, tri, { action: 'flag', reason: '' }), slrr: null, fields: Object.assign({}, fields, { exposure_tag: '' }), why: 'worth a look' }),
      said({ action: 'escalate', basis: 'watch', esc, draft: null })], [
      `${MET}a repeat of QA-1004.`,
      `${MET}a repeat of an earlier alert.`,
      `${MET}its engagement count isn't known, so a person checks it.`,
      `${MET}the triage leaves a post this small to a person.`,
      `${MET}the review says "Routine grumbling".`,
      `${MET}the review is only 70% sure, so a person decides.`,
      `${MET}the review says "A made-up legal citation".`,
      `${MET}worth a look.`,
      `${MET}emails are off in this run (a dry run).`,
    ]);
    // a Social Alert that a Guidance row started on a view the triage is sure of (row 13) is below the thresholds and
    // goes out on the review's call: the rules' own result is asked again, never the started one
    const lowFields = Object.assign({}, fields, { risk_tags: [], total_engagement: 300 });
    const lowEsc = B.escalation_(lowFields, { now: NOW });
    const started = Object.assign({}, lowEsc, { escalated: true, track: 'URGENT', action: 'EMAIL_ALERT', suppression: null,
      reasons: lowEsc.reasons.concat(['KB_OR_GUIDANCE']), kb_basis: 'Guidance row 2' });
    eq([lowEsc.escalated, B.otherRequirementLine_(acCtx(), d({ fields: lowFields, slrr: { sure: true, esc: started, veto: '', collected: true },
      action: 'escalate', basis: 'watch', esc: started, draft: { email_status: 'pending' } }), { unknown: [] })],
    [false, `${HEAD}below the Social Alert thresholds (${BELOW('P1', '300')}). ${ANYWAY}`]);
    // A view Gemini isn't sure of never decides, and the triage leaves the alert to a person to check when the rules
    // would escalate it on that view (basis slrr_check). The line then reads the rules as the triage did, on the view
    // it flagged the alert on (d.slrr.esc: a P0 tag here), though the alert's own facts (d.fields: no tag, 520
    // engagements) meet nothing: it never says such an alert is only monitored
    const bare = Object.assign({}, fields, { exposure_tag: '', risk_tags: [], total_engagement: 520 });
    const asIf = B.escalation_(Object.assign({}, bare, { exposure_tag: P0_TAG }), { now: NOW });
    const unsure = patchD => Object.assign({ tri: { reason: 'It may need escalating', slrr: { is: true, confidence: 0.6, tag: P0_TAG, why: '' } }, fields: bare,
      slrr: { sure: false, esc: asIf, veto: '', collected: true }, action: 'flag', basis: 'slrr_check', esc: null, draft: null,
      why: 'it may be an SLRR alert (Product - Perceived bias, 60% sure) that the SLRR rules would escalate (P0 criteria (Product - Perceived bias))' }, patchD);
    eq([asIf.escalated, B.escalation_(bare, { now: NOW }).escalated], [true, false]);
    eq(B.otherRequirementLine_(acCtx(), unsure({}), { unknown: [] }),
      `${HEAD}met for a Social Alert (P0 exposure tag), but none was sent: its exposure tag isn't confirmed, so a person checks it.`);
    // ...where the view is a tag the rules count as another, that is said of the view's tag
    const banFields = Object.assign({}, bare, { exposure_tag: SUSPENSION_TAG, summary: 'An X user says Google suspended their account to censor them.' });
    eq(B.otherRequirementLine_(acCtx(), unsure({ tri: { reason: 'It may need escalating', slrr: { is: true, confidence: 0.6, tag: SUSPENSION_TAG, why: '' } },
      slrr: { sure: false, esc: B.escalation_(banFields, { now: NOW }), veto: '', collected: true } }), { unknown: [] }),
    `${HEAD}met for a Social Alert (${COUNTS_AS_BIAS}), but none was sent: its exposure tag isn't confirmed, so a person checks it.`);
    // Should the rules alone not escalate the view after all (a Guidance row started it: KB & Guidance can start alerts),
    // the line says "not met", and that a person checks it: never "Monitoring only." for an alert left to a person to check
    const startedOn = (base, extra) => Object.assign({}, base, { escalated: true, track: 'URGENT', action: 'EMAIL_ALERT', suppression: null,
      reasons: base.reasons.concat(['KB_OR_GUIDANCE']), kb_basis: 'Guidance row 2' }, extra);
    const bareRules = B.escalation_(bare, { now: NOW });
    const tagged = Object.assign({}, bare, { exposure_tag: P1_TAG, total_engagement: null });
    eq([B.otherRequirementLine_(acCtx(), unsure({ slrr: { sure: false, esc: startedOn(bareRules), veto: '', collected: true } }), { unknown: [] }),
      B.otherRequirementLine_(acCtx(), d({ fields: tagged, basis: 'slrr_check', slrr: { sure: true, esc: startedOn(B.escalation_(tagged, { now: NOW })), veto: '', collected: null },
        why: 'the SLRR rules would escalate it (Guidance row 2) if it has 100+ engagements: check its count' }), { unknown: [] })], [
      `${HEAD}not met for a Social Alert (a post with no confirmed exposure tag needs 2,000+ engagements, a KOF author or a Sensitive Topic; this post: ` +
        '520 engagements, no KOF author). A person checks it: its exposure tag isn\'t confirmed.',
      `${HEAD}not met for a Social Alert (a P1 tag needs 2,000+ engagements, a KOF author or a Sensitive Topic; this post: no engagement count, ` +
        'no KOF author). A person checks it: its engagement count isn\'t known.',
    ]);
    // An alert that gets a T&S form (otherNoEmail_ took it before the note: d.tnsActive) says so where the line would say
    // "Monitoring only."; with Auto-submit T&S form ON the bot handles the form itself
    const plainFields = Object.assign({}, fields, { risk_tags: [], total_engagement: 300 });
    const flagged = patchD => Object.assign({ tri, fields: plainFields, slrr: null, action: 'flag', basis: 'stream', why: 'A made-up legal citation', esc: null,
      draft: null, tnsActive: true }, patchD);
    eq([B.otherRequirementLine_(acCtx(), flagged({}), { unknown: [] }),
      B.otherRequirementLine_(Object.assign(acCtx(), { switches: { autoTns: true } }), flagged({}), { unknown: [] }),
      B.otherRequirementLine_(acCtx(), flagged({ tnsActive: false }), { unknown: [] }),
      B.otherRequirementLine_(acCtx(), flagged({ action: 'no_action', why: 'A joke, no claim' }), { unknown: [] })], [
      `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}). ${TNS_ASKED}`,
      `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}). ${TNS_HANDLED}`,
      `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}). Monitoring only.`,
      `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}). ${TNS_ASKED}`,
    ]);
    // a repeat the alert memory holds as the other flow's (the same Burson alert, beside a Mirror space) says who sent it;
    // and an escalated alert whose email has nobody to go to (Control B30 blank) says what it waits for
    const live = { skip: 'Social Alert sent by the other flow (QA-1004)', kind: 'live', ref: 'QA-1004' };
    eq([said({ action: 'no_action', basis: 'repeat', why: live.skip, review: { memory: { verdict: live } } }),
      said({ action: 'no_action', basis: 'repeat', why: 'the same post was already alerted (QA-1002)', review: { memory: { verdict: live } } }),
      B.otherRequirementLine_(Object.assign(acCtx(), { b30Blank: true }), d({ action: 'escalate', basis: 'watch', esc, draft: { email_status: 'pending' } }), { unknown: [] }),
      B.otherRequirementLine_(Object.assign(acCtx(), { b30Blank: true }), d({ action: 'no_action', basis: 'repeat', why: 'the same post was already alerted (QA-1004)' }), { unknown: [] })], [
      `${MET}the other flow already sent it (QA-1004).`,
      `${MET}a repeat of QA-1002.`,
      `${HEAD}met for a Social Alert: Sensitive Topic (Child Safety). ${B30_WAIT}`,
      `${MET}a repeat of QA-1004.`,
    ]);
    // a card that is a build-up of small posts: posted early, by how many accounts tell the story
    const small = { tri, fields: Object.assign({}, fields, { risk_tags: [], total_engagement: 57 }), slrr: null, action: 'flag', basis: 'stream',
      why: 'A made-up legal citation', esc: null, draft: null };
    eq(B.otherRequirementLine_(acCtx(), small, { unknown: [{ label: 'build_up', value: '4 small posts from 3 accounts within 3 hours (X, Reddit) · 57 engagements in all' }] }),
      `${HEAD}not met yet (${EARLY}). Posted early because 3 accounts tell the same story.`);
    // no triage (it failed), the setting off, or another flow: no line
    eq([B.otherRequirementLine_(acCtx(), Object.assign(d({}), { tri: null }), null), B.otherRequirementLine_(acCtx({ requirement_line: false }), d({}), null),
      B.otherRequirementLine_(Object.assign(acCtx(), { sourceReadOnly: false }), d({}), null),
      B.otherRequirementLine_(Object.assign(acCtx(), { outboundBlocked: true }), d({}), null)], ['', '', '', '']);
  });

  test('requirement line: where the line stands in a Watch triage note or an Early Detection review note, the note\'s head and first line never name the team\'s rules either ("Social Alert (the SLRR rules)" -> "(the alert rules)", "it may be an SLRR alert" -> "a Social Alert case", "SLRR alert log" -> "the team\'s alert log", any other "SLRR", in capitals or not); the bullets under them, with the T&S form\'s link, are left as they are; without the line (every other flow, the setting off) the note is word for word what it was', () => {
    const fields = { product: 'Gemini App', social_network: 'X', exposure_tag: P1_TAG, risk_tags: ['Child Safety'], total_engagement: 400,
      author: 'court_watch', post_url: 'https://x.com/court_watch/status/2150000000000000501',
      issue_name: 'Gemini answer invents a court ruling', summary: 'An X user says Gemini invented a court ruling.' };
    const esc = B.escalation_(fields, { now: NOW });
    const FORM = '<https://docs.google.com/forms/d/e/SLRR-form/viewform?entry.1=SLRR|Open the T&S form>';
    const tri = { summary: 'Gemini invented a court ruling', reason: 'A made-up legal citation', severity: 'high', confidence: 0.9,
      teamReasons: {}, tns: '', watch: '', slrr: { is: true, confidence: 0.9, tag: P1_TAG, priority: 'P1', product: 'Gemini App', others: [], topics: ['Child Safety'] } };
    const d = { tri, fields, eng: { n: 400 }, slrr: { sure: true, esc, veto: '', collected: true }, action: 'escalate', basis: 'slrr',
      why: 'the SLRR rules: Sensitive topic (Child Safety); see the slrr alert log', tnsLine: `Child safety — ${FORM}`, esc, draft: { email_status: 'pending' } };
    const before = B.otherNoteText_(d).split('\n');
    const req = `${HEAD}met for a Social Alert: Sensitive Topic (Child Safety).`;
    const after = B.otherNoteText_(d, req).split('\n');
    assert.ok(/\(the SLRR rules\)/.test(before[0]) && /the SLRR rules: /.test(before[1]) && /^• \*SLRR:\*/.test(before[2]), before.join('\n'));
    eq(after, [before[0].replace('the SLRR rules', 'the alert rules'),
      before[1].replace('the SLRR rules', 'the alert rules').replace('the slrr alert log', 'the team\'s alert log'),
      `• ${req}`].concat(before.slice(3)));
    eq([after.slice(0, 3).some(l => /SLRR/i.test(l)), after.indexOf(`• *T&S:* Child safety — ${FORM}`) > 2], [false, true]);
    // the words, one by one
    eq(['it may be an SLRR alert (Product - Perceived bias, 60% sure) that the SLRR rules would escalate',
      'the same post was already alerted (QA-1001, SLRR alert log)', 'below SLRR\'s collection threshold', 'Slrr and slrr'].map(B.requirementNoteWords_), [
      'it may be a Social Alert case (Product - Perceived bias, 60% sure) that the alert rules would escalate',
      'the same post was already alerted (QA-1001, team\'s alert log)', 'below alert requirements collection threshold', 'alert requirements and alert requirements']);
    // An Early Detection review note: its head and its "Why" line
    const rev = { confidence: 0.86, severity: 'medium', reason: 'Six accounts tell the same story', teamReasons: {}, tns: '', watchFor: '',
      slrr: { is: true, tag: P2_TAG, priority: 'P2', product: 'Chrome', others: [], topics: [] } };
    const ed = { rev, fields: { product: 'Chrome', exposure_tag: P2_TAG }, disposition: 'dismiss', basis: 'repeat', esc: null, draft: null,
      why: 'the same post was already alerted (QA-1001, SLRR alert log)', tnsLine: `not needed — ${FORM}`, ed: { signalType: 'CLUSTER_EMERGENCE', distinctAuthors: 6 } };
    const edBefore = B.edNoteText_(ed).split('\n');
    const edAfter = B.edNoteText_(ed, req).split('\n');
    eq([edBefore[1], edAfter[1]], ['*Why:* the same post was already alerted (QA-1001, SLRR alert log).',
      '*Why:* the same post was already alerted (QA-1001, team\'s alert log).']);
    eq([edAfter[0], edAfter[2], edAfter.slice(3)], [edBefore[0], `• ${req}`, edBefore.slice(3)]);
  });

  // =============================================================================================================
  // An Early Detection card's review note
  // =============================================================================================================

  /** A story through the one-space setup, its review scripted by `rev(base answer)`: what the bot did with its card (look). */
  const story = (rev, row) => {
    const w = oneSpace();
    const base = w.t.g.vertex.earlyDetection;
    if (rev) w.t.g.vertex.earlyDetection = payload => rev(base(payload));
    w.rec.step('a story is found and reviewed', 13, () => { w.feed.stories = [golden.rows.story(row || {})]; });
    w.rec.step('quiet run', 1);
    const r = look(w.t, tops(w.t)[0]);
    assert.ok(/^🚨 \*EARLY DETECTION\* · New story\n/.test(r.top.text) && !/Alert requirements/.test(r.top.text), 'no line on the card');
    assert.ok(/^🤖 \*Early Detection Review: /.test(r.notes[0]) && !/SLRR/.test(r.notes[0]), r.notes[0]);
    return r;
  };
  const escalate = { early_detection_call: { disposition: 'escalate', confidence: 0.85 } };
  const merged = over => r => {
    Object.keys(over).forEach(k => { r[k] = Object.assign({}, r[k], over[k]); });
    return r;
  };

  test('requirement line: an Early Detection card\'s review note carries the line where it had its "SLRR" line. A story to monitor: "not met yet … Posted early because 6 accounts tell the same story", a thumbs-up, no email; the review escalating it (85% sure): below the thresholds, a Social Alert on the review\'s call, sent; a P0 exposure tag the review confirms: met, sent; the producer\'s own "P0" hint with no tag confirmed is never called a P0 tag; a Sensitive Topic on a story the review only monitors: met, but none sent', () => {
    const monitor = story();
    eq(lineOf(monitor), [`${HEAD}not met yet (${EARLY}). Posted early because 6 accounts tell the same story.`]);
    did(monitor, false);
    eq([monitor.row.ingested, monitor.marks, monitor.row.decision],
      ['Early detection', ['👍'], '👍 Monitor build-up: Several independent users describe the same data loss after one update']);
    const called = story(merged(escalate));
    eq(lineOf(called), [`${HEAD}below the Social Alert thresholds (${EARLY}). ${ANYWAY}`]);
    did(called, true);
    const p0 = story(merged({ slrr: { exposure_tag: P0_TAG, confidence: 0.9 } }));
    eq(lineOf(p0), [`${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`]);
    did(p0, true);
    const hint = story(merged(Object.assign({ slrr: { exposure_tag: 'Product - Privacy & security concerns', confidence: 0.6 } }, escalate)), { priority_hint: 'P0' });
    eq(lineOf(hint), [`${HEAD}below the Social Alert thresholds (${EARLY}). ${ANYWAY}`]);
    did(hint, true);
    const topic = story(merged({ slrr: { sensitive_topics: ['Child Safety'] } }));
    eq(lineOf(topic), [`${HEAD}met for a Social Alert (Sensitive Topic), but none was sent: the review calls it a build-up to monitor.`]);
    did(topic, false);
  });

  test('requirement line: the Early Detection review\'s other endings, on the decision as the review hands it over: a pace jump says its pace, a review not sure enough leaves it to a person, a story that is a repeat, dismissed, evergreen noise or not in English says so, a review that failed gets no line, and neither does any other flow or the setting off; in the note the line takes the "SLRR" line\'s place, and is one bullet more where the note has none (no other bullet goes for it)', () => {
    const fields = { product: 'Chrome', social_network: 'X', exposure_tag: P2_TAG, priority: 'P2', total_engagement: 44,
      issue_name: 'Chrome update closes all open tabs', summary: 'Six small accounts say a Chrome update closed their tabs.' };
    const d = over => Object.assign({ rev: { confidence: 0.86 }, fields, disposition: 'monitor', basis: 'early_detection', esc: null, draft: null,
      ed: { signalType: 'CLUSTER_EMERGENCE', distinctAuthors: 6 } }, over);
    const said = (over, ctx) => B.edRequirementLine_(ctx || acCtx(), d(over));
    eq([said({}), said({ ed: { signalType: 'VELOCITY_SPIKE', velocityRatio: 3.2, distinctAuthors: 36 } }),
      said({ ed: { signalType: 'EARLY_WATCH', distinctAuthors: 3 } }),
      said({ basis: 'low_confidence', rev: { confidence: 0.7 }, fields: Object.assign({}, fields, { risk_tags: ['Child Safety'] }) }),
      said({ disposition: 'escalate', basis: 'early_detection', draft: null, fields: Object.assign({}, fields, { risk_tags: ['Child Safety'] }) })], [
      `${HEAD}not met yet (${EARLY}). Posted early because 6 accounts tell the same story.`,
      `${HEAD}not met yet (${EARLY}). Posted early because 36 accounts posted about it at about 3 times the usual pace.`,
      `${HEAD}not met yet (${EARLY}). Posted early because 3 accounts tell the same story.`,
      `${HEAD}met for a Social Alert (Sensitive Topic), but none was sent: the review is only 70% sure, so a person decides.`,
      `${HEAD}met for a Social Alert (Sensitive Topic), but none was sent: emails are off in this run (a dry run).`,
    ]);
    // A story that gets a T&S form (edNoEmail_ took it before the note: d.tnsActive) and is no "not yet" (an ongoing
    // issue whose author is no KOF) says so where the line would say "Monitoring only."; a story posted early keeps its
    // own words, with the form in the next bullet. An escalated story whose email has nobody to go to (Control B30
    // blank) says what it waits for, and a repeat the alert memory holds as the other flow's says who sent it
    const ongoingFields = Object.assign({}, fields, { exposure_tag: P0_TAG, priority: 'P0', issue_status: 'Ongoing Issue' });
    const live = { skip: 'Social Alert sent by the other flow (QA-1004)', kind: 'live', ref: 'QA-1004' };
    // a story the review tags as an account suspension, whose posts claim censorship: the rules count it as the P0 tag
    // Product - Perceived bias, and the line says so of the story's own tag
    const banned = Object.assign({}, fields, { exposure_tag: SUSPENSION_TAG, issue_name: 'Accounts suspended to censor critics',
      summary: 'Six small accounts say Google suspended their accounts to censor them.' });
    eq(said({ fields: banned }), `${HEAD}met for a Social Alert (${COUNTS_AS_BIAS}), but none was sent: the review calls it a build-up to monitor.`);
    eq([said({ fields: ongoingFields }), said({ fields: ongoingFields, tnsActive: true }),
      said({ fields: ongoingFields, tnsActive: true }, Object.assign(acCtx(), { switches: { autoTns: true } })),
      said({ tnsActive: true }),
      said({ disposition: 'escalate', draft: { email_status: 'pending' } }, Object.assign(acCtx(), { b30Blank: true })),
      said({ disposition: 'escalate', draft: { email_status: 'pending' } }),
      said({ disposition: 'dismiss', basis: 'repeat', why: live.skip, review: { memory: { verdict: live } },
        fields: Object.assign({}, fields, { risk_tags: ['Child Safety'] }) })], [
      `${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). Monitoring only.`,
      `${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). ${TNS_ASKED}`,
      `${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). ${TNS_HANDLED}`,
      `${HEAD}not met yet (${EARLY}). Posted early because 6 accounts tell the same story.`,
      `${HEAD}below the Social Alert thresholds (${EARLY}). ${ANYWAY} ${B30_WAIT}`,
      `${HEAD}below the Social Alert thresholds (${EARLY}). ${ANYWAY}`,
      `${HEAD}met for a Social Alert (Sensitive Topic), but none was sent: the other flow already sent it (QA-1004).`,
    ]);
    // a story the review doesn't escalate although it meets a threshold says why, by the decision's kind: a repeat (by
    // the earlier alert's id), Gemini's own reason for dismissing it (quoted as the review's), the bot's own words for
    // a pattern of evergreen noise, a story that isn't in English
    const topic = Object.assign({}, fields, { risk_tags: ['Child Safety'] });
    const MET = `${HEAD}met for a Social Alert (Sensitive Topic), but none was sent: `;
    eq([said({ disposition: 'dismiss', basis: 'repeat', why: 'folded into QA-1007 (the same story: "Chrome tabs")', fields: topic }),
      said({ disposition: 'dismiss', basis: 'early_detection', why: 'Jokes about a meme, no claim', rev: { confidence: 0.9, reason: 'Jokes about a meme, no claim' }, fields: topic }),
      said({ disposition: 'dismiss', basis: 'early_detection', why: 'benign or unrelated low-tier chatter', rev: { confidence: 0.9, reason: '' }, fields: topic }),
      said({ disposition: 'dismiss', basis: 'evergreen', why: 'matched evergreen noise pattern "Chrome tab complaints"', fields: topic }),
      said({ disposition: 'dismiss', basis: 'non_english', why: 'non-English signal (pt) excluded under the English-language collection rule', fields: topic }),
      said({ disposition: 'dismiss', basis: 'early_detection', why: 'Jokes about a meme, no claim', rev: { confidence: 0.9, reason: 'Jokes about a meme, no claim' } })], [
      `${MET}a repeat of QA-1007.`,
      `${MET}the review says "Jokes about a meme, no claim".`,
      `${MET}benign or unrelated low-tier chatter.`,
      `${MET}matched evergreen noise pattern "Chrome tab complaints".`,
      `${MET}the story isn't in English.`,
      `${HEAD}not met yet (${EARLY}). Posted early because 6 accounts tell the same story.`,
    ]);
    // the producer's hint is the story's priority only while no exposure tag is confirmed: never a "P0 exposure tag"
    const hinted = said({ fields: Object.assign({}, fields, { exposure_tag: '', priority: 'P0' }) });
    eq(hinted, `${HEAD}not met yet (${EARLY}). Posted early because 6 accounts tell the same story.`);
    // In the note the line stands where the "SLRR" line is; a note that has none (the review sees no brand-safety issue)
    // gets it as one bullet more, so no other bullet goes for it
    const rev = { confidence: 0.86, severity: 'medium', reason: 'Six accounts tell the same story', teamReasons: {}, tns: '',
      tempCheck: { query: 'chrome update closed tabs', scope: 'X, last 24 hours' }, watchFor: 'a tech reporter picks it up' };
    const noteOf = (slrr, requirement) => B.edNoteText_(d({ rev: Object.assign({}, rev, { slrr }), why: rev.reason, tnsLine: 'not needed for this story.' }), requirement)
      .split('\n');
    const plain = noteOf({ is: false });
    eq([plain.length, plain.slice(2).map(l => l.slice(0, 12))], [5, ['• *Draft Tem', '• *T&S:* not', '• *Escalate ']]);
    eq(noteOf({ is: false }, `${HEAD}x`), plain.slice(0, 2).concat([`• ${HEAD}x`], plain.slice(2)));
    const tagged = noteOf({ is: true, tag: P2_TAG, priority: 'P2', product: 'Chrome', others: [], topics: [] });
    eq([tagged.length, tagged[2]], [5, '• *SLRR:* Product - Other/general criticism (P2) · Chrome.']);
    eq(noteOf({ is: true, tag: P2_TAG, priority: 'P2', product: 'Chrome', others: [], topics: [] }, `${HEAD}x`),
      tagged.slice(0, 2).concat([`• ${HEAD}x`], tagged.slice(3)));
    eq([said({ rev: null }), said({}, acCtx({ requirement_line: false })), said({}, Object.assign(acCtx(), { sourceReadOnly: false })),
      said({}, Object.assign(acCtx(), { otherSpace: true })), said({}, Object.assign(acCtx(), { direct: true }))], ['', '', '', '', '']);
  });

  // =============================================================================================================
  // Burson's resend; "final": when the note in the thread does not say what was done
  // =============================================================================================================

  /** F.P0_OK with these values: its network as Burson wrote it, and its engagements. */
  const p0With = (network, n) => F.P0_OK.replace('[Social Network]: X', `[Social Network]: ${network}`)
    .replace('| X | 1 Engagements', `| ${network} | ${n} Engagements`)
    .replace('VERY LOW (1 engagements)', `${n >= 2000 ? 'HIGH' : 'LOW'} (${n} engagements)`).replace('Product - Perceived bias,1,', `Product - Perceived bias,${n},`);

  test('requirement line: Burson\'s resend with a higher engagement level of an alert that already had its Social Alert is posted as a new corrected alert whose note says at once that it gets none ("…, but none was sent: a resend of QA-1001, whose Social Alert was already decided."), with Never wait on Burson OFF and ON: no second email, and no "final" line after a line that was right from the start; a raised resend of an alert that had no email gets its Social Alert now, and its line says so. A dry run needs no "final" line either: no email is made in it, and the review\'s note says so itself', () => {
    // a dry run: no Social Alert is made, which the line knows before the note is posted
    const dry = oneSpace({ dry_run: true });
    dry.rec.step('Burson alerts', 1, () => { [F.P0_OK, LOW_OK].forEach(text => dry.t.chat.say(REAL, text, ZAPIER)); });
    dry.rec.step('quiet run', 1);
    dry.rec.step('quiet run', 1);
    const [dryMet, dryLow] = tops(dry.t).map(top => look(dry.t, top));
    eq([dryMet.notes, dryLow.notes, dryMet.mails.length, dryMet.row.email_status || '', dry.t.g.gmail.allDrafts().length], [
      [`${HEAD}met for a Social Alert (P0 exposure tag), but none was sent: emails are off in this run (a dry run).`],
      [`${HEAD}not met for a Social Alert (${BELOW('P2', '300')}). Monitoring only.`], 0, '', 0]);
    // Burson's alert with a wrong network (a fix is open) and 300 engagements is escalated for its P0 tag; its resend,
    // fixed, now says 2,500 engagements: a new corrected alert, and the first one keeps its Social Alert. The resend's
    // issue is ongoing by then and its author is no KOF, so its engagements are the requirement it meets
    [false, true].forEach(noWait => {
      const w = oneSpace(null, noWait ? x => { x.sh.getRange(23, 2).setValue('ON'); } : null);
      w.rec.step('a Burson alert', 1, () => { w.t.chat.say(REAL, p0With('Instagram', 300), ZAPIER); });
      w.rec.step('Burson resends it', 2, () => { w.t.chat.say(REAL, p0With('X', 2500), ZAPIER); });
      w.rec.step('quiet run', 1);
      w.rec.step('quiet run', 1);
      const [one, two] = tops(w.t).map(top => look(w.t, top));
      eq([one.notes, two.notes], [
        [`${CHANGES}\n- Social Network: Instagram to X\n${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`],
        ['QA: updated alert (engagement is now HIGH, was LOW)\n' + `${CHANGES}\n` +
          '- Issue status: New / not previously reported over the past 14 days to Ongoing Issue\n' +
          `${HEAD}met for a Social Alert (2,500 engagements), but none was sent: a resend of QA-1001, whose Social Alert was already decided.`],
      ], `Never wait on Burson ${noWait ? 'ON' : 'OFF'}`);
      eq([two.mails.length, alertRows(w.t).map(row => [row.alert_id, row.email_status || '', row.resend_of || ''])],
        [1, [['QA-1001', 'sent', ''], ['QA-1002', '', 'QA-1001']]]);
      // the note is the bot's own, in the alert's thread in the Auto-correct space; no note went through the helper for
      // notes under a card (no "final" line: its counts have nothing)
      eq(under(w.t, two.top).map(m => [m.name.indexOf(AC + '/messages/') === 0, /^client-bqa-[0-9a-f]{40}$/.test(m.clientAssignedMessageId)]), [[true, true]]);
      eq(w.t.g.cache.get('ac_thread_notes') || null, null);
      assert.ok(!w.t.g.logs.some(l => /thread note not posted|alert requirements line was left out/.test(l)), 'nothing was held or left out');
    });
    // An alert that had no email: a P2 tag at 300 engagements with a wrong network. Its resend, fixed, at 2,500: a new
    // corrected alert that is escalated now, and its line says that
    const meme = (network, n) => bursonAlert({ banner: 'P2', tag: 'Product - Meme about Google products', product: 'Maps', n, author: 'street_view_fan',
      id: '2150000000000000414', name: 'Street View Car Meme',
      summary: 'An X user (@street_view_fan; 800 followers) posted a meme about the Street View car.' })
      .replace('[Other Google Products]: None', `[Other Google Products]: None\n[Social Network]: ${network}`);
    const w = oneSpace();
    w.rec.step('a Burson alert', 1, () => { w.t.chat.say(REAL, meme('Instagram', 300), ZAPIER); });
    w.rec.step('Burson resends it', 2, () => { w.t.chat.say(REAL, meme('X', 2500), ZAPIER); });
    w.rec.step('quiet run', 1);
    const [low, raised] = tops(w.t).map(top => look(w.t, top));
    eq([lineOf(low), lineOf(raised), raised.notes[0].split('\n')[0]], [[`${HEAD}not met for a Social Alert (${BELOW('P2', '300')}). Monitoring only.`],
      [`${HEAD}met for a Social Alert: 2,500 engagements (2,000+ needed).`], 'QA: updated alert (engagement is now HIGH, was LOW)']);
    eq([raised.mails.length, raised.mails.map(m => m.to), alertRows(w.t).map(row => [row.alert_id, row.email_status || '', row.resend_of || ''])],
      [1, [[TESTER]], [['QA-1001', '', ''], ['QA-1002', 'sent', 'QA-1001']]]);
    assert.ok(!under(w.t, raised.top).some(m => m.text.indexOf(FINAL) >= 0), 'no "final" line: the Social Alert went as the line says');
  });

  /** Makes the next `n` attempts at an alert in the Auto-correct flow stop where its Social Alert is planned: after its note was posted, before its row. */
  const stopAfterNote = (t, n) => {
    if (!t.bot.__stops) {
      t.bot.__stops = { left: 0, made: 0 };
      t.bot.ev('draftPlan_ = (orig => function (ctx, review, history) { if (ctx.sourceReadOnly === true && __stops.left > 0) { ' +
        '__stops.left--; __stops.made++; throw new Error("the run stopped here"); } return orig(ctx, review, history); })(draftPlan_)');
    }
    t.bot.__stops.left = n;
    return t.bot.__stops;
  };
  const VETO = () => ({ checks: [], social_alert: { warranted: false, confidence: 0.95, reason: 'A meme with no claim about the product' } });

  test('requirement line: an alert that is tried a second time (the first attempt stopped after its note was posted, before the alert was recorded) keeps the first attempt\'s note, because a note is posted once per alert. When the second attempt decides otherwise, "*Alert requirements, final:* …" follows with what was decided and done: none sent after a line that said one goes out, one sent after a line that said none, under Burson\'s corrected copy and under a card reviewed in place; when it decides the same, nothing follows', () => {
    // 1. the first attempt: met, a Social Alert goes out. The second: the review is against it, and none is sent
    const w = oneSpace();
    const stops = stopAfterNote(w.t, 1);
    w.rec.step('the first attempt', 1, () => { w.t.chat.say(REAL, MAPS_OK, ZAPIER); });
    const card = tops(w.t)[0];
    eq([stops.made, under(w.t, card).map(m => m.text), alertRows(w.t).length, socialAlerts(w.t).length],
      [1, [`${HEAD}met for a Social Alert: 4,200 engagements (2,000+ needed).`], 0, 0]);
    w.t.g.vertex.assess = VETO;
    w.rec.step('the second attempt', 1);
    w.rec.step('quiet run', 1);
    const r = look(w.t, card);
    eq([tops(w.t).length, r.notes, r.row.decision, r.marks, r.mails.length, r.row.email_status || ''], [1, [
      `${HEAD}met for a Social Alert: 4,200 engagements (2,000+ needed).`,
      `${FINAL}met for a Social Alert (4,200 engagements), but none was sent: the review says "A meme with no claim about the product".`,
    ], '❌ AI review: A meme with no claim about the product', ['❌'], 0, '']);
    // the final line is the bot's own note, posted once through the helper for notes under a card
    eq([under(w.t, card).map(m => /^client-bqa-[0-9a-f]{40}$/.test(m.clientAssignedMessageId)), Object.keys(JSON.parse(w.t.g.cache.get('ac_thread_notes')).k).length],
      [[true, true], 1]);
    w.rec.step('quiet run', 1);
    eq(under(w.t, card).length, 2);
    // 2. the other way round: the first attempt's review is against it; the second sends the Social Alert
    const v = oneSpace();
    stopAfterNote(v.t, 1);
    const scripted = v.t.g.vertex.assess;
    v.t.g.vertex.assess = VETO;
    v.rec.step('the first attempt', 1, () => { v.t.chat.say(REAL, MAPS_OK, ZAPIER); });
    v.t.g.vertex.assess = scripted;
    v.rec.step('the second attempt', 1);
    v.rec.step('quiet run', 1);
    const sent = look(v.t, tops(v.t)[0]);
    eq([sent.notes.filter(n => /Alert requirements/.test(n)), sent.mails.length, sent.row.email_status], [[
      `${HEAD}met for a Social Alert (4,200 engagements), but none was sent: the review says "A meme with no claim about the product".`,
      `${FINAL}met for a Social Alert: 4,200 engagements (2,000+ needed).`,
    ], 1, 'sent']);
    // 3. the second attempt decides the same: the note in the thread says what was done, and nothing follows
    const same = oneSpace();
    stopAfterNote(same.t, 1);
    same.rec.step('the first attempt', 1, () => { same.t.chat.say(REAL, MAPS_OK, ZAPIER); });
    same.rec.step('the second attempt', 1);
    same.rec.step('quiet run', 1);
    const again = look(same.t, tops(same.t)[0]);
    eq([again.notes, again.mails.length, again.row.email_status, same.t.g.cache.get('ac_thread_notes') || null],
      [[`${HEAD}met for a Social Alert: 4,200 engagements (2,000+ needed).`], 1, 'sent', null]);
    // 4. a card reviewed in place (a Direct BigQuery card: the Pixel post, with 2,400 engagements here)
    const q = oneSpace();
    stopAfterNote(q.t, 1);
    q.rec.step('Direct BigQuery finds the Pixel post', 4, () => { q.feed.bsip = [golden.rows.bsipRow({ total: 2400 })]; });
    q.rec.step('the first attempt at its review', 1);
    const pixel = tops(q.t)[0];
    const firstNote = under(q.t, pixel).map(m => m.text);
    eq([firstNote.length, firstNote[0].split('\n').slice(-1)[0]], [1, `${HEAD}met for a Social Alert: 2,400 engagements (2,000+ needed).`]);
    q.t.g.vertex.assess = VETO;
    q.rec.step('the second attempt', 1);
    q.rec.step('quiet run', 1);
    const inPlace = look(q.t, pixel);
    eq([inPlace.notes.length, inPlace.notes[0], inPlace.notes[1], inPlace.row.ingested, inPlace.row.decision, inPlace.mails.length], [2, firstNote[0],
      `${FINAL}met for a Social Alert (2,400 engagements), but none was sent: the review says "A meme with no claim about the product".`,
      'BSIP', '❌ AI review: A meme with no claim about the product', 0]);
  });

  test('requirement line: the "final" line, asked directly: nothing when the Social Alert was planned as the line says; one line, once, when none was planned after a line that said one goes out, or one was planned after a line that said none (worded from the planned Social Alert\'s own escalation); and, when the note in the thread is an earlier attempt\'s, this attempt\'s own line. Whether the note Chat hands back is this attempt\'s is told by its last line, with Chat\'s bold marks or without. What the caller knows beforehand is on the first line already: an alert whose Social Alert was decided before gets none, and one that still waits on Burson says its T&S form follows then', () => {
    const w = oneSpace();
    w.rec.step('Burson alerts', 1, () => { [F.P0_OK, LOW_OK, MAPS_OK].forEach(text => w.t.chat.say(REAL, text, ZAPIER)); });
    w.rec.step('quiet run', 1);
    const [one, two, three] = tops(w.t).map(top => look(w.t, top));
    const cardOf = r => ({ name: r.top.name, thread: r.top.thread.name });
    const texts = r => under(w.t, r.top).map(m => m.text);
    const had = [texts(one).length, texts(two).length, texts(three).length];
    // Whether the note Chat handed back is this attempt's (requirementNoted_): only a note that has text and does not
    // end with this attempt's line marks the line as an earlier attempt's
    const LINE = `${HEAD}met for a Social Alert: 4,200 engagements (2,000+ needed).`;
    const OTHER = `${HEAD}met for a Social Alert (4,200 engagements), but none was sent: the review says "A meme".`;
    const noted = text => {
      const req = { line: LINE, d: {} };
      B.requirementNoted_(req, text === undefined ? undefined : { text });
      return req.stale === true;
    };
    // (Chat can hand a text back in another form than it was sent in: without its bold marks, as italics, with other
    // spacing or quotation marks. Only the letters and digits are held against each other)
    eq([LINE, `${CHANGES}\n- Product: Gems to Gemini App\n${LINE}`, LINE.replace(/\*/g, ''), `Sources: Reuters\n${LINE.replace(/\*/g, '')}  `,
      `${LINE.replace(': 4,200', ':  4,200')}\n`, LINE.replace(/\*/g, '_'), LINE.replace(/\*/g, '**').replace('(2,000+ needed)', '(2,000+ needed) '),
      OTHER, `${CHANGES}\n- Product: Gems to Gemini App`, `${LINE}\n${OTHER}`, LINE.replace('4,200', '4,300'), '', undefined].map(noted),
    [false, false, false, false, false, false, false, true, true, true, true, false, false]);
    B.requirementNoted_(null, { text: OTHER });  // (no line worked out: nothing to mark, and it never throws)
    B.requirementNoted_({ d: {} }, { text: OTHER });
    // (what the flow's run found is handed out and held to account after the run: nothing thrown in it can go unseen)
    const got = inFlow(w, ctx => {
      const bot = w.t.bot;
      const reviewOf = text => bot.reviewAlert_(bot.parseAlert_(text), { now: NOW, history: [] });
      const reqOf = (text, opts) => bot.requirementOf_(ctx, reviewOf(text), [], opts);
      const met = reqOf(F.P0_OK);
      const low = reqOf(LOW_OK);
      const first = [met.d.sent, low.d.sent, met.stale, low.stale];
      const planned = (text, patch) => {
        const fields = reviewOf(text).fields;
        return { email_status: 'pending', email_input: { fields, escalation: Object.assign(bot.escalation_(fields, { now: NOW }), patch || {}) } };
      };
      // 1. they agree: nothing is posted (a Social Alert planned as the line says; none, as the line says)
      bot.requirementFinal_(ctx, met, cardOf(one), 'spaces/src/messages/agree-1', planned(F.P0_OK), '');
      bot.requirementFinal_(ctx, low, cardOf(one), 'spaces/src/messages/agree-2', null, '');
      // 2. the line said one goes out, and none was planned, with no reason from the caller
      bot.requirementFinal_(ctx, met, cardOf(one), 'spaces/src/messages/none-1', null, '');
      bot.requirementFinal_(ctx, met, cardOf(one), 'spaces/src/messages/none-1', null, '');  // (once: the same alert again)
      // 3. the line said none, and one was planned: worded from the planned Social Alert's own escalation (the rules', or
      //    one the review started below the thresholds)
      bot.requirementFinal_(ctx, low, cardOf(one), 'spaces/src/messages/made-1', planned(F.P0_OK), '');
      bot.requirementFinal_(ctx, low, cardOf(two), 'spaces/src/messages/made-2',
        planned(LOW_OK, { escalated: true, track: 'URGENT', action: 'EMAIL_ALERT', suppression: null, reasons: ['KB_OR_GUIDANCE'] }), '');
      // 4. the note in the thread is an earlier attempt's, and this attempt's plan is what its own line says: that line
      bot.requirementFinal_(ctx, Object.assign({}, low, { stale: true }), cardOf(three), 'spaces/src/messages/stale-1', null, '');
      bot.requirementFinal_(ctx, Object.assign({}, met, { stale: true }), cardOf(three), 'spaces/src/messages/stale-2', planned(F.P0_OK), '');
      // 5. nothing to go by: no line worked out, no card
      bot.requirementFinal_(ctx, null, cardOf(one), 'spaces/src/messages/no-req', null, '');
      bot.requirementFinal_(ctx, met, null, 'spaces/src/messages/no-card', null, '');
      bot.requirementFinal_(ctx, met, {}, 'spaces/src/messages/no-card', null, '');
      bot.requirementFinal_(ctx, Object.assign({}, met, { stale: true }), {}, 'spaces/src/messages/no-card', planned(F.P0_OK), '');
      // What the caller knows before the note: an alert whose Social Alert was decided before gets none, whatever the
      // review says, and the line names that reason; an alert that still waits on Burson gets no T&S form yet
      const DECIDED = { decided: 'a resend of QA-7, whose Social Alert was already decided' };
      const decided = reqOf(F.P0_OK, DECIDED);
      const decidedLow = reqOf(LOW_OK, DECIDED);
      const form = reqOf(GEMINI_WRONG);
      const formLater = reqOf(GEMINI_WRONG, { waits: true });
      const formDecided = reqOf(GEMINI_WRONG, DECIDED);
      // (and none of that leaves anything on the review it reads)
      const review = reviewOf(GEMINI_WRONG);
      const asWas = JSON.stringify(review);
      bot.requirementOf_(ctx, review, []);
      return { first, known: [decided.d.sent, decided.line, decidedLow.line, form.d.tns, form.line, formLater.d.tns, formLater.line, formDecided.d.tns,
        formDecided.line], untouched: JSON.stringify(review) === asWas };
    });
    eq([got.first, got.untouched], [[true, false, undefined, undefined], true]);
    eq(got.known, [false,
      `${HEAD}met for a Social Alert (P0 exposure tag), but none was sent: a resend of QA-7, whose Social Alert was already decided.`,
      `${HEAD}not met for a Social Alert (${BELOW('P2', '300')}). Monitoring only.`,
      'ask', `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}). ${TNS_ASKED}`,
      'later', `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}). ${TNS_LATER}`,
      undefined, `${HEAD}not met for a Social Alert (${BELOW('P1', '300')}). Monitoring only.`]);
    eq([texts(one).slice(had[0]), texts(two).slice(had[1]), texts(three).slice(had[2])], [[
      `${FINAL}met for a Social Alert (P0 exposure tag), but none was sent: it was not made in this run.`,
      `${FINAL}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`,
    ], [`${FINAL}below the Social Alert thresholds (${BELOW('P2', '300')}). ${ANYWAY}`], [
      `${FINAL}not met for a Social Alert (${BELOW('P2', '300')}). Monitoring only.`,
      `${FINAL}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`]]);
    assert.ok(!w.t.g.logs.some(l => /thread note not posted/.test(l)), 'none was held back');
  });

  // =============================================================================================================
  // The bot's own note, never answered; never on a way to Burson
  // =============================================================================================================

  test('requirement line: the bot never answers the review\'s note: alone, under a list of changes, under "Not fixed: …" and under the write-up\'s "Sources: …", it gets no reply and no Gemini call at the next runs, read back with its message id and with none (Chat\'s custom ids gone, the bot\'s record of its posts dropped: only its words tell); a person\'s message from the bot\'s account in the same thread is answered, also a question that starts "Alert requirements" (in the Auto-correct flow: the bot\'s own lines never end with a question mark)', () => {
    const w = oneSpace();
    const WRITEUP = { post: 'X user @WasSamLowryEsq (652 followers) says Google Search showed mainly white protesters for "Paris riots 2026" and ' +
      'accuses Google of a misleading account of events. The post does not say which results it saw.',
    background: 'The 2026 Paris riots followed a police shooting in the city. Le Monde and Reuters report the riots; neither reports the claim about Search.' };
    const scripted = w.t.g.vertex.assess;
    w.t.g.vertex.assess = payload => (/WasSamLowryEsq/.test(JSON.stringify(payload.contents)) && payload.generationConfig.responseSchema.properties.writeup
      ? { checks: [], writeup: WRITEUP } : scripted(payload));
    w.t.g.vertex.grounding = payload => (payload.tools && /WasSamLowryEsq/.test(JSON.stringify(payload.contents))
      ? { webSearchQueries: ['Paris riots 2026 Google Search'], groundingChunks: [
        { web: { title: 'Paris riots: what we know - Le Monde', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC1' } },
        { web: { title: 'reuters.com', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/DeF2' } }] } : null);
    const NO_LINK = F.WAYMO_KOF.replace('[Link]: https://x.com/ICannot_Enough/status/2111814207448514693\n', '');
    [F.P0_OK, F.MISTAKES, MAPS_OK, NO_LINK].forEach((text, i) => w.rec.step(`alert ${i + 1}`, 1, () => { w.t.chat.say(REAL, text, ZAPIER); }));
    const cards = tops(w.t);
    const firstNote = card => under(w.t, card)[0];
    const reviewNotes = cards.map(firstNote);
    eq(reviewNotes.map(m => m.text.split('\n').map(l => l.replace(/^(- |Not fixed: ).*$/, '$1…'))), [
      ['Sources: Le Monde, Reuters', `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`],
      [CHANGES, '- …', '- …', '- …', '- …', `${HEAD}met for a Social Alert: 29,425 engagements (2,000+ needed).`],
      [`${HEAD}met for a Social Alert: 4,200 engagements (2,000+ needed).`],
      ['Not fixed: …', `${HEAD}met for a Social Alert: KOF author (Viral KOFs).`],
    ]);
    const replies = () => cards.map(card => under(w.t, card).map(m => m.text));
    const answers = () => w.t.g.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.answer).length;
    const baseline = replies();
    const asked = answers();
    // 1. with their ids
    w.rec.step('quiet run', 1);
    w.rec.step('quiet run', 1);
    eq([replies(), answers()], [baseline, asked]);
    // 2. with no id at all: read again (the flow re-reads the last minutes), each is still the bot's own by its words
    const forget = () => {
      reviewNotes.forEach(m => { delete m.clientAssignedMessageId; });
      ['bot_posts', 'bot_post_ids', 'bot_reactions', 'recent:AC:' + REAL].forEach(k => w.t.g.cache.delete(k));
      w.t.bot.ev('BOT_MARKS_ = null');
    };
    forget();
    const ctx = { botUser: 'users/bot', store: { isOwnPost: () => false } };
    const read = w.t.bot.chatListMessages_(AC, new Date(w.t.g.clock.now - 20 * MIN).toISOString(), 1000)
      .filter(m => reviewNotes.some(n => n.name === m.name));
    eq([read.length, read.map(m => m.clientId), read.map(m => w.t.bot.isOwnMessage_(ctx, m))], [4, ['', '', '', ''], [true, true, true, true]]);
    w.rec.step('quiet run', 1);
    forget();
    w.rec.step('quiet run', 1);
    eq([replies(), answers()], [baseline, asked]);
    // 3. the same thread does answer a message from the bot's account that names an alert field in other words
    const ask = w.t.chat.say(AC, 'Which requirement did this alert meet, the exposure tag or the engagements?', { thread: cards[2].thread.name, sender: 'users/bot' });
    forget();
    w.rec.step('a question', 1);
    eq([answers(), under(w.t, cards[2]).slice(-2).map(m => m.text)], [asked + 1, [ask.text, 'Happy to help with that.']]);
    // ...and one that starts as the line does and ends with a question mark: the bot's own lines never do
    const owner = w.t.chat.say(AC, 'Alert requirements: why was this one met by its engagements?', { thread: cards[2].thread.name, sender: 'users/bot' });
    forget();
    w.rec.step('the owner\'s question', 1);
    eq([answers(), under(w.t, cards[2]).slice(-2).map(m => m.text)], [asked + 2, [owner.text, 'Happy to help with that.']]);
    w.rec.step('quiet run', 1);
    eq(answers(), asked + 2);
    const acOwn = text => B.isOwnMessage_(Object.assign({ sourceReadOnly: true }, ctx), { senderName: 'users/bot', text });
    eq(['Alert requirements: why was this one not met?', '*Alert requirements:* is this right?', '🔗 Alert requirements, final: why?',
      'Alert requirements: why?\nAnd this', `${HEAD}met for a Social Alert (2,400 engagements), but none was sent: the review says "Is it news?".`,
      `${FINAL}met for a Social Alert (KOF author), but none was sent: why not?.`, 'Part of a story: is it?'].map(acOwn),
    [false, false, false, true, true, true, true]);
    // (only the Auto-correct flow, where the line is: elsewhere such a message stays as it was, the bot's own by its words)
    eq(B.isOwnMessage_(ctx, { senderName: 'users/bot', text: 'Alert requirements: why was this one not met?' }), true);
    eq(B.isRequirementQuestion_(`${HEAD}not met for a Social Alert (${BELOW('P2', '300')}). Monitoring only.`), false);
    // the words alone: each form of the note is the bot's own; a person's two lines that only look alike are theirs
    const own = text => B.isOwnMessage_(ctx, { senderName: 'users/bot', text });
    reviewNotes.forEach(m => assert.ok(own(m.text) && own(m.text.replace(/\*/g, '')), m.text));
    ['Sources: Reuters\nand the BBC too', 'Sources: Reuters says it is fake.\n*Alert requirements:* met for a Social Alert: KOF author.',
      'Sources: Reuters\nAlert requirements are met?', 'Sources: Reuters\n*Alert requirements:* yes they are', 'Sources: Reuters\nAlert requirements: all met.',
      'Sources: Le Monde, Reuters\n*Alert requirements:* met for a Social Alert: KOF author.\nAnd one more line'].forEach(text => assert.ok(!own(text), text));
  });

  test('requirement line: nothing of it reaches an email, the T&S form, the Burson outbox or the Burson test copy: in the one-space scenario (default settings) no email, form link or form text has "Alert requirements"; and the Mirror flow (rows 15, 19, 22, 24 and 34 ON; Testing with a test copy, then LIVE) has it nowhere at all: not in the Mirror space, the test copy, the outbox or an email', () => {
    const one = golden.oneSpaceRun();
    const words = /Alert[\s+]*requirements|Alert%20requirements/i;
    assert.ok(one.out.chat.filter(c => words.test(c.text)).length >= 5, 'the scenario has the line');
    eq([one.out.emails.filter(e => words.test(JSON.stringify(e))), one.out.outbox, one.out.test_copy], [[], [], []]);
    const forms = [];
    one.out.chat.forEach(c => (c.text.match(/https:\/\/docs\.google\.com\/forms\/[^|>\s]+/g) || []).forEach(u => forms.push(decodeURIComponent(u))));
    assert.ok(forms.length >= 1 && !forms.some(u => words.test(u)), forms.join('\n'));
    const withInput = alertRows(one.t).filter(r => r.email_input && r.email_input.fields);
    assert.ok(withInput.length >= 2);
    withInput.forEach(r => {
      assert.ok(!words.test(JSON.stringify(r.email_input)), r.alert_id);
      assert.ok(!words.test(one.t.bot.tnsFormText_(r.email_input)) && !words.test(decodeURIComponent(String(one.t.bot.tnsPrefillUrl_(r.email_input) || ''))), r.alert_id);
    });
    // every row's decision in the Alert log is what it was: the line is in the space only
    assert.ok(!alertRows(one.t).some(r => words.test(String(r.decision || ''))));
    const mirror = golden.mirror();
    eq([words.test(JSON.stringify(mirror)), mirror.chat.length > 10, mirror.test_copy.length > 3, mirror.outbox.length > 3, mirror.emails.length], [false, true, true, true, 2]);
  });

  // =============================================================================================================
  // Only the Auto-correct flow, only with the setting on
  // =============================================================================================================

  test('requirement line: with the setting requirement_line off, the one-space scenario posts what it posted before the line: the same emails, emojis and messages, the review\'s notes without their last line, and the Watch triage and Early Detection review notes with their "SLRR" line; with it on, only those notes differ', () => {
    const on = golden.oneSpace();
    const off = golden.oneSpace({ requirement_line: false });
    eq([off.emails, off.reactions, off.outbox, off.test_copy, off.chat.length], [on.emails, on.reactions, on.outbox, on.test_copy, on.chat.length]);
    const pairs = on.chat.map((c, i) => [c, off.chat[i]]).filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b));
    // every difference is a thread note, in the same place, that has the line when on and not when off
    pairs.forEach(([a, b]) => eq([a.reply, b.reply, a.run, a.thread, /Alert requirements/.test(a.text), /Alert requirements/.test(b.text)],
      [true, true, b.run, b.thread, true, false], a.text));
    assert.ok(!/Alert requirements/.test(JSON.stringify(off)), 'off: the words are nowhere');
    // off, each of those notes is what it was: the review's note without its last line, or the note with its own line
    eq(pairs.map(([a, b]) => (b.text === a.text.replace(/\n\*Alert requirements:\*[^\n]*$/, '') ? 'the same note without its last line'
      : (b.text.match(/\n• \*SLRR:\*[^\n]*/) || ['?'])[0].slice(1))), [
      'the same note without its last line',
      'the same note without its last line',
      '• *SLRR:* Product - Factual inaccuracies (not dangerous/offensive) (P1), Gemini App — Below SLRR email bar (P1 needs 2,000+ engagements, ' +
        'a KOF author or a Sensitive Topic; this one: 520 engagements (the alert), not a KOF).',
      '• *SLRR:* Product - Other/general criticism (P2) · Chrome.',
      'the same note without its last line',
    ]);
    eq(pairs.map(([a]) => (a.text.match(/(?:^|\n)(?:• )?(\*Alert requirements:\*[^\n]*)/) || [])[1]), [
      `${HEAD}met for a Social Alert: 29,425 engagements (2,000+ needed).`,  // (Burson's alert is on an ongoing issue: its P0 tag alone sends nothing)
      `${HEAD}not met for a Social Alert (${BELOW('P2', '800')}). Monitoring only.`,
      `${HEAD}not met for a Social Alert (${BELOW('P1', '520')}). ${TNS_ASKED}`,  // (the Watch alert's note asks for a T&S form in its next bullet)
      `${HEAD}not met yet (${EARLY}). Posted early because 6 accounts tell the same story.`,
      `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias) · 2,400 engagements (2,000+ needed).`,
    ]);
    // in a triage or review note the line took the other line's place: the rest of the note is the same
    pairs.filter(([, b]) => /\n• \*SLRR:\*/.test(b.text)).forEach(([a, b]) => {
      eq(a.text.replace(/\n• \*Alert requirements:\*[^\n]*/, ''), b.text.replace(/\n• \*SLRR:\*[^\n]*/, ''));
    });
  });

  test('requirement line: only the Auto-correct flow writes it: the Mirror flow, a test feed with its analyst space, the bot working directly in B25 (row 32) and the Other alerts space (B33) get no line (nothing is even worked out for them), and their notes are built exactly as before; nor does the Auto-correct flow with the setting off; and where it is worked out, the review is left as it was (its fields, and the alert memory\'s facts with no verdict written on them)', () => {
    const { t } = oneSpace();
    const OTHER = 'spaces/AAQAotherRq01';
    const DIRECT = 'spaces/AAQAdirectRq1';
    [[MIRROR, 'SLRR Zapier Training Mirror'], [OTHER, 'Midterms 2026'], [DIRECT, 'Campaign alerts']].forEach(([id, name]) => t.chat.addSpace(id, name));
    const sfb = { id: REAL, name: '[S-F] Burson Automated Alerts V3', externalUserAllowed: true };
    const space = (id, name) => ({ id, name, externalUserAllowed: false });
    const flow = cfg => t.bot.buildCtx_(cfg, t.sheet(), t.bot.switchesOff_());
    const flows = {
      mirror: flow({ burson: space(MIRROR, 'Mirror'), analyst: space(MIRROR, 'Mirror'), mirror: space(MIRROR, 'Mirror'), outboundBlocked: true, sfBurson: sfb }),
      feed: flow({ burson: space(TEST_FEED, 'Feed'), analyst: space(TRIAGED, 'Analysts'), sfBurson: sfb }),
      direct: flow(t.bot.directCfg_(space(DIRECT, 'Campaign alerts'))),
      other: flow(t.bot.otherSpaceCfg_(space(OTHER, 'Midterms 2026'))),
    };
    const ac = flow(t.bot.autoCorrectCfg_(space(AC, golden.world.names.AC), sfb));
    t.bot.setSfBurson_(sfb);  // (buildCtx_ is the run's: the run's S-F Burson stays as poll() set it)
    const review = t.bot.reviewAlert_(t.bot.parseAlert_(F.P0_OK), { now: NOW, history: [] });
    const called = { n: 0 };
    t.bot.__reqCalls = called;
    t.bot.ev('escalationFor_ = (orig => function (ctx, review, history) { __reqCalls.n++; return orig(ctx, review, history); })(escalationFor_)');
    Object.keys(flows).forEach(k => eq([t.bot.requirementLineOn_(flows[k]), t.bot.requirementOf_(flows[k], review, [])], [false, null], k));
    eq(called.n, 0);
    const req = t.bot.requirementOf_(ac, review, []);
    eq([t.bot.requirementLineOn_(ac), req.line, called.n], [true, `${HEAD}met for a Social Alert: P0 exposure tag (Product - Perceived bias).`, 1]);
    const offAc = Object.assign({}, ac, { settings: Object.assign({}, ac.settings, { requirement_line: false }) });
    eq([t.bot.requirementLineOn_(offAc), t.bot.requirementOf_(offAc, review, []), called.n], [false, null, 1]);
    // In the Auto-correct flow, working the line out leaves nothing on the review the Social Alert is then planned from:
    // its fields and its alert-memory facts (where the reason functions keep their verdict) are what they were. Here
    // the memory holds the same post's Social Alert, sent five minutes before
    const again = t.bot.reviewAlert_(t.bot.parseAlert_(F.P0_OK), { now: NOW, history: [] });
    again.memory = { on: true, at: NOW, id: '', lv: false, tf: '', flow: 'ac', fields: {},
      post: { e: { id: 'QA-1001', at: NOW - 5 * MIN, o: 'e', lv: false, th: 'thread-1' }, le: 0, st: { p: 'P0', t: [], k: false, ld: false, g: 1 }, tg: [] } };
    const asWas = JSON.stringify(again);
    const repeat = t.bot.requirementOf_(ac, again, []);
    eq([repeat.line, repeat.d.repeat, 'verdict' in again.memory, JSON.stringify(again) === asWas],
      [`${HEAD}not met for a Social Alert (an ongoing issue, and the author isn't a KOF). Monitoring only.`, 'QA-1001', false, true]);
    // (the reason function itself keeps its verdict there, as it does when the Social Alert is planned)
    eq([t.bot.memorySkip_(again, repeat.d.rules), 'verdict' in again.memory], ['the same post was already emailed (QA-1001)', true]);
    // a ctx that only looks like the flow: the flag must be exactly true, and no other flow's mark may be set
    [{ sourceReadOnly: 'true' }, { outboundBlocked: true }, { direct: true }, { otherSpace: true }, { settings: null }]
      .forEach(patchCtx => eq(t.bot.requirementLineOn_(Object.assign({}, ac, patchCtx)), false, JSON.stringify(patchCtx)));
    eq([t.bot.requirementLineOn_(null), t.bot.requirementLineOn_({})], [false, false]);
    // the notes without a line are built as before: the same text as the builders give with no second argument
    const r = B.reviewAlert_(B.parseAlert_(F.MISTAKES), { now: NOW, history: [] });
    eq([B.changeNoteText_(r, { findLinks: false, requirement: '' }), B.changeNoteText_(r, { inPlace: true, requirement: null })],
      [B.changeNoteText_(r, { findLinks: false }), B.changeNoteText_(r, { inPlace: true })]);
    eq(B.changeNoteText_(r, { requirement: `${HEAD}x` }), `${B.changeNoteText_(r)}\n${HEAD}x`);
    eq(B.changeNoteText_(B.reviewAlert_(B.parseAlert_(F.P0_OK), { now: NOW, history: [] }), { requirement: `${HEAD}x` }), `${HEAD}x`);
  });

  // =============================================================================================================
  // Not a note under another alert's card: outside the thread-note helper's caps
  // =============================================================================================================

  test('requirement line: the review\'s own note is not one of the three notes a card may take from other alerts (ThreadNotes.gs): with its one-line note under it, a card still takes three such notes and refuses the fourth, also when the card\'s notes are counted in its thread (the counts gone), for Burson\'s corrected copy and for a card reviewed in place; only with Chat\'s ids gone too can it not be told apart, and it counts as one', () => {
    const STORY = '🔗 *Part of a story:* 5 small accounts on X and Reddit now tell it: Pixel 10 owners say the update is the issue';
    const WATCH = '🔭 *Also flagged by the watch “Google brand safety (all)”.* No separate Watch alert: this card already covers the post.';
    const w = oneSpace();
    w.t.g.vertex.assess = () => ({ checks: [] });  // no write-up: each review's note is its one line
    const inRun = fn => inFlow(w, fn);
    w.rec.step('Burson alerts', 1, () => { [F.P0_OK, F.WAYMO_KOF].forEach(text => w.t.chat.say(REAL, text, ZAPIER)); });
    w.rec.step('Direct BigQuery finds the Pixel post', 3, () => { w.feed.bsip = [golden.rows.bsipRow()]; });
    w.rec.step('the Pixel card is reviewed', 1);
    const rowsNow = alertRows(w.t);
    const copy = rowsNow.find(r => !r.ingested && /2109952063492993159/.test(r.record_key));
    const kof = rowsNow.find(r => !r.ingested && /2111814207448514693/.test(r.record_key));
    const card = rowsNow.find(r => r.ingested === 'BSIP');
    const thread = row => w.t.chat.spaces.get(AC).messages.filter(m => m.threadReply && m.thread.name === row.forward_thread);
    [copy, kof, card].forEach(row => eq(thread(row).map(m => m.text.indexOf(HEAD) === 0), [true], row.alert_id));
    const threadReads = () => w.t.chat.calls.filter(c => c.method === 'get' && /\/messages$/.test(c.path) &&
      /^thread\.name = /.test(String((c.query || {}).filter || ''))).length;
    // the counts gone: each card's notes are counted in its thread, where the review's line is no note of this kind
    [copy, card].forEach(row => {
      w.t.g.cache.delete('ac_thread_notes');
      const reads = threadReads();
      const took = inRun(ctx => ['a', 'b', 'c', 'd'].map((k, i) => w.t.bot.acThreadNote_(ctx, row, i % 2 ? WATCH : STORY, `${row.alert_id}:${k}`)));
      eq([took, threadReads() - reads, thread(row).length], [[true, true, true, false], 1, 4], row.alert_id);
    });
    // ...and with Chat's custom ids gone as well (and the bot's record of its posts): the line can't be told from a
    // note by its words, so it counts as one of the three: a note fewer, never one more
    thread(kof).forEach(m => { delete m.clientAssignedMessageId; });
    ['bot_posts', 'bot_post_ids', 'bot_reactions', 'ac_thread_notes'].forEach(k => w.t.g.cache.delete(k));
    w.t.bot.ev('BOT_MARKS_ = null');
    const fewer = inRun(ctx => ['a', 'b', 'c'].map((k, i) => w.t.bot.acThreadNote_(ctx, kof, i % 2 ? WATCH : STORY, `${kof.alert_id}:${k}`)));
    eq([fewer, thread(kof).length], [[true, true, false], 3]);
  });
};
