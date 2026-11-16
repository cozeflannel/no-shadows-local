// What the Control tab says about the Proactive watch (row 34, ProactiveWatch.gs) and its Watch alerts (row 35,
// WatchAlerts.gs), in the one-space setup (everything in the Auto-correct space, B10; B35 = B10):
//   - C35 counts how every flag of the day ended, the counts before its explanation, and never cuts a count.
// Nothing here changes what is posted in Chat, emailed or queued: only notes on the Control tab.
//   node apps-script-chat-bot/test/run_tests.js "watch notes:"
'use strict';

module.exports = H => {
  const { test, eq, assert, B } = H;
  const golden = require('./golden_flows')(H);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const C1 = 'us-central1';
  const AC = golden.spaces.AC;
  const AC_NAME = golden.world.names.AC;
  const TO_AC = 'Auto-correct space (B10)';
  const BRAND = 'Google brand safety (all)';
  const MIDTERMS = 'Midterms 2026 × Google';
  const HOW = 'a flag that matters by itself (a KOF author, 100+ engagements or a P0 tag) is posted there as a 🔭 Watch alert ' +
    'for full triage (always Testing there); small ones wait and go out as one alert once 3 accounts tell the same story; ' +
    'a story already alerted isn\'t posted again';

  // -----------------------------------------------------------------------------------------------------------
  // The one-space world, a look at a time
  // -----------------------------------------------------------------------------------------------------------

  /** A post's link, by number. */
  const P = n => `https://x.com/user${n}/status/21600000000000${String(n).padStart(5, '0')}`;
  /** A post the brand-safety watch flags at its bar (8 of 10, the bar 7), 250 engagements, unless `o` says otherwise. */
  const flag = (n, o) => golden.rows.hit(Object.assign({ post_url: P(n), author: `@user${n}`, followers: 3200, eng: 250,
    issue: `Story number ${n}`, summary: `An X user (@user${n}) describes problem number ${n} with a Google product.`,
    topic: 'Product failure or outage' }, o || {}));

  /**
   * The one-space setup (golden_flows.js: B3, B4 and B9 blank; B10; B25 read only; rows 15, 19, 34, 38, 39 and 40 ON)
   * after its first run, the brand-safety watch ON (`o.midterms`: the Midterms watch too) and B35 as `o.b35` says (the
   * Auto-correct space when left out). The pre-read answers each post from `w.say(post, recent, posts)`, else as a
   * meaningful post about Pixel with its issue as its story.
   */
  function oneSpace(o) {
    const opt = Object.assign({ b35: TO_AC }, o || {});
    const w = golden.world.oneSpaceWorld();
    const { t } = w;
    t.poll();  // the watch's tabs
    golden.world.watchOn(t);
    const watches = t.sheet().getSheetByName('Watches');
    if (opt.midterms) watches.getRange(watches.rows.findIndex(r => r[0] === MIDTERMS) + 1, 2).setValue('ON');
    if (opt.b35) w.sh.getRange(35, 2).setValue(opt.b35);
    w.say = null;
    t.g.vertex.watchPreRead = payload => {
      const prompt = payload.contents[0].parts.map(p => p.text || '').join('');
      const part = tag => JSON.parse((prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`)) || [])[1] || '[]');
      const posts = part('watch_posts');
      const recent = part('recent_alerts');
      return { watch_posts: posts.map(p => Object.assign({ ref: p.ref, summary: p.text || '', background: '', about_google: true,
        product: 'Pixel', other_products: [], exposure_tag: 'Product - Other/general criticism', sensitive_topics: [],
        story: p.issue || `story ${p.ref}`, same_story_as: '', meaningful: true }, (w.say && w.say(p, recent, posts)) || {})) };
    };
    return w;
  }
  /** The us-central1 looks (Sonar and Tubular) sent so far. */
  const sent = w => Object.keys(w.feed.jobs).filter(id => w.feed.jobs[id] === C1).length;
  /** The watch's next look: runs go by, a minute each, until it is sent; the run after collects it, with `hits`. */
  function look(w, hits) {
    w.feed.look = [];
    const before = sent(w);
    for (let i = 0; i < 8 && sent(w) === before; i++) w.t.poll();
    assert.ok(sent(w) > before, 'a look was sent');
    w.feed.look = hits || [];
    w.t.poll();
    w.feed.look = [];
  }
  const c34 = t => t.control().cell(34, 3);
  const c35 = t => t.control().cell(35, 3);
  /** The hidden keys of the Watch detections tab's rows, by post link. */
  const keysOf = t => Object.fromEntries(t.sheet().getSheetByName('Watch detections').rows.slice(13)
    .filter(r => (r || []).some(v => v !== '' && v !== undefined && v !== null))
    .map(r => [`${String(r[5])}|${JSON.parse(r[18]).w}`, JSON.parse(r[18])]));
  const letter = (t, n, watch) => (keysOf(t)[`${P(n)}|${watch || BRAND}`] || {}).a;
  /** The bot's Watch alert cards in the Auto-correct space. */
  const cards = t => t.chat.botPosts(AC).filter(m => !m.threadReply && /^client-zwat-/.test(m.clientAssignedMessageId || ''));

  // -----------------------------------------------------------------------------------------------------------
  // C35: the day's counts
  // -----------------------------------------------------------------------------------------------------------

  test('watch notes: C35 says the day\'s counts before its explanation, each count but "posted" only when above zero; with every count at three digits none is cut: the explanation is, then a long reason for waiting, then a long space name', () => {
    const dest = { choice: 'autocorrect', space: { id: AC, name: AC_NAME }, problem: '' };
    const text = (d, res, today, grouped, more) => B.pwAlertsNoteText_(d, res, true, today, grouped, more);
    // a quiet day: the explanation whole, after the one count
    eq(text(dest, null, 0, 0, B.pwAlertDayMore_()), `✓ ${AC_NAME} (B10) · today: 0 posted · ${HOW}`);
    eq(text(dest, { waiting: 0 }, 2, 0, { already: 3, dropped: 1 }),
      `✓ ${AC_NAME} (B10) · today: 2 posted, 3 on a post that already had an alert, 1 dropped after waiting 3 hours · ${HOW}`);
    // every count, each a different three-digit number
    const more = { builds: 101, held: 103, repeats: 104, offTopic: 105, already: 106, noted: 100, twin: 107, notEnglish: 108,
      dropped: 109, empty: 110 };
    const COUNTS = 'today: 912 posted (101 a build-up of small posts), +102 in their story\'s thread, 103 small held to be ' +
      'grouped, 104 repeats of an alerted story held back, 105 off-topic not posted, 106 on a post that already had an alert ' +
      '(100 noted in its thread), 107 on a post another watch flagged too, 108 not in English, 109 dropped after waiting 3 ' +
      'hours, 110 with nothing to show, 111 waiting';
    eq(B.pwAlertCountsText_(912, 102, more, 111), COUNTS);
    const busy = text(dest, { waiting: 111 }, 912, 102, more);
    eq(busy.indexOf(`✓ ${AC_NAME} (B10) · ${COUNTS}`), 0);
    assert.ok(busy.length <= 480, String(busy.length));
    // the explanation is what gives way: cut short, or left out when under 40 characters of it would fit
    const rest = busy.slice(`✓ ${AC_NAME} (B10) · ${COUNTS}`.length);
    assert.ok(rest === '' || (/^ · a flag that matters by itself .*…$/.test(rest) && rest.length >= 40), rest);
    const some = text(dest, { waiting: 0 }, 912, 102, { builds: 101, held: 103, repeats: 104, offTopic: 105, already: 106 });
    assert.match(some, /, 106 on a post that already had an alert · a flag that matters by itself \(a KOF author, .*…$/);
    eq(some.length, 480);
    // waiting, with a long reason: the reason is cut, the counts stay whole at the end
    const why = `couldn't post in ${AC_NAME}: ${'Chat HTTP 500: Internal error encountered. '.repeat(4)}`.trim();
    const waiting = text(dest, { waiting: 111, problem: why }, 912, 102, more);
    assert.ok(waiting.indexOf('⚠️ waiting: couldn\'t post in ') === 0 && waiting.endsWith(`… · ${COUNTS}`), waiting);
    assert.ok(waiting.length <= 480, String(waiting.length));
    eq(text(dest, { waiting: 1, problem: 'the AI read of the flagged posts failed this run (tried again next run)' }, 2, 0, {}),
      '⚠️ waiting: the AI read of the flagged posts failed this run (tried again next run) (a flag waits up to 3 hours) · ' +
      'today: 2 posted, 1 waiting');
    // a space with a very long name: the name is cut, never a count
    const long = text({ choice: 'autocorrect', space: { id: AC, name: 'N'.repeat(128) }, problem: '' }, { waiting: 111 }, 912, 102, more);
    assert.ok(/^✓ N+… · today: 912 posted /.test(long) && long.endsWith(COUNTS) && long.length <= 480, long);
    // how many of the flags on a post that already had an alert were noted under that alert's card: all, some, none
    const noted = (already, n) => B.pwAlertCountsText_(1, 0, { already, noted: n }, 0);
    eq([noted(5, 5), noted(5, 2), noted(5, 0), noted(1, 1), noted(0, 3)], [
      'today: 1 posted, 5 on a post that already had an alert (noted in its thread)',
      'today: 1 posted, 5 on a post that already had an alert (2 noted in its thread)',
      'today: 1 posted, 5 on a post that already had an alert',
      'today: 1 posted, 1 on a post that already had an alert (noted in its thread)',
      'today: 1 posted']);
  });

  test('watch notes: the day\'s counts are kept in one script property (PW_ALERT_TODAY), small whatever the day held (every count at 999,999: far under the 9 KB a property holds), read back by name, and start again on a new day', () => {
    const { t } = oneSpace();
    const names = ['builds', 'held', 'repeats', 'offTopic', 'already', 'noted', 'twin', 'notEnglish', 'dropped', 'empty'];
    const all = n => Object.fromEntries(names.map(k => [k, n]));
    eq(t.bot.pwAlertDayMore_(), all(0));
    t.bot.pwAlertDay_(999000, 999000, all(999000));
    eq(t.bot.pwAlertDay_(999, 999, all(999)), 999999);
    eq([t.bot.pwAlertDayMore_(), t.bot.pwAlertDayGrouped_()], [all(999999), 999999]);
    const kept = t.g.props.get('PW_ALERT_TODAY');
    assert.ok(kept.length <= 8800 && kept.length < 200, `${kept.length} characters`);
    eq(Object.keys(JSON.parse(kept)).sort(), ['b', 'd', 'day', 'dn', 'e', 'g', 'h', 'l', 'n', 'o', 'r', 't', 'x']);
    // a count that stayed zero has no key; the next day starts from nothing
    t.g.clock.now += 24 * HOUR;
    eq([t.bot.pwAlertDay_(0), t.bot.pwAlertDayMore_()], [0, all(0)]);
    t.bot.pwAlertDay_(1, 0, { dropped: 2 });
    eq(JSON.parse(t.g.props.get('PW_ALERT_TODAY')), { day: t.bot.dayKey_(), n: 1, x: 2 });
  });

  /** C35's counts as numbers, by name; a count that isn't there is 0. */
  const COUNT_RX = { posted: /(\d+) posted/, builds: /\((\d+) a build-up of small posts\)/, grouped: /\+(\d+) in their story's thread/,
    held: /(\d+) small held to be grouped/, repeats: /(\d+) repeats of an alerted story held back/,
    offTopic: /(\d+) off-topic not posted/, already: /(\d+) on a post that already had an alert/,
    twin: /(\d+) on a post another watch flagged too/, notEnglish: /(\d+) not in English/,
    dropped: /(\d+) dropped after waiting 3 hours/, empty: /(\d+) with nothing to show/, waiting: /(\d+) waiting$/ };
  const countsOf = text => {
    const today = (String(text).match(/(?:^| · )today: (.*?)(?: · |$)/) || [])[1] || '';
    return Object.fromEntries(Object.keys(COUNT_RX).map(k => [k, Number((today.match(COUNT_RX[k]) || [])[1]) || 0]));
  };
  const counts = (t, o) => eq(countsOf(c35(t)), Object.assign(Object.fromEntries(Object.keys(COUNT_RX).map(k => [k, 0])), o));

  test('watch notes: one day with every ending of a flag (the one-space setup, two watches ON, Direct BigQuery ON): C35 counts each flag once, where it ended, and with those counts every flag C34 calls "flagged today" is accounted for; the one ending C35 has no count for is a flag recorded while B35 was still OFF, which is listed and never queued', () => {
    const w = oneSpace({ b35: 'OFF', midterms: true });
    const { t } = w;
    const MAPS_STORY = 'Maps routing onto a closed bridge';
    // The pre-read: one post isn't about Google; posts with the same issue tell one story (but for the Maps story, where
    // it names no earlier story: the alert memory's own test finds it); one post has no words of its own
    w.say = (p, recent, posts) => {
      if (/Nepal/.test(p.issue || '')) return { about_google: false, product: null, exposure_tag: '', story: 'Nepal protest footage' };
      if (p.issue === MAPS_STORY) return {};
      const earlier = recent.find(r => r.story === p.issue);
      const first = posts.find(x => x.issue === p.issue);
      return Object.assign(earlier ? { same_story_as: earlier.ref } : first.ref !== p.ref ? { same_story_as: first.ref } : {},
        p.text ? {} : { summary: '' });
    };
    // 1. flagged while B35 is OFF: listed, never queued (its key has no letter) and never posted, also once B35 is set
    look(w, [flag(1)]);
    eq([letter(t, 1), c35(t)], [undefined, B.pwAlertsOffText_()]);
    w.sh.getRange(35, 2).setValue(TO_AC);
    // 2. two near misses (6 and 5.2 against a bar of 7): C34 counts them apart, they are never flags
    look(w, [flag(2, { impact: 6 }), flag(3, { impact: 5.2 })]);
    counts(t, {});
    // 3. a flag that matters by itself: posted; another post on its story: into its thread
    look(w, [flag(4, { issue: 'Pixel camera stops focusing' })]);
    look(w, [flag(5, { eng: 300, issue: 'Pixel camera stops focusing' })]);
    eq([letter(t, 4), letter(t, 5)], ['p', 'g']);
    counts(t, { posted: 1, grouped: 1 });
    // 4. two small posts on one story: held. A third account brings the build-up, but its post has nothing to show
    look(w, [flag(6, { eng: 20, issue: 'Chrome extension breaks' }), flag(7, { eng: 45, issue: 'Chrome extension breaks' })]);
    look(w, [flag(8, { eng: 30, issue: 'Chrome extension breaks', summary: '' })]);
    eq([6, 7, 8].map(n => letter(t, n)), ['b', 'b', 'n']);
    counts(t, { posted: 1, grouped: 1, held: 2, empty: 1 });
    // 5. not about Google
    look(w, [flag(9, { issue: 'Nepal protest clip', summary: 'A user shares protest footage and says to google it.' })]);
    eq(letter(t, 9), 'o');
    // 6. two posts Direct BigQuery cards first (one of them ends in a Social Alert); the watch flags both afterwards
    w.feed.bsip = [golden.rows.bsipRow(), golden.rows.mapsRow()];
    const bqCards = () => t.chat.botPosts(AC).filter(m => !m.threadReply && /\*\[BigQuery · BSIP\]\*/.test(m.text));
    for (let i = 0; i < 12 && bqCards().length < 2; i++) t.poll();
    eq(bqCards().length, 2);
    look(w, [golden.rows.pixelHit(), golden.rows.mapsHit()]);
    const keys = keysOf(t);
    eq([keys[`${golden.posts.PIXEL}|${BRAND}`].a, keys[`${golden.posts.MAPS}|${BRAND}`].a], ['d', 'd']);
    counts(t, { posted: 1, grouped: 1, held: 2, empty: 1, offTopic: 1, already: 2 });
    assert.ok(t.g.gmail.sentMessages().some(m => m.subject.includes(MAPS_STORY)), 'the Maps card ended in a Social Alert');
    // 7. another account on the story of that Social Alert: a repeat
    look(w, [flag(12, { eng: 300, issue: MAPS_STORY,
      summary: 'An X user says Google Maps keeps sending drivers onto a closed bridge and calls the routing biased toward toll roads.' })]);
    eq(letter(t, 12), 'r');
    // 8. one post both watches flag: one alert, the other watch's flag closed
    look(w, [flag(13), flag(13, { watch: MIDTERMS, idx: 2, impact: 7.5 })]);
    eq([letter(t, 13), letter(t, 13, MIDTERMS)], ['p', 'd']);
    // 9. a post that turns out not to be in English when the bot looks it up
    const id = P(14).split('/').pop();
    t.g.pages.set(`${B.ev('X_EMBED_API_')}?id=${id}&lang=en&token=${B.xEmbedToken_(id)}`, JSON.stringify({ id_str: id, lang: 'ru',
      text: 'Пользователь пишет, что батарея Pixel 10 вздулась после обновления системы', user: { screen_name: 'user14' } }));
    look(w, [flag(14)]);
    eq(letter(t, 14), 'd');
    counts(t, { posted: 2, grouped: 1, held: 2, empty: 1, offTopic: 1, already: 2, repeats: 1, twin: 1, notEnglish: 1 });
    // 10. a flag whose card Chat refuses: it waits (C35 says why), and three hours on it is dropped
    t.chat.fail = (method, path, query, body) => (method === 'post' && body && String(body.text || '').includes(P(15))
      ? { code: 500, body: { error: { code: 500, message: 'Internal error encountered' } } } : null);
    look(w, [flag(15, { eng: 180 })]);
    eq(letter(t, 15), 'q');
    assert.match(c35(t), /^⚠️ waiting: couldn't post in SLRR One Space \(Auto-correct\): .* \(a flag waits up to 3 hours\) · today: 2 posted, .*, 1 waiting$/);
    t.g.clock.now += 3 * HOUR;
    t.poll();
    eq(letter(t, 15), 'x');

    // The day: what C34 counts as flagged, and where C35 says each of them ended
    const flagged = Number((c34(t).match(/ · today: (\d+) flagged, 2 near misses/) || [])[1]);
    const ended = { posted: 2, grouped: 1, held: 2, repeats: 1, offTopic: 1, already: 2, twin: 1, notEnglish: 1, dropped: 1, empty: 1 };
    counts(t, ended);
    const letters = Object.values(keysOf(t)).filter(k => k.b === 1).map(k => k.a || 'none');
    const tally = l => letters.filter(x => x === l).length;
    eq([tally('p'), tally('g'), tally('b'), tally('r'), tally('o'), tally('d'), tally('x'), tally('n'), tally('q'), tally('none')],
      [ended.posted, ended.grouped, ended.held, ended.repeats, ended.offTopic, ended.already + ended.twin + ended.notEnglish,
        ended.dropped, ended.empty, 0, 1]);
    const counted = Object.keys(ended).reduce((n, k) => n + ended[k], 0);
    // every flag is in one of C35's counts, but the one recorded while B35 was OFF (post 1)
    eq([flagged, counted, flagged - counted], [14, 13, tally('none')]);
    eq(letter(t, 1), undefined);
    assert.ok(c35(t).length <= 480 && c35(t).indexOf(`✓ ${AC_NAME} (B10) · today: 2 posted, +1 in their story's thread, `) === 0, c35(t));
    // what was posted: the two Watch alerts, nothing for any other flag
    eq(cards(t).map(m => (m.text.match(/user\d+/) || [])[0]), ['user4', 'user13']);
  });

  test('watch notes: a flag found to be on an alerted thread only when its post is looked up, just before posting (two replies in one X thread flagged in the same look: the higher-scored one is posted, the other is not), is counted on C35 as on a post that already had an alert', () => {
    const w = oneSpace();
    const { t } = w;
    const id = n => P(n).split('/').pop();
    const ROOT = '2160000000000000900';
    const reply = n => t.g.pages.set(`${B.ev('X_EMBED_API_')}?id=${id(n)}&lang=en&token=${B.xEmbedToken_(id(n))}`, JSON.stringify({
      id_str: id(n), text: `Reply ${n} about a Pixel problem`, user: { screen_name: `user${n}` }, in_reply_to_status_id_str: ROOT,
      parent: { id_str: ROOT, text: 'The post both reply to', user: { screen_name: 'root' } } }));
    reply(21);
    reply(22);
    look(w, [flag(21, { impact: 9 }), flag(22, { impact: 8 })]);
    eq([letter(t, 21), letter(t, 22), cards(t).length], ['p', 'd', 1]);
    counts(t, { posted: 1, already: 1 });
  });
};
