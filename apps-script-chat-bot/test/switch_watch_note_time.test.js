// The watch's notes under a card in the Auto-correct space (WatchAlerts.gs pwThreadNote_) respect the time the run has
// left: the helper (ThreadNotes.gs acThreadNote_) asks Chat about the card's notes only with time to spare, by the
// deadline the watch hands it; a note that needs asking when time is short is left for the next run, its flags waiting.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const golden = require('./golden_flows')(H);
  const AC = golden.spaces.AC;
  const MAPS = golden.posts.MAPS;
  const BRAND = 'Google brand safety (all)';
  const NOTE_RX = /^🔭 \*Also flagged by the watch /;

  const keysOf = t => Object.fromEntries(t.sheet().getSheetByName('Watch detections').rows.slice(13)
    .filter(r => r && r[18]).map(r => [`${String(r[5])}|${JSON.parse(r[18]).w}`, JSON.parse(r[18])]));
  const c35 = t => t.control().cell(35, 3);
  const notes = t => t.chat.botPosts(AC).filter(m => m.threadReply && NOTE_RX.test(m.text));

  function oneSpace() {
    const w = golden.world.oneSpaceWorld();
    const { t, sh } = w;
    t.poll();
    const tab = t.sheet().getSheetByName('Watches');
    tab.getRange(tab.rows.findIndex(r => r[0] === BRAND) + 1, 2).setValue('ON');
    sh.getRange(35, 2).setValue('Auto-correct space (B10)');
    for (let i = 0; i < 3; i++) t.poll();
    return w;
  }
  function cardAndFlagInOneRun(w, bsip, hits) {
    const { t, feed } = w;
    const sent = () => Object.keys(feed.jobs).length;
    feed.look = [];
    const before = sent();
    for (let i = 0; i < 8 && sent() === before; i++) t.poll();
    assert.ok(sent() > before, 'a look was sent');
    feed.look = hits;
    feed.bsip = bsip;
    t.g.props.delete('BQ_DIRECT_AT');
    t.poll();
    feed.look = [];
  }

  test('watch note time: a cover note that needs its card\'s thread read is left for the next run when the watch has too little time left to ask Chat (the flag waits, C35 "1 waiting"); with time on the next run it goes under the card and the flag is "listed under another alert"', () => {
    const w = oneSpace();
    const { t } = w;
    cardAndFlagInOneRun(w, [golden.rows.mapsRow()], [golden.rows.mapsHit()]);
    eq(keysOf(t)[`${MAPS}|${BRAND}`].a, 'q');
    // the next run: the counts gone (so the card's notes must be counted in its thread), and the watch with 30 seconds
    t.g.cache.delete('ac_thread_notes');
    t.bot.__left = () => t.bot.ev('PW_MIN_LEFT_MS_') + 10 * 1000;
    t.bot.ev('pwPostAlerts_ = (orig => function (sh, dest, now, left, opts) { return orig(sh, dest, now, __left || left, opts); })(pwPostAlerts_)');
    t.poll();
    eq([keysOf(t)[`${MAPS}|${BRAND}`].a, notes(t).length], ['q', 0]);
    assert.match(c35(t), /1 waiting/);
    assert.ok(t.g.logs.some(l => l === 'thread note not posted: the run has too little time left to count its card\'s notes'), 'its log line');
    // time again: the note goes, the flag is listed under the card
    t.bot.__left = null;
    t.poll();
    eq([keysOf(t)[`${MAPS}|${BRAND}`].a, notes(t).length], ['u', 1]);
  });
};
