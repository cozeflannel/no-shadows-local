// Early Detection's endings, in the harness: a world whose producer, fast triage and reviews are scripted, and one long
// mixed day in which a story signal ends in every way the code has. Used by the switch_ed_*.test.js files:
//
//   const ends = require('./ed_endings')(H);          // H: the helpers every switch_*.test.js file is given
//   const w = ends.world({ flow, row46, settings });   // flow: 'one-space' (B10 alone) or 'mirror' (B9); rows 19, 38,
//                                                      // 39 and 40 ON, row 46 as asked; settings: GEN.settings overrides
//   w.run('09:31', [signals])                          // one poll() at that Eastern time (a 'D2 ' prefix: the day after)
//                                                      // with those signals in the producer's hand-over; -> w.look()
//   ends.signal(n, {...})                              // a signal on story n (its words can carry the marks below)
//   ends.day(w, after)                                 // the long mixed day, run by run; after(run, look, i) after each
//
// What a signal's words make the scripted services do:
//   DECNOISE    the fast triage answers "routine noise" (held back by row 40)     DECOFF   "not about Google" (held back)
//   DECLOW      the fast triage answers severity low, not noise: not held back, and ordinary under the allowance
//               (the usual answer, severity medium, makes a signal serious there: FastTriage.gs edSerious_)
//   REVDISMISS  the review dismisses it          REVESCALATE  the review escalates it (a Social Alert)
//   REVNONENG   the review says the posts are not English      REVREPEAT  the review finds an issue already alerted
//   REVFAIL     Gemini's review fails            EVERGREEN    the listening data says its topic is always around
//   CARDFAIL    Chat answers 500 to its card     CARDHELD     Chat gives no message back for its card
// Everything is deterministic: the harness's clock is set to the time each run is given.
'use strict';

