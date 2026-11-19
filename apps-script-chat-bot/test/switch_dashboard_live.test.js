// The live dashboard's data (DashboardData.gs; Control row 54, Live dashboard; SPEC section 3): dashSnapshot,
// dashDetail and dashWhyNot read what the bot keeps, read-only, and say plainly what it does not keep; the story card's
// posts in time order are kept with the card only while row 54 is ON (EarlyDetection.gs edSnapPosts_, SPEC 3.6).
//
// The data comes from the bot's own flows: the one-space setup of the golden flows (golden_flows.js oneSpaceWorld) runs
// Burson's alert with mistakes (corrected, its Social Alert sent), Direct BigQuery cards (one without a Social Alert,
// one whose Social Alert waits: B30 blank), a Watch alert whose T&S form the bot submits (row 12 ON), a small Watch flag
// held to be grouped, Early Detection stories carded and one held back as noise by the fast triage, then six hours of
// the real Early Detection producer (EarlyWaveSource.gs) on posts the test hands its BigQuery lanes: a story carded from
// its cache, and a copy-paste ring that surges in its last hour and never reaches the bar. Row 54 is turned ON by
// overriding readSwitches_, as other tests do; the viewer is let in by stubbing dashAccess_. Every post and account is
// made up; every address ends in .test.
'use strict';

