// A bigger post on an issue that already has an alert gets its own Direct BigQuery card (BqPipeline.gs bqBiggerPost_,
// bqEngagementBar_; BigQuery.gs pollBigQuerySources_; setting cross_alert_notes, default on; the Auto-correct flow only).
// Step 1 of the Direct BigQuery evaluation leaves a post out when its issue already has an alert and nothing says what
// is new, however big the post is. Now a record it leaves out as on that issue (by the rules, or by Gemini where the
// code's own rule matches an earlier alert by the issue) goes through as its own card when it has the alert
// requirements' engagement bar or more (the config's 2,000) and none of the earlier alerts on the issue had that many.
// Its card is reviewed like any other. Nothing else passes: not a record left out for any other reason, no post under
// the bar whoever wrote it, and there is no thread note. A record that passes is not counted on C15 as not posted. With
// the setting off, in the Mirror flow and in every flow that is not the Auto-correct flow, the poll does what it did.
//
// Every scenario here turns the fix plan's other settings off (golden.SETTINGS_OFF), so what a later change does by
// default never moves these tests.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, world, loadBot, collectBurson, MAPS_LOW } = H;
  const golden = require('./golden_flows')(H);
  const W = golden.world;
  const { AC, MIRROR } = golden.spaces;
  const MIN = 60 * 1000;
  const TESTER = 'tester@testing.test';
  const ON = Object.assign({}, golden.SETTINGS_OFF, { cross_alert_notes: true });
  const OFF = golden.SETTINGS_OFF;

  // -----------------------------------------------------------------------------------------------------------
  // The rule
  // -----------------------------------------------------------------------------------------------------------

  // Earlier alerts, as the poll hands them to Step 1 (BqPipeline.gs bqPriorAlerts_): two on the Pixel issue, both under
  // the bar; one on the Maps issue that had the bar; one on the Chrome issue whose count isn't known
  const PRIORS = [
    { alert_id: 'QA-701', url: 'https://x.com/tech/status/10', issue_name: 'Pixel 10 battery swelling', engagement: 800,
      summary: 'User reported Pixel 10 battery swelling on charger.' },
    { alert_id: 'QA-702', url: 'https://x.com/w1/status/101', issue_name: 'Google Maps routing onto closed highway bridge', engagement: 2500,
      summary: 'Drivers on X reported Google Maps routing onto a closed bridge.' },
    { alert_id: 'QA-703', url: 'https://x.com/tech2/status/11', issue_name: 'Pixel 10 battery swelling', engagement: 1999,
      summary: 'Another Pixel 10 owner reported a swollen battery.' },
    { alert_id: 'QA-704', url: 'https://x.com/tabs/status/12', issue_name: 'Chrome tabs crashing', summary: 'Chrome keeps crashing tabs.' },
  ];
  const rec = (id, url, issue, o) => Object.assign({ id, url, platform: 'X', author: `@${id}`, issue_name: issue,
    summary: `People talk about the Google issue (${issue}) today.` }, o);
  const PIXEL = 'Pixel 10 battery swelling';
  const MAPS = 'Google Maps routing onto closed highway bridge';
  const RECORDS = [
    rec('pixel_2400', 'https://x.com/a/status/21', PIXEL, { engagement: 2400 }),
    rec('pixel_2000', 'https://x.com/b/status/22', PIXEL, { engagement: 2000 }),
    rec('pixel_1999', 'https://x.com/c/status/23', PIXEL, { engagement: 1999 }),
    rec('pixel_feed_total', 'https://x.com/d/status/24', PIXEL, { source_kind: 'BSIP', tags: 'Product - Other/general criticism', total: 2400 }),  // the count as the BSIP feed gives it
    rec('maps_9000', 'https://x.com/e/status/25', MAPS, { engagement: 9000 }),
    rec('chrome_2400', 'https://x.com/f/status/26', 'Chrome tabs crashing', { engagement: 2400 }),
    rec('same_post', 'https://x.com/tech/status/10', PIXEL, { engagement: 5000 }),  // the very post of QA-701
    rec('slang', 'https://x.com/g/status/27', '', { engagement: 9000, summary: 'Just google the answer or google me before asking!' }),
    rec('fresh', 'https://x.com/h/status/28', 'Gmail drafts vanish', { engagement: 5000, summary: 'Gmail keeps losing my drafts since the Google update.' }),
    rec('gemini_pixel', 'https://x.com/i/status/29', PIXEL, { engagement: 2400 }),
    rec('gemini_maps', 'https://x.com/j/status/30', MAPS, { engagement: 9000 }),
    rec('gemini_fresh', 'https://x.com/k/status/31', 'Photos albums gone', { engagement: 9000, summary: 'Google Photos lost my albums.' }),
    rec('gemini_under', 'https://x.com/l/status/32', PIXEL, { engagement: 1500 }),
  ];
  const GEMINI = { analyzeBqRecords: () => ({ solo_alerts: RECORDS.filter(r => !/^gemini_/.test(r.id)).map(r => ({ id: r.id, why_met_guidelines: 'Passed.' })),
    group_waves: [], discarded_ids: RECORDS.filter(r => /^gemini_/.test(r.id)).map(r => r.id) }) };
  /** Step 1 as the poll asks it, then the rule for every record it left out: [id, why, the alert it matched, bigger?]. */
  const judged = (bot, priors, gemini) => {
    const step = bot.evaluateBqDualTrack_(RECORDS, null, { soloOnly: true, priorAlerts: priors, gemini });
    return { passed: step.solo_alerts.map(s => s.id),
      out: step.left_out.map(x => [x.id, x.why, x.alert_id, bot.bqBiggerPost_(RECORDS.find(r => r.id === x.id), x, priors)]) };
  };

  test('bigger post: the rule (bqBiggerPost_). A record Step 1 left out as on an issue already alerted is a bigger post when it has the engagement bar or more (2,000, from the config) and none of the earlier alerts on that issue had that many: every earlier alert on the issue counts, not only the first; one whose count isn\'t known had none. Also when Gemini discarded the record and the code\'s own rule matches an earlier alert by the issue. Never a record under the bar, one on an issue whose earlier alert had the bar, one left out for any other reason (the post itself already alerted, not about Google, Gemini\'s own call with no earlier alert on the issue), or one Step 1 let through', () => {
    eq([B.bqEngagementBar_(), B.ev('GEN').escalation_rules.high_engagement_threshold], [2000, 2000]);
    const got = judged(B, PRIORS, GEMINI);
    eq(got.passed, ['fresh']);  // a new issue: Step 1 lets it through itself, as before
    eq(got.out, [
      ['same_post', 'same_post', 'QA-701', false],
      ['slang', 'not_google', '', false],
      ['pixel_2400', 'same_issue', 'QA-701', true],
      ['pixel_2000', 'same_issue', 'QA-701', true],
      ['pixel_1999', 'same_issue', 'QA-701', false],
      ['pixel_feed_total', 'same_issue', 'QA-701', true],
      ['maps_9000', 'same_issue', 'QA-702', false],
      ['chrome_2400', 'same_issue', 'QA-704', true],
      ['gemini_pixel', 'gemini', 'QA-701', true],
      ['gemini_maps', 'gemini', 'QA-702', false],
      ['gemini_fresh', 'gemini', '', false],
      ['gemini_under', 'gemini', 'QA-701', false],
    ]);
    // the rules alone (Gemini not asked): the same records are bigger posts, each left out by the rules
    eq(judged(B, PRIORS, null).out.filter(x => x[3]).map(x => [x[0], x[1]]),
      [['pixel_2400', 'same_issue'], ['pixel_2000', 'same_issue'], ['pixel_feed_total', 'same_issue'], ['chrome_2400', 'same_issue'], ['gemini_pixel', 'same_issue']]);
    // every earlier alert on the issue counts: the first one Step 1 names (QA-701, 800) is under the bar, but once a
    // later alert on the issue had the bar, no post on it is a bigger post any more
    const pixel = RECORDS[0];
    const x = { id: 'pixel_2400', why: 'same_issue', alert_id: 'QA-701', match: 'issue' };
    const withBar = n => PRIORS.concat([{ alert_id: 'QA-705', url: 'https://x.com/z/status/40', issue_name: PIXEL, engagement: n }]);
    eq([B.bqBiggerPost_(pixel, x, PRIORS), B.bqBiggerPost_(pixel, x, withBar(1999)), B.bqBiggerPost_(pixel, x, withBar(2000)),
      B.bqBiggerPost_(pixel, x, withBar(2400)), B.bqBiggerPost_(pixel, x, withBar(50000))], [true, true, false, false, false]);
    // the entry must say "left out as on an issue already alerted": any other entry, or none, is no bigger post
    const entry = patch => Object.assign({}, x, patch);
    eq([entry({ why: 'gemini' }), entry({ why: 'same_post', match: 'post' }), entry({ why: 'same_issue', match: 'post' }), entry({ match: '' }),
      entry({ why: 'gemini', match: '' }), entry({ why: 'not_google', match: '' }), entry({ why: 'not_google' }), entry({ why: 'no_wave' }),
      entry({ why: '' }), null, undefined, {}].map(e => B.bqBiggerPost_(pixel, e, PRIORS)),
    [true, false, false, false, false, false, false, false, false, false, false, false]);
    // no earlier alert on the issue among the ones given (none at all, or only other issues), or no record: no bigger post
    eq([B.bqBiggerPost_(pixel, x, []), B.bqBiggerPost_(pixel, x, null), B.bqBiggerPost_(pixel, x, [PRIORS[1]]), B.bqBiggerPost_(null, x, PRIORS),
      B.bqBiggerPost_('pixel', x, PRIORS), B.bqBiggerPost_({}, x, PRIORS)], [false, false, false, false, false, false]);
  });

  test('bigger post: the bar is the config\'s (collection.high_engagement_threshold, as GEN.escalation_rules has it), never a number in the code: with the bar at 5,000 a post of 2,400 is no bigger post and one of 5,000 is, and the Maps issue (its earlier alert had 2,500) is open again; while the config gives no bar nothing passes', () => {
    const bot = loadBot();
    const rules = bot.ev('GEN').escalation_rules;
    const pixel = n => rec('p', 'https://x.com/a/status/21', PIXEL, { engagement: n });
    const maps = n => rec('m', 'https://x.com/e/status/25', MAPS, { engagement: n });
    const x = alert => ({ id: 'p', why: 'same_issue', alert_id: alert, match: 'issue' });
    const all = () => [bot.bqEngagementBar_(), bot.bqBiggerPost_(pixel(2400), x('QA-701'), PRIORS), bot.bqBiggerPost_(pixel(5000), x('QA-701'), PRIORS),
      bot.bqBiggerPost_(maps(9000), x('QA-702'), PRIORS)];
    eq(all(), [2000, true, true, false]);
    rules.high_engagement_threshold = 5000;
    eq(all(), [5000, false, true, true]);
    [0, undefined, null, 'x', -1, NaN].forEach(none => {
      rules.high_engagement_threshold = none;
      eq([String(none)].concat(all()), [String(none), 0, false, false, false]);
    });
    delete bot.ev('GEN').escalation_rules;
    eq(all(), [0, false, false, false]);
    // the number 2,000 is not written in the rule: the code reads the config
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'BqPipeline.gs'), 'utf8');
    const body = src.slice(src.indexOf('function bqEngagementBar_()'), src.indexOf('function evaluateBqDualTrack_('));
    assert.ok(body.includes('function bqBiggerPost_(') && !/2[,_]?000/.test(body.replace(/\/\*[\s\S]*?\*\//g, '')), 'no 2,000 in the code of the rule');
  });

  // -----------------------------------------------------------------------------------------------------------
  // In the one-space setup
  // -----------------------------------------------------------------------------------------------------------

  const PIXEL_POST = golden.posts.PIXEL;                                   // the golden Pixel post: 800 engagements, a P2 tag
  const PIXEL_ISSUE = 'Pixel 10 battery swelling after update';
  const BIG = 'https://x.com/batterywatch/status/2150000000000000041';     // a bigger post on the same issue
  const THIRD = 'https://x.com/thirdpost/status/2150000000000000042';      // and a later, bigger one still
  const onIssue = (url, total, o) => golden.rows.bsipRow(Object.assign({ id: url.split('/').pop(), url, handle: url.split('/')[3], followers: 61000,
    total, summary: `Another X user (${url.split('/')[3]}) says their Google Pixel 10 battery swelled up after the latest update.` }, o || {}));
  const kind = m => (!m.threadReply && /\*\[BigQuery · BSIP\]\*/.test(m.text) ? 'Direct BigQuery card'
    : m.threadReply && m.text.indexOf('The agentic assistant reviewed this alert') === 0 ? 'card review note' : 'another post');
  const botPosts = (t, space) => t.chat.spaces.get(space).messages.filter(m => m.viaApi);
  const cards = (t, space) => botPosts(t, space || AC).filter(m => kind(m) === 'Direct BigQuery card').map(m => m.text.match(/\[Link\]: (\S+)/)[1]);
  const today = t => { const d = JSON.parse(t.g.props.get('BQ_DIRECT_TODAY')); return ['n', 's', 'm', 'a', 'b'].map(k => d[k]); };
  const c15 = t => String(t.control().cell(15, 3)).replace(/^.* · last check [^·]+ · /, '');
  const logs = t => t.g.logs.filter(l => /^BigQuery direct poll: (?:let through|not posted)/.test(l)).map(l => l.replace('BigQuery direct poll: ', ''));
  const mails = t => t.g.gmail.sentMessages().map(m => [m.to, m.subject]);
  const alertRows = t => t.bot.sheetBackend_(t.sheet()).loadAlerts();
  /** The one-space setup, three Direct BigQuery checks in, then the golden Pixel post carded and reviewed (no Social Alert). */
  const withPixelCard = overrides => {
    const w = W.oneSpaceWorld(overrides);
    w.rec.collect('setup');
    w.rec.step('the first run', 1);
    w.rec.step('a check', 5);
    w.rec.step('a check', 5);
    w.rec.step('Direct BigQuery finds the Pixel post', 5, () => { w.feed.bsip = [golden.rows.bsipRow()]; });
    w.rec.step('its card is reviewed', 1);
    eq([cards(w.t), today(w.t), mails(w.t)], [[PIXEL_POST], [1, 0, 1, 0, 0], []]);
    return w;
  };
  const LET_THROUGH = (url, n, alert, by) => `let through, a bigger post on an issue already alerted: ${url} · ${n} engagements, ` +
    `and no earlier alert on the issue had 2,000 · ${alert} (BSIP) · Step 1 had left it out, ${by || 'by the rules'}`;
  const NOT_POSTED = (url, alert, by) => `not posted, on a story already alerted: ${url} · ${alert} (BSIP) · Step 1, ${by || 'by the rules'}`;

  test('bigger post: in the one-space setup a post of 2,400 engagements on an issue whose only alert had 800 goes through as its own card, once: the card as the poll builds every card, its review a run later (the issue marked ongoing, the Social Alert to the tester), and C15 counts it as a post, never as "on a story already alerted". A second look at the same post does not card it again, also with the poll\'s memory lost. A later post on the issue, bigger still, does not pass: the issue now has an alert with the bar', () => {
    const w = withPixelCard(ON);
    const { t, rec, feed } = w;
    const first = alertRows(t)[0].alert_id;
    rec.step('a bigger post on the Pixel issue', 5, () => { feed.bsip = [golden.rows.bsipRow(), onIssue(BIG, 2400)]; });
    eq([cards(t), today(t), logs(t)], [[PIXEL_POST, BIG], [2, 0, 1, 0, 0], [LET_THROUGH(BIG, '2,400', first)]]);
    eq(c15(t), '2 posts today (0 for a Social Alert, 1 monitoring only) · not posted: 0 already had an alert, 0 on a story already alerted');
    // the card is the one the poll builds for any BSIP post
    const card = botPosts(t, AC).filter(m => kind(m) === 'Direct BigQuery card')[1];
    eq(card.text, t.bot.formatBsipSonarAlertText_(onIssue(BIG, 2400), { kof: false }));
    assert.match(card.text, /^THIS ALERT MEETS P2 CRITERIA · 🔷🔍 \*\[BigQuery · BSIP\]\*\n\n🟨SOCIAL ALERT🟨: Pixel \| Pixel 10 battery swelling after update \| X \| 2400 Engagements\n/);
    // its review: one note under it, and the Social Alert its 2,400 engagements earn
    rec.step('its card is reviewed', 1);
    eq([botPosts(t, AC).filter(m => m.threadReply && m.thread.name === card.thread.name).map(kind), today(t)], [['card review note'], [2, 1, 1, 0, 0]]);
    eq(mails(t), [[[TESTER], '[Auto-correct test] 🟥SOCIAL ALERT🟥: Pixel | Pixel 10 battery swelling after update | X | 2400 Engagements']]);
    const rows = alertRows(t).map(r => [r.ingested, r.record_key, r.email_status || '', r.forwarded_fields.total_engagement, r.forwarded_fields.issue_name,
      r.forwarded_fields.issue_status]);
    eq(rows, [['BSIP', t.bot.recordKey_({ post_url: PIXEL_POST }), '', 800, PIXEL_ISSUE, 'NEW'],
      ['BSIP', t.bot.recordKey_({ post_url: BIG }), 'sent', 2400, PIXEL_ISSUE, 'Ongoing Issue']]);
    // a second look, and a third with the poll's memory of the posts it took gone: no second card, nothing counted
    rec.step('the same posts again', 5);
    t.g.props.delete('BQ_INGESTED_KEYS');
    Array.from(t.g.cache.keys()).filter(k => /^bq(?:step1|np):/.test(k)).forEach(k => t.g.cache.delete(k));
    rec.step('the same posts again', 5);
    eq([cards(t), today(t), logs(t).length, mails(t).length], [[PIXEL_POST, BIG], [2, 1, 1, 0, 0], 1, 1]);
    // a later post on the issue with 3,000: the earlier alerts on the issue now include one that had the bar
    const second = alertRows(t)[1].alert_id;
    rec.step('a later post on the issue, bigger still', 5, () => { feed.bsip = [golden.rows.bsipRow(), onIssue(BIG, 2400), onIssue(THIRD, 3000)]; });
    rec.step('quiet run', 1);
    eq([cards(t), today(t), logs(t).slice(1), mails(t).length], [[PIXEL_POST, BIG], [2, 1, 1, 0, 1], [NOT_POSTED(THIRD, first)], 1]);
    assert.ok(second !== first && /^QA-\d+$/.test(second), second);
    eq(c15(t), '2 posts today (1 for a Social Alert, 1 monitoring only) · not posted: 0 already had an alert, 1 on a story already alerted');
    // nothing went anywhere but the Auto-correct space and the tester's mailbox
    const elsewhere = [];
    t.chat.spaces.forEach((s, id) => { if (id !== AC) s.messages.forEach(m => { if (m.viaApi && /BigQuery|Pixel/.test(m.text)) elsewhere.push([id, m.text.slice(0, 40)]); }); });
    eq(elsewhere.filter(x => !/^spaces\/DM/.test(x[0])), []);
  });

  test('bigger post: with the setting off (cross_alert_notes false) the one-space setup does what it did before: the bigger post is left out as on a story already alerted, counted and logged as such, with no card and no email; and in the golden scenarios the setting changes nothing', () => {
    const w = withPixelCard(OFF);
    const { t, rec, feed } = w;
    const first = alertRows(t)[0].alert_id;
    rec.step('a bigger post on the Pixel issue', 5, () => { feed.bsip = [golden.rows.bsipRow(), onIssue(BIG, 2400)]; });
    rec.step('quiet run', 1);
    rec.step('the same posts again', 5);
    eq([cards(t), today(t), logs(t), mails(t)], [[PIXEL_POST], [1, 0, 1, 0, 1], [NOT_POSTED(BIG, first)], []]);
    eq(c15(t), '1 post today (0 for a Social Alert, 1 monitoring only) · not posted: 0 already had an alert, 1 on a story already alerted');
    eq(alertRows(t).length, 1);
    // the golden scenarios hold no record Step 1 leaves out as the same issue: with this setting alone turned on, each
    // puts out exactly what it did at f93e31a
    eq(golden.differences(golden.oneSpace(ON), golden.recorded.one_space), []);
    eq(golden.differences(golden.mirror(ON), golden.recorded.mirror), []);
  });

  test('bigger post: nothing else passes. A post under the bar on an issue already alerted (1,999 engagements) and a post, however big, on an issue whose earlier alert already had the bar are left out as before, each counted once under "on a story already alerted" with its log line', () => {
    const MAPS_POST = golden.posts.MAPS;  // the golden Maps post: 2,400 engagements and a P0 tag (its card sends a Social Alert)
    const UNDER = 'https://x.com/almostthere/status/2150000000000000051';
    const HUGE = 'https://x.com/bridgewatch/status/2150000000000000052';
    const { t, rec, feed } = W.oneSpaceWorld(ON);
    rec.collect('setup');
    rec.step('the first run', 1);
    rec.step('a check', 5);
    rec.step('Direct BigQuery finds the Pixel post and the Maps post', 5, () => { feed.bsip = [golden.rows.mapsRow(), golden.rows.bsipRow()]; });
    rec.step('their cards are reviewed', 1);
    eq([cards(t), today(t)], [[MAPS_POST, PIXEL_POST], [2, 1, 1, 0, 0]]);
    const [mapsId, pixelId] = alertRows(t).map(r => r.alert_id);
    rec.step('two more posts on those issues', 5, () => {
      feed.bsip = [Object.assign(golden.rows.mapsRow(), { id: '2150000000000000052', url: HUGE, handle: 'bridgewatch', total: 50000,
        summary: 'Another X user says Google Maps still routes drivers onto the closed bridge.' }), golden.rows.mapsRow(), golden.rows.bsipRow(),
      onIssue(UNDER, 1999)];
    });
    rec.step('quiet run', 1);
    eq([cards(t), today(t), logs(t), mails(t).length], [[MAPS_POST, PIXEL_POST], [2, 1, 1, 0, 2], [NOT_POSTED(HUGE, mapsId), NOT_POSTED(UNDER, pixelId)], 1]);
    // the post under the bar reaches it: within the hour Step 1 doesn't weigh it again; after that it is a bigger post
    rec.step('the post under the bar reaches 2,000', 5, () => { feed.bsip = [onIssue(UNDER, 2000)]; });
    eq(cards(t), [MAPS_POST, PIXEL_POST]);
    Array.from(t.g.cache.keys()).filter(k => /^bqstep1:/.test(k)).forEach(k => t.g.cache.delete(k));  // (an hour on)
    rec.step('an hour on', 5);
    eq([cards(t), today(t), logs(t).slice(2)], [[MAPS_POST, PIXEL_POST, UNDER], [3, 1, 1, 0, 2], [LET_THROUGH(UNDER, '2,000', pixelId)]]);
  });

  test('bigger post: the earlier alert can be a story\'s card. A story among small accounts is carded (its main post has 44 engagements); Direct BigQuery then reads a post of 2,400 engagements on the story\'s issue that is none of the story\'s posts: it goes through as its own card, and the log names the story\'s card as the earlier alert. With the setting off it is left out as on a story already alerted', () => {
    const POST = 'https://x.com/tabsgone/status/2150000000000000081';
    const row = () => golden.rows.bsipRow({ id: '2150000000000000081', url: POST, handle: 'tabsgone', alert_names_json: '["Chrome"]',
      tags: 'Chrome tabs | Product - Other/general criticism', followers: 52000, total: 2400,
      summary: 'An X user says the Google Chrome update closed all their open tabs.', issue_name: 'Chrome update closes all open tabs' });
    const run = overrides => {
      const { t, rec, feed } = W.oneSpaceWorld(overrides);
      rec.collect('setup');
      rec.step('the first run', 1);
      rec.step('a story is found', 15, () => { feed.stories = [golden.rows.story()]; });
      rec.step('its card is posted', 1);
      const story = alertRows(t).find(r => r.ingested === 'Early detection');
      eq([story.forwarded_fields.issue_name, story.forwarded_fields.total_engagement], ['Chrome update closes all open tabs', 44]);
      rec.step('Direct BigQuery reads a bigger post on the story\'s issue', 5, () => { feed.stories = []; feed.bsip = [row()]; });
      rec.step('quiet run', 1);
      return { cards: cards(t), logs: logs(t), story: story.alert_id, notes: botPosts(t, AC).filter(m => /Part of a story/.test(m.text)).length };
    };
    const on = run(ON);
    eq([on.cards, on.notes, on.logs], [[POST], 0, [`let through, a bigger post on an issue already alerted: ${POST} · 2,400 engagements, ` +
      `and no earlier alert on the issue had 2,000 · ${on.story} (Early detection) · Step 1 had left it out, by the rules`]]);
    const off = run(OFF);
    eq([off.cards, off.logs], [[], [`not posted, on a story already alerted: ${POST} · ${off.story} (Early detection) · Step 1, by the rules`]]);
  });

  test('bigger post: also when Gemini discarded it. Gemini\'s Step 1 discards a bigger post on an issue already alerted and a post on an issue nobody alerted: the first still gets its card (the code\'s own rule matches the earlier alert by the issue; the log says Gemini had left it out), the second stays out, as Gemini said, and is not counted', () => {
    const w = withPixelCard(ON);
    const { t, rec, feed } = w;
    const first = alertRows(t)[0].alert_id;
    const FRESH = 'https://x.com/newissue/status/2150000000000000061';
    const asked = [];
    t.g.vertex.bqRecords = payload => {
      const recs = JSON.parse(payload.contents[0].parts.map(p => p.text || '').join('\n').match(/<records>\n([\s\S]*)\n<\/records>/)[1]);
      asked.push(recs.map(r => r.url));
      return { solo_alerts: [], group_waves: [], discarded_ids: recs.map(r => r.id) };
    };
    rec.step('Gemini discards both', 5, () => {
      feed.bsip = [golden.rows.bsipRow(), onIssue(BIG, 2400), golden.rows.bsipRow({ id: '2150000000000000061', url: FRESH, handle: 'newissue',
        alert_names_json: '["Chrome"]', tags: 'Chrome tabs | Product - Other/general criticism', total: 9000,
        summary: 'An X user says the Google Chrome update closed every open tab.', issue_name: 'Chrome update closes every open tab' })];
    });
    eq([asked, cards(t), today(t)], [[[BIG, FRESH]], [PIXEL_POST, BIG], [2, 0, 1, 0, 0]]);
    eq(t.g.logs.filter(l => /^BigQuery direct poll: (?:let through|not posted)/.test(l)).map(l => l.replace('BigQuery direct poll: ', '')),
      [LET_THROUGH(BIG, '2,400', first, 'by Gemini'), `not posted, left out by Step 1: ${FRESH} · by Gemini (it matched no earlier alert)`]);
  });

  test('bigger post: the poll\'s limits still hold. Four bigger posts in one check, two of them on one issue: of those two only the first passes (the other is left out as on a story already alerted: a post let through at this check counts as an alert with the bar); of the three that pass, two are carded at this check (the poll\'s 2 cards a check) and the third at the next one; none is carded twice', () => {
    const ISSUES = [
      ['chrome', 'Chrome', 'Chrome update closes every open tab', 'An X user says the Google Chrome update closed every open tab.'],
      ['gmail', 'Gmail', 'Gmail drafts sent to the wrong contact', 'An X user says Gmail sent their Google account drafts to the wrong contact.'],
    ];
    const post = ([id, product, issue, summary], n, total) => golden.rows.bsipRow({ id: `21500000000000001${n}`, url: `https://x.com/${id}_${n}/status/21500000000000001${n}`,
      handle: `${id}_${n}`, alert_names_json: JSON.stringify([product]), tags: `${product} | Product - Other/general criticism`, followers: 7000, total,
      summary, issue_name: issue });
    const { t, rec, feed } = withPixelCard(ON);
    rec.step('two more small posts, each on an issue of its own', 5, () => { feed.bsip = [post(ISSUES[0], 1, 600), post(ISSUES[1], 2, 610)]; });
    rec.step('their cards are reviewed', 1);
    const [pixelId, chromeId, gmailId] = alertRows(t).map(r => r.alert_id);
    eq([cards(t).length, today(t)], [3, [3, 0, 3, 0, 0]]);
    // four bigger posts, the most engaged first (as the feed gives them): two on the Pixel issue, one on each of the others
    const big = [onIssue(THIRD, 3000), post(ISSUES[1], 3, 2600), post(ISSUES[0], 4, 2500), onIssue(BIG, 2400)];
    rec.step('four bigger posts', 5, () => { feed.bsip = big; });
    eq([cards(t).slice(3), today(t)], [[THIRD, big[1].url], [5, 0, 3, 0, 1]]);
    eq(logs(t), [LET_THROUGH(THIRD, '3,000', pixelId), LET_THROUGH(big[1].url, '2,600', gmailId), LET_THROUGH(big[2].url, '2,500', chromeId),
      NOT_POSTED(BIG, pixelId)]);
    rec.step('their cards are reviewed', 1);
    // the next check: the third one gets its card; the two carded and the one left out are not looked at again
    rec.step('the next check', 5);
    rec.step('its card is reviewed', 1);
    eq([cards(t).slice(3), today(t), logs(t).slice(4)], [[THIRD, big[1].url, big[2].url], [6, 3, 3, 0, 1], [LET_THROUGH(big[2].url, '2,500', chromeId)]]);
    rec.step('one more check', 5);
    eq([cards(t).length, today(t), logs(t).length], [6, [6, 3, 3, 0, 1], 5]);
    eq(t.bot.ev('BQ_POLL_MAX_PER_RUN_'), 2);
  });

  // -----------------------------------------------------------------------------------------------------------
  // The flows that are not the Auto-correct flow
  // -----------------------------------------------------------------------------------------------------------

  test('bigger post: in the Mirror flow nothing changes. A post is carded in the Mirror space, then a bigger post on its issue is read, while Testing and again LIVE: it is left out as on a story already alerted, and every Chat post, test copy post, emoji, email and Burson outbox row, the day\'s counts and the run log\'s lines are the same with the setting on as with it off', () => {
    const run = overrides => {
      const { t, feed, rec } = W.mirrorWorld(overrides);
      rec.step('Direct BigQuery finds the Pixel post', 5, () => { feed.bsip = [golden.rows.bsipRow()]; });
      rec.step('its card is reviewed', 1);
      rec.step('a bigger post on the Pixel issue (Testing)', 5, () => { feed.bsip = [golden.rows.bsipRow(), onIssue(BIG, 2400)]; });
      rec.step('quiet run', 1);
      rec.step('the test copy is cleared: LIVE', 1, () => { t.set('B26', ''); });
      rec.step('another bigger post on the Pixel issue (LIVE)', 5, () => { feed.bsip = [golden.rows.bsipRow(), onIssue(BIG, 2400), onIssue(THIRD, 3000)]; });
      rec.step('quiet run', 1);
      return { t, out: rec.out(), today: today(t), logs: logs(t), cards: cards(t, MIRROR) };
    };
    const on = run(ON);
    const off = run(OFF);
    eq(golden.differences(on.out, off.out), []);
    eq([on.today, on.logs, on.cards], [off.today, off.logs, off.cards]);
    const first = alertRows(on.t)[0].alert_id;
    eq([on.cards, on.today, on.logs], [[PIXEL_POST], [1, 0, 1, 0, 2], [NOT_POSTED(BIG, first), NOT_POSTED(THIRD, first)]]);
  });

  // The poll's reads, for a world built by hand (the BSIP read answers feed.bsip; every other read has no rows)
  const BSIP_COLS = [['source_kind'], ['id'], ['url'], ['handle'], ['network'], ['alert_names_json'], ['tags'], ['criticality'],
    ['followers', 'INTEGER'], ['total', 'INTEGER'], ['summary'], ['issue_name'], ['post_time']];
  const fakeBq = g => {
    const feed = { bsip: [] };
    const orig = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (u, params) => {
      if (!String(u).startsWith('https://bigquery.googleapis.com/')) return orig(u, params);
      const [cols, rows] = /"BSIP" AS source_kind/.test(String(JSON.parse(params.payload).query || '')) ? [BSIP_COLS, feed.bsip] : [[['url']], []];
      const text = JSON.stringify({ jobComplete: true, schema: { fields: cols.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: rows.map(x => ({ f: cols.map(c => ({ v: x[c[0]] === undefined || x[c[0]] === null ? null : String(x[c[0]]) })) })) });
      return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => text };
    };
    return feed;
  };

  test('bigger post: only the Auto-correct flow, and only its own mark. The same earlier alert (Burson\'s, 300 engagements) and the same bigger post on its issue (2,400), read by the poll in a world built by hand: the Auto-correct flow lets it through; the main flow on a test feed, a flow whose mark is merely truthy, and the Auto-correct flow with the setting off leave it out as on a story already alerted, exactly as before', () => {
    const DOG = 'https://x.com/streetviewfan/status/2118000000000000071';
    const dogRow = () => ({ source_kind: 'BSIP', id: '2118000000000000071', url: DOG, handle: 'streetviewfan', network: 'Twitter',
      alert_names_json: '["Google Maps"]', tags: 'Product - Meme about Google products', criticality: 'HIGH', followers: 9000, total: 2400,
      summary: 'An X user shares the Google Maps Street View picture of a dog chasing the car.', issue_name: 'Google Maps Street View Dog Meme',
      post_time: '2026-10-14 11:40:00+00' });
    const res = o => Object.assign({ sprinklr: 0, bmie: 0, bsip: 0, skipped_duplicates: 0, skipped_step1: 0, skipped_no_count: 0 }, o);
    const said = w => w.g.logs.filter(l => /^BigQuery direct poll: (?:let through|not posted)/.test(l)).map(l => l.replace('BigQuery direct poll: ', ''));
    /** A world with Burson's alert on the issue reviewed by `flow`, then one check of the poll that reads the bigger post. */
    const run = (flow, settings) => {
      const w = world(settings ? { settings } : undefined);
      const feed = fakeBq(w.g);
      const ctx = () => {
        const c = Object.assign(w.ctx(), { switches: Object.assign(w.bot.switchesOff_(), { directBq: true }) }, flow);
        Object.assign(c.settings, { bq_direct_poll: true, bq_poll_sprinklr: true, bq_poll_bmie: true, bq_poll_bsip: true });
        return c;
      };
      const target = flow.sourceReadOnly ? w.ANA : w.BUR;  // where this flow's poll posts its cards
      w.paste(MAPS_LOW);
      w.g.clock.now += 1000;
      w.bot.runOnce_(Object.assign(ctx(), flow.sourceReadOnly ? { sourceReadOnly: true, changeNotes: true } : {}));
      collectBurson(w.chat, [w.BUR]);
      const prior = w.alertRows()[0];
      eq([prior.forwarded_fields.issue_name, prior.forwarded_fields.total_engagement], ['Google Maps Street View Dog Meme', 300]);
      feed.bsip = [dogRow()];
      w.g.clock.now += 5 * MIN;
      const got = w.bot.pollBigQuerySources_(ctx(), target);
      const posted = w.chat.botPosts(target).filter(m => !m.threadReply && /\*\[BigQuery · BSIP\]\*/.test(m.text)).map(m => m.text.match(/\[Link\]: (\S+)/)[1]);
      const d = JSON.parse(w.g.props.get('BQ_DIRECT_TODAY'));
      return { got, posted, counts: [d.n, d.a, d.b], said: said(w), prior: prior.alert_id };
    };
    const AC_FLOW = { sourceReadOnly: true, allowDirectBq: true };
    eq(B.ev('GEN').settings.cross_alert_notes, true);  // (a world built by hand has the default settings)
    const ac = run(AC_FLOW);
    eq([ac.got, ac.posted, ac.counts, ac.said], [res({ bsip: 1 }), [DOG], [1, 0, 0],
      [`let through, a bigger post on an issue already alerted: ${DOG} · 2,400 engagements, and no earlier alert on the issue had 2,000 · ` +
        `${ac.prior} (Burson's alert) · Step 1 had left it out, by the rules`]]);
    const LEFT_OUT = r => [res({ skipped_step1: 1 }), [], [0, 0, 1], [`not posted, on a story already alerted: ${DOG} · ${r.prior} (Burson's alert) · Step 1, by the rules`]];
    [['the main flow on a test feed', {}, null], ['a flow whose mark is merely truthy', { sourceReadOnly: 'yes', allowDirectBq: true }, null],
      ['the Auto-correct flow with the setting off', AC_FLOW, { cross_alert_notes: false }]].forEach(([name, flow, settings]) => {
      const r = run(flow, settings);
      eq([name, r.got, r.posted, r.counts, r.said], [name].concat(LEFT_OUT(r)));
    });
  });
};
