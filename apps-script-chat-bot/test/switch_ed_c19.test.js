// Control C19, the note of the Early Detection row (BigQuery.gs edDayNoteText_, noteEarlyWave_): one line that adds up
// and fits. "last check <time> (<problem>; it tries again at the next check) · today: F found, C cards, U under another
// alert, L let go, N never reviewed, W waiting · the Early Detection tab lists each one". Every switch's note is cut at
// 200 characters (Control.gs noteSwitch_), so the line is made to fit before that, and never by cutting a number.
'use strict';

module.exports = H => {
  const { test, eq, assert, makeGoogle, loadBot, NOW } = H;
  const ends = require('./ed_endings')(H);
  const POINTER = 'the Early Detection tab lists each one';
  const STOP_NEW = 'today\'s limit of 150 reviews is reached, more after midnight ET';
  const STOP_OLD = 'daily cap of 40 reached, more tomorrow';
  const AGAIN = '; it tries again at the next check';
  const AT = 'Oct 14, 12:35 PM EDT';  // as long as a time gets
  const counts = (f, c, u, l, n, w) => `today: ${f} found, ${c} card${c === 1 ? '' : 's'}, ${u} under another alert, ${l} let go, ` +
    `${n} never reviewed, ${w} waiting`;
  const nums = (f, c, u, l, n, w) => ({ found: f, cards: c, under: u, letgo: l, never: n, waiting: w });
  const THREE = nums(999, 999, 999, 999, 999, 999);
  const THREE_TEXT = counts(999, 999, 999, 999, 999, 999);
  /** The six numbers a note holds, or null. */
  const parse = text => {
    const m = String(text).match(/today: (\d+) found, (\d+) cards?, (\d+) under another alert, (\d+) let go, (\d+) never reviewed, (\d+) waiting/);
    return m ? nums(...m.slice(1).map(Number)) : null;
  };

  test('early detection C19: the line says the day\'s six numbers after the last check and ends with the pointer to the tab; "1 card", not "1 cards"; with the tab off there is no pointer; a day stop takes the pointer\'s place', () => {
    const bot = loadBot(makeGoogle(NOW).services);
    const text = (s, n, o) => bot.edDayNoteText_(s, n, o);
    eq(text({ at: 'Oct 14, 10:15 AM EDT', problem: '' }, nums(12, 3, 0, 6, 1, 2), { tab: true }),
      'last check Oct 14, 10:15 AM EDT · today: 12 found, 3 cards, 0 under another alert, 6 let go, 1 never reviewed, 2 waiting · the Early Detection tab lists each one');
    eq(text({ at: 'Oct 14, 10:15 AM EDT' }, nums(1, 1, 0, 0, 0, 0), { tab: true }),
      'last check Oct 14, 10:15 AM EDT · today: 1 found, 1 card, 0 under another alert, 0 let go, 0 never reviewed, 0 waiting · the Early Detection tab lists each one');
    eq(text({ at: 'Oct 14, 10:15 AM EDT' }, nums(12, 3, 0, 6, 1, 2), { tab: false }),
      'last check Oct 14, 10:15 AM EDT · today: 12 found, 3 cards, 0 under another alert, 6 let go, 1 never reviewed, 2 waiting');
    eq(text({ at: 'Oct 14, 10:15 AM EDT' }, nums(12, 3, 0, 6, 1, 2), {}),
      'last check Oct 14, 10:15 AM EDT · today: 12 found, 3 cards, 0 under another alert, 6 let go, 1 never reviewed, 2 waiting');
    eq(text({ at: 'Oct 14, 10:15 AM EDT' }, nums(160, 40, 2, 80, 28, 10), { tab: true, stop: STOP_NEW }),
      `last check Oct 14, 10:15 AM EDT · today: 160 found, 40 cards, 2 under another alert, 80 let go, 28 never reviewed, 10 waiting · ${STOP_NEW}`);
    eq(text({ at: 'Oct 14, 10:15 AM EDT' }, nums(52, 20, 0, 20, 12, 0), { tab: false, stop: STOP_OLD }),
      `last check Oct 14, 10:15 AM EDT · today: 52 found, 20 cards, 0 under another alert, 20 let go, 12 never reviewed, 0 waiting · ${STOP_OLD}`);
    eq([bot.ev('ED_C19_MAX_CHARS_'), bot.ev('ED_TAB_POINTER_')], [200, POINTER]);
  });

  test('early detection C19: with every number at three digits the line is at most 200 characters and no number is cut: with the pointer, with each of the two day-stop phrases, and with a problem text; what gives way, in order, is the pointer to the tab, the words "it tries again at the next check", the day\'s stop, then the end of the problem\'s words', () => {
    const bot = loadBot(makeGoogle(NOW).services);
    const text = (problem, n, o) => bot.edDayNoteText_({ at: AT, problem }, n, o);
    const whole = (t, n) => { assert.ok(t.length <= 200, `${t.length}: ${t}`); eq(parse(t), n, t); assert.ok(!/…/.test(t.replace(/\(.*\)/, '')), t); };
    const head = `last check ${AT}`;
    // no problem: the pointer or the day's stop fits
    const plain = text('', THREE, { tab: true });
    eq([plain, plain.length], [`${head} · ${THREE_TEXT} · ${POINTER}`, 172]);
    const stopNew = text('', THREE, { tab: true, stop: STOP_NEW });
    eq([stopNew, stopNew.length], [`${head} · ${THREE_TEXT} · ${STOP_NEW}`, 197]);
    const stopOld = text('', THREE, { tab: true, stop: STOP_OLD });
    eq([stopOld, stopOld.length], [`${head} · ${THREE_TEXT} · ${STOP_OLD}`, 172]);
    [plain, stopNew, stopOld].forEach(t => whole(t, THREE));
    // a problem: the pointer goes first (the line would be 231 characters with it), the problem's words stay whole
    const p1 = text('BigQuery didn\'t answer', THREE, { tab: true });
    eq([p1, p1.length], [`${head} (BigQuery didn't answer${AGAIN}) · ${THREE_TEXT}`, 190]);
    const p2 = text('BigQuery didn\'t finish in time', THREE, { tab: true });
    eq([p2, p2.length], [`${head} (BigQuery didn't finish in time${AGAIN}) · ${THREE_TEXT}`, 198]);
    // ... then "it tries again at the next check"
    const p3 = text('a BigQuery source table was not found', THREE, { tab: true });
    eq([p3, p3.length], [`${head} (a BigQuery source table was not found) · ${THREE_TEXT}`, 171]);
    [p1, p2, p3].forEach(t => whole(t, THREE));
    // with small numbers too a problem takes the pointer's room (the two together would pass 200), and keeps all its words
    const small = text('25 couldn\'t be queued', nums(30, 2, 0, 3, 0, 25), { tab: true });
    eq([small, small.length], [`${head} (25 couldn't be queued${AGAIN}) · ${counts(30, 2, 0, 3, 0, 25)}`, 179]);
    // a problem and a day stop: "it tries again" goes, then the day's stop, before a word of the problem is cut
    const both = text('BigQuery didn\'t answer', THREE, { tab: true, stop: STOP_OLD });
    eq([both, both.length], [`${head} (BigQuery didn't answer) · ${THREE_TEXT} · ${STOP_OLD}`, 197]);
    const bothNew = text('BigQuery didn\'t answer', THREE, { tab: true, stop: STOP_NEW });
    eq(bothNew, `${head} (BigQuery didn't answer) · ${THREE_TEXT}`);
    [both, bothNew].forEach(t => whole(t, THREE));
    // a problem too long for the line: its end is cut, the numbers never
    const long = text('x'.repeat(300), THREE, { tab: true, stop: STOP_NEW });
    eq([long.length, long.indexOf(`${head} (xxx`), /x…\) · today: 999 found/.test(long)], [200, 0, true]);
    whole(long, THREE);
    // bigger numbers still: whole, and under 200
    whole(text('a BigQuery source table was not found', nums(9999, 9999, 9999, 9999, 9999, 9999), { tab: true, stop: STOP_NEW }), nums(9999, 9999, 9999, 9999, 9999, 9999));
    whole(text('x'.repeat(300), nums(999999, 999999, 999999, 999999, 999999, 999999), { tab: true }), nums(999999, 999999, 999999, 999999, 999999, 999999));
    // the words "cluster" and "velocity" are gone from the line
    [plain, stopNew, stopOld, p1, p2, p3, small, both, bothNew].forEach(t => assert.ok(!/cluster|velocity/i.test(t), t));
  });

  test('early detection C19: over the long mixed day the note holds the day\'s numbers as they stand after EVERY run, they add up, the note is never cut (at most 200 characters, as it was written), and "cluster" and "velocity" are not in it; in the one-space setup and in the Mirror flow', () => {
    for (const flow of ['one-space', 'mirror']) {
      const w = ends.world({ flow, row46: false });
      const props = w.t.g.services.PropertiesService.getScriptProperties();
      const noteOf = () => (JSON.parse(w.t.g.props.get('SWITCH_NOTES') || '{}').earlyWave || {}).text || '';
      const seen = [];
      ends.day(w, run => {
        const note = noteOf();
        const n = parse(note);
        assert.ok(n, `${flow} ${run.at}: ${note}`);
        eq(n, w.t.bot.edDayNumbers_(props), `${flow} ${run.at}: ${note}`);
        eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `${flow} ${run.at}: ${note}`);
        assert.ok(note.length <= 200 && !/…$/.test(note) && !/cluster|velocity/i.test(note), `${flow} ${run.at}: ${note}`);
        assert.ok(String(w.sh.cell(19, 3)).endsWith(` · ${note}`), `${flow} ${run.at}`);
        seen.push([run.at, note.replace(/^last check [^·(]+/, '').trim()]);
      });
      const at = time => seen.find(x => x[0] === time)[1];
      // the first run of the day, a check with a signal let go without a line of its own before, the check BigQuery
      // didn't answer (its problem takes the pointer's room), the day after (five waited at midnight), the day's limit
      eq([at('08:01'), at('08:17'), at('13:50'), at('D2 00:07'), at('D2 00:50')], [
        `· ${counts(0, 0, 0, 0, 0, 0)} · ${POINTER}`,
        `· ${counts(6, 3, 0, 3, 0, 0)} · ${POINTER}`,
        `(BigQuery didn't answer${AGAIN}) · ${counts(41, 10, 0, 19, 12, 0)}`,
        `· ${counts(5, 2, 0, 2, 1, 0)} · ${POINTER}`,
        `· ${counts(9, 3, 0, 2, 4, 0)} · ${STOP_OLD}`,
      ], flow);
    }
  });

  test('early detection C19: the day\'s stop in words: the old rule\'s "daily cap of 40 reached, more tomorrow" once 40 were queued; under a daily limit a check passes (dayLimit), "today\'s limit of 150 reviews is reached, more after midnight ET" once that many were, also in the notes the reviews write until the next check; the pointer is there only with the setting early_detection_tab on', () => {
    const g = makeGoogle(NOW);
    const bot = loadBot(g.services, g.clock);
    const props = g.services.PropertiesService.getScriptProperties();
    const note = () => JSON.parse(g.props.get('SWITCH_NOTES')).earlyWave.text.replace(/^last check [^·]+· /, '');
    const day = () => JSON.parse(g.props.get('EARLY_DETECTION_TODAY'));
    const zero = counts(0, 0, 0, 0, 0, 0);
    // the old rule
    bot.noteEarlyWave_(props, 0, 0, '', { queued: 39 });
    eq(note(), `${zero} · ${POINTER}`);
    bot.noteEarlyWave_(props, 0, 0, '', { queued: 1 });
    eq([note(), day().queued, day().limit], [`${zero} · ${STOP_OLD}`, 40, undefined]);
    // a check under a daily limit of 150: 40 is no stop there
    bot.noteEarlyWave_(props, 0, 0, '', { dayLimit: 150 });
    eq([note(), day().limit], [`${zero} · ${POINTER}`, 150]);
    bot.noteEarlyWave_(props, 0, 0, '', { queued: 110, dayLimit: 150 });
    eq(note(), `${zero} · ${STOP_NEW}`);
    // a review's note (not a check: no dayLimit passed) keeps the limit of the last check
    bot.noteEarlyWave_(props, 1, 0, '', { checked: false });
    eq([note(), day().limit, day().clusters], [`${zero} · ${STOP_NEW}`, 150, 1]);
    // the next check runs under the old rule again: its words are back
    bot.noteEarlyWave_(props, 0, 0, '');
    eq([note(), day().limit], [`${zero} · ${STOP_OLD}`, undefined]);
    assert.ok(g.props.get('EARLY_DETECTION_TODAY').length < 400);

    // the pointer follows the setting: off, no pointer at all; a day stop is still said
    Object.assign(bot.ev('GEN').settings, { early_detection_tab: false });
    g.props.delete('EARLY_DETECTION_TODAY');
    bot.noteEarlyWave_(props, 0, 0, '');
    eq(note(), zero);
    bot.noteEarlyWave_(props, 0, 0, '', { queued: 40 });
    eq(note(), `${zero} · ${STOP_OLD}`);
    Object.assign(bot.ev('GEN').settings, { early_detection_tab: true });
    g.props.delete('EARLY_DETECTION_TODAY');
    bot.noteEarlyWave_(props, 0, 0, '');
    eq(note(), `${zero} · ${POINTER}`);
  });

  test('early detection C19: the note is written again whenever a signal leaves the queue: also when its stored row was gone or Chat gave no message for its card, which no other count shows, and when a signal is dropped after a card was posted in the same run', () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    const note = () => parse(JSON.parse(w.t.g.props.get('SWITCH_NOTES')).earlyWave.text);
    w.busy = true;
    const lost = ends.signal(1, { at: '08:16' });
    const held = ends.signal(2, { at: '08:16', words: 'Pixel owners say the lock screen stutters CARDHELD, story 2' });
    w.run('08:16', [lost, held]);
    eq(note(), nums(2, 0, 0, 0, 0, 2));
    w.loseRow(lost);
    w.busy = false;
    w.run('08:17');
    eq(note(), nums(2, 0, 0, 1, 1, 0));  // one never reviewed (its row was gone), one let go (no message for its card)

    // ... and when a signal is dropped after a card was posted in the same run (the card's note came before the drop)
    const v = ends.world({ flow: 'one-space', row46: false });
    const noteV = () => parse(JSON.parse(v.t.g.props.get('SWITCH_NOTES')).earlyWave.text);
    v.busy = true;
    v.run('08:46', [ends.signal(3, { au: 6, pri: 'P1', at: '08:46' }),
      ends.signal(4, { au: 3, pri: 'P1', type: 'EARLY_WATCH', at: '08:46', words: 'Fake Google support scam ads drained my wallet, story 4' })]);
    eq(noteV(), nums(2, 0, 0, 0, 0, 2));
    v.sh.getRange(39, 2).setValue('OFF');  // the early signal that waits is dropped at its turn, after the story's card
    v.busy = false;
    v.run('08:47');
    eq([noteV(), v.t.bot.edNotesOfRun_().map(r => v.t.bot.edNoteObj_(r).outcome)],
      [nums(2, 1, 0, 0, 1, 0), ['Card posted: Monitor build-up', 'Never reviewed']]);
  });
};