module.exports = H => {
  const { test, eq, assert, F, REAL } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const ZAPIER = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const VIEWER = 'viewer@team.test';
  const SMALL = 'https://x.com/smallvoice/status/2150000000000000041';
  const NOISE = 'https://x.com/dinofan/status/2150000000000000051';
  const EWS_COLS = [['kind'], ['lane'], ['mid'], ['url'], ['platform'], ['author'], ['audience', 'INTEGER'], ['eng', 'INTEGER'],
    ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'], ['txt'], ['topic'], ['chash'], ['sig'], ['risk'], ['brand', 'BOOLEAN']];
  const EMOJI = /\p{Extended_Pictographic}/u;

  /**
   * The one-space world, before its first run, with row 54 ON (a flag the test can turn OFF: bot.__dashOn), the viewer let
   * in, and the producer's two BigQuery lanes answered from `posts` (each post handed over once, by the first check
   * after it was seen).
   */
  function world(on) {
    const golden = require('./golden_flows')(H);
    const w = golden.world.oneSpaceWorld();
    const { t } = w;
    t.bot.ev(`var __dashOn = ${on !== false}; readSwitches_ = (read => sh => Object.assign(read(sh), { liveDashboard: __dashOn }))(readSwitches_)`);
    t.bot.ev(`dashAccess_ = () => ({ ok: true, email: "${VIEWER}", self: false, why: '' })`);
    const posts = [];
    let served = 0;
    const prev = t.g.services.UrlFetchApp.fetch;
    const decisions = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'decisions_fixtures.json'), 'utf8'))
      .signal_responses['ED-CLU-CLU-e9dddc0be913-202611071746'];
    const noise = JSON.parse(JSON.stringify(decisions));
    Object.assign(noise.answers.routine_noise, { value: true, noul: 0.95, confidence: 0.95, true_probability: 0.95, false_probability: 0.05 });
    Object.assign(noise.answers.severity, { score: 1, most_likely_level: 1, confidence: 0.7, probabilities: { 0: 0.1, 1: 0.7, 2: 0.1, 3: 0.05, 4: 0.05 } });
    t.g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      // Gemini Decisions: the dinosaur story is routine noise (the fast triage holds it back, row 40)
      if (url.includes('/decisions') && /dinofan|dinosaur/.test(String((params && params.payload) || ''))) {
        return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(noise) };
      }
      if (url.startsWith('https://bigquery.googleapis.com/') && String((params && params.method) || '').toLowerCase() === 'post' && /\/queries$/.test(url)) {
        const body = JSON.parse(params.payload);
        const lane = (String(body.query || '').match(/^-- ews:(us|c1)\b/) || [])[1];
        if (lane) {
          const now = t.g.clock.now;
          const rows = lane === 'c1' ? posts.filter(p => p.seen_ms > served && p.seen_ms <= now) : [];
          if (lane === 'c1') served = now;
          const resp = { jobComplete: true, jobReference: { projectId: 'brand-social-central-data', jobId: `ews_${now}_${lane}`, location: body.location },
            schema: { fields: EWS_COLS.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
            rows: rows.map(r => ({ f: EWS_COLS.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })) };
          return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(resp) };
        }
      }
      return prev(link, params);
    };
    // Gemini's review of the Photos story (the scripted answer otherwise tells the Chrome one): rated high
    const ed = t.g.vertex.earlyDetection;
    t.g.vertex.earlyDetection = payload => {
      const text = payload.contents[0].parts.map(p => p.text || '').join('\n');
      if (!/Google Photos/.test(text)) return ed(payload);
      const out = ed(payload);
      return Object.assign(out, { issue_name: 'Google Photos backups wiped after a storage plan change',
        story_title: 'Photos users say backups were wiped after a storage plan change', summary: 'Small accounts say Google Photos wiped their backups.',
        early_detection_call: Object.assign({}, out.early_detection_call, { severity: 'high', reason: 'Several users describe losing years of photos' }) });
    };
    return Object.assign({ golden, posts }, w);
  }

  /** A post on the producer's real-time lane, seen at `at` (posted a minute before). */
  function lanePost(i, at, o) {
    return Object.assign({ kind: 'post', lane: 'sonar', mid: `SONAR|M-${i}`, url: `https://x.com/user${i}/status/21600000000000${String(i).padStart(5, '0')}`,
      platform: 'twitter', author: `user${i}`, audience: 300, eng: 10 + i, posted_ms: at - MIN, seen_ms: at,
      txt: `Post ${i}`, topic: 'Other', chash: `h_${i}`, sig: `sig_${i}`, risk: '', brand: false }, o || {});
  }

  /**
   * The whole timeline (see the header): {t, sh, golden, rec, ...}. The runs end 20 minutes into a clock hour, with the
   * ring's 7 accounts all in the hour before.
   */
  function run(opts) {
    const o = opts || {};
    const x = world(o.on);
    const { golden, t, sh, feed, rec, posts } = x;
    sh.getRange(12, 2).setValue('ON');  // Auto-submit T&S form
    rec.collect('setup');
    rec.step('01 first run: the watch tabs are made', 1);
    golden.world.watchOn(t);
    sh.getRange(35, 2).setValue('Auto-correct space (B10)');
    rec.step('02 quiet run', 1);
    rec.step('03 Burson alert with mistakes', 1, () => { t.chat.say(REAL, F.MISTAKES, ZAPIER); });
    rec.step('04 Direct BigQuery finds the Pixel post', 3, () => { feed.bsip = [golden.rows.bsipRow()]; });
    rec.step('05 the Pixel card is reviewed', 1);
    rec.step('06 the watch flags the Gemini post, and a small post', 1, () => {
      feed.look = [golden.rows.hit(), golden.rows.hit({ post_url: SMALL, author: '@smallvoice', followers: 150, eng: 12,
        issue: 'Gemini app will not summarize a long PDF', topic: 'AI answers and Gemini',
        summary: 'An X user (@smallvoice, 150 followers) says the Gemini app will not summarize a long PDF.' })];
    });
    rec.step('07 the watch alert is triaged', 1, () => { feed.look = []; });
    rec.step('08 quiet run', 2);
    rec.step('09 Maps (its Social Alert waits: B30 is blank) and a story', 5, () => {
      t.set('B30', '');
      feed.bsip = [golden.rows.bsipRow(), golden.rows.mapsRow()];
      feed.stories = [golden.rows.story()];
    });
    rec.step('10 the Maps card is reviewed', 1, () => { feed.look = [golden.rows.mapsHit()]; });
    rec.step('11 quiet run', 1, () => { feed.look = []; });
    rec.step('12 the Pixel story, and a story of routine noise', 14, () => {
      feed.stories = [golden.rows.story(), golden.rows.pixelStory(), golden.rows.story({ alert_id: 'ED-CLU-clu_dino-202610141245',
        cluster_id: 'clu_dino', signal_key: 'clu_dino', headline: 'Low-tier claim cluster (5 accounts): my dinosaur game high score in Chrome',
        primary_url: NOISE, risk_groups: '', topic_product: 'Chrome', representative_posts_json: JSON.stringify([
          { platform: 'X', author_handle: 'dinofan', followers: 120, engagement_total: 4, published_at: '2026-10-14 12:40 UTC', url: NOISE,
            snippet: 'New high score on the Chrome dinosaur game while the wifi was out, 4000 points.' },
          { platform: 'X', author_handle: 'dinofan2', followers: 90, engagement_total: 2, published_at: '2026-10-14 12:41 UTC',
            url: 'https://x.com/dinofan2/status/2150000000000000052', snippet: 'Beat my dinosaur game score today, 3500.' }]) })];
    });
    rec.step('13 quiet run', 1);
    // the producer, for real: the golden stories still come from the feed (repeats now), the rest from its own lanes
    t.bot.bqEarlyDetectionRows_ = (m, op) => feed.stories.map(r => JSON.parse(JSON.stringify(r))).concat(t.bot.ewsRows_(m, op));
    const start = t.g.clock.now;
    // the Photos story: 6 small accounts, at once (carded at the first check)
    for (let i = 1; i <= 6; i++) {
      posts.push(lanePost(i, start + 5 * MIN + i * MIN, { url: i % 2 ? `https://x.com/photos${i}/status/216000000000000000${i}`
        : `https://www.reddit.com/r/googlephotos/comments/1ph${i}/backup_wiped/`, platform: i % 2 ? 'twitter' : 'reddit', author: `photos${i}`,
      txt: `Google Photos wiped my photos from the backup after the storage plan change, years of pictures gone, support says nothing ${i}`,
      topic: 'Google Photos', risk: 'outage_broken_feature', brand: true }));
    }
    const stopAt = (Math.floor(start / HOUR) + 6) * HOUR + 20 * MIN;
    const lastHour = Math.floor(stopAt / HOUR) - 1;
    // a story of two accounts three hours before the end
    for (let i = 20; i < 22; i++) {
      posts.push(lanePost(i, (lastHour - 2) * HOUR + (10 + i) * MIN, { author: `nestuser${i}`, url: `https://x.com/nestuser${i}/status/21700000000000000${i}`,
        txt: `Nest thermostat went offline overnight and the house is freezing, the app cannot reach it at all ${i}`, topic: 'Nest' }));
    }
    // the ring: 7 accounts with the same words, none naming Google, all in the last full hour
    for (let i = 40; i < 47; i++) {
      posts.push(lanePost(i, lastHour * HOUR + (5 + 5 * (i - 40)) * MIN, { author: `ringuser${i}`, url: `https://x.com/ringuser${i}/status/21800000000000000${i}`,
        txt: 'My phone dialer screen freezes completely right after installing the overnight update patch, cannot call anyone at all',
        topic: 'Phones', chash: 'ring_same_text', risk: 'outage_broken_feature' }));
    }
    let n = 0;
    while (t.g.clock.now + 15 * MIN <= stopAt) rec.step(`p${n++}`, 15);
    return Object.assign(x, { lastHour });
  }

  let shared = null;
  /** The ON timeline, built once for the tests that only read it. */
  const on = () => (shared || (shared = run()));

  /** Everything the bot keeps that a dash* call must not change: every tab's cells, every property, the cache but its own keys. */
  function kept(t) {
    const ss = t.sheet();
    return JSON.stringify({
      tabs: ss.getSheets().map(s => [s.getName(), s.rows]),
      props: Array.from(t.g.props.entries()).sort(),
      cache: Array.from(t.g.cache.entries()).filter(([k]) => k.indexOf('dash1:') !== 0).sort(),
    });
  }

  // -------------------------------------------------------------------------------------------------------------

  test('dashboard live: with row 54 OFF every dash* call answers that the live dashboard is OFF, and a viewer the sheet is not shared with is refused first', () => {
    const x = on();
    const b = x.t.bot;
    b.__dashOn = false;
    try {
      const why = 'The live dashboard is OFF on the Control tab (row 54). Turn it ON there to see the bot\'s work here.';
      eq(b.dashSnapshot(), { ok: false, off: true, why });
      eq(b.dashDetail('alert', 'QA-1001'), { ok: false, off: true, why });
      eq(b.dashWhyNot('https://x.com/a/status/1'), { ok: false, off: true, why });
      const access = b.dashAccess_;
      b.dashAccess_ = () => ({ ok: false, email: 'someone@else.test', self: false, why: 'The sheet is not shared with you.' });
      eq(b.dashSnapshot(), { ok: false, denied: true, why: 'The sheet is not shared with you.' });
      b.dashAccess_ = access;
    } finally {
      b.__dashOn = true;
    }
  });

  test('dashboard live: the snapshot has every part and shape of SPEC 3.1, under 400 KB, with no emoji and no email address in it', () => {
    const x = on();
    const s = x.t.bot.dashSnapshot({ refresh: true });
    const keys = o => Object.keys(o).sort();
    eq(s.ok, true);
    ['asOf', 'build', 'switches', 'mode', 'health', 'now', 'clusters', 'alerts', 'pressure', 'pipeline', 'early', 'held', 'questions']
      .forEach(k => assert.ok(k in s, k));
    eq([s.asOf, s.servedAt, keys(s.build), s.mode], [x.t.g.clock.now, x.t.g.clock.now, ['accountWhy', 'behind', 'bot', 'sameAccount', 'url', 'web'], 'testing']);
    eq([s.build.sameAccount, s.build.accountWhy], [true, '']);  // the web app runs as the account in Control B8
    // every answer the page shows times from carries the bot's clock (the page never counts "ago" from the device's)
    eq([x.t.bot.dashDetail('alert', s.alerts[0].id).servedAt, x.t.bot.dashWhyNot('https://x.com/nobody/status/1').servedAt], [x.t.g.clock.now, x.t.g.clock.now]);
    assert.ok(Object.keys(s.switches).length >= 29 && Object.values(s.switches).every(v => typeof v === 'boolean'));
    eq([s.switches.liveDashboard, s.switches.earlyWave, s.switches.openEngine], [true, true, false]);
    // health
    eq(keys(s.health), ['cannotSee', 'fix', 'headline', 'lastRunAt', 'level', 'sources', 'status', 'why']);
    eq([s.health.level, s.health.status], ['ok', 'Working']);
    eq(s.health.sources.map(x2 => [x2.key, x2.state]), [['run', 'fresh'], ['alertLog', 'fresh'], ['earlyWave', 'fresh'], ['producer', 'fresh'], ['watch', 'fresh'],
      ['directBq', 'fresh']]);
    s.health.sources.forEach(x2 => eq(keys(x2), ['at', 'key', 'label', 'note', 'state']));
    s.health.cannotSee.forEach(c => eq([keys(c), typeof c.what, typeof c.why, typeof c.fix], [['fix', 'what', 'why'], 'string', 'string', 'string']));
    // now and its items
    eq(keys(s.now), ['counts', 'first', 'headline', 'level', 'then']);
    eq([s.now.first.length, s.now.then.length <= 5], [3, true]);
    s.now.first.concat(s.now.then).forEach(it => {
      eq([keys(it), keys(it.action)], [['action', 'id', 'kind', 'level', 'title', 'why'], ['detail', 'filter', 'text', 'view']]);
      assert.ok(['alert', 'cluster', 'health', 'stuck'].includes(it.kind) && ['critical', 'high', 'medium', 'low', 'unknown'].includes(it.level), JSON.stringify(it));
    });
    // a cluster, an alert
    const cl = s.clusters[0];
    ['id', 'label', 'topic', 'platforms', 'accounts', 'posts', 'engagement', 'firstAt', 'lastAt', 'perHour', 'lastHour', 'prevHours', 'speed',
      'level', 'levelWhy', 'risk', 'atBar', 'carded', 'importance', 'mark', 'status'].forEach(k => assert.ok(k in cl, k));
    s.clusters.forEach(c => {
      eq([c.perHour.length, Array.isArray(c.levelWhy), Array.isArray(c.risk)], [24, true, true]);
      assert.ok(['surging', 'rising', 'steady', 'slowing', 'unknown'].includes(c.speed) && ['forming', 'at the bar', 'carded', 'held'].includes(c.status));
      assert.ok(c.level !== 'critical');  // never critical before a review
    });
    const al = s.alerts[0];
    ['id', 'kind', 'flow', 'createdAt', 'issue', 'product', 'platform', 'author', 'engagement', 'tag', 'topics', 'level', 'levelWhy', 'status', 'owner',
      'action', 'email', 'tns', 'corrections', 'decision', 'postUrl', 'chatLink'].forEach(k => assert.ok(k in al, k));
    s.alerts.forEach(a => {
      eq([keys(a.status), keys(a.owner), keys(a.action), keys(a.email), keys(a.tns)],
        [['derived', 'key', 'label'], ['derived', 'who', 'why'], ['text'], ['sentAt', 'status'], ['submitted']]);
      assert.ok(['burson', 'watch', 'direct', 'story', 'update', 'early', 'other', 'sheet'].includes(a.kind), a.kind);
      assert.ok(/^https:\/\/chat\.google\.com\/room\//.test(a.chatLink), a.chatLink);
    });
    eq(s.alerts.map(a => a.id), ['QA-1007', 'QA-1006', 'QA-1005', 'QA-1004', 'QA-1003', 'QA-1002', 'QA-1001']);  // newest first
    eq(s.questions.map(q => q.id), ['keeping-up', 'needs-me', 'fastest', 'stuck', 'held', 'beat-burson', 'corrections', 'why-not']);
    s.questions.forEach(q => eq(keys(q), ['answer', 'filter', 'id', 'text', 'view']));
    const json = JSON.stringify(s);
    assert.ok(json.length < 400000, String(json.length));
    assert.ok(!EMOJI.test(json), json.match(new RegExp(EMOJI.source, 'u')));
    assert.ok(!/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(json), 'an email address in the snapshot');
    console.log(`    (snapshot: ${json.length} characters)`);
  });

  test('dashboard live: seriousness, status, owner and action of each kind of alert, worked out from its row (SPEC 3.2, 3.3)', () => {
    const x = on();
    const b = x.t.bot;
    const s = b.dashSnapshot({ refresh: true });
    const by = id => s.alerts.find(a => a.id === id);
    const pick = a => [a.kind, a.level, a.levelWhy, a.status.key, a.owner.who, a.action.text];
    eq(pick(by('QA-1001')), ['burson', 'critical', 'P0 exposure tag (Product - Perceived bias)', 'sent', 'the teams emailed: GCPA (gcpa), pa',
      // Track post-alert outcomes (row 21) is OFF in this world: the bot reads no replies, and says so (never "wait for it")
      'The bot does not read replies while Track post-alert outcomes (row 21) is OFF: check the email thread in Gmail.']);
    eq([by('QA-1001').corrections, by('QA-1001').email.status, by('QA-1001').flow], [4, 'sent', 'auto-correct']);
    eq(pick(by('QA-1002')), ['direct', 'low', 'No action: P2, 800 engagements: below the escalation criteria', 'no-action', 'nobody',
      'Nothing to do: P2, 800 engagements: below the escalation criteria.']);
    eq(pick(by('QA-1003')), ['watch', 'medium', 'A T&S form, no Social Alert', 'tns', 'Trust & Safety',
      'Check that the T&S submission went through (its confirmation email).']);
    eq([by('QA-1003').tns.submitted, by('QA-1003').decision], [true, 'Worth a look + T&S (Gemini hallucination) · auto-submitted']);
    // "Monitor build-up" hands the story to the IMs on shift to watch (never "nobody" and "nothing to do")
    eq(pick(by('QA-1004')), ['story', 'medium', 'The story\'s review rated it medium', 'done', 'the IMs on shift',
      'Watch the story; open it again if it grows (Monitor build-up: Several independent users describe the same data loss after one update).']);
    eq(pick(by('QA-1005')), ['direct', 'critical', 'P0 exposure tag (Product - Perceived bias)', 'draft-waiting', 'the IM on shift',
      'Not sent yet: Testing: enter an email address in Control!B30 (Testing: send to) to receive test emails']);
    eq([by('QA-1007').level, by('QA-1007').levelWhy], ['high', 'The story\'s review rated it high']);
    // the states the one-space flow doesn't reach, on the same rows as they would be kept
    const row = id => JSON.parse(JSON.stringify(b.dlAlertRows_(x.t.sheet(), 3000).rows.find(r => r.alert_id === id)));
    const of = r => b.dlAlertOf_(r, x.t.g.clock.now).a;
    const main = Object.assign(row('QA-1001'), { space: 'spaces/AAQAtestfd1 > spaces/AAQAaLn375E', email_status: '', email_input: {} });
    eq([of(main).status.key, of(main).owner.who, of(main).action.text], ['fix-asked', 'Burson',
      'Wait for Burson\'s corrected alert; if none comes within an hour, ask Burson in the alert\'s thread.']);
    eq(of(Object.assign(row('QA-1001'), { status: 'superseded' })).status.key, 'superseded');
    const failed = of(Object.assign(row('QA-1005'), { email_status: 'failed', email_error: 'Gmail refused the message' }));
    eq([failed.status.key, failed.owner.who, failed.action.text, failed.level], ['failed', 'the IM on shift',
      'Send the Social Alert by hand: the bot gave up (Gmail refused the message).', 'critical']);
    eq(of(Object.assign(row('QA-1005'), { email_status: 'drafted', email_error: '' })).action.text, 'Open the draft in Gmail and send it, or discard it.');
    const fresh = of(Object.assign(row('QA-1002'), { decision: '', mirrored: '' }));
    eq([fresh.status.key, fresh.owner.who, fresh.action.text, fresh.level, fresh.levelWhy], ['needs-review', 'the bot',
      'Nothing to do yet: the bot reviews it on its next run.', 'medium', 'P2 exposure tag (Product - Other/general criticism) kept for review']);
    const urgent = row('QA-1003');
    urgent.email_input = Object.assign({}, urgent.email_input, { escalation: { track: 'URGENT', priority: 'P1' } });
    eq([of(urgent).level, of(urgent).levelWhy], ['critical', 'Escalated on the urgent track']);
    eq(of(Object.assign(row('QA-1002'), { mirrored: '\u{1F9D1}\u200D\u{1F4BB}' })).levelWhy, 'A leadership case: the leads were told');
    eq(of(Object.assign(row('QA-1003'), { decision: '', tns_submitted: '', email_input: {}, email_groups: '',
      forwarded_fields: Object.assign(row('QA-1003').forwarded_fields, { triage: {} }) })).levelWhy,
      'P1 exposure tag (Product - Factual inaccuracies (not dangerous/offensive)) kept for review');
    const card = row('QA-1004');
    card.forwarded_fields.early_detection.severity = '';
    eq([of(card).level, of(card).levelWhy], ['low', 'The story\'s review gave it no severity (counted as low)']);
  });

  test('dashboard live: now (SPEC 3.4): what needs a person first, then the stories forming, then the rest; never calm when the last run or a source is late or missing, the reason first', () => {
    const x = on();
    const { t } = x;
    const b = t.bot;
    let s = b.dashSnapshot({ refresh: true });
    eq([s.now.level, s.now.counts.needAction, s.now.counts.stuck], ['critical', 1, 1]);
    eq(s.now.first.map(i => [i.kind, i.id, i.level]), [['alert', 'QA-1005', 'critical'], ['cluster', s.clusters.find(c => c.mark === 1).id, 'medium'],
      ['cluster', s.clusters.find(c => c.mark === 2).id, 'low']]);
    eq(s.now.first[0].why, 'Its Social Alert has waited 6 hours to go out');
    eq(s.now.headline, '1 item needs a person now. Most serious: Maps routing onto a closed bridge (critical: Its Social Alert has waited 6 hours to go out).');
    eq(s.now.then.map(i => i.id), ['QA-1001', 'QA-1007', 'QA-1006', 'QA-1004', 'QA-1003']);  // by level, then the newest
    const clock = t.g.clock.now;
    const check = (label, change, undo, headline, level) => {
      change();
      try {
        s = b.dashSnapshot({ refresh: true });
        eq([s.now.level, s.health.level, s.now.headline, s.now.first[0].kind, s.now.first[0].level], ['unknown', level, headline, 'health', 'unknown'], label);
        assert.ok(s.now.first[0].action.text.length > 10, label);
      } finally {
        undo();
      }
    };
    check('7 minutes', () => { t.g.clock.now = clock + 7 * MIN; }, () => { t.g.clock.now = clock; },
      'Can\'t be sure: the bot last ran 7 minutes ago (it runs every minute)', 'late');
    check('25 minutes', () => { t.g.clock.now = clock + 25 * MIN; }, () => { t.g.clock.now = clock; },
      'Can\'t be sure: the bot last ran 25 minutes ago (it runs every minute, so it has stopped)', 'stopped');
    // the main flow's run record (LAST_RUN) counts too: Control B6 blank, the record old, then fresh
    const b6 = t.get('B6');
    check('an old run record and no B6', () => { t.set('B6', ''); t.g.props.set('LAST_RUN', JSON.stringify({ at: new Date(clock - 40 * MIN).toISOString() })); },
      () => { t.set('B6', b6); t.g.props.delete('LAST_RUN'); }, 'Can\'t be sure: the bot last ran 40 minutes ago (it runs every minute, so it has stopped)', 'stopped');
    t.set('B6', '');
    t.g.props.set('LAST_RUN', JSON.stringify({ at: new Date(clock - 2 * MIN).toISOString() }));
    try { eq(b.dashSnapshot({ refresh: true }).now.level, 'critical'); } finally { t.set('B6', b6); t.g.props.delete('LAST_RUN'); }
    check('no run recorded', () => { t.set('B6', ''); }, () => { t.set('B6', b6); },
      'Can\'t be sure: the bot\'s last run is not recorded (Control B6 and its run record are blank or unreadable)', 'unknown');
    const b5 = t.get('B5');
    check('a problem in B5', () => { t.set('B5', '\u26A0\uFE0F Something needs another try: Chat answered 500.'); }, () => { t.set('B5', b5); },
      'Can\'t be sure: the bot reports a problem: Something needs another try: Chat answered 500.', 'late');
    check('paused', () => { t.set('B5', '\u23F8 Paused: Bot is OFF. Set it to ON to restart.'); }, () => { t.set('B5', b5); },
      'Can\'t be sure: the bot is paused (Control B2 is OFF), so nothing new is reviewed', 'stopped');
    const edAt = t.g.props.get('EARLY_DETECTION_AT');
    check('a late source', () => { t.g.props.set('EARLY_DETECTION_AT', String(clock - 45 * MIN)); }, () => { t.g.props.set('EARLY_DETECTION_AT', edAt); },
      'Can\'t be sure: Early Detection checks (row 19, every 15 minutes): Last ran 45 minutes ago', 'late');
    const st = t.g.props.get('EWS_STATE');
    check('a missing source', () => { t.g.props.delete('EWS_STATE'); }, () => { t.g.props.set('EWS_STATE', st); },
      'Can\'t be sure: Stories forming (the Early Detection producer\'s cache): no record of it running', 'late');
    // the Alert log, when its first row is not the bot's header: not read, and never calm
    const log = t.sheet().getSheetByName('Alert log');
    check('the Alert log not the bot\'s', () => { log.getRange(1, 1).setValue('Alert id'); }, () => { log.getRange(1, 1).setValue('alert_id'); },
      'Can\'t be sure: The Alert log (the bot\'s record of every alert): Its first row is not the bot\'s header, so it is not read', 'late');
    log.getRange(1, 1).setValue('Alert id');
    try {
      const n = b.dashSnapshot({ refresh: true });
      eq([n.alerts, n.health.cannotSee.some(c => c.what === 'Alerts')], [[], true]);
    } finally {
      log.getRange(1, 1).setValue('alert_id');
    }
    eq(b.dashSnapshot({ refresh: true }).now.level, 'critical');
  });

  test('dashboard live: the stories come from the producer\'s own cache: size, speed per hour, level with its reasons, the bar, the card, and the top three marked (SPEC 3.1, 3.2)', () => {
    const x = on();
    const { t } = x;
    const b = t.bot;
    const s = b.dashSnapshot({ refresh: true });
    const H = Math.floor(t.g.clock.now / HOUR);
    eq(H - 1, x.lastHour);
    const ring = s.clusters.find(c => c.topic === 'Phones');
    const nest = s.clusters.find(c => c.topic === 'Nest');
    const photos = s.clusters.find(c => c.topic === 'Google Photos');
    eq([ring.accounts, ring.posts, ring.platforms, ring.engagement, ring.risk], [7, 7, ['X'], [40, 41, 42, 43, 44, 45, 46].reduce((p, n) => p + 10 + n, 0),
      ['Outage or broken feature']]);
    eq([ring.perHour.slice(-4), ring.lastHour, ring.prevHours, ring.speed, ring.speedWhy],
      [[0, 0, 0, 7], 7, 0, 'surging', '7 accounts in the last full hour, against 0 an hour in the 3 hours before']);
    assert.ok(ring.perHour.slice(0, 10).every(v => v === null), 'hours no check read are not known');
    // the same words from every account and no Google name: a copy-paste ring, never at the bar
    eq([ring.atBar, ring.status, ring.level, ring.levelWhy, ring.mark, ring.carded], [false, 'forming', 'medium', ['P1 risk words: Outage or broken feature'], 1, null]);
    eq([nest.accounts, nest.status, nest.level, nest.levelWhy, nest.mark, nest.speed, nest.perHour.slice(-4)],
      [2, 'forming', 'low', ['No risk words in its posts'], 2, 'steady', [0, 2, 0, 0]]);
    eq([photos.status, photos.level, photos.levelWhy, photos.mark, photos.carded.alertId, photos.carded.decision],
      ['carded', 'high', ['Its card QA-1007: The story\'s review rated it high'], null, 'QA-1007', 'Monitor build-up: Several users describe losing years of photos']);
    assert.ok(ring.importance > nest.importance && photos.importance > ring.importance);
    // one step up at the bar and rising: the ring's own record, its texts told apart (no longer a ring), from medium to high
    const raw = JSON.parse(t.g.cache.get('ews1:cl:0')).find(c => c.id === ring.id);
    raw.m.forEach((m, i) => { m.s = `${m.s} variant ${i}`; m.h = `h${i}`; });
    const roll = b.ewsRollup_(t.g.services.PropertiesService.getScriptProperties());
    const acc = b.ewsAcc_(JSON.parse(t.g.cache.get('ews1:acc') || 'null'));
    const up = b.dlClusterOf_(raw, t.g.clock.now, roll, b.dlAccIndex_(acc), new Map(), new Map());
    eq([up.atBar, up.status, up.level, up.levelWhy], [true, 'at the bar', 'high', ['P1 risk words: Outage or broken feature', 'One step up: at the bar for a card and surging']]);
    // a part of the cache gone: never "no stories", the page says what it can't see
    const part = t.g.cache.get('ews1:cl:0');
    t.g.cache.delete('ews1:cl:0');
    try {
      const gone = b.dashSnapshot({ refresh: true });
      eq([gone.clusters.length, gone.health.level, gone.now.level], [0, 'late', 'unknown']);
      eq(gone.health.sources.find(x2 => x2.key === 'producer').note, 'Every story it followed is gone from the cache');
      assert.ok(gone.health.cannotSee.some(c => c.what === 'Some stories forming'));
    } finally {
      t.g.cache.set('ews1:cl:0', part);
    }
  });

  test('dashboard live: an alert\'s detail: its corrections, email, T&S, escalation, follow-up, timeline, and its Chat thread read now as the bot with each message\'s link; a thread that can\'t be read keeps the row\'s own links and says so (SPEC 3.7)', () => {
    const x = on();
    const { t } = x;
    const b = t.bot;
    const writes = () => t.chat.calls.filter(c => c.method !== 'get').length;
    const before = writes();
    const d = b.dashDetail('alert', 'QA-1001');
    eq([d.ok, d.kind, d.id, d.title, d.level, d.status.key, d.alertKind], [true, 'alert', 'QA-1001', 'Criticism against AI Overviews', 'critical', 'sent', 'burson']);
    eq(d.alert.corrections.map(c => [c.field, c.old, c.new]), [['product', 'Gems', 'Gemini App'], ['social network', 'Instagram', 'X'],
      ['priority', 'P2', 'P0'], ['engagement level', 'LOW', 'HIGH']]);
    eq(d.alert.fixesAsked, []);  // the Auto-correct space asks Burson nothing
    eq([d.alert.email.status, d.alert.email.sentBy, d.alert.email.gmailLink, d.alert.email.groups],
      ['sent', 'the bot\'s account', 'https://mail.google.com/mail/?authuser=bot%40runner.test#all/th1', ['GCPA (gcpa)', 'pa']]);
    assert.ok(/^\[Auto-correct test\] SOCIAL ALERT: Gemini App/.test(d.alert.email.subject), d.alert.email.subject);
    eq([d.alert.escalation.track, d.alert.escalation.reasons, d.alert.followup.status, d.alert.followup.teams, d.alert.ongoing],
      ['HIGH_ENGAGEMENT', 'P0 criteria (Product - Perceived bias) · High engagement (29,425 on X)', 'Not checked yet', ['Gemini App alert POCs', 'Standard CC'], true]);
    eq(d.posts.map(p => [p.url, p.author, p.engagement, p.source]), [['https://x.com/edervolcelazz/status/2109566527900926417', 'edervolcelazz', 29425, 'the alert']]);
    eq(d.timeline.map(e => e.what), ['Burson\'s alert reached the space', 'The bot picked it up', 'The bot recorded its review', 'Its Social Alert was sent']);
    // the thread: Burson's alert in S-F Burson, the corrected copy, the bot's note of what it changed
    eq(d.chat.map(m => [m.kind, m.who]), [['alert', 'Zapier'], ['alert', 'the bot'], ['bot note', 'the bot']]);
    assert.ok(/Product: Gems to Gemini App/.test(d.chat[2].text), d.chat[2].text);
    d.chat.forEach(m => assert.ok(/^https:\/\/chat\.google\.com\/room\/AAQA/.test(m.link), m.link));
    eq(d.chat[0].link, b.outboxMessageLink_('spaces/AAQAaa_0I9g/messages/m2').split(' ')[0]);
    eq(b.dlChatLink_('spaces/AAQAx1/messages/T9.M9'), 'https://chat.google.com/room/AAQAx1/T9/M9');
    eq(b.dlChatLink_('spaces/AAQAx1/messages/T9.M9'), b.outboxMessageLink_('spaces/AAQAx1/messages/T9.M9'));
    assert.ok(d.cannotSee.some(c => c.what === 'Who the email went to'));
    // the Watch alert's T&S form, submitted by the bot
    const w = b.dashDetail('alert', 'QA-1003');
    eq([w.alert.tns.submitted, typeof w.alert.tns.at, w.alert.escalation], [true, 'number', null]);
    assert.ok(w.cannotSee.some(c => c.what === 'Its escalation details'));
    // Chat refuses the thread: the row's own messages keep their links, and the panel says it couldn't read the rest
    t.chat.fail = (method, path, query) => (method === 'get' && /\/messages$/.test(path) && /thread\.name/.test(String(query.filter || ''))
      ? { code: 500, body: { error: { code: 500, message: 'backend error' } } } : null);
    try {
      const f = b.dashDetail('alert', 'QA-1001');
      eq([f.ok, f.chat.map(m => [m.kind, m.link])], [true, [['alert', 'https://chat.google.com/room/AAQAaa_0I9g'], ['alert', 'https://chat.google.com/room/AAQAonespace01']]]);
      eq(f.cannotSee.filter(c => c.what === 'The messages of its Chat thread').map(c => c.fix), [
        'Open the panel again in a minute. The thread in Chat: https://chat.google.com/room/AAQAaa_0I9g/t2',
        'Open the panel again in a minute. The thread in Chat: https://chat.google.com/room/AAQAonespace01/t3']);
    } finally {
      t.chat.fail = null;
    }
    eq(writes(), before);  // nothing posted
    eq(b.dashDetail('alert', 'QA-9999'), { ok: false, why: 'QA-9999 is not among the newest 3,000 rows of the Alert log.',
      todo: 'Find QA-9999 on the Alert log tab of the bot\'s sheet (search the alert_id column).' });
    eq(b.dashDetail('alert', ''), { ok: false, why: 'Nothing was picked: choose an alert or a story first.' });
  });

  test('dashboard live: a story card keeps its story\'s posts in time order while row 54 is ON (from the producer\'s cache, else the signal\'s own posts), and nothing more with it OFF: the card\'s snapshot and every Chat post, emoji and email are as before (SPEC 3.6)', () => {
    const x = on();
    const b = x.t.bot;
    const ff = id => b.dlAlertRows_(x.t.sheet(), 3000).rows.find(r => r.alert_id === id).forwarded_fields.early_detection;
    // the Photos card: its story's 6 posts from the producer's cache, the oldest first
    const kept = ff('QA-1007').posts;
    eq(kept.map(p => p.a), ['X:photos1', 'Reddit:photos2', 'X:photos3', 'Reddit:photos4', 'X:photos5', 'Reddit:photos6']);
    assert.ok(kept.every((p, i) => typeof p.t === 'number' && (!i || p.t >= kept[i - 1].t)) && kept.every(p => /^https:\/\//.test(p.u)));
    const d = b.dashDetail('alert', 'QA-1007');
    eq(d.posts.map(p => [p.url, p.author, p.platform, p.at, p.source]), kept.map(p => [p.u, p.a.split(':')[1], p.p, p.t, 'kept with its card']));
    // a card whose story the cache doesn't have: the signal's own posts, with the time each was posted
    eq(ff('QA-1004').posts.map(p => [p.a, p.t]), [['X:tabhoarder', Date.UTC(2026, 9, 14, 11, 42)], ['X:devnotes_k', Date.UTC(2026, 9, 14, 11, 42)],
      ['Reddit:u_tab_loss', Date.UTC(2026, 9, 14, 11, 42)], ['X:latenightcoder', Date.UTC(2026, 9, 14, 11, 42)]]);
    // the cluster's own detail: its members in time order
    const c = b.dashDetail('cluster', b.dashSnapshot({ refresh: true }).clusters.find(cl => cl.topic === 'Google Photos').id);
    eq([c.ok, c.posts.length, c.posts.every((p, i) => !i || p.at >= c.posts[i - 1].at), c.posts[0].source, c.related[0]], [true, 6, true, 'Sonar',
      { kind: 'alert', id: 'QA-1007', title: 'Google Photos backups wiped after a storage plan change', why: 'Its card' }]);
    eq(b.dashDetail('cluster', 'CLU-gone'), { ok: false, why: 'This story is no longer in the producer\'s cache: a story leaves it 24 hours after its last post, or when the cache is cleared.',
      todo: 'If it got a card, find it in Alerts (a story card); how it ended is on the Early Detection tab, and in Held back when it was let go.' });
    // the cell cap: a story of 60 posts with the longest links kept keeps its newest 30, each link whole or left out
    const ON = { switches: { liveDashboard: true } };
    const big = { id: 'CLU-big000000001', s: 'x', m: Array.from({ length: 60 }, (_, i) => ({ a: `X:acct${i}`, p: 'X', t: 1790000000000 + i * MIN,
      u: `https://x.com/acct${i}/status/${String(i).padStart(4, '0')}?${'q'.repeat(i === 59 ? 400 : 250)}` })) };
    const props = x.t.g.services.PropertiesService.getScriptProperties();
    const st0 = x.t.g.props.get('EWS_STATE');
    const cl0 = x.t.g.cache.get('ews1:cl:1');
    try {
      props.setProperty('EWS_STATE', JSON.stringify(Object.assign(JSON.parse(st0), { cl: 2 })));
      x.t.g.cache.set('ews1:cl:1', JSON.stringify([big]));
      const posts = b.edSnapPosts_(ON, { ed: { clusterId: 'CLU-big000000001' } });
      eq([posts.length, posts[0].a, posts[posts.length - 1].a], [30, 'X:acct29', 'X:acct58']);  // acct59's link is too long: left out
      assert.ok(JSON.stringify(posts).length < 12000, String(JSON.stringify(posts).length));
      eq(b.edSnapPosts_({ switches: { liveDashboard: false } }, { ed: { clusterId: 'CLU-big000000001' } }), null);
    } finally {
      x.t.g.props.set('EWS_STATE', st0);
      if (cl0 === undefined) x.t.g.cache.delete('ews1:cl:1'); else x.t.g.cache.set('ews1:cl:1', cl0);
    }
    // the stored snapshot stays far under the cell cap
    const cell = x.t.sheet().getSheetByName('Alert log');
    const col = cell.rows[0].indexOf('forwarded_fields');
    assert.ok(cell.rows.slice(1).every(r => String(r[col]).length <= 45000));
    // row 54 OFF for the whole timeline
    const off = run({ on: false });
    const snapKeys = ['signal_type', 'velocity_grain', 'distinct_authors', 'mention_count', 'velocity_ratio', 'ed_alert_id', 'cluster_id', 'signal_key',
      'platforms', 'post_keys', 'update_of', 'disposition', 'basis', 'why', 'severity', 'confidence', 'narrative', 'signals', 'temp_check_query',
      'watch_for', 'story_title', 'next_steps', 'note'];
    const offFf = id => off.t.bot.dlAlertRows_(off.t.sheet(), 3000).rows.find(r => r.alert_id === id).forwarded_fields.early_detection;
    ['QA-1004', 'QA-1006', 'QA-1007'].forEach(id => {
      eq(Object.keys(offFf(id)), snapKeys, id);
      const on2 = Object.assign({}, ff(id));
      delete on2.posts;
      eq(offFf(id), on2, id);  // the rest of the snapshot is the same either way
    });
    eq(x.golden.differences(off.rec.out(), x.rec.out()), []);  // what the bot posts, marks and emails is the same either way
    off.t.bot.__dashOn = true;
    const od = off.t.bot.dashDetail('alert', 'QA-1007');
    eq([od.posts.length, od.posts[0].source, od.posts.every(p => p.at === null)], [6, 'its card\'s post links (no times kept)', true]);
    assert.ok(od.cannotSee.some(c2 => c2.what === 'Its story\'s posts in time order'));
  });

  test('dashboard live: what was held back today and this week, with the bot\'s own reasons: the fast triage\'s hold, a Watch flag waiting for its story; a tab the bot did not make is not read (SPEC 3.5 held)', () => {
    const x = on();
    const { t } = x;
    const b = t.bot;
    const h = b.dashSnapshot({ refresh: true }).held;
    eq([h.today.earlyDetection, h.today.fastTriage, h.today.fastTriageToday], [{ total: 1, byOutcome: [{ outcome: 'Held back as noise (no review)', n: 1 }] }, 1, 1]);
    eq(h.earlyDetection.rows.map(r => [r.outcome, r.why, r.link, r.id, r.group]), [['Held back as noise (no review)',
      'Looks like routine chatter (95% likely), severity low (70% sure).', NOISE, 'ED-CLU-clu_dino-202610141245', 'letgo']]);
    eq(h.today.watch, { total: 1, byCode: [{ code: 'b', words: 'Waiting: a small post, held until enough accounts tell its story for one alert', n: 1 }] });
    eq(h.watch.rows.map(r => [r.post, r.code, r.author]), [[SMALL, 'b', '@smallvoice']]);
    eq([h.today.direct.kept, h.today.direct.a + h.today.direct.b + h.today.direct.o, h.week.direct], [true, 0,
      { kept: false, why: 'Direct BigQuery keeps its not-posted counts for today only.' }]);
    eq(h.week.earlyDetection.total, 1);
    const sh = t.sheet().getSheetByName('Early Detection');
    const a1 = sh.cell(1, 1);
    sh.getRange(1, 1).setValue('My own notes');
    try {
      const f = b.dashSnapshot({ refresh: true }).held;
      eq([f.earlyDetection.ok, f.earlyDetection.why, f.earlyDetection.rows, f.today.earlyDetection],
        [false, 'A tab named "Early Detection" that the bot did not make is in the way, so it is not read.', [], null]);
    } finally {
      sh.getRange(1, 1).setValue(a1);
    }
  });

  test('dashboard live: pressure, pipeline, the head start and the common questions, each from what the bot keeps (SPEC 3.5)', () => {
    const x = on();
    const s = x.t.bot.dashSnapshot({ refresh: true });
    const p = s.pressure;
    eq([p.complete, p.byProduct.find(g => g.name === 'Chrome'), p.speedLeaders.map(l => [l.speed, l.lastHour])],
      [{ day: true, prevDay: true, week: true, prevWeek: true }, { name: 'Chrome', now24: 2, prev24: 0, change24: 2, now7: 2, prev7: 0, change7: 2 }, [['surging', 7]]]);
    eq(p.load, { measured: false, why: 'Not measured with row 51 OFF: the bot counts its own run time and outside calls against a budget only for the open engine.' });
    eq(s.pipeline.stages.map(st => [st.label, st.count]), [['Received', 7], ['Reviewed', 7], ['Fixes asked', 1], ['Social Alert drafted', 2], ['Sent / T&S', 2],
      ['Follow-up', null], ['Done', 4]]);  // row 21 OFF: replies are not tracked, so not counted as 0
    eq(s.pipeline.stages.find(st => st.key === 'followup').note, 'Not tracked with row 21 OFF (Track post-alert outcomes): the bot reads no replies');
    eq(s.pipeline.stuck.map(st => [st.id, st.why]), [['QA-1005', 'Its Social Alert has waited 6 hours to go out']]);
    eq([s.early.ok, /ET$/.test(s.early.rebuilt), s.early.numbers.length, s.early.numbers[0]], [true, true, 12, { label: 'Stories this app alerted on its own', week: '5', month: '5' }]);
    assert.ok(s.early.stories.some(st => st.appAlert === 'QA-1007' && st.link === 'https://www.reddit.com/r/googlephotos/comments/1ph6/backup_wiped/'));
    const q = id => s.questions.find(x2 => x2.id === id).answer;
    // only what is timed is named as current (never "every source that is ON")
    eq(q('keeping-up'), 'Yes: it last ran less than a minute ago, and Early Detection, its stories\' producer, the Proactive watch and Direct BigQuery are current.');
    eq(q('needs-me'), '1 item: first, Maps routing onto a closed bridge (Its Social Alert has waited 6 hours to go out).');
    eq(q('held'), 'Today: 1 story let go or never reviewed (most: Held back as noise (no review)); 1 Watch flag not posted; 0 Direct BigQuery posts not posted.');
    eq(q('corrections'), 'In the last 7 days, 4 corrections on 1 of Burson\'s alerts: product (1), social network (1), priority (1), engagement level (1).');
    assert.ok(/^Last 7 days \(the Head start tab, rebuilt .* ET\): of this app's own stories, Burson also alerted 0 of 5 \(0%\); this app was first on none of them, Burson on 0\.$/.test(q('beat-burson')), q('beat-burson'));
    assert.ok(/: surging \(7 accounts in the last full hour/.test(q('fastest')), q('fastest'));
    // the times as Sheets gives them back: the tab gives its time columns a date format, so a time the bot wrote as text
    // comes back as a date; it is shown as the bot wrote it ("yyyy-MM-dd HH:mm" ET), never left out; and the race on the
    // same post (Burson on this post, head start on the post) and the IMs' head start come with each story
    const sh = x.t.sheet().getSheetByName('Head start');
    const firstRow = sh.rows.findIndex(r => r && /^EVERY STORY/.test(String(r[0] || ''))) + 3;  // its title, its header, then the stories
    const T1 = Date.UTC(2026, 9, 14, 14, 5);
    const T2 = Date.UTC(2026, 9, 14, 14, 50);
    const T3 = Date.UTC(2026, 9, 14, 13, 40);
    const T4 = Date.UTC(2026, 9, 14, 16, 0);
    const keep = [2, 6, 8, 9, 15, 16].map(c => [c, sh.cell(firstRow, c)]);
    sh.getRange(firstRow, 2).setValue(new Date(T1));
    sh.getRange(firstRow, 6).setValue(new Date(T2));
    sh.getRange(firstRow, 8).setValue(new Date(T4));
    sh.getRange(firstRow, 9).setValue('ahead by 1 h 55 min');
    sh.getRange(firstRow, 15).setValue(new Date(T3));
    sh.getRange(firstRow, 16).setValue('behind by 25 min');
    try {
      const st = x.t.bot.dashSnapshot({ refresh: true }).early.stories[0];
      eq([st.at, st.bursonAt, st.imsAt, st.imsHeadStart, st.postBursonAt, st.postHeadStart],
        [x.t.bot.speedTime_(T1), x.t.bot.speedTime_(T2), x.t.bot.speedTime_(T4), 'ahead by 1 h 55 min', x.t.bot.speedTime_(T3), 'behind by 25 min']);
      assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(st.at), st.at);
      eq(x.t.bot.dlTimeCell_(new Date(NaN)), '');
      eq(x.t.bot.dlTimeCell_('\'2026-10-14 10:05'), '2026-10-14 10:05');
    } finally {
      keep.forEach(([c, v]) => sh.getRange(firstRow, c).setValue(v));
    }
    // the Head start tab, when one the bot did not make is in the way
    const a1 = sh.cell(1, 1);
    sh.getRange(1, 1).setValue('Our own head start notes');
    try {
      const e = x.t.bot.dashSnapshot({ refresh: true });
      eq([e.early.ok, e.early.why], [false, 'A tab named "Head start" that the bot did not make is in the way, so it is not read.']);
      eq(e.questions.find(x2 => x2.id === 'beat-burson').answer, e.early.why);
    } finally {
      sh.getRange(1, 1).setValue(a1);
    }
  });

  test('dashboard live: why didn\'t a post get an alert: what each store holds about it, read-only', () => {
    const x = on();
    const b = x.t.bot;
    const maps = b.dashWhyNot('https://x.com/roadwatcher/status/2150000000000000002');
    eq([maps.ok, maps.found.map(f => f.where)], [true, ['Alert memory', 'Alert log', 'Watch detections tab']]);
    eq(maps.answer, 'The bot holds 3 things about this post. The bot remembers it: its Social Alert was waiting to go out (QA-1005). ' +
      'Direct BigQuery card QA-1005: Draft waiting. The Watch flagged it (Google brand safety (all)): listed under another alert\'s card.');
    const noise = b.dashWhyNot(NOISE);
    eq(noise.found.map(f => [f.where, f.what]), [['Early Detection tab',
      'The story whose main post it is: Held back as noise (no review): Looks like routine chatter (95% likely), severity low (70% sure).']]);
    const ringPost = x.posts.find(p => /ringuser40/.test(p.url)).url;
    eq(b.dashWhyNot(ringPost).found.map(f => f.where), ['Early Detection stories']);
    assert.ok(/^It joined the story "My phone dialer screen freezes/.test(b.dashWhyNot(ringPost).found[0].what));
    const none = b.dashWhyNot('https://x.com/nobody_here/status/1');
    eq([none.found, none.answer], [[], 'Nothing the bot keeps mentions this post. Either no source read brought it in, or it was left out before grouping (not English, too short, a repost) or read long ago.']);
    eq(b.dashWhyNot('not a link'), { ok: false, why: 'Paste the post\'s full link, starting with https://.' });
  });

  test('dashboard live: no dash* call writes to the sheet, a property, Chat or Gmail; the only cache keys it adds are its own dash1: ones', () => {
    const x = on();
    const { t } = x;
    const b = t.bot;
    const before = kept(t);
    const keysBefore = new Set(t.g.cache.keys());
    const chatWrites = t.chat.calls.filter(c => c.method !== 'get').length;
    const mail = [t.g.gmail.sentMessages().length, t.g.gmail.allDrafts().length];
    const s = b.dashSnapshot({ refresh: true });
    b.dashSnapshot();
    b.dashDetail('alert', 'QA-1001');
    b.dashDetail('alert', 'QA-1007');
    b.dashDetail('cluster', s.clusters[0].id);
    b.dashWhyNot('https://x.com/roadwatcher/status/2150000000000000002');
    b.dashWhyNot(NOISE);
    eq(kept(t), before);
    eq(Array.from(t.g.cache.keys()).filter(k => !keysBefore.has(k) && k.indexOf('dash1:') !== 0), []);
    eq([t.chat.calls.filter(c => c.method !== 'get').length, t.g.gmail.sentMessages().length, t.g.gmail.allDrafts().length], [chatWrites].concat(mail));
  });

  test('dashboard live: the snapshot is kept 45 seconds in the script cache (dash1:snap, parts of at most 90,000 characters); refresh builds it anew; a torn copy is never used', () => {
    const x = on();
    const { t } = x;
    const b = t.bot;
    const svc = t.g.services.CacheService;
    const real = svc.getScriptCache;
    const ttl = {};
    svc.getScriptCache = () => {
      const c = real();
      return Object.assign({}, c, { put: (k, v, sec) => { ttl[k] = sec; return c.put(k, v, sec); },
        putAll: (m, sec) => { Object.keys(m).forEach(k => { ttl[k] = sec; }); return c.putAll(m, sec); } });
    };
    try {
      const first = b.dashSnapshot({ refresh: true });
      const head = JSON.parse(t.g.cache.get('dash1:snap'));
      eq(Object.keys(head).sort(), ['h', 'len', 'n']);
      const parts = Array.from({ length: head.n }, (_, i) => t.g.cache.get(`dash1:snap:${i}`));
      assert.ok(parts.every(p => typeof p === 'string' && p.length <= 90000));
      eq(parts.join(''), JSON.stringify(first));
      eq(Object.keys(ttl).sort(), ['dash1:snap'].concat(parts.map((_, i) => `dash1:snap:${i}`)).sort());
      assert.ok(Object.values(ttl).every(v => v === 45));
      const clock = t.g.clock.now;
      t.g.clock.now += 20 * 1000;
      try {
        const again = b.dashSnapshot();
        // the cached copy says when it was built (asOf) and when it is sent (servedAt: the page counts "ago" from it)
        eq([again.cached, again.asOf, again.servedAt], [true, first.asOf, clock + 20 * 1000]);
        eq(b.dashSnapshot({ refresh: true }).asOf, clock + 20 * 1000);
        t.g.cache.set('dash1:snap:0', `x${t.g.cache.get('dash1:snap:0').slice(1)}`);  // a part from another build: built anew
        const rebuilt = b.dashSnapshot();
        eq([rebuilt.cached, rebuilt.ok, rebuilt.asOf], [undefined, true, clock + 20 * 1000]);
      } finally {
        t.g.clock.now = clock;
      }
    } finally {
      svc.getScriptCache = real;
    }
    // the parts: characters and UTF-8 bytes both held to the limit, a character outside the BMP never split
    const s = 'a'.repeat(50000) + 'é'.repeat(40000) + '\u{1F600}'.repeat(30000) + 'z';
    const parts = b.dlChunks_(s, 90000);
    eq(parts.join(''), s);
    parts.forEach(p => assert.ok(p.length <= 90000 && Buffer.byteLength(p, 'utf8') <= 90000 && !/^[\uDC00-\uDFFF]/.test(p), `${p.length} ${Buffer.byteLength(p, 'utf8')}`));
  });

  test('dashboard live: the small helpers: the Last check label and ET times read back exactly, speed by the producer\'s own spike rule, page text without emoji', () => {
    const x = on();
    const b = x.t.bot;
    const now = x.t.g.clock.now;
    [now, now - 3 * 3600e3, Date.UTC(2026, 2, 8, 6, 59), Date.UTC(2026, 2, 8, 7, 1), Date.UTC(2025, 11, 31, 23, 30)].forEach(at => {
      const ms = Math.floor(at / MIN) * MIN;
      const label = b.Utilities.formatDate(new Date(ms), 'America/New_York', 'MMM d, h:mm a z');
      eq(b.dlLabelMs_(label, Math.max(now, ms)), ms, label);
      const et = b.Utilities.formatDate(new Date(ms), 'America/New_York', 'yyyy-MM-dd HH:mm');
      eq(b.dlEtMs_(et, Math.max(now, ms)), ms, et);
    });
    eq([b.dlLabelMs_('', now), b.dlLabelMs_('Working', now), b.dlEtMs_('2026-13-40 99:99', now)], [0, 0, 0]);
    // surging: 4 accounts or more, and 3 times (last / (before + 2)) or 12 more; rising / slowing: a quarter, and at least one
    const speeds = [[[6, 0], 'surging'], [[22, 9], 'surging'], [[3, 0], 'rising'], [[20, 9], 'rising'], [[5, 4], 'rising'], [[4, 4], 'steady'],
      [[9, 10], 'steady'], [[3, 4], 'slowing'], [[0, 0.7], 'steady'], [[0, 1], 'slowing'], [[null, 1], 'unknown'], [[2, null], 'unknown']];
    eq(speeds.map(([[l, p]]) => b.dlSpeedOf_(l, p).speed), speeds.map(x2 => x2[1]));
    eq(b.dlPlain_('\u2705 Working · <https://x.com/a|the post> \u{1F534} LIVE 1\uFE0F\u20E3'), 'Working · the post LIVE 1');
    eq(b.dlDecisionWords_('\u274C P2, 800 engagements: below the escalation criteria'), 'No action: P2, 800 engagements: below the escalation criteria');
    eq(b.dlDecisionWords_('\u{1F44D} Monitor build-up: x'), 'Monitor build-up: x');
  });

  // -------------------------------------------------------------------------------------------------------------
  // The review's fixes (each test fails without its fix)
  // -------------------------------------------------------------------------------------------------------------

  /** A row of the Alert log as dlAlertRows_ reads it (a copy of `id`'s), with `o` on it. */
  const rowOf = (x, id, o) => Object.assign(JSON.parse(JSON.stringify(x.t.bot.dlAlertRows_(x.t.sheet(), 3000).rows.find(r => r.alert_id === id))), o || {});
  /** Runs `fn` with these switches as the Control tab says them (on top of the world's), then puts them back. */
  const withSwitches = (b, sw, fn) => {
    if (!b.__more) b.ev('var __more = {}; readSwitches_ = (read => sh => Object.assign(read(sh), __more))(readSwitches_)');
    b.__more = sw;
    try { return fn(); } finally { b.__more = {}; }
  };

  test('dashboard live: a resend follows its chain: the draft or Social Alert its superseded original keeps shows on the live resend (owner, action, stuck), and Burson\'s alert left undecided becomes one a person must look at (H1)', () => {
    const x = on();
    const b = x.t.bot;
    const now = x.t.g.clock.now;
    const props = x.t.g.services.PropertiesService.getScriptProperties();
    const main = { space: 'spaces/AAQAtestfd1 > spaces/AAQAaLn375E', forward_message: 'spaces/AAQAaLn375E/messages/F8001' };
    const orig = rowOf(x, 'QA-1001', Object.assign({ alert_id: 'QA-8001', status: 'superseded', email_status: 'drafted', email_at: now - 2 * HOUR,
      email_sent_at: '', created_at: now - 3 * HOUR, decision: '' }, main));
    const resend = rowOf(x, 'QA-1001', Object.assign({ alert_id: 'QA-8002', status: 'fixed', resend_of: 'QA-8001', email_status: '', email_input: {},
      email_at: '', email_sent_at: '', email_thread: '', decision: '', created_at: now - HOUR }, main));
    const all = b.dlAlertsOf_([orig, resend], now, { trackOutcomes: false });
    eq(all.map(y => [y.a.id, y.status, y.a.owner.who]), [['QA-8001', 'superseded', 'nobody'], ['QA-8002', 'draft-waiting', 'the IM on shift']]);
    eq(all[1].a.action.text, 'Open the draft in Gmail and send it, or discard it.');
    const stuck = b.dlStuck_(x.t.sheet(), props, all, now, null).filter(st => st.kind === 'alert');
    eq(stuck.map(st => [st.id, st.why]), [['QA-8002', 'Its Social Alert has waited 2 hours to go out']]);
    // the original's Social Alert sent: the resend is sent, the teams have it
    const sent = b.dlAlertsOf_([Object.assign({}, orig, { email_status: 'sent', email_sent_at: now - 2 * HOUR }), resend], now, { trackOutcomes: true });
    eq([sent[1].status, /^the teams emailed/.test(sent[1].a.owner.who)], ['sent', true]);
    // the rows read are never changed
    eq([resend.email_status, resend.decision], ['', '']);
    // Burson's alert with no decision and no email anywhere on its chain, 2 days after the bot recorded it: a person looks
    const lost = rowOf(x, 'QA-1001', Object.assign({ alert_id: 'QA-8003', status: 'fixed', resend_of: 'QA-7999', email_status: '', email_input: {},
      decision: '', mirrored: '', created_at: now - 2 * 24 * HOUR }, main));
    const [l] = b.dlAlertsOf_([lost], now, {});
    eq([l.status, l.a.status.label, l.a.owner.who], ['needs-person', 'A person needs to look', 'the IM on shift']);
    // its original (QA-7999) is not among the rows read: whether it was decided is not known, and it says so (never "no decision")
    eq([l.a.owner.why, l.a.action.text], ['Its original (QA-7999) is not among the rows read, so whether it was decided is not known',
      'Look at it yourself: its original (QA-7999) is not among the rows read, so whether it was decided is not known. Find QA-7999 on the Alert log tab.']);
    eq(b.dlStuck_(x.t.sheet(), props, [l], now, null).filter(st => st.kind === 'alert').map(st => [st.id, st.why]),
      [['QA-8003', 'Its original (QA-7999) is not among the rows read, so whether it was decided is not known']]);
    // Burson's alert (not a resend) with no decision 2 days after the bot recorded it: the bot made none
    const undecided = Object.assign({}, lost, { alert_id: 'QA-8004', resend_of: '' });
    const [u] = b.dlAlertsOf_([undecided], now, {});
    eq([u.status, u.a.owner.who], ['needs-person', 'the IM on shift']);
    assert.match(u.a.action.text, /^Look at it yourself: the bot recorded it 2 days ago and has made no decision on it/);
    eq(b.dlStuck_(x.t.sheet(), props, [u], now, null).filter(st => st.kind === 'alert').map(st => st.id), ['QA-8004']);
    // a minute after it was recorded: still the bot's (it decides on the run that records it)
    eq(b.dlAlertsOf_([Object.assign({}, lost, { created_at: now - MIN })], now, {})[0].status, 'needs-review');
  });

  test('dashboard live: decisions that hand the work to a person name who and what: the YouTube Social chat ping, a T&S form not submitted yet, worth a look and a story to monitor (never "nobody" and "nothing to do") (H2)', () => {
    const x = on();
    const b = x.t.bot;
    const now = x.t.g.clock.now;
    const of = o => { const a = b.dlAlertsOf_([rowOf(x, 'QA-1002', Object.assign({ mirrored: '' }, o))], now, {})[0].a; return [a.status.key, a.owner.who, a.action.text]; };
    eq(of({ decision: 'YouTube: left for a person (the YouTube Social chat ping)' }),
      ['done', 'the IM on shift', 'Ping the YouTube Social chat about it (the bot left it for a person).']);
    eq(of({ decision: '\u{1F44D} + T&S (impersonation)', tns_submitted: '', email_groups: '' }),
      ['done', 'the IM on shift', 'Submit the T&S form from the pre-filled link in its thread, if no one has.']);
    eq(of({ decision: '\u{1F44D} Monitor build-up: worth analyst monitoring' }),
      ['done', 'the IMs on shift', 'Watch the story; open it again if it grows (Monitor build-up: worth analyst monitoring).']);
    const flag = rowOf(x, 'QA-1002', { decision: '', mirrored: '' });
    flag.forwarded_fields.triage = { call: 'flag', why: 'A creator says.' };
    const fa = b.dlAlertsOf_([flag], now, {})[0].a;
    eq([fa.owner.who, fa.action.text], ['the IMs on shift', 'Watch the story; open it again if it grows (Worth a look: A creator says).']);
  });

  test('dashboard live: with Direct BigQuery (row 15), Track post-alert outcomes (row 21) or Early Detection (row 19) OFF the page never shows calm zeros: Direct\'s held counts are not kept, replies are not tracked, stories are not followed (none shown, none counted), and it says so (H3, H4, H5)', () => {
    const x = on();
    const b = x.t.bot;
    withSwitches(b, { directBq: false, trackOutcomes: false, earlyWave: false }, () => {
      const s = b.dashSnapshot({ refresh: true });
      eq(s.held.today.direct, { kept: false, why: 'Direct BigQuery (row 15) is OFF: it reads no posts, so it holds none back.' });
      eq(s.questions.find(q => q.id === 'held').answer.indexOf('Direct BigQuery'), -1);
      const what = s.health.cannotSee.map(c => c.what);
      ['Direct BigQuery\'s posts', 'Replies to the Social Alerts sent', 'Stories forming'].forEach(w => assert.ok(what.includes(w), w));
      eq([s.clusters, s.now.counts.forming, s.now.counts.atBar, s.now.first.concat(s.now.then).some(i => i.kind === 'cluster')], [[], null, null, false]);
      eq(s.pressure.speedLeaders, []);
      eq(s.questions.find(q => q.id === 'fastest').answer, 'No story is followed: Early Detection (row 19) is OFF.');
      eq(s.pipeline.stages.find(st => st.key === 'followup').count, null);
      // no alert in the last 24 hours and none forming: the headline says stories are not followed (never "no story is forming")
      const quiet = b.dlNow_({ level: 'ok' }, [], [], [], x.t.g.clock.now, { earlyWave: false });
      eq(quiet.headline, 'Nothing needs a person now. No alerts came in the last 24 hours, and stories are not followed (Early Detection, row 19, is OFF).');
    });
    // ON again: as before
    const s = b.dashSnapshot({ refresh: true });
    eq([s.held.today.direct.kept, s.clusters.length > 0], [true, true]);
  });

  test('dashboard live: Burson messages the bot could not review (forwarded as received) or gave up on, from the Message log, are stuck items a person must look at, with a link; a Message log the bot did not make is said, never read (H3)', () => {
    const x = on();
    const b = x.t.bot;
    const now = x.t.g.clock.now;
    const sh = x.t.sheet().getSheetByName('Message log');
    const saved = JSON.parse(JSON.stringify(sh.rows));
    try {
      sh.appendRow(['spaces/AAQAaa_0I9g/messages/RAW1', now - 10 * MIN, 'raw_forward', '', 1, '']);
      sh.appendRow(['ac|spaces/AAQAaa_0I9g/messages/DEAD1', now - 20 * MIN, 'dead', '', 3, 'Chat answered 500']);
      sh.appendRow(['spaces/AAQAaa_0I9g/messages/OLD1', now - 2 * 24 * HOUR, 'raw_forward', '', 1, '']);
      const s = b.dashSnapshot({ refresh: true });
      const mine = s.pipeline.stuck.filter(st => /^msg:/.test(st.id));
      eq(mine.map(st => [st.id, st.level, st.title]), [['msg:spaces/AAQAaa_0I9g/messages/RAW1', 'unknown', 'A Burson message the bot could not review'],
        ['msg:spaces/AAQAaa_0I9g/messages/DEAD1', 'unknown', 'A Burson message the bot gave up on']]);
      assert.match(mine[1].why, /^The bot gave up on it after its tries \(Chat answered 500\)/);
      assert.match(mine[0].action, /^Review it by hand/);
      eq(s.now.counts.stuck, 3);
      // a tab of that name the bot did not make: not read, and said
      sh.getRange(1, 1).setValue('Our messages');
      const t2 = b.dashSnapshot({ refresh: true });
      eq(t2.pipeline.stuck.filter(st => /^msg:/.test(st.id)), []);
      assert.ok(t2.health.cannotSee.some(c => c.what === 'Burson messages the bot could not review' && /not the bot's header/.test(c.why)));
    } finally {
      sh.rows = saved;
    }
  });

  test('dashboard live: the Control tab missing or unreadable is never "the dashboard is OFF": the page is told to try again and keeps what it shows (H7); an Alert log with no alert yet shows no time it never recorded (H8)', () => {
    const x = on();
    const b = x.t.bot;
    const sh = x.t.control();
    const getRange = sh.getRange;
    sh.getRange = () => { throw new Error('Service Spreadsheets timed out'); };
    let r;
    try { r = b.dashSnapshot({ refresh: true }); } finally { sh.getRange = getRange; }
    eq([r.ok, r.off, r.why], [false, undefined, 'The Control tab of the bot\'s sheet could not be read just now, so the dashboard can\'t tell which parts are ON: press Refresh in a minute.']);
    const tab = b.controlTab_;
    b.controlTab_ = () => null;
    try { r = b.dashSnapshot({ refresh: true }); } finally { b.controlTab_ = tab; }
    eq([r.ok, r.off], [false, undefined]);
    assert.match(r.why, /^The bot's sheet has no Control tab/);
    eq(b.dashSnapshot({ refresh: true }).ok, true);
    // the Alert log read, with no alert in it yet
    const ctx = b.dashCtx_();
    const h = b.dlHealth_(ctx, x.t.g.services.PropertiesService.getScriptProperties(),
      { rows: [], tab: true, mine: true, read: 0, total: 0, oldestAt: 0, newestAt: 0, error: '' }, { count: 1, missing: 0 }, x.t.g.clock.now, null);
    eq(h.sources.find(src => src.key === 'alertLog'), { key: 'alertLog', label: 'The Alert log (the bot\'s record of every alert)', at: null, state: 'fresh', note: 'No alert recorded yet' });
  });

  test('dashboard live: a stuck item\'s seriousness has its reason: a queued signal\'s from its priority, said; a Burson outbox row\'s is not kept, so "can\'t be sure" (H10)', () => {
    const t = H.e2e(H.makeGoogle(H.NOW));
    t.bot.setup();
    const ss = t.sheet();
    const props = t.g.services.PropertiesService.getScriptProperties();
    const now = t.g.clock.now;
    const ob = t.bot.outboxTab_(ss, true);
    ob.appendRow(['2026-10-14 07:00', 'reply', 'S-F Burson', 'Please fix the product', 'the bot', 'Pending', '']);
    props.setProperty(t.bot.ev('ED_QUEUE_PROP_'), JSON.stringify([{ k: 'sig1', id: 'ED-CLU-a-202610141100', at: now - 2 * HOUR, pri: 'P0', tries: 0 }]));
    const stuck = t.bot.dlStuck_(ss, props, [], now, null);
    const q = stuck.find(st => st.id === 'ED-CLU-a-202610141100');
    eq(q.level, 'high');
    assert.match(q.why, /; high because its signal's priority is P0$/);
    const o = stuck.find(st => /^outbox:/.test(st.id));
    eq(o.level, 'unknown');
    assert.match(o.why, /; its seriousness is not kept$/);
    // the headline names it as not known (never a level it does not have)
    const only = t.bot.dlNow_({ level: 'ok' }, [], [], [o], now, {});
    assert.match(only.headline, /^1 item needs a person now\. Most serious: Please fix the product \(seriousness not known: /);
  });

  test('dashboard live: answers that find nothing carry what to do next: an alert past the rows read, a story gone from the cache, a post nothing mentions (H11)', () => {
    const x = on();
    const b = x.t.bot;
    assert.match(b.dashDetail('alert', 'QA-9998').todo, /^Find QA-9998 on the Alert log tab/);
    assert.match(b.dashDetail('cluster', 'CLU-none').todo, /^If it got a card, find it in Alerts/);
    const w = b.dashWhyNot('https://x.com/nobody/status/7');
    eq([w.found, w.todo], [[], 'If this post should have had an alert, post its link in the analyst space or send it to the IM on shift.']);
  });

  // ----- second review (L1-L8, L12, R1, R2): pure checks on rows written as the bot writes them --------------------
  const MAINP = 'spaces/AAQAtestfd1 > spaces/AAQAaLn375E';
  const ACP = 'spaces/AAQAsfb0001 > spaces/AAQAacsp001 (auto-correct)';
  const HEALTHY = { level: 'ok', headline: 'The bot is running: it last ran 1 minute ago.', why: '', fix: '', sources: [] };
  const ALL_ON = { trackOutcomes: true, earlyWave: true, directBq: true, proactiveWatch: true };
  const raw = (now, o) => Object.assign({ alert_id: 'QA-9100', created_at: now - HOUR, space: MAINP, source_message: 'spaces/AAQAtestfd1/messages/m1',
    status: 'ok', forwarded_fields: { issue_name: 'Gems give wrong answers' }, source_at: now - HOUR - MIN, decision: '', email_status: '' }, o || {});
  const stage = (p, k) => p.stages.find(st => st.key === k).count;
  const noSheet = { getSheetByName: () => null };
  const noProps = { getProperty: () => null };

  test('dashboard live: one Social Alert or T&S form counts once in the pipeline when Burson resent its alert, and an alert a person must look at is not "Reviewed" (L1, L2)', () => {
    const b = on().t.bot;
    const now = on().t.g.clock.now;
    // row 23 OFF: the resend keeps no email and no decision of its own (Bot.gs handleResend_ hadEmail), same forward
    const orig = raw(now, { alert_id: 'QA-9101', status: 'superseded', created_at: now - 2 * HOUR, forward_message: 'spaces/AAQAaLn375E/messages/F1',
      email_status: 'sent', email_sent_at: now - 110 * MIN, email_input: { followup: { read: now - 30 * MIN } } });
    const resend = raw(now, { alert_id: 'QA-9102', status: 'fixed', resend_of: 'QA-9101', created_at: now - 100 * MIN,
      source_message: 'spaces/AAQAtestfd1/messages/m2', forward_message: 'spaces/AAQAaLn375E/messages/F1' });
    const p = b.dlPipeline_(b.dlAlertsOf_([orig, resend], now, ALL_ON), [], now, ALL_ON);
    eq(['received', 'drafted', 'sent', 'followup'].map(k => stage(p, k)), [2, 1, 1, 1]);
    // a T&S form submitted on the original; the resend's decision is its copy (row 23 ON): one form
    const tOrig = raw(now, { alert_id: 'QA-9103', status: 'superseded', created_at: now - 90 * MIN, decision: 'T&S form only (impersonation)',
      tns_submitted: now - 89 * MIN });
    const tResend = raw(now, { alert_id: 'QA-9104', status: 'fixed', resend_of: 'QA-9103', created_at: now - 40 * MIN, decision: 'T&S form only (impersonation)' });
    eq(stage(b.dlPipeline_(b.dlAlertsOf_([tOrig, tResend], now, ALL_ON), [], now, ALL_ON), 'sent'), 1);
    // two alerts, each with its own Social Alert: two
    const other = raw(now, { alert_id: 'QA-9105', email_status: 'sent', email_sent_at: now - 50 * MIN });
    eq(stage(b.dlPipeline_(b.dlAlertsOf_([orig, resend, other], now, ALL_ON), [], now, ALL_ON), 'sent'), 2);
    // Burson's alert with no decision 20 minutes after it was recorded: a person looks, so it is not counted as Reviewed
    const undecided = b.dlAlertsOf_([raw(now, { alert_id: 'QA-9106', created_at: now - 20 * MIN })], now, ALL_ON);
    eq([undecided[0].status, stage(b.dlPipeline_(undecided, [], now, ALL_ON), 'reviewed')], ['needs-person', 0]);
  });

  test('dashboard live: what needs a person and whose seriousness is not known ranks above a known high one and sets the level to "can\'t be sure"; a critical one still leads (L3, R1)', () => {
    const x = on();
    const b = x.t.bot;
    const now = x.t.g.clock.now;
    const low = b.dlAlertsOf_([raw(now, { alert_id: 'QA-9111', created_at: now - 30 * MIN, decision: '❌ P2, 300 engagements: below the escalation criteria',
      forwarded_fields: { issue_name: 'Meme' } })], now, ALL_ON);
    const msgs = { ok: true, reach: true, rows: [{ message: 'spaces/AAQAtestfd1/messages/z', at: now - 10 * MIN, kind: 'raw_forward', flows: ['main'], error: '' }] };
    const n1 = b.dlNow_(HEALTHY, low, [], b.dlStuck_(noSheet, noProps, low, now, msgs), now, ALL_ON);
    eq([n1.level, n1.counts.needAction, n1.first[0].id], ['unknown', 1, 'msg:spaces/AAQAtestfd1/messages/z']);
    assert.match(n1.headline, /^1 item needs a person now\. Most serious: A Burson message the bot could not review \(seriousness not known: /);
    // a high draft waiting: the message still comes first
    const high = b.dlAlertsOf_([raw(now, { alert_id: 'QA-9112', created_at: now - 3 * HOUR, email_status: 'pending', email_at: now - 2 * HOUR })], now, ALL_ON);
    const n2 = b.dlNow_(HEALTHY, high, [], b.dlStuck_(noSheet, noProps, high, now, msgs), now, ALL_ON);
    eq([n2.level, n2.first.map(i => i.id)], ['unknown', ['msg:spaces/AAQAtestfd1/messages/z', 'QA-9112']]);
    // a critical one leads (a P0 exposure tag on a draft waiting)
    const p0 = (b.ev('GEN').exposure_tags || []).find(t => String(t.priority).toUpperCase() === 'P0');
    assert.ok(p0, 'a P0 tag in the config');
    const crit = b.dlAlertsOf_([raw(now, { alert_id: 'QA-9113', created_at: now - 3 * HOUR, email_status: 'pending', email_at: now - 2 * HOUR,
      exposure_tag: p0.name })], now, ALL_ON);
    const n3 = b.dlNow_(HEALTHY, crit, [], b.dlStuck_(noSheet, noProps, crit, now, msgs), now, ALL_ON);
    eq([n3.level, n3.first.map(i => i.id)], ['critical', ['QA-9113', 'msg:spaces/AAQAtestfd1/messages/z']]);
  });

  test('dashboard live: a decision that leaves a T&S form to submit or the YouTube Social chat to ping needs a person: counted, named in the headline and the needs-me answer, never "Done" in the pipeline (L4, R2)', () => {
    const x = on();
    const b = x.t.bot;
    const now = x.t.g.clock.now;
    const all = b.dlAlertsOf_([
      raw(now, { alert_id: 'QA-9121', created_at: now - HOUR, decision: 'T&S form only (impersonation)', forwarded_fields: { issue_name: 'Impersonation' } }),
      raw(now, { alert_id: 'QA-9122', created_at: now - 50 * MIN, decision: 'YouTube: left for a person (the YouTube Social chat ping)', forwarded_fields: { issue_name: 'YT thing' } }),
      raw(now, { alert_id: 'QA-9123', created_at: now - 40 * MIN, decision: 'T&S form only (impersonation) · auto-submitted', tns_submitted: now - 39 * MIN }),
    ], now, ALL_ON);
    const stuck = b.dlStuck_(noSheet, noProps, all, now, { ok: true, reach: true, rows: [] });
    const n = b.dlNow_(HEALTHY, all, [], stuck, now, ALL_ON);
    eq([n.counts.needAction, n.first.slice(0, 2).map(i => i.id).sort()], [2, ['QA-9121', 'QA-9122']]);
    assert.match(n.headline, /^2 items need a person now\. Most serious: Impersonation \(medium: Its T&S form is not submitted yet\)\.$/);
    const p = b.dlPipeline_(all, stuck, now, ALL_ON);
    eq(stage(p, 'done'), 0);
    const snap = { health: HEALTHY, now: n, pressure: { speedLeaders: [] }, clusters: [], switches: ALL_ON, pipeline: p,
      held: { today: { direct: { kept: false } } }, early: { ok: false, why: '', numbers: [] } };
    assert.match(b.dlQuestions_(snap, all, now).find(q => q.id === 'needs-me').answer, /^2 items: first, Impersonation \(Its T&S form is not submitted yet\)\.$/);
  });

  test('dashboard live: Burson\'s alert left undecided follows the bot\'s own rule for waiting on Burson: the Auto-correct flow waits only on a problem only Burson can fix, and nothing waits with row 23 ON (L5)', () => {
    const x = on();
    const b = x.t.bot;
    const now = x.t.g.clock.now;
    const ac = raw(now, { alert_id: 'QA-9131', space: ACP, created_at: now - 3 * HOUR, status: 'fix_requested',
      requested: [{ field: 'product', old: 'Gemini', new: 'Gems' }] });
    const [a] = b.dlAlertsOf_([ac], now, ALL_ON);
    eq([a.a.flow, a.status, a.a.owner.who], ['auto-correct', 'needs-person', 'the IM on shift']);
    assert.match(a.a.action.text, /Open its thread in the Auto-correct space\.$/);
    // the bot's rule says the same: a retry can't decide it, a person needs to look
    const ctx = { store: { alertById: () => null, emailRowByForward: () => null }, drafts: { on: true }, gmail: {}, settings: { react: true },
      switches: { noWait: false }, sourceReadOnly: true };
    eq(b.undecidedRow_(ctx, ac), true);
    // something only Burson can add (a problem): it waits on Burson's resend
    const waits = Object.assign({}, ac, { requested: [{ field: 'post_url', problem: 'missing' }] });
    eq(b.dlAlertsOf_([waits], now, ALL_ON)[0].status, 'needs-review');
    // ...unless Never wait on Burson (row 23) is ON
    eq(b.dlAlertsOf_([waits], now, Object.assign({ noWait: true }, ALL_ON))[0].status, 'needs-person');
  });

  test('dashboard live: a resend whose decision is its original\'s T&S form, auto-submitted or submitted on the original, is never told to submit it again (L6)', () => {
    const x = on();
    const b = x.t.bot;
    const now = x.t.g.clock.now;
    const orig = raw(now, { alert_id: 'QA-9141', status: 'superseded', created_at: now - 90 * MIN, decision: 'T&S form only (impersonation) · auto-submitted',
      tns_submitted: now - 89 * MIN, forward_message: 'spaces/AAQAaLn375E/messages/F9' });
    const resend = raw(now, { alert_id: 'QA-9142', status: 'fixed', resend_of: 'QA-9141', created_at: now - 40 * MIN,
      decision: 'T&S form only (impersonation) · auto-submitted', forward_message: 'spaces/AAQAaLn375E/messages/F9' });
    const r = b.dlAlertsOf_([orig, resend], now, ALL_ON)[1];
    eq([r.status, r.a.tns.submitted], ['tns', true]);
    assert.doesNotMatch(r.a.action.text, /Submit the T&S form/);
    // its original not read: the decision's own words say it was submitted
    eq(b.dlAlertsOf_([resend], now, ALL_ON)[0].a.tns.submitted, true);
    // a T&S decision without the mark, its form submitted on the original
    const plainOrig = Object.assign({}, orig, { decision: 'T&S form only (impersonation)' });
    const plainResend = Object.assign({}, resend, { decision: 'T&S form only (impersonation)' });
    const pr = b.dlAlertsOf_([plainOrig, plainResend], now, ALL_ON)[1];
    eq([pr.status, pr.a.tns.submitted, pr.row.tnsFrom], ['tns', true, 'QA-9141']);
    // and with no submission anywhere, the person is still told to submit it
    const none = b.dlAlertsOf_([Object.assign({}, plainOrig, { tns_submitted: '' }), plainResend], now, ALL_ON)[1];
    eq([none.status, none.a.action.text], ['done', 'Submit the T&S form from the pre-filled link in its thread, if no one has.']);
  });

  test('dashboard live: a Burson message both flows could not review is one stuck item, worded for where each flow put it; a Message log read that does not reach back 24 hours says so (L7, L8)', () => {
    const x = on();
    const b = x.t.bot;
    const now = x.t.g.clock.now;
    const sheetOf = values => ({ getLastRow: () => values.length,
      getRange: (r, c, nr, nc) => ({ getValues: () => values.slice(r - 1, r - 1 + nr).map(v => v.slice(c - 1, c - 1 + nc)) }) });
    const head = JSON.parse(JSON.stringify(b.ev('MESSAGE_COLUMNS_')));
    const tab = b.ev('MESSAGE_TAB_');
    const ssOf = vals => ({ getSheetByName: n => (n === tab ? sheetOf(vals) : null) });
    const iso = new Set(['spaces/AAQAmirror01']);
    const fwd = new Set(['spaces/AAQAtestfd1']);
    const m = b.dlMessages_(ssOf([head, ['spaces/AAQAtestfd1/messages/z', now - 10 * MIN, 'raw_forward', '', 3, ''],
      ['ac|spaces/AAQAtestfd1/messages/z', now - 9 * MIN, 'raw_forward', '', 3, ''],
      ['spaces/AAQAmirror01/messages/q', now - 8 * MIN, 'raw_forward', '', 3, ''],
      ['ac|spaces/AAQAsfb0001/messages/k', now - 7 * MIN, 'raw_forward', '', 3, '']]), now, iso, fwd);
    const st = b.dlStuck_(noSheet, noProps, [], now, m);
    eq(st.map(s => s.id), ['msg:spaces/AAQAtestfd1/messages/z', 'msg:spaces/AAQAmirror01/messages/q', 'msg:spaces/AAQAsfb0001/messages/k']);
    eq(st[0].why, 'The bot could not read or review it, so it went to the analyst space as received, and went to the Auto-correct space as received, with no review (its seriousness is not known)');
    eq(st[0].action, 'Review it by hand: open it in the analyst space, where it was forwarded as received.');
    eq([st[1].why, st[1].action], ['The bot could not read or review it, so it was not forwarded (the bot works in its own space there), with no review (its seriousness is not known)',
      'Review it by hand: open it in its space (the link).']);
    eq(st[2].action, 'Review it by hand: open its copy in the Auto-correct space, where it was posted as received.');
    eq(b.dlNow_(HEALTHY, [], [], st, now, ALL_ON).counts.needAction, 3);
    // a message 20 hours ago behind 600 newer rows: not read, and said
    const many = [head, ['spaces/AAQAtestfd1/messages/old', now - 20 * HOUR, 'raw_forward', '', 3, '']];
    for (let i = 0; i < 600; i++) many.push([`spaces/AAQAtestfd1/messages/n${i}`, now - 6 * HOUR + i * 30000, 'alert', `QA-${i}`, 0, '']);
    const m2 = b.dlMessages_(ssOf(many), now, iso, fwd);
    eq([m2.ok, m2.reach, m2.rows.length], [true, false, 0]);
    const cannot = b.dlCannotSee_(ALL_ON, { tab: true, mine: true, oldestAt: now - 8 * 24 * HOUR }, { count: 1, missing: 0 }, now, m2);
    const c = cannot.find(e => /^Burson messages the bot could not review, before /.test(e.what));
    assert.ok(c, JSON.stringify(cannot.map(e => e.what)));
    eq(c.why, 'Only the newest 500 rows of the Message log are read, and they do not reach back 24 hours.');
    // all of the last 24 hours read: nothing said
    const m3 = b.dlMessages_(ssOf(many.slice(0, 300)), now, iso, fwd);
    eq([m3.reach, m3.rows.length], [true, 1]);
  });

  test('dashboard live: why a post got no alert, with Early Detection (row 19) OFF: the story it joined is told as it was when row 19 was turned OFF, never as current (L11)', () => {
    const x = on();
    const b = x.t.bot;
    const url = 'https://x.com/photos1/status/2160000000000000001';
    const story = r => r.found.find(f => f.where === 'Early Detection stories' || f.where === 'Early Detection pool');
    const live = story(b.dashWhyNot(url));
    assert.ok(live, JSON.stringify(b.dashWhyNot(url).found));
    assert.ok(/so far\)|\(none yet\)/.test(live.what), live.what);
    withSwitches(b, { earlyWave: false }, () => {
      const off = story(b.dashWhyNot(url));
      assert.match(off.what, /when Early Detection \(row 19\) was turned OFF/);
      assert.ok(!/so far\)|\(none yet\)/.test(off.what), off.what);
    });
  });
};
