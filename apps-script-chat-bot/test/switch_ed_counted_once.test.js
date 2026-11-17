// Early Detection: a signal is counted once, whatever comes round again (EarlyDetectionNotes.gs edNote_, BigQuery.gs
// edCount_ and its `noted` list with the day's counts), a count that could not be saved is tried again and kept for
// the run (noteEarlyWave_ saves it), and a card already in the space is counted as a card, never as a repeat or as never reviewed.
//
// Each sequence checks after every run that the day's numbers add up AND that found is the number of different
// signals the day has counted (each one that got a row, or waits in the queue): a signal counted twice would add up
// too, so the sum alone can't tell.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const ends = require('./ed_endings')(H);
  const say = (what, n) => `Pixel owners say ${what}, story ${n}`;
  const props = w => w.t.g.services.PropertiesService.getScriptProperties();
  const numbers = w => w.t.bot.edDayNumbers_(props(w));

  /** A world whose runs are checked: after each, the numbers add up and found is the number of signals counted. */
  const checked = o => {
    const w = ends.world(o || { flow: 'one-space', row46: false });
    const counted = new Set();
    w.rows46 = [];
    w.step = (time, rows) => {
      const look = w.run(time, rows);
      const recs = w.t.bot.edNotesOfRun_().map(r => w.t.bot.edNoteObj_(r));
      recs.forEach(r => { counted.add(r.id); w.rows46.push([time, r.id, r.outcome, r.why]); });
      w.t.bot.edQueueList_(props(w)).forEach(e => counted.add(e.id));
      const n = numbers(w);
      eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `the run at ${time}: ${JSON.stringify(n)}`);
      eq(n.found, counted.size, `the run at ${time}: found ${n.found}, signals counted ${[...counted].join(', ')}`);
      return Object.assign(look, { recs, n });
    };
    return w;
  };
  const brief = recs => recs.map(r => [r.id.replace(/^ED-[A-Z]+-clu_ends0*(\d+)-.*$/, '$1'), r.outcome, r.why]);

  test('early detection counted once: at the day\'s limit of 40 the signals read are noted as never reviewed; when one of them is later looked at again (a repeat of a card, not English) it is not counted a second time and gets no second row', () => {
    const w = checked();
    const C = ends.signal(210, { au: 6, pri: 'P1', at: '08:16', words: say('the dock disconnects', 210) });
    let look = w.step('08:16', [C]);
    eq(brief(look.recs), [['210', 'Card posted: Monitor build-up', 'Early reports worth watching.']]);
    w.busy = true;
    w.setDay({ queued: 40 });
    const X = ends.signal(202, { pri: 'P1', at: '08:31', words: say('the torch flickers', 202) });
    const Rp = ends.signal(210, { au: 7, at: '08:31', words: say('the dock disconnects', 210) });
    const Y = ends.signal(203, { at: '08:31', words: `${ends.NOT_ENGLISH} 203` });
    look = w.step('08:31', [C, X, Rp, Y]);
    eq(brief(look.recs).map(x => x[1]), ['Never reviewed', 'Never reviewed', 'Never reviewed']);
    eq(look.n, { found: 4, cards: 1, under: 0, letgo: 0, never: 3, waiting: 0 });
    look = w.step('08:46', [C, X, Rp, Y]);
    eq(look.recs, []);
    // X has left the producer's hand-over: the check now looks at the two behind it
    look = w.step('09:01', [C, Rp, Y]);
    eq([look.recs, look.n], [[], { found: 4, cards: 1, under: 0, letgo: 0, never: 3, waiting: 0 }]);
    assert.ok(look.logs.map(String).some(l => /held back a repeat of "Small accounts report problem 210"/.test(l)), 'the repeat\'s own log line is still written');
    look = w.step('09:16', [C, Rp, Y]);
    eq([look.recs, look.n.found], [[], 4]);
  });

  test('early detection counted once: an early signal read while row 39 is OFF is never reviewed (once, though read at two checks); queued when row 39 is ON again, it moves from never reviewed to the queue, and its card makes it a card: found stays 1', () => {
    const w = checked();
    w.sh.getRange(39, 2).setValue('OFF');
    const W = ends.signal(220, { au: 3, type: 'EARLY_WATCH', pri: 'P1', at: '08:16', words: 'Fake Google support scam ads drained my wallet, story 220' });
    let look = w.step('08:16', [W]);
    eq(brief(look.recs), [['220', 'Never reviewed', 'Early signals are switched OFF (row 39).']]);
    look = w.step('08:31', [W]);
    eq([look.recs, look.n], [[], { found: 1, cards: 0, under: 0, letgo: 0, never: 1, waiting: 0 }]);
    w.sh.getRange(39, 2).setValue('ON');
    look = w.step('08:46', [W]);
    eq(brief(look.recs), [['220', 'Card posted: Monitor build-up', 'Early reports worth watching.']]);
    eq(look.n, { found: 1, cards: 1, under: 0, letgo: 0, never: 0, waiting: 0 });
    look = w.step('08:47', [W]);
    eq([look.recs, look.n.found], [[], 1]);
  });

  test('early detection counted once: a check that dies half way has counted what it noted but saved none of its marks; the next check reads those signals again and counts none of them twice (row 39 ON and OFF), and a story it carded in between is not a repeat of itself', () => {
    for (const rank of [true, false]) {
      const w = checked();
      if (!rank) w.sh.getRange(39, 2).setValue('OFF');
      w.busy = true;
      const N = ends.signal(301, { at: '08:16', words: `${ends.NOT_ENGLISH} 301` });
      const H1 = ends.signal(302, { at: '08:16', words: 'People chat about the new Pixel wallpaper DECNOISE, story 302' });
      const Q1 = ends.signal(303, { pri: 'P1', at: '08:16', words: say('the clock drifts', 303) });
      const Z = ends.signal(304, { at: '08:16', words: say('BOOM the app explodes', 304) });
      const Q2 = ends.signal(305, { at: '08:16', words: say('the alarm is late', 305) });
      w.t.bot.__boom = 1;
      w.t.bot.ev('edStoryVerdict_ = (f => function (row) { if (__boom && /BOOM/.test(JSON.stringify(row || {}))) { __boom--; ' +
        'throw new Error("scripted: the check dies here"); } return f.apply(this, arguments); })(edStoryVerdict_)');
      const first = w.step('08:16', [N, H1, Q1, Z, Q2]);
      eq(w.t.g.props.has('EARLY_DETECTION_SEEN'), false, 'the dead check saved no marks');
      w.step('08:17', null);
      const again = w.step('08:31', [N, H1, Q1, Z, Q2]);
      w.step('08:46', [N, H1, Q1, Z, Q2]);
      const all = w.rows46.map(x => x[1]);
      const label = rank ? 'row 39 ON' : 'row 39 OFF';
      // every signal has one row at most, and none of the first check's rows comes again
      eq(all.length, new Set(all).size, `${label}: ${JSON.stringify(w.rows46)}`);
      first.recs.forEach(r => assert.ok(!again.recs.some(x => x.id === r.id), `${label}: ${r.id}`));
      eq(numbers(w).found, 5, label);
    }
  });

  test('early detection: a card already in the space is counted as a card: a run that dies after the card was posted and logged but before its signal left the queue notes that card at the next run (never a repeat); a card posted but never logged (the run failed twice after the post) is noted as a card that needs a human look when the signal is dropped, and its story keeps its marks, so the story\'s next signal is no second card', () => {
    {  // posted and logged, then the run dies before the signal leaves the queue
      const w = checked();
      const S = ends.signal(230, { au: 6, pri: 'P1', at: '08:16', words: say('the dock disconnects', 230) });
      w.t.bot.__boom = 1;
      w.t.bot.ev('edQueueDrop_ = (f => function () { if (__boom) { __boom--; throw new Error("scripted: the run dies here"); } ' +
        'return f.apply(this, arguments); })(edQueueDrop_)');
      let look = w.step('08:16', [S]);
      eq([look.cards.length, look.recs, look.waiting], [1, [], 1]);
      look = w.step('08:17', null);
      eq(brief(look.recs), [['230', 'Card posted: Monitor build-up', 'Its card was posted on an earlier try.']]);
      eq([look.recs[0].card, look.recs[0].message.indexOf(`${w.space}/messages/`), look.recs[0].story, look.cards.length],
        ['QA-1001', 0, 'Small accounts report problem 230', 0]);
      eq(look.n, { found: 1, cards: 1, under: 0, letgo: 0, never: 0, waiting: 0 });
      look = w.step('08:31', [S]);
      eq([look.recs, look.n.found, look.cards.length], [[], 1, 0]);
    }
    {  // posted, never logged (twice): dropped after two tries
      const w = checked();
      w.t.bot.__boom = 2;
      w.t.bot.ev('edAct_ = (f => function () { if (__boom) { __boom--; throw new Error("scripted: Sheets failed after the card was posted"); } ' +
        'return f.apply(this, arguments); })(edAct_)');
      const first = ends.signal(90, { au: 5, at: '09:16', words: say('the keyboard lags', 90) });
      w.step('09:16', [first]);
      w.step('09:17', null);
      let look = w.step('09:18', null);
      eq(brief(look.recs), [['90', 'Card posted: Needs a human look',
        'Its card is in the space, but the bot could not record it, so a person makes the call.']]);
      eq([look.recs[0].card, look.n], ['', { found: 1, cards: 1, under: 0, letgo: 0, never: 0, waiting: 0 }]);
      assert.ok(look.logs.map(String).includes(`early detection: dropped ${first.alert_id} (2 reviews started without finishing)`));
      const again = ends.signal(90, { au: 7, at: '09:31', words: say('the keyboard lags', 90) });
      look = w.step('09:31', [first, again]);
      eq(brief(look.recs), [['90', 'Seen before, nothing new', 'First seen 9:16 AM ET with 5 accounts; 7 now, nothing new.']]);
      w.step('09:32', null);
      const stories = w.t.chat.botPosts(w.space).filter(m => /^client-zeda-/.test(String(m.clientAssignedMessageId || '')) && !m.threadReply);
      eq(stories.length, 1);
    }
  });

  test('early detection: a count that could not be saved leaves the numbers wrong for one moment at most: the signal just queued is counted right when the day\'s first save failed; an ending\'s count whose save fails is saved by the second try, or kept for the run and saved by the next note of C19 with its true ending; only one lost for good (its run ended first) makes found add up, and the log says so', () => {
    const failing = (w, when, times) => {
      const ps = w.t.g.services.PropertiesService;
      const real = ps.getScriptProperties;
      let armed = times || 1;
      ps.getScriptProperties = () => {
        const p = real();
        return {
          getProperty: k => p.getProperty(k),
          getKeys: () => p.getKeys(),
          getProperties: () => p.getProperties(),
          deleteProperty(k) { p.deleteProperty(k); return this; },
          setProperty(k, v) {
            if (armed && k === 'EARLY_DETECTION_TODAY' && when(JSON.parse(v), JSON.parse(p.getProperty(k) || '{}'))) {
              armed--;
              throw new Error('scripted: Service error: Properties');
            }
            p.setProperty(k, v);
            return this;
          },
        };
      };
    };
    {  // the day's first save fails just as a signal is queued
      const w = checked();
      w.busy = true;
      failing(w, () => true);
      const look = w.step('08:16', [ends.signal(240, { at: '08:16' })]);
      assert.ok(look.logs.map(String).some(l => /could not start the day's early detection counts: scripted/.test(l)));
      eq([look.n, look.logs.map(String).filter(l => /did not add up/.test(l))],
        [{ found: 1, cards: 0, under: 0, letgo: 0, never: 0, waiting: 1 }, []]);
    }
    // the count of a signal dropped after 3 hours: its save fails once (the second try saves it), twice (kept for the
    // run: the drain's note of C19 saves it), or four times (both saves fail: kept, then lost with the run's end)
    const dropped = (times, lose) => {
      const w = ends.world({ flow: 'one-space', row46: false });
      w.busy = true;
      w.run('08:16', [ends.signal(241, { at: '08:16' })]);
      failing(w, (next, was) => Number(next.never) > Number(was.never || 0), times);
      w.busy = false;
      const look = w.run('11:31', []);
      const n = numbers(w);
      if (lose) w.t.bot.ev('ED_COUNT_UNSAVED_ = []');  // the run ended: what it kept in memory is gone
      const next = lose ? w.run('11:46', []) : null;
      return { w, look, next, n, kept: numbers(w), told: look.logs.concat(next ? next.logs : []).map(String)
        .filter(l => /early detection: (dropped|today's numbers)|could not save today's early detection counts/.test(l)) };
    };
    const DROP = `early detection: dropped ${ends.signal(241, { at: '08:16' }).alert_id} (not reviewed within 3 hours of being queued)`;
    const FAILED = 'ERROR could not save today\'s early detection counts: scripted: Service error: Properties';
    const FAILED2 = 'ERROR could not save today\'s early detection counts (second try): scripted: Service error: Properties';
    const ONE = { found: 1, cards: 0, under: 0, letgo: 0, never: 1, waiting: 0 };
    {
      const r = dropped(1);
      eq([r.n, r.told], [ONE, [DROP, FAILED]]);
      assert.ok(/today: 1 found, 0 cards, 0 under another alert, 0 let go, 1 never reviewed, 0 waiting/.test(r.look.c19), r.look.c19);
    }
    {
      const r = dropped(2);
      eq([r.n, r.told], [ONE, [DROP, FAILED, FAILED2]]);
      eq(JSON.parse(r.w.t.g.props.get('EARLY_DETECTION_TODAY')).never, 1);  // saved by the note of C19
      assert.ok(/today: 1 found, 0 cards, 0 under another alert, 0 let go, 1 never reviewed, 0 waiting/.test(r.look.c19), r.look.c19);
    }
    {
      const r = dropped(4, true);
      eq([r.n, r.kept, r.told], [ONE, { found: 0, cards: 0, under: 0, letgo: 0, never: 0, waiting: 0 }, [DROP, FAILED, FAILED2, FAILED, FAILED2,
        'early detection: today\'s numbers did not add up (1 found, but 0 cards, 0 under another alert, 0 let go, 0 never reviewed and 0 waiting), so found is made to add up: 0',
      ]]);
      assert.ok(/today: 0 found, 0 cards, 0 under another alert, 0 let go, 0 never reviewed, 0 waiting/.test(r.next.c19), r.next.c19);
    }
    // the day's state without found (its first save failed): a signal that waited is counted as having left the queue
    {
      const w = ends.world({ flow: 'one-space', row46: false });
      const bot = w.t.bot;
      const p = props(w);
      const sig = ends.signal(242, { at: '08:16' });
      w.t.g.clock.now = ends.at('08:16');
      eq(bot.edQueuePut_(p, sig, w.t.g.clock.now).queued, true);
      w.t.g.props.delete('EARLY_DETECTION_TODAY');  // as if neither save of the day had gone through
      bot.edQueueDrop_(p, bot.edQueueKey_(sig));    // the day starts here, at rest: nothing waits
      w.t.g.props.delete('EARLY_DETECTION_TODAY');
      bot.edNote_({ now: () => w.t.g.clock.now, log() {} }, sig, 'Reviewed and dismissed', 'x', { waited: true, logged: true });
      eq(numbers(w), { found: 1, cards: 0, under: 0, letgo: 1, never: 0, waiting: 0 });
    }
  });

  test('early detection counted once: the list of signals counted carries over midnight: one still waiting is counted where it ends; one that ended the day before is not counted again; one that ended the day before and is queued today is found today', () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    const bot = w.t.bot;
    const p = props(w);
    const ctx = { now: () => w.t.g.clock.now, log() {} };
    w.t.g.clock.now = ends.at('23:30');
    const waits = ends.signal(250, { at: '23:30' });
    const ended = ends.signal(251, { at: '23:30' });
    const back = ends.signal(252, { at: '23:30' });
    bot.edQueuePut_(p, waits, w.t.g.clock.now);
    bot.edNote_(ctx, ended, 'Not English', 'x', {});
    bot.edNote_(ctx, back, 'Never reviewed', bot.edNeverWhy_('day'), { once: true });
    eq(numbers(w), { found: 3, cards: 0, under: 0, letgo: 1, never: 1, waiting: 1 });
    w.t.g.clock.now = ends.at('D2 00:10');
    eq(bot.edNote_(ctx, ended, 'Not English', 'x', {}), null);
    eq(bot.edQueuePut_(p, back, w.t.g.clock.now).queued, true);
    bot.edQueueDrop_(p, bot.edQueueKey_(waits));
    eq(bot.edNote_(ctx, waits, 'Reviewed and dismissed', 'x', { waited: true }) !== null, true);
    eq(numbers(w), { found: 2, cards: 0, under: 0, letgo: 1, never: 0, waiting: 1 });
    eq(JSON.parse(w.t.g.props.get('EARLY_DETECTION_TODAY')).noted.map(e => e.split('=')[1]), ['-', 'w', 'l']);
  });
};
