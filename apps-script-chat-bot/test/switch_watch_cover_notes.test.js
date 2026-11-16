// P4b of the fix plan (setting cross_alert_notes; only where the watch's alerts go to the Auto-correct space, B35 =
// B10): a watch flag on a post that already has a card in that space gets no card of its own, as before, and one note
// goes under that card ("🔭 *Also flagged by the watch “…”.* No separate Watch alert: this card already covers the
// post."), through the one helper (ThreadNotes.gs acThreadNote_). The flag's hidden key on the Watch detections tab
// then says a: 'u' ("listed under another alert"), else a: 'd' ("already alerted") as before; C35 says how many were
// noted. With the setting off, and in every other destination, the bot does what it did before.
//   node apps-script-chat-bot/test/run_tests.js "watch cover notes:"
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const MIN = 60 * 1000;
  const AC = golden.spaces.AC;
  const MAPS = golden.posts.MAPS;
  const PIXEL = golden.posts.PIXEL;
  const BRAND = 'Google brand safety (all)';
  const MIDTERMS = 'Midterms 2026 × Google';
  const NOTE_RX = /^🔭 \*Also flagged by the watch /;
  const note = names => `🔭 *Also flagged by ${names.map(n => `the watch “${n}”`).join(' and ')}.* No separate Watch alert: this ` +
    'card already covers the post.';
  const ONLY_NOTES = Object.assign({}, golden.SETTINGS_OFF, { cross_alert_notes: true });

  /** The hidden keys of the Watch detections tab's rows: {"<post>|<watch>": key}. */
  const keysOf = t => Object.fromEntries(t.sheet().getSheetByName('Watch detections').rows.slice(13)
    .filter(r => r && r[18]).map(r => [`${String(r[5])}|${JSON.parse(r[18]).w}`, JSON.parse(r[18])]));
  const c35 = t => t.control().cell(35, 3);
  const notes = t => t.chat.botPosts(AC).filter(m => m.threadReply && NOTE_RX.test(m.text));

  /**
   * The one-space setup (golden_flows.js) one run in, the brand-safety watch ON (and the Midterms watch with
   * `o.midterms`), B35 = the Auto-correct space; `settings`: the scenario's overrides (the defaults when left out).
   */
  function oneSpace(settings, o) {
    const w = golden.world.oneSpaceWorld(settings);
    const { t, sh } = w;
    t.poll();
    const tab = t.sheet().getSheetByName('Watches');
    const on = name => tab.getRange(tab.rows.findIndex(r => r[0] === name) + 1, 2).setValue('ON');
    on(BRAND);
    if (o && o.midterms) on(MIDTERMS);
    sh.getRange(35, 2).setValue('Auto-correct space (B10)');
    for (let i = 0; i < 3; i++) t.poll();
    return w;
  }

  /**
   * Runs until the watch has sent a look; then ONE run in which Direct BigQuery cards the posts of `bsip` (its check is
   * made due) and the look is collected with `hits`: the watch's flags come a few seconds after the card, whose Alert-log
   * row is written when the card is reviewed, on the next run.
   */
  function cardAndFlagInOneRun(w, bsip, hits) {
    const { t, feed } = w;
    const sent = () => Object.keys(feed.jobs).length;
    feed.look = [];
    const before = sent();
    for (let i = 0; i < 8 && sent() === before; i++) t.poll();
    assert.ok(sent() > before, 'a look was sent');
    feed.look = hits;
    feed.bsip = bsip;
    t.g.props.delete('BQ_DIRECT_AT');  // the Direct BigQuery check is due in this run
    t.poll();
    feed.look = [];
  }

  test('watch cover notes: in the one-space setup a watch flag on a post Direct BigQuery carded in the same run waits for the card\'s Alert-log row (C35: 1 waiting); on the next run one note goes under that card, the flag is "listed under another alert" (a: \'u\') and C35 counts it as noted; nothing else is posted for it, and the bot never answers the note', () => {
    const w = oneSpace();
    const { t } = w;
    cardAndFlagInOneRun(w, [golden.rows.mapsRow()], [golden.rows.mapsHit()]);
    const card = t.chat.botPosts(AC).find(m => !m.threadReply && /roadwatcher/.test(m.text) && /BigQuery/.test(m.text));
    assert.ok(card, 'the Direct BigQuery card');
    eq(keysOf(t)[`${MAPS}|${BRAND}`].a, 'q');
    assert.match(c35(t), / · today: 0 posted, 1 waiting · /);
    assert.ok(t.g.logs.some(l => l === `Watch alerts: ${MAPS} waits for the next run: its post's card (a bq card was already ` +
      'posted for it) isn\'t in the Alert log yet, and the note goes under it'), 'its log line');
    eq(notes(t), []);
    t.poll();
    eq(keysOf(t)[`${MAPS}|${BRAND}`].a, 'u');
    eq(notes(t).map(m => [m.thread.name, m.text]), [[card.thread.name, note([BRAND])]]);
    assert.match(c35(t), / · today: 0 posted, 1 on a post that already had an alert \(noted in its thread\) · /);
    // no Watch alert card of its own, and the note is the bot's own: nothing answers it on the runs after
    eq(t.chat.botPosts(AC).filter(m => !m.threadReply && /^client-zwat-/.test(m.clientAssignedMessageId || '')).length, 0);
    const posted = notes(t)[0];
    assert.ok(/^client-bqa-/.test(posted.clientAssignedMessageId || ''), posted.clientAssignedMessageId);
    const after = () => t.chat.spaces.get(AC).messages.filter(m => m.thread.name === card.thread.name && Number(String(m.name).split('/messages/m')[1]) >
      Number(String(posted.name).split('/messages/m')[1]));
    for (let i = 0; i < 3; i++) t.g.clock.now += MIN, t.poll();
    eq(after().map(m => m.text), []);
    // its log line says so, with no Chat id
    const alertLog = t.sheet().getSheetByName('Alert log');
    const id = alertLog.rows[1][alertLog.rows[0].indexOf('alert_id')];
    assert.match(id, /^QA-\d+$/);
    eq(t.g.logs.filter(l => /^Watch alerts: not posting/.test(l)),
      [`Watch alerts: not posting ${MAPS}: it already had an alert: ${id} in the Alert log; noted under that alert's card`]);
    eq(t.g.logs.filter(l => /^Watch alerts: /.test(l) && l.includes('spaces/')), []);
  });

  test('watch cover notes: with cross_alert_notes off (the other settings off too, or on), the same flag on a post Direct BigQuery carded in the same run is closed at once as "already alerted" (a: \'d\'), with no note and no "noted" on C35, as before', () => {
    [golden.SETTINGS_OFF, { cross_alert_notes: false }].forEach(settings => {
      const w = oneSpace(settings);
      const { t } = w;
      cardAndFlagInOneRun(w, [golden.rows.mapsRow()], [golden.rows.mapsHit()]);
      eq(keysOf(t)[`${MAPS}|${BRAND}`].a, 'd');
      t.poll();
      eq([keysOf(t)[`${MAPS}|${BRAND}`].a, notes(t)], ['d', []]);
      assert.match(c35(t), / · today: 0 posted, 1 on a post that already had an alert · /);
    });
  });

  test('watch cover notes: two watches flagging a carded post in the same run get ONE note under its card, naming both; both flags are "listed under another alert" and C35 counts both as noted', () => {
    const w = oneSpace(undefined, { midterms: true });
    const { t } = w;
    cardAndFlagInOneRun(w, [golden.rows.mapsRow()], [golden.rows.mapsHit(), Object.assign(golden.rows.mapsHit(), { watch: MIDTERMS, idx: 2, impact: 7.5 })]);
    eq([keysOf(t)[`${MAPS}|${BRAND}`].a, keysOf(t)[`${MAPS}|${MIDTERMS}`].a], ['q', 'q']);
    assert.match(c35(t), /, 2 waiting · /);
    t.poll();
    eq([keysOf(t)[`${MAPS}|${BRAND}`].a, keysOf(t)[`${MAPS}|${MIDTERMS}`].a], ['u', 'u']);
    const texts = notes(t).map(m => m.text);
    eq(texts.length, 1);
    assert.ok(texts[0] === note([BRAND, MIDTERMS]) || texts[0] === note([MIDTERMS, BRAND]), texts[0]);
    assert.match(c35(t), / · today: 0 posted, 2 on a post that already had an alert \(noted in its thread\) · /);
    // the note's text, for up to three watches (a fourth isn't named)
    eq(t.bot.pwAlsoFlaggedText_(['A', 'B', 'C', 'D']), '🔭 *Also flagged by the watch “A”, the watch “B” and the watch “C”.* No ' +
      'separate Watch alert: this card already covers the post.');
    eq(t.bot.isThreadNoteText_(t.bot.pwAlsoFlaggedText_(['A', 'B'])), true);
  });

  test('watch cover notes: when the helper posts no note (Chat refuses it), nothing is posted, the flag stays "already alerted" (a: \'d\') and C35 counts it without "noted"; a refusal of the helper\'s own check does the same', () => {
    const w = oneSpace();
    const { t } = w;
    cardAndFlagInOneRun(w, [golden.rows.mapsRow()], [golden.rows.mapsHit()]);
    t.chat.fail = (method, path, query, body) => (method === 'post' && body && /Also flagged by the watch/.test(String(body.text || ''))
      ? { code: 500, body: { error: { code: 500, message: 'Internal error encountered' } } } : null);
    t.poll();
    t.chat.fail = null;
    eq([keysOf(t)[`${MAPS}|${BRAND}`].a, notes(t)], ['d', []]);
    assert.match(c35(t), / · today: 0 posted, 1 on a post that already had an alert · /);
    assert.ok(t.g.logs.some(l => /^thread note not posted: /.test(l)), 'the helper\'s log line');
    // the helper's own check refuses: the Auto-correct flow last worked in another space
    const v = oneSpace();
    cardAndFlagInOneRun(v, [golden.rows.mapsRow()], [golden.rows.mapsHit()]);
    assert.ok(v.t.g.props.get('LAST_AC_SPACE'), 'LAST_AC_SPACE is set');
    // the next run sets LAST_AC_SPACE again at its start: change it only for the note's check
    v.t.chat.fail = (method, path, query, body) => {
      if (method === 'post' && body && /Also flagged by the watch/.test(String(body.text || ''))) {
        throw new Error('the note was posted although its check should refuse it');
      }
      return null;
    };
    const getProperty = v.t.g.services.PropertiesService.getScriptProperties;
    v.t.g.services.PropertiesService.getScriptProperties = () => {
      const p = getProperty();
      const stack = String(new Error().stack);
      return Object.assign(Object.create(p), { getProperty: k => (k === 'LAST_AC_SPACE' && /acThreadNoteCheck_/.test(stack) ? 'spaces/AAQAelsewhere1' : p.getProperty(k)) });
    };
    v.t.poll();
    v.t.g.services.PropertiesService.getScriptProperties = getProperty;
    eq([keysOf(v.t)[`${MAPS}|${BRAND}`].a, notes(v.t)], ['d', []]);
    assert.ok(v.t.g.logs.some(l => l === 'thread note not posted: the Auto-correct flow hasn\'t worked in that space'), 'refused by the check');
  });

  test('watch cover notes: the golden scenarios: the one-space setup with only cross_alert_notes on puts out what it puts out with every setting off plus ONE note, under the Maps card, and its Maps flag is "listed under another alert"; with every setting off that flag is "already alerted" and C35 has no "noted"; the Mirror flow\'s flags, C35 and output are the same with the defaults and with every setting off (its Pixel flag "already alerted")', () => {
    const off = golden.oneSpaceRun(golden.SETTINGS_OFF);
    const on = golden.oneSpaceRun(ONLY_NOTES);
    eq(golden.differences(off.out, golden.recorded.one_space), []);
    eq([keysOf(off.t)[`${MAPS}|${BRAND}`].a, /noted/.test(c35(off.t)), notes(off.t)], ['d', false, []]);
    const added = on.out.chat.filter(c => NOTE_RX.test(c.text));
    const maps = off.t.sheet().getSheetByName('Alert log');
    const col = name => maps.rows[0].indexOf(name);
    const mapsThread = maps.rows.slice(1).find(r => r[col('record_key')] === 'x.com/status/2150000000000000002')[col('forward_thread')];
    eq(added, [{ run: '10 the Maps card is reviewed and the watch flags the Maps post too', space: AC, thread: mapsThread, reply: true,
      text: note([BRAND]) }]);
    eq(golden.differences(Object.assign({}, on.out, { chat: on.out.chat.filter(c => !NOTE_RX.test(c.text)) }), off.out), []);
    eq(keysOf(on.t)[`${MAPS}|${BRAND}`].a, 'u');
    assert.match(c35(on.t), /, 1 on a post that already had an alert \(noted in its thread\)/);
    // the Mirror flow
    const mOn = golden.mirrorRun();
    const mOff = golden.mirrorRun(golden.SETTINGS_OFF);
    eq(golden.differences(mOn.out, golden.recorded.mirror), []);
    eq([keysOf(mOn.t), c35(mOn.t)], [keysOf(mOff.t), c35(mOff.t)]);
    eq(keysOf(mOn.t)[`${PIXEL}|${BRAND}`].a, 'd');
    eq(mOn.out.chat.filter(c => NOTE_RX.test(c.text)), []);
  });

  // -----------------------------------------------------------------------------------------------------------
  // The watch's "Same story: N more posts" reply under its own alert
  // -----------------------------------------------------------------------------------------------------------

  const STORY = 'Pixel batteries swell after the update';
  const P = n => `https://x.com/user${n}/status/21700000000000${String(n).padStart(5, '0')}`;
  /** A flag on the battery story (250+ engagements: each matters by itself; the higher `n`, the more engagements). */
  const storyFlag = n => golden.rows.hit({ post_url: P(n), author: `@user${n}`, followers: 3200, eng: 250 + n, issue: STORY,
    summary: `An X user (@user${n}) says their Pixel battery swelled after the update.`, topic: 'Product failure or outage' });
  /** A pre-read in which every flag on the battery story tells it: an alert posted on it lately, else the run's first flag. */
  const sameStory = t => {
    t.g.vertex.watchPreRead = payload => {
      const prompt = payload.contents[0].parts.map(p => p.text || '').join('');
      const part = tag => JSON.parse((prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`)) || [])[1] || '[]');
      const posts = part('watch_posts');
      const earlier = part('recent_alerts').find(r => r.story === STORY);
      return { watch_posts: posts.map((p, i) => ({ ref: p.ref, summary: p.text || 'A user says their Pixel battery swelled.',
        background: '', about_google: true, product: 'Pixel', other_products: [], exposure_tag: 'Product - Other/general criticism',
        sensitive_topics: [], story: STORY, same_story_as: earlier ? earlier.ref : i ? posts[0].ref : '', meaningful: true })) };
    };
  };
  /** Runs until the watch has sent a look; the next run collects it with `hits`. */
  function look(w, hits) {
    const { t, feed } = w;
    const sent = () => Object.keys(feed.jobs).length;
    feed.look = [];
    const before = sent();
    for (let i = 0; i < 8 && sent() === before; i++) t.poll();
    assert.ok(sent() > before, 'a look was sent');
    feed.look = hits;
    t.poll();
    feed.look = [];
  }
  const watchCard = (t, space) => t.chat.botPosts(space || AC).find(m => !m.threadReply && /^client-zwat-/.test(m.clientAssignedMessageId || ''));
  /** Every message in the thread of `card`, after it: [id prefix, text]. */
  const threadOf = (t, card, space) => t.chat.spaces.get(space || AC).messages
    .filter(m => m.thread.name === card.thread.name && m.name !== card.name)
    .map(m => [String(m.clientAssignedMessageId || '').replace(/^(client-[a-z]+-).*$/, '$1'), m.text]);

  test('watch cover notes: in the one-space setup the watch\'s "Same story: N more posts" reply under its own alert, posted as it is with cross_alert_notes off, is answered by the bot\'s own flow on the next run (the bot took it for a person\'s follow-up); with the setting on, the same reply, word for word, is a note of the bot\'s own (through the helper) and nothing answers it', () => {
    const run = settings => {
      const w = oneSpace(settings);
      sameStory(w.t);
      look(w, [storyFlag(2), storyFlag(1)]);
      for (let i = 0; i < 3; i++) w.t.poll();
      return threadOf(w.t, watchCard(w.t));
    };
    const off = run({ cross_alert_notes: false });
    const on = run();
    const reply = off.find(([, text]) => /^🔗 \*Same story: 1 more post\*/.test(text));
    assert.ok(reply, JSON.stringify(off));
    // at the base: the reply carries the watch alerts' id, which isn't the bot's own message id, and gets an answer
    eq(reply[0], 'client-zwat-');
    assert.ok(off.some(([id, text]) => id === 'client-bqa-' && text === 'Happy to help with that.'), JSON.stringify(off));
    // with the setting on: the same words, the bot's own id, and no answer
    eq(on.filter(([, text]) => /Same story/.test(text)), [['client-bqa-', reply[1]]]);
    eq(on.filter(([, text]) => text === 'Happy to help with that.'), []);
    eq(on.length, off.length - 1);
  });

  test('watch cover notes: a later flag on the story of a Watch alert posted lately joins its thread as a note too ("seen since this alert was posted"); when the helper posts nothing (Chat refuses it), the flag waits on the tab (C35: 1 waiting), nothing else is posted for it, and it joins on a later run', () => {
    const w = oneSpace();
    const { t } = w;
    sameStory(t);
    look(w, [storyFlag(2), storyFlag(1)]);
    const card = watchCard(t);
    refuseNotes(t, /Same story/);
    look(w, [storyFlag(3)]);
    eq(keysOf(t)[`${P(3)}|${BRAND}`].a, 'q');
    assert.match(c35(t), /, 1 waiting · /);
    eq(t.chat.botPosts(AC).filter(m => /user3\b/.test(m.text)), []);
    t.chat.fail = null;
    t.poll();
    eq(keysOf(t)[`${P(3)}|${BRAND}`].a, 'g');
    const joined = threadOf(t, card).filter(([, text]) => /^🔗 \*Same story: 1 more post\* \(seen since this alert was posted\)/.test(text));
    eq(joined.map(([id, text]) => [id, /user3\b/.test(text)]), [['client-bqa-', true]]);
  });

  /** Chat refuses (a 500) what the bot posts when its text matches `rx`. */
  function refuseNotes(t, rx) {
    t.chat.fail = (method, path, query, body) => (method === 'post' && body && rx.test(String(body.text || ''))
      ? { code: 500, body: { error: { code: 500, message: 'Internal error encountered' } } } : null);
  }

  test('watch cover notes: in the Mirror flow the "Same story" reply is posted as it was, with the watch alerts\' id, and the flow puts out the same with the default settings as with every setting off', () => {
    const run = settings => {
      const w = golden.world.mirrorWorld(settings);
      const { t, rec } = w;
      sameStory(t);
      look(w, [storyFlag(2), storyFlag(1)]);
      for (let i = 0; i < 3; i++) t.poll();
      rec.collect('the look and three runs');
      return { t, out: rec.out() };
    };
    const on = run();
    const off = run(golden.SETTINGS_OFF);
    eq(golden.differences(on.out, off.out), []);
    const card = watchCard(on.t, golden.spaces.MIRROR);
    assert.ok(card, 'the Watch alert in the Mirror space');
    const replies = threadOf(on.t, card, golden.spaces.MIRROR).filter(([, text]) => /Same story/.test(text));
    eq(replies.map(([id, text]) => [id, text.split('\n')[0]]), [['client-zwat-', '🔗 *Same story: 1 more post*']]);
    eq(on.out.chat.filter(c => NOTE_RX.test(c.text)), []);
  });

  test('watch cover notes: in the one-space setup a Watch alert whose story keeps growing takes 3 notes in its thread (its "Same story" replies, the helper\'s cap); later flags on that story are closed at once as repeats of the alerted story (a: \'r\', C35 "repeats of an alerted story held back"), never left waiting: no pre-read reads them again, none is dropped after 3 hours, nothing more is posted', () => {
    const w = oneSpace();
    const { t } = w;
    sameStory(t);
    let reads = 0;
    const preRead = t.g.vertex.watchPreRead;
    t.g.vertex.watchPreRead = payload => { reads++; return preRead(payload); };
    look(w, [storyFlag(2), storyFlag(1)]);
    const card = watchCard(t);
    [3, 4, 5, 6].forEach(n => look(w, [storyFlag(n)]));
    const keys = keysOf(t);
    eq([1, 3, 4, 5, 6].map(n => keys[`${P(n)}|${BRAND}`].a), ['g', 'g', 'g', 'r', 'r']);
    const replies = threadOf(t, card).filter(([, text]) => /^🔗 \*Same story: /.test(text));
    eq(replies.map(([id]) => id), ['client-bqa-', 'client-bqa-', 'client-bqa-']);
    assert.match(c35(t), /, \+3 in their story's thread, 2 repeats of an alerted story held back/);
    assert.ok(!/waiting/.test(c35(t)), c35(t));
    assert.ok(t.g.logs.some(l => l === 'Watch alerts: 1 flag not listed in their story\'s Watch alert\'s thread ("' + STORY + '"): its card ' +
      'already has 3 notes, the most it takes; that alert covers the story'), 'its log line');
    // the runs after (three hours and more): no pre-read, no flag dropped, nothing posted
    const before = [reads, t.chat.botPosts(AC).length];
    for (let i = 0; i < 10; i++) {
      t.g.clock.now += 20 * MIN;
      t.poll();
    }
    eq([reads, t.chat.botPosts(AC).length], before);
    eq([5, 6].map(n => keysOf(t)[`${P(n)}|${BRAND}`].a), ['r', 'r']);
    assert.ok(!/dropped/.test(c35(t)), c35(t));
  });

  test('watch cover notes: a card takes one "Also flagged" note in its life: a later run\'s flag on its post (another watch) finds that note already there, so nothing is posted, the flag stays "already alerted" (a: \'d\': the note doesn\'t name its watch) and C35 counts only the first as noted', () => {
    const w = oneSpace(undefined, { midterms: true });
    const { t } = w;
    cardAndFlagInOneRun(w, [golden.rows.mapsRow()], [golden.rows.mapsHit()]);
    t.poll();
    eq(keysOf(t)[`${MAPS}|${BRAND}`].a, 'u');
    look(w, [Object.assign(golden.rows.mapsHit(), { watch: MIDTERMS, idx: 2, impact: 7.5 })]);
    eq([keysOf(t)[`${MAPS}|${BRAND}`].a, keysOf(t)[`${MAPS}|${MIDTERMS}`].a], ['u', 'd']);
    eq(notes(t).map(m => m.text), [note([BRAND])]);
    assert.match(c35(t), / · today: 0 posted, 2 on a post that already had an alert \(1 noted in its thread\) · /);
  });

  test('watch cover notes: a flag waits for its post\'s card only when a producer claimed the post (a card was posted for it); a post the alert memory has only seen, with no card in the Auto-correct space, is closed at once as "already alerted", as with the setting off', () => {
    const w = oneSpace();
    const { t } = w;
    t.bot.__fakeSeen = null;
    t.bot.ev('alertMemory_ = (orig => function () { const m = orig.apply(this, arguments); if (!m || m.__fake) return m; ' +
      'const f = Object.create(m); f.__fake = true; f.seenPost = function (url, o) { return __fakeSeen && url === __fakeSeen.url ' +
      '? { why: "already seen (QA-9001)", alert_id: "QA-9001", at: Date.now(), outcome: "seen", ids: ["QA-9001"], claim: "" } ' +
      ': m.seenPost(url, o); }; return f; })(alertMemory_)');
    t.bot.__fakeSeen = { url: MAPS };
    look(w, [golden.rows.mapsHit()]);
    eq(keysOf(t)[`${MAPS}|${BRAND}`].a, 'd');
    eq(notes(t), []);
    assert.ok(!t.g.logs.some(l => /waits for the next run: its post's card/.test(l)), 'no wait');
    assert.match(c35(t), / · today: 0 posted, 1 on a post that already had an alert · /);
  });

  test('watch cover notes: in the Mirror flow (LIVE, with the Relay; the default settings and every setting off) an analyst\'s reply with "Same story" in their own words goes to S-F Burson as before; only the watch\'s reply in its own shape ("Same story: N more posts"), quoted, is held', () => {
    const run = settings => {
      const t = golden.mirrorRun(settings).t;
      const copy = t.chat.botPosts(golden.spaces.MIRROR).filter(m => !m.threadReply && /SOCIAL ALERT/.test(m.text)).slice(-1)[0];
      assert.ok(copy, 'a Social Alert\'s copy in the Mirror space');
      const outbox = () => t.sheet().getSheetByName('Burson outbox').rows.slice(1).map(r => String(r[3]));
      const said = ['We saw the Same story: battery swelling', 'Same story as the one this morning', '🔗 *Same story: 2 more posts*'];
      const before = outbox().length;
      said.forEach(text => {
        t.chat.say(golden.spaces.MIRROR, text, { thread: copy.thread.name, sender: 'users/analyst9', displayName: 'Dana Lee' });
        t.poll();
      });
      return outbox().slice(before);
    };
    [undefined, golden.SETTINGS_OFF].forEach(settings => {
      const queued = run(settings);
      assert.ok(queued.some(x => x.includes('We saw the Same story: battery swelling')), JSON.stringify(queued));
      assert.ok(queued.some(x => x.includes('Same story as the one this morning')), JSON.stringify(queued));
      assert.ok(!queued.some(x => /Same story: 2 more posts/.test(x)), JSON.stringify(queued));
    });
  });

  test('watch cover notes: the "Same story" reply\'s first words are registered as a note\'s: the bot knows a message from its account that starts so as its own; on a way to S-F Burson only the reply\'s own shape ("Same story: N more posts") is held, wherever it stands, and an analyst\'s "Same story" in other words is not; the bot\'s own answer to a question of Burson\'s is checked as before; "the same story" in a sentence is anyone\'s to say', () => {
    const B = H.B;
    const GUARD = { terms: ['SLRR Triaged Alerts', 'AAQAaLn375E'] };
    const ctx = { botUser: 'users/bot', store: { isOwnPost: () => false } };
    const reply = '🔗 *Same story: 2 more posts*\n• <https://x.com/a/status/1|@a> · X';
    eq([B.isThreadNoteText_(reply), B.isOwnMessage_(ctx, { senderName: 'users/bot', text: reply }),
      B.isOwnMessage_(ctx, { senderName: 'users/someone', text: reply })], [true, true, false]);
    // the reply's shape is held: alone, quoted by an analyst after their name, without its bold marks, on a later line
    [reply, 'Dana Lee: 🔗 *Same story: 2 more posts*', 'Dana Lee: Same story: 1 more post (seen since this alert was posted)',
      'Dana Lee: see below\nSame story: 12 more posts'].forEach(text => {
      eq([B.outboxGuardHits_(text, GUARD).length > 0, H.leakDenied(text)], [true, true], text);
    });
    eq(B.outboxGuardHits_('Dana Lee: 🔗 *Same story: 2 more posts*', GUARD), ['Same story: 2 more posts']);
    // an analyst's own words with "Same story" are not held (as before the reply was registered)
    ['Same story: we saw this yesterday', 'Dana Lee: We saw the Same story: battery swelling', 'Dana Lee: see the Same story: line',
      'Dana Lee: Same story as the one this morning', 'Dana Lee: *Same story* on Reddit too', 'This is the same story as yesterday.',
      'Same story: 2 more posters said so'].forEach(text => {
      eq([B.outboxGuardHits_(text, GUARD), H.leakDenied(text)], [[], false], text);
    });
    // the bot's own answer to a question of Burson's is checked as before
    eq(B.outboxGuardHits_('Same story: 2 more posts', GUARD, true), []);
  });
};
