// Step S16 of the open-engine plan (growth notes), what is built of it: under Control row 51 a story already carded that
// grew 1.5 times and 3 more accounts (since its card, or since its last growth note), but not to the update bar, gets a
// short note in its card's thread ("📈 *Growing:* 14 accounts now, up from 9" and up to 3 of its posts' links), with no
// review; never once its newest post is more than 180 minutes old. No cap refuses the note; it is the bot's own words,
// never sent to S-F Burson, and counted on the Engine tab. The producer lets a carded story back at 1.5 times and 3 more.
// With row 51 OFF, as before. Every post here is made up.
'use strict';

module.exports = H => {
  const { test, eq, assert, NOW, makeGoogle, loadBot } = H;
  const MIN = 60 * 1000;

  function bot(on) {
    const g = makeGoogle(NOW);
    const b = loadBot(g.services, g.clock);
    b.ewsRunSwitches_(on ? { openEngine: true, earlyWave: true } : {});
    return { g, b };
  }
  const keysOf = urls => new Set(bot(false).b.edPostKeys_(urls));
  const card = { row: 'QA-1', ed: 'ED-CLU-A', cid: 'clu_a', sk: 'clu_a', sig: 'CLUSTER_EMERGENCE', grain: '', au: 9, plats: ['X'],
    keys: keysOf(['https://x.com/a/status/1']), msg: 'spaces/AC/messages/m1', thread: 'spaces/AC/threads/t1', fwdThread: '', title: 'Card one', at: NOW - 60 * MIN };
  const row = (au, o) => Object.assign({ alert_id: `ED-CLU-${au}`, signal_type: 'CLUSTER_EMERGENCE', cluster_id: 'clu_a', signal_key: 'clu_a',
    unique_low_tier_authors: au, platforms_csv: 'X', primary_url: 'https://x.com/a/status/1', window_end_utc: new Date(NOW - 10 * MIN).toISOString(),
    representative_posts_json: JSON.stringify(['https://x.com/a/status/1', 'https://x.com/b/status/2', 'https://x.com/c/status/3', 'https://x.com/d/status/4',
      'https://x.com/e/status/5'].map(u => ({ platform: 'X', author_id: 'a', url: u, snippet: 's' }))) }, o);

  test('open growth (S16): 9 on the card, 14 now: held with a growth note (the count and up to 3 links its card did not name); 11 (not 1.5 times and 3 more): held, no note; 21 (the update bar): an update as before; row 51 OFF: no note', () => {
    const { b } = bot(true);
    const v = b.edStoryVerdict_(row(14), [card], null, NOW);
    eq([!!v.hold, v.grow.au, v.grow.was, v.grow.links, v.grow.card, v.grow.key],
      [true, 14, 9, ['https://x.com/b/status/2', 'https://x.com/c/status/3', 'https://x.com/d/status/4'], { thread: 'spaces/AC/threads/t1', message: 'spaces/AC/messages/m1' }, 'grow:QA-1:14']);
    eq(b.edGrowthText_(v.grow), '📈 *Growing:* 14 accounts now, up from 9 · https://x.com/b/status/2 · https://x.com/c/status/3 · https://x.com/d/status/4');
    eq([b.edStoryVerdict_(row(11), [card], null, NOW).grow, !!b.edStoryVerdict_(row(21), [card], null, NOW).update], [undefined, true]);
    eq(bot(false).b.edStoryVerdict_(row(14), [card], null, NOW).grow, undefined);
  });

  test('open growth (S16): the next note counts from the last note\'s accounts; no note once the newest post is more than 180 minutes old', () => {
    const { g, b } = bot(true);
    const big = Object.assign({}, card, { au: 20 });  // the update bar: 40
    g.cache.set(`ed_grow:${b.hashText_('QA-1')}`, '24');  // the last note said 24
    eq([b.edStoryVerdict_(row(35), [big], null, NOW).grow, b.edStoryVerdict_(row(36), [big], null, NOW).grow.was, !!b.edStoryVerdict_(row(40), [big], null, NOW).update],
      [undefined, 24, true]);
    const fresh = bot(true).b;
    eq([fresh.edStoryVerdict_(row(14, { window_end_utc: new Date(NOW - 181 * MIN).toISOString() }), [card], null, NOW).grow,
      fresh.edStoryVerdict_(row(14, { window_end_utc: new Date(NOW - 179 * MIN).toISOString() }), [card], null, NOW).grow.au], [undefined, 14]);
    // and 3 more accounts: a card of 4 needs 7 (1.5 times is 6)
    const small = Object.assign({}, card, { au: 4 });
    eq([fresh.edStoryVerdict_(row(6), [small], null, NOW).grow, fresh.edStoryVerdict_(row(7), [small], null, NOW).grow.au], [undefined, 7]);
  });

  test('open growth (S16): the note goes through the one way to a card\'s thread with a key no cap refuses, is the bot\'s own words, never for S-F Burson; once posted its accounts are kept and it is counted on the Engine tab', () => {
    const { g, b } = bot(true);
    const v = b.edStoryVerdict_(row(14), [card], null, NOW);
    const asked = [];
    b.acThreadNote_ = (from, c, text, key) => { asked.push([c, text, key]); return true; };
    b.engRunStart_();
    eq(b.edGrowthNote_({}, v), true);
    eq([asked[0][2], b.acNoteUncapped_(asked[0][2]), b.acNoteUncappedText_(asked[0][1]), b.isThreadNoteText_(asked[0][1]), b.isBotFormattedText_(asked[0][1])],
      ['grow:QA-1:14', true, true, true, true]);
    assert.ok(b.outboxGuardHits_(asked[0][1]).length > 0, 'a growth note can never go to S-F Burson');
    eq([g.cache.get(`ed_grow:${b.hashText_('QA-1')}`), b.ev('ENG_RUN_').n.growth], ['14', 1]);
    eq(b.edGrowthNote_({}, { hold: 'x' }), false);
  });

  test('open growth (S16): the producer lets a carded story back inside its 6 hours at 1.5 times and 3 more accounts with row 51 ON; at 2 times with it OFF', () => {
    const passes = (on, au) => {
      const { b } = bot(on);
      const w = { platforms: ['X'], allPlatforms: ['X'], urls: 5, authors: au, texts: au, brand: true, risk: [] };
      b.ewsStoryWindow_ = () => w;
      b.ewsCentroid_ = () => [1, 0];
      const c = { id: 'clu_a', al: { at: NOW - 60 * MIN, au: 8 }, m: [] };
      return b.ewsPromote_([c], [], NOW, {}).length;
    };
    eq([passes(true, 12), passes(true, 11), passes(false, 12), passes(false, 16)], [1, 0, 0, 1]);
  });

  test('open growth (S16): in a run of the one-space setup with row 51 ON, a carded story of 6 accounts that grows to 10 gets its growth note in its card\'s thread and no second review; with row 51 OFF it is held as before, with no note', () => {
    const golden = require('./golden_flows')(H);
    const run = (on, more) => {
      const w = golden.world.oneSpaceWorld(Object.assign({}, golden.SETTINGS_OFF, { early_detection_first: true }, more || {}));
      if (on) w.t.bot.ev('readSwitches_ = (read => sh => Object.assign(read(sh), { openEngine: true }))(readSwitches_)');
      w.rec.collect('setup');
      w.rec.step('the first run', 1);
      const base = golden.rows.story({});
      w.rec.step('the story', 15, () => { w.feed.stories = [base]; });
      [1, 1].forEach(m => w.rec.step('after', m));
      const reviews = w.t.g.vertex.calls.filter(c => /early_detection_call/.test(JSON.stringify(c.payload))).length;
      const grown = Object.assign({}, base, { alert_id: `${base.alert_id}g`, unique_low_tier_authors: 10 });
      w.rec.step('it grew', 15, () => { w.feed.stories = [grown]; });
      [1, 1].forEach(m => w.rec.step('after', m));
      const AC = golden.spaces.AC;
      const cardMsg = w.t.chat.botPosts(AC).find(p => !p.threadReply && /EARLY DETECTION/.test(p.text));
      const notes = w.t.chat.botPosts(AC).filter(p => p.threadReply && /^📈 \*Growing:\*/.test(p.text));
      return { base: base.unique_low_tier_authors, notes: notes.map(p => [p.thread.name === cardMsg.thread.name, p.text.split(' · ')[0]]),
        moreReviews: w.t.g.vertex.calls.filter(c => /early_detection_call/.test(JSON.stringify(c.payload))).length - reviews };
    };
    const on = run(true);
    eq([on.base, on.notes, on.moreReviews], [6, [[true, '📈 *Growing:* 10 accounts now, up from 6']], 0]);
    eq(run(false).notes, []);
    // the same under the review allowance (the check's other way through its signals)
    const allow = run(true, { early_wave_reviews_per_hour: 6, early_wave_reviews_per_day: 150 });
    eq([allow.notes.length, allow.moreReviews], [1, 0]);
  });
};