module.exports = H => {
  const { REAL } = H;
  const golden = require('./golden_flows')(H);
  const MIN = 60 * 1000;
  const AC = 'spaces/AAQAedEndsAc1';
  const AC_NAME = 'SLRR One Space (endings)';
  const MIRROR = 'spaces/AAQAedEndsMr1';
  const MIRROR_NAME = 'SLRR Zapier Training Mirror (endings)';
  const DAY1 = Date.UTC(2026, 9, 14, 4, 0);  // midnight Eastern (EDT) on the day the harness starts (at 08:00 that day)
  // The settings of the old rule of the review queue (BigQuery.gs edAllowance_ returns null): a world's own when it is
  // given none
  const OLD_RULE = { early_wave_reviews_per_hour: 0, early_wave_topic_min_ratio: 0 };

  /** "09:31" (the first day) or "D2 00:05" (the day after), Eastern time, in ms. */
  const at = label => {
    const m = String(label).match(/^(D2 )?(\d{1,2}):(\d{2})$/);
    if (!m) throw new Error(`ed endings: not a time: ${label}`);
    return DAY1 + (m[1] ? 24 * 60 * MIN : 0) + (Number(m[2]) * 60 + Number(m[3])) * MIN;
  };

  // -----------------------------------------------------------------------------------------------------------
  // Signals, as the producer hands them over (EarlyWaveSource.gs ewsClusterRow_ / ewsVelocityRow_ / ewsWatchRow_)
  // -----------------------------------------------------------------------------------------------------------

  const NOT_ENGLISH = 'Камера Pixel вылетает после обновления, снова и снова, история';
  // An early-watch story carries the fast triage's answers it was raised on (Decisions.gs decCompact_)
  const RAISED = { g: 0.96, r: 0.9, i: 0.45, n: 0.1, c: 'other risk', cp: 0.6, p0: 0, s: 2.9, l: 3, sc: 0.6, sp: [0.05, 0.05, 0.1, 0.6, 0.2] };

  /**
   * A signal on story `n`. o: {au (accounts, 5), type ('CLUSTER_EMERGENCE', 'VELOCITY_SPIKE', 'EARLY_WATCH'), grain (a
   * velocity spike's: 'CLUSTER', 'PRIORITY_TOPIC', 'RISK_TERM_GROUP'), key (a topic's name or a risk group's key), ratio
   * (a spike's pace against the usual), words (what its posts say; the marks above go here), pri ('P2'), risk (its risk
   * groups, a comma list), at (when it was made, "09:31": a later signal on the same story has another time, so another
   * id), plats, row (fields put on top)}.
   */
  function signal(n, o) {
    const x = o || {};
    const au = x.au || 5;
    const type = x.type || 'CLUSTER_EMERGENCE';
    const grain = type === 'VELOCITY_SPIKE' ? (x.grain || 'CLUSTER') : '';
    const cid = `clu_ends${String(n).padStart(3, '0')}`;
    const words = x.words || `Pixel owners say the camera app crashes after the update, story ${n}`;
    const made = at(x.at || '08:00');
    const stamp = new Date(made).toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const posts = Array.from({ length: Math.min(au, 4) }, (_, i) => ({
      platform: i === 2 ? 'Reddit' : 'X', author_handle: `ends${n}_${i}`, followers: 300 + i, engagement_total: 10 + i,
      published_at: iso(made - (20 - i) * MIN),
      url: i === 2 ? `https://www.reddit.com/r/GooglePixel/comments/1e${n}x${i}/thread/`
        : `https://x.com/ends${n}_${i}/status/21500000000${String(100000 + n * 10 + i)}`,
      snippet: `${words} (post ${i + 1})`,
    }));
    const onStory = grain !== 'PRIORITY_TOPIC' && grain !== 'RISK_TERM_GROUP';
    const key = onStory ? cid : (x.key || 'Search & Shopping');
    const id = type === 'VELOCITY_SPIKE' ? `ED-VEL-${grain}-${onStory ? cid : `ends${n}`}-${stamp}`
      : type === 'EARLY_WATCH' ? `ED-WAT-${cid}-${stamp}` : `ED-CLU-${cid}-${stamp}`;
    const row = {
      alert_id: id,
      created_utc: `${iso(made).slice(0, 10)} ${iso(made).slice(11, 16)} UTC`,
      signal_type: type,
      velocity_grain: grain,
      cluster_id: onStory ? cid : '',
      signal_key: key,
      headline: type === 'VELOCITY_SPIKE' ? `Low-tier velocity ${x.ratio || '4.2'}x (${grain}: ${onStory ? words : key})`
        : type === 'EARLY_WATCH' ? `Early story (${au} accounts): ${words}` : `Low-tier claim cluster (${au} accounts): ${words}`,
      topic_product: grain === 'PRIORITY_TOPIC' ? key : 'Pixel',
      priority_hint: x.pri || 'P2',
      unique_low_tier_authors: au,
      mention_count: au + 1,
      platform_count: 2,
      platforms_csv: x.plats || 'X, Reddit',
      baseline_authors: type === 'VELOCITY_SPIKE' ? 2.5 : 0,
      velocity_ratio: type === 'VELOCITY_SPIKE' ? Number(x.ratio || 4.2) : 0,
      absolute_author_delta: 0,
      primary_url: posts[0].url,
      window_start_utc: iso(made - 60 * MIN),
      window_end_utc: iso(made),
      representative_posts_json: JSON.stringify(posts),
      chatbot_card_text: '',
      update_of_alert_id: '',
      update_of_authors: 0,
      taxonomy_hint: '',
      risk_groups: x.risk || '',
      tag_raised: false,
    };
    if (type === 'EARLY_WATCH') row.dec = Object.assign({}, RAISED);
    return Object.assign(row, x.row || {});
  }

  // -----------------------------------------------------------------------------------------------------------
  // The scripted services
  // -----------------------------------------------------------------------------------------------------------

  // Gemini Decisions' six answers, in the API's own shape (Decisions.gs decAnswer_ reads them)
  function decisions(input) {
    const a = /DECNOISE/.test(input) ? { g: 0.84, r: 0.09, i: 0.29, n: 0.93, cat: 'none', level: 1, conf: 0.6 }
      : /DECOFF/.test(input) ? { g: 0.06, r: 0.05, i: 0.2, n: 0.5, cat: 'none', level: 0, conf: 0.7 }
        : /DECLOW/.test(input) ? { g: 0.9, r: 0.2, i: 0.3, n: 0.5, cat: 'none', level: 1, conf: 0.6 }
        : { g: 0.9, r: 0.5, i: 0.3, n: 0.4, cat: 'other risk', level: 2, conf: 0.6 };
    const yes = p => ({ type: 'noul', noul: p, confidence: Math.max(p, 1 - p) });
    const levels = { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.05, 4: 0.05 };
    levels[a.level] = a.conf;
    return { answers: {
      about_google: yes(a.g), brand_risk: yes(a.r), independent_reports: yes(a.i), routine_noise: yes(a.n),
      category: { type: 'choice', choice: a.cat, probabilities: { [a.cat]: 0.6 }, confidence: 0.6 },
      severity: { type: 'score', score: a.level, probabilities: levels, confidence: a.conf },
    }, usage: { total_input_tokens: 3300 } };
  }

  // Gemini's review of a story (EarlyDetection.gs edReviewSchema_); its headline carries a card's mark, so the fake Chat
  // can tell that card
  function review(text) {
    const n = (text.match(/story (\d+)/) || [])[1] || '0';
    const mark = (text.match(/CARDFAIL|CARDHELD/) || [])[0] || '';
    const base = {
      summary: `Small accounts report problem ${n}.`,
      issue_name: /REVREPEAT/.test(text) ? `Known issue REVREPEAT ${n}` : `Reported problem ${n}`,
      emerging_narrative: `Owners describe problem ${n}.`,
      early_detection_call: { disposition: 'monitor', severity: 'medium', confidence: 0.82, reason: 'Early reports worth watching' },
      known_issue: { matches: false, confidence: 0.9 },
      tns: { needed: false },
      temp_check_draft: { recommended: false, query_suggestion: '', scope_note: '' },
      recommended_groups: [],
      story_title: `Small accounts report problem ${n}${mark ? ` (${mark})` : ''}`,
      story: `Small accounts describe [problem ${n}](P1).`,
      web_context: '',
      next_steps: ['Re-check in 2 hours'],
      driver_post: 'P1',
    };
    if (/REVDISMISS/.test(text)) {
      return Object.assign(base, { early_detection_call: { disposition: 'dismiss', severity: 'none', confidence: 0.95,
        reason: 'Benign chatter, nothing for Google to act on' }, slrr: { is_slrr: false, confidence: 0.95 } });
    }
    if (/REVESCALATE/.test(text)) {
      return Object.assign(base, { early_detection_call: { disposition: 'escalate', severity: 'high', confidence: 0.91,
        reason: 'Several independent owners describe the same concrete failure' },
      slrr: { is_slrr: true, confidence: 0.9, exposure_tag: 'Product - Other/general criticism', product: 'Pixel',
        other_products: [], sensitive_topics: [], location: 'US' } });
    }
    if (/REVNONENG/.test(text)) {
      return Object.assign(base, { translation: { is_non_english: true, language: 'Portuguese', english_text: 'The camera crashes after the update' } });
    }
    return base;
  }

  /**
   * The world: {t, sh (the Control tab), flow, space (where the cards go), rows (what the producer hands over at a
   * check), fail (an error text: the producer's read fails with it), writes (what the row-46 writer sent: [{table,
   * rows: [{insertId, json}]}]), busy (true: a run's time is used up right after the check, so no review starts in
   * it), partition (the flow's Alert-log rows, once a run has told), run(time, rows), look(), covered(signal, id),
   * loseRow(signal), setDay(patch)}.
   */
  function world(o) {
    const x = o || {};
    const mirror = x.flow === 'mirror';
    // without settings of its own a world keeps the old rule of the review queue (40 queued a day; topic counts
    // reviewed), which every flow but the Auto-correct one keeps whatever the settings: the long mixed day was written
    // for it. The Auto-correct flow's allowance is tested with settings that turn it on (OLD_RULE's keys at their
    // defaults: switch_ed_allowance.test.js).
    const t = golden.world.start(x.settings === undefined ? OLD_RULE : x.settings, [mirror ? [MIRROR, MIRROR_NAME] : [AC, AC_NAME]]);
    const sh = t.control();
    const w = { t, sh, flow: mirror ? 'mirror' : 'one-space', space: mirror ? MIRROR : AC, rows: [], fail: '', writes: [],
      busy: false, partition: '', seen: { logs: 0, posts: new Set(), writes: 0 } };

    // the producer: what it hands over at a check (a copy, as rows read from its buffer are)
    t.bot.bqEarlyDetectionRows_ = () => {
      if (w.fail) throw new Error(w.fail);  // BigQuery did not answer the producer
      return w.rows.map(r => JSON.parse(JSON.stringify(r)));
    };
    // a busy run: the check takes the flow's time, and under 90 seconds of it are left for the reviews
    w.afterCheck = ctx => {
      w.partition = ctx.partition;
      if (w.busy && ctx.deadline) t.g.clock.now = Math.max(t.g.clock.now, ctx.deadline - MIN);
    };
    t.bot.__edEndsWorld = w;
    t.bot.ev('earlyWaveCheck_ = (check => function (ctx) { const out = check(ctx); __edEndsWorld.afterCheck(ctx); return out; })(earlyWaveCheck_)');

    const resp = (code, body) => ({ getResponseCode: () => code, getHeaders: () => ({}),
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    const fetch = t.g.services.UrlFetchApp.fetch;
    t.g.services.UrlFetchApp.fetch = (link, params) => {
      const url = String(link);
      const method = String((params && params.method) || 'get').toLowerCase();
      if (url.includes('secretmanager.googleapis.com/')) {
        return resp(200, { payload: { data: Buffer.from('test-only-decisions-key-value-77', 'utf8').toString('base64') } });
      }
      if (url.includes('/decisions')) return resp(200, decisions(String(JSON.parse((params && params.payload) || '{}').input || '')));
      if (!url.startsWith('https://bigquery.googleapis.com/')) return fetch(link, params);
      if (method === 'post' && /\/insertAll$/.test(url)) {  // the row-46 writer
        const table = decodeURIComponent((url.match(/\/tables\/([^/]+)\/insertAll$/) || [])[1] || '');
        w.writes.push({ table, rows: (JSON.parse(params.payload).rows || []).map(r => ({ insertId: r.insertId, json: r.json })) });
        return resp(200, {});
      }
      if (method === 'post' && /\/queries$/.test(url)) {  // every read: no rows
        return resp(200, { jobComplete: true, schema: { fields: [{ name: 'url', type: 'STRING' }] }, rows: [] });
      }
      return resp(200, { jobComplete: true, rows: [] });
    };

    const promptOf = payload => payload.contents[0].parts.map(p => p.text || '').join('\n');
    t.g.vertex.earlyDetection = payload => review(promptOf(payload));
    t.g.vertex.fail = payload => {
      const props = (payload.generationConfig && payload.generationConfig.responseSchema && payload.generationConfig.responseSchema.properties) || {};
      return props.early_detection_call && /REVFAIL/.test(promptOf(payload))
        ? { code: 400, body: { error: { code: 400, message: 'invalid argument (scripted)' } } } : null;
    };
    t.chat.fail = (method, path, query, body) => (method === 'post' && /\/messages$/.test(path) && body && /CARDFAIL/.test(body.text || '')
      ? { code: 500, body: { error: { code: 500, message: 'backend error' } } } : null);
    // a card Chat gives no message back for (as a post held back in a space the bot never writes), a review that finds an
    // issue already alerted, and a topic the listening data knows as always around: only for the signals marked so
    t.bot.ev('chatPostMessage_ = (post => function (space, text) { return /CARDHELD/.test(String(text || "")) ? null ' +
      ': post.apply(this, arguments); })(chatPostMessage_)');
    t.bot.ev('knownIssueSkip_ = (rule => (review, esc) => (/REVREPEAT/.test(String(((review || {}).fields || {}).issue_name || "")) ' +
      '? \'already alerted as a known issue (QA-4228, "Pixel camera crash"): nothing materially new\' : rule(review, esc)))(knownIssueSkip_)');
    t.bot.ev('enrichAlertFromBigQuery_ = (read => function (parsed) { return parsed && parsed.kind === "early_detection" && ' +
      '/EVERGREEN/.test(JSON.stringify(parsed.fields || {})) ? { is_evergreen_noise: true, evergreen_topic_label: "Shot on Pixel showcase" } ' +
      ': read.apply(this, arguments); })(enrichAlertFromBigQuery_)');

    // the Control tab, last: starting the Mirror space is a run of its own
    if (mirror) {
      t.bot.startMirror(MIRROR_NAME);  // B9
    } else {
      [3, 4, 9].forEach(r => sh.getRange(r, 2).setValue(''));
      sh.getRange(10, 2).setValue(AC_NAME);
    }
    [19, 38, 39, 40].concat(x.row46 ? [46] : []).forEach(r => sh.getRange(r, 2).setValue('ON'));

    const props = () => t.g.services.PropertiesService.getScriptProperties();
    /** What the bot holds and shows after a run, and what the run itself put out (since the last look). */
    w.look = () => {
      const logs = t.g.logs.slice(w.seen.logs);
      w.seen.logs = t.g.logs.length;
      const posts = t.chat.botPosts(w.space).filter(m => !w.seen.posts.has(m.name));
      posts.forEach(m => w.seen.posts.add(m.name));
      const writes = w.writes.slice(w.seen.writes);
      w.seen.writes = w.writes.length;
      return {
        day: JSON.parse(t.g.props.get('EARLY_DETECTION_TODAY') || '{}'),
        waiting: t.bot.edQueueList_(props()).length,
        c19: String(sh.cell(19, 3) || ''),
        logs,
        cards: posts.filter(m => /^client-zeda-/.test(String(m.clientAssignedMessageId || ''))),
        writes,
      };
    };
    /** One run at Eastern time `time` ("09:31", "D2 00:05"); `rows`, when given, is what the producer hands over from now on. */
    w.run = (time, rows) => {
      if (rows) w.rows = rows;
      t.g.clock.now = at(time) - MIN;  // poll() itself moves the clock on a minute
      t.poll();
      return w.look();
    };
    /** Another path's alert on `sig`'s main post: an Alert-log row of this flow, made now (a Direct BigQuery card's). */
    w.covered = (sig, id) => {
      if (!w.partition) throw new Error('ed endings: no run has told the flow\'s Alert-log partition yet');
      t.bot.sheetBackend_(t.sheet()).appendAlert({ alert_id: id, created_at: t.g.clock.now, space: w.partition,
        source_message: `${w.space}/messages/another-path-${id}`, source_thread: `${w.space}/threads/another-path-${id}`,
        forward_message: `${w.space}/messages/another-path-${id}`, forward_thread: `${w.space}/threads/another-path-${id}`,
        record_key: t.bot.recordKey_({ post_url: sig.primary_url }), status: 'ok', ingested: 'BSIP' });
    };
    /** A queued signal's stored row is gone (as when script properties are cleared by hand); its queue entry stays. */
    w.loseRow = sig => t.g.props.delete(`ED_ALERT_Q_${t.bot.edQueueKey_(sig)}`);
    /** Today's counts as the bot keeps them, changed as a test says (the day's 40th signal, the early watch's 8th). */
    w.setDay = patch => {
      const day = JSON.parse(t.g.props.get('EARLY_DETECTION_TODAY') || '{}');
      t.g.props.set('EARLY_DETECTION_TODAY', JSON.stringify(Object.assign(day, patch)));
    };
    return w;
  }

  // -----------------------------------------------------------------------------------------------------------
  // One long mixed day: every way a story signal can end, and the day changing while signals wait
  // -----------------------------------------------------------------------------------------------------------

  /**
   * The day's signals by name (S: a story; W: an early signal; V, T, R: a pace jump on a story, a topic, risk words; Q:
   * the stories of the full queue; N: the ones of the night; C: the ones at the day's limit) and its runs in order:
   * [{at, label, rows (what the producer hands over from this run on: a signal stays in its hand-over for the next
   * checks too, as it does in the producer's buffer), busy (true / false from this run on), fail (the producer's read
   * fails with this text, in this run only), before(w)}].
   */
  function dayPlan() {
    const s = (n, o) => signal(n, o);
    const say = (what, mark, n) => `Pixel owners say ${what}${mark ? ` ${mark}` : ''}, story ${n}`;
    const G = {
      // the morning's first check: a card of each kind, a hold, not English, a main post another path alerted
      S1: s(1, { au: 6, pri: 'P1', at: '08:16' }),
      S2: s(2, { pri: 'P1', at: '08:16', words: say('the phone overheats while charging', 'REVESCALATE', 2) }),
      S3: s(3, { at: '08:16', words: say('the screen flickers at night', 'REVFAIL', 3) }),
      S4: s(4, { at: '08:16', words: 'People chat about the new Pixel wallpaper DECNOISE, story 4' }),
      S5: s(5, { at: '08:16', words: `${NOT_ENGLISH} 5` }),
      S6: s(6, { at: '08:16', risk: 'outage_broken_feature,security_scam_malware', words: say('the speaker crackles', '', 6) }),
      // the second: the first story again (not grown), a dismissal, not English and an issue already alerted found by
      // the review, a pace jump on a story, a topic that is always around, a hold for not being about Google and a
      // topic count held as noise
      S1b: s(1, { au: 8, pri: 'P1', at: '08:31' }),
      S7: s(7, { at: '08:31', words: say('the weather widget looks odd', 'REVDISMISS', 7) }),
      S8: s(8, { at: '08:31', words: say('the camera closes by itself', 'REVNONENG', 8) }),
      S9: s(9, { at: '08:31', words: say('the camera crashes again', 'REVREPEAT', 9) }),
      V10: s(10, { au: 12, type: 'VELOCITY_SPIKE', grain: 'CLUSTER', at: '08:31', words: say('the fingerprint reader fails', '', 10) }),
      S11: s(11, { at: '08:31', words: say('their photos look great', 'EVERGREEN', 11) }),
      S12: s(12, { at: '08:31', words: 'A pixel art contest draws a crowd DECOFF, story 12' }),
      T13: s(13, { au: 22, type: 'VELOCITY_SPIKE', grain: 'PRIORITY_TOPIC', key: 'Chrome', ratio: '1.4', at: '08:31',
        words: 'Chrome feels fine today, people say DECNOISE, story 13' }),
      // the third: the first story grown (an update), the dismissed story again (not grown), an early signal, a pace
      // jump on a topic and one on risk words
      S1c: s(1, { au: 14, pri: 'P1', at: '08:46', plats: 'X, Reddit, TikTok' }),
      S7b: s(7, { au: 8, at: '08:46', words: say('the weather widget looks odd', 'REVDISMISS', 7) }),
      W15: s(15, { au: 3, type: 'EARLY_WATCH', pri: 'P1', risk: 'security_scam_malware', at: '08:46',
        words: 'Fake Google support scam ads drained my wallet, story 15' }),
      T16: s(16, { au: 36, type: 'VELOCITY_SPIKE', grain: 'PRIORITY_TOPIC', key: 'Search & Shopping', ratio: '1.9', at: '08:46',
        words: 'I can not find the shop when googling it REVDISMISS, story 16' }),
      R17: s(17, { au: 9, type: 'VELOCITY_SPIKE', grain: 'RISK_TERM_GROUP', key: 'outage_broken_feature', ratio: '3.2', pri: 'P1',
        risk: 'outage_broken_feature', at: '08:46', words: 'Gmail is down again for me, story 17' }),
      // the fourth: two signals on one story, both queued (the smaller one is a repeat by the time of its review)
      S19: s(19, { au: 5, at: '09:00', words: say('calls drop in the car', '', 19) }),
      S19b: s(19, { au: 12, at: '09:01', words: say('calls drop in the car', '', 19) }),
      // the fifth: an early signal whose review fails, a card Chat does not take, a card Chat gives no message for
      S20: s(20, { au: 6, at: '09:16', words: say('the keyboard lags', 'CARDFAIL', 20) }),
      W21: s(21, { au: 3, type: 'EARLY_WATCH', pri: 'P1', at: '09:16', words: 'My Pixel account got locked out REVFAIL, story 21' }),
      S22: s(22, { at: '09:16', words: say('the lock screen stutters', 'CARDHELD', 22) }),
      // a busy morning: more than 5 in one check, the queue filling up, one refused and one pushed out
      Q: Array.from({ length: 12 }, (_, i) => s(31 + i, { au: i === 10 ? 6 : 5, at: i < 7 ? '09:31' : i < 10 ? '09:46' : '10:01',
        words: say(`app ${i + 1} freezes`, i >= 5 && i < 10 ? 'REVDISMISS' : '', 31 + i) })),
      Q43: s(43, { au: 4, at: '10:16', words: say('the clock app is late', '', 43) }),
      Q44: s(44, { au: 7, risk: 'privacy_data_leak', at: '10:16', words: 'Private photos exposed after a data breach, people say, story 44' }),
      // the early watch: one waiting when row 39 goes OFF, one read while it is OFF, one past the day's 8
      W51: s(51, { au: 3, type: 'EARLY_WATCH', pri: 'P1', at: '12:50', words: 'A phishing mail copies the Google sign-in page, story 51' }),
      W52: s(52, { au: 3, type: 'EARLY_WATCH', pri: 'P1', at: '13:05', words: 'Malware hides in a fake Pixel update, story 52' }),
      W53: s(53, { au: 4, type: 'EARLY_WATCH', pri: 'P1', at: '13:20', words: 'Scam ads use the Google Pay logo, story 53' }),
      // the night: five signals queued before midnight, reviewed after it (the stored row of the last is lost), and one
      // on a post another path alerted, handed over on both sides of midnight
      N: Array.from({ length: 5 }, (_, i) => s(61 + i, { au: 5 + i, at: '23:40',
        words: say(`night problem ${i + 1} shows up`, i % 2 ? 'REVDISMISS' : '', 61 + i) })),
      S67: s(67, { at: '23:40', words: say('the night light flickers', '', 67) }),
      S66: s(66, { at: 'D2 00:20', words: say('the alarm did not ring', '', 66) }),
      // the day's limit of 40: an early signal, a story and a risk-word jump
      W73: s(73, { au: 3, type: 'EARLY_WATCH', pri: 'P1', at: 'D2 00:35', words: 'A fake Google prize mail asks for passwords, story 73' }),
      C71: s(71, { at: 'D2 00:35', words: say('the torch stays on', '', 71) }),
      C72: s(72, { au: 9, type: 'VELOCITY_SPIKE', grain: 'RISK_TERM_GROUP', key: 'privacy_data_leak', ratio: '3.2', pri: 'P0',
        risk: 'privacy_data_leak', at: 'D2 00:35', words: 'Leaked passwords from a data breach, people say, story 72' }),
    };
    const runs = [
      { at: '08:01', label: 'the first run: nothing found yet' },
      { at: '08:16', label: 'check: three stories for a card, one held as noise, one not English, one on a post another path alerted',
        before: w => w.covered(G.S6, 'QA-0906'), rows: [G.S1, G.S2, G.S3, G.S4, G.S5, G.S6] },
      { at: '08:17', label: 'the third review' },
      { at: '08:31', label: 'check: the first story again, a dismissal, not English, an issue already alerted, a pace jump, a topic always around, two holds',
        rows: [G.S1, G.S2, G.S3, G.S4, G.S5, G.S6, G.S1b, G.S7, G.S8, G.S9, G.V10, G.S11, G.S12, G.T13] },
      { at: '08:32', label: 'reviews' },
      { at: '08:33', label: 'reviews' },
      { at: '08:46', label: 'check: the first story grown, the dismissed story again, an early signal, a topic count, a risk-word jump',
        rows: [G.S6, G.S1b, G.S7, G.S8, G.S9, G.V10, G.S11, G.S12, G.T13, G.S1c, G.S7b, G.W15, G.T16, G.R17] },
      { at: '08:47', label: 'reviews' },
      { at: '09:01', label: 'check: two signals on one story, both queued; the smaller is a repeat by the time of its review',
        rows: [G.S1c, G.S7b, G.W15, G.T16, G.R17, G.S19, G.S19b] },
      { at: '09:02', label: 'a run with nothing to do' },
      { at: '09:16', label: 'check: an early signal whose review fails, a card Chat does not take, a card Chat gives no message for',
        rows: [G.S19, G.S19b, G.S20, G.W21, G.S22] },
      { at: '09:17', label: 'the early signal\'s second try' },
      { at: '09:18', label: 'the card\'s first try' },
      { at: '09:19', label: 'the card\'s second try' },
      { at: '09:20', label: 'the signal whose card was not taken is dropped; the other card gets no message' },
      { at: '09:31', label: 'busy check: seven new stories, five queued (the dropped signals are handed over again)', busy: true,
        rows: [G.S20, G.W21, G.S22].concat(G.Q.slice(0, 7)) },
      { at: '09:46', label: 'busy check: the two left over and three more', rows: G.Q.slice(0, 10) },
      { at: '10:01', label: 'busy check: the queue is full', rows: G.Q.slice(0, 12) },
      { at: '10:16', label: 'busy check: one refused, one pushes another out', rows: G.Q.slice(7, 12).concat([G.Q43, G.Q44]) },
      { at: '10:31', label: 'busy check: the refused and the pushed-out signals are handed over again', rows: G.Q.slice(10, 12).concat([G.Q43, G.Q44]) },
      { at: '12:35', label: 'the first run with time: five waited 3 hours', busy: false, rows: [] },
      { at: '12:36', label: 'reviews' },
      { at: '12:37', label: 'reviews' },
      { at: '12:38', label: 'reviews' },
      { at: '12:50', label: 'busy check: an early signal is queued', busy: true, rows: [G.W51] },
      { at: '12:51', label: 'row 39 is OFF: the early signal that waited is dropped', busy: false, before: w => w.sh.getRange(39, 2).setValue('OFF') },
      { at: '13:05', label: 'check with row 39 OFF: an early signal is left alone', rows: [G.W51, G.W52] },
      { at: '13:20', label: 'check with row 39 ON again and the day\'s 8 early signals used',
        before: w => { w.sh.getRange(39, 2).setValue('ON'); w.setDay({ watchq: 8 }); }, rows: [G.W51, G.W52, G.W53] },
      { at: '13:35', label: 'check: the same early signals again', rows: [G.W52, G.W53] },
      { at: '13:50', label: 'check: the producer cannot read BigQuery', fail: 'BigQuery HTTP 500: backendError' },
      { at: '23:40', label: 'busy check before midnight: five queued, one on a post another path alerted', busy: true,
        before: w => w.covered(G.S67, 'QA-0967'), rows: G.N.concat([G.S67]) },
      { at: 'D2 00:05', label: 'the day changed while five waited', busy: false, rows: G.N.concat([G.S67]) },
      { at: 'D2 00:06', label: 'reviews' },
      { at: 'D2 00:07', label: 'the last of the night: its stored row is gone', before: w => w.loseRow(G.N[0]) },
      { at: 'D2 00:20', label: 'check: a story of the new day', rows: [G.S66] },
      { at: 'D2 00:35', label: 'check at the day\'s limit of 40', before: w => w.setDay({ queued: 40 }), rows: [G.S66, G.W73, G.C71, G.C72] },
      { at: 'D2 00:50', label: 'check: the same three at the limit again', rows: [G.S66, G.W73, G.C71, G.C72] },
    ];
    return { signals: G, runs };
  }

  /** Runs the day in world `w`; after(run, look, i) after each run (run: the plan's entry; look: w.look()). The plan. */
  function day(w, after) {
    const plan = dayPlan();
    plan.runs.forEach((run, i) => {
      if (run.busy !== undefined) w.busy = run.busy;
      if (run.before) run.before(w);
      w.fail = run.fail || '';
      const look = w.run(run.at, run.rows);
      w.fail = '';
      if (after) after(run, look, i);
    });
    return plan;
  }

  return { world, signal, at, day, dayPlan, NOT_ENGLISH, OLD_RULE, spaces: { AC, MIRROR, REAL } };
};
