// What Early Detection remembers of a story whose signal was never reviewed (BigQuery.gs earlyWaveCheck_, the seen map
// EARLY_DETECTION_SEEN). A story is marked as seen, with its accounts, when its signal is queued for a review: the
// story's next signal is then held back as a repeat unless the story grew. A signal that never got that review must not
// leave the mark behind: the story's next signal would be held back as a repeat of something nobody looked at.
'use strict';

module.exports = H => {
  const { test, eq } = H;
  const ends = require('./ed_endings')(H);

  const HELD = 'Seen before, nothing new';
  const NEVER = 'Never reviewed';
  const say = (what, n) => `Pixel owners say ${what}, story ${n}`;
  /** The one-space setup with the review queue full of twelve stories of priority P1 (no review starts: the flow is busy). */
  const fullQueue = () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    w.busy = true;
    const fill = Array.from({ length: 12 }, (_, i) => ends.signal(31 + i, { pri: 'P1', at: i < 5 ? '09:31' : i < 10 ? '09:46' : '10:01',
      words: say(`app ${i + 1} freezes`, 31 + i) }));
    w.run('09:31', fill.slice(0, 5));
    w.run('09:46', fill.slice(0, 10));
    eq(w.run('10:01', fill).waiting, 12);
    return { w, fill };
  };
  const notes = w => w.t.bot.edNotesOfRun_().map(r => w.t.bot.edNoteObj_(r)).map(r => [r.id, r.outcome, r.why]);
  const waitingIds = w => w.t.bot.edQueueList_(w.t.g.services.PropertiesService.getScriptProperties()).map(e => e.id);
  const adds = look => look.day.found === look.day.cards + look.day.under + look.day.letgo + look.day.never + look.waiting;

  test('early detection seen marks: a signal the full queue had no room for marks only itself as seen, never its story: the story\'s next signal is not held back as a repeat of a signal nobody reviewed, and the refused signal itself is not read again', () => {
    const { w, fill } = fullQueue();
    // a story of lower priority arrives: the queue has no room for it
    const first = ends.signal(90, { au: 5, pri: 'P2', at: '10:16', words: say('the torch flickers', 90) });
    let look = w.run('10:16', fill.concat([first]));
    eq([look.waiting, notes(w), adds(look)], [12, [[first.alert_id, NEVER, 'The review queue was full.']], true]);
    // the same story again, a little bigger and ranked higher: it is a story nobody has reviewed, so it is queued (the
    // lowest-ranked of the twelve makes room), not held back as "already queued with 5 accounts, nothing new"
    const again = ends.signal(90, { au: 7, pri: 'P1', at: '10:31', words: say('the torch flickers', 90) });
    look = w.run('10:31', fill.concat([first, again]));
    eq(notes(w).filter(n => n[1] === HELD), []);
    eq([look.waiting, waitingIds(w).includes(again.alert_id), waitingIds(w).includes(first.alert_id), adds(look)], [12, true, false, true]);
    eq(notes(w), [[fill[11].alert_id, NEVER, 'Pushed out of the full queue by higher-ranked stories.']]);
    eq(look.logs.filter(l => /held back a repeat/.test(String(l))), []);
    // the refused signal is marked by its own id: handed over again, it is not looked at, noted or counted again
    look = w.run('10:46', fill.concat([first, again]));
    eq([notes(w), look.waiting, adds(look)], [[], 12, true]);
  });

  test('early detection seen marks: a queued signal that leaves the queue without a review (pushed out of the full queue, dropped after 3 hours, dropped after two tries that didn\'t finish) no longer leaves its story marked as seen: the story\'s next signal is reviewed, not held back as a repeat; the dropped signal\'s own id stays marked, so it is never queued again', () => {
    const CARD = 'Card posted: Monitor build-up';
    // 1. Pushed out: eleven P1 stories and a P2 one fill the queue; a twelfth P1 story pushes the P2 one out
    {
      const w = ends.world({ flow: 'one-space', row46: false });
      w.busy = true;
      const fill = Array.from({ length: 11 }, (_, i) => ends.signal(31 + i, { pri: 'P1', at: i < 5 ? '09:31' : i < 10 ? '09:46' : '10:01',
        words: say(`app ${i + 1} freezes`, 31 + i) }));
      const first = ends.signal(90, { au: 5, pri: 'P2', at: '10:01', words: say('the torch flickers', 90) });
      w.run('09:31', fill.slice(0, 5));
      w.run('09:46', fill.slice(0, 10));
      eq(w.run('10:01', fill.concat([first])).waiting, 12);
      const pusher = ends.signal(91, { au: 5, pri: 'P1', at: '10:16', words: say('the alarm is late', 91) });
      let look = w.run('10:16', fill.concat([first, pusher]));
      eq([notes(w), look.waiting, adds(look)], [[[first.alert_id, NEVER, 'Pushed out of the full queue by higher-ranked stories.']], 12, true]);
      // its story's next signal, with 7 accounts where it had 5: queued (it now pushes the lowest-ranked one out)
      const again = ends.signal(90, { au: 7, pri: 'P1', at: '10:31', words: say('the torch flickers', 90) });
      look = w.run('10:31', fill.concat([first, pusher, again]));
      eq(notes(w), [[pusher.alert_id, NEVER, 'Pushed out of the full queue by higher-ranked stories.']]);
      eq([waitingIds(w).includes(again.alert_id), waitingIds(w).includes(first.alert_id), look.waiting, adds(look)], [true, false, 12, true]);
      // the signals that were pushed out are still marked by their own ids: handed over again, neither is queued again
      look = w.run('10:46', fill.concat([first, pusher, again]));
      eq([notes(w), waitingIds(w).includes(first.alert_id), waitingIds(w).includes(pusher.alert_id), look.waiting, adds(look)], [[], false, false, 12, true]);
    }
    // 2. Dropped after 3 hours of waiting
    {
      const w = ends.world({ flow: 'one-space', row46: false });
      w.busy = true;
      const first = ends.signal(90, { au: 5, at: '09:31', words: say('the torch flickers', 90) });
      eq(w.run('09:31', [first]).waiting, 1);
      w.busy = false;
      let look = w.run('12:35', []);
      eq([notes(w), look.waiting, adds(look)], [[[first.alert_id, NEVER, 'Waited 3 hours while the bot worked on alerts.']], 0, true]);
      const again = ends.signal(90, { au: 7, at: '12:50', words: say('the torch flickers', 90) });
      look = w.run('12:50', [first, again]);
      eq([notes(w), look.waiting, adds(look)], [[[again.alert_id, CARD, 'Early reports worth watching.']], 0, true]);
    }
    // 3. Dropped after two tries that didn't finish (Chat refused its card twice)
    {
      const w = ends.world({ flow: 'one-space', row46: false });
      const first = ends.signal(90, { au: 5, at: '09:16', words: 'Pixel owners say the keyboard lags CARDFAIL, story 90' });
      eq(w.run('09:16', [first]).waiting, 1);
      eq(w.run('09:17').waiting, 1);
      let look = w.run('09:18');
      eq([notes(w), look.waiting, adds(look)], [[[first.alert_id, NEVER, 'Its review failed twice.']], 0, true]);
      const again = ends.signal(90, { au: 7, at: '09:31', words: say('the keyboard lags', 90) });
      look = w.run('09:31', [first, again]);
      eq([notes(w), look.waiting, adds(look)], [[[again.alert_id, CARD, 'Early reports worth watching.']], 0, true]);
    }
    // 4. Its story's mark was written again while it waited (the seen map was lost and the signal handed over once more):
    //    the mark is still its own, and goes with it
    {
      const w = ends.world({ flow: 'one-space', row46: false });
      w.busy = true;
      const first = ends.signal(90, { au: 5, at: '09:31', words: say('the torch flickers', 90) });
      w.run('09:31', [first]);
      w.t.g.props.delete('EARLY_DETECTION_SEEN');
      eq([w.run('09:46', [first]).waiting, notes(w)], [1, []]);
      // (while it waits, its story is marked as before: a second signal with nothing new is a repeat)
      const mid = ends.signal(90, { au: 7, at: '10:01', words: say('the torch flickers', 90) });
      eq([w.run('10:01', [first, mid]).waiting, notes(w)], [1, [[mid.alert_id, HELD, 'First seen 9:46 AM ET with 5 accounts; 7 now, nothing new.']]]);
      w.busy = false;
      let look = w.run('12:35', []);
      eq(notes(w), [[first.alert_id, NEVER, 'Waited 3 hours while the bot worked on alerts.']]);
      const again = ends.signal(90, { au: 7, at: '12:50', words: say('the torch flickers', 90) });
      look = w.run('12:50', [first, again]);
      eq([notes(w), look.waiting, adds(look)], [[[again.alert_id, CARD, 'Early reports worth watching.']], 0, true]);
    }
  });

  test('early detection seen marks: only the dropped signal\'s own mark is taken out: when a bigger signal on the same story is waiting too, the story stays marked with the bigger one\'s accounts, and its next signal is still held back as a repeat', () => {
    const w = ends.world({ flow: 'one-space', row46: false });
    w.busy = true;
    const fill = Array.from({ length: 10 }, (_, i) => ends.signal(31 + i, { pri: 'P1', at: i < 5 ? '09:31' : '09:46', words: say(`app ${i + 1} freezes`, 31 + i) }));
    w.run('09:31', fill.slice(0, 5));
    w.run('09:46', fill);
    // two signals on one story in the same check, the second with enough accounts to be news: both are queued
    const small = ends.signal(90, { au: 5, pri: 'P2', at: '10:00', words: say('the torch flickers REVDISMISS', 90) });
    const big = ends.signal(90, { au: 12, pri: 'P2', at: '10:01', words: say('the torch flickers REVDISMISS', 90) });
    eq(w.run('10:01', fill.concat([small, big])).waiting, 12);
    // a P1 story pushes the smaller one out
    const pusher = ends.signal(91, { au: 5, pri: 'P1', at: '10:16', words: say('the alarm is late', 91) });
    w.run('10:16', fill.concat([small, big, pusher]));
    eq(notes(w), [[small.alert_id, NEVER, 'Pushed out of the full queue by higher-ranked stories.']]);
    // the story is still marked with the bigger signal's 12 accounts: 13 accounts are nothing new
    const next = ends.signal(90, { au: 13, pri: 'P2', at: '10:31', words: say('the torch flickers REVDISMISS', 90) });
    const look = w.run('10:31', fill.concat([small, big, pusher, next]));
    eq(notes(w), [[next.alert_id, HELD, 'First seen 10:01 AM ET with 12 accounts; 13 now, nothing new.']]);
    eq([look.waiting, adds(look)], [12, true]);
  });
};
