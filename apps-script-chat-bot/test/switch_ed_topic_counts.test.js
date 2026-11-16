// Early Detection's topic head counts in the Auto-correct flow (BigQuery.gs edTopicCount_, in earlyWaveCheck_'s
// queueByAllowance): with the setting early_wave_topic_min_ratio above 0 (3 by default) a pace jump on a topic label
// whose count is under that many times its usual, and that is not serious, ends as "Topic busier than usual, not a
// story" after the fast triage's answer, without a review: logged in one line, counted among what was let go, and only
// its own id marked as seen. Pace jumps on a story or on risk words are unchanged; the setting at 0, every other flow,
// and the old rule of the review queue (early_wave_reviews_per_hour at 0) review topic counts as before.
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;
  const ends = require('./ed_endings')(H);
  const golden = require('./golden_flows')(H);
  const fs = require('fs');
  const path = require('path');
  const FX = require('./decisions_fixtures.json');
  const DEFAULTS = {};
  const TOPIC = 'Topic busier than usual, not a story';
  const WHY = 'Under 3 times its usual count.';
  // the real 1.37x pace jump on "Chrome Overall" of 9 November and the fast triage's recorded answer about it
  const CHROME_ID = 'ED-VEL-PRIORITY_TOPIC-2cb939f86090a0ffb4ed1cce8c43c295-202611091217';
  const chrome = o => Object.assign(JSON.parse(JSON.stringify(FX.signals.find(s => s.alert_id === CHROME_ID))), o || {});
  const props = w => w.t.g.services.PropertiesService.getScriptProperties();
  const recsOf = w => w.t.bot.edNotesOfRun_().map(r => w.t.bot.edNoteObj_(r));

  /** A world whose runs are checked (the numbers add up after each), where Gemini Decisions gives its recorded answer about the Chrome topic count. */
  const world = o => {
    const w = ends.world(Object.assign({ flow: 'one-space', row46: false, settings: DEFAULTS }, o || {}));
    w.calls = { decisions: 0 };
    const fetch = w.t.g.services.UrlFetchApp.fetch;
    w.t.g.services.UrlFetchApp.fetch = (link, params) => {
      if (String(link).includes('/decisions')) {
        w.calls.decisions++;
        if (/1\.4x \(PRIORITY_TOPIC: Chrome Overall\)/.test(String(JSON.parse((params && params.payload) || '{}').input || ''))) {
          const body = JSON.stringify(FX.signal_responses[CHROME_ID]);
          return { getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => body };
        }
      }
      return fetch(link, params);
    };
    w.step = (time, rows) => {
      const look = w.run(time, rows);
      const n = w.t.bot.edDayNumbers_(props(w));
      eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `the run at ${time}: ${JSON.stringify(n)}`);
      return Object.assign(look, { recs: recsOf(w), n });
    };
    return w;
  };
  const brief = recs => recs.map(r => [r.id, r.outcome, r.why]);
  const spike = (n, grain, ratio, o) => ends.signal(n, Object.assign({ type: 'VELOCITY_SPIKE', grain, ratio, au: 22, at: '09:01',
    key: grain === 'RISK_TERM_GROUP' ? 'outage_broken_feature' : 'Search & Shopping',
    words: `Pixel owners say app ${n} is slow DECLOW, story ${n}` }, o || {}));

  test('early detection topic counts: what a topic count is: a pace jump on a topic label under the setting\'s multiple of its usual count; never a story, a pace jump on a story or on risk words, a ratio that can\'t be read, or anything with the setting at 0', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const row = (type, grain, ratio) => ({ signal_type: type, velocity_grain: grain, velocity_ratio: ratio });
    eq([
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', 1.37), 3),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', '1.37'), 3),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', 2.99), 3),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', 3), 3),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', 3.2), 3),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', 1.37), 0),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', 1.37), 1.2),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', 'None'), 3),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', null), 3),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'PRIORITY_TOPIC', 0), 3),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'CLUSTER', 1.4), 3),
      bot.edTopicCount_(row('VELOCITY_SPIKE', 'RISK_TERM_GROUP', 1.4), 3),
      bot.edTopicCount_(row('CLUSTER_EMERGENCE', '', 0), 3),
      bot.edTopicCount_(null, 3),
    ], [true, true, true, false, false, false, false, false, false, false, false, false, false, false]);
    eq(bot.edTopicCount_(chrome(), 3), true);
    eq(bot.ev('GEN').settings.early_wave_topic_min_ratio, 3);
  });

  test('early detection topic counts: the real 1.37x "Chrome Overall" count of 9 November, with its recorded answer: noted as a topic count after the fast triage\'s answer, not reviewed, logged in one line, let go; only its id is marked, so a real 3.2x jump on that topic afterwards is no repeat and is queued; with the setting at 0 it is queued and reviewed as before, and that jump is then a repeat', () => {
    const w = world();
    w.busy = true;
    let look = w.step('09:01', [chrome()]);
    eq(brief(look.recs), [[CHROME_ID, TOPIC, WHY]]);
    const r = look.recs[0];
    eq([r.story, r.kind, r.accounts, r.tag, r.card], ['Topic: Chrome Overall, 41 accounts in an hour (1.4x the usual)', 'Pace jump (topic)', 41,
      'None: not a brand-safety issue (75% sure) · severity none', '']);
    eq([look.waiting, w.calls.decisions, look.n], [0, 1, { found: 1, cards: 0, under: 0, letgo: 1, never: 0, waiting: 0 }]);
    eq(look.logs.map(String).filter(l => /^early detection: /.test(l)), [
      `early detection: topic count on "Chrome Overall" noted, not reviewed: 1.37x its usual (under 3x), 41 accounts in an hour (${CHROME_ID})`]);
    // read again at the next check: nothing more
    look = w.step('09:16', [chrome()]);
    eq([look.recs, look.n.found], [[], 1]);
    // a real jump on the same topic, as many accounts: no repeat of a count that was never reviewed
    const jump = spike(70, 'PRIORITY_TOPIC', '3.2', { au: 41, key: 'Chrome Overall', at: '09:31' });
    look = w.step('09:31', [jump]);
    eq([look.recs, look.waiting], [[], 1]);

    const off = world({ settings: { early_wave_topic_min_ratio: 0 } });
    off.busy = true;
    look = off.step('09:01', [chrome()]);
    eq([look.recs, look.waiting], [[], 1]);
    look = off.step('09:31', [jump]);
    eq(look.recs.map(x => x.outcome), ['Seen before, nothing new']);
  });

  test('early detection topic counts: a serious topic count is reviewed as usual (a P0 hint; the fast triage\'s usual answer, severity medium; with rows 38-40 OFF a taxonomy raise); with rows 38-40 OFF and nothing serious it is a topic count; a count at 3 times its usual, and pace jumps on a story or on risk words under 3, are queued as before', () => {
    const w = world();
    w.busy = true;
    let look = w.step('09:01', [chrome({ priority_hint: 'P0' }), spike(71, 'PRIORITY_TOPIC', '1.9', { words: 'Search is busy today, story 71' }),
      spike(72, 'PRIORITY_TOPIC', '3.0'), spike(73, 'CLUSTER', '1.4'), spike(74, 'RISK_TERM_GROUP', '1.4')]);
    eq([look.recs, look.waiting], [[], 5]);

    const bare = world();
    [38, 39, 40].forEach(r => bare.sh.getRange(r, 2).setValue('OFF'));
    bare.busy = true;
    look = bare.step('09:01', [spike(75, 'PRIORITY_TOPIC', '1.9'), spike(76, 'PRIORITY_TOPIC', '1.9', { row: { tag_raised: true } })]);
    eq([brief(look.recs).map(x => x.slice(1)), look.waiting, bare.calls.decisions], [[[TOPIC, WHY]], 1, 0]);
    eq(bare.t.bot.edQueueList_(props(bare)).map(e => [e.id, e.ser]), [[spike(76, 'PRIORITY_TOPIC', '1.9').alert_id, 1]]);
  });

  test('early detection topic counts: the Mirror flow and the old rule of the review queue (early_wave_reviews_per_hour at 0) review a topic count as before, whatever early_wave_topic_min_ratio says', () => {
    for (const o of [{ flow: 'mirror', settings: DEFAULTS }, { flow: 'one-space', settings: { early_wave_reviews_per_hour: 0 } }]) {
      const w = world(o);
      w.busy = true;
      const look = w.step('09:01', [chrome()]);
      eq([look.recs, look.waiting], [[], 1], JSON.stringify(o));
    }
  });

  test('early detection topic counts and allowance: with either setting at 0 (the others at their defaults) the one-space scenario posts the same Chat messages and emails as with the defaults (golden_flows_defaults.json)', () => {
    const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_flows_defaults.json'), 'utf8')).one_space;
    eq(golden.differences(golden.oneSpace({ early_wave_topic_min_ratio: 0 }), recorded), []);
    eq(golden.differences(golden.oneSpace({ early_wave_reviews_per_hour: 0 }), recorded), []);
    assert.ok(recorded.chat.length > 0);
  });
};
