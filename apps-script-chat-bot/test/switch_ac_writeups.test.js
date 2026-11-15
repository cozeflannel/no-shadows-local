// Reviewed alerts that explain themselves, in the Auto-correct space (B10, AutoCorrect.gs): the corrected alert's first
// line says the agentic assistant reviewed (and corrected) it, with a link to Burson's original (Voice.gs reviewedLine_;
// everything that reads the alert back skips it: Alert.gs RX_BOILERPLATE_, isBotFormattedText_); the thread note lists
// what it changed and who changed it (changeNoteText_); it decides from settings.autocorrect_min_confidence instead of
// asking the reader to double-check (Review.gs rule 6); a Direct BigQuery card, posted before its review, gets the same
// note (Bot.gs inPlaceNote_); the review call writes the summary paragraph, its web background only with web sources
// (Review.gs writeupPrompt_ / writeupOf_), for the corrected alert, its note and the Social Alert email; and the
// corrected alert carries the post's own picture (Bot.gs correctedAlertPicture_). The main flow is exactly as before.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, NOW, world, parse, review } = H;

  const REVIEWED = '✅ *Reviewed by the agentic assistant*';
  const CORRECTED = '✅ *Reviewed and corrected by the agentic assistant*';
  const HEAD = 'The agentic assistant reviewed this alert and made these changes:';
  const IN_PLACE = 'The agentic assistant reviewed this alert. The card above was posted before the review; the email uses ' +
    'these corrections:';
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const SAM = 'https://x.com/WasSamLowryEsq/status/2109952063492993159';
  const P0_SUMMARY = parse(F.P0_OK).fields.summary;
  // The write-up Gemini gives for F.P0_OK, and the web searches behind it
  const POST_PART = 'X user @WasSamLowryEsq (652 followers) says Google Search showed mainly white protesters for "Paris riots ' +
    '2026" and accuses Google of a misleading account of events. The post does not say which results it saw.';
  const WEB_PART = 'The 2026 Paris riots followed a police shooting in the city. Le Monde and Reuters report the riots; neither ' +
    'reports the claim about Search.';
  const WRITEUP = { post: POST_PART, background: WEB_PART };
  const SOURCES = payload => (payload.tools ? { webSearchQueries: ['Paris riots 2026 Google Search white protesters'], groundingChunks: [
    { web: { title: 'Paris riots: what we know - Le Monde', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC1' } },
    { web: { title: 'reuters.com', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/DeF2' } }] } : null);

  /** world() in the Auto-correct flow (ctx.sourceReadOnly, ctx.changeNotes), with any other ctx fields from extra(w). */
  const ac = (opts, extra, flow) => {
    const w = world(Object.assign({ drafts: STAND_IN }, opts || {}));
    const base = w.ctx;
    w.ctx = () => Object.assign(base(), flow === false ? {} : { sourceReadOnly: true, changeNotes: true },
      typeof extra === 'function' ? extra(w) : (extra || {}));
    return w;
  };
  const tops = w => w.analystPosts().filter(m => !m.threadReply);
  const notesUnder = (w, top) => w.analystPosts().filter(m => m.threadReply && m.thread.name === top.thread.name).map(m => m.text);
  const reviewCall = w => w.vertex.calls.find(c => c.payload.generationConfig.responseSchema.properties.checks);
  const check = (id, proposed, confidence) => ({ id, ok: false, confidence, finding: 'The post shows otherwise', proposed_value: proposed });

  // =============================================================================================================
  // A1. The corrected alert's first line
  // =============================================================================================================

  test('reviewed alerts: the corrected alert\'s first line says the agentic assistant reviewed it (and corrected it, when the note lists a change), with a link to Burson\'s original when its message name gives one; everything that reads the alert back skips the line, and the alert parses to the same fields', () => {
    const fixed = review(F.MISTAKES);
    const LIVE = 'spaces/AAQAaa_0I9g/messages/Xk2b9zQ1.Xk2b9zQ1';
    const LINK = 'https://chat.google.com/room/AAQAaa_0I9g/Xk2b9zQ1/Xk2b9zQ1';
    eq([B.reviewedLine_(fixed, LIVE), B.reviewedLine_(review(F.P0_OK), LIVE), B.reviewedLine_(fixed, 'spaces/AAQAaa_0I9g/messages/m12'),
      B.reviewedLine_(fixed, '')], [`${CORRECTED} · <${LINK}|Original alert>`, `${REVIEWED} · <${LINK}|Original alert>`, CORRECTED, CORRECTED]);
    // a summary rewrite alone isn't a correction the note lists, so the alert reads "Reviewed by"
    eq(B.reviewedLine_({ fixes: [{ field: 'summary', old: 'a', new: 'b' }], silentFixes: [] }, ''), REVIEWED);
    // read back: the same fields, missing labels, flags and record key, still an alert, still the bot's own text
    const fixtures = Object.keys(F);
    assert.ok(fixtures.length >= 8);
    fixtures.forEach(name => [CORRECTED, REVIEWED, `${CORRECTED} · <${LINK}|Original alert>`].forEach(line => {
      const text = `${line}\n${F[name]}`;
      const before = parse(F[name]);
      const after = parse(text);
      eq([after.fields, after.missing, after.flags, B.recordKey_(after.fields)],
        [before.fields, before.missing, before.flags, B.recordKey_(before.fields)], `${name} under "${line}"`);
      assert.ok(B.detectAlert_(text, after, 'Zapier'), name);
      assert.ok(B.isBotFormattedText_(text), name);
    }));
    // rebuilt (a resend's corrections on the alert as posted): the line stays as it is
    const posted = `${CORRECTED}\n${F.MISTAKES}`;
    const rebuilt = B.rebuildAlert_(posted, parse(posted), fixed.fields, fixed.changed);
    eq(rebuilt, `${CORRECTED}\n${F.MISTAKES_FIXED}`);
    // the bot's own post, also when its id and records are lost: never answered as a person's question
    const ctx = { botUser: 'users/bot', store: { isOwnPost: () => false } };
    assert.ok(B.isOwnMessage_(ctx, { senderName: 'users/bot', text: `${CORRECTED}\n${F.MISTAKES_FIXED.replace('offensive reply', 'offensive reply?')}` }));
    assert.ok(!B.isOwnMessage_(ctx, { senderName: 'users/bot', text: F.MISTAKES_FIXED }));
  });

  test('reviewed alerts: end to end in the Auto-correct space, the corrected alert is posted under the bot\'s first line, its note says who changed what, and nothing is posted in the Burson space; the main flow\'s forward is exactly as before', () => {
    const w = ac();
    w.paste(F.MISTAKES);
    const report = w.run();
    eq(tops(w).map(m => m.text), [`${CORRECTED}\n${F.MISTAKES_FIXED}`]);
    eq(notesUnder(w, tops(w)[0]), [`${HEAD}\n- Product: Gems to Gemini App\n- Social Network: Instagram to X\n` +
      '- Priority banner: P2 to P0\n- Engagement: LOW to HIGH']);
    eq([w.bursonPosts(), report.corrected], [[], 1]);
    const main = ac({}, {}, false);
    main.paste(F.MISTAKES);
    main.run();
    assert.ok(tops(main)[0].text.startsWith(`${F.MISTAKES_FIXED}\n\nQA corrected:\n`), tops(main)[0].text);
    assert.ok(!/agentic assistant/.test(main.analystPosts().map(m => m.text).join('\n')));
  });

  // =============================================================================================================
  // A3. Burson's resend
  // =============================================================================================================

  test('reviewed alerts: Burson\'s resend with a value the alert above lacks gets a note that says the value is not in the alert above (the bot never edits a posted message); the main flow\'s note is as before', () => {
    const NOTE = `Burson resent this alert. These values are not in the alert above:\n- Link: <${SAM}|Alleged Bias in Search Reporting for Paris Riots 2026>`;
    const w = ac();
    w.paste(F.NO_LINK);
    w.run();
    w.paste(F.P0_OK);
    w.run();
    const [top] = tops(w);
    eq([tops(w).length, notesUnder(w, top)], [1, ['Not fixed: Burson\'s alert has no link to the post (Auto-find missing links, row 14, is OFF)', NOTE]]);
    eq(w.bursonPosts(), []);
    const forwarded = B.snapshotFields_(parse(F.NO_LINK).fields);
    eq([B.updateNote_(forwarded, review(F.P0_OK), true), B.updateNote_(forwarded, review(F.P0_OK))],
      [NOTE, NOTE.replace('Burson resent this alert. These values are not in the alert above:', 'Burson resent this alert with updates:')]);
  });

  // =============================================================================================================
  // A4. The agentic assistant decides
  // =============================================================================================================

  test('reviewed alerts: in the Auto-correct space Gemini\'s value is applied from autocorrect_min_confidence (0.6) instead of a double-check, never on a field the rules corrected, the summary, a blank value or a check the review may not fix; the main flow keeps 0.9', () => {
    const S = B.ev('GEN').settings;
    eq([S.autocorrect_min_confidence, S.llm_min_confidence, S.autocorrect_writeup], [0.6, 0.9, true]);
    const run = (text, checks, autoCorrect, settings) => B.reviewAlert_(parse(text), { now: NOW, history: [], llm: { checks },
      autoCorrect, settings: settings ? Object.assign({}, S, settings) : undefined });
    const topic = [check('sensitive_topics_fit', 'Politics', 0.75)];
    const on = run(F.P0_OK, topic, true);
    eq([on.fixes.map(x => [x.field, x.new, x.source]), on.unsure], [[['risk_tags', ['Politics'], 'llm']], []]);
    const off = run(F.P0_OK, topic, false);
    eq([off.fixes, off.unsure.map(u => [u.field, u.proposed])], [[], [['risk_tags', ['Politics']]]]);
    // under 0.6: Burson's value stays, in both flows (kept on review.unsure, for the run log)
    eq(run(F.P0_OK, [check('sensitive_topics_fit', 'Politics', 0.55)], true).fixes, []);
    // a field the rules corrected (Gems -> Gemini App) keeps the rule's value under 0.9; at 0.9 Gemini's wins, as today
    const product = c => run(F.MISTAKES, [check('product_fit', 'AI Overviews', c)], true).fields.product;
    eq([product(0.7), product(0.95)], ['Gemini App', 'AI Overviews']);
    // the summary (the write-up has it), a blank value, a check the review may not fix (llm_fix_severities)
    eq(run(F.P0_OK, [check('summary_grammar', 'A plainer summary of the post about Search.', 0.8)], true).fixes, []);
    eq(run(F.P0_OK, [check('sensitive_topics_fit', '', 0.8)], true).fixes, []);
    eq(run(F.P0_OK, [check('issue_name_neutral', 'Claims of bias in Search results about the Paris riots', 0.8)], true,
      { llm_fix_severities: ['blocking'] }).fixes, []);
    eq(run(F.P0_OK, [check('issue_name_neutral', 'Claims of bias in Search results about the Paris riots', 0.8)], true).fixes
      .map(x => x.field), ['issue_name']);
    // end to end: the change is listed, there's no double-check, and the main flow's footer still asks to check it
    const w = ac();
    w.vertex.assess = () => ({ checks: topic });
    w.paste(F.P0_OK);
    w.run();
    const [top] = tops(w);
    assert.ok(top.text.startsWith(`${CORRECTED}\n`) && top.text.includes('\n[Sensitive Topic]: Politics\n'), top.text);
    eq(notesUnder(w, top).filter(n => !/^Social Alert/.test(n)), [`${HEAD}\n- Sensitive Topic: added Politics`]);
    const low = ac();
    low.vertex.assess = () => ({ checks: [check('sensitive_topics_fit', 'Politics', 0.55)] });
    low.paste(F.P0_OK);
    low.run();
    eq([tops(low)[0].text, notesUnder(low, tops(low)[0]).filter(n => !/^Social Alert/.test(n))], [`${REVIEWED}\n${F.P0_OK}`, []]);
    assert.ok(low.g.logs.some(l => /^left as Burson wrote it \(Gemini wasn't sure enough\): Sensitive Topic \(maybe Politics\), 55% sure/.test(l)),
      low.g.logs.join('\n'));
    const main = ac({}, {}, false);
    main.vertex.assess = () => ({ checks: topic });
    main.paste(F.P0_OK);
    main.run();
    assert.ok(/\nQA check: Sensitive Topic may be "Politics": .* \(75% sure\)/.test(tops(main)[0].text), tops(main)[0].text);
  });

  // =============================================================================================================
  // B1-B3. The write-up
  // =============================================================================================================

  test('reviewed alerts: the write-up is asked for in the same review call only in the Auto-correct space (one more prompt paragraph and schema field); elsewhere the prompt and the schema are exactly as before', () => {
    const parsed = parse(F.P0_OK);
    const plainP = B.assessPrompts_(parsed);
    const withW = B.assessPrompts_(Object.assign({}, parsed, { writeup: true }));
    assert.ok(plainP.schema === B.ev('ASSESS_SCHEMA_'), 'the schema is ASSESS_SCHEMA_ itself');
    eq(Object.keys(withW.schema.properties).filter(k => !(k in plainP.schema.properties)), ['writeup']);
    eq(withW.schema.properties.writeup.required, ['post']);
    const para = B.writeupPrompt_({ writeup: true });
    assert.ok(para.startsWith('\n\nWRITE-UP (writeup): ') && withW.system.includes(para), para);
    eq(withW.system.replace(para, ''), plainP.system);
    eq(withW.prompt, plainP.prompt);
    ['at most 600 characters', 'only from your web search in this call, never from memory', 'Never identify a private individual',
      'Keep every concrete fact the alert\'s summary has unless the post shows it is wrong', 'in English', 'no links, no Markdown']
      .forEach(s => assert.ok(para.includes(s), s));
    eq(B.writeupPrompt_({}), '');
  });

  test('reviewed alerts: the write-up, checked: its background only when the call came back with web sources, at most 600 characters cut at a sentence, plain prose with no links or marks, the outlets\' names (never links); an empty, short, non-English or internal write-up is dropped (Burson\'s summary stays)', () => {
    const web = { queries: ['q'], sources: [{ title: 'Paris riots: what we know - Le Monde', uri: 'https://vertexaisearch.cloud.google.com/a' },
      { title: 'reuters.com', uri: 'https://vertexaisearch.cloud.google.com/b' }, { title: 'Reuters', uri: '' },
      { title: 'bbc.co.uk', uri: '' }, { title: 'apnews.com', uri: '' }] };
    eq(B.writeupOf_(WRITEUP, web), { text: `${POST_PART} ${WEB_PART}`, background: true, sources: ['Le Monde', 'Reuters', 'BBC'] });
    // no web sources (no search, or a search that returned none): the post's part alone
    eq([B.writeupOf_(WRITEUP, null), B.writeupOf_(WRITEUP, { queries: ['q'], sources: [] })],
      [{ text: POST_PART, background: false, sources: [] }, { text: POST_PART, background: false, sources: [] }]);
    // plain prose: links, web addresses and marks out
    const marked = B.writeupOf_({ post: '**X user** @a_b posts [a clip](https://x.com/a/status/1) saying <https://g.co/x|Gemini> lied; ' +
      'see https://example.com/page and theverge.com for more about it.', background: null }, web);
    eq(marked.text, 'X user @a_b posts a clip saying Gemini lied; see and for more about it.');
    // 600 characters at most, cut at a sentence; a background that doesn't fit is left out
    const long = 'The post says Gemini gave a wrong answer about the election in a long thread. '.repeat(9);
    const cut = B.writeupOf_({ post: long, background: WEB_PART }, web);
    assert.ok(cut.text.length <= 600 && /\.$/.test(cut.text) && !cut.background && !cut.sources.length, cut.text);
    // unusable: Burson's summary stays
    [null, 'text', { post: '' }, { post: 'Too short to say anything.' }, { post: `${POST_PART} Pendulum flagged it.` },
      { post: 'Пользователь X написал, что Gemini дал неверный ответ о выборах в Бразилии и об этом говорят все.' },
      { post: `[Product]: Search. ${POST_PART}` }, { post: `${POST_PART} The bot saw it.` }]
      .forEach(x => eq(B.writeupOf_(x, web), null, JSON.stringify(x)));
    // a background that names how the alert was made is left out, the post's part kept
    eq(B.writeupOf_({ post: POST_PART, background: 'BigQuery shows it trending.' }, web), { text: POST_PART, background: false, sources: [] });
    eq([B.webSourceName_({ title: 'g1.globo.com' }), B.webSourceName_({ title: '', uri: 'https://vertexaisearch.cloud.google.com/x' }),
      B.webSourceName_({ title: '', uri: 'https://www.nytimes.com/2026/x.html' })], ['Globo', '', 'Nytimes']);
    // the review keeps it only in the Auto-correct space (parsed.writeup), and it's never a change
    const llm = { checks: [], writeup: WRITEUP, _web: web };
    const r = B.reviewAlert_(Object.assign(parse(F.P0_OK), { writeup: true }), { now: NOW, history: [], llm });
    eq([r.writeup.text, r.fixes, r.changed, r.fields.summary, B.noteChanges_(r)], [`${POST_PART} ${WEB_PART}`, [], [], P0_SUMMARY, []]);
    eq(B.reviewAlert_(parse(F.P0_OK), { now: NOW, history: [], llm }).writeup, undefined);
    eq(B.changeNoteText_(r), 'Sources: Le Monde, Reuters, BBC');
  });

  test('reviewed alerts: end to end, the write-up takes the summary\'s place in the corrected alert and in the Social Alert email (nothing else in it changes, no link or bot wording), the note names its web sources, and it is no correction anywhere (the first line, C10, the Alert log); without web sources it has no background and no note; the main flow is exactly as before', () => {
    const w = ac();
    w.vertex.assess = () => ({ checks: [], writeup: WRITEUP });
    w.vertex.grounding = SOURCES;
    w.paste(F.P0_OK);
    const report = w.run();
    const [top] = tops(w);
    eq(top.text, `${REVIEWED}\n${F.P0_OK.replace(P0_SUMMARY, `${POST_PART} ${WEB_PART}`)}`);
    eq(notesUnder(w, top).filter(n => !/^Social Alert/.test(n)), ['Sources: Le Monde, Reuters']);
    assert.ok(reviewCall(w).payload.systemInstruction.parts[0].text.includes('WRITE-UP (writeup)'));
    eq(reviewCall(w).payload.tools, [{ enterpriseWebSearch: {} }]);  // the review call already has the web search: no extra call
    eq(w.vertex.calls.filter(c => c.payload.generationConfig.responseSchema.properties.checks).length, 1);
    const [row] = w.alertRows();
    eq([report.corrected, row.status, row.requested, row.forwarded_fields.summary], [undefined, 'ok', [], B.truncate_(P0_SUMMARY, 400)]);
    const sent = w.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    eq(sent.length, 1);
    assert.ok(sent[0].text.startsWith(`SOCIAL ALERT\n\n${POST_PART} ${WEB_PART}\n\nLink: ${SAM}\n`), sent[0].text.slice(0, 600));
    assert.ok(![sent[0].text, sent[0].html].some(s => /vertexaisearch|grounding-api|\bbot\b|automat|BigQuery|Le Monde -/i.test(s)));
    eq(w.bursonPosts(), []);
    // the same email without the write-up: only the summary differs
    const without = ac();
    without.paste(F.P0_OK);
    without.run();
    const plainSent = without.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject))[0];
    eq(sent[0].text.replace(`${POST_PART} ${WEB_PART}`, P0_SUMMARY), plainSent.text);
    eq([tops(without)[0].text, notesUnder(without, tops(without)[0]).filter(n => !/^Social Alert/.test(n))], [`${REVIEWED}\n${F.P0_OK}`, []]);
    // no web sources: the post's part alone, and no note
    const bare = ac();
    bare.vertex.assess = () => ({ checks: [], writeup: WRITEUP });
    bare.vertex.grounding = null;
    bare.paste(F.P0_OK);
    bare.run();
    eq([tops(bare)[0].text, notesUnder(bare, tops(bare)[0]).filter(n => !/^Social Alert/.test(n))],
      [`${REVIEWED}\n${F.P0_OK.replace(P0_SUMMARY, POST_PART)}`, []]);
    // the main flow: no write-up asked for, the forward and the email as Burson wrote them
    const main = ac({}, {}, false);
    main.vertex.assess = () => ({ checks: [], writeup: WRITEUP });
    main.vertex.grounding = SOURCES;
    main.paste(F.P0_OK);
    main.run();
    assert.ok(!reviewCall(main).payload.systemInstruction.parts[0].text.includes('WRITE-UP'));
    assert.ok(!('writeup' in reviewCall(main).payload.generationConfig.responseSchema.properties));
    eq(tops(main)[0].text, F.P0_OK);
    assert.ok(main.gmail.sentMessages()[0].text.startsWith(`SOCIAL ALERT\n\n${P0_SUMMARY}\n\n`));
  });

  // =============================================================================================================
  // A5 + B3 (f). A Direct BigQuery card, posted before its review
  // =============================================================================================================

  test('reviewed alerts: a Direct BigQuery card in the Auto-correct space, reviewed after it was posted, gets a thread note with what the review changed and the summary the email uses (the card is never edited); a card with nothing to say gets none', () => {
    const card = (w, text, key) => {
      const msg = w.bot.mirrorPostMessage_(w.ANA, text, key);
      const kept = JSON.parse(w.g.props.get('BQ_INGESTED_MSGS') || '[]');
      w.g.props.set('BQ_INGESTED_MSGS', JSON.stringify(kept.concat([[w.bot.hashText_(msg.name), 'BSIP']])));
      return msg;
    };
    const w = ac();
    w.vertex.assess = () => ({ checks: [], writeup: WRITEUP });
    w.vertex.grounding = SOURCES;
    const c1 = card(w, F.MISTAKES, 'bq:BSIP:k1');
    const report = w.run();
    eq(tops(w).map(m => m.text), [F.MISTAKES]);  // the card, as posted
    eq(notesUnder(w, tops(w)[0]).filter(n => !/^Social Alert|^T&S/.test(n)), [`${IN_PLACE}\n- Product: Gems to Gemini App\n` +
      `- Social Network: Instagram to X\n- Priority banner: P2 to P0\n- Engagement: LOW to HIGH\n- Summary: ${POST_PART} ${WEB_PART}\n` +
      'Sources: Le Monde, Reuters']);
    eq(report.corrected, 1);
    eq(w.bursonPosts(), []);
    // a card the review leaves as it is, with no write-up: no note
    const quiet = ac();
    const c2 = card(quiet, F.P0_OK, 'bq:BSIP:k2');
    quiet.run();
    eq(notesUnder(quiet, tops(quiet)[0]).filter(n => !/^Social Alert|^T&S/.test(n)), []);
    // the email of a card that goes out: the write-up is its summary
    const sent = ac();
    sent.vertex.assess = () => ({ checks: [], writeup: WRITEUP });
    sent.vertex.grounding = SOURCES;
    const c3 = card(sent, F.P0_OK, 'bq:BSIP:k3');
    sent.run();
    eq(notesUnder(sent, tops(sent)[0]).filter(n => !/^Social Alert|^T&S/.test(n)), [`${IN_PLACE}\n- Summary: ${POST_PART} ${WEB_PART}\nSources: Le Monde, Reuters`]);
    const email = sent.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject));
    assert.ok(email.length === 1 && email[0].text.startsWith(`SOCIAL ALERT\n\n${POST_PART} ${WEB_PART}\n\n`), email.map(m => m.text).join('\n---\n'));
  });

  // =============================================================================================================
  // C3. The post's own picture under the corrected alert
  // =============================================================================================================

  test('reviewed alerts: the corrected alert carries the post\'s own picture when the run has a minute for it (uploaded to the Auto-correct space only); never the page\'s preview picture, nothing fetched without time, Chat refusing it posts the alert as text once; the main flow\'s forward has none', () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0xff, 0xd9]);
    const PHOTO = 'https://pbs.twimg.com/media/Paris1.jpg';
    const POST = { platform: 'X', author: 'WasSamLowryEsq', text: 'Search shows only white protesters for Paris riots 2026', photos: [PHOTO], video: null };
    const withPhoto = (opts, extra, flow) => {
      const w = ac(Object.assign({ post: () => JSON.parse(JSON.stringify(POST)) }, opts || {}), extra, flow);
      w.g.pages.set(PHOTO, { code: 200, bytes: JPEG, headers: { 'Content-Type': 'image/jpeg' } });
      return w;
    };
    const attached = m => (m.attachment || []).map(a => [a.contentName, a.contentType]);
    const w = withPhoto();
    w.paste(F.P0_OK);
    w.run();
    eq([tops(w).map(attached), (w.chat.uploads || []).map(u => u.space)], [[[['post.jpg', 'image/jpeg']]], [w.ANA]]);
    eq(tops(w)[0].text, `${REVIEWED}\n${F.P0_OK}`);
    eq(w.bursonPosts(), []);
    // a post with no picture of its own: none (never the picture its page shows link previews: the page is read only for
    // Gemini's media, as in the main flow, which has no picture code at all)
    const FB = 'https://www.facebook.com/abc/posts/1';
    const fbAlert = F.P0_OK.split(SAM).join(FB).replace('| X |', '| Facebook |').replace('[Social Network]: X', '[Social Network]: Facebook');
    const pageRun = flow => {
      const w2 = ac({ post: () => ({ platform: 'Facebook', author: 'abc', text: 'A post', photos: [], video: null }) }, {}, flow);
      w2.g.pages.set(FB, '<html><head><meta property="og:image" content="https://scontent.xx.fbcdn.net/v/p.jpg"></head></html>');
      w2.g.pages.set('https://scontent.xx.fbcdn.net/v/p.jpg', { code: 200, bytes: JPEG, headers: { 'Content-Type': 'image/jpeg' } });
      w2.paste(fbAlert);
      w2.run();
      return w2;
    };
    const page = pageRun();
    const pageReads = w2 => w2.g.fetches.filter(f => f.url === FB || /fbcdn/.test(f.url)).length;
    eq([tops(page).map(attached), (page.chat.uploads || []).length, pageReads(page)], [[[]], 0, pageReads(pageRun(false))]);
    // under a minute left: none, nothing fetched for it (the photo is read only for Gemini's review, as in the main flow)
    const photoReads = w2 => w2.g.fetches.filter(f => f.url === PHOTO).length;
    const late = withPhoto({}, w2 => ({ deadline: w2.g.clock.now + 50 * 1000 }));
    late.paste(F.P0_OK);
    late.run();
    const lateMain = withPhoto({}, w2 => ({ deadline: w2.g.clock.now + 50 * 1000 }), false);
    lateMain.paste(F.P0_OK);
    lateMain.run();
    eq([tops(late).map(attached), (late.chat.uploads || []).length, photoReads(late)], [[[]], 0, photoReads(lateMain)]);
    assert.ok(photoReads(w) === photoReads(lateMain) + 1, 'with time, the picture is the one more read');
    // Chat refusing the alert with its picture: the alert goes as text, once
    const refused = withPhoto();
    refused.chat.fail = (method, path, query, body) => (body && body.attachment ? { code: 400, body: { error: { code: 400, message: 'Invalid attachment' } } } : null);
    refused.paste(F.P0_OK);
    refused.run();
    eq([tops(refused).length, tops(refused).map(attached)], [1, [[]]]);
    assert.ok(refused.g.logs.some(l => /Chat refused the corrected alert with the post's picture, so it goes as text/.test(l)));
    // the main flow: as before, no picture
    const main = withPhoto({}, {}, false);
    main.paste(F.P0_OK);
    main.run();
    eq([tops(main).map(attached), (main.chat.uploads || []).length], [[[]], 0]);
  });
};
