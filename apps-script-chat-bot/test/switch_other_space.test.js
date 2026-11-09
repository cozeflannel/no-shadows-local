// The Other alerts space (Control tab B33, OtherSpace.gs): a Google-only space the bot works every minute beside the
// Mirror space, always Testing. B25 stays the real S-F Burson, so Zapier's alerts keep coming into the Mirror space and the
// bot works them there exactly as before, while each alert in the Other alerts space gets its own triage (or, in Burson's
// format, Burson's review) right there. Nothing from it reaches S-F Burson, the Burson test copy or the Burson outbox,
// nothing from it goes in the SLRR tables, and the Results, Follow-up and Analysis tabs leave its alerts out.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, e2e, REAL, TEST_FEED, TRIAGED, VENDOR } = H;
  const MID = 'spaces/AAQAmidterm1';
  const MID_NAME = 'Midterms 2026';
  const MID_LINK = 'https://chat.google.com/app/chat/AAQAmidterm1';
  const MIRROR = 'spaces/AAQAmirror1';
  const MIRROR_NAME = 'SLRR Zapier Training Mirror';
  const ROOM = 'https://chat.google.com/room/AAQAaa_0I9g';  // S-F Burson: people outside Google can join it
  const ZAP = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const BOTACCT = { sender: 'users/bot', displayName: 'Lucas Hammonds' };  // the stream's tool posts as the bot's account
  const ANNA = { sender: 'users/analyst7', displayName: 'Anna Lee' };
  const POST = 'https://x.com/CorrDove/status/1980000000000000001';
  const TEXT = '@ewarren How much did your donors pay to rig the midterms? You blame Google but you\'re being busted in it.';
  const OWN = 'Paste a separate Google-only space.';

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
  // Gemini sure it's a P0 exposure tag: the SLRR rules escalate it at any engagement (SLRR collects P0 at any count)
  const P0 = {
    stream_call: { action: 'flag', severity: 'medium', confidence: 0.7, reason: 'Claims Google rigs results for one party' },
    slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Brand - Perceived bias - brand', product: 'Brand', sensitive_topics: [],
      warranted: true, warranted_confidence: 0.8, why: 'A political-bias claim about Google' },
    recommended_groups: [{ code: 'gcpa', reason: 'A reputational claim about Google' }],
  };

  /**
   * setup(); S-F Burson in B25; the Mirror space (B9) copying its Zapier alerts; Midterms 2026 in B33; one run. Testing
   * (the Safety valve ON) unless `live`: then the main run is 🔴 LIVE (B26 blank, the Safety valve OFF).
   */
  const bothWorld = opts => {
    const o = opts || {};
    const t = e2e();
    t.chat.addSpace(MID, MID_NAME);
    t.chat.addSpace(MIRROR, MIRROR_NAME);
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.set('B25', ROOM);
    t.bot.startMirror(MIRROR_NAME);
    if (!o.live) t.control().getRange(29, 2).setValue('ON');
    t.control().getRange(33, 2).setValue(MID_LINK);
    t.poll();
    return t;
  };
  const inThread = (t, msg) => t.chat.botPosts(MID).filter(p => p.thread.name === msg.thread.name && p.name !== msg.name);
  const rows = t => t.bot.sheetBackend_(t.sheet()).loadAlerts();
  const alertRow = (t, msg) => rows(t).find(r => r.source_message === msg.name);
  const callsWith = (t, prop) => t.g.vertex.calls.filter(c => ((c.payload.generationConfig.responseSchema || {}).properties || {})[prop]);
  /** Every write call that reached Chat for S-F Burson (posts, replies, reactions), whether it worked or not. */
  const writes = t => t.chat.calls.filter(c => c.method !== 'get' && String(c.path).indexOf(REAL) === 0);
  const outbox = t => {
    const tab = t.sheet().getSheetByName('Burson outbox');
    return tab ? tab.rows.slice(1) : [];
  };
  const PART = `${MID} > (isolated) (other alerts)`;

  test('Other alerts space (B33): both at once. S-F Burson\'s Zapier alert is copied into the Mirror space and worked there exactly as before, and the Midterms alert in the Other alerts space gets its triage right there (its note, ❌), in the same run; nothing from either lands anywhere else; C33 says how it\'s doing, always Testing', () => {
    const t = bothWorld();
    eq(t.control().cell(33, 3), '✓ Midterms 2026 · 🧪 Testing · no alerts yet today');
    t.g.vertex.triage = triage();
    t.chat.say(REAL, F.P0_OK, ZAP);
    const alert = say(t, midterms());
    t.poll();
    // the Mirror space: Zapier's alert, copied and given Burson's review there, as before
    const copy = t.chat.botPosts(MIRROR).find(m => !m.threadReply && m.text === F.P0_OK);
    assert.ok(copy, 'the Mirror space has its copy');
    const mirrorRow = alertRow(t, copy);
    eq([!!mirrorRow, mirrorRow && String(mirrorRow.ingested || ''), mirrorRow && mirrorRow.space], [true, '', `${MIRROR} > (isolated)`]);
    assert.ok(callsWith(t, 'checks').length >= 1, 'Burson\'s review for Zapier\'s alert');
    // the Other alerts space: the triage, in the alert's thread, and ❌; its row in its own partition
    const notes = inThread(t, alert);
    eq(notes.length, 1);
    assert.match(notes[0].text, /^🤖 \*Triage: ❌ No action\* · low\n/);
    assert.match(notes[0].text, /\n\*For 2026 Midterm Elections \/ Civics:\* An election-rigging conspiracy claim that names Google/);
    eq(t.chat.botReactions(alert.name), ['❌']);
    const row = alertRow(t, alert);
    eq([row.ingested, row.space, row.forwarded_fields.triage.call], ['Other alert', PART, 'no_action']);
    eq(callsWith(t, 'stream_call').length, 1);
    // nothing anywhere else: no write in S-F Burson, nothing of the Midterms alert in the Mirror space, only its note in Midterms
    eq([writes(t), t.chat.botPosts(MIRROR).filter(p => /Triage:|CorrDove/.test(p.text)), t.chat.botPosts(MID).length], [[], [], 1]);
    eq(t.control().cell(33, 3), '✓ Midterms 2026 · 🧪 Testing · today: 1 alert (1 in other formats), 0 Social Alerts to the testers, 0 questions answered');
    assert.match(t.get('C9'), /^✓ SLRR Zapier Training Mirror/);  // the Mirror space carries on as before
    eq(t.get('B5'), '✅ Working');  // the Other alerts space never touches the main Status
    eq([t.bot.status().other_alerts_space, t.bot.status().other_alerts_status], [MID_LINK, t.control().cell(33, 3)]);
    t.poll();  // handled once
    eq([inThread(t, alert).length, callsWith(t, 'stream_call').length], [1, 1]);
  });

  test('Other alerts space: always Testing, even while the bot is LIVE. An alert the SLRR rules escalate there gets its Social Alert only to the testers, its subject starting "[Other alerts space]"; every email from it goes only to the testers; the main run stays LIVE (its mode is put back after the space\'s run)', () => {
    const t = bothWorld({ live: true });
    assert.match(t.get('B5'), /^🔴 LIVE · /);
    t.g.vertex.triage = triage(P0);
    const alert = say(t, midterms());
    t.poll();
    const sent = t.g.gmail.sentMessages();
    assert.ok(sent.length >= 1, 'the Social Alert went out');
    sent.forEach(m => eq(m.to, ['tester@testing.test'], m.subject));
    sent.forEach(m => assert.match(m.subject, /^\[Other alerts space\] /, m.subject));
    const social = sent.filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(social.length, 1);
    const row = alertRow(t, alert);
    eq([row.email_status, row.email_input.escalation.reasons.includes('P0_TOPIC'), row.space], ['sent', true, PART]);
    assert.match(inThread(t, alert)[0].text, /^🤖 \*Triage: 📦 Social Alert \(the SLRR rules\)\* · medium\n/);
    eq(t.bot.runLiveSetting_(), true);  // the main run's mode, put back once the Other alerts space was done
    assert.match(t.get('B5'), /^🔴 LIVE · /);
    assert.match(t.control().cell(33, 3), /^✓ Midterms 2026 · 🧪 Testing · today: 1 alert \(1 in other formats\), 1 Social Alert to the testers, /);
    eq(writes(t), []);
  });

  test('Other alerts space: an alert in Burson\'s format there, whoever posts it, gets Burson\'s review right there; a question in an alert\'s thread gets the analysts\' answer there; LIVE with Post in S-F Burson ON, nothing from it is queued on the Burson outbox or written in S-F Burson', () => {
    const t = bothWorld({ live: true });
    t.control().getRange(24, 2).setValue('ON');  // Post in S-F Burson
    t.g.vertex.triage = triage();
    const burson = t.chat.say(MID, F.MISTAKES, ANNA);
    const alert = say(t, midterms());
    t.poll();
    const bRow = alertRow(t, burson);
    eq([!!bRow, bRow && String(bRow.ingested || ''), bRow && bRow.space], [true, '', PART]);
    assert.ok(t.chat.botPosts(MID).some(p => p.thread.name === burson.thread.name && p.name !== burson.name), 'its review, in its thread');
    t.chat.say(MID, 'Should we escalate this one?', Object.assign({ thread: alert.thread.name }, ANNA));
    t.poll();
    const answers = callsWith(t, 'answer');
    eq(answers.length, 1);
    assert.match(answers[0].payload.systemInstruction.parts[0].text, /helping the Google SLRR Incident Manager \/ analyst/);
    eq(inThread(t, alert).map(p => p.text).slice(1), ['Happy to help with that.']);
    eq([outbox(t), writes(t)], [[], []]);
  });

  test('Other alerts space: refused (✗ and what to fix in C33; nothing read there) when it is the space in B25, a space people outside Google can join, a space the main run works in (B3, B4), the Auto-correct space (B10), the Burson test copy (B26) or the Mirror space (B9), one the bot can\'t open, or a name no space has; the main run carries on as before', () => {
    const t = e2e();
    const AC = 'spaces/AAQAautofx1';
    const COPY = 'spaces/AAQAtestcp1';
    t.chat.addSpace(MID, MID_NAME);
    t.chat.addSpace(MIRROR, MIRROR_NAME);
    t.chat.addSpace(AC, 'SLRR Auto-correct Test');
    t.chat.addSpace(COPY, 'SLRR Test Router');
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.set('B25', ROOM);
    t.poll();
    const c33 = v => { t.control().getRange(33, 2).setValue(v); t.poll(); return t.control().cell(33, 3); };
    eq(c33(REAL), `✗ The Other alerts space can't be the space in B25 (S-F Burson). ${OWN}`);
    eq(c33('[S-F] Burson Automated Alerts V3'), `✗ The Other alerts space can't be the space in B25 (S-F Burson). ${OWN}`);
    eq(c33(VENDOR), '✗ "Shared With Vendors" allows people outside Google, so Burson could see it. Use a space only Google people can join.');
    // the main run's own spaces (B3 → B4 here): it reviews B3's alert as before, once
    t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
    eq(c33(TEST_FEED), `✗ The Other alerts space must be a space of its own, not the Burson space (B3), which the bot already works in. ${OWN}`);
    eq(callsWith(t, 'checks').length, 1);
    eq(c33(TRIAGED), `✗ The Other alerts space must be a space of its own, not the analyst space (B4), which the bot already works in. ${OWN}`);
    eq(c33('spaces/NOPENOPE123'), '\u2717 Can\'t open the Other alerts space (spaces/NOPENOPE123). Check the link, and that bot@runner.test is a member of that space.');
    eq(c33('No Such Space'), '✗ No space named "No Such Space" (Other alerts space). Paste the space\'s link instead.');
    t.set('B10', 'SLRR Auto-correct Test');
    eq(c33(AC), `✗ The Other alerts space must be a space of its own, not the Auto-correct space (B10). ${OWN}`);
    t.set('B10', '');
    t.set('B26', COPY);
    eq(c33(COPY), `✗ The Other alerts space must be a space of its own, not the Burson test copy (B26). ${OWN}`);
    t.set('B26', '');
    t.set('B9', MIRROR_NAME);
    eq(c33(MIRROR), `✗ The Other alerts space must be a space of its own, not the Mirror space (B9). ${OWN}`);
    // nothing was triaged or posted in any refused space by it, and the Midterms space works once it's pasted
    eq([callsWith(t, 'stream_call').length, t.chat.botPosts(MID)], [0, []]);
    eq(c33(MID_LINK), '✓ Midterms 2026 · 🧪 Testing · no alerts yet today');
    assert.ok(!/⚠️/.test(t.get('B5')), t.get('B5'));
  });

  test('Other alerts space: a new one starts from its last 15 minutes (nothing older is triaged); after a pause, from a minute ago (what came while the bot was OFF isn\'t); cleared, it stops (C33 says what to paste) and its name leaves the S-F Burson guards', () => {
    const t = e2e();
    t.chat.addSpace(MID, MID_NAME);
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    t.poll();
    t.g.vertex.triage = triage();
    const url = n => `https://x.com/CorrDove/status/198000000000000001${n}`;
    const old = say(t, midterms({ url: url(1) }));
    t.g.clock.now += 20 * 60e3;
    const recent = say(t, midterms({ url: url(2) }));
    t.g.clock.now += 5 * 60e3;
    t.control().getRange(33, 2).setValue(MID_LINK);
    t.poll();
    eq([inThread(t, old).length, inThread(t, recent).length], [0, 1]);
    eq(t.g.props.get('LAST_OS_NAME'), MID_NAME);
    assert.ok(t.bot.outboxGuard_(t.bot.readControl_(t.control())).terms.includes(MID_NAME));
    // paused: what comes meanwhile isn't triaged when the bot is back ON
    t.set('B2', 'OFF');
    t.poll();
    const during = say(t, midterms({ url: url(3) }));
    t.g.clock.now += 5 * 60e3;
    t.set('B2', 'ON');
    t.poll();
    const after = say(t, midterms({ url: url(4) }));
    t.poll();
    eq([inThread(t, during).length, inThread(t, after).length], [0, 1]);
    // cleared: nothing more is triaged there, C33 says what to paste, and its name is forgotten
    t.control().getRange(33, 2).setValue('');
    t.poll();
    const later = say(t, midterms({ url: url(5) }));
    t.poll();
    eq([inThread(t, later).length, t.control().cell(33, 3), t.g.props.get('LAST_OS_NAME'), t.g.props.get('LAST_OS_SPACE')],
      [0, B.ev('OS_HINT_'), undefined, undefined]);
    assert.ok(!t.bot.outboxGuard_(t.bot.readControl_(t.control())).terms.includes(MID_NAME));
  });

  test('Other alerts space: its rows are left out of the Results, Follow-up and Analysis tabs (resultsFlowOf_), nothing from it goes in the SLRR tables (even ON), it is never LIVE (its ctx, its DMs), its id and name are on the guards of what goes to S-F Burson, and B33 is read only on its own row', () => {
    eq([B.resultsFlowOf_({ space: PART }, { main: { partition: `${MIRROR} > (isolated)` } }), B.resultsFlowOf_({ space: PART }, {}),
      B.resultsFlowOf_({ space: `${MIRROR} > (isolated)` }, {})], ['', '', 'main']);
    const memo = { get: () => null, set() {} };
    eq(B.bqWriteBack_({ switches: { writeBackBq: true }, otherSpace: true, log() {}, now: () => 0, memo }, { alert_id: 'QA-9', ingested: '' },
      'decided', {}), false);
    const cfg = B.otherSpaceCfg_({ id: MID, name: MID_NAME, externalUserAllowed: false });
    eq([cfg.burson.id, cfg.analyst.id, cfg.outboundBlocked, cfg.sfBurson, cfg.direct, cfg.otherSpace, cfg.mode.live],
      [MID, MID, true, null, true, true, false]);
    const t = e2e();
    t.bot.setup();
    t.set('B30', 'tester@testing.test');
    // even told it's LIVE, its ctx isn't: Testing, its own partition and email tag, no S-F Burson
    const ctx = t.bot.buildCtx_(Object.assign({}, cfg, { mode: { live: true } }), t.sheet(), t.bot.switchesOff_());
    eq([ctx.live, ctx.drafts.live, ctx.drafts.standIn, ctx.otherSpace, ctx.direct, ctx.partition, ctx.flowTag, ctx.sfBurson],
      [false, false, 'tester@testing.test', true, true, PART, 'Other alerts space', null]);
    const lead = ((B.ev('GEN').leadership || {}).recipients || [])[0];
    if (lead) {
      const chat = t.bot.guardedChat_(Object.assign({}, cfg, { mode: { live: true }, testers: ['tester@testing.test'] }), {}, null);
      eq(chat.dm(lead, 'x', 'k'), false);  // the escalation-protocol DM never goes to the leads from it
    }
    // the guards of what goes to S-F Burson: its id from B33, its name once a run found it
    t.g.props.set('LAST_OS_NAME', MID_NAME);
    const terms = t.bot.outboxGuard_({ otherSpace: MID_LINK }).terms;
    assert.ok(terms.includes('AAQAmidterm1') && terms.includes(MID_NAME), terms.join(', '));
    assert.ok(B.outboxGuardHits_('it came up in the Midterms 2026 space', { terms }).length);
    const relayTerms = t.bot.relayGuard_({ spaces: { analyst: { id: TRIAGED, name: 'SLRR Triaged Alerts' } } }, { otherSpace: MID_LINK }).terms;
    assert.ok(relayTerms.includes('AAQAmidterm1') && relayTerms.includes(MID_NAME), relayTerms.join(', '));
    // B33 is read only on its own row: '' when A33 is something else (a tab from before it)
    const sh = t.control();
    sh.getRange(33, 2).setValue(MID_LINK);
    eq(t.bot.readControl_(sh).otherSpace, MID_LINK);
    sh.getRange(33, 1).setValue('Something else');
    eq(t.bot.readControl_(sh).otherSpace, '');
  });

  test('Other alerts space: cross-space memory & semantic known-issue matching — an issue escalated in the Mirror space appears in RECENT KNOWN / ONGOING ISSUES ([K1]) for B33, suppressing low-reach re-reports with ❌ Already escalated while isolating Gmail threads when stakes rise; and B33 test rows never suppress Mirror alerts', () => {
    const t = bothWorld();
    const MIRROR_URL = 'https://x.com/Voter1/status/1980000000000000701';
    const OTHER_DUP_URL = 'https://x.com/Voter2/status/1980000000000000702';
    const OTHER_KOF_URL = 'https://x.com/SenatorJane/status/1980000000000000703';
    // 1. Seed an escalated Mirror-space alert with a real Gmail thread ID ('th_mirror_live_1')
    t.bot.sheetBackend_(t.sheet()).appendAlert({
      alert_id: 'QA-201', space: `${MIRROR} > (isolated)`, record_key: B.recordKey_({ post_url: MIRROR_URL }),
      created_at: t.g.clock.now - 30 * 60e3, forward_message: `${MIRROR}/messages/m201`, email_status: 'sent',
      email_thread: 'th_mirror_live_1', email_message_id: '<msg1@mail.test>',
      email_subject: '⬛SOCIAL ALERT⬛: Search | Poll-hours AI Overview error in Ohio | X | 3,400 Engagements',
      forwarded_fields: { post_url: MIRROR_URL, author: '@Voter1', issue_name: 'Poll-hours AI Overview error in Ohio',
        product: 'Search', summary: 'Posts show an AI Overview giving the wrong poll closing hour for Ohio.' },
    });
    // 2. A different non-KOF author posts about the same known issue in B33 (<2K eng) -> Gemini matches [K1] -> ❌ Already escalated
    t.g.vertex.triage = triage({
      summary: 'Another X user (@Voter2, 900 followers) reposting the same Ohio poll-hours AI Overview screenshot.',
      issue_name: 'Poll-hours AI Overview error in Ohio',
      stream_call: { action: 'escalate', severity: 'medium', confidence: 0.88, reason: 'Election info claim' },
      slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Product - Factual inaccuracies (not dangerous/offensive)',
        product: 'AI Overviews', sensitive_topics: ['Politics'], warranted: true, warranted_confidence: 0.85,
        why: 'Election AI Overview' },
      known_issue: { matches: true, issue_n: 1, adds_materially_new: false, confidence: 0.93,
        reason: 'Same Ohio poll-hours AI Overview screenshot already escalated in [K1], low-reach non-KOF repost' },
    });
    const dupAlert = say(t, midterms({ author: '@Voter2', followers: '900', engagement: 'Very Low (0-199)', url: OTHER_DUP_URL,
      text: 'Look at Google AI Overview getting Ohio poll closing times wrong!' }));
    const sent0 = t.g.gmail.sentMessages().length;
    t.poll();
    const sysText = callsWith(t, 'stream_call').slice(-1)[0].payload.systemInstruction.parts.map(p => p.text || '').join('\n');
    assert.match(sysText, /RECENT KNOWN \/ ONGOING ISSUES/);
    assert.match(sysText, /\[K1\].*Poll-hours AI Overview error in Ohio/);
    assert.match(inThread(t, dupAlert)[0].text, /^🤖 \*Triage: ❌ Already escalated\*/);
    assert.match(inThread(t, dupAlert)[0].text, /Poll-hours AI Overview error in Ohio/);
    eq([t.chat.botReactions(dupAlert.name), t.g.gmail.sentMessages().length], [['❌'], sent0]);
    // 3. Now a KOF (@SenatorJane, KOF Yes / High engagement) amplifies the same known issue in B33 -> escalates as ONGOING,
    //    sends [Other alerts space] email ONLY to testers, and NEVER replies onto th_mirror_live_1!
    t.g.vertex.triage = triage({
      summary: 'Senator Jane (@SenatorJane, 450K followers) amplifies the Ohio poll-hours AI Overview screenshot (4,500 engagements).',
      issue_name: 'Poll-hours AI Overview error in Ohio',
      stream_call: { action: 'escalate', severity: 'high', confidence: 0.95, reason: 'KOF amplification above 2K engagements' },
      slrr: { is_slrr: true, confidence: 0.95, exposure_tag: 'Product - Factual inaccuracies (not dangerous/offensive)',
        product: 'AI Overviews', sensitive_topics: ['Politics'], warranted: true, warranted_confidence: 0.95,
        why: 'KOF + >2K amplification of ongoing issue' },
      known_issue: { matches: true, issue_n: 1, adds_materially_new: true, confidence: 0.95,
        reason: 'Major KOF amplification (4,500 engagements) of [K1]' },
      recommended_groups: [{ code: 'civics', reason: 'Midterms election info' }],
    });
    const kofAlert = say(t, midterms({ author: '@SenatorJane', followers: '450K', engagement: 'High (4,500)', url: OTHER_KOF_URL,
      text: 'Google must fix Ohio poll hours immediately!' }));
    t.poll();
    assert.match(inThread(t, kofAlert)[0].text, /^🤖 \*Triage: 📦 Social Alert/);
    const kofRow = alertRow(t, kofAlert);
    eq([kofRow.email_input.escalation.status, kofRow.email_thread === 'th_mirror_live_1'], ['ONGOING', false]);
    const newEmails = t.g.gmail.sentMessages().slice(sent0);
    assert.ok(newEmails.some(m => /^\[Other alerts space\] /.test(m.subject)), 'tagged [Other alerts space]');
    newEmails.forEach(m => {
      eq(m.to, ['tester@testing.test']);
      assert.notStrictEqual(m.threadId, 'th_mirror_live_1', 'never replies onto Mirror/LIVE Gmail thread');
    });
    // 4. Reverse isolation: an alert escalated in B33 NEVER suppresses the Mirror space when Zapier later posts the same URL
    const B33_FIRST_URL = 'https://x.com/NewVoice/status/1980000000000000799';
    t.bot.sheetBackend_(t.sheet()).appendAlert({
      alert_id: 'QA-209', space: PART, record_key: B.recordKey_({ post_url: B33_FIRST_URL }),
      created_at: t.g.clock.now - 5 * 60e3, forward_message: `${MID}/messages/m209`, email_status: 'sent',
      forwarded_fields: { post_url: B33_FIRST_URL, author: '@NewVoice', issue_name: 'B33 test escalation' },
    });
    const mirrorStore = t.bot.makeStore_(t.bot.sheetBackend_(t.sheet()), () => t.g.clock.now, `${MIRROR} > (isolated)`);
    eq(mirrorStore.recentForwarded(t.g.clock.now - 3600e3).some(r => r.record_key === B.recordKey_({ post_url: B33_FIRST_URL })), false);
  });

  test('Other alerts space: same-day SLRR BigQuery log & display-name vs URL @handle matching — slrr_first_alerted dated today counts in non-Burson flows, and display name "Rep. Bryan Lamont Arrington37" matches @RepBryan37 from its X URL', () => {
    const url = 'https://twitter.com/RepBryan37/status/2117280528001094065';
    const priorUrl = 'https://x.com/RepBryan37/status/2117000000000000001';
    const handles = B.authorHandles_('Rep. Bryan Lamont Arrington37', url, { author: '@RepBryan37' });
    assert.ok(handles.has('repbryan37') && handles.has('rep. bryan lamont arrington37'), Array.from(handles).join(', '));
    const now = Date.parse('2026-11-02T15:00:00Z');  // 2026-11-02 in ET
    const history = [{
      alert_id: 'QA-301', created_at: now - 3600e3, record_key: B.recordKey_({ post_url: priorUrl }),
      author: '@RepBryan37', email_status: 'sent',
      fields: { post_url: priorUrl, author: '@RepBryan37', issue_name: 'Prior claim', product: 'Android' },
    }];
    const bqToday = {
      slrr_first_alerted: '2026-11-02',
      slrr_issue_name: 'Play Services hidden files claim',
      slrr_product: 'Android',
    };
    // Burson flow (default opts): same-day SLRR log row is excluded (could be Burson's just-logged alert), while @RepBryan37 history matches!
    const bursonEarlier = B.earlierAlerts_({ post_url: url, author: 'Rep. Bryan Lamont Arrington37' }, history, bqToday, now, null);
    eq([bursonEarlier.some(e => e.same_post), bursonEarlier.length], [false, 1]);
    // OtherSpace / Watch flow ({ includeSameDayLog: true }): same-day SLRR log row DOES count as same_post: true + @RepBryan37 history matches!
    const otherEarlier = B.earlierAlerts_({ post_url: url, author: 'Rep. Bryan Lamont Arrington37' }, history, bqToday, now, null,
      { includeSameDayLog: true });
    eq([otherEarlier.some(e => e.same_post), otherEarlier.length], [true, 2]);
  });
};
