// Where the Early Detection tab (EarlyDetectionTab.gs) meets the Auto-correct flow's allowance and its notes under
// another alert's card (BigQuery.gs edAllowance_, EarlyDetectionCross.gs): the two were built apart on the same record
// of story signals (EarlyDetectionNotes.gs edNote_). The endings only the allowance has ("Added under another alert's
// card", "Never reviewed" for the hour's reviews, a topic busier than usual) must each give one row on the tab and count
// once in the day's numbers, and the tab's row 3 must say what C19 says.
'use strict';

module.exports = H => {
  const { test, eq, assert } = H;
  const ends = require('./ed_endings')(H);
  const ON = { cross_alert_notes: true };  // the settings as the config gives them: the allowance and the notes ON
  const TAB = 'Early Detection';
  const props = w => w.t.g.services.PropertiesService.getScriptProperties();
  const recsOf = w => w.t.bot.edNotesOfRun_().map(r => w.t.bot.edNoteObj_(r));
  const ordinary = (n, at) => ends.signal(n, { at, words: `Pixel owners say app ${n} is slow DECLOW, story ${n}` });
  /** Another path's card on `sig`'s main post that went out as a Social Alert, with its Alert-log row. */
  const cover = (w, sig, id) => {
    const card = w.t.chat._add(w.space, { text: `A card of another path (${id})`, sender: { name: w.t.chat.botUser, type: 'BOT' },
      viaApi: true, clientId: `client-bqa-cover-${id}` });
    w.t.bot.sheetBackend_(w.t.sheet()).appendAlert({
      alert_id: id, created_at: w.t.g.clock.now, space: w.partition, status: 'ok', ingested: 'BSIP', email_status: 'sent',
      record_key: w.t.bot.recordKey_({ post_url: sig.primary_url }), source_message: card.name, source_thread: card.thread.name,
      forward_message: card.name, forward_thread: card.thread.name });
    return card;
  };
  /** The tab's data rows as [Id, Outcome]; the tab's row 3. */
  const tabRows = w => {
    const tab = w.t.sheet().getSheetByName(TAB);
    return tab ? tab.rows.slice(4).map(r => [String(r[9]).replace(/^'/, ''), String(r[1]).replace(/^'/, '')]) : [];
  };
  const tabToday = w => {
    const tab = w.t.sheet().getSheetByName(TAB);
    return tab ? String(tab.cell(3, 1)) : '';
  };
  const waitingRows = w => {
    const v = JSON.parse(w.t.g.services.CacheService.getScriptCache().get('ed_tab_waiting') || 'null');
    return v ? v.r.map(r => w.t.bot.edNoteObj_(r)).map(r => [r.id, r.outcome]) : [];
  };
  /** "F found, C cards, ..." on C19 or "F found · C cards · ..." on the tab -> [F, C, U, L, N, W]. */
  const numbers = s => {
    const m = String(s).match(/(\d+) found\D+(\d+) cards?\D+(\d+) under another alert\D+(\d+) let go\D+(\d+) never reviewed\D+(\d+) waiting/);
    return m ? m.slice(1).map(Number) : null;
  };

  test('merged lanes, early detection tab and allowance: each ending the allowance adds (under another alert\'s card, never reviewed for the hour\'s reviews) is one row on the tab and one count in the day\'s numbers, and the tab\'s row 3 says what C19 says', () => {
    const w = ends.world({ flow: 'one-space', row46: false, settings: ON });
    const all = [];
    const step = (time, rows) => {
      const look = w.run(time, rows);
      all.push(...recsOf(w).map(r => [r.id, r.outcome]));
      const n = w.t.bot.edDayNumbers_(props(w));
      eq(n.found, n.cards + n.under + n.letgo + n.never + n.waiting, `the run at ${time}: ${JSON.stringify(n)}`);
      return Object.assign(look, { n });
    };
    step('08:01', []);
    const s1 = ends.signal(1, { au: 5, at: '08:10' });
    cover(w, s1, 'QA-0901');
    step('08:16', [s1]);
    step('09:01', [2, 3, 4, 5, 6].map(n => ordinary(n, '09:01')));
    step('09:16', [7, 8, 9, 10].map(n => ordinary(n, '09:16')));
    for (const time of ['09:17', '09:18', '09:19', '09:20']) step(time);
    const end = step('09:21');

    const outcomes = all.map(r => r[1]);
    assert.ok(outcomes.includes('Added under another alert\'s card'), JSON.stringify(all));
    eq(outcomes.filter(o => o === 'Never reviewed').length, 3, JSON.stringify(all));
    // every ending is one row, on the tab or still waiting for a run with time; none twice
    const listed = tabRows(w).concat(waitingRows(w));
    eq(listed.map(r => r.join(' | ')).sort(), all.map(r => r.join(' | ')).sort());
    eq(new Set(all.map(r => r[0])).size, all.length);
    // the day's numbers count each ending once, and the tab's row 3 and C19 give the same numbers
    const n = w.t.bot.edDayNumbers_(props(w));
    eq([n.found, n.under, n.never], [10, 1, 3]);
    eq(numbers(end.c19), [n.found, n.cards, n.under, n.letgo, n.never, n.waiting]);
    assert.ok(tabToday(w), 'the tab was written');
    eq(numbers(tabToday(w)).slice(0, 5), numbers(end.c19).slice(0, 5));
  });
};
