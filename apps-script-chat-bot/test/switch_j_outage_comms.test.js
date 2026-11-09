// Check outage & comms docs (Control tab row 20, outageComms): for a post about a Google outage, a widespread bug or a
// policy issue, Gemini checks Google's own status with its web search (trusted only when the answer came with web
// sources) and copies the approved holding statement from a Resources document (kept only when it is word for word in
// that document). Analysts get one "Comms / Status Context" line; the Social Alert email a section at the bottom; Burson
// nothing (Review.gs commsPrompt_ / commsContextOf_, Bot.gs, Knowledge.gs knowledgeQuery_, Drafts.gs draftPlan_,
// Email.gs commsEmailRows_, Voice.gs changeNoteText_).
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, world, e2e, plain, parse, TEST_FEED, REAL } = H;

  // A correct alert the rules escalate (P1, 4,800 engagements): a Social Alert today, nothing to fix
  const OUTAGE = `THIS ALERT MEETS P1 CRITERIA
SOCIAL ALERT:
[Time/Date Post Went Live]: October 13, 2026, 9:20 AM
[Exposure Tag]: Product - Product failures - general software/service issues
[Product]: Gemini App
[Other Google Products]: None
[Engagement]: HIGH (4800 engagements)
[Sensitive Topic]: None
[KOF]: No
An X user (@inboxwatcher; 51200 followers) posted that the Gemini app has been down for over an hour, with chats failing to load for users in Europe. Replies report the same problem.
[Link]: https://x.com/inboxwatcher/status/1845000000000000777
[Name]: Gemini App Outage Reports / New / not previously reported over the past 14 days
[Code]: Product - Product failures - general software/service issues,4800,@inboxwatcher,None,Gemini App,New / not previously reported over the past 14 days`;
  // The same post with a mistake Burson has to fix (LOW for 4,800 engagements): a fix request in its thread
  const OUTAGE_WRONG = OUTAGE.replace('[Engagement]: HIGH', '[Engagement]: LOW');
  const P = B.ev('GEN').prefix;
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const DRAFTS = { live: false, mailbox: 'im@ops.test', from: 'Brand Social <im@ops.test>' };  // no stand-in: a Gmail draft
  const LIVE = { live: true, mailbox: 'im@ops.test', from: 'Brand Social <sender@alerts.test>' };
  const ON = { outageComms: true };
  const ALL_OFF = () => B.switchesOff_();

  const STATEMENT = 'We\'re aware that some people are having trouble using the Gemini app right now. We\'re working to fix it as ' +
    'quickly as possible and will share an update here as soon as we can.';
  const STATUS = 'Google Workspace Status Dashboard';
  const SUMMARY = 'Gemini app: service disruption for some users in Europe since 8:05 AM ET, a fix is in progress';
  const KBASE = () => ({ docs: [
    { name: 'SLRR Collection Requirements', url: 'https://docs.google.com/document/d/1KbRequirementsDoc00001/edit', covers: 'The alert requirements',
      burson: true, label: 'Google Doc', text: 'SLRR Collection Requirements\n\nKOF: an author on any KOF list counts as a KOF.' },
    { name: 'Reactive statements', url: 'https://docs.google.com/document/d/1KbReactiveStatementsDoc1/edit',
      covers: 'Approved holding statements: "We are investigating reports of an issue with Google Maps."', burson: false, label: 'Google Doc',
      text: 'Reactive statements (approved by GCPA)\n\nGemini app outage\nHolding statement: “We’re aware that some people are having ' +
        'trouble using the Gemini app right now.\nWe’re working to fix it as quickly as possible and will share an update here as soon ' +
        'as we can.”\n\nPixel 11 battery reports\nHolding statement: "We\'re looking into reports of battery drain on some Pixel 11 phones."' },
  ] });
  const COMMS = (extra) => Object.assign({ applies: true, kind: 'outage', outage_confirmed: true, status_source: STATUS,
    status_summary: SUMMARY + '.', holding_statement: STATEMENT, document: 'Reactive statements' }, extra || {});
  const gemini = (comms, extra) => Object.assign({ checks: [], knowledge_used: [{ document: 'Reactive statements', used_for: 'holding statement' }] },
    comms === undefined ? {} : { comms_context: comms }, extra || {});
  /** Vertex AI's web searches behind an answer: only a call with the web-search tool on can have searched. */
  const SOURCES = payload => (payload.tools ? { webSearchQueries: ['Gemini app outage status October 2026'], groundingChunks: [
    { web: { title: STATUS, uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123' } },
    { web: { title: 'theverge.com', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/DeF456' } }] } : null);
  const LINE = `outage · confirmed by Google (${STATUS}): ${SUMMARY} · holding statement from Reactive statements: "${B.truncate_(STATEMENT, 300)}"`;

  /** world(), with ctx.switches (world()'s own ctx has none: everything OFF) and any other ctx fields in `extra`. */
  const sim = (opts, extra) => {
    const w = world(opts);
    if ((opts && opts.switches) || extra) {
      const base = w.ctx;
      w.ctx = () => Object.assign(base(), opts && opts.switches ? { switches: Object.assign({}, opts.switches) } : {}, extra || {});
    }
    return w;
  };
  /** One alert through the bot: {w, msg, report, reactions, sent, drafts, row, logs, payload (the review call's)}. */
  const run = (opts, llm, text, o) => {
    o = o || {};
    const w = sim(Object.assign({ drafts: STAND_IN, knowledge: KBASE() }, opts || {}), o.extra);
    w.vertex.assess = typeof llm === 'function' ? llm : () => JSON.parse(JSON.stringify(llm));
    w.vertex.grounding = o.grounding === undefined ? SOURCES : o.grounding;
    const msg = w.paste(text || OUTAGE);
    const report = w.run();
    const call = w.vertex.calls.find(c => c.payload.generationConfig.responseSchema.properties.checks);
    return { w, msg, report, reactions: w.chat.botReactions(msg.name), sent: w.gmail.sentMessages(), drafts: w.gmail.allDrafts(),
      row: w.alertRows()[0], logs: w.g.logs, payload: call && call.payload };
  };
  const systemOf = payload => payload.systemInstruction.parts[0].text;
  const switchNote = w => (JSON.parse(w.g.props.get('SWITCH_NOTES') || '{}').outageComms || {}).text;
  /** Everything a run did that anyone could see or that was stored (vertex: false leaves out what was asked of Gemini). */
  const outcome = (r, vertex) => JSON.stringify({
    vertex: vertex === false ? null : r.w.vertex.calls.map(c => c.payload),
    analyst: r.w.analystPosts().map(m => [m.text, m.threadReply]), burson: r.w.bursonPosts().map(m => m.text), reactions: r.reactions,
    analystReactions: r.w.analystPosts().map(m => r.w.chat.botReactions(m.name)),
    sent: r.sent.map(m => [m.to, m.cc, m.subject, m.text, m.html]), drafts: r.drafts.map(d => [d.to, d.cc, d.subject, d.text, d.html]),
    rows: r.w.alertRows(), logs: r.logs, props: Array.from(r.w.g.props.entries()), report: r.report,
  });
  const hasComms = s => /Comms \/ Status Context|holding statement|Workspace Status Dashboard|vertexaisearch/i.test(String(s || ''));

  test('outage comms: OFF (or no switches at all) is exactly as before, even when Gemini returns a comms context and web sources: same prompt, schema, notes, email, Alert log', () => {
    const scenario = switches => run({ switches }, gemini(COMMS()));
    const absent = scenario(undefined);
    const off = scenario(ALL_OFF());
    const offExplicit = scenario({ outageComms: false });
    eq(outcome(off), outcome(absent));
    eq(outcome(offExplicit), outcome(absent));
    // ...and that is today's behaviour: the Social Alert to the stand-in, no comms paragraph, ASSESS_SCHEMA_ itself
    eq([absent.sent.length, absent.sent[0].to, absent.w.bursonPosts()], [1, ['tester@testing.test'], []]);
    assert.ok(!/COMMS \/ STATUS CONTEXT|comms_context|holding_statement/.test(systemOf(absent.payload)));
    eq(absent.payload.generationConfig.responseSchema, plain(B.ev('ASSESS_SCHEMA_')));
    assert.ok(!('comms_context' in B.ev('ASSESS_SCHEMA_').properties));
    assert.ok(![absent.sent[0].text, absent.sent[0].html].concat(absent.w.analystPosts().map(m => m.text)).some(hasComms));
    assert.ok(!JSON.stringify(absent.row).includes('comms_context') && !absent.logs.some(l => /comms \/ status context|left out/i.test(l)));
    eq([absent.w.g.props.has('OUTAGE_COMMS'), absent.w.g.props.has('SWITCH_NOTES')], [false, false]);
    // The pure parts with the switch OFF: no new key on the review, the same prompt, schema object and search words
    const parsed = parse(OUTAGE);
    parsed.knowledge = B.knowledgeFor_(KBASE(), B.knowledgeQuery_(parsed), { budget: 100000 });
    const p = B.assessPrompts_(parsed, null);
    assert.strictEqual(p.schema, B.ev('ASSESS_SCHEMA_'));
    eq(B.commsPrompt_(parsed), '');
    eq(B.knowledgeQuery_(parsed), B.knowledgeQuery_(Object.assign({}, parsed, { outageComms: false })));
    const llm = Object.assign(gemini(COMMS()), { _web: { queries: ['q'], sources: [{ title: STATUS, uri: 'u' }] } });
    const rev = B.reviewAlert_(parsed, { llm, now: NOW, history: [] });
    assert.ok(!('commsContext' in rev) && !rev.notes.length, JSON.stringify(rev.notes));
    // An email built from a stored email_input with no comms_context (every row today) is byte for byte the same
    const input = B.emailInput_(rev.fields, B.escalation_(rev.fields, { now: NOW }));
    const plan = B.planRecipients_(input.escalation, input.escalation.text, []);
    const opts = { standIn: 'tester@testing.test', sendId: 'QA-1', footer: 'Would have gone to: x' };
    eq(B.socialAlertEmail_(input, plan, opts), B.socialAlertEmail_(Object.assign({}, input, { comms_context: undefined }), plan, opts));
    eq(B.socialAlertEmail_(input, plan, opts), B.socialAlertEmail_(Object.assign({}, input, { comms_context: null }), plan, opts));
  });

  test('outage comms: OFF while KB & Guidance can start alerts is ON (the other switch that changes the review) asks Gemini for nothing of this feature', () => {
    const r = run({ switches: Object.assign(ALL_OFF(), { kbStartAlerts: true }) }, gemini(COMMS()));
    assert.ok(r.payload.generationConfig.responseSchema.properties.social_alert.properties.per, 'KB & Guidance\'s own field is there');
    assert.ok(!/COMMS \/ STATUS CONTEXT/.test(systemOf(r.payload)));
    assert.ok(!('comms_context' in r.payload.generationConfig.responseSchema.properties));
    assert.ok(!r.sent.some(m => hasComms(m.text) || hasComms(m.html)));
  });

  test('outage comms ON: a confirmed outage and a holding statement that is word for word in a Resources document: one line for analysts, a section at the bottom of the Social Alert email (stand-in only), nothing for Burson', () => {
    const r = run({ switches: ON }, gemini(COMMS()));
    // The prompt asks for it (with the holding statement part: there are documents), the schema has comms_context
    const system = systemOf(r.payload);
    assert.match(system, /\n\nCOMMS \/ STATUS CONTEXT \(comms_context\): when the post is about a Google service outage, a widespread bug or a policy issue/);
    assert.match(system, /copy the statement word for word into `holding_statement`/);
    assert.ok(system.indexOf('COMMS / STATUS CONTEXT') > system.indexOf('WEB SEARCH:'), 'right after the web search paragraph');
    eq(r.payload.generationConfig.responseSchema.properties.comms_context, plain(B.ev('COMMS_CONTEXT_SCHEMA_')));
    assert.ok(!('comms_context' in B.ev('ASSESS_SCHEMA_').properties), 'ASSESS_SCHEMA_ itself never changes');
    eq(r.payload.tools, [{ enterpriseWebSearch: {} }]);  // the web search was already on for every review
    eq(r.w.vertex.calls.length, 1);  // nothing extra is asked of Vertex AI
    // Analysts: one line under the forwarded alert (the corrected alert's QA notes)
    const [fwd] = r.w.analystPosts().filter(m => !m.threadReply);
    assert.ok(fwd.text.startsWith(OUTAGE), fwd.text);
    eq(fwd.text.split('\n').filter(l => /Comms \/ Status Context/.test(l)), [`QA: Comms / Status Context: ${LINE}`]);
    // The Social Alert: to the stand-in only; the section under Alert Details, above the Emoji Key and the testing footer
    eq([r.sent.length, r.sent[0].to, r.sent[0].cc, r.row.email_status], [1, ['tester@testing.test'], [], 'sent']);
    const email = r.sent[0];
    const block = '--- Comms / Status Context ---\nIssue: Outage\n' +
      `Google status: Confirmed by Google (${STATUS}): ${SUMMARY}\nHolding statement: "${STATEMENT}" (from Reactive statements)`;
    assert.ok(email.text.includes(`\nCode: ${B.parseAlert_(OUTAGE).fields.code}\n\n${block}\n\nWould have gone to: `), email.text);
    const html = email.html;
    const at = html.indexOf('>Comms / Status Context</div>');
    assert.ok(at > html.indexOf('>T&S</td>') && at < html.indexOf('Emoji Key'), 'between Alert Details and the Emoji Key');
    assert.ok(html.includes(`>Google status</td><td style="padding: 8px; border: 1px solid #ddd; font-size: 14px;">Confirmed by Google (${STATUS}): ` +
      `${B.htmlEsc_(SUMMARY)}</td>`));
    assert.ok(html.includes(`>Holding statement</td><td style="padding: 8px; border: 1px solid #ddd; font-size: 14px;">${B.htmlEsc_(`"${STATEMENT}" (from Reactive statements)`)}</td>`));
    // Never a web link, never the bot, Gemini or automation in the email
    assert.ok(![email.text, html].some(s => /vertexaisearch|grounding-api|Gemini (?:says|checked)|\bbot\b|automat|BigQuery/i.test(s)));
    eq(r.row.email_input.comms_context, { kind: 'outage', outage_confirmed: true, status_source: STATUS, status_summary: SUMMARY,
      holding_statement: STATEMENT, document: 'Reactive statements' });
    // The run log and column C of row 20
    assert.ok(r.logs.includes(`comms / status context: ${LINE}`), r.logs.join('\n'));
    eq(switchNote(r.w), `1 today · last: outage · confirmed by Google (${STATUS}) · holding statement found`);
    eq(JSON.parse(r.w.g.props.get('OUTAGE_COMMS')), { day: '2026-10-14', keys: [B.recordKey_(parse(OUTAGE).fields)] });
    // Burson: nothing posted, and only the legend emojis any sent Social Alert gets
    eq(r.w.bursonPosts(), []);
    assert.ok(r.reactions.includes('📦') && r.reactions.every(e => B.legendByEmoji_(e)), r.reactions.join(' '));
    eq(r.report.errors, []);
  });

  test('outage comms ON: a statement that isn\'t word for word in the document it names (or a document it wasn\'t given, the listing line, another document, too short) is left out; Google\'s status still shows', () => {
    const cases = [
      ['a paraphrase', { holding_statement: 'We know the Gemini app is having problems and we are fixing it quickly.' },
        'the statement isn\'t word for word in Reactive statements'],
      ['a document it wasn\'t given', { document: 'Comms playbook' }, '"Comms playbook" isn\'t a document it was given'],
      ['no document named', { document: null }, '"no name" isn\'t a document it was given'],
      ['the document\'s listing line', { holding_statement: 'We are investigating reports of an issue with Google Maps.' },
        'the statement isn\'t word for word in Reactive statements'],
      ['another document', { document: 'SLRR Collection Requirements' }, 'the statement isn\'t word for word in SLRR Collection Requirements'],
      ['too short', { holding_statement: 'We\'re aware.' }, 'the statement from Reactive statements is too short'],
      ['extra words', { holding_statement: `${STATEMENT} Thanks for your patience.` }, 'the statement isn\'t word for word in Reactive statements'],
    ];
    cases.forEach(([name, extra, why]) => {
      const r = run({ switches: ON }, gemini(COMMS(extra)));
      const c = r.row.email_input.comms_context;
      eq([name, c.holding_statement, c.document, c.outage_confirmed], [name, '', '', true]);
      assert.ok(r.logs.includes(`the holding statement Gemini gave was left out: ${why}`), `${name}\n${r.logs.join('\n')}`);
      const line = `outage · confirmed by Google (${STATUS}): ${SUMMARY} · no approved holding statement found in the Resources documents`;
      assert.ok(r.w.analystPosts()[0].text.includes(`QA: Comms / Status Context: ${line}`), name);
      assert.ok(!/Holding statement/.test(r.sent[0].text) && r.sent[0].text.includes(`Google status: Confirmed by Google (${STATUS})`), name);
      eq([name, switchNote(r.w)], [name, `1 today · last: outage · confirmed by Google (${STATUS})`]);
    });
    // [n], curly quotes, line breaks and spacing don't matter; the words do
    const r = run({ switches: ON }, gemini(COMMS({ document: '[2]', holding_statement: `“${STATEMENT.replace(/'/g, '’').replace('. ', '.\n  ')}”` })));
    eq([r.row.email_input.comms_context.document, r.row.email_input.comms_context.holding_statement],
      ['Reactive statements', STATEMENT.replace(/'/g, '’')]);
  });

  test('outage comms ON: no web sources means Google\'s status was "not checked" (Gemini\'s yes or no isn\'t trusted); the email then shows the statement only, or nothing at all', () => {
    // Gemini says confirmed, but the answer came without web sources (search refused, off, or the BigQuery fallback)
    const r = run({ switches: ON }, gemini(COMMS()), null, { grounding: null });
    const c = r.row.email_input.comms_context;
    eq([c.outage_confirmed, c.status_source, c.status_summary, c.holding_statement], [null, '', '', STATEMENT]);
    const line = 'outage · Google\'s status not checked (no web sources) · holding statement from Reactive statements: ';
    assert.ok(r.w.analystPosts()[0].text.includes(`QA: Comms / Status Context: ${line}`), r.w.analystPosts()[0].text);
    assert.ok(r.sent[0].text.includes(`--- Comms / Status Context ---\nIssue: Outage\nHolding statement: "${STATEMENT}"`), r.sent[0].text);
    assert.ok(!/Google status|Confirmed by Google/.test(r.sent[0].text + r.sent[0].html));
    eq(switchNote(r.w), '1 today · last: outage · status not checked · holding statement found');
    // Searched but no sources: not checked either
    const q = run({ switches: ON }, gemini(COMMS()), null, { grounding: () => ({ webSearchQueries: ['gemini down'], groundingChunks: [] }) });
    eq(q.row.email_input.comms_context.outage_confirmed, null);
    // Web search off in the settings: no tool, no search, so not checked
    const o = sim({ drafts: STAND_IN, knowledge: KBASE(), switches: ON });
    o.bot.ev('GEN').settings.web_grounding = 'off';
    o.vertex.assess = () => gemini(COMMS());
    o.vertex.grounding = SOURCES;
    o.paste(OUTAGE);
    o.run();
    eq([o.vertex.calls[0].payload.tools, o.alertRows()[0].email_input.comms_context.outage_confirmed], [undefined, null]);
    eq(B.commsContextOf_(COMMS(), null, null).outage_confirmed, null);
    // Not checked and no statement: the email is byte for byte the email without the switch
    const bare = run({ switches: ON }, gemini(COMMS({ holding_statement: null, document: null })), null, { grounding: null });
    const before = run({}, gemini(COMMS({ holding_statement: null, document: null })), null, { grounding: null });
    eq([bare.sent[0].text, bare.sent[0].html, bare.sent[0].subject], [before.sent[0].text, before.sent[0].html, before.sent[0].subject]);
    assert.ok(bare.w.analystPosts()[0].text.includes('Comms / Status Context: outage · Google\'s status not checked (no web sources) · ' +
      'no approved holding statement found in the Resources documents'));
    // "Not confirmed" (checked, nothing official) is shown as such
    const none = run({ switches: ON }, gemini(COMMS({ outage_confirmed: false, status_summary: 'No incident is listed for the Gemini app',
      holding_statement: null })));
    assert.ok(none.sent[0].text.includes(`Google status: Not confirmed by Google (${STATUS}): No incident is listed for the Gemini app`));
  });

  test('outage comms ON: a post that isn\'t about an outage, a bug or a policy issue (applies false, nothing returned, odd values) gets nothing new but the question', () => {
    const base = run({ switches: ALL_OFF() }, gemini(undefined));
    [{ applies: false, kind: 'outage', outage_confirmed: true }, undefined, null, 'yes', ['outage'], { applies: 'true', kind: 'outage' },
      { kind: 'outage', holding_statement: STATEMENT, document: 'Reactive statements' }].forEach(cc => {
      const r = run({ switches: ON }, gemini(cc));
      eq([JSON.stringify(cc), outcome(r, false)], [JSON.stringify(cc), outcome(base, false)]);
      assert.match(systemOf(r.payload), /COMMS \/ STATUS CONTEXT/);
    });
    // The knowledge base fits whole here, so the comms phrases change nothing in what Gemini reads: the prompt is today's
    // plus the one paragraph
    const r = run({ switches: ON }, gemini({ applies: false }));
    eq(systemOf(r.payload), systemOf(base.payload).replace('check\'s finding.', `check's finding.${B.commsPrompt_(Object.assign(parse(OUTAGE),
      { outageComms: true, knowledge: { text: 'x' } }))}`));
  });

  test('outage comms ON: odd values from Gemini are cleaned (links, kinds, long text, non-strings) and never break the run', () => {
    const web = { queries: ['q'], sources: [{ title: STATUS, uri: 'https://vertexaisearch.cloud.google.com/x' }] };
    const k = B.knowledgeFor_(KBASE(), { text: 'gemini outage', phrases: [], handles: [] }, { budget: 100000 });
    const c = B.commsContextOf_({ applies: true, kind: 'Service OUTAGE', outage_confirmed: true,
      status_source: '[Google Workspace Status Dashboard](https://www.google.com/appsstatus/dashboard/) https://vertexaisearch.cloud.google.com/abc',
      status_summary: `See <https://status.example.com|the dashboard>: down since 8 AM. ${'x'.repeat(400)}` }, k, web);
    eq([c.kind, c.status_source, c.status_summary.length <= 240, /https?:|www\./.test(c.status_summary)], ['outage', STATUS, true, false]);
    eq(['bug', 'Widespread bug', 'policy', 'Policy update', 'constructor', '__proto__', 'meme', ''].map(kind =>
      B.commsContextOf_({ applies: true, kind }, null, null).kind), ['bug', 'bug', 'policy', 'policy', '', '', '', '']);
    eq([B.commsKindName_('constructor'), B.commsKindName_('toString'), B.commsKindName_('bug')], ['', '', 'widespread bug']);
    eq(B.commsContextOf_({ applies: true, kind: 'outage', outage_confirmed: 'yes', holding_statement: 42, document: { x: 1 } }, k, web),
      { kind: 'outage', outage_confirmed: null, status_source: '', status_summary: '', holding_statement: '', document: '', dropped: '',
        unclear: true });
    // A long statement that is in the document is kept, cut at COMMS_STATEMENT_MAX_CHARS_
    const long = 'We are aware of the issue. '.repeat(80).trim();
    const kl = B.knowledgeFor_({ docs: [{ name: 'Statements', url: 'u', covers: '', text: `Holding statement:\n${long}` }] },
      { text: 'x', phrases: [], handles: [] }, { budget: 100000 });
    const cl = B.commsContextOf_({ applies: true, kind: 'outage', holding_statement: long, document: 'Statements' }, kl, web);
    eq([cl.holding_statement.length, cl.holding_statement.endsWith('…'), cl.document], [B.ev('COMMS_STATEMENT_MAX_CHARS_'), true, 'Statements']);
    // Through the bot: messy values, and a check that throws, never stop the run or reach Burson
    const messy = run({ switches: ON }, gemini({ applies: true, kind: { a: 1 }, outage_confirmed: true, status_source: ['x'],
      status_summary: 7, holding_statement: ['a'], document: 3 }));
    eq([messy.report.errors, messy.sent.length, messy.w.bursonPosts()], [[], 1, []]);
    const w = sim({ drafts: STAND_IN, knowledge: KBASE(), switches: ON });
    w.vertex.assess = () => gemini(COMMS());
    w.vertex.grounding = SOURCES;
    w.bot.commsContextOf_ = () => { throw new Error('boom'); };
    const msg = w.paste(OUTAGE);
    const report = w.run();
    eq([report.errors, w.gmail.sentMessages().length, JSON.stringify(w.alertRows()[0]).includes('comms_context')], [[], 1, false]);
    assert.ok(w.chat.botReactions(msg.name).includes('📦'));
    assert.ok(!hasComms(w.gmail.sentMessages()[0].text) && !w.analystPosts().some(m => hasComms(m.text)));
    // Gemini down: the rules alone, as always
    const down = run({ switches: ON }, () => { throw new Error('Vertex AI unavailable'); });
    eq([down.sent.length, down.report.errors, JSON.stringify(down.row).includes('comms_context')], [1, [], false]);
    // A stored email_input someone mangled: the email goes without the section, never an error
    eq([B.commsEmailRows_('x'), B.commsEmailRows_([1]), B.commsEmailRows_({ outage_confirmed: 'yes' }), B.commsEmailRows_(null)], [[], [], [], []]);
    eq(B.commsEmailRows_({ kind: 'constructor', outage_confirmed: false, status_source: 'S' }), [['Google status', 'Not confirmed by Google (S)']]);
  });

  test('outage comms ON: the column C note never stops the run (no script properties), and counts each post once a day', () => {
    const logged = [];
    const review = { recordKey: 'x', commsContext: { kind: 'outage', outage_confirmed: null, status_source: '', status_summary: '',
      holding_statement: STATEMENT, document: 'Reactive statements', dropped: '' } };
    B.noteOutageComms_({ now: () => NOW, log: t => logged.push(t) }, review);  // B has no PropertiesService
    assert.ok(logged.some(l => /^couldn't note the comms \/ status context for the Control tab: /.test(l)), logged.join('\n'));
    const w = sim({ drafts: STAND_IN, knowledge: KBASE(), switches: ON });
    w.g.props.set('OUTAGE_COMMS', JSON.stringify({ day: '2026-10-13', keys: ['a', 'b'] }));
    const ctx = { now: () => w.g.clock.now, log: () => {} };
    w.bot.noteOutageComms_(ctx, { recordKey: 'p1', commsContext: review.commsContext });
    w.bot.noteOutageComms_(ctx, { recordKey: 'p1', commsContext: review.commsContext });
    w.bot.noteOutageComms_(ctx, { recordKey: 'p2', commsContext: Object.assign({}, review.commsContext, { kind: 'policy' }) });
    eq([JSON.parse(w.g.props.get('OUTAGE_COMMS')).keys, switchNote(w)],
      [['p1', 'p2'], '2 today · last: policy issue · status not checked · holding statement found']);
    w.g.props.set('OUTAGE_COMMS', '{not json');
    w.bot.noteOutageComms_(ctx, { recordKey: 'p3', commsContext: review.commsContext });
    eq(JSON.parse(w.g.props.get('OUTAGE_COMMS')).keys, ['p3']);
  });

  test('outage comms ON: never twice: later runs, a retried send and the same post again make one email with the section and one review; the count is one post', () => {
    const w = sim({ drafts: STAND_IN, knowledge: KBASE(), switches: ON });
    let reviews = 0;
    w.vertex.assess = () => { reviews++; return gemini(COMMS()); };
    w.vertex.grounding = SOURCES;
    w.gmail.fail = (method, path) => (path === 'messages/send' ? { code: 500, body: { error: { message: 'backend error' } } } : null);
    w.paste(OUTAGE);
    w.run();
    eq([w.gmail.sentMessages().length, w.alertRows()[0].email_status], [0, 'pending']);
    w.gmail.fail = null;
    w.run();  // the retry works from the stored email_input: the section is still there, with no second review
    w.run();
    eq([w.gmail.sentMessages().length, reviews, w.alertRows()[0].email_status], [1, 1, 'sent']);
    assert.ok(w.gmail.sentMessages()[0].text.includes(`Holding statement: "${STATEMENT}"`));
    // The same post again an hour later: a repeat (❌), reviewed once more; still one email, still one post on column C
    w.g.clock.now += 3600e3;
    const again = w.paste(OUTAGE);
    w.run();
    eq([w.gmail.sentMessages().length, reviews, w.chat.botReactions(again.name)], [1, 2, ['❌']]);
    eq(switchNote(w), `1 today · last: outage · confirmed by Google (${STATUS}) · holding statement found`);
  });

  test('outage comms ON: without a stand-in it\'s a Gmail draft with the section (a test draft, or the live one to the real distros); a test draft rebuilt for ✍️ keeps it', () => {
    const r = run({ switches: ON, drafts: DRAFTS }, gemini(COMMS()));
    eq([r.drafts.length, r.sent.length, r.row.email_status], [1, 0, 'drafted']);
    assert.ok(r.drafts[0].text.includes(`Holding statement: "${STATEMENT}" (from Reactive statements)`), r.drafts[0].text);
    assert.match(r.drafts[0].text, /^T&S: No$/m);
    // The draft note says where the draft is; the line itself is already under the forwarded alert (no repeat)
    const note = r.w.analystPosts().find(m => m.threadReply && /Social Alert draft is in Gmail Drafts/.test(m.text));
    assert.ok(note && !/Comms \/ Status Context/.test(note.text), note && note.text);
    eq(r.w.analystPosts().filter(m => /Comms \/ Status Context/.test(m.text)).length, 1);
    r.w.chat.addReaction(r.w.analystPosts().filter(m => !m.threadReply)[0].name, '✍️');
    r.w.run();
    const after = r.w.gmail.draft(r.drafts[0].id);
    assert.match(after.text, /^T&S: Yes$/m);
    assert.ok(after.text.includes(`Holding statement: "${STATEMENT}" (from Reactive statements)`) && after.html.includes('>Comms / Status Context</div>'));
    // Live (no stand-in at all): the draft to the real distros carries it too; nothing is sent
    const live = sim({ drafts: LIVE, knowledge: KBASE(), switches: ON });
    live.bot.ev('GEN').email.stand_in = '';
    live.vertex.assess = () => gemini(COMMS());
    live.vertex.grounding = SOURCES;
    live.paste(OUTAGE);
    live.run();
    const [d] = live.gmail.allDrafts();
    eq([live.gmail.sentMessages().length, d.to.length > 0, d.html.includes('>Comms / Status Context</div>')], [0, true, true]);
    // Live, the T&S row of a draft changes alone: still exactly one T&S row, the section untouched
    live.chat.addReaction(live.analystPosts().filter(m => !m.threadReply)[0].name, '✍️');
    live.run();
    const ld = live.gmail.draft(d.id);
    eq([(ld.text.match(/^T&S: /gm) || []).length, ld.text.includes(`Holding statement: "${STATEMENT}"`)], [1, true]);
    assert.match(ld.text, /^T&S: Yes$/m);
  });

  test('outage comms ON: Burson never hears about it: fix requests and answers are word for word what they\'d be with the switch OFF; analysts\' answers have the line', () => {
    // An alert Burson must fix: the fix request in its thread is the same with the switch ON
    const on = run({ switches: ON }, gemini(COMMS()), OUTAGE_WRONG);
    const off = run({}, gemini(COMMS()), OUTAGE_WRONG);
    assert.ok(on.w.bursonPosts().length >= 1);
    eq(on.w.bursonPosts().map(m => m.text), off.w.bursonPosts().map(m => m.text));
    eq(on.reactions, off.reactions);
    assert.ok(on.w.analystPosts()[0].text.includes('Comms / Status Context'));
    // Burson asks about it: the answer's prompt has nothing of it
    const r = run({ switches: ON }, gemini(COMMS()));
    const w = r.w;
    w.vertex.answer = () => 'Thanks for flagging this, it\'s in review.';
    w.reply(r.msg, 'is the gemini app down? is there a statement we can use?');
    w.run();
    const answers = () => w.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.answer);
    const toBurson = JSON.stringify(answers()[0].payload);
    assert.ok(!/Comms \/ Status Context|Workspace Status Dashboard|share an update here as soon as we can|comms_context/.test(toBurson), toBurson);
    assert.ok(w.bursonPosts().every(m => !hasComms(m.text) && !/gemini app right now|analyst|bigquery|automat/i.test(m.text)),
      w.bursonPosts().map(m => m.text).join('\n'));
    // An analyst asks in the forwarded alert's thread: their answer's context has the line
    const [fwd] = w.analystPosts().filter(m => !m.threadReply);
    w.chat.say(w.ANA, 'is there an approved statement for this one?', { thread: fwd.thread.name, sender: 'users/im_lead' });
    w.run();
    const toAnalyst = answers()[answers().length - 1].payload.contents[0].parts[0].text;
    assert.ok(toAnalyst.includes(`Comms / Status Context: ${LINE}`), toAnalyst);
  });

  test('outage comms ON: the auto-correct space shows the line in the change note (even when nothing changed); the live Burson space is only read', () => {
    const extra = { sourceReadOnly: true, changeNotes: true };
    const r = run({ switches: ON }, gemini(COMMS()), null, { extra });
    const [top] = r.w.analystPosts().filter(m => !m.threadReply);
    eq(top.text, OUTAGE);  // the corrected alert on its own, exactly as Burson's would look
    const notes = r.w.analystPosts().filter(m => m.threadReply && m.thread.name === top.thread.name).map(m => m.text);
    assert.ok(notes.includes(`Comms / Status Context: ${LINE}`), notes.join('\n---\n'));
    eq([r.w.bursonPosts(), r.reactions], [[], []]);
    // OFF: no note at all (nothing changed)
    const off = run({}, gemini(COMMS()), null, { extra });
    eq(off.w.analystPosts().filter(m => m.threadReply && !/Social Alert/.test(m.text)).map(m => m.text), []);
    // With changes too, the line comes last
    const fixed = run({ switches: ON }, gemini(COMMS()), OUTAGE_WRONG, { extra });
    const note = fixed.w.analystPosts().find(m => m.threadReply && /Updates made to this alert:/.test(m.text));
    assert.ok(note && note.text.endsWith(`\nComms / Status Context: ${LINE}`), note && note.text);
  });

  test('outage comms: the pieces (knowledge search words, the prompt without documents, the schema with KB & Guidance, the analyst line)', () => {
    const parsed = parse(OUTAGE);
    const q = B.knowledgeQuery_(Object.assign({}, parsed, { outageComms: true }));
    const q0 = B.knowledgeQuery_(parsed);
    eq([q.text, q.phrases, q.handles], [q0.text, q0.phrases, q0.handles]);
    eq([q.comms, 'comms' in q0], [B.ev('KNOWLEDGE_COMMS_PHRASES_'), false]);
    // With the words, the passage with the holding statement outranks one that only shares more of the alert's own words
    const passages = ['Gemini app help: chats that fail to load for users in Europe, and what to tell them',
      'Gemini app: approved holding statement (reactive statement) for an incident: We are aware of the issue and will post a status update.'];
    const s0 = B.knowledgeScores_(passages, q0);
    const s1 = B.knowledgeScores_(passages, q);
    assert.ok(s0[0] > s0[1] && s1[1] > s1[0], JSON.stringify([s0, s1]));
    // Without documents, the paragraph asks for no statement (and any statement is left out)
    const bare = Object.assign({}, parsed, { outageComms: true, knowledge: { text: '', docs: [] } });
    assert.match(B.commsPrompt_(bare), /leave `holding_statement` and `document` null \(there are no documents to take a statement from\)\. Otherwise/);
    assert.ok(!/copy the statement word for word/.test(B.commsPrompt_(bare)));
    eq(B.commsContextOf_(COMMS(), bare.knowledge, null).dropped, '"Reactive statements" isn\'t a document it was given');
    // Both switches ON: one schema with both additions; ASSESS_SCHEMA_ untouched
    const both = B.assessSchema_(Object.assign({}, parsed, { outageComms: true, kbStartAlerts: true }));
    eq([!!both.properties.comms_context, !!both.properties.social_alert.properties.per], [true, true]);
    eq(B.assessSchema_(Object.assign({}, parsed, { outageComms: true })).properties.social_alert, plain(B.ev('ASSESS_SCHEMA_').properties.social_alert));
    both.properties.comms_context.properties.kind.type = 'X';
    eq(B.assessSchema_(Object.assign({}, parsed, { outageComms: true })).properties.comms_context, plain(B.ev('COMMS_CONTEXT_SCHEMA_')));
    eq(Object.keys(B.ev('ASSESS_SCHEMA_').properties).includes('comms_context'), false);
    // The analyst line, by case
    const line = c => B.commsLine_(Object.assign({ kind: '', outage_confirmed: null, status_source: '', status_summary: '', holding_statement: '',
      document: '' }, c));
    eq([line({}), line({ kind: 'policy', outage_confirmed: false, status_summary: 'No change announced' }),
      line({ kind: 'bug', outage_confirmed: true, holding_statement: 'x'.repeat(400), document: 'D' }).length < 400],
    ['Google\'s status not checked (no web sources) · no approved holding statement found in the Resources documents',
      'policy issue · not confirmed by Google: No change announced · no approved holding statement found in the Resources documents', true]);
    // Gemini's review only: its comms_context is ignored when the review isn't asked for one (the switch OFF)
    const llm = Object.assign(gemini(COMMS()), { _web: { queries: [], sources: [{ title: STATUS, uri: 'u' }] } });
    eq('commsContext' in B.reviewAlert_(Object.assign(parse(OUTAGE), { outageComms: 'yes' }), { llm, now: NOW, history: [] }), false);
    const on = B.reviewAlert_(Object.assign(parse(OUTAGE), { outageComms: true }), { llm, now: NOW, history: [] });
    eq([on.commsContext.outage_confirmed, on.notes], [true, [`Comms / Status Context: outage · confirmed by Google (${STATUS}): ${SUMMARY} · ` +
      'no approved holding statement found in the Resources documents']]);
  });

  test('outage comms ON from the Control tab (row 20), end to end through poll(): the Social Alert to the stand-in has the section, column C says what it found; OFF it doesn\'t', () => {
    const go = on => {
      const t = e2e();
      t.bot.setup();
      t.set('B30', 'tester@testing.test');
      if (on) t.control().getRange(20, 2).setValue('ON');
      t.g.vertex.assess = payload => gemini(/COMMS \/ STATUS CONTEXT/.test(payload.systemInstruction.parts[0].text)
        ? COMMS({ holding_statement: null, document: null }) : undefined);
      t.g.vertex.grounding = SOURCES;
      const alert = t.chat.say(TEST_FEED, OUTAGE, { sender: 'users/bot' });
      t.poll();
      t.poll();
      return { t, alert };
    };
    const on = go(true);
    const sent = on.t.g.gmail.sentMessages();
    eq(sent.map(m => m.to), [['tester@testing.test']]);
    assert.ok(sent[0].text.includes(`--- Comms / Status Context ---\nIssue: Outage\nGoogle status: Confirmed by Google (${STATUS}): ${SUMMARY}`),
      sent[0].text);
    assert.ok(on.t.chat.botReactions(on.alert.name).includes('📦'));
    assert.match(on.t.control().cell(20, 3), new RegExp('^✓ ON: checks outage claims and adds approved holding statements from the ' +
      `Resources documents · 1 today · last: outage · confirmed by Google \\(${STATUS}\\)$`));
    eq([on.t.chat.botPosts(TEST_FEED), on.t.chat.botPosts(REAL)], [[], []]);
    const off = go(false);
    const offSent = off.t.g.gmail.sentMessages();
    eq(offSent.length, 1);
    assert.ok(!hasComms(offSent[0].text) && !hasComms(offSent[0].html));
    eq(off.t.control().cell(20, 3), 'OFF (standard review)');
  });

  test('outage comms ON: the knowledge search only favours passages that hold a comms phrase ("holding statement", "known issue"…); every other passage scores as with the switch OFF, so an unrelated alert reads the same knowledge', () => {
    const maps = parse(H.MAPS_LOW);
    const q0 = B.knowledgeQuery_(maps);
    const q = B.knowledgeQuery_(Object.assign({}, maps, { outageComms: true }));
    // Passages with the common words of the old search list (issue, status, update, incident, outage), but no comms phrase
    const generic = ['Issue Name and Issue Status: update the issue status when an incident or outage is reported on Maps.',
      'Maps Street View: a dog chasing the Google Maps car is a meme, not an incident.',
      'Brandwatch outage email: send an update to the team when an incident starts.'];
    eq(B.knowledgeScores_(generic, q), B.knowledgeScores_(generic, q0));
    // A long document (passages are picked): the same parts with the switch ON as OFF
    const para = (k, words) => `Section ${k}\n${Array.from({ length: 30 }, () => words).join(' ')}`;
    const text = Array.from({ length: 24 }, (_, k) => (k % 3 === 0
      ? para(k, 'Issue status: post an update on the incident, the issue and the outage.')
      : k % 3 === 1 ? para(k, 'Street View posts: a dog chasing the Google Maps car on Reddit.') : para(k, 'Doodle complaints go to the Doodle team.')))
      .join('\n\n');
    const kb = { docs: [{ name: 'Handbook', url: 'u', covers: '', text }] };
    eq(B.knowledgeFor_(kb, q, { budget: 12000 }).text, B.knowledgeFor_(kb, q0, { budget: 12000 }).text);
    // ...and a passage with a comms phrase still comes first for an outage post
    const out = parse(OUTAGE);
    const passages = ['Gemini app help: chats that fail to load for users in Europe, and what to tell them',
      'Gemini app: approved holding statement for this known issue: We are aware of it.'];
    const s = B.knowledgeScores_(passages, B.knowledgeQuery_(Object.assign({}, out, { outageComms: true })));
    assert.ok(s[1] > s[0], JSON.stringify(s));
  });

  test('outage comms ON: web sources but no answer on Google\'s status reads "unclear", not "not checked (no web sources)"; the email still shows no status', () => {
    const r = run({ switches: ON }, gemini(COMMS({ outage_confirmed: null })));
    const line = 'outage · Google\'s status unclear (searched the web, couldn\'t tell) · holding statement from Reactive statements: ';
    assert.ok(r.w.analystPosts()[0].text.includes(`QA: Comms / Status Context: ${line}`), r.w.analystPosts()[0].text);
    assert.ok(!/Google status|confirmed by Google/i.test(r.sent[0].text + r.sent[0].html), r.sent[0].text);
    eq(switchNote(r.w), '1 today · last: outage · status unclear · holding statement found');
    const web = { queries: ['q'], sources: [{ title: STATUS, uri: 'u' }] };
    eq([B.commsStatusText_(B.commsContextOf_(COMMS({ outage_confirmed: null }), null, web)),
      B.commsStatusText_(B.commsContextOf_(COMMS({ outage_confirmed: null }), null, null)),
      B.commsStatusText_(B.commsContextOf_(COMMS(), null, null))],
    ['Google\'s status unclear (searched the web, couldn\'t tell)', 'Google\'s status not checked (no web sources)',
      'Google\'s status not checked (no web sources)']);
    // Analysts' answers read it from the Alert log row
    eq(B.commsLine_(r.row.email_input.comms_context).startsWith('outage · Google\'s status unclear'), true);
  });

  test('outage comms ON: a status source or summary never carries a bare web address (host or host/path) either', () => {
    const web = { queries: ['q'], sources: [{ title: STATUS, uri: 'u' }] };
    const c = B.commsContextOf_({ applies: true, kind: 'outage', outage_confirmed: true,
      status_source: 'status.cloud.google.com/incidents/abc123',
      status_summary: 'See google.com/appsstatus for details: Gemini app disruption on status.cloud.google.com since 8 AM' }, null, web);
    eq([c.status_source, c.status_summary], ['', 'See for details: Gemini app disruption on since 8 AM']);
    eq(B.commsContextOf_({ applies: true, kind: 'outage', outage_confirmed: true, status_source: 'theverge.com',
      status_summary: 'Gemini 2.5 and Node.js users in the U.S. saw errors at 8 a.m. ET, i.e. for an hour' }, null, web),
    { kind: 'outage', outage_confirmed: true, status_source: '', holding_statement: '', document: '', dropped: '',
      status_summary: 'Gemini 2.5 and Node.js users in the U.S. saw errors at 8 a.m. ET, i.e. for an hour' });
    // Through the bot: the email and the analyst line have no address
    const r = run({ switches: ON }, gemini(COMMS({ status_source: `${STATUS} (status.cloud.google.com/incidents/abc123)` })));
    assert.ok(![r.sent[0].text, r.sent[0].html, r.w.analystPosts()[0].text].some(s => s.includes('status.cloud.google.com')), r.sent[0].text);
    eq(r.row.email_input.comms_context.status_source, STATUS);
    assert.ok(r.sent[0].text.includes(`Google status: Confirmed by Google (${STATUS}): ${SUMMARY}`), r.sent[0].text);
  });
};
