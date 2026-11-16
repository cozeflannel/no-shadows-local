// C15 (Direct BigQuery alerts, Control row 15, column C) says what the poll did not post (BigQuery.gs noteBqDirect_,
// bqDirectNoteText_, bqCountNotPosted_, bqDirectReviewed_):
//   last check <time> · N posts today (S for a Social Alert, M monitoring only) · not posted: A already had an alert,
//   B on a story already alerted
// N: the cards the poll posted. S and M: the cards whose review ended in a Social Alert, and in none; each card is
// counted once, where its review ends. A: posts about Google the poll read that already had an alert (never the poll's
// own card). B: posts Step 1 left out as on a story already alerted. A and B count each post once a day for each
// reason, with one line in the run log. The note is 200 characters at most: with a problem to tell, the bracket goes
// first, then "; it tries again at the next check", then the problem's own words are cut; never a count.
// A post Step 1 leaves out on its own call (not about Google, or Gemini's call with no earlier alert on the issue) is
// on neither count of C15: it has its line in the run log once a day too, however often Step 1 weighs it, and the day's
// record counts it apart (o).
// Nothing here changes what is posted, queued or emailed (the golden tests hold that).
'use strict';

module.exports = H => {
  const { test, eq, assert, B, F, world, collectBurson } = H;
  const golden = require('./golden_flows')(H);
  const MIN = 60 * 1000;
  const TESTER = 'tester@testing.test';
  const SAM = 'https://x.com/WasSamLowryEsq/status/2109952063492993159';  // the post of F.P0_OK
  const AIO = 'https://x.com/TheChiefNerd/status/1845000000000000001';    // the post of F.AIO
  const ISSUE = 'Alleged Bias in Search Reporting for Paris Riots 2026';  // the issue of F.P0_OK and F.NO_LINK
  const NONE = ' · not posted: 0 already had an alert, 0 on a story already alerted';

  // -----------------------------------------------------------------------------------------------------------
  // The poll's reads, and a world with the switch ON
  // -----------------------------------------------------------------------------------------------------------

  const BSIP_COLS = [['source_kind'], ['id'], ['url'], ['handle'], ['network'], ['alert_names_json'], ['tags'], ['criticality'],
    ['followers', 'INTEGER'], ['total', 'INTEGER'], ['summary'], ['issue_name'], ['post_time']];
  /** A fake BigQuery for the poll: feed.bsip (the BSIP read's rows) and feed.logged (links the SLRR alert log has). */
  function fakeBq(g) {
    const feed = { bsip: [], logged: [] };
    const orig = g.services.UrlFetchApp.fetch;
    g.services.UrlFetchApp.fetch = (u, params) => {
      if (!String(u).startsWith('https://bigquery.googleapis.com/')) return orig(u, params);
      const sql = String(JSON.parse(params.payload).query || '');
      const [cols, rows] = /"BSIP" AS source_kind/.test(sql) ? [BSIP_COLS, feed.bsip]
        : /SPLIT\(@urls, " "\)/.test(sql) ? [[['url']], feed.logged.map(url => ({ url }))] : [[['url']], []];
      const text = JSON.stringify({ jobComplete: true, schema: { fields: cols.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
        rows: rows.map(x => ({ f: cols.map(c => ({ v: x[c[0]] === undefined || x[c[0]] === null ? null : String(x[c[0]]) })) })) });
      return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => text };
    };
    return feed;
  }
  // Posts on issues of their own (a post on an issue that has a card would be left out as the same issue)
  const POSTS = [
    ['Google Maps - Accuracy', 'Maps routing onto a closed bridge', 'An X user says Google Maps sent drivers onto a closed bridge.'],
    ['Chrome', 'Chrome update closes every open tab', 'An X user says the Chrome update closed every open tab.'],
    ['Pixel - Reliability', 'Pixel battery swelling on the charger', 'An X user says their Google Pixel battery swelled on the charger.'],
    ['Gmail', 'Gmail drafts sent to the wrong contact', 'An X user says Gmail sent their drafts to the wrong contact.'],
    ['Google Photos', 'Photos albums gone after the backup', 'An X user says Google Photos lost their albums after the backup.'],
    ['Android', 'Android Auto disconnects on the highway', 'An X user says Android Auto keeps disconnecting on the highway.'],
    ['YouTube', 'YouTube captions show the wrong language', 'An X user says YouTube captions show the wrong language.'],
  ];
  const link = n => `https://x.com/critic${n}/status/21180000000000000${10 + n}`;
  /** BSIP's row for post `n`: a P2 tag and 620 engagements (no Social Alert at its review) unless `o` says otherwise. */
  const bsip = (n, o) => Object.assign({ source_kind: 'BSIP', id: String(n), url: link(n), handle: `critic${n}`, network: 'Twitter',
    alert_names_json: JSON.stringify([POSTS[n % POSTS.length][0]]), tags: 'Product - Other/general criticism', criticality: 'HIGH',
    followers: 5100, total: 620, summary: POSTS[n % POSTS.length][2], issue_name: POSTS[n % POSTS.length][1],
    post_time: '2026-10-14 11:40:00+00' }, o || {});
  const samRow = o => bsip(0, Object.assign({ url: SAM, handle: 'WasSamLowryEsq', alert_names_json: '["Search"]', tags: 'Product - Perceived bias',
    total: 1, issue_name: 'Search results about the riots', summary: 'An X user says Search results about the Paris riots are biased.' }, o || {}));

  const onCtx = (w, extra) => {
    const ctx = Object.assign(w.ctx(), { switches: Object.assign(w.bot.switchesOff_(), { directBq: true }) }, extra || {});
    Object.assign(ctx.settings, { bq_direct_poll: true, bq_poll_sprinklr: true, bq_poll_bmie: true, bq_poll_bsip: true });
    return ctx;
  };
  /** The next check, 5 minutes on (`extra`: on the run's ctx). */
  const check = (w, extra) => { w.g.clock.now += 5 * MIN; return w.bot.pollBigQuerySources_(onCtx(w, extra), w.BUR); };
  /** A run of the flow with the switch ON: what waits in the space is reviewed. */
  const review = w => { w.g.clock.now += 1000; const r = w.bot.runOnce_(onCtx(w)); collectBurson(w.chat, [w.BUR]); return r; };
  const note = w => JSON.parse(w.g.props.get('SWITCH_NOTES')).directBq.text;
  const today = w => JSON.parse(w.g.props.get('BQ_DIRECT_TODAY'));
  const counts = w => ['n', 's', 'm', 'a', 'b'].map(k => today(w)[k]);  // what C15 shows
  const ownCall = w => today(w).o;  // the posts Step 1 left out on its own call: counted apart, not on C15
  const said = w => w.g.logs.filter(l => /^BigQuery direct poll: not posted/.test(l));
  const cards = w => w.chat.botPosts(w.BUR).filter(m => !m.threadReply && /^THIS ALERT MEETS/.test(m.text)).map(m => m.text.match(/\[Link\]: (\S+)/)[1]);
  const forget = (w, prefix) => Array.from(w.g.cache.keys()).filter(k => k.indexOf(prefix) === 0).forEach(k => w.g.cache.delete(k));
  const res = o => Object.assign({ sprinklr: 0, bmie: 0, bsip: 0, skipped_duplicates: 0, skipped_step1: 0, skipped_no_count: 0 }, o);

  // -----------------------------------------------------------------------------------------------------------
  // The note's words
  // -----------------------------------------------------------------------------------------------------------

  test('direct BQ C15: the note is "last check <time> · N posts today (S for a Social Alert, M monitoring only) · not posted: A already had an alert, B on a story already alerted", 200 characters at most. With every count at three digits and the longest time nothing is cut. With a problem to tell, the bracket goes first, then "; it tries again at the next check", then the problem\'s own words are cut: never a count', () => {
    const text = (s, label, problem) => B.bqDirectNoteText_(s, label, problem);
    eq(B.ev('BQ_NOTE_MAX_'), 200);
    const OWNER = 'last check Nov 16, 2:13 PM EST · 14 posts today (3 for a Social Alert, 11 monitoring only) · ' +
      'not posted: 12 already had an alert, 9 on a story already alerted';
    eq([text({ n: 14, s: 3, m: 11, a: 12, b: 9 }, 'Nov 16, 2:13 PM EST', ''), OWNER.length], [OWNER, 158]);
    eq(text({ n: 1, s: 1, m: 0, a: 1, b: 1 }, 'Nov 16, 2:13 PM EST'),
      'last check Nov 16, 2:13 PM EST · 1 post today (1 for a Social Alert, 0 monitoring only) · not posted: 1 already had an alert, 1 on a story already alerted');
    eq([text({}, 'Nov 16, 2:13 PM EST', ''), text(null, 'Nov 16, 2:13 PM EST', '')].map(t => t.replace(/^last check Nov 16, 2:13 PM EST/, '')),
      Array(2).fill(` · 0 posts today (0 for a Social Alert, 0 monitoring only)${NONE}`));

    // every count at three digits, at the longest time of day: the whole text, 166 characters
    const BIG = { n: 999, s: 998, m: 997, a: 996, b: 995 };
    const LONGEST = 'Nov 16, 12:13 PM EST';
    const HEAD = `last check ${LONGEST}`;
    const POSTS_3 = ' · 999 posts today';
    const SPLIT_3 = ' (998 for a Social Alert, 997 monitoring only)';
    const NOT_3 = ' · not posted: 996 already had an alert, 995 on a story already alerted';
    eq([text(BIG, LONGEST, ''), text(BIG, LONGEST, '').length], [HEAD + POSTS_3 + SPLIT_3 + NOT_3, 166]);
    // a short problem: the bracket that splits the posts goes; N, A and B stay whole
    const AGAIN = '; it tries again at the next check';
    eq(text(BIG, LONGEST, 'couldn\'t read the space'), `${HEAD} (couldn't read the space${AGAIN})${POSTS_3}${NOT_3}`);
    // a longer one: "; it tries again at the next check" goes too, the problem's own words stay
    const SLOW = 'BigQuery didn\'t finish the query for Sprinklr and BMIE in time';
    eq(text(BIG, LONGEST, SLOW), `${HEAD} (${SLOW})${POSTS_3}${NOT_3}`);
    // the longest the poll can tell: its words are cut to what fits, at exactly 200 characters
    const WORST = 'BigQuery refused the query for Sprinklr, BMIE and BSIP\'s SLRR log check, BigQuery didn\'t finish the query for ' +
      'BSIP in time, 2 couldn\'t be posted';
    const worst = text(BIG, LONGEST, WORST);
    eq([worst, worst.length], [`${HEAD} (BigQuery refused the query for Sprinklr, BMIE and BSIP's SLRR log check, Big…)${POSTS_3}${NOT_3}`, 200]);
    // whatever the problem's length and the counts' size (one to four digits): never over 200, and every count whole
    [{ n: 1, s: 0, m: 1, a: 2, b: 3 }, { n: 42, s: 10, m: 32, a: 15, b: 27 }, BIG, { n: 1234, s: 1000, m: 234, a: 5678, b: 9012 }].forEach(s => {
      const tail = ` · not posted: ${s.a} already had an alert, ${s.b} on a story already alerted`;
      const posts = ` · ${s.n} post${s.n === 1 ? '' : 's'} today`;
      for (let len = 0; len <= 160; len++) {
        const problem = 'x'.repeat(len);
        const t = text(s, LONGEST, problem);
        assert.ok(t.length <= 200, `${t.length} characters: ${t}`);
        assert.ok(t.endsWith(posts + tail) || t.endsWith(`${posts} (${s.s} for a Social Alert, ${s.m} monitoring only)${tail}`), t);
        assert.ok(t.indexOf(HEAD) === 0 && (len === 0) === (t.indexOf(' (x') < 0), t);
      }
    });

    // through the poll: column C's note is that text, not cut by the 200 characters every switch's note is held to
    const w = world();
    fakeBq(w.g);
    w.g.props.set('BQ_DIRECT_TODAY', JSON.stringify(Object.assign({ day: w.bot.dayKey_(), k: [] }, BIG)));
    eq(check(w), res({}));
    assert.match(note(w), /^last check Oct 14, 8:05 AM EDT · 999 posts today \(998 for a Social Alert, 997 monitoring only\) · not posted: 996 already had an alert, 995 on a story already alerted$/);
    assert.ok(note(w).length <= 200 && !note(w).includes('…'), note(w));
  });

  // -----------------------------------------------------------------------------------------------------------
  // A: already had an alert. B: on a story already alerted. Once a day each.
  // -----------------------------------------------------------------------------------------------------------

  test('direct BQ C15: a post that already had an alert is counted once a day, with one log line (its link, the reason, the alert), however many checks read it; a post the poll took itself never counts (while its card waits, once it is reviewed, and when the poll\'s memory of it is lost). With the cache emptied the day\'s record still knows the post, and the other way round: only a post both have lost counts a second time. The next day it counts once again', () => {
    const w = world();
    const feed = fakeBq(w.g);
    const puts = [];  // what the bot keeps in the script cache for these counts: [key, seconds]
    const getCache = w.g.services.CacheService.getScriptCache;
    w.g.services.CacheService.getScriptCache = () => Object.assign(getCache(), {
      put: (k, v, sec) => { if (/^bqnp:/.test(k)) puts.push([k, sec]); w.g.cache.set(k, String(v)); } });
    w.paste(F.P0_OK);  // Burson alerted SAM's post, and the bot reviewed it
    w.run();
    const burson = w.alertRows()[0].alert_id;
    feed.bsip = [samRow(), bsip(1)];
    eq(check(w), res({ bsip: 1, skipped_duplicates: 1 }));
    eq([cards(w), counts(w)], [[link(1)], [1, 0, 0, 1, 0]]);
    eq(said(w), [`BigQuery direct poll: not posted, it already had an alert: ${SAM} · ${burson} (Burson's alert)`]);
    assert.match(note(w), /^last check Oct 14, 8:05 AM EDT · 1 post today \(0 for a Social Alert, 0 monitoring only\) · not posted: 1 already had an alert, 0 on a story already alerted$/);
    // the day's record keeps the post under the reason and a short hash; the cache has a key for the day, kept 6 hours
    const id = 'a' + w.bot.hashText_(w.bot.recordKey_({ post_url: SAM }));
    eq([today(w).k, puts], [[id], [[`bqnp:${w.bot.dayKey_()}:${id}`, 21600]]]);
    eq(B.ev('[BQ_NOT_POSTED_CACHE_SEC_, BQ_NOT_POSTED_KEPT_]'), [21600, 300]);

    // the next checks read both posts again: the poll's own card (waiting to be reviewed) is no other alert, and SAM's
    // post is known; its cache key is set again at every check that reads it
    eq(check(w), res({ skipped_duplicates: 2 }));
    eq([counts(w), said(w).length, puts.length], [[1, 0, 0, 1, 0], 1, 2]);
    review(w);  // the card is reviewed (no Social Alert: this world makes none)
    eq(check(w), res({ skipped_duplicates: 2 }));
    eq(counts(w), [1, 0, 1, 1, 0]);
    w.g.props.delete('BQ_INGESTED_KEYS');  // the poll's memory of the posts it took is lost: the card's row still says whose it is
    eq(check(w), res({ skipped_duplicates: 2 }));
    eq([counts(w), cards(w)], [[1, 0, 1, 1, 0], [link(1)]]);

    // the cache emptied, at every check, ten times over: the day's record still knows the post
    for (let i = 0; i < 10; i++) {
      forget(w, 'bqnp:');
      check(w);
    }
    eq([counts(w), said(w).length], [[1, 0, 1, 1, 0], 1]);
    // the day's record without the post (as when 300 others were counted after it): the cache key still knows it
    w.g.props.set('BQ_DIRECT_TODAY', JSON.stringify(Object.assign(today(w), { k: [] })));
    check(w);
    eq([counts(w), today(w).k], [[1, 0, 1, 1, 0], []]);
    // both lost: the post counts a second time, and is known again
    forget(w, 'bqnp:');
    check(w);
    eq([counts(w), today(w).k, said(w).length], [[1, 0, 1, 2, 0], [id], 2]);
    check(w);
    eq(counts(w), [1, 0, 1, 2, 0]);

    // the next day: the counts start again, and the post, still read, counts once that day
    w.g.clock.now += 24 * 60 * MIN;
    check(w);
    check(w);
    eq([counts(w), today(w).k, said(w).length], [[0, 0, 0, 1, 0], [id], 3]);
    assert.ok(/ · 0 posts today \(0 for a Social Alert, 0 monitoring only\) · not posted: 1 already had an alert, 0 on a story already alerted$/.test(note(w)), note(w));
  });

  test('direct BQ C15: every way a post already has an alert counts, and says which alert: Burson\'s alert still waiting in the space, the SLRR alert log, a Watch alert\'s card not reviewed yet, an alert another flow has, a Social Alert that went out; never a post whose Direct BigQuery card the alert memory knows', () => {
    const w = world();
    const feed = fakeBq(w.g);
    w.paste(F.P0_OK);
    w.run();
    const burson = w.alertRows()[0].alert_id;
    w.paste(F.AIO);  // Burson's alert of another post, in the space and not reviewed yet
    // a card the poll posted, as its Alert-log row has it (QA-900)
    w.backend.alerts.push({ alert_id: 'QA-900', space: `${w.BUR} > ${w.ANA}`, ingested: 'BSIP', record_key: 'x.com/status/900',
      created_at: w.g.clock.now, status: 'ok' });
    feed.bsip = [bsip(1, { url: AIO }), bsip(2), bsip(3), bsip(4), bsip(5), bsip(6), bsip(7)];
    feed.logged = [link(2).replace('x.com', 'twitter.com') + '?s=46'];  // the SLRR alert log has post 2 under another link
    // what the shared alert memory says of the other posts (AlertMemory.gs seenPost)
    const seen = {
      [link(3)]: { why: 'a watch card was already posted for it', alert_id: '', outcome: 'claimed', ids: [], claim: 'watch' },
      [link(4)]: { why: 'already seen (QA-77)', alert_id: 'QA-77', outcome: 'seen', ids: ['QA-77'], claim: '' },
      [link(5)]: { why: 'a bq card was already posted for it', alert_id: '', outcome: 'claimed', ids: [], claim: 'bq' },
      [link(6)]: { why: `its Social Alert already went out (${burson})`, alert_id: burson, outcome: 'emailed' },
      [link(7)]: { why: 'its Social Alert already went out (QA-900)', alert_id: 'QA-900', outcome: 'emailed' },  // the poll's own card's
    };
    const memory = { active: true, seenPost: url => seen[url] || null, claim: () => true };
    eq(check(w, { memory }), res({ skipped_duplicates: 7 }));
    eq([cards(w), counts(w)], [[], [0, 0, 0, 5, 0]]);
    eq(said(w).map(l => l.replace('BigQuery direct poll: not posted, it already had an alert: ', '')), [
      `${AIO} · in the space, not reviewed yet`,
      `${link(3)} · a watch card, not reviewed yet`,
      `${link(4)} · QA-77 (an alert of another flow)`,
      `${link(6)} · ${burson} (Burson's alert)`,
      `${link(2)} · the SLRR alert log has the post`,
    ]);
    // once Burson's alert is reviewed its post is still the same post: nothing is counted again
    w.run();
    eq(check(w, { memory }), res({ skipped_duplicates: 7 }));
    eq([counts(w), said(w).length], [[0, 0, 0, 5, 0], 5]);
  });

  test('direct BQ C15: a post Step 1 leaves out as on a story already alerted is counted once a day under "on a story already alerted", with the alert the code\'s own rule matched and who left it out (the rules, or Gemini): not again while Step 1 doesn\'t weigh it (an hour), nor when it weighs it again. A post Gemini leaves out that matches no earlier alert is on neither count of C15: the log says so, once, and the day\'s record counts it apart. A post Step 1 matches to an earlier alert by the post itself counts under "already had an alert", unless that alert is the poll\'s own card', () => {
    const w = world();
    const feed = fakeBq(w.g);
    w.paste(F.NO_LINK);  // Burson's alert on the issue, without its link (so SAM's post is not in the log by its link)
    w.run();
    const prior = w.alertRows()[0].alert_id;
    feed.bsip = [samRow({ issue_name: ISSUE })];
    eq(check(w), res({ skipped_step1: 1 }));
    eq([cards(w), counts(w)], [[], [0, 0, 0, 0, 1]]);
    eq(said(w), [`BigQuery direct poll: not posted, on a story already alerted: ${SAM} · ${prior} (Burson's alert) · Step 1, by the rules`]);
    assert.ok(note(w).endsWith(' · 0 posts today (0 for a Social Alert, 0 monitoring only) · not posted: 0 already had an alert, 1 on a story already alerted'), note(w));
    // within the hour Step 1 doesn't weigh it again: it is read, and not counted
    eq(check(w), res({ skipped_duplicates: 1 }));
    eq(counts(w), [0, 0, 0, 0, 1]);
    // an hour on (the cache has forgotten Step 1's answer): weighed again, left out again, still counted once
    forget(w, 'bqstep1:');
    eq(check(w), res({ skipped_step1: 1 }));
    eq([counts(w), said(w).length], [[0, 0, 0, 0, 1], 1]);

    // Gemini leaves two posts out: one on that issue (the code's own rule finds Burson's alert), one on no alerted issue
    w.vertex.bqRecords = payload => {
      const recs = JSON.parse(payload.contents[0].parts.map(p => p.text || '').join('\n').match(/<records>\n([\s\S]*)\n<\/records>/)[1]);
      return { solo_alerts: [], group_waves: [], discarded_ids: recs.map(r => r.id) };
    };
    feed.bsip = [bsip(2, { issue_name: ISSUE, summary: 'Another X user says Google Search shows a biased picture of the Paris riots.' }), bsip(3)];
    eq([ownCall(w), check(w)], [0, res({ skipped_step1: 2 })]);
    eq([cards(w), counts(w), ownCall(w)], [[], [0, 0, 0, 0, 2], 1]);
    // (each in the order Step 1 was given them, said when the check is noted)
    eq(said(w).slice(1), [
      `BigQuery direct poll: not posted, on a story already alerted: ${link(2)} · ${prior} (Burson's alert) · Step 1, by Gemini`,
      `BigQuery direct poll: not posted, left out by Step 1: ${link(3)} · by Gemini (it matched no earlier alert)`,
    ]);
    assert.ok(note(w).endsWith(' · 0 posts today (0 for a Social Alert, 0 monitoring only) · not posted: 0 already had an alert, 2 on a story already alerted'), note(w));
    // weighed again an hour on, and left out again: neither is said or counted a second time
    forget(w, 'bqstep1:');
    eq(check(w), res({ skipped_step1: 2 }));
    eq([counts(w), ownCall(w), said(w).length], [[0, 0, 0, 0, 2], 1, 3]);
    w.vertex.bqRecords = null;

    // The post itself, under a link the log doesn't know it by: Step 1's own rule finds the earlier alert by the post
    const w2 = world();
    const feed2 = fakeBq(w2.g);
    w2.paste(F.P0_OK);  // Burson alerted SAM's post
    w2.run();
    const alerted = w2.alertRows()[0].alert_id;
    const OTHER_LINK = SAM.replace('x.com', 'vxtwitter.com');
    feed2.bsip = [samRow({ url: OTHER_LINK }), bsip(1)];
    eq(check(w2), res({ bsip: 1, skipped_step1: 1 }));
    eq([cards(w2), counts(w2)], [[link(1)], [1, 0, 0, 1, 0]]);
    eq(said(w2), [`BigQuery direct poll: not posted, it already had an alert: ${OTHER_LINK} · ${alerted} (Burson's alert) · Step 1, by the rules`]);
    // ...and the poll's own card found the same way (post 1 under another link, once its card is reviewed) is no other alert
    review(w2);
    forget(w2, 'bqstep1:');
    feed2.bsip = [bsip(1, { url: link(1).replace('x.com', 'vxtwitter.com') })];
    eq(check(w2), res({ skipped_step1: 1 }));
    eq([cards(w2), counts(w2), said(w2).length], [[link(1)], [1, 0, 1, 1, 0], 1]);
  });

  test('direct BQ C15: a post Step 1 leaves out on its own call has one line in the run log a day, however often Step 1 weighs it, like the two reasons C15 counts. Three posts are read at every check for 25 hours (300 checks, past midnight Eastern): one Burson alerted, one on that alert\'s issue, one Gemini leaves out with no earlier alert on its issue. With the script cache as it works (Step 1 weighs a post again every hour), with its keys for these counts emptied before every check, and with the whole cache emptied before every check (Step 1 then weighs the posts at every check): each post has one line a day, C15 counts the first two once a day and never the third, and the day\'s record counts the third apart', () => {
    const HOURLY = 12;  // checks in an hour: how long the cache keeps what Step 1 left out
    ['the cache as it works', 'its keys for these counts emptied before every check', 'the whole cache emptied before every check'].forEach((state, mode) => {
      const w = world();
      const feed = fakeBq(w.g);
      w.paste(F.P0_OK);  // Burson alerts SAM's post, on the Paris issue
      w.run();
      const prior = w.alertRows()[0].alert_id;
      // Gemini leaves post 3 out (no alert has its issue) and passes post 2, which the rules then leave out for its issue
      let weighed = 0;
      w.vertex.bqRecords = payload => {
        weighed++;
        const recs = JSON.parse(payload.contents[0].parts.map(p => p.text || '').join('\n').match(/<records>\n([\s\S]*)\n<\/records>/)[1]);
        const out = recs.filter(r => r.url === link(3)).map(r => r.id);
        return { solo_alerts: recs.filter(r => out.indexOf(r.id) < 0).map(r => ({ id: r.id, why_met_guidelines: 'A complaint about a Google product.' })),
          group_waves: [], discarded_ids: out };
      };
      feed.bsip = [samRow(), bsip(2, { issue_name: ISSUE, summary: 'Another X user says Google Search shows a biased picture of the Paris riots.' }), bsip(3)];
      const days = {};  // each day's counts as its last check left them: [what C15 shows, the posts left out on Step 1's own call]
      let longest = 0;
      for (let i = 0; i < 300; i++) {
        if (mode === 2 || i % HOURLY === 0) forget(w, 'bqstep1:');
        if (mode >= 1) forget(w, 'bqnp:');
        check(w);
        longest = Math.max(longest, note(w).length);
        days[today(w).day] = [counts(w), ownCall(w)];
      }
      eq([state, days], [state, { '2026-10-14': [[0, 0, 0, 1, 1], 1], '2026-10-15': [[0, 0, 0, 1, 1], 1] }]);
      // Step 1 weighed the two posts 25 times (once an hour), or at all 300 checks: one line a day for each reason all the same
      eq([state, weighed], [state, mode === 2 ? 300 : 300 / HOURLY]);
      const lines = reason => said(w).filter(l => l.indexOf(`BigQuery direct poll: not posted, ${reason}: `) === 0).map(l => l.split(': ').slice(2).join(': '));
      eq([state, lines('it already had an alert'), lines('on a story already alerted'), lines('left out by Step 1'), said(w).length], [state,
        Array(2).fill(`${SAM} · ${prior} (Burson's alert)`),
        Array(2).fill(`${link(2)} · ${prior} (Burson's alert) · Step 1, by the rules`),
        Array(2).fill(`${link(3)} · by Gemini (it matched no earlier alert)`), 6]);
      assert.ok(note(w).endsWith(` · 0 posts today (0 for a Social Alert, 0 monitoring only) · not posted: 1 already had an alert, 1 on a story already alerted`), note(w));
      assert.ok(longest <= 200, `${longest} characters`);
      eq([cards(w), today(w).k.map(id => id.charAt(0)).sort().join('')], [[], 'abo']);
    });

    // the other reason Step 1 can give on its own call (not about Google, by the rules: the poll's own test comes first,
    // so Step 1 hardly ever says it): its line, once a day as well
    const w = world();
    const feed = fakeBq(w.g);
    feed.bsip = [bsip(4)];
    w.bot.ev('evaluateBqDualTrack_ = records => ({ solo_alerts: [], group_waves: [], discarded_ids: records.map(r => r.id), by: "rules", ' +
      'left_out: records.map(r => bqLeftOut_(r.id, BQ_LEFT_OUT_.NOT_GOOGLE, null)) })');
    for (let i = 0; i < 5; i++) {
      forget(w, 'bqstep1:');
      forget(w, 'bqnp:');
      eq(check(w), res({ skipped_step1: 1 }));
    }
    eq([said(w), counts(w), ownCall(w)], [[`BigQuery direct poll: not posted, left out by Step 1: ${link(4)} · not about Google, by the rules`], [0, 0, 0, 0, 0], 1]);
  });

  // -----------------------------------------------------------------------------------------------------------
  // S and M: where a card's review ends
  // -----------------------------------------------------------------------------------------------------------

  test('direct BQ C15: a card is counted where its review ends, once: "for a Social Alert" when the review calls for one, "monitoring only" when it doesn\'t; C15 says so at the next check. Burson\'s own alert, a story\'s card and a Watch alert never count', () => {
    const w = world({ drafts: { live: false, standIn: TESTER } });
    w.chat.addDm(TESTER, 'spaces/DMSTANDIN');
    const feed = fakeBq(w.g);
    // a P0 exposure tag (a Social Alert whatever its size) and a P2 one at 620 engagements (none)
    feed.bsip = [bsip(0, { tags: 'Maps routing | Product - Perceived bias', total: 1200 }), bsip(1)];
    eq(check(w), res({ bsip: 2 }));
    eq(counts(w), [2, 0, 0, 0, 0]);
    assert.ok(note(w).endsWith(` · 2 posts today (0 for a Social Alert, 0 monitoring only)${NONE}`), note(w));
    review(w);
    eq([counts(w), w.gmail.sentMessages().map(m => m.to.join())], [[2, 1, 1, 0, 0], [TESTER]]);
    eq(w.alertRows().map(r => [r.ingested, r.email_status || '']), [['BSIP', 'sent'], ['BSIP', '']]);
    assert.ok(note(w).endsWith(` · 2 posts today (0 for a Social Alert, 0 monitoring only)${NONE}`), 'the note is the last check\'s');
    check(w);
    assert.ok(note(w).endsWith(` · 2 posts today (1 for a Social Alert, 1 monitoring only)${NONE}`), note(w));
    // once per card: more runs and checks move nothing
    review(w);
    check(w);
    review(w);
    eq(counts(w), [2, 1, 1, 0, 0]);
    // Burson's own alert, reviewed (a P0 one): not a Direct BigQuery card
    w.paste(F.P0_OK);
    w.run();
    eq([counts(w), w.alertRows().length], [[2, 1, 1, 0, 0], 3]);

    // the rule on its own: only a row the poll's card made (its `ingested` is one of the poll's sources) is counted
    const w2 = world();
    const reviewed = (ingested, alerted) => w2.bot.bqDirectReviewed_({ alert_id: 'QA-1', ingested }, alerted);
    ['', undefined, null, 'Early detection', 'Watch alert', 'Other alert', 'Sheet test alert', 'bsip', 'BSIP '].forEach(i => reviewed(i, true));
    w2.bot.bqDirectReviewed_(null, true);
    eq(w2.g.props.has('BQ_DIRECT_TODAY'), false);
    reviewed('BSIP', true);
    reviewed('BMIE', false);
    reviewed('Sprinklr', false);
    eq([counts(w2), B.bqDirectSource_('BSIP'), B.bqDirectSource_('Early detection'), B.bqDirectSource_('')], [[0, 1, 2, 0, 0], true, false, false]);
  });

  test('direct BQ C15: in the flows as they run. The one-space setup: the watch alerts a post first, then Direct BigQuery reads it (counted as already alerted, by the Watch alert), posts two cards (one reviewed for a Social Alert, one for none) and later reads another post on the first card\'s issue (on a story already alerted); column C says all of it. The golden scenarios end with their cards counted too, the Mirror flow\'s as the one-space setup\'s', () => {
    const { t, sh, feed, rec } = golden.world.oneSpaceWorld(golden.SETTINGS_OFF);
    const c15 = () => String(t.control().cell(15, 3));
    const state = () => { const d = JSON.parse(t.g.props.get('BQ_DIRECT_TODAY')); return ['n', 's', 'm', 'a', 'b'].map(k => d[k]); };
    rec.collect('setup');
    rec.step('the first run', 1);
    golden.world.watchOn(t);
    sh.getRange(35, 2).setValue('Auto-correct space (B10)');
    rec.step('the watch looks', 1, () => { feed.look = [golden.rows.hit()]; });
    rec.step('the watch alert is posted', 1);
    rec.step('the watch alert is triaged', 1, () => { feed.look = []; });
    const WATCHED = golden.posts.GEMINI;
    // Direct BigQuery reads the post the watch alerted, the Maps post (a P0 tag: a Social Alert) and the Pixel post (none)
    rec.step('Direct BigQuery reads three posts', 2, () => {
      feed.bsip = [golden.rows.bsipRow({ id: '2150000000000000003', url: WATCHED, handle: 'promptwatch', alert_names_json: '["Gemini App - Accuracy"]',
        tags: 'Product - Factual inaccuracies (not dangerous/offensive)', total: 520, issue_name: 'Gemini answer invents a court ruling',
        summary: 'An X user says the Gemini app invented a court ruling and cited it as real.' }), golden.rows.mapsRow(), golden.rows.bsipRow()];
    });
    const rows = t.bot.sheetBackend_(t.sheet()).loadAlerts();
    const watchAlert = rows.find(r => r.ingested === 'Watch alert');
    assert.ok(watchAlert && /^QA-\d+$/.test(watchAlert.alert_id), 'the watch alert has its Alert-log row');
    eq(state(), [2, 0, 0, 1, 0]);
    assert.ok(c15().endsWith(' · 2 posts today (0 for a Social Alert, 0 monitoring only) · not posted: 1 already had an alert, 0 on a story already alerted'), c15());
    eq(t.g.logs.filter(l => /^BigQuery direct poll: not posted/.test(l)),
      [`BigQuery direct poll: not posted, it already had an alert: ${WATCHED} · ${watchAlert.alert_id} (Watch alert)`]);
    rec.step('the two cards are reviewed', 1);
    eq(state(), [2, 1, 1, 1, 0]);
    // the next check reads them all again, and another post on the Maps card's issue
    const SECOND = 'https://x.com/bridgewatch/status/2150000000000000032';
    rec.step('Direct BigQuery reads another post on the Maps issue', 5, () => {
      feed.bsip = feed.bsip.concat([Object.assign(golden.rows.mapsRow(), { id: '2150000000000000032', url: SECOND, handle: 'bridgewatch', total: 900,
        summary: 'Another X user says Google Maps still routes drivers onto the closed bridge.' })]);
    });
    const mapsCard = t.bot.sheetBackend_(t.sheet()).loadAlerts().find(r => r.ingested === 'BSIP' && r.record_key === t.bot.recordKey_({ post_url: golden.posts.MAPS }));
    eq(state(), [2, 1, 1, 1, 1]);
    assert.ok(c15().endsWith(' · 2 posts today (1 for a Social Alert, 1 monitoring only) · not posted: 1 already had an alert, 1 on a story already alerted'), c15());
    eq(t.g.logs.filter(l => /^BigQuery direct poll: not posted/.test(l)).slice(1),
      [`BigQuery direct poll: not posted, on a story already alerted: ${SECOND} · ${mapsCard.alert_id} (BSIP) · Step 1, by the rules`]);
    // what was posted is the two cards, each with its review note; the post left out got nothing
    const out = rec.out();
    eq(out.chat.filter(m => !m.reply && /\*\[BigQuery · BSIP\]\*/.test(m.text)).map(m => m.text.match(/\[Link\]: (\S+)/)[1]), [golden.posts.MAPS, golden.posts.PIXEL]);
    eq(out.chat.filter(m => m.text.includes(SECOND)), []);
    eq(out.emails.map(e => [e.kind, e.to]), [['sent', [TESTER]]]);

    // the golden scenarios: one card reviewed for no Social Alert in the Mirror flow; in the one-space setup the Pixel
    // card for none and the Maps card for one. No post in them is left out
    const endOf = run => { const d = JSON.parse(run.t.g.props.get('BQ_DIRECT_TODAY')); return [d.n, d.s, d.m, d.a, d.b, d.k]; };
    eq([endOf(golden.mirrorRun(golden.SETTINGS_OFF)), endOf(golden.oneSpaceRun(golden.SETTINGS_OFF)), endOf(golden.oneSpaceRun())],
      [[1, 0, 1, 0, 0, []], [2, 1, 1, 0, 0, []], [2, 1, 1, 0, 0, []]]);
  });

  // -----------------------------------------------------------------------------------------------------------
  // The day's record
  // -----------------------------------------------------------------------------------------------------------

  test('direct BQ C15: the day\'s record (script property BQ_DIRECT_TODAY: {day, n, s, m, a, b, o, k}) stays well under a property\'s 9 KB: it keeps the newest 300 posts C15 counts and, apart from them, the newest 100 that Step 1 left out on its own call (those never push out a post C15 counts); its worst case is under 8,800 characters; a record from before the new counts keeps its posts, one of another day or one that can\'t be read starts from nothing; with the switch OFF nothing is counted or logged', () => {
    const w = world();
    const day = w.bot.dayKey_();
    eq(day, '2026-10-14');
    eq(B.ev('[BQ_NOT_POSTED_KEPT_, BQ_LEFT_OUT_KEPT_]'), [300, 100]);
    // 400 posts not posted for each reason, each with a long key: all counted and logged, 300 + 100 kept
    const s = w.bot.bqDirectDay_(JSON.stringify({ day, n: 99999999, s: 49999999, m: 49999999 }));
    const many = (why, n) => Array.from({ length: n || 400 }, (_, i) => ({ why, key: `x.com/status/${'9'.repeat(1200)}${i}`, url: `https://x.com/u/status/${i}`,
      said: why === 'o' ? 'by Gemini (it matched no earlier alert)' : 'QA-1 (Watch alert)' }));
    const kinds = () => ['a', 'b', 'o'].map(why => s.k.filter(id => id.charAt(0) === why).length);
    w.bot.bqCountNotPosted_(s, many('a'));
    eq([s.a, kinds()], [400, [300, 0, 0]]);
    // the posts Step 1 left out on its own call have room of their own: 400 of them push out none of the 300
    w.bot.bqCountNotPosted_(s, many('o'));
    eq([s.o, kinds()], [400, [300, 0, 100]]);
    w.bot.bqCountNotPosted_(s, many('b'));
    eq([s.b, kinds()], [400, [0, 300, 100]]);
    Object.assign(s, { a: s.a + 99999000, b: s.b + 99999000, o: s.o + 99999000 });
    const text = JSON.stringify(s);
    eq([s.a, s.b, s.o, s.k.length, s.k.every(id => /^[bo][0-9a-f]{1,8}:\d{4}$/.test(id))], [99999400, 99999400, 99999400, 400, true]);
    assert.ok(text.length < 8800, `${text.length} characters`);
    const lines = w.g.logs.filter(l => /^BigQuery direct poll: not posted/.test(l));
    eq([lines.length, lines[0], lines[400], lines[800]], [1200,
      'BigQuery direct poll: not posted, it already had an alert: https://x.com/u/status/0 · QA-1 (Watch alert)',
      'BigQuery direct poll: not posted, left out by Step 1: https://x.com/u/status/0 · by Gemini (it matched no earlier alert)',
      'BigQuery direct poll: not posted, on a story already alerted: https://x.com/u/status/0 · QA-1 (Watch alert)']);
    // counted again in the same order: all known (the newest by the record, the others by their cache key)
    w.bot.bqCountNotPosted_(s, many('b').concat(many('o')));
    eq([s.b, s.o, s.k.length, w.g.logs.filter(l => /^BigQuery direct poll: not posted/.test(l)).length], [99999400, 99999400, 400, 1200]);
    // which ones are kept, by itself: each kind's newest, in the order they were counted; anything else is passed over
    const mixed = ['a1:1', 'o1:1', 'b2:1', 'o2:1', 'a3:1'];
    eq([B.bqNotPostedKept_(mixed), B.bqNotPostedKept_([]), B.bqNotPostedKept_(null), B.bqNotPostedKept_(undefined)], [mixed, [], [], []]);
    const long = Array.from({ length: 350 }, (_, i) => `a${i}:1`).concat(Array.from({ length: 150 }, (_, i) => `o${i}:1`), ['b9:1']);
    const kept = B.bqNotPostedKept_(long);
    eq([kept.length, kept[0], kept[298], kept[299], kept[398], kept[399]], [400, 'a51:1', 'a349:1', 'o50:1', 'o149:1', 'b9:1']);
    const before = { a: s.a, b: s.b, o: s.o, k: s.k.length };
    w.bot.bqCountNotPosted_(s, [null, undefined, {}, { why: 'x', key: 'k', url: 'u', said: '' }, { why: 'constructor', key: 'k', url: 'u', said: '' },
      { why: 'k', key: 'k', url: 'u', said: '' }, { why: 'day', key: 'k', url: 'u', said: '' }]);
    eq([{ a: s.a, b: s.b, o: s.o, k: s.k.length }, s.day, Array.isArray(s.k)], [before, day, true]);
    // what bqDirectDay_ reads
    const read = raw => w.bot.bqDirectDay_(raw);
    const NEW = { day, n: 0, s: 0, m: 0, a: 0, b: 0, o: 0, k: [] };
    eq([read(JSON.stringify({ day, n: 7 })), read(JSON.stringify({ day: '2026-10-13', n: 7, s: 3, m: 4, a: 5, b: 6, o: 8, k: ['a1:2'] })),
      read('{not json'), read(null), read('[]'), read(JSON.stringify({ day, n: -4, s: 'x', o: 'z', k: 'y' }))],
    [Object.assign({}, NEW, { n: 7 }), NEW, NEW, NEW, NEW, NEW]);
    eq(read(JSON.stringify({ day, n: 2, s: 1, m: 1, a: 3, b: 4, o: 5, k: ['a1:2', 'o5:6', 'b3:4'] })),
      { day, n: 2, s: 1, m: 1, a: 3, b: 4, o: 5, k: ['a1:2', 'o5:6', 'b3:4'] });
    // (a record written before the posts Step 1 left out on its own call were counted keeps what it has)
    eq(read(JSON.stringify({ day, n: 2, s: 1, m: 1, a: 3, b: 4, k: ['a1:2', 'b3:4'] })), { day, n: 2, s: 1, m: 1, a: 3, b: 4, o: 0, k: ['a1:2', 'b3:4'] });

    // the poll with the switch OFF (its settings alone): it reads and posts as before, counts nothing, logs no such line,
    // whatever the reason a post gets no card for: Burson alerted it, it is on that alert's issue, Gemini left it out
    const off = world();
    const feed = fakeBq(off.g);
    off.paste(F.P0_OK);
    off.run();
    off.vertex.bqRecords = payload => {
      const recs = JSON.parse(payload.contents[0].parts.map(p => p.text || '').join('\n').match(/<records>\n([\s\S]*)\n<\/records>/)[1]);
      const out = recs.filter(r => r.url === link(3)).map(r => r.id);
      return { solo_alerts: recs.filter(r => out.indexOf(r.id) < 0).map(r => ({ id: r.id, why_met_guidelines: 'A complaint about a Google product.' })),
        group_waves: [], discarded_ids: out };
    };
    feed.bsip = [samRow(), bsip(1), bsip(2, { issue_name: ISSUE, summary: 'Another X user says Google Search shows a biased picture of the Paris riots.' }), bsip(3)];
    const ctx = off.ctx();
    Object.assign(ctx.settings, { bq_direct_poll: true, bq_poll_bsip: true });
    eq(off.bot.pollBigQuerySources_(ctx, off.BUR), res({ bsip: 1, skipped_duplicates: 1, skipped_step1: 2 }));
    eq([off.g.props.has('BQ_DIRECT_TODAY'), off.g.props.has('SWITCH_NOTES'), said(off)], [false, false, []]);
    // (the same check with the switch ON says all three)
    const on = world();
    const onFeed = fakeBq(on.g);
    on.paste(F.P0_OK);
    on.run();
    on.vertex.bqRecords = off.vertex.bqRecords;
    onFeed.bsip = feed.bsip;
    eq(check(on), res({ bsip: 1, skipped_duplicates: 1, skipped_step1: 2 }));
    eq([counts(on), ownCall(on), said(on).map(l => l.replace(/^BigQuery direct poll: not posted, ([^:]+): .*$/, '$1'))],
      [[1, 0, 0, 1, 1], 1, ['it already had an alert', 'on a story already alerted', 'left out by Step 1']]);
  });
};
