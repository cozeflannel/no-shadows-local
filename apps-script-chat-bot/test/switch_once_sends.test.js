// Exactly once (review findings M2 and M3): a transient Sheets or Properties error right after Gmail sent the stand-in's
// copy, or made the draft, never sends the Social Alert again or makes a second draft (Drafts.gs sendToStandIn_ /
// afterStandInSend_, tryDraft_ / saveDraft_ / reusedDraft_). Adapted from the review's fault injection (R2
// once/switch_zz_once.test.js), which counted 2 sends and 2 open drafts per alert before the fix.
'use strict';

module.exports = H => {
  const { test, eq, assert, F, world } = H;
  const STAND_IN_ADDR = 'tester@testing.test';
  const STAND_IN = { live: true, standIn: STAND_IN_ADDR, mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const LIVE = { live: true, mailbox: 'im@runner.test', from: 'Brand Social <sender@alerts.test>' };
  const sendCalls = w => w.gmail.calls.filter(c => c.method === 'post' && c.path === 'messages/send').length;
  const sent = w => w.gmail.sentMessages().length;
  const draftsMade = w => w.gmail.calls.filter(c => c.method === 'post' && c.path === 'drafts').length;
  // The tester has a Chat DM with the bot's account, so the escalation-protocol message (a P0) goes there as a DM and
  // these tests count only the Social Alert's sends (a tester Chat can't reach gets it by email: switch_testers.test.js)
  const standInWorld = () => {
    const w = world({ drafts: STAND_IN });
    w.bot.ev('GEN').email.stand_in = STAND_IN_ADDR;
    w.chat.addDm(STAND_IN_ADDR, 'spaces/DMSTANDIN');
    return w;
  };
  const liveWorld = () => {
    const w = world({ drafts: LIVE });
    w.bot.ev('GEN').email.stand_in = '';
    return w;
  };
  /** The memo (script properties) refuses the `nth` write (1 = the first) of `key`, once: a transient Properties error. */
  const memoFailsOnce = (w, key, nth) => {
    let writes = 0;
    const ctxOrig = w.ctx;
    w.ctx = function () {
      const c = ctxOrig.call(w);
      const set = c.memo.set;
      c.memo.set = (k, v) => {
        if (k === key && ++writes === (nth || 1)) throw new Error('Service invoked too many times: properties');
        return set(k, v);
      };
      return c;
    };
  };
  /** The Alert log refuses one write whose patch matches `pred` (a Sheets timeout), before the row changes. */
  const sheetFailsOnce = (w, pred) => {
    let failed = false;
    const orig = w.backend.updateAlert;
    w.backend.updateAlert = (row, patch) => {
      if (!failed && pred(patch)) { failed = true; throw new Error('Service Spreadsheets timed out'); }
      return orig(row, patch);
    };
  };
  /** Gmail refuses the next `times` (default 1) calls matching (method, path) with `code`. A 5xx is retried by
   *  gmailCall_ up to 3 times for anything but a send, so failing a draft call for good takes 3. */
  const gmailFailsOnce = (w, method, rx, code, times) => {
    let left = times || 1;
    w.gmail.fail = (m, path) => {
      if (!left || m !== method || !rx.test(path)) return null;
      left--;
      return { code: code || 500, body: { error: { message: 'Backend Error' } } };
    };
  };
  const row0 = w => w.alertRows()[0];

  // ===========================================================================================================
  // M2: the stand-in path (testing, as live runs today)
  // ===========================================================================================================

  test('once (stand-in): the "sent" row write fails right after Gmail sent the Social Alert: one email; the next try marks the row sent without sending', () => {
    const w = standInWorld();
    const alert = w.paste(F.P0_OK);
    sheetFailsOnce(w, p => p.email_status === 'sent');
    w.run();
    w.run();
    w.run();
    eq([sendCalls(w), sent(w), row0(w).email_status, row0(w).email_attempts || 0], [1, 1, 'sent', 0]);
    assert.ok(w.g.logs.some(l => /^couldn't mark the Social Alert for QA-\d+ sent \(the next try marks it, without sending it again\): Service Spreadsheets timed out$/.test(l)), w.g.logs.join('\n'));
    assert.ok(w.g.logs.some(l => /^the Social Alert for QA-\d+ already went to the testers; marking it sent, not sending it again$/.test(l)));
    eq(row0(w).email_message_id, `<sent-${w.gmail.sentMessages()[0].id}@mail.test>`);  // the Message-ID from the send it found
    assert.ok(w.chat.botReactions(alert.name).includes('📦'));
    eq(w.gmail.sentMessages()[0].to, [STAND_IN_ADDR]);
  });

  test('once (stand-in): the emoji write fails after the send: one email, the row stays sent, nothing is retried', () => {
    const w = standInWorld();
    w.paste(F.P0_OK);
    sheetFailsOnce(w, p => p.mirrored !== undefined);
    const report = w.run();
    w.run();
    w.run();
    eq([sendCalls(w), row0(w).email_status, row0(w).email_attempts || 0, report.errors], [1, 'sent', 0, []]);
    assert.ok(w.g.logs.some(l => /^couldn't mark the emojis for the Social Alert for QA-\d+: Service Spreadsheets timed out$/.test(l)), w.g.logs.join('\n'));
  });

  test('once (stand-in): a T&S alert whose tns_watch memo write fails after the send: one email; its T&S note is still posted', () => {
    const w = standInWorld();
    w.paste(F.PARIS);
    memoFailsOnce(w, 'tns_watch');
    w.run();
    w.run();
    w.run();
    eq([sendCalls(w), row0(w).email_status, row0(w).email_attempts || 0], [1, 'sent', 0]);
    assert.ok(w.g.logs.some(l => /^couldn't watch QA-\d+ for the T&S confirmation: Service invoked too many times: properties$/.test(l)), w.g.logs.join('\n'));
    assert.ok(w.analystPosts().some(m => m.threadReply && /T&S form needed/.test(m.text)));
  });

  test('once (stand-in): the note after the send AND the row write both fail in the same run: still one email, and the same run\'s retry marks it sent from its own record', () => {
    const w = standInWorld();
    w.paste(F.P0_OK);
    memoFailsOnce(w, 'stand_in_sent', 2);  // 1: before the send (kept); 2: "it went out" (refused)
    sheetFailsOnce(w, p => p.email_status === 'sent');
    w.run();
    eq([sendCalls(w), row0(w).email_status], [1, 'sent']);  // maintainDrafts_ marked it later in that run
    assert.ok(w.g.logs.some(l => /^couldn't note that the Social Alert for QA-\d+ went to the testers: /.test(l)), w.g.logs.join('\n'));
    w.run();
    w.run();
    eq(sendCalls(w), 1);
  });

  test('once (stand-in): Gmail refusing the send notes nothing, so the next try sends it (as before), once', () => {
    const w = standInWorld();
    w.paste(F.P0_OK);
    gmailFailsOnce(w, 'post', /^messages\/send$/, 500);
    w.run();
    w.run();
    eq([sendCalls(w), sent(w), row0(w).email_status, row0(w).email_attempts], [2, 1, 'sent', 1]);
    eq(JSON.parse(w.ctx().memo.get('stand_in_sent')).map(e => [e.id, e.sent]), [[row0(w).alert_id, true]]);
  });

  test('once (stand-in): a try that stopped mid-send (only its first note kept) is never sent again: the row ends failed, saying to check Sent, and the Control tab is told', () => {
    const w = standInWorld();
    w.paste(F.P0_OK);
    gmailFailsOnce(w, 'post', /^messages\/send$/, 500);
    memoFailsOnce(w, 'stand_in_sent', 2);  // dropping the refused send's note fails: whether it went can't be told
    const report = w.run();
    w.run();
    eq([sendCalls(w), sent(w), row0(w).email_status], [1, 0, 'failed']);
    assert.match(row0(w).email_error, /may have sent it to the testers \(check Sent in Gmail\), so it wasn't sent again/);
    assert.ok((report.notices || []).some(n => /^The Social Alert for QA-\d+: an earlier try may have sent it/.test(n)), JSON.stringify(report));
  });

  test('once (stand-in): the note before the send can\'t be saved: nothing is sent that try; it goes out once on the next', () => {
    const w = standInWorld();
    w.paste(F.P0_OK);
    memoFailsOnce(w, 'stand_in_sent', 1);
    w.run();
    w.run();
    eq([sendCalls(w), sent(w), row0(w).email_status, row0(w).email_attempts], [1, 1, 'sent', 1]);
    assert.ok(w.g.logs.some(l => /^Social Alert send for QA-\d+ failed \(attempt 1\): Service invoked too many times: properties$/.test(l)), w.g.logs.join('\n'));
  });

  // ===========================================================================================================
  // M3: the draft path (no stand-in: production)
  // ===========================================================================================================

  test('once (draft): the tns_watch memo write fails after the draft: one draft, the row stays drafted with it, and its note is posted', () => {
    const w = liveWorld();
    w.paste(F.PARIS);
    memoFailsOnce(w, 'tns_watch');
    w.run();
    w.run();
    w.run();
    eq([draftsMade(w), w.gmail.allDrafts().length, row0(w).email_status, row0(w).email_draft, row0(w).email_attempts || 0],
      [1, 1, 'drafted', w.gmail.allDrafts()[0].id, 0]);
    assert.ok(w.g.logs.some(l => /^after making the Social Alert draft for QA-\d+, watching for the T&S confirmation failed: /.test(l)), w.g.logs.join('\n'));
    assert.ok(w.analystPosts().some(m => m.threadReply && /Social Alert draft is in Gmail Drafts/.test(m.text)));
  });

  test('once (draft): the "drafted" row write fails right after createDraft: that draft is deleted, so there is one open draft and the row has it', () => {
    const w = liveWorld();
    w.paste(F.P0_OK);
    sheetFailsOnce(w, p => p.email_status === 'drafted');
    w.run();
    w.run();
    w.run();
    const open = w.gmail.allDrafts();
    eq([draftsMade(w), open.length, row0(w).email_status, row0(w).email_draft], [2, 1, 'drafted', open[0].id]);
    assert.ok(w.gmail.calls.some(c => c.method === 'delete' && /^drafts\/d\d+$/.test(c.path)));
  });

  test('once (draft): the row write and the delete both fail: the next try brings that draft up to date (no second draft)', () => {
    const w = liveWorld();
    w.paste(F.P0_OK);
    sheetFailsOnce(w, p => p.email_status === 'drafted');
    gmailFailsOnce(w, 'delete', /^drafts\//, 503, 3);
    w.run();
    w.run();
    const open = w.gmail.allDrafts();
    eq([draftsMade(w), open.length, row0(w).email_status, row0(w).email_draft], [1, 1, 'drafted', open[0].id]);
    assert.ok(w.gmail.calls.some(c => c.method === 'put' && c.path === `drafts/${open[0].id}`), 'the draft was updated');
    assert.ok(w.g.logs.some(l => /^the Social Alert draft an earlier try made for QA-\d+ is brought up to date \(no second draft\)$/.test(l)), w.g.logs.join('\n'));
    assert.ok(w.analystPosts().some(m => m.threadReply && /Social Alert draft is in Gmail Drafts/.test(m.text)));
  });

  test('once (draft): a pending row naming a draft a person already deleted or sent gets no new draft: maintainDrafts_ marks it ❌ (deleted) or sent', () => {
    const run = act => {
      const w = liveWorld();
      const alert = w.paste(F.P0_OK);
      w.run();
      const id = row0(w).email_draft;
      act(w, id);
      row0(w).email_status = 'pending';  // as left by a try that stopped before the row said drafted
      w.run();
      eq(row0(w).email_status, 'drafted');
      w.run();
      return { w, alert, made: draftsMade(w) };
    };
    const deleted = run((w, id) => w.gmail.discard(id));
    eq([deleted.made, deleted.w.gmail.allDrafts().length, row0(deleted.w).email_status], [1, 0, 'discarded']);
    assert.ok(deleted.w.chat.botReactions(deleted.alert.name).includes('❌'));
    const wasSent = run((w, id) => w.gmail.send(id, 'im@runner.test'));
    eq([wasSent.made, row0(wasSent.w).email_status], [1, 'sent']);
  });

  test('once (draft): Auto-send turned ON between two tries never sends while the first try\'s draft is open: that draft is updated instead', () => {
    const w = liveWorld();
    w.paste(F.P0_OK);
    w.run();
    const id = row0(w).email_draft;
    row0(w).email_status = 'pending';  // the first try made the draft and stopped before the row said drafted
    w.g.clock.now += 1000;
    const c = w.ctx();
    c.switches = { autoSend: true };
    w.bot.runOnce_(c);
    eq([sendCalls(w), draftsMade(w), w.gmail.allDrafts().map(d => d.id), row0(w).email_status, row0(w).email_draft],
      [0, 1, [id], 'drafted', id]);
  });

  test('once (draft): auto-send ON, the "sent" row write fails after the send: still one send (unchanged)', () => {
    const w = liveWorld();
    w.paste(F.P0_OK);
    sheetFailsOnce(w, p => p.email_status === 'sent');
    const run = () => { w.g.clock.now += 1000; const c = w.ctx(); c.switches = { autoSend: true }; return w.bot.runOnce_(c); };
    run();
    run();
    run();
    eq([sendCalls(w), w.gmail.allDrafts().length, row0(w).email_status], [1, 0, 'sent']);
  });
};
