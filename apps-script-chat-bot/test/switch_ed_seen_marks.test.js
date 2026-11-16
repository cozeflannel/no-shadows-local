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
};
