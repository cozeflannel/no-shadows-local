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
    eq([s.asOf, s.servedAt, keys(s.build), s.mode], [x.t.g.clock.now, x.t.g.clock.now, ['behind', 'bot', 'url', 'web'], 'testing']);
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
      'Nothing yet: wait for its thread to be read']);
    eq([by('QA-1001').corrections, by('QA-1001').email.status, by('QA-1001').flow], [4, 'sent', 'auto-correct']);
    eq(pick(by('QA-1002')), ['direct', 'low', 'No action: P2, 800 engagements: below the escalation criteria', 'no-action', 'nobody',
      'Nothing to do: P2, 800 engagements: below the escalation criteria.']);
    eq(pick(by('QA-1003')), ['watch', 'medium', 'A T&S form, no Social Alert', 'tns', 'Trust & Safety',
      'Check that the T&S submission went through (its confirmation email).']);
    eq([by('QA-1003').tns.submitted, by('QA-1003').decision], [true, 'Worth a look + T&S (Gemini hallucination) · auto-submitted']);
    eq(pick(by('QA-1004')), ['story', 'medium', 'The story\'s review rated it medium', 'done', 'nobody',
      'Nothing to do: Monitor build-up: Several independent users describe the same data loss after one update.']);
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
    eq(b.dashDetail('alert', 'QA-9999'), { ok: false, why: 'QA-9999 is not among the newest 3,000 rows of the Alert log.' });
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
    eq(b.dashDetail('cluster', 'CLU-gone'), { ok: false, why: 'This story is no longer in the producer\'s cache: a story leaves it 24 hours after its last post, or when the cache is cleared.' });
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
      ['Follow-up', 0], ['Done', 4]]);
    eq(s.pipeline.stuck.map(st => [st.id, st.why]), [['QA-1005', 'Its Social Alert has waited 6 hours to go out']]);
    eq([s.early.ok, /ET$/.test(s.early.rebuilt), s.early.numbers.length, s.early.numbers[0]], [true, true, 12, { label: 'Stories this app alerted on its own', week: '5', month: '5' }]);
    assert.ok(s.early.stories.some(st => st.appAlert === 'QA-1007' && st.link === 'https://www.reddit.com/r/googlephotos/comments/1ph6/backup_wiped/'));
    const q = id => s.questions.find(x2 => x2.id === id).answer;
    eq(q('keeping-up'), 'Yes: it last ran less than a minute ago, and every source that is ON is current.');
    eq(q('needs-me'), '1 item: first, Maps routing onto a closed bridge (Its Social Alert has waited 6 hours to go out).');
    eq(q('held'), 'Today: 1 story let go or never reviewed (most: Held back as noise (no review)); 1 Watch flag not posted; 0 Direct BigQuery posts not posted.');
    eq(q('corrections'), 'In the last 7 days, 4 corrections on 1 of Burson\'s alerts: product (1), social network (1), priority (1), engagement level (1).');
    assert.ok(/^Last 7 days \(the Head start tab, rebuilt .* ET\): of this app's own stories, Burson also alerted 0 of 5 \(0%\); this app was first on none of them, Burson on 0\.$/.test(q('beat-burson')), q('beat-burson'));
    assert.ok(/: surging \(7 accounts in the last full hour/.test(q('fastest')), q('fastest'));
    // the Head start tab, when one the bot did not make is in the way
    const sh = x.t.sheet().getSheetByName('Head start');
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
};
