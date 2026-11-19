// The Early Detection tab (EarlyDetectionTab.gs), after its review: the "tab in the way" sentence in Status (B5) goes
// once that tab is renamed even when no row is left to write; the ownership check reads only A1 and then row 4 of a tab,
// and a Sheets error during it is not taken for a tab in the way; every text cell is written as text (a leading
// apostrophe), so Sheets never makes a number or a date of it; row 3 says what C19 says after a run with time.
'use strict';

module.exports = H => {
  const { test, eq, assert, world, NOW } = H;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const TAB = 'Early Detection';
  const TITLE = 'Early Detection: every story it found and what happened to each (written by the Burson QA bot)';
  const HEADER = ['When (ET)', 'Outcome', 'Story', 'Why', 'Card', 'Kind', 'Accounts', 'Platforms', 'Exposure Tag (first guess)', 'Id'];
  const SPACE = 'spaces/AAQAedTabRv1';
  const link = n => `https://x.com/user${n}/status/${90000 + n}`;

  const sig = (n, o) => Object.assign({
    alert_id: `ED-CLU-CLU-rev${String(n).padStart(4, '0')}-202611150800`, signal_type: 'CLUSTER_EMERGENCE',
    unique_low_tier_authors: 5, platforms_csv: 'X, Reddit', primary_url: link(n),
    headline: `Low-tier claim cluster (5 accounts): Pixel owners say the camera fails, story ${n}`,
  }, o || {});
  const sheetOf = w => w.g.services.SpreadsheetApp.create('bot');
  const tabOf = ss => ss.getSheetByName(TAB);
  const cache = w => w.g.services.CacheService.getScriptCache();
  const note = (w, at, row, outcome, why, extra) => {
    w.g.clock.now = at;
    return w.bot.edNote_({ now: () => at, log: () => {} }, row, outcome, why, extra);
  };
  const ctxAt = at => ({ now: () => at });
  /** Records every call (its name and arguments) on a spreadsheet and the sheets and ranges it hands out. */
  const counted = (obj, log) => new Proxy(obj, {
    get(target, k) {
      const v = target[k];
      if (typeof v !== 'function') return v;
      return (...args) => {
        log.push([String(k)].concat(args.filter(a => typeof a === 'number')));
        const r = v.apply(target, args);
        return r && typeof r === 'object' && !Array.isArray(r) && (typeof r.getRange === 'function' || typeof r.setValues === 'function')
          ? counted(r, log) : r;
      };
    },
  });
  const names = log => log.map(x => x[0]);

  // ---------------------------------------------------------------------------------------------------------------
  // Status (B5) after the tab in the way is renamed
  // ---------------------------------------------------------------------------------------------------------------

  test('early detection tab (review): the "tab in the way" sentence goes once that tab is renamed, also in a run with no row to write (the waiting rows lost with the cache); while it is still in the way the sentence stays and the tab is not touched', () => {
    const w = world();
    const real = sheetOf(w);
    const theirs = real.insertSheet(TAB);
    theirs.getRange(1, 1, 5, 2).setValues([['their notes', 'x'], ['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']]);
    const kept = JSON.stringify(theirs.rows);
    note(w, NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    eq(w.bot.maybeWriteEdTab_(real, ctxAt(NOW), { deadline: NOW + 4 * MIN }).blocked, true);
    eq([w.g.props.get('ED_TAB_BLOCKED'), w.bot.edTabBlockedNote_() !== ''], ['true', true]);
    cache(w).remove('ed_tab_waiting');  // the waiting row is lost: no run has a row to write any more
    // a run with no row while the tab is still in the way: one look (its name, its row count, A1), nothing written
    w.bot.edNotesStart_();
    const log = [];
    const ss = counted(real, log);
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + MIN), { deadline: NOW + 4 * MIN }), { written: 0, waiting: 0, blocked: false });
    eq([names(log), JSON.stringify(theirs.rows) === kept, theirs.protections.length, w.g.props.get('ED_TAB_BLOCKED')],
      [['getSheetByName', 'getLastRow', 'getRange', 'getDisplayValue'], true, 0, 'true']);
    // a run with no time left doesn't look
    log.length = 0;
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + 2 * MIN), { deadline: NOW + 2 * MIN + 1000 });
    eq([log, w.g.props.get('ED_TAB_BLOCKED')], [[], 'true']);
    // renamed: the next run with time and no row sees the name is free, and the sentence goes; no tab is made
    theirs.setName('My notes');
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + 3 * MIN), { deadline: NOW + 6 * MIN });
    eq([w.g.props.has('ED_TAB_BLOCKED'), w.bot.edTabBlockedNote_(), tabOf(real), JSON.stringify(theirs.rows) === kept], [false, '', null, true]);
    // from now on a run with no row makes no Sheets call at all
    log.length = 0;
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + 4 * MIN), { deadline: NOW + 8 * MIN });
    eq(log, []);
  });

  test('early detection tab (review): the sentence also goes when the tab in the way becomes the bot\'s own again (its title and column names put back), in a run with no row', () => {
    const w = world();
    const ss = sheetOf(w);
    note(w, NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW), { deadline: NOW + 4 * MIN });
    const own = tabOf(ss);
    own.getRange(1, 1).setValue('Early Detection');  // someone changes the title
    w.bot.edNotesStart_();
    note(w, NOW + MIN, sig(2), 'Not English', 'Most of its posts are not in English');
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + MIN), { deadline: NOW + 4 * MIN }).blocked, true);
    cache(w).remove('ed_tab_waiting');
    own.getRange(1, 1).setValue(TITLE);  // and puts it back
    w.bot.edNotesStart_();
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + 2 * MIN), { deadline: NOW + 4 * MIN });
    eq([w.g.props.has('ED_TAB_BLOCKED'), w.bot.edTabBlockedNote_()], [false, '']);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The ownership check
  // ---------------------------------------------------------------------------------------------------------------

  test('early detection tab (review): the ownership check reads a tab\'s row count, then A1, then row 4 only when A1 is the bot\'s title; never rows 2 and 3, never past row 4', () => {
    const w = world();
    const ss = sheetOf(w);
    const check = (rows) => {
      const sh = ss.insertSheet('probe' + Math.random());
      if (rows.length) sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      const log = [];
      const owner = w.bot.edTabOwner_(counted(sh, log));
      return [owner, log];
    };
    const blank = new Array(10).fill('');
    const theirs = check([['their title'].concat(blank.slice(1)), blank, blank, HEADER, blank]);
    eq(theirs, ['other', [['getLastRow'], ['getRange', 1, 1], ['getDisplayValue']]]);
    const renamed = HEADER.slice();
    renamed[3] = 'Reason';
    const edited = check([[TITLE].concat(blank.slice(1)), blank, blank, renamed]);
    eq(edited, ['other', [['getLastRow'], ['getRange', 1, 1], ['getDisplayValue'], ['getRange', 4, 1, 1, 10], ['getDisplayValues']]]);
    const mine = check([[TITLE].concat(blank.slice(1)), blank, blank, HEADER]);
    eq(mine[0], 'bot');
    eq(check([])[0], 'other');
    eq(check([['x'], ['y'], ['z']])[1], [['getLastRow']]);
    // every range read is A1 or row 4
    [theirs, edited, mine].forEach(([, log]) => log.filter(x => x[0] === 'getRange').forEach(x => assert.ok(x[1] === 1 || x[1] === 4, JSON.stringify(x))));
  });

  test('early detection tab (review): a Sheets error during the ownership check is not taken for a tab in the way: nothing is written, Status says nothing new (and a sentence already there stays), the rows wait, and the next run writes them', () => {
    const w = world();
    const ss = sheetOf(w);
    note(w, NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW), { deadline: NOW + 4 * MIN });
    const tab = tabOf(ss);
    const before = JSON.stringify(tab.rows);
    const lastRow = tab.getLastRow;
    tab.getLastRow = () => { throw new Error('Service Spreadsheets timed out'); };
    eq(w.bot.edTabOwner_(tab), 'unknown');
    eq(w.bot.isEdTab_(tab), false);
    w.bot.edNotesStart_();
    note(w, NOW + MIN, sig(2), 'Not English', 'Most of its posts are not in English');
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + MIN), { deadline: NOW + 4 * MIN }), { written: 0, waiting: 1, blocked: false });
    eq([JSON.stringify(tab.rows) === before, w.g.props.has('ED_TAB_BLOCKED'), w.bot.edTabBlockedNote_(), w.g.logs.slice(-1)],
      [true, false, '', ['ERROR Early Detection tab not written (its rows wait for the next run): the "Early Detection" tab could not be checked']]);
    // a sentence already there is neither set nor cleared by an error: not by a write, not by the look of a run with no row
    w.g.props.set('ED_TAB_BLOCKED', 'true');
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + MIN), { deadline: NOW + 4 * MIN });
    eq(w.g.props.get('ED_TAB_BLOCKED'), 'true');
    const waited = cache(w).get('ed_tab_waiting');
    cache(w).remove('ed_tab_waiting');
    w.bot.edNotesStart_();
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + MIN), { deadline: NOW + 4 * MIN });
    eq(w.g.props.get('ED_TAB_BLOCKED'), 'true');
    cache(w).put('ed_tab_waiting', waited, 21600);
    // Sheets answers again: the waiting row is written, the sentence goes
    tab.getLastRow = lastRow;
    eq(w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + 2 * MIN), { deadline: NOW + 4 * MIN }).written, 1);
    eq([tab.rows.slice(4).map(r => r[9]), w.g.props.has('ED_TAB_BLOCKED')], [[sig(2).alert_id, sig(1).alert_id], false]);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Text cells
  // ---------------------------------------------------------------------------------------------------------------

  test('early detection tab (review): every text cell is written as text with a leading apostrophe, so a headline, reason, tag, platform or id that looks like a number or a date stays as it is; the links stay formulas, Accounts a number, an empty cell empty, and no cell passes 49,000 characters with the apostrophe', () => {
    const w = world();
    const row = w.bot.edNoteRow_(sig(1, { primary_url: '', platforms_csv: '1/2', alert_id: '404' }), 'Reviewed and dismissed', '2026-11-15',
      { title: '3.14', tag: '12:30' }, NOW);
    const cells = w.bot.edTabRow_(row);
    eq([cells[0], cells[1], cells[2], cells[4], cells[6], cells[7], cells[8], cells[9]],
      ['\'2026-10-14 08:00', '\'Reviewed and dismissed', '\'3.14', '', 5, '\'1/2', '\'12:30', '\'404']);
    assert.ok(/^'2026-11-15/.test(cells[3]), cells[3]);
    // each text cell starts with one apostrophe; a text that starts like a formula still gets only one
    cells.filter(v => typeof v === 'string' && v).forEach(v => assert.ok(v.startsWith('\'') && !v.startsWith('\'\''), v));
    eq(w.bot.edTabText_('=1+1'), '\'=1+1');
    eq(w.bot.edTabText_('\'Tis the season'), '\'\'Tis the season');  // Sheets shows it with its own apostrophe
    eq([w.bot.edTabText_(''), w.bot.edTabText_(null), w.bot.edTabText_(undefined)], ['', '', '']);
    // linked cells are the quoted links, as before
    const linked = w.bot.edTabRow_(w.bot.edNoteRow_(sig(2), 'Card posted: Monitor build-up', 'Early reports', {
      title: '2026', card: { id: 'QA-1', message: `${SPACE}/messages/c1.c1` } }, NOW));
    eq([linked[2], linked[4]], [`=HYPERLINK("${link(2)}","2026")`, '=HYPERLINK("https://chat.google.com/room/AAQAedTabRv1/c1/c1","QA-1")']);
    // the cap holds with the apostrophe
    eq(w.bot.edTabText_('A'.repeat(60000)).length, 49000);
    eq(w.bot.edTabText_('A'.repeat(48999)).length, 49000);
    // on the tab (Sheets keeps the text without the apostrophe), the lost row too
    const ss = sheetOf(w);
    w.bot.writeEdTab_(ss, [row], { lost: 3, lostAt: NOW }, NOW);
    const tab = tabOf(ss);
    eq([tab.cell(5, 3), tab.cell(5, 8), tab.cell(5, 10), tab.cell(6, 2)], ['3.14', '1/2', '404', '3 outcomes were not recorded (the runs were full)']);
    eq(w.bot.edTabLostRow_(3, NOW).slice(2), new Array(8).fill(''));
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Row 3
  // ---------------------------------------------------------------------------------------------------------------

  test('early detection tab (review): row 3 is as of the last write (its date and time say when): a run with no row and time brings it up to date (one cell) when the numbers changed, the next write too', () => {
    const w = world();
    const ss = sheetOf(w);
    note(w, NOW, sig(1), 'Reviewed and dismissed', 'Nothing for Google to act on');
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW), { deadline: NOW + 4 * MIN });
    const tab = tabOf(ss);
    const first = tab.cell(3, 1);
    assert.match(first, /^Today \(2026-10-14\): 1 found .* Updated 8:00 AM ET\.$/);
    w.bot.edNotesStart_();
    w.g.clock.now = NOW + 24 * HOUR;
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + 24 * HOUR), { deadline: NOW + 24 * HOUR + 4 * MIN });
    assert.match(tab.cell(3, 1), /^Today \(2026-10-15\): 0 found .* Updated 8:00 AM ET\.$/);  // a new day: its numbers
    note(w, NOW + 24 * HOUR, sig(2), 'Not English', 'Most of its posts are not in English');
    w.bot.maybeWriteEdTab_(ss, ctxAt(NOW + 24 * HOUR), { deadline: NOW + 24 * HOUR + 4 * MIN });
    assert.match(tab.cell(3, 1), /^Today \(2026-10-15\): 1 found .* Updated 8:00 AM ET\.$/);
  });
};
