// What the Control tab says about the Proactive watch (row 34, ProactiveWatch.gs) and its Watch alerts (row 35,
// WatchAlerts.gs), in the one-space setup (everything in the Auto-correct space, B10; B35 = B10):
//   - C35 counts how every flag of the day ended, the counts before its explanation, and never cuts a count;
//   - with no watch ON on the Watches tab, C35 says so in place of its healthy sentence;
//   - a look whose BigQuery job fails as a whole stays visible: C34 says since when and why until that job succeeds
//     again, and the Watch sources tab shows the job's sources as failing, not as stale;
//   - each flag that ends without a card leaves one log line with its link: the alert it matched, or why it waited.
// Nothing here changes what is posted in Chat, emailed or queued: only notes on the Control tab, status text on the
// Watch sources tab and log lines.
//   node apps-script-chat-bot/test/run_tests.js "watch notes:"
'use strict';

module.exports = H => {
  const { test, eq, assert, B } = H;
  const golden = require('./golden_flows')(H);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const C1 = 'us-central1';
  const US = 'US';
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
   * after its first run, the brand-safety watch ON (`o.midterms`: the Midterms watch too; `o.watch` false: none) and
   * B35 as `o.b35` says (the Auto-correct space when left out). The pre-read answers each post from
   * `w.say(post, recent, posts)`, else as a meaningful post about Pixel with its issue as its story.
   */
  function oneSpace(o) {
    const opt = Object.assign({ b35: TO_AC }, o || {});
    const w = golden.world.oneSpaceWorld();
    const { t } = w;
    t.poll();  // the watch's tabs
    const watches = t.sheet().getSheetByName('Watches');
    w.watch = (name, on) => watches.getRange(watches.rows.findIndex(r => r[0] === name) + 1, 2).setValue(on ? 'ON' : 'OFF');
    if (opt.watch !== false) w.watch(BRAND, true);
    if (opt.midterms) w.watch(MIDTERMS, true);
    if (opt.b35) w.sh.getRange(35, 2).setValue(opt.b35);
    // What a look answers when it is collected, where the test says so (w.answers[its BigQuery location]): {rows} (its
    // 'hit' and 'src' rows) or {fail: {code, message}} (BigQuery's error for the whole job); and a look BigQuery refuses
    // when it is sent (w.refuse(its location): {code, message}, or null). Else as golden's feeds do
    w.answers = {};
    w.refuse = null;
    const fetch = t.g.services.UrlFetchApp.fetch;
    t.g.services.UrlFetchApp.fetch = (link, params) => {
      const job = (String(link).match(/^https:\/\/bigquery\.googleapis\.com\/.*\/queries\/(pwjob_\d+)\?/) || [])[1];
      const asked = !job && w.refuse && /^https:\/\/bigquery\.googleapis\.com\/.*\/queries$/.test(String(link)) ? JSON.parse(params.payload) : null;
      const refused = asked && /CREATE TEMP TABLE pw_new/.test(asked.query || '') ? w.refuse(asked.location) : null;
      const a = job ? w.answers[w.feed.jobs[job]] : refused ? { fail: refused } : null;
      if (!a) return fetch(link, params);
      const body = a.fail ? { error: { code: a.fail.code, message: a.fail.message } }
        : { jobComplete: true, jobReference: { projectId: 'brand-social-central-data', jobId: job, location: w.feed.jobs[job] },
          schema: { fields: LOOK_COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
          rows: a.rows.map(r => ({ f: LOOK_COLS.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })) };
      return { getResponseCode: () => (a.fail ? a.fail.code : 200), getHeaders: () => ({}), getContentText: () => JSON.stringify(body) };
    };
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
  // A look's result columns (ProactiveWatch.gs pwSql_'s final SELECT), and a row a source of each of its two jobs
  const LOOK_COLS = [['kind'], ['source'], ['why'], ['idx', 'INTEGER'], ['watch'], ['post_url'], ['platform'], ['author'],
    ['followers', 'INTEGER'], ['eng', 'INTEGER'], ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'], ['issue'], ['issue_new', 'BOOLEAN'],
    ['summary'], ['impact', 'FLOAT'], ['bar', 'FLOAT'], ['topic'], ['found', 'INTEGER'], ['checked', 'INTEGER'],
    ['newest_ms', 'INTEGER'], ['mod_ms', 'INTEGER'], ['err'], ['detail'], ['tax']];
  const C1_SOURCES = ['sonar', 'tubular'];
  const US_SOURCES = ['bwm', 'owned', 'comments', 'story', 'chat', 'bwq'];
  /** A source's row for each of `keys`: nothing new, unless `o[key]` says otherwise. */
  const srcs = (keys, o) => keys.map(k => Object.assign({ kind: 'src', source: k, found: 0, checked: 0, newest_ms: null, mod_ms: null,
    err: null }, (o || {})[k]));
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
    // The log: each flag that ended without a card left one line with its link. The two on a post Direct BigQuery had
    // carded name that card's alert; the second watch's flag names the watch whose flag carries the post; the one
    // dropped says why it was waiting
    const alertLog = t.sheet().getSheetByName('Alert log');
    const col = name => alertLog.rows[0].indexOf(name);
    const idOf = url => (alertLog.rows.slice(1).find(r => r[col('record_key')] === B.recordKey_({ post_url: url })) || [])[col('alert_id')];
    assert.ok(/^QA-\d+$/.test(idOf(golden.posts.PIXEL)) && /^QA-\d+$/.test(idOf(golden.posts.MAPS)), 'both cards are in the Alert log');
    eq(t.g.logs.filter(l => /^Watch alerts: (?:not posting|dropped) /.test(l)), [
      `Watch alerts: not posting ${P(8)}: no summary, text or picture to show analysts`,
      `Watch alerts: not posting ${P(9)}: the pre-read says it isn't about Google`,
      `Watch alerts: not posting ${golden.posts.PIXEL}: it already had an alert: already seen (${idOf(golden.posts.PIXEL)})`,
      `Watch alerts: not posting ${golden.posts.MAPS}: it already had an alert: ${idOf(golden.posts.MAPS)} in the Alert log`,
      `Watch alerts: not posting ${P(13)}: the watch "${MIDTERMS}" flagged it too: the flag of "${BRAND}" on the same post is the one that goes on`,
      `Watch alerts: not posting ${P(14)}: the post is not in English`,
      `Watch alerts: dropped ${P(15)}: not posted within 3 hours of being seen (${B.pwTime_(keysOf(t)[`${P(15)}|${BRAND}`].s)} ET): ` +
        `couldn't post in ${AC_NAME}: Chat API 500 on posting to ${AC}: Internal error encountered`,
    ]);
  });

  test('watch notes: a flag found to be on an alerted thread only when its post is looked up, just before posting (two replies in one X thread flagged in the same look: the higher-scored one is posted, the other is not), is counted on C35 as on a post that already had an alert, and its log line names the Watch alert that covers its thread; a second watch flagging the posted post later is counted the same way, its line naming that Watch alert too', () => {
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
    const notPosted = () => t.g.logs.filter(l => /^Watch alerts: not posting /.test(l));
    const CARD = `the Watch alert of "${BRAND}" (${cards(t)[0].name})`;
    eq(notPosted(), [`Watch alerts: not posting ${P(22)}: a post of its thread already had an alert: ${CARD}`]);
    // the Midterms watch flags the posted post too, a look later
    w.watch(MIDTERMS, true);
    look(w, [flag(21, { watch: MIDTERMS, idx: 2, impact: 7.5 })]);
    eq([letter(t, 21, MIDTERMS), cards(t).length], ['d', 1]);
    counts(t, { posted: 1, already: 2 });
    eq(notPosted().slice(1), [`Watch alerts: not posting ${P(21)}: it already had an alert: ${CARD}`]);
  });

  // -----------------------------------------------------------------------------------------------------------
  // C35: a small flag that waited is counted once, where it ended
  // -----------------------------------------------------------------------------------------------------------

  /** A pre-read in which posts with the same issue tell one story: an earlier story's, else the first such post's. */
  const sameIssue = (p, recent, posts) => {
    const earlier = recent.find(r => r.story === p.issue);
    const first = posts.find(x => x.issue === p.issue);
    return earlier ? { same_story_as: earlier.ref } : first.ref !== p.ref ? { same_story_as: first.ref } : {};
  };
  /** How many flags C35's counts account for (a build-up is one of the posted), and how many C34 calls flagged today. */
  const accounted = t => {
    const c = countsOf(c35(t));
    return Object.keys(c).filter(k => k !== 'builds').reduce((n, k) => n + c[k], 0);
  };
  const flaggedToday = t => Number((c34(t).match(/ · today: (\d+) flagged, /) || [])[1]);
  /** Chat refuses what the bot posts when its text says `rx` (a 500). */
  const refuse = (t, rx) => {
    t.chat.fail = (method, path, query, body) => (method === 'post' && body && rx.test(String(body.text || ''))
      ? { code: 500, body: { error: { code: 500, message: 'Internal error encountered' } } } : null);
  };

  test('watch notes: a small flag that waited and then went out is counted once on C35, where it ended: "small held to be grouped" counts the flags held today that still wait, so one queued again when its post grew (then posted, or dropped 3 hours on) and the held posts of a build-up that goes out leave that count, and C35\'s counts add up to what C34 calls "flagged today" at every step; a flag held the day before that goes out today is not taken off today\'s count; the count never goes below zero', () => {
    const w = oneSpace();
    const { t } = w;
    w.say = sameIssue;
    const TODAY = text => `✓ ${AC_NAME} (B10) · today: ${text} · ${HOW}`;
    // 1. a small post (20 engagements): held
    look(w, [flag(31, { eng: 20, issue: 'Gmail search is slow' })]);
    eq([letter(t, 31), c35(t)], ['b', TODAY('0 posted, 1 small held to be grouped')]);
    // ...its post is handed over again at 150 engagements: queued again and posted. It is no longer held
    look(w, [flag(31, { eng: 150, issue: 'Gmail search is slow' })]);
    eq([letter(t, 31), c35(t)], ['p', TODAY('1 posted')]);
    eq([flaggedToday(t), accounted(t)], [1, 1]);
    // 2. two small posts on one story: held. A third account brings the build-up: one alert, the two in its thread
    look(w, [flag(32, { eng: 20, issue: 'Drive loses a folder' }), flag(33, { eng: 30, issue: 'Drive loses a folder' })]);
    eq([[32, 33].map(n => letter(t, n)), c35(t)], [['b', 'b'], TODAY('1 posted, 2 small held to be grouped')]);
    eq([flaggedToday(t), accounted(t)], [3, 3]);
    look(w, [flag(34, { eng: 40, issue: 'Drive loses a folder' })]);
    eq([32, 33, 34].map(n => letter(t, n)), ['g', 'g', 'p']);
    eq(c35(t), TODAY('2 posted (1 a build-up of small posts), +2 in their story\'s thread'));
    eq([flaggedToday(t), accounted(t)], [4, 4]);
    eq(JSON.parse(t.g.props.get('PW_ALERT_TODAY')), { day: t.bot.dayKey_(), n: 2, g: 2, b: 1 });  // a count back at zero has no key
    // 3. a small post held, queued again when it grew, but Chat refuses its card: it waits, and 3 hours on it is dropped
    look(w, [flag(35, { eng: 25, issue: 'Photos deletes albums' })]);
    counts(t, { posted: 2, builds: 1, grouped: 2, held: 1 });
    refuse(t, new RegExp(P(35).replace(/[.?]/g, '\\$&')));
    look(w, [flag(35, { eng: 180, issue: 'Photos deletes albums' })]);
    eq(letter(t, 35), 'q');
    counts(t, { posted: 2, builds: 1, grouped: 2, waiting: 1 });
    t.g.clock.now = keysOf(t)[`${P(35)}|${BRAND}`].rq + 3 * HOUR;
    t.poll();
    eq(letter(t, 35), 'x');
    counts(t, { posted: 2, builds: 1, grouped: 2, dropped: 1 });
    eq([flaggedToday(t), accounted(t)], [5, 5]);
    t.chat.fail = null;
    // 4. a small post held today; the next day starts from nothing; another small post is held then
    look(w, [flag(36, { eng: 15, issue: 'Keep loses notes' })]);
    counts(t, { posted: 2, builds: 1, grouped: 2, dropped: 1, held: 1 });
    eq([flaggedToday(t), accounted(t)], [6, 6]);
    t.g.clock.now += 24 * HOUR;
    look(w, [flag(37, { eng: 12, issue: 'Calendar shifts events' })]);
    eq([[36, 37].map(n => letter(t, n)), c35(t)], [['b', 'b'], TODAY('0 posted, 1 small held to be grouped')]);
    // ...the one held the day before grows and is posted: today's count of held flags (the other one) stays
    look(w, [flag(36, { eng: 400, issue: 'Keep loses notes' })]);
    eq([[36, 37].map(n => letter(t, n)), c35(t)], [['p', 'b'], TODAY('1 posted, 1 small held to be grouped')]);
    // the count by itself: only "held" can be taken from, and never below zero
    t.bot.pwAlertDay_(0, 0, { dropped: 4, repeats: 2 });
    t.bot.pwAlertDay_(0, 0, { held: -5, dropped: -3, repeats: -1 });
    eq(JSON.parse(t.g.props.get('PW_ALERT_TODAY')), { day: t.bot.dayKey_(), n: 1, r: 2, x: 4 });
    t.bot.pwAlertDay_(0, 0, { held: 3 });
    t.bot.pwAlertDay_(0, 0, { held: -1 });
    eq([t.bot.pwAlertDayMore_().held, t.bot.pwOnToday_(t.g.clock.now), t.bot.pwOnToday_(t.g.clock.now - 24 * HOUR), t.bot.pwOnToday_(0),
      t.bot.pwOnToday_(undefined)], [2, true, false, false, false]);
  });

  test('watch notes: the held posts of a build-up are counted once however they end: when Chat refuses the reply that lists them in the build-up\'s thread they still left with that alert (their key says so) and are counted with the posts in their story\'s thread; when the story they waited on turns out to be one already alerted (the alert memory\'s own test, as the build-up is about to go out) they are counted as repeats; none of them stays in "small held to be grouped", and C35 adds up to C34\'s "flagged today"', () => {
    const w = oneSpace();
    const { t } = w;
    w.say = sameIssue;
    // 1. two small posts held; the third account's post brings the build-up, and Chat refuses the list of its other posts
    look(w, [flag(51, { eng: 20, issue: 'Docs loses edits' }), flag(52, { eng: 30, issue: 'Docs loses edits' })]);
    counts(t, { held: 2 });
    refuse(t, /^🔗 \*Same story: /);
    look(w, [flag(53, { eng: 40, issue: 'Docs loses edits' })]);
    t.chat.fail = null;
    eq([[51, 52, 53].map(n => letter(t, n)), cards(t).length], [['g', 'g', 'p'], 1]);
    assert.ok(t.g.logs.some(l => /^Watch alerts: couldn't add the story's other posts to its alert's thread: /.test(l)), 'the reply was refused');
    eq(t.chat.botPosts(AC).filter(m => m.threadReply && /Same story/.test(m.text)), []);
    counts(t, { posted: 1, builds: 1, grouped: 2 });
    eq([flaggedToday(t), accounted(t)], [3, 3]);
    // 2. two small posts on the Maps story are held; then Direct BigQuery cards a bigger post on it, which ends in a
    // Social Alert; a third account's small post would bring the build-up (the pre-read names the posts that wait, not
    // that alert), but the story has had its alert: three repeats
    const MAPS_STORY = 'Maps routing onto a closed bridge';
    w.say = (p, recent, posts) => {
      const waiting = recent.find(r => r.status === 'waiting' && r.story === p.issue);
      return waiting ? { same_story_as: waiting.ref } : sameIssue(p, [], posts);
    };
    const maps = (n, eng) => flag(n, { eng, issue: MAPS_STORY,
      summary: 'An X user says Google Maps keeps sending drivers onto a closed bridge and calls the routing biased toward toll roads.' });
    look(w, [maps(54, 20), maps(55, 30)]);
    eq([54, 55].map(n => letter(t, n)), ['b', 'b']);
    counts(t, { posted: 1, builds: 1, grouped: 2, held: 2 });
    w.feed.bsip = [golden.rows.mapsRow()];
    const alerted = () => t.g.gmail.sentMessages().some(m => m.subject.includes(MAPS_STORY));
    for (let i = 0; i < 15 && !alerted(); i++) t.poll();
    assert.ok(alerted(), 'the Maps card ended in a Social Alert');
    look(w, [maps(56, 40)]);
    eq([[54, 55, 56].map(n => letter(t, n)), cards(t).length], [['r', 'r', 'r'], 1]);
    counts(t, { posted: 1, builds: 1, grouped: 2, repeats: 3 });
    eq([flaggedToday(t), accounted(t)], [6, 6]);
  });

  test('watch notes: around midnight Eastern "small held to be grouped" stays a count of the day: a small flag held in a run that passes midnight is held on the day its key says (the day before), so it is not in the new day\'s count, and when it goes out on the new day nothing is taken off a count it was never in; small posts held in the evening whose build-up goes out after midnight are not taken off the new day\'s count either', () => {
    const w = oneSpace();
    const { t } = w;
    const MIDNIGHT = Date.UTC(2026, 9, 15, 4, 0);  // 00:00 Eastern on Oct 15
    t.g.clock.now = MIDNIGHT - 30 * MIN;
    // a look is sent; the run that collects it starts 20 seconds before midnight, and its pre-read takes 40 seconds
    const before = sent(w);
    for (let i = 0; i < 8 && sent(w) === before; i++) t.poll();
    assert.ok(sent(w) > before && t.g.clock.now < MIDNIGHT - 2 * MIN, 'a look was sent before midnight');
    t.g.clock.now = MIDNIGHT - 80 * 1000;
    let slow = 40 * 1000;
    w.say = () => { t.g.clock.now += slow; slow = 0; return {}; };
    w.feed.look = [flag(61, { eng: 20 })];
    t.poll();
    w.feed.look = [];
    const key = keysOf(t)[`${P(61)}|${BRAND}`];
    eq([key.a, key.at < MIDNIGHT, t.g.clock.now > MIDNIGHT], ['b', true, true]);
    eq(c35(t), `✓ ${AC_NAME} (B10) · today: 0 posted · ${HOW}`);
    eq(t.bot.pwAlertDayMore_().held, 0);
    // on the new day another small post is held, and the first one grows and is posted
    w.say = null;
    look(w, [flag(62, { eng: 15 })]);
    eq(c35(t), `✓ ${AC_NAME} (B10) · today: 0 posted, 1 small held to be grouped · ${HOW}`);
    look(w, [flag(61, { eng: 300 })]);
    eq([[61, 62].map(n => letter(t, n)), c35(t)], [['p', 'b'], `✓ ${AC_NAME} (B10) · today: 1 posted, 1 small held to be grouped · ${HOW}`]);
    // that evening (9 PM) two small posts on one story are held; half an hour into the next day a small post on another
    // story is held, and then a third account brings the first story's build-up: its two posts were held the day
    // before, so today's count of held flags (the one post) stays as it is
    w.say = sameIssue;
    t.g.clock.now = Date.UTC(2026, 9, 16, 1, 0);
    look(w, [flag(63, { eng: 20, issue: 'Sheets drops a formula' }), flag(64, { eng: 30, issue: 'Sheets drops a formula' })]);
    eq(c35(t), `✓ ${AC_NAME} (B10) · today: 1 posted, 3 small held to be grouped · ${HOW}`);
    t.g.clock.now = Date.UTC(2026, 9, 16, 4, 30);
    look(w, [flag(65, { eng: 15, issue: 'Slides loses a theme' })]);
    eq(c35(t), `✓ ${AC_NAME} (B10) · today: 0 posted, 1 small held to be grouped · ${HOW}`);
    look(w, [flag(66, { eng: 40, issue: 'Sheets drops a formula' })]);
    eq([63, 64, 65, 66].map(n => letter(t, n)), ['g', 'g', 'b', 'p']);
    eq(c35(t), `✓ ${AC_NAME} (B10) · today: 1 posted (1 a build-up of small posts), +2 in their story's thread, 1 small held to be grouped · ${HOW}`);
  });

  // -----------------------------------------------------------------------------------------------------------
  // C35 with no watch ON
  // -----------------------------------------------------------------------------------------------------------

  test('watch notes: with no watch ON on the Watches tab C35 does not show its healthy sentence: it says "nothing to post: no watch is ON (set one to ON on the Watches tab)" in its place, before the day\'s counts; a watch turned ON brings the usual text back; flags raised before the last watch was turned OFF still go out, and while one of them waits C35 says "no watch is ON" without "nothing to post"; the warnings for row 34 OFF and for flags that can\'t go out read as before', () => {
    const NO_WATCH = 'no watch is ON (set one to ON on the Watches tab)';
    const w = oneSpace({ watch: false });
    const { t } = w;
    t.poll();
    eq(c35(t), `nothing to post: ${NO_WATCH} · today: 0 posted`);
    assert.match(c34(t), / · waiting: no watch is ON \(set a watch's On to ON on the Watches tab\)$/);  // C34, as before
    // a watch ON: the usual text
    w.watch(BRAND, true);
    t.poll();
    eq(c35(t), `✓ ${AC_NAME} (B10) · today: 0 posted · ${HOW}`);
    // five flags at once go out two a run. The watch is turned OFF after the first two: the rest still go out
    look(w, [1, 2, 3, 4, 5].map(n => flag(n, { impact: 9.5 - n / 10 })));
    eq(c35(t), `✓ ${AC_NAME} (B10) · today: 2 posted, 3 waiting · ${HOW}`);
    w.watch(BRAND, false);
    t.poll();
    eq(c35(t), `${NO_WATCH} · today: 4 posted, 1 waiting`);
    t.poll();
    eq([c35(t), cards(t).length], [`nothing to post: ${NO_WATCH} · today: 5 posted`, 5]);
    // row 34 OFF: its own warning, as it was
    w.sh.getRange(34, 2).setValue('OFF');
    t.poll();
    eq(c35(t), '⚠️ Auto-correct space (B10) chosen, but the Proactive watch (row 34) is OFF: nothing to post');
    // the text by itself: a reason flags can't go out comes first; B35 OFF and row 34 OFF say what they said
    const dest = { choice: 'autocorrect', space: { id: AC, name: AC_NAME }, problem: '' };
    const text = (d, res, watchOn) => B.pwAlertsNoteText_(d, res, watchOn, 3, 0, { already: 2 }, true);
    eq(text(dest, null, true), `nothing to post: ${NO_WATCH} · today: 3 posted, 2 on a post that already had an alert`);
    eq(text(dest, { waiting: 2 }, true), `${NO_WATCH} · today: 3 posted, 2 on a post that already had an alert, 2 waiting`);
    eq(text(dest, { waiting: 1, problem: 'the Auto-correct space\'s flow ran out of time on this run (Burson\'s alerts come first)' }, true),
      '⚠️ waiting: the Auto-correct space\'s flow ran out of time on this run (Burson\'s alerts come first) (a flag waits up to 3 ' +
      'hours) · today: 3 posted, 2 on a post that already had an alert, 1 waiting');
    eq([text({ choice: '' }, null, true), text(dest, null, false)], [B.pwAlertsOffText_(),
      '⚠️ Auto-correct space (B10) chosen, but the Proactive watch (row 34) is OFF: nothing to post']);
  });

  // -----------------------------------------------------------------------------------------------------------
  // C34 and the Watch sources tab while a look fails as a whole
  // -----------------------------------------------------------------------------------------------------------

  /** C34's note: what follows the switch's fixed text, as it is kept (at most 200 characters). */
  const noteOf = t => JSON.parse(t.g.props.get('SWITCH_NOTES')).proactiveWatch.text;
  /** The Watch sources tab's Status column, by source. */
  const statuses = t => Object.fromEntries(t.sheet().getSheetByName('Watch sources').rows.slice(3).map(r => [r[0], r[3]]));

  test('watch notes: a look that fails as a whole stays visible (the one-space setup: one good look, then the Sonar and Tubular job failing every time it is collected, for a day, the other job fine): C34 says so from the first failed try until that job succeeds again, after the last look and before today\'s counts ("the look at Sonar and Tubular has failed since <time>: <why>", the reason cut so that the note keeps to its 200 characters with the counts whole); the last look\'s numbers no longer carry the failed job\'s last good look; the Watch sources tab shows that job\'s sources as failing, with the whole error, not as stale, and status() says the same; the window skipped after 3 tries is in the log; when the job succeeds again C34 and the tab read as before; nothing is posted or emailed in all of it', () => {
    const w = oneSpace();
    const { t } = w;
    const ERR = 'Query error: AI.IF: quota exceeded for the Gemini model in us-central1';
    const good = found => ({ [C1]: { rows: srcs(C1_SOURCES, { sonar: { found, checked: Math.min(found, 150), newest_ms: t.g.clock.now,
      mod_ms: t.g.clock.now } }) }, [US]: { rows: srcs(US_SOURCES) } });
    const bad = { [C1]: { fail: { code: 400, message: ERR } }, [US]: { rows: srcs(US_SOURCES) } };
    const out = () => [t.chat.botPosts(AC).length, t.g.gmail.sentMessages().length, t.g.gmail.allDrafts().length];
    const quiet = out();
    // one good look: Sonar had 180 new posts and 150 of them were checked
    w.answers = good(180);
    look(w);
    const HEALTHY = 'last look Oct 14, 8:03 AM EDT: 150 new posts, 0 flagged · today: 0 flagged, 0 near misses · all 8 sources live (Watch sources tab)';
    eq(noteOf(t), HEALTHY);
    assert.ok(c34(t).endsWith(` · ${HEALTHY}`), c34(t));
    eq(statuses(t).Sonar, '✓ live: 180 new at the last look');
    // From now on the Sonar and Tubular job fails every time it is collected. Minute by minute: nothing changes until the
    // next look (sent 5 minutes after the last one) is collected; from then on every minute's C34 says so
    w.answers = bad;
    const minutes = [];
    for (let m = 1; m <= 16; m++) { t.poll(); minutes.push(noteOf(t)); }
    const failing = at => `last look ${at} EDT: 0 new posts, 0 flagged · the look at Sonar and Tubular has failed since Oct 14, 8:08 AM: ` +
      'BigQuery HTTP 400: Query error: AI.IF: quota… · today: 0 flagged, 0 near misses';
    eq(minutes, Array(4).fill(HEALTHY).concat(Array(5).fill(failing('Oct 14, 8:08 AM')), Array(5).fill(failing('Oct 14, 8:13 AM')),
      Array(2).fill(failing('Oct 14, 8:18 AM'))));
    minutes.forEach(n => assert.ok(n.length <= 200, n));
    assert.ok(c34(t).endsWith(` · ${failing('Oct 14, 8:18 AM')}`), c34(t));
    const since = JSON.parse(t.g.props.get('PW_LAST')).lanes.c1.fail.since;
    eq(B.pwWhen_(since), 'Oct 14, 8:08 AM');
    // 45 minutes on. Sonar's table last changed 46 minutes ago: before, its row read "stale" by now (it does after 30)
    for (let m = 17; m <= 45; m++) t.poll();
    eq(noteOf(t), failing('Oct 14, 8:48 AM'));
    const FAILING = `⚠️ failing: the look at Sonar and Tubular has failed since 2026-10-14 08:08 ET: BigQuery HTTP 400: ${ERR} ` +
      '(tried again at the next look)';
    const LIVE = '✓ live: nothing new at the last look';
    const others = { 'Brandwatch mentions': LIVE, 'Sprinklr owned posts': LIVE, 'Sprinklr comments': LIVE, 'DSD story selection': LIVE,
      'Other alerts space': LIVE, 'Brandwatch: 2026 Election Alerts': LIVE };
    eq(statuses(t), Object.assign({ Sonar: FAILING, Tubular: FAILING }, others));
    eq(t.bot.status().proactive_watch_sources.slice(0, 3), [`Sonar: ${FAILING}`, `Tubular: ${FAILING}`, `Brandwatch mentions: ${LIVE}`]);
    assert.ok(t.g.logs.includes('Proactive watch: skipped 08:01-08:16 for Sonar and Tubular after 3 tries; the next look carries on'));
    // ...and for the rest of the day and the night (a look every half hour here, to keep the test short): the next
    // morning C34 and the tab still say since when
    for (let i = 0; i < 52; i++) { t.g.clock.now += 28 * MIN; t.poll(); t.poll(); }
    eq(noteOf(t), failing('Oct 15, 10:48 AM'));
    eq(noteOf(t).length, 200);
    eq(statuses(t), Object.assign({ Sonar: FAILING, Tubular: FAILING }, others));
    eq(JSON.parse(t.g.props.get('PW_LAST')).lanes.c1, { fail: { since, why: `BigQuery HTTP 400: ${ERR}` } });
    // the job succeeds again: both read as they did before
    w.answers = good(12);
    look(w);
    eq(noteOf(t), 'last look Oct 15, 10:53 AM EDT: 12 new posts, 0 flagged · today: 0 flagged, 0 near misses · all 8 sources live (Watch sources tab)');
    eq(statuses(t), Object.assign({ Sonar: '✓ live: 12 new at the last look', Tubular: LIVE }, others));
    eq(Object.keys(JSON.parse(t.g.props.get('PW_LAST')).lanes.c1).sort(), ['at', 'checked', 'flagged', 'near']);
    eq(out(), quiet);
  });

  test('watch notes: C34 with a look failing keeps to the 200 characters a switch note has, whatever the day held: with every count at three digits none is cut, the reason is; the reason keeps 16 characters at least (the last look\'s numbers go first, then the last look itself); the US job is named by its first source ("Brandwatch mentions and 5 more"); with every look failing C34 says "the looks at all 8 sources have failed since", from when the later of them began to and with its reason, and no last look; the sources follow only when they fit whole; with no look failing the note is what it was', () => {
    const since = Date.UTC(2026, 9, 14, 14, 4);  // 10:04 AM ET
    const WHY = 'BigQuery HTTP 403: Access Denied: Project brand-social-central-data: User does not have bigquery.jobs.create permission';
    const text = (fails, o) => {
      const x = Object.assign({ today: { flagged: 120, near: 345 }, last: { at: 1, checked: 510, flagged: 120 },
        label: 'Oct 14, 10:05 AM EDT', sources: 'sources: 6 live, 2 failing: Sonar, Tubular' }, o);
      return B.pwNoteText_(x.today, x.last, x.label, x.sources, fails);
    };
    const LOOKED = 'last look Oct 14, 10:05 AM EDT: 510 new posts, 120 flagged';
    const COUNTS = ' · today: 120 flagged, 345 near misses';
    // no look failing: as it was
    const healthy = `${LOOKED}${COUNTS} · all 8 sources live (Watch sources tab)`;
    eq([text(undefined, { sources: 'all 8 sources live' }), text({}, { sources: 'all 8 sources live' })], [healthy, healthy]);
    eq(B.pwNoteText_({ flagged: 0, near: 1 }, null, '', ''), 'first look on its way · today: 0 flagged, 1 near miss (Watch detections tab)');
    // every count at three digits: the reason is cut to the room there is, never a count
    const c1 = text({ c1: { since, why: WHY } });
    eq(c1, `${LOOKED} · the look at Sonar and Tubular has failed since Oct 14, 10:04 AM: BigQuery HTTP 403: Access Denied: P…${COUNTS}`);
    const us = text({ us: { since, why: WHY } });
    eq(us, `${LOOKED} · the look at Brandwatch mentions and 5 more has failed since Oct 14, 10:04 AM: BigQuery HTTP 403: Acc…${COUNTS}`);
    eq([c1.length, us.length], [200, 200]);
    // counts so long that under 16 characters of the reason would be left: the last look's numbers go, then the last look
    const big = text({ us: { since, why: WHY } }, { today: { flagged: 1234567, near: 2345678 } });
    eq(big, 'last look Oct 14, 10:05 AM EDT · the look at Brandwatch mentions and 5 more has failed since Oct 14, 10:04 AM: ' +
      'BigQuery HTTP 403: Access Denied: Proj… · today: 1,234,567 flagged, 2,345,678 near misses');
    const bigger = text({ us: { since, why: WHY } }, { today: { flagged: 1e15, near: 1e15 } });
    eq(bigger, 'the look at Brandwatch mentions and 5 more has failed since Oct 14, 10:04 AM: BigQuery HTTP 403: Access Denied: ' +
      'Project brand… · today: 1,000,000,000,000,000 flagged, 1,000,000,000,000,000 near misses');
    eq([big.length, bigger.length], [200, 200]);
    // a short reason stays whole; the sources follow the counts only when they fit whole
    eq(text({ c1: { since, why: 'BigQuery took more than 4 minutes' } }),
      `${LOOKED} · the look at Sonar and Tubular has failed since Oct 14, 10:04 AM: BigQuery took more than 4 minutes${COUNTS}`);
    const first = B.pwNoteText_({ flagged: 0, near: 1 }, null, '', 'sources: 6 waiting, 2 failing: Sonar, Tubular',
      { c1: { since, why: 'unknown' } });
    eq(first, 'first look on its way · the look at Sonar and Tubular has failed since Oct 14, 10:04 AM: unknown · today: 0 flagged, ' +
      '1 near miss · sources: 6 waiting, 2 failing: Sonar, Tubular (Watch sources tab)');
    assert.ok(first.length <= 200, String(first.length));
    // every look failing: one sentence, from when the later of them began to fail and with its reason; no last look
    const all = { c1: { since, why: 'BigQuery HTTP 500: Backend error' }, us: { since: since + MIN, why: WHY } };
    const both = text(all, { last: { at: 0, checked: 0, flagged: 0 }, label: '' });
    eq(both, 'the looks at all 8 sources have failed since Oct 14, 10:05 AM: BigQuery HTTP 403: Access Denied: Project ' +
      `brand-social-central-data: User does not have bigquery.j…${COUNTS}`);
    eq(both.length, 200);
    all.us.since = since;  // both from the same minute: the first job's reason
    eq(text(all, { last: { at: 0, checked: 0, flagged: 0 }, label: '', sources: 'sources: 8 failing' }),
      `the looks at all 8 sources have failed since Oct 14, 10:04 AM: BigQuery HTTP 500: Backend error${COUNTS} · sources: 8 failing ` +
      '(Watch sources tab)');
  });

  test('watch notes: every look failing (BigQuery refuses both jobs when they are sent, from the first look on): C34 says "the looks at all 8 sources have failed since <time>: <why>" and every row of the Watch sources tab says failing; what is kept of it (the script property PW_LAST) stays small whatever the error is (160 characters of a job\'s reason: far under the 9 KB a property holds); one job succeeding leaves the other\'s failure standing; with the last watch turned OFF nothing is looked at and the failure is forgotten', () => {
    const w = oneSpace();
    const { t } = w;
    const MSG = 'Access Denied: Project brand-social-central-data: User does not have bigquery.jobs.create permission';
    w.refuse = () => ({ code: 403, message: MSG });
    t.poll();  // the first looks: both refused
    const TODAY = ' · today: 0 flagged, 0 near misses';
    eq(noteOf(t), 'the looks at all 8 sources have failed since Oct 14, 8:02 AM: BigQuery HTTP 403: Access Denied: Project ' +
      `brand-social-central-data: User does not have bigquery.jobs.c…${TODAY}`);
    assert.ok(noteOf(t).length === 200 && c34(t).endsWith(` · ${noteOf(t)}`), c34(t));
    const failing = names => `⚠️ failing: the look at ${names} has failed since 2026-10-14 08:02 ET: BigQuery HTTP 403: ${MSG} ` +
      '(tried again at the next look)';
    eq(Object.values(statuses(t)), Array(2).fill(failing('Sonar and Tubular')).concat(Array(6).fill(failing('Brandwatch mentions and 5 more'))));
    const failedAt = t.g.clock.now;
    const fail = { fail: { since: failedAt, why: `BigQuery HTTP 403: ${MSG}` } };
    eq(JSON.parse(t.g.props.get('PW_LAST')), { at: 0, checked: 0, flagged: 0, near: 0, lanes: { c1: fail, us: fail } });
    // the worst an error can be: long, and every character one that JSON writes as six (\u0001)
    w.refuse = () => ({ code: 403, message: '\u0001'.repeat(2000) });
    t.g.clock.now += 4 * MIN;
    t.poll();
    const kept = t.g.props.get('PW_LAST');
    const lanes = JSON.parse(kept).lanes;
    eq([lanes.us.fail.why.length, lanes.c1.fail.why, lanes.c1.fail.since, lanes.us.fail.since], [160, lanes.us.fail.why, failedAt, failedAt]);
    assert.ok(kept.length <= 8800 && kept.length < 2000, `${kept.length} characters`);
    assert.ok(noteOf(t).length <= 200 && noteOf(t).endsWith(TODAY), noteOf(t));
    // the US job is no longer refused: its look is collected, and C34 keeps saying that the other one fails
    w.refuse = location => (location === C1 ? { code: 403, message: MSG } : null);
    w.answers = { [US]: { rows: srcs(US_SOURCES) } };
    t.g.clock.now += 4 * MIN;
    t.poll();
    t.poll();
    eq(noteOf(t), 'last look Oct 14, 8:13 AM EDT: 0 new posts, 0 flagged · the look at Sonar and Tubular has failed since Oct 14, 8:02 AM: ' +
      `BigQuery HTTP 403: Access Denied: Project bra…${TODAY}`);
    eq(noteOf(t).length, 200);
    eq(Object.values(statuses(t)), Array(2).fill(failing('Sonar and Tubular')).concat(Array(6).fill('✓ live: nothing new at the last look')));
    // no watch ON: nothing is looked at, and the failure is forgotten with the last looks
    w.watch(BRAND, false);
    t.poll();
    eq([noteOf(t), t.g.props.get('PW_LAST')], ['waiting: no watch is ON (set a watch\'s On to ON on the Watches tab)', undefined]);
    eq(Object.values(statuses(t)).slice(0, 2), Array(2).fill('... waiting for its first look'));
  });

  // -----------------------------------------------------------------------------------------------------------
  // The log: one line for each flag that ends without a card
  // -----------------------------------------------------------------------------------------------------------

  test('watch notes: a flag dropped after waiting 3 hours leaves one log line, once, with its link, since when it waited and why flags were waiting: the reason of the last run that left flags waiting, kept in the script cache (also when this run has another reason), else, with that value gone, this run\'s own reason, else that none was kept (a reason from before the flag was seen is not its reason); nothing is posted for any of them', () => {
    const TO_OTHER = 'Other alerts space (B33)';
    const B33_BLANK = 'the Other alerts space (B33) is blank or can\'t be used this run (see C33)';
    const B9_BLANK = 'the Mirror space (B9) isn\'t working this run (see C9)';
    const w = oneSpace({ b35: TO_OTHER });  // B33 is blank: the flags wait
    const { t } = w;
    const kept = () => JSON.parse(t.g.cache.get('pw_alert_wait') || 'null');
    const seen = n => keysOf(t)[`${P(n)}|${BRAND}`].s;
    const dropped = () => t.g.logs.filter(l => /^Watch alerts: dropped /.test(l));
    // three flags, each from a look of its own, so each has waited 3 hours at another minute
    [1, 2, 3].forEach(n => look(w, [flag(n)]));
    eq([1, 2, 3].map(n => letter(t, n)), ['q', 'q', 'q']);
    assert.ok(seen(1) < seen(2) && seen(2) < seen(3), 'seen one after the other');
    assert.match(c35(t), /^⚠️ waiting: the Other alerts space \(B33\) is blank or can't be used this run \(see C33\) \(a flag waits up to 3 hours\) · today: 0 posted, 3 waiting$/);
    eq(kept(), { at: t.g.clock.now, why: B33_BLANK });
    assert.ok(t.g.cache.get('pw_alert_wait').length < 400, 'a small cache value');
    /** The run in which flag `n` has waited just over 3 hours (`before`: what happens right before it). */
    const dropRun = (n, before) => {
      t.g.clock.now = seen(n) + 3 * HOUR;  // the run itself is a minute later
      if (before) before();
      t.poll();
    };
    const line = (n, why) => `Watch alerts: dropped ${P(n)}: not posted within 3 hours of being seen (${B.pwTime_(seen(n))} ET)${why}`;
    // 1. the kept reason, though this run would have another one (B35 now points at the Mirror space, B9 blank)
    dropRun(1, () => w.sh.getRange(35, 2).setValue('Mirror space (B9)'));
    eq([[1, 2, 3].map(n => letter(t, n)), dropped()], [['x', 'q', 'q'], [line(1, `: ${B33_BLANK}`)]]);
    eq(kept().why, B9_BLANK);  // what this run kept for the two still waiting
    // 2. the kept value is gone (the cache keeps nothing for sure): this run's own reason
    dropRun(2, () => t.g.cache.delete('pw_alert_wait'));
    eq([[1, 2, 3].map(n => letter(t, n)), dropped().slice(1)], [['x', 'x', 'q'], [line(2, `: ${B9_BLANK}`)]]);
    // 3. no reason this run (B35 back to the Auto-correct space), and what is kept is from before the flag was seen
    dropRun(3, () => {
      w.sh.getRange(35, 2).setValue(TO_AC);
      t.g.cache.set('pw_alert_wait', JSON.stringify({ at: seen(3) - MIN, why: 'a reason from before it was seen' }));
    });
    eq([[1, 2, 3].map(n => letter(t, n)), dropped().slice(2)], [['x', 'x', 'x'], [line(3, '; why it waited was not kept')]]);
    // once each: later runs add no line; C35 counts the three; nothing was posted
    for (let i = 0; i < 3; i++) t.poll();
    eq(dropped().length, 3);
    counts(t, { dropped: 3 });
    eq(cards(t), []);
  });

  test('watch notes: which alert a post already had, as the log words it: the Watch alert by the watch that posted it and its message, a Watch alert whose thread lists the post, Burson\'s alert and when; the same for the posts of its thread; the first one found for a post stays', () => {
    const k = n => B.recordKey_({ post_url: P(n) });
    const row = (n, key, bursonAt) => {
      const r = new Array(19).fill('');
      r[5] = P(n);
      r[15] = bursonAt || '';
      r[18] = JSON.stringify(Object.assign({ k: k(n), w: BRAND, s: 1, b: 1 }, key));
      return r;
    };
    const CARD = 'spaces/AAQAx/messages/m1';
    const state = B.pwAlertedState_(null, { first: 14, values: [
      row(1, { a: 'p', m: CARD, th: ['2160000000000000777'] }),
      row(2, { a: 'g', pm: CARD }),
      row(3, { a: 'q' }, '2026-10-14 08:43'),
      row(4, { a: 'q' }),
      row(1, { a: 'g', pm: 'spaces/AAQAx/messages/m9', w: MIDTERMS }),
    ] }, 'autocorrect');
    const POSTED = `the Watch alert of "${BRAND}" (${CARD})`;
    eq([1, 2, 3, 4].map(n => state.done.get(k(n))),
      [POSTED, `a Watch alert (${CARD}) whose thread lists it`, 'Burson\'s alert (2026-10-14 08:43 ET)', undefined]);
    eq([state.doneThreadIds.get('2160000000000000777'), state.doneThreadIds.get(P(1).split('/').pop()), state.doneThreadIds.get(P(4).split('/').pop())],
      [POSTED, POSTED, undefined]);
    eq([B.pwAlertWords_({ a: 'p', w: BRAND }), B.pwAlertWords_({ a: 'g' })],
      [`the Watch alert of "${BRAND}"`, 'a Watch alert whose thread lists it']);
  });

  test('watch notes: when more flags wait than a run posts (5 at once, 2 a run in the Auto-correct space), what is kept as the reason they waited says so, and no flag is dropped or logged as not posted', () => {
    const w = oneSpace();
    const { t } = w;
    look(w, [1, 2, 3, 4, 5].map(n => flag(n, { impact: 9.5 - n / 10 })));
    const kept = JSON.parse(t.g.cache.get('pw_alert_wait'));
    eq([cards(t).length, kept.why], [2, 'more flags were waiting than one run reads and posts']);
    assert.ok(kept.at <= t.g.clock.now && kept.at > t.g.clock.now - MIN, 'kept in that run');
    t.poll();
    t.poll();
    eq([cards(t).length, t.g.logs.filter(l => /^Watch alerts: (?:not posting|dropped) /.test(l))], [5, []]);
  });
};
