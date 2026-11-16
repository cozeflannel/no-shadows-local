// Two end-to-end scenarios whose outputs were recorded at commit f93e31a (golden_flows_f93e31a.json): the net under
// "the Mirror flow stays byte for byte" and "a setting turned off gives what the bot did before". Used by
// switch_golden_flows.test.js, and by any later test file:
//
//   const golden = require('./golden_flows')(H);     // H: the helpers every switch_*.test.js file is given
//   golden.mirror(overrides)                -> what the Mirror flow put out
//   golden.oneSpace(overrides)              -> what the one-space setup put out
//   golden.SETTINGS_OFF                     -> the overrides that turn every new behaviour of the fix plan off
//   golden.recorded.mirror, .one_space      -> what each put out at f93e31a (never edited)
//   golden.differences(actual, expected)    -> [] when they are the same, else where they first differ
//   golden.mirrorRun(overrides), golden.oneSpaceRun(overrides) -> {t, out}: the scenario's world too, to look further
//
// `overrides` are settings (config/default_config.yaml burson_qa -> GEN.settings), put on the scenario's own bot before
// its first run, so code with a flow ctx (ctx.settings: a copy of GEN.settings made each run) and code without one (the
// watch reads GEN.settings) both see them.
//
// What a scenario returns, each list in the order it happened:
//   chat       every message the bot posted in any space but the Burson test copy: {run, space, thread, reply, text}
//   test_copy  every message it posted in the Burson test copy (B26): the same fields
//   reactions  every emoji it put on a message: {run, on, emoji}
//   emails     every email it sent, and every Gmail draft it made, changed or deleted: {run, kind, to, cc, bcc, subject,
//              text, html}
//   outbox     every row of the Burson outbox tab, as it stands at the end (all its columns)
// `run` is the scenario's step the output came in. The Control tab's notes are left out on purpose: later changes
// reword them.
//
// Everything is deterministic: the harness's fake clock, scripted Gemini and Gemini Decisions answers, and feeds that
// hand over exactly what each step says.
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = H => {
  const { e2e, F, REAL } = H;
  const MIN = 60 * 1000;
  const C1 = 'us-central1';
  const TESTER = 'tester@testing.test';
  const DM = 'spaces/DMTESTER01';
  const ZAPIER = { sender: 'users/zapier', type: 'BOT', displayName: 'Zapier' };
  const WATCH = 'Google brand safety (all)';  // one of the watches a new Watches tab starts with

  // The settings of the fix plan, each at the value that keeps what the bot did before it
  const SETTINGS_OFF = {
    early_detection_first: false,
    early_wave_reviews_per_hour: 0,
    early_wave_reviews_per_day: 150,
    early_wave_topic_min_ratio: 0,
    early_detection_tab: false,
    cross_alert_notes: false,
    requirement_line: false,
  };

  // -----------------------------------------------------------------------------------------------------------
  // What the listening feeds hand over
  // -----------------------------------------------------------------------------------------------------------

  // The Direct BigQuery poll's BSIP read (BigQuery.gs bqBsipCandidates_)
  const BSIP_COLS = [['source_kind'], ['id'], ['url'], ['handle'], ['network'], ['alert_names_json'], ['tags'], ['criticality'],
    ['followers', 'INTEGER'], ['total', 'INTEGER'], ['summary'], ['issue_name'], ['post_time']];
  // A watch look's result (ProactiveWatch.gs pwSql_'s final SELECT)
  const PW_COLS = [['kind'], ['source'], ['why'], ['idx', 'INTEGER'], ['watch'], ['post_url'], ['platform'], ['author'],
    ['followers', 'INTEGER'], ['eng', 'INTEGER'], ['posted_ms', 'INTEGER'], ['seen_ms', 'INTEGER'], ['issue'], ['issue_new', 'BOOLEAN'],
    ['summary'], ['impact', 'FLOAT'], ['bar', 'FLOAT'], ['topic'], ['found', 'INTEGER'], ['checked', 'INTEGER'],
    ['newest_ms', 'INTEGER'], ['mod_ms', 'INTEGER'], ['err'], ['detail'], ['tax']];
  const srcRow = source => ({ kind: 'src', source, found: 0, checked: 0, newest_ms: null, mod_ms: null, err: null });
  const C1_SRC = ['sonar', 'tubular', 'outbound'].map(srcRow);
  const US_SRC = ['bmie', 'comments', 'story', 'chat', 'bwq'].map(srcRow);

  const PIXEL = 'https://x.com/pixelcritic/status/2150000000000000001';   // Direct BigQuery; later a story's main post
  const MAPS = 'https://x.com/roadwatcher/status/2150000000000000002';    // Direct BigQuery and the watch both find it
  const GEMINI = 'https://x.com/promptwatch/status/2150000000000000003';  // a watch flag of its own
  const CHROME = 'https://x.com/tabhoarder/status/2150000000000000011';   // a story's main post

  const bsipRow = o => Object.assign({ source_kind: 'BSIP', id: '2150000000000000001', url: PIXEL, handle: 'pixelcritic', network: 'Twitter',
    alert_names_json: '["Pixel - Reliability"]', tags: 'Pixel battery | Product - Other/general criticism', criticality: 'HIGH',
    followers: 3200, total: 800, summary: 'An X user says their Google Pixel 10 battery swelled up after the latest update.',
    issue_name: 'Pixel 10 battery swelling after update', post_time: '2026-10-14 11:40:00+00' }, o || {});
  const mapsRow = () => bsipRow({ id: '2150000000000000002', url: MAPS, handle: 'roadwatcher',
    alert_names_json: '["Google Maps - Accuracy"]', tags: 'Maps routing | Product - Perceived bias', followers: 41000, total: 2400,
    summary: 'An X user says Google Maps keeps sending drivers onto a closed bridge and calls the routing biased toward toll roads.',
    issue_name: 'Maps routing onto a closed bridge', post_time: '2026-10-14 11:55:00+00' });

  const hit = o => Object.assign({ kind: 'hit', source: 'sonar', idx: 1, watch: WATCH, post_url: GEMINI, platform: 'twitter',
    author: '@promptwatch', followers: 18000, eng: 520, posted_ms: null, seen_ms: null,
    issue: 'Gemini answer invents a court ruling', issue_new: true,
    summary: 'An X user (@promptwatch, 18K followers) says the Gemini app invented a court ruling and cited it as real.',
    impact: 8, bar: 7, topic: 'AI answers and Gemini' }, o || {});
  const mapsHit = () => hit({ post_url: MAPS, author: '@roadwatcher', followers: 41000, eng: 2400,
    issue: 'Maps routing onto a closed bridge',
    summary: 'An X user (@roadwatcher, 41K followers) says Google Maps keeps sending drivers onto a closed bridge.',
    topic: 'Product failure or outage' });
  const pixelHit = () => hit({ post_url: PIXEL, author: '@pixelcritic', followers: 3200, eng: 800,
    issue: 'Pixel 10 battery swelling after update',
    summary: 'An X user (@pixelcritic, 3.2K followers) says their Pixel 10 battery swelled up after the latest update.',
    topic: 'Product failure or outage' });

  const rep = (url, author, eng, snippet, platform) => ({ platform: platform || 'X', author_handle: author, followers: 900,
    engagement_total: eng, published_at: '2026-10-14 11:42 UTC', url, snippet });
  // A story the producer found: several small accounts saying the same thing
  const story = o => Object.assign({
    alert_id: 'ED-CLU-clu_chrome_tabs-202610141200', created_utc: '2026-10-14 12:00 UTC', signal_type: 'CLUSTER_EMERGENCE',
    velocity_grain: '', cluster_id: 'clu_chrome_tabs', signal_key: 'clu_chrome_tabs',
    headline: 'Low-tier claim cluster (6 accounts): Chrome closed all my tabs after the update',
    topic_product: 'Chrome', priority_hint: 'P1', unique_low_tier_authors: 6, mention_count: 7, platform_count: 2,
    platforms_csv: 'X, Reddit', baseline_authors: 0, velocity_ratio: 0, absolute_author_delta: 0, primary_url: CHROME,
    representative_posts_json: JSON.stringify([
      rep(CHROME, 'tabhoarder', 44, 'Chrome closed all my tabs after the update and the session restore is empty.'),
      rep('https://x.com/devnotes_k/status/2150000000000000012', 'devnotes_k', 31, 'Same here: Chrome update wiped every open tab, nothing in history to restore.'),
      rep('https://www.reddit.com/r/chrome/comments/1q2tabs/update_closed_tabs/', 'u_tab_loss', 27,
        'Chrome update closed all tabs and restore session does nothing. Anyone else?', 'Reddit'),
      rep('https://x.com/latenightcoder/status/2150000000000000014', 'latenightcoder', 19, 'Lost 60 tabs to the Chrome update tonight.'),
    ]),
    chatbot_card_text: '', risk_groups: 'outage_broken_feature', tag_raised: false,
  }, o || {});
  // ...and one whose main post is the post of the Direct BigQuery card
  const pixelStory = () => story({
    alert_id: 'ED-CLU-clu_pixel_battery-202610141230', created_utc: '2026-10-14 12:30 UTC', cluster_id: 'clu_pixel_battery',
    signal_key: 'clu_pixel_battery',
    headline: 'Low-tier claim cluster (5 accounts): my Pixel 10 battery swelled up after the latest update',
    topic_product: 'Pixel', unique_low_tier_authors: 5, mention_count: 6, primary_url: PIXEL,
    representative_posts_json: JSON.stringify([
      rep(PIXEL, 'pixelcritic', 120, 'My Pixel 10 battery swelled up after the latest update, the back cover is lifting.'),
      rep('https://x.com/droidfan22/status/2150000000000000022', 'droidfan22', 40, 'Same here, Pixel 10 battery is swelling since the update.'),
      rep('https://www.reddit.com/r/GooglePixel/comments/1p9xyz/battery_swelling/', 'u_pixel_owner', 35,
        'Pixel 10 battery swelling after update, anyone else seeing the back pop off?', 'Reddit'),
    ]),
  });

  // A recorded real answer of Gemini Decisions (severity high, brand risk 0.94): never held back as noise
  const DECISIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'decisions_fixtures.json'), 'utf8'))
    .signal_responses['ED-CLU-CLU-e9dddc0be913-202611071746'];

  /**
   * The feeds of a scenario's world: BigQuery (the Direct BigQuery poll's reads, and the watch's looks, each sent in one
   * run and collected in a later one), the producer's story signals and Gemini Decisions. feed.bsip, feed.stories and
   * feed.look (the flags the next look collected brings) say what each hands over from now on.
   */
  function feedsOf(t) {
    const feed = { bsip: [], stories: [], look: [], jobs: {}, seq: 0 };
    t.bot.bqEarlyDetectionRows_ = () => feed.stories.map(r => JSON.parse(JSON.stringify(r)));
    const orig = t.g.services.UrlFetchApp.fetch;
    const resp = (code, body) => ({ getResponseCode: () => code, getHeaders: () => ({}),
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    const table = (cols, rows) => ({ schema: { fields: cols.map(c => ({ name: c[0], type: c[1] || 'STRING' })) },
      rows: (rows || []).map(r => ({ f: cols.map(c => ({ v: r[c[0]] === undefined || r[c[0]] === null ? null : String(r[c[0]]) })) })) });
    t.g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      if (url.includes('secretmanager.googleapis.com/')) {
        return resp(200, { payload: { data: Buffer.from('test-only-decisions-key-value-99', 'utf8').toString('base64') } });
      }
      if (url.includes('/decisions')) return resp(200, DECISIONS);
      if (!url.startsWith('https://bigquery.googleapis.com/')) return orig(link, params);
      const method = String((params && params.method) || 'get').toLowerCase();
      if (method === 'post' && /\/jobs\/[^/]+\/cancel/.test(url)) return resp(200, {});
      if (method === 'post' && /\/queries$/.test(url)) {
        const body = JSON.parse(params.payload);
        const sql = String(body.query || '');
        if (/CREATE TEMP TABLE pw_new/.test(sql)) {  // a watch's look: answered when it is collected
          const jobId = `pwjob_${++feed.seq}`;
          feed.jobs[jobId] = body.location;
          return resp(200, { jobComplete: false, jobReference: { projectId: 'brand-social-central-data', jobId, location: body.location } });
        }
        if (/"BSIP" AS source_kind/.test(sql)) return resp(200, Object.assign({ jobComplete: true }, table(BSIP_COLS, feed.bsip)));
        return resp(200, Object.assign({ jobComplete: true }, table([['url']], [])));  // every other read: no rows
      }
      if (method === 'get' && /\/queries\/pwjob_\d+\?/.test(url)) {
        const jobId = url.match(/pwjob_\d+/)[0];
        const location = feed.jobs[jobId] || C1;
        const rows = location === C1 ? feed.look.concat(C1_SRC) : US_SRC;
        return resp(200, Object.assign({ jobComplete: true, jobReference: { projectId: 'brand-social-central-data', jobId, location } },
          table(PW_COLS, rows)));
      }
      return orig(link, params);
    };
    return feed;
  }

  // -----------------------------------------------------------------------------------------------------------
  // Gemini's scripted answers
  // -----------------------------------------------------------------------------------------------------------

  const promptOf = payload => payload.contents[0].parts.map(p => p.text || '').join('\n');

  function scriptGemini(t) {
    const v = t.g.vertex;
    // an alert's review (Burson's, a Direct BigQuery card's): no check fails; where the review is asked for the write-up
    // (the Auto-correct space only), it writes one
    v.assess = payload => {
      const text = promptOf(payload);
      if (!payload.generationConfig.responseSchema.properties.writeup) return { checks: [] };
      const writeup = /pixelcritic/.test(text)
        ? 'X user @pixelcritic (3,200 followers) says their Pixel 10 battery swelled up after the latest update and that ' +
          'the back cover is lifting. The post does not say which update.'
        : /roadwatcher/.test(text)
          ? 'X user @roadwatcher (41,000 followers) says Google Maps keeps sending drivers onto a closed bridge and calls ' +
            'the routing biased toward toll roads. The post does not name the bridge.'
          : /edervolcelazz/.test(text)
            ? 'X user @edervolcelazz criticized AI Overviews in a reply, saying the answer it gave was offensive. The post ' +
              'does not show the answer.'
            : '';
      return writeup ? { checks: [], writeup: { post: writeup, background: null } } : { checks: [] };
    };
    // Step 1 of the Direct BigQuery evaluation: every record passes
    v.bqRecords = payload => {
      const m = promptOf(payload).match(/<records>\n([\s\S]*)\n<\/records>/);
      const recs = m ? JSON.parse(m[1]) : [];
      return { solo_alerts: recs.map(r => ({ id: r.id, why_met_guidelines: 'A specific complaint about a Google product.' })),
        group_waves: [], discarded_ids: [] };
    };
    // a story's review: worth monitoring
    v.earlyDetection = payload => {
      const pixel = /clu_pixel_battery/.test(promptOf(payload));
      return {
        summary: pixel ? 'Five small accounts on X and Reddit say their Pixel 10 batteries swelled after the latest update.'
          : 'Six small accounts on X and Reddit say a Chrome update closed all their open tabs and that session restore is empty.',
        issue_name: pixel ? 'Pixel 10 battery swelling reports after update' : 'Chrome update closes all open tabs',
        emerging_narrative: pixel ? 'Independent Pixel 10 owners describe swollen batteries after the update.'
          : 'Independent Chrome users describe losing every open tab after the update.',
        early_detection_call: { disposition: 'monitor', severity: 'medium', confidence: 0.86,
          reason: pixel ? 'Several independent owners describe the same hardware safety symptom'
            : 'Several independent users describe the same data loss after one update',
          build_up_signals: pixel ? '5 accounts on 2 platforms' : '6 accounts on 2 platforms',
          watch_for: 'An official statement or press pickup' },
        temp_check_draft: { recommended: true,
          query_suggestion: pixel ? '"Pixel 10" AND (battery OR swelling OR swollen)' : 'Chrome AND (tabs OR "session restore") AND update',
          scope_note: 'Last 6 hours across X and Reddit' },
        slrr: { is_slrr: true, confidence: 0.85, exposure_tag: 'Product - Other/general criticism', product: pixel ? 'Pixel' : 'Chrome',
          other_products: [], sensitive_topics: [], location: 'US' },
        known_issue: { matches: false, confidence: 0.9 },
        tns: { needed: false, reason: '' }, recommended_groups: [],
        story_title: pixel ? 'Pixel 10 owners say batteries are swelling after the update'
          : 'Chrome users say the update closed all their open tabs',
        story: pixel ? 'Owners describe [swollen batteries](P1) on X and [Reddit](P3).'
          : 'Users say the update [closed every open tab](P1) and that [session restore does nothing](P3).',
        web_context: '', next_steps: ['Keep monitoring for volume growth and re-check in 2 hours.'], driver_post: 'P1',
      };
    };
    // a watch flag's pre-read: its card's summary and classification lines
    v.watchPreRead = payload => {
      const m = promptOf(payload).match(/<watch_posts>\n([\s\S]*?)\n<\/watch_posts>/);
      const posts = m ? JSON.parse(m[1]) : [];
      return { watch_posts: posts.map(p => {
        const maps = /roadwatcher/.test(JSON.stringify(p));
        return { ref: p.ref,
          summary: maps ? 'X account @roadwatcher (41K followers) says Google Maps keeps sending drivers onto a closed bridge.'
            : 'X account @promptwatch (18K followers) says the Gemini app invented a court ruling and cited it as real.',
          background: '', about_google: true, product: maps ? 'Maps' : 'Gemini App', other_products: [],
          exposure_tag: maps ? 'Product - Perceived bias' : 'Product - Factual inaccuracies (not dangerous/offensive)',
          sensitive_topics: [], story: maps ? 'Google Maps routes drivers onto a closed bridge' : 'Gemini app invents a court ruling',
          same_story_as: '', meaningful: true };
      }) };
    };
    // a watch alert's triage: worth a look, below the email bar
    v.triage = () => ({
      summary: 'An X user (@promptwatch, 18K followers) says the Gemini app invented a court ruling and cited it as real.',
      issue_name: 'Gemini answer invents a court ruling',
      stream_fit: 'A claim that a Google AI product made up a legal fact.', risks: ['misinformation'],
      stream_call: { action: 'flag', severity: 'medium', confidence: 0.8, reason: 'A made-up legal citation from a Google AI product',
        watch_for: 'A KOF or 2,000+ engagements amplifying it' },
      slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Product - Factual inaccuracies (not dangerous/offensive)',
        product: 'Gemini App', sensitive_topics: [], warranted: false, warranted_confidence: 0.8, why: 'Below the engagement bar' },
      tns: { needed: false },
    });
  }

  // -----------------------------------------------------------------------------------------------------------
  // What a scenario put out
  // -----------------------------------------------------------------------------------------------------------

  /**
   * The scenario's recorder: step(label, minutes, before) runs one poll() `minutes` after the last one (`before`: what
   * happens in the spaces and the feeds first) and notes what came out under `label`; out() is the whole record.
   */
  function recorder(t, copySpace) {
    const out = { chat: [], test_copy: [], reactions: [], emails: [], outbox: [] };
    const seen = { msgs: new Set(), reacts: new Set(), sent: 0, drafts: new Map() };
    const order = m => Number(String(m.name).split('/messages/m')[1]);
    const collect = run => {
      const fresh = [];
      t.chat.spaces.forEach(s => s.messages.forEach(m => {
        if (m.viaApi && !seen.msgs.has(m.name)) { seen.msgs.add(m.name); fresh.push(m); }
        m.reactions.forEach((r, i) => {
          const key = `${m.name}|${i}`;
          if (r.user !== t.chat.botUser || seen.reacts.has(key)) return;
          seen.reacts.add(key);
          out.reactions.push({ run, on: m.name, emoji: r.emoji });
        });
      }));
      fresh.sort((a, b) => order(a) - order(b)).forEach(m => {
        const space = m.name.split('/messages/')[0];
        const entry = { run, space, thread: m.thread.name, reply: m.threadReply, text: m.text };
        (space === copySpace ? out.test_copy : out.chat).push(entry);
      });
      const mail = (kind, m) => ({ run, kind, to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, text: m.text, html: m.html });
      const sent = t.g.gmail.sentMessages();
      sent.slice(seen.sent).forEach(m => out.emails.push(mail('sent', m)));
      seen.sent = sent.length;
      const drafts = t.g.gmail.allDrafts();
      drafts.forEach(d => {
        if (seen.drafts.get(d.id) === d.raw) return;
        out.emails.push(mail(seen.drafts.has(d.id) ? 'draft changed' : 'draft', d));
        seen.drafts.set(d.id, d.raw);
      });
      Array.from(seen.drafts.keys()).filter(id => !drafts.some(d => d.id === id)).forEach(id => {
        seen.drafts.delete(id);
        out.emails.push({ run, kind: 'draft deleted', id });
      });
    };
    return {
      step(label, minutes, before) {
        t.g.clock.now += Math.max(0, minutes * MIN - MIN);  // poll() itself moves the clock on a minute
        if (before) before();
        t.poll();
        collect(label);
      },
      collect,
      out() {
        const tab = t.sheet().getSheetByName('Burson outbox');
        out.outbox = tab ? tab.rows.slice(1).map(r => r.slice()) : [];
        return JSON.parse(JSON.stringify(out));
      },
    };
  }

  /** setup() for a scenario: its own bot with `overrides` on its settings, the tester in B30 and S-F Burson in B25. */
  function start(overrides, spaces) {
    const t = e2e();
    Object.assign(t.bot.ev('GEN').settings, overrides || {});
    spaces.forEach(([id, name]) => t.chat.addSpace(id, name));
    t.bot.setup();
    t.set('B30', TESTER);
    t.chat.addDm(TESTER, DM);
    t.set('B25', REAL);
    return t;
  }

  /** The watch's tabs are made by a first run with row 34 ON; then its "Google brand safety (all)" watch is turned ON. */
  function watchOn(t) {
    const tab = t.sheet().getSheetByName('Watches');
    const row = tab.rows.findIndex(r => r[0] === WATCH);
    if (row < 0) throw new Error(`golden flows: the Watches tab has no "${WATCH}" watch`);
    tab.getRange(row + 1, 2).setValue('ON');
  }

  // -----------------------------------------------------------------------------------------------------------
  // (a) The Mirror flow: B9 the Mirror space, rows 15, 19, 22, 24 and 34 ON, the watch's alerts going to the Mirror space
  //     (B35). First Testing with a Burson test copy (B26), where what Burson would get goes to the test copy; then LIVE
  //     (B26 cleared, the Safety valve OFF), where it waits on the Burson outbox and the Social Alert is a draft for the
  //     real recipients.
  // -----------------------------------------------------------------------------------------------------------

  const MIRROR = 'spaces/AAQAmirrorgf1';
  const MIRROR_NAME = 'SLRR Zapier Training Mirror';
  const COPY = 'spaces/AAQAtestcpgf1';
  const COPY_NAME = 'SLRR Burson Test Copy';
  const ANALYST = { sender: 'users/analyst9', displayName: 'Dana Lee' };
  const BURSON = { sender: 'users/burson7', displayName: 'Alice Smith' };
  const MISTAKES_2 = F.MISTAKES.split('2109566527900926417').join('2109566527900926999');  // another post, the same mistakes
  const MISTAKES_2_FIXED = F.MISTAKES_FIXED.split('2109566527900926417').join('2109566527900926999');

  function mirrorRun(overrides) {
    const t = start(overrides, [[MIRROR, MIRROR_NAME], [COPY, COPY_NAME]]);
    const sh = t.control();
    const feed = feedsOf(t);
    scriptGemini(t);
    const rec = recorder(t, COPY);
    rec.collect('setup');
    t.bot.startMirror(MIRROR_NAME);  // B9, and a run
    rec.collect('00 the Mirror space is set');
    t.set('B26', COPY_NAME);
    [15, 19, 22, 24, 34].forEach(r => sh.getRange(r, 2).setValue('ON'));
    rec.step('01 first run: the Relay starts and the watch tabs are made', 1);
    watchOn(t);
    sh.getRange(35, 2).setValue('Mirror space (B9)');
    const mirrorTop = text => t.chat.botPosts(MIRROR).find(m => !m.threadReply && m.text === text);

    // Testing, with the Burson test copy
    rec.step('02 quiet run', 1);
    let first = null;
    rec.step('03 Burson alert with mistakes', 1, () => { first = t.chat.say(REAL, F.MISTAKES, ZAPIER); });
    rec.step('04 an analyst replies in the Mirror space and Burson asks a question', 1, () => {
      t.chat.say(MIRROR, 'Thanks, we are checking this one now.', Object.assign({ thread: mirrorTop(F.MISTAKES).thread.name }, ANALYST));
      t.chat.say(REAL, 'Why is the product wrong?', Object.assign({ thread: first.thread.name }, BURSON));
    });
    rec.step('05 Burson resends the alert, fixed', 1, () => { t.chat.say(REAL, F.MISTAKES_FIXED, ZAPIER); });
    rec.step('06 Direct BigQuery finds the Pixel post: posted and reviewed', 2, () => { feed.bsip = [bsipRow()]; });
    // the watch flags a post of its own, and the Pixel post that already has its Direct BigQuery card
    rec.step('07 the watch flags the Gemini post and the Pixel post', 1, () => { feed.look = [hit(), pixelHit()]; });
    rec.step('08 the watch alert is triaged', 1, () => { feed.look = []; });
    // a story of its own, and one whose main post is the Pixel post
    rec.step('09 two stories are found: one is reviewed and posted', 7, () => { feed.stories = [story(), pixelStory()]; });
    rec.step('10 quiet run', 1);

    // LIVE
    rec.step('11 the test copy is cleared: LIVE', 1, () => { t.set('B26', ''); });
    let second = null;
    rec.step('12 LIVE: Burson alert with mistakes', 1, () => { second = t.chat.say(REAL, MISTAKES_2, ZAPIER); });
    rec.step('13 LIVE: an analyst replies in the Mirror space and Burson asks a question', 1, () => {
      t.chat.say(MIRROR, 'Thanks, we are checking this one now.', Object.assign({ thread: mirrorTop(MISTAKES_2).thread.name }, ANALYST));
      t.chat.say(REAL, 'Why is the product wrong?', Object.assign({ thread: second.thread.name }, BURSON));
    });
    rec.step('14 LIVE: Burson resends the alert, fixed', 1, () => { t.chat.say(REAL, MISTAKES_2_FIXED, ZAPIER); });
    rec.step('15 quiet run', 1);
    return { t, out: rec.out() };
  }

  // -----------------------------------------------------------------------------------------------------------
  // (b) The one-space setup: B3, B4 and B9 blank; B10 the Auto-correct space; B25 the live Burson space, read only;
  //     B35 = the Auto-correct space; rows 15, 19, 34, 38, 39 and 40 ON
  // -----------------------------------------------------------------------------------------------------------

  const AC = 'spaces/AAQAonespace01';
  const AC_NAME = 'SLRR One Space (Auto-correct)';

  function oneSpaceRun(overrides) {
    const t = start(overrides, [[AC, AC_NAME]]);
    const sh = t.control();
    [3, 4, 9].forEach(r => sh.getRange(r, 2).setValue(''));
    sh.getRange(10, 2).setValue(AC_NAME);
    [15, 19, 34, 38, 39, 40].forEach(r => sh.getRange(r, 2).setValue('ON'));
    const feed = feedsOf(t);
    scriptGemini(t);
    const rec = recorder(t, '');
    rec.collect('setup');
    rec.step('01 first run: the watch tabs are made', 1);
    watchOn(t);
    sh.getRange(35, 2).setValue('Auto-correct space (B10)');

    rec.step('02 quiet run', 1);
    rec.step('03 Burson alert with mistakes', 1, () => { t.chat.say(REAL, F.MISTAKES, ZAPIER); });
    rec.step('04 Direct BigQuery finds the Pixel post', 3, () => { feed.bsip = [bsipRow()]; });
    rec.step('05 the Pixel card is reviewed', 1);
    rec.step('06 the watch flags the Gemini post', 1, () => { feed.look = [hit()]; });
    rec.step('07 the watch alert is triaged', 1, () => { feed.look = []; });
    rec.step('08 Direct BigQuery check with nothing new', 2);
    // one run with a Direct BigQuery candidate and a story to review: which is posted first is runAutoCorrect_'s order
    rec.step('09 Direct BigQuery finds the Maps post and a story is found', 5, () => {
      feed.bsip = [bsipRow(), mapsRow()];
      feed.stories = [story()];
    });
    rec.step('10 the Maps card is reviewed and the watch flags the Maps post too', 1, () => { feed.look = [mapsHit()]; });
    rec.step('11 quiet run', 1, () => { feed.look = []; });
    rec.step('12 a story whose main post is the Pixel post', 14, () => { feed.stories = [story(), pixelStory()]; });
    rec.step('13 quiet run', 1);
    return { t, out: rec.out() };
  }

  // -----------------------------------------------------------------------------------------------------------
  // The record, and how two of them differ
  // -----------------------------------------------------------------------------------------------------------

  const RECORDED_FILE = path.join(__dirname, 'golden_flows_f93e31a.json');
  const recorded = fs.existsSync(RECORDED_FILE) ? JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8')) : {};
  const LISTS = ['chat', 'test_copy', 'reactions', 'emails', 'outbox'];

  /**
   * Where `actual` and `expected` (two scenario records) differ: [] when they are the same, else up to `max` (5) lines,
   * each naming the list, the place in it and its run, and the first character that differs with the words around it.
   */
  function differences(actual, expected, max) {
    const out = [];
    const limit = max || 5;
    const show = s => JSON.stringify(String(s).length > 160 ? `${String(s).slice(0, 160)}…` : String(s));
    const more = () => { if (out[out.length - 1] !== '… and more') out.push('… and more'); };
    LISTS.forEach(list => {
      const a = (actual && actual[list]) || [];
      const e = (expected && expected[list]) || [];
      for (let i = 0; i < Math.max(a.length, e.length); i++) {
        const x = JSON.stringify(a[i]);
        const y = JSON.stringify(e[i]);
        if (x === y) continue;
        if (out.length >= limit) { more(); return; }
        if (x === undefined) { out.push(`${list}[${i}] is missing; expected ${show(y)}`); continue; }
        if (y === undefined) { out.push(`${list}[${i}] is new: ${show(x)}`); continue; }
        let at = 0;
        while (at < x.length && x[at] === y[at]) at++;
        const from = Math.max(0, at - 60);
        out.push(`${list}[${i}]${a[i] && a[i].run ? ` (run "${a[i].run}")` : ''} differs at character ${at}: ` +
          `got ${show(x.slice(from, at + 100))}, expected ${show(y.slice(from, at + 100))}`);
      }
    });
    const unknown = Object.keys(actual || {}).concat(Object.keys(expected || {})).filter(k => LISTS.indexOf(k) < 0);
    if (unknown.length) out.push(`a list this comparison doesn't know: ${Array.from(new Set(unknown)).join(', ')}`);
    return out;
  }

  return {
    mirror: overrides => mirrorRun(overrides).out,
    oneSpace: overrides => oneSpaceRun(overrides).out,
    mirrorRun, oneSpaceRun, differences, recorded, SETTINGS_OFF, RECORDED_FILE, LISTS,
    spaces: { MIRROR, COPY, AC, REAL }, posts: { PIXEL, MAPS, GEMINI, CHROME },
  };
};
