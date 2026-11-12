// KB & Guidance can start alerts (Control tab row 13, kbStartAlerts): Gemini can start a Social Alert the rules leave
// below the bar, only on a Guidance tab row or a Resources document it cites and quotes, and only when the quote checks
// out (Review.gs kbCitation_, Escalate.gs kbPromotion_, Drafts.gs escalationFor_).
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, NOW, world, e2e, plain, review, parse, MAPS_LOW, TEST_FEED } = H;

  // A correct alert below the escalation criteria (P2, 300 engagements, no KOF): today ❌, no Social Alert
  const LOW = MAPS_LOW.split('Product - Memes & humorous content').join('Product - Meme about Google products');
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const DRAFTS = { live: false, mailbox: 'im@ops.test', from: 'Brand Social <im@ops.test>' };  // no stand-in: a Gmail draft
  const ROW = 'Escalate every Street View post that shows a dog or another animal chasing the Google Maps car, whatever the engagement';
  const GUIDE = [{ source: 'tab', text: ROW, applies_to: 'Maps', until: '' }];
  const QUOTE = 'Escalate every Street View post that shows a dog or another animal chasing the Google Maps car';
  const G1 = { source: 'guidance', guidance_n: 1, document: null, quote: QUOTE };
  const BASIS = `Guidance: "${B.truncate_(ROW, 120)}"`;
  const PLAYBOOK = 'Escalation playbook\n\nMaps: Street View posts where the Google Maps car hits or chases an animal get a Social ' +
    'Alert, whatever the engagement. Copy the Maps comms team.\n\nDoodle complaints go to the Doodle team.';
  const KBASE = () => ({ docs: [
    { name: 'SLRR Collection Requirements', url: 'https://docs.google.com/document/d/1KbRequirementsDoc00001/edit', covers: 'The alert requirements',
      burson: true, label: 'Google Doc', text: 'SLRR Collection Requirements\n\nKOF: an author on any KOF list counts as a KOF.' },
    { name: 'Escalation playbook', url: 'https://docs.google.com/document/d/1KbEscalationPlaybookDoc01/edit', covers: 'Which team gets which alert',
      burson: false, label: 'Google Doc', text: PLAYBOOK },
  ] });
  const KB_QUOTE = 'Street View posts where the Google Maps car hits or chases an animal get a Social Alert, whatever the engagement';
  const ON = { kbStartAlerts: true };
  const ALL_OFF = () => B.switchesOff_();

  /** world(), with ctx.switches (world()'s own ctx has none: everything OFF). */
  const sim = opts => {
    const w = world(opts);
    if (opts && opts.switches) {
      const base = w.ctx;
      w.ctx = () => { const c = base(); c.switches = Object.assign({}, opts.switches); return c; };
    }
    return w;
  };
  /** Gemini: a confident "warranted" call, with `per` when given (and any other fields in `extra`). */
  const cite = (per, extra) => Object.assign({ checks: [], social_alert: Object.assign({ warranted: true, confidence: 0.95,
    reason: 'Street View posts like this get a Social Alert', signal_class: 'legitimate_nerve' }, per === undefined ? {} : { per }) }, extra || {});
  /** One alert through the bot: {w, msg, reactions, sent, drafts, row, logs, review: the review call's payload}. */
  const run = (opts, llm, text) => {
    const w = sim(Object.assign({ drafts: STAND_IN, guidance: GUIDE }, opts || {}));
    w.vertex.assess = typeof llm === 'function' ? llm : () => JSON.parse(JSON.stringify(llm));
    const msg = w.paste(text || LOW);
    const report = w.run();
    const call = w.vertex.calls.find(c => c.payload.generationConfig.responseSchema.properties.checks);
    return { w, msg, report, reactions: w.chat.botReactions(msg.name), sent: w.gmail.sentMessages(), drafts: w.gmail.allDrafts(),
      row: w.alertRows()[0], logs: w.g.logs, payload: call && call.payload };
  };
  const systemOf = payload => payload.systemInstruction.parts[0].text;
  const switchNote = w => (JSON.parse(w.g.props.get('SWITCH_NOTES') || '{}').kbStartAlerts || {}).text;
  /** Everything the run did that anyone could see or that was stored, to compare runs byte for byte. */
  const outcome = r => JSON.stringify({
    vertex: r.w.vertex.calls.map(c => c.payload), analyst: r.w.analystPosts().map(m => [m.text, m.threadReply]),
    burson: r.w.bursonPosts().map(m => m.text), reactions: r.reactions, analystReactions: r.w.analystPosts().map(m => r.w.chat.botReactions(m.name)),
    sent: r.sent.map(m => [m.to, m.subject, m.text, m.html]), drafts: r.drafts.map(d => [d.to, d.subject, d.text]), rows: r.w.alertRows(),
    logs: r.logs, props: Array.from(r.w.g.props.entries()), report: r.report,
  });

  test('KB & Guidance OFF (or no switches at all): the prompt, the schema, the review, the posts, the emails and the Alert log are exactly as before, even when Gemini cites a Guidance row', () => {
    // Gemini (as if it ignored the schema) says warranted and cites the Guidance row: OFF, nothing comes of it
    const llm = cite(G1, { knowledge_used: [{ document: 'Escalation playbook', used_for: 'the Maps rule' }] });
    const scenario = switches => run({ switches, knowledge: KBASE() }, llm);
    const absent = scenario(undefined);
    const off = scenario(ALL_OFF());
    const offExplicit = scenario({ kbStartAlerts: false });
    eq(outcome(off), outcome(absent));
    eq(outcome(offExplicit), outcome(absent));
    // ...and that is today's behaviour: ❌, no email, unnumbered guidance, no new paragraph, ASSESS_SCHEMA_ itself
    eq([absent.reactions, absent.sent.length, absent.drafts.length, absent.w.bursonPosts()], [['❌'], 0, 0, []]);
    const system = systemOf(absent.payload);
    assert.ok(system.includes(`\n- ${ROW} [applies to: Maps]`), 'the guidance line keeps its "- "');
    assert.ok(!/\[G\d+\]|STARTING A SOCIAL ALERT|social_alert\.per/.test(system));
    eq(absent.payload.generationConfig.responseSchema, plain(B.ev('ASSESS_SCHEMA_')));
    assert.ok(!('per' in B.ev('ASSESS_SCHEMA_').properties.social_alert.properties));
    assert.ok(!JSON.stringify(absent.row).includes('kb_basis') && !absent.logs.some(l => /cites|citation|started on what Gemini cited/.test(l)));
    eq([absent.w.g.props.has('KB_STARTS'), absent.w.g.props.has('SWITCH_NOTES')], [false, false]);
    // The pure parts with the switch OFF: the review has no `per`, the prompt and schema are the same objects as before
    const parsed = parse(LOW);
    parsed.guidance = GUIDE;
    const p = B.assessPrompts_(parsed, null);
    assert.strictEqual(p.schema, B.ev('ASSESS_SCHEMA_'));
    assert.strictEqual(B.assessSchema_(parsed), B.ev('ASSESS_SCHEMA_'));
    eq(B.guidancePrompt_(GUIDE), B.guidancePrompt_(GUIDE, false));
    eq(B.kbStartPrompt_(parsed), '');
    eq(Object.keys(review(LOW, { llm }).socialAlert), ['warranted', 'confidence', 'reason', 'signal_class', 'outrage_half_life']);
    const esc = B.escalation_(review(LOW, { llm }).fields, { now: NOW });
    eq(B.emailInput_(review(LOW).fields, esc), JSON.parse(JSON.stringify(B.emailInput_(review(LOW).fields, esc))));
    assert.ok(!('kb_basis' in B.emailInput_(review(LOW).fields, esc).escalation));
  });

  test('KB & Guidance OFF: an alert the rules escalate is untouched too (same prompt, same email, same Alert log row)', () => {
    const llm = cite(G1);
    const absent = run({}, llm, F.P0_OK);
    const off = run({ switches: ALL_OFF() }, llm, F.P0_OK);
    eq(outcome(off), outcome(absent));
    eq(absent.sent.length, 1);
    eq(absent.row.email_input.escalation.reasons.includes('KB_OR_GUIDANCE'), false);
  });

  test('KB & Guidance ON: a below-threshold alert gets its Social Alert on a Guidance tab row Gemini quotes (stand-in only while testing); analysts see why, Burson sees nothing new', () => {
    const r = run({ switches: ON }, cite(G1));
    // The prompt numbers the guidance and asks for the citation; the schema asks for social_alert.per
    const system = systemOf(r.payload);
    assert.ok(system.includes(`\n[G1] ${ROW} [applies to: Maps]`), system.slice(-3000));
    assert.match(system, new RegExp('STARTING A SOCIAL ALERT ON THE GUIDANCE TAB OR THE KNOWLEDGE BASE \\(social_alert\\.per\\): the rules ' +
      'escalate on P0 tags, Sensitive Topics, briefed topics, KOF authors and 2,000\\+ engagements\\.'));
    assert.match(system, /Otherwise `per` is null: never for your own judgment, the playbook, an email/);
    eq(r.payload.generationConfig.responseSchema.properties.social_alert.properties.per, plain(B.ev('KB_PER_SCHEMA_')));
    assert.ok(!('per' in B.ev('ASSESS_SCHEMA_').properties.social_alert.properties), 'ASSESS_SCHEMA_ itself never changes');
    // The Social Alert went out, to the stand-in only, with the alert's emojis instead of ❌
    eq(r.sent.map(m => m.to), [['tester@testing.test']]);
    assert.ok(r.reactions.includes('📦') && !r.reactions.includes('❌'), r.reactions.join(' '));
    const esc = r.row.email_input.escalation;
    eq([r.row.email_status, esc.track, esc.reasons, esc.kb_basis], ['sent', 'URGENT', ['KB_OR_GUIDANCE'], BASIS]);
    // ...and the email itself says nothing about the Guidance tab, the bot's reasons or the automation
    const email = r.sent[0];
    assert.ok(![email.text, email.html || '', email.subject].some(s => /Escalated per|Guidance|KB_OR_GUIDANCE|another animal chasing|Gemini/i.test(s)),
      email.text);
    // Analysts: the run log, the Results tab's reason, analyst answers; the leadership DM never fires for these
    assert.ok(r.logs.includes(`Gemini cites ${BASIS} for a Social Alert (quote checked)`), r.logs.join('\n'));
    assert.ok(r.logs.includes(`Social Alert started on what Gemini cited (the rules alone wouldn't): per ${BASIS}`));
    const info = B.resultsFlowInfo_(r.w.alertRows());
    eq([info.alerted, info.sent, info.why, B.resultsReason_(info)], [true, true, `Escalated per ${BASIS}`, `Escalated per ${BASIS}`]);
    eq(B.escalationWhyBullets_(esc), [`• Escalated per ${BASIS}`]);
    eq(r.report.leadership, undefined);
    // Burson: nothing posted, and its only marks are the legend emojis any sent Social Alert gets
    eq(r.w.bursonPosts(), []);
    // Column C of row 13: what it did today
    eq(switchNote(r.w), `1 started today · last per ${BASIS}`);
    eq(JSON.parse(r.w.g.props.get('KB_STARTS')).keys, ['reddit.com/comments/1abcde']);
    // One Gemini call, as with the switch OFF: nothing extra is asked of Vertex AI
    eq(r.w.vertex.calls.length, 1);
    assert.ok(systemOf(r.payload).length - systemOf(run({}, cite(G1)).payload).length < 1500);
  });

  test('KB & Guidance ON: without a stand-in it\'s a Gmail draft, and the analysts\' draft note says "Why: Escalated per …" (the draft itself doesn\'t)', () => {
    const r = run({ switches: ON, drafts: DRAFTS }, cite(G1));
    eq([r.drafts.length, r.sent.length, r.row.email_status], [1, 0, 'drafted']);
    const note = r.w.analystPosts().find(m => m.threadReply && /Social Alert draft is in Gmail Drafts/.test(m.text));
    assert.ok(note && note.text.includes(`\n- Why: Escalated per ${BASIS}\n`), note && note.text);
    const draft = r.drafts[0];
    assert.ok(![draft.text, draft.html || '', draft.subject].some(t => /Escalated per|KB_OR_GUIDANCE|Guidance|another animal chasing/.test(t)),
      draft.text);
    eq(r.reactions, ['👍']);  // waits on a person (the draft), as for any Social Alert draft
    eq(r.w.bursonPosts(), []);
  });

  test('KB & Guidance ON: a Resources document can start it too, when the quote is in that document as Gemini was given it ([n] or its name)', () => {
    const used = { knowledge_used: [{ document: 'Escalation playbook', used_for: 'Maps rule' }] };
    const doc = per => run({ switches: ON, knowledge: KBASE(), guidance: [] }, cite(per, used));
    const r = doc({ source: 'knowledge_base', guidance_n: null, document: 'Escalation playbook', quote: KB_QUOTE });
    eq([r.sent.length, r.row.email_input.escalation.kb_basis], [1, 'Escalation playbook']);
    eq(B.resultsReason_(B.resultsFlowInfo_(r.w.alertRows())), 'Escalated per Escalation playbook');
    assert.match(systemOf(r.payload), /STARTING A SOCIAL ALERT ON THE GUIDANCE TAB OR THE KNOWLEDGE BASE/);
    eq(doc({ source: 'knowledge_base', document: '[2]', quote: `“${KB_QUOTE.toUpperCase()}.”` }).sent.length, 1);  // [n], curly quotes, case
    // The quote from another document, a document it wasn't given, or only its name: no Social Alert
    const wrongDoc = doc({ source: 'knowledge_base', document: 'SLRR Collection Requirements', quote: KB_QUOTE });
    eq([wrongDoc.sent.length, wrongDoc.reactions], [0, ['❌']]);
    assert.ok(wrongDoc.logs.includes('Gemini\'s citation for a Social Alert doesn\'t check out, so it can\'t start one: the quote isn\'t in ' +
      'SLRR Collection Requirements'), wrongDoc.logs.join('\n'));
    eq(doc({ source: 'knowledge_base', document: 'Maps handbook', quote: KB_QUOTE }).sent.length, 0);
    eq(doc({ source: 'knowledge_base', document: 'Escalation playbook', quote: '' }).sent.length, 0);
    // No documents and no Guidance tab row: nothing to cite, so the paragraph isn't even asked
    const lead = { source: 'email', from: 'Kelsey Lange', date: '2026-10-14', subject: 'alerts', text: 'Escalate Street View dog posts' };
    const none = run({ switches: ON, guidance: [lead] }, cite(G1));
    assert.ok(!/STARTING A SOCIAL ALERT/.test(systemOf(none.payload)));
    assert.ok(systemOf(none.payload).includes('\n[G1] Email from Kelsey Lange (2026-10-14), "alerts": Escalate Street View dog posts'));
  });

  test('KB & Guidance ON: no Social Alert when the citation doesn\'t check out or something else says no (paraphrase, a lead\'s email, under 90% sure, an exclusion, the YouTube protocol, a no-alert check, snark, a hold row, too short, no such row, no citation at all)', () => {
    const EMAIL = { source: 'email', from: 'Kelsey Lange', date: '2026-10-14', subject: 'Street View', text: `${ROW}.` };
    const ytText = LOW.split('[Product]: Maps').join('[Product]: YouTube').split('Google Maps Street View Dog Meme').join('YouTube Shorts Dog Meme')
      .split(',Maps,').join(',YouTube,');
    const spamText = LOW.split('chasing the Google Maps car.').join('chasing the Google Maps car. Giveaway: link in bio.');
    const HOLD = [{ source: 'tab', text: 'Hold Street View posts that show a dog chasing the Google Maps car: no Social Alert this week',
      applies_to: 'Maps', until: '' }];
    const cases = [
      ['a paraphrase', {}, cite(Object.assign({}, G1, { quote: 'Escalate all Street View animal posts regardless of engagement' })),
        'the quote isn\'t in Guidance row G1'],
      ['a lead\'s email', { guidance: GUIDE.concat([EMAIL]) }, cite({ source: 'guidance', guidance_n: 2, quote: QUOTE }),
        'G2 is a lead\'s email: only a Guidance tab row can start an alert'],
      ['under 90% sure', {}, cite(G1, { social_alert: { warranted: true, confidence: 0.85, reason: 'x', per: G1 } }), null],
      ['not warranted', {}, cite(G1, { social_alert: { warranted: false, confidence: 0.95, reason: 'Just a meme', per: G1 } }), null],
      ['an exclusion (spam)', {}, cite(G1), null, spamText],
      ['the YouTube protocol', { guidance: [Object.assign({}, GUIDE[0], { applies_to: '' })] }, cite(G1), null, ytText],
      ['a no-alert check', {}, cite(G1, { no_alert_checks: { not_actionable: true, evidence: 'A joke' } }), null],
      ['snark (Critic/Arbiter)', {},
        cite(G1, { social_alert: { warranted: true, confidence: 0.95, reason: 'x', signal_class: 'routine_snark', per: G1 } }), null],
      ['a hold row', { guidance: HOLD }, cite({ source: 'guidance', guidance_n: 1, quote: 'Street View posts that show a dog chasing the Google Maps car' }),
        'the words around the quote in Guidance row G1 say not to escalate'],
      ['too short', {}, cite(Object.assign({}, G1, { quote: 'Street View post' })), 'the quote from Guidance row G1 is too short to go by'],
      ['no such row', {}, cite(Object.assign({}, G1, { guidance_n: 5 })), 'it named no Guidance row it was shown (G5)'],
      ['no source', {}, cite({ source: 'my judgment', quote: QUOTE }), 'it named neither a Guidance row nor a document'],
      // The spec's literal gate (guidance shown, a document relied on, warranted at 95%) is not a citation: no alert
      ['no citation', { knowledge: KBASE() }, cite(undefined, { knowledge_used: [{ document: 'Escalation playbook', used_for: 'Maps' }] }), null],
      ['evergreen noise', { bq: () => ({ is_evergreen_noise: true, evergreen_topic_label: 'Street View pets', evergreen_cosine_distance: 0.08 }) },
        cite(G1), null],
    ];
    cases.forEach(([name, opts, llm, why, text]) => {
      const r = run(Object.assign({ switches: ON }, opts), llm, text);
      eq([name, r.sent.length, r.drafts.length, r.reactions.includes('📦'), JSON.stringify(r.row).includes('kb_basis')],
        [name, 0, 0, false, false]);
      if (why) {
        assert.ok(r.logs.includes(`Gemini's citation for a Social Alert doesn't check out, so it can't start one: ${why}`),
          `${name}\n${r.logs.join('\n')}`);
      } else if (!['no citation', 'evergreen noise'].includes(name)) {  // the citation held up: something else said no
        assert.ok(r.logs.includes(`Gemini cites ${BASIS} for a Social Alert (quote checked)`), `${name}\n${r.logs.join('\n')}`);
      }
      assert.ok(!r.logs.some(l => /Social Alert started on what Gemini cited/.test(l)), name);
      eq([name, r.w.g.props.has('KB_STARTS')], [name, false]);
    });
  });

  test('KB & Guidance ON: an ongoing issue with no KOF author can be started too, keeping the rules\' reasons; an alert the rules escalate anyway is never touched', () => {
    const ongoing = LOW.split('[Sensitive Topic]: None').join('[Sensitive Topic]: Privacy')
      .split('New / not previously reported over the past 14 days').join('Ongoing Issue').split(',None,Maps,').join(',Privacy,Maps,');
    eq(B.escalation_(review(ongoing).fields, { now: NOW }).suppression, 'ongoing_no_kof');
    const r = run({ switches: ON }, cite(G1), ongoing);
    const esc = r.row.email_input.escalation;
    eq([r.sent.length, esc.reasons, esc.status, esc.track], [1, ['SENSITIVE_TOPIC', 'KB_OR_GUIDANCE'], 'ONGOING', 'URGENT']);
    eq(B.escalationWhyText_(esc), `Escalated per ${BASIS} · Sensitive topic (Privacy)`);
    // P0: escalated by the rules; the citation changes nothing about its email (no kb_basis, the rules' reasons)
    const p0 = run({ switches: ON }, cite(G1), F.P0_OK);
    const off = run({}, cite(G1), F.P0_OK);
    eq([p0.sent.length, p0.row.email_input, p0.reactions], [1, off.row.email_input, off.reactions]);
    assert.ok(!p0.logs.some(l => /Social Alert started on what Gemini cited/.test(l)));
  });

  test('KB & Guidance ON: never twice: later runs, a retried send and the same post again send one Social Alert; the count on the Control tab counts the post once', () => {
    const w = sim({ drafts: STAND_IN, guidance: GUIDE, switches: ON });
    let reviews = 0;
    w.vertex.assess = () => { reviews++; return cite(G1); };
    w.gmail.fail = (method, path) => (path === 'messages/send' ? { code: 429, body: { error: { message: 'rate limit exceeded' } } } : null);
    const msg = w.paste(LOW);
    w.run();
    eq([w.gmail.sentMessages().length, w.alertRows()[0].email_status], [0, 'pending']);
    assert.ok(w.g.logs.some(l => /Social Alert send for QA-\d+ failed \(attempt 1\)/.test(l)), w.g.logs.join('\n'));
    w.gmail.fail = null;
    w.run();  // the retry works from the stored email (no second review, no second promotion)
    w.run();
    eq([w.gmail.sentMessages().length, reviews, w.alertRows()[0].email_status, w.alertRows()[0].email_input.escalation.kb_basis], [1, 1, 'sent', BASIS]);
    assert.ok(w.chat.botReactions(msg.name).includes('📦'));
    // The same post again, an hour later: it was alerted, so ❌ (Gemini's citation can't make it a second Social Alert)
    w.g.clock.now += 3600e3;
    const again = w.paste(LOW);
    w.run();
    eq([w.gmail.sentMessages().length, w.chat.botReactions(again.name)], [1, ['❌']]);
    assert.ok(w.g.logs.some(l => /❌ no Social Alert needed \(the same post was already alerted/.test(l)), w.g.logs.join('\n'));
    eq(switchNote(w), `1 started today · last per ${BASIS}`);
    // A new day starts the count again; without script properties (a broken service) it only logs
    w.g.props.set('KB_STARTS', JSON.stringify({ day: '2026-10-13', keys: ['a', 'b'] }));
    const logged = [];
    B.noteKbStart_({ now: () => NOW, log: t => logged.push(t) }, { recordKey: 'x' }, BASIS);
    assert.match(logged[0] || '', /^couldn't note the KB & Guidance alert for the Control tab: /);
    w.bot.noteKbStart_({ now: () => w.g.clock.now, log: () => {} }, { recordKey: 'reddit.com/comments/zzz' }, 'Escalation playbook');
    eq([JSON.parse(w.g.props.get('KB_STARTS')).keys, switchNote(w)], [['reddit.com/comments/zzz'], '1 started today · last per Escalation playbook']);
  });

  test('KB & Guidance ON: a failure in the check leaves the rules\' call (❌) and never stops the run; odd citations from Gemini are ignored', () => {
    const w = sim({ drafts: STAND_IN, guidance: GUIDE, switches: ON });
    w.vertex.assess = () => cite(G1);
    w.bot.kbPromotion_ = () => { throw new Error('boom'); };
    const msg = w.paste(LOW);
    const report = w.run();
    eq([w.chat.botReactions(msg.name), w.gmail.sentMessages().length, report.errors], [['❌'], 0, []]);
    assert.ok(w.g.logs.includes('the KB & Guidance check failed, so the rules\' call stands: boom'), w.g.logs.join('\n'));
    // ...and a failure checking the quote only means it can't start one
    const v = sim({ drafts: STAND_IN, guidance: GUIDE, switches: ON });
    v.vertex.assess = () => cite(G1);
    v.bot.kbCitation_ = () => { throw new Error('bad row'); };
    const m2 = v.paste(LOW);
    const report2 = v.run();
    eq([v.chat.botReactions(m2.name), v.gmail.sentMessages().length, report2.errors], [['❌'], 0, []]);
    assert.ok(v.g.logs.includes('Gemini\'s citation for a Social Alert doesn\'t check out, so it can\'t start one: couldn\'t check it: bad row'),
      v.g.logs.join('\n'));
    // Gemini returns something that isn't a citation: no crash, no alert
    ['yes', ['guidance', 1], null, 7, { source: 'guidance', guidance_n: 'one', quote: 42 }, { source: 'knowledge_base', document: { x: 1 } }]
      .forEach(per => {
        const r = run({ switches: ON, knowledge: KBASE() }, cite(per));
        eq([JSON.stringify(per), r.sent.length, r.reactions, r.report.errors], [JSON.stringify(per), 0, ['❌'], []]);
      });
    // Gemini down: the rules alone, as always
    const down = run({ switches: ON }, () => { throw new Error('Vertex AI unavailable'); });
    eq([down.sent.length, down.reactions], [0, ['❌']]);
  });

  test('KB & Guidance ON: Burson\'s answers never hear about it (the guidance, the reason, the automation); analysts\' answers do', () => {
    const r = run({ switches: ON }, cite(G1));
    const w = r.w;
    w.vertex.answer = () => 'This alert was escalated and the email has gone out.';
    w.reply(r.msg, 'why was this one escalated? it only has 300 engagements');
    w.run();
    const answers = () => w.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.answer);
    const toBurson = JSON.stringify(answers()[0].payload);
    assert.ok(!/Escalated per|KB_OR_GUIDANCE|Guidance:|another animal chasing|started on what Gemini cited/.test(toBurson), toBurson);
    assert.ok(w.bursonPosts().every(m => !/guidance|knowledge base|resources|gemini|automat|bigquery|analyst/i.test(m.text)),
      w.bursonPosts().map(m => m.text).join('\n'));
    const [fwd] = w.analystPosts().filter(m => !m.threadReply);
    w.chat.say(w.ANA, 'why did this one get a Social Alert?', { thread: fwd.thread.name, sender: 'users/im_lead' });
    w.run();
    const toAnalyst = answers()[answers().length - 1].payload.contents[0].parts[0].text;
    assert.ok(toAnalyst.includes(`Why escalated: Escalated per ${BASIS}`), toAnalyst);
  });

  test('KB & Guidance ON from the Control tab (row 13), end to end through poll(): the Guidance tab row starts the Social Alert (to the stand-in), and column C says so; OFF it\'s ❌', () => {
    const go = on => {
      const t = e2e();
      t.bot.setup();
      t.set('B30', 'tester@testing.test');
      if (on) t.control().getRange(13, 2).setValue('ON');
      t.sheet().getSheetByName('Guidance').appendRow([ROW, 'Maps', '', 'Kelsey']);
      t.g.vertex.assess = payload => {
        const system = payload.systemInstruction.parts[0].text;
        return cite(/\[G1\] Escalate every Street View post/.test(system) ? G1 : undefined);
      };
      const alert = t.chat.say(TEST_FEED, LOW, { sender: 'users/bot' });
      t.poll();
      t.poll();
      return { t, alert };
    };
    const on = go(true);
    eq(on.t.g.gmail.sentMessages().map(m => m.to), [['tester@testing.test']]);
    assert.ok(on.t.chat.botReactions(on.alert.name).includes('📦'));
    assert.match(on.t.control().cell(13, 3), new RegExp('^✓ ON: a Social Alert can start on a Guidance row or a Resources document Gemini ' +
      `cites, at high confidence · 1 started today · last per Guidance: "Escalate every Street View post`));
    eq(on.t.chat.botPosts(TEST_FEED), []);
    const off = go(false);
    eq([off.t.g.gmail.sentMessages().length, off.t.chat.botReactions(off.alert.name)], [0, ['❌']]);
    assert.match(off.t.control().cell(13, 3), /^OFF \(the Resources documents and the Guidance tab can only stop an alert/);
  });

  test('KB & Guidance: the citation check and the promotion, piece by piece (Review.gs kbCitation_, Escalate.gs kbPromotion_)', () => {
    // The quote may differ in case, spacing, curly quotes and a final period; never in its words
    const tab = [{ source: 'tab', text: 'Escalate  every Pixel 11 leak  —  whatever the engagement.' }];
    const ok = B.kbCitation_({ source: 'Guidance', guidance_n: '[G1]', quote: '“escalate every pixel 11 leak - whatever the engagement.”' }, tab, null);
    eq(plain(ok), { source: 'guidance', guidance_n: 1, document: '', quote: '“escalate every pixel 11 leak - whatever the engagement.”',
      basis: 'Guidance: "Escalate every Pixel 11 leak — whatever the engagement."', why: '' });
    eq(B.kbCitation_({ source: 'guidance', guidance_n: 1, quote: 'Escalate every Pixel 11 leak, whatever' }, tab, null).basis, '');
    // A short row can be quoted whole
    eq(B.kbCitation_({ source: 'guidance', guidance_n: 1, quote: 'Alert on Waymo crashes' }, [{ source: 'tab', text: 'Alert on Waymo crashes.' }], null).basis,
      'Guidance: "Alert on Waymo crashes."');
    eq(B.kbCitation_({ source: 'guidance', guidance_n: 1, quote: 'Waymo crashes' }, [{ source: 'tab', text: 'Alert on Waymo crashes.' }], null).why,
      'the quote from Guidance row G1 is too short to go by');
    // Only the 12 rows Gemini was shown
    const many = Array.from({ length: 14 }, (_, i) => ({ source: 'tab', text: `Escalate every Pixel ${i + 1} leak whatever the engagement` }));
    eq([B.kbCitation_({ source: 'guidance', guidance_n: 12, quote: 'Escalate every Pixel 12 leak whatever' }, many, null).basis !== '',
      B.kbCitation_({ source: 'guidance', guidance_n: 13, quote: 'Escalate every Pixel 13 leak whatever' }, many, null).why],
    [true, 'it named no Guidance row it was shown (G13)']);
    // A document: only the parts Gemini was given count, not its listing line ("What it covers")
    const kb = { docs: [{ name: 'Playbook', url: 'u1', covers: 'Pixel leaks always get a Social Alert, whatever the engagement', text: 'Doodles go to the Doodle team.' },
      { name: 'Leaks', url: 'u2', covers: 'Leaks', text: 'Every Pixel leak gets a Social Alert, whatever the engagement.' }] };
    const k = B.knowledgeFor_(kb, { text: 'pixel leak', phrases: [], handles: [] }, { budget: 100000 });
    eq(B.kbCitation_({ source: 'knowledge_base', document: 'Playbook', quote: 'Pixel leaks always get a Social Alert, whatever the engagement' }, [], k).why,
      'the quote isn\'t in Playbook');
    eq(B.kbCitation_({ source: 'knowledge base', document: 'leaks', quote: 'every pixel leak gets a social alert, whatever the engagement' }, [], k).basis, 'Leaks');
    eq(B.kbDocText_(k.text, 1, 'Playbook'), 'Doodles go to the Doodle team.');
    eq([B.kbDocText_(k.text, 3, 'Nope'), B.kbDocText_('', 1, 'Playbook')], ['', '']);
    // "Don't escalate …" never starts one, even when the quote leaves those words out; a holding statement is fine
    const hold = [{ source: 'tab', text: 'Do not escalate Pixel 11 leaks from @leaker this week' }];
    eq(B.kbCitation_({ source: 'guidance', guidance_n: 1, quote: 'Pixel 11 leaks from @leaker this week' }, hold, null).why,
      'the words around the quote in Guidance row G1 say not to escalate');
    eq(B.kbCitation_({ source: 'guidance', guidance_n: 1, quote: 'Outage posts get a Social Alert with the holding statement' },
      [{ source: 'tab', text: 'Outage posts get a Social Alert with the holding statement.' }], null).why, '');
    const holds = s => B.ev('KB_HOLD_RX_').test(B.kbNorm_(s));
    eq(['Do not escalate Pixel 11 leaks', 'Hold KOF criticism of Waymo', 'Pixel leaks aren’t escalated', 'It doesn\'t get a Social Alert',
      'No need to alert on these', 'not to be escalated', 'no Social Alert this week', 'skip memes'].map(holds), [true, true, true, true, true, true, true, true]);
    eq(['Escalate posts telling people to stop using Gemini, whatever the engagement', 'Escalate posts that tell users to avoid Pixel 9',
      'Never miss a crash video: escalate every one', 'Escalate every post saying don\'t use Gemini'].map(holds), [false, false, false, false]);

    // kbPromotion_: only below the bar, only with a checked citation, at 90%+ (exactly 90% counts)
    const fields = review(LOW).fields;
    const esc = B.escalation_(fields, { now: NOW });
    const rev = (sa, extra) => Object.assign({ fields, followUp: null, noAlertChecks: null,
      socialAlert: Object.assign({ warranted: true, confidence: 0.9, reason: 'r', per: { basis: BASIS } }, sa) }, extra || {});
    const up = B.kbPromotion_(rev({}), esc, NOW);
    eq(plain(up), plain(Object.assign({}, esc, { escalated: true, track: 'URGENT', action: 'EMAIL_ALERT', suppression: null, youtube: 'none',
      reasons: ['KB_OR_GUIDANCE'], kb_basis: BASIS, leadership: false })));
    eq([B.kbPromotion_(rev({ confidence: 0.89 }), esc, NOW), B.kbPromotion_(rev({ per: { basis: '' } }), esc, NOW),
      B.kbPromotion_(rev({ per: undefined }), esc, NOW), B.kbPromotion_(rev({ source: 'rule' }), esc, NOW),
      B.kbPromotion_(rev({ warranted: false }), esc, NOW), B.kbPromotion_(rev({}), Object.assign({}, esc, { suppression: 'EXCLUDED_SPAM' }), NOW),
      B.kbPromotion_(rev({}), Object.assign({}, esc, { suppression: 'youtube_no_action' }), NOW),
      B.kbPromotion_(rev({}), Object.assign({}, esc, { escalated: true }), NOW),
      B.kbPromotion_(rev({}, { noAlertChecks: { duplicate: false, guidance: true, evidence: 'e' } }), esc, NOW),
      B.kbPromotion_(rev({}, { followUp: { by: 'same_post', original: { outcome: 'alerted', alert_id: 'QA-1', risk_tags: [] } } }), esc, NOW)],
    [null, null, null, null, null, null, null, null, null, null]);
    eq(B.kbPromotion_(rev({}, { noAlertChecks: { duplicate: false, evidence: 'nothing holds' } }), esc, NOW).escalated, true);
    // The switch decides, in one place for the Social Alert, the ❌ and the leadership DM
    const ctx = switches => ({ switches, now: () => NOW, log: () => {} });
    eq([B.escalationFor_(ctx(ON), rev({}), []).esc.kb_basis, B.escalationFor_(ctx(ALL_OFF()), rev({}), []).esc, B.escalationFor_(ctx(undefined), rev({}), []).esc],
      [BASIS, esc, esc]);
    // The schema copy with `per`: built fresh, never shared
    const parsed = Object.assign(parse(LOW), { kbStartAlerts: true });
    const s1 = B.assessSchema_(parsed);
    s1.properties.social_alert.properties.per.properties.quote.type = 'X';
    eq(B.assessSchema_(parsed).properties.social_alert.properties.per, plain(B.ev('KB_PER_SCHEMA_')));
    eq(Object.keys(s1.properties), Object.keys(B.ev('ASSESS_SCHEMA_').properties));
  });

  test('KB & Guidance ON: a row or document that says Social Alerts are not needed ("no … alerts", "stop escalating", "no longer", "monitor only", "log only") never starts one', () => {
    const NOT_NEEDED = 'Posts about Street View dogs chasing the Google Maps car this week: Social Alerts are not needed, comms ' +
      'already has it covered';
    const r = run({ switches: ON, guidance: [{ source: 'tab', text: NOT_NEEDED, applies_to: 'Maps', until: '' }] },
      cite({ source: 'guidance', guidance_n: 1, quote: 'Posts about Street View dogs chasing the Google Maps car this week' }));
    eq([r.sent.length, r.drafts.length, r.reactions, JSON.stringify(r.row).includes('kb_basis')], [0, 0, ['❌'], false]);
    assert.ok(r.logs.includes('Gemini\'s citation for a Social Alert doesn\'t check out, so it can\'t start one: the words around the ' +
      'quote in Guidance row G1 say not to escalate'), r.logs.join('\n'));
    const holds = s => B.ev('KB_HOLD_RX_').test(B.kbNorm_(s));
    eq(['Social Alerts are not needed, comms already has it covered', 'Social Alerts aren’t needed for Pixel leaks',
      'No Pixel alerts this week', 'no escalation needed', 'Stop escalating Waymo crash videos', 'We no longer escalate Doodle posts',
      'Pixel 11 leaks: monitor only, no email', 'Waymo videos: log only', 'An escalation is not required for these',
      'Social Alerts are unnecessary for memes'].map(holds), [true, true, true, true, true, true, true, true, true, true]);
    // Rows that say to escalate still count, even with "stop" or "no" in them
    eq(['Escalate posts telling people to stop using Gemini, whatever the engagement', 'Escalate every Pixel leak, no matter the engagement',
      'Escalate every Waymo crash video with no KOF author'].map(holds), [false, false, false]);
    // A document says it too
    const kb = B.knowledgeFor_({ docs: [{ name: 'Outage handbook', url: 'u', covers: '',
      text: 'During a Gemini app outage, Social Alerts are not needed: comms posts one status update.' }] },
    { text: 'gemini', phrases: [], handles: [] }, { budget: 100000 });
    eq(B.kbCitation_({ source: 'knowledge_base', document: 'Outage handbook', quote: 'During a Gemini app outage' }, [], kb).why,
      'the words around the quote in Outage handbook say not to escalate');
  });

  test('KB & Guidance ON: a document or row that only mentions the topic never starts one: the quote\'s sentence must say to alert', () => {
    const FAQ = { name: 'Street View FAQ', url: 'https://docs.google.com/document/d/1KbStreetViewFaqDoc00001/edit', covers: 'Street View',
      burson: false, label: 'Google Doc', text: 'Street View FAQ\n\nThe Google Maps car drives most streets about once a year. Dogs ' +
        'often chase the Google Maps car, and people post the pictures.' };
    const used = { knowledge_used: [{ document: 'Street View FAQ', used_for: 'Street View' }] };
    const r = run({ switches: ON, guidance: [], knowledge: { docs: [FAQ] } },
      cite({ source: 'knowledge_base', document: 'Street View FAQ', quote: 'Dogs often chase the Google Maps car' }, used));
    eq([r.sent.length, r.drafts.length, r.reactions, JSON.stringify(r.row).includes('kb_basis')], [0, 0, ['❌'], false]);
    assert.ok(r.logs.includes('Gemini\'s citation for a Social Alert doesn\'t check out, so it can\'t start one: the words around the ' +
      'quote in Street View FAQ don\'t say to send a Social Alert'), r.logs.join('\n'));
    // A Guidance row: the topic sentence alone doesn't count; the sentence that says to escalate does
    const tab = [{ source: 'tab', text: 'Pixel 10 battery fires are trending on TikTok. Escalate every one, whatever the engagement.' }];
    eq([B.kbCitation_({ source: 'guidance', guidance_n: 1, quote: 'Pixel 10 battery fires are trending on TikTok' }, tab, null).why,
      B.kbCitation_({ source: 'guidance', guidance_n: 1, quote: 'Escalate every one, whatever the engagement' }, tab, null).why],
    ['the words around the quote in Guidance row G1 don\'t say to send a Social Alert', '']);
    // The words that say so: escalate, a Social Alert, send an email
    const starts = s => B.ev('KB_START_RX_').test(B.kbNorm_(s));
    eq(['Escalate every Pixel leak', 'Street View dog posts get a Social Alert', 'These are always alerted', 'Send an email to the Maps team',
      'The Pixel 10 battery lasts up to 30 hours with Extreme Battery Saver on'].map(starts), [true, true, true, true, false]);
  });

  test('KB & Guidance ON: a Guidance row whose Applies to names only other products doesn\'t start one for this alert; anything else in Applies to is left to Gemini', () => {
    const GEMINI_ROW = [{ source: 'tab', text: ROW, applies_to: 'Gemini app', until: '' }];
    const r = run({ switches: ON, guidance: GEMINI_ROW }, cite(G1));
    eq([r.sent.length, r.reactions, JSON.stringify(r.row).includes('kb_basis')], [0, ['❌'], false]);
    assert.ok(r.logs.includes('Gemini\'s citation for a Social Alert doesn\'t check out, so it can\'t start one: Guidance row G1 applies ' +
      'to Gemini app, not to Maps'), r.logs.join('\n'));
    const fields = review(LOW).fields;
    const per = applies => B.kbCitation_(G1, [{ source: 'tab', text: ROW, applies_to: applies, until: '' }], null, fields);
    eq(['Gemini app', 'YouTube; Pixel', 'Waze'].map(a => per(a).why), ['Guidance row G1 applies to Gemini app, not to Maps',
      'Guidance row G1 applies to YouTube; Pixel, not to Maps', 'Guidance row G1 applies to Waze, not to Maps']);
    // The alert's product by any of its names, among others, or Applies to that isn't a list of products: it counts
    eq(['Maps', 'Google Maps', 'Maps/Geo', 'Waze, Google Maps', 'Street View posts', 'KOF authors', 'Maps, KOF authors', '']
      .map(a => per(a).basis), [BASIS, BASIS, BASIS, BASIS, BASIS, BASIS, BASIS, BASIS]);
    // Another product of the alert counts too; without the alert's fields there's nothing to check
    const aio = review(F.AIO).fields;
    eq([B.kbCitation_(G1, [{ source: 'tab', text: ROW, applies_to: 'Google Search' }], null, aio).basis,
      B.kbCitation_(G1, [{ source: 'tab', text: ROW, applies_to: 'Waze' }], null).basis], [BASIS, BASIS]);
  });

  test('KB & Guidance ON while testing (a stand-in): the alert\'s thread for analysts says why the Social Alert went out, once; a rules alert gets no such note', () => {
    const P = B.ev('GEN').prefix;
    const w = sim({ drafts: STAND_IN, guidance: GUIDE, switches: ON });
    w.vertex.assess = () => cite(G1);
    const msg = w.paste(LOW);
    w.run();
    w.run();
    const why = () => w.analystPosts().filter(m => m.threadReply && /Why: Escalated per/.test(m.text)).map(m => m.text);
    eq(why(), [`Social Alert sent (to the testers while testing).\n- Why: Escalated per ${BASIS}`]);
    const [fwd] = w.analystPosts().filter(m => !m.threadReply);
    assert.ok(w.analystPosts().filter(m => m.threadReply && /Why: Escalated per/.test(m.text)).every(m => m.thread.name === fwd.thread.name));
    eq([w.gmail.sentMessages().length, w.bursonPosts(), w.chat.botReactions(msg.name).includes('📦')], [1, [], true]);
    // The rules' own Social Alert (P0), switch ON: no new note
    const p0 = run({ switches: ON }, cite(G1), F.P0_OK);
    eq([p0.sent.length, p0.w.analystPosts().filter(m => /Why: /.test(m.text)).length], [1, 0]);
    // The note failing never fails the send (a retry would send the email again)
    const v = sim({ drafts: STAND_IN, guidance: GUIDE, switches: ON });
    v.vertex.assess = () => cite(G1);
    v.bot.escalationWhyText_ = () => { throw new Error('boom'); };
    v.paste(LOW);
    const rep = v.run();
    v.run();
    eq([v.gmail.sentMessages().length, v.alertRows()[0].email_status, rep.errors], [1, 'sent', []]);
    assert.ok(v.g.logs.some(l => /^couldn't post why the Social Alert for QA-\d+ went out: boom$/.test(l)), v.g.logs.join('\n'));
  });
};
