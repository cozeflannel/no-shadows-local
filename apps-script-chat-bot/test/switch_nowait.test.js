// Never wait on Burson (Control tab row 23, key noWait; the row itself is Agent A's, Control.gs): the behavior of
// 85264de / 8e9f7fe behind its own switch, which starts OFF. The tests set ctx.switches.noWait directly (world({noWait})
// / w.noWait, e2e(g, {noWait})).
//   OFF (the default) is LIVE 8a0f20b: a wrong alert gets ⬇️ and a request to fix it and resend it in its thread, and is
//     held (no ❌, no T&S note, no decision) until Burson's resend, which is then decided; a missing link or video
//     timestamp is asked of Burson; the answers, the analyst notes, the Social Alert email, the T&S form, the Results
//     tab and auto-send's note say so, in the v1 wording.
//   ON is HEAD 7933a95: the alert is decided at once with the bot's own corrections (a long video's missing timestamp is
//     the one Gemini found), Burson is told what changed and that it was processed, and Burson's resend anyway is the
//     same alert (never decided twice).
// The differential harness (review/fixes/C/diff_posts.js) checks both modes byte for byte against LIVE and HEAD.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, NOW, world, e2e, review, parse, GUARD, MAPS_LOW, resultsRows } = H;
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const LIVE = { live: true, mailbox: 'im@runner.test', from: 'Brand Social <sender@alerts.test>' };
  const MAPS_LOW_OK = MAPS_LOW.split('Product - Memes & humorous content').join('Product - Meme about Google products');
  const SAM = 'https://x.com/WasSamLowryEsq/status/2109952063492993159';
  // The post's video goes with the review (an og:video page; B1's M7 gating counts a media_review only then)
  const VIDEO_PAGE = '<meta property="og:video" content="https://video.twimg.com/v/clip.mp4">';
  const WATCHED = () => ({ checks: [], media_review: { watched: true, duration_seconds: 245, google_timestamp: '02:15', what_happens: 'Search comes up at 02:15' } });
  const ASKS = /Then resend the alert here\.$|resend the alert here:/;  // the v1 request (fixRequestText_)
  const TELLS = /The alert has been updated, so there is no need to resend it\./;  // processedText_
  const declined = w => w.g.logs.filter(l => /❌ no Social Alert needed/.test(l)).length;
  const row = (w, i) => w.alertRows()[i || 0];

  test('Never wait on Burson OFF (no switches, or every switch OFF): a wrong alert gets ⬇️ and the request to fix it and resend it here, as LIVE; ON: 👍 (drafts off) and Burson is told what the bot changed and that it was processed', () => {
    const r = review(F.MISTAKES);
    const corrected = B.rebuildAlert_(F.MISTAKES, parse(F.MISTAKES), r.fields, r.changed) + '\n\n' + B.forwardFooter_(r);
    for (const mode of ['absent', 'all off', 'on']) {
      const w = world({ noWait: mode === 'on' });
      if (mode === 'all off') { const base = w.ctx; w.ctx = () => Object.assign(base(), { switches: w.bot.switchesOff_() }); }
      const alert = w.paste(F.MISTAKES);
      w.run();
      const [post] = w.bursonPosts();
      eq([post.thread.name, w.analystPosts().map(m => m.text)], [alert.thread.name, [corrected]], mode);  // analysts: the same
      if (mode === 'on') {
        eq([w.chat.botReactions(alert.name), post.text], [['👍'], B.processedText_(r, GUARD)]);
      } else {
        eq([w.chat.botReactions(alert.name), post.text], [['⬇'], B.fixRequestText_(r, GUARD, false)], mode);
        assert.match(post.text, /^Please make the following updates and resend the alert here:\n- Product listed is incorrect\. Please change to Gemini App\./);
      }
      eq([row(w).status, row(w).decision || '', row(w).burson_done], ['fix_requested', '', true], mode);
    }
  });

  test('Never wait on Burson OFF: a wrong alert that needs no Social Alert is held (no ❌, no decision) until Burson\'s resend, which is decided then, once; ON: ❌ at once, and the resend is the same alert (⬇️ on the original, nothing decided twice)', () => {
    const off = world({ drafts: STAND_IN });
    const a = off.paste(MAPS_LOW);
    off.run();
    eq([off.chat.botReactions(a.name), row(off).decision || '', declined(off)], [['⬇'], '', 0]);  // held: waits on Burson
    assert.match(off.bursonPosts()[0].text, ASKS);
    const r = off.paste(MAPS_LOW_OK);
    off.run();
    off.run();
    eq([off.chat.botReactions(a.name), off.chat.botReactions(r.name), declined(off)], [['⬇'], ['❌'], 1]);  // decided on the resend
    eq(off.alertRows().map(x => [x.status, x.decision || '', x.resend_of || '']),
      [['superseded', '', ''], ['fixed', '❌ P2, 300 engagements: below the escalation criteria', 'QA-1001']]);
    eq(off.bursonPosts().length, 1);

    const on = world({ drafts: STAND_IN, noWait: true });
    const b = on.paste(MAPS_LOW);
    on.run();
    eq([on.chat.botReactions(b.name), /^❌ /.test(row(on).decision), declined(on)], [['❌'], true, 1]);
    assert.match(on.bursonPosts()[0].text, TELLS);
    const r2 = on.paste(MAPS_LOW_OK);
    on.run();
    on.run();
    eq([on.chat.botReactions(b.name), on.chat.botReactions(r2.name), declined(on), on.bursonPosts().length], [['❌', '⬇'], [], 1, 1]);
  });

  test('Never wait on Burson OFF: a missing link is asked of Burson ("Link is missing. Please add it. Then resend the alert here.") and analysts see it was requested from Burson; the resend with it is matched. ON: processed without it, and Burson is told it was missing', () => {
    for (const noWait of [false, true]) {
      const w = world({ drafts: STAND_IN, noWait });
      const a = w.paste(F.NO_LINK);
      w.run();
      const [fwd] = w.analystPosts();
      if (noWait) {
        eq([w.bursonPosts()[0].text, w.chat.botReactions(a.name)],
          ['The alert has been updated, so there is no need to resend it. The following updates were made:\n- Link was missing. Please include it in future alerts.', ['📰', '📦', '🌎']]);
        assert.match(fwd.text, /QA: Link missing \(processed without waiting for Burson; Burson was told\)$/);
      } else {
        eq([w.bursonPosts()[0].text, w.chat.botReactions(a.name)], ['Link is missing. Please add it. Then resend the alert here.', ['⬇', '📰', '📦', '🌎']]);
        assert.match(fwd.text, /QA: Link missing \(requested from Burson\)$/);
      }
      w.paste(F.NO_LINK_RESENT);
      w.run();
      eq([w.analystPosts()[1].text, w.bursonPosts().length, w.alertRows().map(x => x.status)],
        [`Burson resent this alert with updates:\n- Link: <${SAM}|Alleged Bias in Search Reporting for Paris Riots 2026>`, 1, ['superseded', 'fixed']], `noWait ${noWait}`);
    }
  });

  test('Never wait on Burson OFF: a long video without a timestamp (the video went with the review) is asked of Burson with the [MM:SS] Gemini found; nothing is added to the corrected alert or the Social Alert email. ON: the bot adds it (a [Timestamp] line, the email\'s line) and Burson is told', () => {
    for (const noWait of [false, true]) {
      const w = world({ drafts: STAND_IN, noWait });
      w.g.pages.set(SAM, VIDEO_PAGE);
      w.vertex.assess = WATCHED;
      w.paste(F.P0_OK);
      w.run();
      const [email] = w.gmail.sentMessages();
      const [fwd] = w.analystPosts();
      if (noWait) {
        eq(w.bursonPosts()[0].text, 'The alert has been updated, so there is no need to resend it. The following updates were made:\n- Timestamp updated to [02:15] (where Google comes up in the video).');
        assert.match(fwd.text, /\n\[Timestamp\]: \[02:15\]\n/);
        assert.match(email.text, /\nTimestamp in the video: \[02:15\]\n/);
        eq(row(w).requested, [{ field: 'video_timestamp', new: '[02:15]', reason: 'where Google comes up in the video' }]);
      } else {
        eq(w.bursonPosts()[0].text, 'Timestamp is missing. Please add [02:15] to the summary (where Google comes up in the video). Then resend the alert here.');
        assert.ok(!/\[Timestamp\]/.test(fwd.text), fwd.text);
        assert.match(fwd.text, /QA: Timestamp missing \(requested from Burson\)/);
        assert.ok(!/Timestamp in the video/.test(email.text + email.html));
        eq(row(w).requested, [{ field: 'video_timestamp', problem: 'missing', suggest: '[02:15] to the summary (where Google comes up in the video)' }]);
      }
    }
    // the review itself: a request (need) OFF, the bot's own fix ON (parsed.noWait, set by Bot.gs only while it's ON)
    const llm = Object.assign(WATCHED(), { _media: { label: 'the post\'s video', kind: 'video' } });
    const offReview = B.reviewAlert_(parse(F.P0_OK), { now: NOW, history: [], llm });
    const onReview = B.reviewAlert_(Object.assign(parse(F.P0_OK), { noWait: true }), { now: NOW, history: [], llm });
    eq([offReview.fixes.map(x => x.field), offReview.missing.map(x => x.field), offReview.fields.video_timestamp || ''], [[], ['video_timestamp'], '']);
    eq([onReview.fixes.map(x => x.field), onReview.missing.map(x => x.field), onReview.fields.video_timestamp], [['video_timestamp'], [], '[02:15]']);
  });

  test('Never wait on Burson OFF: the Social Alert email never has a bot-added timestamp line, and its HTML is as LIVE (no empty slot for it); ON (email_input.no_wait): "Timestamp in the video", and HEAD\'s empty slot when there is none', () => {
    const r = review(F.P0_OK);
    const esc = B.escalation_(r.fields, { now: NOW });
    const stamped = Object.assign({}, r.fields, { video_timestamp: '[02:15]' });
    const mail = (fields, noWait) => B.socialAlertEmail_(B.emailInput_(fields, esc, noWait), B.planRecipients_(esc, esc.text, []),
      { test: false, mailbox: 'bot@runner.test', sendId: 'T' });
    eq([B.emailInput_(r.fields, esc).no_wait, B.emailInput_(r.fields, esc, false).no_wait, B.emailInput_(r.fields, esc, true).no_wait], [undefined, undefined, true]);
    const off = mail(stamped, false);
    const on = mail(stamped, true);
    assert.ok(!/Timestamp in the video/.test(off.text + off.html));
    assert.match(on.text, /\nLink: https:\/\/x\.com\/WasSamLowryEsq\/status\/2109952063492993159\nTimestamp in the video: \[02:15\]\n/);
    assert.match(on.html, /<p style="margin-top: 0; margin-bottom: 15px;">Timestamp in the video: \[02:15\]<\/p>/);
    // no timestamp at all: the same text; ON's HTML has HEAD's empty line where the stamp would go, OFF's has none
    const offPlain = mail(r.fields, false);
    const onPlain = mail(r.fields, true);
    eq(offPlain.text, onPlain.text);
    eq(onPlain.html.split('\n').length, offPlain.html.split('\n').length + 1);
    eq(onPlain.html.split('\n').filter(l => l !== ''), offPlain.html.split('\n').filter(l => l !== ''));
  });

  test('Never wait on Burson OFF: the T&S form\'s issue text has the video timestamp when the summary lacks its digits (LIVE); ON (email_input.no_wait) when the summary gives no [MM:SS]', () => {
    const r = review(F.PARIS);
    const esc = B.escalation_(r.fields, { now: NOW });
    const issue = (summary, noWait) => B.tnsFormValues_(B.emailInput_(Object.assign({}, r.fields, { summary, video_timestamp: '[02:15]' }), esc, noWait)).issue;
    const stamp = /Timestamp in the video: \[02:15\]\./;
    // a summary without it: both add it
    for (const noWait of [false, true]) assert.match(issue('The user shares a video of Search.', noWait), stamp);
    // "02:15" as a time of day: OFF it's there (its digits); ON it isn't a [MM:SS], so the line goes in
    assert.ok(!stamp.test(issue('At 02:15 PM the user shares a video of Search.', false)));
    assert.match(issue('At 02:15 PM the user shares a video of Search.', true), stamp);
    // another [MM:SS] in the summary: OFF the line goes in (not its digits); ON the summary already gives one
    assert.match(issue('At [01:40] the user searches.', false), stamp);
    assert.ok(!stamp.test(issue('At [01:40] the user searches.', true)));
  });

  test('Never wait on Burson OFF: answers in an alert\'s thread use the v1 wording (what needs to change, [Fixes requested for this alert]) and never the bot\'s decision; ON (voiceRow_): what was wrong and what the bot changed, and that no escalation email is needed (❌)', () => {
    const base = { requested: B.requestedItems_(review(F.MISTAKES)), forwarded_fields: B.snapshotFields_(review(F.MISTAKES).fields),
      decision: '❌ P2, 300 engagements: below the escalation criteria' };
    eq([B.voiceRow_(base, false), B.voiceRow_(null, true)], [base, null]);  // OFF: the row as it is; never stored
    const on = B.voiceRow_(base, true);
    eq([on.noWait, base.noWait], [true, undefined]);
    const offAnswer = B.safeAnswer_('', base, GUARD).text;
    const onAnswer = B.safeAnswer_('', on, GUARD).text;
    assert.match(offAnswer, /^Here is what needs to be updated on this alert:\n- Product listed is incorrect\. Please change to Gemini App\.\n[\s\S]*\nPlease update the alert and resend it here\./);
    assert.match(onAnswer, /^The alert has been updated, so there is no need to resend it\. The following updates were made:\n- Product updated to Gemini App\.\n/);
    const ctxOf = rowIn => B.answerPrompts_('Is this handled?', rowIn).prompt.split('QUESTION (untrusted')[0];
    assert.match(ctxOf(base), /\[Fixes requested for this alert\]\nProduct listed is incorrect\. Please change to Gemini App\./);
    assert.ok(!/no escalation email is needed|we changed/.test(ctxOf(base)), ctxOf(base));
    assert.match(ctxOf(on), /\[What was wrong with this alert and what we changed: it was already processed with these changes, so Burson doesn't need to resend it\]\nProduct updated to Gemini App\./);
    assert.match(ctxOf(on), /Escalation status: We reviewed this alert and no escalation email is needed \(❌\)\./);
    // the last check's stand-in text, the analyst footer and the auto-correct note
    assert.match(B.safeGenericText_(), /then update it and resend it here\.$/);
    assert.match(B.safeGenericText_(true), /The alert has been updated, so there is no need to resend it\./);
    eq([B.forwardFooter_(review(F.NO_LINK)), B.forwardFooter_(review(F.NO_LINK), true)],
      ['QA: Link missing (requested from Burson)', 'QA: Link missing (processed without waiting for Burson; Burson was told)']);
    eq([B.changeNoteText_(review(F.NO_LINK)), B.changeNoteText_(review(F.NO_LINK), true)],
      ['Still needs Burson: Link missing', 'Processed without waiting for Burson: Link missing']);
  });

  test('Never wait on Burson: a question in a decided alert\'s thread, end to end: OFF Gemini is told the fixes requested (v1), ON what the bot changed and that it was processed (❌)', () => {
    for (const noWait of [false, true]) {
      const w = world({ drafts: STAND_IN, noWait });
      const a = w.paste(MAPS_LOW);
      w.run();
      w.reply(a, 'Is the exposure tag right on this one?');
      w.run();
      const prompt = w.vertex.calls[w.vertex.calls.length - 1].payload.contents[0].parts[0].text;
      if (noWait) {
        assert.match(prompt, /Exposure Tag updated to Product - Meme about Google products\./);
        assert.match(prompt, /no escalation email is needed \(❌\)/);
      } else {
        assert.match(prompt, /\[Fixes requested for this alert\]\nExposure Tag listed is incorrect\. Please change to Product - Meme about Google products\./);
        assert.ok(!/no escalation email is needed|we changed/.test(prompt.split('QUESTION (untrusted')[0]));
      }
    }
  });

  test('Never wait on Burson: Burson\'s resend is matched to an open alert: OFF a fix request (or an alert whose link the bot found) as LIVE, ON also the latest resend of an alert (resendOpen_)', () => {
    const fixReq = { status: 'fix_requested' };
    const resent = { status: 'fixed', resend_of: 'QA-1' };
    const plainOk = { status: 'ok' };
    eq([B.resendOpen_(fixReq, false), B.resendOpen_(resent, false), B.resendOpen_(plainOk, false)], [true, false, false]);
    eq([B.resendOpen_(fixReq, true), B.resendOpen_(resent, true), B.resendOpen_(plainOk, true)], [true, true, false]);
    // OFF, a second fixed resend of the same alert is taken for a new alert and decided again (as LIVE); ON it's the same
    // alert, never decided again
    for (const noWait of [false, true]) {
      const w = world({ drafts: STAND_IN, noWait });
      w.paste(MAPS_LOW);
      w.run();
      w.paste(MAPS_LOW_OK);
      w.run();
      w.paste(MAPS_LOW_OK);
      const rep = w.run();
      eq([rep.resends, declined(w)], noWait ? [1, 1] : [0, 2], `noWait ${noWait}`);
    }
  });

  test('Never wait on Burson turned ON while an alert waits on Burson\'s resend: the resend is processed then, once (the alert was never decided)', () => {
    const w = world({ drafts: STAND_IN });
    const a = w.paste(MAPS_LOW);
    w.run();
    eq([w.chat.botReactions(a.name), declined(w)], [['⬇'], 0]);
    w.noWait = true;
    const r = w.paste(MAPS_LOW_OK);
    const rep = w.run();
    w.run();
    eq([rep.resends, declined(w), w.bursonPosts().length], [1, 1, 1]);
    eq(w.alertRows().map(x => x.status), ['superseded', 'fixed']);
    assert.ok(w.chat.botReactions(a.name).includes('⬇'));
    assert.ok(/^❌ /.test(row(w, 1).decision), row(w, 1).decision);
    eq(w.chat.botReactions(r.name).filter(e => e === '❌').length + w.chat.botReactions(a.name).filter(e => e === '❌').length, 1);
  });

  test('Never wait on Burson with Auto-send ON, live: an alert waiting on Burson\'s link stays a draft; OFF its note says the bot asked Burson to fix it (LIVE), ON that Burson\'s alert has a problem the bot can\'t fix itself', () => {
    for (const noWait of [false, true]) {
      const w = world({ drafts: LIVE });
      w.bot.ev('GEN').email.stand_in = '';
      const msg = w.paste(F.NO_LINK);
      w.g.clock.now += 1000;
      w.bot.runOnce_(Object.assign(w.ctx(), { switches: Object.assign(w.bot.switchesOff_(), { autoSend: true }, noWait ? { noWait: true } : {}) }));
      H.collectBurson(w.chat, [w.BUR]);
      const note = w.analystPosts().filter(m => m.threadReply).map(m => m.text)[0].split('\n')[1];
      const switchNote = JSON.parse(w.g.props.get('SWITCH_NOTES') || '{}').autoSend.text;
      eq([w.gmail.allDrafts().length, row(w).email_status], [1, 'drafted']);
      if (noWait) {
        eq(note, '- Not sent automatically: Burson\'s alert has a problem the bot can\'t fix itself: Link (missing). Fix it in Gmail, then send it.');
        assert.match(switchNote, /^QA-1001 lacks what only Burson knows \(Link\), so it's a draft \(Oct 14, /);
        eq(w.chat.botReactions(msg.name), ['👍']);
      } else {
        eq(note, '- Not sent automatically: the bot asked Burson to fix Link (missing). Fix it in Gmail, then send it.');
        assert.match(switchNote, /^QA-1001 is waiting on Burson \(Link\), so it's a draft \(Oct 14, /);
        eq(w.chat.botReactions(msg.name), ['⬇']);
      }
    }
  });

  test('Never wait on Burson OFF: the Results tab says the bot asked Burson to fix mistakes (LIVE\'s facts and labels); ON that it fixed them itself and told Burson', () => {
    const MAIN = 'spaces/MIRROR > (isolated)';
    const FLOWS = { main: { partition: MAIN, label: 'Mirror space' }, ac: { partition: 'spaces/AAQAaa_0I9g > spaces/AUTOFIX (auto-correct)', label: 'Auto-correct space' } };
    const summary = rows => B.resultsSummary_(B.speedPosts_(rows, [], [], FLOWS), NOW, 7, 'Mirror space');
    const mirror = summary(resultsRows().filter(x => x.space === MAIN));
    const off = B.resultsFacts_(mirror, false);
    const on = B.resultsFacts_(mirror, true);
    eq(Object.keys(off.last_7_days).filter(k => /mistakes_bot|details_/.test(k)), ['mistakes_bot_caught_and_asked_burson_to_fix', 'details_only_burson_could_add']);
    eq(Object.keys(on.last_7_days).filter(k => /mistakes_bot|details_/.test(k)), ['mistakes_bot_fixed_itself', 'details_missing_from_bursons_alerts']);
    assert.ok(!/went on without waiting/.test(B.resultsFallbackSynopsis_(off)), B.resultsFallbackSynopsis_(off));
    assert.match(B.resultsFallbackSynopsis_(on), /the bot went on without waiting/);
    const both = summary(resultsRows());
    eq(Object.keys(B.resultsFacts_(both, false).test_spaces_last_7_days.main_space).filter(k => /burson/.test(k)), ['fix_requests_sent_to_burson']);
    eq(Object.keys(B.resultsFacts_(both, true).test_spaces_last_7_days.main_space).filter(k => /burson/.test(k)), ['alerts_burson_was_told_what_changed']);
  });

  test('Never wait on Burson: tryAlert() previews what the bot would do now: OFF (no Control tab, or the switch OFF) the request to fix and resend, ON the processed text', () => {
    const off = e2e();
    off.bot.tryAlert();
    assert.ok(off.g.logs.some(l => l.includes('===== Burson would see (in the alert\'s thread) =====\nPlease make the following updates and resend the alert here:')));
    const on = e2e(null, { noWait: true });
    on.bot.tryAlert();
    assert.ok(on.g.logs.some(l => l.includes('===== Burson would see (in the alert\'s thread) =====\nThe alert has been updated, so there is no need to resend it. The following updates were made:')));
    eq([off.chat.botPosts(H.TEST_FEED), on.chat.botPosts(H.TEST_FEED)], [[], []]);
  });

  test('Never wait on Burson OFF: nothing the bot says in the Burson space tells Burson an alert was processed or what the bot changed; ON it never asks Burson to resend', () => {
    const flows = [
      w => { w.paste(F.MISTAKES); w.run(); w.paste(F.MISTAKES_PARTLY_FIXED); w.run(); },
      w => { w.paste(F.NO_LINK); w.run(); w.paste(F.NO_LINK_RESENT); w.run(); },
      w => { const a = w.paste(MAPS_LOW); w.run(); w.reply(a, 'why?'); w.run(); },
      w => { w.g.pages.set(SAM, VIDEO_PAGE); w.vertex.assess = WATCHED; w.paste(F.P0_OK); w.run(); },
    ];
    for (const noWait of [false, true]) {
      const texts = flows.flatMap(flow => { const w = world({ drafts: STAND_IN, noWait }); flow(w); return w.bursonPosts().map(m => m.text); });
      assert.ok(texts.length >= 5, texts.join('\n'));
      if (noWait) texts.forEach(t => assert.ok(!/resend (?:the alert|it) here|Please change to|Please add/.test(t), t));
      else texts.forEach(t => assert.ok(!/processed|we changed|we added|we reworded|in future alerts/i.test(t), t));
    }
  });
};
