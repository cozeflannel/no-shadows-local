// Step 1 of the Direct BigQuery evaluation says why it leaves a record out (BqPipeline.gs evaluateBqDualTrack_).
// Beside the ids in `discarded_ids` it returns `left_out`: one entry a left-out record, in the same order,
//   {id, why, alert_id, match}
//   why       one of BQ_LEFT_OUT_: 'not_google' | 'same_post' | 'gemini' | 'same_issue' | 'no_wave'
//   alert_id  the earlier alert the code's own rule (matchBqPriorAlert_) matches the record to, '' for none: the id the
//             caller's list of earlier alerts has (from the poll: the Alert-log id), never the reference Gemini writes
//   match     how that rule matched it: 'post' (the post itself), 'issue' (the same issue), '' for none
// Which records pass is not changed. bq_step1_records_3be2e06.json holds what the cases below returned at commit
// 3be2e06, before `left_out` was added (solo_alerts, group_waves, discarded_ids and by, whole). The first test holds
// the evaluation to it. It was written by this file from the code as it stood then:
//   BQ_STEP1_RECORD=1 node apps-script-chat-bot/test/run_tests.js "Step 1 left out: the same inputs"
// Recording it again is for a change that is meant to move which records pass; then read its diff and name it in the
// commit. Once this round is merged and released the record can go: the second test pins the reasons.
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = H => {
  const { test, eq, assert, B } = H;
  const RECORD_FILE = path.join(__dirname, 'bq_step1_records_3be2e06.json');
  const WAVES = { threshold: 2000, waveMin: 2000, minWaveAuthors: 5 };
  const rec = (id, url, o) => Object.assign({ id, url, platform: 'X' }, o);

  // Two earlier alerts, as the poll hands them over (BqPipeline.gs bqPriorAlerts_): a Pixel post and a Maps story on X
  const PRIORS = [
    { alert_id: 'QA-701', url: 'https://x.com/tech/status/10', author: '@tech', platform: 'X', product: 'Pixel',
      issue_name: 'Pixel 10 battery swelling', engagement: 2800, summary: 'User reported Pixel 10 battery swelling on charger.' },
    { alert_id: 'QA-702', url: 'https://x.com/w1/status/101', author: '@w1', platforms: ['X'], product: 'Google Maps',
      issue_name: 'Google Maps routing onto closed highway bridge', engagement: 1500,
      summary: 'Drivers on X reported Google Maps routing onto a closed bridge.' },
  ];

  // Not about Google by the rules: "google it" slang, a feed that isn't about Google, an issue name the feed marks as noise
  const SLANG = rec('slang', 'https://x.com/slang/status/1', { engagement: 5000, summary: 'Just google the answer or google me before asking!' });
  const NFL = rec('nfl', 'https://x.com/nfl/status/2', { source_kind: 'BMIE', brand: 'NFL', engagement: 8000,
    snippet: 'Touchdown in the fourth quarter at MetLife Stadium!' });
  const PROMO = rec('promo', 'https://x.com/promo/status/3', { engagement: 900, issue_name: 'Promotional giveaway for a mobile game',
    summary: 'A Google Play gift card giveaway for a new mobile game.' });
  // The very post of QA-701: as it is, under another link, and with its feed's own "new development" mark
  const PIXEL = { author: '@tech', product: 'Pixel', issue_name: 'Pixel 10 battery swelling',
    summary: 'My Google Pixel 10 battery swelled and caught fire on the charger.' };
  const SAME_POST = rec('same_post', 'https://x.com/tech/status/10', Object.assign({ engagement: 2900 }, PIXEL));
  const SAME_POST_OTHER_LINK = rec('same_post_other_link', 'https://twitter.com/tech/status/10?s=20', Object.assign({ engagement: 2950 }, PIXEL));
  const SAME_POST_FLAGGED = rec('same_post_flagged', 'https://x.com/i/web/status/10', Object.assign({ engagement: 3100, new_development: true }, PIXEL));
  // Other posts on QA-701's issue with nothing new, and one with a new development the rules know by its words
  const sameIssue = (n, url, engagement) => rec(n, url, { author: `@${n}`, product: 'Pixel', issue_name: 'Pixel 10 battery swelling', engagement,
    summary: 'Seeing people talk about the Google Pixel 10 battery swelling issue today.' });
  const SAME_ISSUE = sameIssue('same_issue', 'https://x.com/other/status/11', 2400);
  const SAME_ISSUE_2 = sameIssue('same_issue_2', 'https://x.com/other2/status/21', 2450);
  const SAME_ISSUE_3 = sameIssue('same_issue_3', 'https://x.com/other3/status/31', 2500);
  const SAME_ISSUE_4 = sameIssue('same_issue_4', 'https://x.com/other4/status/41', 2550);
  const NEW_DEVELOPMENT = rec('new_development', 'https://x.com/news/status/12', { author: '@news', product: 'Pixel',
    issue_name: 'Pixel 10 battery swelling', engagement: 3200,
    summary: 'Breaking update: Google responded with an official statement and recall program for affected Pixel 10 batteries.' });
  // Posts on issues nobody alerted
  const FRESH = rec('fresh', 'https://x.com/fresh/status/13', { author: '@fresh', engagement: 2500, issue_name: 'Chrome tabs crashing',
    summary: 'Google Chrome keeps crashing my tabs.' });
  const FRESH_2 = rec('fresh_2', 'https://x.com/fresh2/status/14', { author: '@fresh2', engagement: 2600, issue_name: 'Gmail drafts vanish',
    summary: 'Gmail keeps losing my drafts since the Google update.' });
  const ONE_OFF = rec('one_off', 'https://x.com/u9/status/9', { author: '@u9', product: 'Workspace', issue_name: 'Gmail dark mode icon color',
    engagement: 90, summary: 'Gmail dark mode changed the settings icon shade slightly.' });
  // Five small posts by five people on QA-702's story, still only on X (no new development), and five on a new story
  const five = (prefix, issue, text) => [1, 2, 3, 4, 5].map(i => rec(`${prefix}${i}`, `https://x.com/${prefix}${i}/status/50${i}`, {
    author: `@${prefix}${i}`, issue_name: typeof issue === 'function' ? issue(i) : issue, engagement: 400 + i * 25, summary: text(i) }));
  const HELD_WAVE = five('held', 'Google Maps routing onto closed highway bridge',
    i => `Commuter ${i} says Google Maps still routes cars onto the closed highway bridge.`);
  const NEW_WAVE = five('wave', 'Google Photos deleting shared albums', i => `Person ${i} says Google Photos deleted a shared album.`);
  // The same two stories in words of their own each (only Gemini can group them)
  const HELD_TOLD = five('heldtold', i => ['Maps sent us into the river', 'Navigation app routing failure', 'Bridge closure ignored',
    'Commuters stranded by map directions', 'Wrong turn onto the closed bridge'][i - 1], i => `Driver ${i}: Google Maps sent me onto the closed bridge.`);
  const NEW_TOLD = five('newtold', i => ['My albums are gone', 'Photo library wiped', 'Shared album vanished', 'Backup lost pictures',
    'Missing family photos'][i - 1], i => `User ${i}: Google Photos lost my shared album.`);
  const DOODLE = rec('doodle', 'https://x.com/n1/status/207', { author: '@n1', engagement: 100, issue_name: 'Doodle', summary: 'Loved today\'s Google Doodle.' });

  // What Gemini answers in the cases that ask it. Its reference to an earlier alert is free text: QA-999 is made up.
  const STEP1_ANSWER = {
    solo_alerts: [
      { id: 'fresh', why_met_guidelines: 'A specific complaint about Chrome.' },
      { id: 'same_issue', why_met_guidelines: 'About the Pixel battery.', prior_alert_ref: 'QA-999' },
      { id: 'same_issue_3', why_met_guidelines: 'Engineers confirmed a pattern.', is_new_development: true, prior_alert_ref: 'QA-999',
        new_development_summary: 'Google engineers acknowledged the swelling pattern.' },
      { id: 'same_issue_4', why_met_guidelines: 'A regulator stepped in.', is_new_development: true, prior_alert_ref: 'QA-702',
        new_development_summary: 'A regulator opened a file on the swelling batteries.' },
      { id: 'new_development', why_met_guidelines: 'Google answered officially.' },
      { id: 'ghost', why_met_guidelines: 'Not one of the records.' },
    ],
    group_waves: [],
    discarded_ids: ['fresh_2', 'same_issue_2', 'same_post_flagged', 'ghost', 'slang'],
  };
  const WAVES_ANSWER = {
    solo_alerts: [{ id: 'fresh', why_met_guidelines: 'A specific complaint about Chrome.' }],
    group_waves: [
      { wave_title: 'Google Maps routing onto closed highway bridge', wave_summary: 'Drivers say Google Maps sends them onto a closed bridge.',
        member_ids: HELD_TOLD.map(r => r.id), platform_breakdown: [{ platform: 'Twitter', narrative: 'Drivers post dashcam clips.' }] },
      { wave_title: 'Google Photos loses shared albums', wave_summary: 'People say Google Photos lost their shared albums.',
        member_ids: NEW_TOLD.map(r => r.id).concat(['ghost']), platform_breakdown: [{ platform: 'Twitter', narrative: 'People list what is gone.' }] },
    ],
    discarded_ids: ['doodle'],
  };
  const STEP1_RECORDS = [SLANG, SAME_POST, SAME_POST_FLAGGED, SAME_ISSUE, SAME_ISSUE_2, SAME_ISSUE_3, SAME_ISSUE_4, NEW_DEVELOPMENT, FRESH, FRESH_2];
  const asks = answer => ({ analyzeBqRecords: () => (typeof answer === 'function' ? answer() : JSON.parse(JSON.stringify(answer))) });
  const withPriors = o => Object.assign({ priorAlerts: PRIORS }, o);

  /** The cases: name -> [records, opts]. The poll's call is Step 1 only (soloOnly); the others are the Dual-Track's. */
  const CASES = {
    'Step 1 only, the rules alone': [[SLANG, NFL, PROMO, SAME_POST, SAME_POST_OTHER_LINK, SAME_POST_FLAGGED, SAME_ISSUE, NEW_DEVELOPMENT,
      FRESH, ONE_OFF, 'not a record', null, Object.assign({}, FRESH_2, { id: 'fresh' })], withPriors({ soloOnly: true })],
    'Step 1 only, no earlier alerts': [[SLANG, NFL, SAME_POST, SAME_ISSUE, FRESH, ONE_OFF], { soloOnly: true }],
    'Step 1 only, Gemini answers': [STEP1_RECORDS, withPriors({ soloOnly: true, gemini: asks(STEP1_ANSWER) })],
    'Step 1 only, Gemini fails': [STEP1_RECORDS, withPriors({ soloOnly: true, gemini: asks(() => { throw new Error('Vertex 503'); }) })],
    'Step 1 only, Gemini answers something else': [STEP1_RECORDS, withPriors({ soloOnly: true, gemini: asks({ ok: true }) })],
    'Step 1 only, nothing passes the rules': [[SLANG, NFL, SAME_POST], withPriors({ soloOnly: true, gemini: asks(STEP1_ANSWER) })],
    'Step 1 only, no records': [[], withPriors({ soloOnly: true })],
    'Dual track, the rules alone': [[SLANG, NFL, FRESH, SAME_ISSUE, ONE_OFF].concat(HELD_WAVE, NEW_WAVE), withPriors(WAVES)],
    'Dual track, Gemini groups': [[FRESH, DOODLE, ONE_OFF].concat(HELD_TOLD, NEW_TOLD), withPriors(Object.assign({ gemini: asks(WAVES_ANSWER) }, WAVES))],
    'Waves only, a wave on a story already alerted': [HELD_WAVE, withPriors(Object.assign({ wavesOnly: true }, WAVES))],
  };
  const run = name => B.evaluateBqDualTrack_(CASES[name][0], null, CASES[name][1]);
  const before = out => ({ by: out.by, solo_alerts: out.solo_alerts, group_waves: out.group_waves, discarded_ids: out.discarded_ids });
  const leftOut = name => run(name).left_out.map(x => [x.id, x.why, x.alert_id, x.match]);

  test('Step 1 left out: the same inputs keep the same records as before the reasons were added: for every case (the poll\'s Step 1 with the rules alone, with Gemini answering, failing or answering something else, the Dual-Track with and without Gemini, waves only) solo_alerts, group_waves, discarded_ids and `by` are what they were at 3be2e06; the one new field is left_out, with an entry for each discarded id, in the same order', () => {
    if (process.env.BQ_STEP1_RECORD) {
      const made = {};
      Object.keys(CASES).forEach(name => { made[name] = H.plain(before(run(name))); });
      fs.writeFileSync(RECORD_FILE, JSON.stringify(made, null, 1) + '\n');
    }
    const record = JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8'));
    eq(Object.keys(record), Object.keys(CASES));
    Object.keys(CASES).forEach(name => {
      const out = run(name);
      eq([name, before(out)], [name, record[name]]);
      eq([name, Object.keys(out).sort()], [name, ['by', 'discarded_ids', 'group_waves', 'left_out', 'solo_alerts']]);
      eq([name, out.left_out.map(x => x.id)], [name, out.discarded_ids]);
      out.left_out.forEach(x => eq([name, Object.keys(x)], [name, ['id', 'why', 'alert_id', 'match']]));
    });
    // the record is no empty net: every case but the one with no records leaves something out, and most let something through
    const total = k => Object.keys(record).reduce((n, name) => n + record[name][k].length, 0);
    assert.ok(total('solo_alerts') >= 10 && total('group_waves') >= 2 && total('discarded_ids') >= 30,
      `${total('solo_alerts')} solo alerts, ${total('group_waves')} waves, ${total('discarded_ids')} discarded`);
    // no records at all, or none that is a record: nothing is left out
    eq([B.evaluateBqDualTrack_(null, null, { soloOnly: true }).left_out, B.evaluateBqDualTrack_(['x', 7, null], null, WAVES).left_out], [[], []]);
  });

  test('Step 1 left out: each reason in turn, with the earlier alert the code\'s own rule matched. Not about Google (slang, a feed that isn\'t about Google, an issue name the feed marks as noise): no alert. The post itself already alerted: that alert, by the post (under another link too, and when the feed marks it new but nothing says what is new). On an issue already alerted with nothing new: that alert, by the issue. Left out by Gemini: the reason is Gemini, with the alert the code\'s rule matches by post or by issue, or none. In the Dual-Track: a small post in no wave, and the posts of a wave on a story already alerted', () => {
    eq(H.plain(B.ev('BQ_LEFT_OUT_')), { NOT_GOOGLE: 'not_google', SAME_POST: 'same_post', GEMINI: 'gemini', SAME_ISSUE: 'same_issue', NO_WAVE: 'no_wave' });
    // The poll's call, the rules alone. A record given twice (the same id) is read once, and what is no record is passed over
    eq(leftOut('Step 1 only, the rules alone'), [
      ['slang', 'not_google', '', ''],
      ['nfl', 'not_google', '', ''],
      ['promo', 'not_google', '', ''],
      ['same_post', 'same_post', 'QA-701', 'post'],
      ['same_post_other_link', 'same_post', 'QA-701', 'post'],
      ['same_post_flagged', 'same_post', 'QA-701', 'post'],
      ['same_issue', 'same_issue', 'QA-701', 'issue'],
    ]);
    eq(run('Step 1 only, the rules alone').solo_alerts.map(s => [s.id, s.prior_alert_ref || '']),
      [['new_development', 'QA-701'], ['fresh', ''], ['one_off', '']]);
    // With no earlier alerts nothing can be a repeat: only the rules' "not about Google" is left
    eq(leftOut('Step 1 only, no earlier alerts'), [['slang', 'not_google', '', ''], ['nfl', 'not_google', '', '']]);
    // Gemini answers. What it discards is left out as Gemini's, and the alert beside it is the one the code's own rule
    // finds (by the post for the flagged repeat, by the issue for same_issue_2, none for fresh_2). An id it makes up
    // (ghost) and one the rules had left out already (slang) change nothing. A record it lets through on an alerted issue
    // without a new development is left out by the rules, against QA-701: never the QA-999 Gemini wrote
    eq(leftOut('Step 1 only, Gemini answers'), [
      ['slang', 'not_google', '', ''],
      ['same_post', 'same_post', 'QA-701', 'post'],
      ['same_post_flagged', 'gemini', 'QA-701', 'post'],
      ['same_issue', 'same_issue', 'QA-701', 'issue'],
      ['same_issue_2', 'gemini', 'QA-701', 'issue'],
      ['fresh_2', 'gemini', '', ''],
    ]);
    const said = run('Step 1 only, Gemini answers');
    eq(said.by, 'gemini');
    // ...and what it lets through with a new development names a real earlier alert: the one the rule matched, or the
    // one Gemini named when that is one of the earlier alerts
    eq(said.solo_alerts.map(s => [s.id, s.prior_alert_ref || '']),
      [['same_issue_3', 'QA-701'], ['same_issue_4', 'QA-702'], ['new_development', 'QA-701'], ['fresh', '']]);
    assert.ok(!JSON.stringify(said).includes('QA-999'), 'the reference Gemini made up');
    // Gemini failing, or answering something else: the rules alone, which name their own reason for each
    const RULES = [
      ['slang', 'not_google', '', ''],
      ['same_post', 'same_post', 'QA-701', 'post'],
      ['same_post_flagged', 'same_post', 'QA-701', 'post'],
      ['same_issue', 'same_issue', 'QA-701', 'issue'],
      ['same_issue_2', 'same_issue', 'QA-701', 'issue'],
      ['same_issue_3', 'same_issue', 'QA-701', 'issue'],
      ['same_issue_4', 'same_issue', 'QA-701', 'issue'],
    ];
    eq([leftOut('Step 1 only, Gemini fails'), leftOut('Step 1 only, Gemini answers something else')], [RULES, RULES]);
    eq([run('Step 1 only, Gemini fails').by, run('Step 1 only, Gemini answers something else').by], ['rules', 'rules']);
    // Nothing passes the rules: Gemini isn't asked, and every record has the rules' reason
    eq(leftOut('Step 1 only, nothing passes the rules'),
      [['slang', 'not_google', '', ''], ['nfl', 'not_google', '', ''], ['same_post', 'same_post', 'QA-701', 'post']]);
    eq(leftOut('Step 1 only, no records'), []);

    // The Dual-Track. A post under the Solo threshold that is in no wave; five posts whose wave is on QA-702's story with
    // nothing new: each left out against that alert, by the issue; the five of the new story make a wave
    const held = ids => ids.map(r => [r.id, 'same_issue', 'QA-702', 'issue']);
    eq(leftOut('Dual track, the rules alone'), [
      ['slang', 'not_google', '', ''],
      ['nfl', 'not_google', '', ''],
      ['same_issue', 'same_issue', 'QA-701', 'issue'],
      ['one_off', 'no_wave', '', ''],
    ].concat(held(HELD_WAVE)));
    eq([run('Dual track, the rules alone').solo_alerts.map(s => s.id), run('Dual track, the rules alone').group_waves.map(w => w.wave_title)],
      [['fresh'], ['Google Photos deleting shared albums']]);
    // Gemini groups posts worded differently: the wave it names after QA-702's story is held the same way
    eq(leftOut('Dual track, Gemini groups'), [['doodle', 'gemini', '', ''], ['one_off', 'no_wave', '', '']].concat(held(HELD_TOLD)));
    eq(run('Dual track, Gemini groups').group_waves.map(w => [w.wave_title, w.total_posts]), [['Google Photos loses shared albums', 5]]);
    eq(leftOut('Waves only, a wave on a story already alerted'), held(HELD_WAVE));
  });
};
