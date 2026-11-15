// The Head start tab (HeadStart.gs): this app's own alerts (Early Detection cards and early signals, Watch alerts,
// Direct BigQuery alerts) next to Burson's alerts and the IMs' Social Alert emails: who alerted a story first and by how
// much. It has no switch: poll() rebuilds it at the end of a run, at most every 10 minutes. It reads the Alert log and
// writes only its own tab.
'use strict';

module.exports = H => {
  const { test, eq, assert, B, NOW, world, e2e, F, TEST_FEED } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const TAB = 'Head start';
  const TITLE = B.ev('HEAD_START_TITLE_');
  const HEADER = ['Type', 'This app alerted (ET)', 'Story', 'Product', 'Exposure Tag', 'Burson alerted (ET)', 'Head start over Burson',
    'IMs emailed (ET)', 'Head start over the IMs', 'Matched on', 'App alert', 'Burson alert', 'Head start over Burson (min)',
    'Head start over the IMs (min)'];
  // The Alert log's `ingested` values, from the bot's own constants (never spelled out here)
  const ED = B.ev('ED_ALERT_INGESTED_');
  const WATCH = B.ev('PW_ALERT_INGESTED_');
  const DIRECT = B.ev('BQ_SOURCE_LABELS_');
  const EARLY = B.ev('EWS_WATCH_SIGNAL_');
  const MAIN = 'spaces/MIRROR > (isolated)';
  const AC = 'spaces/AAQAaa_0I9g > spaces/AUTOFIX' + B.ev('AC_PARTITION_SUFFIX_');
  const OTHERS = 'spaces/OTHERS > (isolated)' + B.ev('OS_PARTITION_SUFFIX_');
  const TAG = 'Product - Perceived bias';
  const ONGOING = B.ev('ONGOING_STATUS_SUFFIX_');
  const link = n => `https://x.com/user${n}/status/${70000 + n}`;
  const key = n => `x.com/status/${70000 + n}`;       // the post's record key (Alert.gs recordKey_)
  const postKey = n => `x:${70000 + n}`;              // the post on the Results tab (Speed.gs postKey_)
  /** An Alert-log row about post `n`, in the Mirror space unless `extra` says otherwise; `fields` go on forwarded_fields. */
  const row = (id, at, n, extra, fields) => Object.assign({
    alert_id: id, space: MAIN, source_at: at, created_at: at + MIN, record_key: key(n), status: 'ok', requested: [], email_status: '',
    decision: '', forwarded_fields: Object.assign({ post_url: link(n), social_network: 'X', author: `user${n}`, product: 'Search',
      exposure_tag: TAG, issue_name: `Issue ${n}` }, fields || {}),
  }, extra || {});
  const own = (id, at, n, ingested, fields, extra) => row(id, at, n, Object.assign({ ingested }, extra || {}), fields);
  const burson = (id, at, n, fields, extra) => row(id, at, n, extra, fields);
  const card = (id, at, n, snap, fields) => own(id, at, n, ED, Object.assign({ early_detection: snap || {} }, fields || {}));
  const report = (rows, im) => B.headStartReport_(rows, im === undefined ? null : im, NOW);
  const brief = s => [s.alert_id, s.type, s.matched, s.burson ? s.burson.alert_id : null, s.lead_ms === null ? null : s.lead_ms / MIN];
  // The owner's example: the card was posted on a Saturday at 11 PM ET, Burson's alert reached Google on Tuesday at 2 PM ET
  const SAT_11PM = Date.UTC(2026, 9, 11, 3, 0);
  const TUE_2PM = Date.UTC(2026, 9, 13, 18, 0);

  const sheetOf = w => w.g.services.SpreadsheetApp.create('bot');
  const tabOf = ss => ss.getSheetByName(TAB);
  const at = (tab, label) => tab.rows.findIndex(x => x[0] === label || String(x[0]).indexOf(label) === 0);
  const line = (tab, label) => (tab.rows.find(x => x[0] === label) || []).slice(1, 3);
  /** The stories under a section's header row, as {column name: cell}. */
  const table = (tab, section) => {
    const head = at(tab, section) + 1;
    const out = [];
    for (let i = head + 1; i < tab.rows.length && tab.rows[i][0] !== '' && tab.rows[i][0] !== 'None yet'; i++) {
      out.push(Object.fromEntries(HEADER.map((h, j) => [h, tab.rows[i][j]])));
    }
    return out;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // What's an own alert, a story, a Burson alert
  // ---------------------------------------------------------------------------------------------------------------

  test('head start: an own alert is a row whose `ingested` is the Early Detection value, the Watch alert value or a Direct BigQuery source label (its type says which; an early-watch signal is an "Early signal"); Burson\'s rows, another tool\'s alerts and sheet test alerts are not', () => {
    const rows = [
      card('QA-1', NOW - 6 * HOUR, 1),
      card('QA-2', NOW - 5 * HOUR, 2, { signal_type: EARLY }),
      card('QA-3', NOW - 4.5 * HOUR, 3, { signal_type: 'VELOCITY_SPIKE' }),
      own('QA-4', NOW - 4 * HOUR, 4, WATCH),
      own('QA-5', NOW - 3 * HOUR, 5, DIRECT.SPRINKLR),
      own('QA-6', NOW - 2.5 * HOUR, 6, DIRECT.BMIE),
      own('QA-7', NOW - 2 * HOUR, 7, DIRECT.BSIP),
      own('QA-8', NOW - 90 * MIN, 8, B.ev('OTHER_INGESTED_'), null, { space: OTHERS }),
      own('QA-9', NOW - 80 * MIN, 9, B.ev('SHEET_TEST_INGESTED_')),
      own('QA-10', NOW - 70 * MIN, 10, 'Some later source'),
      burson('QA-11', NOW - HOUR, 11),
    ];
    const r = report(rows);
    eq(r.stories.map(s => [s.alert_id, s.type]), [['QA-7', 'Direct (BSIP)'], ['QA-6', 'Direct (BMIE)'], ['QA-5', 'Direct (Sprinklr)'],
      ['QA-4', 'Watch'], ['QA-3', 'Early Detection'], ['QA-2', 'Early signal'], ['QA-1', 'Early Detection']]);
    eq(rows.map(B.headStartOwnType_), ['Early Detection', 'Early signal', 'Early Detection', 'Watch', 'Direct (Sprinklr)', 'Direct (BMIE)',
      'Direct (BSIP)', '', '', '', '']);
    // neither this app's nor Burson's: the other tool's alert and the sheet test alert are in neither count
    eq([r.windows.week.stories, r.windows.week.burson_alerts, r.windows.week.unmatched], [7, 1, 7]);
    // the time is when the alert was posted (source_at: an own card's own post time in Chat), else when its row was written
    const timed = report([Object.assign(card('QA-20', NOW - HOUR, 20), { source_at: '', created_at: NOW - 50 * MIN }),
      Object.assign(card('QA-21', NOW - HOUR, 21), { source_at: 0, created_at: '' })]);
    eq(timed.stories.map(s => [s.alert_id, s.at]), [['QA-20', NOW - 50 * MIN]]);  // a row with no time at all is left out
  });

  test('head start: Burson\'s alerts are exactly the rows ProactiveWatch.gs pwBursonTimes_ counts (a link, a blank `ingested`, not the Other alerts space, a recorded time), timed at the earliest row of the post', () => {
    const rows = [
      burson('QA-1', NOW - 3 * HOUR, 1),
      burson('QA-2', NOW - 3 * HOUR - 40 * 1000, 1, null, { space: AC }),  // the same post in the auto-correct space, seconds earlier
      burson('QA-3', NOW - 2 * HOUR, 2, null, { space: OTHERS }),           // the Other alerts space's: not Burson's
      burson('QA-4', NOW - 2 * HOUR, 3, null, { record_key: '' }),          // no link
      burson('QA-5', NOW - 2 * HOUR, 4, null, { source_at: 0 }),            // from before the time was recorded
      burson('QA-6', NOW - HOUR, 5, null, { ingested: '' }),
      own('QA-7', NOW - HOUR, 6, DIRECT.SPRINKLR),
      own('QA-8', NOW - HOUR, 7, B.ev('OTHER_INGESTED_')),
      // on the first post too, and earlier, but not Burson's: the Other alerts space's copy, this app's own alert, an untimed row
      burson('QA-9', NOW - 5 * HOUR, 1, { issue_name: 'Another tool\'s alert' }, { space: OTHERS }),
      own('QA-10', NOW - 6 * HOUR, 1, WATCH, { issue_name: 'This app\'s own alert' }),
      burson('QA-12', NOW - 7 * HOUR, 1, { issue_name: 'Untimed' }, { source_at: '' }),
    ];
    const theirs = Array.from(B.headStartBurson_(rows).values());
    eq(Object.fromEntries(theirs.map(g => [g.key, g.at])), B.pwBursonTimes_(rows));
    eq(theirs.map(g => [g.key, g.at, g.alert_id, g.name, g.rows.map(x => x.id)]),
      [[key(1), NOW - 3 * HOUR - 40 * 1000, 'QA-2', 'Issue 1', ['QA-2', 'QA-1']], [key(5), NOW - HOUR, 'QA-6', 'Issue 5', ['QA-6']]]);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Ahead of Burson, behind Burson, not alerted by Burson
  // ---------------------------------------------------------------------------------------------------------------

  test('head start: an own alert ahead of Burson on the same post (the card on Saturday at 11 PM, Burson\'s alert on Tuesday afternoon: "2 d 15 h"), one behind Burson ("behind by 20 min"), and one Burson never alerted (blank cells, never a zero)', () => {
    const rows = [
      // the card rests on three posts; Burson alerted the second of them (in both test spaces: the earliest row counts)
      card('QA-1', SAT_11PM, 1, { post_keys: [key(1), key(2), key(3)], story_title: 'Malware apps on the Play Store' },
        { issue_name: 'Banking malware in Play Store apps', product: 'Play Store' }),
      burson('QA-2', TUE_2PM + 30 * 1000, 2),
      burson('QA-3', TUE_2PM, 2, null, { space: AC }),
      own('QA-4', NOW - 20 * HOUR, 4, WATCH),
      burson('QA-5', NOW - 20 * HOUR - 20 * MIN, 4),
      own('QA-6', NOW - 2 * HOUR, 6, DIRECT.SPRINKLR),
    ];
    const r = report(rows);
    eq(r.stories.map(brief), [['QA-6', 'Direct (Sprinklr)', '', null, null], ['QA-4', 'Watch', 'same post', 'QA-5', -20],
      ['QA-1', 'Early Detection', 'same post', 'QA-3', 63 * 60]]);
    eq(r.stories[2].burson, { key: key(2), at: TUE_2PM, alert_id: 'QA-3', url: link(2), name: 'Issue 2' });
    eq(r.top.map(s => s.alert_id), ['QA-1']);  // only the stories this app alerted first
    const w = r.windows.week;
    eq([w.stories, w.matched, w.matched_pct, w.first, w.first_pct, w.first_median_min, w.behind, w.behind_median_min, w.unmatched],
      [3, 2, 67, 1, 50, 3780, 1, 20, 1]);
    eq([w.burson_alerts, w.burson_after, w.burson_after_pct, w.burson_after_by], [2, 1, 50, { post: 1, story: 0, wording: 0 }]);

    const out = B.headStartTabRows_(r).rows;
    const head = out.findIndex(x => String(x[0]).indexOf('EVERY STORY') === 0) + 1;
    eq(out[head], HEADER);
    eq(out.slice(head + 1), [
      ['Direct (Sprinklr)', B.speedTime_(NOW - 2 * HOUR), `=HYPERLINK("${link(6)}","Issue 6")`, 'Search', TAG, '', '', '', '', '', 'QA-6', '', '', ''],
      ['Watch', B.speedTime_(NOW - 20 * HOUR), `=HYPERLINK("${link(4)}","Issue 4")`, 'Search', TAG, B.speedTime_(NOW - 20 * HOUR - 20 * MIN),
        'behind by 20 min', '', '', 'same post', 'QA-4', `=HYPERLINK("${link(4)}","QA-5")`, -20, ''],
      ['Early Detection', '2026-10-10 23:00', `=HYPERLINK("${link(1)}","Banking malware in Play Store apps")`, 'Play Store', TAG,
        '2026-10-13 14:00', '2 d 15 h', '', '', 'same post', 'QA-1', `=HYPERLINK("${link(2)}","QA-3")`, 3780, ''],
    ]);
    assert.ok(!out.slice(head + 1).some(x => x.slice(5, 9).concat(x.slice(12)).some(v => v === 0)), 'never a zero for a missing time');
  });

  test('head start: a length of time in words: minutes, hours and minutes, days and hours; "behind by" when this app was later; nothing for none', () => {
    eq([45, 190, 3780, -20, 60, 24 * 60, 59.6, 0.4, -0.4, 0, 2 * 24 * 60 + 29, null, undefined, '', 'soon'].map(B.headStartWords_),
      ['45 min', '3 h 10 min', '2 d 15 h', 'behind by 20 min', '1 h', '1 d', '1 h', 'under 1 min', 'behind by under 1 min', 'the same minute',
        '2 d', '', '', '', '']);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Stories: an update joins its card; own alerts on the same post are one story
  // ---------------------------------------------------------------------------------------------------------------

  test('head start: an update folds into its story: the cards that update an earlier card (by its Alert-log id, or its BigQuery alert id) and own alerts on the same post count once, timed from the earliest; Burson\'s alert on an update\'s post is measured from the first card', () => {
    const T = NOW - 3 * DAY;
    const rows = [
      card('QA-1', T, 1, { ed_alert_id: 'ed-first', post_keys: [key(1)], update_of: '' }, { issue_name: 'Fake Chrome update installs spyware' }),
      card('QA-2', T + 5 * HOUR, 2, { ed_alert_id: 'ed-second', post_keys: [key(2), key(12)], update_of: 'QA-1' }),
      card('QA-3', T + 9 * HOUR, 3, { ed_alert_id: 'ed-third', post_keys: [key(3)], update_of: 'ed-second' }),
      burson('QA-4', T + 10 * HOUR, 12),  // one of the first update's posts
      // the same post alerted by this app in both test spaces: one story
      own('QA-5', NOW - 30 * HOUR, 5, DIRECT.SPRINKLR),
      own('QA-6', NOW - 30 * HOUR + MIN, 5, DIRECT.SPRINKLR, null, { space: AC }),
      // an update of a card that is no longer among the rows read: a story of its own
      card('QA-7', NOW - 3 * HOUR, 7, { update_of: 'QA-0' }),
      // a Watch alert on one of an Early Detection card's posts: the same story as that card
      card('QA-8', NOW - 12 * HOUR, 8, { post_keys: [key(8), key(9)] }),
      own('QA-9', NOW - 10 * HOUR, 9, WATCH),
    ];
    const r = report(rows);
    eq(r.stories.map(s => [s.alert_id, s.type, s.alert_ids, s.alerts, s.at, s.keys]), [
      ['QA-7', 'Early Detection', ['QA-7'], 1, NOW - 3 * HOUR, [key(7)]],
      ['QA-8', 'Early Detection', ['QA-8', 'QA-9'], 2, NOW - 12 * HOUR, [key(8), key(9)]],
      ['QA-5', 'Direct (Sprinklr)', ['QA-5', 'QA-6'], 2, NOW - 30 * HOUR, [key(5)]],
      ['QA-1', 'Early Detection', ['QA-1', 'QA-2', 'QA-3'], 3, T, [key(1), key(2), key(12), key(3)]],
    ]);
    eq(brief(r.stories[3]), ['QA-1', 'Early Detection', 'same post', 'QA-4', 10 * 60]);  // from the first card, not the update
    eq([r.stories[3].name, r.windows.week.stories, r.windows.week.matched], ['Fake Chrome update installs spyware', 4, 1]);
    eq(B.headStartTabRows_(r).rows.filter(x => x[10] === 'QA-1, QA-2, QA-3').length, 2);  // BIGGEST HEAD STARTS and EVERY STORY
    // an Early Detection card keeps 8 post keys at most
    const many = report([card('QA-1', T, 1, { post_keys: Array.from({ length: 12 }, (x, i) => key(100 + i)) })]);
    eq(many.stories[0].keys.length, 9);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The same story on another post
  // ---------------------------------------------------------------------------------------------------------------

  test('head start: the same-story rule: Burson\'s alert on another post carries the story\'s exact issue name and the later of the two is an Ongoing Issue (what a review records when it takes an alert for an issue already alerted): "same story", either way round, within 14 days', () => {
    const T = NOW - 5 * DAY;
    const NAME = 'Banking malware in Play Store apps';
    const story = fields => card('QA-1', T, 1, { post_keys: [key(1)] }, Object.assign({ issue_name: NAME }, fields || {}));
    const match = rows => brief(report(rows).stories.find(s => s.alert_id === 'QA-1'));
    // Burson's alert on another post, under another exposure tag (so the two are not alike in wording by the weaker rule)
    const theirs = (at, name, status) => burson('QA-2', at, 2, Object.assign({ issue_name: name, exposure_tag: 'Another tag' },
      status ? { issue_status: status } : {}));
    // Burson two days later, as an Ongoing Issue under the story's name (however it is written)
    eq(match([story(), theirs(T + 2 * DAY, 'banking  malware in Play Store apps', ONGOING)]),
      ['QA-1', 'Early Detection', 'same story', 'QA-2', 2 * 24 * 60]);
    eq(match([story(), theirs(T + 2 * DAY, `${NAME} / ${ONGOING}`, 'ongoing issue')])[2], 'same story');
    // the same name, but Burson's later alert is still New (or says nothing): no review took it for this story
    eq(match([story(), theirs(T + 2 * DAY, NAME, 'NEW')]), ['QA-1', 'Early Detection', '', null, null]);
    eq(match([story(), theirs(T + 2 * DAY, NAME, '')])[2], '');
    // Burson first, and this app's later alert is the Ongoing Issue under Burson's name: the same story, this app behind
    eq(match([story({ issue_status: ONGOING }), theirs(T - 6 * HOUR, NAME, 'NEW')]), ['QA-1', 'Early Detection', 'same story', 'QA-2', -6 * 60]);
    // ... but not when only Burson's EARLIER alert says Ongoing (it was ongoing about something older)
    eq(match([story(), theirs(T - 6 * HOUR, NAME, ONGOING)])[2], '');
    // 14 days either side of the story, no further
    const far = d => match([story(), theirs(T + d, NAME, ONGOING)])[2];
    eq([far(14 * DAY), far(14 * DAY + MIN), far(-14 * DAY - MIN)], ['same story', '', '']);
    // another name: not the same story
    eq(match([story(), theirs(T + DAY, 'Play Store refund delays', ONGOING)])[2], '');
    // the issue's name is on an update of the story: still the story's, measured from its first card
    eq(match([story({ issue_name: 'Suspicious apps' }), card('QA-3', T + HOUR, 3, { update_of: 'QA-1' }, { issue_name: NAME }),
      theirs(T + DAY, NAME, ONGOING)]), ['QA-1', 'Early Detection', 'same story', 'QA-2', 24 * 60]);
  });

  test('head start: the same-story rule, weaker: the Alert memory\'s word check (the same exposure tag, issue words alike, no clashing identifiers) is labelled "same story (similar wording)"; the rules apply in order (same post, same story, similar wording) and the earliest of Burson\'s alerts counts; nothing is asked of the Alert memory and nothing is embedded', () => {
    const T = NOW - 5 * DAY;
    const story = (name, fields) => card('QA-1', T, 1, { post_keys: [key(1)] }, Object.assign({ issue_name: name }, fields || {}));
    const match = rows => brief(report(rows).stories.find(s => s.alert_id === 'QA-1'));
    const OWN = 'Banking malware in Play Store apps';
    const ALIKE = 'Malware found in Play Store banking apps';
    const SIMILAR = 'same story (similar wording)';
    const theirs = (at, name, fields) => burson('QA-2', at, 2, Object.assign({ issue_name: name }, fields || {}));
    eq(B.jaccard_(B.issueTokens_(OWN), B.issueTokens_(ALIKE)) >= B.ev('GEN').novelty_min_jaccard, true);
    eq(match([story(OWN), theirs(T + 3 * DAY, ALIKE)]), ['QA-1', 'Early Detection', SIMILAR, 'QA-2', 3 * 24 * 60]);
    eq(match([story(OWN), theirs(T - 2 * HOUR, ALIKE)]), ['QA-1', 'Early Detection', SIMILAR, 'QA-2', -120]);
    // not alike enough; another exposure tag; identifiers that clash (two different CVEs); more than 14 days away
    eq(match([story(OWN), theirs(T + DAY, 'Play Store malware steals banking logins')])[2], '');
    eq(match([story(OWN), theirs(T + DAY, ALIKE, { exposure_tag: 'Product - Security or privacy vulnerabilities' })])[2], '');
    eq(match([story('CVE-2026-11111 exploited in Chrome'), theirs(T + DAY, 'CVE-2026-22222 exploited in Chrome')])[2], '');
    eq(match([story('CVE-2026-11111 exploited in Chrome'), theirs(T + DAY, 'CVE-2026-11111 exploited in Chrome browsers')])[2], SIMILAR);
    eq(match([story(OWN), theirs(T + 15 * DAY, ALIKE)])[2], '');
    // the product is part of the story's view, but the memory's check doesn't compare products: another product still matches
    eq(match([story(OWN), theirs(T + DAY, ALIKE, { product: 'Play Store' })])[2], SIMILAR);
    // it is the memory's own check, on the same view of a story
    const view = name => B.headStartRowFacts_(burson('QA-9', T, 9, { issue_name: name })).view;
    eq([B.amSameStoryWords_(view(OWN), view(ALIKE)) > 0, B.amSameStoryWords_(view(OWN), view('Play Store malware steals banking logins'))], [true, 0]);
    eq(view(OWN), { tag: TAG, prod: 'Search', tok: B.issueTokens_(OWN), idt: { c: [], n: [], a: [] } });
    // ... built from the issue name, the exposure tag and the product: nothing else on the row is read for it
    eq(B.headStartRowFacts_(burson('QA-9', T, 9, { issue_name: OWN, summary: 'CVE-2026-33333 and @someone, 123456 times' })).view, view(OWN));
    eq(B.headStartRowFacts_(burson('QA-9', T, 9, { issue_name: 'the issue of a claim' })).view, null);  // no words to compare: never matched on wording

    // In order: the same post wins over an earlier same-story alert, the same story over an earlier alert alike in
    // wording; within a rule, the earliest of Burson's alerts
    const rows = [
      story(OWN, { post_url: link(1) }),
      burson('QA-2', T + 4 * DAY, 1),                                                   // the same post, four days on
      burson('QA-3', T + 2 * DAY, 3, { issue_name: OWN, issue_status: ONGOING }),       // the same story, two days on
      burson('QA-4', T + 3 * DAY, 4, { issue_name: OWN, issue_status: ONGOING }),
      burson('QA-5', T + DAY, 5, { issue_name: ALIKE }),                                // alike in wording, a day on
      burson('QA-6', T + 6 * HOUR, 6, { issue_name: ALIKE }),
    ];
    eq(match(rows), ['QA-1', 'Early Detection', 'same post', 'QA-2', 4 * 24 * 60]);
    eq(match(rows.filter(x => x.alert_id !== 'QA-2')), ['QA-1', 'Early Detection', 'same story', 'QA-3', 2 * 24 * 60]);
    eq(match(rows.filter(x => !['QA-2', 'QA-3', 'QA-4'].includes(x.alert_id))), ['QA-1', 'Early Detection', SIMILAR, 'QA-6', 6 * 60]);
    // the reverse view: every one of Burson's alerts this app's story came before, by the surest rule that holds
    const w = report(rows).windows.week;
    eq([w.burson_alerts, w.burson_after, w.burson_after_pct, w.burson_after_by], [5, 5, 100, { post: 1, story: 2, wording: 2 }]);

    // The Alert memory is never asked, no text is embedded, nothing is fetched or written
    const world1 = world();
    const calls = [];
    world1.bot.alertMemory_ = () => { calls.push('memory'); throw new Error('the report must not ask the Alert memory'); };
    world1.bot.embedTexts_ = () => { calls.push('embed'); throw new Error('the report must not embed text'); };
    const ss = sheetOf(world1);
    const before = [world1.g.fetches.length, world1.vertex.calls.length];
    const out = world1.bot.refreshHeadStart_(ss, { now: NOW, alerts: rows });
    eq([out.written, calls, world1.g.fetches.length, world1.vertex.calls.length, ss.getSheets().map(s => s.getName())],
      [true, [], before[0], before[1], ['Sheet1', TAB]]);
  });

  test('head start: the word check is only run on Burson\'s alerts that share a word of the name under the same tag, and that shortcut never changes a match: the same stories and the same reverse view as the memory\'s check on every pair', () => {
    const words = ['malware', 'outage', 'bias', 'privacy', 'leak', 'refund', 'crash', 'scam', 'lawsuit', 'gemini', 'pixel', 'chrome', 'play',
      'store', 'maps', 'login'];
    let seed = 11;
    const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
    const named = () => ({ issue_name: Array.from({ length: 3 + rnd(3) }, () => words[rnd(words.length)]).join(' '),
      exposure_tag: [TAG, 'Product - Security or privacy vulnerabilities'][rnd(2)] });
    const rows = [];
    for (let i = 0; i < 80; i++) rows.push(own(`QA-o${i}`, NOW - rnd(40 * 24) * HOUR - i * 1000, 1000 + i, WATCH, named()));
    for (let i = 0; i < 500; i++) rows.push(burson(`QA-b${i}`, NOW - rnd(44 * 24) * HOUR - i * 977, 5000 + i, named()));
    // every pair, by the memory's own check (no post is shared and no alert is an Ongoing Issue: only wording can match)
    const view = x => B.headStartRowFacts_(x).view;
    const ours = rows.filter(x => x.ingested).map(x => ({ id: x.alert_id, at: x.source_at, view: view(x) }));
    const theirs = rows.filter(x => !x.ingested).map(x => ({ id: x.alert_id, at: x.source_at, view: view(x) }));
    const alike = (o, b) => Math.abs(b.at - o.at) <= 14 * DAY && B.amSameStoryWords_(o.view, b.view) > 0;
    const expected = ours.filter(o => o.at >= NOW - 30 * DAY).sort((x, y) => y.at - x.at).map(o => {
      const hits = theirs.filter(b => alike(o, b)).sort((x, y) => x.at - y.at);
      return [o.id, hits.length ? hits[0].id : null];
    });
    const after = theirs.filter(b => b.at >= NOW - 30 * DAY && ours.some(o => o.at < b.at && alike(o, b))).length;
    const r = B.headStartReport_(rows, null, NOW);
    eq(r.stories.map(s => [s.alert_id, s.burson ? s.burson.alert_id : null]), expected);
    eq(r.stories.filter(s => s.burson).every(s => s.matched === 'same story (similar wording)'), true);
    eq([r.windows.month.burson_after, r.windows.month.burson_after_by], [after, { post: 0, story: 0, wording: after }]);
    assert.ok(expected.filter(x => x[1]).length >= 10 && expected.filter(x => !x[1]).length >= 10 && after >= 10, JSON.stringify([expected.length, after]));
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The IMs' email
  // ---------------------------------------------------------------------------------------------------------------

  test('head start: IM times present and absent: the IMs\' time for the matched Burson post (their email, else their draft, by the post\'s key on the Results tab) gives the end-to-end head start; absent, the IM columns are blank and the tab says why', () => {
    const T = NOW - 2 * DAY;
    const rows = [
      own('QA-1', T, 1, DIRECT.SPRINKLR), burson('QA-2', T + 2 * HOUR, 1),            // the IMs emailed 3 h 10 min after this app's alert
      own('QA-3', T + HOUR, 3, WATCH), burson('QA-4', T + 3 * HOUR, 3),               // only their draft is known
      own('QA-5', T + 2 * HOUR, 5, WATCH), burson('QA-6', T + HOUR, 5),               // the IMs emailed before this app alerted
      own('QA-7', T + 3 * HOUR, 7, WATCH), burson('QA-8', T + 4 * HOUR, 7),           // no IM time for this post
      own('QA-9', T + 4 * HOUR, 9, WATCH),                                            // no Burson alert: no post to look the IMs up by
    ];
    const im = { [postKey(1)]: { at: T + 190 * MIN, from: 'email' }, [postKey(3)]: { at: T + 4 * HOUR, from: 'draft' },
      [postKey(5)]: { at: T + 90 * MIN, from: 'email' }, [postKey(9)]: { at: T + 5 * HOUR, from: 'email' } };
    const r = report(rows, im);
    eq(r.stories.map(s => [s.alert_id, s.im, s.im_lead_ms === null ? null : s.im_lead_ms / MIN]), [
      ['QA-9', null, null], ['QA-7', null, null], ['QA-5', { at: T + 90 * MIN, from: 'email' }, -30],
      ['QA-3', { at: T + 4 * HOUR, from: 'draft' }, 180], ['QA-1', { at: T + 190 * MIN, from: 'email' }, 190]]);
    const w = r.windows.week;
    eq([r.im_at_hand, w.im_known, w.im_first, w.im_first_pct, w.im_median_min, w.im_from_email], [true, 3, 2, 67, 180, 2]);
    const cells = x => B.headStartTabRows_(x).rows.filter(c => /^QA-\d$/.test(String(c[10]))).slice(-5).map(c => [c[10], c[7], c[8], c[13]]);
    eq(cells(r), [['QA-9', '', '', ''], ['QA-7', '', '', ''], ['QA-5', B.speedTime_(T + 90 * MIN), 'behind by 30 min', -30],
      ['QA-3', B.speedTime_(T + 4 * HOUR), '3 h', 180], ['QA-1', B.speedTime_(T + 190 * MIN), '3 h 10 min', 190]]);
    const note = x => B.headStartTabRows_(x).rows.map(c => c[0]).find(c => String(c).indexOf('Matched on:') === 0);
    assert.match(note(r), /The IMs' time is their email for Burson's post, else their draft, as the Results tab has it \(their email for 2 of 3 in the last 30 days\)/);

    // Absent: every IM cell blank (never a zero), the numbers say none, the note says why
    const none = report(rows);
    eq([none.im_at_hand, none.stories.map(s => [s.im, s.im_lead_ms]), cells(none).map(c => c.slice(1))],
      [false, rows.filter(x => x.ingested).map(() => [null, null]), rows.filter(x => x.ingested).map(() => ['', '', ''])]);
    eq([none.windows.week.im_known, none.windows.week.im_first, none.windows.week.im_first_pct, none.windows.week.im_median_min], [0, 0, null, null]);
    assert.match(note(none), /The IMs' times weren't at hand for this rebuild \(they come with the Results tab's rebuild in the every-minute run\), so those columns are blank\.$/);
    const lines = B.headStartTabRows_(none).rows;
    eq(['This app\'s alert before the IMs\' email (of the stories with an IM email time)',
      'Median time from this app\'s alert to the IMs\' email (the end-to-end head start)'].map(label => lines.find(c => c[0] === label).slice(1, 3)),
    [['—', '—'], ['—', '—']]);
  });

  test('head start: the IMs\' times come from the Results rebuild of the same run and from nowhere else: their email or draft for Burson\'s post as that rebuild has it, never the bot\'s own draft, and none when the Results tab wasn\'t rebuilt in this run (no Gmail search, no BigQuery read)', () => {
    const w = world();
    const ss = sheetOf(w);
    const T = NOW - 2 * DAY;
    const rows = [
      own('QA-1', T, 1, DIRECT.SPRINKLR), burson('QA-2', T + 2 * HOUR, 1),
      own('QA-3', T + HOUR, 3, WATCH), burson('QA-4', T + 3 * HOUR, 3),
    ];
    const flows = { main: { partition: MAIN, label: 'Mirror space', live: false }, ac: null };
    // the IMs drafted a Social Alert for the first post half an hour after Burson's alert; the second post's draft is the bot's own
    const drafts = () => [
      { post_url: link(1), at: T + 150 * MIN, subject: '⭐ SOCIAL ALERT ⭐: Search | Issue 1 | X | 900 Engagements', drafted_by: 'im1@ops.test' },
      { post_url: link(3), at: T + 200 * MIN, subject: '⭐ SOCIAL ALERT ⭐: Search | Issue 3 | X | 900 Engagements', drafted_by: B.ev('RESULTS_BOT_MARK_') },
    ];
    eq(w.bot.ev('RESULTS_RUN_'), null);
    const run = extra => w.bot.maybeRefreshHeadStart_(ss, w.ctx(), Object.assign({ deadline: w.g.clock.now + 4 * MIN, runStart: w.g.clock.now }, extra || {}));
    const stories = () => table(tabOf(ss), 'EVERY STORY').map(x => [x['App alert'], x['Burson alerted (ET)'], x['IMs emailed (ET)'],
      x['Head start over the IMs'], x['Head start over the IMs (min)']]);
    const store = w.bot.sheetBackend_(ss);  // the Alert log, as poll() leaves it
    rows.forEach(x => store.appendAlert(x));

    // The first rebuild, in a run without a Results rebuild: no IM times
    eq([run(), stories()], [true, [['QA-3', B.speedTime_(T + 3 * HOUR), '', '', ''], ['QA-1', B.speedTime_(T + 2 * HOUR), '', '', '']]]);
    // Ten minutes on, the Results tab is rebuilt in the same run: its posts carry the IMs' time
    w.g.clock.now += 10 * MIN;
    w.bot.refreshSpeed_(ss, w.ctx(), { alerts: rows, drafts, logged: () => [], flows });
    eq(w.bot.ev('RESULTS_RUN_.posts.map(p => [p.key, speedImAt_(p)])'), [[postKey(3), null], [postKey(1), T + 150 * MIN]]);
    eq(B.headStartImTimes_(w.bot.ev('RESULTS_RUN_.posts')), { [postKey(1)]: { at: T + 150 * MIN, from: 'draft' } });
    const fetches = w.g.fetches.length;  // every request the bot makes (Chat, Gmail, BigQuery, Gemini) goes through here
    eq([run(), stories(), w.g.fetches.length], [true, [['QA-3', B.speedTime_(T + 3 * HOUR), '', '', ''],
      ['QA-1', B.speedTime_(T + 2 * HOUR), B.speedTime_(T + 150 * MIN), '2 h 30 min', 150]], fetches]);
    // their email, once the Results tab knows it, replaces their draft; a post without a key or a time gives nothing
    eq(B.headStartImTimes_([{ key: postKey(1), im_email_at: T + 170 * MIN, im_draft: { at: T + 150 * MIN } }, { key: '', im_email_at: T },
      { key: postKey(3), im_draft: null, im_email_at: null }, null]), { [postKey(1)]: { at: T + 170 * MIN, from: 'email' } });
    // A later run without a Results rebuild: that earlier rebuild's posts are not this run's
    w.g.clock.now += 20 * MIN;
    eq([w.bot.headStartResultsRun_(w.g.clock.now, w.g.clock.now), run(), stories().map(x => x.slice(2))], [null, true, [['', '', ''], ['', '', '']]]);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The numbers
  // ---------------------------------------------------------------------------------------------------------------

  test('head start: the 7-day and 30-day numbers, by when this app alerted: stories, those Burson alerted too, this app first and Burson first with their medians and shares, not alerted by Burson, before the IMs\' email with its median, and the reverse view of Burson\'s alerts', () => {
    const rows = [
      own('QA-1', NOW - 2 * DAY, 1, WATCH), burson('QA-2', NOW - 2 * DAY + 3 * HOUR, 1),          // first by 180 min
      card('QA-3', NOW - 3 * DAY, 3), burson('QA-4', NOW - 3 * DAY + HOUR, 3),                     // first by 60 min
      own('QA-5', NOW - 4 * DAY, 5, DIRECT.BSIP), burson('QA-6', NOW - 4 * DAY - 30 * MIN, 5),     // behind by 30 min
      own('QA-7', NOW - 5 * DAY, 7, WATCH),                                                        // not alerted by Burson
      card('QA-8', NOW - 10 * DAY, 8), burson('QA-9', NOW - 8 * DAY, 8),                           // first by 2 days (30 days only)
      own('QA-10', NOW - 20 * DAY, 10, WATCH), burson('QA-11', NOW - 20 * DAY - 2 * HOUR, 10),     // behind by 120 min (30 days only)
      own('QA-12', NOW - 40 * DAY, 12, WATCH), burson('QA-13', NOW - 39 * DAY, 12),                // older than 30 days: in neither
      burson('QA-14', NOW - DAY, 14),                                                              // an alert only Burson had
    ];
    const im = { [postKey(1)]: { at: NOW - 2 * DAY + 5 * HOUR, from: 'email' }, [postKey(5)]: { at: NOW - 4 * DAY - 10 * MIN, from: 'draft' },
      [postKey(8)]: { at: NOW - 7 * DAY, from: 'email' } };
    const r = report(rows, im);
    eq(r.stories.map(s => s.alert_id), ['QA-1', 'QA-3', 'QA-5', 'QA-7', 'QA-8', 'QA-10']);  // the last 30 days, newest first
    eq(r.windows.week, {
      stories: 4, matched: 3, matched_pct: 75, first: 2, first_pct: 67, first_median_min: 120, behind: 1, behind_median_min: 30, unmatched: 1,
      im_known: 2, im_first: 1, im_first_pct: 50, im_median_min: 145, im_from_email: 1,
      burson_alerts: 4, burson_after: 2, burson_after_pct: 50, burson_after_by: { post: 2, story: 0, wording: 0 },
    });
    eq(r.windows.month, {
      stories: 6, matched: 5, matched_pct: 83, first: 3, first_pct: 60, first_median_min: 180, behind: 2, behind_median_min: 75, unmatched: 1,
      im_known: 3, im_first: 2, im_first_pct: 67, im_median_min: 300, im_from_email: 2,
      burson_alerts: 6, burson_after: 3, burson_after_pct: 50, burson_after_by: { post: 3, story: 0, wording: 0 },
    });
    eq(r.top.map(s => [s.alert_id, s.lead_ms / MIN]), [['QA-8', 2880], ['QA-1', 180], ['QA-3', 60]]);  // the longest head start first

    const w = world();
    const ss = sheetOf(w);
    w.bot.refreshHeadStart_(ss, { now: NOW, alerts: rows, im });
    const tab = tabOf(ss);
    eq(tab.rows[at(tab, 'HEADLINE NUMBERS')].slice(0, 3), ['HEADLINE NUMBERS', 'Last 7 days', 'Last 30 days']);
    eq(['Stories this app alerted on its own', 'Of those, also alerted by Burson', 'This app alerted first (of those Burson alerted too)',
      'Median head start over Burson (where this app was first)', 'Burson alerted first', 'Median time this app was behind (where Burson was first)',
      'Not alerted by Burson', 'This app\'s alert before the IMs\' email (of the stories with an IM email time)',
      'Median time from this app\'s alert to the IMs\' email (the end-to-end head start)', 'Burson\'s alerts in the same days',
      'Of Burson\'s alerts, those this app had alerted first (same post or same story)'].map(label => line(tab, label)),
    [[4, 6], ['3 of 4 (75%)', '5 of 6 (83%)'], ['2 of 3 (67%)', '3 of 5 (60%)'], ['2 h', '3 h'], [1, 2], ['30 min', '1 h 15 min'], [1, 1],
      ['1 of 2 (50%)', '2 of 3 (67%)'], ['2 h 25 min', '5 h'], [4, 6], ['2 of 4 (50%): 2 same post', '3 of 6 (50%): 3 same post']]);
    eq(table(tab, 'BIGGEST HEAD STARTS').map(x => [x['App alert'], x['Head start over Burson'], x['Head start over Burson (min)']]),
      [['QA-8', '2 d', 2880], ['QA-1', '3 h', 180], ['QA-3', '1 h', 60]]);

    // Nothing of this app's own: every count is 0, every share and median a dash
    const empty = report([burson('QA-1', NOW - DAY, 1)]);
    eq([empty.stories, empty.top, empty.windows.month.stories, empty.windows.month.matched_pct, empty.windows.month.first_median_min,
      empty.windows.month.burson_alerts, empty.windows.month.burson_after_pct], [[], [], 0, null, null, 1, 0]);
    const lines = B.headStartTabRows_(empty).rows;
    eq(lines.slice(4, 15).map(x => x[2]), [0, '—', '—', '—', 0, '—', 0, '—', '—', 1, '0 of 1 (0%)']);
    eq(lines.filter(x => x[0] === 'None yet').length, 2);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The tab: the bot's own, safe text, capped cells
  // ---------------------------------------------------------------------------------------------------------------

  test('head start: the tab, top to bottom: the bot\'s title in A1, what\'s counted and when it was rebuilt (ET), HEADLINE NUMBERS, BIGGEST HEAD STARTS, EVERY STORY; made after the report tabs, protected with a warning, rewritten whole on the next rebuild', () => {
    const w = world();
    const ss = sheetOf(w);
    ['Resources', 'Results', 'Follow-up', 'Alert log', 'Relay'].forEach(n => ss.insertSheet(n));
    const rows = [card('QA-1', SAT_11PM, 1, { post_keys: [key(1), key(2)], story_title: 'A card\'s headline' }, { issue_name: '' }),
      burson('QA-2', TUE_2PM, 2)];
    const out = w.bot.refreshHeadStart_(ss, { now: NOW, alerts: rows });
    const tab = tabOf(ss);
    eq([out.written, ss.getSheets().map(s => s.getName())], [true, ['Sheet1', 'Resources', 'Results', 'Follow-up', TAB, 'Alert log', 'Relay']]);
    assert.match(TITLE, /^Head start: .*\(written by the Burson QA bot\)$/);
    eq([tab.cell(1, 1), w.bot.isHeadStartTab_(tab), tab.protections.length, tab.protections[0].warningOnly], [TITLE, true, 1, true]);
    assert.match(tab.cell(2, 1), /^What's counted: every story this app alerted on its own in the last 30 days .* Rebuilt 2026-10-14 08:00 ET\.$/);
    eq([at(tab, 'HEADLINE NUMBERS'), at(tab, 'Matched on:'), at(tab, 'BIGGEST HEAD STARTS'), at(tab, 'EVERY STORY')], [3, 15, 17, 21]);
    eq([tab.rows[18], tab.rows[22], tab.rows.length], [HEADER, HEADER, 24]);
    // the story is the card's headline when it has no issue name, linked to its lead post
    eq(table(tab, 'EVERY STORY'), [Object.fromEntries(HEADER.map((h, i) => [h, ['Early Detection', '2026-10-10 23:00',
      `=HYPERLINK("${link(1)}","A card's headline")`, 'Search', TAG, '2026-10-13 14:00', '2 d 15 h', '', '', 'same post', 'QA-1',
      `=HYPERLINK("${link(2)}","QA-2")`, 3780, ''][i]]))]);
    eq(tab.merges, ['2,1,1,8', '16,1,1,8']);
    // The next rebuild writes the tab whole: nothing of the last one is left below a shorter table
    tab.getRange(40, 3).setValue('left over');
    w.bot.refreshHeadStart_(ss, { now: NOW + HOUR, alerts: [own('QA-9', NOW, 9, WATCH)] });
    eq([tab.rows.length, tab.cell(1, 1), table(tab, 'EVERY STORY').map(x => x['App alert']), tab.rows.filter(x => x[0] === 'None yet').length,
      ss.getSheets().filter(s => s.getName() === TAB).length], [24, TITLE, ['QA-9'], 1, 1]);
    assert.match(tab.cell(2, 1), /Rebuilt 2026-10-14 09:00 ET\.$/);

    // A sheet where this app never alerted on its own gets no tab from the every-minute run; refreshHeadStart() makes one
    const bare = sheetOf(w);
    eq([w.bot.refreshHeadStart_(bare, { now: NOW, alerts: [burson('QA-1', NOW - HOUR, 1)] }).written, bare.getSheets().map(s => s.getName())],
      [false, ['Sheet1']]);
    eq([w.bot.refreshHeadStart_(bare, { now: NOW, alerts: [burson('QA-1', NOW - HOUR, 1)], make: true }).written, bare.getSheets().map(s => s.getName()),
      tabOf(bare).rows.filter(x => x[0] === 'None yet').length], [true, ['Sheet1', TAB], 2]);
  });

  test('head start: a foreign "Head start" tab (one the bot didn\'t make: no title of the bot\'s in A1, or empty) is left untouched: never read, cleared, written or protected, and the log and the note say so until it is renamed', () => {
    const w = world();
    const ss = sheetOf(w);
    const theirs = ss.insertSheet(TAB);
    theirs.getRange(1, 1, 2, 2).setValues([['Head start: my own notes', 'Owner'], ['keep', 'this']]);
    const kept = JSON.stringify(theirs.rows);
    const rows = [own('QA-1', NOW - HOUR, 1, WATCH), burson('QA-2', NOW - 30 * MIN, 1)];
    const untouched = () => [JSON.stringify(theirs.rows), theirs.protections.length, theirs.cleared || [], theirs.merges || [], theirs.formatsCleared || 0,
      ss.getSheets().filter(s => s.getName() === TAB).length];
    eq([w.bot.isHeadStartTab_(theirs), w.bot.headStartTabForeign_(ss)], [false, true]);
    const out = w.bot.refreshHeadStart_(ss, { now: NOW, alerts: rows, make: true });
    eq([out.blocked, out.written, out.stories], [true, false, []]);
    eq(untouched(), [kept, 0, [], [], 0, 1]);
    assert.throws(() => w.bot.writeHeadStartTab_(theirs, B.headStartReport_(rows, null, NOW)), /isn't the bot's Head start tab: left as it is/);
    eq(w.bot.ensureHeadStartTab_(ss), null);
    eq(untouched(), [kept, 0, [], [], 0, 1]);
    // from poll(): the same, and it says why
    const store = w.bot.sheetBackend_(ss);
    rows.forEach(x => store.appendAlert(x));
    eq(w.bot.maybeRefreshHeadStart_(ss, w.ctx(), { deadline: w.g.clock.now + 4 * MIN, runStart: w.g.clock.now }), false);
    eq(untouched(), [kept, 0, [], [], 0, 1]);
    const TEXT = 'a tab named "Head start" that the bot didn\'t make is in the way (or its title in A1 was changed). Rename that tab, and the bot makes its own.';
    eq([w.g.props.get('HEAD_START_BLOCKED'), w.bot.headStartBlockedNote_(), w.g.logs.filter(l => /Head start/.test(l))],
      ['true', `The Head start tab isn't being updated: ${TEXT}`,
        ['Head start tab not updated: a "Head start" tab the bot didn\'t make is there (left as it is)',
          'Head start tab not updated: a "Head start" tab the bot didn\'t make is there (left as it is)']]);
    // refreshHeadStart() (from the editor): the same, and it says why
    w.g.props.set('STORE_SHEET_ID', ss.getId());
    eq([w.bot.refreshHeadStart(), untouched(), w.g.logs.slice(-1)], [null, [kept, 0, [], [], 0, 1], [`Head start tab not rebuilt: ${TEXT}`]]);
    // An empty tab with the name isn't the bot's either
    const ss2 = sheetOf(w);
    const blank = ss2.insertSheet(TAB);
    eq([w.bot.isHeadStartTab_(blank), w.bot.refreshHeadStart_(ss2, { now: NOW, alerts: rows }).blocked, blank.rows, blank.protections.length], [false, true, [], 0]);
    // Renamed: the bot makes its own tab beside it, and the note goes
    theirs.setName('My head start notes');
    eq([w.bot.refreshHeadStart_(ss, { now: NOW, alerts: rows }).written, tabOf(ss).cell(1, 1), JSON.stringify(theirs.rows), w.g.props.has('HEAD_START_BLOCKED'),
      w.bot.headStartBlockedNote_()], [true, TITLE, kept, false, '']);
    // The bot's own tab with its A1 changed is no longer known as the bot's: left as it is, too
    tabOf(ss).getRange(1, 1).setValue('Edited title');
    const edited = JSON.stringify(tabOf(ss).rows);
    eq([w.bot.refreshHeadStart_(ss, { now: NOW + HOUR, alerts: rows }).blocked, JSON.stringify(tabOf(ss).rows)], [true, edited]);
  });

  test('head start: formula-safe text and the cell cap: an issue name that starts with "=" (or a product, tag or alert id that starts with = + - @) is never read as a formula, the only formulas are the quoted links, and every cell stays at or under 49,000 characters', () => {
    const T = NOW - DAY;
    const HUGE = 'A'.repeat(60000);
    const rows = [
      own('QA-1', T, 1, WATCH, { issue_name: '=SUM(1,2)', product: '+cmd|\' /C calc\'!A0', exposure_tag: '@tag' }),
      burson('=1+1', T + HOUR, 1),
      own('QA-3', T + HOUR, 3, WATCH, { issue_name: '=HYPERLINK("https://evil.test","x")&"', post_url: '' }),          // no link: text
      own('QA-4', T + 2 * HOUR, 4, WATCH, { issue_name: 'He said "hello", then =1+1', post_url: 'https://x.com/a"b/status/70004' }),
      own('QA-5', T + 3 * HOUR, 5, WATCH, { issue_name: `${HUGE} end`, product: HUGE, exposure_tag: HUGE }),
      own('-QA-6', T + 4 * HOUR, 6, WATCH, { issue_name: '-minus', post_url: `https://x.com/a/status/70006?${HUGE}` }),  // a link too long to link
      own('QA-7', T + 5 * HOUR, 7, WATCH, { issue_name: '   spread\nover\tlines  ', post_url: 'https://x.com/a b/status/1' }),  // a broken link
      card('QA-8', T + 6 * HOUR, 8, { story_title: `=${HUGE}` }, { issue_name: '' }),
    ];
    const r = report(rows);
    const cells = B.headStartTabRows_(r).rows;
    const all = [].concat.apply([], cells);
    eq(Math.max.apply(null, all.map(v => String(v).length)) <= 49000, true);
    assert.ok(Math.max.apply(null, all.map(v => String(v).length)) < 2000, 'a name is cut to a line, not to a cell');
    // every cell that starts like a formula is one of the bot's quoted links, whole: a name can't close the quote
    const LINK = /^=HYPERLINK\("https?:\/\/(?:[^"]|"")*","(?:[^"]|"")*"\)$/;
    const formulas = all.filter(v => typeof v === 'string' && /^[=+\-@]/.test(v));
    eq([formulas.length, formulas.filter(v => !LINK.test(v))], [7, []]);
    const story = id => cells.filter(x => String(x[10]).replace(/^'/, '') === id).pop();
    eq([story('QA-1')[2], story('QA-1')[3], story('QA-1')[4], story('QA-1')[11]],
      [`=HYPERLINK("${link(1)}","=SUM(1,2)")`, '\'+cmd|\' /C calc\'!A0', '\'@tag', `=HYPERLINK("${link(1)}","=1+1")`]);
    eq([story('QA-3')[2], story('QA-4')[2], story('-QA-6')[2], story('-QA-6')[10], story('QA-7')[2]],
      ['\'=HYPERLINK("https://evil.test","x")&" (no link)', '=HYPERLINK("https://x.com/a""b/status/70004","He said ""hello"", then =1+1")',
        '\'-minus (no link)', '\'-QA-6', 'spread over lines (no link)']);
    assert.match(story('QA-5')[2], /^=HYPERLINK\("https:\/\/x\.com\/user5\/status\/70005","A{199}…"\)$/);
    assert.match(story('QA-8')[2], /^=HYPERLINK\("https:\/\/x\.com\/user8\/status\/70008","=A{198}…"\)$/);
    eq([story('QA-5')[3].length, story('QA-5')[4].length], [200, 200]);
    // written: the same cells, every one at or under 49,000 characters
    const w = world();
    const ss = sheetOf(w);
    w.bot.refreshHeadStart_(ss, { now: NOW, alerts: rows });
    const tab = tabOf(ss);
    tab.rows.forEach((x, i) => x.forEach((v, j) => assert.ok(String(v).length <= 49000, `row ${i + 1} column ${j + 1}`)));
    eq(tab.rows.length, cells.length);
    eq(B.ev('SHEET_CELL_MAX_CHARS_'), 49000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The rebuild: when, and that it never gets in the way
  // ---------------------------------------------------------------------------------------------------------------

  test('head start: a rebuild never throws on broken rows: rows that are not rows, broken cells and missing columns are left out or read as blank, and the every-minute rebuild logs a failure and carries on', () => {
    const good = [own('QA-1', NOW - 2 * HOUR, 1, WATCH), burson('QA-2', NOW - HOUR, 1)];
    const broken = [
      null, undefined, 5, 'a row?', [], {}, [1, 2, 3], true,
      { ingested: ED }, { ingested: ED, source_at: 'soon', created_at: null }, { ingested: WATCH, source_at: NOW, forwarded_fields: 'not JSON' },
      { ingested: ED, source_at: NOW - HOUR, forwarded_fields: [1, 2], record_key: 12345, alert_id: { a: 1 } },
      { ingested: ED, source_at: NOW - HOUR, forwarded_fields: { early_detection: 'card', issue_name: { a: 1 }, exposure_tag: ['x'], product: 7 } },
      { ingested: ED, source_at: NOW - HOUR, forwarded_fields: { early_detection: { post_keys: 'x.com/status/1', update_of: { id: 1 }, story_title: 9 } } },
      { ingested: ED, source_at: NOW - HOUR, forwarded_fields: { early_detection: { post_keys: [null, 5, {}, key(1), ''], update_of: 'QA-404', signal_type: 3 } } },
      { ingested: DIRECT.BMIE, source_at: NOW - HOUR, email_input: 'x', forwarded_fields: null, space: 5 },
      { ingested: '', record_key: key(2), source_at: NOW - HOUR, space: null, forwarded_fields: 'x' },
      { ingested: null, record_key: { k: 1 }, source_at: NOW - HOUR, forwarded_fields: { issue_name: 5, issue_status: {}, post_url: [] } },
      { ingested: 0, record_key: key(3), source_at: 'x' }, { ingested: [], record_key: key(4), source_at: NOW },
      Object.assign(Object.create(null), { ingested: WATCH, source_at: NOW - HOUR }),
    ];
    let r;
    assert.doesNotThrow(() => { r = B.headStartReport_(good.concat(broken), { [postKey(1)]: 'soon', x: null }, NOW); });
    eq(brief(r.stories.find(s => s.alert_id === 'QA-1')), ['QA-1', 'Watch', 'same post', 'QA-2', 60]);
    // an IM time that isn't a time is no IM time
    for (const bad of ['soon', null, {}, { at: 0 }, { at: 'x', from: 'email' }, { at: -5 }, []]) {
      const s = B.headStartReport_(good, { [postKey(1)]: bad }, NOW).stories[0];
      eq([s.im, s.im_lead_ms], [null, null], JSON.stringify(bad));
    }
    assert.doesNotThrow(() => B.headStartTabRows_(r));
    for (const args of [[null, null, NOW], [undefined, undefined, undefined], ['rows', 'im', 'now'], [{}, [], NaN], [[null], new Map(), -1]]) {
      assert.doesNotThrow(() => B.headStartTabRows_(B.headStartReport_.apply(null, args)), JSON.stringify(args));
    }
    eq(B.headStartReport_(null, null, NOW).stories, []);

    // Through the sheet: an Alert log with a broken row, cells that aren't JSON and a missing column
    const w = world();
    const ss = sheetOf(w);
    const log = ss.insertSheet('Alert log');
    const cols = ['alert_id', 'created_at', 'space', 'record_key', 'forwarded_fields', 'source_at', 'ingested'];
    log.getRange(1, 1, 5, cols.length).setValues([cols,
      ['QA-1', NOW - 2 * HOUR, MAIN, key(1), JSON.stringify({ post_url: link(1), issue_name: 'Issue 1' }), NOW - 2 * HOUR, WATCH],
      ['QA-2', NOW - HOUR, MAIN, key(1), '{not json', NOW - HOUR, ''],
      ['', 'yesterday', '', '', '[]', '', ED],
      ['QA-4', NOW - 30 * MIN, MAIN, key(4), '"text"', 'x', ED]]);
    const run = book => w.bot.maybeRefreshHeadStart_(book, w.ctx(), { deadline: w.g.clock.now + 4 * MIN, runStart: w.g.clock.now });
    let made;
    assert.doesNotThrow(() => { made = run(ss); });
    eq([made, table(tabOf(ss), 'EVERY STORY').map(x => [x['App alert'], x['Matched on'], x['Head start over Burson']]), log.rows[0]],
      [true, [['QA-4', '', ''], ['QA-1', 'same post', '1 h']], cols]);  // the Alert log's header is as it was: nothing added
    // Sheets failing: logged, false, the run carries on (never thrown into poll())
    const down = { getSheetByName() { throw new Error('Sheets is down'); } };
    w.g.clock.now += 30 * MIN;
    let res;
    assert.doesNotThrow(() => { res = run(down); });
    eq([res, w.g.logs.slice(-1)], [false, ['ERROR Head start tab not refreshed: Sheets is down']]);
    assert.doesNotThrow(() => { res = [w.bot.maybeRefreshHeadStart_(null, w.ctx(), {}), w.bot.maybeRefreshHeadStart_(ss, null, null)]; });
    eq(res[0], false);
    // No Alert log yet: nothing is made, the Alert log least of all
    const bare = sheetOf(w);
    w.g.props.delete('HEAD_START_AT');
    eq([run(bare), bare.getSheets().map(s => s.getName())], [false, ['Sheet1']]);
  });

  test('head start: rebuilt at most every 10 minutes, in a run where the Results tab was rebuilt (10 more minutes without one and it goes without the IMs\' times; at once when the Results tab is off), and skipped when less than 30 seconds of the run are left', () => {
    const w = world();
    const ss = sheetOf(w);
    const store = w.bot.sheetBackend_(ss);
    const T = NOW - 2 * DAY;
    const rows = [own('QA-1', T, 1, WATCH), burson('QA-2', T + 2 * HOUR, 1)];
    rows.forEach(x => store.appendAlert(x));
    const props = w.g.services.PropertiesService.getScriptProperties();
    const flows = { main: { partition: MAIN, label: 'Mirror space', live: false }, ac: null };
    const drafts = () => [{ post_url: link(1), at: T + 150 * MIN, subject: '⭐ SOCIAL ALERT ⭐: Search | Issue 1 | X | 900 Engagements', drafted_by: 'im1@ops.test' }];
    const results = () => w.bot.refreshSpeed_(ss, w.ctx(), { alerts: rows, drafts, logged: () => [], flows });
    const run = (left, ctx) => w.bot.maybeRefreshHeadStart_(ss, ctx || w.ctx(), { deadline: w.g.clock.now + (left === undefined ? 4 * MIN : left),
      runStart: w.g.clock.now });
    const rebuilt = () => tabOf(ss).cell(2, 1).match(/Rebuilt (.*) ET\.$/)[1];
    const im = () => table(tabOf(ss), 'EVERY STORY')[0]['IMs emailed (ET)'];
    const START = w.g.clock.now;

    eq([run(), rebuilt(), im(), Number(props.getProperty('HEAD_START_AT'))], [true, B.speedTime_(START), '', START]);  // the first time: at once
    w.g.clock.now += 9 * MIN;
    results();
    eq([run(), rebuilt()], [false, B.speedTime_(START)]);                       // under 10 minutes, even with a Results rebuild
    w.g.clock.now += MIN;
    eq(run(), false);                                                             // 10 minutes on, no Results rebuild in this run: it waits for one
    w.g.clock.now += 2 * MIN;
    results();
    eq([run(20 * 1000), run(29999)], [false, false]);                             // under 30 seconds of the run left: skipped
    eq([run(30 * 1000), rebuilt(), im()], [true, B.speedTime_(START + 12 * MIN), B.speedTime_(T + 150 * MIN)]);
    eq(run(), false);                                                             // once
    w.g.clock.now += 19 * MIN;
    eq(run(), false);                                                             // 19 minutes on and still no Results rebuild: it waits
    w.g.clock.now += MIN;
    eq([run(), rebuilt(), im()], [true, B.speedTime_(START + 32 * MIN), '']);     // 20 minutes on: rebuilt without the IMs' times
    // The Results tab off in the settings: there's no rebuild of it to wait for
    const off = w.ctx();
    off.settings = Object.assign({}, off.settings, { speed_tab: false });
    w.g.clock.now += 9 * MIN;
    eq(run(undefined, off), false);
    w.g.clock.now += MIN;
    eq([run(undefined, off), rebuilt()], [true, B.speedTime_(START + 42 * MIN)]);
    // Without a deadline (an older caller): the context's own
    w.g.clock.now += 10 * MIN;
    const late = Object.assign(off, { deadline: w.g.clock.now + 10 * 1000 });
    eq([w.bot.maybeRefreshHeadStart_(ss, late), w.bot.maybeRefreshHeadStart_(ss, Object.assign(late, { deadline: w.g.clock.now + MIN }))], [false, true]);
    // refreshHeadStart() (from the editor) rebuilds it now and leaves it due again, for the next run that has the IMs' times
    w.g.props.set('STORE_SHEET_ID', ss.getId());
    w.g.clock.now += MIN;
    const numbers = w.bot.refreshHeadStart();
    eq([numbers.month.stories, numbers.month.first, rebuilt(), Number(props.getProperty('HEAD_START_AT'))],
      [1, 1, B.speedTime_(w.g.clock.now), w.g.clock.now - 10 * MIN]);
    results();
    eq([run(), im()], [true, B.speedTime_(T + 150 * MIN)]);
  });

  test('head start: the Alert log is only read (never made, its header never touched), back as far as the stories need and no further', () => {
    const w = world();
    const ss = sheetOf(w);
    eq([w.bot.headStartAlertRows_(ss, NOW - DAY), ss.getSheets().map(s => s.getName())], [[], ['Sheet1']]);  // no Alert log: none is made
    const log = ss.insertSheet('Alert log');
    const cols = ['alert_id', 'created_at', 'record_key', 'forwarded_fields', 'source_at', 'ingested', 'my own column'];
    const line = (n, madeAt) => [`QA-${n}`, madeAt, key(n), JSON.stringify({ post_url: link(n) }), madeAt, WATCH, 'note'];
    log.getRange(1, 1, 7, cols.length).setValues([cols, line(1, NOW - 50 * DAY), line(2, NOW - 45 * DAY), line(3, NOW - 40 * DAY),
      line(4, NOW - 60 * DAY), line(5, NOW - DAY), line(6, '')]);
    const before = JSON.stringify(log.rows);
    const read = since => w.bot.headStartAlertRows_(ss, since).map(x => x.alert_id);
    // from the first row made since then to the end (a row out of order, or without a time, in between is read too)
    eq([read(NOW - 44 * DAY), read(NOW - 2 * DAY), read(NOW - 100 * DAY), read(NOW)], [['QA-3', 'QA-4', 'QA-5', 'QA-6'], ['QA-5', 'QA-6'],
      ['QA-1', 'QA-2', 'QA-3', 'QA-4', 'QA-5', 'QA-6'], []]);
    eq(w.bot.headStartAlertRows_(ss, NOW - 2 * DAY)[0].forwarded_fields, { post_url: link(5) });
    eq([JSON.stringify(log.rows), log.protections.length, log.frozenRows], [before, 0, undefined]);
    // a rebuild reads the 30 days of stories and the 14 days before them
    w.bot.refreshHeadStart_(ss, { now: NOW });
    eq([table(tabOf(ss), 'EVERY STORY').map(x => x['App alert']), JSON.stringify(log.rows)], [['QA-5'], before]);
  });

  test('head start: nothing is posted or emailed: poll() rebuilds the tab at the end of a run and it changes nothing else (the same Chat posts, emails, drafts, requests, other tabs and log as a run with the rebuild taken out)', () => {
    const T = NOW - 2 * DAY;
    const rows = [
      card('QA-901', T, 1, { post_keys: [key(1), key(2)], story_title: 'A build-up' }, { issue_name: 'Banking malware in Play Store apps' }),
      burson('QA-902', T + 26 * HOUR, 2),
      own('QA-903', T + 3 * HOUR, 3, WATCH, null, { space: OTHERS }),
    ];
    const go = takenOut => {
      const t = e2e();
      t.bot.setup();
      t.set('B30', 'tester@testing.test');
      if (takenOut) t.bot.maybeRefreshHeadStart_ = () => false;
      const log = t.bot.sheetTable_(t.sheet(), 'Alert log', t.bot.ev('ALERT_COLUMNS_'), 'alert_id', 4000);
      rows.forEach(x => log.append(x));
      // three runs: the first makes the tab; five minutes on it is left alone; half an hour on it is rebuilt (here the
      // Results tab can't be rebuilt, BigQuery being out of reach, so it goes without the IMs' times)
      const rebuilt = [];
      const poll = () => {
        t.poll();
        const tab = tabOf(t.sheet());
        rebuilt.push(tab ? [B.speedTime_(t.g.clock.now), tab.cell(2, 1).match(/Rebuilt (.*) ET\.$/)[1]] : null);
      };
      t.chat.say(TEST_FEED, F.P0_OK, { sender: 'users/bot' });
      poll();
      t.g.clock.now += 4 * MIN;
      poll();
      t.g.clock.now += 25 * MIN;
      poll();
      const snap = JSON.stringify({
        chat: Array.from(t.chat.spaces.values()).map(s => [s.name, s.messages.map(m => [m.name, m.text, m.thread.name, m.reactions])]),
        sent: t.g.gmail.sentMessages(), drafts: t.g.gmail.allDrafts(), fetches: t.g.fetches.map(f => [f.method, f.url]),
        sheets: t.sheet().sheets.filter(sh => sh.name !== TAB).map(sh => [sh.name, sh.rows]),
        props: Array.from(t.g.props).filter(([k]) => k !== 'LAST_RUN' && !/^HEAD_START_/.test(k)), logs: t.g.logs,
      });
      return { t, snap, rebuilt };
    };
    const on = go(false);
    const without = go(true);
    assert.strictEqual(on.snap, without.snap);
    // the runs did their usual work beside it: Burson's alert reviewed (its row in the Alert log), its Social Alert sent to the tester
    eq([on.t.sheet().getSheetByName('Alert log').rows.length - 1, on.t.g.gmail.sentMessages().length], [rows.length + 1, 1]);
    const tab = tabOf(on.t.sheet());
    const names = on.t.sheet().sheets.map(s => s.name);
    eq([without.rebuilt, tabOf(without.t.sheet()), without.t.g.props.has('HEAD_START_AT')], [[null, null, null], null, false]);
    eq([on.rebuilt[0][0] === on.rebuilt[0][1], on.rebuilt[1][1], on.rebuilt[2][0] === on.rebuilt[2][1], on.rebuilt[2][1] !== on.rebuilt[0][1]],
      [true, on.rebuilt[0][1], true, true]);
    eq([tab.cell(1, 1), tab.protections[0].warningOnly, names.filter(n => n === TAB).length, names.indexOf(TAB) > names.indexOf('Alert log'),
      Number(on.t.g.props.get('HEAD_START_AT'))], [TITLE, true, 1, true, on.t.g.clock.now]);
    eq(table(tab, 'EVERY STORY').map(x => [x.Type, x['App alert'], x['Matched on'], x['Burson alert'], x['Head start over Burson'], x['IMs emailed (ET)']]),
      [['Watch', 'QA-903', '', '', '', ''], ['Early Detection', 'QA-901', 'same post', `=HYPERLINK("${link(2)}","QA-902")`, '1 d 2 h', '']]);
    assert.ok(!on.t.g.logs.some(l => /Head start/.test(l)), 'a rebuild that works says nothing in the log');
    // it has no switch and no row of its own on the Control tab
    assert.ok(!on.t.control().rows.some(x => x.some(v => /head start/i.test(String(v)))));
    assert.ok(!B.ev('CONTROL_SWITCHES_').some(s => /head ?start/i.test(`${s.key} ${s.label}`)));
  });
};
