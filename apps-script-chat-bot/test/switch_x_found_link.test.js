// Switches together: a link the bot found itself (Auto-find missing links, row 14) is a guess until a person checks it,
// so Auto-send Social Alerts (row 11) leaves that alert a draft, and Auto-submit T&S form (row 12) never puts it in the
// real T&S form (the test copy is still filled in while testing).
'use strict';

module.exports = H => {
  const { test, eq, assert, F, world, collectBurson } = H;
  const LIVE = { live: true, mailbox: 'im@runner.test', from: 'Brand Social <sender@alerts.test>' };
  const STAND_IN = { live: false, standIn: 'tester@testing.test', mailbox: 'bot@runner.test', from: 'Brand Social <bot@runner.test>' };
  const SAM = 'https://x.com/WasSamLowryEsq/status/2109952063492993159';
  const PARIS_LINK = 'https://x.com/paris_tech_press/status/1845000000000000003';
  const PARIS_NO_LINK = F.PARIS.replace(`[Link]: ${PARIS_LINK}\n`, '');
  const finder = url => () => ({ post_url: url, author: '', confidence: 0.92, how: 'issue name' });

  const liveWorld = () => {
    const w = world({ drafts: LIVE });
    w.bot.ev('GEN').email.stand_in = '';
    return w;
  };
  const runWith = (w, extra) => {
    w.g.clock.now += 1000;
    const report = w.bot.runOnce_(Object.assign(w.ctx(), extra || {}));
    collectBurson(w.chat, [w.BUR]);
    return report;
  };
  const on = (w, keys) => Object.assign(w.bot.switchesOff_(), Object.fromEntries(keys.map(k => [k, true])));
  const sends = w => w.gmail.sentMessages().filter(m => /SOCIAL ALERT/.test(m.subject)).length;
  const notes = w => w.analystPosts().filter(m => m.threadReply).map(m => m.text);
  const responses = w => Array.from(w.g.forms.values()).reduce((all, f) => all.concat(f.responses.map(r => [f.id, r])), []);
  const liveForm = w => {
    const f = w.g.services.FormApp.create('T&S Intake Form (the real one)');
    w.bot.ev('TNS_QUESTIONS_').forEach(q => {
      const item = q.choices ? (q.radio ? f.addMultipleChoiceItem() : f.addListItem()).setChoiceValues(q.choices)
        : (q.paragraph ? f.addParagraphTextItem() : f.addTextItem());
      item.setTitle(q.title).setRequired(!q.optional);
    });
    w.g.props.set('TNS_LIVE_FORM_ID', f.id);
    return f;
  };

  test('switches together: live, Auto-send leaves an alert whose link the bot found itself (Auto-find missing links) a draft, with a note to check the post; Burson\'s own link is sent as usual', () => {
    const w = liveWorld();
    w.paste(F.NO_LINK);
    const r = runWith(w, { switches: on(w, ['autoSend', 'autoFindLinks']), findLink: finder(SAM) });
    eq([r.links_found, r.auto_sent || 0, sends(w), w.gmail.allDrafts().length, w.bursonPosts().length], [1, 0, 0, 1, 0]);
    const row = w.alertRows()[0];
    eq([row.email_status, row.forwarded_fields.link_found.confidence], ['drafted', 0.92]);
    assert.ok(notes(w).some(n => /Not sent automatically: Burson's alert had no link, and the bot found this one in the listening feeds \(92% sure\)\. Check it's the right post, then send it\./.test(n)), notes(w).join('\n'));
    // Later runs never send it either
    runWith(w, { switches: on(w, ['autoSend', 'autoFindLinks']), findLink: finder(SAM) });
    eq(sends(w), 0);

    // Burson's alert with its own link: sent as usual
    const w2 = liveWorld();
    w2.paste(F.P0_OK);
    const r2 = runWith(w2, { switches: on(w2, ['autoSend', 'autoFindLinks']), findLink: finder(SAM) });
    eq([r2.auto_sent, sends(w2), w2.gmail.allDrafts().length], [1, 1, 0]);
  });

  test('switches together: live, Auto-submit T&S never puts a link the bot found itself in the real T&S form (no urgent email either): the note keeps the pre-filled link for a person; while testing the test copy is still filled in', () => {
    const w = liveWorld();
    const real = liveForm(w);
    w.paste(PARIS_NO_LINK);
    const r = runWith(w, { switches: on(w, ['autoTns', 'autoFindLinks']), findLink: finder(PARIS_LINK) });
    eq([r.links_found, r.tns_auto || 0, real.responses.length, responses(w).length], [1, 0, 0, 0]);
    eq(w.gmail.sentMessages().filter(m => /URGENT T&S/.test(m.subject)).length, 0);
    assert.ok(notes(w).some(n => n.includes('T&S Intake Form, pre-filled')), notes(w).join('\n'));
    assert.ok(!notes(w).some(n => /auto-submitted/.test(n)), notes(w).join('\n'));
    assert.match(JSON.parse(w.g.props.get('SWITCH_NOTES')).autoTns.text, /link was found by the bot, so a person checks it/);
    assert.ok(!w.g.props.has('TNS_AUTO_LINKS'));  // nothing decided for the post: a later alert with Burson's link can submit it

    // While testing (a stand-in): the test copy is filled in with the found link, as with Burson's link
    const t = world({ drafts: STAND_IN });
    t.paste(PARIS_NO_LINK);
    const rt = runWith(t, { switches: on(t, ['autoTns', 'autoFindLinks']), findLink: finder(PARIS_LINK) });
    eq([rt.tns_auto, responses(t).length, responses(t)[0][1]['Link / URL(s) in question:']], [1, 1, PARIS_LINK]);
  });
};
