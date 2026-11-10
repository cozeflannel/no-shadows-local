// One name per issue (IssueNames.gs): SLRR's tools count and group alerts by issue name, so an alert about an issue
// already alerted in the last 14 days takes that issue's exact name and the Ongoing Issue status: never a second name
// for the same issue, never "New" for one that's running. Burson's alerts (Review.gs rule 14b: Gemini's call on the
// EXISTING ISSUES it was shown, the earlier alert it follows up on, a near-identical name), the bot's own (OtherAlerts.gs
// otherReview_, EarlyDetection.gs edBuildReview_), and once more right before any Social Alert is drafted (Drafts.gs
// draftRowFor_).
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, world } = H;
  const DAY = 24 * 3600e3;
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const FINLAND = 'Criticism against alleged Finland AI infrastructure';
  const VARIANT = 'Alleged Google environmental damage in Finland';
  const TAG = 'Brand - Sustainability concerns';
  const NEW = 'New / not previously reported over the past 14 days';
  // The SLRR master log's issues of the last 14 days (BigQuery.gs recentSlrrIssues_), newest first, as the enrichment
  // hands them over: the Finland story is neither the newest nor named like the new alert
  const issue = (name, product, tag, days, count, summary) => ({ issue_name: name, product, exposure_tag: tag, count,
    max_engagement: null, latest_at: NOW - days * DAY, summary });
  const ISSUES = [
    issue('Criticism against Search and Ads earnings', 'Search', 'Brand - Value & Earnings', 0.2, 129, 'Posts criticize Google Search and Ads earnings.'),
    issue('Alleged School Search Access Restrictions Over AI Opt-Out', 'Search', 'Brand - Other/general criticism', 0.5, 151,
      'Claims that schools lose Search access after opting out of AI features.'),
    issue('AI Mode Teen Safety Lawsuit', 'AI Mode', 'Brand - Litigation', 1, 16, 'A lawsuit claims AI Mode harmed a teen.'),
    issue('Environmental impacts of Google Data Centers', 'Data Centers', TAG, 4, 5, 'Posts on the water and power use of Google data centers.'),
    issue(FINLAND, 'Data Centers', TAG, 2, 33, 'X user claims Google cleared more than 300 hectares of Finnish forest for a large AI data center.'),
  ];
  // Burson's alert on the Finland story, under another name (the example SLRR's tools miscounted)
  const alertText = (name, status) => [
    'THIS ALERT MEETS P2 CRITERIA',
    'SOCIAL ALERT:',
    '[Time/Date Post Went Live]: October 13, 2026, 3:50 AM',
    `[Exposure Tag]: ${TAG}`,
    '[Product]: Data Centers',
    '[Other Google Products]: None',
    '[Engagement]: HIGH (2312 engagements)',
    '[Sensitive Topic]: None',
    '[KOF]: Yes',
    'Reddit user u/Beyond_the_one (330K members) shared a post alleging that Google illegally fells 250,000 trees for a datacentre in Finland.',
    '[Link]: https://www.reddit.com/r/BuyFromEU/comments/1oz2xyz/google_fells_250000_trees_for_a_datacentre_in/',
    `[Name]: ${name} / ${status}`,
    `[Code]: ${TAG},2312,u/Beyond_the_one,None,Data Centers,${status}`,
  ].join('\n');
  const ALERT = alertText(VARIANT, 'Ongoing Issue');
  // Gemini's known_issue call (the scripted answer): the Finland issue by its [K#] in the prompt it was given
  const kOf = (payload, name) => {
    const line = payload.systemInstruction.parts[0].text.split('\n').find(l => /^\[K\d+\]/.test(l) && l.includes(`"${name}"`));
    return line ? Number(line.match(/^\[K(\d+)\]/)[1]) : null;
  };
  const sameStory = confidence => payload => ({ checks: [], known_issue: { matches: true, issue_n: kOf(payload, FINLAND),
    issue_name: FINLAND, confidence, reason: 'The same Finland data center deforestation story' } });
  const reviewed = (text, llm, history) => {
    const parsed = B.parseAlert_(text);
    parsed.knownIssues = B.recentKnownIssues_(parsed.fields, history || [], ISSUES, [], NOW);
    return B.reviewAlert_(parsed, { now: NOW, history: history || [], llm });
  };

  test('one name per issue: a Burson alert on an issue already alerted under another name (the Finland data center story) is checked against the existing issues before anything goes out and takes that issue\'s exact name: the corrected alert, its Social Alert (subject and Name) and its Alert-log row; Burson is told', () => {
    const w = world({ drafts: STAND_IN, noWait: true, bq: () => ({ recent_issues: ISSUES }) });
    const asked = [];
    w.vertex.assess = payload => { asked.push(payload); return sameStory(0.93)(payload); };
    w.paste(ALERT);
    w.run();
    // Gemini was shown the existing issues, the most like this alert first, and asked for known_issue
    const sys = asked[0].systemInstruction.parts[0].text;
    assert.ok(sys.includes('\nEXISTING ISSUES (alerted in the last 14 days across SLRR, the most like this alert first;'), sys);
    assert.ok(sys.includes(`\n[K1] (2d ago, 33 alerts, SLRR master log) \u00b7 Data Centers \u00b7 ${TAG} \u00b7 "${FINLAND}" \u2014 `), sys);
    assert.ok(asked[0].generationConfig.responseSchema.properties.known_issue, 'known_issue asked for');
    // the alert, its email and its row carry the existing issue's name and the Ongoing Issue status
    const row = w.alertRows()[0];
    eq([row.forwarded_fields.issue_name, row.forwarded_fields.issue_status], [FINLAND, 'Ongoing Issue']);
    eq(row.email_input.fields.issue_name, FINLAND);
    const sent = w.gmail.sentMessages();
    eq(sent.length, 1);
    assert.ok(sent[0].subject.includes(`| ${FINLAND} | Reddit |`), sent[0].subject);
    assert.ok(sent[0].text.includes(`Name: ${FINLAND} / Ongoing Issue`), sent[0].text);
    assert.ok(!sent[0].text.includes(VARIANT) && !sent[0].subject.includes(VARIANT));
    assert.ok(w.analystPosts()[0].text.includes(`[Name]: ${FINLAND} / Ongoing Issue`), w.analystPosts()[0].text);
    // Burson hears what changed, in plain words
    const told = w.bursonPosts().map(m => m.text).join('\n');
    assert.ok(told.includes(`Issue title updated to "${FINLAND}"`), told);
    assert.ok(!/\bQA-\d+|\bK\d+\b|master log/i.test(told), told);
  });

  test('one name per issue, Burson\'s alerts: a less sure call is a question for analysts (no change); "not the same story" or an issue it wasn\'t shown changes nothing; its own name written differently (case) is that issue\'s, Ongoing; Gemini\'s wording suggestions for an existing issue\'s name are dropped', () => {
    const k = reviewed(ALERT, { checks: [] });
    eq([k.fields.issue_name, k.existingIssue, k.knownIssue], [VARIANT, null, null]);
    // the Finland issue is shown first: the most like this alert, though two issues were alerted more lately
    const shown = B.recentKnownIssues_(B.parseAlert_(ALERT).fields, [], ISSUES, [], NOW);
    eq(shown.map(x => x.issue_name).slice(0, 2), [FINLAND, 'Environmental impacts of Google Data Centers']);
    const n = shown.find(x => x.issue_name === FINLAND).n;
    // less sure (0.7): nothing changes, analysts get the question
    const unsure = reviewed(ALERT, { checks: [], known_issue: { matches: true, issue_n: n, confidence: 0.7 } });
    eq(unsure.fixes.filter(x => /^issue_/.test(x.field)), []);
    eq(unsure.unsure.filter(u => u.field === 'issue_name').map(u => [u.proposed, u.confidence]), [[FINLAND, 0.7]]);
    // sure (0.9): the existing name, and no other issue-name suggestion survives
    const sure = reviewed(ALERT, { checks: [{ id: 'issue_name_neutral', ok: false, confidence: 0.8, finding: 'Could be more neutral',
      proposed_value: 'Reports of Google data center tree felling in Finland' }], known_issue: { matches: true, issue_n: n, confidence: 0.9 } });
    eq(sure.fixes.filter(x => x.field === 'issue_name').map(x => [x.old, x.new, x.source]), [[VARIANT, FINLAND, 'llm']]);
    eq([sure.fields.issue_status, sure.existingIssue.by, sure.unsure.filter(u => u.field === 'issue_name')], ['Ongoing Issue', 'gemini', []]);
    // not the same story; or "the same" as an issue it was never shown: nothing changes
    eq(reviewed(ALERT, { checks: [], known_issue: { matches: false, confidence: 0.95 } }).fields.issue_name, VARIANT);
    eq(reviewed(ALERT, { checks: [], known_issue: { matches: true, issue_n: 99, issue_name: 'Something else', confidence: 0.99 } }).fields.issue_name, VARIANT);
    // its own name, written in another case and called New: the issue's own spelling, and Ongoing Issue
    const named = reviewed(alertText(FINLAND.toLowerCase(), NEW), { checks: [] });
    eq([named.fields.issue_name, named.fields.issue_status, named.existingIssue.by], [FINLAND, 'Ongoing Issue', 'name']);
    eq(named.fixes.filter(x => /^issue_/.test(x.field)).map(x => x.field).sort(), ['issue_name', 'issue_status']);
    // ...but not one alerted under another exposure tag (a generic name can cover more than one issue)
    const otherTag = reviewed(alertText(FINLAND.toLowerCase(), NEW).split(TAG).join('Brand - Other/general criticism'), { checks: [] });
    eq([otherTag.fields.issue_name, otherTag.existingIssue], [FINLAND.toLowerCase(), null]);
  });

  test('one name per issue, the rules: what ties an alert to an existing issue (a sent email it replies on, an alerted follow-up or near-identical alert, Gemini\'s call on a listed issue, its own name), the most certain first; an alert that never went out makes no issue; names compare without case, spacing, quotes or a status suffix', () => {
    eq(B.issueNameKey_('  Criticism against \u201cAI Overviews\u201d  / Ongoing Issue '), 'criticism against ai overviews');
    eq(B.issueNameKey_(`${FINLAND} / ${NEW}`), FINLAND.toLowerCase());
    eq(B.issueNameText_(`${FINLAND} / Ongoing Issue`), FINLAND);
    eq([B.knownIssueName_('criticism against ALLEGED finland ai infrastructure.', ISSUES, TAG),
      B.knownIssueName_(FINLAND, ISSUES, 'Brand - Litigation'), B.knownIssueName_('Something new', ISSUES)], [FINLAND, '', '']);
    const row = (name, extra) => Object.assign({ alert_id: 'QA-7', email_status: 'sent', email_thread: 'th1', fields: { issue_name: name } }, extra || {});
    const fields = { issue_name: VARIANT, exposure_tag: TAG };
    const fu = (by, outcome, extra) => Object.assign({ by, confidence: 0.9, original: { issue_name: 'Followed-up issue', outcome, alert_id: 'QA-8' } }, extra || {});
    const ki = { matches: true, entry: { issue_name: FINLAND, n: 1 }, confidence: 0.9 };
    const of = (review, related, known, similar) => {
      const x = B.existingIssueOf_(Object.assign({ fields }, review), related, known || ISSUES, similar);
      return x && [x.name, x.by];
    };
    eq(of({ followUp: fu('ai', 'alerted'), knownIssue: ki }, row('Thread issue')), ['Thread issue', 'thread']);
    eq(of({ followUp: fu('ai', 'alerted'), knownIssue: ki }, row('Thread issue', { email_status: 'drafted' })), ['Followed-up issue', 'follow_up']);
    eq(of({ followUp: fu('ai', 'not alerted'), knownIssue: ki }), [FINLAND, 'gemini']);
    eq(of({ followUp: fu('ai', 'alerted', { confidence: 0.5 }), knownIssue: ki }), [FINLAND, 'gemini']);
    eq(of({}, null, null, row('Similar issue', { mirrored: '\ud83d\udcf0' })), ['Similar issue', 'similar']);
    eq(of({}, null, null, row('Similar issue', { email_status: '', mirrored: '\u274c' })), null);
    eq(of({ knownIssue: { matches: true, issue_name: 'A paraphrase', confidence: 0.9 } }), null);  // only names really alerted
    eq(of({ knownIssue: { matches: true, issue_name: FINLAND.toUpperCase(), confidence: 0.9 } }), [FINLAND, 'gemini']);
    eq(B.existingIssueOf_({ fields: { issue_name: ` ${FINLAND.toLowerCase()} `, exposure_tag: TAG } }, null, ISSUES).by, 'name');
    // the fix it makes, and the reason a person can read (never an alert id)
    const ex = B.existingIssueOf_({ fields, knownIssue: ki }, null, ISSUES);
    assert.ok(!/QA-|\[K/.test(ex.why), ex.why);
    eq(B.withExistingIssue_({ issue_name: VARIANT, issue_status: NEW, alert_name: `${VARIANT} / ${NEW}`, product: 'Data Centers' }, ex),
      { issue_name: FINLAND, issue_status: 'Ongoing Issue', alert_name: `${FINLAND} / Ongoing Issue`, product: 'Data Centers' });
    eq(B.withExistingIssue_({ issue_name: FINLAND, issue_status: 'Recently Reported' }, ex).issue_status, 'Ongoing Issue');
    eq([B.issueRenamed_({ issue_name: VARIANT }, ex), B.issueRenamed_({ issue_name: ` ${FINLAND} ` }, ex)], [true, false]);
    // Gemini's call: a listed issue at the bar, else nothing
    const list = B.recentKnownIssues_({ issue_name: VARIANT, exposure_tag: TAG }, [], ISSUES, [], NOW);
    const n = list.find(x => x.issue_name === FINLAND).n;
    eq(B.knownIssueCall_({ known_issue: { matches: true, issue_n: n, confidence: 0.9 } }, list, 0.85).issue_name, FINLAND);
    eq(B.knownIssueCall_({ known_issue: { matches: true, issue_n: n, confidence: 0.8 } }, list, 0.85), null);
    eq(B.knownIssueCall_({ known_issue: { matches: true, issue_name: FINLAND.toLowerCase(), confidence: 0.9 } }, list, 0.85).entry.n, n);
    eq(B.knownIssueCall_({ known_issue: { matches: false, issue_n: n, confidence: 0.99 } }, list, 0.5), null);
    eq(B.existingIssuesPrompt_([]), '');
  });

  test('one name per issue, the bot\'s own alerts: a watch or other-format alert and an Early Detection signal that Gemini matched to an issue already alerted carry that issue\'s name (not Gemini\'s new wording) and Ongoing Issue; with no match they keep their own', () => {
    const parsed = { fields: { post_url: 'https://www.reddit.com/r/europe/comments/1p0abcd/finland_forest/', issue_name: 'Google datacentre deforestation in Finland',
      exposure_tag: TAG }, knownIssues: B.recentKnownIssues_({ issue_name: 'Google datacentre deforestation in Finland' }, [], ISSUES, [], NOW), earlier: [] };
    const entry = parsed.knownIssues.find(x => x.issue_name === FINLAND);
    const ki = { matches: true, entry, issue_n: entry.n, issue_name: FINLAND, adds_new: false, confidence: 0.9, reason: 'same story' };
    const otherFields = Object.assign({}, parsed.fields);
    const other = B.otherReview_(parsed, { knownIssue: ki, teamReasons: {} }, otherFields, null, NOW);
    eq([other.fields.issue_name, other.fields.issue_status, other.existingIssue.by, otherFields.issue_name], [FINLAND, 'Ongoing Issue', 'gemini', FINLAND]);
    const edFields = Object.assign({}, parsed.fields);
    const ed = B.edBuildReview_(parsed, { knownIssue: ki, teamReasons: {} }, edFields, null, NOW);
    eq([ed.fields.issue_name, ed.fields.issue_status, ed.existingIssue.by], [FINLAND, 'Ongoing Issue', 'gemini']);
    const own = B.otherReview_(parsed, { knownIssue: null, teamReasons: {} }, Object.assign({}, parsed.fields), null, NOW);
    eq([own.fields.issue_name, own.existingIssue], ['Google datacentre deforestation in Finland', null]);
  });

  test('one name per issue, right before a Social Alert is drafted: an email that replies on an earlier alert\'s sent thread goes out under that alert\'s issue name (the review\'s fields take it too, and the run log says so); a thread that was never sent ties nothing', () => {
    const logs = [];
    const ctx = { log: l => logs.push(l), switches: {}, flowTag: '', now: () => NOW };
    const related = { alert_id: 'QA-41', email_status: 'sent', email_thread: 'th-finland', email_message_id: '<m41@mail.test>',
      email_subject: `\ud83d\udfe7SOCIAL ALERT\ud83d\udfe7: Data Centers | ${FINLAND} | X | 2063 Engagements`, fields: { issue_name: FINLAND } };
    const esc = B.escalation_({ issue_name: VARIANT, exposure_tag: TAG, product: 'Data Centers', total_engagement: 2312, kof: true }, { status: 'ONGOING', now: NOW });
    const review = { fields: { issue_name: VARIANT, issue_status: 'Ongoing Issue', exposure_tag: TAG, product: 'Data Centers', total_engagement: 2312 } };
    const row = B.draftRowFor_(ctx, review, esc, related);
    eq([row.email_input.fields.issue_name, row.email_input.escalation.issue_name, review.fields.issue_name, row.email_thread], [FINLAND, FINLAND, FINLAND, 'th-finland']);
    assert.ok(logs.some(l => l.startsWith(`Social Alert issue name: "${FINLAND}", the existing issue's (its Social Alert replies on that issue's email, QA-41), not "${VARIANT}"`)), logs.join('\n'));
    const unsent = { fields: { issue_name: VARIANT, exposure_tag: TAG, product: 'Data Centers' } };
    const row2 = B.draftRowFor_(ctx, unsent, esc, Object.assign({}, related, { email_status: 'drafted' }));
    eq(row2.email_input.fields.issue_name, VARIANT);
  });
};
