// Work directly in B25 (Control row 32, Main.gs directB25For_ / directCfg_) and alerts in other formats (OtherAlerts.gs).
// With row 32 ON and B25 a space only Google people can join, the bot works right in B25, as in a Mirror space, always
// Testing. An alert in another format there (a monitoring tool's "🚨 X Alert: <stream> - <sentiment> 🚨") gets its own
// triage, the SLRR rules first, and is never answered as if it were a question; a question in an alert's thread gets the
// analysts' answer. The real S-F Burson (people outside Google can join it) is never worked this way, and Burson's own
// alerts keep exactly their review.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, e2e, REAL, TEST_FEED, TRIAGED } = H;
  const MID = 'spaces/AAQAmidterm1';
  const MID_NAME = 'Midterms 2026';
  const BOTACCT = { sender: 'users/bot', displayName: 'Lucas Hammonds' };  // the stream's tool posts as the bot's account
  const ANNA = { sender: 'users/analyst7', displayName: 'Anna Lee' };
  const POST = 'https://x.com/CorrDove/status/1980000000000000001';
  const TEXT = '@ewarren How much did your donors pay to rig the midterms? You blame Google but you\'re being busted in it.';

  /** A Midterms-stream alert as its tool posts it: the post's link is only in formattedText ("Click to view post"). */
  const midterms = o => {
    const v = Object.assign({ net: 'X', sentiment: 'Negative', author: '@CorrDove', followers: '1.7K', engagement: 'Very Low (0-199)',
      text: TEXT, url: POST }, o || {});
    const body = link => [`🚨 *${v.net} Alert: 2026 Midterm Elections / Civics - ${v.sentiment}* 🚨`, '', `*Author:* ${v.author}`,
      `*Followers:* ${v.followers}`, `*Engagement:* ${v.engagement}`, `*Sentiment:* ${v.sentiment}`, `*Text:* _"${v.text}"_`, '',
      link, '', '_⚠️ *Disclaimer:* These alerts are fully automated._'].join('\n');
    return { text: body('Click to view post'), formattedText: body(`<${v.url}|Click to view post>`) };
  };
  const say = (t, alert, who) => t.chat.say(MID, alert.text, Object.assign({ formattedText: alert.formattedText }, who || BOTACCT));
  /** Gemini's triage (FakeVertex.triage): a low-reach, SLRR-type post the stream wouldn't act on, unless `o` says otherwise. */
  const triage = o => () => Object.assign({
    summary: 'An X reply (@CorrDove, 1.7K followers) accusing donors of rigging the midterms and claiming Google is "being busted in it."',
    issue_name: 'Election-rigging claim naming Google',
    stream_fit: 'An election-rigging conspiracy claim that names Google, with no evidence and very low reach.',
    risks: ['misinformation', 'election_integrity'],
    stream_call: { action: 'no_action', severity: 'low', confidence: 0.85, reason: 'A low-reach conspiracy claim nobody is picking up',
      watch_for: 'A KOF or 2,000+ engagements amplifying it, or press pickup' },
    slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Brand - Conspiratorial theories about Google', product: 'Brand',
      sensitive_topics: [], warranted: false, warranted_confidence: 0.9, why: 'Routine fringe grumbling' },
    tns: { needed: false },
  }, o || {});
  /** setup(), B25 a Google-only space (Midterms 2026) and row 32 ON, one run. */
  const directWorld = () => {
    const t = e2e();
    t.chat.addSpace(MID, MID_NAME);
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.set('B25', MID);
    t.control().getRange(32, 2).setValue('ON');
    t.poll();
    return t;
  };
  const inThread = (t, msg) => t.chat.botPosts(MID).filter(p => p.thread.name === msg.thread.name && p.name !== msg.name);
  const alertRow = (t, msg) => t.bot.sheetBackend_(t.sheet()).loadAlerts().find(r => r.source_message === msg.name);
  const callsWith = (t, prop) => t.g.vertex.calls.filter(c => ((c.payload.generationConfig.responseSchema || {}).properties || {})[prop]);

  test('other alerts: otherAlertOf_ reads a monitoring tool\'s alert ("🚨 X Alert: <stream> - <sentiment> 🚨", Author, Followers, Engagement, Sentiment, Text; the post\'s link from the message\'s own links); Burson\'s alerts, a Zapier post and chatter are never one', () => {
    const a = midterms();
    const o = B.otherAlertOf_(a.text, 'Lucas Hammonds', [POST]);
    eq([o.source, o.topic, o.sentiment, o.author, o.followers, o.network, o.url, o.text],
      ['X', '2026 Midterm Elections / Civics', 'Negative', '@CorrDove', 1700, 'X', POST, TEXT]);
    eq([o.engagement.level, o.engagement.min, o.engagement.max, o.engagement.count], ['VERY LOW', 0, 199, null]);
    eq(o.keys.slice().sort(), ['author', 'engagement', 'followers', 'sentiment', 'text']);
    // the link in the text itself (a pasted alert) works too; the platform comes from the link (or the header)
    const bsky = midterms({ net: 'BlueSky', sentiment: 'Neutral', author: '@someone.bsky.social',
      url: 'https://bsky.app/profile/someone.bsky.social/post/3abc' });
    const b = B.otherAlertOf_(bsky.formattedText, 'Lucas Hammonds');
    eq([b.network, b.sentiment, b.url], ['Bluesky', 'Neutral', 'https://bsky.app/profile/someone.bsky.social/post/3abc']);
    // engagement as tools write it: SLRR's levels and ranges
    const e = s => { const x = B.otherEngagementOf_(s); return [x.level, x.count, x.min, x.max]; };
    eq([e('High (2000+)'), e('1,234'), e('Moderate'), e('LOW (200-499)')],
      [['HIGH', null, 2000, null], ['MODERATE', 1234, null, null], ['MODERATE', null, 500, 1999], ['LOW', null, 200, 499]]);
    // never one: Burson's alerts (whoever posts them), any Zapier post, a question with a label or two, nothing about a post
    [F.P0_OK, F.MISTAKES, F.MAPS].forEach(x => eq(B.otherAlertOf_(x, 'Lucas Hammonds'), null));
    eq(B.otherAlertOf_(a.text, 'Zapier', [POST]), null);
    eq(B.otherAlertOf_('Author: me\nText: is this one worth escalating?', 'Anna Lee'), null);
    eq(B.otherAlertOf_('🚨 X Alert: Midterms 🚨\nAuthor: @a\nFollowers: 10', 'Lucas Hammonds'), null);
    eq(B.otherAlertOf_('', 'Lucas Hammonds'), null);
  });

  test('Work directly in B25 (row 32 ON, B25 Google-only): the Midterms alert that was answered like a Burson question (a "?" in its text) is triaged instead: its note in the alert\'s thread (the call, what it is, for the stream, the SLRR view), ❌, an Alert-log row marked Other alert; no answer, no email, nothing in any other space', () => {
    const t = directWorld();
    assert.match(t.control().cell(32, 3), /^✓ ON: B25 \(Midterms 2026\) is Google-only, so the bot works right in it/);
    assert.match(t.get('C29'), /^OFF · 🧪 Testing \(the bot works directly in B25, a Google-only space \(row 32\)\)/);
    assert.match(t.get('B5'), /right in B25 \(Midterms 2026\) · 🧪 Testing \(row 32\)$/);
    t.g.vertex.triage = triage();
    const alert = say(t, midterms());
    t.poll();
    const notes = inThread(t, alert);
    eq(notes.length, 1);
    const note = notes[0].text;
    assert.match(note, /^🤖 \*Triage: ❌ No action\* · low\n/);
    assert.match(note, /\n\*What it is:\* An X reply \(@CorrDove, 1\.7K followers\) accusing donors/);
    assert.match(note, /\n\*For 2026 Midterm Elections \/ Civics:\* An election-rigging conspiracy claim that names Google/);
    assert.match(note, /\n\*Risks:\* misinformation, election integrity\n/);
    assert.match(note, /\n\*Why:\* A low-reach conspiracy claim nobody is picking up\n/);
    assert.match(note, /\n\*SLRR view:\* Brand - Conspiratorial theories about Google \(P2\)\. Below the SLRR escalation bar: P2 needs 2,000\+ engagements, a KOF author or a Sensitive Topic; this one: engagement Very Low \(0-199\), not a KOF\./);
    assert.match(note, /\n\*Watch for:\* A KOF or 2,000\+ engagements amplifying it, or press pickup/);
    eq(t.chat.botReactions(alert.name), ['❌']);
    const row = alertRow(t, alert);
    eq([row.ingested, row.forward_message, row.email_status || '', String(row.decision).charAt(0)], ['Other alert', alert.name, '', '❌']);
    eq([row.forwarded_fields.triage.call, row.forwarded_fields.triage.stream], ['no_action', '2026 Midterm Elections / Civics']);
    assert.ok(t.g.logs.some(l => l === 'other alert: X · @CorrDove · 1,700 followers · Very Low (0-199) · 2026 Midterm Elections / Civics'));
    // the triage: never the Burson-facing answer, nor Burson's review
    eq([callsWith(t, 'stream_call').length, callsWith(t, 'answer').length, callsWith(t, 'checks').length], [1, 0, 0]);
    eq(t.g.gmail.sentMessages(), []);
    // nothing in any other space: the real S-F Burson, the test feed (B3), the analyst space (B4: setup()'s hello only)
    eq([t.chat.botPosts(REAL), t.chat.botPosts(TEST_FEED), t.chat.botPosts(TRIAGED).length], [[], [], 1]);
    t.poll();  // handled once
    eq([inThread(t, alert).length, callsWith(t, 'stream_call').length], [1, 1]);
  });

  test('Work directly in B25: a question in an alert\'s thread gets the analysts\' answer (the alert\'s triage in its context), posted right there; never the Burson-facing answer', () => {
    const t = directWorld();
    t.g.vertex.triage = triage();
    const alert = say(t, midterms());
    t.poll();
    t.chat.say(MID, 'Should we escalate this one?', Object.assign({ thread: alert.thread.name }, ANNA));
    t.poll();
    const answers = callsWith(t, 'answer');
    eq(answers.length, 1);
    const sys = answers[0].payload.systemInstruction.parts[0].text;
    const prompt = answers[0].payload.contents[0].parts.map(p => p.text || '').join('\n');
    assert.match(sys, /helping the Google SLRR Incident Manager \/ analyst/);
    assert.match(sys, /This alert came from another monitoring stream, not Burson/);
    assert.ok(!/You help the Burson team/.test(sys));
    assert.match(prompt, /\[Triage of this alert\]\nThis alert came from another monitoring stream \("2026 Midterm Elections \/ Civics"\), not Burson: the bot triaged it\.\nTriage call: no action \(❌\) \(basis: stream\), severity low: A low-reach conspiracy claim nobody is picking up/);
    eq(inThread(t, alert).map(p => p.text).slice(1), ['Happy to help with that.']);
  });

  test('Work directly in B25: an alert the SLRR rules escalate (Gemini sure of a P0 exposure tag: SLRR collects those at any engagement) gets a Social Alert with SLRR routing, sent only to the testers while Testing, whatever the stream\'s own call; its note says the SLRR rules sent it, and why', () => {
    const t = directWorld();
    t.g.vertex.triage = triage({
      stream_call: { action: 'flag', severity: 'medium', confidence: 0.7, reason: 'Claims Google rigs results for one party' },
      slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Brand - Perceived bias - brand', product: 'Brand', sensitive_topics: [],
        warranted: true, warranted_confidence: 0.8, why: 'A political-bias claim about Google' },
      recommended_groups: [{ code: 'gcpa', reason: 'A reputational claim about Google' }],
    });
    const alert = say(t, midterms());
    t.poll();
    const sent = t.g.gmail.sentMessages();
    eq(sent.length, 1);
    eq(sent[0].to, ['tester@testing.test']);
    assert.match(sent[0].subject, /SOCIAL ALERT/);
    const row = alertRow(t, alert);
    eq([row.ingested, row.email_status, row.email_input.escalation.reasons.includes('P0_TOPIC'),
      row.email_input.escalation.triage_basis], ['Other alert', 'sent', true, undefined]);  // the SLRR rules' own Social Alert
    const note = inThread(t, alert)[0].text;
    assert.match(note, /^🤖 \*Triage: 📦 Social Alert \(the SLRR rules\)\* · medium\n/);
    assert.match(note, /\n\*Why:\* the SLRR rules: P0 criteria \(Brand - Perceived bias - brand\)\n/);
    assert.match(note, /\n\*SLRR view:\* Brand - Perceived bias - brand \(P0\)\. Meets the SLRR escalation rules: P0 criteria/);
    const marks = t.chat.botReactions(alert.name);
    assert.ok(marks.length > 0 && !marks.includes('❌') && !marks.includes('👍'), marks.join(' '));  // the distros' emojis
  });

  test('Work directly in B25: the stream\'s own call sends a Social Alert for an alert that isn\'t SLRR-type only when Gemini is 90%+ sure (to the testers; its "Why" names the stream triage); the same post again gets no second email (❌ already escalated); a less sure escalate is a 👍 for a person', () => {
    const t = directWorld();
    const notSlrr = { is_slrr: false, confidence: 0.85, why: 'About election officials: Google is only a passing mention' };
    t.g.vertex.triage = triage({
      stream_call: { action: 'escalate', severity: 'high', confidence: 0.95, reason: 'A false polling-place claim spreading fast' },
      slrr: notSlrr, recommended_groups: [{ code: 'civics', reason: 'Election misinformation' }],
    });
    const first = say(t, midterms({ engagement: 'High (2000+)' }));
    t.poll();
    eq(t.g.gmail.sentMessages().length, 1);
    const row = alertRow(t, first);
    eq([row.email_status, row.email_input.escalation.reasons.includes('STREAM_TRIAGE'), row.email_input.escalation.triage_basis],
      ['sent', true, '2026 Midterm Elections / Civics: A false polling-place claim spreading fast']);
    eq(B.escalationWhyText_(row.email_input.escalation),
      'Stream triage: 2026 Midterm Elections / Civics: A false polling-place claim spreading fast · High engagement (2,000 on X)');
    const note = inThread(t, first)[0].text;
    assert.match(note, /^🤖 \*Triage: 📦 Social Alert \(the stream triage\)\* · high \(95% sure\)\n/);
    assert.match(note, /\n\*SLRR view:\* not an SLRR alert \(About election officials: Google is only a passing mention\)\./);
    assert.match(note, /\n\*Teams:\* Civics/);
    // the same post again: no second Social Alert
    const again = say(t, midterms({ engagement: 'High (2000+)' }));
    t.poll();
    eq(t.g.gmail.sentMessages().length, 1);
    assert.match(inThread(t, again)[0].text, /^🤖 \*Triage: ❌ Already escalated\*/);
    assert.match(inThread(t, again)[0].text, /\n\*Why:\* the same post was already alerted \(/);
    eq(t.chat.botReactions(again.name), ['❌']);
    // a less sure escalate: 👍, a person decides
    t.g.vertex.triage = triage({ stream_call: { action: 'escalate', severity: 'medium', confidence: 0.7, reason: 'Might be spreading' },
      slrr: notSlrr });
    const unsure = say(t, midterms({ url: 'https://x.com/CorrDove/status/1980000000000000002' }));
    t.poll();
    eq([t.g.gmail.sentMessages().length, t.chat.botReactions(unsure.name)], [1, ['👍']]);
    assert.match(inThread(t, unsure)[0].text, /^🤖 \*Triage: 👍 Worth a look\* · medium \(70% sure\)\n/);
    assert.match(inThread(t, unsure)[0].text, /\n\*Why:\* Might be spreading \(70% sure, so a person decides\)/);
  });

  test('Work directly in B25: rules that would escalate it on a count the bot can\'t tell (a Sensitive Topic, engagement 0-199, no count) or on an SLRR view Gemini isn\'t sure of get 👍 for a person, never ❌ or an email; Gemini without its call: 👍, "Needs a person"', () => {
    const t = directWorld();
    t.g.vertex.triage = triage({ slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Brand - Conspiratorial theories about Google',
      product: 'Brand', sensitive_topics: ['Politics'], warranted: false, warranted_confidence: 0.6 } });
    const one = say(t, midterms());
    t.poll();
    eq([t.chat.botReactions(one.name), t.g.gmail.sentMessages().length], [['👍'], 0]);
    const note = inThread(t, one)[0].text;
    assert.match(note, /^🤖 \*Triage: 👍 Worth a look\* · low\n/);
    assert.match(note, /\n\*Why:\* the SLRR rules would escalate it \(Sensitive topic \(Politics\)\) if it has 100\+ engagements: check its count\n/);
    assert.match(note, /\n\*SLRR view:\* Brand - Conspiratorial theories about Google \(P2\), Sensitive: Politics\. The SLRR rules escalate it with 100\+ engagements \(Sensitive topic \(Politics\)\); this one: engagement Very Low \(0-199\)\./);
    // an SLRR view Gemini is only 60% sure of: what the rules would do with it is for a person to check
    t.g.vertex.triage = triage({ slrr: { is_slrr: true, confidence: 0.6, exposure_tag: 'Brand - Perceived bias - brand', product: 'Brand' } });
    const two = say(t, midterms({ url: 'https://x.com/CorrDove/status/1980000000000000003' }));
    t.poll();
    eq([t.chat.botReactions(two.name), t.g.gmail.sentMessages().length], [['👍'], 0]);
    assert.match(inThread(t, two)[0].text, /\n\*Why:\* it may be an SLRR alert \(Brand - Perceived bias - brand, 60% sure\) that the SLRR rules would escalate \(P0 criteria \(Brand - Perceived bias - brand\)\)/);
    assert.match(inThread(t, two)[0].text, /\n\*SLRR view \(unsure, 60%\):\* Brand - Perceived bias - brand \(P0\)\. Meets the SLRR escalation rules: P0 criteria/);
    // Gemini's answer without its call: a person decides, with what the alert says
    t.g.vertex.triage = null;
    const three = say(t, midterms({ url: 'https://x.com/CorrDove/status/1980000000000000004' }));
    t.poll();
    eq([t.chat.botReactions(three.name), t.g.gmail.sentMessages().length], [['👍'], 0]);
    assert.match(inThread(t, three)[0].text, /^🤖 \*Triage: 👍 Needs a person\*\n\*What it is:\* X · @CorrDove · 1,700 followers · engagement Very Low \(0-199\)\n\*Why:\* the AI triage failed, so a person decides \(no call in its answer\)/);
  });

  test('Work directly in B25: an alert in Burson\'s format, whoever pastes it there, gets Burson\'s own review (never the triage); a person\'s chatter is neither an alert nor a question', () => {
    const t = directWorld();
    t.g.vertex.triage = triage();
    const burson = t.chat.say(MID, F.P0_OK, ANNA);
    t.chat.say(MID, 'Morning all, quiet so far', ANNA);
    t.poll();
    const row = alertRow(t, burson);
    eq([!!row, row && String(row.ingested || '')], [true, '']);
    eq([callsWith(t, 'checks').length, callsWith(t, 'stream_call').length, callsWith(t, 'answer').length], [1, 0, 0]);
  });

  test('other alerts: one a person pastes in any other flow (the test feed here) is never answered as if it were a question, and isn\'t triaged there', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.poll();
    t.chat.say(TEST_FEED, midterms().text, ANNA);
    t.poll();
    eq([t.chat.botPosts(TEST_FEED), callsWith(t, 'answer').length, callsWith(t, 'stream_call').length], [[], 0, 0]);
  });

  test('Work directly in B25: OFF on a new tab; never the real S-F Burson (people outside Google can join it): ON there, C32 says it isn\'t used and the run is as with it OFF; directB25For_ fails closed; a Google-only B25 is never LIVE, whatever row 32 says', () => {
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    eq([t.control().cell(32, 2), t.bot.readControl_(t.control()).switches.directB25], ['OFF', false]);
    t.set('B25', REAL);
    t.control().getRange(32, 2).setValue('ON');
    t.poll();
    assert.match(t.control().cell(32, 3), /^✓ ON, but not used: people outside Google can join B25 \(\[S-F\] Burson Automated Alerts V3\)/);
    const state = (on, space) => t.bot.directB25For_({ directB25: on }, { space }).state;
    eq([state(true, { id: REAL, name: 'S-F', externalUserAllowed: true }), state(true, { id: MID, name: MID_NAME, externalUserAllowed: false }),
      state(true, null), state(false, { id: MID, externalUserAllowed: false }), state(true, { id: MID })],
    ['outside', 'on', 'waiting', 'off', 'outside']);  // not known to be Google-only: as the real S-F Burson
    // the main flow as before: B3's alert reaches B4; nothing in S-F Burson
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    t.poll();
    eq([t.chat.botPosts(TRIAGED).length >= 2, t.chat.botPosts(REAL)], [true, []]);
    // a Google-only B25 is never LIVE (runMode_), even with the Safety valve OFF and B26 blank
    eq(t.bot.runMode_(t.bot.switchesOff_(), '', { id: MID, externalUserAllowed: false }, { outboundBlocked: true, burson: { id: MID } }),
      { live: false, why: 'S-F Burson, B25, is a Google-only space: the real S-F Burson lets people outside Google join' });
  });

  test('other alerts: never in the SLRR tables (Write back to SLRR BigQuery leaves them out, even ON) nor on the Results tab; Burson\'s alerts keep their review prompt, other alerts get the triage prompt; the triage\'s reason goes only on its own Social Alerts', () => {
    const ctx = { switches: { writeBackBq: true }, log() {}, now: () => 0, memo: { get: () => null, set() {} } };
    eq(B.bqWriteBack_(ctx, { alert_id: 'QA-9', ingested: 'Other alert' }, 'decided', {}), false);
    eq(B.resultsBursonRows_([{ alert_id: 'a', ingested: 'Other alert' }, { alert_id: 'b', ingested: '' }]).map(r => r.alert_id), ['b']);
    const slrr = B.assessPrompts_(B.parseAlert_(F.P0_OK), null);
    assert.ok(slrr.schema.properties.checks && !slrr.schema.properties.stream_call);
    const other = B.otherAlertOf_(midterms().text, 'Lucas Hammonds', [POST]);
    const p = B.assessPrompts_({ kind: 'other', other, fields: B.otherBaseFields_(other) }, null);
    assert.ok(p.schema.properties.stream_call && !p.schema.properties.checks);
    assert.match(p.system, /THE STREAM: "2026 Midterm Elections \/ Civics" \(X alerts\), labelled Negative by the tool\./);
    assert.match(p.system, /\nSLRR VIEW \(slrr\): /);
    assert.match(p.prompt, /"author":"@CorrDove"/);
    eq(B.emailInput_({ issue_name: 'x' }, { reasons: ['P0_TOPIC'] }).escalation.triage_basis, undefined);
    eq(B.escalationWhyText_({ reasons: ['STREAM_TRIAGE'], triage_basis: 'Midterms: spreading' }), 'Stream triage: Midterms: spreading');
  });
};
